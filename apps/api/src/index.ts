import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { hashPasswordArgon2id } from './auth/security.js';
import { loadConfig } from './config.js';
import { RabbitMqManagementClient } from './infra/connectors.js';
import { StructuredLogger } from './logger.js';
import { AdminControlStore } from './routes/admin.js';
import { InMemoryAnalyticsStore } from './routes/analytics.js';
import { InMemoryAuthStore } from './routes/auth.js';
import { InMemoryMarketingStore } from './routes/campaigns.js';
import { InMemoryCredentialsStore } from './routes/credentials.js';
import {
  createHttpMtaSyncClient,
  InMemoryDomainStore,
} from './routes/domains.js';
import {
  createNodeDnsAdapter,
  getInfraDnsConfig,
  runFullDomainDiagnostics,
} from './services/dns-verifier.js';
import { LocalSpoolWriter, PgEmailSubmissionStore, S3SpoolWriter } from './routes/emails.js';
import { InMemoryMailboxStore } from './routes/mailboxes.js';
import type { ReadinessDeps } from './routes/health.js';
import { InMemoryWebhookStore } from './routes/webhooks.js';
import {
  PgAnalyticsStore,
  PgAuthStore,
  PgCredentialsStore,
  PgDomainStore,
  PgMailboxStore,
  PgMarketingStore,
  PgWebhookStore,
} from './stores/pg-stores.js';

const config = loadConfig();
const logger = new StructuredLogger('api');
const pgPool = new Pool({ connectionString: config.DATABASE_URL, max: 20 });
const useInMemory = process.env.USE_IN_MEMORY_STORES === 'true';

const authStore = useInMemory ? new InMemoryAuthStore() : new PgAuthStore(pgPool);
const domainStore = useInMemory ? new InMemoryDomainStore() : new PgDomainStore(pgPool);
const mailboxStore = useInMemory ? new InMemoryMailboxStore() : new PgMailboxStore(pgPool);
const credentialsStore = useInMemory
  ? new InMemoryCredentialsStore()
  : new PgCredentialsStore(pgPool);
const marketingStore = useInMemory ? new InMemoryMarketingStore() : new PgMarketingStore(pgPool);
const webhookStore = useInMemory
  ? new InMemoryWebhookStore()
  : new PgWebhookStore(pgPool, process.env.KEY_ENCRYPTION_SECRET ?? config.JWT_ACCESS_SECRET);
const analyticsStore = useInMemory ? new InMemoryAnalyticsStore() : new PgAnalyticsStore(pgPool);

const readiness: ReadinessDeps = {
  checkPostgres: async () => {
    const result = await pgPool.query('SELECT 1');
    return result.rowCount === 1;
  },
};

const rabbitMqManagement = config.RABBITMQ_MANAGEMENT_URL
  ? new RabbitMqManagementClient(
      config.RABBITMQ_MANAGEMENT_URL,
      config.RABBITMQ_USER,
      config.RABBITMQ_PASSWORD
    )
  : undefined;

const adminStore = new AdminControlStore({
  authStore,
  domainStore,
  analyticsStore,
  infra: {
    readiness,
    ...(!useInMemory ? { pgPool } : {}),
    ...(config.REDIS_URL ? { redisUrl: config.REDIS_URL } : {}),
    ...(config.MAIL_ENGINE_CONTROL_TOKEN
      ? { mtaControlToken: config.MAIL_ENGINE_CONTROL_TOKEN }
      : {}),
    ...(rabbitMqManagement ? { rabbitMqManagement } : {}),
  },
});

if (config.MAIL_ENGINE_CONTROL_URL) {
  adminStore.registerNode(
    {
      id: config.MAIL_ENGINE_NODE_ID,
      hostname: new URL(config.MAIL_ENGINE_CONTROL_URL).hostname,
      roles: ['ingress', 'outbound', 'inbound'],
      controlUrl: config.MAIL_ENGINE_CONTROL_URL,
    },
    { userId: 'system-bootstrap', ip: null }
  );
}

const mtaDomainSync = createHttpMtaSyncClient(
  config.MAIL_ENGINE_CONTROL_URL,
  config.MAIL_ENGINE_CONTROL_TOKEN
);

const app = createApp({
  corsOrigins: config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  adminCorsOrigins: config.ADMIN_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  logger,
  jwtSecret: config.JWT_ACCESS_SECRET,
  authStore,
  domainStore,
  mtaDomainSync,
  mailboxStore,
  credentialsStore,
  marketingStore,
  webhookStore,
  analyticsStore,
  adminStore,
  readiness,
  emails: {
    store: new PgEmailSubmissionStore(pgPool),
    spool:
      config.SPOOL_BACKEND === 's3' && config.S3_ENDPOINT
        ? new S3SpoolWriter({
            endpoint: config.S3_ENDPOINT,
            region: config.S3_REGION,
            bucket: config.S3_BUCKET,
            accessKey: config.S3_ACCESS_KEY ?? '',
            secretKey: config.S3_SECRET_KEY ?? '',
          })
        : new LocalSpoolWriter(config.SPOOL_DIR),
  },
});

const server = app.listen(config.API_PORT, config.API_HOST, () => {
  logger.info('API server started', {
    host: config.API_HOST,
    port: config.API_PORT,
    env: config.NODE_ENV,
    persistence: useInMemory ? 'in-memory' : 'postgres',
  });
});

async function bootstrapFromEnv(): Promise<void> {
  await adminStore.hydrateFromPostgres();
  if (!config.ADMIN_BOOTSTRAP_EMAIL || !config.ADMIN_BOOTSTRAP_PASSWORD) return;

  let orgId: string;
  if (authStore instanceof PgAuthStore) {
    const existing = await authStore.findUserByEmail(config.ADMIN_BOOTSTRAP_EMAIL);
    if (existing?.orgId) {
      orgId = existing.orgId;
    } else {
      const passwordHash = await hashPasswordArgon2id(config.ADMIN_BOOTSTRAP_PASSWORD);
      const seeded = await authStore.seedSuperAdminFromBootstrap({
        email: config.ADMIN_BOOTSTRAP_EMAIL,
        fullName: config.ADMIN_BOOTSTRAP_ORG,
        passwordHash,
        organizationName: config.ADMIN_BOOTSTRAP_ORG,
      });
      orgId = seeded.orgId;
    }
  } else {
    const existing = await authStore.findUserByEmail(config.ADMIN_BOOTSTRAP_EMAIL);
    if (existing) return;
    const passwordHash = await hashPasswordArgon2id(config.ADMIN_BOOTSTRAP_PASSWORD);
    orgId = randomUUID();
    const userId = randomUUID();
    (authStore as InMemoryAuthStore).seedUser({
      id: userId,
      email: config.ADMIN_BOOTSTRAP_EMAIL.toLowerCase(),
      fullName: config.ADMIN_BOOTSTRAP_ORG,
      passwordHash,
      status: 'active',
      platformRole: 'super_admin',
      orgId,
      orgRole: 'owner',
      mfaEnabled: false,
    });
    adminStore.upsertOrganization({
      id: orgId,
      name: config.ADMIN_BOOTSTRAP_ORG,
      slug: 'primary',
      status: 'active',
      sendingMode: 'live',
      dailySendLimit: 100_000,
      monthlySendLimit: 3_000_000,
      defaultIpPoolId: null,
      createdAt: new Date().toISOString(),
    });
  }

  if (config.PRIMARY_DOMAIN) {
    const normalized = config.PRIMARY_DOMAIN.toLowerCase();
    const existingDomains = await domainStore.listDomains(orgId);
    if (!existingDomains.some((d) => d.domainName === normalized)) {
      const dom = await domainStore.createDomain({
        organizationId: orgId,
        domainName: normalized,
        sendingEnabled: true,
        hostingEnabled: true,
      });
      await domainStore.markVerified(orgId, dom.id);
      logger.info('Bootstrapped primary domain & workspace from environment', {
        organizationId: orgId,
        domainId: dom.id,
        domainName: dom.domainName,
        adminEmail: config.ADMIN_BOOTSTRAP_EMAIL.toLowerCase(),
      });
    }
  }
}

void bootstrapFromEnv().catch((err) => {
  logger.error('Failed bootstrapping environment workspace', {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Background periodic DNS re-verification for pending domains and stale diagnostics
const dnsAutoTimer = setInterval(() => {
  if (useInMemory || !domainStore.listAllDomains) return;
  void (async () => {
    try {
      const all = await domainStore.listAllDomains!();
      const now = Date.now();
      const pendingOrStale = all.filter((d) => {
        if (d.isSuspended) return false;
        const lastMs = d.lastDnsCheckedAt ? Date.parse(d.lastDnsCheckedAt) : 0;
        if (!d.ownershipVerifiedAt) return now - lastMs > 120_000;
        return now - lastMs > 6 * 60 * 60 * 1000;
      });
      if (pendingOrStale.length === 0) return;

      const adapter = createNodeDnsAdapter(config.DNS_CHECK_TIMEOUT_MS);
      const mtaStatus = await mtaDomainSync.getDkimStatus().catch(() => null);
      for (const dom of pendingOrStale.slice(0, 5)) {
        const keys = domainStore.listDkimKeys ? await domainStore.listDkimKeys(dom.id) : [];
        const mtaLoaded = mtaStatus?.activeSelectors?.[dom.domainName.toLowerCase()];
        const report = await runFullDomainDiagnostics(
          { ...dom, dkimKeys: keys, mtaLoadedSelectors: mtaLoaded },
          adapter,
          getInfraDnsConfig()
        );
        if (report.ownershipMatched && !dom.ownershipVerifiedAt) {
          await domainStore.markVerified(dom.organizationId, dom.id);
        }
        await domainStore.recordDnsCheckResult?.(dom.id, report);
      }
    } catch (err) {
      logger.warn('Background DNS verification sweep skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}, 120_000);
dnsAutoTimer.unref();

async function shutdown(signal: string): Promise<void> {
  clearInterval(dnsAutoTimer);
  logger.info('Shutting down API server', { signal });
  server.close(async () => {
    await pgPool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
