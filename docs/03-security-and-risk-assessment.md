# Security Model, Anti-Abuse & Risk Assessment

**Status:** Draft — Awaiting Stakeholder Approval

---

## 1. Security Model & Tenant Isolation

### Authentication
- **Password Hashing**: `Argon2id` (`m=65536 KiB`, `t=3`, `p=1`) for user accounts, SMTP credentials, and Dovecot mailboxes. Never stored in plaintext; never logged.
- **Session & Token Architecture**:
  - Separate origin-scoped sessions (`web`, `mail`, `admin`) with `HttpOnly`, `Secure`, `SameSite=Lax/Strict` cookies or short-lived JWTs + opaque rotating refresh tokens stored hashed in `user_sessions`.
  - Refresh-token reuse triggers immediate revocation of the entire `token_family_id`.
  - **Super Admin (`apps/admin`)**: Mandatory TOTP/WebAuthn MFA, strict IP allowlist/VPN option, shorter idle timeout (15–30 min), step-up re-authentication for sensitive actions (node drain, account suspension, system config updates).
- **API & SMTP Auth**:
  - API keys generated with CSPRNG, shown once on creation/rotation, stored as SHA-256 hash + 8-char prefix (`mk_live_...`), scope-restricted (`email:send`, `domains:write`, etc.), per-key sliding-window rate limits in Redis.
  - SMTP submission (`587`/`465`) strictly disables `AUTH` prior to `STARTTLS`. Failed auth attempts increment `failed_auth_count` and trigger exponential IP/username throttling.

### Authorization (RBAC) & Tenant Isolation
- Every API endpoint enforces middleware RBAC (`SuperAdmin`, `PlatformOperator`, `OrgOwner`, `OrgAdmin`, `Developer`, `MailboxUser`, `ReadOnlyAnalyst`) on the backend.
- Every tenant-scoped database query injects `organization_id = req.auth.orgId` from verified session/API-key context—never from request body/query params without membership verification.
- Super Admin endpoints live under an isolated router/policy boundary requiring `platform_role IN ('super_admin', 'platform_operator')` + verified MFA session, and record immutable before/after diffs in `audit_logs`.

### Cryptographic & Data Protection
- **DKIM Private Keys**: Envelope-encrypted (`AES-256-GCM`) using a master Key Encryption Key (KEK) injected via environment/KMS/Vault. `apps/api` and `apps/admin` have zero read paths for decrypted DKIM keys; only `services/mail-engine` decrypts keys in memory (zeroized on drop).
- **Webhook Signing Secrets**: Encrypted at rest; rotation supports dual-signature/grace-window so clients don't drop events mid-rotation.
- **Webmail XSS/SSRF Defense**: Inbound HTML emails rendered in `apps/mail` pass through strict server/client sanitization (`DOMPurify` stripping scripts, event handlers, forms, `<object>`, unsafe styles) inside a sandboxed container, plus an optional image proxy so remote tracking pixels do not leak mailbox user IPs.
- **No Arbitrary Shell**: Super Admin has zero shell/exec endpoints; operational actions use typed, audited control messages (e.g., node drain state in DB/Redis).

---

## 2. Anti-Abuse & Deliverability Controls

1. **Sender Verification Gate**: New organizations start in `sandbox` mode (strict daily cap, verified recipient whitelist or test sink) until domain ownership + SPF + DKIM pass verification and anti-abuse checks.
2. **Sender Authorization**: SMTP submission and API send reject `From` / `MAIL FROM` addresses whose domain is not owned, verified, and active under the authenticated organization (and matching `smtp_credentials.allowed_sender_patterns`).
3. **Consent & Suppression Enforcement**:
   - Bulk campaigns require consent metadata (`consented_at`, `consent_source`) and auto-inject RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers.
   - Global & per-org `suppression_entries` automatically block hard bounces, spam complaints, and unsubscribes before enqueueing/delivery.
4. **Automated Abuse Circuit Breakers**:
   - Rolling 24h & 1h windows monitor hard-bounce rate and FBL complaint rate per organization/domain/IP.
   - Exceeding warning thresholds triggers alerts + automatic throttling; exceeding critical thresholds (e.g., bounce rate > 5% or complaint rate > 0.2% over minimum sample N) automatically pauses active campaigns and flips `organizations.sending_mode` / `domains.is_suspended`, logging an admin audit event.
5. **No Reputation Evasion**: Platform never rotates IPs automatically to evade blacklists or ISP blocks; problematic tenants/pools are isolated and throttled.

---

## 3. Architectural Risk Assessment & Mitigations

| # | Risk / Bottleneck | Impact | Likelihood | Mitigation Strategy |
|---|---|---|---|---|
| **R1** | **IP Warm-up & ISP Blocks (Deliverability)** | High | High | Enforce shared vs dedicated IP pools, strict warmup stage daily caps (`sending_ips.warmup_stage`), provider-specific adaptive throttling (`421`/`429` feedback into Redis), and strict sandbox gating for new tenants. Never promise guaranteed inbox placement. |
| **R2** | **PostgreSQL Bloat at 20M+ msg/mo (~100M events/mo)** | High | High | Monthly range partitioning on `email_events`, `delivery_attempts`, `audit_logs`; pre-aggregated `daily_domain_metrics` rollups; MIME bodies stored outside DB in `message-storage`; `UUIDv7` keys to eliminate random B-tree page splits. |
| **R3** | **Duplicate Deliveries on Crash or Ambiguous Post-DATA Drops** | High | Medium | Transactional outbox + AMQP publisher confirms; only ACK RabbitMQ after DB commit; flag `ambiguous_after_data` on post-DATA socket drops with longer backoff and operator visibility. |
| **R4** | **Head-of-Line Blocking in Bulk vs Transactional Mail** | High | High | Separate RabbitMQ queues (`mail.outbound.transactional` vs `mail.outbound.bulk`), dedicated Rust worker pools, and separate shared IP pools so bulk spikes never delay OTPs/password resets. |
| **R5** | **DNS Resolution Bottlenecks / Stale MX Caches** | Medium | High | `hickory-dns` async resolver with bounded in-memory + Redis TTL cache, negative caching (NXDOMAIN/Null MX), and timeout guards so slow authoritative DNS servers cannot exhaust Tokio worker tasks. |
| **R6** | **Shared Spool Failure / Multi-Node MTA Split** | High | Medium | Abstract `message-storage` behind a trait: fast NVMe shared/local volume initially, migrating to S3/MinIO object storage in Phase 10 before horizontal multi-node MTA deployment. |
| **R7** | **Backscatter Spam from Catch-All / Late Bounces** | Medium | High | Validate `RCPT TO` recipients against Redis/PostgreSQL *synchronously during SMTP transaction* and reject invalid users with `550 5.1.1` before accepting `DATA`. |
| **R8** | **Dovecot Single-Node Bottleneck / Lock Contention** | Medium | Medium | Never access Maildir from Rust/Node directly—all delivery goes through Dovecot LMTP and all reads through Dovecot IMAP (`mailbox-service`). Embed `mailbox_servers.server_id` in DB for future sharding. |
| **R9** | **Webmail XSS / Attachment Malware** | High | Medium | Origin-separate `apps/mail` from `apps/web` & `apps/admin`; sanitize HTML with strict allowlist + sandboxed rendering; serve attachment downloads with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and isolated download domain/headers. |
| **R10** | **Prisma + SQLx Schema Drift** | Medium | Medium | Single SQL migration source of truth (`migrations/`), CI check validating Prisma client generation + `sqlx prepare` offline metadata against live Postgres schema on every PR. |
