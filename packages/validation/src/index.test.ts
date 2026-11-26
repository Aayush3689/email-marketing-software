import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDomainRequestSchema, sendEmailRequestSchema } from './index.js';

describe('@mail/validation', () => {
  it('accepts a valid transactional email payload', () => {
    const parsed = sendEmailRequestSchema.safeParse({
      from: 'noreply@example.com',
      to: ['user@example.org'],
      subject: 'Verification code',
      text: 'Your code is 123456',
      idempotencyKey: 'req-12345678',
    });
    assert.equal(parsed.success, true);
  });

  it('rejects email payload missing both html and text', () => {
    const parsed = sendEmailRequestSchema.safeParse({
      from: 'noreply@example.com',
      to: ['user@example.org'],
      subject: 'Empty',
    });
    assert.equal(parsed.success, false);
  });

  it('normalizes and validates domain names', () => {
    const parsed = createDomainRequestSchema.parse({ domainName: '  MAIL.Example.COM ' });
    assert.equal(parsed.domainName, 'mail.example.com');
  });
});
