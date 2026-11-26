# Scalability & Performance Audit

**Audit Date:** 2026-11-26  
**Target Scale:** 20,000,000+ emails per campaign & horizontal multi-node distributed delivery  
**Scope:** Queue ingestion, Rust Tokio MTA workers, SMTP connection pooling, DNS cache, adaptive rate limits, PostgreSQL partitioning/indexes, S3 throughput, memory/disk, backpressure, and benchmark interpretation.

---

## 1. Benchmark Reality Check (Synthetic vs. Production SMTP)

Observed release-mode benchmark (`cargo test --release -p delivery-engine --test load_benchmark -- --nocapture`) in this session:
- **Burst 600 Transactional (32 workers):** `600/600` accepted in `30.19ms` (`19,874.3 msgs/sec`), RSS `7.38 MiB`, CPU `0:00.03`, E2E `p50=19.71ms` / `p99=29.01ms`.
- **Mixed Faults (55 msgs: Slow + 421 + DNS Fail + NullMX):** `55` processed (`30` accepted, `15` deferred, `10` bounced) in `95.23ms` (`577.6 msgs/sec`), RSS `7.36 MiB`, E2E `p50=27.89ms` / `p99=95.19ms`.

### Why These Numbers Do NOT Represent Real 20M/Campaign SMTP Throughput
The benchmark uses:
1. `StaticMxResolver` (in-memory HashMap lookup, ~0ns) instead of live UDP/TCP authoritative DNS across thousands of domains.
2. `InMemoryMessageStore` (zero-copy RAM bytes) instead of NVMe `fsync` or networked S3/MinIO HTTP PUT/GET.
3. `InMemoryDeliveryStateStore` (mutex vector push) instead of PostgreSQL ACID transactions on `delivery_attempts`, `message_recipients`, `messages`, `email_events`.
4. Loopback `127.0.0.1` plaintext SMTP sinks with ~0ms RTT and no RabbitMQ/AMQP broker confirms, no TLS handshakes (`STARTTLS`), no RSA-2048 DKIM CPU signing, and no ISP rate ceilings (Gmail/Outlook/Yahoo throttle per IP/domain).

At **~5–10ms real remote SMTP+TLS+DB+S3 per reused-connection delivery** with 64 concurrent workers per node, one node sustains roughly **1,000–3,000 msgs/sec raw** (20M messages = ~2–6 hours across 2–4 horizontal nodes if ISP throttling allows; ISP warm-up limits are the dominant external constraint). Real bottlenecks currently lie in **sequential `OutboxRelay`**, **single-consumer `queue-engine`**, **memory leaks in `DeliveryEngine` / `LimiterMap` / DNS cache**, **missing campaign dispatcher**, and **unindexed/unpartitioned DB tables**.

---

## 2. Detailed Scalability & Performance Findings

### SC-01 — `OutboxRelay` Sequential Processing & Table Bloat Bottlenecks at ~100–300 msgs/sec
- **Severity:** **Critical**
- **Affected Files / Modules:** `services/scheduler/src/outbox-relay.ts:27-46`, `services/scheduler/src/index.ts:18-55`, `migrations/0001_initial_schema.sql:496-509`
- **Exact Technical Issue:** `OutboxRelay` fetches `LIMIT 200`, awaits `publishConfirmed` one message at a time (200 sequential AMQP network RTTs), and runs `UPDATE outbox_events SET status = 'published' WHERE id = $1` 200 times sequentially—never deleting published rows. `idx_outbox_pending` indexes all `status = 'pending'` including currently locked rows, and default `autovacuum_vacuum_scale_factor = 0.2` creates severe bloat as `outbox_events` reaches 20M+ rows.
- **Business / Operational Impact:** Dispatching 20M campaign emails would take **18–55+ hours** through `OutboxRelay` alone, starving transactional outbox latency and bloating PostgreSQL WAL & table size.
- **Recommended Fix:** Batch AMQP publishes concurrently (`Promise.all` up to channel confirm window), execute a single `DELETE FROM outbox_events WHERE id = ANY($1)` (or move to daily archive), index `WHERE status = 'pending' AND locked_at IS NULL`, tune aggressive `autovacuum` (`0.01`), or for bulk campaigns have the dedicated campaign worker publish directly with idempotency tracking rather than routing 20M single-row JSONB rows through `outbox_events`.
- **How to Verify:** Benchmark `OutboxRelay` against live PostgreSQL + RabbitMQ publishing 100k rows and verify sustained >5,000 rows/sec with flat table size.

### SC-02 — Single-Message Serial Consumption in `queue-engine` + Unbounded `DeliveryEngine.timings` Memory Leak
- **Severity:** **Critical**
- **Affected Files / Modules:** `crates/queue-engine/src/lib.rs:179-239`, `crates/delivery-engine/src/lib.rs:173, 327-329`, `services/mail-engine/src/outbound_runner.rs:146-192`
- **Exact Technical Issue:**
  1. `consume_queue` (`queue-engine/src/lib.rs:203-236`) awaits `handler(...).await` sequentially one AMQP delivery at a time despite setting `basic_qos(prefetch_count = 32)`. When properly changed to wait for delivery completion before ACK, serial consumption would limit throughput to 1 concurrent message unless dispatched concurrently within bounded worker permits!
  2. `DeliveryEngine.timings` (`delivery-engine/src/lib.rs:173, 327-329`) pushes a `DeliveryStageTiming` struct to an unbounded `Mutex<Vec<_>>` for every message ever processed.
  3. `PipelineMessageSink` locks a single `Mutex<lapin::Channel>` across all 1,024+ ingress connections (`outbound_runner.rs:44, 86`).
- **Business / Operational Impact:** Under 20M campaign volume, unbounded `timings` causes deterministic OOM crashes (~1.6 GB leaked just for structs), and awaiting delivery serially collapses concurrency to 1!
- **Recommended Fix:** Delete `timings` retention in production (use Prometheus histograms only, or ring-buffer in tests), dispatch AMQP deliveries concurrently via `tokio::spawn` / `FuturesUnordered` up to `prefetch_count` (holding `delivery` until persistence completes), and pool AMQP publisher channels.
- **How to Verify:** Soak test 1,000,000 deliveries in `mail-engine` monitoring RSS growth (`< 5%` variance after warmup) and verifying parallel worker utilization.

### SC-03 — Unbounded Memory Growth Across DNS Cache, Adaptive Limiter, Rate Limiter, & Idle Pool
- **Severity:** **High**
- **Affected Files / Modules:** `crates/dns-resolver/src/lib.rs:82`, `crates/delivery-engine/src/adaptive.rs:53`, `crates/rate-limiter/src/lib.rs:34-39`, `crates/smtp-outbound/src/lib.rs:222, 679-712`
- **Exact Technical Issue:** `HickoryDnsResolver.cache`, `AdaptiveDomainLimiter.domains`, `IngressRateLimiter` (`ip_message_counts`, `ip_auth_failures`), and `OutboundSmtpPool.idle` are all unbounded `HashMap`s with zero max-capacity LRU eviction and zero periodic sweeping of expired keys/connections.
- **Business / Operational Impact:** Long-running MTA nodes accumulate millions of stale recipient domains, attacker IPs, and closed idle FDs until hitting `ulimit -n` (FD exhaustion) or OOM.
- **Recommended Fix:** Enforce bounded LRU/TinyLFU caches (e.g., max `100_000` domains for DNS & adaptive limiter), spawn periodic TTL sweeps on `OutboundSmtpPool.idle`, and back rate-limiting + cross-node adaptive throttles in Redis.
- **How to Verify:** Unit/stress test inserting 500k unique recipient domains + random source IPs confirming bounded RSS and FD count.

### SC-04 — PostgreSQL Partition Exhaustion & Missing Campaign/Analytics Indexes at 20M Scale
- **Severity:** **Critical**
- **Affected Files / Modules:** `migrations/0001_initial_schema.sql:83-95, 309-494`, `migrations/0002_partition_management.sql`
- **Exact Technical Issue:** Missing automated future partition creation beyond month +3 (`audit_logs`, `email_events`, `delivery_attempts` fail hard after 3–4 months); unpartitioned `messages` & `message_recipients` (each adding 20M rows per campaign); UUIDv4 (`crypto.randomUUID()`) causing random B-tree page splits instead of monotonic UUIDv7; missing indexes on `messages(campaign_id, state)`, `message_recipients(recipient_domain, state)`, `contacts GIN(tags)`, `email_events(message_id)` & `(campaign_id, event_type)`, and `audit_logs(created_at, organization_id, actor_user_id)`.
- **Business / Operational Impact:** Full sequential table scans on 20M-row tables stall campaign targeting, admin queries, and web analytics, saturating DB CPU/IOPS.
- **Recommended Fix:** Schedule `ensure_monthly_partitions(3)` daily + add `DEFAULT` partitions, switch to UUIDv7 everywhere in Node, partition `messages`/`message_recipients`, and add the targeted partial/GIN/composite indexes via concurrent index migration.
- **How to Verify:** Run `EXPLAIN (ANALYZE, BUFFERS)` against a seeded 5M-row benchmark Postgres DB validating index-only/index scans (<20ms) on campaign segmentation, event queries, and retry polls.

### SC-05 — S3 Full-Body Buffering, Missing Pooling, & Non-Streaming SMTP Payload Construction
- **Severity:** **High**
- **Affected Files / Modules:** `crates/message-storage/src/s3.rs:141-158, 207-236`, `crates/smtp-outbound/src/lib.rs:828-847`, `services/mail-engine/src/storage_and_dkim.rs:48-63`
- **Exact Technical Issue:** For a 25 MiB message, `S3MessageStore` loads HTTP bytes into `Vec<u8>`, copies slice into `Bytes`, `DkimSigningStore` signs/allocates a full copy, and `dot_stuff_payload` allocates another `Vec<u8>` (~75–100 MiB transient allocations per concurrent worker) while opening a fresh TCP+TLS connection to S3 per message.
- **Business / Operational Impact:** 64 concurrent workers handling large attachments require 5–6 GB RAM spike + high S3 TLS handshake overhead.
- **Recommended Fix:** Use a pooled HTTP/keep-alive S3 client, write DKIM + dot-stuffing incrementally over buffered `AsyncWrite` / chunked MIME streams, and cache S3 client connections.
- **How to Verify:** Benchmark 64 concurrent workers delivering 10 MiB attachments via MinIO and measure peak RSS and S3 ops/sec.

### SC-06 — Local-Only Adaptive Provider Throttling & Missing IP Pool Warmup Enforcement
- **Severity:** **High**
- **Affected Files / Modules:** `crates/delivery-engine/src/adaptive.rs`, `services/mail-engine/src/outbound_runner.rs:181`, `apps/api/src/routes/admin.ts:520-585`
- **Exact Technical Issue:** `AdaptiveDomainLimiter` state (`421` backoff rate cuts) is per-process rather than shared via Redis across multi-node `mail-engine` workers. Also `DeliveryJob.bind_ip` is always `None` (`outbound_runner.rs:181`)—sending IPs, IP pools, `warmup_stage`, and `daily_quota` configured in Super Admin have zero effect on outbound MTA sockets.
- **Business / Operational Impact:** Horizontal scaling to 10 MTA nodes multiplies ISP traffic 10x during provider `421` throttling, and new IPs blast beyond warmup quotas, damaging IP reputation.
- **Recommended Fix:** Publish/synchronize provider backoff limits and daily sending IP quotas via Redis counters/pub-sub, and wire `ip_pools`/`sending_ips` selection + `bind_ip` socket binding into `mail-engine`.
- **How to Verify:** Simulate `421` on Node A and confirm Node B honors throttled rate ceiling; confirm `bind_ip` routes outbound socket and halts at `daily_quota`.

### SC-07 — Missing Campaign Chunked Fan-Out Architecture (20M Target)
- **Severity:** **High**
- **Affected Files / Modules:** `apps/api/src/routes/campaigns.ts`, `services/scheduler/src/*`
- **Exact Technical Issue:** No worker exists to segment millions of contacts via keyset cursor pagination (`WHERE id > $last_id`), batch-insert `messages`/`message_recipients`, apply RFC 8058 + suppression filtering, or throttle campaign injection into `mail.outbound.bulk` so bulk spikes don't flood DB/RabbitMQ.
- **Recommended Fix:** Implement a resumable cursor-paginated `CampaignDispatcher` in `services/scheduler` storing `last_dispatched_contact_id` checkpoints in Postgres and respecting `queue_depth` backpressure & `paused`/`cancelled` checks between 1,000-contact batches.
- **How to Verify:** Benchmark dispatching a 100k-contact test campaign checking memory ceiling (<256 MB) and mid-flight pause latency (<1s).

---

## 3. Required Real-World Load Benchmarks (Before Production)

To validate 20M-email capacity accurately, replace synthetic benchmarks with an **end-to-end Docker/cloud staging benchmark suite** measuring:
1. **API → Postgres → Outbox → RabbitMQ → MinIO S3 → `mail-engine` → Local Sink Cluster:** 100k–1M messages end-to-end across 2+ `mail-engine` replicas (measuring DB IOPS, RabbitMQ publish/consume lag, S3 latency, `delivery_attempts` write TPS, CPU, RSS).
2. **Real DNS + TLS + DKIM Signing Overhead:** Benchmark `HickoryDnsResolver` against Unbound/CoreDNS + RSA-2048 DKIM signing CPU saturation per core + `STARTTLS` handshake rate without session reuse vs with session reuse.
3. **20M Campaign Fan-out Checkpoint & Pause:** Measure cursor fan-out throughput + Postgres `messages`/`message_recipients` partition vacuum/bloat behavior + isolation of `mail.outbound.transactional` p99 latency (<1s) while `mail.outbound.bulk` holds a 1M-message backlog.
