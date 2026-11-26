#!/usr/bin/env node
// One-command smoke script to queue a transactional email through POST /v1/emails.
// Usage:
//   API_URL=http://localhost:4000 API_KEY=mk_live_... \
//   FROM=hello@yourdomain.com TO=you@gmail.com node scripts/send-test-email.mjs

const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const apiKey = process.env.API_KEY;
const domainId = process.env.DOMAIN_ID;
const from = process.env.FROM;
const to = process.env.TO;

if (!apiKey || !from || !to) {
  console.error(
    'Missing required env vars.\nExample:\n  API_KEY=mk_live_... FROM=hello@yourdomain.com TO=recipient@gmail.com node scripts/send-test-email.mjs'
  );
  process.exit(1);
}

const response = await fetch(`${apiUrl}/v1/emails`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    from,
    to: [to],
    ...(domainId ? { domainId } : {}),
    subject: process.env.SUBJECT ?? 'MailForge Live SMTP Test',
    text: 'This message was sent from your self-hosted MailForge MTA stack.',
    html: '<p>This message was sent from your self-hosted <strong>MailForge MTA</strong> stack.</p>',
    idempotencyKey: `smoke-${Date.now()}`,
  }),
});

const payload = await response.json();
if (!response.ok) {
  console.error('Send failed:', response.status, payload);
  process.exit(1);
}

console.log('Queued successfully:', payload);
