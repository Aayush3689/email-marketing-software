# Deployment & Disaster Recovery Gaps

**Audit Date:** 2026-11-26  
**Scope:** Dockerfiles, `docker-compose.yml`, `.env.example`, Nginx, Dovecot, Prometheus/Alerts, database migrations, and backup/restore scripts.

---

## 1. Docker Compose & Network Security (`infrastructure/docker/docker-compose.yml`)

### DEP-01 — Internal Infrastructure & Admin Ports Exposed on `0.0.0.0`
- **Severity:** **Critical**
- **Affected Files / Modules:** `infrastructure/docker/docker-compose.yml:9-10, 25-26, 43-45, 63-65, 75-77, 94-95, 132-133, 147-151, 170-197, 204-217`
- **Exact Technical Issue:** `postgres` (`5432`), passwordless `redis` (`6379`), `rabbitmq` (`5672`, `15672`), `minio` (`9000`, `9001`), unauthenticated `dovecot` LMTP (`2424`) and plaintext IMAP (`1430`), `api` (`4000`), `mailbox-service` (`4100`), `mail-engine` control (`9100`), `prometheus` (`9090`), `grafana` (`3001`), and raw web UIs (`5173-5175`) all bind to `0.0.0.0` instead of internal Docker networking or `127.0.0.1`.
- **Business / Operational Impact:** Deploying `docker-compose.yml` on a clean cloud VPS exposes databases, queues, unauthenticated LMTP mail injection, and MTA node drain controls directly to the public internet.
- **Recommended Fix:** Remove `ports:` from all internal services (`postgres`, `redis`, `rabbitmq`, `dovecot` port 24, `api`, `mailbox-service`, `web`, `mail`, `admin`), bind ops UIs (`prometheus`, `grafana`, `9100`, `15672`, `9001`) strictly to `127.0.0.1:...`, add Redis `--requirepass`, and enforce strong Grafana admin creds via `.env`.
- **How to Verify:** Run `docker compose config` and `ss -tulpn` on VPS confirming only `25`, `465`, `587`, `80/443`, and `993` are bound externally.

### DEP-02 — Missing Container `restart` Policies & `healthcheck` Probes
- **Severity:** **High**
- **Affected Files / Modules:** `infrastructure/docker/docker-compose.yml:1-239`
- **Exact Technical Issue:** Zero services configure `restart: unless-stopped`. Twelve services (`minio`, `dovecot`, `api`, `scheduler`, `mailbox-service`, `mail-engine`, `web`, `mail`, `admin`, `prometheus`, `grafana`, `nginx`) lack `healthcheck` probes, and `nginx`/`mailbox-service` depend on `service_started` without health readiness gating.
- **Business / Operational Impact:** Host reboots or transient crashes leave services permanently offline; Docker/Nginx routes requests to unready containers.
- **Recommended Fix:** Add `restart: unless-stopped` and explicit `healthcheck` probes to every service (`api` `/healthz`, `mailbox-service` `/healthz`, `mail-engine` `/healthz`, `minio`, `dovecot`, `prometheus` `/-/healthy`, `grafana` `/api/health`, `nginx`).
- **How to Verify:** `docker compose ps` shows `(healthy)` for all services and automatic recovery after `docker kill`.

### DEP-03 — `SPOOL_BACKEND=s3` Broken Between `api` and `mail-engine` + Missing MinIO Bucket Init
- **Severity:** **Critical**
- **Affected Files / Modules:** `infrastructure/docker/docker-compose.yml:56-69, 96-97, 152-153`, `apps/api/src/index.ts:82`, `apps/api/src/config.ts`, `.env.example:55-62`
- **Exact Technical Issue:** `apps/api` hardcodes `LocalSpoolWriter` and ignores `SPOOL_BACKEND=s3` / `S3_*`. Enabling `SPOOL_BACKEND=s3` in `.env` causes `api` to write to local disk while `mail-engine` reads from MinIO (`NoSuchKey`). Furthermore, `minio` in compose never initializes the `mail-spool` bucket.
- **Business / Operational Impact:** Horizontal multi-node MTA scaling with shared S3 spool fails 100% of API-submitted emails; fresh MinIO startup fails every `PUT`.
- **Recommended Fix:** Add `S3SpoolWriter` in `apps/api` gated on `SPOOL_BACKEND=s3`, and add a one-shot `minio-init` container (`mc mb --ignore-existing local/mail-spool`) before `api`/`mail-engine` start.
- **How to Verify:** Set `SPOOL_BACKEND=s3`, run `docker compose up`, submit `POST /v1/emails`, and verify object exists in MinIO and is delivered by `mail-engine`.

### DEP-04 — Missing TLS Cert Mount Causes `mail-engine` Crash or Disabled Ports `587`/`465`
- **Severity:** **Critical**
- **Affected Files / Modules:** `infrastructure/docker/docker-compose.yml:140-160`, `Dockerfile.mail-engine:11`, `.env.example:74-75`, `services/mail-engine/src/main.rs:394-402`
- **Exact Technical Issue:** `.env.example` sets `TLS_CERT_PATH=/etc/mail-certs/fullchain.pem` and `TLS_KEY_PATH=/etc/mail-certs/privkey.pem`, while `Dockerfile.mail-engine` creates an empty `/etc/mail-certs` directory and `docker-compose.yml` never mounts certificates into it. On boot, `tokio::fs::read(cert_p).await?` fails with `ENOENT` and crashes `mail-engine` immediately.
- **Business / Operational Impact:** Deploying cleanly from `.env.example` + `docker compose up` causes `mail-engine` to enter a crash loop on first launch.
- **Recommended Fix:** Mount `./certs:/etc/mail-certs:ro` in `docker-compose.yml`, document/automate Certbot cert provisioning in `DEPLOYMENT.md`, and optionally auto-generate temporary self-signed certs for local dev when `MAIL_DEV_SELF_SIGNED_TLS=true` (while failing loudly in `NODE_ENV=production` with a clear error message).
- **How to Verify:** Run `docker compose up mail-engine` cleanly with mounted certs and test `STARTTLS` on 587 and implicit TLS on 465 via `openssl s_client`.

---

## 2. Dockerfiles & Image Hygiene

### DEP-05 — `Dockerfile.node` Fragile Alpine `argon2` Build, Missing Workspaces & `.dockerignore`
- **Severity:** **High**
- **Affected Files / Modules:** `infrastructure/docker/Dockerfile.node:1-18`, `.gitignore` (no `.dockerignore` exists)
- **Exact Technical Issue:** `RUN npm ci --ignore-scripts && npm rebuild argon2 || npm install` attempts native compilation on `node:22-alpine` without `python3`/`make`/`g++`, silently falling back to `|| npm install` outside `package-lock.json`; copies only backend `package.json` files despite workspace references; runs as `root`; and repo root lacks `.dockerignore`, uploading `target/`, `node_modules/`, `.git/`, and `.env` into Docker build context.
- **Business / Operational Impact:** Slow multi-GB Docker contexts, potential runtime `argon2` native module crash on Alpine, non-deterministic `npm install` fallback, and `.env` leakage risk into Docker build cache.
- **Recommended Fix:** Create `.dockerignore` (`node_modules`, `target`, `.git`, `.env`, `**/dist`, `**/dist-test`); use a multi-stage `Dockerfile.node` with build tools in builder stage, deterministic `npm ci` without `|| npm install`, and `USER node` in final runtime stage.
- **How to Verify:** `docker build -f infrastructure/docker/Dockerfile.node .` completes with small build context and `node -e "require('argon2').hash('test')"` works inside container as `USER node`.

---

## 3. Nginx, Monitoring & Dovecot Alignment

### DEP-06 — `nginx.conf` Exposes HTTP-Only, Blocks Webmail & Super Admin, Breaks `/healthz` & SSE
- **Severity:** **Critical**
- **Affected Files / Modules:** `infrastructure/nginx/nginx.conf:1-46`, `infrastructure/docker/docker-compose.yml:225-236`
- **Exact Technical Issue:**
  1. Only `listen 80` (no TLS `443`).
  2. `location /` routes solely to `web:80`—neither `mail:80` (`apps/mail`) nor `admin:80` (`apps/admin`) has any host/path route in `nginx.conf`.
  3. `/healthz` and `/readyz` hit `web:80` (`index.html` 200 OK) instead of `api:4000`.
  4. `/mail/v1/` lacks `proxy_buffering off` and extended `proxy_read_timeout`, breaking Webmail SSE `/mail/v1/events`.
- **Business / Operational Impact:** Webmail and Super Admin panels are unreachable behind Nginx; API readiness checks give false `200` from static SPA; real-time webmail sync fails; all traffic is unencrypted.
- **Recommended Fix:** Configure TLS `443` server blocks per host/domain (`app.*`, `mail.*`, `admin.*` or path-based fallback), proxy `/healthz` & `/readyz` to `api:4000`, and disable buffering/timeouts on `/mail/v1/events`.
- **How to Verify:** Curl `/healthz`, `/v1`, `/admin/v1/overview`, `/mail/v1/events`, and test all 3 SPAs through Nginx over HTTPS.

### DEP-07 — Broken Prometheus Scrape Targets & Missing API `/metrics` Endpoint
- **Severity:** **High**
- **Affected Files / Modules:** `infrastructure/monitoring/prometheus.yml:10-19`, `infrastructure/monitoring/alerts.yml:4-10`, `apps/api/src/app.ts`
- **Exact Technical Issue:** `prometheus.yml` scrapes `mail-engine-1:9100` & `mail-engine-2:9100` (Docker Compose service name is `mail-engine`, causing permanent `up == 0` critical alert) and scrapes `api:4000/metrics` (`apps/api` has no `/metrics` route, returning `404`).
- **Business / Operational Impact:** Zero metrics collected in production monitoring; false-positive `MtaNodeDown` paging alerts fire nonstop.
- **Recommended Fix:** Align scrape target with `mail-engine:9100` (or compose alias/DNS SD) and implement `/metrics` (`prom-client` or structured counters) on `apps/api` (exposed internally only).
- **How to Verify:** Query Prometheus `/api/v1/targets` confirming `health == "up"` for all configured jobs.

### DEP-08 — Dovecot Static Password, Missing Quota Plugin, Missing TLS `993`, Permissive `user_query`
- **Severity:** **High**
- **Affected Files / Modules:** `infrastructure/dovecot/dovecot-sql.conf.ext:2, 14-22`, `infrastructure/dovecot/dovecot.conf:1-40`, `infrastructure/docker/docker-compose.yml:75-77`
- **Exact Technical Issue:** Hardcodes `password=change_me_local_dev_only`; omits `quota` plugin despite SQL returning `quota_rule`; `user_query` omits `d.hosting_enabled = TRUE AND d.is_suspended = FALSE`; exposes plaintext `143` without TLS/IMAPS `993`.
- **Business / Operational Impact:** Changing `.env` `POSTGRES_PASSWORD` breaks all IMAP/LMTP mail hosting; quotas are ignored; suspended domains accept LMTP deliveries.
- **Recommended Fix:** Generate `dovecot-sql.conf.ext` from `.env` at startup, enable `quota`/`imap_quota` in `dovecot.conf`, enforce TLS `ssl = required` & port `993`, and copy domain status checks into `user_query`.
- **How to Verify:** Change `POSTGRES_PASSWORD` in `.env`, rebuild Dovecot, verify `doveadm user <addr>` succeeds for active domain and fails for suspended domain.

---

## 4. Environment, Migrations & Disaster Recovery Scripts

### DEP-09 — `DEPLOYMENT.md` & `migrate.sh` Assume Host `psql`; Weak Defaults & SQL Injection in `migrate.sh`
- **Severity:** **Medium / High**
- **Affected Files / Modules:** `scripts/migrate.sh:16, 24`, `docs/DEPLOYMENT.md:80`, `apps/api/src/index.ts:58`, `apps/api/src/config.ts`
- **Exact Technical Issue:** `migrate.sh` requires host `psql` instead of optionally running inside the `postgres` container and interpolates `$version` unescaped into SQL. `apps/api` hardcodes `mta-primary-1` ignoring `MAIL_ENGINE_NODE_ID`, and `config.ts` accepts `.env.example` placeholder secrets in `production`. Also `apps/api/prisma/schema.prisma` only mirrors 7 of 27 tables (schema drift if ever used).
- **Recommended Fix:** Provide containerized `migrate` one-shot service in `docker-compose.yml` (or auto-fallback to `docker compose exec -T postgres psql`), parameterize SQL in `migrate.sh`, validate non-placeholder secrets in `production`, and sync or deprecate partial `prisma/schema.prisma`.
- **How to Verify:** Deploy on a clean VM with *only* Docker & Git installed (no `psql`/`node`/`rustc` on host) and verify clean startup.

### DEP-10 — `backup-restore-dr.sh` Skips S3 Spool, Never Runs Real Restore Drill & Has No Retention/Encryption
- **Severity:** **High**
- **Affected Files / Modules:** `scripts/backup-restore-dr.sh:1-23`
- **Exact Technical Issue:** Runs `pg_restore --list` (index check only) instead of restoring into a scratch Postgres database; skips Docker volume `spooldata` unless host `/var/spool/mailplat` exists; ignores S3/MinIO bucket objects when `SPOOL_BACKEND=s3`; writes unencrypted dumps locally without rotation/off-site upload.
- **Business / Operational Impact:** Undetected corrupt backups or missing S3 objects cause permanent data loss during a real disaster recovery event.
- **Recommended Fix:** Support backing up Docker volumes/S3 buckets (e.g., `mc mirror`), encrypt archives (`age`/`gpg`), upload off-site, prune old retention, and add an automated weekly `pg_restore` into an ephemeral scratch database + row-count assertion.
- **How to Verify:** Run the DR drill script and confirm restored scratch DB passes migration/query checks and S3 files match backup manifest.
