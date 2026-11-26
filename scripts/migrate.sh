#!/usr/bin/env bash
set -euo pipefail

# Applies SQL migrations in migrations/ sequentially and records applied versions.
DATABASE_URL="${DATABASE_URL:?DATABASE_URL environment variable is required}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

run_psql() {
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" "$@"
  else
    docker compose -f "${ROOT_DIR}/infrastructure/docker/docker-compose.yml" exec -T postgres \
      psql -U "${POSTGRES_USER:-mailplat}" -d "${POSTGRES_DB:-mailplat}" "$@"
  fi
}

run_psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL

for file in "${ROOT_DIR}"/migrations/*.sql; do
    version="$(basename "$file")"
    already_applied="$(run_psql -v ON_ERROR_STOP=1 -v ver="$version" -tA <<'SQL'
SELECT 1 FROM schema_migrations WHERE version = :'ver';
SQL
)"
    if [[ "$already_applied" == "1" ]]; then
        echo "Skipping already applied migration: $version"
        continue
    fi

    echo "Applying migration: $version"
    run_psql -v ON_ERROR_STOP=1 --single-transaction -f - < "$file"
    run_psql -v ON_ERROR_STOP=1 -v ver="$version" <<'SQL'
INSERT INTO schema_migrations (version) VALUES (:'ver') ON CONFLICT DO NOTHING;
SQL
done

echo "All migrations applied successfully."
