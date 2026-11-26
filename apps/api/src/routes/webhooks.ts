import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { EmailEventType } from '@mail/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import type { AsyncCompatible } from '../utils/async-store.js';

export interface WebhookEndpointRecord {
  id: string;
  organizationId: string;
  url: string;
  secretPrefix: string;
  signingSecret: string;
  eventTypes: EmailEventType[];
  isActive: boolean;
  createdAt: string;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  organizationId: string;
  eventType: EmailEventType;
  attemptCount: number;
  httpStatus: number | null;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
}

export function signWebhookPayload(secret: string, timestampSec: number, payloadJson: string): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestampSec}.${payloadJson}`)
    .digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

export class InMemoryWebhookStore {
  private readonly endpoints = new Map<string, WebhookEndpointRecord>();
  private readonly deliveries: WebhookDeliveryLog[] = [];

  listEndpoints(orgId: string) {
    return [...this.endpoints.values()]
      .filter((w) => w.organizationId === orgId)
      .map(({ signingSecret: _s, ...pub }) => pub);
  }

  createEndpoint(orgId: string, url: string, eventTypes: EmailEventType[]) {
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    const rec: WebhookEndpointRecord = {
      id: randomUUID(),
      organizationId: orgId,
      url,
      secretPrefix: signingSecret.slice(0, 12),
      signingSecret,
      eventTypes,
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    this.endpoints.set(rec.id, rec);
    const { signingSecret: _s, ...pub } = rec;
    return { webhook: pub, signingSecret };
  }

  rotateSecret(orgId: string, id: string) {
    const existing = this.endpoints.get(id);
    if (!existing || existing.organizationId !== orgId) return null;
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    existing.signingSecret = signingSecret;
    existing.secretPrefix = signingSecret.slice(0, 12);
    const { signingSecret: _s, ...pub } = existing;
    return { webhook: pub, signingSecret };
  }

  listDeliveries(orgId: string): WebhookDeliveryLog[] {
    return this.deliveries.filter((d) => d.organizationId === orgId);
  }

  recordDelivery(log: WebhookDeliveryLog): void {
    this.deliveries.unshift(log);
  }
}

const createWebhookSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
      message: 'Webhook URL must use HTTPS',
    }),
  eventTypes: z
    .array(
      z.enum([
        'accepted',
        'delivered',
        'deferred',
        'bounced',
        'rejected',
        'complained',
        'unsubscribed',
        'opened',
        'clicked',
      ])
    )
    .min(1),
});

export type WebhookStore = AsyncCompatible<InMemoryWebhookStore>;

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const ip = ipRaw.startsWith('::ffff:') ? ipRaw.slice(7) : ipRaw;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('ff')
  );
}

export async function assertPublicWebhookUrl(
  urlString: string,
  options?: { requireResolved?: boolean }
): Promise<{
  url: URL;
  address: string | null;
  family: 4 | 6 | null;
}> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new AppError(400, 'INVALID_WEBHOOK_URL', 'Invalid webhook URL');
  }
  const requireHttps = process.env.NODE_ENV === 'production';
  if (url.protocol !== 'https:' && (requireHttps || url.protocol !== 'http:')) {
    throw new AppError(400, 'INVALID_WEBHOOK_SCHEME', 'Webhook URL must use HTTPS');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new AppError(400, 'SSRF_BLOCKED', 'Webhook target host is not publicly routable');
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new AppError(400, 'SSRF_BLOCKED', 'Webhook target IP is private or reserved');
    }
    return { url, address: host, family: net.isIPv6(host) ? 6 : 4 };
  }

  const records = await dnsLookup(host, { all: true }).catch(() => []);
  if (records.length === 0) {
    if (options?.requireResolved) {
      throw new AppError(400, 'WEBHOOK_DNS_FAILED', `Could not resolve webhook hostname ${host}`);
    }
    return { url, address: null, family: null };
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new AppError(400, 'SSRF_BLOCKED', 'Webhook target resolves to a private or reserved IP');
    }
  }
  const primary = records[0]!;
  return { url, address: primary.address, family: primary.family === 6 ? 6 : 4 };
}

/**
 * Delivers a signed webhook payload while pinning TCP connection to the pre-validated public IP
 * to neutralize DNS rebinding / SSRF TOCTOU attacks.
 */
export async function deliverWebhookSigned(
  endpoint: Pick<WebhookEndpointRecord, 'url' | 'signingSecret'>,
  payload: Record<string, unknown>
): Promise<{ status: number; ok: boolean }> {
  const pinned = await assertPublicWebhookUrl(endpoint.url, { requireResolved: true });
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signWebhookPayload(endpoint.signingSecret, ts, body);

  return new Promise((resolve, reject) => {
    const lib = pinned.url.protocol === 'https:' ? https : http;
    const req = lib.request(
      pinned.url,
      {
        method: 'POST',
        timeout: 5000,
        ...(pinned.address && pinned.family
          ? { lookup: (_host, _opts, cb) => cb(null, pinned.address!, pinned.family!) }
          : {}),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-MailForge-Signature': sig,
        },
      },
      (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        resolve({ status: code, ok: code >= 200 && code < 300 });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Webhook request timed out'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function createWebhooksRouter(deps: {
  store: WebhookStore;
  jwtSecret: string;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/webhooks', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    res.json({ webhooks: await deps.store.listEndpoints(req.auth!.orgId!) });
  });

  router.post('/webhooks', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const parsed = createWebhookSchema.parse(req.body);
    await assertPublicWebhookUrl(parsed.url);
    const created = await deps.store.createEndpoint(req.auth!.orgId!, parsed.url, parsed.eventTypes);
    res.status(201).json(created);
  });

  router.post('/webhooks/:id/rotate', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const rotated = await deps.store.rotateSecret(req.auth!.orgId!, String(req.params.id ?? ''));
    if (!rotated) throw new AppError(404, 'NOT_FOUND', 'Webhook endpoint not found');
    res.json(rotated);
  });

  router.get('/webhooks/deliveries', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    res.json({ deliveries: await deps.store.listDeliveries(req.auth!.orgId!) });
  });

  return router;
}
