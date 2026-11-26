import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from './app.js';
import { StructuredLogger } from './logger.js';
import { InMemoryAnalyticsStore } from './routes/analytics.js';
import { InMemoryAuthStore } from './routes/auth.js';
import { InMemoryMarketingStore } from './routes/campaigns.js';
import { InMemoryCredentialsStore } from './routes/credentials.js';
import { InMemoryDomainStore } from './routes/domains.js';
import { InMemoryMailboxStore } from './routes/mailboxes.js';
import { InMemoryWebhookStore, signWebhookPayload } from './routes/webhooks.js';

describe('@mail/api', () => {
  const logger = new StructuredLogger('api-test');
  let postgresHealthy = true;
  let server: Server;
  let baseUrl: string;
  const submitted: Array<{ from: string; recipients: string[]; storageKey: string }> = [];

  const authStore = new InMemoryAuthStore();
  const domainStore = new InMemoryDomainStore();
  const credentialsStore = new InMemoryCredentialsStore();

  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    logger,
    jwtSecret: 'test_secret_with_at_least_32_characters_here',
    authStore,
    domainStore,
    mailboxStore: new InMemoryMailboxStore(),
    credentialsStore,
    marketingStore: new InMemoryMarketingStore(),
    webhookStore: new InMemoryWebhookStore(),
    analyticsStore: new InMemoryAnalyticsStore(),
    readiness: {
      checkPostgres: async () => postgresHealthy,
    },
    emails: {
      store: {
        submitTransactionalEmail: async (params) => {
          submitted.push({
            from: params.from,
            recipients: params.recipients,
            storageKey: params.bodyStorageKey,
          });
          return {
            messageId: '01930000-0000-7000-8000-000000000001',
            recipientCount: params.recipients.length,
            deduplicated: false,
          };
        },
      },
      spool: {
        writeMime: async (orgId, buf) => ({
          storageKey: `${orgId}/01/test.eml`,
          sizeBytes: buf.byteLength,
        }),
      },
    },
  });

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns 200 on /healthz and sets x-request-id', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('x-request-id'));
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'ok');
  });

  it('returns 200 on /readyz when dependencies are healthy and 503 when degraded', async () => {
    postgresHealthy = true;
    const okRes = await fetch(`${baseUrl}/readyz`);
    assert.equal(okRes.status, 200);

    postgresHealthy = false;
    const degradedRes = await fetch(`${baseUrl}/readyz`);
    assert.equal(degradedRes.status, 503);
    const body = (await degradedRes.json()) as { status: string; checks: { postgres: boolean } };
    assert.equal(body.status, 'degraded');
    assert.equal(body.checks.postgres, false);
  });

  it('handles Argon2id register, refresh rotation + reuse revocation, domains & mailboxes RBAC', async () => {
    const reg = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@acme.test',
        password: 'VeryStrongPassword123!',
        fullName: 'Alice Owner',
        organizationName: 'Acme Corp',
      }),
    });
    assert.equal(reg.status, 201);
    const regJson = (await reg.json()) as { accessToken: string; refreshToken: string };
    assert.ok(regJson.accessToken);

    // Refresh token rotation
    const ref1 = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: regJson.refreshToken }),
    });
    assert.equal(ref1.status, 200);
    const ref1Json = (await ref1.json()) as { accessToken: string; refreshToken: string };

    // Reusing old refresh token must fail & revoke family
    const reuse = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: regJson.refreshToken }),
    });
    assert.equal(reuse.status, 401);

    // Create domain + verify + create mailbox + alias
    const domRes = await fetch(`${baseUrl}/v1/domains`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ref1Json.accessToken}`,
      },
      body: JSON.stringify({ domainName: 'acme.test', hostingEnabled: true, sendingEnabled: true }),
    });
    assert.equal(domRes.status, 201);
    const domJson = (await domRes.json()) as { domain: { id: string; domainName: string } };

    const mbRes = await fetch(`${baseUrl}/v1/mailboxes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ref1Json.accessToken}`,
      },
      body: JSON.stringify({
        domainId: domJson.domain.id,
        domainName: domJson.domain.domainName,
        localPart: 'support',
        password: 'MailboxPassword123!',
        displayName: 'Acme Support',
      }),
    });
    assert.equal(mbRes.status, 201);
    const mbJson = (await mbRes.json()) as { mailbox: { emailAddress: string } };
    assert.equal(mbJson.mailbox.emailAddress, 'support@acme.test');
  });

  it('requires authenticated mk_live API key + verified domain on POST /v1/emails and blocks CRLF injection', async () => {
    const unauth = await fetch(`${baseUrl}/v1/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-organization-id': 'spoofed-org',
        'x-domain-id': 'spoofed-dom',
      },
      body: JSON.stringify({
        from: 'noreply@example.com',
        to: ['alice@example.org'],
        subject: 'Spoof attempt',
        text: 'Welcome',
      }),
    });
    assert.equal(unauth.status, 401);

    // Register org, create + verify domain, issue mk_live_* key
    const reg = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'mailer@sendtest.org',
        password: 'SendTestPassword!123',
        fullName: 'Mailer',
        organizationName: 'SendTest Inc',
      }),
    });
    assert.equal(reg.status, 201);
    const { accessToken } = (await reg.json()) as { accessToken: string };

    const domRes = await fetch(`${baseUrl}/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ domainName: 'sendtest.org', sendingEnabled: true, hostingEnabled: false }),
    });
    const { domain } = (await domRes.json()) as { domain: { id: string } };

    // Unverified domain must fail 403
    const keyRes = await fetch(`${baseUrl}/v1/api-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name: 'Mailer Key', scopes: ['emails:send'], rateLimitRpm: 100 }),
    });
    const { secret: apiKey } = (await keyRes.json()) as { secret: string };

    const unverifiedSend = await fetch(`${baseUrl}/v1/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        domainId: domain.id,
        from: 'noreply@sendtest.org',
        to: ['alice@example.org'],
        subject: 'Before verify',
        text: 'Hello',
      }),
    });
    assert.equal(unverifiedSend.status, 403);

    await fetch(`${baseUrl}/v1/domains/${domain.id}/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    // CRLF injection in subject must fail 400
    const crlf = await fetch(`${baseUrl}/v1/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        domainId: domain.id,
        from: 'noreply@sendtest.org',
        to: ['alice@example.org'],
        subject: 'Hello\r\nBcc: attacker@evil.test',
        text: 'Welcome',
      }),
    });
    assert.equal(crlf.status, 400);

    // Mismatched From domain must fail 403
    const mismatch = await fetch(`${baseUrl}/v1/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        domainId: domain.id,
        from: 'noreply@other-domain.com',
        to: ['alice@example.org'],
        subject: 'Hello',
        text: 'Welcome',
      }),
    });
    assert.equal(mismatch.status, 403);

    const ok = await fetch(`${baseUrl}/v1/emails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        domainId: domain.id,
        from: 'noreply@sendtest.org',
        to: ['alice@example.org'],
        subject: 'Hello',
        text: 'Welcome',
        idempotencyKey: 'idem-12345678',
      }),
    });
    assert.equal(ok.status, 202);
    const body = (await ok.json()) as { id: string; status: string; recipientCount: number; traceId: string };
    assert.equal(body.status, 'queued');
    assert.equal(body.recipientCount, 1);
    assert.ok(body.traceId);
    assert.equal(submitted.length, 1);
  });

  it('returns 404 JSON on unknown routes', async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('supports Phase 8 API keys & SMTP reveal-once secrets, campaigns, webhooks, tracking, analytics CSV, and billing', async () => {
    const reg = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'dev@phase8.test',
        password: 'Phase8Password!123',
        fullName: 'Dev User',
        organizationName: 'Phase 8 Org',
      }),
    });
    assert.equal(reg.status, 201);
    const { accessToken } = (await reg.json()) as { accessToken: string };
    const authHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    };

    // 1. Reveal-once API key create + list (no secret leaked) + rotate
    const keyRes = await fetch(`${baseUrl}/v1/api-keys`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Production Backend', scopes: ['emails:send'], rateLimitRpm: 1200 }),
    });
    assert.equal(keyRes.status, 201);
    const keyCreated = (await keyRes.json()) as { apiKey: { id: string }; secret: string };
    assert.ok(keyCreated.secret.startsWith('mk_live_'));

    const listKeys = await fetch(`${baseUrl}/v1/api-keys`, { headers: authHeaders });
    const listKeysJson = (await listKeys.json()) as { apiKeys: Array<Record<string, unknown>> };
    assert.equal(listKeysJson.apiKeys.length, 1);
    assert.equal(listKeysJson.apiKeys[0]?.secret, undefined);

    const rotKey = await fetch(`${baseUrl}/v1/api-keys/${keyCreated.apiKey.id}/rotate`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(rotKey.status, 200);
    const rotKeyJson = (await rotKey.json()) as { secret: string };
    assert.notEqual(rotKeyJson.secret, keyCreated.secret);

    // 2. SMTP credential create & reveal-once password
    const smtpRes = await fetch(`${baseUrl}/v1/smtp-credentials`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ allowedSenderPatterns: ['*@phase8.test'], maxRatePerMin: 200 }),
    });
    assert.equal(smtpRes.status, 201);
    const smtpJson = (await smtpRes.json()) as {
      credential: { id: string; username: string };
      secretPassword: string;
    };
    assert.ok(smtpJson.credential.username.startsWith('smtp_'));
    assert.ok(smtpJson.secretPassword.length >= 20);

    // 3. Suppression + consent-gated contact import skipping suppressed recipient + campaign pause
    const supRes = await fetch(`${baseUrl}/v1/suppressions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email: 'bounced@example.net', reason: 'hard_bounce' }),
    });
    assert.equal(supRes.status, 201);

    const impRes = await fetch(`${baseUrl}/v1/contacts/import`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        consentSource: 'web_signup_2026',
        contacts: [
          { email: 'bounced@example.net', firstName: 'Bounce' },
          { email: 'alice@example.net', firstName: 'Alice', tags: ['newsletter'] },
        ],
      }),
    });
    assert.equal(impRes.status, 201);
    const impJson = (await impRes.json()) as { imported: number; skippedSuppressed: number };
    assert.equal(impJson.imported, 1);
    assert.equal(impJson.skippedSuppressed, 1);

    const tplRes = await fetch(`${baseUrl}/v1/templates`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Welcome Sequence',
        subject: 'Welcome {{firstName}}',
        htmlBody: '<p>Hi {{firstName}}</p>',
      }),
    });
    assert.equal(tplRes.status, 201);
    const tplJson = (await tplRes.json()) as { template: { id: string } };

    const previewRes = await fetch(`${baseUrl}/v1/templates/preview`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        subject: 'Welcome {{firstName}}',
        htmlBody: '<p>Hi {{firstName}}</p>',
        variables: { firstName: 'Alice' },
      }),
    });
    assert.equal(previewRes.status, 200);
    const previewJson = (await previewRes.json()) as { subject: string; htmlBody: string };
    assert.equal(previewJson.subject, 'Welcome Alice');

    const campRes = await fetch(`${baseUrl}/v1/campaigns`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        domainId: 'dom-1',
        templateId: tplJson.template.id,
        name: 'Q4 Launch',
        tagFilter: 'newsletter',
      }),
    });
    assert.equal(campRes.status, 201);
    const campJson = (await campRes.json()) as { campaign: { id: string; targetCount: number } };
    assert.equal(campJson.campaign.targetCount, 1);

    const pauseRes = await fetch(`${baseUrl}/v1/campaigns/${campJson.campaign.id}/pause`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(pauseRes.status, 200);
    const pauseJson = (await pauseRes.json()) as { campaign: { status: string } };
    assert.equal(pauseJson.campaign.status, 'paused');

    // 4. Webhook creation + HMAC-SHA256 verification
    const whRes = await fetch(`${baseUrl}/v1/webhooks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: 'https://hooks.example.com/mail-events',
        eventTypes: ['delivered', 'bounced'],
      }),
    });
    assert.equal(whRes.status, 201);
    const whJson = (await whRes.json()) as { signingSecret: string };
    const sig = signWebhookPayload(whJson.signingSecret, 1700000000, '{"event":"delivered"}');
    assert.match(sig, /^t=1700000000,v1=[a-f0-9]{64}$/);

    // 5. Analytics events, tracking tokens, RFC 8058 one-click unsubscribe + CSV export
    await fetch(`${baseUrl}/v1/analytics/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        messageId: 'msg-100',
        recipientEmail: 'alice@example.net',
        eventType: 'delivered',
        domain: 'example.net',
        latencyMs: 145,
      }),
    });

    const unsubTokRes = await fetch(`${baseUrl}/v1/tracking/tokens`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        messageId: 'msg-100',
        recipientEmail: 'alice@example.net',
        kind: 'unsubscribe',
      }),
    });
    assert.equal(unsubTokRes.status, 201);
    const { token: unsubTok } = (await unsubTokRes.json()) as { token: { token: string } };

    const unsubPost = await fetch(`${baseUrl}/v1/unsubscribe/${unsubTok.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(unsubPost.status, 200);
    const unsubJson = (await unsubPost.json()) as { unsubscribed: boolean; reason: string };
    assert.equal(unsubJson.unsubscribed, true);
    assert.equal(unsubJson.reason, 'unsubscribe');

    const overviewRes = await fetch(`${baseUrl}/v1/analytics/overview?range=7d`, { headers: authHeaders });
    assert.equal(overviewRes.status, 200);
    const ovJson = (await overviewRes.json()) as {
      overview: { counts: { delivered: number; unsubscribed: number }; avgLatencyMs: number };
    };
    assert.equal(ovJson.overview.counts.delivered, 1);
    assert.equal(ovJson.overview.counts.unsubscribed, 1);
    assert.equal(ovJson.overview.avgLatencyMs, 145);

    const csvRes = await fetch(`${baseUrl}/v1/analytics/export.csv?range=7d`, { headers: authHeaders });
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('alice@example.net'));

    // 6. Multi-tier billing plan upgrade + invoice generation
    const upgRes = await fetch(`${baseUrl}/v1/billing/upgrade`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ planId: 'growth' }),
    });
    assert.equal(upgRes.status, 200);
    const upgJson = (await upgRes.json()) as { plan: { id: string }; invoice: { amountUsd: number } };
    assert.equal(upgJson.plan.id, 'growth');
    assert.equal(upgJson.invoice.amountUsd, 99);

    // 7. Webhook SSRF guard rejects loopback and metadata URLs + GET unsubscribe does not auto-mutate
    const ssrfRes = await fetch(`${baseUrl}/v1/webhooks`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        url: 'http://169.254.169.254/latest/meta-data',
        eventTypes: ['delivered'],
      }),
    });
    assert.equal(ssrfRes.status, 400);

    const getUnsubRes = await fetch(`${baseUrl}/v1/unsubscribe/safe-preview-token`);
    assert.equal(getUnsubRes.status, 200);
    const getUnsubHtml = await getUnsubRes.text();
    assert.ok(getUnsubHtml.includes('<form method="POST"'));
  });
});
