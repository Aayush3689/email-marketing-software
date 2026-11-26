import { emailAddressSchema } from '@mail/validation';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { SignJWT, jwtVerify } from 'jose';
import { z, ZodError } from 'zod';
import type { MailboxBackend } from './imap-backend.js';

export interface MailboxServiceDeps {
  backend: MailboxBackend;
  jwtSecret: string;
  corsOrigins: string[];
  verifyMailboxCredentials: (email: string, password: string) => Promise<boolean>;
}

interface MailAuthRequest extends Request {
  mailboxEmail?: string;
}

const loginSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(1).max(128),
});

const sendSchema = z.object({
  to: z.array(emailAddressSchema).min(1).max(50),
  cc: z.array(emailAddressSchema).max(50).default([]),
  bcc: z.array(emailAddressSchema).max(50).default([]),
  subject: z.string().min(1).max(998),
  htmlBody: z.string().max(2_000_000).default(''),
  textBody: z.string().max(2_000_000).default(''),
  inReplyToThreadId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.string().min(3).max(120),
        contentBase64: z.string().max(10_000_000),
      })
    )
    .max(10)
    .optional(),
});

const draftSchema = z.object({
  id: z.string().optional(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  bcc: z.array(z.string()).default([]),
  subject: z.string().max(998).default(''),
  htmlBody: z.string().max(2_000_000).default(''),
  textBody: z.string().max(2_000_000).default(''),
});

const patchSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isImportant: z.boolean().optional(),
  folder: z.string().min(1).max(64).optional(),
  addLabel: z.string().min(1).max(64).optional(),
  removeLabel: z.string().min(1).max(64).optional(),
});

export function createMailboxApp(deps: MailboxServiceDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: deps.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '12mb' }));

  const key = new TextEncoder().encode(deps.jwtSecret);

  async function requireMailboxAuth(
    req: MailAuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const auth = req.header('authorization');
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : queryToken;
    if (!raw) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Mailbox authentication required' } });
      return;
    }
    try {
      const { payload } = await jwtVerify(raw, key, {
        algorithms: ['HS256'],
        audience: 'mail',
      });
      if (typeof payload.sub !== 'string' || payload.scope !== 'mailbox') {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid mailbox token scope' } });
        return;
      }
      req.mailboxEmail = payload.sub;
      next();
    } catch {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
  }

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'mailbox-service' });
  });

  app.post('/mail/v1/auth/login', async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const ok = await deps.verifyMailboxCredentials(email, password);
    if (!ok) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid mailbox credentials' } });
      return;
    }
    const token = await new SignJWT({ scope: 'mailbox' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(email.toLowerCase())
      .setAudience('mail')
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(key);

    res.json({ token, mailboxEmail: email.toLowerCase() });
  });

  app.get('/mail/v1/folders', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const folders = await deps.backend.listFolders(req.mailboxEmail!);
    res.json({ folders });
  });

  app.get('/mail/v1/threads', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const rawPage = Number(req.query.page);
    const rawSize = Number(req.query.pageSize);
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
    const pageSize = Number.isFinite(rawSize) ? Math.min(100, Math.max(1, Math.trunc(rawSize))) : 25;
    const result = await deps.backend.listThreads(req.mailboxEmail!, {
      ...(typeof req.query.folder === 'string' ? { folder: req.query.folder } : {}),
      ...(typeof req.query.label === 'string' ? { label: req.query.label } : {}),
      ...(typeof req.query.q === 'string' ? { q: req.query.q } : {}),
      ...(typeof req.query.from === 'string' ? { from: req.query.from } : {}),
      ...(typeof req.query.to === 'string' ? { to: req.query.to } : {}),
      ...(typeof req.query.subject === 'string' ? { subject: req.query.subject } : {}),
      ...(typeof req.query.dateFrom === 'string' ? { dateFrom: req.query.dateFrom } : {}),
      ...(typeof req.query.dateTo === 'string' ? { dateTo: req.query.dateTo } : {}),
      ...(req.query.hasAttachment === 'true' ? { hasAttachment: true } : {}),
      ...(req.query.unreadOnly === 'true' ? { unreadOnly: true } : {}),
      page,
      pageSize,
    });
    res.json({ ...result, page, pageSize });
  });

  app.get('/mail/v1/threads/:threadId', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const messages = await deps.backend.getThread(req.mailboxEmail!, String(req.params.threadId ?? ''));
    if (messages.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Thread not found' } });
      return;
    }
    res.json({ threadId: req.params.threadId, messages });
  });

  app.get('/mail/v1/messages/:id/attachments/:partId', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const att = await deps.backend.getAttachment(
      req.mailboxEmail!,
      String(req.params.id ?? ''),
      String(req.params.partId ?? '')
    );
    if (!att) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attachment not found' } });
      return;
    }
    const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeType =
      att.contentType === 'image/svg+xml' || att.contentType === 'text/html'
        ? 'application/octet-stream'
        : att.contentType;
    res.setHeader('Content-Type', safeType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.send(att.bytes);
  });

  app.post('/mail/v1/drafts', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const parsed = draftSchema.parse(req.body);
    const draft = await deps.backend.saveDraft(req.mailboxEmail!, {
      ...(parsed.id !== undefined ? { id: parsed.id } : {}),
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      htmlBody: parsed.htmlBody,
      textBody: parsed.textBody,
    });
    res.json({ draft });
  });

  app.post('/mail/v1/messages/send', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const parsed = sendSchema.parse(req.body);
    const message = await deps.backend.sendMessage(req.mailboxEmail!, {
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      htmlBody: parsed.htmlBody,
      textBody: parsed.textBody,
      ...(parsed.inReplyToThreadId !== undefined ? { inReplyToThreadId: parsed.inReplyToThreadId } : {}),
      ...(parsed.scheduledAt !== undefined ? { scheduledAt: parsed.scheduledAt } : {}),
      ...(parsed.attachments !== undefined ? { attachments: parsed.attachments } : {}),
    });
    res.status(202).json({ message });
  });

  app.patch('/mail/v1/messages/:id', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const parsed = patchSchema.parse(req.body);
    const updated = await deps.backend.patchMessage(req.mailboxEmail!, String(req.params.id ?? ''), {
      ...(parsed.isRead !== undefined ? { isRead: parsed.isRead } : {}),
      ...(parsed.isStarred !== undefined ? { isStarred: parsed.isStarred } : {}),
      ...(parsed.isImportant !== undefined ? { isImportant: parsed.isImportant } : {}),
      ...(parsed.folder !== undefined ? { folder: parsed.folder } : {}),
      ...(parsed.addLabel !== undefined ? { addLabel: parsed.addLabel } : {}),
      ...(parsed.removeLabel !== undefined ? { removeLabel: parsed.removeLabel } : {}),
    });
    if (!updated) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Message not found' } });
      return;
    }
    res.json({ message: updated });
  });

  app.get('/mail/v1/contacts', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    res.json({ contacts: await deps.backend.listContacts(req.mailboxEmail!) });
  });

  app.post('/mail/v1/contacts', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        email: emailAddressSchema,
        company: z.string().max(120).optional(),
      })
      .parse(req.body);
    const contact = await deps.backend.upsertContact(req.mailboxEmail!, {
      name: body.name,
      email: body.email,
      ...(body.company !== undefined ? { company: body.company } : {}),
    });
    res.status(201).json({ contact });
  });

  app.get('/mail/v1/settings', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    res.json({ settings: await deps.backend.getSettings(req.mailboxEmail!) });
  });

  app.put('/mail/v1/settings', requireMailboxAuth, async (req: MailAuthRequest, res) => {
    const patch = z
      .object({
        signatureHtml: z.string().max(20_000).optional(),
        signatureEnabled: z.boolean().optional(),
        displayName: z.string().max(120).optional(),
      })
      .parse(req.body);
    const settings = await deps.backend.updateSettings(req.mailboxEmail!, {
      ...(patch.signatureHtml !== undefined ? { signatureHtml: patch.signatureHtml } : {}),
      ...(patch.signatureEnabled !== undefined ? { signatureEnabled: patch.signatureEnabled } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    });
    res.json({ settings });
  });

  app.get('/mail/v1/events', requireMailboxAuth, (req: MailAuthRequest, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const unsubscribe = deps.backend.subscribeEvents(req.mailboxEmail!, (ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: err.flatten() } });
      return;
    }
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}
