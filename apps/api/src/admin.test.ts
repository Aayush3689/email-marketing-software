import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from './app.js';
import { hashPasswordArgon2id } from './auth/security.js';
import { generateTotpCode } from './auth/totp.js';
import { RabbitMqManagementClient } from './infra/connectors.js';
import { StructuredLogger } from './logger.js';
import { AdminControlStore } from './routes/admin.js';
import { InMemoryAnalyticsStore } from './routes/analytics.js';
import { InMemoryAuthStore } from './routes/auth.js';
import { InMemoryDomainStore } from './routes/domains.js';
import { InMemoryMailboxStore } from './routes/mailboxes.js';

describe('Phase 9 Super Admin & Infra Integration (/admin/v1)', () => {
  const logger = new StructuredLogger('admin-test');
  const jwtSecret = 'phase9_super_admin_test_secret_at_least_32_chars';

  let apiServer: Server;
  let mtaControlServer: Server;
  let rabbitMgmtServer: Server;
  let baseUrl: string;
  let mtaControlUrl: string;
  let mtaDraining = false;

  const dlqMessages = [{ payload: '{"messageId":"msg-1"}', payload_encoding: 'string' }];
  const republishedTo: string[] = [];

  const authStore = new InMemoryAuthStore();
  const domainStore = new InMemoryDomainStore();
  const analyticsStore = new InMemoryAnalyticsStore();

  let adminStore: AdminControlStore;

  before(async () => {
    mtaControlServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/control/drain') {
        mtaDraining = true;
        res.end(JSON.stringify({ draining: true, status: 'draining' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/control/resume') {
        mtaDraining = false;
        res.end(JSON.stringify({ draining: false, status: 'healthy' }));
        return;
      }
      res.end(
        JSON.stringify({
          nodeId: 'mta-node-1',
          roles: ['ingress', 'outbound'],
          status: mtaDraining ? 'draining' : 'healthy',
          draining: mtaDraining,
          activeConnections: 3,
        })
      );
    });
    await new Promise<void>((r) => mtaControlServer.listen(0, '127.0.0.1', () => r()));
    mtaControlUrl = `http://127.0.0.1:${(mtaControlServer.address() as AddressInfo).port}`;

    rabbitMgmtServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/overview') {
        res.end(JSON.stringify({ rabbitmq_version: '3.13.7' }));
        return;
      }
      if (req.url === '/api/queues') {
        res.end(
          JSON.stringify([
            { name: 'mail.outbound.transactional', messages_ready: 4, messages_unacknowledged: 1, consumers: 2 },
            { name: 'mail.outbound.bulk.dlq', messages_ready: dlqMessages.length, messages_unacknowledged: 0, consumers: 0 },
          ])
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/api/queues/%2F/mail.outbound.bulk.dlq/get') {
        const drained = dlqMessages.splice(0, dlqMessages.length);
        res.end(JSON.stringify(drained));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/exchanges/%2F/amq.default/publish') {
        let raw = '';
        req.on('data', (c) => {
          raw += String(c);
        });
        req.on('end', () => {
          const parsed = JSON.parse(raw) as { routing_key: string };
          republishedTo.push(parsed.routing_key);
          res.end(JSON.stringify({ routed: true }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => rabbitMgmtServer.listen(0, '127.0.0.1', () => r()));
    const rabbitUrl = `http://127.0.0.1:${(rabbitMgmtServer.address() as AddressInfo).port}`;

    adminStore = new AdminControlStore({
      authStore,
      domainStore,
      analyticsStore,
      infra: {
        readiness: { checkPostgres: async () => true },
        rabbitMqManagement: new RabbitMqManagementClient(rabbitUrl, 'mailplat', 'secret'),
      },
    });

    const app = createApp({
      corsOrigins: ['http://localhost:5175'],
      logger,
      jwtSecret,
      authStore,
      domainStore,
      mailboxStore: new InMemoryMailboxStore(),
      analyticsStore,
      adminStore,
      readiness: { checkPostgres: async () => true },
    });

    await new Promise<void>((r) => {
      apiServer = app.listen(0, '127.0.0.1', () => r());
    });
    baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

    // Seed a super_admin and a platform_operator
    authStore.seedUser({
      id: '00000000-0000-4000-8000-000000000001',
      email: 'root@mailforge.internal',
      fullName: 'Root SuperAdmin',
      passwordHash: await hashPasswordArgon2id('SuperAdminPass!123'),
      status: 'active',
      platformRole: 'super_admin',
      orgId: null,
      orgRole: null,
      mfaEnabled: false,
    });
    authStore.seedUser({
      id: '00000000-0000-4000-8000-000000000002',
      email: 'ops@mailforge.internal',
      fullName: 'Ops Operator',
      passwordHash: await hashPasswordArgon2id('OperatorPass!123'),
      status: 'active',
      platformRole: 'platform_operator',
      orgId: null,
      orgRole: null,
      mfaEnabled: false,
    });
  });

  after(async () => {
    apiServer?.closeAllConnections();
    mtaControlServer?.closeAllConnections();
    rabbitMgmtServer?.closeAllConnections();
    await Promise.all([
      apiServer ? new Promise<void>((r) => apiServer.close(() => r())) : Promise.resolve(),
      mtaControlServer
        ? new Promise<void>((r) => mtaControlServer.close(() => r()))
        : Promise.resolve(),
      rabbitMgmtServer
        ? new Promise<void>((r) => rabbitMgmtServer.close(() => r()))
        : Promise.resolve(),
    ]);
  });

  it('rejects non-admin and non-MFA users, verifies TOTP MFA, and runs real MTA drain, RabbitMQ DLQ replay, and immutable audit logs', async () => {
    // 1. Register a normal tenant customer & domain
    const custReg = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'tenant@customer.test',
        password: 'TenantPassword!123',
        fullName: 'Tenant Owner',
        organizationName: 'Customer Inc',
      }),
    });
    assert.equal(custReg.status, 201);
    const custJson = (await custReg.json()) as {
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    };

    const custDom = await fetch(`${baseUrl}/v1/domains`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${custJson.accessToken}`,
      },
      body: JSON.stringify({ domainName: 'customer.test', sendingEnabled: true, hostingEnabled: false }),
    });
    assert.equal(custDom.status, 201);
    const { domain } = (await custDom.json()) as { domain: { id: string } };

    // Non-admin user must receive 403 on /admin/v1
    const deniedCust = await fetch(`${baseUrl}/admin/v1/overview`, {
      headers: { authorization: `Bearer ${custJson.accessToken}` },
    });
    assert.equal(deniedCust.status, 403);

    // 1b. Security check: SuperAdmin logging in via appSurface:'web' must NOT bypass MFA!
    const webBypassAttempt = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'root@mailforge.internal',
        password: 'SuperAdminPass!123',
        appSurface: 'web',
      }),
    });
    assert.equal(webBypassAttempt.status, 200);
    const webAttemptJson = (await webBypassAttempt.json()) as { accessToken: string };
    const bypassDenied = await fetch(`${baseUrl}/admin/v1/overview`, {
      headers: { authorization: `Bearer ${webAttemptJson.accessToken}` },
    });
    assert.equal(bypassDenied.status, 403);

    // 2. SuperAdmin password login -> initially mfaVerified=false -> must be rejected until TOTP verified
    const adminLogin = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'root@mailforge.internal',
        password: 'SuperAdminPass!123',
        appSurface: 'admin',
      }),
    });
    assert.equal(adminLogin.status, 200);
    const preMfa = (await adminLogin.json()) as { accessToken: string };

    const deniedNoMfa = await fetch(`${baseUrl}/admin/v1/overview`, {
      headers: { authorization: `Bearer ${preMfa.accessToken}` },
    });
    assert.equal(deniedNoMfa.status, 403);
    const noMfaBody = (await deniedNoMfa.json()) as { error: { code: string } };
    assert.equal(noMfaBody.error.code, 'MFA_REQUIRED');

    // Enroll + verify real RFC 6238 TOTP
    const enroll = await fetch(`${baseUrl}/v1/auth/mfa/enroll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${preMfa.accessToken}` },
    });
    assert.equal(enroll.status, 200);
    const { secret } = (await enroll.json()) as { secret: string };
    const code = generateTotpCode(secret);

    const verify = await fetch(`${baseUrl}/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${preMfa.accessToken}`,
      },
      body: JSON.stringify({ code }),
    });
    assert.equal(verify.status, 200);
    const { accessToken: adminToken } = (await verify.json()) as { accessToken: string };

    // Security check: TOTP code replay within same window must fail 401
    const replay = await fetch(`${baseUrl}/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${preMfa.accessToken}`,
      },
      body: JSON.stringify({ code }),
    });
    assert.equal(replay.status, 401);

    // Security check: Pre-MFA password token cannot overwrite existing TOTP enrollment
    const hijackEnroll = await fetch(`${baseUrl}/v1/auth/mfa/enroll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${preMfa.accessToken}` },
    });
    assert.equal(hijackEnroll.status, 403);
    const adminHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
    };

    // 3. Register real HTTP MTA node + drain + resume
    const regNode = await fetch(`${baseUrl}/admin/v1/nodes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        id: 'mta-node-1',
        hostname: '127.0.0.1',
        roles: ['ingress', 'outbound'],
        controlUrl: mtaControlUrl,
      }),
    });
    assert.equal(regNode.status, 201);

    const drainRes = await fetch(`${baseUrl}/admin/v1/nodes/mta-node-1/drain`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(drainRes.status, 200);
    const drainJson = (await drainRes.json()) as { node: { status: string } };
    assert.equal(drainJson.node.status, 'draining');
    assert.equal(mtaDraining, true);

    const resumeRes = await fetch(`${baseUrl}/admin/v1/nodes/mta-node-1/resume`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(resumeRes.status, 200);
    assert.equal(mtaDraining, false);

    // 4. Inspect real RabbitMQ queues & replay DLQ over Management HTTP API
    const qRes = await fetch(`${baseUrl}/admin/v1/queues`, { headers: adminHeaders });
    assert.equal(qRes.status, 200);
    const qJson = (await qRes.json()) as { queues: Array<{ name: string; messagesReady: number }> };
    assert.equal(qJson.queues.find((q) => q.name === 'mail.outbound.bulk.dlq')?.messagesReady, 1);

    const retryRes = await fetch(`${baseUrl}/admin/v1/queues/mail.outbound.bulk.dlq/retry-dlq`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(retryRes.status, 200);
    const retryJson = (await retryRes.json()) as { requeued: number };
    assert.equal(retryJson.requeued, 1);
    assert.deepEqual(republishedTo, ['mail.outbound.bulk']);

    // 5. Operator role vs SuperAdmin role restriction
    const opsLogin = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ops@mailforge.internal',
        password: 'OperatorPass!123',
        appSurface: 'admin',
      }),
    });
    const opsPre = (await opsLogin.json()) as { accessToken: string };
    const opsEnroll = await fetch(`${baseUrl}/v1/auth/mfa/enroll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opsPre.accessToken}` },
    });
    const opsSecret = ((await opsEnroll.json()) as { secret: string }).secret;
    const opsVerify = await fetch(`${baseUrl}/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opsPre.accessToken}` },
      body: JSON.stringify({ code: generateTotpCode(opsSecret) }),
    });
    const opsToken = ((await opsVerify.json()) as { accessToken: string }).accessToken;

    const opsForbiddenSettings = await fetch(`${baseUrl}/admin/v1/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opsToken}` },
      body: JSON.stringify({
        sandboxDailyCap: 100,
        maxAttachmentSizeMb: 10,
        autoSuspendBounceRatePct: 4,
        autoSuspendComplaintRatePct: 0.1,
        maintenanceBanner: 'test',
        requireTlsForInboundRelay: true,
      }),
    });
    assert.equal(opsForbiddenSettings.status, 403);

    // 6. Suspend domain, revoke customer sessions, update versioned settings, check immutable audit log
    const suspDom = await fetch(`${baseUrl}/admin/v1/domains/${domain.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ isSuspended: true, suspensionReason: 'Spike in complaints' }),
    });
    assert.equal(suspDom.status, 200);
    const suspJson = (await suspDom.json()) as { domain: { isSuspended: boolean } };
    assert.equal(suspJson.domain.isSuspended, true);

    const revRes = await fetch(`${baseUrl}/admin/v1/users/${custJson.user.id}/revoke-sessions`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(revRes.status, 200);
    const postRevokeRefresh = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: custJson.refreshToken }),
    });
    assert.equal(postRevokeRefresh.status, 401);

    const setRes = await fetch(`${baseUrl}/admin/v1/settings`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        sandboxDailyCap: 250,
        maxAttachmentSizeMb: 20,
        autoSuspendBounceRatePct: 4.5,
        autoSuspendComplaintRatePct: 0.15,
        maintenanceBanner: 'Planned MTA maintenance Sunday 02:00 UTC',
        requireTlsForInboundRelay: true,
      }),
    });
    assert.equal(setRes.status, 200);
    const setJson = (await setRes.json()) as { setting: { version: number } };
    assert.equal(setJson.setting.version, 2);

    const auditRes = await fetch(`${baseUrl}/admin/v1/audit-logs`, { headers: adminHeaders });
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as { auditLogs: Array<{ action: string }> };
    assert.ok(auditJson.auditLogs.some((a) => a.action === 'admin.node.drained'));
    assert.ok(auditJson.auditLogs.some((a) => a.action === 'admin.queue.dlq_retried'));
    assert.ok(auditJson.auditLogs.some((a) => a.action === 'admin.domain.suspended'));

    const delAudit = await fetch(`${baseUrl}/admin/v1/audit-logs`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert.equal(delAudit.status, 405);
  });
});
