#!/usr/bin/env bash
set -euo pipefail

# Point-in-time PostgreSQL backup & verification drill for Disaster Recovery.
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mailplat}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL environment variable is required}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="${BACKUP_DIR}/mailplat-${STAMP}.dump"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

echo "[1/4] Creating custom-format pg_dump snapshot -> ${DUMP_FILE}"
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump --format=custom --no-owner --no-acl --file="$DUMP_FILE" "$DATABASE_URL"
else
  docker compose -f "${ROOT_DIR}/infrastructure/docker/docker-compose.yml" exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-mailplat}" -d "${POSTGRES_DB:-mailplat}" --format=custom --no-owner --no-acl > "$DUMP_FILE"
fi

echo "[2/4] Verifying archive integrity via pg_restore --list"
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$DUMP_FILE" > "${DUMP_FILE}.toc"
  if [[ -n "${DR_VERIFY_DATABASE_URL:-}" ]]; then
    pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DR_VERIFY_DATABASE_URL" "$DUMP_FILE"
    psql "$DR_VERIFY_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) AS org_count FROM organizations;"
  fi
fi

if [[ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]]; then
  echo "[3/4] Encrypting archive with AES-256-CBC (PBKDF2)"
  openssl enc -aes-256-cbc -salt -pbkdf2 -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
    -in "$DUMP_FILE" -out "${DUMP_FILE}.enc"
  rm -f "$DUMP_FILE"
  DUMP_FILE="${DUMP_FILE}.enc"
fi

if [[ -d "${SPOOL_DIR:-/var/spool/mailplat}" ]]; then
  echo "[4/4] Archiving local spool directory snapshot"
  tar -czf "${BACKUP_DIR}/spool-${STAMP}.tar.gz" -C "${SPOOL_DIR:-/var/spool/mailplat}" .
fi

find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete || true
echo "DR backup complete: ${DUMP_FILE}"
