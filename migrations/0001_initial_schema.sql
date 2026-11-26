-- 0001_initial_schema.sql
-- Single source-of-truth schema shared by Node.js (Prisma) and Rust (SQLx).
-- Uses TEXT + CHECK constraints for enum-like columns to avoid Prisma/SQLx enum type-mapping friction.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Identity, Tenancy & RBAC
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id                UUID PRIMARY KEY,
    email             CITEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    full_name         TEXT NOT NULL,
    email_verified_at TIMESTAMPTZ,
    mfa_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    platform_role     TEXT NOT NULL DEFAULT 'none' CHECK (platform_role IN ('none', 'platform_operator', 'super_admin')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

CREATE TABLE user_sessions (
    id                 UUID PRIMARY KEY,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_surface        TEXT NOT NULL CHECK (app_surface IN ('web', 'mail', 'admin')),
    refresh_token_hash TEXT NOT NULL UNIQUE,
    token_family_id    UUID NOT NULL,
    ip_address         INET,
    user_agent         TEXT,
    mfa_verified_at    TIMESTAMPTZ,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_sessions_family ON user_sessions(token_family_id);

CREATE TABLE mfa_credentials (
    id                UUID PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type              TEXT NOT NULL CHECK (type IN ('totp', 'webauthn')),
    encrypted_secret  BYTEA NOT NULL,
    backup_codes_hash TEXT[] NOT NULL DEFAULT '{}',
    last_used_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ip_pools (
    id           UUID PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    pool_type    TEXT NOT NULL CHECK (pool_type IN ('shared_transactional', 'shared_bulk', 'dedicated', 'warmup')),
    is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE organizations (
    id                  UUID PRIMARY KEY,
    name                TEXT NOT NULL,
    slug                CITEXT NOT NULL UNIQUE,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending_review')),
    sending_mode        TEXT NOT NULL DEFAULT 'sandbox' CHECK (sending_mode IN ('sandbox', 'live')),
    default_ip_pool_id  UUID REFERENCES ip_pools(id),
    daily_send_limit    INTEGER NOT NULL DEFAULT 500,
    monthly_send_limit  INTEGER NOT NULL DEFAULT 10000,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE organization_members (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'read_only_analyst')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

CREATE TABLE audit_logs (
    id              UUID NOT NULL,
    actor_user_id   UUID REFERENCES users(id),
    actor_ip        INET,
    organization_id UUID REFERENCES organizations(id),
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     TEXT,
    before_state    JSONB,
    after_state     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- ---------------------------------------------------------------------------
-- 2. Sending IPs, Nodes & Reputation
-- ---------------------------------------------------------------------------

CREATE TABLE sending_ips (
    id               UUID PRIMARY KEY,
    ip_pool_id       UUID NOT NULL REFERENCES ip_pools(id),
    ipv4_address     INET NOT NULL UNIQUE,
    ipv6_address     INET,
    ptr_hostname     TEXT NOT NULL,
    warmup_stage     INTEGER NOT NULL DEFAULT 1,
    daily_quota      INTEGER NOT NULL DEFAULT 1000,
    sent_today       INTEGER NOT NULL DEFAULT 0,
    reputation_score NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    status           TEXT NOT NULL DEFAULT 'warming' CHECK (status IN ('active', 'warming', 'paused', 'retired')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE provider_rate_limits (
    id                    UUID PRIMARY KEY,
    ip_pool_id            UUID REFERENCES ip_pools(id) ON DELETE CASCADE,
    remote_domain_pattern TEXT NOT NULL,
    max_connections       INTEGER NOT NULL DEFAULT 4,
    max_msgs_per_minute   INTEGER NOT NULL DEFAULT 120,
    backoff_multiplier    NUMERIC(4,2) NOT NULL DEFAULT 2.00,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mta_nodes (
    id                 TEXT PRIMARY KEY,
    hostname           TEXT NOT NULL UNIQUE,
    roles              TEXT[] NOT NULL,
    status             TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'draining', 'maintenance', 'offline')),
    active_connections INTEGER NOT NULL DEFAULT 0,
    queue_lag_ms       INTEGER NOT NULL DEFAULT 0,
    last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3. Domains, DKIM & Deliverability
-- ---------------------------------------------------------------------------

CREATE TABLE domains (
    id                        UUID PRIMARY KEY,
    organization_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_name               CITEXT NOT NULL UNIQUE,
    verification_token        TEXT NOT NULL,
    ownership_verified_at     TIMESTAMPTZ,
    sending_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    hosting_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    is_suspended              BOOLEAN NOT NULL DEFAULT FALSE,
    suspension_reason         TEXT,
    active_dkim_selector      TEXT,
    custom_return_path_domain CITEXT,
    custom_tracking_domain    CITEXT,
    dmarc_policy              TEXT NOT NULL DEFAULT 'none' CHECK (dmarc_policy IN ('none', 'quarantine', 'reject')),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_domains_org ON domains(organization_id);

CREATE TABLE dkim_keys (
    id                     UUID PRIMARY KEY,
    domain_id              UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    selector               TEXT NOT NULL,
    algorithm              TEXT NOT NULL CHECK (algorithm IN ('rsa2048', 'ed25519')),
    public_key_dns_txt     TEXT NOT NULL,
    encrypted_private_key  BYTEA NOT NULL,
    key_encryption_version INTEGER NOT NULL DEFAULT 1,
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retiring', 'revoked')),
    rotated_at             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (domain_id, selector)
);

CREATE TABLE domain_dns_checks (
    id          UUID PRIMARY KEY,
    domain_id   UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    spf_status  TEXT NOT NULL CHECK (spf_status IN ('pass', 'warn', 'fail', 'unchecked')),
    dkim_status TEXT NOT NULL CHECK (dkim_status IN ('pass', 'warn', 'fail', 'unchecked')),
    dmarc_status TEXT NOT NULL CHECK (dmarc_status IN ('pass', 'warn', 'fail', 'unchecked')),
    mx_status   TEXT NOT NULL CHECK (mx_status IN ('pass', 'warn', 'fail', 'unchecked')),
    ptr_status  TEXT NOT NULL CHECK (ptr_status IN ('pass', 'warn', 'fail', 'unchecked')),
    details     JSONB NOT NULL DEFAULT '{}'::JSONB,
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dns_checks_domain_latest ON domain_dns_checks(domain_id, checked_at DESC);

-- ---------------------------------------------------------------------------
-- 4. API Keys & SMTP Credentials
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    key_prefix      VARCHAR(16) NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,
    scopes          TEXT[] NOT NULL,
    rate_limit_rpm  INTEGER NOT NULL DEFAULT 600,
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_org ON api_keys(organization_id) WHERE revoked_at IS NULL;

CREATE TABLE smtp_credentials (
    id                      UUID PRIMARY KEY,
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_id               UUID REFERENCES domains(id) ON DELETE SET NULL,
    username                TEXT NOT NULL UNIQUE,
    password_hash           TEXT NOT NULL,
    allowed_sender_patterns TEXT[] NOT NULL DEFAULT '{}',
    max_rate_per_min        INTEGER NOT NULL DEFAULT 300,
    last_used_at            TIMESTAMPTZ,
    failed_auth_count       INTEGER NOT NULL DEFAULT 0,
    revoked_at              TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 5. Mailbox Hosting (Dovecot)
-- ---------------------------------------------------------------------------

CREATE TABLE mailbox_servers (
    id           UUID PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    lmtp_host    TEXT NOT NULL,
    lmtp_port    INTEGER NOT NULL DEFAULT 24,
    imap_host    TEXT NOT NULL,
    imap_port    INTEGER NOT NULL DEFAULT 143,
    storage_path TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'full')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mailboxes (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_id       UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    server_id       UUID NOT NULL REFERENCES mailbox_servers(id),
    local_part      CITEXT NOT NULL,
    email_address   CITEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL DEFAULT '',
    quota_bytes     BIGINT NOT NULL DEFAULT 5368709120, -- 5 GiB
    used_bytes      BIGINT NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    is_catch_all    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (domain_id, local_part)
);

CREATE INDEX idx_mailboxes_org ON mailboxes(organization_id);

CREATE TABLE mailbox_aliases (
    id                    UUID PRIMARY KEY,
    domain_id             UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    source_address        CITEXT NOT NULL UNIQUE,
    destination_addresses TEXT[] NOT NULL,
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mailbox_forwarding_rules (
    id                 UUID PRIMARY KEY,
    mailbox_id         UUID NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    forward_to_address CITEXT NOT NULL,
    keep_local_copy    BOOLEAN NOT NULL DEFAULT TRUE,
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 6. Templates, Audiences, Campaigns & Suppressions
-- ---------------------------------------------------------------------------

CREATE TABLE templates (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'transactional',
    active_version  INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE template_versions (
    id              UUID PRIMARY KEY,
    template_id     UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    subject         TEXT NOT NULL,
    html_body       TEXT NOT NULL DEFAULT '',
    text_body       TEXT NOT NULL DEFAULT '',
    variable_schema JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (template_id, version_number)
);

CREATE TABLE contact_lists (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE contacts (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           CITEXT NOT NULL,
    first_name      TEXT,
    last_name       TEXT,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    attributes      JSONB NOT NULL DEFAULT '{}'::JSONB,
    consent_source  TEXT NOT NULL,
    consented_at    TIMESTAMPTZ NOT NULL,
    unsubscribed_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, email)
);

CREATE TABLE contact_list_memberships (
    list_id    UUID NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE campaigns (
    id                  UUID PRIMARY KEY,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_id           UUID NOT NULL REFERENCES domains(id),
    template_version_id UUID REFERENCES template_versions(id),
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    scheduled_at        TIMESTAMPTZ,
    target_filter       JSONB NOT NULL DEFAULT '{}'::JSONB,
    stats_cache         JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE suppression_entries (
    id                UUID PRIMARY KEY,
    organization_id   UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email             CITEXT NOT NULL,
    reason            TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribe', 'manual')),
    source_message_id UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_suppression_org_email
    ON suppression_entries (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::UUID), email);

-- ---------------------------------------------------------------------------
-- 7. Core Messages, Recipients, Delivery Attempts & Analytics
-- ---------------------------------------------------------------------------

CREATE TABLE messages (
    id                UUID PRIMARY KEY,
    organization_id   UUID NOT NULL REFERENCES organizations(id),
    domain_id         UUID REFERENCES domains(id),
    campaign_id       UUID REFERENCES campaigns(id),
    source_type       TEXT NOT NULL CHECK (source_type IN ('api', 'smtp', 'campaign', 'webmail', 'inbound')),
    direction         TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    idempotency_key   VARCHAR(128),
    envelope_from     CITEXT NOT NULL,
    header_from       TEXT NOT NULL,
    subject           TEXT NOT NULL DEFAULT '',
    message_id_header TEXT NOT NULL,
    body_storage_key  TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL,
    state             TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'queued', 'processing', 'accepted_remote', 'deferred', 'bounced', 'rejected', 'cancelled')),
    ip_pool_id        UUID REFERENCES ip_pools(id),
    scheduled_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_messages_idempotency
    ON messages(organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_messages_org_created ON messages(organization_id, created_at DESC);

CREATE TABLE message_recipients (
    id                   UUID PRIMARY KEY,
    message_id           UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    organization_id      UUID NOT NULL REFERENCES organizations(id),
    recipient_email      CITEXT NOT NULL,
    recipient_domain     TEXT NOT NULL,
    recipient_type       TEXT NOT NULL DEFAULT 'to' CHECK (recipient_type IN ('to', 'cc', 'bcc', 'inbound')),
    state                TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'accepted_remote', 'deferred', 'bounced', 'rejected', 'cancelled')),
    attempt_count        SMALLINT NOT NULL DEFAULT 0,
    next_retry_at        TIMESTAMPTZ,
    ambiguous_after_data BOOLEAN NOT NULL DEFAULT FALSE,
    last_smtp_code       SMALLINT,
    last_enhanced_code   VARCHAR(16),
    last_smtp_response   TEXT,
    remote_mx_host       TEXT,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recipients_retry
    ON message_recipients(next_retry_at)
    WHERE state = 'deferred';
CREATE INDEX idx_recipients_message ON message_recipients(message_id);

CREATE TABLE delivery_attempts (
    id                   UUID NOT NULL,
    message_recipient_id UUID NOT NULL,
    message_id           UUID NOT NULL,
    organization_id      UUID NOT NULL,
    mta_node_id          TEXT NOT NULL,
    sending_ip           INET,
    remote_mx_host       TEXT,
    remote_ip            INET,
    tls_used             BOOLEAN NOT NULL DEFAULT FALSE,
    tls_verified         BOOLEAN NOT NULL DEFAULT FALSE,
    tls_cipher           TEXT,
    attempt_no           SMALLINT NOT NULL,
    smtp_code            SMALLINT,
    enhanced_code        VARCHAR(16),
    smtp_response        TEXT,
    outcome              TEXT NOT NULL CHECK (outcome IN ('accepted', 'deferred', 'bounced', 'rejected', 'network_error')),
    duration_ms          INTEGER NOT NULL,
    attempted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, attempted_at)
) PARTITION BY RANGE (attempted_at);

CREATE INDEX idx_delivery_attempts_recipient ON delivery_attempts(message_recipient_id, attempted_at DESC);

CREATE TABLE email_events (
    id                   UUID NOT NULL,
    organization_id      UUID NOT NULL,
    domain_id            UUID,
    campaign_id          UUID,
    message_id           UUID NOT NULL,
    message_recipient_id UUID,
    event_type           TEXT NOT NULL CHECK (event_type IN ('accepted', 'delivered', 'deferred', 'bounced', 'rejected', 'complained', 'unsubscribed', 'opened', 'clicked')),
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX idx_email_events_org_type_time ON email_events(organization_id, event_type, occurred_at DESC);

CREATE TABLE daily_domain_metrics (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_id       UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    metric_date     DATE NOT NULL,
    sent            BIGINT NOT NULL DEFAULT 0,
    accepted_remote BIGINT NOT NULL DEFAULT 0,
    deferred        BIGINT NOT NULL DEFAULT 0,
    hard_bounced    BIGINT NOT NULL DEFAULT 0,
    soft_bounced    BIGINT NOT NULL DEFAULT 0,
    complaints      BIGINT NOT NULL DEFAULT 0,
    opens           BIGINT NOT NULL DEFAULT 0,
    clicks          BIGINT NOT NULL DEFAULT 0,
    unsubscribes    BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (organization_id, domain_id, metric_date)
);

-- ---------------------------------------------------------------------------
-- 8. Webhooks & Transactional Outbox
-- ---------------------------------------------------------------------------

CREATE TABLE webhooks (
    id                         UUID PRIMARY KEY,
    organization_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url                        TEXT NOT NULL,
    encrypted_signing_secret   BYTEA NOT NULL,
    previous_secret_expires_at TIMESTAMPTZ,
    event_types                TEXT[] NOT NULL,
    is_active                  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
    id            UUID PRIMARY KEY,
    webhook_id    UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id      UUID NOT NULL,
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    http_status   SMALLINT,
    response_body TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(next_retry_at) WHERE status = 'pending';

CREATE TABLE outbox_events (
    id             BIGSERIAL PRIMARY KEY,
    aggregate_type TEXT NOT NULL,
    aggregate_id   UUID NOT NULL,
    exchange       TEXT NOT NULL,
    routing_key    TEXT NOT NULL,
    payload        JSONB NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
    locked_at      TIMESTAMPTZ,
    published_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON outbox_events(id) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- 9. Billing & Platform System Configuration
-- ---------------------------------------------------------------------------

CREATE TABLE plans (
    id                UUID PRIMARY KEY,
    slug              TEXT NOT NULL UNIQUE CHECK (slug IN ('free', 'starter', 'professional', 'business', 'enterprise')),
    name              TEXT NOT NULL,
    monthly_price_cents INTEGER NOT NULL,
    annual_price_cents  INTEGER NOT NULL,
    included_emails   INTEGER NOT NULL,
    max_domains       INTEGER NOT NULL,
    max_mailboxes     INTEGER NOT NULL,
    max_storage_gb    INTEGER NOT NULL,
    features          JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE subscriptions (
    id                   UUID PRIMARY KEY,
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id              UUID NOT NULL REFERENCES plans(id),
    billing_cycle        TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
    status               TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'suspended', 'cancelled')),
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end   TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE usage_records (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    period_month    DATE NOT NULL,
    emails_sent     BIGINT NOT NULL DEFAULT 0,
    storage_bytes   BIGINT NOT NULL DEFAULT 0,
    api_requests    BIGINT NOT NULL DEFAULT 0,
    UNIQUE (organization_id, period_month)
);

CREATE TABLE invoices (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id),
    amount_cents    INTEGER NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    status          TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ
);

CREATE TABLE system_settings (
    id         UUID PRIMARY KEY,
    version    INTEGER NOT NULL UNIQUE,
    config     JSONB NOT NULL,
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
