# Cloud Deployment, Domain & Let's Encrypt TLS Guide

Follow these steps to deploy MailForge on a cloud Ubuntu VPS (AWS EC2 with Docker Engine & Compose) and send real emails using valid Let's Encrypt certificates for `mx1.fastconnect.in`.

---

## 1. Server Requirements
1. Ubuntu cloud VPS (e.g., AWS EC2) with a **public static IPv4** and **outbound TCP port 25 unblocked** (request AWS EC2 port 25 / rDNS removal if throttled on a new account).
2. Security Group / Firewall ingress ports:
   - `22` (SSH)
   - `25` (Server-to-server MX SMTP + STARTTLS)
   - `465`, `587` (Authenticated SMTP submission over TLS)
   - `80`, `443` (Web consoles, API & ACME HTTP-01 challenge via Nginx)
   - `993` (IMAPS via Dovecot, optional if using external mail clients)
3. **Host isolation**: Do NOT install PostgreSQL, Redis, RabbitMQ, MinIO, Dovecot, Node, or Rust directly on the Ubuntu host — all application services run in Docker. Database, Redis, RabbitMQ, Prometheus, Grafana, and MTA metrics ports bind only to `127.0.0.1`.

---

## 2. Configure Root `.env` (Never Committed)

```bash
cp .env.example .env
```

Replace all default placeholders inside `.env` (`NODE_ENV=production` rejects placeholder secrets):

| Variable | Example / Action | Purpose |
|---|---|---|
| `PRIMARY_DOMAIN` | `fastconnect.in` | DKIM signing, allowed sender patterns, and initial workspace domain |
| `MAIL_HELO_DOMAIN` | `mx1.fastconnect.in` | `EHLO` banner announced to remote MX servers (must match PTR) |
| `SMTP_SERVER_DOMAIN` | `mx1.fastconnect.in` | Inbound SMTP `220` greeting hostname |
| `TLS_DOMAIN` | `mx1.fastconnect.in` | Subdirectory under `/etc/letsencrypt/live/<TLS_DOMAIN>` synced to `/etc/mail-certs` |
| `LETSENCRYPT_HOST_DIR` | `/etc/letsencrypt` | Host Let's Encrypt directory mounted `:ro` only into `tls-init` |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | `/etc/mail-certs/fullchain.pem` / `privkey.pem` | Paths inside `mail-engine`, `dovecot`, and `nginx` |
| `ADMIN_BOOTSTRAP_EMAIL` / `PASSWORD` | Strong unique credentials | Initial Super Admin login |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `openssl rand -hex 32` | Unique JWT signing keys |
| `DKIM_KEK_HEX` | `openssl rand -hex 32` | 32-byte AES-256-GCM key encrypting stored DKIM private keys |
| `MAIL_ENGINE_CONTROL_TOKEN` | `openssl rand -hex 24` | Bearer token for `/control/drain` and `/control/resume` |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD` | Strong random passwords | Keep matching credentials inside `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL` |
| `SPOOL_BACKEND` / `COMPOSE_PROFILES` | `local` + empty (or `s3` + `s3`) | Select local volume `spooldata` or start optional `minio` container |

---

## 3. Publish DNS & Reverse DNS Records

Replace `<YOUR_EC2_PUBLIC_IP>` with your Elastic IP:

1. **Reverse DNS (PTR)** — Set via AWS EC2 Elastic IP / Route 53 form:
   - `<YOUR_EC2_PUBLIC_IP>` → `mx1.fastconnect.in`
2. **A Records**:
   - `mx1.fastconnect.in` → `<YOUR_EC2_PUBLIC_IP>`
   - `app.fastconnect.in`, `mail.fastconnect.in`, `admin.fastconnect.in` → `<YOUR_EC2_PUBLIC_IP>`
3. **MX Record**:
   - `@` (`fastconnect.in`) → `10 mx1.fastconnect.in`
4. **SPF Record (`TXT`)**:
   - `@` → `v=spf1 ip4:<YOUR_EC2_PUBLIC_IP> -all`
5. **DMARC Record (`TXT`)**:
   - `_dmarc` → `v=DMARC1; p=quarantine; rua=mailto:dmarc@fastconnect.in`
6. **DKIM Record (`TXT`)**:
   - Generated automatically on `mail-engine` startup and persisted in PostgreSQL `dkim_keys` (check Developer Console -> Domains & DNS or `logs mail-engine | grep DKIM`).

---

## 4. TLS / Let's Encrypt Certificates (`mx1.fastconnect.in`)

### How Container Certificate Loading & Symlinks Work
`certbot` writes relative symlinks in `/etc/letsencrypt/live/mx1.fastconnect.in/{fullchain,privkey}.pem` pointing to `../../archive/...` (owned `root:root`, `0600`), while `mail-engine` runs as non-root UID `1000`.
- `tls-init` mounts `${LETSENCRYPT_HOST_DIR:-/etc/letsencrypt}:/etc/letsencrypt:ro` and `./certs:/etc/mail-certs`.
- If valid Let's Encrypt certificates exist at `/etc/letsencrypt/live/${TLS_DOMAIN}`, `tls-init` **dereferences symlinks (`cp -L`)** into `./certs/fullchain.pem` and `./certs/privkey.pem` with `chown 1000:1000` and mode `0644`/`0640`.
- If Let's Encrypt certificates do not exist yet, `tls-init` preserves any manually placed certificates in `./certs/` or generates a temporary self-signed certificate so local/staging boots succeed without crash loops.
- `mail-engine`, `dovecot`, and `nginx` mount `./certs:/etc/mail-certs:ro` cleanly without direct access to `/etc/letsencrypt`.

### Initial Let's Encrypt Issuance on Ubuntu EC2
Before booting the stack (when port `80` is free), issue the certificate on the host:
```bash
sudo apt-get update && sudo apt-get install -y certbot
sudo certbot certonly --standalone -d mx1.fastconnect.in \
  -m admin@fastconnect.in --agree-tos --non-interactive
```

### Automated Renewal & Safe MTA Drain/Restart
Configure Certbot's deploy hook so renewed certificates are copied into `./certs/`, `mail-engine` gracefully drains active SMTP connections, and `mail-engine`, `dovecot`, and `nginx` load the new certificate cleanly:
```bash
sudo ln -sf "$(pwd)/scripts/sync-tls-certs.sh" /etc/letsencrypt/renewal-hooks/deploy/mailplat-sync.sh

# Test renewal & hook dry run:
sudo certbot renew --dry-run
```
If certificates were already running with self-signed certs and you later obtain Let's Encrypt certs while the stack is up, run:
```bash
sudo ./scripts/sync-tls-certs.sh --force
```

---

## 5. Deploy Stack & Run Database Migrations

```bash
# 1. Start the full containerized stack (migrations remain an explicit step)
sudo docker compose --env-file .env -f infrastructure/docker/docker-compose.yml up -d --build

# 2. Apply SQL migrations cleanly (uses Postgres container automatically if psql is not on host)
set -a && source .env && set +a
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
./scripts/migrate.sh

# 3. Restart app containers once after first-time migration so bootstrapped admin/domain persist in Postgres
sudo docker compose --env-file .env -f infrastructure/docker/docker-compose.yml restart api scheduler mail-engine dovecot

# 4. Verify container health & TLS certificates inside mail-engine
sudo docker compose --env-file .env -f infrastructure/docker/docker-compose.yml ps
sudo docker compose --env-file .env -f infrastructure/docker/docker-compose.yml exec -T mail-engine ls -l /etc/mail-certs/
curl -fsS http://127.0.0.1/readyz
```

---

## 6. Send a Verification Email

Create an `mk_live_*` API key in the Developer Console (`https://app.fastconnect.in`), then run:
```bash
API_KEY="mk_live_..." \
FROM_EMAIL="hello@fastconnect.in" \
TO_EMAIL="your-personal-email@gmail.com" \
node scripts/send-test-email.mjs
```
