import { randomUUID } from 'node:crypto';
import { emailAddressSchema } from '@mail/validation';
import { Router } from 'express';
import { z } from 'zod';
import { hashPasswordArgon2id, requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';

export interface MailboxRecord {
  id: string;
  organizationId: string;
  domainId: string;
  serverId: string;
  localPart: string;
  emailAddress: string;
  displayName: string;
  quotaBytes: number;
  usedBytes: number;
  status: 'active' | 'suspended';
  isCatchAll: boolean;
  createdAt: string;
}

export interface AliasRecord {
  id: string;
  organizationId: string;
  domainId: string;
  sourceAddress: string;
  destinationAddresses: string[];
  isActive: boolean;
}

export interface ForwardingRuleRecord {
  id: string;
  organizationId: string;
  mailboxId: string;
  forwardToAddress: string;
  keepLocalCopy: boolean;
  isActive: boolean;
}

export interface MailboxStore {
  listMailboxes(organizationId: string): Promise<MailboxRecord[]>;
  createMailbox(input: {
    organizationId: string;
    domainId: string;
    domainName: string;
    localPart: string;
    passwordHash: string;
    displayName: string;
    quotaBytes: number;
    isCatchAll: boolean;
  }): Promise<MailboxRecord>;
  updateMailbox(
    organizationId: string,
    mailboxId: string,
    patch: { status?: 'active' | 'suspended'; quotaBytes?: number; isCatchAll?: boolean; passwordHash?: string }
  ): Promise<MailboxRecord | null>;
  deleteMailbox(organizationId: string, mailboxId: string): Promise<boolean>;
  listAliases(organizationId: string): Promise<AliasRecord[]>;
  createAlias(input: {
    organizationId: string;
    domainId: string;
    sourceAddress: string;
    destinationAddresses: string[];
  }): Promise<AliasRecord>;
  listForwardingRules(organizationId: string, mailboxId: string): Promise<ForwardingRuleRecord[]>;
  createForwardingRule(input: {
    organizationId: string;
    mailboxId: string;
    forwardToAddress: string;
    keepLocalCopy: boolean;
  }): Promise<ForwardingRuleRecord>;
}

export class InMemoryMailboxStore implements MailboxStore {
  private readonly mailboxes = new Map<string, MailboxRecord>();
  private readonly passwordHashes = new Map<string, string>();
  private readonly aliases = new Map<string, AliasRecord>();
  private readonly forwards = new Map<string, ForwardingRuleRecord>();

  async listMailboxes(organizationId: string): Promise<MailboxRecord[]> {
    return [...this.mailboxes.values()].filter((m) => m.organizationId === organizationId);
  }

  async createMailbox(input: {
    organizationId: string;
    domainId: string;
    domainName: string;
    localPart: string;
    passwordHash: string;
    displayName: string;
    quotaBytes: number;
    isCatchAll: boolean;
  }): Promise<MailboxRecord> {
    const emailAddress = `${input.localPart.toLowerCase()}@${input.domainName.toLowerCase()}`;
    const exists = [...this.mailboxes.values()].some((m) => m.emailAddress === emailAddress);
    if (exists) {
      throw new AppError(409, 'MAILBOX_EXISTS', `Mailbox ${emailAddress} already exists`);
    }

    const record: MailboxRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainId: input.domainId,
      serverId: 'default-dovecot-1',
      localPart: input.localPart.toLowerCase(),
      emailAddress,
      displayName: input.displayName,
      quotaBytes: input.quotaBytes,
      usedBytes: 0,
      status: 'active',
      isCatchAll: input.isCatchAll,
      createdAt: new Date().toISOString(),
    };
    this.mailboxes.set(record.id, record);
    this.passwordHashes.set(record.id, input.passwordHash);
    return record;
  }

  async updateMailbox(
    organizationId: string,
    mailboxId: string,
    patch: { status?: 'active' | 'suspended'; quotaBytes?: number; isCatchAll?: boolean; passwordHash?: string }
  ): Promise<MailboxRecord | null> {
    const found = this.mailboxes.get(mailboxId);
    if (!found || found.organizationId !== organizationId) return null;
    if (patch.status !== undefined) found.status = patch.status;
    if (patch.quotaBytes !== undefined) found.quotaBytes = patch.quotaBytes;
    if (patch.isCatchAll !== undefined) found.isCatchAll = patch.isCatchAll;
    if (patch.passwordHash !== undefined) this.passwordHashes.set(mailboxId, patch.passwordHash);
    return found;
  }

  async deleteMailbox(organizationId: string, mailboxId: string): Promise<boolean> {
    const found = this.mailboxes.get(mailboxId);
    if (!found || found.organizationId !== organizationId) return false;
    this.mailboxes.delete(mailboxId);
    this.passwordHashes.delete(mailboxId);
    return true;
  }

  async listAliases(organizationId: string): Promise<AliasRecord[]> {
    return [...this.aliases.values()].filter((a) => a.organizationId === organizationId);
  }

  async createAlias(input: {
    organizationId: string;
    domainId: string;
    sourceAddress: string;
    destinationAddresses: string[];
  }): Promise<AliasRecord> {
    const rec: AliasRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainId: input.domainId,
      sourceAddress: input.sourceAddress.toLowerCase(),
      destinationAddresses: input.destinationAddresses.map((a) => a.toLowerCase()),
      isActive: true,
    };
    this.aliases.set(rec.id, rec);
    return rec;
  }

  async listForwardingRules(organizationId: string, mailboxId: string): Promise<ForwardingRuleRecord[]> {
    return [...this.forwards.values()].filter(
      (f) => f.organizationId === organizationId && f.mailboxId === mailboxId
    );
  }

  async createForwardingRule(input: {
    organizationId: string;
    mailboxId: string;
    forwardToAddress: string;
    keepLocalCopy: boolean;
  }): Promise<ForwardingRuleRecord> {
    const mailbox = this.mailboxes.get(input.mailboxId);
    if (!mailbox || mailbox.organizationId !== input.organizationId) {
      throw new AppError(404, 'NOT_FOUND', 'Mailbox not found');
    }
    const rec: ForwardingRuleRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      mailboxId: input.mailboxId,
      forwardToAddress: input.forwardToAddress.toLowerCase(),
      keepLocalCopy: input.keepLocalCopy,
      isActive: true,
    };
    this.forwards.set(rec.id, rec);
    return rec;
  }
}

const createMailboxSchema = z.object({
  domainId: z.string().min(1),
  domainName: z.string().min(3),
  localPart: z.string().regex(/^[a-zA-Z0-9._+-]{1,64}$/),
  password: z.string().min(10).max(128),
  displayName: z.string().max(120).default(''),
  quotaBytes: z.number().int().min(104_857_600).default(5_368_709_120),
  isCatchAll: z.boolean().default(false),
});

const updateMailboxSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  quotaBytes: z.number().int().min(104_857_600).optional(),
  isCatchAll: z.boolean().optional(),
  password: z.string().min(10).max(128).optional(),
});

const createAliasSchema = z.object({
  domainId: z.string().min(1),
  sourceAddress: emailAddressSchema,
  destinationAddresses: z.array(emailAddressSchema).min(1).max(25),
});

const createForwardSchema = z.object({
  forwardToAddress: emailAddressSchema,
  keepLocalCopy: z.boolean().default(true),
});

export function createMailboxesRouter(deps: { store: MailboxStore; jwtSecret: string }): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/mailboxes', auth, requireOrgRole(['owner', 'admin', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const mailboxes = await deps.store.listMailboxes(orgId);
    res.json({ mailboxes });
  });

  router.post('/mailboxes', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const parsed = createMailboxSchema.parse(req.body);
    const passwordHash = await hashPasswordArgon2id(parsed.password);
    const mailbox = await deps.store.createMailbox({
      organizationId: orgId,
      domainId: parsed.domainId,
      domainName: parsed.domainName,
      localPart: parsed.localPart,
      passwordHash,
      displayName: parsed.displayName,
      quotaBytes: parsed.quotaBytes,
      isCatchAll: parsed.isCatchAll,
    });
    res.status(201).json({ mailbox });
  });

  router.patch('/mailboxes/:mailboxId', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const mailboxId = String(req.params.mailboxId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const parsed = updateMailboxSchema.parse(req.body);
    const passwordHash = parsed.password ? await hashPasswordArgon2id(parsed.password) : undefined;
    const mailbox = await deps.store.updateMailbox(orgId, mailboxId, {
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.quotaBytes !== undefined ? { quotaBytes: parsed.quotaBytes } : {}),
      ...(parsed.isCatchAll !== undefined ? { isCatchAll: parsed.isCatchAll } : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
    });
    if (!mailbox) throw new AppError(404, 'NOT_FOUND', 'Mailbox not found');
    res.json({ mailbox });
  });

  router.delete('/mailboxes/:mailboxId', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const mailboxId = String(req.params.mailboxId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const deleted = await deps.store.deleteMailbox(orgId, mailboxId);
    if (!deleted) throw new AppError(404, 'NOT_FOUND', 'Mailbox not found');
    res.status(204).send();
  });

  router.get('/aliases', auth, requireOrgRole(['owner', 'admin', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    res.json({ aliases: await deps.store.listAliases(orgId) });
  });

  router.post('/aliases', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const parsed = createAliasSchema.parse(req.body);
    const alias = await deps.store.createAlias({
      organizationId: orgId,
      domainId: parsed.domainId,
      sourceAddress: parsed.sourceAddress,
      destinationAddresses: parsed.destinationAddresses,
    });
    res.status(201).json({ alias });
  });

  router.get('/mailboxes/:mailboxId/forwarding', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const mailboxId = String(req.params.mailboxId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    res.json({ rules: await deps.store.listForwardingRules(orgId, mailboxId) });
  });

  router.post('/mailboxes/:mailboxId/forwarding', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const mailboxId = String(req.params.mailboxId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const parsed = createForwardSchema.parse(req.body);
    const rule = await deps.store.createForwardingRule({
      organizationId: orgId,
      mailboxId,
      forwardToAddress: parsed.forwardToAddress,
      keepLocalCopy: parsed.keepLocalCopy,
    });
    res.status(201).json({ rule });
  });

  return router;
}
