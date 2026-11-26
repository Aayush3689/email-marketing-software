import { randomUUID } from 'node:crypto';
import type { SuppressionReason } from '@mail/shared-types';
import { emailAddressSchema } from '@mail/validation';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import type { AsyncCompatible } from '../utils/async-store.js';

export interface TemplateRecord {
  id: string;
  organizationId: string;
  name: string;
  category: string;
  activeVersion: number;
  versions: Array<{
    versionNumber: number;
    subject: string;
    htmlBody: string;
    textBody: string;
    createdAt: string;
  }>;
  createdAt: string;
}

export interface ContactRecord {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  tags: string[];
  consentSource: string;
  consentedAt: string;
  unsubscribedAt: string | null;
}

export interface CampaignRecord {
  id: string;
  organizationId: string;
  domainId: string;
  templateId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
  timezone: string;
  scheduledAt: string | null;
  tagFilter: string | null;
  targetCount: number;
  sentCount: number;
  createdAt: string;
}

export interface SuppressionRecord {
  id: string;
  organizationId: string;
  email: string;
  reason: SuppressionReason;
  createdAt: string;
}

export class InMemoryMarketingStore {
  private readonly templates = new Map<string, TemplateRecord>();
  private readonly contacts = new Map<string, ContactRecord>();
  private readonly campaigns = new Map<string, CampaignRecord>();
  private readonly suppressions = new Map<string, SuppressionRecord>();

  listTemplates(orgId: string): TemplateRecord[] {
    return [...this.templates.values()].filter((t) => t.organizationId === orgId);
  }

  createTemplate(input: {
    organizationId: string;
    name: string;
    category: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }): TemplateRecord {
    const rec: TemplateRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      category: input.category,
      activeVersion: 1,
      versions: [
        {
          versionNumber: 1,
          subject: input.subject,
          htmlBody: input.htmlBody,
          textBody: input.textBody,
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    };
    this.templates.set(rec.id, rec);
    return rec;
  }

  duplicateTemplate(orgId: string, id: string): TemplateRecord | null {
    const orig = this.templates.get(id);
    if (!orig || orig.organizationId !== orgId) return null;
    const latest = orig.versions[orig.versions.length - 1]!;
    return this.createTemplate({
      organizationId: orgId,
      name: `${orig.name} (Copy)`,
      category: orig.category,
      subject: latest.subject,
      htmlBody: latest.htmlBody,
      textBody: latest.textBody,
    });
  }

  listContacts(orgId: string, tag?: string): ContactRecord[] {
    return [...this.contacts.values()].filter(
      (c) => c.organizationId === orgId && (!tag || c.tags.includes(tag))
    );
  }

  importContacts(
    orgId: string,
    rows: Array<{
      email: string;
      firstName?: string | undefined;
      lastName?: string | undefined;
      tags?: string[] | undefined;
      consentSource: string;
    }>
  ): { imported: number; skippedSuppressed: number } {
    let imported = 0;
    let skippedSuppressed = 0;
    const suppressedSet = new Set(
      this.listSuppressions(orgId).map((s) => s.email.toLowerCase())
    );

    for (const row of rows) {
      const email = row.email.toLowerCase();
      if (suppressedSet.has(email)) {
        skippedSuppressed += 1;
        continue;
      }
      const existing = [...this.contacts.values()].find(
        (c) => c.organizationId === orgId && c.email === email
      );
      if (existing) continue;
      const rec: ContactRecord = {
        id: randomUUID(),
        organizationId: orgId,
        email,
        firstName: row.firstName ?? '',
        lastName: row.lastName ?? '',
        tags: row.tags ?? [],
        consentSource: row.consentSource,
        consentedAt: new Date().toISOString(),
        unsubscribedAt: null,
      };
      this.contacts.set(rec.id, rec);
      imported += 1;
    }

    return { imported, skippedSuppressed };
  }

  listCampaigns(orgId: string): CampaignRecord[] {
    return [...this.campaigns.values()].filter((c) => c.organizationId === orgId);
  }

  createCampaign(input: {
    organizationId: string;
    domainId: string;
    templateId: string;
    name: string;
    timezone: string;
    scheduledAt: string | null;
    tagFilter: string | null;
  }): CampaignRecord {
    const suppressed = new Set(
      this.listSuppressions(input.organizationId).map((s) => s.email.toLowerCase())
    );
    const eligible = this.listContacts(input.organizationId, input.tagFilter ?? undefined).filter(
      (c) => !c.unsubscribedAt && !suppressed.has(c.email)
    );

    const rec: CampaignRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainId: input.domainId,
      templateId: input.templateId,
      name: input.name,
      status: input.scheduledAt ? 'scheduled' : 'draft',
      timezone: input.timezone,
      scheduledAt: input.scheduledAt,
      tagFilter: input.tagFilter,
      targetCount: eligible.length,
      sentCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.campaigns.set(rec.id, rec);
    return rec;
  }

  transitionCampaign(
    orgId: string,
    id: string,
    status: CampaignRecord['status']
  ): CampaignRecord | null {
    const c = this.campaigns.get(id);
    if (!c || c.organizationId !== orgId) return null;
    c.status = status;
    return c;
  }

  listSuppressions(orgId: string): SuppressionRecord[] {
    return [...this.suppressions.values()].filter((s) => s.organizationId === orgId);
  }

  addSuppression(orgId: string, email: string, reason: SuppressionReason): SuppressionRecord {
    const lower = email.toLowerCase();
    const existing = [...this.suppressions.values()].find(
      (s) => s.organizationId === orgId && s.email === lower
    );
    if (existing) return existing;
    const rec: SuppressionRecord = {
      id: randomUUID(),
      organizationId: orgId,
      email: lower,
      reason,
      createdAt: new Date().toISOString(),
    };
    this.suppressions.set(rec.id, rec);
    return rec;
  }

  removeSuppression(orgId: string, id: string): boolean {
    const s = this.suppressions.get(id);
    if (!s || s.organizationId !== orgId) return false;
    return this.suppressions.delete(id);
  }
}

export function renderTemplateString(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

const createTemplateSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().default('transactional'),
  subject: z.string().min(1).max(998),
  htmlBody: z.string().default(''),
  textBody: z.string().default(''),
});

const importContactsSchema = z.object({
  consentSource: z.string().min(2).max(200),
  contacts: z
    .array(
      z.object({
        email: emailAddressSchema,
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .min(1)
    .max(5000),
});

const createCampaignSchema = z.object({
  domainId: z.string().min(1),
  templateId: z.string().min(1),
  name: z.string().min(2).max(120),
  timezone: z.string().default('UTC'),
  scheduledAt: z.string().datetime().nullable().default(null),
  tagFilter: z.string().nullable().default(null),
});

export type MarketingStore = AsyncCompatible<InMemoryMarketingStore>;

export function createMarketingRouter(deps: {
  store: MarketingStore;
  jwtSecret: string;
  onCampaignStarted?: (campaign: CampaignRecord) => Promise<number>;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/templates', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    res.json({ templates: await deps.store.listTemplates(req.auth!.orgId!) });
  });

  router.post('/templates', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const parsed = createTemplateSchema.parse(req.body);
    const template = await deps.store.createTemplate({
      organizationId: req.auth!.orgId!,
      ...parsed,
    });
    res.status(201).json({ template });
  });

  router.post('/templates/:id/duplicate', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const dup = await deps.store.duplicateTemplate(req.auth!.orgId!, String(req.params.id ?? ''));
    if (!dup) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    res.status(201).json({ template: dup });
  });

  router.post('/templates/preview', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const body = z
      .object({
        subject: z.string(),
        htmlBody: z.string().default(''),
        variables: z.record(z.string(), z.string()).default({}),
      })
      .parse(req.body);
    res.json({
      subject: renderTemplateString(body.subject, body.variables),
      htmlBody: renderTemplateString(body.htmlBody, body.variables),
    });
  });

  router.get('/contacts', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    res.json({ contacts: await deps.store.listContacts(req.auth!.orgId!, tag) });
  });

  router.post('/contacts/import', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const parsed = importContactsSchema.parse(req.body);
    const result = await deps.store.importContacts(
      req.auth!.orgId!,
      parsed.contacts.map((c) => ({ ...c, consentSource: parsed.consentSource }))
    );
    res.status(201).json(result);
  });

  router.get('/campaigns', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    res.json({ campaigns: await deps.store.listCampaigns(req.auth!.orgId!) });
  });

  router.post('/campaigns', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const parsed = createCampaignSchema.parse(req.body);
    const campaign = await deps.store.createCampaign({
      organizationId: req.auth!.orgId!,
      ...parsed,
    });
    res.status(201).json({ campaign });
  });

  router.post('/campaigns/:id/:action', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const action = String(req.params.action ?? '');
    const nextStatus =
      action === 'pause'
        ? 'paused'
        : action === 'resume' || action === 'send' || action === 'start'
          ? 'running'
          : action === 'cancel'
            ? 'cancelled'
            : null;
    if (!nextStatus) throw new AppError(400, 'INVALID_ACTION', 'Unsupported campaign action');
    const updated = await deps.store.transitionCampaign(req.auth!.orgId!, String(req.params.id ?? ''), nextStatus);
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    let dispatchedCount = 0;
    if (nextStatus === 'running' && deps.onCampaignStarted) {
      dispatchedCount = await deps.onCampaignStarted(updated);
    }
    res.json({ campaign: updated, dispatchedCount });
  });

  router.get('/suppressions', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    res.json({ suppressions: await deps.store.listSuppressions(req.auth!.orgId!) });
  });

  router.post('/suppressions', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const body = z
      .object({
        email: emailAddressSchema,
        reason: z.enum(['hard_bounce', 'complaint', 'unsubscribe', 'manual']).default('manual'),
      })
      .parse(req.body);
    const entry = await deps.store.addSuppression(req.auth!.orgId!, body.email, body.reason);
    res.status(201).json({ suppression: entry });
  });

  router.delete('/suppressions/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!(await deps.store.removeSuppression(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Suppression entry not found');
    }
    res.status(204).send();
  });

  return router;
}
