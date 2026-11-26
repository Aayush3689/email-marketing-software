import { randomUUID } from 'node:crypto';
import type {
  AudienceEstimate,
  AudienceSelectionSpec,
  AutomationEdge,
  AutomationItem,
  AutomationNode,
  AutomationRunItem,
  BroadcastAnalyticsSummary,
  ContactImportJobItem,
  CustomFieldDef,
  EmailEventType,
  EmailSequenceItem,
  EmailTemplateBlock,
  GrowthFormItem,
  LandingPageItem,
  SegmentConditionGroup,
  SegmentConditionRule,
  SegmentItem,
  SequenceEnrollmentItem,
  SequenceStepItem,
  SubscriberRecord,
  SubscriberStatus,
  SuppressionReason,
  TagItem,
} from '@mail/shared-types';
import { audienceSelectionSchema, emailAddressSchema } from '@mail/validation';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireOrgRole } from '../auth/security.js';
import { AppError } from '../middleware/error-handler.js';
import {
  type ActivityLookup,
  compileBlocksToHtmlAndText,
  evaluateSegmentForSubscriber,
  htmlToPlainText,
  parseCsvMatrix,
  renderPersonalizedContent,
  sanitizeMarketingHtml,
} from '../services/marketing-engine.js';
import type { AnalyticsStore } from './analytics.js';
import type { DomainStore } from './domains.js';

export interface TemplateVersionRecord {
  versionNumber: number;
  subject: string;
  previewText?: string | undefined;
  htmlBody: string;
  textBody: string;
  blocksJson?: EmailTemplateBlock[] | undefined;
  createdAt: string;
}

export interface TemplateRecord {
  id: string;
  organizationId: string;
  name: string;
  category: string;
  description?: string | undefined;
  activeVersion: number;
  archivedAt?: string | null | undefined;
  versions: TemplateVersionRecord[];
  createdAt: string;
  updatedAt?: string | undefined;
}

export type ContactRecord = SubscriberRecord;

export interface CampaignRecord {
  id: string;
  organizationId: string;
  domainId: string;
  templateId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  fromName?: string | undefined;
  fromEmail?: string | null | undefined;
  replyTo?: string | null | undefined;
  subject?: string | null | undefined;
  previewText?: string | undefined;
  htmlBody?: string | null | undefined;
  textBody?: string | null | undefined;
  blocksJson?: EmailTemplateBlock[] | undefined;
  audienceSpec?: AudienceSelectionSpec | undefined;
  timezone: string;
  scheduledAt: string | null;
  tagFilter: string | null;
  targetCount: number;
  sentCount: number;
  dispatchedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  failureReason?: string | null | undefined;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface SuppressionRecord {
  id: string;
  organizationId: string;
  email: string;
  reason: SuppressionReason;
  source?: string | null | undefined;
  relatedCampaignId?: string | null | undefined;
  status?: string | undefined;
  createdAt: string;
}

export interface SubscriberQueryParams {
  search?: string | undefined;
  status?: SubscriberStatus | undefined;
  tag?: string | undefined;
  tagId?: string | undefined;
  segmentId?: string | undefined;
  source?: string | undefined;
  customFieldKey?: string | undefined;
  customFieldValue?: string | undefined;
  sort?: 'recent' | 'oldest' | 'engagement' | 'email' | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface SubscriberProfileData {
  subscriber: SubscriberRecord;
  events: Array<{ id: string; eventType: string; source: string | null; detail: unknown; createdAt: string }>;
  deliveries: Array<{ messageId: string; subject: string; state: string; createdAt: string }>;
  emailActivity: Array<{ id: string; eventType: EmailEventType; detail: string | null; createdAt: string }>;
  enrollments: SequenceEnrollmentItem[];
  automationRuns: AutomationRunItem[];
  suppression: SuppressionRecord | null;
}

export interface MarketingStore {
  listTemplates(orgId: string, includeArchived?: boolean): Promise<TemplateRecord[]> | TemplateRecord[];
  createTemplate(input: {
    organizationId: string;
    name: string;
    category: string;
    description?: string | undefined;
    subject: string;
    previewText?: string | undefined;
    htmlBody: string;
    textBody: string;
    blocksJson?: EmailTemplateBlock[] | undefined;
  }): Promise<TemplateRecord> | TemplateRecord;
  updateTemplate?(
    orgId: string,
    id: string,
    patch: {
      name?: string | undefined;
      category?: string | undefined;
      description?: string | undefined;
      archived?: boolean | undefined;
      subject?: string | undefined;
      previewText?: string | undefined;
      htmlBody?: string | undefined;
      textBody?: string | undefined;
      blocksJson?: EmailTemplateBlock[] | undefined;
    }
  ): Promise<TemplateRecord | null> | TemplateRecord | null;
  duplicateTemplate(orgId: string, id: string): Promise<TemplateRecord | null> | TemplateRecord | null;
  deleteTemplate?(orgId: string, id: string): Promise<boolean> | boolean;

  listContacts(orgId: string, tag?: string): Promise<ContactRecord[]> | ContactRecord[];
  querySubscribers?(
    orgId: string,
    params: SubscriberQueryParams,
    analyticsStore?: AnalyticsStore
  ): Promise<{ subscribers: SubscriberRecord[]; total: number; page: number; pageSize: number }> | { subscribers: SubscriberRecord[]; total: number; page: number; pageSize: number };
  upsertSubscriber?(
    orgId: string,
    input: {
      email: string;
      firstName?: string;
      lastName?: string;
      status?: SubscriberStatus;
      tags?: string[];
      attributes?: Record<string, string | number | boolean | null>;
      consentSource: string;
      consentedAt?: string;
    }
  ): Promise<{ subscriber: SubscriberRecord; created: boolean }> | { subscriber: SubscriberRecord; created: boolean };
  getSubscriberProfile?(
    orgId: string,
    id: string,
    analyticsStore?: AnalyticsStore
  ): Promise<SubscriberProfileData | null> | SubscriberProfileData | null;
  updateSubscriber?(
    orgId: string,
    id: string,
    patch: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      addTags?: string[] | undefined;
      removeTags?: string[] | undefined;
    }
  ): Promise<SubscriberRecord | null> | SubscriberRecord | null;
  unsubscribeSubscriber?(orgId: string, id: string, reason?: string): Promise<SubscriberRecord | null> | SubscriberRecord | null;
  resubscribeSubscriber?(orgId: string, id: string, consentSource: string): Promise<SubscriberRecord | null> | SubscriberRecord | null;
  deleteSubscriber?(orgId: string, id: string): Promise<boolean> | boolean;
  bulkSubscribersAction?(
    orgId: string,
    ids: string[],
    action: 'add_tag' | 'remove_tag' | 'unsubscribe' | 'delete',
    tagName?: string
  ): Promise<{ affected: number }> | { affected: number };

  importContacts(
    orgId: string,
    rows: Array<{
      email: string;
      firstName?: string | undefined;
      lastName?: string | undefined;
      tags?: string[] | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      consentSource: string;
    }>
  ): Promise<{ imported: number; updated?: number; skippedSuppressed: number }> | { imported: number; updated?: number; skippedSuppressed: number };

  createImportJob?(
    orgId: string,
    input: {
      fileName: string | null;
      consentSource: string;
      defaultTags: string[];
      fieldMapping: Record<string, string>;
      csvText: string;
    }
  ): Promise<ContactImportJobItem> | ContactImportJobItem;
  getImportJob?(orgId: string, jobId: string): Promise<ContactImportJobItem | null> | ContactImportJobItem | null;
  listImportJobs?(orgId: string): Promise<ContactImportJobItem[]> | ContactImportJobItem[];

  listTags?(orgId: string): Promise<TagItem[]> | TagItem[];
  createTag?(orgId: string, input: { name: string; description?: string; color?: string }): Promise<TagItem> | TagItem;
  updateTag?(orgId: string, id: string, patch: { name?: string | undefined; description?: string | undefined; color?: string | undefined }): Promise<TagItem | null> | TagItem | null;
  deleteTag?(orgId: string, id: string): Promise<boolean> | boolean;

  listCustomFields?(orgId: string): Promise<CustomFieldDef[]> | CustomFieldDef[];
  createCustomField?(orgId: string, input: { fieldKey: string; label: string; fieldType: 'text' | 'number' | 'date' | 'boolean'; description?: string }): Promise<CustomFieldDef> | CustomFieldDef;
  deleteCustomField?(orgId: string, id: string): Promise<boolean> | boolean;

  listSegments?(orgId: string, analyticsStore?: AnalyticsStore): Promise<SegmentItem[]> | SegmentItem[];
  createSegment?(orgId: string, input: { name: string; description?: string; matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }): Promise<SegmentItem> | SegmentItem;
  updateSegment?(orgId: string, id: string, patch: { name?: string | undefined; description?: string | undefined; matchType?: 'all' | 'any' | undefined; conditions?: Array<SegmentConditionRule | SegmentConditionGroup> | undefined }): Promise<SegmentItem | null> | SegmentItem | null;
  deleteSegment?(orgId: string, id: string): Promise<boolean> | boolean;
  previewSegment?(orgId: string, input: { matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }, analyticsStore?: AnalyticsStore): Promise<{ count: number; sample: SubscriberRecord[] }> | { count: number; sample: SubscriberRecord[] };

  listCampaigns(orgId: string): Promise<CampaignRecord[]> | CampaignRecord[];
  createCampaign(input: {
    organizationId: string;
    domainId: string;
    templateId: string;
    name: string;
    fromName?: string | undefined;
    fromEmail?: string | null | undefined;
    replyTo?: string | null | undefined;
    subject?: string | null | undefined;
    previewText?: string | undefined;
    htmlBody?: string | null | undefined;
    textBody?: string | null | undefined;
    blocksJson?: EmailTemplateBlock[] | undefined;
    audienceSpec?: AudienceSelectionSpec | undefined;
    timezone: string;
    scheduledAt: string | null;
    tagFilter: string | null;
  }): Promise<CampaignRecord> | CampaignRecord;
  updateCampaign?(
    orgId: string,
    id: string,
    patch: Partial<{
      domainId: string;
      templateId: string;
      name: string;
      fromName: string;
      fromEmail: string | null;
      replyTo: string | null;
      subject: string | null;
      previewText: string;
      htmlBody: string | null;
      textBody: string | null;
      blocksJson: EmailTemplateBlock[];
      audienceSpec: AudienceSelectionSpec;
      timezone: string;
      scheduledAt: string | null;
      status: CampaignRecord['status'];
      expectedUpdatedAt?: string | undefined;
    }>
  ): Promise<CampaignRecord | null> | CampaignRecord | null;
  duplicateCampaign?(orgId: string, id: string): Promise<CampaignRecord | null> | CampaignRecord | null;
  deleteCampaign?(orgId: string, id: string): Promise<boolean> | boolean;
  transitionCampaign(orgId: string, id: string, status: CampaignRecord['status']): Promise<CampaignRecord | null> | CampaignRecord | null;
  markCampaignDispatched?(orgId: string, id: string, sentCount: number, failedReason?: string): Promise<CampaignRecord | null> | CampaignRecord | null;
  estimateBroadcastAudience?(orgId: string, spec: AudienceSelectionSpec, analyticsStore?: AnalyticsStore): Promise<{ estimate: AudienceEstimate; eligible: SubscriberRecord[] }> | { estimate: AudienceEstimate; eligible: SubscriberRecord[] };
  snapshotCampaignRecipients?(orgId: string, campaignId: string, eligible: SubscriberRecord[]): Promise<void> | void;
  markCampaignRecipientStatus?(campaignId: string, recipientEmail: string, status: 'pending' | 'queued' | 'sent' | 'cancelled' | 'failed', messageId?: string): Promise<void> | void;
  cancelBroadcastRecipients?(orgId: string, campaignId: string): Promise<{ cancelledCount: number; handedOffCount: number }> | { cancelledCount: number; handedOffCount: number };
  getBroadcastAnalytics?(orgId: string, campaignId: string, analyticsStore?: AnalyticsStore): Promise<BroadcastAnalyticsSummary | null> | BroadcastAnalyticsSummary | null;
  listDueScheduledCampaigns?(): Promise<CampaignRecord[]> | CampaignRecord[];

  listSuppressions(orgId: string): Promise<SuppressionRecord[]> | SuppressionRecord[];
  addSuppression(
    orgId: string,
    email: string,
    reason: SuppressionReason,
    opts?: { source?: string; relatedCampaignId?: string }
  ): Promise<SuppressionRecord> | SuppressionRecord;
  removeSuppression(orgId: string, id: string): Promise<boolean> | boolean;

  listSequences?(orgId: string): Promise<EmailSequenceItem[]> | EmailSequenceItem[];
  createSequence?(orgId: string, input: Partial<EmailSequenceItem> & { name: string }): Promise<EmailSequenceItem> | EmailSequenceItem;
  updateSequence?(orgId: string, id: string, patch: Partial<EmailSequenceItem> & { steps?: Array<Partial<SequenceStepItem> & { subject: string }> }): Promise<EmailSequenceItem | null> | EmailSequenceItem | null;
  deleteSequence?(orgId: string, id: string): Promise<boolean> | boolean;
  enrollInSequence?(orgId: string, sequenceId: string, subscriberId: string): Promise<SequenceEnrollmentItem> | SequenceEnrollmentItem;
  listSequenceEnrollments?(orgId: string, sequenceId: string): Promise<SequenceEnrollmentItem[]> | SequenceEnrollmentItem[];

  listAutomations?(orgId: string): Promise<AutomationItem[]> | AutomationItem[];
  createAutomation?(orgId: string, input: { name: string; description?: string; triggerType: AutomationItem['triggerType']; triggerConfig?: Record<string, unknown>; nodes?: AutomationNode[]; edges?: AutomationEdge[] }): Promise<AutomationItem> | AutomationItem;
  updateAutomation?(orgId: string, id: string, patch: Partial<AutomationItem>): Promise<AutomationItem | null> | AutomationItem | null;
  deleteAutomation?(orgId: string, id: string): Promise<boolean> | boolean;
  listAutomationRuns?(orgId: string, automationId?: string): Promise<AutomationRunItem[]> | AutomationRunItem[];
  triggerAutomationForSubscriber?(orgId: string, triggerType: AutomationItem['triggerType'], subscriberId: string, context?: Record<string, unknown>): Promise<number> | number;
  runSpecificAutomation?(orgId: string, automationId: string, subscriberId: string, context?: Record<string, unknown>): Promise<AutomationRunItem | null> | AutomationRunItem | null;

  listForms?(orgId: string): Promise<GrowthFormItem[]> | GrowthFormItem[];
  createForm?(orgId: string, input: Partial<GrowthFormItem> & { name: string }): Promise<GrowthFormItem> | GrowthFormItem;
  updateForm?(orgId: string, id: string, patch: Partial<GrowthFormItem>): Promise<GrowthFormItem | null> | GrowthFormItem | null;
  deleteForm?(orgId: string, id: string): Promise<boolean> | boolean;
  getPublicForm?(formId: string): Promise<GrowthFormItem | null> | GrowthFormItem | null;
  submitPublicForm?(formId: string, payload: { email: string; firstName?: string; lastName?: string; attributes?: Record<string, string>; landingPageId?: string }): Promise<{ subscriber: SubscriberRecord; doubleOptIn: boolean; confirmToken?: string; successMessage: string; redirectUrl: string | null }> | { subscriber: SubscriberRecord; doubleOptIn: boolean; confirmToken?: string; successMessage: string; redirectUrl: string | null };

  listLandingPages?(orgId: string): Promise<LandingPageItem[]> | LandingPageItem[];
  createLandingPage?(orgId: string, input: Partial<LandingPageItem> & { slug: string; title: string; headline: string }): Promise<LandingPageItem> | LandingPageItem;
  updateLandingPage?(orgId: string, id: string, patch: Partial<LandingPageItem>): Promise<LandingPageItem | null> | LandingPageItem | null;
  deleteLandingPage?(orgId: string, id: string): Promise<boolean> | boolean;
  getPublicLandingPage?(slug: string): Promise<LandingPageItem | null> | LandingPageItem | null;
}

export class InMemoryMarketingStore implements MarketingStore {
  private readonly templates = new Map<string, TemplateRecord>();
  private readonly contacts = new Map<string, SubscriberRecord>();
  private readonly tags = new Map<string, TagItem>();
  private readonly customFields = new Map<string, CustomFieldDef>();
  private readonly segments = new Map<string, SegmentItem>();
  private readonly importJobs = new Map<string, ContactImportJobItem>();
  private readonly campaigns = new Map<string, CampaignRecord>();
  private readonly campaignRecipients = new Map<string, Array<{ recipientEmail: string; subscriberId: string | null; status: string; messageId?: string }>>();
  private readonly suppressions = new Map<string, SuppressionRecord>();
  private readonly subscriberEvents = new Map<string, Array<{ id: string; eventType: string; source: string | null; detail: unknown; createdAt: string }>>();
  private readonly sequences = new Map<string, EmailSequenceItem>();
  private readonly enrollments = new Map<string, SequenceEnrollmentItem>();
  private readonly automations = new Map<string, AutomationItem>();
  private readonly automationRuns = new Map<string, AutomationRunItem>();
  private readonly forms = new Map<string, GrowthFormItem>();
  private readonly landingPages = new Map<string, LandingPageItem>();
  private readonly optInTokens = new Map<string, { orgId: string; subscriberId: string }>();

  private syncTagsForOrg(orgId: string, names: string[]): void {
    const now = new Date().toISOString();
    for (const raw of names) {
      const clean = raw.trim();
      if (!clean) continue;
      const existing = [...this.tags.values()].find(
        (t) => t.organizationId === orgId && t.name.toLowerCase() === clean.toLowerCase()
      );
      if (!existing) {
        const id = randomUUID();
        this.tags.set(id, {
          id,
          organizationId: orgId,
          name: clean,
          description: '',
          color: '#2563eb',
          subscriberCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  private pushSubEvent(subId: string, eventType: string, source: string | null, detail: unknown = {}): void {
    const arr = this.subscriberEvents.get(subId) ?? [];
    arr.unshift({ id: randomUUID(), eventType, source, detail, createdAt: new Date().toISOString() });
    this.subscriberEvents.set(subId, arr.slice(0, 100));
  }

  private async buildActivityLookup(orgId: string, analyticsStore?: AnalyticsStore): Promise<ActivityLookup> {
    const openedCampaignIdsByEmail = new Map<string, Set<string>>();
    const clickedEmails = new Set<string>();
    const openedAnyEmails = new Set<string>();
    const lastEngagedByEmail = new Map<string, Date>();
    if (analyticsStore) {
      const evs = await analyticsStore.queryEvents(orgId, { range: '30d' });
      for (const e of evs) {
        const em = e.recipientEmail.toLowerCase();
        if (e.eventType === 'opened') {
          openedAnyEmails.add(em);
          if (e.campaignId) {
            const set = openedCampaignIdsByEmail.get(em) ?? new Set<string>();
            set.add(e.campaignId);
            openedCampaignIdsByEmail.set(em, set);
          }
          const d = new Date(e.createdAt);
          if (!lastEngagedByEmail.has(em) || lastEngagedByEmail.get(em)! < d) lastEngagedByEmail.set(em, d);
        } else if (e.eventType === 'clicked') {
          clickedEmails.add(em);
          const d = new Date(e.createdAt);
          if (!lastEngagedByEmail.has(em) || lastEngagedByEmail.get(em)! < d) lastEngagedByEmail.set(em, d);
        }
      }
    }
    return { openedCampaignIdsByEmail, clickedEmails, openedAnyEmails, lastEngagedByEmail };
  }

  listTemplates(orgId: string, includeArchived = false): TemplateRecord[] {
    return [...this.templates.values()].filter(
      (t) => t.organizationId === orgId && (includeArchived || !t.archivedAt)
    );
  }

  createTemplate(input: {
    organizationId: string;
    name: string;
    category: string;
    description?: string | undefined;
    subject: string;
    previewText?: string | undefined;
    htmlBody: string;
    textBody: string;
    blocksJson?: EmailTemplateBlock[] | undefined;
  }): TemplateRecord {
    const now = new Date().toISOString();
    const compiled =
      input.blocksJson && input.blocksJson.length > 0 && !input.htmlBody
        ? compileBlocksToHtmlAndText(input.blocksJson, { subject: input.subject, previewText: input.previewText ?? '' })
        : {
            htmlBody: sanitizeMarketingHtml(input.htmlBody),
            textBody: input.textBody || htmlToPlainText(input.htmlBody),
          };
    const rec: TemplateRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      category: input.category,
      description: input.description ?? '',
      activeVersion: 1,
      archivedAt: null,
      versions: [
        {
          versionNumber: 1,
          subject: input.subject,
          previewText: input.previewText ?? '',
          htmlBody: compiled.htmlBody,
          textBody: compiled.textBody,
          blocksJson: input.blocksJson ?? [],
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(rec.id, rec);
    return rec;
  }

  updateTemplate(
    orgId: string,
    id: string,
    patch: {
      name?: string | undefined;
      category?: string | undefined;
      description?: string | undefined;
      archived?: boolean | undefined;
      subject?: string | undefined;
      previewText?: string | undefined;
      htmlBody?: string | undefined;
      textBody?: string | undefined;
      blocksJson?: EmailTemplateBlock[] | undefined;
    }
  ): TemplateRecord | null {
    const tpl = this.templates.get(id);
    if (!tpl || tpl.organizationId !== orgId) return null;
    const now = new Date().toISOString();
    if (patch.name !== undefined) tpl.name = patch.name;
    if (patch.category !== undefined) tpl.category = patch.category;
    if (patch.description !== undefined) tpl.description = patch.description;
    if (patch.archived !== undefined) tpl.archivedAt = patch.archived ? now : null;
    if (patch.subject !== undefined || patch.htmlBody !== undefined || patch.textBody !== undefined || patch.blocksJson !== undefined) {
      const latest = tpl.versions[tpl.versions.length - 1]!;
      const nextNum = latest.versionNumber + 1;
      const html = patch.htmlBody !== undefined ? sanitizeMarketingHtml(patch.htmlBody) : latest.htmlBody;
      const text = patch.textBody !== undefined ? patch.textBody : htmlToPlainText(html);
      tpl.versions.push({
        versionNumber: nextNum,
        subject: patch.subject ?? latest.subject,
        previewText: patch.previewText ?? latest.previewText ?? '',
        htmlBody: html,
        textBody: text,
        blocksJson: patch.blocksJson ?? latest.blocksJson ?? [],
        createdAt: now,
      });
      tpl.activeVersion = nextNum;
    }
    tpl.updatedAt = now;
    return tpl;
  }

  duplicateTemplate(orgId: string, id: string): TemplateRecord | null {
    const orig = this.templates.get(id);
    if (!orig || orig.organizationId !== orgId) return null;
    const latest = orig.versions[orig.versions.length - 1]!;
    return this.createTemplate({
      organizationId: orgId,
      name: `${orig.name} (Copy)`,
      category: orig.category,
      description: orig.description ?? '',
      subject: latest.subject,
      previewText: latest.previewText ?? '',
      htmlBody: latest.htmlBody,
      textBody: latest.textBody,
      blocksJson: latest.blocksJson ?? [],
    });
  }

  deleteTemplate(orgId: string, id: string): boolean {
    const tpl = this.templates.get(id);
    if (!tpl || tpl.organizationId !== orgId) return false;
    return this.templates.delete(id);
  }

  listContacts(orgId: string, tag?: string): SubscriberRecord[] {
    return [...this.contacts.values()].filter(
      (c) => c.organizationId === orgId && (!tag || c.tags.includes(tag))
    );
  }

  async querySubscribers(orgId: string, params: SubscriberQueryParams, analyticsStore?: AnalyticsStore) {
    let rows = [...this.contacts.values()].filter((c) => c.organizationId === orgId);
    if (params.search) {
      const q = params.search.trim().toLowerCase();
      rows = rows.filter(
        (c) =>
          c.email.toLowerCase().includes(q) ||
          c.firstName.toLowerCase().includes(q) ||
          c.lastName.toLowerCase().includes(q)
      );
    }
    if (params.status) rows = rows.filter((c) => c.status === params.status);
    if (params.tag) rows = rows.filter((c) => c.tags.some((t) => t.toLowerCase() === params.tag!.toLowerCase()));
    if (params.tagId) {
      const tag = this.tags.get(params.tagId);
      rows = tag ? rows.filter((c) => c.tags.some((t) => t.toLowerCase() === tag.name.toLowerCase())) : [];
    }
    if (params.source) rows = rows.filter((c) => c.consentSource.toLowerCase().includes(params.source!.toLowerCase()));
    if (params.customFieldKey) {
      const valFilter = params.customFieldValue?.toLowerCase();
      rows = rows.filter((c) => {
        const raw = c.attributes?.[params.customFieldKey!];
        if (raw === undefined || raw === null) return false;
        return valFilter ? String(raw).toLowerCase().includes(valFilter) : true;
      });
    }
    if (params.segmentId) {
      const seg = this.segments.get(params.segmentId);
      if (seg && seg.organizationId === orgId) {
        const act = await this.buildActivityLookup(orgId, analyticsStore);
        rows = rows.filter((c) => evaluateSegmentForSubscriber(seg.matchType, seg.conditions, c, act));
      } else {
        rows = [];
      }
    }
    if (params.sort === 'oldest') rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    else if (params.sort === 'engagement') rows.sort((a, b) => b.engagementScore - a.engagementScore);
    else if (params.sort === 'email') rows.sort((a, b) => a.email.localeCompare(b.email));
    else rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));
    return {
      subscribers: rows.slice((page - 1) * pageSize, page * pageSize),
      total: rows.length,
      page,
      pageSize,
    };
  }

  upsertSubscriber(
    orgId: string,
    input: {
      email: string;
      firstName?: string;
      lastName?: string;
      status?: SubscriberStatus;
      tags?: string[];
      attributes?: Record<string, string | number | boolean | null>;
      consentSource: string;
      consentedAt?: string;
    }
  ): { subscriber: SubscriberRecord; created: boolean } {
    const email = input.email.trim().toLowerCase();
    const now = new Date().toISOString();
    const cleanTags = [...new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    this.syncTagsForOrg(orgId, cleanTags);

    const suppressed = this.listSuppressions(orgId).find((s) => s.email === email);
    const existing = [...this.contacts.values()].find((c) => c.organizationId === orgId && c.email === email);
    if (existing) {
      if (input.firstName !== undefined && input.firstName !== '') existing.firstName = input.firstName;
      if (input.lastName !== undefined && input.lastName !== '') existing.lastName = input.lastName;
      existing.tags = [...new Set([...existing.tags, ...cleanTags])];
      existing.attributes = { ...existing.attributes, ...(input.attributes ?? {}) };
      existing.updatedAt = now;
      this.pushSubEvent(existing.id, 'subscriber_updated', input.consentSource, { tagsAdded: cleanTags });
      return { subscriber: existing, created: false };
    }
    const status: SubscriberStatus = suppressed ? 'unsubscribed' : input.status ?? 'subscribed';
    const rec: SubscriberRecord = {
      id: randomUUID(),
      organizationId: orgId,
      email,
      firstName: input.firstName ?? '',
      lastName: input.lastName ?? '',
      status,
      tags: cleanTags,
      attributes: input.attributes ?? {},
      consentSource: input.consentSource,
      consentedAt: input.consentedAt ?? now,
      unsubscribedAt: status === 'unsubscribed' ? now : null,
      lastActivityAt: null,
      engagementScore: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.contacts.set(rec.id, rec);
    this.pushSubEvent(rec.id, 'subscribed', input.consentSource, { tags: cleanTags });
    return { subscriber: rec, created: true };
  }

  async getSubscriberProfile(orgId: string, id: string, analyticsStore?: AnalyticsStore): Promise<SubscriberProfileData | null> {
    const sub = this.contacts.get(id);
    if (!sub || sub.organizationId !== orgId) return null;
    const allEvs = analyticsStore ? await analyticsStore.queryEvents(orgId, { range: '30d', recipient: sub.email }) : [];
    const suppression = this.listSuppressions(orgId).find((s) => s.email === sub.email.toLowerCase()) ?? null;
    const enrollments = [...this.enrollments.values()].filter((e) => e.subscriberId === id);
    const automationRuns = [...this.automationRuns.values()].filter((r) => r.subscriberId === id);
    return {
      subscriber: sub,
      events: this.subscriberEvents.get(id) ?? [],
      deliveries: [],
      emailActivity: allEvs.map((e) => ({ id: e.id, eventType: e.eventType, detail: e.detail, createdAt: e.createdAt })),
      enrollments,
      automationRuns,
      suppression,
    };
  }

  updateSubscriber(
    orgId: string,
    id: string,
    patch: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      addTags?: string[] | undefined;
      removeTags?: string[] | undefined;
    }
  ): SubscriberRecord | null {
    const sub = this.contacts.get(id);
    if (!sub || sub.organizationId !== orgId) return null;
    if (patch.firstName !== undefined) sub.firstName = patch.firstName;
    if (patch.lastName !== undefined) sub.lastName = patch.lastName;
    if (patch.attributes) sub.attributes = { ...sub.attributes, ...patch.attributes };
    if (patch.addTags?.length) {
      this.syncTagsForOrg(orgId, patch.addTags);
      sub.tags = [...new Set([...sub.tags, ...patch.addTags.map((t) => t.trim()).filter(Boolean)])];
      this.pushSubEvent(sub.id, 'tags_added', 'manual', { tags: patch.addTags });
    }
    if (patch.removeTags?.length) {
      const rem = new Set(patch.removeTags.map((t) => t.toLowerCase()));
      sub.tags = sub.tags.filter((t) => !rem.has(t.toLowerCase()));
      this.pushSubEvent(sub.id, 'tags_removed', 'manual', { tags: patch.removeTags });
    }
    sub.updatedAt = new Date().toISOString();
    return sub;
  }

  unsubscribeSubscriber(orgId: string, id: string, reason = 'manual_unsubscribe'): SubscriberRecord | null {
    const sub = this.contacts.get(id);
    if (!sub || sub.organizationId !== orgId) return null;
    sub.status = 'unsubscribed';
    sub.unsubscribedAt = new Date().toISOString();
    sub.updatedAt = sub.unsubscribedAt;
    this.addSuppression(orgId, sub.email, 'unsubscribe', { source: reason });
    this.pushSubEvent(sub.id, 'unsubscribed', reason);
    return sub;
  }

  resubscribeSubscriber(orgId: string, id: string, consentSource: string): SubscriberRecord | null {
    const sub = this.contacts.get(id);
    if (!sub || sub.organizationId !== orgId) return null;
    const now = new Date().toISOString();
    sub.status = 'subscribed';
    sub.unsubscribedAt = null;
    sub.consentSource = consentSource;
    sub.consentedAt = now;
    sub.updatedAt = now;
    for (const [sid, s] of this.suppressions.entries()) {
      if (s.organizationId === orgId && s.email === sub.email.toLowerCase()) {
        this.suppressions.delete(sid);
      }
    }
    this.pushSubEvent(sub.id, 'resubscribed', consentSource);
    return sub;
  }

  deleteSubscriber(orgId: string, id: string): boolean {
    const sub = this.contacts.get(id);
    if (!sub || sub.organizationId !== orgId) return false;
    return this.contacts.delete(id);
  }

  bulkSubscribersAction(
    orgId: string,
    ids: string[],
    action: 'add_tag' | 'remove_tag' | 'unsubscribe' | 'delete',
    tagName?: string
  ): { affected: number } {
    let affected = 0;
    for (const id of ids) {
      if (action === 'add_tag' && tagName && this.updateSubscriber(orgId, id, { addTags: [tagName] })) affected += 1;
      else if (action === 'remove_tag' && tagName && this.updateSubscriber(orgId, id, { removeTags: [tagName] })) affected += 1;
      else if (action === 'unsubscribe' && this.unsubscribeSubscriber(orgId, id, 'bulk_action')) affected += 1;
      else if (action === 'delete' && this.deleteSubscriber(orgId, id)) affected += 1;
    }
    return { affected };
  }

  importContacts(
    orgId: string,
    rows: Array<{
      email: string;
      firstName?: string | undefined;
      lastName?: string | undefined;
      tags?: string[] | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      consentSource: string;
    }>
  ): { imported: number; updated: number; skippedSuppressed: number } {
    let imported = 0;
    let updated = 0;
    let skippedSuppressed = 0;
    const suppressedSet = new Set(this.listSuppressions(orgId).map((s) => s.email.toLowerCase()));

    for (const row of rows) {
      const email = row.email.trim().toLowerCase();
      if (suppressedSet.has(email)) {
        skippedSuppressed += 1;
        continue;
      }
      const existing = [...this.contacts.values()].find((c) => c.organizationId === orgId && c.email === email);
      if (existing) {
        if (row.firstName) existing.firstName = row.firstName;
        if (row.lastName) existing.lastName = row.lastName;
        if (row.tags?.length) {
          this.syncTagsForOrg(orgId, row.tags);
          existing.tags = [...new Set([...existing.tags, ...row.tags])];
        }
        if (row.attributes) existing.attributes = { ...existing.attributes, ...row.attributes };
        updated += 1;
        continue;
      }
      const res = this.upsertSubscriber(orgId, {
        email,
        firstName: row.firstName ?? '',
        lastName: row.lastName ?? '',
        tags: row.tags ?? [],
        attributes: row.attributes ?? {},
        consentSource: row.consentSource,
      });
      if (res.created) imported += 1;
    }
    return { imported, updated, skippedSuppressed };
  }

  createImportJob(
    orgId: string,
    input: {
      fileName: string | null;
      consentSource: string;
      defaultTags: string[];
      fieldMapping: Record<string, string>;
      csvText: string;
    }
  ): ContactImportJobItem {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { headers, rows } = parseCsvMatrix(input.csvText);
    const errors: Array<{ row: number; email: string; reason: string }> = [];
    const seenInFile = new Set<string>();
    const suppressedSet = new Set(this.listSuppressions(orgId).map((s) => s.email.toLowerCase()));

    let importedCount = 0;
    let updatedCount = 0;
    let skippedDuplicates = 0;
    let invalidCount = 0;
    let suppressedCount = 0;
    let missingConsentCount = 0;

    if (!input.consentSource || input.consentSource.trim().length < 2) {
      missingConsentCount = rows.length;
      const failedJob: ContactImportJobItem = {
        id,
        organizationId: orgId,
        status: 'failed',
        fileName: input.fileName,
        consentSource: input.consentSource,
        totalRows: rows.length,
        importedCount: 0,
        updatedCount: 0,
        skippedDuplicates: 0,
        invalidCount: 0,
        suppressedCount: 0,
        missingConsentCount,
        failedCount: rows.length,
        errorReport: [{ row: 0, email: '', reason: 'Consent source is required' }],
        createdAt: now,
        completedAt: now,
      };
      this.importJobs.set(id, failedJob);
      return failedJob;
    }

    rows.forEach((cols, idx) => {
      const rowMap: Record<string, string> = {};
      headers.forEach((h, hIdx) => {
        const mapped = input.fieldMapping[h] ?? h.toLowerCase();
        rowMap[mapped] = cols[hIdx] ?? '';
      });
      const email = (rowMap.email ?? '').trim().toLowerCase();
      if (!email || !emailAddressSchema.safeParse(email).success) {
        invalidCount += 1;
        errors.push({ row: idx + 2, email: email || '(blank)', reason: 'Invalid email syntax' });
        return;
      }
      if (seenInFile.has(email)) {
        skippedDuplicates += 1;
        errors.push({ row: idx + 2, email, reason: 'Duplicate row in CSV' });
        return;
      }
      seenInFile.add(email);
      if (suppressedSet.has(email)) {
        suppressedCount += 1;
        errors.push({ row: idx + 2, email, reason: 'Suppressed address' });
        return;
      }
      const rowTags = (rowMap.tags ?? '')
        .split(/[|;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const mergedTags = [...new Set([...input.defaultTags, ...rowTags])];
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(rowMap)) {
        if (!['email', 'firstname', 'first_name', 'lastname', 'last_name', 'tags'].includes(k.toLowerCase()) && v) {
          attrs[k] = v;
        }
      }
      const res = this.upsertSubscriber(orgId, {
        email,
        firstName: rowMap.firstName ?? rowMap.firstname ?? rowMap.first_name ?? '',
        lastName: rowMap.lastName ?? rowMap.lastname ?? rowMap.last_name ?? '',
        tags: mergedTags,
        attributes: attrs,
        consentSource: input.consentSource,
      });
      if (res.created) importedCount += 1;
      else updatedCount += 1;
    });

    const job: ContactImportJobItem = {
      id,
      organizationId: orgId,
      status: 'completed',
      fileName: input.fileName,
      consentSource: input.consentSource,
      totalRows: rows.length,
      importedCount,
      updatedCount,
      skippedDuplicates,
      invalidCount,
      suppressedCount,
      missingConsentCount,
      failedCount: invalidCount + missingConsentCount,
      errorReport: errors,
      createdAt: now,
      completedAt: new Date().toISOString(),
    };
    this.importJobs.set(id, job);
    return job;
  }

  getImportJob(orgId: string, jobId: string): ContactImportJobItem | null {
    const j = this.importJobs.get(jobId);
    return j && j.organizationId === orgId ? j : null;
  }

  listImportJobs(orgId: string): ContactImportJobItem[] {
    return [...this.importJobs.values()]
      .filter((j) => j.organizationId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listTags(orgId: string): TagItem[] {
    const orgTags = [...this.tags.values()].filter((t) => t.organizationId === orgId);
    return orgTags.map((t) => ({
      ...t,
      subscriberCount: this.listContacts(orgId).filter((c) =>
        c.tags.some((n) => n.toLowerCase() === t.name.toLowerCase())
      ).length,
    }));
  }

  createTag(orgId: string, input: { name: string; description?: string; color?: string }): TagItem {
    const dup = [...this.tags.values()].find(
      (t) => t.organizationId === orgId && t.name.toLowerCase() === input.name.trim().toLowerCase()
    );
    if (dup) throw new AppError(409, 'TAG_EXISTS', `Tag "${input.name}" already exists`);
    const now = new Date().toISOString();
    const rec: TagItem = {
      id: randomUUID(),
      organizationId: orgId,
      name: input.name.trim(),
      description: input.description ?? '',
      color: input.color ?? '#2563eb',
      subscriberCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tags.set(rec.id, rec);
    return rec;
  }

  updateTag(orgId: string, id: string, patch: { name?: string | undefined; description?: string | undefined; color?: string | undefined }): TagItem | null {
    const tag = this.tags.get(id);
    if (!tag || tag.organizationId !== orgId) return null;
    const oldName = tag.name;
    if (patch.name !== undefined && patch.name.trim()) {
      tag.name = patch.name.trim();
      for (const c of this.contacts.values()) {
        if (c.organizationId === orgId) {
          c.tags = [...new Set(c.tags.map((t) => (t.toLowerCase() === oldName.toLowerCase() ? tag.name : t)))];
        }
      }
    }
    if (patch.description !== undefined) tag.description = patch.description;
    if (patch.color !== undefined) tag.color = patch.color;
    tag.updatedAt = new Date().toISOString();
    return tag;
  }

  deleteTag(orgId: string, id: string): boolean {
    const tag = this.tags.get(id);
    if (!tag || tag.organizationId !== orgId) return false;
    for (const c of this.contacts.values()) {
      if (c.organizationId === orgId) {
        c.tags = c.tags.filter((t) => t.toLowerCase() !== tag.name.toLowerCase());
      }
    }
    return this.tags.delete(id);
  }

  listCustomFields(orgId: string): CustomFieldDef[] {
    return [...this.customFields.values()].filter((f) => f.organizationId === orgId);
  }

  createCustomField(
    orgId: string,
    input: { fieldKey: string; label: string; fieldType: 'text' | 'number' | 'date' | 'boolean'; description?: string }
  ): CustomFieldDef {
    const dup = [...this.customFields.values()].find(
      (f) => f.organizationId === orgId && f.fieldKey === input.fieldKey
    );
    if (dup) throw new AppError(409, 'FIELD_EXISTS', `Custom field "${input.fieldKey}" already exists`);
    const rec: CustomFieldDef = {
      id: randomUUID(),
      organizationId: orgId,
      fieldKey: input.fieldKey,
      label: input.label,
      fieldType: input.fieldType,
      description: input.description ?? '',
      createdAt: new Date().toISOString(),
    };
    this.customFields.set(rec.id, rec);
    return rec;
  }

  deleteCustomField(orgId: string, id: string): boolean {
    const f = this.customFields.get(id);
    if (!f || f.organizationId !== orgId) return false;
    return this.customFields.delete(id);
  }

  async listSegments(orgId: string, analyticsStore?: AnalyticsStore): Promise<SegmentItem[]> {
    const act = await this.buildActivityLookup(orgId, analyticsStore);
    const subs = this.listContacts(orgId);
    return [...this.segments.values()]
      .filter((s) => s.organizationId === orgId)
      .map((s) => ({
        ...s,
        subscriberCount: subs.filter((c) => evaluateSegmentForSubscriber(s.matchType, s.conditions, c, act)).length,
      }));
  }

  createSegment(
    orgId: string,
    input: { name: string; description?: string; matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }
  ): SegmentItem {
    const now = new Date().toISOString();
    const rec: SegmentItem = {
      id: randomUUID(),
      organizationId: orgId,
      name: input.name,
      description: input.description ?? '',
      matchType: input.matchType,
      conditions: input.conditions,
      createdAt: now,
      updatedAt: now,
    };
    this.segments.set(rec.id, rec);
    return rec;
  }

  updateSegment(
    orgId: string,
    id: string,
    patch: { name?: string | undefined; description?: string | undefined; matchType?: 'all' | 'any' | undefined; conditions?: Array<SegmentConditionRule | SegmentConditionGroup> | undefined }
  ): SegmentItem | null {
    const seg = this.segments.get(id);
    if (!seg || seg.organizationId !== orgId) return null;
    if (patch.name !== undefined) seg.name = patch.name;
    if (patch.description !== undefined) seg.description = patch.description;
    if (patch.matchType !== undefined) seg.matchType = patch.matchType;
    if (patch.conditions !== undefined) seg.conditions = patch.conditions;
    seg.updatedAt = new Date().toISOString();
    return seg;
  }

  deleteSegment(orgId: string, id: string): boolean {
    const seg = this.segments.get(id);
    if (!seg || seg.organizationId !== orgId) return false;
    return this.segments.delete(id);
  }

  async previewSegment(
    orgId: string,
    input: { matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> },
    analyticsStore?: AnalyticsStore
  ): Promise<{ count: number; sample: SubscriberRecord[] }> {
    const act = await this.buildActivityLookup(orgId, analyticsStore);
    const matching = this.listContacts(orgId).filter((c) =>
      evaluateSegmentForSubscriber(input.matchType, input.conditions, c, act)
    );
    return { count: matching.length, sample: matching.slice(0, 15) };
  }

  listCampaigns(orgId: string): CampaignRecord[] {
    return [...this.campaigns.values()].filter((c) => c.organizationId === orgId);
  }

  async estimateBroadcastAudience(
    orgId: string,
    spec: AudienceSelectionSpec,
    analyticsStore?: AnalyticsStore
  ): Promise<{ estimate: AudienceEstimate; eligible: SubscriberRecord[] }> {
    const allSubs = this.listContacts(orgId);
    const suppressedSet = new Set(this.listSuppressions(orgId).map((s) => s.email.toLowerCase()));
    const act = await this.buildActivityLookup(orgId, analyticsStore);

    let candidateSet: SubscriberRecord[] = allSubs;
    if (spec.mode === 'filtered') {
      const incTags = new Set(
        [
          ...(spec.includeTags ?? []),
          ...(spec.includeTagIds ?? []).map((id) => this.tags.get(id)?.name ?? ''),
        ]
          .filter(Boolean)
          .map((t) => t.toLowerCase())
      );
      const incSegs = (spec.includeSegmentIds ?? [])
        .map((id) => this.segments.get(id))
        .filter((s): s is SegmentItem => Boolean(s && s.organizationId === orgId));
      const explicitIds = new Set(spec.subscriberIds ?? []);

      if (incTags.size > 0 || incSegs.length > 0 || explicitIds.size > 0) {
        candidateSet = allSubs.filter((c) => {
          if (explicitIds.has(c.id)) return true;
          if (c.tags.some((t) => incTags.has(t.toLowerCase()))) return true;
          if (incSegs.some((s) => evaluateSegmentForSubscriber(s.matchType, s.conditions, c, act))) return true;
          return false;
        });
      }
    }

    const excTags = new Set(
      [
        ...(spec.excludeTags ?? []),
        ...(spec.excludeTagIds ?? []).map((id) => this.tags.get(id)?.name ?? ''),
      ]
        .filter(Boolean)
        .map((t) => t.toLowerCase())
    );
    const excSegs = (spec.excludeSegmentIds ?? [])
      .map((id) => this.segments.get(id))
      .filter((s): s is SegmentItem => Boolean(s && s.organizationId === orgId));

    const excluded = { unsubscribed: 0, bounced: 0, complained: 0, suppressed: 0, invalidEmail: 0, excludedByRule: 0 };
    const eligible: SubscriberRecord[] = [];
    const seen = new Set<string>();

    for (const c of candidateSet) {
      const email = c.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      if (!emailAddressSchema.safeParse(email).success) {
        excluded.invalidEmail += 1;
        continue;
      }
      if (c.unsubscribedAt || c.status === 'unsubscribed' || c.status === 'pending_confirmation') {
        excluded.unsubscribed += 1;
        continue;
      }
      if (c.status === 'bounced') {
        excluded.bounced += 1;
        continue;
      }
      if (c.status === 'complained') {
        excluded.complained += 1;
        continue;
      }
      if (suppressedSet.has(email)) {
        excluded.suppressed += 1;
        continue;
      }
      if (
        c.tags.some((t) => excTags.has(t.toLowerCase())) ||
        excSegs.some((s) => evaluateSegmentForSubscriber(s.matchType, s.conditions, c, act))
      ) {
        excluded.excludedByRule += 1;
        continue;
      }
      eligible.push(c);
    }

    return {
      estimate: {
        totalContacts: allSubs.length,
        matchedBeforeExclusions: candidateSet.length,
        eligibleCount: eligible.length,
        excluded,
      },
      eligible,
    };
  }

  async createCampaign(input: {
    organizationId: string;
    domainId: string;
    templateId: string;
    name: string;
    fromName?: string | undefined;
    fromEmail?: string | null | undefined;
    replyTo?: string | null | undefined;
    subject?: string | null | undefined;
    previewText?: string | undefined;
    htmlBody?: string | null | undefined;
    textBody?: string | null | undefined;
    blocksJson?: EmailTemplateBlock[] | undefined;
    audienceSpec?: AudienceSelectionSpec | undefined;
    timezone: string;
    scheduledAt: string | null;
    tagFilter: string | null;
  }): Promise<CampaignRecord> {
    const effectiveSpec: AudienceSelectionSpec =
      input.audienceSpec ?? (input.tagFilter ? { mode: 'filtered', includeTags: [input.tagFilter] } : { mode: 'all' });
    const { estimate } = await this.estimateBroadcastAudience(input.organizationId, effectiveSpec);

    const tpl = this.templates.get(input.templateId);
    const latestTpl = tpl?.versions[tpl.versions.length - 1];
    const html = input.htmlBody ?? latestTpl?.htmlBody ?? null;

    const rec: CampaignRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      domainId: input.domainId,
      templateId: input.templateId,
      name: input.name,
      status: input.scheduledAt ? 'scheduled' : 'draft',
      fromName: input.fromName ?? '',
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
      subject: input.subject ?? latestTpl?.subject ?? null,
      previewText: input.previewText ?? latestTpl?.previewText ?? '',
      htmlBody: html ? sanitizeMarketingHtml(html) : null,
      textBody: input.textBody ?? latestTpl?.textBody ?? null,
      blocksJson: input.blocksJson ?? latestTpl?.blocksJson ?? [],
      audienceSpec: effectiveSpec,
      timezone: input.timezone,
      scheduledAt: input.scheduledAt,
      tagFilter: input.tagFilter,
      targetCount: estimate.eligibleCount,
      sentCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.campaigns.set(rec.id, rec);
    return rec;
  }

  async updateCampaign(
    orgId: string,
    id: string,
    patch: Partial<{
      domainId: string;
      templateId: string;
      name: string;
      fromName: string;
      fromEmail: string | null;
      replyTo: string | null;
      subject: string | null;
      previewText: string;
      htmlBody: string | null;
      textBody: string | null;
      blocksJson: EmailTemplateBlock[];
      audienceSpec: AudienceSelectionSpec;
      timezone: string;
      scheduledAt: string | null;
      status: CampaignRecord['status'];
      expectedUpdatedAt?: string | undefined;
    }>
  ): Promise<CampaignRecord | null> {
    const c = this.campaigns.get(id);
    if (!c || c.organizationId !== orgId) return null;
    if (c.status === 'completed' || c.status === 'sending' || c.status === 'running' || c.status === 'cancelled') {
      throw new AppError(409, 'CAMPAIGN_LOCKED', `Cannot edit a ${c.status} broadcast`);
    }
    if (patch.expectedUpdatedAt && c.updatedAt && patch.expectedUpdatedAt !== c.updatedAt) {
      throw new AppError(409, 'DRAFT_CONFLICT', 'Broadcast draft was updated in another session', { latestCampaign: c });
    }
    const { expectedUpdatedAt: _ignored, ...rest } = patch;
    Object.assign(c, rest);
    if (patch.htmlBody !== undefined && patch.htmlBody !== null) {
      c.htmlBody = sanitizeMarketingHtml(patch.htmlBody);
    }
    if (patch.audienceSpec) {
      const { estimate } = await this.estimateBroadcastAudience(orgId, patch.audienceSpec);
      c.targetCount = estimate.eligibleCount;
    }
    c.updatedAt = new Date().toISOString();
    return { ...c };
  }

  duplicateCampaign(orgId: string, id: string): CampaignRecord | null {
    const src = this.campaigns.get(id);
    if (!src || src.organizationId !== orgId) return null;
    const now = new Date().toISOString();
    const copy: CampaignRecord = {
      ...src,
      id: randomUUID(),
      name: `${src.name} (Copy)`,
      status: 'draft',
      scheduledAt: null,
      sentCount: 0,
      dispatchedAt: null,
      completedAt: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.campaigns.set(copy.id, copy);
    return { ...copy };
  }

  deleteCampaign(orgId: string, id: string): boolean {
    const c = this.campaigns.get(id);
    if (!c || c.organizationId !== orgId) return false;
    return this.campaigns.delete(id);
  }

  transitionCampaign(orgId: string, id: string, status: CampaignRecord['status']): CampaignRecord | null {
    const c = this.campaigns.get(id);
    if (!c || c.organizationId !== orgId) return null;
    if ((c.status === 'completed' || c.status === 'cancelled') && status === 'running') {
      throw new AppError(400, 'INVALID_TRANSITION', `Cannot restart a ${c.status} broadcast`);
    }
    c.status = status;
    return c;
  }

  markCampaignDispatched(orgId: string, id: string, sentCount: number, failureReason?: string): CampaignRecord | null {
    const c = this.campaigns.get(id);
    if (!c || c.organizationId !== orgId) return null;
    c.sentCount += sentCount;
    c.status = failureReason ? 'failed' : 'completed';
    if (failureReason) c.failureReason = failureReason;
    c.completedAt = new Date().toISOString();
    return c;
  }

  snapshotCampaignRecipients(_orgId: string, campaignId: string, eligible: SubscriberRecord[]): void {
    const existing = this.campaignRecipients.get(campaignId) ?? [];
    const seen = new Set(existing.map((e) => e.recipientEmail));
    for (const s of eligible) {
      if (!seen.has(s.email.toLowerCase())) {
        existing.push({ recipientEmail: s.email.toLowerCase(), subscriberId: s.id, status: 'pending' });
        seen.add(s.email.toLowerCase());
      }
    }
    this.campaignRecipients.set(campaignId, existing);
  }

  markCampaignRecipientStatus(
    campaignId: string,
    recipientEmail: string,
    status: 'pending' | 'queued' | 'sent' | 'cancelled' | 'failed',
    messageId?: string
  ): void {
    const list = this.campaignRecipients.get(campaignId) ?? [];
    const row = list.find((r) => r.recipientEmail === recipientEmail.toLowerCase());
    if (row) {
      row.status = status;
      if (messageId) row.messageId = messageId;
    }
  }

  cancelBroadcastRecipients(_orgId: string, campaignId: string): { cancelledCount: number; handedOffCount: number } {
    const list = this.campaignRecipients.get(campaignId) ?? [];
    let cancelledCount = 0;
    let handedOffCount = 0;
    for (const r of list) {
      if (r.status === 'pending') {
        r.status = 'cancelled';
        cancelledCount += 1;
      } else if (r.status === 'queued' || r.status === 'sent') {
        handedOffCount += 1;
      }
    }
    return { cancelledCount, handedOffCount };
  }

  async getBroadcastAnalytics(
    orgId: string,
    campaignId: string,
    analyticsStore?: AnalyticsStore
  ): Promise<BroadcastAnalyticsSummary | null> {
    const c = this.campaigns.get(campaignId);
    if (!c || c.organizationId !== orgId) return null;
    const snap = this.campaignRecipients.get(campaignId) ?? [];
    const evs = analyticsStore
      ? (await analyticsStore.queryEvents(orgId, { range: '30d' })).filter((e) => e.campaignId === campaignId)
      : [];

    const openSet = new Set<string>();
    const clickSet = new Set<string>();
    const linkMap = new Map<string, { clicks: number; uniq: Set<string> }>();
    let delivered = 0;
    let opens = 0;
    let clicks = 0;
    let bounces = 0;
    let complaints = 0;
    let unsubscribes = 0;

    for (const ev of evs) {
      if (ev.eventType === 'delivered' || ev.eventType === 'accepted') delivered += 1;
      if (ev.eventType === 'opened') {
        opens += 1;
        openSet.add(ev.recipientEmail);
      }
      if (ev.eventType === 'clicked') {
        clicks += 1;
        clickSet.add(ev.recipientEmail);
        if (ev.detail) {
          const entry = linkMap.get(ev.detail) ?? { clicks: 0, uniq: new Set<string>() };
          entry.clicks += 1;
          entry.uniq.add(ev.recipientEmail);
          linkMap.set(ev.detail, entry);
        }
      }
      if (ev.eventType === 'bounced') bounces += 1;
      if (ev.eventType === 'complained') complaints += 1;
      if (ev.eventType === 'unsubscribed') unsubscribes += 1;
    }

    return {
      campaignId,
      totalTargeted: c.targetCount,
      eligibleRecipients: snap.length || c.targetCount,
      queued: snap.filter((r) => r.status === 'pending' || r.status === 'queued').length,
      sent: c.sentCount,
      acceptedRemote: delivered,
      delivered,
      opens,
      uniqueOpens: openSet.size,
      clicks,
      uniqueClicks: clickSet.size,
      bounces,
      complaints,
      unsubscribes,
      failed: snap.filter((r) => r.status === 'failed').length,
      cancelled: snap.filter((r) => r.status === 'cancelled').length,
      topLinks: [...linkMap.entries()].map(([url, v]) => ({ url, clicks: v.clicks, uniqueClicks: v.uniq.size })),
      recentActivity: evs.slice(0, 20).map((e) => ({
        id: e.id,
        recipientEmail: e.recipientEmail,
        eventType: e.eventType,
        detail: e.detail,
        occurredAt: e.createdAt,
      })),
    };
  }

  listDueScheduledCampaigns(): CampaignRecord[] {
    const now = Date.now();
    return [...this.campaigns.values()].filter(
      (c) => c.status === 'scheduled' && c.scheduledAt && Date.parse(c.scheduledAt) <= now
    );
  }

  listSuppressions(orgId: string): SuppressionRecord[] {
    return [...this.suppressions.values()].filter((s) => s.organizationId === orgId);
  }

  addSuppression(
    orgId: string,
    email: string,
    reason: SuppressionReason,
    opts?: { source?: string; relatedCampaignId?: string }
  ): SuppressionRecord {
    const lower = email.toLowerCase();
    for (const c of this.contacts.values()) {
      if (c.organizationId === orgId && c.email === lower) {
        if (reason === 'complaint') c.status = 'complained';
        else if (reason === 'hard_bounce') c.status = 'bounced';
        else {
          c.status = 'unsubscribed';
          c.unsubscribedAt = c.unsubscribedAt ?? new Date().toISOString();
        }
        c.updatedAt = new Date().toISOString();
      }
    }
    const existing = [...this.suppressions.values()].find((s) => s.organizationId === orgId && s.email === lower);
    if (existing) return existing;
    const rec: SuppressionRecord = {
      id: randomUUID(),
      organizationId: orgId,
      email: lower,
      reason,
      source: opts?.source ?? null,
      relatedCampaignId: opts?.relatedCampaignId ?? null,
      status: 'active',
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

  // --- Sequences ---
  listSequences(orgId: string): EmailSequenceItem[] {
    return [...this.sequences.values()]
      .filter((s) => s.organizationId === orgId)
      .map((s) => ({
        ...s,
        enrolledCount: [...this.enrollments.values()].filter((e) => e.sequenceId === s.id && e.status === 'active').length,
      }));
  }

  createSequence(orgId: string, input: Partial<EmailSequenceItem> & { name: string }): EmailSequenceItem {
    const now = new Date().toISOString();
    const id = randomUUID();
    const rec: EmailSequenceItem = {
      id,
      organizationId: orgId,
      domainId: input.domainId ?? null,
      name: input.name,
      description: input.description ?? '',
      fromName: input.fromName ?? '',
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
      enabled: input.enabled ?? false,
      allowReentry: input.allowReentry ?? false,
      exitOnUnsubscribe: input.exitOnUnsubscribe ?? true,
      steps: (input.steps ?? []).map((st, idx) => ({
        id: st.id || randomUUID(),
        sequenceId: id,
        position: idx + 1,
        delayDays: st.delayDays ?? (idx === 0 ? 0 : 2),
        delayHours: st.delayHours ?? 0,
        subject: st.subject ?? `Step ${idx + 1}`,
        previewText: st.previewText ?? '',
        htmlBody: sanitizeMarketingHtml(st.htmlBody ?? '<p>Hello {{firstName}}</p>'),
        textBody: st.textBody ?? 'Hello {{firstName}}',
        blocksJson: st.blocksJson ?? [],
        enabled: st.enabled ?? true,
      })),
      enrolledCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sequences.set(id, rec);
    return rec;
  }

  updateSequence(orgId: string, id: string, patch: Partial<EmailSequenceItem>): EmailSequenceItem | null {
    const seq = this.sequences.get(id);
    if (!seq || seq.organizationId !== orgId) return null;
    if (patch.name !== undefined) seq.name = patch.name;
    if (patch.description !== undefined) seq.description = patch.description;
    if (patch.domainId !== undefined) seq.domainId = patch.domainId;
    if (patch.fromName !== undefined) seq.fromName = patch.fromName;
    if (patch.fromEmail !== undefined) seq.fromEmail = patch.fromEmail;
    if (patch.replyTo !== undefined) seq.replyTo = patch.replyTo;
    if (patch.enabled !== undefined) seq.enabled = patch.enabled;
    if (patch.allowReentry !== undefined) seq.allowReentry = patch.allowReentry;
    if (patch.exitOnUnsubscribe !== undefined) seq.exitOnUnsubscribe = patch.exitOnUnsubscribe;
    if (patch.steps !== undefined) {
      seq.steps = patch.steps.map((st, idx) => ({
        id: st.id || randomUUID(),
        sequenceId: id,
        position: idx + 1,
        delayDays: st.delayDays ?? 0,
        delayHours: st.delayHours ?? 0,
        subject: st.subject,
        previewText: st.previewText ?? '',
        htmlBody: sanitizeMarketingHtml(st.htmlBody ?? ''),
        textBody: st.textBody || htmlToPlainText(st.htmlBody ?? ''),
        blocksJson: st.blocksJson ?? [],
        enabled: st.enabled ?? true,
      }));
    }
    seq.updatedAt = new Date().toISOString();
    return seq;
  }

  deleteSequence(orgId: string, id: string): boolean {
    const seq = this.sequences.get(id);
    if (!seq || seq.organizationId !== orgId) return false;
    return this.sequences.delete(id);
  }

  enrollInSequence(orgId: string, sequenceId: string, subscriberId: string): SequenceEnrollmentItem {
    const seq = this.sequences.get(sequenceId);
    const sub = this.contacts.get(subscriberId);
    if (!seq || seq.organizationId !== orgId || !sub || sub.organizationId !== orgId) {
      throw new AppError(404, 'NOT_FOUND', 'Sequence or subscriber not found');
    }
    const existing = [...this.enrollments.values()].find(
      (e) => e.sequenceId === sequenceId && e.subscriberId === subscriberId && e.status === 'active'
    );
    if (existing && !seq.allowReentry) return existing;
    const now = new Date();
    const firstStep = seq.steps[0];
    const delayMs = firstStep ? ((firstStep.delayDays * 24 + firstStep.delayHours) * 3600_000) : 0;
    const rec: SequenceEnrollmentItem = {
      id: randomUUID(),
      sequenceId,
      subscriberId,
      subscriberEmail: sub.email,
      currentStepIndex: 0,
      status: 'active',
      nextSendAt: firstStep ? new Date(now.getTime() + delayMs).toISOString() : null,
      lastSentAt: null,
      exitedReason: null,
      enrolledAt: now.toISOString(),
      completedAt: null,
    };
    this.enrollments.set(rec.id, rec);
    return rec;
  }

  listSequenceEnrollments(orgId: string, sequenceId: string): SequenceEnrollmentItem[] {
    const seq = this.sequences.get(sequenceId);
    if (!seq || seq.organizationId !== orgId) return [];
    return [...this.enrollments.values()].filter((e) => e.sequenceId === sequenceId);
  }

  // --- Visual Automations ---
  listAutomations(orgId: string): AutomationItem[] {
    return [...this.automations.values()]
      .filter((a) => a.organizationId === orgId)
      .map((a) => ({
        ...a,
        runCount: [...this.automationRuns.values()].filter((r) => r.automationId === a.id).length,
      }));
  }

  createAutomation(
    orgId: string,
    input: {
      name: string;
      description?: string;
      triggerType: AutomationItem['triggerType'];
      triggerConfig?: Record<string, unknown>;
      nodes?: AutomationNode[];
      edges?: AutomationEdge[];
    }
  ): AutomationItem {
    const now = new Date().toISOString();
    const rec: AutomationItem = {
      id: randomUUID(),
      organizationId: orgId,
      name: input.name,
      description: input.description ?? '',
      status: 'draft',
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig ?? {},
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.automations.set(rec.id, rec);
    return rec;
  }

  updateAutomation(orgId: string, id: string, patch: Partial<AutomationItem>): AutomationItem | null {
    const a = this.automations.get(id);
    if (!a || a.organizationId !== orgId) return null;
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.description !== undefined) a.description = patch.description;
    if (patch.status !== undefined) a.status = patch.status;
    if (patch.triggerType !== undefined) a.triggerType = patch.triggerType;
    if (patch.triggerConfig !== undefined) a.triggerConfig = patch.triggerConfig;
    if (patch.nodes !== undefined) a.nodes = patch.nodes;
    if (patch.edges !== undefined) a.edges = patch.edges;
    a.updatedAt = new Date().toISOString();
    return a;
  }

  deleteAutomation(orgId: string, id: string): boolean {
    const a = this.automations.get(id);
    if (!a || a.organizationId !== orgId) return false;
    return this.automations.delete(id);
  }

  listAutomationRuns(orgId: string, automationId?: string): AutomationRunItem[] {
    return [...this.automationRuns.values()].filter((r) => {
      const a = this.automations.get(r.automationId);
      return a && a.organizationId === orgId && (!automationId || r.automationId === automationId);
    });
  }

  private executeAutomationGraphSync(orgId: string, a: AutomationItem, sub: SubscriberRecord): AutomationRunItem {
    let current = a.nodes.find((n) => n.type === 'trigger') ?? a.nodes[0];
    let steps = 0;
    const runId = randomUUID();
    const visited = new Set<string>();
    while (current && steps < 25) {
      steps += 1;
      if (visited.has(current.id)) break;
      visited.add(current.id);
      const resolvedTag = (conf: Record<string, unknown>): string | null => {
        if (typeof conf.tagId === 'string' && conf.tagId) {
          return this.tags.get(conf.tagId)?.name ?? (typeof conf.tagName === 'string' ? conf.tagName : null);
        }
        return typeof conf.tagName === 'string' ? conf.tagName : null;
      };
      const tagTarget = resolvedTag(current.config);
      if (current.type === 'action_add_tag' && tagTarget) {
        this.updateSubscriber(orgId, sub.id, { addTags: [tagTarget] });
      } else if (current.type === 'action_remove_tag' && tagTarget) {
        this.updateSubscriber(orgId, sub.id, { removeTags: [tagTarget] });
      } else if (current.type === 'action_update_field' && typeof current.config.fieldKey === 'string') {
        this.updateSubscriber(orgId, sub.id, {
          attributes: { [current.config.fieldKey]: String(current.config.value ?? '') },
        });
      } else if (current.type === 'action_subscribe_sequence' && typeof current.config.sequenceId === 'string') {
        this.enrollInSequence(orgId, current.config.sequenceId, sub.id);
      } else if (current.type === 'end') {
        break;
      }
      let nextEdge = a.edges.find((e) => e.source === current!.id && (!e.branch || e.branch === 'next'));
      if (current.type === 'condition' && tagTarget) {
        const hasTag = sub.tags.some((t) => t.toLowerCase() === tagTarget.toLowerCase());
        nextEdge = a.edges.find((e) => e.source === current!.id && e.branch === (hasTag ? 'yes' : 'no'));
      }
      current = nextEdge ? a.nodes.find((n) => n.id === nextEdge.target) : undefined;
    }
    const run: AutomationRunItem = {
      id: runId,
      automationId: a.id,
      subscriberId: sub.id,
      subscriberEmail: sub.email,
      currentNodeId: current?.id ?? null,
      status: 'completed',
      nextRunAt: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.automationRuns.set(run.id, run);
    return run;
  }

  triggerAutomationForSubscriber(
    orgId: string,
    triggerType: AutomationItem['triggerType'],
    subscriberId: string,
    context?: Record<string, unknown>
  ): number {
    const sub = this.contacts.get(subscriberId);
    if (!sub || sub.organizationId !== orgId) return 0;
    let launched = 0;
    for (const a of this.automations.values()) {
      if (a.organizationId !== orgId || a.status !== 'published' || a.triggerType !== triggerType) continue;
      if (triggerType === 'tag_added' && (a.triggerConfig.tagId || a.triggerConfig.tagName)) {
        const expectedById =
          typeof a.triggerConfig.tagId === 'string' && a.triggerConfig.tagId
            ? this.tags.get(a.triggerConfig.tagId)?.name
            : undefined;
        const expected = String(expectedById ?? a.triggerConfig.tagName ?? '').toLowerCase();
        const actual = String(context?.tagName ?? '').toLowerCase();
        if (expected && actual && actual !== expected) continue;
        if (a.triggerConfig.tagId && context?.tagId && a.triggerConfig.tagId !== context.tagId) continue;
      }
      this.executeAutomationGraphSync(orgId, a, sub);
      launched += 1;
    }
    return launched;
  }

  runSpecificAutomation(orgId: string, automationId: string, subscriberId: string): AutomationRunItem | null {
    const a = this.automations.get(automationId);
    const sub = this.contacts.get(subscriberId);
    if (!a || a.organizationId !== orgId || !sub || sub.organizationId !== orgId) return null;
    return this.executeAutomationGraphSync(orgId, a, sub);
  }

  // --- Growth: Forms & Landing Pages ---
  listForms(orgId: string): GrowthFormItem[] {
    return [...this.forms.values()].filter((f) => f.organizationId === orgId);
  }

  createForm(orgId: string, input: Partial<GrowthFormItem> & { name: string }): GrowthFormItem {
    const now = new Date().toISOString();
    const rec: GrowthFormItem = {
      id: randomUUID(),
      organizationId: orgId,
      name: input.name,
      formType: input.formType ?? 'inline',
      title: input.title ?? 'Subscribe to our newsletter',
      description: input.description ?? '',
      buttonText: input.buttonText ?? 'Subscribe',
      successMessage: input.successMessage ?? 'Thanks for subscribing!',
      redirectUrl: input.redirectUrl ?? null,
      consentText: input.consentText ?? 'I agree to receive email updates.',
      doubleOptIn: input.doubleOptIn ?? false,
      fields: input.fields ?? [{ key: 'firstName', label: 'First name', required: false }],
      tagIds: input.tagIds ?? [],
      published: input.published ?? true,
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.forms.set(rec.id, rec);
    return rec;
  }

  updateForm(orgId: string, id: string, patch: Partial<GrowthFormItem>): GrowthFormItem | null {
    const f = this.forms.get(id);
    if (!f || f.organizationId !== orgId) return null;
    Object.assign(f, patch, { updatedAt: new Date().toISOString() });
    return f;
  }

  deleteForm(orgId: string, id: string): boolean {
    const f = this.forms.get(id);
    if (!f || f.organizationId !== orgId) return false;
    return this.forms.delete(id);
  }

  getPublicForm(formId: string): GrowthFormItem | null {
    const f = this.forms.get(formId);
    return f && f.published ? f : null;
  }

  submitPublicForm(
    formId: string,
    payload: { email: string; firstName?: string; lastName?: string; attributes?: Record<string, string>; landingPageId?: string }
  ) {
    const f = this.forms.get(formId);
    if (!f || !f.published) throw new AppError(404, 'FORM_NOT_FOUND', 'Signup form not found');
    const tagNames = f.tagIds.map((id) => this.tags.get(id)?.name ?? '').filter(Boolean);
    const { subscriber } = this.upsertSubscriber(f.organizationId, {
      email: payload.email,
      firstName: payload.firstName ?? '',
      lastName: payload.lastName ?? '',
      status: f.doubleOptIn ? 'pending_confirmation' : 'subscribed',
      tags: tagNames,
      attributes: payload.attributes ?? {},
      consentSource: `form:${f.name}`,
    });
    f.submissionCount += 1;
    let confirmToken: string | undefined;
    if (f.doubleOptIn) {
      confirmToken = randomUUID();
      this.optInTokens.set(confirmToken, { orgId: f.organizationId, subscriberId: subscriber.id });
    } else {
      this.triggerAutomationForSubscriber(f.organizationId, 'form_submitted', subscriber.id, { formId: f.id });
    }
    return {
      subscriber,
      doubleOptIn: f.doubleOptIn,
      ...(confirmToken ? { confirmToken } : {}),
      successMessage: f.successMessage,
      redirectUrl: f.redirectUrl,
    };
  }

  listLandingPages(orgId: string): LandingPageItem[] {
    return [...this.landingPages.values()].filter((p) => p.organizationId === orgId);
  }

  createLandingPage(
    orgId: string,
    input: Partial<LandingPageItem> & { slug: string; title: string; headline: string }
  ): LandingPageItem {
    const cleanSlug = input.slug.trim().toLowerCase();
    const dup = [...this.landingPages.values()].find((p) => p.slug === cleanSlug);
    if (dup) throw new AppError(409, 'SLUG_EXISTS', `Landing page slug "${cleanSlug}" is already taken`);
    const now = new Date().toISOString();
    const rec: LandingPageItem = {
      id: randomUUID(),
      organizationId: orgId,
      slug: cleanSlug,
      title: input.title,
      headline: input.headline,
      subheadline: input.subheadline ?? '',
      bodyHtml: sanitizeMarketingHtml(input.bodyHtml ?? ''),
      heroImageUrl: input.heroImageUrl ?? null,
      templateKey: input.templateKey ?? 'minimal',
      buttonText: input.buttonText ?? 'Get Updates',
      customDomain: input.customDomain ?? null,
      formId: input.formId ?? null,
      tagIds: input.tagIds ?? [],
      published: input.published ?? false,
      viewsCount: 0,
      conversionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.landingPages.set(rec.id, rec);
    return rec;
  }

  updateLandingPage(orgId: string, id: string, patch: Partial<LandingPageItem>): LandingPageItem | null {
    const p = this.landingPages.get(id);
    if (!p || p.organizationId !== orgId) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    if (patch.bodyHtml !== undefined) p.bodyHtml = sanitizeMarketingHtml(patch.bodyHtml);
    return p;
  }

  deleteLandingPage(orgId: string, id: string): boolean {
    const p = this.landingPages.get(id);
    if (!p || p.organizationId !== orgId) return false;
    return this.landingPages.delete(id);
  }

  getPublicLandingPage(slug: string): LandingPageItem | null {
    const p = [...this.landingPages.values()].find((x) => x.slug === slug.toLowerCase());
    if (!p || !p.published) return null;
    p.viewsCount += 1;
    return p;
  }
}

export function renderTemplateString(template: string, vars: Record<string, string>): string {
  return renderPersonalizedContent(template, vars);
}

const emailBlockSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['heading', 'text', 'image', 'button', 'divider', 'social', 'footer', 'columns']),
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
});

const createTemplateSchema = z.object({
  name: z.string().min(2).max(120),
  category: z.string().default('transactional'),
  description: z.string().max(300).default(''),
  subject: z.string().min(1).max(998),
  previewText: z.string().max(300).default(''),
  htmlBody: z.string().default(''),
  textBody: z.string().default(''),
  blocksJson: z.array(emailBlockSchema).optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  category: z.string().optional(),
  description: z.string().max(300).optional(),
  archived: z.boolean().optional(),
  subject: z.string().min(1).max(998).optional(),
  previewText: z.string().max(300).optional(),
  htmlBody: z.string().optional(),
  textBody: z.string().optional(),
  blocksJson: z.array(emailBlockSchema).optional(),
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
        attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      })
    )
    .min(1)
    .max(5000),
});

const createCampaignSchema = z.object({
  domainId: z.string().min(1),
  templateId: z.string().default(''),
  name: z.string().min(2).max(120),
  fromName: z.string().max(120).default(''),
  fromEmail: z.string().max(320).nullable().optional(),
  replyTo: z.string().max(320).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
  previewText: z.string().max(300).default(''),
  htmlBody: z.string().nullable().optional(),
  textBody: z.string().nullable().optional(),
  blocksJson: z.array(emailBlockSchema).optional(),
  audienceSpec: audienceSelectionSchema.optional(),
  timezone: z.string().default('UTC'),
  scheduledAt: z.string().datetime().nullable().default(null),
  tagFilter: z.string().nullable().default(null),
});

const updateCampaignSchema = createCampaignSchema.partial().extend({
  status: z.enum(['draft', 'scheduled', 'paused']).optional(),
  expectedUpdatedAt: z.string().optional(),
});

export function createMarketingRouter(deps: {
  store: MarketingStore;
  jwtSecret: string;
  analyticsStore?: AnalyticsStore;
  domainStore?: DomainStore;
  onCampaignStarted?: (campaign: CampaignRecord) => Promise<number>;
  onSendTestEmail?: (input: {
    organizationId: string;
    domainId: string;
    toEmail: string;
    fromName: string;
    fromEmail: string;
    replyTo: string | null;
    subject: string;
    htmlBody: string;
    textBody: string;
  }) => Promise<void>;
  onCancelCampaign?: (organizationId: string, campaignId: string) => Promise<{ cancelledCount: number; handedOffCount: number }>;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);

  router.get('/templates', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    res.json({ templates: await deps.store.listTemplates(req.auth!.orgId!, includeArchived) });
  });

  router.post('/templates', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const parsed = createTemplateSchema.parse(req.body);
    const template = await deps.store.createTemplate({
      organizationId: req.auth!.orgId!,
      ...parsed,
    });
    res.status(201).json({ template });
  });

  router.patch('/templates/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateTemplate) throw new AppError(501, 'NOT_SUPPORTED', 'Template updates not supported');
    const patch = updateTemplateSchema.parse(req.body);
    const updated = await deps.store.updateTemplate(req.auth!.orgId!, String(req.params.id ?? ''), patch);
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    res.json({ template: updated });
  });

  router.post('/templates/:id/duplicate', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const dup = await deps.store.duplicateTemplate(req.auth!.orgId!, String(req.params.id ?? ''));
    if (!dup) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    res.status(201).json({ template: dup });
  });

  router.delete('/templates/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteTemplate) throw new AppError(501, 'NOT_SUPPORTED', 'Template deletion not supported');
    const deleted = await deps.store.deleteTemplate(req.auth!.orgId!, String(req.params.id ?? ''));
    if (!deleted) throw new AppError(404, 'NOT_FOUND', 'Template not found');
    res.status(204).send();
  });

  router.post('/templates/render-blocks', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const body = z
      .object({
        blocksJson: z.array(emailBlockSchema),
        subject: z.string().optional(),
        previewText: z.string().optional(),
      })
      .parse(req.body);
    const compiled = compileBlocksToHtmlAndText(body.blocksJson, {
      ...(body.subject ? { subject: body.subject } : {}),
      ...(body.previewText ? { previewText: body.previewText } : {}),
    });
    res.json(compiled);
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
      htmlBody: sanitizeMarketingHtml(renderTemplateString(body.htmlBody, body.variables)),
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

  router.get('/campaigns/:id', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const campaigns = await deps.store.listCampaigns(req.auth!.orgId!);
    const campaign = campaigns.find((c) => c.id === String(req.params.id ?? ''));
    if (!campaign) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    res.json({ campaign });
  });

  router.post('/campaigns/:id/duplicate', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.duplicateCampaign) throw new AppError(501, 'NOT_SUPPORTED', 'Campaign duplication not supported');
    const copy = await deps.store.duplicateCampaign(req.auth!.orgId!, String(req.params.id ?? ''));
    if (!copy) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    res.status(201).json({ campaign: copy });
  });

  router.post('/campaigns/estimate-audience', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const spec = audienceSelectionSchema.parse(req.body ?? {}) as AudienceSelectionSpec;
    if (!deps.store.estimateBroadcastAudience) {
      const contacts = await deps.store.listContacts(req.auth!.orgId!);
      const eligible = contacts.filter((c) => !c.unsubscribedAt);
      return res.json({
        estimate: {
          totalContacts: contacts.length,
          matchedBeforeExclusions: contacts.length,
          eligibleCount: eligible.length,
          excluded: { unsubscribed: contacts.length - eligible.length, bounced: 0, complained: 0, suppressed: 0, invalidEmail: 0, excludedByRule: 0 },
        },
        sample: eligible.slice(0, 10),
      });
    }
    const { estimate, eligible } = await deps.store.estimateBroadcastAudience(req.auth!.orgId!, spec, deps.analyticsStore);
    return res.json({ estimate, sample: eligible.slice(0, 10) });
  });

  router.post('/campaigns', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const parsed = createCampaignSchema.parse(req.body);
    const campaign = await deps.store.createCampaign({
      organizationId: req.auth!.orgId!,
      ...parsed,
    });
    res.status(201).json({ campaign });
  });

  router.patch('/campaigns/:id', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    if (!deps.store.updateCampaign) throw new AppError(501, 'NOT_SUPPORTED', 'Broadcast editing not supported');
    const patch = updateCampaignSchema.parse(req.body);
    const updated = await deps.store.updateCampaign(req.auth!.orgId!, String(req.params.id ?? ''), patch as Parameters<NonNullable<MarketingStore['updateCampaign']>>[2]);
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    res.json({ campaign: updated });
  });

  router.delete('/campaigns/:id', auth, requireOrgRole(['owner', 'admin']), async (req, res) => {
    if (!deps.store.deleteCampaign) throw new AppError(501, 'NOT_SUPPORTED', 'Campaign deletion not supported');
    if (!(await deps.store.deleteCampaign(req.auth!.orgId!, String(req.params.id ?? '')))) {
      throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    }
    res.status(204).send();
  });

  router.post('/campaigns/:id/send-test', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const body = z.object({ toEmail: emailAddressSchema }).parse(req.body);
    const campaigns = await deps.store.listCampaigns(req.auth!.orgId!);
    const c = campaigns.find((x) => x.id === String(req.params.id ?? ''));
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    if (!deps.onSendTestEmail || !deps.domainStore) {
      throw new AppError(501, 'NOT_SUPPORTED', 'Test email sending is not configured');
    }
    const domain = await deps.domainStore.getDomain(req.auth!.orgId!, c.domainId);
    if (!domain || !domain.ownershipVerifiedAt || !domain.sendingEnabled || domain.isSuspended) {
      throw new AppError(403, 'DOMAIN_NOT_READY', 'Select a verified, active sending domain before sending test emails');
    }
    const fromEmail = c.fromEmail || `${domain.defaultSenderLocalPart || 'newsletter'}@${domain.domainName}`;
    const tpls = await deps.store.listTemplates(req.auth!.orgId!, true);
    const tpl = tpls.find((t) => t.id === c.templateId);
    const tplVer = tpl?.versions.find((v) => v.versionNumber === tpl.activeVersion) ?? tpl?.versions[tpl.versions.length - 1];
    const subject = `[TEST] ${c.subject || tplVer?.subject || c.name}`;
    const htmlBody = c.htmlBody || tplVer?.htmlBody || `<p>${c.name}</p>`;
    const textBody = c.textBody || tplVer?.textBody || htmlToPlainText(htmlBody);
    await deps.onSendTestEmail({
      organizationId: req.auth!.orgId!,
      domainId: domain.id,
      toEmail: body.toEmail,
      fromName: c.fromName || domain.domainName,
      fromEmail,
      replyTo: c.replyTo ?? null,
      subject: renderTemplateString(subject, { firstName: 'Preview', lastName: 'User', email: body.toEmail }),
      htmlBody: sanitizeMarketingHtml(renderTemplateString(htmlBody, { firstName: 'Preview', lastName: 'User', email: body.toEmail })),
      textBody: renderTemplateString(textBody, { firstName: 'Preview', lastName: 'User', email: body.toEmail }),
    });
    res.json({ sent: true, toEmail: body.toEmail });
  });

  router.get('/campaigns/:id/analytics', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    if (!deps.store.getBroadcastAnalytics) throw new AppError(501, 'NOT_SUPPORTED', 'Broadcast analytics unavailable');
    const summary = await deps.store.getBroadcastAnalytics(req.auth!.orgId!, String(req.params.id ?? ''), deps.analyticsStore);
    if (!summary) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    res.json({ analytics: summary });
  });

  router.post('/campaigns/:id/:action', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const action = String(req.params.action ?? '');
    const id = String(req.params.id ?? '');
    const orgId = req.auth!.orgId!;
    const nextStatus =
      action === 'pause'
        ? 'paused'
        : action === 'resume' || action === 'send' || action === 'start'
          ? 'running'
          : action === 'cancel'
            ? 'cancelled'
            : null;
    if (!nextStatus) throw new AppError(400, 'INVALID_ACTION', 'Unsupported campaign action');

    let cancelReport: { cancelledCount: number; handedOffCount: number } | undefined;
    if (nextStatus === 'cancelled') {
      if (deps.onCancelCampaign) cancelReport = await deps.onCancelCampaign(orgId, id);
      else if (deps.store.cancelBroadcastRecipients) cancelReport = await deps.store.cancelBroadcastRecipients(orgId, id);
    }

    if (nextStatus === 'running' && deps.domainStore) {
      const list = await deps.store.listCampaigns(orgId);
      const target = list.find((c) => c.id === id);
      if (target) {
        const domain = await deps.domainStore.getDomain(orgId, target.domainId);
        if (!domain || !domain.ownershipVerifiedAt || !domain.sendingEnabled || domain.isSuspended) {
          throw new AppError(403, 'DOMAIN_NOT_READY', 'Sending domain must be verified, enabled, and not suspended');
        }
      }
    }

    let updated = await deps.store.transitionCampaign(orgId, id, nextStatus);
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
    let dispatchedCount = 0;
    if (nextStatus === 'running' && deps.onCampaignStarted) {
      dispatchedCount = await deps.onCampaignStarted(updated);
      if (deps.store.markCampaignDispatched) {
        const completed = await deps.store.markCampaignDispatched(orgId, updated.id, dispatchedCount);
        if (completed) updated = completed;
      }
    }
    res.json({ campaign: updated, dispatchedCount, ...(cancelReport ? { cancelReport } : {}) });
  });

  router.get('/suppressions', auth, requireOrgRole(['owner', 'admin', 'developer', 'read_only_analyst']), async (req, res) => {
    const list = await deps.store.listSuppressions(req.auth!.orgId!);
    const q = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const reason = typeof req.query.reason === 'string' ? req.query.reason : '';
    const filtered = list.filter((s) => (!q || s.email.includes(q)) && (!reason || s.reason === reason));
    res.json({ suppressions: filtered });
  });

  router.post('/suppressions', auth, requireOrgRole(['owner', 'admin', 'developer']), async (req, res) => {
    const body = z
      .object({
        email: emailAddressSchema,
        reason: z.enum(['hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid_recipient', 'admin']).default('manual'),
      })
      .parse(req.body);
    const entry = await deps.store.addSuppression(req.auth!.orgId!, body.email, body.reason, { source: 'manual_console' });
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
