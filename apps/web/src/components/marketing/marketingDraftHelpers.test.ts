import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  clearLocalDraftRecovery,
  compileClientBlocks,
  getDraftRecoveryStorageKey,
  readLocalDraftRecovery,
  renderLocalPersonalization,
  sanitizePreviewHtml,
  stripHtmlToText,
  writeLocalDraftRecovery,
  type BroadcastDraftPayload,
} from './marketingDraftHelpers.js';

function installMockLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  return store;
}

const sampleDraft: BroadcastDraftPayload = {
  domainId: 'dom_1',
  templateId: '',
  name: 'Weekly Issue #12',
  fromName: 'FastConnect Editorial',
  fromEmail: 'news@fastconnect.in',
  replyTo: 'reply@fastconnect.in',
  subject: 'Hello {{firstName | fallback: "Friend"}}',
  previewText: 'Top stories inside',
  blocks: [
    { id: 'b1', type: 'heading', props: { text: 'Welcome {{firstName}}', level: 'h1' } },
    { id: 'b2', type: 'button', props: { label: 'Read More', url: 'https://fastconnect.in/blog', color: '#2563eb' } },
  ],
  htmlBody: '<p>Hi</p>',
  textBody: 'Hi',
  audienceSpec: { mode: 'all', includeTags: ['Newsletter'], excludeTags: ['Muted'] },
  deliveryChoice: 'draft',
  scheduledLocal: '',
  timezone: 'UTC',
  wizardStep: 3,
};

describe('Broadcast draft recovery & editor helpers', () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it('persists, reads, and clears local draft recovery keyed by campaign ID', () => {
    assert.equal(getDraftRecoveryStorageKey(null), 'fastconnect_broadcast_draft_new');
    assert.equal(getDraftRecoveryStorageKey('cmp_42'), 'fastconnect_broadcast_draft_cmp_42');

    writeLocalDraftRecovery('cmp_42', {
      draft: sampleDraft,
      serverUpdatedAt: '2026-11-26T10:00:00.000Z',
      dirty: true,
      savedLocallyAt: 1700000000000,
    });

    const restored = readLocalDraftRecovery('cmp_42');
    assert.ok(restored);
    assert.equal(restored.dirty, true);
    assert.equal(restored.draft.name, 'Weekly Issue #12');
    assert.equal(restored.draft.audienceSpec.excludeTags?.[0], 'Muted');

    clearLocalDraftRecovery('cmp_42');
    assert.equal(readLocalDraftRecovery('cmp_42'), null);
  });

  it('compiles email blocks safely, strips XSS vectors, and preserves personalization tokens', () => {
    const compiled = compileClientBlocks(sampleDraft.blocks, {
      subject: sampleDraft.subject,
      previewText: sampleDraft.previewText,
    });
    assert.ok(compiled.htmlBody.includes('Welcome {{firstName}}'));
    assert.ok(compiled.htmlBody.includes('https://fastconnect.in/blog'));
    assert.ok(compiled.textBody.includes('Read More: https://fastconnect.in/blog'));

    const cleaned = sanitizePreviewHtml(
      '<p onclick="steal()">Ok</p><a href="javascript:alert(1)">Bad</a><script>evil()</script>'
    );
    assert.equal(cleaned.includes('<script>'), false);
    assert.equal(cleaned.includes('onclick'), false);
    assert.equal(cleaned.includes('javascript:'), false);

    assert.equal(
      stripHtmlToText('<h1>Headline</h1><p>Line 1<br />Line 2 &amp; More</p>'),
      'Headline\nLine 1\nLine 2 & More'
    );
    assert.equal(
      renderLocalPersonalization('Hi {{firstName | fallback: "there"}} ({{plan_tier}})', {
        firstName: '',
        plan_tier: 'Pro',
      }),
      'Hi there (Pro)'
    );
  });
});
