-- 0005_kit_email_marketing.sql
-- Complete Kit-inspired email marketing platform schema:
-- Normalized tags, subscriber statuses & custom fields, dynamic segments,
-- CSV import jobs, visual template blocks, broadcast snapshots, sequences,
-- visual automations, forms, landing pages, and compliance extensions.

-- 1. Subscribers (`contacts` normalized & extended without duplicating contacts)
ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'subscribed',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS engagement_score INTEGER NOT NULL DEFAULT 0;

UPDATE contacts
   SET status = 'unsubscribed'
 WHERE unsubscribed_at IS NOT NULL AND status = 'subscribed';

ALTER TABLE contacts
    DROP CONSTRAINT IF EXISTS contacts_status_check;
ALTER TABLE contacts
    ADD CONSTRAINT contacts_status_check
    CHECK (status IN ('subscribed', 'unsubscribed', 'bounced', 'complained', 'pending_confirmation'));

CREATE INDEX IF NOT EXISTS idx_contacts_org_status_created
    ON contacts (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_org_email_search
    ON contacts (organization_id, email);

-- 2. Normalized Tags & Many-to-Many Subscriber-Tag Assignments
CREATE TABLE IF NOT EXISTS tags (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            CITEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    color           TEXT NOT NULL DEFAULT '#2563eb',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);

CREATE TABLE IF NOT EXISTS subscriber_tags (
    subscriber_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    tag_id        UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subscriber_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriber_tags_tag
    ON subscriber_tags (tag_id, subscriber_id);

-- Backfill existing `contacts.tags TEXT[]` cleanly into `tags` + `subscriber_tags`
INSERT INTO tags (id, organization_id, name, description)
SELECT
    (
        substr(md5(organization_id::text || ':' || lower(trim(tag_val))), 1, 8) || '-' ||
        substr(md5(organization_id::text || ':' || lower(trim(tag_val))), 9, 4) || '-' ||
        substr(md5(organization_id::text || ':' || lower(trim(tag_val))), 13, 4) || '-' ||
        substr(md5(organization_id::text || ':' || lower(trim(tag_val))), 17, 4) || '-' ||
        substr(md5(organization_id::text || ':' || lower(trim(tag_val))), 21, 12)
    )::UUID,
    organization_id,
    trim(tag_val)::citext,
    'Migrated tag'
FROM (
    SELECT DISTINCT organization_id, unnest(tags) AS tag_val
    FROM contacts
    WHERE array_length(tags, 1) > 0
) src
WHERE trim(tag_val) <> ''
ON CONFLICT (organization_id, name) DO NOTHING;

INSERT INTO subscriber_tags (subscriber_id, tag_id)
SELECT DISTINCT c.id, t.id
FROM contacts c
CROSS JOIN LATERAL unnest(c.tags) AS raw_tag
JOIN tags t
  ON t.organization_id = c.organization_id
 AND t.name = trim(raw_tag)::citext
WHERE trim(raw_tag) <> ''
ON CONFLICT DO NOTHING;

-- 3. Custom Field Definitions & Subscriber Event Audit Log
CREATE TABLE IF NOT EXISTS custom_fields (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    field_key       TEXT NOT NULL,
    label           TEXT NOT NULL,
    field_type      TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'number', 'date', 'boolean')),
    description     TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, field_key)
);

CREATE TABLE IF NOT EXISTS subscriber_events (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscriber_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    source          TEXT,
    detail          JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriber_events_sub
    ON subscriber_events (subscriber_id, created_at DESC);

-- 4. Dynamic Segments
CREATE TABLE IF NOT EXISTS segments (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    match_type      TEXT NOT NULL DEFAULT 'all' CHECK (match_type IN ('all', 'any')),
    conditions      JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segments_org
    ON segments (organization_id, created_at DESC);

-- 5. Background CSV Import Jobs
CREATE TABLE IF NOT EXISTS contact_import_jobs (
    id                   UUID PRIMARY KEY,
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    file_name            TEXT,
    consent_source       TEXT NOT NULL,
    default_tags         TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    field_mapping        JSONB NOT NULL DEFAULT '{}'::JSONB,
    total_rows           INTEGER NOT NULL DEFAULT 0,
    imported_count       INTEGER NOT NULL DEFAULT 0,
    updated_count        INTEGER NOT NULL DEFAULT 0,
    skipped_duplicates   INTEGER NOT NULL DEFAULT 0,
    invalid_count        INTEGER NOT NULL DEFAULT 0,
    suppressed_count     INTEGER NOT NULL DEFAULT 0,
    missing_consent_count INTEGER NOT NULL DEFAULT 0,
    failed_count         INTEGER NOT NULL DEFAULT 0,
    error_report         JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_contact_import_jobs_org
    ON contact_import_jobs (organization_id, created_at DESC);

-- 6. Visual Email Templates Extension
ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE template_versions
    ADD COLUMN IF NOT EXISTS preview_text TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS blocks_json JSONB NOT NULL DEFAULT '[]'::JSONB;

-- 7. Broadcasts (`campaigns` extended) & Audience Snapshot Recipients
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS from_name TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS from_email TEXT,
    ADD COLUMN IF NOT EXISTS reply_to TEXT,
    ADD COLUMN IF NOT EXISTS subject TEXT,
    ADD COLUMN IF NOT EXISTS preview_text TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS html_body TEXT,
    ADD COLUMN IF NOT EXISTS text_body TEXT,
    ADD COLUMN IF NOT EXISTS blocks_json JSONB NOT NULL DEFAULT '[]'::JSONB,
    ADD COLUMN IF NOT EXISTS audience_spec JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT;

ALTER TABLE campaigns
    DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'running', 'paused', 'completed', 'cancelled', 'failed'));

CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_due
    ON campaigns (status, scheduled_at)
    WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS campaign_recipients (
    id              UUID PRIMARY KEY,
    campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscriber_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
    recipient_email CITEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'cancelled', 'failed', 'skipped_suppressed')),
    message_id      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (campaign_id, recipient_email)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_status
    ON campaign_recipients (campaign_id, status);

-- 8. Tracking Tokens & Suppressions Compliance Extensions
ALTER TABLE tracking_tokens
    ADD COLUMN IF NOT EXISTS campaign_id UUID,
    ADD COLUMN IF NOT EXISTS domain_id UUID,
    ADD COLUMN IF NOT EXISTS subscriber_id UUID;

CREATE INDEX IF NOT EXISTS idx_tracking_tokens_campaign
    ON tracking_tokens (campaign_id)
    WHERE campaign_id IS NOT NULL;

ALTER TABLE suppression_entries
    ADD COLUMN IF NOT EXISTS source TEXT,
    ADD COLUMN IF NOT EXISTS related_campaign_id UUID,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE suppression_entries
    DROP CONSTRAINT IF EXISTS suppression_entries_reason_check;
ALTER TABLE suppression_entries
    ADD CONSTRAINT suppression_entries_reason_check
    CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid_recipient', 'admin'));

-- 9. Email Sequences
CREATE TABLE IF NOT EXISTS email_sequences (
    id                  UUID PRIMARY KEY,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_id           UUID REFERENCES domains(id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    from_name           TEXT NOT NULL DEFAULT '',
    from_email          TEXT,
    reply_to            TEXT,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    allow_reentry       BOOLEAN NOT NULL DEFAULT FALSE,
    exit_on_unsubscribe BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
    id           UUID PRIMARY KEY,
    sequence_id  UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    delay_days   INTEGER NOT NULL DEFAULT 0 CHECK (delay_days >= 0),
    delay_hours  INTEGER NOT NULL DEFAULT 0 CHECK (delay_hours >= 0),
    subject      TEXT NOT NULL,
    preview_text TEXT NOT NULL DEFAULT '',
    html_body    TEXT NOT NULL DEFAULT '',
    text_body    TEXT NOT NULL DEFAULT '',
    blocks_json  JSONB NOT NULL DEFAULT '[]'::JSONB,
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_seq_pos
    ON sequence_steps (sequence_id, position);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
    id                 UUID PRIMARY KEY,
    organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sequence_id        UUID NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
    subscriber_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    current_step_index INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'exited', 'paused')),
    next_send_at       TIMESTAMPTZ,
    last_sent_at       TIMESTAMPTZ,
    exited_reason      TEXT,
    enrolled_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
    ON sequence_enrollments (status, next_send_at)
    WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_sequence_enrollments_active_unique
    ON sequence_enrollments (sequence_id, subscriber_id)
    WHERE status = 'active';

-- 10. Visual Automations
CREATE TABLE IF NOT EXISTS automations (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
    trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('tag_added', 'segment_joined', 'form_submitted', 'landing_page_signup', 'api_event')),
    trigger_config  JSONB NOT NULL DEFAULT '{}'::JSONB,
    nodes           JSONB NOT NULL DEFAULT '[]'::JSONB,
    edges           JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automation_runs (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    automation_id   UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    subscriber_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    current_node_id TEXT,
    status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
    next_run_at     TIMESTAMPTZ,
    context         JSONB NOT NULL DEFAULT '{}'::JSONB,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_due
    ON automation_runs (status, next_run_at)
    WHERE status IN ('running', 'waiting');

CREATE TABLE IF NOT EXISTS automation_run_logs (
    id                UUID PRIMARY KEY,
    automation_run_id UUID NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    node_id           TEXT NOT NULL,
    node_type         TEXT NOT NULL,
    action_status     TEXT NOT NULL CHECK (action_status IN ('executed', 'skipped', 'failed')),
    detail            TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Growth: Forms & Landing Pages
CREATE TABLE IF NOT EXISTS forms (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    form_type        TEXT NOT NULL DEFAULT 'inline' CHECK (form_type IN ('inline', 'popup', 'embedded')),
    title            TEXT NOT NULL DEFAULT 'Join our newsletter',
    description      TEXT NOT NULL DEFAULT '',
    button_text      TEXT NOT NULL DEFAULT 'Subscribe',
    success_message  TEXT NOT NULL DEFAULT 'Thanks for subscribing!',
    redirect_url     TEXT,
    consent_text     TEXT NOT NULL DEFAULT 'I agree to receive email updates.',
    double_opt_in    BOOLEAN NOT NULL DEFAULT FALSE,
    fields           JSONB NOT NULL DEFAULT '[]'::JSONB,
    tag_ids          UUID[] NOT NULL DEFAULT '{}'::UUID[],
    published        BOOLEAN NOT NULL DEFAULT TRUE,
    submission_count INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS landing_pages (
    id               UUID PRIMARY KEY,
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug             CITEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,
    headline         TEXT NOT NULL,
    subheadline      TEXT NOT NULL DEFAULT '',
    body_html        TEXT NOT NULL DEFAULT '',
    hero_image_url   TEXT,
    template_key     TEXT NOT NULL DEFAULT 'minimal',
    button_text      TEXT NOT NULL DEFAULT 'Get Updates',
    custom_domain    CITEXT,
    form_id          UUID REFERENCES forms(id) ON DELETE SET NULL,
    tag_ids          UUID[] NOT NULL DEFAULT '{}'::UUID[],
    published        BOOLEAN NOT NULL DEFAULT FALSE,
    views_count      INTEGER NOT NULL DEFAULT 0,
    conversion_count INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS form_submissions (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    form_id         UUID REFERENCES forms(id) ON DELETE CASCADE,
    landing_page_id UUID REFERENCES landing_pages(id) ON DELETE CASCADE,
    subscriber_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
    email           CITEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::JSONB,
    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
