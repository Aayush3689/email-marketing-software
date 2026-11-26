# Cloud Deployment & Domain Setup Guide

Follow these steps to deploy MailForge on a Linux cloud VPS (Ubuntu/Debian with Docker) and send real emails to external recipients.

---

## 1. Server Requirements
1. A cloud VPS with a **public static IPv4** and **outbound TCP port 25 unblocked** (note: check with your cloud provider—many block port 25 on new accounts until you request unblocking).
2. Open firewall ports:
   - `25` (Server-to-server MX SMTP)
   - `465`, `587` (Authenticated SMTP submission)
   - `80`, `443` (Web dashboards & API via Nginx)
   - `143` / `993` (Optional IMAP if connecting external mail clients)

---

## 2. Where to Set Your Domain, Passwords & Mail Settings

Everything lives in **one single `.env` file** at the repository root:

```bash
cp .env.example .env
```

Edit Section 1 (`YOUR DOMAIN & QUICK-START IDENTITY`) and Section 3 (`SECURITY SECRETS`) inside `.env`:

| Variable | What to put | Purpose |
|---|---|---|
| `PRIMARY_DOMAIN` | `yourdomain.com` | Domain used for DKIM signing, allowed SMTP sender patterns, and initial workspace bootstrap |
| `MAIL_HELO_DOMAIN` | `mx1.yourdomain.com` | Hostname your Rust MTA announces in `EHLO` (must match your IP's PTR record) |
| `SMTP_SERVER_DOMAIN` | `mx1.yourdomain.com` | Hostname greeting on incoming SMTP (`220 mx1.yourdomain.com ESMTP`) |
| `ADMIN_BOOTSTRAP_EMAIL` | `admin@yourdomain.com` | Initial owner & Super Admin login email |
| `ADMIN_BOOTSTRAP_PASSWORD` | Strong 12+ char password | Initial Super Admin login password |
| `SMTP_AUTH_USERNAME` / `SMTP_AUTH_PASSWORD` | Relay login + password | Ready-to-use SMTP submission login for apps connecting on port `587`/`465` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `openssl rand -hex 32` | JWT signing keys (minimum 32 characters) |
| `DKIM_KEK_HEX` | `openssl rand -hex 32` | 256-bit AES-GCM key encrypting DKIM private keys |
| `SPOOL_BACKEND` | `local` or `s3` | Choose local NVMe Docker volume (`local`) or S3/MinIO (`s3`) |

---

## 3. Publish These DNS Records for `yourdomain.com`

Replace `<YOUR_SERVER_IP>` with your VPS IPv4 address:

1. **Reverse DNS (PTR)** — Set inside your **cloud provider's dashboard** (AWS/Hetzner/DO/Vultr Networking panel):
   - `<YOUR_SERVER_IP>` → `mx1.yourdomain.com`
2. **A Record**:
   - Host: `mx1.yourdomain.com` → Value: `<YOUR_SERVER_IP>`
   - Host: `mail.yourdomain.com` (UI) → Value: `<YOUR_SERVER_IP>`
   - Host: `api.yourdomain.com` (API) → Value: `<YOUR_SERVER_IP>`
3. **MX Record** (for receiving mail/bounces):
   - Host: `@` (`yourdomain.com`) → Value: `10 mx1.yourdomain.com`
4. **SPF Record (TXT)**:
   - Host: `@` → Value: `v=spf1 ip4:<YOUR_SERVER_IP> ~all`
5. **DMARC Record (TXT)**:
   - Host: `_dmarc` → Value: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`
6. **DKIM Record (TXT)**:
   - When `mail-engine` starts with `DKIM_AUTO_GENERATE=true`, check its startup logs:
     ```bash
     docker compose -f infrastructure/docker/docker-compose.yml logs mail-engine | grep DKIM
     ```
   - Copy the printed `dns_record_name` (`mp1._domainkey.yourdomain.com`) and `dns_txt_value` (`v=DKIM1; k=rsa; p=...`) into your DNS provider!

---

## 4. Mount TLS Certificates (Optional for Port 25, Required for Port 587/465 AUTH)

Using Certbot on your VPS for `mx1.yourdomain.com`:
```bash
sudo certbot certonly --standalone -d mx1.yourdomain.com
```
Point `./certs` (or update volume mount in `docker-compose.yml`) to `/etc/letsencrypt/live/mx1.yourdomain.com`.

---

## 5. Start the Stack & Apply Database Migrations

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d --build postgres redis rabbitmq
DATABASE_URL=postgresql://mailplat:change_me_local_dev_only@localhost:5432/mailplat ./scripts/migrate.sh
docker compose -f infrastructure/docker/docker-compose.yml up -d --build
```

Look up your bootstrapped `organizationId` and `domainId` in the API logs:
```bash
docker compose -f infrastructure/docker/docker-compose.yml logs api | grep Bootstrapped
```

---

## 6. Send Your First Real Email

Either use the Developer Dashboard UI (`apps/web`, port `5173`), an SMTP client on port `587`, or the built-in CLI script:

```bash
API_URL=http://localhost:4000 \
ORG_ID=<organizationId_from_logs> \
DOMAIN_ID=<domainId_from_logs> \
FROM=hello@yourdomain.com \
TO=your-personal-email@gmail.com \
node scripts/send-test-email.mjs
```

> **Note on Deliverability:** With outbound port `25`, `A`/`PTR`, `SPF`, and `DKIM` configured, Gmail/Outlook will accept the message over SMTP (new IPs may initially place mail in **Spam** until IP warmup and reputation build).
