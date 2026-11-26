#!/usr/bin/env bash
set -euo pipefail

# Safely dereferences Let's Encrypt symlinks from /etc/letsencrypt/live/<domain>
# into ./certs/ (mounted at /etc/mail-certs:ro in mail-engine, dovecot, nginx)
# and gracefully drains + restarts mail-engine when certificates change.

SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v readlink >/dev/null 2>&1 && readlink -f "$SCRIPT_PATH" >/dev/null 2>&1; then
  SCRIPT_PATH="$(readlink -f "$SCRIPT_PATH")"
fi
ROOT_DIR="${MAILPLAT_ROOT_DIR:-$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)}"
COMPOSE_FILE="${ROOT_DIR}/infrastructure/docker/docker-compose.yml"
ENV_FILE="${ROOT_DIR}/.env"
CERTS_DIR="${ROOT_DIR}/certs"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

TLS_DOMAIN="${TLS_DOMAIN:-${SMTP_SERVER_DOMAIN:-mx1.fastconnect.in}}"
LE_BASE="${LETSENCRYPT_HOST_DIR:-/etc/letsencrypt}"
LE_LIVE="${LE_BASE}/live/${TLS_DOMAIN}"
FORCE_RELOAD="${1:-}"

if [[ ! -s "${LE_LIVE}/fullchain.pem" ]] || [[ ! -s "${LE_LIVE}/privkey.pem" ]]; then
  echo "ERROR: Let's Encrypt files not found at ${LE_LIVE}/{fullchain,privkey}.pem" >&2
  exit 1
fi

openssl x509 -in "${LE_LIVE}/fullchain.pem" -noout
CERT_PUB="$(openssl x509 -in "${LE_LIVE}/fullchain.pem" -pubkey -noout)"
KEY_PUB="$(openssl pkey -in "${LE_LIVE}/privkey.pem" -pubout)"
if [[ "$CERT_PUB" != "$KEY_PUB" ]]; then
  echo "ERROR: Certificate public key does not match private key at ${LE_LIVE}" >&2
  exit 1
fi

mkdir -p "$CERTS_DIR"
CHANGED=0
if ! cmp -s "${LE_LIVE}/fullchain.pem" "${CERTS_DIR}/fullchain.pem" 2>/dev/null \
  || ! cmp -s "${LE_LIVE}/privkey.pem" "${CERTS_DIR}/privkey.pem" 2>/dev/null; then
  TMP_CERT="${CERTS_DIR}/.fullchain.pem.tmp"
  TMP_KEY="${CERTS_DIR}/.privkey.pem.tmp"
  cp -L "${LE_LIVE}/fullchain.pem" "$TMP_CERT"
  cp -L "${LE_LIVE}/privkey.pem" "$TMP_KEY"
  mv "$TMP_CERT" "${CERTS_DIR}/fullchain.pem"
  mv "$TMP_KEY" "${CERTS_DIR}/privkey.pem"
  CHANGED=1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  chown 1000:1000 "$CERTS_DIR" "${CERTS_DIR}/fullchain.pem" "${CERTS_DIR}/privkey.pem"
fi
chmod 750 "$CERTS_DIR"
chmod 644 "${CERTS_DIR}/fullchain.pem"
chmod 640 "${CERTS_DIR}/privkey.pem"

if [[ "$CHANGED" -eq 1 ]] || [[ "$FORCE_RELOAD" == "--force" ]]; then
  echo "TLS certificate updated for ${TLS_DOMAIN}; draining mail-engine and reloading services..."
  CONTROL_PORT="${METRICS_PORT:-9100}"
  if [[ -n "${MAIL_ENGINE_CONTROL_TOKEN:-}" ]]; then
    curl -fsS -X POST "http://127.0.0.1:${CONTROL_PORT}/control/drain" \
      -H "Authorization: Bearer ${MAIL_ENGINE_CONTROL_TOKEN}" >/dev/null 2>&1 || true
    sleep 3
  fi

  if [[ -f "$ENV_FILE" ]]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart mail-engine dovecot
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T nginx nginx -s reload || \
      docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart nginx
  fi
  echo "TLS certificate sync and safe reload completed."
else
  echo "TLS certificate unchanged for ${TLS_DOMAIN}; no restart needed."
fi
