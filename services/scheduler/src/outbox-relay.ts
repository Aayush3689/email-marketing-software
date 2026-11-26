export interface OutboxRow {
  id: number;
  exchange: string;
  routingKey: string;
  payload: unknown;
  attemptCount?: number;
}

export interface OutboxRepository {
  claimPendingBatch(limit: number): Promise<OutboxRow[]>;
  markPublished(id: number): Promise<void>;
  markPublishedBatch?(ids: number[]): Promise<void>;
  markFailed(id: number, maxAttempts?: number): Promise<void>;
}

export interface BrokerPublisher {
  publishConfirmed(exchange: string, routingKey: string, payload: Buffer): Promise<void>;
}

/**
 * Relays committed `outbox_events` rows to RabbitMQ using concurrent pipelined
 * publisher confirms, guaranteeing at-least-once durable delivery without holding
 * database transactions open across network I/O.
 */
export class OutboxRelay {
  constructor(
    private readonly repo: OutboxRepository,
    private readonly broker: BrokerPublisher,
    private readonly maxAttempts = 10
  ) {}

  async relayBatch(batchSize = 100): Promise<{ published: number; failed: number }> {
    const rows = await this.repo.claimPendingBatch(batchSize);
    if (rows.length === 0) {
      return { published: 0, failed: 0 };
    }

    const settled = await Promise.allSettled(
      rows.map(async (row) => {
        const body = Buffer.from(JSON.stringify(row.payload), 'utf8');
        await this.broker.publishConfirmed(row.exchange, row.routingKey, body);
        return row.id;
      })
    );

    const publishedIds: number[] = [];
    const failedIds: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        publishedIds.push(outcome.value);
      } else {
        failedIds.push(rows[i]!.id);
      }
    }

    if (publishedIds.length > 0) {
      if (this.repo.markPublishedBatch) {
        await this.repo.markPublishedBatch(publishedIds);
      } else {
        await Promise.all(publishedIds.map((id) => this.repo.markPublished(id)));
      }
    }

    if (failedIds.length > 0) {
      await Promise.all(failedIds.map((id) => this.repo.markFailed(id, this.maxAttempts)));
    }

    return { published: publishedIds.length, failed: failedIds.length };
  }
}
