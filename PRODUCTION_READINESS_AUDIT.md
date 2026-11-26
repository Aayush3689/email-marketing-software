# Production Readiness & Reliability Audit

**Audit Date:** 2026-11-26  
**Scope:** Full repository (`apps/*`, `services/*`, `crates/*`, `packages/*`, `migrations/*`, `infrastructure/*`, `scripts/*`)  
**Verdict:** **NOT READY FOR PRODUCTION.** While unit/component building blocks exist and pass isolated tests, critical runtime persistence, message-durability, inbound/outbound pipeline wiring, and security defects block safe live deployment.

---

## 1. End-to-End Architecture Verification

### 1.1 Outbound Pipeline
`React Developer Console (apps/web) → Node API (apps/api) → PostgreSQL → Transactional Outbox (services/scheduler) → RabbitMQ → Rust MTA (services/mail-engine) → DNS/MX → TCP/STARTTLS → Recipient SMTP → Delivery Events`

| Hop | Current State | Production Readiness Verdict |
|---|---|---|
| `apps/web` → `apps/api` | Implemented, but `/v1/auth/me` contract mismatch (`{ auth }` vs `{ user }`), no auto-refresh on 15-min JWT expiry, and hardcoded DNS text mismatch (`DomainsView.tsx`). | **Broken on reload / expiry** |
| `apps/api` Auth & Validation | `POST /v1/emails` has **zero authentication**, trusts arbitrary `x-organization-id`/`x-domain-id` headers, ignores `mk_live_*` API keys, and writes `.eml` files before DB checks. | **Critical Security / Orphaned Spool** |
| `apps/api` → PostgreSQL | `PgEmailSubmissionStore` writes `messages`, `message_recipients`, `outbox_events`, **but 9 of 10 stores in `apps/api/src/index.ts` are `InMemory*Store`**. FK constraints on `messages` fail in Postgres (`23503`) because orgs/domains are never written to SQL. | **Fails at runtime against real Postgres** |
| `apps/api` → `mail-engine` Spool | `apps/api` hardcodes `LocalSpoolWriter` (`SPOOL_DIR`), ignoring `SPOOL_BACKEND=s3` even when `mail-engine` uses `S3MessageStore`. | **Broken when `SPOOL_BACKEND=s3` or multi-node** |
| `scheduler` (`OutboxRelay`) → RabbitMQ | Polls `outbox_events` and calls AMQP `confirmChannel.publish`, but processes sequentially (`200` serial awaits), lacks `attempt_count`/DLQ backoff (poison-pill spin), crashes without `try/catch` or reconnect, and leaves rows forever (`outbox_events` bloat). | **Fragile / Bottlenecked** |
| RabbitMQ → `mail-engine` (`outbound`) | `outbound_runner.rs` **ACKs RabbitMQ immediately upon `mpsc::send()`**, dropping durability; **never republishes deferred retries**; `EngineDeliveryStateStore` SQL queries reference **non-existent columns (`enhanced_status`, `response_message`, `updated_at`)** and omit `NOT NULL` columns (`message_id`, `organization_id`, `mta_node_id`). | **Silent Message Loss & Total Telemetry Loss** |
| `mail-engine` → DKIM → DNS → Remote MX | DKIM keys auto-generate ephemerally in RAM on every restart and hardcode fallback KEK; DNS works via `HickoryDnsResolver` but cache is unbounded and allows SSRF to private IPs; `OutboundSmtpPool` works over TCP/STARTTLS on single node without IP pool `bind_ip` wiring. | **Breaks DKIM/DMARC across restarts** |

### 1.2 Inbound Pipeline & Mail Hosting
`External Sender → Inbound SMTP → Domain/Recipient Validation → Spool Storage → LMTP → Dovecot → Maildir → IMAP → Webmail (apps/mail)`

| Hop | Current State | Production Readiness Verdict |
|---|---|---|
| Port 25 Ingress (`mail-engine`) | `InMemoryDomainDirectory` is completely empty in `main.rs`; 100% of external inbound emails are rejected `550 5.7.1 Relay access denied`. | **Non-functional** |
| Post-DATA Routing (`PipelineMessageSink`) | Same sink used on Port 25 and 587/465: **publishes every accepted email to `mail.outbound.transactional`**, creating an inbound mail loop if a domain is later populated. | **Mail Loop / Broken Inbound** |
| `inbound` Worker Role | `InboundProcessor`, `InboundAuthVerifier` (SPF/DKIM/DMARC), `bounce-handler` (VERP/DSN/ARF), and `DovecotLmtpClient` are **never instantiated** in `services/mail-engine/src/main.rs`. `mail.inbound.*` queues have zero consumers. | **Unwired** |
| `services/mailbox-service` | Production `index.ts` binds `verifyMailboxCredentials: async () => true` (unauthenticated bypass) and `InMemoryMailboxBackend`; `DovecotImapConnector` is an unused stub; `apps/mail` attachment links miss auth headers. | **Non-functional / Critical Vulnerability** |

### 1.3 Subsystems Status Summary
- **SMTP Submission (`587`/`465`):** Fails silently if `TLS_CERT_PATH` unset, crashes if set without mounted certs; ignores Postgres `smtp_credentials` (reads only single env var credential).
- **Aliases, Forwarding, Catch-all:** Implemented in `smtp-inbound`/`InMemoryDomainDirectory`, not backed by Postgres or wired in `mail-engine`; external forwarding + SRS unimplemented.
- **Webhooks (`webhooks.ts`):** CRUD + HMAC signing helper exist in memory only; **no webhook delivery HTTP worker** or retry engine exists.
- **Campaigns (`campaigns.ts`):** Template preview, consent-gated import, and CRUD state records exist in memory only; **no campaign fan-out dispatcher**, no `start` action, and no RFC 8058 injection during sending.
- **Analytics & Billing (`analytics.ts`):** Partitioned SQL schema exists, runtime store is in-memory; `GET /unsubscribe/:token` auto-unsubscribes on scanner prefetch; billing upgrade requires no payment verification and plan limits are never enforced.
- **Super Admin (`apps/admin` & `admin.ts`):** Live Postgres/Redis/RabbitMQ/Rust drain connectors work conceptually, but MFA is bypassable via login surface, `AdminControlStore` state/audit logs are in-memory, and Postgres tables aren't persisted.

---

## 2. Detailed Reliability Findings

### PR-01 — Premature RabbitMQ ACK Before SMTP Delivery (Silent Message Loss)
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/src/outbound_runner.rs:146-192`, `crates/queue-engine/src/lib.rs:205-208`, `crates/delivery-engine/src/lib.rs:232-244`
- **Exact Technical Issue:** `consume_queue` ACKs each AMQP delivery immediately when the callback returns `Ok(())`. Inside `outbound_runner.rs`, the callback merely calls `eng.enqueue(job).await`, which places the job into an unpersisted in-memory `mpsc::channel` (capacity 4,096 per pool). Meanwhile `main.rs:329-335` cancels `run_workers()` on shutdown via `tokio::select!`.
- **Business / Operational Impact:** Any `SIGKILL`, OOM, node crash, or graceful shutdown after enqueue permanently drops up to `8,192 + 32*3` in-flight emails with zero record of failure in RabbitMQ.
- **Recommended Fix:** Only ACK AMQP messages *after* `DeliveryEngine::process_job` finishes AND state/retry records commit to PostgreSQL (pass a oneshot ack handle per job or execute bounded worker futures directly from the AMQP consumer with matching `basic_qos` prefetch).
- **How to Verify:** Kill (`SIGKILL`) `mail-engine` mid-batch against a slow SMTP sink and confirm un-acked RabbitMQ messages are redelivered and 100% eventually delivered without loss.

### PR-02 — Deferred Retries Are Permanently Dropped
- **Severity:** **Critical**
- **Affected Files / Modules:** `crates/delivery-engine/src/lib.rs:346-359, 459-467, 590-598, 763`, `services/mail-engine/src/state_store.rs:29-79`, `services/scheduler/src/index.ts:16-86`
- **Exact Technical Issue:** When `DeliveryEngine` returns `RecipientDeliveryState::Deferred` (SMTP `421`/`450`/`451`, network drop, ambiguous post-DATA, transient DNS, or local domain concurrency saturation), it sets `next_retry_at` in `AttemptRecord`, discards `DeliveryStageTiming` in `run_pool_loop`, and never republishes to `mail.outbound.retry`. No scheduler job scans `message_recipients` for due `next_retry_at` rows.
- **Business / Operational Impact:** 100% of temporary recipient throttling (common at Gmail/Microsoft/Yahoo) causes permanent silent message loss after attempt #1.
- **Recommended Fix:** Persist `next_retry_at` in PostgreSQL inside the same atomic step before AMQP ACK, and add a `services/scheduler` deferred-retry poller (`FOR UPDATE SKIP LOCKED WHERE state = 'deferred' AND next_retry_at <= NOW()`) pushing back to `mail.outbound.retry` via `outbox_events` (or RabbitMQ per-backoff TTL retry queues). Also wait on local `AdaptiveDomainLimiter` permits rather than failing/deferring locally when saturation occurs.
- **How to Verify:** Point `mail-engine` at an SMTP server that returns `421` twice and `250` on the third attempt; verify 3 attempts are recorded in `delivery_attempts` and final status reaches `accepted_remote`.

### PR-03 — Fatal PostgreSQL Schema Mismatch in `EngineDeliveryStateStore`
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/src/state_store.rs:42-68, 93-132`, `migrations/0001_initial_schema.sql:362-432`
- **Exact Technical Issue:** `persist_pg_attempt` inserts columns `enhanced_status`, `response_message`, and `ambiguous_after_data` into `delivery_attempts` (actual schema has `enhanced_code`, `smtp_response`, and no `ambiguous_after_data`), omits required `NOT NULL` columns (`message_id`, `organization_id`, `mta_node_id`), updates non-existent `updated_at` on `message_recipients`, overwrites `messages.state` per recipient instead of computing aggregate message completion, and catches all SQL errors with `warn!` while returning `Ok(())`.
- **Business / Operational Impact:** Every Postgres attempt update fails silently in production; operator dashboards and billing/bounce systems never receive delivery states.
- **Recommended Fix:** Align `sqlx` queries (validated at compile time/CI against real schema) with `0001_initial_schema.sql`, pass `organization_id` & `node_id`, aggregate `messages.state`, and bubble DB errors so AMQP does not ACK unpersisted deliveries.
- **How to Verify:** Run an integration test against PostgreSQL 16 after `./scripts/migrate.sh` and assert rows appear accurately in `delivery_attempts` and `message_recipients`.

### PR-04 — Nine of Ten Control-Plane Stores Are In-Memory (`apps/api` + `mailbox-service`)
- **Severity:** **Critical**
- **Affected Files / Modules:** `apps/api/src/index.ts:23-84`, `services/mailbox-service/src/index.ts:8-14`, `migrations/0001_initial_schema.sql`
- **Exact Technical Issue:** Only `PgEmailSubmissionStore` uses PostgreSQL. `AuthStore`, `DomainStore`, `MailboxStore`, `CredentialsStore`, `MarketingStore`, `WebhookStore`, `AnalyticsStore`, `AdminControlStore`, and `InMemoryMailboxBackend` all keep state in JS process RAM. Because `messages.organization_id` and `messages.domain_id` have SQL FK references to `organizations` and `domains`, `PgEmailSubmissionStore` rejects submissions with `23503 foreign_key_violation`.
- **Business / Operational Impact:** Any container restart wipes users, domains, keys, tracking/unsubscribe links, and audit logs; API and MTA cannot share data; email submissions fail FK checks in Postgres.
- **Recommended Fix:** Implement PostgreSQL-backed store classes (`PgAuthStore`, `PgDomainStore`, `PgMailboxStore`, `PgCredentialsStore`, `PgMarketingStore`, `PgWebhookStore`, `PgAnalyticsStore`, `PgAdminStore`) and Redis-backed lockout/rate-limit state.
- **How to Verify:** Restart API container mid-workflow against Postgres and verify login, domains, API keys, tracking tokens, and `POST /v1/emails` continue working seamlessly.

### PR-05 — Unwired Inbound Pipeline (`inbound` Role) & Mail Loop in `PipelineMessageSink`
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/src/main.rs:209-223, 386-486`, `services/mail-engine/src/outbound_runner.rs:42-121`, `crates/smtp-inbound/src/processor.rs:123-218`
- **Exact Technical Issue:** `main.rs` has no `has_role("inbound")` worker, leaving `InboundProcessor`, `InboundAuthVerifier`, `bounce-handler`, and `DovecotLmtpClient` unused. `InMemoryDomainDirectory` and `InMemoryCredentialStore` never query Postgres. Worse, `PipelineMessageSink` handles both Port 25 MX ingress and Port 587/465 submission identically by publishing every email into `mail.outbound.transactional` (so inbound mail loops back to the domain's MX).
- **Business / Operational Impact:** Platform cannot receive external email, process VERP bounces/ARF complaints, enforce inbound SPF/DKIM/DMARC, or deliver into Dovecot mailboxes; misconfigured routing causes SMTP loops.
- **Recommended Fix:** Separate Port 25 `ServerToServerMx` sink (run `InboundAuthVerifier`, spool, publish to `mail.inbound.delivery` / `mail.inbound.feedback`) from authenticated `587/465` sink (route local recipients to inbound queue, external to outbound queue), implement `PgDomainDirectory` & `PgCredentialStore`, and spawn the `inbound` queue consumer in `main.rs`.
- **How to Verify:** Run an E2E test sending SMTP mail to Port 25 for a hosted domain -> verify `Authentication-Results` header -> Dovecot LMTP delivery -> IMAP `INBOX`, plus VERP bounce -> `suppression_entries`.

### PR-06 — Ephemeral In-Memory DKIM Keys Across Restarts & Multi-Node Scale
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/src/main.rs:271-294`, `crates/dkim/src/lib.rs`, `services/mail-engine/src/storage_and_dkim.rs:74-96`
- **Exact Technical Issue:** `build_dkim_keyring` generates a fresh RSA-2048 key in memory for `PRIMARY_DOMAIN` on every restart and ignores `dkim_keys` SQL table and multi-tenant domains. `extract_from_domain` stops at 8 KiB, breaks on folded headers, and misparses `@` in display names.
- **Business / Operational Impact:** Every container restart rotates the private signing key silently without updating DNS, invalidating DKIM and failing strict DMARC (`p=reject`) at Gmail/Outlook. Multi-tenant customer domains cannot sign emails.
- **Recommended Fix:** Persist/load AES-256-GCM encrypted keys in Postgres `dkim_keys` (`status IN ('active', 'retiring')`), expose key rotation API triggering safe DNS propagation window, and parse headers with `mail-parser`.
- **How to Verify:** Restart `mail-engine` and confirm outbound emails continue signing with the same selector/key matching DNS TXT.

### PR-07 — Monthly Partition Exhaustion & Timezone Drift (`email_events`, `delivery_attempts`, `audit_logs`)
- **Severity:** **Critical**
- **Affected Files / Modules:** `migrations/0002_partition_management.sql:1-32`, `migrations/0001_initial_schema.sql:83-95, 412-449`, `services/scheduler/src/index.ts`
- **Exact Technical Issue:** `ensure_monthly_partitions(3)` executes only once during initial migration; nothing runs it monthly (`pg_cron` or `scheduler` recurring job is absent), no `DEFAULT` partitions exist, and `DATE_TRUNC('month', NOW())` depends on session timezone rather than UTC.
- **Business / Operational Impact:** Exactly 3–4 months after launch, **every** `email_events`, `delivery_attempts`, and `audit_logs` insert fails hard with PostgreSQL `no partition found`.
- **Recommended Fix:** Add `DEFAULT` safety partitions, fix `DATE_TRUNC` to explicit UTC, and schedule daily execution of `SELECT ensure_monthly_partitions(3)` inside `services/scheduler`.
- **How to Verify:** Insert a timestamped row 6 months into the future after running the scheduler maintenance task and verify partition routing succeeds.

### PR-08 — `S3MessageStore` Protocol Bugs & Permanent Bounce on Transient Storage Errors
- **Severity:** **High**
- **Affected Files / Modules:** `crates/message-storage/src/s3.rs:56-236`, `crates/delivery-engine/src/lib.rs:362-376`
- **Exact Technical Issue:** `S3MessageStore` has no timeouts, doesn't handle `100 Continue` or `Transfer-Encoding: chunked`, doesn't SigV4-percent-encode keys, breaks on IPv6 endpoints, and creates a new TCP/TLS socket per request. Worse, `DeliveryEngine` marks *any* `storage.get_message()` error (`lib.rs:362-376`) as permanent `RecipientDeliveryState::Bounced` (`554 5.3.0 Payload missing`).
- **Business / Operational Impact:** Any temporary MinIO/S3 glitch or HTTP `100 Continue` permanently destroys outbound messages instead of retrying.
- **Recommended Fix:** Use a pooled HTTP/S3 client (`aws-sdk-s3` or `reqwest`) with strict timeouts, classify `404 NoSuchKey` vs transient `5xx`/network errors, and defer on transient storage failures.
- **How to Verify:** Inject a simulated `503 Service Unavailable` or timeout from S3 test endpoint and assert `DeliveryEngine` returns `Deferred`, not `Bounced`.

### PR-09 — Missing Campaign Execution Engine & Unimplemented Scheduler Cron
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/routes/campaigns.ts:161-204, 337-351`, `services/scheduler/src/index.ts`
- **Exact Technical Issue:** No worker transitions `scheduled` campaigns when `scheduled_at <= NOW()`, renders versioned templates with RFC 8058 `List-Unsubscribe-Post` headers, streams 20M recipients in chunks into `mail.outbound.bulk`, or halts in-progress fan-out when an operator calls `pause`/`cancel`. Also `POST /campaigns/:id/pause|resume|cancel` has no state-machine guard (`completed -> running` allowed).
- **Business / Operational Impact:** Scheduled/started marketing campaigns sit idle forever; pause/cancel state transitions cannot stop already-enqueued batches unless checked pre-delivery.
- **Recommended Fix:** Implement chunked cursor-based campaign dispatcher in `services/scheduler`, validate state transitions cleanly, re-check campaign status + suppression list per batch and pre-SMTP send.
- **How to Verify:** Create a scheduled campaign of 1,000 contacts including 50 suppressed, pause mid-dispatch after 200, verify suppressed addresses never enqueue and remaining 800 halt cleanly.

### PR-10 — `OutboxRelay` Infinite Poison-Pill Retry Loop, Unhandled Errors & Duplicate Leases
- **Severity:** **High**
- **Affected Files / Modules:** `services/scheduler/src/index.ts:16-86`, `services/scheduler/src/outbox-relay.ts:27-46`
- **Exact Technical Issue:** Unhandled PG/AMQP exceptions crash `scheduler`; no `'error'`/`'close'` handlers exist on PG `Pool` or `amqplib` connection; `markFailed` sets `locked_at = NULL` without incrementing `attempt_count` or failing poison messages; 30s `locked_at` timeout can expire during a slow batch, allowing a second replica to duplicate-publish.
- **Business / Operational Impact:** One malformed row locks `scheduler` in a 100ms tight spin loop (`ORDER BY id ASC LIMIT 200`) blocking all platform emails; transient RabbitMQ restarts take down outbound dispatching until process restart.
- **Recommended Fix:** Add `attempt_count`, `next_attempt_at`, and `status = 'failed'` dead-letter cap in `outbox_events`; wrap polling in reconnect-safe `try/catch`; increase lease window / atomic `locked_by` token check; purge published rows cleanly.
- **How to Verify:** Inject a failing `publishConfirmed` row and verify retries back off and mark `failed` after max attempts while valid newer rows continue publishing.

### PR-11 — Broken Graceful Shutdown & Partial-Publish Duplicates (`mail-engine`)
- **Severity:** **High**
- **Affected Files / Modules:** `services/mail-engine/src/main.rs:325-336`, `services/mail-engine/src/outbound_runner.rs:85-109, 145-201`
- **Exact Technical Issue:** `main.rs` puts `engine_workers.run_workers()` inside `tokio::select!` so shutdown cancels active delivery tasks immediately instead of waiting for `shutdown_intake()` drain completion. In `PipelineMessageSink`, publishing in a per-recipient loop means partial failure returns `421` to the SMTP client after earlier recipients were already queued (duplicates on client retry).
- **Business / Operational Impact:** Rolling deploys abort active SMTP sessions (`AmbiguousPostData`) and multi-recipient SMTP submissions risk duplicate deliveries.
- **Recommended Fix:** Call `shutdown_intake()` on drain/shutdown and await `run_workers()` to completion before exiting; write submission transactionally into Postgres `outbox_events` (or publish single envelope batch) before answering `250 OK`.
- **How to Verify:** Send a 5s-delayed SMTP transaction and trigger `SIGTERM`; confirm in-flight delivery completes `250 OK` and `state_store` persists before exit.

### PR-12 — Duplicate Delivery Risks & Non-Idempotent Partial Submissions
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/routes/emails.ts:67-149`, `crates/delivery-engine/src/lib.rs:640-677`, `services/mail-engine/src/outbound_runner.rs:90-108`
- **Exact Technical Issue:** `PgEmailSubmissionStore` checks `idempotency_key`, which only works if the client provides one (`optional` in schema) and does **not** enforce uniqueness in SQL (`0001_initial_schema.sql` has no unique index on `(organization_id, idempotency_key)`—concurrent retries race!). `LocalSpoolWriter` writes `.eml` *before* dedup check, leaking duplicate files.
- **Recommended Fix:** Add `CREATE UNIQUE INDEX idx_messages_org_idempotency ON messages(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL` and clean up or reuse storage keys cleanly.
- **How to Verify:** Fire two concurrent identical `POST /v1/emails` requests with the same `idempotencyKey` and assert only one `messages` row and one `outbox_events` job exist.

---

## 3. Prioritized Remediation Plan (Summary)

*Wait for approval before implementing any fixes.*

- **P0 (Critical Security & Data-Loss Blockers — Fix First Before Any Exposure):**
  1. Authenticate `POST /v1/emails` via API keys (`mk_live_*` + scopes) / JWT, remove header spoofing, sanitize `Subject`/headers CRLF, validate domain/org before spool write.
  2. Fix `apps/api` MFA bypass (`mfaVerified` & `appSurface` binding, block `/auth/mfa/enroll` takeover, add TOTP rate limit/replay guard).
  3. Remove `verifyMailboxCredentials: async () => true` bypass & hardcoded JWT secret in `mailbox-service`.
  4. Lock down internal Docker ports (`postgres`, `redis` + add password, `rabbitmq`, `minio`, `dovecot` 24, `prometheus`, `grafana`, `9100`, `4000`, `4100`).
  5. Fix AMQP late-ACK in `mail-engine`, durable `deferred` retry scheduling, `state_store.rs` SQL schema mismatches, and `Pg*Store` persistence across `apps/api` & `mailbox-service`.
  6. Persist encrypted `dkim_keys` in Postgres (require real `DKIM_KEK_HEX`), wire `inbound` role (`InboundProcessor` + `auth-verification` + `DovecotLmtpClient`) and split Port 25 vs 587 sinks.
- **P1 (High Operational & Security Hardening):**
  7. Add `DEFAULT` + automated monthly partition creation in `scheduler`, UUIDv7 IDs, and missing 20M-scale indexes.
  8. Fix Nginx (TLS 443, route `apps/mail` & `apps/admin`, `/healthz`, SSE unbuffered), `S3SpoolWriter` parity in `apps/api`, `S3MessageStore` chunked/timeout/transient-defer fixes.
  9. Harden `OutboxRelay` (batched pipelined publish, `failed` DLQ status, reconnects), build webhook delivery worker with anti-SSRF IP validation, build chunked campaign dispatcher, enforce billing/quotas, fix `GET /unsubscribe` prefetch mutation, sign VERP with HMAC.
  10. Fix `apps/web` `/v1/auth/me` & auto-refresh interceptors, `apps/mail` authenticated attachment download, `Dovecot` quota/TLS/`user_query`/env templating, bounded Redis rate-limiting & IP-DNS SSRF blocking, graceful worker drain.
- **P2 (Medium/Low Production Polish & Test Coverage):**
  11. Add React `ErrorBoundary`s, mobile drawers, Vite `manualChunks`; fix Prometheus targets & API `/metrics`; add container `healthcheck`/`restart`/non-root `USER`/`.dockerignore`; add PostgreSQL/RabbitMQ/Dovecot/chaos/20M-scale integration tests and verified DR restore drills.
