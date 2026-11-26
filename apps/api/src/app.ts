import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { StructuredLogger } from './logger.js';
import { AppError, createErrorHandler } from './middleware/error-handler.js';
import { type AdminControlStore, createAdminRouter } from './routes/admin.js';
import {
  type AnalyticsStore,
  createAnalyticsRouter,
  createPublicTrackingRouter,
  InMemoryAnalyticsStore,
} from './routes/analytics.js';
import { type AuthStore, createAuthRouter } from './routes/auth.js';
import { type CampaignRecord, createMarketingRouter, type MarketingStore } from './routes/campaigns.js';
import { createMarketingPlatformRouter } from './routes/marketing-platform.js';
import { createCredentialsRouter, type CredentialsStore } from './routes/credentials.js';
import {
  createDomainsRouter,
  type DomainStore,
  type MtaDomainSyncClient,
} from './routes/domains.js';
import type { DnsLookupAdapter } from './services/dns-verifier.js';
import {
  buildBasicRfc5322Mime,
  createEmailsRouter,
  type EmailSubmissionStore,
  type SpoolWriter,
} from './routes/emails.js';
import {
  buildSubscriberVarMap,
  compileBlocksToHtmlAndText,
  htmlToPlainText,
  instrumentTrackedEmail,
  renderPersonalizedContent,
} from './services/marketing-engine.js';
import { uuidv7 } from './utils/uuidv7.js';
import { createHealthRouter, type ReadinessDeps } from './routes/health.js';
import { createMailboxesRouter, type MailboxStore } from './routes/mailboxes.js';
import { createWebhooksRouter, type WebhookStore } from './routes/webhooks.js';

export interface AppDependencies {
  corsOrigins: string[];
  adminCorsOrigins?: string[];
  publicBaseUrl?: string;
  logger: StructuredLogger;
  readiness: ReadinessDeps;
  jwtSecret?: string;
  authStore?: AuthStore;
  domainStore?: DomainStore;
  dnsAdapter?: DnsLookupAdapter;
  mtaDomainSync?: MtaDomainSyncClient;
  mailboxStore?: MailboxStore;
  credentialsStore?: CredentialsStore;
  marketingStore?: MarketingStore;
  webhookStore?: WebhookStore;
  analyticsStore?: AnalyticsStore;
  adminStore?: AdminControlStore;
  emails?: {
    store: EmailSubmissionStore;
    spool: SpoolWriter;
  };
}

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  const tenantCors = cors({
    origin: deps.corsOrigins,
    credentials: true,
  });
  const adminCors = cors({
    origin: deps.adminCorsOrigins ?? deps.corsOrigins,
    credentials: true,
  });
  app.use('/v1', tenantCors);
  app.use('/admin/v1', adminCors);
  app.use(express.json({ limit: '6mb' }));

  app.use((req, res, next) => {
    const incomingId = req.header('x-request-id');
    const requestId =
      incomingId && /^[a-zA-Z0-9._-]{1,64}$/.test(incomingId) ? incomingId : randomUUID();
    res.setHeader('x-request-id', requestId);
    next();
  });

  app.use(createHealthRouter(deps.readiness));

  app.get('/v1', (_req, res) => {
    res.status(200).json({
      name: 'Mail Infrastructure API',
      version: 'v1',
      status: 'operational',
    });
  });

  if (deps.jwtSecret && deps.authStore) {
    app.use('/v1', createAuthRouter({ store: deps.authStore, jwtSecret: deps.jwtSecret }));
  }
  if (deps.jwtSecret && deps.domainStore) {
    app.use(
      '/v1',
      createDomainsRouter({
        store: deps.domainStore,
        jwtSecret: deps.jwtSecret,
        ...(deps.dnsAdapter ? { dnsAdapter: deps.dnsAdapter } : {}),
        ...(deps.mtaDomainSync ? { mtaSync: deps.mtaDomainSync } : {}),
      })
    );
  }
  if (deps.jwtSecret && deps.mailboxStore) {
    app.use('/v1', createMailboxesRouter({ store: deps.mailboxStore, jwtSecret: deps.jwtSecret }));
  }
  if (deps.jwtSecret && deps.credentialsStore) {
    app.use(
      '/v1',
      createCredentialsRouter({ store: deps.credentialsStore, jwtSecret: deps.jwtSecret })
    );
  }
  const publicBaseUrl =
    deps.publicBaseUrl ||
    process.env.PUBLIC_BASE_URL ||
    (process.env.PRIMARY_DOMAIN ? `https://${process.env.PRIMARY_DOMAIN}` : 'http://localhost:4000');

  const dispatchCampaignBroadcast = async (campaign: CampaignRecord): Promise<number> => {
    if (!deps.emails || !deps.domainStore || !deps.marketingStore) return 0;
    const orgId = campaign.organizationId;
    const domain = await deps.domainStore.getDomain(orgId, campaign.domainId);
    if (!domain || !domain.ownershipVerifiedAt || !domain.sendingEnabled || domain.isSuspended) {
      throw new AppError(403, 'DOMAIN_NOT_READY', 'Sending domain must be verified, enabled, and active');
    }

    const templates = await deps.marketingStore.listTemplates(orgId, true);
    const tpl = templates.find((t) => t.id === campaign.templateId);
    const tplVer =
      tpl?.versions.find((v) => v.versionNumber === tpl.activeVersion) ?? tpl?.versions[tpl.versions.length - 1];

    const spec =
      campaign.audienceSpec ??
      (campaign.tagFilter ? { mode: 'filtered' as const, includeTags: [campaign.tagFilter] } : { mode: 'all' as const });

    let eligible = [];
    if (deps.marketingStore.estimateBroadcastAudience) {
      eligible = (await deps.marketingStore.estimateBroadcastAudience(orgId, spec, deps.analyticsStore)).eligible;
    } else {
      const suppressed = new Set((await deps.marketingStore.listSuppressions(orgId)).map((s) => s.email.toLowerCase()));
      eligible = (await deps.marketingStore.listContacts(orgId, campaign.tagFilter ?? undefined)).filter(
        (c) => !c.unsubscribedAt && c.status !== 'unsubscribed' && !suppressed.has(c.email.toLowerCase())
      );
    }

    if (deps.marketingStore.snapshotCampaignRecipients) {
      await deps.marketingStore.snapshotCampaignRecipients(orgId, campaign.id, eligible);
    }

    let rawSubject = campaign.subject || tplVer?.subject || campaign.name;
    let rawHtml = campaign.htmlBody ?? tplVer?.htmlBody ?? '';
    let rawText = campaign.textBody ?? tplVer?.textBody ?? '';
    if (!rawHtml && campaign.blocksJson && campaign.blocksJson.length > 0) {
      const compiled = compileBlocksToHtmlAndText(campaign.blocksJson, {
        subject: rawSubject,
        ...(campaign.previewText ? { previewText: campaign.previewText } : {}),
      });
      rawHtml = compiled.htmlBody;
      if (!rawText) rawText = compiled.textBody;
    }
    if (!rawHtml && !rawText) return 0;

    const senderLocal = domain.defaultSenderLocalPart || 'newsletter';
    const fromAddr = campaign.fromEmail || `${senderLocal}@${domain.domainName}`;
    let sent = 0;

    for (const contact of eligible) {
      // Stop cleanly if campaign was paused or cancelled mid-flight
      const fresh = (await deps.marketingStore.listCampaigns(orgId)).find((x) => x.id === campaign.id);
      if (fresh && (fresh.status === 'cancelled' || fresh.status === 'paused')) break;

      const vars = buildSubscriberVarMap(contact);
      const subject = renderPersonalizedContent(rawSubject, vars);
      let html = renderPersonalizedContent(rawHtml, vars);
      let text = renderPersonalizedContent(rawText || htmlToPlainText(html), vars);
      let headers: Record<string, string> = {};
      if (campaign.replyTo) headers['Reply-To'] = campaign.replyTo;

      const messageRefId = uuidv7();
      const recipientId = uuidv7();

      if (deps.analyticsStore) {
        const tracked = await instrumentTrackedEmail({
          baseUrl: publicBaseUrl,
          organizationId: orgId,
          messageId: messageRefId,
          recipientEmail: contact.email,
          campaignId: campaign.id,
          domainId: domain.id,
          subscriberId: contact.id,
          htmlBody: html,
          textBody: text,
          createTrackingToken: async (t) => deps.analyticsStore!.createTrackingToken(t),
        });
        html = tracked.html;
        text = tracked.text;
        headers = { ...headers, ...tracked.headers };
      }

      const envFromAddr = domain.customReturnPathDomain
        ? `bounces+${recipientId}@${domain.customReturnPathDomain}`
        : `bounces+${recipientId}@${domain.domainName}`;

      const mime = buildBasicRfc5322Mime({
        from: campaign.fromName ? `${campaign.fromName} <${fromAddr}>` : fromAddr,
        to: [contact.email],
        subject,
        html,
        text,
        headers,
      });
      const spooled = await deps.emails.spool.writeMime(orgId, mime);
      const sub = await deps.emails.store.submitTransactionalEmail({
        organizationId: orgId,
        domainId: domain.id,
        from: fromAddr,
        envelopeFrom: envFromAddr,
        recipients: [contact.email],
        subject,
        bodyStorageKey: spooled.storageKey,
        sizeBytes: spooled.sizeBytes,
        sourceType: 'campaign',
        campaignId: campaign.id,
        recipientId,
        routingKey: 'mail.outbound.bulk',
      });
      await deps.marketingStore.markCampaignRecipientStatus?.(campaign.id, contact.email, 'queued', sub.messageId);
      sent += 1;
    }
    return sent;
  };

  if (deps.jwtSecret && deps.marketingStore) {
    app.use(
      '/v1',
      createMarketingRouter({
        store: deps.marketingStore,
        jwtSecret: deps.jwtSecret,
        ...(deps.analyticsStore ? { analyticsStore: deps.analyticsStore } : {}),
        ...(deps.domainStore ? { domainStore: deps.domainStore } : {}),
        ...(deps.emails && deps.domainStore
          ? {
              onCampaignStarted: dispatchCampaignBroadcast,
              onSendTestEmail: async (input) => {
                const dom = await deps.domainStore!.getDomain(input.organizationId, input.domainId);
                if (!dom) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found');
                const headers: Record<string, string> = {};
                if (input.replyTo) headers['Reply-To'] = input.replyTo;
                const mime = buildBasicRfc5322Mime({
                  from: input.fromName ? `${input.fromName} <${input.fromEmail}>` : input.fromEmail,
                  to: [input.toEmail],
                  subject: input.subject,
                  html: input.htmlBody,
                  text: input.textBody,
                  headers,
                });
                const spooled = await deps.emails!.spool.writeMime(input.organizationId, mime);
                await deps.emails!.store.submitTransactionalEmail({
                  organizationId: input.organizationId,
                  domainId: dom.id,
                  from: input.fromEmail,
                  envelopeFrom: dom.customReturnPathDomain ? `bounces@${dom.customReturnPathDomain}` : input.fromEmail,
                  recipients: [input.toEmail],
                  subject: input.subject,
                  bodyStorageKey: spooled.storageKey,
                  sizeBytes: spooled.sizeBytes,
                });
              },
              onCancelCampaign: async (orgId, campaignId) =>
                deps.marketingStore!.cancelBroadcastRecipients
                  ? deps.marketingStore!.cancelBroadcastRecipients(orgId, campaignId)
                  : { cancelledCount: 0, handedOffCount: 0 },
            }
          : {}),
      })
    );
    app.use(
      '/v1',
      createMarketingPlatformRouter({
        store: deps.marketingStore,
        jwtSecret: deps.jwtSecret,
        ...(deps.analyticsStore ? { analyticsStore: deps.analyticsStore } : {}),
      })
    );
  }
  if (deps.jwtSecret && deps.webhookStore) {
    app.use('/v1', createWebhooksRouter({ store: deps.webhookStore, jwtSecret: deps.jwtSecret }));
  }
  if (deps.jwtSecret && deps.analyticsStore) {
    app.use(
      '/v1',
      createAnalyticsRouter({ store: deps.analyticsStore, jwtSecret: deps.jwtSecret })
    );
  }
  if (deps.analyticsStore && deps.marketingStore) {
    app.use(
      '/v1',
      createPublicTrackingRouter({
        analyticsStore: deps.analyticsStore,
        marketingStore: deps.marketingStore,
      })
    );
  }
  if (deps.emails) {
    const emailRouterDeps: Parameters<typeof createEmailsRouter>[0] = {
      ...deps.emails,
      ...(deps.jwtSecret ? { jwtSecret: deps.jwtSecret } : {}),
      ...(deps.credentialsStore
        ? {
            apiKeys: {
              findActiveByHash: (h) => deps.credentialsStore!.findActiveByHash(h),
              touchLastUsed: (id) => deps.credentialsStore!.touchLastUsed(id),
            },
          }
        : {}),
      ...(deps.domainStore ? { domainStore: deps.domainStore } : {}),
      ...(deps.marketingStore
        ? {
            filterSuppressedRecipients: async (orgId, emails) => {
              const suppressed = new Set(
                (await deps.marketingStore!.listSuppressions(orgId)).map((s) => s.email.toLowerCase())
              );
              return emails.filter((e) => !suppressed.has(e.toLowerCase()));
            },
          }
        : {}),
    };
    app.use('/v1', createEmailsRouter(emailRouterDeps));
  }
  if (deps.jwtSecret && deps.adminStore) {
    app.use('/admin/v1', createAdminRouter({ store: deps.adminStore, jwtSecret: deps.jwtSecret }));
  }

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  app.use(createErrorHandler(deps.logger));
  return app;
}
