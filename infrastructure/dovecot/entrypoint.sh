#!/bin/sh
set -eu

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required for Dovecot SQL authentication}"
PG_HOST="${POSTGRES_HOST:-postgres}"
PG_DB="${POSTGRES_DB:-mailplat}"
PG_USER="${POSTGRES_USER:-mailplat}"

sed \
  -e "s/__POSTGRES_HOST__/${PG_HOST}/g" \
  -e "s/__POSTGRES_DB__/${PG_DB}/g" \
  -e "s/__POSTGRES_USER__/${PG_USER}/g" \
  -e "s/__POSTGRES_PASSWORD__/$(printf '%s' "$POSTGRES_PASSWORD" | sed 's/[&/\]/\\&/g')/g" \
  /etc/dovecot/dovecot-sql.conf.ext.tmpl > /etc/dovecot/dovecot-sql.conf.ext
chmod 600 /etc/dovecot/dovecot-sql.conf.ext

mkdir -p /etc/dovecot/tls
if [ -s "${TLS_CERT_PATH:-/etc/mail-certs/fullchain.pem}" ] && [ -s "${TLS_KEY_PATH:-/etc/mail-certs/privkey.pem}" ]; then
  cp "${TLS_CERT_PATH:-/etc/mail-certs/fullchain.pem}" /etc/dovecot/tls/fullchain.pem
  cp "${TLS_KEY_PATH:-/etc/mail-certs/privkey.pem}" /etc/dovecot/tls/privkey.pem
elif [ ! -s /etc/dovecot/tls/fullchain.pem ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -subj "/CN=${PRIMARY_DOMAIN:-mail.localhost}" \
    -keyout /etc/dovecot/tls/privkey.pem \
    -out /etc/dovecot/tls/fullchain.pem 2>/dev/null
fi
chmod 600 /etc/dovecot/tls/privkey.pem

exec dovecot -F
