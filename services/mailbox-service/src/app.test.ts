import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createMailboxApp } from './app.js';
import { InMemoryMailboxBackend } from './imap-backend.js';

describe('@mail/mailbox-service', () => {
  let server: Server;
  let baseUrl: string;
  const backend = new InMemoryMailboxBackend();

  backend.seedMailbox('alice@acme.test', [
    {
      id: 'm1',
      threadId: 't1',
      folder: 'inbox',
      from: { name: 'Stripe Billing', address: 'billing@stripe.com' },
      to: [{ name: 'Alice', address: 'alice@acme.test' }],
      cc: [],
      bcc: [],
      subject: 'Invoice #4012',
      snippet: 'Your monthly invoice is ready',
      htmlBody: '<p>Invoice attached</p><script>alert(1)</script>',
      textBody: 'Invoice attached',
      receivedAt: '2026-11-25T10:00:00Z',
      isRead: false,
      isStarred: false,
      isImportant: true,
      labels: ['Finance'],
      attachments: [],
    },
  ]);

  const app = createMailboxApp({
    backend,
    jwtSecret: 'test_mailbox_secret_with_at_least_32_chars',
    corsOrigins: ['http://localhost:5174'],
    verifyMailboxCredentials: async (email, password) =>
      email === 'alice@acme.test' && password === 'secret-pass',
  });

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('enforces mailbox isolation, search, send with attachment download security headers', async () => {
    const badLogin = await fetch(`${baseUrl}/mail/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@other.test', password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    const loginRes = await fetch(`${baseUrl}/mail/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@acme.test', password: 'secret-pass' }),
    });
    assert.equal(loginRes.status, 200);
    const { token } = (await loginRes.json()) as { token: string };

    // Search unread
    const threadsRes = await fetch(`${baseUrl}/mail/v1/threads?folder=inbox&unreadOnly=true`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const threadsJson = (await threadsRes.json()) as { total: number; threads: Array<{ threadId: string }> };
    assert.equal(threadsJson.total, 1);

    // Send with attachment and download safely
    const sendRes = await fetch(`${baseUrl}/mail/v1/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: ['partner@example.org'],
        subject: 'Report',
        textBody: 'See attached',
        htmlBody: '<p>See attached</p>',
        attachments: [
          {
            filename: '../evil.txt',
            contentType: 'text/plain',
            contentBase64: Buffer.from('hello world').toString('base64'),
          },
        ],
      }),
    });
    assert.equal(sendRes.status, 202);
    const sent = (await sendRes.json()) as {
      message: { id: string; attachments: Array<{ partId: string }> };
    };

    const attRes = await fetch(
      `${baseUrl}/mail/v1/messages/${sent.message.id}/attachments/${sent.message.attachments[0]!.partId}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    assert.equal(attRes.status, 200);
    assert.equal(attRes.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(attRes.headers.get('content-disposition')?.includes('attachment;'));
    assert.equal(await attRes.text(), 'hello world');
  });
});
