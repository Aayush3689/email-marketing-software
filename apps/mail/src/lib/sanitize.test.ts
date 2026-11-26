import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeEmailHtml } from './sanitize.js';

describe('sanitizeEmailHtml', () => {
  it('strips script tags and inline event handlers', () => {
    const clean = sanitizeEmailHtml('<p onclick="alert(1)">Hello</p><script>evil()</script>');
    assert.equal(clean.includes('<script>'), false);
    assert.equal(clean.includes('onclick'), false);
    assert.equal(clean.includes('Hello'), true);
  });
});
