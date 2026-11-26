import type {
  AutomationItem,
  EmailSequenceItem,
  SegmentConditionGroup,
  SegmentConditionRule,
  SubscriberStatus,
} from '@mail/shared-types';
import {
  createCustomFieldSchema,
  createTagSchema,
  emailAddressSchema,
  saveSegmentSchema,
  upsertSubscriberSchema,
} from '@mail/validation';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import type { AnalyticsStore } from './analytics.js';
import type { MarketingStore } from './campaigns.js';

function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function createMarketingPlatformRouter(deps: {
  store: MarketingStore;
  jwtSecret: string;
  analyticsStore?: AnalyticsStore;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  // =========================================================================
  // 1. Subscribers & Profiles
  // =========================================================================
  router.get('/subscribers', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth!.orgId!;
    const q = {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: typeof req.query.status === 'string' && req.query.status ? (req.query.status as SubscriberStatus) : undefined,
      tag: typeof req.query.tag === 'string' && req.query.tag ? req.query.tag : undefined,
      tagId: typeof req.query.tagId === 'string' && req.query.tagId ? req.query.tagId : undefined,
      segmentId: typeof req.query.segmentId === 'string' && req.query.segmentId ? req.query.segmentId : undefined,
      source: typeof req.query.source === 'string' && req.query.source ? req.query.source : undefined,
      customFieldKey: typeof req.query.customFieldKey === 'string' && req.query.customFieldKey ? req.query.customFieldKey : undefined,
      customFieldValue: typeof req.query.customFieldValue === 'string' && req.query.customFieldValue ? req.query.customFieldValue : undefined,
      sort: typeof req.query.sort === 'string' ? (req.query.sort as 'recent' | 'oldest' | 'engagement' | 'email') : 'recent',
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25,
    };
    if (deps.store.querySubscribers) {
      return res.json(await deps.store.querySubscribers(orgId, q, deps.analyticsStore));
    }
    const contacts = await deps.store.listContacts(orgId, q.tag);
    return res.json({ subscribers: contacts, total: contacts.length, page: 1, pageSize: contacts.length || 25 });
  });

  router.post('/subscribers', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.upsertSubscriber) throw new AppError(501, 'NOT_SUPPORTED', 'Subscriber upsert unavailable');
    const parsed = upsertSubscriberSchema.parse(req.body);
    const result = await deps.store.upsertSubscriber(req.auth!.orgId!, {
      email: parsed.email,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      status: parsed.status,
      tags: parsed.tags,
      attributes: parsed.attributes,
      consentSource: parsed.consentSource,
      ...(parsed.consentedAt ? { consentedAt: parsed.consentedAt } : {}),
    });
    if (parsed.tags.length > 0 && deps.store.triggerAutomationForSubscriber) {
      for (const tagName of parsed.tags) {
        await Promise.resolve(
          deps.store.triggerAutomationForSubscriber(req.auth!.orgId!, 'tag_added', result.subscriber.id, { tagName })
        ).catch(() => 0);
      }
    }
    res.status(result.created ? 201 : 200).json(result);
  });

  router.get('/subscribers/export.csv', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const orgId = req.auth!.orgId!;
    const selectedIds =
      typeof req.query.ids === 'string' && req.query.ids
        ? new Set(req.query.ids.split(',').map((s) => s.trim()))
        : null;
    const rows = deps.store.querySubscribers
      ? (
          await deps.store.querySubscribers(
            orgId,
            {
              search: typeof req.query.search === 'string' ? req.query.search : undefined,
              status: typeof req.query.status === 'string' && req.query.status ? (req.query.status as SubscriberStatus) : undefined,
              tag: typeof req.query.tag === 'string' && req.query.tag ? req.query.tag : undefined,
              segmentId: typeof req.query.segmentId === 'string' && req.query.segmentId ? req.query.segmentId : undefined,
              page: 1,
              pageSize: 10000,
            },
            deps.analyticsStore
          )
        ).subscribers
      : await deps.store.listContacts(orgId);
    const finalRows = selectedIds ? rows.filter((r) => selectedIds.has(r.id)) : rows;
    const lines = ['id,email,firstName,lastName,status,tags,consentSource,consentedAt,createdAt'];
    for (const r of finalRows) {
      lines.push(
        [
          escapeCsvCell(r.id),
          escapeCsvCell(r.email),
          escapeCsvCell(r.firstName),
          escapeCsvCell(r.lastName),
          escapeCsvCell(r.status),
          escapeCsvCell(r.tags.join(';')),
          escapeCsvCell(r.consentSource),
          escapeCsvCell(r.consentedAt),
          escapeCsvCell(r.createdAt),
        ].join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fastconnect-subscribers.csv"');
    res.send(lines.join('\n'));
  });

  router.post('/subscribers/import-csv', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createImportJob) throw new AppError(501, 'NOT_SUPPORTED', 'CSV import jobs unavailable');
    const body = z
      .object({
        fileName: z.string().nullable().default('import.csv'),
        consentSource: z.string().trim().max(200),
        defaultTags: z.array(z.string()).default([]),
        fieldMapping: z.record(z.string(), z.string()).default({}),
        csvText: z.string().min(1).max(10_000_000),
      })
      .parse(req.body);
    const job = await deps.store.createImportJob(req.auth!.orgId!, body);
    res.status(201).json({ job });
  });

  router.get('/subscribers/import-jobs', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const jobs = deps.store.listImportJobs ? await deps.store.listImportJobs(req.auth!.orgId!) : [];
    res.json({ jobs });
  });

  router.get('/subscribers/import-jobs/:jobId', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    if (!deps.store.getImportJob) throw new AppError(404, 'NOT_FOUND', 'Import job not found');
    const job = await deps.store.getImportJob(req.auth!.orgId!, String(req.params.jobId ?? ''));
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Import job not found');
    res.json({ job });
  });

  router.get('/subscribers/import-jobs/:jobId/errors.csv', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    if (!deps.store.getImportJob) throw new AppError(404, 'NOT_FOUND', 'Import job not found');
    const job = await deps.store.getImportJob(req.auth!.orgId!, String(req.params.jobId ?? ''));
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Import job not found');
    const lines = ['row,email,reason'];
    for (const err of job.errorReport) {
      lines.push([String(err.row), escapeCsvCell(err.email), escapeCsvCell(err.reason)].join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-errors-${job.id}.csv"`);
    res.send(lines.join('\n'));
  });

  router.post('/subscribers/bulk', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.bulkSubscribersAction) throw new AppError(501, 'NOT_SUPPORTED', 'Bulk actions unavailable');
    const body = z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(2000),
        action: z.enum(['add_tag', 'remove_tag', 'unsubscribe', 'delete']),
        tagName: z.string().trim().min(1).max(64).optional(),
      })
      .parse(req.body);
    const result = await deps.store.bulkSubscribersAction(req.auth!.orgId!, body.ids, body.action, body.tagName);
    res.json(result);
  });

  router.get('/subscribers/:id', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    if (!deps.store.getSubscriberProfile) throw new AppError(501, 'NOT_SUPPORTED', 'Profile lookup unavailable');
    const profile = await deps.store.getSubscriberProfile(req.auth!.orgId!, String(req.params.id ?? ''), deps.analyticsStore);
    if (!profile) throw new AppError(404, 'NOT_FOUND', 'Subscriber not found');
    res.json(profile);
  });

  router.patch('/subscribers/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateSubscriber) throw new AppError(501, 'NOT_SUPPORTED', 'Subscriber update unavailable');
    const body = z
      .object({
        firstName: z.string().max(120).optional(),
        lastName: z.string().max(120).optional(),
        attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
        addTags: z.array(z.string().trim().min(1).max(64)).optional(),
        removeTags: z.array(z.string().trim().min(1).max(64)).optional(),
      })
      .parse(req.body);
    const subscriber = await deps.store.updateSubscriber(req.auth!.orgId!, String(req.params.id ?? ''), body);
    if (!subscriber) throw new AppError(404, 'NOT_FOUND', 'Subscriber not found');
    if (body.addTags?.length && deps.store.triggerAutomationForSubscriber) {
      for (const tagName of body.addTags) {
        await Promise.resolve(
          deps.store.triggerAutomationForSubscriber(req.auth!.orgId!, 'tag_added', subscriber.id, { tagName })
        ).catch(() => 0);
      }
    }
    res.json({ subscriber });
  });

  router.post('/subscribers/:id/unsubscribe', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.unsubscribeSubscriber) throw new AppError(501, 'NOT_SUPPORTED', 'Unsubscribe unavailable');
    const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    const subscriber = await deps.store.unsubscribeSubscriber(req.auth!.orgId!, String(req.params.id ?? ''), body.reason);
    if (!subscriber) throw new AppError(404, 'NOT_FOUND', 'Subscriber not found');
    res.json({ subscriber });
  });

  router.post('/subscribers/:id/resubscribe', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.resubscribeSubscriber) throw new AppError(501, 'NOT_SUPPORTED', 'Resubscribe unavailable');
    const body = z
      .object({
        consentSource: z.string().trim().min(3).max(200),
        confirmedByConsent: z.literal(true),
      })
      .parse(req.body);
    const subscriber = await deps.store.resubscribeSubscriber(req.auth!.orgId!, String(req.params.id ?? ''), body.consentSource);
    if (!subscriber) throw new AppError(404, 'NOT_FOUND', 'Subscriber not found');
    res.json({ subscriber });
  });

  router.delete('/subscribers/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteSubscriber) throw new AppError(501, 'NOT_SUPPORTED', 'Delete subscriber unavailable');
    if (!(await deps.store.deleteSubscriber(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Subscriber not found');
    }
    res.status(204).send();
  });

  // =========================================================================
  // 2. Tags & Custom Fields
  // =========================================================================
  router.get('/tags', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const tags = deps.store.listTags ? await deps.store.listTags(req.auth!.orgId!) : [];
    res.json({ tags });
  });

  router.post('/tags', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createTag) throw new AppError(501, 'NOT_SUPPORTED', 'Tags unavailable');
    const parsed = createTagSchema.parse(req.body);
    const tag = await deps.store.createTag(req.auth!.orgId!, parsed);
    res.status(201).json({ tag });
  });

  router.patch('/tags/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateTag) throw new AppError(501, 'NOT_SUPPORTED', 'Tags unavailable');
    const patch = createTagSchema.partial().parse(req.body);
    const tag = await deps.store.updateTag(req.auth!.orgId!, String(req.params.id ?? ''), patch);
    if (!tag) throw new AppError(404, 'NOT_FOUND', 'Tag not found');
    res.json({ tag });
  });

  router.delete('/tags/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteTag) throw new AppError(501, 'NOT_SUPPORTED', 'Tags unavailable');
    if (!(await deps.store.deleteTag(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Tag not found');
    }
    res.status(204).send();
  });

  router.get('/custom-fields', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const customFields = deps.store.listCustomFields ? await deps.store.listCustomFields(req.auth!.orgId!) : [];
    res.json({ customFields });
  });

  router.post('/custom-fields', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createCustomField) throw new AppError(501, 'NOT_SUPPORTED', 'Custom fields unavailable');
    const parsed = createCustomFieldSchema.parse(req.body);
    const field = await deps.store.createCustomField(req.auth!.orgId!, parsed);
    res.status(201).json({ customField: field });
  });

  router.delete('/custom-fields/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteCustomField) throw new AppError(501, 'NOT_SUPPORTED', 'Custom fields unavailable');
    if (!(await deps.store.deleteCustomField(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Custom field not found');
    }
    res.status(204).send();
  });

  // =========================================================================
  // 3. Dynamic Segments
  // =========================================================================
  router.get('/segments', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const segments = deps.store.listSegments ? await deps.store.listSegments(req.auth!.orgId!, deps.analyticsStore) : [];
    res.json({ segments });
  });

  router.post('/segments/preview', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    if (!deps.store.previewSegment) throw new AppError(501, 'NOT_SUPPORTED', 'Segment preview unavailable');
    const body = z
      .object({
        matchType: z.enum(['all', 'any']).default('all'),
        conditions: z.array(z.unknown()).default([]),
      })
      .parse(req.body ?? {});
    const result = await deps.store.previewSegment(
      req.auth!.orgId!,
      {
        matchType: body.matchType,
        conditions: body.conditions as Array<SegmentConditionRule | SegmentConditionGroup>,
      },
      deps.analyticsStore
    );
    res.json(result);
  });

  router.post('/segments', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createSegment) throw new AppError(501, 'NOT_SUPPORTED', 'Segments unavailable');
    const parsed = saveSegmentSchema.parse(req.body);
    const segment = await deps.store.createSegment(req.auth!.orgId!, {
      name: parsed.name,
      description: parsed.description,
      matchType: parsed.matchType,
      conditions: parsed.conditions as unknown as Array<SegmentConditionRule | SegmentConditionGroup>,
    });
    res.status(201).json({ segment });
  });

  router.patch('/segments/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateSegment) throw new AppError(501, 'NOT_SUPPORTED', 'Segments unavailable');
    const patch = saveSegmentSchema.partial().parse(req.body);
    const segment = await deps.store.updateSegment(req.auth!.orgId!, String(req.params.id ?? ''), {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.matchType !== undefined ? { matchType: patch.matchType } : {}),
      ...(patch.conditions !== undefined
        ? { conditions: patch.conditions as unknown as Array<SegmentConditionRule | SegmentConditionGroup> }
        : {}),
    });
    if (!segment) throw new AppError(404, 'NOT_FOUND', 'Segment not found');
    res.json({ segment });
  });

  router.delete('/segments/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteSegment) throw new AppError(501, 'NOT_SUPPORTED', 'Segments unavailable');
    if (!(await deps.store.deleteSegment(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Segment not found');
    }
    res.status(204).send();
  });

  // =========================================================================
  // 4. Email Sequences
  // =========================================================================
  router.get('/sequences', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const sequences = deps.store.listSequences ? await deps.store.listSequences(req.auth!.orgId!) : [];
    res.json({ sequences });
  });

  router.post('/sequences', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createSequence) throw new AppError(501, 'NOT_SUPPORTED', 'Sequences unavailable');
    const body = z
      .object({
        name: z.string().min(2).max(120),
        description: z.string().max(300).default(''),
        domainId: z.string().nullable().default(null),
        fromName: z.string().max(120).default(''),
        fromEmail: z.string().nullable().default(null),
        replyTo: z.string().nullable().default(null),
        enabled: z.boolean().default(false),
        allowReentry: z.boolean().default(false),
        exitOnUnsubscribe: z.boolean().default(true),
        steps: z.array(z.any()).default([]),
      })
      .parse(req.body);
    const sequence = await deps.store.createSequence(req.auth!.orgId!, body as Partial<EmailSequenceItem> & { name: string });
    res.status(201).json({ sequence });
  });

  router.patch('/sequences/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateSequence) throw new AppError(501, 'NOT_SUPPORTED', 'Sequences unavailable');
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(300).optional(),
        domainId: z.string().nullable().optional(),
        fromName: z.string().max(120).optional(),
        fromEmail: z.string().nullable().optional(),
        replyTo: z.string().nullable().optional(),
        enabled: z.boolean().optional(),
        allowReentry: z.boolean().optional(),
        exitOnUnsubscribe: z.boolean().optional(),
        steps: z.array(z.any()).optional(),
      })
      .parse(req.body);
    const sequence = await deps.store.updateSequence(req.auth!.orgId!, String(req.params.id ?? ''), body as Partial<EmailSequenceItem>);
    if (!sequence) throw new AppError(404, 'NOT_FOUND', 'Sequence not found');
    res.json({ sequence });
  });

  router.delete('/sequences/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteSequence) throw new AppError(501, 'NOT_SUPPORTED', 'Sequences unavailable');
    if (!(await deps.store.deleteSequence(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Sequence not found');
    }
    res.status(204).send();
  });

  router.post('/sequences/:id/enroll', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.enrollInSequence) throw new AppError(501, 'NOT_SUPPORTED', 'Sequences unavailable');
    const body = z.object({ subscriberId: z.string().min(1) }).parse(req.body);
    const enrollment = await deps.store.enrollInSequence(req.auth!.orgId!, String(req.params.id ?? ''), body.subscriberId);
    res.status(201).json({ enrollment });
  });

  router.get('/sequences/:id/enrollments', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const enrollments = deps.store.listSequenceEnrollments
      ? await deps.store.listSequenceEnrollments(req.auth!.orgId!, String(req.params.id ?? ''))
      : [];
    res.json({ enrollments });
  });

  // =========================================================================
  // 5. Visual Automations
  // =========================================================================
  router.get('/automations', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const automations = deps.store.listAutomations ? await deps.store.listAutomations(req.auth!.orgId!) : [];
    res.json({ automations });
  });

  router.post('/automations', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createAutomation) throw new AppError(501, 'NOT_SUPPORTED', 'Automations unavailable');
    const body = z
      .object({
        name: z.string().min(2).max(120),
        description: z.string().max(300).default(''),
        triggerType: z.enum(['tag_added', 'segment_joined', 'form_submitted', 'landing_page_signup', 'api_event']),
        triggerConfig: z.record(z.string(), z.unknown()).default({}),
        nodes: z.array(z.any()).default([]),
        edges: z.array(z.any()).default([]),
      })
      .parse(req.body);
    const automation = await deps.store.createAutomation(req.auth!.orgId!, body as Parameters<NonNullable<MarketingStore['createAutomation']>>[1]);
    res.status(201).json({ automation });
  });

  router.patch('/automations/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateAutomation) throw new AppError(501, 'NOT_SUPPORTED', 'Automations unavailable');
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(300).optional(),
        status: z.enum(['draft', 'published', 'paused']).optional(),
        triggerType: z.enum(['tag_added', 'segment_joined', 'form_submitted', 'landing_page_signup', 'api_event']).optional(),
        triggerConfig: z.record(z.string(), z.unknown()).optional(),
        nodes: z.array(z.any()).optional(),
        edges: z.array(z.any()).optional(),
      })
      .parse(req.body);
    const automation = await deps.store.updateAutomation(req.auth!.orgId!, String(req.params.id ?? ''), body as Partial<AutomationItem>);
    if (!automation) throw new AppError(404, 'NOT_FOUND', 'Automation not found');
    res.json({ automation });
  });

  router.delete('/automations/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteAutomation) throw new AppError(501, 'NOT_SUPPORTED', 'Automations unavailable');
    if (!(await deps.store.deleteAutomation(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Automation not found');
    }
    res.status(204).send();
  });

  router.get('/automations/runs', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const automationId = typeof req.query.automationId === 'string' ? req.query.automationId : undefined;
    const runs = deps.store.listAutomationRuns ? await deps.store.listAutomationRuns(req.auth!.orgId!, automationId) : [];
    res.json({ runs });
  });

  router.post('/automations/:id/trigger', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.runSpecificAutomation) throw new AppError(501, 'NOT_SUPPORTED', 'Automation execution unavailable');
    const body = z.object({ subscriberId: z.string().min(1), context: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    const run = await deps.store.runSpecificAutomation(req.auth!.orgId!, String(req.params.id ?? ''), body.subscriberId, body.context);
    if (!run) throw new AppError(404, 'NOT_FOUND', 'Automation or subscriber not found');
    res.status(201).json({ run });
  });

  // =========================================================================
  // 6. Growth: Forms & Landing Pages (Authenticated + Public)
  // =========================================================================
  router.get('/forms', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const forms = deps.store.listForms ? await deps.store.listForms(req.auth!.orgId!) : [];
    res.json({ forms });
  });

  router.post('/forms', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createForm) throw new AppError(501, 'NOT_SUPPORTED', 'Forms unavailable');
    const body = z
      .object({
        name: z.string().min(2).max(120),
        formType: z.enum(['inline', 'popup', 'embedded']).default('inline'),
        title: z.string().max(200).default('Join our newsletter'),
        description: z.string().max(500).default(''),
        buttonText: z.string().max(60).default('Subscribe'),
        successMessage: z.string().max(300).default('Thanks for subscribing!'),
        redirectUrl: z.string().url().nullable().default(null),
        consentText: z.string().max(300).default('I agree to receive email updates.'),
        doubleOptIn: z.boolean().default(false),
        fields: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean() })).default([]),
        tagIds: z.array(z.string()).default([]),
        published: z.boolean().default(true),
      })
      .parse(req.body);
    const form = await deps.store.createForm(req.auth!.orgId!, body);
    res.status(201).json({ form });
  });

  router.patch('/forms/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateForm) throw new AppError(501, 'NOT_SUPPORTED', 'Forms unavailable');
    const body = z
      .object({
        name: z.string().min(2).max(120).optional(),
        formType: z.enum(['inline', 'popup', 'embedded']).optional(),
        title: z.string().max(200).optional(),
        description: z.string().max(500).optional(),
        buttonText: z.string().max(60).optional(),
        successMessage: z.string().max(300).optional(),
        redirectUrl: z.string().url().nullable().optional(),
        consentText: z.string().max(300).optional(),
        doubleOptIn: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
        published: z.boolean().optional(),
      })
      .parse(req.body);
    const form = await deps.store.updateForm(req.auth!.orgId!, String(req.params.id ?? ''), body as Record<string, unknown>);
    if (!form) throw new AppError(404, 'NOT_FOUND', 'Form not found');
    res.json({ form });
  });

  router.delete('/forms/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteForm) throw new AppError(501, 'NOT_SUPPORTED', 'Forms unavailable');
    if (!(await deps.store.deleteForm(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Form not found');
    }
    res.status(204).send();
  });

  router.get('/landing-pages', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const landingPages = deps.store.listLandingPages ? await deps.store.listLandingPages(req.auth!.orgId!) : [];
    res.json({ landingPages });
  });

  router.post('/landing-pages', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.createLandingPage) throw new AppError(501, 'NOT_SUPPORTED', 'Landing pages unavailable');
    const body = z
      .object({
        slug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9-]+$/, 'Slug must be alphanumeric with hyphens'),
        title: z.string().min(2).max(140),
        headline: z.string().min(2).max(200),
        subheadline: z.string().max(400).default(''),
        bodyHtml: z.string().max(200_000).default(''),
        heroImageUrl: z.string().url().nullable().default(null),
        templateKey: z.string().default('minimal'),
        buttonText: z.string().max(60).default('Get Updates'),
        customDomain: z.string().nullable().default(null),
        formId: z.string().nullable().default(null),
        tagIds: z.array(z.string()).default([]),
        published: z.boolean().default(false),
      })
      .parse(req.body);
    const landingPage = await deps.store.createLandingPage(req.auth!.orgId!, body);
    res.status(201).json({ landingPage });
  });

  router.patch('/landing-pages/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateLandingPage) throw new AppError(501, 'NOT_SUPPORTED', 'Landing pages unavailable');
    const body = z
      .object({
        title: z.string().min(2).max(140).optional(),
        headline: z.string().min(2).max(200).optional(),
        subheadline: z.string().max(400).optional(),
        bodyHtml: z.string().max(200_000).optional(),
        heroImageUrl: z.string().url().nullable().optional(),
        buttonText: z.string().max(60).optional(),
        customDomain: z.string().nullable().optional(),
        formId: z.string().nullable().optional(),
        tagIds: z.array(z.string()).optional(),
        published: z.boolean().optional(),
      })
      .parse(req.body);
    const landingPage = await deps.store.updateLandingPage(req.auth!.orgId!, String(req.params.id ?? ''), body as Record<string, unknown>);
    if (!landingPage) throw new AppError(404, 'NOT_FOUND', 'Landing page not found');
    res.json({ landingPage });
  });

  router.delete('/landing-pages/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteLandingPage) throw new AppError(501, 'NOT_SUPPORTED', 'Landing pages unavailable');
    if (!(await deps.store.deleteLandingPage(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Landing page not found');
    }
    res.status(204).send();
  });

  // Public unauthenticated form & landing page endpoints
  router.get('/public/forms/:formId', async (req, res) => {
    if (!deps.store.getPublicForm) throw new AppError(404, 'NOT_FOUND', 'Form not found');
    const form = await deps.store.getPublicForm(String(req.params.formId ?? ''));
    if (!form) throw new AppError(404, 'NOT_FOUND', 'Form not found');
    res.json({ form });
  });

  router.post('/public/forms/:formId/submit', async (req, res) => {
    if (!deps.store.submitPublicForm) throw new AppError(404, 'NOT_FOUND', 'Form not found');
    const body = z
      .object({
        email: emailAddressSchema,
        firstName: z.string().max(120).optional(),
        lastName: z.string().max(120).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        consentAccepted: z.boolean().default(true),
      })
      .parse(req.body);
    if (!body.consentAccepted) throw new AppError(400, 'CONSENT_REQUIRED', 'Explicit consent is required');
    const result = await deps.store.submitPublicForm(String(req.params.formId ?? ''), {
      email: body.email,
      ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.attributes !== undefined ? { attributes: body.attributes } : {}),
    });
    res.status(201).json(result);
  });

  router.get('/public/pages/:slug', async (req, res) => {
    if (!deps.store.getPublicLandingPage) throw new AppError(404, 'NOT_FOUND', 'Page not found');
    const page = await deps.store.getPublicLandingPage(String(req.params.slug ?? ''));
    if (!page) throw new AppError(404, 'NOT_FOUND', 'Landing page not found');
    res.json({ landingPage: page });
  });

  return router;
}
