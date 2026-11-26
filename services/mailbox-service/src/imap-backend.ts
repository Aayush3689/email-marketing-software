import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import type {
  MailboxFolder,
  MailboxSettings,
  MailMessage,
  MailThreadSummary,
  ThreadSearchQuery,
  WebmailContact,
} from './types.js';

export interface MailboxBackend {
  listFolders(mailboxEmail: string): Promise<MailboxFolder[]>;
  listThreads(
    mailboxEmail: string,
    query: ThreadSearchQuery
  ): Promise<{ threads: MailThreadSummary[]; total: number }>;
  getThread(mailboxEmail: string, threadId: string): Promise<MailMessage[]>;
  getAttachment(
    mailboxEmail: string,
    messageId: string,
    partId: string
  ): Promise<{ filename: string; contentType: string; bytes: Buffer } | null>;
  saveDraft(
    mailboxEmail: string,
    draft: {
      id?: string;
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      htmlBody: string;
      textBody: string;
      attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
    }
  ): Promise<MailMessage>;
  sendMessage(
    mailboxEmail: string,
    input: {
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      htmlBody: string;
      textBody: string;
      inReplyToThreadId?: string;
      scheduledAt?: string;
      attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
    }
  ): Promise<MailMessage>;
  patchMessage(
    mailboxEmail: string,
    messageId: string,
    patch: {
      isRead?: boolean;
      isStarred?: boolean;
      isImportant?: boolean;
      folder?: string;
      addLabel?: string;
      removeLabel?: string;
    }
  ): Promise<MailMessage | null>;
  listContacts(mailboxEmail: string): Promise<WebmailContact[]>;
  upsertContact(mailboxEmail: string, contact: { name: string; email: string; company?: string }): Promise<WebmailContact>;
  getSettings(mailboxEmail: string): Promise<MailboxSettings>;
  updateSettings(mailboxEmail: string, patch: Partial<MailboxSettings>): Promise<MailboxSettings>;
  subscribeEvents(mailboxEmail: string, listener: (event: { type: string; unreadInbox: number }) => void): () => void;
}

/**
 * Live Dovecot IMAP connector helper using `ImapFlow` (`CONDSTORE`/`IDLE` capable).
 * Used when `DOVECOT_IMAP_HOST` is active in production/staging environments.
 */
export class DovecotImapConnector {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly secure = false
  ) {}

  async connect(email: string, password: string): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth: { user: email, pass: password },
      logger: false,
    });
    await client.connect();
    return client;
  }
}

/**
 * High-speed mailbox store backing Webmail integration tests & local standalone preview
 * with exact IMAP folder semantics, threading, search filters, attachments, and SSE events.
 */
export class InMemoryMailboxBackend implements MailboxBackend {
  private readonly messages = new Map<string, MailMessage[]>();
  private readonly attachments = new Map<string, { filename: string; contentType: string; bytes: Buffer }>();
  private readonly contacts = new Map<string, WebmailContact[]>();
  private readonly settings = new Map<string, MailboxSettings>();
  private readonly customFolders = new Map<string, string[]>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly onOutboundDispatch?: (msg: MailMessage) => Promise<void>) {}

  seedMailbox(email: string, initialMessages: MailMessage[]): void {
    const key = email.toLowerCase();
    this.messages.set(key, [...initialMessages]);
    if (!this.settings.has(key)) {
      this.settings.set(key, {
        signatureHtml: '<p>Best regards,<br/>Platform User</p>',
        signatureEnabled: true,
        displayName: key.split('@')[0] ?? key,
        quotaBytes: 5_368_709_120,
        usedBytes: 2_450_000,
      });
    }
    if (!this.contacts.has(key)) {
      this.contacts.set(key, [
        { id: randomUUID(), name: 'Engineering Team', email: 'engineering@acme.test', company: 'Acme' },
      ]);
    }
  }

  private getMsgs(email: string): MailMessage[] {
    const key = email.toLowerCase();
    if (!this.messages.has(key)) {
      this.seedMailbox(key, []);
    }
    return this.messages.get(key) ?? [];
  }

  async listFolders(mailboxEmail: string): Promise<MailboxFolder[]> {
    const msgs = this.getMsgs(mailboxEmail);
    const custom = this.customFolders.get(mailboxEmail.toLowerCase()) ?? ['Receipts', 'Security'];

    const sys: Array<{ id: string; name: string; imapPath: string }> = [
      { id: 'inbox', name: 'Inbox', imapPath: 'INBOX' },
      { id: 'starred', name: 'Starred', imapPath: 'Starred' },
      { id: 'important', name: 'Important', imapPath: 'Important' },
      { id: 'sent', name: 'Sent', imapPath: 'Sent' },
      { id: 'drafts', name: 'Drafts', imapPath: 'Drafts' },
      { id: 'archive', name: 'Archive', imapPath: 'Archive' },
      { id: 'spam', name: 'Spam', imapPath: 'Spam' },
      { id: 'trash', name: 'Trash', imapPath: 'Trash' },
    ];

    const folders: MailboxFolder[] = sys.map((f) => {
      const matching = msgs.filter((m) => {
        if (f.id === 'starred') return m.isStarred && m.folder !== 'trash';
        if (f.id === 'important') return m.isImportant && m.folder !== 'trash';
        return m.folder === f.id;
      });
      return {
        id: f.id,
        name: f.name,
        imapPath: f.imapPath,
        kind: 'system',
        unreadCount: matching.filter((m) => !m.isRead).length,
        totalCount: matching.length,
      };
    });

    for (const c of custom) {
      const id = c.toLowerCase();
      const matching = msgs.filter((m) => m.folder === id);
      folders.push({
        id,
        name: c,
        imapPath: c,
        kind: 'custom',
        unreadCount: matching.filter((m) => !m.isRead).length,
        totalCount: matching.length,
      });
    }

    return folders;
  }

  async listThreads(
    mailboxEmail: string,
    query: ThreadSearchQuery
  ): Promise<{ threads: MailThreadSummary[]; total: number }> {
    const msgs = this.getMsgs(mailboxEmail);
    const filtered = msgs.filter((m) => {
      if (query.folder) {
        if (query.folder === 'starred') {
          if (!m.isStarred || m.folder === 'trash') return false;
        } else if (query.folder === 'important') {
          if (!m.isImportant || m.folder === 'trash') return false;
        } else if (m.folder !== query.folder) {
          return false;
        }
      }
      if (query.label && !m.labels.includes(query.label)) return false;
      if (query.unreadOnly && m.isRead) return false;
      if (query.hasAttachment && m.attachments.length === 0) return false;
      if (query.from && !m.from.address.toLowerCase().includes(query.from.toLowerCase())) return false;
      if (query.to && !m.to.some((t) => t.address.toLowerCase().includes(query.to!.toLowerCase()))) return false;
      if (query.subject && !m.subject.toLowerCase().includes(query.subject.toLowerCase())) return false;
      if (query.dateFrom && m.receivedAt < query.dateFrom) return false;
      if (query.dateTo && m.receivedAt > query.dateTo) return false;
      if (query.q) {
        const needle = query.q.toLowerCase();
        const hay = `${m.subject} ${m.snippet} ${m.from.address} ${m.from.name} ${m.textBody}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const grouped = new Map<string, MailMessage[]>();
    for (const m of filtered) {
      const list = grouped.get(m.threadId) ?? [];
      list.push(m);
      grouped.set(m.threadId, list);
    }

    const summaries: MailThreadSummary[] = [];
    for (const [threadId, threadMsgs] of grouped.entries()) {
      threadMsgs.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      const latest = threadMsgs[threadMsgs.length - 1]!;
      const participants = new Map<string, { name: string; address: string }>();
      for (const tm of threadMsgs) {
        participants.set(tm.from.address, tm.from);
      }
      summaries.push({
        threadId,
        subject: latest.subject,
        snippet: latest.snippet,
        participants: [...participants.values()],
        lastMessageAt: latest.receivedAt,
        messageCount: threadMsgs.length,
        unreadCount: threadMsgs.filter((m) => !m.isRead).length,
        isStarred: threadMsgs.some((m) => m.isStarred),
        isImportant: threadMsgs.some((m) => m.isImportant),
        hasAttachments: threadMsgs.some((m) => m.attachments.length > 0),
        labels: [...new Set(threadMsgs.flatMap((m) => m.labels))],
        folder: latest.folder,
      });
    }

    summaries.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    const start = (query.page - 1) * query.pageSize;
    return {
      threads: summaries.slice(start, start + query.pageSize),
      total: summaries.length,
    };
  }

  async getThread(mailboxEmail: string, threadId: string): Promise<MailMessage[]> {
    return this.getMsgs(mailboxEmail)
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async getAttachment(
    mailboxEmail: string,
    messageId: string,
    partId: string
  ): Promise<{ filename: string; contentType: string; bytes: Buffer } | null> {
    const key = `${mailboxEmail.toLowerCase()}:${messageId}:${partId}`;
    return this.attachments.get(key) ?? null;
  }

  async saveDraft(
    mailboxEmail: string,
    draft: {
      id?: string;
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      htmlBody: string;
      textBody: string;
    }
  ): Promise<MailMessage> {
    const msgs = this.getMsgs(mailboxEmail);
    const existing = draft.id ? msgs.find((m) => m.id === draft.id && m.folder === 'drafts') : undefined;
    const msg: MailMessage = existing ?? {
      id: draft.id ?? randomUUID(),
      threadId: randomUUID(),
      folder: 'drafts',
      from: { name: mailboxEmail, address: mailboxEmail },
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      snippet: '',
      htmlBody: '',
      textBody: '',
      receivedAt: new Date().toISOString(),
      isRead: true,
      isStarred: false,
      isImportant: false,
      labels: [],
      attachments: [],
    };
    msg.to = draft.to.map((a) => ({ name: a, address: a }));
    msg.cc = draft.cc.map((a) => ({ name: a, address: a }));
    msg.bcc = draft.bcc.map((a) => ({ name: a, address: a }));
    msg.subject = draft.subject || '(No subject)';
    msg.htmlBody = draft.htmlBody;
    msg.textBody = draft.textBody;
    msg.snippet = draft.textBody.slice(0, 120);
    msg.receivedAt = new Date().toISOString();

    if (!existing) msgs.push(msg);
    this.emitUpdate(mailboxEmail);
    return msg;
  }

  async sendMessage(
    mailboxEmail: string,
    input: {
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string;
      htmlBody: string;
      textBody: string;
      inReplyToThreadId?: string;
      scheduledAt?: string;
      attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
    }
  ): Promise<MailMessage> {
    const id = randomUUID();
    const attachmentMetas = (input.attachments ?? []).map((att, idx) => {
      const partId = `part-${idx + 1}`;
      const bytes = Buffer.from(att.contentBase64, 'base64');
      this.attachments.set(`${mailboxEmail.toLowerCase()}:${id}:${partId}`, {
        filename: att.filename,
        contentType: att.contentType,
        bytes,
      });
      return {
        partId,
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: bytes.byteLength,
        isInline: false,
      };
    });

    const msg: MailMessage = {
      id,
      threadId: input.inReplyToThreadId ?? randomUUID(),
      folder: input.scheduledAt ? 'drafts' : 'sent',
      from: { name: mailboxEmail, address: mailboxEmail },
      to: input.to.map((a) => ({ name: a, address: a })),
      cc: input.cc.map((a) => ({ name: a, address: a })),
      bcc: input.bcc.map((a) => ({ name: a, address: a })),
      subject: input.subject,
      snippet: input.textBody.slice(0, 140),
      htmlBody: input.htmlBody,
      textBody: input.textBody,
      receivedAt: new Date().toISOString(),
      isRead: true,
      isStarred: false,
      isImportant: false,
      labels: input.scheduledAt ? ['Scheduled'] : [],
      attachments: attachmentMetas,
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    };

    this.getMsgs(mailboxEmail).push(msg);
    if (!input.scheduledAt && this.onOutboundDispatch) {
      await this.onOutboundDispatch(msg);
    }
    this.emitUpdate(mailboxEmail);
    return msg;
  }

  async patchMessage(
    mailboxEmail: string,
    messageId: string,
    patch: {
      isRead?: boolean;
      isStarred?: boolean;
      isImportant?: boolean;
      folder?: string;
      addLabel?: string;
      removeLabel?: string;
    }
  ): Promise<MailMessage | null> {
    const msg = this.getMsgs(mailboxEmail).find((m) => m.id === messageId);
    if (!msg) return null;
    if (patch.isRead !== undefined) msg.isRead = patch.isRead;
    if (patch.isStarred !== undefined) msg.isStarred = patch.isStarred;
    if (patch.isImportant !== undefined) msg.isImportant = patch.isImportant;
    if (patch.folder !== undefined) msg.folder = patch.folder;
    if (patch.addLabel && !msg.labels.includes(patch.addLabel)) msg.labels.push(patch.addLabel);
    if (patch.removeLabel) msg.labels = msg.labels.filter((l) => l !== patch.removeLabel);
    this.emitUpdate(mailboxEmail);
    return msg;
  }

  async listContacts(mailboxEmail: string): Promise<WebmailContact[]> {
    return this.contacts.get(mailboxEmail.toLowerCase()) ?? [];
  }

  async upsertContact(
    mailboxEmail: string,
    contact: { name: string; email: string; company?: string }
  ): Promise<WebmailContact> {
    const key = mailboxEmail.toLowerCase();
    const list = this.contacts.get(key) ?? [];
    const rec: WebmailContact = { id: randomUUID(), ...contact };
    list.push(rec);
    this.contacts.set(key, list);
    return rec;
  }

  async getSettings(mailboxEmail: string): Promise<MailboxSettings> {
    const key = mailboxEmail.toLowerCase();
    if (!this.settings.has(key)) this.seedMailbox(key, []);
    return this.settings.get(key)!;
  }

  async updateSettings(mailboxEmail: string, patch: Partial<MailboxSettings>): Promise<MailboxSettings> {
    const current = await this.getSettings(mailboxEmail);
    const updated = { ...current, ...patch };
    this.settings.set(mailboxEmail.toLowerCase(), updated);
    return updated;
  }

  subscribeEvents(
    mailboxEmail: string,
    listener: (event: { type: string; unreadInbox: number }) => void
  ): () => void {
    const channel = `ev:${mailboxEmail.toLowerCase()}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  private emitUpdate(mailboxEmail: string): void {
    const msgs = this.getMsgs(mailboxEmail);
    const unreadInbox = msgs.filter((m) => m.folder === 'inbox' && !m.isRead).length;
    this.emitter.emit(`ev:${mailboxEmail.toLowerCase()}`, {
      type: 'mailbox_updated',
      unreadInbox,
    });
  }
}
