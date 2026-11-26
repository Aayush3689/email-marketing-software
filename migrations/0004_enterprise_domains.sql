-- 0004_enterprise_domains.sql
-- Enterprise domain sending/authentication settings, security policies (MTA-STS, TLS-RPT, BIMI),
-- background DNS verification jobs, and audit log lookup optimization.

ALTER TABLE domains
    ADD COLUMN IF NOT EXISTS default_sender_local_part TEXT,
    ADD COLUMN IF NOT EXISTS dmarc_rua TEXT,
    ADD COLUMN IF NOT EXISTS dmarc_ruf TEXT,
    ADD COLUMN IF NOT EXISTS dmarc_pct SMALLINT NOT NULL DEFAULT 100 CHECK (dmarc_pct BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS dmarc_aspf TEXT NOT NULL DEFAULT 'r' CHECK (dmarc_aspf IN ('r', 's')),
    ADD COLUMN IF NOT EXISTS dmarc_adkim TEXT NOT NULL DEFAULT 'r' CHECK (dmarc_adkim IN ('r', 's')),
    ADD COLUMN IF NOT EXISTS daily_send_limit INTEGER CHECK (daily_send_limit IS NULL OR daily_send_limit >= 0),
    ADD COLUMN IF NOT EXISTS mta_sts_mode TEXT NOT NULL DEFAULT 'none' CHECK (mta_sts_mode IN ('none', 'testing', 'enforce')),
    ADD COLUMN IF NOT EXISTS mta_sts_max_age INTEGER NOT NULL DEFAULT 86400 CHECK (mta_sts_max_age >= 60),
    ADD COLUMN IF NOT EXISTS tls_rpt_rua TEXT,
    ADD COLUMN IF NOT EXISTS bimi_selector TEXT NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS bimi_logo_url TEXT,
    ADD COLUMN IF NOT EXISTS bimi_vmc_url TEXT,
    ADD COLUMN IF NOT EXISTS last_dns_checked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_auth_passed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS domain_dns_jobs (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain_id       UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    trigger_source  TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_source IN ('manual', 'scheduled', 'verify', 'auto')),
    requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    result_check_id UUID REFERENCES domain_dns_checks(id) ON DELETE SET NULL,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_domain_dns_jobs_domain
    ON domain_dns_jobs (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_domain_dns_jobs_pending
    ON domain_dns_jobs (status, created_at ASC)
    WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
    ON audit_logs (resource_type, resource_id, created_at DESC);
