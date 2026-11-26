-- 0006_dkim_hardening.sql
-- Non-destructive hardening migration for DKIM fail-closed signing policy,
-- single-active-key invariant per domain, and KEK version validation.

ALTER TABLE domains
    ADD COLUMN IF NOT EXISTS dkim_policy TEXT NOT NULL DEFAULT 'required'
        CHECK (dkim_policy IN ('required', 'optional'));

-- Non-destructive guard: if any domain somehow accumulated multiple 'active' rows
-- prior to adding the partial unique index, preserve the newest one and retire older duplicates.
WITH ranked_active AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY domain_id ORDER BY created_at DESC, id DESC) AS rn
      FROM dkim_keys
     WHERE status = 'active'
)
UPDATE dkim_keys k
   SET status = 'retiring',
       rotated_at = COALESCE(k.rotated_at, NOW())
  FROM ranked_active r
 WHERE k.id = r.id
   AND r.rn > 1;

-- Backfill domains.active_dkim_selector only where NULL
UPDATE domains d
   SET active_dkim_selector = k.selector
  FROM dkim_keys k
 WHERE k.domain_id = d.id
   AND k.status = 'active'
   AND d.active_dkim_selector IS NULL;

-- Enforce at most one active DKIM signing key per domain at the database level
CREATE UNIQUE INDEX IF NOT EXISTS uq_dkim_keys_one_active_per_domain
    ON dkim_keys (domain_id)
    WHERE status = 'active';

-- Ensure every stored encrypted key has a valid KEK version >= 1
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_dkim_keys_enc_version_pos'
    ) THEN
        ALTER TABLE dkim_keys
            ADD CONSTRAINT chk_dkim_keys_enc_version_pos CHECK (key_encryption_version >= 1);
    END IF;
END $$;
