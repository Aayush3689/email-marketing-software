import argon2 from 'argon2';
import { Pool } from 'pg';
import { createMailboxApp } from './app.js';
import { InMemoryMailboxBackend } from './imap-backend.js';

const PORT = Number(process.env.MAILBOX_SERVICE_PORT ?? 4100);
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || (NODE_ENV === 'production' && JWT_SECRET.includes('replace_with'))) {
  throw new Error('mailbox-service requires a secure JWT_ACCESS_SECRET (min 32 chars, non-placeholder)');
}

const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5174')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DATABASE_URL = process.env.DATABASE_URL;
const pgPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 15 }) : null;

async function verifyMailboxCredentials(email: string, password: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!pgPool) {
    return false;
  }

  const res = await pgPool.query<{ password_hash: string }>(
    `SELECT m.password_hash
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id
      WHERE m.email_address = $1
        AND m.status = 'active'
        AND d.hosting_enabled = TRUE
        AND d.is_suspended = FALSE
      LIMIT 1`,
    [normalized]
  );

  const row = res.rows[0];
  if (!row?.password_hash) return false;
  try {
    return await argon2.verify(row.password_hash, password);
  } catch {
    return false;
  }
}

const backend = new InMemoryMailboxBackend();
const app = createMailboxApp({
  backend,
  jwtSecret: JWT_SECRET,
  corsOrigins: CORS_ORIGINS,
  verifyMailboxCredentials,
});

const server = app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ service: 'mailbox-service', port: PORT, status: 'listening' }) + '\n');
});

async function shutdown() {
  server.close(async () => {
    if (pgPool) await pgPool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
