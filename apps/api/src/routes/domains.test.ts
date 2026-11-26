import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../app.js';
import { StructuredLogger } from '../logger.js';
import { InMemoryAnalyticsStore } from './analytics.js';
import { InMemoryAuthStore } from './auth.js';
import { InMemoryMarketingStore } from './campaigns.js';
import { InMemoryCredentialsStore } from './credentials.js';
import { InMemoryDomainStore } from './domains.js';
import { InMemoryMailboxStore } from './mailboxes.js';
import { InMemoryWebhookStore } from './webhooks.js';
import {
  decryptDkimPrivateKey,
  extractNormalizedDkimPublicKeyBase64,
  generateDomainDkimKeyPair,
  resolveDkimKek,
} from '../services/dkim-service.js';
import type { DnsLookupAdapter, MxRecordValue } from '../services/dns-verifier.js';

interface MockZone {
  txt: Map<string, string[]>;
  publicTxt: Map<string, string[]>;
  mx: Map<string, MxRecordValue[]>;
  a: Map<string, string[]>;
  aaaa: Map<string, string[]>;
  cname: Map<string, string[]>;
  ptr: Map<string, string[]>;
  mtaSts: Map<string, { ok: boolean; status: number | null; body: string | null; error: string | null }>;
  timeoutHosts: Set<string>;
}

describe('Enterprise Domains & DNS Authentication Center', () => {
  const logger = new StructuredLogger('domains-test');
  const domainStore = new InMemoryDomainStore();
  const mailboxStore = new InMemoryMailboxStore();
  const mtaReloadCalls: number[] = [];

  const zone: MockZone = {
    txt: new Map(),
    publicTxt: new Map(),
    mx: new Map(),
    a: new Map(),
    aaaa: new Map(),
    cname: new Map(),
    ptr: new Map(),
    mtaSts: new Map(),
    timeoutHosts: new Set(),
  };

  const mockDnsAdapter: DnsLookupAdapter = {
    resolveTxt: async (fqdn) => {
      const key = fqdn.toLowerCase();
      if (zone.timeoutHosts.has(key)) return { records: [], error: 'DNS lookup timed out after 3500ms' };
      return { records: zone.txt.get(key) ?? [], error: null };
    },
    resolveTxtAt: async (_ip, fqdn) => {
      const key = fqdn.toLowerCase();
      if (zone.timeoutHosts.has(key)) return { records: [], error: 'DNS lookup timed out after 3500ms' };
      return { records: (zone.publicTxt.get(key) ?? zone.txt.get(key)) ?? [], error: null };
    },
    resolveMx: async (fqdn) => {
      const key = fqdn.toLowerCase();
      if (zone.timeoutHosts.has(key)) return { records: [], error: 'DNS lookup timed out after 3500ms' };
      return { records: zone.mx.get(key) ?? [], error: null };
    },
    resolve4: async (fqdn) => ({ records: zone.a.get(fqdn.toLowerCase()) ?? [], error: null }),
    resolve6: async (fqdn) => ({ records: zone.aaaa.get(fqdn.toLowerCase()) ?? [], error: null }),
    resolveCname: async (fqdn) => ({ records: zone.cname.get(fqdn.toLowerCase()) ?? [], error: null }),
    reverse: async (ip) => ({ records: zone.ptr.get(ip) ?? [], error: null }),
    fetchMtaStsPolicy: async (domain) =>
      zone.mtaSts.get(domain.toLowerCase()) ?? { ok: false, status: 404, body: null, error: 'HTTP 404' },
  };

  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    logger,
    jwtSecret: 'test_secret_with_at_least_32_characters_here',
    authStore: new InMemoryAuthStore(),
    domainStore,
    mailboxStore,
    credentialsStore: new InMemoryCredentialsStore(),
    marketingStore: new InMemoryMarketingStore(),
    webhookStore: new InMemoryWebhookStore(),
    analyticsStore: new InMemoryAnalyticsStore(),
    dnsAdapter: mockDnsAdapter,
    mtaDomainSync: {
      reloadDkim: async () => {
        mtaReloadCalls.push(Date.now());
        return { reloaded: 1, activeSelectors: { 'corp.example': ['mp1'] } };
      },
      getDkimStatus: async () => ({
        nodeId: 'mta-test-1',
        heloDomain: 'mx1.mailplat.local',
        activeSelectors: { 'corp.example': ['mp1'] },
      }),
    },
    readiness: { checkPostgres: async () => true },
    emails: {
      store: {
        submitTransactionalEmail: async () => ({
          messageId: '01930000-0000-7000-8000-000000000099',
          recipientCount: 1,
          deduplicated: false,
        }),
      },
      spool: { writeMime: async () => ({ storageKey: 'k', sizeBytes: 10 }) },
    },
  });

  let server: Server;
  let baseUrl: string;
  let orgAToken = '';
  let orgBToken = '';

  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected numeric server port');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const regA = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@org-a.example',
        password: 'StrongPassword123!',
        fullName: 'Org A Admin',
        organizationName: 'Org A',
      }),
    });
    assert.equal(regA.status, 201);
    orgAToken = ((await regA.json()) as { accessToken: string }).accessToken;

    const regB = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@org-b.example',
        password: 'StrongPassword123!',
        fullName: 'Org B Admin',
        organizationName: 'Org B',
      }),
    });
    assert.equal(regB.status, 201);
    orgBToken = ((await regB.json()) as { accessToken: string }).accessToken;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('generates 2048-bit DKIM keys without exposing private keys and verifies real DNS records', async () => {
    const createRes = await fetch(`${baseUrl}/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({ domainName: 'corp.example', sendingEnabled: true, hostingEnabled: true }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      domain: { id: string; verificationToken: string; activeDkimSelector: string };
      dkimKeys: Array<{ id: string; selector: string; publicKeyDnsTxt: string; encryptedPrivateKey?: unknown }>;
    };

    assert.equal(created.domain.activeDkimSelector, 'mp1');
    assert.equal(created.dkimKeys.length, 1);
    assert.ok(created.dkimKeys[0]!.publicKeyDnsTxt.startsWith('v=DKIM1; k=rsa; p='));
    assert.equal('encryptedPrivateKey' in created.dkimKeys[0]!, false);

    // Assert canonicalPkcs1Base64 from DNS public key matches private key's derived PKCS#1 public key
    const kek = resolveDkimKek();
    const keyMat = generateDomainDkimKeyPair('corp.example', 'mp1', 'rsa2048', kek);
    const privDer = decryptDkimPrivateKey(kek, keyMat.encryptedPrivateKey);
    const privObj = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs1' });
    const derivedPubPkcs1 = createPublicKey(privObj).export({ format: 'der', type: 'pkcs1' });
    const parsedPub = extractNormalizedDkimPublicKeyBase64(keyMat.publicKeyDnsTxt);
    assert.equal(parsedPub.validSyntax, true);
    assert.equal(parsedPub.canonicalPkcs1Base64, derivedPubPkcs1.toString('base64'));
    assert.equal(extractNormalizedDkimPublicKeyBase64(created.dkimKeys[0]!.publicKeyDnsTxt).validSyntax, true);

    // Verify fails before TXT is published
    const failVerify = await fetch(`${baseUrl}/v1/domains/${created.domain.id}/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(failVerify.status, 200);
    const failBody = (await failVerify.json()) as { verified: boolean };
    assert.equal(failBody.verified, false);

    // Publish full valid DNS zone for corp.example
    const helo = process.env.MAIL_HELO_DOMAIN || 'mx1.fastconnect.in';
    zone.txt.set('_mailplat-verify.corp.example', [created.domain.verificationToken]);
    zone.txt.set('corp.example', [`v=spf1 a mx a:${helo} ~all`]);
    zone.txt.set('mp1._domainkey.corp.example', [created.dkimKeys[0]!.publicKeyDnsTxt]);
    zone.txt.set('_dmarc.corp.example', ['v=DMARC1; p=quarantine; rua=mailto:dmarc@corp.example; pct=100; aspf=r; adkim=r']);
    zone.mx.set('corp.example', [{ priority: 10, exchange: helo }]);
    zone.a.set(helo, ['198.51.100.25']);
    zone.ptr.set('198.51.100.25', [helo]);

    const passVerify = await fetch(`${baseUrl}/v1/domains/${created.domain.id}/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(passVerify.status, 200);
    const passBody = (await passVerify.json()) as {
      verified: boolean;
      domain: { ownershipVerifiedAt: string | null };
      diagnostics: { spfStatus: string; dkimStatus: string; dmarcStatus: string; mxStatus: string; healthStatus: string };
    };
    assert.equal(passBody.verified, true);
    assert.ok(passBody.domain.ownershipVerifiedAt);
    assert.equal(passBody.diagnostics.spfStatus, 'pass');
    assert.equal(passBody.diagnostics.dkimStatus, 'pass');
    assert.equal(passBody.diagnostics.dmarcStatus, 'pass');
    assert.equal(passBody.diagnostics.mxStatus, 'pass');
    assert.equal(passBody.diagnostics.healthStatus, 'verified');
    assert.ok(mtaReloadCalls.length >= 1);

    // List domains filter + summary
    const listRes = await fetch(`${baseUrl}/v1/domains?search=corp&verified=verified&sort=name`, {
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as {
      domains: Array<{ domainName: string; healthStatus: string }>;
      summary: { total: number; verified: number; sendingEnabled: number; hostingEnabled: number };
    };
    assert.equal(listJson.domains.length, 1);
    assert.equal(listJson.domains[0]!.healthStatus, 'verified');
    assert.equal(listJson.summary.verified, 1);

    // Org B tenant isolation checks
    const crossGet = await fetch(`${baseUrl}/v1/domains/${created.domain.id}`, {
      headers: { authorization: `Bearer ${orgBToken}` },
    });
    assert.equal(crossGet.status, 404);

    const crossPatch = await fetch(`${baseUrl}/v1/domains/${created.domain.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgBToken}` },
      body: JSON.stringify({ sendingEnabled: false }),
    });
    assert.equal(crossPatch.status, 404);
  });

  it('detects duplicate SPF records, excessive >10 DNS lookups, propagation diffs, and DKIM key rotation rules', async () => {
    const createRes = await fetch(`${baseUrl}/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({ domainName: 'spf-broken.example', sendingEnabled: true, hostingEnabled: false }),
    });
    const { domain } = (await createRes.json()) as { domain: { id: string; verificationToken: string } };

    // Two conflicting SPF records + 12 include lookups
    const twelveIncludes = Array.from({ length: 12 }, (_, i) => `include:s${i}.example.net`).join(' ');
    zone.txt.set('spf-broken.example', [`v=spf1 ${twelveIncludes} ~all`, 'v=spf1 include:other.example ~all']);
    // Simulate propagation lag on public DNS
    zone.publicTxt.set('_mailplat-verify.spf-broken.example', []);
    zone.txt.set('_mailplat-verify.spf-broken.example', [domain.verificationToken]);

    const diag1 = await fetch(`${baseUrl}/v1/domains/${domain.id}/diagnostics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(diag1.status, 200);
    const diagJson1 = (await diag1.json()) as {
      check: {
        spfStatus: string;
        records: Array<{ id: string; status: string; remediation: string; propagationStatus: string }>;
      };
    };
    const spfEval = diagJson1.check.records.find((r) => r.id === 'spf');
    assert.ok(spfEval);
    assert.equal(spfEval.status, 'fail');
    assert.ok(spfEval.remediation.toLowerCase().includes('multiple spf'));

    // Now single SPF with 12 includes -> triggers RFC 7208 >10 DNS lookup limit failure
    zone.txt.set('spf-broken.example', [`v=spf1 ${twelveIncludes} ~all`]);
    const diagLimit = await fetch(`${baseUrl}/v1/domains/${domain.id}/diagnostics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(diagLimit.status, 200);
    const diagLimitJson = (await diagLimit.json()) as {
      check: {
        records: Array<{ id: string; status: string; remediation: string }>;
      };
    };
    const spfLimitEval = diagLimitJson.check.records.find((r) => r.id === 'spf');
    assert.ok(spfLimitEval);
    assert.equal(spfLimitEval.status, 'fail');
    assert.ok(spfLimitEval.remediation.includes('10 DNS lookups'));

    // Rotate DKIM selector
    const rotRes = await fetch(`${baseUrl}/v1/domains/${domain.id}/dkim/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({ selector: 'mp2026', algorithm: 'rsa2048' }),
    });
    assert.equal(rotRes.status, 201);
    const rotJson = (await rotRes.json()) as {
      key: { id: string; selector: string; status: string };
      dkimKeys: Array<{ id: string; selector: string; status: string }>;
      mtaSynced: boolean;
    };
    assert.equal(rotJson.key.selector, 'mp2026');
    assert.equal(rotJson.mtaSynced, true);
    assert.equal(rotJson.dkimKeys.filter((k) => k.status === 'active').length, 1);
    assert.equal(rotJson.dkimKeys.filter((k) => k.status === 'retiring').length, 1);

    // Cannot revoke currently active key; CAN revoke retiring key
    const activeKey = rotJson.dkimKeys.find((k) => k.status === 'active')!;
    const retiringKey = rotJson.dkimKeys.find((k) => k.status === 'retiring')!;
    const revokeActive = await fetch(`${baseUrl}/v1/domains/${domain.id}/dkim/${activeKey.id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(revokeActive.status, 400);

    const revokeRetiring = await fetch(`${baseUrl}/v1/domains/${domain.id}/dkim/${retiringKey.id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(revokeRetiring.status, 200);

    // Fix SPF and run second diagnostic -> diff shows TXT/SPF transition from fail -> pass
    const helo = process.env.MAIL_HELO_DOMAIN || 'mx1.fastconnect.in';
    zone.txt.set('spf-broken.example', [`v=spf1 a:${helo} ~all`]);
    const diag2 = await fetch(`${baseUrl}/v1/domains/${domain.id}/diagnostics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(diag2.status, 200);
    const histRes = await fetch(`${baseUrl}/v1/domains/${domain.id}/history`, {
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(histRes.status, 200);
    const histJson = (await histRes.json()) as { history: Array<{ changes: string[] }> };
    assert.ok(histJson.history.length >= 2);
    assert.ok(histJson.history[0]!.changes.some((d) => d.includes('spf-broken.example status: fail -> pass')));
  });

  it('supports async background diagnostic jobs, settings updates, timeout resilience, and safe deletion', async () => {
    const createRes = await fetch(`${baseUrl}/v1/domains`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({ domainName: 'async-del.example', sendingEnabled: true, hostingEnabled: true }),
    });
    const { domain } = (await createRes.json()) as { domain: { id: string; verificationToken: string } };

    // Simulate timeout on TXT query
    zone.timeoutHosts.add('async-del.example');
    const asyncStart = await fetch(`${baseUrl}/v1/domains/${domain.id}/diagnostics?async=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(asyncStart.status, 202);
    const { job } = (await asyncStart.json()) as { job: { id: string; status: string } };
    assert.ok(job.id);

    // Poll until completed
    let finalStatus = job.status;
    for (let i = 0; i < 20 && finalStatus !== 'completed' && finalStatus !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const poll = await fetch(`${baseUrl}/v1/domains/${domain.id}/diagnostics/${job.id}`, {
        headers: { authorization: `Bearer ${orgAToken}` },
      });
      const pollJson = (await poll.json()) as { job: { status: string } };
      finalStatus = pollJson.job.status;
    }
    assert.equal(finalStatus, 'completed');

    // Update DMARC/MTA-STS/Return-Path/Tracking settings
    const patchRes = await fetch(`${baseUrl}/v1/domains/${domain.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({
        dmarcPolicy: 'reject',
        dmarcPct: 50,
        customReturnPathDomain: 'bounce.async-del.example',
        customTrackingDomain: 'trk.async-del.example',
        dailySendLimit: 5000,
        mtaStsMode: 'testing',
        mtaStsMaxAge: 86400,
        tlsRptRua: 'mailto:tls@async-del.example',
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as {
      domain: { dmarcPolicy: string; dmarcPct: number; customReturnPathDomain: string; mtaStsMode: string; dailySendLimit: number };
    };
    assert.equal(patched.domain.dmarcPolicy, 'reject');
    assert.equal(patched.domain.dmarcPct, 50);
    assert.equal(patched.domain.customReturnPathDomain, 'bounce.async-del.example');
    assert.equal(patched.domain.mtaStsMode, 'testing');
    assert.equal(patched.domain.dailySendLimit, 5000);

    // Wrong confirmation domain name rejected with 400
    const badDel = await fetch(`${baseUrl}/v1/domains/${domain.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({ confirmDomainName: 'wrong.example', confirmCleanup: false }),
    });
    assert.equal(badDel.status, 400);

    // Token regeneration clears verification timestamp
    zone.txt.set('_mailplat-verify.async-del.example', [domain.verificationToken]);
    const regen = await fetch(`${baseUrl}/v1/domains/${domain.id}/regenerate-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${orgAToken}` },
    });
    assert.equal(regen.status, 200);
    const regenJson = (await regen.json()) as { domain: { verificationToken: string; ownershipVerifiedAt: string | null } };
    assert.notEqual(regenJson.domain.verificationToken, domain.verificationToken);
    assert.equal(regenJson.domain.ownershipVerifiedAt, null);

    // Delete with exact confirmation succeeds with 204
    const delOk = await fetch(`${baseUrl}/v1/domains/${domain.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` },
      body: JSON.stringify({ confirmDomainName: 'async-del.example', confirmCleanup: true }),
    });
    assert.equal(delOk.status, 204);
  });
});
