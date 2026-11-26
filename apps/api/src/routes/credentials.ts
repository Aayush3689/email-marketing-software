import { randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  hashPasswordArgon2id,
  hashTokenSha256,
  requireAuth,
  requireOrgRole,
} from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import type { AsyncCompatible } from '../utils/async-store.js';

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  rateLimitRpm: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface SmtpCredentialRecord {
  id: string;
  organizationId: string;
  domainId: string | null;
  username: string;
  passwordHash: string;
  allowedSenderPatterns: string[];
  maxRatePerMin: number;
  lastUsedAt: string | null;
  failedAuthCount: number;
  revokedAt: string | null;
  createdAt: string;
}

export class InMemoryCredentialsStore {
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly smtpCreds = new Map<string, SmtpCredentialRecord>();

  listApiKeys(orgId: string): Omit<ApiKeyRecord, 'keyHash'>[] {
    return [...this.apiKeys.values()]
      .filter((k) => k.organizationId === orgId)
      .map(({ keyHash: _h, ...pub }) => pub);
  }

  createApiKey(orgId: string, name: string, scopes: string[], rateLimitRpm: number) {
    const secret = `mk_live_${randomBytes(24).toString('base64url')}`;
    const record: ApiKeyRecord = {
      id: randomUUID(),
      organizationId: orgId,
      name,
      keyPrefix: secret.slice(0, 14),
      keyHash: hashTokenSha256(secret),
      scopes,
      rateLimitRpm,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.apiKeys.set(record.id, record);
    const { keyHash: _h, ...pub } = record;
    return { apiKey: pub, secret };
  }

  rotateApiKey(orgId: string, id: string) {
    const existing = this.apiKeys.get(id);
    if (!existing || existing.organizationId !== orgId || existing.revokedAt) {
      return null;
    }
    const secret = `mk_live_${randomBytes(24).toString('base64url')}`;
    existing.keyPrefix = secret.slice(0, 14);
    existing.keyHash = hashTokenSha256(secret);
    const { keyHash: _h, ...pub } = existing;
    return { apiKey: pub, secret };
  }

  revokeApiKey(orgId: string, id: string): boolean {
    const existing = this.apiKeys.get(id);
    if (!existing || existing.organizationId !== orgId) return false;
    existing.revokedAt = new Date().toISOString();
    return true;
  }

  findActiveByHash(keyHash: string) {
    const match = [...this.apiKeys.values()].find(
      (k) => k.keyHash === keyHash && k.revokedAt === null
    );
    if (!match) return null;
    return {
      id: match.id,
      organizationId: match.organizationId,
      scopes: match.scopes,
      rateLimitRpm: match.rateLimitRpm,
      revokedAt: match.revokedAt,
    };
  }

  touchLastUsed(id: string): void {
    const existing = this.apiKeys.get(id);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
    }
  }

  listSmtpCredentials(orgId: string): Omit<SmtpCredentialRecord, 'passwordHash'>[] {
    return [...this.smtpCreds.values()]
      .filter((c) => c.organizationId === orgId)
      .map(({ passwordHash: _h, ...pub }) => pub);
  }

  async createSmtpCredential(input: {
    organizationId: string;
    domainId: string | null;
    allowedSenderPatterns: string[];
    maxRatePerMin: number;
  }) {
    const username = `smtp_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(24).toString('base64url');
    const passwordHash = await hashPasswordArgon2id(password);
    const record: SmtpCredentialRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainId: input.domainId,
      username,
      passwordHash,
      allowedSenderPatterns: input.allowedSenderPatterns,
      maxRatePerMin: input.maxRatePerMin,
      lastUsedAt: null,
      failedAuthCount: 0,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.smtpCreds.set(record.id, record);
    const { passwordHash: _h, ...pub } = record;
    return { credential: pub, secretPassword: password };
  }

  async rotateSmtpCredential(orgId: string, id: string) {
    const existing = this.smtpCreds.get(id);
    if (!existing || existing.organizationId !== orgId || existing.revokedAt) {
      return null;
    }
    const password = randomBytes(24).toString('base64url');
    existing.passwordHash = await hashPasswordArgon2id(password);
    const { passwordHash: _h, ...pub } = existing;
    return { credential: pub, secretPassword: password };
  }

  revokeSmtpCredential(orgId: string, id: string): boolean {
    const existing = this.smtpCreds.get(id);
    if (!existing || existing.organizationId !== orgId) return false;
    existing.revokedAt = new Date().toISOString();
    return true;
  }
}

const createApiKeySchema = z.object({
  name: z.string().min(2).max(80),
  scopes: z.array(z.string()).min(1).default(['emails:send', 'domains:read']),
  rateLimitRpm: z.number().int().min(10).max(60000).default(600),
});

const createSmtpSchema = z.object({
  domainId: z.string().nullable().default(null),
  allowedSenderPatterns: z.array(z.string().min(1)).min(1),
  maxRatePerMin: z.number().int().min(1).max(10000).default(300),
});

export type CredentialsStore = AsyncCompatible<InMemoryCredentialsStore>;

export function createCredentialsRouter(deps: {
  store: CredentialsStore;
  jwtSecret: string;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/api-keys', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    res.json({ apiKeys: await deps.store.listApiKeys(orgId) });
  });

  router.post('/api-keys', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    const parsed = createApiKeySchema.parse(req.body);
    // Secret is returned strictly once on creation; never logged.
    const created = await deps.store.createApiKey(orgId, parsed.name, parsed.scopes, parsed.rateLimitRpm);
    res.status(201).json(created);
  });

  router.post('/api-keys/:id/rotate', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    const rotated = await deps.store.rotateApiKey(orgId, String(req.params.id ?? ''));
    if (!rotated) throw new AppError(404, 'NOT_FOUND', 'Active API key not found');
    res.json(rotated);
  });

  router.delete('/api-keys/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    if (!(await deps.store.revokeApiKey(orgId, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'API key not found');
    }
    res.status(204).send();
  });

  router.get('/smtp-credentials', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    res.json({ credentials: await deps.store.listSmtpCredentials(orgId) });
  });

  router.post('/smtp-credentials', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    const parsed = createSmtpSchema.parse(req.body);
    const created = await deps.store.createSmtpCredential({
      organizationId: orgId,
      domainId: parsed.domainId,
      allowedSenderPatterns: parsed.allowedSenderPatterns,
      maxRatePerMin: parsed.maxRatePerMin,
    });
    res.status(201).json(created);
  });

  router.post('/smtp-credentials/:id/rotate', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    const rotated = await deps.store.rotateSmtpCredential(orgId, String(req.params.id ?? ''));
    if (!rotated) throw new AppError(404, 'NOT_FOUND', 'Active SMTP credential not found');
    res.json(rotated);
  });

  router.delete('/smtp-credentials/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization required');
    if (!(await deps.store.revokeSmtpCredential(orgId, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'SMTP credential not found');
    }
    res.status(204).send();
  });

  return router;
}
