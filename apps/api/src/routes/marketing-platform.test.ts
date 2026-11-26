import assert from 'node:assert/strict';
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

describe('Kit-Inspired Email Marketing Platform API', () => {
  const logger = new StructuredLogger('marketing-platform-test');
  const domainStore = new InMemoryDomainStore();
  const marketingStore = new InMemoryMarketingStore();
  const analyticsStore = new InMemoryAnalyticsStore();
  const submittedEmails: Array<{
    from: string;
    envelopeFrom?: string | undefined;
    recipients: string[];
    subject: string;
    sourceType?: string | undefined;
    campaignId?: string | undefined;
    routingKey?: string | undefined;
    mimeText: string;
  }> = [];

  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    publicBaseUrl: 'https://mail.test.local',
    logger,
    jwtSecret: 'test_secret_with_at_least_32_characters_here',
    authStore: new InMemoryAuthStore(),
    domainStore,
    dnsAdapter: {
      resolveTxt: async () => ({ records: [], error: null }),
      resolveMx: async () => ({ records: [], error: null }),
      resolve4: async () => ({ records: ['203.0.113.10'], error: null }),
      resolve6: async () => ({ records: [], error: null }),
      resolveCname: async () => ({ records: [], error: null }),
      reverse: async () => ({ records: ['mx1.fastconnect.in'], error: null }),
      fetchMtaStsPolicy: async () => ({ ok: false, status: 404, body: null, error: 'none' }),
    },
    mailboxStore: new InMemoryMailboxStore(),
    credentialsStore: new InMemoryCredentialsStore(),
    marketingStore,
    webhookStore: new InMemoryWebhookStore(),
    analyticsStore,
    readiness: { checkPostgres: async () => true },
    emails: {
      store: {
        submitTransactionalEmail: async (params) => {
          submittedEmails.push({
            from: params.from,
            envelopeFrom: params.envelopeFrom,
            recipients: params.recipients,
            subject: params.subject,
            sourceType: params.sourceType,
            campaignId: params.campaignId,
            routingKey: params.routingKey,
            mimeText: submittedEmails.length >= 0 ? lastSpooledMime : '',
          });
          return {
            messageId: '01930000-0000-7000-8000-000000000101',
            ...(params.recipientId ? { recipientId: params.recipientId } : {}),
            recipientCount: params.recipients.length,
            deduplicated: false,
          };
        },
      },
      spool: {
        writeMime: async (orgId, buf) => {
          lastSpooledMime = buf.toString('utf8');
          return { storageKey: `${orgId}/test.eml`, sizeBytes: buf.byteLength };
        },
      },
    },
  });

  let lastSpooledMime = '';
  let server: Server;
  let baseUrl: string;
  let orgAToken = '';
  let orgBToken = '';
  let orgAId = '';
  let verifiedDomainId = '';

  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected numeric port');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const regA = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'creator@brand-a.test',
        password: 'StrongPassword123!',
        fullName: 'Creator A',
        organizationName: 'Brand A',
      }),
    });
    const regAJson = (await regA.json()) as { accessToken: string; user: { orgId: string } };
    orgAToken = regAJson.accessToken;
    orgAId = regAJson.user.orgId;

    const dom = await domainStore.createDomain({
      organizationId: orgAId,
      domainName: 'brand-a.test',
      sendingEnabled: true,
      hostingEnabled: false,
    });
    await domainStore.markVerified(orgAId, dom.id);
    verifiedDomainId = dom.id;

    const regB = await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'creator@brand-b.test',
        password: 'StrongPassword123!',
        fullName: 'Creator B',
        organizationName: 'Brand B',
      }),
    });
    orgBToken = ((await regB.json()) as { accessToken: string }).accessToken;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('manages subscribers, custom fields, normalized tags, CSV wizard import/export, and dynamic segments', async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` };

    // Custom field
    const cfRes = await fetch(`${baseUrl}/v1/custom-fields`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ fieldKey: 'plan_tier', label: 'Plan Tier', fieldType: 'text' }),
    });
    assert.equal(cfRes.status, 201);

    // Tags
    const tagRes = await fetch(`${baseUrl}/v1/tags`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'Newsletter', description: 'Weekly readers' }),
    });
    assert.equal(tagRes.status, 201);
    const { tag: newsletterTag } = (await tagRes.json()) as { tag: { id: string; name: string } };

    // Upsert subscriber + duplicate update without duplicate contact
    const s1 = await fetch(`${baseUrl}/v1/subscribers`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        email: 'alice@example.com',
        firstName: 'Alice',
        tags: ['Newsletter', 'Customer'],
        attributes: { plan_tier: 'pro' },
        consentSource: 'app_signup',
      }),
    });
    assert.equal(s1.status, 201);
    const { subscriber: alice } = (await s1.json()) as { subscriber: { id: string; tags: string[] } };

    const s1Dup = await fetch(`${baseUrl}/v1/subscribers`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        email: 'alice@example.com',
        firstName: 'Alice',
        tags: ['VIP'],
        consentSource: 'checkout',
      }),
    });
    assert.equal(s1Dup.status, 200);

    // Dynamic segment: has Newsletter AND plan_tier === pro
    const segRes = await fetch(`${baseUrl}/v1/segments`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        name: 'Pro Newsletter Readers',
        matchType: 'all',
        conditions: [
          { id: 'c1', kind: 'rule', field: 'tags', operator: 'has_tag', value: 'Newsletter' },
          { id: 'c2', kind: 'rule', field: 'custom.plan_tier', operator: 'equals', value: 'pro' },
        ],
      }),
    });
    assert.equal(segRes.status, 201);
    const { segment } = (await segRes.json()) as { segment: { id: string } };

    const segPrev = await fetch(`${baseUrl}/v1/segments/preview`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        matchType: 'all',
        conditions: [{ id: 'c1', kind: 'rule', field: 'custom.plan_tier', operator: 'equals', value: 'pro' }],
      }),
    });
    assert.equal(segPrev.status, 200);
    assert.equal(((await segPrev.json()) as { count: number }).count, 1);

    // CSV import with quoted comma, duplicate, invalid email, suppressed
    await fetch(`${baseUrl}/v1/suppressions`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ email: 'suppressed@example.com', reason: 'hard_bounce' }),
    });
    const csvText = [
      'Email,First Name,Company',
      'bob@example.com,"Bob, Jr.",Acme',
      'bob@example.com,"Bob, Jr.",Acme',
      'bad-email,Bad,None',
      'suppressed@example.com,Sup,None',
    ].join('\n');

    const impRes = await fetch(`${baseUrl}/v1/subscribers/import-csv`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        fileName: 'leads.csv',
        consentSource: 'webinar_csv',
        defaultTags: ['Webinar Attendee'],
        fieldMapping: { Email: 'email', 'First Name': 'firstName', Company: 'company' },
        csvText,
      }),
    });
    assert.equal(impRes.status, 201);
    const { job } = (await impRes.json()) as {
      job: { id: string; importedCount: number; skippedDuplicates: number; invalidCount: number; suppressedCount: number };
    };
    assert.equal(job.importedCount, 1);
    assert.equal(job.skippedDuplicates, 1);
    assert.equal(job.invalidCount, 1);
    assert.equal(job.suppressedCount, 1);

    // Delete tag must NOT delete subscriber Alice
    const delTag = await fetch(`${baseUrl}/v1/tags/${newsletterTag.id}`, { method: 'DELETE', headers: h });
    assert.equal(delTag.status, 204);
    const prof = await fetch(`${baseUrl}/v1/subscribers/${alice.id}`, { headers: h });
    assert.equal(prof.status, 200);

    // Query subscribers using segment filter + export CSV
    const listSeg = await fetch(`${baseUrl}/v1/subscribers?segmentId=${segment.id}`, { headers: h });
    assert.equal(listSeg.status, 200);

    // Resubscribe requires explicit consent confirmation
    await fetch(`${baseUrl}/v1/subscribers/${alice.id}/unsubscribe`, { method: 'POST', headers: h, body: '{}' });
    const badResub = await fetch(`${baseUrl}/v1/subscribers/${alice.id}/resubscribe`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ consentSource: 'manual', confirmedByConsent: false }),
    });
    assert.equal(badResub.status, 400);

    // Tenant isolation: Org B cannot read Alice
    const orgBRead = await fetch(`${baseUrl}/v1/subscribers/${alice.id}`, {
      headers: { authorization: `Bearer ${orgBToken}` },
    });
    assert.equal(orgBRead.status, 404);
  });

  it('builds templates, estimates broadcast audiences, sends tracked bulk emails, and tracks analytics/cancellations', async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` };

    // Add active subscriber + unsubscribed subscriber
    await fetch(`${baseUrl}/v1/subscribers`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ email: 'reader1@example.com', firstName: 'Reader', tags: ['Launch'], consentSource: 'form' }),
    });
    await fetch(`${baseUrl}/v1/subscribers`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ email: 'optout@example.com', status: 'unsubscribed', tags: ['Launch'], consentSource: 'form' }),
    });

    // Visual blocks + XSS stripping + personalization fallback
    const tplRes = await fetch(`${baseUrl}/v1/templates`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        name: 'Launch Block Template',
        category: 'marketing',
        subject: 'Big Launch {{firstName | fallback: "Friend"}}',
        htmlBody: '<p onclick="evil()">Hi {{firstName | fallback: "Friend"}}</p><a href="https://fastconnect.in/docs">Read</a><script>alert(1)</script>',
        blocksJson: [{ id: 'b1', type: 'heading', props: { text: 'Hello' } }],
      }),
    });
    assert.equal(tplRes.status, 201);
    const { template } = (await tplRes.json()) as { template: { id: string; versions: Array<{ htmlBody: string }> } };
    assert.equal(template.versions[0]!.htmlBody.includes('<script>'), false);
    assert.equal(template.versions[0]!.htmlBody.includes('onclick'), false);

    // Update template bumps activeVersion -> 2
    const updTpl = await fetch(`${baseUrl}/v1/templates/${template.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ subject: 'Updated Launch {{firstName | fallback: "Friend"}}' }),
    });
    assert.equal(updTpl.status, 200);
    assert.equal(((await updTpl.json()) as { template: { activeVersion: number } }).template.activeVersion, 2);

    // Estimate audience exclusions
    const estRes = await fetch(`${baseUrl}/v1/campaigns/estimate-audience`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ mode: 'filtered', includeTags: ['Launch'] }),
    });
    assert.equal(estRes.status, 200);
    const est = (await estRes.json()) as { estimate: { eligibleCount: number; excluded: { unsubscribed: number } } };
    assert.equal(est.estimate.eligibleCount, 1);
    assert.equal(est.estimate.excluded.unsubscribed, 1);

    // Create Broadcast & Send Test
    const campRes = await fetch(`${baseUrl}/v1/campaigns`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        domainId: verifiedDomainId,
        templateId: template.id,
        name: 'Product Launch Broadcast',
        fromName: 'FastConnect Team',
        audienceSpec: { mode: 'filtered', includeTags: ['Launch'] },
      }),
    });
    assert.equal(campRes.status, 201);
    const { campaign } = (await campRes.json()) as { campaign: { id: string; targetCount: number } };
    assert.equal(campaign.targetCount, 1);

    const testRes = await fetch(`${baseUrl}/v1/campaigns/${campaign.id}/send-test`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ toEmail: 'qa@brand-a.test' }),
    });
    assert.equal(testRes.status, 200);

    // Start broadcast -> routes via mail.outbound.bulk, VERP bounces+<recipientId>, tracking + RFC 8058 headers
    const beforeCount = submittedEmails.length;
    const startRes = await fetch(`${baseUrl}/v1/campaigns/${campaign.id}/start`, { method: 'POST', headers: h });
    assert.equal(startRes.status, 200);
    const startJson = (await startRes.json()) as { dispatchedCount: number; campaign: { status: string } };
    assert.equal(startJson.dispatchedCount, 1);
    assert.equal(startJson.campaign.status, 'completed');

    const dispatched = submittedEmails[beforeCount]!;
    assert.equal(dispatched.sourceType, 'campaign');
    assert.equal(dispatched.routingKey, 'mail.outbound.bulk');
    assert.equal(dispatched.campaignId, campaign.id);
    assert.ok(dispatched.envelopeFrom?.startsWith('bounces+'));
    assert.ok(dispatched.mimeText.includes('List-Unsubscribe:'));
    assert.ok(dispatched.mimeText.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
    assert.ok(dispatched.mimeText.includes('/v1/t/o/'));
    assert.ok(dispatched.mimeText.includes('/v1/t/c/'));

    // Re-starting completed broadcast is blocked
    const restart = await fetch(`${baseUrl}/v1/campaigns/${campaign.id}/start`, { method: 'POST', headers: h });
    assert.equal(restart.status, 400);

    // Analytics summary
    const anaRes = await fetch(`${baseUrl}/v1/campaigns/${campaign.id}/analytics`, { headers: h });
    assert.equal(anaRes.status, 200);
    const ana = (await anaRes.json()) as { analytics: { sent: number } };
    assert.equal(ana.analytics.sent, 1);
  });

  it('supports email sequences, visual automation execution, forms, and landing pages', async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${orgAToken}` };

    // Create sequence
    const seqRes = await fetch(`${baseUrl}/v1/sequences`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        name: 'Onboarding Sequence',
        domainId: verifiedDomainId,
        enabled: true,
        steps: [
          { delayDays: 0, delayHours: 0, subject: 'Day 0 Welcome', htmlBody: '<p>Welcome!</p>' },
          { delayDays: 2, delayHours: 0, subject: 'Day 2 Tips', htmlBody: '<p>Tips!</p>' },
        ],
      }),
    });
    assert.equal(seqRes.status, 201);
    const { sequence } = (await seqRes.json()) as { sequence: { id: string } };

    // Create + publish visual automation: form_submitted -> add_tag -> subscribe_sequence -> end
    const autoRes = await fetch(`${baseUrl}/v1/automations`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        name: 'Form Signup Onboarding',
        triggerType: 'form_submitted',
        nodes: [
          { id: 'n1', type: 'trigger', label: 'Form Submitted', x: 50, y: 50, config: {} },
          { id: 'n2', type: 'action_add_tag', label: 'Tag Engaged', x: 50, y: 150, config: { tagName: 'AutoTagged' } },
          { id: 'n3', type: 'action_subscribe_sequence', label: 'Enroll Seq', x: 50, y: 250, config: { sequenceId: sequence.id } },
          { id: 'n4', type: 'end', label: 'Done', x: 50, y: 350, config: {} },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', branch: 'next' },
          { id: 'e2', source: 'n2', target: 'n3', branch: 'next' },
          { id: 'e3', source: 'n3', target: 'n4', branch: 'next' },
        ],
      }),
    });
    assert.equal(autoRes.status, 201);
    const { automation } = (await autoRes.json()) as { automation: { id: string } };
    await fetch(`${baseUrl}/v1/automations/${automation.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ status: 'published' }),
    });

    // Create form & submit publicly
    const formRes = await fetch(`${baseUrl}/v1/forms`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'Homepage Box', title: 'Subscribe', doubleOptIn: false }),
    });
    assert.equal(formRes.status, 201);
    const { form } = (await formRes.json()) as { form: { id: string } };

    const pubSub = await fetch(`${baseUrl}/v1/public/forms/${form.id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lead@example.com', firstName: 'Lead', consentAccepted: true }),
    });
    assert.equal(pubSub.status, 201);
    const pubJson = (await pubSub.json()) as { subscriber: { id: string; tags: string[] } };
    assert.ok(pubJson.subscriber.tags.includes('AutoTagged'));

    // Sequence enrollment created by automation
    const enrRes = await fetch(`${baseUrl}/v1/sequences/${sequence.id}/enrollments`, { headers: h });
    assert.equal(enrRes.status, 200);
    const enrJson = (await enrRes.json()) as { enrollments: Array<{ subscriberId: string }> };
    assert.equal(enrJson.enrollments.length, 1);

    // Landing page public route
    const lpRes = await fetch(`${baseUrl}/v1/landing-pages`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        slug: 'creator-ebook',
        title: 'Creator Ebook',
        headline: 'Download the Free Guide',
        published: true,
      }),
    });
    assert.equal(lpRes.status, 201);
    const pubLp = await fetch(`${baseUrl}/v1/public/pages/creator-ebook`);
    assert.equal(pubLp.status, 200);
    assert.equal(((await pubLp.json()) as { landingPage: { viewsCount: number } }).landingPage.viewsCount, 1);
  });
});
