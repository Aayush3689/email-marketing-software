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
import { emailAddressSchema } from '@mail/validation';
import type { Pool } from 'pg';
import { AppError } from '../middleware/error-handler.js';
import type { AnalyticsStore } from '../routes/analytics.js';
import type {
  CampaignRecord,
  MarketingStore,
  SubscriberProfileData,
  SubscriberQueryParams,
  SuppressionRecord,
  TemplateRecord,
} from '../routes/campaigns.js';
import {
  type ActivityLookup,
  compileBlocksToHtmlAndText,
  evaluateSegmentForSubscriber,
  htmlToPlainText,
  parseCsvMatrix,
  sanitizeMarketingHtml,
} from '../services/marketing-engine.js';
import { uuidv7 } from '../utils/uuidv7.js';

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function isoOrNull(v: unknown): string | null {
  return v ? iso(v) : null;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgMarketingPlatformStore implements MarketingStore {
  constructor(private readonly pool: Pool) {}

  private mapSubscriberRow(r: Record<string, unknown>): SubscriberRecord {
    const tags = Array.isArray(r.tag_names)
      ? (r.tag_names as string[])
      : Array.isArray(r.tags)
        ? (r.tags as string[])
        : [];
    const tagIds = Array.isArray(r.tag_ids) ? (r.tag_ids as string[]) : undefined;
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      email: String(r.email),
      firstName: String(r.first_name ?? ''),
      lastName: String(r.last_name ?? ''),
      status: (r.status as SubscriberStatus) ?? (r.unsubscribed_at ? 'unsubscribed' : 'subscribed'),
      tags,
      ...(tagIds ? { tagIds } : {}),
      attributes: (r.attributes ?? {}) as Record<string, string | number | boolean | null>,
      consentSource: String(r.consent_source ?? ''),
      consentedAt: iso(r.consented_at),
      unsubscribedAt: isoOrNull(r.unsubscribed_at),
      lastActivityAt: isoOrNull(r.last_activity_at),
      engagementScore: Number(r.engagement_score ?? 0),
      createdAt: iso(r.created_at),
      updatedAt: r.updated_at ? iso(r.updated_at) : iso(r.created_at),
    };
  }

  private async ensureTagsAndLink(orgId: string, subscriberId: string, tagNames: string[]): Promise<string[]> {
    const cleanNames = [...new Set(tagNames.map((t) => t.trim()).filter(Boolean))];
    if (cleanNames.length === 0) return [];
    const tagIds: string[] = [];
    for (const name of cleanNames) {
      const tagRes = await this.pool.query<{ id: string }>(
        `INSERT INTO tags (id, organization_id, name)
         VALUES ($1, $2, $3::citext)
         ON CONFLICT (organization_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id::text`,
        [uuidv7(), orgId, name]
      );
      const tagId = tagRes.rows[0]!.id;
      tagIds.push(tagId);
      await this.pool.query(
        `INSERT INTO subscriber_tags (subscriber_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [subscriberId, tagId]
      );
    }
    await this.pool.query(
      `UPDATE contacts
          SET tags = COALESCE((
            SELECT array_agg(t.name::text ORDER BY t.name)
              FROM subscriber_tags st JOIN tags t ON t.id = st.tag_id
             WHERE st.subscriber_id = $1
          ), '{}'::text[]),
              updated_at = NOW()
        WHERE id = $1`,
      [subscriberId]
    );
    return tagIds;
  }

  private async loadActivityLookup(orgId: string): Promise<ActivityLookup> {
    const openedCampaignIdsByEmail = new Map<string, Set<string>>();
    const clickedEmails = new Set<string>();
    const openedAnyEmails = new Set<string>();
    const lastEngagedByEmail = new Map<string, Date>();
    const res = await this.pool.query<{
      event_type: EmailEventType;
      campaign_id: string | null;
      occurred_at: Date;
      email: string | null;
    }>(
      `SELECT e.event_type, e.campaign_id::text, e.occurred_at,
              COALESCE(r.recipient_email::text, e.metadata->>'recipientEmail') AS email
         FROM email_events e
         LEFT JOIN message_recipients r ON r.id = e.message_recipient_id
        WHERE e.organization_id = $1
          AND e.event_type IN ('opened', 'clicked')
          AND e.occurred_at >= NOW() - INTERVAL '90 days'`,
      [orgId]
    );
    for (const r of res.rows) {
      if (!r.email) continue;
      const em = r.email.toLowerCase();
      const dt = new Date(r.occurred_at);
      if (!lastEngagedByEmail.has(em) || lastEngagedByEmail.get(em)! < dt) lastEngagedByEmail.set(em, dt);
      if (r.event_type === 'opened') {
        openedAnyEmails.add(em);
        if (r.campaign_id) {
          const set = openedCampaignIdsByEmail.get(em) ?? new Set<string>();
          set.add(r.campaign_id);
          openedCampaignIdsByEmail.set(em, set);
        }
      } else if (r.event_type === 'clicked') {
        clickedEmails.add(em);
      }
    }
    return { openedCampaignIdsByEmail, clickedEmails, openedAnyEmails, lastEngagedByEmail };
  }

  // =========================================================================
  // Templates
  // =========================================================================
  async listTemplates(orgId: string, includeArchived = false): Promise<TemplateRecord[]> {
    const tRes = await this.pool.query(
      `SELECT id::text, organization_id::text, name, category, description, active_version, archived_at, created_at, updated_at
         FROM templates
        WHERE organization_id = $1
          AND ($2::boolean = TRUE OR archived_at IS NULL)
        ORDER BY created_at DESC`,
      [orgId, includeArchived]
    );
    if (tRes.rows.length === 0) return [];
    const ids = tRes.rows.map((r) => r.id);
    const vRes = await this.pool.query(
      `SELECT template_id::text, version_number, subject, preview_text, html_body, text_body, blocks_json, created_at
         FROM template_versions
        WHERE template_id = ANY($1::uuid[])
        ORDER BY version_number ASC`,
      [ids]
    );
    const byTpl = new Map<string, TemplateRecord['versions']>();
    for (const v of vRes.rows) {
      const list = byTpl.get(v.template_id) ?? [];
      list.push({
        versionNumber: Number(v.version_number),
        subject: v.subject,
        previewText: v.preview_text ?? '',
        htmlBody: v.html_body,
        textBody: v.text_body,
        blocksJson: Array.isArray(v.blocks_json) ? v.blocks_json : [],
        createdAt: iso(v.created_at),
      });
      byTpl.set(v.template_id, list);
    }
    return tRes.rows.map((t) => ({
      id: t.id,
      organizationId: t.organization_id,
      name: t.name,
      category: t.category,
      description: t.description ?? '',
      activeVersion: Number(t.active_version),
      archivedAt: isoOrNull(t.archived_at),
      versions: byTpl.get(t.id) ?? [],
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
    }));
  }

  async createTemplate(input: {
    organizationId: string;
    name: string;
    category: string;
    description?: string;
    subject: string;
    previewText?: string;
    htmlBody: string;
    textBody: string;
    blocksJson?: EmailTemplateBlock[];
  }): Promise<TemplateRecord> {
    const id = uuidv7();
    const versionId = uuidv7();
    const compiled =
      input.blocksJson && input.blocksJson.length > 0 && !input.htmlBody
        ? compileBlocksToHtmlAndText(input.blocksJson, { subject: input.subject, previewText: input.previewText ?? '' })
        : {
            htmlBody: sanitizeMarketingHtml(input.htmlBody),
            textBody: input.textBody || htmlToPlainText(input.htmlBody),
          };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO templates (id, organization_id, name, category, description, active_version)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [id, input.organizationId, input.name, input.category, input.description ?? '']
      );
      await client.query(
        `INSERT INTO template_versions (id, template_id, version_number, subject, preview_text, html_body, text_body, blocks_json)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7::jsonb)`,
        [
          versionId,
          id,
          input.subject,
          input.previewText ?? '',
          compiled.htmlBody,
          compiled.textBody,
          JSON.stringify(input.blocksJson ?? []),
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const now = new Date().toISOString();
    return {
      id,
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
  }

  async updateTemplate(
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
  ): Promise<TemplateRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const all = await this.listTemplates(orgId, true);
    const tpl = all.find((t) => t.id === id);
    if (!tpl) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE templates
            SET name = COALESCE($3, name),
                category = COALESCE($4, category),
                description = COALESCE($5, description),
                archived_at = CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6::boolean THEN NOW() ELSE NULL END,
                updated_at = NOW()
          WHERE organization_id = $1 AND id = $2`,
        [orgId, id, patch.name ?? null, patch.category ?? null, patch.description ?? null, patch.archived ?? null]
      );
      if (
        patch.subject !== undefined ||
        patch.htmlBody !== undefined ||
        patch.textBody !== undefined ||
        patch.blocksJson !== undefined
      ) {
        const latest = tpl.versions[tpl.versions.length - 1];
        const nextNum = (latest?.versionNumber ?? 0) + 1;
        const nextHtml = patch.htmlBody !== undefined ? sanitizeMarketingHtml(patch.htmlBody) : latest?.htmlBody ?? '';
        const nextText = patch.textBody !== undefined ? patch.textBody : htmlToPlainText(nextHtml);
        await client.query(
          `INSERT INTO template_versions (id, template_id, version_number, subject, preview_text, html_body, text_body, blocks_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            uuidv7(),
            id,
            nextNum,
            patch.subject ?? latest?.subject ?? 'Subject',
            patch.previewText ?? latest?.previewText ?? '',
            nextHtml,
            nextText,
            JSON.stringify(patch.blocksJson ?? latest?.blocksJson ?? []),
          ]
        );
        await client.query(`UPDATE templates SET active_version = $2 WHERE id = $1`, [id, nextNum]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return (await this.listTemplates(orgId, true)).find((t) => t.id === id) ?? null;
  }

  async duplicateTemplate(orgId: string, id: string): Promise<TemplateRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const all = await this.listTemplates(orgId, true);
    const orig = all.find((t) => t.id === id);
    if (!orig) return null;
    const latest = orig.versions[orig.versions.length - 1];
    return this.createTemplate({
      organizationId: orgId,
      name: `${orig.name} (Copy)`,
      category: orig.category,
      description: orig.description ?? '',
      subject: latest?.subject ?? '',
      previewText: latest?.previewText ?? '',
      htmlBody: latest?.htmlBody ?? '',
      textBody: latest?.textBody ?? '',
      blocksJson: latest?.blocksJson ?? [],
    });
  }

  async deleteTemplate(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM templates WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  // =========================================================================
  // Subscribers, Tags, Custom Fields & CSV Imports
  // =========================================================================
  async listContacts(orgId: string, tag?: string): Promise<SubscriberRecord[]> {
    const res = await this.pool.query(
      `SELECT c.id::text, c.organization_id::text, c.email::text, c.first_name, c.last_name, c.status,
              c.tags, c.attributes, c.consent_source, c.consented_at, c.unsubscribed_at,
              c.last_activity_at, c.engagement_score, c.created_at, c.updated_at
         FROM contacts c
        WHERE c.organization_id = $1
          AND ($2::text IS NULL OR LOWER($2) = ANY(SELECT LOWER(x) FROM unnest(c.tags) AS x))
        ORDER BY c.created_at DESC`,
      [orgId, tag ?? null]
    );
    return res.rows.map((r) => this.mapSubscriberRow(r));
  }

  async querySubscribers(orgId: string, params: SubscriberQueryParams) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 25));

    // When filtering by dynamic segmentId, evaluate segment safely against org contacts + activity
    if (params.segmentId) {
      const segs = await this.listSegments(orgId);
      const seg = segs.find((s) => s.id === params.segmentId);
      if (!seg) return { subscribers: [], total: 0, page, pageSize };
      const all = await this.listContacts(orgId);
      const act = await this.loadActivityLookup(orgId);
      let rows = all.filter((c) => evaluateSegmentForSubscriber(seg.matchType, seg.conditions, c, act));
      if (params.search) {
        const q = params.search.toLowerCase();
        rows = rows.filter((c) => c.email.toLowerCase().includes(q) || c.firstName.toLowerCase().includes(q) || c.lastName.toLowerCase().includes(q));
      }
      if (params.status) rows = rows.filter((c) => c.status === params.status);
      return {
        subscribers: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length,
        page,
        pageSize,
      };
    }

    const sortExpr =
      params.sort === 'oldest'
        ? 'c.created_at ASC'
        : params.sort === 'engagement'
          ? 'c.engagement_score DESC, c.created_at DESC'
          : params.sort === 'email'
            ? 'c.email ASC'
            : 'c.created_at DESC';

    const where = `
      WHERE c.organization_id = $1
        AND ($2::text IS NULL OR LOWER(c.email::text) LIKE $2 OR LOWER(COALESCE(c.first_name,'')) LIKE $2 OR LOWER(COALESCE(c.last_name,'')) LIKE $2)
        AND ($3::text IS NULL OR c.status = $3)
        AND ($4::text IS NULL OR EXISTS (
          SELECT 1 FROM subscriber_tags st JOIN tags t ON t.id = st.tag_id
           WHERE st.subscriber_id = c.id AND LOWER(t.name::text) = LOWER($4)
        ) OR LOWER($4) = ANY(SELECT LOWER(x) FROM unnest(c.tags) AS x))
        AND ($5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM subscriber_tags st WHERE st.subscriber_id = c.id AND st.tag_id = $5
        ))
        AND ($6::text IS NULL OR LOWER(c.consent_source) LIKE $6)
        AND ($7::text IS NULL OR (c.attributes ? $7 AND ($8::text IS NULL OR LOWER(COALESCE(c.attributes->>$7,'')) LIKE $8)))
    `;
    const args = [
      orgId,
      params.search ? `%${params.search.trim().toLowerCase()}%` : null,
      params.status ?? null,
      params.tag ?? null,
      params.tagId && UUID_RX.test(params.tagId) ? params.tagId : null,
      params.source ? `%${params.source.trim().toLowerCase()}%` : null,
      params.customFieldKey ?? null,
      params.customFieldValue ? `%${params.customFieldValue.trim().toLowerCase()}%` : null,
    ];

    const [cntRes, rowsRes] = await Promise.all([
      this.pool.query<{ cnt: string }>(`SELECT COUNT(*)::text AS cnt FROM contacts c ${where}`, args),
      this.pool.query(
        `SELECT c.id::text, c.organization_id::text, c.email::text, c.first_name, c.last_name, c.status,
                c.tags, c.attributes, c.consent_source, c.consented_at, c.unsubscribed_at,
                c.last_activity_at, c.engagement_score, c.created_at, c.updated_at
           FROM contacts c ${where}
          ORDER BY ${sortExpr}
          LIMIT $9 OFFSET $10`,
        [...args, pageSize, (page - 1) * pageSize]
      ),
    ]);

    return {
      subscribers: rowsRes.rows.map((r) => this.mapSubscriberRow(r)),
      total: Number(cntRes.rows[0]?.cnt ?? 0),
      page,
      pageSize,
    };
  }

  async upsertSubscriber(
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
  ): Promise<{ subscriber: SubscriberRecord; created: boolean }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.pool.query(`SELECT id::text, status FROM contacts WHERE organization_id = $1 AND LOWER(email::text) = $2 LIMIT 1`, [orgId, email]);
    const sup = await this.pool.query(
      `SELECT 1 FROM suppression_entries WHERE (organization_id = $1 OR organization_id IS NULL) AND LOWER(email::text) = $2 LIMIT 1`,
      [orgId, email]
    );
    const isSuppressed = (sup.rowCount ?? 0) > 0;
    const isNew = (existing.rowCount ?? 0) === 0;
    const desiredStatus: SubscriberStatus = isSuppressed ? 'unsubscribed' : input.status ?? 'subscribed';

    const rowRes = await this.pool.query(
      `INSERT INTO contacts (id, organization_id, email, first_name, last_name, status, attributes, consent_source, consented_at, unsubscribed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, COALESCE($9::timestamptz, NOW()), CASE WHEN $6 = 'unsubscribed' THEN NOW() ELSE NULL END)
       ON CONFLICT (organization_id, email) DO UPDATE
         SET first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), contacts.first_name),
             last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), contacts.last_name),
             attributes = contacts.attributes || EXCLUDED.attributes,
             updated_at = NOW()
       RETURNING id::text, organization_id::text, email::text, first_name, last_name, status,
                 tags, attributes, consent_source, consented_at, unsubscribed_at,
                 last_activity_at, engagement_score, created_at, updated_at`,
      [
        uuidv7(),
        orgId,
        email,
        input.firstName?.trim() || null,
        input.lastName?.trim() || null,
        desiredStatus,
        JSON.stringify(input.attributes ?? {}),
        input.consentSource,
        input.consentedAt ?? null,
      ]
    );

    const subId = String(rowRes.rows[0].id);
    if (input.tags && input.tags.length > 0) {
      await this.ensureTagsAndLink(orgId, subId, input.tags);
    }

    await this.pool.query(
      `INSERT INTO subscriber_events (id, organization_id, subscriber_id, event_type, source, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [uuidv7(), orgId, subId, isNew ? 'subscribed' : 'updated', input.consentSource, JSON.stringify({ tags: input.tags ?? [] })]
    );

    const finalRes = await this.pool.query(
      `SELECT id::text, organization_id::text, email::text, first_name, last_name, status,
              tags, attributes, consent_source, consented_at, unsubscribed_at,
              last_activity_at, engagement_score, created_at, updated_at
         FROM contacts WHERE id = $1`,
      [subId]
    );
    return { subscriber: this.mapSubscriberRow(finalRes.rows[0]), created: isNew };
  }

  async getSubscriberProfile(orgId: string, id: string): Promise<SubscriberProfileData | null> {
    if (!UUID_RX.test(id)) return null;
    const subRes = await this.pool.query(
      `SELECT id::text, organization_id::text, email::text, first_name, last_name, status,
              tags, attributes, consent_source, consented_at, unsubscribed_at,
              last_activity_at, engagement_score, created_at, updated_at
         FROM contacts WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [orgId, id]
    );
    if ((subRes.rowCount ?? 0) === 0) return null;
    const subscriber = this.mapSubscriberRow(subRes.rows[0]);

    const [evRes, delRes, actRes, supRes, seqRes, autoRes] = await Promise.all([
      this.pool.query(
        `SELECT id::text, event_type, source, detail, created_at
           FROM subscriber_events WHERE subscriber_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id]
      ),
      this.pool.query(
        `SELECT m.id::text AS message_id, m.subject, mr.state, mr.created_at
           FROM message_recipients mr
           JOIN messages m ON m.id = mr.message_id
          WHERE mr.organization_id = $1 AND LOWER(mr.recipient_email::text) = $2
          ORDER BY mr.created_at DESC LIMIT 30`,
        [orgId, subscriber.email.toLowerCase()]
      ),
      this.pool.query(
        `SELECT e.id::text, e.event_type, e.metadata->>'detail' AS detail, e.occurred_at
           FROM email_events e
           LEFT JOIN message_recipients mr ON mr.id = e.message_recipient_id
          WHERE e.organization_id = $1
            AND LOWER(COALESCE(mr.recipient_email::text, e.metadata->>'recipientEmail', '')) = $2
          ORDER BY e.occurred_at DESC LIMIT 50`,
        [orgId, subscriber.email.toLowerCase()]
      ),
      this.pool.query(
        `SELECT id::text, organization_id::text, email::text, reason, source, related_campaign_id::text, status, created_at
           FROM suppression_entries
          WHERE (organization_id = $1 OR organization_id IS NULL) AND LOWER(email::text) = $2
          LIMIT 1`,
        [orgId, subscriber.email.toLowerCase()]
      ),
      this.pool.query(
        `SELECT se.id::text, se.sequence_id::text, se.subscriber_id::text, se.current_step_index, se.status,
                se.next_send_at, se.last_sent_at, se.exited_reason, se.enrolled_at, se.completed_at
           FROM sequence_enrollments se
          WHERE se.organization_id = $1 AND se.subscriber_id = $2
          ORDER BY se.enrolled_at DESC`,
        [orgId, id]
      ),
      this.pool.query(
        `SELECT ar.id::text, ar.automation_id::text, ar.subscriber_id::text, ar.current_node_id, ar.status,
                ar.next_run_at, ar.started_at, ar.completed_at
           FROM automation_runs ar
          WHERE ar.organization_id = $1 AND ar.subscriber_id = $2
          ORDER BY ar.started_at DESC LIMIT 20`,
        [orgId, id]
      ),
    ]);

    return {
      subscriber,
      events: evRes.rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        source: r.source ?? null,
        detail: r.detail ?? {},
        createdAt: iso(r.created_at),
      })),
      deliveries: delRes.rows.map((r) => ({
        messageId: r.message_id,
        subject: r.subject,
        state: r.state,
        createdAt: iso(r.created_at),
      })),
      emailActivity: actRes.rows.map((r) => ({
        id: r.id,
        eventType: r.event_type as EmailEventType,
        detail: r.detail ?? null,
        createdAt: iso(r.occurred_at),
      })),
      enrollments: seqRes.rows.map((r) => ({
        id: r.id,
        sequenceId: r.sequence_id,
        subscriberId: r.subscriber_id,
        subscriberEmail: subscriber.email,
        currentStepIndex: Number(r.current_step_index),
        status: r.status,
        nextSendAt: isoOrNull(r.next_send_at),
        lastSentAt: isoOrNull(r.last_sent_at),
        exitedReason: r.exited_reason ?? null,
        enrolledAt: iso(r.enrolled_at),
        completedAt: isoOrNull(r.completed_at),
      })),
      automationRuns: autoRes.rows.map((r) => ({
        id: r.id,
        automationId: r.automation_id,
        subscriberId: r.subscriber_id,
        subscriberEmail: subscriber.email,
        currentNodeId: r.current_node_id ?? null,
        status: r.status,
        nextRunAt: isoOrNull(r.next_run_at),
        startedAt: iso(r.started_at),
        completedAt: isoOrNull(r.completed_at),
      })),
      suppression: supRes.rows[0]
        ? {
            id: supRes.rows[0].id,
            organizationId: supRes.rows[0].organization_id ?? orgId,
            email: supRes.rows[0].email,
            reason: supRes.rows[0].reason as SuppressionReason,
            source: supRes.rows[0].source ?? null,
            relatedCampaignId: supRes.rows[0].related_campaign_id ?? null,
            status: supRes.rows[0].status ?? 'active',
            createdAt: iso(supRes.rows[0].created_at),
          }
        : null,
    };
  }

  async updateSubscriber(
    orgId: string,
    id: string,
    patch: {
      firstName?: string | undefined;
      lastName?: string | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      addTags?: string[] | undefined;
      removeTags?: string[] | undefined;
    }
  ): Promise<SubscriberRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const upd = await this.pool.query(
      `UPDATE contacts
          SET first_name = COALESCE($3, first_name),
              last_name = COALESCE($4, last_name),
              attributes = CASE WHEN $5::jsonb IS NOT NULL THEN attributes || $5::jsonb ELSE attributes END,
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text`,
      [orgId, id, patch.firstName ?? null, patch.lastName ?? null, patch.attributes ? JSON.stringify(patch.attributes) : null]
    );
    if ((upd.rowCount ?? 0) === 0) return null;

    if (patch.addTags?.length) {
      await this.ensureTagsAndLink(orgId, id, patch.addTags);
      await this.pool.query(
        `INSERT INTO subscriber_events (id, organization_id, subscriber_id, event_type, source, detail)
         VALUES ($1, $2, $3, 'tags_added', 'manual', $4::jsonb)`,
        [uuidv7(), orgId, id, JSON.stringify({ tags: patch.addTags })]
      );
    }
    if (patch.removeTags?.length) {
      const lower = patch.removeTags.map((t) => t.toLowerCase());
      await this.pool.query(
        `DELETE FROM subscriber_tags st
          USING tags t
          WHERE st.tag_id = t.id AND st.subscriber_id = $1 AND t.organization_id = $2 AND LOWER(t.name::text) = ANY($3::text[])`,
        [id, orgId, lower]
      );
      await this.pool.query(
        `UPDATE contacts
            SET tags = COALESCE((
              SELECT array_agg(t.name::text ORDER BY t.name)
                FROM subscriber_tags st JOIN tags t ON t.id = st.tag_id
               WHERE st.subscriber_id = $1
            ), '{}'::text[]),
                updated_at = NOW()
          WHERE id = $1`,
        [id]
      );
    }

    const row = await this.pool.query(
      `SELECT id::text, organization_id::text, email::text, first_name, last_name, status,
              tags, attributes, consent_source, consented_at, unsubscribed_at,
              last_activity_at, engagement_score, created_at, updated_at
         FROM contacts WHERE id = $1`,
      [id]
    );
    return row.rows[0] ? this.mapSubscriberRow(row.rows[0]) : null;
  }

  async unsubscribeSubscriber(orgId: string, id: string, reason = 'manual_unsubscribe'): Promise<SubscriberRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE contacts
          SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, NOW()), updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, email::text, first_name, last_name, status,
                 tags, attributes, consent_source, consented_at, unsubscribed_at,
                 last_activity_at, engagement_score, created_at, updated_at`,
      [orgId, id]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const sub = this.mapSubscriberRow(res.rows[0]);
    await this.addSuppression(orgId, sub.email, 'unsubscribe', { source: reason });
    await this.pool.query(
      `UPDATE sequence_enrollments SET status = 'exited', exited_reason = 'unsubscribed', completed_at = NOW()
        WHERE subscriber_id = $1 AND status = 'active'`,
      [id]
    );
    await this.pool.query(
      `INSERT INTO subscriber_events (id, organization_id, subscriber_id, event_type, source)
       VALUES ($1, $2, $3, 'unsubscribed', $4)`,
      [uuidv7(), orgId, id, reason]
    );
    return sub;
  }

  async resubscribeSubscriber(orgId: string, id: string, consentSource: string): Promise<SubscriberRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE contacts
          SET status = 'subscribed', unsubscribed_at = NULL, consent_source = $3, consented_at = NOW(), updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, email::text, first_name, last_name, status,
                 tags, attributes, consent_source, consented_at, unsubscribed_at,
                 last_activity_at, engagement_score, created_at, updated_at`,
      [orgId, id, consentSource]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const sub = this.mapSubscriberRow(res.rows[0]);
    await this.pool.query(
      `DELETE FROM suppression_entries WHERE organization_id = $1 AND LOWER(email::text) = $2 AND reason = 'unsubscribe'`,
      [orgId, sub.email.toLowerCase()]
    );
    await this.pool.query(
      `INSERT INTO subscriber_events (id, organization_id, subscriber_id, event_type, source)
       VALUES ($1, $2, $3, 'resubscribed', $4)`,
      [uuidv7(), orgId, id, consentSource]
    );
    return sub;
  }

  async deleteSubscriber(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM contacts WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async bulkSubscribersAction(
    orgId: string,
    ids: string[],
    action: 'add_tag' | 'remove_tag' | 'unsubscribe' | 'delete',
    tagName?: string
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const id of ids) {
      if (action === 'add_tag' && tagName && (await this.updateSubscriber(orgId, id, { addTags: [tagName] }))) affected += 1;
      else if (action === 'remove_tag' && tagName && (await this.updateSubscriber(orgId, id, { removeTags: [tagName] }))) affected += 1;
      else if (action === 'unsubscribe' && (await this.unsubscribeSubscriber(orgId, id, 'bulk_action'))) affected += 1;
      else if (action === 'delete' && (await this.deleteSubscriber(orgId, id))) affected += 1;
    }
    return { affected };
  }

  async importContacts(
    orgId: string,
    rows: Array<{
      email: string;
      firstName?: string | undefined;
      lastName?: string | undefined;
      tags?: string[] | undefined;
      attributes?: Record<string, string | number | boolean | null> | undefined;
      consentSource: string;
    }>
  ): Promise<{ imported: number; updated: number; skippedSuppressed: number }> {
    const suppressedSet = new Set((await this.listSuppressions(orgId)).map((s) => s.email.toLowerCase()));
    let imported = 0;
    let updated = 0;
    let skippedSuppressed = 0;
    for (const row of rows) {
      const email = row.email.trim().toLowerCase();
      if (suppressedSet.has(email)) {
        skippedSuppressed += 1;
        continue;
      }
      const res = await this.upsertSubscriber(orgId, {
        email,
        firstName: row.firstName ?? '',
        lastName: row.lastName ?? '',
        tags: row.tags ?? [],
        attributes: row.attributes ?? {},
        consentSource: row.consentSource,
      });
      if (res.created) imported += 1;
      else updated += 1;
    }
    return { imported, updated, skippedSuppressed };
  }

  async createImportJob(
    orgId: string,
    input: { fileName: string | null; consentSource: string; defaultTags: string[]; fieldMapping: Record<string, string>; csvText: string }
  ): Promise<ContactImportJobItem> {
    const jobId = uuidv7();
    const { headers, rows } = parseCsvMatrix(input.csvText);
    const errors: Array<{ row: number; email: string; reason: string }> = [];
    const seenInFile = new Set<string>();
    const suppressedSet = new Set((await this.listSuppressions(orgId)).map((s) => s.email.toLowerCase()));

    let importedCount = 0;
    let updatedCount = 0;
    let skippedDuplicates = 0;
    let invalidCount = 0;
    let suppressedCount = 0;
    let missingConsentCount = 0;

    if (!input.consentSource || input.consentSource.trim().length < 2) {
      missingConsentCount = rows.length;
      errors.push({ row: 0, email: '', reason: 'Consent source is required' });
    } else {
      for (let idx = 0; idx < rows.length; idx += 1) {
        const cols = rows[idx]!;
        const rowMap: Record<string, string> = {};
        headers.forEach((h, hIdx) => {
          const mapped = input.fieldMapping[h] ?? h.toLowerCase();
          rowMap[mapped] = cols[hIdx] ?? '';
        });
        const email = (rowMap.email ?? '').trim().toLowerCase();
        if (!email || !emailAddressSchema.safeParse(email).success) {
          invalidCount += 1;
          errors.push({ row: idx + 2, email: email || '(blank)', reason: 'Invalid email syntax' });
          continue;
        }
        if (seenInFile.has(email)) {
          skippedDuplicates += 1;
          errors.push({ row: idx + 2, email, reason: 'Duplicate email in CSV' });
          continue;
        }
        seenInFile.add(email);
        if (suppressedSet.has(email)) {
          suppressedCount += 1;
          errors.push({ row: idx + 2, email, reason: 'Suppressed address' });
          continue;
        }
        const rowTags = (rowMap.tags ?? '').split(/[|;]/).map((s) => s.trim()).filter(Boolean);
        const mergedTags = [...new Set([...input.defaultTags, ...rowTags])];
        const attrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(rowMap)) {
          if (!['email', 'firstname', 'first_name', 'lastname', 'last_name', 'tags'].includes(k.toLowerCase()) && v) {
            attrs[k] = v;
          }
        }
        const res = await this.upsertSubscriber(orgId, {
          email,
          firstName: rowMap.firstName ?? rowMap.firstname ?? rowMap.first_name ?? '',
          lastName: rowMap.lastName ?? rowMap.lastname ?? rowMap.last_name ?? '',
          tags: mergedTags,
          attributes: attrs,
          consentSource: input.consentSource,
        });
        if (res.created) importedCount += 1;
        else updatedCount += 1;
      }
    }

    const res = await this.pool.query(
      `INSERT INTO contact_import_jobs (
         id, organization_id, status, file_name, consent_source, default_tags, field_mapping,
         total_rows, imported_count, updated_count, skipped_duplicates, invalid_count,
         suppressed_count, missing_consent_count, failed_count, error_report, completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW())
       RETURNING id::text, organization_id::text, status, file_name, consent_source, total_rows,
                 imported_count, updated_count, skipped_duplicates, invalid_count, suppressed_count,
                 missing_consent_count, failed_count, error_report, created_at, completed_at`,
      [
        jobId,
        orgId,
        missingConsentCount > 0 ? 'failed' : 'completed',
        input.fileName,
        input.consentSource,
        input.defaultTags,
        JSON.stringify(input.fieldMapping),
        rows.length,
        importedCount,
        updatedCount,
        skippedDuplicates,
        invalidCount,
        suppressedCount,
        missingConsentCount,
        invalidCount + missingConsentCount,
        JSON.stringify(errors.slice(0, 500)),
      ]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      status: r.status,
      fileName: r.file_name,
      consentSource: r.consent_source,
      totalRows: Number(r.total_rows),
      importedCount: Number(r.imported_count),
      updatedCount: Number(r.updated_count),
      skippedDuplicates: Number(r.skipped_duplicates),
      invalidCount: Number(r.invalid_count),
      suppressedCount: Number(r.suppressed_count),
      missingConsentCount: Number(r.missing_consent_count),
      failedCount: Number(r.failed_count),
      errorReport: r.error_report ?? [],
      createdAt: iso(r.created_at),
      completedAt: isoOrNull(r.completed_at),
    };
  }

  async getImportJob(orgId: string, jobId: string): Promise<ContactImportJobItem | null> {
    if (!UUID_RX.test(jobId)) return null;
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, status, file_name, consent_source, total_rows,
              imported_count, updated_count, skipped_duplicates, invalid_count, suppressed_count,
              missing_consent_count, failed_count, error_report, created_at, completed_at
         FROM contact_import_jobs WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [orgId, jobId]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      organizationId: r.organization_id,
      status: r.status,
      fileName: r.file_name,
      consentSource: r.consent_source,
      totalRows: Number(r.total_rows),
      importedCount: Number(r.imported_count),
      updatedCount: Number(r.updated_count),
      skippedDuplicates: Number(r.skipped_duplicates),
      invalidCount: Number(r.invalid_count),
      suppressedCount: Number(r.suppressed_count),
      missingConsentCount: Number(r.missing_consent_count),
      failedCount: Number(r.failed_count),
      errorReport: r.error_report ?? [],
      createdAt: iso(r.created_at),
      completedAt: isoOrNull(r.completed_at),
    };
  }

  async listImportJobs(orgId: string): Promise<ContactImportJobItem[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, status, file_name, consent_source, total_rows,
              imported_count, updated_count, skipped_duplicates, invalid_count, suppressed_count,
              missing_consent_count, failed_count, error_report, created_at, completed_at
         FROM contact_import_jobs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      status: r.status,
      fileName: r.file_name,
      consentSource: r.consent_source,
      totalRows: Number(r.total_rows),
      importedCount: Number(r.imported_count),
      updatedCount: Number(r.updated_count),
      skippedDuplicates: Number(r.skipped_duplicates),
      invalidCount: Number(r.invalid_count),
      suppressedCount: Number(r.suppressed_count),
      missingConsentCount: Number(r.missing_consent_count),
      failedCount: Number(r.failed_count),
      errorReport: r.error_report ?? [],
      createdAt: iso(r.created_at),
      completedAt: isoOrNull(r.completed_at),
    }));
  }

  // =========================================================================
  // Tags & Custom Fields
  // =========================================================================
  async listTags(orgId: string): Promise<TagItem[]> {
    const res = await this.pool.query(
      `SELECT t.id::text, t.organization_id::text, t.name::text, t.description, t.color, t.created_at, t.updated_at,
              COUNT(st.subscriber_id)::int AS subscriber_count
         FROM tags t
         LEFT JOIN subscriber_tags st ON st.tag_id = t.id
        WHERE t.organization_id = $1
        GROUP BY t.id
        ORDER BY t.name ASC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      description: r.description ?? '',
      color: r.color ?? '#2563eb',
      subscriberCount: Number(r.subscriber_count ?? 0),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  }

  async createTag(orgId: string, input: { name: string; description?: string; color?: string }): Promise<TagItem> {
    const exists = await this.pool.query(`SELECT 1 FROM tags WHERE organization_id = $1 AND name = $2::citext LIMIT 1`, [orgId, input.name.trim()]);
    if ((exists.rowCount ?? 0) > 0) throw new AppError(409, 'TAG_EXISTS', `Tag "${input.name}" already exists`);
    const res = await this.pool.query(
      `INSERT INTO tags (id, organization_id, name, description, color)
       VALUES ($1, $2, $3::citext, $4, $5)
       RETURNING id::text, organization_id::text, name::text, description, color, created_at, updated_at`,
      [uuidv7(), orgId, input.name.trim(), input.description ?? '', input.color ?? '#2563eb']
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      description: r.description,
      color: r.color,
      subscriberCount: 0,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async updateTag(orgId: string, id: string, patch: { name?: string | undefined; description?: string | undefined; color?: string | undefined }): Promise<TagItem | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE tags
          SET name = COALESCE($3::citext, name),
              description = COALESCE($4, description),
              color = COALESCE($5, color),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text`,
      [orgId, id, patch.name?.trim() ?? null, patch.description ?? null, patch.color ?? null]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    if (patch.name) {
      await this.pool.query(
        `UPDATE contacts c
            SET tags = COALESCE((
              SELECT array_agg(t.name::text ORDER BY t.name)
                FROM subscriber_tags st JOIN tags t ON t.id = st.tag_id
               WHERE st.subscriber_id = c.id
            ), '{}'::text[])
          WHERE c.id IN (SELECT subscriber_id FROM subscriber_tags WHERE tag_id = $1)`,
        [id]
      );
    }
    return (await this.listTags(orgId)).find((t) => t.id === id) ?? null;
  }

  async deleteTag(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const subsRes = await this.pool.query<{ subscriber_id: string }>(`SELECT subscriber_id::text FROM subscriber_tags WHERE tag_id = $1`, [id]);
    const res = await this.pool.query(`DELETE FROM tags WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    if ((res.rowCount ?? 0) === 0) return false;
    const subIds = subsRes.rows.map((r) => r.subscriber_id);
    if (subIds.length > 0) {
      await this.pool.query(
        `UPDATE contacts c
            SET tags = COALESCE((
              SELECT array_agg(t.name::text ORDER BY t.name)
                FROM subscriber_tags st JOIN tags t ON t.id = st.tag_id
               WHERE st.subscriber_id = c.id
            ), '{}'::text[])
          WHERE c.id = ANY($1::uuid[])`,
        [subIds]
      );
    }
    return true;
  }

  async listCustomFields(orgId: string): Promise<CustomFieldDef[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, field_key, label, field_type, description, created_at
         FROM custom_fields WHERE organization_id = $1 ORDER BY label ASC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      fieldKey: r.field_key,
      label: r.label,
      fieldType: r.field_type,
      description: r.description ?? '',
      createdAt: iso(r.created_at),
    }));
  }

  async createCustomField(
    orgId: string,
    input: { fieldKey: string; label: string; fieldType: 'text' | 'number' | 'date' | 'boolean'; description?: string }
  ): Promise<CustomFieldDef> {
    const res = await this.pool.query(
      `INSERT INTO custom_fields (id, organization_id, field_key, label, field_type, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text, organization_id::text, field_key, label, field_type, description, created_at`,
      [uuidv7(), orgId, input.fieldKey, input.label, input.fieldType, input.description ?? '']
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      fieldKey: r.field_key,
      label: r.label,
      fieldType: r.field_type,
      description: r.description ?? '',
      createdAt: iso(r.created_at),
    };
  }

  async deleteCustomField(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM custom_fields WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  // =========================================================================
  // Dynamic Segments
  // =========================================================================
  async listSegments(orgId: string): Promise<SegmentItem[]> {
    const [segRes, subs, act] = await Promise.all([
      this.pool.query(
        `SELECT id::text, organization_id::text, name, description, match_type, conditions, created_at, updated_at
           FROM segments WHERE organization_id = $1 ORDER BY created_at DESC`,
        [orgId]
      ),
      this.listContacts(orgId),
      this.loadActivityLookup(orgId),
    ]);
    return segRes.rows.map((r) => {
      const conditions = (r.conditions ?? []) as Array<SegmentConditionRule | SegmentConditionGroup>;
      const matchType = (r.match_type === 'any' ? 'any' : 'all') as 'all' | 'any';
      return {
        id: r.id,
        organizationId: r.organization_id,
        name: r.name,
        description: r.description ?? '',
        matchType,
        conditions,
        subscriberCount: subs.filter((c) => evaluateSegmentForSubscriber(matchType, conditions, c, act)).length,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
      };
    });
  }

  async createSegment(
    orgId: string,
    input: { name: string; description?: string; matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }
  ): Promise<SegmentItem> {
    const res = await this.pool.query(
      `INSERT INTO segments (id, organization_id, name, description, match_type, conditions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id::text, organization_id::text, name, description, match_type, conditions, created_at, updated_at`,
      [uuidv7(), orgId, input.name, input.description ?? '', input.matchType, JSON.stringify(input.conditions)]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      description: r.description ?? '',
      matchType: r.match_type,
      conditions: r.conditions ?? [],
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async updateSegment(
    orgId: string,
    id: string,
    patch: { name?: string | undefined; description?: string | undefined; matchType?: 'all' | 'any' | undefined; conditions?: Array<SegmentConditionRule | SegmentConditionGroup> | undefined }
  ): Promise<SegmentItem | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE segments
          SET name = COALESCE($3, name),
              description = COALESCE($4, description),
              match_type = COALESCE($5, match_type),
              conditions = COALESCE($6::jsonb, conditions),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, name, description, match_type, conditions, created_at, updated_at`,
      [
        orgId,
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.matchType ?? null,
        patch.conditions ? JSON.stringify(patch.conditions) : null,
      ]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      description: r.description ?? '',
      matchType: r.match_type,
      conditions: r.conditions ?? [],
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async deleteSegment(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM segments WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async previewSegment(
    orgId: string,
    input: { matchType: 'all' | 'any'; conditions: Array<SegmentConditionRule | SegmentConditionGroup> }
  ): Promise<{ count: number; sample: SubscriberRecord[] }> {
    const [subs, act] = await Promise.all([this.listContacts(orgId), this.loadActivityLookup(orgId)]);
    const matched = subs.filter((c) => evaluateSegmentForSubscriber(input.matchType, input.conditions, c, act));
    return { count: matched.length, sample: matched.slice(0, 15) };
  }

  // =========================================================================
  // Broadcasts (`campaigns`) + Snapshot & Analytics
  // =========================================================================
  async estimateBroadcastAudience(
    orgId: string,
    spec: AudienceSelectionSpec
  ): Promise<{ estimate: AudienceEstimate; eligible: SubscriberRecord[] }> {
    const [allSubs, sups, allTags, segs, act] = await Promise.all([
      this.listContacts(orgId),
      this.listSuppressions(orgId),
      this.listTags(orgId),
      this.listSegments(orgId),
      this.loadActivityLookup(orgId),
    ]);
    const tagById = new Map(allTags.map((t) => [t.id, t.name.toLowerCase()]));
    const segById = new Map(segs.map((s) => [s.id, s]));
    const suppressedSet = new Set(sups.map((s) => s.email.toLowerCase()));

    let candidateSet = allSubs;
    if (spec.mode === 'filtered') {
      const incTags = new Set(
        [...(spec.includeTags ?? []).map((t) => t.toLowerCase()), ...(spec.includeTagIds ?? []).map((id) => tagById.get(id) ?? '')].filter(Boolean)
      );
      const incSegs = (spec.includeSegmentIds ?? []).map((id) => segById.get(id)).filter((s): s is SegmentItem => Boolean(s));
      const explicitIds = new Set(spec.subscriberIds ?? []);
      if (incTags.size > 0 || incSegs.length > 0 || explicitIds.size > 0) {
        candidateSet = allSubs.filter(
          (c) =>
            explicitIds.has(c.id) ||
            c.tags.some((t) => incTags.has(t.toLowerCase())) ||
            incSegs.some((s) => evaluateSegmentForSubscriber(s.matchType, s.conditions, c, act))
        );
      }
    }

    const excTags = new Set(
      [...(spec.excludeTags ?? []).map((t) => t.toLowerCase()), ...(spec.excludeTagIds ?? []).map((id) => tagById.get(id) ?? '')].filter(Boolean)
    );
    const excSegs = (spec.excludeSegmentIds ?? []).map((id) => segById.get(id)).filter((s): s is SegmentItem => Boolean(s));

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

  private mapCampaignRow(r: Record<string, unknown>): CampaignRecord {
    const tf = (r.target_filter ?? {}) as { templateId?: string; tagFilter?: string | null };
    const sc = (r.stats_cache ?? {}) as { targetCount?: number; sentCount?: number };
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      domainId: String(r.domain_id),
      templateId: tf.templateId ?? (r.template_version_id ? String(r.template_version_id) : ''),
      name: String(r.name),
      status: r.status as CampaignRecord['status'],
      fromName: String(r.from_name ?? ''),
      fromEmail: (r.from_email as string | null) ?? null,
      replyTo: (r.reply_to as string | null) ?? null,
      subject: (r.subject as string | null) ?? null,
      previewText: String(r.preview_text ?? ''),
      htmlBody: (r.html_body as string | null) ?? null,
      textBody: (r.text_body as string | null) ?? null,
      blocksJson: Array.isArray(r.blocks_json) ? (r.blocks_json as EmailTemplateBlock[]) : [],
      audienceSpec: (r.audience_spec ?? { mode: tf.tagFilter ? 'filtered' : 'all', includeTags: tf.tagFilter ? [tf.tagFilter] : [] }) as AudienceSelectionSpec,
      timezone: String(r.timezone ?? 'UTC'),
      scheduledAt: isoOrNull(r.scheduled_at),
      tagFilter: tf.tagFilter ?? null,
      targetCount: Number(sc.targetCount ?? 0),
      sentCount: Number(sc.sentCount ?? 0),
      dispatchedAt: isoOrNull(r.dispatched_at),
      completedAt: isoOrNull(r.completed_at),
      failureReason: (r.failure_reason as string | null) ?? null,
      createdAt: iso(r.created_at),
    };
  }

  async listCampaigns(orgId: string): Promise<CampaignRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, template_version_id::text, name,
              status, from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
              blocks_json, audience_spec, timezone, scheduled_at, dispatched_at, completed_at,
              failure_reason, target_filter, stats_cache, created_at
         FROM campaigns WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => this.mapCampaignRow(r));
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
    if (!UUID_RX.test(input.domainId)) {
      throw new AppError(400, 'INVALID_DOMAIN', 'Select a valid registered sending domain');
    }
    const domCheck = await this.pool.query(
      `SELECT 1 FROM domains WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [input.organizationId, input.domainId]
    );
    if ((domCheck.rowCount ?? 0) === 0) {
      throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Selected domain does not belong to your organization');
    }

    let tvId: string | null = null;
    let tplSubject: string | null = null;
    let tplHtml: string | null = null;
    let tplText: string | null = null;
    let tplPreview = '';
    let tplBlocks: EmailTemplateBlock[] = [];

    if (input.templateId && UUID_RX.test(input.templateId)) {
      const tvRes = await this.pool.query(
        `SELECT tv.id::text, tv.subject, tv.preview_text, tv.html_body, tv.text_body, tv.blocks_json
           FROM template_versions tv
           JOIN templates t ON t.id = tv.template_id
          WHERE t.organization_id = $1 AND t.id = $2
          ORDER BY tv.version_number DESC LIMIT 1`,
        [input.organizationId, input.templateId]
      );
      if ((tvRes.rowCount ?? 0) === 0) {
        throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Selected template was not found');
      }
      const r = tvRes.rows[0];
      tvId = r.id;
      tplSubject = r.subject;
      tplPreview = r.preview_text ?? '';
      tplHtml = r.html_body;
      tplText = r.text_body;
      tplBlocks = r.blocks_json ?? [];
    }

    const effectiveSpec: AudienceSelectionSpec =
      input.audienceSpec ?? (input.tagFilter ? { mode: 'filtered', includeTags: [input.tagFilter] } : { mode: 'all' });
    const { estimate } = await this.estimateBroadcastAudience(input.organizationId, effectiveSpec);

    const status: CampaignRecord['status'] = input.scheduledAt ? 'scheduled' : 'draft';
    const id = uuidv7();
    const html = input.htmlBody ?? tplHtml;
    const sanitizedHtml = html ? sanitizeMarketingHtml(html) : null;

    const res = await this.pool.query(
      `INSERT INTO campaigns (
         id, organization_id, domain_id, template_version_id, name, status,
         from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
         blocks_json, audience_spec, timezone, scheduled_at, target_filter, stats_cache
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18::jsonb,$19::jsonb)
       RETURNING id::text, organization_id::text, domain_id::text, template_version_id::text, name,
                 status, from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
                 blocks_json, audience_spec, timezone, scheduled_at, dispatched_at, completed_at,
                 failure_reason, target_filter, stats_cache, created_at`,
      [
        id,
        input.organizationId,
        input.domainId,
        tvId,
        input.name,
        status,
        input.fromName ?? '',
        input.fromEmail ?? null,
        input.replyTo ?? null,
        input.subject ?? tplSubject,
        input.previewText ?? tplPreview,
        sanitizedHtml,
        input.textBody ?? tplText,
        JSON.stringify(input.blocksJson ?? tplBlocks),
        JSON.stringify(effectiveSpec),
        input.timezone,
        input.scheduledAt,
        JSON.stringify({ templateId: input.templateId, tagFilter: input.tagFilter }),
        JSON.stringify({ targetCount: estimate.eligibleCount, sentCount: 0 }),
      ]
    );
    return this.mapCampaignRow(res.rows[0]);
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
    }>
  ): Promise<CampaignRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const existing = (await this.listCampaigns(orgId)).find((c) => c.id === id);
    if (!existing) return null;
    if (existing.status === 'completed' || existing.status === 'sending' || existing.status === 'running') {
      throw new AppError(400, 'CAMPAIGN_LOCKED', 'Cannot edit a campaign after sending has started');
    }

    let nextTargetCount = existing.targetCount;
    if (patch.audienceSpec) {
      nextTargetCount = (await this.estimateBroadcastAudience(orgId, patch.audienceSpec)).estimate.eligibleCount;
    }

    const res = await this.pool.query(
      `UPDATE campaigns
          SET domain_id = COALESCE($3::uuid, domain_id),
              name = COALESCE($4, name),
              from_name = COALESCE($5, from_name),
              from_email = CASE WHEN $6::boolean THEN $7 ELSE from_email END,
              reply_to = CASE WHEN $8::boolean THEN $9 ELSE reply_to END,
              subject = CASE WHEN $10::boolean THEN $11 ELSE subject END,
              preview_text = COALESCE($12, preview_text),
              html_body = CASE WHEN $13::boolean THEN $14 ELSE html_body END,
              text_body = CASE WHEN $15::boolean THEN $16 ELSE text_body END,
              blocks_json = COALESCE($17::jsonb, blocks_json),
              audience_spec = COALESCE($18::jsonb, audience_spec),
              timezone = COALESCE($19, timezone),
              scheduled_at = CASE WHEN $20::boolean THEN $21::timestamptz ELSE scheduled_at END,
              status = COALESCE($22, status),
              stats_cache = jsonb_set(COALESCE(stats_cache, '{}'::jsonb), '{targetCount}', to_jsonb($23::int)),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, domain_id::text, template_version_id::text, name,
                 status, from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
                 blocks_json, audience_spec, timezone, scheduled_at, dispatched_at, completed_at,
                 failure_reason, target_filter, stats_cache, created_at`,
      [
        orgId,
        id,
        patch.domainId && UUID_RX.test(patch.domainId) ? patch.domainId : null,
        patch.name ?? null,
        patch.fromName ?? null,
        patch.fromEmail !== undefined,
        patch.fromEmail ?? null,
        patch.replyTo !== undefined,
        patch.replyTo ?? null,
        patch.subject !== undefined,
        patch.subject ?? null,
        patch.previewText ?? null,
        patch.htmlBody !== undefined,
        patch.htmlBody ? sanitizeMarketingHtml(patch.htmlBody) : null,
        patch.textBody !== undefined,
        patch.textBody ?? null,
        patch.blocksJson ? JSON.stringify(patch.blocksJson) : null,
        patch.audienceSpec ? JSON.stringify(patch.audienceSpec) : null,
        patch.timezone ?? null,
        patch.scheduledAt !== undefined,
        patch.scheduledAt ?? null,
        patch.status ?? null,
        nextTargetCount,
      ]
    );
    return res.rows[0] ? this.mapCampaignRow(res.rows[0]) : null;
  }

  async deleteCampaign(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    await this.pool.query(`UPDATE messages SET campaign_id = NULL WHERE organization_id = $1 AND campaign_id = $2`, [orgId, id]);
    const res = await this.pool.query(`DELETE FROM campaigns WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async transitionCampaign(orgId: string, id: string, status: CampaignRecord['status']): Promise<CampaignRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const cur = (await this.listCampaigns(orgId)).find((c) => c.id === id);
    if (!cur) return null;
    if ((cur.status === 'completed' || cur.status === 'cancelled') && status === 'running') {
      throw new AppError(400, 'INVALID_TRANSITION', `Cannot restart a ${cur.status} broadcast`);
    }
    const res = await this.pool.query(
      `UPDATE campaigns
          SET status = $3,
              dispatched_at = CASE WHEN $3 IN ('running', 'sending') THEN COALESCE(dispatched_at, NOW()) ELSE dispatched_at END,
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, domain_id::text, template_version_id::text, name,
                 status, from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
                 blocks_json, audience_spec, timezone, scheduled_at, dispatched_at, completed_at,
                 failure_reason, target_filter, stats_cache, created_at`,
      [orgId, id, status]
    );
    return res.rows[0] ? this.mapCampaignRow(res.rows[0]) : null;
  }

  async markCampaignDispatched(orgId: string, id: string, sentCount: number, failureReason?: string): Promise<CampaignRecord | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE campaigns
          SET status = $4,
              failure_reason = $5,
              completed_at = NOW(),
              stats_cache = jsonb_set(
                COALESCE(stats_cache, '{}'::jsonb),
                '{sentCount}',
                to_jsonb(COALESCE((stats_cache->>'sentCount')::int, 0) + $3)
              ),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, domain_id::text, template_version_id::text, name,
                 status, from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
                 blocks_json, audience_spec, timezone, scheduled_at, dispatched_at, completed_at,
                 failure_reason, target_filter, stats_cache, created_at`,
      [orgId, id, sentCount, failureReason ? 'failed' : 'completed', failureReason ?? null]
    );
    return res.rows[0] ? this.mapCampaignRow(res.rows[0]) : null;
  }

  async snapshotCampaignRecipients(orgId: string, campaignId: string, eligible: SubscriberRecord[]): Promise<void> {
    if (!UUID_RX.test(campaignId) || eligible.length === 0) return;
    for (const s of eligible) {
      await this.pool.query(
        `INSERT INTO campaign_recipients (id, campaign_id, organization_id, subscriber_id, recipient_email, status)
         VALUES ($1, $2, $3, $4, $5::citext, 'pending')
         ON CONFLICT (campaign_id, recipient_email) DO NOTHING`,
        [uuidv7(), campaignId, orgId, UUID_RX.test(s.id) ? s.id : null, s.email.toLowerCase()]
      );
    }
  }

  async markCampaignRecipientStatus(
    campaignId: string,
    recipientEmail: string,
    status: 'pending' | 'queued' | 'sent' | 'cancelled' | 'failed',
    messageId?: string
  ): Promise<void> {
    if (!UUID_RX.test(campaignId)) return;
    await this.pool.query(
      `UPDATE campaign_recipients
          SET status = $3,
              message_id = COALESCE($4::uuid, message_id),
              updated_at = NOW()
        WHERE campaign_id = $1 AND LOWER(recipient_email::text) = $2`,
      [campaignId, recipientEmail.toLowerCase(), status, messageId && UUID_RX.test(messageId) ? messageId : null]
    );
  }

  async cancelBroadcastRecipients(orgId: string, campaignId: string): Promise<{ cancelledCount: number; handedOffCount: number }> {
    if (!UUID_RX.test(campaignId)) return { cancelledCount: 0, handedOffCount: 0 };
    const updPending = await this.pool.query(
      `UPDATE campaign_recipients SET status = 'cancelled', updated_at = NOW()
        WHERE organization_id = $1 AND campaign_id = $2 AND status = 'pending'`,
      [orgId, campaignId]
    );
    // Also cancel still-queued unpublished outbox jobs & queued recipients before MTA handoff
    await this.pool.query(
      `UPDATE outbox_events SET status = 'failed'
        WHERE status = 'pending' AND aggregate_id IN (SELECT id FROM messages WHERE organization_id = $1 AND campaign_id = $2)`,
      [orgId, campaignId]
    );
    const handed = await this.pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM campaign_recipients WHERE organization_id = $1 AND campaign_id = $2 AND status IN ('queued', 'sent')`,
      [orgId, campaignId]
    );
    return {
      cancelledCount: updPending.rowCount ?? 0,
      handedOffCount: Number(handed.rows[0]?.cnt ?? 0),
    };
  }

  async getBroadcastAnalytics(orgId: string, campaignId: string): Promise<BroadcastAnalyticsSummary | null> {
    if (!UUID_RX.test(campaignId)) return null;
    const c = (await this.listCampaigns(orgId)).find((x) => x.id === campaignId);
    if (!c) return null;

    const [snapRes, evAggRes, linkRes, recentRes] = await Promise.all([
      this.pool.query<{ status: string; cnt: number }>(
        `SELECT status, COUNT(*)::int AS cnt FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status`,
        [campaignId]
      ),
      this.pool.query<{ event_type: EmailEventType; cnt: number; uniq: number }>(
        `SELECT e.event_type, COUNT(*)::int AS cnt,
                COUNT(DISTINCT LOWER(COALESCE(r.recipient_email::text, e.metadata->>'recipientEmail', e.id::text)))::int AS uniq
           FROM email_events e
           LEFT JOIN message_recipients r ON r.id = e.message_recipient_id
          WHERE e.organization_id = $1
            AND (e.campaign_id = $2 OR e.metadata->>'campaignId' = $2::text)
          GROUP BY e.event_type`,
        [orgId, campaignId]
      ),
      this.pool.query<{ url: string; clicks: number; uniq: number }>(
        `SELECT metadata->>'detail' AS url, COUNT(*)::int AS clicks,
                COUNT(DISTINCT LOWER(COALESCE(metadata->>'recipientEmail', id::text)))::int AS uniq
           FROM email_events
          WHERE organization_id = $1 AND event_type = 'clicked'
            AND (campaign_id = $2 OR metadata->>'campaignId' = $2::text)
            AND COALESCE(metadata->>'detail', '') <> ''
          GROUP BY 1
          ORDER BY clicks DESC LIMIT 10`,
        [orgId, campaignId]
      ),
      this.pool.query<{ id: string; recipient_email: string; event_type: EmailEventType; detail: string | null; occurred_at: Date }>(
        `SELECT e.id::text, COALESCE(r.recipient_email::text, e.metadata->>'recipientEmail', 'unknown') AS recipient_email,
                e.event_type, e.metadata->>'detail' AS detail, e.occurred_at
           FROM email_events e
           LEFT JOIN message_recipients r ON r.id = e.message_recipient_id
          WHERE e.organization_id = $1 AND (e.campaign_id = $2 OR e.metadata->>'campaignId' = $2::text)
          ORDER BY e.occurred_at DESC LIMIT 25`,
        [orgId, campaignId]
      ),
    ]);

    const snapCounts: Record<string, number> = {};
    let eligibleRecipients = 0;
    for (const s of snapRes.rows) {
      snapCounts[s.status] = Number(s.cnt);
      eligibleRecipients += Number(s.cnt);
    }

    const evMap = new Map(evAggRes.rows.map((r) => [r.event_type, { cnt: Number(r.cnt), uniq: Number(r.uniq) }]));
    const delivered = (evMap.get('delivered')?.cnt ?? 0) + (evMap.get('accepted')?.cnt ?? 0);
    return {
      campaignId,
      totalTargeted: c.targetCount,
      eligibleRecipients: eligibleRecipients || c.targetCount,
      queued: (snapCounts.pending ?? 0) + (snapCounts.queued ?? 0),
      sent: c.sentCount,
      acceptedRemote: delivered,
      delivered,
      opens: evMap.get('opened')?.cnt ?? 0,
      uniqueOpens: evMap.get('opened')?.uniq ?? 0,
      clicks: evMap.get('clicked')?.cnt ?? 0,
      uniqueClicks: evMap.get('clicked')?.uniq ?? 0,
      bounces: evMap.get('bounced')?.cnt ?? 0,
      complaints: evMap.get('complained')?.cnt ?? 0,
      unsubscribes: evMap.get('unsubscribed')?.cnt ?? 0,
      failed: snapCounts.failed ?? 0,
      cancelled: snapCounts.cancelled ?? 0,
      topLinks: linkRes.rows.map((l) => ({ url: l.url, clicks: Number(l.clicks), uniqueClicks: Number(l.uniq) })),
      recentActivity: recentRes.rows.map((r) => ({
        id: r.id,
        recipientEmail: r.recipient_email,
        eventType: r.event_type,
        detail: r.detail ?? null,
        occurredAt: iso(r.occurred_at),
      })),
    };
  }

  async listDueScheduledCampaigns(): Promise<CampaignRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, domain_id::text, template_version_id::text, name,
              status, from_name, from_email, reply_to, subject, preview_text, html_body, text_body,
              blocks_json, audience_spec, timezone, scheduled_at, dispatched_at, completed_at,
              failure_reason, target_filter, stats_cache, created_at
         FROM campaigns
        WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
        LIMIT 20`
    );
    return res.rows.map((r) => this.mapCampaignRow(r));
  }

  // =========================================================================
  // Suppressions
  // =========================================================================
  async listSuppressions(orgId: string): Promise<SuppressionRecord[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, email::text, reason, source, related_campaign_id::text, status, created_at
         FROM suppression_entries
        WHERE organization_id = $1 OR organization_id IS NULL
        ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id ?? orgId,
      email: r.email,
      reason: r.reason as SuppressionReason,
      source: r.source ?? null,
      relatedCampaignId: r.related_campaign_id ?? null,
      status: r.status ?? 'active',
      createdAt: iso(r.created_at),
    }));
  }

  async addSuppression(
    orgId: string,
    email: string,
    reason: SuppressionReason,
    opts?: { source?: string; relatedCampaignId?: string }
  ): Promise<SuppressionRecord> {
    const lower = email.trim().toLowerCase();
    const res = await this.pool.query(
      `INSERT INTO suppression_entries (id, organization_id, email, reason, source, related_campaign_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::UUID), email)
       DO UPDATE SET reason = EXCLUDED.reason, source = COALESCE(EXCLUDED.source, suppression_entries.source)
       RETURNING id::text, organization_id::text, email::text, reason, source, related_campaign_id::text, status, created_at`,
      [
        uuidv7(),
        orgId,
        lower,
        reason,
        opts?.source ?? null,
        opts?.relatedCampaignId && UUID_RX.test(opts.relatedCampaignId) ? opts.relatedCampaignId : null,
      ]
    );
    const nextContactStatus =
      reason === 'complaint' ? 'complained' : reason === 'hard_bounce' ? 'bounced' : 'unsubscribed';
    await this.pool.query(
      `UPDATE contacts
          SET status = $3,
              unsubscribed_at = CASE WHEN $3 = 'unsubscribed' THEN COALESCE(unsubscribed_at, NOW()) ELSE unsubscribed_at END,
              updated_at = NOW()
        WHERE organization_id = $1 AND LOWER(email::text) = $2`,
      [orgId, lower, nextContactStatus]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      email: r.email,
      reason: r.reason as SuppressionReason,
      source: r.source ?? null,
      relatedCampaignId: r.related_campaign_id ?? null,
      status: r.status ?? 'active',
      createdAt: iso(r.created_at),
    };
  }

  async removeSuppression(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM suppression_entries WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  // =========================================================================
  // Email Sequences
  // =========================================================================
  async listSequences(orgId: string): Promise<EmailSequenceItem[]> {
    const seqRes = await this.pool.query(
      `SELECT s.id::text, s.organization_id::text, s.domain_id::text, s.name, s.description, s.from_name,
              s.from_email, s.reply_to, s.enabled, s.allow_reentry, s.exit_on_unsubscribe, s.created_at, s.updated_at,
              (SELECT COUNT(*)::int FROM sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active') AS enrolled_cnt
         FROM email_sequences s WHERE s.organization_id = $1 ORDER BY s.created_at DESC`,
      [orgId]
    );
    if (seqRes.rows.length === 0) return [];
    const stepRes = await this.pool.query(
      `SELECT id::text, sequence_id::text, position, delay_days, delay_hours, subject, preview_text,
              html_body, text_body, blocks_json, enabled
         FROM sequence_steps WHERE sequence_id = ANY($1::uuid[]) ORDER BY position ASC`,
      [seqRes.rows.map((r) => r.id)]
    );
    const bySeq = new Map<string, SequenceStepItem[]>();
    for (const st of stepRes.rows) {
      const list = bySeq.get(st.sequence_id) ?? [];
      list.push({
        id: st.id,
        sequenceId: st.sequence_id,
        position: Number(st.position),
        delayDays: Number(st.delay_days),
        delayHours: Number(st.delay_hours),
        subject: st.subject,
        previewText: st.preview_text ?? '',
        htmlBody: st.html_body ?? '',
        textBody: st.text_body ?? '',
        blocksJson: Array.isArray(st.blocks_json) ? st.blocks_json : [],
        enabled: Boolean(st.enabled),
      });
      bySeq.set(st.sequence_id, list);
    }
    return seqRes.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      domainId: r.domain_id ?? null,
      name: r.name,
      description: r.description ?? '',
      fromName: r.from_name ?? '',
      fromEmail: r.from_email ?? null,
      replyTo: r.reply_to ?? null,
      enabled: Boolean(r.enabled),
      allowReentry: Boolean(r.allow_reentry),
      exitOnUnsubscribe: Boolean(r.exit_on_unsubscribe),
      steps: bySeq.get(r.id) ?? [],
      enrolledCount: Number(r.enrolled_cnt ?? 0),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  }

  async createSequence(orgId: string, input: Partial<EmailSequenceItem> & { name: string }): Promise<EmailSequenceItem> {
    const id = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO email_sequences (id, organization_id, domain_id, name, description, from_name, from_email, reply_to, enabled, allow_reentry, exit_on_unsubscribe)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          orgId,
          input.domainId && UUID_RX.test(input.domainId) ? input.domainId : null,
          input.name,
          input.description ?? '',
          input.fromName ?? '',
          input.fromEmail ?? null,
          input.replyTo ?? null,
          input.enabled ?? false,
          input.allowReentry ?? false,
          input.exitOnUnsubscribe ?? true,
        ]
      );
      for (let i = 0; i < (input.steps ?? []).length; i += 1) {
        const st = input.steps![i]!;
        const html = sanitizeMarketingHtml(st.htmlBody ?? '<p>Hello {{firstName}}</p>');
        await client.query(
          `INSERT INTO sequence_steps (id, sequence_id, position, delay_days, delay_hours, subject, preview_text, html_body, text_body, blocks_json, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
          [
            uuidv7(),
            id,
            i + 1,
            st.delayDays ?? (i === 0 ? 0 : 2),
            st.delayHours ?? 0,
            st.subject ?? `Email ${i + 1}`,
            st.previewText ?? '',
            html,
            st.textBody || htmlToPlainText(html),
            JSON.stringify(st.blocksJson ?? []),
            st.enabled ?? true,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return (await this.listSequences(orgId)).find((s) => s.id === id)!;
  }

  async updateSequence(
    orgId: string,
    id: string,
    patch: Partial<EmailSequenceItem> & { steps?: Array<Partial<SequenceStepItem> & { subject: string }> }
  ): Promise<EmailSequenceItem | null> {
    if (!UUID_RX.test(id)) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE email_sequences
            SET name = COALESCE($3, name),
                description = COALESCE($4, description),
                domain_id = COALESCE($5::uuid, domain_id),
                from_name = COALESCE($6, from_name),
                from_email = CASE WHEN $7::boolean THEN $8 ELSE from_email END,
                reply_to = CASE WHEN $9::boolean THEN $10 ELSE reply_to END,
                enabled = COALESCE($11, enabled),
                allow_reentry = COALESCE($12, allow_reentry),
                exit_on_unsubscribe = COALESCE($13, exit_on_unsubscribe),
                updated_at = NOW()
          WHERE organization_id = $1 AND id = $2`,
        [
          orgId,
          id,
          patch.name ?? null,
          patch.description ?? null,
          patch.domainId && UUID_RX.test(patch.domainId) ? patch.domainId : null,
          patch.fromName ?? null,
          patch.fromEmail !== undefined,
          patch.fromEmail ?? null,
          patch.replyTo !== undefined,
          patch.replyTo ?? null,
          patch.enabled ?? null,
          patch.allowReentry ?? null,
          patch.exitOnUnsubscribe ?? null,
        ]
      );
      if ((upd.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      if (patch.steps !== undefined) {
        await client.query(`DELETE FROM sequence_steps WHERE sequence_id = $1`, [id]);
        for (let i = 0; i < patch.steps.length; i += 1) {
          const st = patch.steps[i]!;
          const html = sanitizeMarketingHtml(st.htmlBody ?? '');
          await client.query(
            `INSERT INTO sequence_steps (id, sequence_id, position, delay_days, delay_hours, subject, preview_text, html_body, text_body, blocks_json, enabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
            [
              st.id && UUID_RX.test(st.id) ? st.id : uuidv7(),
              id,
              i + 1,
              st.delayDays ?? 0,
              st.delayHours ?? 0,
              st.subject,
              st.previewText ?? '',
              html,
              st.textBody || htmlToPlainText(html),
              JSON.stringify(st.blocksJson ?? []),
              st.enabled ?? true,
            ]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return (await this.listSequences(orgId)).find((s) => s.id === id) ?? null;
  }

  async deleteSequence(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM email_sequences WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async enrollInSequence(orgId: string, sequenceId: string, subscriberId: string): Promise<SequenceEnrollmentItem> {
    if (!UUID_RX.test(sequenceId) || !UUID_RX.test(subscriberId)) throw new AppError(404, 'NOT_FOUND', 'Sequence or subscriber not found');
    const [seqList, subRes] = await Promise.all([
      this.listSequences(orgId),
      this.pool.query(`SELECT email::text FROM contacts WHERE organization_id = $1 AND id = $2 LIMIT 1`, [orgId, subscriberId]),
    ]);
    const seq = seqList.find((s) => s.id === sequenceId);
    const email = subRes.rows[0]?.email as string | undefined;
    if (!seq || !email) throw new AppError(404, 'NOT_FOUND', 'Sequence or subscriber not found');

    const firstStep = seq.steps[0];
    const delayMs = firstStep ? (firstStep.delayDays * 24 + firstStep.delayHours) * 3600_000 : 0;
    const nextSendAt = firstStep ? new Date(Date.now() + delayMs).toISOString() : null;

    const existing = await this.pool.query(
      `SELECT id::text, sequence_id::text, subscriber_id::text, current_step_index, status, next_send_at, last_sent_at, exited_reason, enrolled_at, completed_at
         FROM sequence_enrollments WHERE sequence_id = $1 AND subscriber_id = $2 AND status = 'active' LIMIT 1`,
      [sequenceId, subscriberId]
    );
    if ((existing.rowCount ?? 0) > 0 && !seq.allowReentry) {
      const r = existing.rows[0];
      return {
        id: r.id,
        sequenceId: r.sequence_id,
        subscriberId: r.subscriber_id,
        subscriberEmail: email,
        currentStepIndex: Number(r.current_step_index),
        status: r.status,
        nextSendAt: isoOrNull(r.next_send_at),
        lastSentAt: isoOrNull(r.last_sent_at),
        exitedReason: r.exited_reason ?? null,
        enrolledAt: iso(r.enrolled_at),
        completedAt: isoOrNull(r.completed_at),
      };
    }

    const res = await this.pool.query(
      `INSERT INTO sequence_enrollments (id, organization_id, sequence_id, subscriber_id, current_step_index, status, next_send_at)
       VALUES ($1,$2,$3,$4,0,'active',$5)
       RETURNING id::text, sequence_id::text, subscriber_id::text, current_step_index, status, next_send_at, last_sent_at, exited_reason, enrolled_at, completed_at`,
      [uuidv7(), orgId, sequenceId, subscriberId, nextSendAt]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      sequenceId: r.sequence_id,
      subscriberId: r.subscriber_id,
      subscriberEmail: email,
      currentStepIndex: Number(r.current_step_index),
      status: r.status,
      nextSendAt: isoOrNull(r.next_send_at),
      lastSentAt: isoOrNull(r.last_sent_at),
      exitedReason: r.exited_reason ?? null,
      enrolledAt: iso(r.enrolled_at),
      completedAt: isoOrNull(r.completed_at),
    };
  }

  async listSequenceEnrollments(orgId: string, sequenceId: string): Promise<SequenceEnrollmentItem[]> {
    if (!UUID_RX.test(sequenceId)) return [];
    const res = await this.pool.query(
      `SELECT se.id::text, se.sequence_id::text, se.subscriber_id::text, c.email::text AS sub_email,
              se.current_step_index, se.status, se.next_send_at, se.last_sent_at, se.exited_reason, se.enrolled_at, se.completed_at
         FROM sequence_enrollments se
         JOIN contacts c ON c.id = se.subscriber_id
        WHERE se.organization_id = $1 AND se.sequence_id = $2
        ORDER BY se.enrolled_at DESC`,
      [orgId, sequenceId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      sequenceId: r.sequence_id,
      subscriberId: r.subscriber_id,
      subscriberEmail: r.sub_email,
      currentStepIndex: Number(r.current_step_index),
      status: r.status,
      nextSendAt: isoOrNull(r.next_send_at),
      lastSentAt: isoOrNull(r.last_sent_at),
      exitedReason: r.exited_reason ?? null,
      enrolledAt: iso(r.enrolled_at),
      completedAt: isoOrNull(r.completed_at),
    }));
  }

  // =========================================================================
  // Visual Automations
  // =========================================================================
  async listAutomations(orgId: string): Promise<AutomationItem[]> {
    const res = await this.pool.query(
      `SELECT a.id::text, a.organization_id::text, a.name, a.description, a.status, a.trigger_type,
              a.trigger_config, a.nodes, a.edges, a.created_at, a.updated_at,
              (SELECT COUNT(*)::int FROM automation_runs r WHERE r.automation_id = a.id) AS run_cnt
         FROM automations a WHERE a.organization_id = $1 ORDER BY a.created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      description: r.description ?? '',
      status: r.status,
      triggerType: r.trigger_type,
      triggerConfig: r.trigger_config ?? {},
      nodes: r.nodes ?? [],
      edges: r.edges ?? [],
      runCount: Number(r.run_cnt ?? 0),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  }

  async createAutomation(
    orgId: string,
    input: { name: string; description?: string; triggerType: AutomationItem['triggerType']; triggerConfig?: Record<string, unknown>; nodes?: AutomationNode[]; edges?: AutomationEdge[] }
  ): Promise<AutomationItem> {
    const res = await this.pool.query(
      `INSERT INTO automations (id, organization_id, name, description, status, trigger_type, trigger_config, nodes, edges)
       VALUES ($1,$2,$3,$4,'draft',$5,$6::jsonb,$7::jsonb,$8::jsonb)
       RETURNING id::text, organization_id::text, name, description, status, trigger_type, trigger_config, nodes, edges, created_at, updated_at`,
      [
        uuidv7(),
        orgId,
        input.name,
        input.description ?? '',
        input.triggerType,
        JSON.stringify(input.triggerConfig ?? {}),
        JSON.stringify(input.nodes ?? []),
        JSON.stringify(input.edges ?? []),
      ]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      description: r.description ?? '',
      status: r.status,
      triggerType: r.trigger_type,
      triggerConfig: r.trigger_config ?? {},
      nodes: r.nodes ?? [],
      edges: r.edges ?? [],
      runCount: 0,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async updateAutomation(orgId: string, id: string, patch: Partial<AutomationItem>): Promise<AutomationItem | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE automations
          SET name = COALESCE($3, name),
              description = COALESCE($4, description),
              status = COALESCE($5, status),
              trigger_type = COALESCE($6, trigger_type),
              trigger_config = COALESCE($7::jsonb, trigger_config),
              nodes = COALESCE($8::jsonb, nodes),
              edges = COALESCE($9::jsonb, edges),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text`,
      [
        orgId,
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.status ?? null,
        patch.triggerType ?? null,
        patch.triggerConfig ? JSON.stringify(patch.triggerConfig) : null,
        patch.nodes ? JSON.stringify(patch.nodes) : null,
        patch.edges ? JSON.stringify(patch.edges) : null,
      ]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return (await this.listAutomations(orgId)).find((a) => a.id === id) ?? null;
  }

  async deleteAutomation(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM automations WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async listAutomationRuns(orgId: string, automationId?: string): Promise<AutomationRunItem[]> {
    const res = await this.pool.query(
      `SELECT ar.id::text, ar.automation_id::text, ar.subscriber_id::text, c.email::text AS sub_email,
              ar.current_node_id, ar.status, ar.next_run_at, ar.started_at, ar.completed_at
         FROM automation_runs ar
         JOIN contacts c ON c.id = ar.subscriber_id
        WHERE ar.organization_id = $1 AND ($2::uuid IS NULL OR ar.automation_id = $2)
        ORDER BY ar.started_at DESC LIMIT 100`,
      [orgId, automationId && UUID_RX.test(automationId) ? automationId : null]
    );
    return res.rows.map((r) => ({
      id: r.id,
      automationId: r.automation_id,
      subscriberId: r.subscriber_id,
      subscriberEmail: r.sub_email,
      currentNodeId: r.current_node_id ?? null,
      status: r.status,
      nextRunAt: isoOrNull(r.next_run_at),
      startedAt: iso(r.started_at),
      completedAt: isoOrNull(r.completed_at),
    }));
  }

  private async executeAutomationRun(orgId: string, automation: AutomationItem, sub: SubscriberRecord): Promise<AutomationRunItem> {
    const runId = uuidv7();
    await this.pool.query(
      `INSERT INTO automation_runs (id, organization_id, automation_id, subscriber_id, status)
       VALUES ($1,$2,$3,$4,'running')`,
      [runId, orgId, automation.id, sub.id]
    );
    let current = automation.nodes.find((n) => n.type === 'trigger') ?? automation.nodes[0];
    let steps = 0;
    const visited = new Set<string>();
    let finalStatus: AutomationRunItem['status'] = 'completed';
    let nextRunAt: string | null = null;

    while (current && steps < 25) {
      steps += 1;
      if (visited.has(current.id)) break;
      visited.add(current.id);
      let detail = '';

      if (current.type === 'action_add_tag' && typeof current.config.tagName === 'string') {
        await this.updateSubscriber(orgId, sub.id, { addTags: [current.config.tagName] });
        detail = `Added tag ${current.config.tagName}`;
      } else if (current.type === 'action_remove_tag' && typeof current.config.tagName === 'string') {
        await this.updateSubscriber(orgId, sub.id, { removeTags: [current.config.tagName] });
        detail = `Removed tag ${current.config.tagName}`;
      } else if (current.type === 'action_update_field' && typeof current.config.fieldKey === 'string') {
        await this.updateSubscriber(orgId, sub.id, { attributes: { [current.config.fieldKey]: String(current.config.value ?? '') } });
        detail = `Updated ${current.config.fieldKey}`;
      } else if (current.type === 'action_subscribe_sequence' && typeof current.config.sequenceId === 'string') {
        await this.enrollInSequence(orgId, current.config.sequenceId, sub.id).catch(() => undefined);
        detail = `Subscribed to sequence`;
      } else if (current.type === 'action_unsubscribe_sequence' && typeof current.config.sequenceId === 'string') {
        await this.pool.query(
          `UPDATE sequence_enrollments SET status = 'exited', exited_reason = 'automation', completed_at = NOW()
            WHERE subscriber_id = $1 AND sequence_id = $2 AND status = 'active'`,
          [sub.id, current.config.sequenceId]
        );
        detail = 'Unsubscribed from sequence';
      } else if (current.type === 'delay') {
        const hours = Number(current.config.delayHours ?? 24);
        nextRunAt = new Date(Date.now() + hours * 3600_000).toISOString();
        finalStatus = 'waiting';
        await this.pool.query(
          `INSERT INTO automation_run_logs (id, automation_run_id, node_id, node_type, action_status, detail)
           VALUES ($1,$2,$3,$4,'executed',$5)`,
          [uuidv7(), runId, current.id, current.type, `Paused for ${hours}h`]
        );
        break;
      } else if (current.type === 'end') {
        await this.pool.query(
          `INSERT INTO automation_run_logs (id, automation_run_id, node_id, node_type, action_status, detail)
           VALUES ($1,$2,$3,$4,'executed','Completed')`,
          [uuidv7(), runId, current.id, current.type]
        );
        break;
      }

      await this.pool.query(
        `INSERT INTO automation_run_logs (id, automation_run_id, node_id, node_type, action_status, detail)
         VALUES ($1,$2,$3,$4,'executed',$5)`,
        [uuidv7(), runId, current.id, current.type, detail || current.label]
      );

      let nextEdge = automation.edges.find((e) => e.source === current!.id && (!e.branch || e.branch === 'next'));
      if (current.type === 'condition' && typeof current.config.tagName === 'string') {
        const latest = await this.pool.query(`SELECT tags FROM contacts WHERE id = $1`, [sub.id]);
        const curTags: string[] = latest.rows[0]?.tags ?? sub.tags;
        const hasTag = curTags.some((t) => t.toLowerCase() === String(current!.config.tagName).toLowerCase());
        nextEdge = automation.edges.find((e) => e.source === current!.id && e.branch === (hasTag ? 'yes' : 'no'));
      }
      current = nextEdge ? automation.nodes.find((n) => n.id === nextEdge.target) : undefined;
    }

    await this.pool.query(
      `UPDATE automation_runs
          SET current_node_id = $2, status = $3, next_run_at = $4,
              completed_at = CASE WHEN $3 = 'completed' THEN NOW() ELSE NULL END, updated_at = NOW()
        WHERE id = $1`,
      [runId, current?.id ?? null, finalStatus, nextRunAt]
    );
    return {
      id: runId,
      automationId: automation.id,
      subscriberId: sub.id,
      subscriberEmail: sub.email,
      currentNodeId: current?.id ?? null,
      status: finalStatus,
      nextRunAt,
      startedAt: new Date().toISOString(),
      completedAt: finalStatus === 'completed' ? new Date().toISOString() : null,
    };
  }

  async triggerAutomationForSubscriber(
    orgId: string,
    triggerType: AutomationItem['triggerType'],
    subscriberId: string,
    context?: Record<string, unknown>
  ): Promise<number> {
    if (!UUID_RX.test(subscriberId)) return 0;
    const [autos, subRes] = await Promise.all([
      this.listAutomations(orgId),
      this.pool.query(
        `SELECT id::text, organization_id::text, email::text, first_name, last_name, status,
                tags, attributes, consent_source, consented_at, unsubscribed_at,
                last_activity_at, engagement_score, created_at, updated_at
           FROM contacts WHERE organization_id = $1 AND id = $2 LIMIT 1`,
        [orgId, subscriberId]
      ),
    ]);
    if ((subRes.rowCount ?? 0) === 0) return 0;
    const sub = this.mapSubscriberRow(subRes.rows[0]);
    let launched = 0;
    for (const a of autos) {
      if (a.status !== 'published' || a.triggerType !== triggerType) continue;
      if (triggerType === 'tag_added' && a.triggerConfig.tagName) {
        const expected = String(a.triggerConfig.tagName).toLowerCase();
        const actual = String(context?.tagName ?? '').toLowerCase();
        if (actual && actual !== expected) continue;
      }
      await this.executeAutomationRun(orgId, a, sub);
      launched += 1;
    }
    return launched;
  }

  async runSpecificAutomation(orgId: string, automationId: string, subscriberId: string): Promise<AutomationRunItem | null> {
    if (!UUID_RX.test(automationId) || !UUID_RX.test(subscriberId)) return null;
    const [autos, subRes] = await Promise.all([
      this.listAutomations(orgId),
      this.pool.query(
        `SELECT id::text, organization_id::text, email::text, first_name, last_name, status,
                tags, attributes, consent_source, consented_at, unsubscribed_at,
                last_activity_at, engagement_score, created_at, updated_at
           FROM contacts WHERE organization_id = $1 AND id = $2 LIMIT 1`,
        [orgId, subscriberId]
      ),
    ]);
    const a = autos.find((x) => x.id === automationId);
    if (!a || (subRes.rowCount ?? 0) === 0) return null;
    return this.executeAutomationRun(orgId, a, this.mapSubscriberRow(subRes.rows[0]));
  }

  // =========================================================================
  // Growth: Forms & Landing Pages
  // =========================================================================
  private mapForm(r: Record<string, unknown>): GrowthFormItem {
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      name: String(r.name),
      formType: r.form_type as GrowthFormItem['formType'],
      title: String(r.title),
      description: String(r.description ?? ''),
      buttonText: String(r.button_text ?? 'Subscribe'),
      successMessage: String(r.success_message ?? ''),
      redirectUrl: (r.redirect_url as string | null) ?? null,
      consentText: String(r.consent_text ?? ''),
      doubleOptIn: Boolean(r.double_opt_in),
      fields: Array.isArray(r.fields) ? (r.fields as GrowthFormItem['fields']) : [],
      tagIds: Array.isArray(r.tag_ids) ? (r.tag_ids as string[]) : [],
      published: Boolean(r.published),
      submissionCount: Number(r.submission_count ?? 0),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async listForms(orgId: string): Promise<GrowthFormItem[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, name, form_type, title, description, button_text,
              success_message, redirect_url, consent_text, double_opt_in, fields, tag_ids::text[],
              published, submission_count, created_at, updated_at
         FROM forms WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => this.mapForm(r));
  }

  async createForm(orgId: string, input: Partial<GrowthFormItem> & { name: string }): Promise<GrowthFormItem> {
    const res = await this.pool.query(
      `INSERT INTO forms (id, organization_id, name, form_type, title, description, button_text, success_message, redirect_url, consent_text, double_opt_in, fields, tag_ids, published)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::uuid[],$14)
       RETURNING id::text, organization_id::text, name, form_type, title, description, button_text,
                 success_message, redirect_url, consent_text, double_opt_in, fields, tag_ids::text[],
                 published, submission_count, created_at, updated_at`,
      [
        uuidv7(),
        orgId,
        input.name,
        input.formType ?? 'inline',
        input.title ?? 'Subscribe to our newsletter',
        input.description ?? '',
        input.buttonText ?? 'Subscribe',
        input.successMessage ?? 'Thanks for subscribing!',
        input.redirectUrl ?? null,
        input.consentText ?? 'I agree to receive email updates.',
        input.doubleOptIn ?? false,
        JSON.stringify(input.fields ?? [{ key: 'firstName', label: 'First name', required: false }]),
        (input.tagIds ?? []).filter((id) => UUID_RX.test(id)),
        input.published ?? true,
      ]
    );
    return this.mapForm(res.rows[0]);
  }

  async updateForm(orgId: string, id: string, patch: Partial<GrowthFormItem>): Promise<GrowthFormItem | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE forms
          SET name = COALESCE($3, name),
              form_type = COALESCE($4, form_type),
              title = COALESCE($5, title),
              description = COALESCE($6, description),
              button_text = COALESCE($7, button_text),
              success_message = COALESCE($8, success_message),
              redirect_url = CASE WHEN $9::boolean THEN $10 ELSE redirect_url END,
              consent_text = COALESCE($11, consent_text),
              double_opt_in = COALESCE($12, double_opt_in),
              tag_ids = COALESCE($13::uuid[], tag_ids),
              published = COALESCE($14, published),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, name, form_type, title, description, button_text,
                 success_message, redirect_url, consent_text, double_opt_in, fields, tag_ids::text[],
                 published, submission_count, created_at, updated_at`,
      [
        orgId,
        id,
        patch.name ?? null,
        patch.formType ?? null,
        patch.title ?? null,
        patch.description ?? null,
        patch.buttonText ?? null,
        patch.successMessage ?? null,
        patch.redirectUrl !== undefined,
        patch.redirectUrl ?? null,
        patch.consentText ?? null,
        patch.doubleOptIn ?? null,
        patch.tagIds ? patch.tagIds.filter((x) => UUID_RX.test(x)) : null,
        patch.published ?? null,
      ]
    );
    return res.rows[0] ? this.mapForm(res.rows[0]) : null;
  }

  async deleteForm(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM forms WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async getPublicForm(formId: string): Promise<GrowthFormItem | null> {
    if (!UUID_RX.test(formId)) return null;
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, name, form_type, title, description, button_text,
              success_message, redirect_url, consent_text, double_opt_in, fields, tag_ids::text[],
              published, submission_count, created_at, updated_at
         FROM forms WHERE id = $1 AND published = TRUE LIMIT 1`,
      [formId]
    );
    return res.rows[0] ? this.mapForm(res.rows[0]) : null;
  }

  async submitPublicForm(
    formId: string,
    payload: { email: string; firstName?: string; lastName?: string; attributes?: Record<string, string>; landingPageId?: string }
  ) {
    const form = await this.getPublicForm(formId);
    if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'Signup form not found');
    const orgTags = await this.listTags(form.organizationId);
    const tagNames = form.tagIds.map((tid) => orgTags.find((t) => t.id === tid)?.name ?? '').filter(Boolean);
    const { subscriber } = await this.upsertSubscriber(form.organizationId, {
      email: payload.email,
      firstName: payload.firstName ?? '',
      lastName: payload.lastName ?? '',
      status: form.doubleOptIn ? 'pending_confirmation' : 'subscribed',
      tags: tagNames,
      attributes: payload.attributes ?? {},
      consentSource: `form:${form.name}`,
    });
    await this.pool.query(`UPDATE forms SET submission_count = submission_count + 1 WHERE id = $1`, [form.id]);
    await this.pool.query(
      `INSERT INTO form_submissions (id, organization_id, form_id, landing_page_id, subscriber_id, email, payload, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        uuidv7(),
        form.organizationId,
        form.id,
        payload.landingPageId && UUID_RX.test(payload.landingPageId) ? payload.landingPageId : null,
        subscriber.id,
        subscriber.email,
        JSON.stringify(payload.attributes ?? {}),
        form.doubleOptIn ? null : new Date().toISOString(),
      ]
    );
    if (!form.doubleOptIn) {
      await this.triggerAutomationForSubscriber(form.organizationId, 'form_submitted', subscriber.id, { formId: form.id }).catch(() => 0);
    }
    return {
      subscriber,
      doubleOptIn: form.doubleOptIn,
      successMessage: form.successMessage,
      redirectUrl: form.redirectUrl,
    };
  }

  private mapLandingPage(r: Record<string, unknown>): LandingPageItem {
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      slug: String(r.slug),
      title: String(r.title),
      headline: String(r.headline),
      subheadline: String(r.subheadline ?? ''),
      bodyHtml: String(r.body_html ?? ''),
      heroImageUrl: (r.hero_image_url as string | null) ?? null,
      templateKey: String(r.template_key ?? 'minimal'),
      buttonText: String(r.button_text ?? 'Get Updates'),
      customDomain: (r.custom_domain as string | null) ?? null,
      formId: (r.form_id as string | null) ?? null,
      tagIds: Array.isArray(r.tag_ids) ? (r.tag_ids as string[]) : [],
      published: Boolean(r.published),
      viewsCount: Number(r.views_count ?? 0),
      conversionCount: Number(r.conversion_count ?? 0),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async listLandingPages(orgId: string): Promise<LandingPageItem[]> {
    const res = await this.pool.query(
      `SELECT id::text, organization_id::text, slug::text, title, headline, subheadline, body_html,
              hero_image_url, template_key, button_text, custom_domain::text, form_id::text,
              tag_ids::text[], published, views_count, conversion_count, created_at, updated_at
         FROM landing_pages WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => this.mapLandingPage(r));
  }

  async createLandingPage(orgId: string, input: Partial<LandingPageItem> & { slug: string; title: string; headline: string }): Promise<LandingPageItem> {
    const res = await this.pool.query(
      `INSERT INTO landing_pages (id, organization_id, slug, title, headline, subheadline, body_html, hero_image_url, template_key, button_text, custom_domain, form_id, tag_ids, published)
       VALUES ($1,$2,$3::citext,$4,$5,$6,$7,$8,$9,$10,$11::citext,$12,$13::uuid[],$14)
       RETURNING id::text, organization_id::text, slug::text, title, headline, subheadline, body_html,
                 hero_image_url, template_key, button_text, custom_domain::text, form_id::text,
                 tag_ids::text[], published, views_count, conversion_count, created_at, updated_at`,
      [
        uuidv7(),
        orgId,
        input.slug.trim().toLowerCase(),
        input.title,
        input.headline,
        input.subheadline ?? '',
        sanitizeMarketingHtml(input.bodyHtml ?? ''),
        input.heroImageUrl ?? null,
        input.templateKey ?? 'minimal',
        input.buttonText ?? 'Get Updates',
        input.customDomain ?? null,
        input.formId && UUID_RX.test(input.formId) ? input.formId : null,
        (input.tagIds ?? []).filter((x) => UUID_RX.test(x)),
        input.published ?? false,
      ]
    );
    return this.mapLandingPage(res.rows[0]);
  }

  async updateLandingPage(orgId: string, id: string, patch: Partial<LandingPageItem>): Promise<LandingPageItem | null> {
    if (!UUID_RX.test(id)) return null;
    const res = await this.pool.query(
      `UPDATE landing_pages
          SET title = COALESCE($3, title),
              headline = COALESCE($4, headline),
              subheadline = COALESCE($5, subheadline),
              body_html = COALESCE($6, body_html),
              hero_image_url = CASE WHEN $7::boolean THEN $8 ELSE hero_image_url END,
              button_text = COALESCE($9, button_text),
              custom_domain = CASE WHEN $10::boolean THEN $11::citext ELSE custom_domain END,
              form_id = CASE WHEN $12::boolean THEN $13::uuid ELSE form_id END,
              tag_ids = COALESCE($14::uuid[], tag_ids),
              published = COALESCE($15, published),
              updated_at = NOW()
        WHERE organization_id = $1 AND id = $2
       RETURNING id::text, organization_id::text, slug::text, title, headline, subheadline, body_html,
                 hero_image_url, template_key, button_text, custom_domain::text, form_id::text,
                 tag_ids::text[], published, views_count, conversion_count, created_at, updated_at`,
      [
        orgId,
        id,
        patch.title ?? null,
        patch.headline ?? null,
        patch.subheadline ?? null,
        patch.bodyHtml !== undefined ? sanitizeMarketingHtml(patch.bodyHtml) : null,
        patch.heroImageUrl !== undefined,
        patch.heroImageUrl ?? null,
        patch.buttonText ?? null,
        patch.customDomain !== undefined,
        patch.customDomain ?? null,
        patch.formId !== undefined,
        patch.formId && UUID_RX.test(patch.formId) ? patch.formId : null,
        patch.tagIds ? patch.tagIds.filter((x) => UUID_RX.test(x)) : null,
        patch.published ?? null,
      ]
    );
    return res.rows[0] ? this.mapLandingPage(res.rows[0]) : null;
  }

  async deleteLandingPage(orgId: string, id: string): Promise<boolean> {
    if (!UUID_RX.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM landing_pages WHERE organization_id = $1 AND id = $2`, [orgId, id]);
    return (res.rowCount ?? 0) > 0;
  }

  async getPublicLandingPage(slug: string): Promise<LandingPageItem | null> {
    const res = await this.pool.query(
      `UPDATE landing_pages SET views_count = views_count + 1
        WHERE slug = $1::citext AND published = TRUE
       RETURNING id::text, organization_id::text, slug::text, title, headline, subheadline, body_html,
                 hero_image_url, template_key, button_text, custom_domain::text, form_id::text,
                 tag_ids::text[], published, views_count, conversion_count, created_at, updated_at`,
      [slug.toLowerCase()]
    );
    return res.rows[0] ? this.mapLandingPage(res.rows[0]) : null;
  }
}

/**
 * Processes due scheduled broadcasts, email sequence steps, and waiting automation runs.
 */
export async function runMarketingBackgroundTick(params: {
  pool: Pool;
  marketingStore: PgMarketingPlatformStore;
  dispatchCampaign: (campaign: CampaignRecord) => Promise<number>;
  sendSequenceStepEmail: (input: {
    organizationId: string;
    domainId: string;
    fromName: string;
    fromEmail: string | null;
    replyTo: string | null;
    recipientEmail: string;
    subscriberId: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }) => Promise<void>;
}): Promise<void> {
  // 1. Trigger due scheduled broadcasts
  const dueCampaigns = await params.marketingStore.listDueScheduledCampaigns();
  for (const camp of dueCampaigns) {
    try {
      const transitioned = await params.marketingStore.transitionCampaign(camp.organizationId, camp.id, 'running');
      if (!transitioned) continue;
      const sentCount = await params.dispatchCampaign(transitioned);
      await params.marketingStore.markCampaignDispatched(camp.organizationId, camp.id, sentCount);
    } catch (err) {
      await params.marketingStore
        .markCampaignDispatched(
          camp.organizationId,
          camp.id,
          0,
          err instanceof Error ? err.message : 'Scheduled dispatch failed'
        )
        .catch(() => undefined);
    }
  }

  // 2. Process due sequence steps
  const dueSteps = await params.pool.query<{
    enrollment_id: string;
    organization_id: string;
    sequence_id: string;
    subscriber_id: string;
    current_step_index: number;
    domain_id: string | null;
    from_name: string;
    from_email: string | null;
    reply_to: string | null;
    exit_on_unsubscribe: boolean;
    sub_email: string;
    sub_status: string;
  }>(
    `SELECT se.id::text AS enrollment_id, se.organization_id::text, se.sequence_id::text, se.subscriber_id::text,
            se.current_step_index, s.domain_id::text, s.from_name, s.from_email, s.reply_to, s.exit_on_unsubscribe,
            c.email::text AS sub_email, c.status AS sub_status
       FROM sequence_enrollments se
       JOIN email_sequences s ON s.id = se.sequence_id
       JOIN contacts c ON c.id = se.subscriber_id
      WHERE se.status = 'active'
        AND s.enabled = TRUE
        AND se.next_send_at IS NOT NULL
        AND se.next_send_at <= NOW()
      LIMIT 50`
  );

  for (const row of dueSteps.rows) {
    if (row.exit_on_unsubscribe && row.sub_status !== 'subscribed') {
      await params.pool.query(
        `UPDATE sequence_enrollments SET status = 'exited', exited_reason = $2, completed_at = NOW() WHERE id = $1`,
        [row.enrollment_id, row.sub_status]
      );
      continue;
    }
    const seqs = await params.marketingStore.listSequences(row.organization_id);
    const seq = seqs.find((s) => s.id === row.sequence_id);
    const step = seq?.steps[row.current_step_index];
    if (!step) {
      await params.pool.query(
        `UPDATE sequence_enrollments SET status = 'completed', completed_at = NOW(), next_send_at = NULL WHERE id = $1`,
        [row.enrollment_id]
      );
      continue;
    }
    if (step.enabled && row.domain_id) {
      await params.sendSequenceStepEmail({
        organizationId: row.organization_id,
        domainId: row.domain_id,
        fromName: row.from_name,
        fromEmail: row.from_email,
        replyTo: row.reply_to,
        recipientEmail: row.sub_email,
        subscriberId: row.subscriber_id,
        subject: step.subject,
        htmlBody: step.htmlBody,
        textBody: step.textBody,
      }).catch(() => undefined);
    }
    const nextIdx = row.current_step_index + 1;
    const nextStep = seq?.steps[nextIdx];
    if (!nextStep) {
      await params.pool.query(
        `UPDATE sequence_enrollments SET current_step_index = $2, status = 'completed', last_sent_at = NOW(), completed_at = NOW(), next_send_at = NULL WHERE id = $1`,
        [row.enrollment_id, nextIdx]
      );
    } else {
      const delayMs = (nextStep.delayDays * 24 + nextStep.delayHours) * 3600_000;
      const nextAt = new Date(Date.now() + delayMs).toISOString();
      await params.pool.query(
        `UPDATE sequence_enrollments SET current_step_index = $2, last_sent_at = NOW(), next_send_at = $3 WHERE id = $1`,
        [row.enrollment_id, nextIdx, nextAt]
      );
    }
  }
}
