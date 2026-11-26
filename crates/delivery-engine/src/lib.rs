//! High-throughput outbound delivery engine with separate transactional/bulk pools,
//! reserved transactional capacity, per-domain/provider AIMD adaptive throttling,
//! backpressure, exponential backoff + jitter, and per-stage latency telemetry.

pub mod adaptive;
pub mod retry;

use std::future::Future;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use adaptive::{classify_provider, AdaptiveDomainLimiter, DomainLimitConfig};
use anyhow::Result;
use chrono::{DateTime, Utc};
use dns_resolver::{DnsLookupError, MxResolution, MxResolver, MxTarget};
use message_storage::MessageStore;
use observability::MetricsRegistry;
pub use retry::{compute_retry_delay, RetryPolicy};
use smtp_outbound::{AttemptTelemetry, DeliveryOutcome, OutboundRequest, OutboundSmtpPool};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;
use tracing::{debug, warn};

/// Delivery pool classification ensuring transactional mail is never starved by bulk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryPoolKind {
    Transactional,
    Bulk,
}

impl DeliveryPoolKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Transactional => "transactional",
            Self::Bulk => "bulk",
        }
    }
}

/// Logical delivery state persisted after an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientDeliveryState {
    AcceptedRemote,
    Deferred,
    Bounced,
}

impl RecipientDeliveryState {
    #[must_use]
    const fn metric_label(self) -> &'static str {
        match self {
            Self::AcceptedRemote => "accepted",
            Self::Deferred => "deferred",
            Self::Bounced => "bounced",
        }
    }
}

/// Outbound job dispatched into the delivery engine.
#[derive(Debug, Clone)]
pub struct DeliveryJob {
    pub message_id: String,
    pub recipient_id: String,
    pub organization_id: String,
    pub pool: DeliveryPoolKind,
    pub envelope_from: String,
    pub recipient_email: String,
    pub body_storage_key: String,
    pub bind_ip: Option<IpAddr>,
    pub attempt_no: u16,
    pub enqueued_at: Instant,
}

/// Persisted transition record emitted by [`DeliveryStateStore`].
#[derive(Debug, Clone)]
pub struct AttemptRecord {
    pub message_id: String,
    pub recipient_id: String,
    pub attempt_no: u16,
    pub next_state: RecipientDeliveryState,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub ambiguous_after_data: bool,
    pub remote_mx_host: Option<String>,
    pub smtp_code: Option<u16>,
    pub enhanced_code: Option<String>,
    pub message: String,
    pub tls_used: bool,
    pub tls_verified: bool,
    pub duration_ms: u64,
}

/// Stage-by-stage timing breakdown captured for every processed job.
#[derive(Debug, Clone, Copy)]
pub struct DeliveryStageTiming {
    pub pool: DeliveryPoolKind,
    pub queue_wait: Duration,
    pub storage_read: Duration,
    pub dns_lookup: Duration,
    pub tcp_connect: Duration,
    pub tls_handshake: Duration,
    pub smtp_transaction: Duration,
    pub state_persist: Duration,
    pub end_to_end: Duration,
    pub outcome_state: RecipientDeliveryState,
    pub persist_succeeded: bool,
}

/// Persistence interface called before a queued delivery is acknowledged.
pub trait DeliveryStateStore: Send + Sync {
    fn record_attempt(&self, record: AttemptRecord) -> impl Future<Output = Result<()>> + Send;
}

/// In-memory persistence store for unit tests and isolated load benchmarks.
#[derive(Debug, Default)]
pub struct InMemoryDeliveryStateStore {
    pub records: Mutex<Vec<AttemptRecord>>,
}

impl DeliveryStateStore for InMemoryDeliveryStateStore {
    fn record_attempt(&self, record: AttemptRecord) -> impl Future<Output = Result<()>> + Send {
        if let Ok(mut guard) = self.records.lock() {
            guard.push(record);
        }
        std::future::ready(Ok(()))
    }
}

/// Configuration for the dual-pool outbound delivery engine.
#[derive(Debug, Clone)]
pub struct DeliveryEngineConfig {
    pub transactional_workers: usize,
    pub bulk_workers: usize,
    pub transactional_queue_capacity: usize,
    pub bulk_queue_capacity: usize,
    pub retry_policy: RetryPolicy,
    pub domain_limits: DomainLimitConfig,
    /// Block loopback, RFC 1918, and link-local/metadata IPs resolved via DNS MX (SSRF protection).
    pub block_private_mx_ips: bool,
}

impl Default for DeliveryEngineConfig {
    fn default() -> Self {
        Self {
            transactional_workers: 32,
            bulk_workers: 16,
            transactional_queue_capacity: 4096,
            bulk_queue_capacity: 4096,
            retry_policy: RetryPolicy::default(),
            domain_limits: DomainLimitConfig::default(),
            block_private_mx_ips: true,
        }
    }
}

/// Backpressure error when a bounded pool queue is saturated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueFullError;

/// Orchestrates bounded concurrent delivery workers with separate priority pools.
pub struct DeliveryEngine<R, S, P> {
    config: DeliveryEngineConfig,
    resolver: Arc<R>,
    storage: Arc<S>,
    smtp_pool: Arc<OutboundSmtpPool>,
    state_store: Arc<P>,
    limiter: Arc<AdaptiveDomainLimiter>,
    metrics: Arc<MetricsRegistry>,
    tx_sender: Mutex<Option<mpsc::Sender<DeliveryJob>>>,
    bulk_sender: Mutex<Option<mpsc::Sender<DeliveryJob>>>,
    tx_rx: Mutex<Option<mpsc::Receiver<DeliveryJob>>>,
    bulk_rx: Mutex<Option<mpsc::Receiver<DeliveryJob>>>,
    peak_concurrency: AtomicUsize,
    active_total: AtomicUsize,
    timings: Mutex<Vec<DeliveryStageTiming>>,
}

impl<R, S, P> DeliveryEngine<R, S, P>
where
    R: MxResolver + 'static,
    S: MessageStore + 'static,
    P: DeliveryStateStore + 'static,
{
    #[must_use]
    pub fn new(
        config: DeliveryEngineConfig,
        resolver: Arc<R>,
        storage: Arc<S>,
        smtp_pool: Arc<OutboundSmtpPool>,
        state_store: Arc<P>,
        metrics: Arc<MetricsRegistry>,
    ) -> Self {
        let (tx_sender, tx_rx) = mpsc::channel(config.transactional_queue_capacity);
        let (bulk_sender, bulk_rx) = mpsc::channel(config.bulk_queue_capacity);
        let limiter = Arc::new(AdaptiveDomainLimiter::new(config.domain_limits));

        Self {
            config,
            resolver,
            storage,
            smtp_pool,
            state_store,
            limiter,
            metrics,
            tx_sender: Mutex::new(Some(tx_sender)),
            bulk_sender: Mutex::new(Some(bulk_sender)),
            tx_rx: Mutex::new(Some(tx_rx)),
            bulk_rx: Mutex::new(Some(bulk_rx)),
            peak_concurrency: AtomicUsize::new(0),
            active_total: AtomicUsize::new(0),
            timings: Mutex::new(Vec::new()),
        }
    }

    /// Non-blocking enqueue returning [`QueueFullError`] immediately when backpressure engages.
    ///
    /// # Errors
    /// Returns [`QueueFullError`] if the pool's bounded channel is full or closed.
    pub fn try_enqueue(&self, job: DeliveryJob) -> std::result::Result<(), QueueFullError> {
        let sender_opt = match job.pool {
            DeliveryPoolKind::Transactional => self.tx_sender.lock().ok().and_then(|g| g.clone()),
            DeliveryPoolKind::Bulk => self.bulk_sender.lock().ok().and_then(|g| g.clone()),
        };
        let Some(sender) = sender_opt else {
            return Err(QueueFullError);
        };
        sender.try_send(job).map_err(|_| QueueFullError)
    }

    /// Awaits queue capacity (async backpressure) and enqueues the job.
    ///
    /// # Errors
    /// Returns an error if the pool worker channel has shut down.
    pub async fn enqueue(&self, job: DeliveryJob) -> Result<()> {
        let sender_opt = match job.pool {
            DeliveryPoolKind::Transactional => self.tx_sender.lock().ok().and_then(|g| g.clone()),
            DeliveryPoolKind::Bulk => self.bulk_sender.lock().ok().and_then(|g| g.clone()),
        };
        let Some(sender) = sender_opt else {
            anyhow::bail!("delivery pool closed");
        };
        sender
            .send(job)
            .await
            .map_err(|_| anyhow::anyhow!("delivery pool closed"))
    }

    /// Closes intake queues so worker pools drain all pending jobs and exit cleanly.
    pub fn shutdown_intake(&self) {
        if let Ok(mut g) = self.tx_sender.lock() {
            let _ = g.take();
        }
        if let Ok(mut g) = self.bulk_sender.lock() {
            let _ = g.take();
        }
    }

    /// Returns peak concurrent active deliveries observed across both pools.
    #[must_use]
    pub fn peak_concurrency(&self) -> usize {
        self.peak_concurrency.load(Ordering::Relaxed)
    }

    /// Returns a snapshot of all recorded stage latency timings.
    #[must_use]
    pub fn snapshot_timings(&self) -> Vec<DeliveryStageTiming> {
        self.timings.lock().map_or_default(|g| g.clone())
    }

    /// Spawns separate transactional and bulk worker pools, running until receivers close.
    ///
    /// # Errors
    /// Returns an error if called more than once.
    pub async fn run_workers(self: &Arc<Self>) -> Result<()> {
        let tx_rx = self
            .tx_rx
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .ok_or_else(|| anyhow::anyhow!("workers already started"))?;
        let bulk_rx = self
            .bulk_rx
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .ok_or_else(|| anyhow::anyhow!("workers already started"))?;

        let tx_handle = tokio::spawn(run_pool_loop(
            Arc::clone(self),
            tx_rx,
            self.config.transactional_workers,
            DeliveryPoolKind::Transactional,
        ));
        let bulk_handle = tokio::spawn(run_pool_loop(
            Arc::clone(self),
            bulk_rx,
            self.config.bulk_workers,
            DeliveryPoolKind::Bulk,
        ));

        let (r1, r2) = tokio::join!(tx_handle, bulk_handle);
        r1?;
        r2?;
        Ok(())
    }

    /// Processes a single delivery job end-to-end and records stage latencies + state transition.
    pub async fn process_job(&self, job: DeliveryJob) -> DeliveryStageTiming {
        let pool_name = job.pool.as_str();
        let queue_wait = job.enqueued_at.elapsed();
        self.metrics
            .observe_stage_latency("queue_wait", pool_name, queue_wait.as_secs_f64());

        let active_now = self.active_total.fetch_add(1, Ordering::SeqCst) + 1;
        update_peak(&self.peak_concurrency, active_now);
        self.metrics
            .outbound_active_workers
            .with_label_values(&[pool_name])
            .inc();

        let timing = self.execute_delivery_pipeline(&job, queue_wait).await;

        self.active_total.fetch_sub(1, Ordering::SeqCst);
        self.metrics
            .outbound_active_workers
            .with_label_values(&[pool_name])
            .dec();

        if let Ok(mut guard) = self.timings.lock() {
            if guard.len() >= 4096 {
                guard.remove(0);
            }
            guard.push(timing);
        }
        timing
    }

    async fn fetch_payload_or_record(
        &self,
        job: &DeliveryJob,
        queue_wait: Duration,
        storage_start: Instant,
    ) -> std::result::Result<(bytes::Bytes, Duration), Box<DeliveryStageTiming>> {
        match self.storage.get_message(&job.body_storage_key).await {
            Ok(p) => Ok((p, storage_start.elapsed())),
            Err(err) => {
                let msg_text = err.to_string();
                let is_not_found = msg_text.contains("OBJECT_NOT_FOUND")
                    || msg_text.contains("missing message key")
                    || msg_text.contains("NoSuchKey");
                let timing = self
                    .record_pre_send_outcome(
                        job,
                        queue_wait,
                        storage_start.elapsed(),
                        Duration::ZERO,
                        if is_not_found {
                            RecipientDeliveryState::Bounced
                        } else {
                            RecipientDeliveryState::Deferred
                        },
                        Some(if is_not_found { 554 } else { 451 }),
                        Some(if is_not_found {
                            "5.3.0".to_string()
                        } else {
                            "4.3.0".to_string()
                        }),
                        if is_not_found {
                            "Payload missing from storage".to_string()
                        } else {
                            format!("Temporary storage read failure: {msg_text}")
                        },
                    )
                    .await;
                Err(Box::new(timing))
            }
        }
    }

    async fn execute_delivery_pipeline(
        &self,
        job: &DeliveryJob,
        queue_wait: Duration,
    ) -> DeliveryStageTiming {
        let pool_name = job.pool.as_str();
        let recipient_domain = job
            .recipient_email
            .rsplit_once('@')
            .map_or("unknown", |(_, d)| d)
            .to_ascii_lowercase();
        let provider = classify_provider(&recipient_domain);

        let Some(domain_permit) = self.limiter.try_acquire(provider, &recipient_domain) else {
            return self
                .record_pre_send_outcome(
                    job,
                    queue_wait,
                    Duration::ZERO,
                    Duration::ZERO,
                    RecipientDeliveryState::Deferred,
                    Some(421),
                    Some("4.7.0".to_string()),
                    "Local adaptive domain rate/concurrency limit engaged".to_string(),
                )
                .await;
        };

        let storage_start = Instant::now();
        let (payload, storage_read) = match self
            .fetch_payload_or_record(job, queue_wait, storage_start)
            .await
        {
            Ok(v) => v,
            Err(timing) => {
                drop(domain_permit);
                return *timing;
            }
        };
        self.metrics
            .observe_stage_latency("storage_read", pool_name, storage_read.as_secs_f64());

        let dns_start = Instant::now();
        let mx_res = self.resolver.resolve_mx(&recipient_domain).await;
        let dns_lookup = dns_start.elapsed();
        self.metrics
            .observe_stage_latency("dns_lookup", pool_name, dns_lookup.as_secs_f64());

        let targets = match mx_res {
            Ok(MxResolution::Targets(t)) => t,
            Ok(MxResolution::NullMx) => {
                drop(domain_permit);
                return self
                    .record_pre_send_outcome(
                        job,
                        queue_wait,
                        storage_read,
                        dns_lookup,
                        RecipientDeliveryState::Bounced,
                        Some(550),
                        Some("5.1.10".to_string()),
                        "Domain advertises Null MX (RFC 7505); does not accept mail".to_string(),
                    )
                    .await;
            }
            Err(dns_err) => {
                drop(domain_permit);
                let (state, code) = match &dns_err {
                    DnsLookupError::NxDomain(_) => (RecipientDeliveryState::Bounced, 550),
                    DnsLookupError::Temporary(_) => (RecipientDeliveryState::Deferred, 451),
                };
                return self
                    .record_pre_send_outcome(
                        job,
                        queue_wait,
                        storage_read,
                        dns_lookup,
                        state,
                        Some(code),
                        Some("4.4.4".to_string()),
                        dns_err.to_string(),
                    )
                    .await;
            }
        };

        let (chosen_mx, tele) = self
            .send_across_mx_targets(job, &targets, payload.as_ref())
            .await;
        drop(domain_permit);

        self.persist_final_attempt(
            job,
            provider,
            &recipient_domain,
            queue_wait,
            storage_read,
            dns_lookup,
            chosen_mx,
            tele,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn persist_final_attempt(
        &self,
        job: &DeliveryJob,
        provider: &str,
        recipient_domain: &str,
        queue_wait: Duration,
        storage_read: Duration,
        dns_lookup: Duration,
        chosen_mx: Option<String>,
        tele: AttemptTelemetry,
    ) -> DeliveryStageTiming {
        let pool_name = job.pool.as_str();
        let (next_state, ambiguous, smtp_code, enhanced, msg) =
            self.classify_and_adapt(provider, recipient_domain, job, &tele.outcome);

        let next_retry_at = (next_state == RecipientDeliveryState::Deferred).then(|| {
            Utc::now()
                + chrono::Duration::from_std(compute_retry_delay(
                    job.attempt_no,
                    ambiguous,
                    &self.config.retry_policy,
                ))
                .unwrap_or_default()
        });

        let persist_start = Instant::now();
        let total_ms = u64::try_from(job.enqueued_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        let persist_succeeded = if let Err(err) = self
            .state_store
            .record_attempt(AttemptRecord {
                message_id: job.message_id.clone(),
                recipient_id: job.recipient_id.clone(),
                attempt_no: job.attempt_no,
                next_state,
                next_retry_at,
                ambiguous_after_data: ambiguous,
                remote_mx_host: chosen_mx,
                smtp_code,
                enhanced_code: enhanced,
                message: msg,
                tls_used: tele.tls_used,
                tls_verified: tele.tls_verified,
                duration_ms: total_ms,
            })
            .await
        {
            warn!(error = %err, "Failed to persist delivery attempt state");
            false
        } else {
            true
        };
        let state_persist = persist_start.elapsed();
        let end_to_end = job.enqueued_at.elapsed();

        self.metrics
            .observe_stage_latency("state_persist", pool_name, state_persist.as_secs_f64());
        self.metrics
            .observe_stage_latency("e2e_delivery", pool_name, end_to_end.as_secs_f64());

        DeliveryStageTiming {
            pool: job.pool,
            queue_wait,
            storage_read,
            dns_lookup,
            tcp_connect: tele.connect_duration,
            tls_handshake: tele.tls_duration,
            smtp_transaction: tele.transaction_duration,
            state_persist,
            end_to_end,
            outcome_state: next_state,
            persist_succeeded,
        }
    }

    async fn send_across_mx_targets(
        &self,
        job: &DeliveryJob,
        targets: &[MxTarget],
        payload: &[u8],
    ) -> (Option<String>, AttemptTelemetry) {
        let pool_name = job.pool.as_str();
        let mut last_telemetry: Option<AttemptTelemetry> = None;
        let mut chosen_mx: Option<String> = None;

        'mx_loop: for target in targets {
            for &ip in &target.addrs {
                if self.config.block_private_mx_ips && is_non_routable_ip(ip) {
                    warn!(mx = %target.exchange, ip = %ip, "Blocked SSRF attempt to non-routable MX IP");
                    last_telemetry = Some(AttemptTelemetry {
                        outcome: DeliveryOutcome::Bounced {
                            smtp_code: 550,
                            enhanced_code: Some("5.7.1".to_string()),
                            message: format!("Policy rejected non-routable MX target {ip}"),
                        },
                        remote_ip: ip,
                        tls_used: false,
                        tls_verified: false,
                        connection_reused: false,
                        connect_duration: Duration::ZERO,
                        tls_duration: Duration::ZERO,
                        transaction_duration: Duration::ZERO,
                    });
                    continue;
                }
                chosen_mx = Some(target.exchange.clone());
                let telemetry = self
                    .smtp_pool
                    .deliver(&OutboundRequest {
                        mx_host: &target.exchange,
                        target_ip: ip,
                        port: target.port,
                        bind_ip: job.bind_ip,
                        envelope_from: &job.envelope_from,
                        recipient: &job.recipient_email,
                        raw_mime: payload,
                    })
                    .await;

                self.metrics
                    .record_connection_reuse(telemetry.connection_reused);
                self.metrics.observe_stage_latency(
                    "tcp_connect",
                    pool_name,
                    telemetry.connect_duration.as_secs_f64(),
                );
                self.metrics.observe_stage_latency(
                    "tls_handshake",
                    pool_name,
                    telemetry.tls_duration.as_secs_f64(),
                );
                self.metrics.observe_stage_latency(
                    "smtp_transaction",
                    pool_name,
                    telemetry.transaction_duration.as_secs_f64(),
                );

                let done = matches!(
                    telemetry.outcome,
                    DeliveryOutcome::Accepted { .. }
                        | DeliveryOutcome::Bounced { .. }
                        | DeliveryOutcome::AmbiguousPostData { .. }
                        | DeliveryOutcome::Deferred {
                            is_throttle: true,
                            ..
                        }
                );
                last_telemetry = Some(telemetry);
                if done {
                    break 'mx_loop;
                }
            }
        }

        let fallback = AttemptTelemetry {
            outcome: DeliveryOutcome::Deferred {
                smtp_code: 451,
                enhanced_code: Some("4.4.4".to_string()),
                message: "No deliverable MX IP addresses available".to_string(),
                is_throttle: false,
            },
            remote_ip: IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
            tls_used: false,
            tls_verified: false,
            connection_reused: false,
            connect_duration: Duration::ZERO,
            tls_duration: Duration::ZERO,
            transaction_duration: Duration::ZERO,
        };
        (chosen_mx, last_telemetry.unwrap_or(fallback))
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_pre_send_outcome(
        &self,
        job: &DeliveryJob,
        queue_wait: Duration,
        storage_read: Duration,
        dns_lookup: Duration,
        state: RecipientDeliveryState,
        smtp_code: Option<u16>,
        enhanced_code: Option<String>,
        message: String,
    ) -> DeliveryStageTiming {
        let retry_at = (state == RecipientDeliveryState::Deferred).then(|| {
            Utc::now()
                + chrono::Duration::from_std(compute_retry_delay(
                    job.attempt_no,
                    false,
                    &self.config.retry_policy,
                ))
                .unwrap_or_default()
        });

        let persist_start = Instant::now();
        let persist_succeeded = self
            .state_store
            .record_attempt(AttemptRecord {
                message_id: job.message_id.clone(),
                recipient_id: job.recipient_id.clone(),
                attempt_no: job.attempt_no,
                next_state: state,
                next_retry_at: retry_at,
                ambiguous_after_data: false,
                remote_mx_host: None,
                smtp_code,
                enhanced_code,
                message,
                tls_used: false,
                tls_verified: false,
                duration_ms: 0,
            })
            .await
            .is_ok();
        let state_persist = persist_start.elapsed();

        let pool_name = job.pool.as_str();
        self.metrics
            .record_delivery_attempt(pool_name, state.metric_label());

        let end_to_end = job.enqueued_at.elapsed();
        self.metrics
            .observe_stage_latency("e2e_delivery", pool_name, end_to_end.as_secs_f64());

        DeliveryStageTiming {
            pool: job.pool,
            queue_wait,
            storage_read,
            dns_lookup,
            tcp_connect: Duration::ZERO,
            tls_handshake: Duration::ZERO,
            smtp_transaction: Duration::ZERO,
            state_persist,
            end_to_end,
            outcome_state: state,
            persist_succeeded,
        }
    }

    fn classify_and_adapt(
        &self,
        provider: &str,
        domain: &str,
        job: &DeliveryJob,
        outcome: &DeliveryOutcome,
    ) -> (
        RecipientDeliveryState,
        bool,
        Option<u16>,
        Option<String>,
        String,
    ) {
        let pool_name = job.pool.as_str();
        match outcome {
            DeliveryOutcome::Accepted {
                smtp_code,
                enhanced_code,
                message,
            } => {
                self.limiter.record_success(provider, domain);
                self.metrics.record_delivery_attempt(pool_name, "accepted");
                (
                    RecipientDeliveryState::AcceptedRemote,
                    false,
                    Some(*smtp_code),
                    enhanced_code.clone(),
                    message.clone(),
                )
            }
            DeliveryOutcome::Bounced {
                smtp_code,
                enhanced_code,
                message,
            } => {
                self.metrics.record_delivery_attempt(pool_name, "bounced");
                (
                    RecipientDeliveryState::Bounced,
                    false,
                    Some(*smtp_code),
                    enhanced_code.clone(),
                    message.clone(),
                )
            }
            DeliveryOutcome::Deferred {
                smtp_code,
                enhanced_code,
                message,
                is_throttle,
            } => {
                if *is_throttle {
                    self.limiter.record_throttle(provider, domain);
                    self.metrics.record_adaptive_throttle(provider);
                }
                let terminal = job.attempt_no >= self.config.retry_policy.max_attempts;
                let state = if terminal {
                    RecipientDeliveryState::Bounced
                } else {
                    RecipientDeliveryState::Deferred
                };
                self.metrics
                    .record_delivery_attempt(pool_name, state.metric_label());
                (
                    state,
                    false,
                    Some(*smtp_code),
                    enhanced_code.clone(),
                    message.clone(),
                )
            }
            DeliveryOutcome::AmbiguousPostData { reason } => {
                let terminal = job.attempt_no >= self.config.retry_policy.max_attempts;
                let state = if terminal {
                    RecipientDeliveryState::Bounced
                } else {
                    RecipientDeliveryState::Deferred
                };
                self.metrics
                    .record_delivery_attempt(pool_name, "ambiguous_deferred");
                (state, true, None, None, reason.clone())
            }
            DeliveryOutcome::NetworkError { reason } => {
                let terminal = job.attempt_no >= self.config.retry_policy.max_attempts;
                let state = if terminal {
                    RecipientDeliveryState::Bounced
                } else {
                    RecipientDeliveryState::Deferred
                };
                self.metrics
                    .record_delivery_attempt(pool_name, "network_deferred");
                (state, false, None, None, reason.clone())
            }
        }
    }
}

async fn run_pool_loop<R, S, P>(
    engine: Arc<DeliveryEngine<R, S, P>>,
    mut rx: mpsc::Receiver<DeliveryJob>,
    max_workers: usize,
    pool: DeliveryPoolKind,
) where
    R: MxResolver + 'static,
    S: MessageStore + 'static,
    P: DeliveryStateStore + 'static,
{
    let semaphore = Arc::new(Semaphore::new(max_workers));
    let mut active = JoinSet::new();

    debug!(
        pool = pool.as_str(),
        max_workers, "Started outbound worker pool"
    );
    while let Some(job) = rx.recv().await {
        let Ok(permit) = semaphore.clone().acquire_owned().await else {
            break;
        };
        let eng = Arc::clone(&engine);
        active.spawn(async move {
            let _permit = permit;
            let _ = eng.process_job(job).await;
        });
        while active.try_join_next().is_some() {}
    }

    while active.join_next().await.is_some() {}
    debug!(pool = pool.as_str(), "Drained outbound worker pool");
}

fn is_non_routable_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

fn update_peak(peak: &AtomicUsize, current: usize) {
    let mut prev = peak.load(Ordering::Relaxed);
    while current > prev {
        match peak.compare_exchange_weak(prev, current, Ordering::SeqCst, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => prev = actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, SocketAddr};

    use dns_resolver::{MxTarget, StaticMxResolver};
    use message_storage::InMemoryMessageStore;
    use smtp_outbound::OutboundClientConfig;
    use smtp_protocol::{SessionConfig, SmtpResponse};
    use smtp_server::{serve_listener, SmtpServerConfig};
    use smtp_session::{ReceivedMessage, SessionContext, SessionHandler};
    use tokio::net::TcpListener;
    use tokio::sync::watch;

    use super::*;

    struct DelayedSink {
        delay: Duration,
    }

    impl SessionHandler for DelayedSink {
        async fn on_message(
            &self,
            _ctx: &SessionContext,
            _message: ReceivedMessage,
        ) -> std::result::Result<SmtpResponse, SmtpResponse> {
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            Ok(SmtpResponse::ok("2.0.0 OK"))
        }
    }

    async fn spawn_sink(
        delay: Duration,
        metrics: Arc<MetricsRegistry>,
        rx: watch::Receiver<bool>,
    ) -> (SocketAddr, tokio::task::JoinHandle<Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                session_config: SessionConfig::default(),
                ..SmtpServerConfig::default()
            },
            Arc::new(DelayedSink { delay }),
            metrics,
            rx,
        ));
        (addr, handle)
    }

    #[tokio::test]
    async fn transactional_pool_is_not_starved_by_slow_bulk_pool() {
        let (tx, rx) = watch::channel(false);
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let (slow_addr, s1) =
            spawn_sink(Duration::from_millis(250), Arc::clone(&metrics), rx.clone()).await;
        let (fast_addr, s2) = spawn_sink(Duration::ZERO, Arc::clone(&metrics), rx).await;

        let resolver = Arc::new(StaticMxResolver::default());
        resolver.set_route(
            "slowbulk.test",
            Ok(MxResolution::Targets(vec![MxTarget {
                exchange: "mx.slowbulk.test".to_string(),
                preference: 10,
                addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
                port: slow_addr.port(),
            }])),
        );
        resolver.set_route(
            "fasttx.test",
            Ok(MxResolution::Targets(vec![MxTarget {
                exchange: "mx.fasttx.test".to_string(),
                preference: 10,
                addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
                port: fast_addr.port(),
            }])),
        );

        let store = Arc::new(InMemoryMessageStore::default());
        let obj = store
            .put_message("org-1", b"Subject: Priority\r\n\r\nHi\r\n")
            .await
            .unwrap();
        let engine = Arc::new(DeliveryEngine::new(
            DeliveryEngineConfig {
                transactional_workers: 4,
                bulk_workers: 1,
                block_private_mx_ips: false,
                ..DeliveryEngineConfig::default()
            },
            resolver,
            store,
            Arc::new(OutboundSmtpPool::new(OutboundClientConfig::default())),
            Arc::new(InMemoryDeliveryStateStore::default()),
            metrics,
        ));

        let workers = tokio::spawn({
            let eng = Arc::clone(&engine);
            async move { eng.run_workers().await }
        });

        for i in 0..4 {
            engine
                .try_enqueue(DeliveryJob {
                    message_id: format!("bulk-{i}"),
                    recipient_id: format!("r-bulk-{i}"),
                    organization_id: "org-1".to_string(),
                    pool: DeliveryPoolKind::Bulk,
                    envelope_from: "news@platform.test".to_string(),
                    recipient_email: format!("u{i}@slowbulk.test"),
                    body_storage_key: obj.storage_key.clone(),
                    bind_ip: None,
                    attempt_no: 1,
                    enqueued_at: Instant::now(),
                })
                .unwrap();
        }

        engine
            .try_enqueue(DeliveryJob {
                message_id: "otp-1".to_string(),
                recipient_id: "r-otp-1".to_string(),
                organization_id: "org-1".to_string(),
                pool: DeliveryPoolKind::Transactional,
                envelope_from: "otp@platform.test".to_string(),
                recipient_email: "user@fasttx.test".to_string(),
                body_storage_key: obj.storage_key,
                bind_ip: None,
                attempt_no: 1,
                enqueued_at: Instant::now(),
            })
            .unwrap();

        engine.shutdown_intake();
        workers.await.unwrap().unwrap();

        let timings = engine.snapshot_timings();
        let tx_timing = timings
            .iter()
            .find(|t| t.pool == DeliveryPoolKind::Transactional)
            .expect("transactional timing");
        assert_eq!(
            tx_timing.outcome_state,
            RecipientDeliveryState::AcceptedRemote
        );
        assert!(tx_timing.end_to_end < Duration::from_millis(150));

        let _ = tx.send(true);
        s1.await.unwrap().unwrap();
        s2.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn blocks_private_mx_ips_when_enabled() {
        let resolver = Arc::new(StaticMxResolver::default());
        resolver.set_route(
            "ssrf.test",
            Ok(MxResolution::Targets(vec![MxTarget {
                exchange: "127.0.0.1".to_string(),
                preference: 10,
                addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
                port: 25,
            }])),
        );
        let store = Arc::new(InMemoryMessageStore::default());
        let obj = store
            .put_message("org-1", b"Subject: Test\r\n\r\nBody\r\n")
            .await
            .unwrap();
        let state = Arc::new(InMemoryDeliveryStateStore::default());
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let engine = DeliveryEngine::new(
            DeliveryEngineConfig {
                block_private_mx_ips: true,
                ..DeliveryEngineConfig::default()
            },
            resolver,
            store,
            Arc::new(OutboundSmtpPool::new(OutboundClientConfig::default())),
            Arc::clone(&state),
            metrics,
        );

        let timing = engine
            .process_job(DeliveryJob {
                message_id: "m-ssrf".to_string(),
                recipient_id: "r-ssrf".to_string(),
                organization_id: "org-1".to_string(),
                pool: DeliveryPoolKind::Transactional,
                envelope_from: "sender@example.com".to_string(),
                recipient_email: "victim@ssrf.test".to_string(),
                body_storage_key: obj.storage_key,
                bind_ip: None,
                attempt_no: 1,
                enqueued_at: Instant::now(),
            })
            .await;

        assert_eq!(timing.outcome_state, RecipientDeliveryState::Bounced);
        assert!(timing.persist_succeeded);
    }

    struct FailingStorage;
    impl MessageStore for FailingStorage {
        fn put_message(
            &self,
            _org_id: &str,
            _raw_mime: &[u8],
        ) -> impl Future<Output = Result<message_storage::StoredObject>> + Send {
            std::future::ready(Err(anyhow::anyhow!("storage write unavailable")))
        }

        fn get_message(
            &self,
            _storage_key: &str,
        ) -> impl Future<Output = Result<bytes::Bytes>> + Send {
            std::future::ready(Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "S3 timeout",
            )
            .into()))
        }

        fn delete_message(&self, _storage_key: &str) -> impl Future<Output = Result<()>> + Send {
            std::future::ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn defers_rather_than_bounces_on_transient_storage_error() {
        let resolver = Arc::new(StaticMxResolver::default());
        resolver.set_route(
            "ok.test",
            Ok(MxResolution::Targets(vec![MxTarget {
                exchange: "mx.ok.test".to_string(),
                preference: 10,
                addrs: vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))],
                port: 25,
            }])),
        );
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let engine = DeliveryEngine::new(
            DeliveryEngineConfig::default(),
            resolver,
            Arc::new(FailingStorage),
            Arc::new(OutboundSmtpPool::new(OutboundClientConfig::default())),
            Arc::new(InMemoryDeliveryStateStore::default()),
            metrics,
        );

        let timing = engine
            .process_job(DeliveryJob {
                message_id: "m-s3-down".to_string(),
                recipient_id: "r-s3-down".to_string(),
                organization_id: "org-1".to_string(),
                pool: DeliveryPoolKind::Transactional,
                envelope_from: "sender@example.com".to_string(),
                recipient_email: "user@ok.test".to_string(),
                body_storage_key: "missing-key".to_string(),
                bind_ip: None,
                attempt_no: 1,
                enqueued_at: Instant::now(),
            })
            .await;

        assert_eq!(timing.outcome_state, RecipientDeliveryState::Deferred);
        assert!(timing.persist_succeeded);
    }
}
