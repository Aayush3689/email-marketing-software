import { randomBytes, randomUUID } from 'node:crypto';
import { createDomainRequestSchema } from '@mail/validation';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';

export interface DomainRecord {
  id: string;
  organizationId: string;
  domainName: string;
  verificationToken: string;
  ownershipVerifiedAt: string | null;
  sendingEnabled: boolean;
  hostingEnabled: boolean;
  isSuspended: boolean;
  suspensionReason: string | null;
  activeDkimSelector: string | null;
  dmarcPolicy: 'none' | 'quarantine' | 'reject';
  createdAt: string;
}

export interface DomainStore {
  listDomains(organizationId: string): Promise<DomainRecord[]>;
  listAllDomains?(): Promise<DomainRecord[]>;
  adminSetSuspended?(
    domainId: string,
    isSuspended: boolean,
    suspensionReason: string | null
  ): Promise<DomainRecord | null>;
  createDomain(input: {
    organizationId: string;
    domainName: string;
    sendingEnabled: boolean;
    hostingEnabled: boolean;
  }): Promise<DomainRecord>;
  getDomain(organizationId: string, domainId: string): Promise<DomainRecord | null>;
  markVerified(organizationId: string, domainId: string): Promise<DomainRecord | null>;
  updateSettings(
    organizationId: string,
    domainId: string,
    patch: { hostingEnabled?: boolean; sendingEnabled?: boolean; dmarcPolicy?: 'none' | 'quarantine' | 'reject' }
  ): Promise<DomainRecord | null>;
}

export class InMemoryDomainStore implements DomainStore {
  private readonly records = new Map<string, DomainRecord>();

  async listDomains(organizationId: string): Promise<DomainRecord[]> {
    return [...this.records.values()].filter((d) => d.organizationId === organizationId);
  }

  async listAllDomains(): Promise<DomainRecord[]> {
    return [...this.records.values()];
  }

  async adminSetSuspended(
    domainId: string,
    isSuspended: boolean,
    suspensionReason: string | null
  ): Promise<DomainRecord | null> {
    const found = this.records.get(domainId);
    if (!found) return null;
    found.isSuspended = isSuspended;
    found.suspensionReason = isSuspended ? suspensionReason : null;
    return found;
  }

  async createDomain(input: {
    organizationId: string;
    domainName: string;
    sendingEnabled: boolean;
    hostingEnabled: boolean;
  }): Promise<DomainRecord> {
    const duplicate = [...this.records.values()].find((d) => d.domainName === input.domainName);
    if (duplicate) {
      throw new AppError(409, 'DOMAIN_EXISTS', 'Domain is already registered');
    }
    const record: DomainRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainName: input.domainName,
      verificationToken: `mailplat-verify=${randomBytes(16).toString('hex')}`,
      ownershipVerifiedAt: null,
      sendingEnabled: input.sendingEnabled,
      hostingEnabled: input.hostingEnabled,
      isSuspended: false,
      suspensionReason: null,
      activeDkimSelector: 'mp1',
      dmarcPolicy: 'none',
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.id, record);
    return record;
  }

  async getDomain(organizationId: string, domainId: string): Promise<DomainRecord | null> {
    const found = this.records.get(domainId);
    if (!found || found.organizationId !== organizationId) return null;
    return found;
  }

  async markVerified(organizationId: string, domainId: string): Promise<DomainRecord | null> {
    const found = await this.getDomain(organizationId, domainId);
    if (!found) return null;
    found.ownershipVerifiedAt = new Date().toISOString();
    return found;
  }

  async updateSettings(
    organizationId: string,
    domainId: string,
    patch: { hostingEnabled?: boolean; sendingEnabled?: boolean; dmarcPolicy?: 'none' | 'quarantine' | 'reject' }
  ): Promise<DomainRecord | null> {
    const found = await this.getDomain(organizationId, domainId);
    if (!found) return null;
    if (patch.hostingEnabled !== undefined) found.hostingEnabled = patch.hostingEnabled;
    if (patch.sendingEnabled !== undefined) found.sendingEnabled = patch.sendingEnabled;
    if (patch.dmarcPolicy !== undefined) found.dmarcPolicy = patch.dmarcPolicy;
    return found;
  }
}

const updateDomainSchema = z.object({
  hostingEnabled: z.boolean().optional(),
  sendingEnabled: z.boolean().optional(),
  dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).optional(),
});

export function buildRequiredDnsRecords(domain: DomainRecord) {
  return [
    {
      type: 'TXT',
      host: `_mailplat-verify.${domain.domainName}`,
      value: domain.verificationToken,
      purpose: 'Domain ownership verification',
    },
    {
      type: 'MX',
      host: domain.domainName,
      value: '10 mx1.mailplat.local',
      purpose: 'Inbound mailbox delivery',
    },
    {
      type: 'TXT',
      host: domain.domainName,
      value: 'v=spf1 include:spf.mailplat.local ~all',
      purpose: 'SPF sender authorization',
    },
    {
      type: 'TXT',
      host: `${domain.activeDkimSelector ?? 'mp1'}._domainkey.${domain.domainName}`,
      value: 'v=DKIM1; k=ed25519; p=<generated-on-key-provision>',
      purpose: 'DKIM cryptographic signing',
    },
    {
      type: 'TXT',
      host: `_dmarc.${domain.domainName}`,
      value: `v=DMARC1; p=${domain.dmarcPolicy}; rua=mailto:dmarc@${domain.domainName}`,
      purpose: 'DMARC policy & reporting',
    },
  ];
}

export function createDomainsRouter(deps: { store: DomainStore; jwtSecret: string }): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/domains', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domains = await deps.store.listDomains(orgId);
    res.json({ domains });
  });

  router.post('/domains', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const parsed = createDomainRequestSchema.parse(req.body);
    const domain = await deps.store.createDomain({
      organizationId: orgId,
      domainName: parsed.domainName,
      sendingEnabled: parsed.sendingEnabled,
      hostingEnabled: parsed.hostingEnabled,
    });
    res.status(201).json({ domain, dnsRecords: buildRequiredDnsRecords(domain) });
  });

  router.get('/domains/:domainId', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.getDomain(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    res.json({ domain, dnsRecords: buildRequiredDnsRecords(domain) });
  });

  router.post('/domains/:domainId/verify', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const domain = await deps.store.markVerified(orgId, domainId);
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    res.json({ domain, verified: true });
  });

  router.patch('/domains/:domainId', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    const orgId = req.auth?.orgId;
    const domainId = String(req.params.domainId ?? '');
    if (!orgId) throw new AppError(400, 'NO_ORG', 'Organization context required');
    const patch = updateDomainSchema.parse(req.body);
    const domain = await deps.store.updateSettings(orgId, domainId, {
      ...(patch.hostingEnabled !== undefined ? { hostingEnabled: patch.hostingEnabled } : {}),
      ...(patch.sendingEnabled !== undefined ? { sendingEnabled: patch.sendingEnabled } : {}),
      ...(patch.dmarcPolicy !== undefined ? { dmarcPolicy: patch.dmarcPolicy } : {}),
    });
    if (!domain) throw new AppError(404, 'NOT_FOUND', 'Domain not found');
    res.json({ domain });
  });

  return router;
}
