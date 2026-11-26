import amqp from 'amqplib';
import { Pool } from 'pg';
import { OutboxRelay, type OutboxRow } from './outbox-relay.js';

const DATABASE_URL = process.env.DATABASE_URL;
const RABBITMQ_URL = process.env.RABBITMQ_URL;

if (!DATABASE_URL || !RABBITMQ_URL) {
  throw new Error('DATABASE_URL and RABBITMQ_URL are required');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const conn = await amqp.connect(RABBITMQ_URL);
const confirmChannel = await conn.createConfirmChannel();

const relay = new OutboxRelay(
  {
    async claimPendingBatch(limit: number): Promise<OutboxRow[]> {
      const { rows } = await pool.query<{
        id: number;
        exchange: string;
        routing_key: string;
        payload: unknown;
      }>(
        `UPDATE outbox_events
         SET locked_at = NOW()
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE status = 'pending'
             AND attempt_count < 10
             AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '30 seconds')
           ORDER BY id ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, exchange, routing_key, payload`,
        [limit]
      );
      return rows.map((r) => ({
        id: Number(r.id),
        exchange: r.exchange,
        routingKey: r.routing_key,
        payload: r.payload,
      }));
    },
    async markPublished(id: number): Promise<void> {
      await pool.query(
        `UPDATE outbox_events SET status = 'published', published_at = NOW() WHERE id = $1`,
        [id]
      );
    },
    async markPublishedBatch(ids: number[]): Promise<void> {
      await pool.query(
        `UPDATE outbox_events SET status = 'published', published_at = NOW() WHERE id = ANY($1::bigint[])`,
        [ids]
      );
    },
    async markFailed(id: number, maxAttempts = 10): Promise<void> {
      await pool.query(
        `UPDATE outbox_events
            SET attempt_count = attempt_count + 1,
                status = CASE WHEN attempt_count + 1 >= $2 THEN 'failed' ELSE 'pending' END,
                locked_at = NULL
          WHERE id = $1`,
        [id, maxAttempts]
      );
    },
  },
  {
    async publishConfirmed(exchange: string, routingKey: string, payload: Buffer): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          exchange,
          routingKey,
          payload,
          { persistent: true, contentType: 'application/json' },
          (err) => (err ? reject(err) : resolve())
        );
      });
    },
  }
);

let running = true;
process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

async function ensurePartitionsSafely(): Promise<void> {
  try {
    await pool.query('SELECT ensure_monthly_partitions(3)');
  } catch (err) {
    console.warn('[scheduler] ensure_monthly_partitions skipped:', err instanceof Error ? err.message : String(err));
  }
}

async function sweepDueDeferredRetries(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query<{
      recipient_id: string;
      message_id: string;
      organization_id: string;
      domain_id: string | null;
      source_type: string;
      envelope_from: string;
      recipient_email: string;
      body_storage_key: string;
      ip_pool_id: string | null;
      attempt_count: number;
    }>(
      `WITH claimed AS (
         SELECT id
         FROM message_recipients
         WHERE state = 'deferred' AND next_retry_at <= NOW()
         ORDER BY next_retry_at ASC
         LIMIT 200
         FOR UPDATE SKIP LOCKED
       )
       UPDATE message_recipients r
       SET state = 'queued', next_retry_at = NULL
       FROM claimed, messages m
       WHERE r.id = claimed.id AND m.id = r.message_id
       RETURNING
         r.id::text AS recipient_id,
         m.id::text AS message_id,
         m.organization_id::text AS organization_id,
         m.domain_id::text AS domain_id,
         m.source_type,
         m.envelope_from,
         r.recipient_email::text AS recipient_email,
         m.body_storage_key,
         m.ip_pool_id::text AS ip_pool_id,
         r.attempt_count`
    );

    let requeued = 0;
    for (const row of due.rows) {
      const payload = Buffer.from(
        JSON.stringify({
          messageId: row.message_id,
          recipientId: row.recipient_id,
          organizationId: row.organization_id,
          domainId: row.domain_id,
          sourceType: row.source_type,
          envelopeFrom: row.envelope_from,
          recipientEmail: row.recipient_email,
          bodyStorageKey: row.body_storage_key,
          ipPoolId: row.ip_pool_id,
          attemptNo: row.attempt_count + 1,
        }),
        'utf8'
      );
      await new Promise<void>((resolve, reject) => {
        confirmChannel.publish(
          'mail.events',
          'mail.outbound.retry',
          payload,
          { persistent: true, contentType: 'application/json' },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      requeued += 1;
    }

    await client.query('COMMIT');
    return requeued;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[scheduler] deferred retry sweep error:', err);
    return 0;
  } finally {
    client.release();
  }
}

await ensurePartitionsSafely();
let lastPartitionCheckMs = Date.now();
let lastRetrySweepMs = 0;

while (running) {
  let published = 0;
  try {
    const res = await relay.relayBatch(200);
    published = res.published;
  } catch (err) {
    console.error('[scheduler] relayBatch error:', err);
  }

  const now = Date.now();
  if (now - lastRetrySweepMs >= 5_000) {
    lastRetrySweepMs = now;
    await sweepDueDeferredRetries();
  }
  if (now - lastPartitionCheckMs >= 6 * 60 * 60 * 1000) {
    lastPartitionCheckMs = now;
    await ensurePartitionsSafely();
  }

  if (published === 0) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

await confirmChannel.close();
await conn.close();
await pool.end();
