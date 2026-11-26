-- 0003_indexes_and_defaults.sql
-- High-scale indexes, MFA TOTP secret persistence, and deferred-retry / API store alignment.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS mfa_totp_secret TEXT;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS sending_mode TEXT NOT NULL DEFAULT 'live'
    CHECK (sending_mode IN ('sandbox', 'live'));

-- 20M-scale hot query and worker indexes
CREATE INDEX IF NOT EXISTS idx_message_recipients_retry_due
    ON message_recipients (next_retry_at)
    WHERE state = 'deferred';

CREATE INDEX IF NOT EXISTS idx_message_recipients_msg
    ON message_recipients (message_id);

CREATE INDEX IF NOT EXISTS idx_messages_org_created
    ON messages (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_rcpt
    ON delivery_attempts (message_recipient_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_events_org_created
    ON email_events (organization_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaigns_org_status
    ON campaigns (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created
    ON audit_logs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invoices (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    amount_cents    INTEGER NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    status          TEXT NOT NULL CHECK (status IN ('paid', 'open', 'void')),
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_rate_limits (
    provider        TEXT PRIMARY KEY,
    max_per_min     INTEGER NOT NULL,
    max_concurrent  INTEGER NOT NULL,
    backoff_seconds INTEGER NOT NULL DEFAULT 60,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,
    url             TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'pending')),
    http_status     INTEGER,
    attempt_count   INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_org
    ON webhook_delivery_logs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tracking_tokens (
    token           TEXT PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    message_id      UUID NOT NULL,
    recipient_email CITEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('open', 'click', 'unsubscribe')),
    target_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
