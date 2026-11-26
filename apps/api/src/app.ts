import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { StructuredLogger } from './logger.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { type AdminControlStore, createAdminRouter } from './routes/admin.js';
import {
  type AnalyticsStore,
  createAnalyticsRouter,
  createPublicTrackingRouter,
  InMemoryAnalyticsStore,
} from './routes/analytics.js';
import { type AuthStore, createAuthRouter } from './routes/auth.js';
import { createMarketingRouter, type MarketingStore } from './routes/campaigns.js';
import { createCredentialsRouter, type CredentialsStore } from './routes/credentials.js';
import { createDomainsRouter, type DomainStore } from './routes/domains.js';
import {
  buildBasicRfc5322Mime,
  createEmailsRouter,
  type EmailSubmissionStore,
  type SpoolWriter,
} from './routes/emails.js';
import { createHealthRouter, type ReadinessDeps } from './routes/health.js';
import { createMailboxesRouter, type MailboxStore } from './routes/mailboxes.js';
import { createWebhooksRouter, type WebhookStore } from './routes/webhooks.js';

export interface AppDependencies {
  corsOrigins: string[];
  adminCorsOrigins?: string[];
  logger: StructuredLogger;
  readiness: ReadinessDeps;
  jwtSecret?: string;
  authStore?: AuthStore;
  domainStore?: DomainStore;
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
    app.use('/v1', createDomainsRouter({ store: deps.domainStore, jwtSecret: deps.jwtSecret }));
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
  if (deps.jwtSecret && deps.marketingStore) {
    app.use(
      '/v1',
      createMarketingRouter({
        store: deps.marketingStore,
        jwtSecret: deps.jwtSecret,
        ...(deps.emails && deps.domainStore
          ? {
              onCampaignStarted: async (campaign) => {
                const orgId = campaign.organizationId;
                const domain = await deps.domainStore!.getDomain(orgId, campaign.domainId);
                if (!domain || !domain.ownershipVerifiedAt || !domain.sendingEnabled || domain.isSuspended) {
                  return 0;
                }
                const templates = await deps.marketingStore!.listTemplates(orgId);
                const tpl = templates.find((t) => t.id === campaign.templateId);
                const tplVer = tpl?.versions[tpl.versions.length - 1];
                if (!tplVer) return 0;

                const suppressed = new Set(
                  (await deps.marketingStore!.listSuppressions(orgId)).map((s) => s.email.toLowerCase())
                );
                const contacts = (
                  await deps.marketingStore!.listContacts(orgId, campaign.tagFilter ?? undefined)
                ).filter((c) => !c.unsubscribedAt && !suppressed.has(c.email.toLowerCase()));

                let sent = 0;
                const chunkSize = 500;
                for (let i = 0; i < contacts.length; i += chunkSize) {
                  const chunk = contacts.slice(i, i + chunkSize);
                  for (const contact of chunk) {
                    const render = (text: string) =>
                      text
                        .replaceAll('{{firstName}}', contact.firstName || '')
                        .replaceAll('{{lastName}}', contact.lastName || '')
                        .replaceAll('{{email}}', contact.email);
                    const fromAddr = `campaign@${domain.domainName}`;
                    const subject = render(tplVer.subject);
                    const mime = buildBasicRfc5322Mime({
                      from: fromAddr,
                      to: [contact.email],
                      subject,
                      html: render(tplVer.htmlBody),
                      text: render(tplVer.textBody),
                    });
                    const spooled = await deps.emails!.spool.writeMime(orgId, mime);
                    await deps.emails!.store.submitTransactionalEmail({
                      organizationId: orgId,
                      domainId: domain.id,
                      from: fromAddr,
                      recipients: [contact.email],
                      subject,
                      bodyStorageKey: spooled.storageKey,
                      sizeBytes: spooled.sizeBytes,
                    });
                    sent += 1;
                  }
                }
                return sent;
              },
            }
          : {}),
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
