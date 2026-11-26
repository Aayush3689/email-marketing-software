# Security Audit

**Audit Date:** 2026-11-26  
**Scope:** Authentication, authorization, MTA relay & ingress security, cryptography, SSRF/XSS/CRLF injection, Docker network isolation, and secret hygiene.

---

## Summary of Findings by Severity

| ID | Finding | Severity | Primary Location |
|---|---|---|---|
| SEC-01 | Unauthenticated `POST /v1/emails` header spoofing & CRLF injection | **Critical** | `apps/api/src/routes/emails.ts` |
| SEC-02 | API key auth (`mk_live_*`) completely unimplemented | **Critical** | `apps/api/src/routes/credentials.ts`, `auth/security.ts` |
| SEC-03 | Admin MFA bypass (`appSurface !== 'admin'`) & `/mfa/enroll` takeover | **Critical** | `apps/api/src/routes/auth.ts` |
| SEC-04 | Unconditional webmail login bypass (`() => true`) & secret fallback | **Critical** | `services/mailbox-service/src/index.ts` |
| SEC-05 | Internal DB, Redis (no auth), RabbitMQ, MinIO, Grafana, Control ports public on `0.0.0.0` | **Critical** | `infrastructure/docker/docker-compose.yml` |
| SEC-06 | `nginx.conf` plaintext HTTP only (no TLS 443 for tokens/passwords) | **Critical** | `infrastructure/nginx/nginx.conf` |
| SEC-07 | Webhook SSRF to localhost / metadata (`169.254.169.254`) / private CIDRs | **High** | `apps/api/src/routes/webhooks.ts` |
| SEC-08 | Outbound MX SSRF to private/loopback IPs & CRLF SMTP command injection | **High** | `crates/dns-resolver/src/lib.rs`, `smtp-outbound/src/lib.rs` |
| SEC-09 | Ephemeral DKIM keys & hardcoded known fallback `DKIM_KEK_HEX` | **High** | `services/mail-engine/src/main.rs` |
| SEC-10 | Admin CORS shared across tenant origins & `controlToken` sent to arbitrary `controlUrl` | **High** | `apps/api/src/app.ts`, `routes/admin.ts` |
| SEC-11 | Unsigned VERP addresses allow bounce/suppression spoofing | **High** | `crates/bounce-handler/src/lib.rs` |
| SEC-12 | `Authentication-Results` stripping & SPF/DMARC checks bypassable | **High** | `crates/auth-verification/src/lib.rs`, `dns-resolver/src/diagnostics.rs` |
| SEC-13 | Tokens in `localStorage` & SSE `?token=` query string leakage | **High** | `apps/web`, `apps/mail`, `apps/admin` |
| SEC-14 | Hardcoded Dovecot DB password, plaintext auth enabled, no IMAPS `993` | **High** | `infrastructure/dovecot/*` |
| SEC-15 | Missing `trust proxy` causes login lockout DoS & in-memory rate limits | **High** | `apps/api/src/app.ts`, `routes/auth.ts`, `crates/rate-limiter` |
| SEC-16 | Billing upgrade bypass (free `enterprise`), `GET` unsubscribe prefetch | **High** | `apps/api/src/routes/analytics.ts` |
| SEC-17 | Root Docker containers, unvalidated `x-request-id`, SVG attachment mime risk | **Medium** | `infrastructure/docker/*`, `mailbox-service/src/app.ts` |

---

## Detailed Findings

### SEC-01 — Unauthenticated `POST /v1/emails` Spoofing, Spool DoS & Header CRLF Injection
- **Severity:** **Critical**
- **Affected Files / Modules:** `apps/api/src/app.ts:113-115`, `apps/api/src/routes/emails.ts:155-235`, `packages/validation/src/index.ts:28`, `scripts/send-test-email.mjs`
- **Exact Technical Issue:** `POST /v1/emails` has no `requireAuth` or API key middleware. It trusts raw `x-organization-id` and `x-domain-id` headers, writes `.eml` to `SPOOL_DIR` before DB validation, never checks domain ownership/suspension/From-domain match, and interpolates unvalidated `input.subject` directly into `Subject: ${input.subject}\r\n` (allowing `\r\nBcc:...` MIME header injection).
- **Business / Operational Impact:** Anyone able to reach the API can send spam/phishing as any tenant UUID, fill disk with orphaned `.eml` files, and inject arbitrary email headers.
- **Recommended Fix:** Require `Authorization: Bearer mk_live_*` or verified org JWT, derive `organizationId` exclusively from auth claims, verify domain ownership + active status + `From` domain match before writing spool, and reject any `\r`/`\n` in `subject`/`headers`.
- **How to Verify:** Automated security test asserting `401` without API key, `403` when `From` belongs to an unowned domain, and `400` when `subject` contains `\r\n`.

### SEC-02 — Scoped API Key Middleware (`mk_live_*`) Does Not Exist
- **Severity:** **Critical**
- **Affected Files / Modules:** `apps/api/src/routes/credentials.ts:49-85`, `apps/api/src/auth/security.ts:91-106`, `migrations/0001_initial_schema.sql:191-203`
- **Exact Technical Issue:** Keys generated via `/v1/api-keys` (`mk_live_*`) cannot authenticate against any API endpoint because `requireAuth` solely accepts HS256 JWTs. Scope (`emails:send`, etc.) and `rateLimitRpm` enforcement are absent.
- **Business / Operational Impact:** Customers cannot securely send via API keys; forces insecure workarounds or leaves `/v1/emails` unauthenticated.
- **Recommended Fix:** Add SHA-256 `api_keys` lookup middleware supporting `Authorization: Bearer mk_live_*`, checking `revoked_at IS NULL`, scope intersection, and Redis sliding-window RPM limiting.
- **How to Verify:** Integration test sending via `/v1/emails` with valid `mk_live_*` key (`202`), insufficient-scope key (`403`), and revoked/rotated key (`401`).

### SEC-03 — Super Admin MFA Bypass, Enrollment Takeover & Unthrottled TOTP Verification
- **Severity:** **Critical**
- **Affected Files / Modules:** `apps/api/src/routes/auth.ts:258, 350-417`, `apps/api/src/auth/security.ts:44-62, 127-144`, `apps/api/src/auth/totp.ts:63-81`
- **Exact Technical Issue:**
  1. `POST /v1/auth/login` sets `mfaVerified = parsed.appSurface !== 'admin'` (`auth.ts:258`) and `signAccessToken` omits `appSurface`. Logging in with default `appSurface: 'web'` grants `mfaVerified: true` to a `super_admin`/`platform_operator` without checking TOTP, granting full `/admin/v1/*` access.
  2. `POST /v1/auth/mfa/enroll` (`auth.ts:350`) allows any pre-MFA token (`mfaVerified: false`) to overwrite `user.totpSecret` even when `user.mfaEnabled === true`.
  3. `POST /v1/auth/mfa/verify` has zero brute-force throttling and does not prevent TOTP code replay within the 90s step window.
- **Business / Operational Impact:** Complete MFA bypass for Super Admin accounts with password-only compromise; an attacker with a stolen admin password can silently overwrite TOTP enrollment or bypass MFA via `appSurface: 'web'`.
- **Recommended Fix:** Never issue `mfaVerified: true` unless actual MFA verification occurred (or `platformRole === 'none' && !mfaEnabled`), bind `aud: appSurface` in JWT and enforce `aud === 'admin'` in `requireSuperAdmin()`, forbid `/mfa/enroll` without existing MFA step-up once `mfaEnabled === true`, enforce 5-attempt lockout on `/mfa/verify`, and track `last_totp_step` to block replay.
- **How to Verify:** Negative tests confirming: `appSurface: 'web'` login token gets `403` on `/admin/v1/*`, `/mfa/enroll` returns `403` when `mfaEnabled: true` without active MFA session, 6th failed TOTP code triggers lockout, and reusing the same TOTP code returns `401`.

### SEC-04 — Unconditional Webmail Authentication Bypass & Hardcoded Fallback Secret
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mailbox-service/src/index.ts:5, 13`, `services/mailbox-service/src/app.ts:80-92`
- **Exact Technical Issue:** `services/mailbox-service/src/index.ts:13` hardcodes `verifyMailboxCredentials: async () => true`. Line 5 falls back to a public literal `JWT_SECRET` if `JWT_ACCESS_SECRET` is unset, and `requireMailboxAuth` accepts general API JWTs (`apps/api`) due to missing `aud`/`scope` check.
- **Business / Operational Impact:** **Total mailbox account takeover** in production Docker deployments: anyone can log into any hosted mailbox with any arbitrary password.
- **Recommended Fix:** Implement Argon2id password verification against PostgreSQL `mailboxes` (`status = 'active'`), fail fast if `JWT_ACCESS_SECRET` is missing, and validate `aud === 'mail'` on mailbox JWTs.
- **How to Verify:** Integration test against seeded Postgres mailbox proving wrong password returns `401`, suspended mailbox returns `403`, and `apps/api` JWT is rejected on `/mail/v1/*`.

### SEC-05 — Unauthenticated Internal Services & DBs Exposed on `0.0.0.0`
- **Severity:** **Critical**
- **Affected Files / Modules:** `infrastructure/docker/docker-compose.yml:9-230`
- **Exact Technical Issue:** Publicly binds `postgres` (`5432`), passwordless `redis` (`6379`), `rabbitmq` (`5672`, `15672`), `minio` (`9000`, `9001`), unauthenticated `dovecot` LMTP (`2424`) and plaintext IMAP (`1430`), `api` (`4000`), `mailbox-service` (`4100`), `mail-engine` control/metrics (`9100`), `prometheus` (`9090`), `grafana` (`3001`), and raw frontend ports (`5173-5175`). Note also that `mail-engine:9100` accepts unauthenticated `POST /control/drain` whenever `MAIL_ENGINE_CONTROL_TOKEN` is unset (`main.rs:505-511`) and compares tokens via non-constant-time substring `l.contains(tok)`.
- **Business / Operational Impact:** External attackers on a cloud VPS can dump PostgreSQL, wipe/poison Redis & RabbitMQ queues, inject spoofed emails directly into Dovecot LMTP port `2424`, drain all MTA nodes via port `9100`, and view Grafana/Prometheus.
- **Recommended Fix:** Remove `ports:` from internal services (`postgres`, `redis`, `rabbitmq`, `dovecot` LMTP 24, `api`, `mailbox-service`, `web`, `mail`, `admin`), bind ops/dev UIs strictly to `127.0.0.1:...` if needed locally, require Redis `--requirepass`, always require `MAIL_ENGINE_CONTROL_TOKEN` with exact constant-time Bearer equality, and enforce `TLS` on public ports only (`25`, `465`, `587`, `443`, `993`).
- **How to Verify:** Run `ss -tulpn` / `docker compose ps` after deploy and verify only `25`, `465`, `587`, `80/443` (and optional `993`) listen on `0.0.0.0`.

### SEC-06 — Nginx Missing HTTPS/TLS (`443`)
- **Severity:** **Critical**
- **Affected Files / Modules:** `infrastructure/nginx/nginx.conf:15-46`, `infrastructure/docker/docker-compose.yml:225-230`
- **Exact Technical Issue:** Nginx listens exclusively on plaintext port `80` with no TLS termination (`443`).
- **Business / Operational Impact:** Passwords, TOTP secrets, JWTs, reveal-once `mk_live_*` keys, and webmail traffic travel unencrypted over the public internet.
- **Recommended Fix:** Add `listen 443 ssl http2`, modern TLS 1.2/1.3 ciphers, HSTS header, mount Let's Encrypt certs, and HTTP `301` redirect to HTTPS.
- **How to Verify:** `curl -I http://<host>` returns `301 https://...`; `openssl s_client -connect <host>:443` negotiates TLS 1.3.

### SEC-07 — Webhook Registration Vulnerable to SSRF & DNS Rebinding
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/routes/webhooks.ts:83-90`
- **Exact Technical Issue:** Only checks `u.startsWith('https://') || u.startsWith('http://localhost')`. Allows `http://localhost` in production, `127.0.0.1`, `169.254.169.254` (cloud metadata), RFC 1918 private IPs (`10/8`, `172.16/12`, `192.168/16`), IPv6 loopback/ULA (`::1`, `fc00::/7`), internal Docker hostnames (`postgres`, `rabbitmq:15672`), and DNS rebinding.
- **Business / Operational Impact:** Future webhook worker can be weaponized for internal network probing or cloud instance metadata credential theft.
- **Recommended Fix:** Reject `http://localhost` outside dev/test; resolve DNS prior to socket connection inside the dispatcher and enforce non-private public unicast IP checks on the connected IP address (`redirect: 'manual'`).
- **How to Verify:** Test creating/dispatching webhooks to `https://169.254.169.254`, `http://localhost:9100`, and private CIDRs returning `400`/`blocked`.

### SEC-08 — Outbound SMTP MX SSRF to Private IPs & SMTP CRLF Injection
- **Severity:** **High**
- **Affected Files / Modules:** `crates/dns-resolver/src/lib.rs`, `crates/delivery-engine/src/lib.rs:395-490`, `crates/smtp-outbound/src/lib.rs:590-591, 758`
- **Exact Technical Issue:** `DeliveryEngine` connects to whatever `IpAddr` DNS MX returns—including `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`—allowing a malicious recipient domain MX record to hit internal services (e.g., Dovecot LMTP `24` or Redis `6379`). Additionally, `OutboundSmtpPool` formats `MAIL FROM:<{envelope_from}>` and `RCPT TO:<{recipient}>` without rejecting `\r`/`\n`.
- **Business / Operational Impact:** SSRF via crafted recipient domains' DNS MX records; potential SMTP command injection if untrusted envelope addresses reach outbound.
- **Recommended Fix:** Block loopback, RFC 1918, link-local, CGNAT, and multicast/unspecified IPv4/IPv6 ranges in `DeliveryEngine` before `OutboundSmtpPool::send` (gated off only for explicit test harness flag), and reject `\r`/`\n` in `OutboundRequest` envelope strings.
- **How to Verify:** Unit test injecting `127.0.0.1` / `169.254.169.254` MX targets proving `DeliveryEngine` rejects with policy bounce rather than opening TCP.

### SEC-09 — Ephemeral DKIM Keys & Hardcoded Known KEK Fallback
- **Severity:** **High**
- **Affected Files / Modules:** `services/mail-engine/src/main.rs:111-115, 271-294`, `apps/api/src/index.ts`, `.env.example:31`
- **Exact Technical Issue:** `main.rs:111-113` falls back to public hex `0123456789abcdef...` when `DKIM_KEK_HEX` is unset; `apps/api/src/config.ts` validates weak placeholder `JWT_*` / `ADMIN_BOOTSTRAP_PASSWORD` in production. Note also `apps/api` cannot generate/rotate DKIM keys in Postgres yet.
- **Business / Operational Impact:** Production deployments missing env vars silently use publicly committed encryption keys.
- **Recommended Fix:** Require strong non-placeholder `DKIM_KEK_HEX`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `MAIL_ENGINE_CONTROL_TOKEN` when `NODE_ENV=production` (fail fast on known `.env.example` strings), and persist DKIM keys in `dkim_keys`.
- **How to Verify:** Startup test verifying `loadConfig()` rejects `.env.example` placeholder strings when `NODE_ENV=production`.

### SEC-10 — Shared CORS Across Tenant & Admin Surfaces + Unconstrained `controlUrl`
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/app.ts:50-55`, `apps/api/src/routes/admin.ts:385, 884-901`
- **Exact Technical Issue:** `app.ts` enables `CORS_ORIGINS` (`5173,5174,5175`) on `/admin/v1/*` as well as `/v1/*`. Additionally, `POST /admin/v1/nodes` permits any `http(s)://` `controlUrl`, causing `probeMtaControlStatus` to send `Authorization: Bearer <MAIL_ENGINE_CONTROL_TOKEN>` to arbitrary URLs.
- **Business / Operational Impact:** XSS in customer webmail (`apps/mail`) can make credentialed CORS calls toward admin APIs if an admin visits webmail on the same browser; compromised `super_admin` or misconfiguration could exfiltrate `MAIL_ENGINE_CONTROL_TOKEN`.
- **Recommended Fix:** Restrict `/admin/v1/*` CORS strictly to `ADMIN_CORS_ORIGINS`; restrict `controlUrl` to configured host allowlist or internal network CIDRs.
- **How to Verify:** Verify preflight `OPTIONS /admin/v1/overview` with `Origin: http://localhost:5174` rejects CORS, and `POST /admin/v1/nodes` rejects external arbitrary domains.

### SEC-11 — Unsigned VERP Return-Path Allows Spoofed Bounces & Suppression Injection
- **Severity:** **High**
- **Affected Files / Modules:** `crates/bounce-handler/src/lib.rs:35-42`, `crates/smtp-inbound/src/processor.rs:150-169`
- **Exact Technical Issue:** `parse_verp_recipient_id` accepts any `bounces+<uuid>@...` without HMAC authentication.
- **Business / Operational Impact:** External attackers can send fake DSNs/bounces to `bounces+<guessed_uuid>@...` or spam-triggering suppression entries to deny delivery to arbitrary recipients.
- **Recommended Fix:** Format VERP as `bounces+<uuid>.<hmac_tag>@<domain>` using HMAC-SHA256 truncated to 16 hex bytes and verify tag before accepting feedback/suppression.
- **How to Verify:** Test forged unsigned VERP DSN returning rejection/ignored rather than suppressing recipient.

### SEC-12 — Spoofable `Authentication-Results` Stripping & Weak SPF/DMARC Diagnostics
- **Severity:** **High**
- **Affected Files / Modules:** `crates/auth-verification/src/lib.rs:106-114, 129-166`, `crates/dns-resolver/src/diagnostics.rs:67-69, 147`
- **Exact Technical Issue:**
  1. `strip_spoofed_auth_results` runs `String::from_utf8_lossy` (corrupting non-UTF8 MIME bytes) and checks `val.starts_with(&authserv_lower)`—bypassable via quoted `"mx.platform.test"`, comment `(foo) mx.platform.test`, or folded headers.
  2. `auth-verification` ignores DMARC `pct=` sampling policy.
  3. `diagnostics.rs` uses substring checks (`.contains("p=none")`, `.contains("include:...")`) prone to false positives (`sp=none`, `include:spf.domain.attacker.com`).
- **Business / Operational Impact:** Attackers can smuggle forged `Authentication-Results` headers past inbound sanitization; DNS diagnostic wizard can pass spoofed SPF/DMARC strings.
- **Recommended Fix:** Operate on raw header bytes before body separator, parse RFC 8601 `authserv-id` tokens cleanly after unfolding, apply `pct=` sampling, and parse SPF mechanisms / DMARC tag-value pairs strictly.
- **How to Verify:** Unit tests passing quoted/commented/folded spoofed `Authentication-Results` and verifying stripping without mangling Latin-1 MIME bodies.

### SEC-13 — Bearer & Refresh Tokens Stored in `localStorage` + EventSource JWT in URL
- **Severity:** **High**
- **Affected Files / Modules:** `apps/web/src/lib/api.ts:3-18`, `apps/mail/src/App.tsx:41-44, 73`, `apps/admin/src/lib/api.ts:3-15`, `services/mailbox-service/src/app.ts:80-81`
- **Exact Technical Issue:** All 3 SPAs store access/refresh JWTs in `localStorage`. `apps/mail` also passes the 12-hour JWT in `?token=...` for `EventSource` SSE, logging active tokens in Nginx access logs and browser history. Also `apps/api/src/routes/auth.ts` has no `POST /v1/auth/logout` endpoint to revoke sessions cleanly.
- **Business / Operational Impact:** Any DOM XSS directly steals refresh/Super Admin tokens; `?token=` leaks active mailbox credentials in server/CDN logs.
- **Recommended Fix:** Move refresh tokens (and SSE auth) to `HttpOnly; Secure; SameSite=Strict` cookies (with CSRF protection on cookie endpoints), keep access tokens in React memory only, and add `POST /v1/auth/logout`.
- **How to Verify:** Inspect `localStorage` in browser dev tools (zero tokens stored) and inspect Nginx logs confirming zero JWT strings in `/mail/v1/events`.

### SEC-14 — Dovecot Hardcoded Password, Plaintext Auth Allowed & No IMAPS TLS
- **Severity:** **High**
- **Affected Files / Modules:** `infrastructure/dovecot/dovecot-sql.conf.ext:2`, `infrastructure/dovecot/dovecot.conf:12, 22-40`, `infrastructure/docker/docker-compose.yml:75-77`
- **Exact Technical Issue:** Hardcodes `password=change_me_local_dev_only`, disables `disable_plaintext_auth = yes`, lacks TLS/IMAPS (`993`), and `user_query` omits `d.hosting_enabled = TRUE AND d.is_suspended = FALSE`.
- **Recommended Fix:** Render `dovecot-sql.conf.ext` from `.env` at container boot, require `ssl = required` + IMAPS `993`, and enforce domain status checks in `user_query`.
- **How to Verify:** Connect via `openssl s_client -connect host:993`, confirm plaintext IMAP fails auth, and confirm suspended domain fails LMTP/IMAP lookup.

### SEC-15 — Missing `trust proxy` Lockout DoS, Unbounded Rate-Limit Maps, & Non-Distributed Enforcement
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/app.ts`, `apps/api/src/routes/auth.ts:183, 235-254`, `crates/rate-limiter/src/lib.rs:34-66`, `crates/smtp-inbound/src/lib.rs:441-455`
- **Exact Technical Issue:** Without `app.set('trust proxy', 1)`, `req.ip` behind Nginx is always the Nginx IP, letting any attacker lock out any victim email globally with 5 bad guesses; `loginFailures` and Rust `IngressRateLimiter` live in unbounded single-process RAM; `validate_mail_from` in `smtp-inbound` skips checking `record.is_revoked` mid-session.
- **Recommended Fix:** Configure `trust proxy`, move login/TOTP/SMTP rate limits & lockouts to Redis (`EXPIRE`), prune in-memory fallbacks, and re-check credential revocation.
- **How to Verify:** Simulate 5 failed logins from IP A behind proxy and confirm IP A is locked while IP B can still sign in.

### SEC-16 — Free Plan Self-Upgrade, Unthrottled Tracking & State-Mutating `GET /unsubscribe`
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/routes/analytics.ts:520-715`
- **Exact Technical Issue:** `POST /v1/billing/upgrade` immediately upgrades any org to `enterprise` (`$999`) with `'paid'` invoice and zero Stripe/payment verification; `GET /v1/unsubscribe/:token` mutates suppression state on `GET` (triggered by enterprise email security link scanners); public tracking routes have no rate limits; org/plan caps (`dailySendLimit`, `sandbox`) are never enforced.
- **Recommended Fix:** Gate plan upgrades on verified payment/webhook or operator grant; make `GET /unsubscribe/:token` render a confirmation button that submits `POST /unsubscribe/:token` (while supporting RFC 8058 `POST`); enforce rate limits on `/t/*` and send caps on `/v1/emails`.
- **How to Verify:** Integration tests proving `GET /unsubscribe/:token` does not insert suppression while `POST /unsubscribe/:token` does, and hitting daily cap returns `429`/`402`.

### SEC-17 — Root Containers, Unsanitized `x-request-id`, & Attachment MIME Risks
- **Severity:** **Medium**
- **Affected Files / Modules:** `infrastructure/docker/Dockerfile.node`, `Dockerfile.mail-engine`, `apps/api/src/app.ts:58-62`, `services/mailbox-service/src/app.ts:154-169`, `apps/mail/src/lib/sanitize.ts`
- **Exact Technical Issue:** All backend containers run as `root`; `x-request-id` echoes arbitrary unsanitized caller headers (log injection); `mailbox-service` serves arbitrary `att.contentType` (e.g., `image/svg+xml`) without `Content-Security-Policy: sandbox`.
- **Recommended Fix:** Switch containers to non-root users, sanitize `x-request-id` (`^[a-zA-Z0-9._-]{1,64}$`), and add `Content-Security-Policy: sandbox` on attachment downloads.
- **How to Verify:** `docker compose exec api id` returns non-root `uid`; attachment headers include `Content-Security-Policy: sandbox`.
