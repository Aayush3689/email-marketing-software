import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OutboundDispatchJob } from '@mail/shared-types';
import { sendEmailRequestSchema } from '@mail/validation';
import { Router } from 'express';
import { type ApiKeyAuthenticator, requireAuthOrApiKey } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import { uuidv7 } from '../utils/uuidv7.js';
import type { DomainStore } from './domains.js';

export interface EmailSubmissionStore {
  submitTransactionalEmail(params: {
    organizationId: string;
    domainId: string;
    idempotencyKey?: string;
    traceparent?: string;
    from: string;
    envelopeFrom?: string;
    recipients: string[];
    subject: string;
    bodyStorageKey: string;
    sizeBytes: number;
  }): Promise<{ messageId: string; recipientCount: number; deduplicated: boolean }>;
}

export interface SpoolWriter {
  writeMime(organizationId: string, mimeBytes: Buffer): Promise<{ storageKey: string; sizeBytes: number }>;
  deleteMime?(storageKey: string): Promise<void>;
}

export class LocalSpoolWriter implements SpoolWriter {
  constructor(private readonly spoolDir: string) {}

  async writeMime(
    organizationId: string,
    mimeBytes: Buffer
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const id = uuidv7();
    const shard = id.slice(0, 2);
    const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeOrg) {
      throw new AppError(400, 'INVALID_ORG', 'Invalid organization identifier');
    }
    const relDir = path.join(safeOrg, shard);
    const absDir = path.join(this.spoolDir, relDir);
    await mkdir(absDir, { recursive: true });

    const storageKey = path.posix.join(safeOrg, shard, `${id}.eml`);
    await writeFile(path.join(this.spoolDir, storageKey), mimeBytes);
    return { storageKey, sizeBytes: mimeBytes.byteLength };
  }

  async deleteMime(storageKey: string): Promise<void> {
    if (storageKey.includes('..') || storageKey.startsWith('/')) return;
    await unlink(path.join(this.spoolDir, storageKey)).catch(() => undefined);
  }
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export class S3SpoolWriter implements SpoolWriter {
  constructor(
    private readonly cfg: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
    }
  ) {}

  private signHeaders(method: string, objectKey: string, payloadHash: string) {
    const url = new URL(`${this.cfg.endpoint.replace(/\/+$/, '')}/${this.cfg.bucket}/${objectKey}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const canonicalUri = url.pathname
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
    const kDate = hmacSha256(`AWS4${this.cfg.secretKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, this.cfg.region);
    const kService = hmacSha256(kRegion, 's3');
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    return {
      url: url.toString(),
      headers: {
        Host: url.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
  }

  async writeMime(
    organizationId: string,
    mimeBytes: Buffer
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const id = uuidv7();
    const safeOrg = organizationId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeOrg) throw new AppError(400, 'INVALID_ORG', 'Invalid organization identifier');
    const storageKey = `${safeOrg}/${id.slice(0, 2)}/${id}.eml`;
    const payloadHash = sha256Hex(mimeBytes);
    const { url, headers } = this.signHeaders('PUT', storageKey, payloadHash);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'message/rfc822' },
      body: new Uint8Array(mimeBytes),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new AppError(502, 'SPOOL_WRITE_FAILED', `S3 PUT failed with status ${res.status}`);
    }
    return { storageKey, sizeBytes: mimeBytes.byteLength };
  }

  async deleteMime(storageKey: string): Promise<void> {
    if (storageKey.includes('..') || storageKey.startsWith('/')) return;
    const payloadHash = sha256Hex('');
    const { url, headers } = this.signHeaders('DELETE', storageKey, payloadHash);
    await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined
    );
  }
}

export class PgEmailSubmissionStore implements EmailSubmissionStore {
  constructor(
    private readonly queryable: {
      connect(): Promise<{
        query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
        release(): void;
      }>;
    }
  ) {}

  async submitTransactionalEmail(params: {
    organizationId: string;
    domainId: string;
    idempotencyKey?: string;
    traceparent?: string;
    from: string;
    envelopeFrom?: string;
    recipients: string[];
    subject: string;
    bodyStorageKey: string;
    sizeBytes: number;
  }): Promise<{ messageId: string; recipientCount: number; deduplicated: boolean }> {
    const client = await this.queryable.connect();
    try {
      await client.query('BEGIN');

      const quotaRes = await client.query(
        `SELECT o.status, o.daily_send_limit, o.monthly_send_limit,
                (SELECT COUNT(*)::int FROM message_recipients mr WHERE mr.organization_id = $1 AND mr.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS sent_today,
                (SELECT COUNT(*)::int FROM message_recipients mr WHERE mr.organization_id = $1 AND mr.created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')) AS sent_month,
                d.daily_send_limit AS domain_daily_limit,
                (SELECT COUNT(*)::int FROM message_recipients mr JOIN messages msg ON msg.id = mr.message_id WHERE msg.domain_id = $2 AND mr.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')) AS domain_sent_today
           FROM organizations o
           LEFT JOIN domains d ON d.id = $2
          WHERE o.id = $1 LIMIT 1`,
        [params.organizationId, params.domainId]
      );
      const orgRow = quotaRes.rows[0] as
        | {
            status?: string;
            daily_send_limit?: number;
            monthly_send_limit?: number;
            sent_today?: number;
            sent_month?: number;
            domain_daily_limit?: number | null;
            domain_sent_today?: number;
          }
        | undefined;
      if (orgRow) {
        if (orgRow.status === 'suspended') {
          throw new AppError(403, 'ORG_SUSPENDED', 'Organization sending is suspended');
        }
        const dailyLimit = Number(orgRow.daily_send_limit ?? 0);
        const monthlyLimit = Number(orgRow.monthly_send_limit ?? 0);
        if (dailyLimit > 0 && Number(orgRow.sent_today ?? 0) + params.recipients.length > dailyLimit) {
          throw new AppError(429, 'DAILY_QUOTA_EXCEEDED', 'Daily sending quota exceeded');
        }
        if (monthlyLimit > 0 && Number(orgRow.sent_month ?? 0) + params.recipients.length > monthlyLimit) {
          throw new AppError(429, 'MONTHLY_QUOTA_EXCEEDED', 'Monthly sending quota exceeded');
        }
        const domainDailyLimit = orgRow.domain_daily_limit !== null && orgRow.domain_daily_limit !== undefined ? Number(orgRow.domain_daily_limit) : null;
        if (domainDailyLimit !== null && domainDailyLimit >= 0 && Number(orgRow.domain_sent_today ?? 0) + params.recipients.length > domainDailyLimit) {
          throw new AppError(429, 'DOMAIN_DAILY_QUOTA_EXCEEDED', 'Domain daily sending limit exceeded');
        }
      }

      if (params.idempotencyKey) {
        const existing = await client.query(
          `SELECT id FROM messages WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [params.organizationId, params.idempotencyKey]
        );
        if (existing.rows[0]?.id) {
          await client.query('COMMIT');
          return {
            messageId: String(existing.rows[0].id),
            recipientCount: params.recipients.length,
            deduplicated: true,
          };
        }
      }

      const messageId = uuidv7();
      const senderDomain = params.from.split('@')[1]?.toLowerCase() ?? 'mail.platform.local';
      const msgIdHeader = `<${messageId}@${senderDomain}>`;
      const effectiveEnvelopeFrom = params.envelopeFrom ?? params.from;

      await client.query(
        `INSERT INTO messages (
           id, organization_id, domain_id, source_type, direction, idempotency_key,
           envelope_from, header_from, subject, message_id_header, body_storage_key, size_bytes, state
         ) VALUES ($1, $2, $3, 'api', 'outbound', $4, $5::citext, $6::text, $7, $8, $9, $10, 'queued')`,
        [
          messageId,
          params.organizationId,
          params.domainId,
          params.idempotencyKey ?? null,
          effectiveEnvelopeFrom,
          params.from,
          params.subject,
          msgIdHeader,
          params.bodyStorageKey,
          params.sizeBytes,
        ]
      );

      for (const recipientEmail of params.recipients) {
        const recipientId = uuidv7();
        const domain = recipientEmail.split('@')[1]?.toLowerCase() ?? 'unknown';

        await client.query(
          `INSERT INTO message_recipients (
             id, message_id, organization_id, recipient_email, recipient_domain, recipient_type, state
           ) VALUES ($1, $2, $3, $4, $5, 'to', 'queued')`,
          [recipientId, messageId, params.organizationId, recipientEmail, domain]
        );

        const job: OutboundDispatchJob = {
          messageId,
          recipientId,
          organizationId: params.organizationId,
          domainId: params.domainId,
          sourceType: 'api',
          envelopeFrom: effectiveEnvelopeFrom,
          recipientEmail,
          bodyStorageKey: params.bodyStorageKey,
          ipPoolId: null,
          attemptNo: 1,
          ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        };

        await client.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, exchange, routing_key, payload)
           VALUES ('message', $1, 'mail.events', 'mail.outbound.transactional', $2::jsonb)`,
          [messageId, JSON.stringify(job)]
        );
      }

      await client.query('COMMIT');
      return {
        messageId,
        recipientCount: params.recipients.length,
        deduplicated: false,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

const PROTECTED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'dkim-signature',
  'authentication-results',
  'received',
  'return-path',
]);

function stripHeaderControls(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim();
}

export function buildBasicRfc5322Mime(input: {
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  messageIdHeader?: string;
}): Buffer {
  const boundary = `----=_Part_${createHash('sha256').update(uuidv7()).digest('hex').slice(0, 16)}`;
  const senderDomain = input.from.split('@')[1]?.toLowerCase() ?? 'mail.platform.local';
  const lines = [
    `From: ${stripHeaderControls(input.from)}`,
    `To: ${input.to.map(stripHeaderControls).join(', ')}`,
    ...(input.replyTo ? [`Reply-To: ${stripHeaderControls(input.replyTo)}`] : []),
    `Subject: ${stripHeaderControls(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${input.messageIdHeader ?? `<${uuidv7()}@${senderDomain}>`}`,
    'MIME-Version: 1.0',
  ];

  if (input.headers) {
    for (const [rawName, rawVal] of Object.entries(input.headers)) {
      const name = stripHeaderControls(rawName);
      if (!name || !/^[a-zA-Z0-9-]+$/.test(name) || PROTECTED_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      lines.push(`${name}: ${stripHeaderControls(rawVal)}`);
    }
  }

  if (input.html && input.text) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', input.text, '');
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', input.html, '');
    lines.push(`--${boundary}--`, '');
  } else if (input.html) {
    lines.push('Content-Type: text/html; charset=utf-8', '', input.html, '');
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', input.text ?? '', '');
  }

  return Buffer.from(lines.join('\r\n'), 'utf8');
}

export function createEmailsRouter(deps: {
  store: EmailSubmissionStore;
  spool: SpoolWriter;
  jwtSecret?: string;
  apiKeys?: ApiKeyAuthenticator;
  domainStore?: DomainStore;
  filterSuppressedRecipients?: (orgId: string, emails: string[]) => Promise<string[]> | string[];
  enforceQuota?: (orgId: string, count: number) => Promise<void> | void;
}): Router {
  const router = Router();
  const auth = requireAuthOrApiKey({
    jwtSecret: deps.jwtSecret,
    apiKeys: deps.apiKeys,
    requiredScope: 'emails:send',
    allowedOrgRoles: ['owner', 'admin', 'developer'],
  });

  router.post('/emails', auth, async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) {
      throw new AppError(403, 'NO_ORG', 'Authenticated organization context required');
    }

    const parsed = sendEmailRequestSchema.parse(req.body);
    const fromDomain = parsed.from.split('@')[1]?.toLowerCase() ?? '';
    const requestedDomainId = parsed.domainId ?? req.header('x-domain-id') ?? undefined;

    let resolvedDomainId = requestedDomainId ?? '';
    let envelopeFromAddress = parsed.from;
    if (deps.domainStore) {
      const domain = requestedDomainId
        ? await deps.domainStore.getDomain(orgId, requestedDomainId)
        : (await deps.domainStore.listDomains(orgId)).find((d) => d.domainName === fromDomain) ?? null;

      if (!domain) {
        throw new AppError(403, 'DOMAIN_NOT_OWNED', 'Sender domain is not registered under your organization');
      }
      if (!domain.ownershipVerifiedAt) {
        throw new AppError(403, 'DOMAIN_UNVERIFIED', 'Sender domain ownership is not verified');
      }
      if (!domain.sendingEnabled || domain.isSuspended) {
        throw new AppError(403, 'DOMAIN_SENDING_DISABLED', 'Sending is disabled or suspended for this domain');
      }
      if (domain.domainName !== fromDomain) {
        throw new AppError(403, 'SENDER_DOMAIN_MISMATCH', 'From address domain must match the verified domain');
      }
      resolvedDomainId = domain.id;
      if (domain.customReturnPathDomain) {
        envelopeFromAddress = `bounces+${domain.id}@${domain.customReturnPathDomain}`;
      }
    } else if (!resolvedDomainId) {
      throw new AppError(400, 'MISSING_DOMAIN', 'Verified sending domain is required');
    }

    const rawRecipients = [...parsed.to, ...(parsed.cc ?? []), ...(parsed.bcc ?? [])];
    const recipients = deps.filterSuppressedRecipients
      ? await deps.filterSuppressedRecipients(orgId, rawRecipients)
      : rawRecipients;

    if (recipients.length === 0) {
      throw new AppError(422, 'ALL_RECIPIENTS_SUPPRESSED', 'All recipients are on the suppression list');
    }

    if (deps.enforceQuota) {
      await deps.enforceQuota(orgId, recipients.length);
    }

    const mime = buildBasicRfc5322Mime({
      from: parsed.from,
      to: parsed.to,
      ...(parsed.replyTo !== undefined ? { replyTo: parsed.replyTo } : {}),
      subject: parsed.subject,
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      ...(parsed.html !== undefined ? { html: parsed.html } : {}),
      ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
    });

    const { storageKey, sizeBytes } = await deps.spool.writeMime(orgId, mime);
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceparent = `00-${traceId}-${spanId}-01`;

    try {
      const result = await deps.store.submitTransactionalEmail({
        organizationId: orgId,
        domainId: resolvedDomainId,
        ...(parsed.idempotencyKey !== undefined ? { idempotencyKey: parsed.idempotencyKey } : {}),
        traceparent,
        from: parsed.from,
        envelopeFrom: envelopeFromAddress,
        recipients,
        subject: parsed.subject,
        bodyStorageKey: storageKey,
        sizeBytes,
      });

      res.setHeader('x-trace-id', traceId);
      res.status(202).json({
        id: result.messageId,
        status: 'queued',
        recipientCount: result.recipientCount,
        deduplicated: result.deduplicated,
        traceId,
      });
    } catch (err) {
      if (deps.spool.deleteMime) {
        await deps.spool.deleteMime(storageKey);
      }
      throw err;
    }
  });

  return router;
}
