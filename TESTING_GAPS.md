# Testing & Verification Gaps

**Audit Date:** 2026-11-26  
**Scope:** Existing Rust, TypeScript, Integration, E2E, Security, and Benchmark suites vs. production failure modes.

---

## 1. Verified Baseline Execution Results (Current Audit Session)

Executed directly via `source "$HOME/.cargo/env" && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo test --release -p delivery-engine --test load_benchmark -- --nocapture && npm run build && npm run typecheck && npm run test` (exit code `0`):

| Layer | Suite / Command | Observed Result | Scope / Limitations |
|---|---|---|---|
| Rust Formatting & Lint | `cargo fmt --all -- --check` & `cargo clippy --workspace --all-targets -- -D warnings` | **Passed** (`0` warnings/errors) | Static code & lints only |
| Rust Workspace Tests | `cargo test --workspace` | **`35/35` passed** (`0` failed) | All stores/MXs/LMTP targets use `InMemory*` & local TCP mocks; zero live PostgreSQL/RabbitMQ/Dovecot containers |
| Rust Release Benchmarks | `cargo test --release -p delivery-engine --test load_benchmark -- --nocapture` | **`2/2` passed** (`19,874.3 msgs/sec` 600-msg burst, `p99=29.01ms`; `577.6 msgs/sec` mixed faults) | Isolated localhost plaintext sinks, `StaticMxResolver`, `InMemoryMessageStore`, `InMemoryDeliveryStateStore` |
| TypeScript Build & Typecheck | `npm run build && npm run typecheck` | **Passed** (9/9 packages `tsc --noEmit` `0` errors; 3 Vite bundles built) | `apps/web` & `apps/admin` have zero unit/UI tests |
| TypeScript Tests | `npm run test` (`@mail/api`: 7, `@mail/validation`: 3, `@mail/webmail`: 1, `@mail/mailbox-service`: 1, `@mail/scheduler`: 1) | **`13/13` passed** (`0` failed) | API & scheduler tests run against `InMemory*Store` and mocked channels (never hitting real PostgreSQL or AMQP broker) |

---

## 2. Critical & High Testing Gaps

### TST-01 — Zero Real PostgreSQL Integration & Migration Runtime Tests
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/src/state_store.rs`, `apps/api/src/routes/emails.ts`, `migrations/0001_initial_schema.sql`, `migrations/0002_partition_management.sql`
- **Exact Technical Issue:** No test runs `migrations/*.sql` against PostgreSQL 16 and executes `PgEmailSubmissionStore` or `EngineDeliveryStateStore::record_attempt`. As a result, fatal column mismatches (`enhanced_status`, `response_message`, missing `message_id`/`organization_id`/`mta_node_id`, non-existent `updated_at`) and missing future monthly partitions passed 100% of CI checks undetected.
- **Business / Operational Impact:** Schema-breaking runtime failures ship straight to production.
- **Recommended Fix:** Add a Postgres integration test suite (in CI using the existing `postgres:16` service container) running `scripts/migrate.sh`, testing `PgEmailSubmissionStore`, `EngineDeliveryStateStore`, FK enforcement, concurrent `idempotency_key` inserts, and partition creation >3 months ahead.
- **How to Verify:** Run Postgres integration job intentionally against a fresh Postgres 16 container in CI and confirm all SQL queries & constraints pass.

### TST-02 — Zero RabbitMQ Durability & Crash-Recovery Tests
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/src/outbound_runner.rs`, `crates/queue-engine/src/lib.rs`, `services/scheduler/src/*`
- **Exact Technical Issue:** `OutboxRelay` tests use mock closures; `services/mail-engine` has zero tests connecting to RabbitMQ or executing `run_rabbitmq_outbound_consumer`. Consequently, premature AMQP ACKing (message loss on crash) and poison-pill loops in `scheduler` had zero test coverage.
- **Business / Operational Impact:** Silent message loss during node crashes/restarts goes undetected.
- **Recommended Fix:** Add integration tests against a real RabbitMQ container verifying: AMQP delivery stays un-acked until SMTP + Postgres attempt persistence complete, killing `mail-engine` mid-delivery redelivers without loss, and deferred `421` messages re-enter `mail.outbound.retry` and succeed.
- **How to Verify:** Automated chaos test passing against RabbitMQ + Postgres container killing consumer mid-transaction.

### TST-03 — E2E Rust Test Bypasses `main.rs` Binary, `outbound_runner.rs`, `storage_and_dkim.rs`, & `state_store.rs`
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/mail-engine/tests/e2e_outbound_smtp.rs`
- **Exact Technical Issue:** `e2e_outbound_smtp.rs` constructs `DeliveryEngine` directly and signs MIME manually instead of testing `DkimSigningStore`, `PipelineMessageSink`, `EngineDeliveryStateStore`, or the compiled `mail-engine` binary. Inbound Port 25 -> `InboundAuthVerifier` -> Dovecot LMTP -> IMAP is completely untested against real Dovecot.
- **Business / Operational Impact:** Major integration defects in `main.rs` (empty `InMemoryDomainDirectory`, `PipelineMessageSink` loop, missing `inbound` role) went undetected by `cargo test`.
- **Recommended Fix:** Add black-box binary E2E tests booting `mail-engine` against Postgres, RabbitMQ, MinIO, Dovecot, and a sink MX testing both outbound (API + 587) and inbound (Port 25 -> IMAP).
- **How to Verify:** Both outbound and inbound E2E black-box tests pass cleanly against running compose dependencies.

### TST-04 — Missing Security Regression Tests for Auth, MFA, SSRF, CRLF, & Access Control
- **Severity:** **Critical**
- **Affected Files / Modules:** `apps/api/src/*.test.ts`, `services/mailbox-service/src/app.test.ts`
- **Exact Technical Issue:** Missing security tests for:
  - `POST /v1/emails` unauthenticated header spoofing & `Subject` CRLF injection
  - `mk_live_*` API key auth, scopes, & rate limits
  - Admin login via `appSurface: 'web'` bypassing TOTP MFA & `/auth/mfa/enroll` takeover
  - `mailbox-service/src/index.ts` credential check (unit test mocked verifier instead of testing production wiring)
  - Webhook SSRF (`169.254.169.254`, `10.0.0.0/8`, DNS rebinding) & Outbound MX SSRF (`127.0.0.1`)
  - Unsigned VERP bounce spoofing & folded/quoted `Authentication-Results` bypass
  - `GET /unsubscribe/:token` scanner prefetch mutation & billing self-upgrade bypass
- **Business / Operational Impact:** Critical security bypasses ship directly to production.
- **Recommended Fix:** Convert each security finding above into an explicit negative regression test that fails on vulnerable behavior and passes only when enforced.
- **How to Verify:** Run full security regression test suite verifying `401`/`403`/`400` rejections across every vector.

### TST-05 — Missing `S3MessageStore` HTTP Edge-Case Tests
- **Severity:** **High**
- **Affected Files / Modules:** `crates/message-storage/src/s3.rs`
- **Exact Technical Issue:** Existing test only exercises simple unchunked `200`/`204` responses without `100 Continue`, `Transfer-Encoding: chunked`, special-character keys, timeouts, or `503` transient error handling in `DeliveryEngine`.
- **Business / Operational Impact:** Real S3/MinIO endpoints returning `100 Continue` or chunked responses fail or corrupt MIME bodies silently.
- **Recommended Fix:** Add unit/integration tests against MinIO container + simulated chunked/`100-Continue`/`503` server verifying S3 client parity and `DeliveryEngine` deferral on transient S3 outages.
- **How to Verify:** `cargo test -p message-storage -p delivery-engine` passes all chunked, timeout, and transient-defer assertions.

### TST-06 — Zero Automated Frontend Tests for `apps/web` & `apps/admin` and No Real Browser DOM XSS Suite
- **Severity:** **High**
- **Affected Files / Modules:** `apps/web`, `apps/admin`, `apps/mail/src/__tests__/sanitize.test.ts`
- **Exact Technical Issue:** `apps/web` and `apps/admin` have no `test` script (`package.json`), leaving `/v1/auth/me` reload bug, 15-min token refresh flow, reveal-once modals, and attachment downloads untested. `apps/mail` HTML sanitizer test runs in Node regex fallback (`sanitize.ts:10-12`) rather than testing DOMPurify execution in a browser/DOM (`jsdom`/`playwright`).
- **Business / Operational Impact:** Broken page reloads, expired-session lockouts, and attachment `401` errors reach end users unnoticed.
- **Recommended Fix:** Add Vitest + React Testing Library / Playwright E2E smoke tests for `apps/web`, `apps/mail`, and `apps/admin` (including browser DOMPurify XSS tests and Nginx routing checks).
- **How to Verify:** Run automated browser/DOM test suites in CI across all 3 frontend apps.

### TST-07 — Missing Docker Compose, Nginx, Dovecot, DR Restore, & Production Load Tests
- **Severity:** **High**
- **Affected Files / Modules:** `.github/workflows/ci.yml`, `infrastructure/*`, `scripts/backup-restore-dr.sh`
- **Exact Technical Issue:** CI does not build `Dockerfile.node`, `Dockerfile.mail-engine`, `Dockerfile.frontend`, or `infrastructure/dovecot/Dockerfile`, never tests `docker compose up` health checks, never runs `backup-restore-dr.sh` actual restore, and has no multi-node throughput/soak test over real Postgres + RabbitMQ + S3 + TLS.
- **Business / Operational Impact:** Broken Alpine `argon2` builds, missing `/etc/mail-certs` crashes, and Prometheus target mismatches fail only on customer VPS deployments.
- **Recommended Fix:** Add CI Docker build/smoke job (`docker compose build` + healthcheck verification), add weekly automated DR restore verification job, and build a containerized staging load-test harness before production launch.
- **How to Verify:** Clean VM `docker compose up` smoke test + DR restore + multi-node load run complete with zero manual intervention.
