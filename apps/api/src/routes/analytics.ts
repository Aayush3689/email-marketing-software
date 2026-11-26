import { randomBytes, randomUUID } from 'node:crypto';
import type { EmailEventType } from '@mail/shared-types';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import type { AsyncCompatible } from '../utils/async-store.js';
import type { MarketingStore } from './campaigns.js';

export type DateRangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

export interface EmailEventRecord {
  id: string;
  organizationId: string;
  messageId: string;
  recipientEmail: string;
  eventType: EmailEventType;
  domain: string;
  latencyMs: number;
  campaignId: string | null;
  detail: string | null;
  createdAt: string;
}

export interface TrackingTokenRecord {
  token: string;
  organizationId: string;
  messageId: string;
  recipientEmail: string;
  kind: 'open' | 'click' | 'unsubscribe';
  targetUrl: string | null;
  campaignId?: string | null;
  domainId?: string | null;
  subscriberId?: string | null;
  createdAt: string;
}

export interface BillingPlan {
  id: 'starter' | 'growth' | 'scale' | 'enterprise';
  name: string;
  monthlyPriceUsd: number;
  includedEmailsPerMonth: number;
  maxDomains: number;
  maxMailboxes: number;
  dedicatedIpIncluded: boolean;
  supportSla: string;
}

export interface SubscriptionRecord {
  organizationId: string;
  planId: BillingPlan['id'];
  status: 'active' | 'past_due' | 'cancelled';
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

export interface InvoiceRecord {
  id: string;
  organizationId: string;
  planId: BillingPlan['id'];
  amountUsd: number;
  status: 'paid' | 'open';
  issuedAt: string;
  periodLabel: string;
}

export const BILLING_PLANS: readonly BillingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    monthlyPriceUsd: 29,
    includedEmailsPerMonth: 50_000,
    maxDomains: 3,
    maxMailboxes: 10,
    dedicatedIpIncluded: false,
    supportSla: 'Email support (24h)',
  },
  {
    id: 'growth',
    name: 'Growth',
    monthlyPriceUsd: 99,
    includedEmailsPerMonth: 300_000,
    maxDomains: 15,
    maxMailboxes: 50,
    dedicatedIpIncluded: false,
    supportSla: 'Priority support (8h)',
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyPriceUsd: 299,
    includedEmailsPerMonth: 1_500_000,
    maxDomains: 100,
    maxMailboxes: 250,
    dedicatedIpIncluded: true,
    supportSla: '24/7 engineering support (2h)',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyPriceUsd: 999,
    includedEmailsPerMonth: 10_000_000,
    maxDomains: 1000,
    maxMailboxes: 2500,
    dedicatedIpIncluded: true,
    supportSla: 'Dedicated deliverability engineer (15m)',
  },
] as const;

const ONE_BY_ONE_GIF = Buffer.from(
  'R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64'
);

function resolveWindow(
  preset: DateRangePreset,
  fromIso?: string,
  toIso?: string
): { startMs: number; endMs: number } {
  const now = new Date();
  const endMs = now.getTime();

  if (preset === 'today') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === 'yesterday') {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCHours(23, 59, 59, 999);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  if (preset === '7d') {
    return { startMs: endMs - 7 * 86_400_000, endMs };
  }
  if (preset === '30d') {
    return { startMs: endMs - 30 * 86_400_000, endMs };
  }

  const parsedFrom = fromIso ? Date.parse(fromIso) : NaN;
  const parsedTo = toIso ? Date.parse(toIso) : NaN;
  if (Number.isNaN(parsedFrom) || Number.isNaN(parsedTo) || parsedFrom > parsedTo) {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Custom date range requires valid from and to ISO timestamps');
  }
  return { startMs: parsedFrom, endMs: parsedTo };
}

function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export class InMemoryAnalyticsStore {
  private readonly events: EmailEventRecord[] = [];
  private readonly tokens = new Map<string, TrackingTokenRecord>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly invoices: InvoiceRecord[] = [];

  recordEvent(input: {
    organizationId: string;
    messageId: string;
    recipientEmail: string;
    eventType: EmailEventType;
    domain: string;
    latencyMs?: number;
    campaignId?: string | null;
    detail?: string | null;
    createdAt?: string;
  }): EmailEventRecord {
    const rec: EmailEventRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      messageId: input.messageId,
      recipientEmail: input.recipientEmail.toLowerCase(),
      eventType: input.eventType,
      domain: input.domain.toLowerCase(),
      latencyMs: input.latencyMs ?? 0,
      campaignId: input.campaignId ?? null,
      detail: input.detail ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.events.unshift(rec);
    return rec;
  }

  createTrackingToken(input: {
    organizationId: string;
    messageId: string;
    recipientEmail: string;
    kind: 'open' | 'click' | 'unsubscribe';
    targetUrl?: string | null;
    campaignId?: string | null;
    domainId?: string | null;
    subscriberId?: string | null;
  }): TrackingTokenRecord {
    const rec: TrackingTokenRecord = {
      token: randomBytes(18).toString('base64url'),
      organizationId: input.organizationId,
      messageId: input.messageId,
      recipientEmail: input.recipientEmail.toLowerCase(),
      kind: input.kind,
      targetUrl: input.targetUrl ?? null,
      campaignId: input.campaignId ?? null,
      domainId: input.domainId ?? null,
      subscriberId: input.subscriberId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.tokens.set(rec.token, rec);
    return rec;
  }

  getTrackingToken(token: string): TrackingTokenRecord | null {
    return this.tokens.get(token) ?? null;
  }

  queryEvents(
    orgId: string,
    opts: {
      range: DateRangePreset;
      from?: string;
      to?: string;
      eventType?: EmailEventType;
      recipient?: string;
    }
  ): EmailEventRecord[] {
    const { startMs, endMs } = resolveWindow(opts.range, opts.from, opts.to);
    const recipientLower = opts.recipient?.trim().toLowerCase();

    return this.events.filter((ev) => {
      if (ev.organizationId !== orgId) return false;
      const ts = Date.parse(ev.createdAt);
      if (ts < startMs || ts > endMs) return false;
      if (opts.eventType && ev.eventType !== opts.eventType) return false;
      if (recipientLower && !ev.recipientEmail.includes(recipientLower)) return false;
      return true;
    });
  }

  getOverview(
    orgId: string,
    opts: { range: DateRangePreset; from?: string; to?: string }
  ) {
    const filtered = this.queryEvents(orgId, opts);
    const counts: Record<EmailEventType, number> = {
      accepted: 0,
      delivered: 0,
      deferred: 0,
      bounced: 0,
      rejected: 0,
      complained: 0,
      unsubscribed: 0,
      opened: 0,
      clicked: 0,
    };

    let latencyTotal = 0;
    let latencyCount = 0;
    const byDay = new Map<
      string,
      { date: string; accepted: number; delivered: number; bounced: number; opened: number; clicked: number }
    >();

    for (const ev of filtered) {
      counts[ev.eventType] += 1;
      if (ev.latencyMs > 0) {
        latencyTotal += ev.latencyMs;
        latencyCount += 1;
      }
      const dayKey = ev.createdAt.slice(0, 10);
      const bucket = byDay.get(dayKey) ?? {
        date: dayKey,
        accepted: 0,
        delivered: 0,
        bounced: 0,
        opened: 0,
        clicked: 0,
      };
      if (
        ev.eventType === 'accepted' ||
        ev.eventType === 'delivered' ||
        ev.eventType === 'bounced' ||
        ev.eventType === 'opened' ||
        ev.eventType === 'clicked'
      ) {
        bucket[ev.eventType] += 1;
      }
      byDay.set(dayKey, bucket);
    }

    const baseVolume = Math.max(counts.accepted, counts.delivered + counts.bounced + counts.deferred, 0);
    const deliveryRate = baseVolume > 0 ? Number(((counts.delivered / baseVolume) * 100).toFixed(2)) : 0;
    const bounceRate = baseVolume > 0 ? Number(((counts.bounced / baseVolume) * 100).toFixed(2)) : 0;
    const openRate = counts.delivered > 0 ? Number(((counts.opened / counts.delivered) * 100).toFixed(2)) : 0;
    const clickRate = counts.delivered > 0 ? Number(((counts.clicked / counts.delivered) * 100).toFixed(2)) : 0;
    const avgLatencyMs = latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : 0;

    const series = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

    return {
      range: opts.range,
      totalEvents: filtered.length,
      counts,
      rates: {
        deliveryRate,
        bounceRate,
        openRate,
        clickRate,
      },
      avgLatencyMs,
      series,
    };
  }

  exportCsv(
    orgId: string,
    opts: { range: DateRangePreset; from?: string; to?: string; eventType?: EmailEventType; recipient?: string }
  ): string {
    const rows = this.queryEvents(orgId, opts);
    const header = ['id', 'createdAt', 'eventType', 'recipientEmail', 'domain', 'messageId', 'latencyMs', 'detail'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.createdAt,
          r.eventType,
          r.recipientEmail,
          r.domain,
          r.messageId,
          String(r.latencyMs),
          r.detail ?? '',
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }
    return `${lines.join('\n')}\n`;
  }

  getSubscription(orgId: string): {
    subscription: SubscriptionRecord;
    plan: BillingPlan;
    monthlyEmailsSent: number;
  } {
    let sub = this.subscriptions.get(orgId);
    if (!sub) {
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      sub = {
        organizationId: orgId,
        planId: 'starter',
        status: 'active',
        currentPeriodStart: start.toISOString(),
        currentPeriodEnd: end.toISOString(),
      };
      this.subscriptions.set(orgId, sub);
    }
    const plan = BILLING_PLANS.find((p) => p.id === sub.planId) ?? BILLING_PLANS[0]!;
    const periodStartMs = Date.parse(sub.currentPeriodStart);
    const monthlyEmailsSent = this.events.filter(
      (e) =>
        e.organizationId === orgId &&
        (e.eventType === 'accepted' || e.eventType === 'delivered') &&
        Date.parse(e.createdAt) >= periodStartMs
    ).length;

    return { subscription: sub, plan, monthlyEmailsSent };
  }

  upgradePlan(orgId: string, planId: BillingPlan['id']) {
    const plan = BILLING_PLANS.find((p) => p.id === planId);
    if (!plan) {
      throw new AppError(404, 'PLAN_NOT_FOUND', 'Billing plan not found');
    }
    const current = this.getSubscription(orgId);
    current.subscription.planId = plan.id;
    current.subscription.status = 'active';
    const invoice: InvoiceRecord = {
      id: `inv_${randomBytes(6).toString('hex')}`,
      organizationId: orgId,
      planId: plan.id,
      amountUsd: plan.monthlyPriceUsd,
      status: 'paid',
      issuedAt: new Date().toISOString(),
      periodLabel: `${current.subscription.currentPeriodStart.slice(0, 7)} (${plan.name})`,
    };
    this.invoices.unshift(invoice);
    return {
      subscription: current.subscription,
      plan,
      invoice,
    };
  }

  listInvoices(orgId: string): InvoiceRecord[] {
    return this.invoices.filter((inv) => inv.organizationId === orgId);
  }

  getGlobalStats() {
    const counts: Record<EmailEventType, number> = {
      accepted: 0,
      delivered: 0,
      deferred: 0,
      bounced: 0,
      rejected: 0,
      complained: 0,
      unsubscribed: 0,
      opened: 0,
      clicked: 0,
    };
    let latencySum = 0;
    let latencyN = 0;
    for (const ev of this.events) {
      counts[ev.eventType] += 1;
      if (ev.latencyMs > 0) {
        latencySum += ev.latencyMs;
        latencyN += 1;
      }
    }
    return {
      totalEvents: this.events.length,
      counts,
      avgLatencyMs: latencyN > 0 ? Math.round(latencySum / latencyN) : 0,
    };
  }
}

const rangeSchema = z.enum(['today', 'yesterday', '7d', '30d', 'custom']).default('7d');
const eventTypeSchema = z.enum([
  'accepted',
  'delivered',
  'deferred',
  'bounced',
  'rejected',
  'complained',
  'unsubscribed',
  'opened',
  'clicked',
]);

const recordEventSchema = z.object({
  messageId: z.string().min(1),
  recipientEmail: z.string().email(),
  eventType: eventTypeSchema,
  domain: z.string().min(1),
  latencyMs: z.number().int().min(0).max(600_000).optional(),
  campaignId: z.string().nullable().optional(),
  detail: z.string().max(500).nullable().optional(),
  createdAt: z.string().datetime().optional(),
});

const createTrackingTokenSchema = z.object({
  messageId: z.string().min(1),
  recipientEmail: z.string().email(),
  kind: z.enum(['open', 'click', 'unsubscribe']),
  targetUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith('http://'), {
      message: 'targetUrl must use http or https',
    })
    .optional(),
});

const upgradePlanSchema = z.object({
  planId: z.enum(['starter', 'growth', 'scale', 'enterprise']),
});

export type AnalyticsStore = AsyncCompatible<InMemoryAnalyticsStore>;

export function createAnalyticsRouter(deps: {
  store: AnalyticsStore;
  jwtSecret: string;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/analytics/overview', auth, async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
    const range = rangeSchema.parse(req.query.range);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const queryOpts: { range: DateRangePreset; from?: string; to?: string } = { range };
    if (from) queryOpts.from = from;
    if (to) queryOpts.to = to;
    res.json({ overview: await deps.store.getOverview(orgId, queryOpts) });
  });

  router.get('/analytics/events', auth, async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
    const range = rangeSchema.parse(req.query.range);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const eventType =
      typeof req.query.eventType === 'string' && req.query.eventType.length > 0
        ? eventTypeSchema.parse(req.query.eventType)
        : undefined;
    const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : undefined;

    const opts: {
      range: DateRangePreset;
      from?: string;
      to?: string;
      eventType?: EmailEventType;
      recipient?: string;
    } = { range };
    if (from) opts.from = from;
    if (to) opts.to = to;
    if (eventType) opts.eventType = eventType;
    if (recipient) opts.recipient = recipient;

    res.json({ events: await deps.store.queryEvents(orgId, opts) });
  });

  router.get('/analytics/export.csv', auth, async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
    const range = rangeSchema.parse(req.query.range);
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const eventType =
      typeof req.query.eventType === 'string' && req.query.eventType.length > 0
        ? eventTypeSchema.parse(req.query.eventType)
        : undefined;
    const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : undefined;

    const opts: {
      range: DateRangePreset;
      from?: string;
      to?: string;
      eventType?: EmailEventType;
      recipient?: string;
    } = { range };
    if (from) opts.from = from;
    if (to) opts.to = to;
    if (eventType) opts.eventType = eventType;
    if (recipient) opts.recipient = recipient;

    const csv = await deps.store.exportCsv(orgId, opts);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="email-events.csv"');
    res.status(200).send(csv);
  });

  router.post(
    '/analytics/events',
    auth,
    requireOrgRole(['owner', 'admin', 'developer']),
    async (req, res) => {
      const orgId = req.auth!.orgId;
      if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
      const parsed = recordEventSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid event payload', parsed.error.flatten());
      }
      const input: Parameters<InMemoryAnalyticsStore['recordEvent']>[0] = {
        organizationId: orgId,
        messageId: parsed.data.messageId,
        recipientEmail: parsed.data.recipientEmail,
        eventType: parsed.data.eventType,
        domain: parsed.data.domain,
      };
      if (parsed.data.latencyMs !== undefined) input.latencyMs = parsed.data.latencyMs;
      if (parsed.data.campaignId !== undefined) input.campaignId = parsed.data.campaignId;
      if (parsed.data.detail !== undefined) input.detail = parsed.data.detail;
      if (parsed.data.createdAt !== undefined) input.createdAt = parsed.data.createdAt;

      const event = await deps.store.recordEvent(input);
      res.status(201).json({ event });
    }
  );

  router.post(
    '/tracking/tokens',
    auth,
    requireOrgRole(['owner', 'admin', 'developer']),
    async (req, res) => {
      const orgId = req.auth!.orgId;
      if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
      const parsed = createTrackingTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid tracking token request', parsed.error.flatten());
      }
      const token = await deps.store.createTrackingToken({
        organizationId: orgId,
        messageId: parsed.data.messageId,
        recipientEmail: parsed.data.recipientEmail,
        kind: parsed.data.kind,
        targetUrl: parsed.data.targetUrl ?? null,
      });
      res.status(201).json({ token });
    }
  );

  router.get('/billing/plans', auth, (_req, res) => {
    res.json({ plans: BILLING_PLANS });
  });

  router.get('/billing/subscription', auth, async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
    const summary = await deps.store.getSubscription(orgId);
    res.json(summary);
  });

  router.post(
    '/billing/upgrade',
    auth,
    requireOrgRole(['owner', 'admin']),
    async (req, res) => {
      const orgId = req.auth!.orgId;
      if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
      if (
        process.env.NODE_ENV === 'production' &&
        process.env.ALLOW_SELF_SERVICE_PLAN_UPGRADE !== 'true'
      ) {
        throw new AppError(
          501,
          'BILLING_PROVIDER_REQUIRED',
          'Self-service plan upgrades require Stripe billing integration in production'
        );
      }
      const parsed = upgradePlanSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid plan selection', parsed.error.flatten());
      }
      const result = await deps.store.upgradePlan(orgId, parsed.data.planId);
      res.status(200).json(result);
    }
  );

  router.get('/billing/invoices', auth, async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) throw new AppError(403, 'NO_ORG', 'Organization context required');
    res.json({ invoices: await deps.store.listInvoices(orgId) });
  });

  return router;
}

export function createPublicTrackingRouter(deps: {
  analyticsStore: AnalyticsStore;
  marketingStore: MarketingStore;
}): Router {
  const router = Router();

  router.get('/t/o/:token', async (req, res) => {
    const rec = await deps.analyticsStore.getTrackingToken(req.params.token ?? '');
    if (rec && rec.kind === 'open') {
      const domain = rec.recipientEmail.split('@')[1] ?? 'unknown';
      await deps.analyticsStore.recordEvent({
        organizationId: rec.organizationId,
        messageId: rec.messageId,
        recipientEmail: rec.recipientEmail,
        eventType: 'opened',
        domain,
        ...(rec.campaignId ? { campaignId: rec.campaignId } : {}),
        detail: 'open_pixel',
      });
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(200).send(ONE_BY_ONE_GIF);
  });

  router.get('/t/c/:token', async (req, res) => {
    const rec = await deps.analyticsStore.getTrackingToken(req.params.token ?? '');
    if (!rec || rec.kind !== 'click' || !rec.targetUrl) {
      throw new AppError(404, 'TRACKING_TOKEN_NOT_FOUND', 'Tracking link not found');
    }
    if (!rec.targetUrl.startsWith('https://') && !rec.targetUrl.startsWith('http://')) {
      throw new AppError(400, 'UNSAFE_REDIRECT', 'Tracking target URL has invalid scheme');
    }
    const domain = rec.recipientEmail.split('@')[1] ?? 'unknown';
    await deps.analyticsStore.recordEvent({
      organizationId: rec.organizationId,
      messageId: rec.messageId,
      recipientEmail: rec.recipientEmail,
      eventType: 'clicked',
      domain,
      ...(rec.campaignId ? { campaignId: rec.campaignId } : {}),
      detail: rec.targetUrl,
    });
    res.redirect(302, rec.targetUrl);
  });

  const handleUnsubscribe = async (token: string) => {
    const rec = await deps.analyticsStore.getTrackingToken(token);
    if (!rec || rec.kind !== 'unsubscribe') {
      throw new AppError(404, 'UNSUBSCRIBE_TOKEN_NOT_FOUND', 'Unsubscribe token not found');
    }
    const suppression = await deps.marketingStore.addSuppression(
      rec.organizationId,
      rec.recipientEmail,
      'unsubscribe',
      {
        source: 'rfc8058_one_click',
        ...(rec.campaignId ? { relatedCampaignId: rec.campaignId } : {}),
      }
    );
    const domain = rec.recipientEmail.split('@')[1] ?? 'unknown';
    await deps.analyticsStore.recordEvent({
      organizationId: rec.organizationId,
      messageId: rec.messageId,
      recipientEmail: rec.recipientEmail,
      eventType: 'unsubscribed',
      domain,
      ...(rec.campaignId ? { campaignId: rec.campaignId } : {}),
      detail: 'rfc8058_one_click',
    });
    return { rec, suppression };
  };

  router.post('/unsubscribe/:token', async (req, res) => {
    const { rec, suppression } = await handleUnsubscribe(req.params.token ?? '');
    res.status(200).json({
      unsubscribed: true,
      email: rec.recipientEmail,
      suppressionId: suppression.id,
      reason: suppression.reason,
    });
  });

  router.get('/unsubscribe/:token', (req, res) => {
    const encoded = encodeURIComponent(String(req.params.token ?? ''));
    res
      .status(200)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirm Unsubscribe</title></head>` +
          `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:24px">` +
          `<h2>Confirm Unsubscribe</h2><p>Click below to opt out of future emails from this sender.</p>` +
          `<form method="POST" action="/v1/unsubscribe/${encoded}"><button type="submit" style="padding:10px 18px;font-size:15px;cursor:pointer">Confirm Unsubscribe</button></form>` +
          `</body></html>`
      );
  });

  return router;
}
