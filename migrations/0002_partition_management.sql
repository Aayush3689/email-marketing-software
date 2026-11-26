-- 0002_partition_management.sql
-- Automatic UTC monthly range partition provisioning + DEFAULT safety partitions.

CREATE OR REPLACE FUNCTION ensure_monthly_partitions(months_ahead INTEGER DEFAULT 3)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    tbl TEXT;
    target_tables TEXT[] := ARRAY['audit_logs', 'delivery_attempts', 'email_events'];
    i INTEGER;
    start_ts TIMESTAMPTZ;
    end_ts TIMESTAMPTZ;
    part_name TEXT;
BEGIN
    FOREACH tbl IN ARRAY target_tables LOOP
        -- Guarantee a DEFAULT catch-all partition so an out-of-window insert never fails.
        EXECUTE FORMAT(
            'CREATE TABLE IF NOT EXISTS %I_default PARTITION OF %I DEFAULT',
            tbl, tbl
        );

        FOR i IN 0..months_ahead LOOP
            start_ts := DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                + (i || ' months')::INTERVAL;
            end_ts := start_ts + INTERVAL '1 month';
            part_name := FORMAT('%s_%s', tbl, TO_CHAR(start_ts AT TIME ZONE 'UTC', 'YYYY_MM'));

            EXECUTE FORMAT(
                'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                part_name, tbl, start_ts, end_ts
            );
        END LOOP;
    END LOOP;
END;
$$;

-- Provision default partitions plus current UTC month and 3 months ahead immediately.
SELECT ensure_monthly_partitions(3);
