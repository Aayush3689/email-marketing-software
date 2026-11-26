//! Real end-to-end load tests and benchmarks for the outbound delivery engine.
//! Covers normal traffic, bursts, slow recipients + priority reservation,
//! DNS failures / Null MX, and provider `421` adaptive throttling.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use delivery_engine::{
    classify_provider, DeliveryEngine, DeliveryEngineConfig, DeliveryJob, DeliveryPoolKind,
    DomainLimitConfig, InMemoryDeliveryStateStore, RecipientDeliveryState, RetryPolicy,
};
use dns_resolver::{DnsLookupError, MxResolution, MxTarget, StaticMxResolver};
use message_storage::{InMemoryMessageStore, MessageStore};
use observability::MetricsRegistry;
use smtp_outbound::{OutboundClientConfig, OutboundSmtpPool};
use smtp_protocol::{SessionConfig, SmtpResponse};
use smtp_server::{serve_listener, SmtpServerConfig};
use smtp_session::{ReceivedMessage, SessionContext, SessionHandler};
use tokio::net::TcpListener;
use tokio::sync::watch;

struct BenchSink {
    delay: Duration,
    throttle_mode: bool,
    accepted: AtomicUsize,
}

impl SessionHandler for BenchSink {
    async fn on_message(
        &self,
        _ctx: &SessionContext,
        _message: ReceivedMessage,
    ) -> Result<SmtpResponse, SmtpResponse> {
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        if self.throttle_mode {
            return Err(SmtpResponse::service_unavailable(
                "4.7.0 Rate limit exceeded; try again later",
            ));
        }
        self.accepted.fetch_add(1, Ordering::Relaxed);
        Ok(SmtpResponse::ok("2.0.0 OK"))
    }
}

fn read_process_stats() -> (u64, String) {
    let pid = std::process::id().to_string();
    let Ok(output) = std::process::Command::new("ps")
        .args(["-o", "rss=,time=", "-p", &pid])
        .output()
    else {
        return (0, "unknown".to_string());
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.split_whitespace();
    let rss_kb = parts
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let cpu_time = parts.next().unwrap_or("0:00.00").to_string();
    (rss_kb, cpu_time)
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn percentile_ms(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx_f = ((sorted.len().saturating_sub(1)) as f64 * p).round();
    let idx = (idx_f as usize).min(sorted.len() - 1);
    sorted[idx]
}

#[allow(clippy::cast_precision_loss)]
fn print_report(
    scenario: &str,
    wall: Duration,
    timings: &[delivery_engine::DeliveryStageTiming],
    peak_concurrency: usize,
) {
    let mut e2e_ms: Vec<f64> = timings
        .iter()
        .map(|t| t.end_to_end.as_secs_f64() * 1000.0)
        .collect();
    let mut q_ms: Vec<f64> = timings
        .iter()
        .map(|t| t.queue_wait.as_secs_f64() * 1000.0)
        .collect();

    e2e_ms.sort_by(f64::total_cmp);
    q_ms.sort_by(f64::total_cmp);

    let accepted = timings
        .iter()
        .filter(|t| t.outcome_state == RecipientDeliveryState::AcceptedRemote)
        .count();
    let deferred = timings
        .iter()
        .filter(|t| t.outcome_state == RecipientDeliveryState::Deferred)
        .count();
    let bounced = timings
        .iter()
        .filter(|t| t.outcome_state == RecipientDeliveryState::Bounced)
        .count();
    let throughput = timings.len() as f64 / wall.as_secs_f64().max(0.0001);
    let (rss_kib, cpu_time) = read_process_stats();
    let mem_mib = rss_kib as f64 / 1024.0;

    println!(
        "\n=== BENCHMARK [{scenario}] ===\n\
         Total: {} (accepted={accepted}, deferred={deferred}, bounced={bounced}) in {:.2?}\n\
         Throughput: {throughput:.1} msgs/sec | Peak Concurrent Workers: {peak_concurrency} | RSS: {mem_mib:.2} MiB | CPU Time: {cpu_time}\n\
         E2E Latency (ms): p50={:.2}, p95={:.2}, p99={:.2}\n\
         Queue Wait  (ms): p50={:.2}, p95={:.2}, p99={:.2}\n",
        timings.len(),
        wall,
        percentile_ms(&e2e_ms, 0.50),
        percentile_ms(&e2e_ms, 0.95),
        percentile_ms(&e2e_ms, 0.99),
        percentile_ms(&q_ms, 0.50),
        percentile_ms(&q_ms, 0.95),
        percentile_ms(&q_ms, 0.99),
    );
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn benchmark_normal_and_burst_delivery_with_connection_reuse() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = watch::channel(false);
    let metrics = Arc::new(MetricsRegistry::new().unwrap());
    let sink = Arc::new(BenchSink {
        delay: Duration::ZERO,
        throttle_mode: false,
        accepted: AtomicUsize::new(0),
    });

    let srv = tokio::spawn(serve_listener(
        listener,
        SmtpServerConfig {
            bind_addr: addr,
            max_connections: 256,
            session_config: SessionConfig::default(),
            ..SmtpServerConfig::default()
        },
        Arc::clone(&sink),
        Arc::clone(&metrics),
        rx,
    ));

    let resolver = Arc::new(StaticMxResolver::default());
    resolver.set_route(
        "fast.example",
        Ok(MxResolution::Targets(vec![MxTarget {
            exchange: "mx.fast.example".to_string(),
            preference: 10,
            addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
            port: addr.port(),
        }])),
    );

    let store = Arc::new(InMemoryMessageStore::default());
    let obj = store
        .put_message("org-bench", b"Subject: Bench\r\n\r\nPayload\r\n")
        .await
        .unwrap();
    let state_store = Arc::new(InMemoryDeliveryStateStore::default());
    let smtp_pool = Arc::new(OutboundSmtpPool::new(OutboundClientConfig {
        max_idle_per_host: 32,
        ..OutboundClientConfig::default()
    }));

    let engine = Arc::new(DeliveryEngine::new(
        DeliveryEngineConfig {
            transactional_workers: 32,
            bulk_workers: 16,
            transactional_queue_capacity: 1024,
            bulk_queue_capacity: 1024,
            domain_limits: DomainLimitConfig {
                max_concurrent_per_domain: 32,
                initial_rate_per_sec: 10_000.0,
                max_rate_per_sec: 20_000.0,
                ..DomainLimitConfig::default()
            },
            block_private_mx_ips: false,
            ..DeliveryEngineConfig::default()
        },
        resolver,
        store,
        smtp_pool,
        state_store,
        Arc::clone(&metrics),
    ));

    let workers = tokio::spawn({
        let eng = Arc::clone(&engine);
        async move { eng.run_workers().await }
    });

    let total_msgs = 600;
    let start = Instant::now();
    for i in 0..total_msgs {
        engine
            .enqueue(DeliveryJob {
                message_id: format!("m-{i}"),
                recipient_id: format!("r-{i}"),
                organization_id: "org-bench".to_string(),
                pool: DeliveryPoolKind::Transactional,
                envelope_from: "noreply@platform.test".to_string(),
                recipient_email: format!("user{i}@fast.example"),
                body_storage_key: obj.storage_key.clone(),
                bind_ip: None,
                attempt_no: 1,
                enqueued_at: Instant::now(),
            })
            .await
            .unwrap();
    }

    engine.shutdown_intake();
    workers.await.unwrap().unwrap();
    let wall = start.elapsed();

    let timings = engine.snapshot_timings();
    assert_eq!(timings.len(), total_msgs);
    assert_eq!(sink.accepted.load(Ordering::Relaxed), total_msgs);
    print_report(
        "Burst 600 Transactional (32 workers)",
        wall,
        &timings,
        engine.peak_concurrency(),
    );

    let prom = metrics.render_prometheus().unwrap();
    assert!(prom.contains("mta_pool_connections_reused_total{mode=\"reused\"}"));

    let _ = tx.send(true);
    srv.await.unwrap().unwrap();
}

async fn spawn_bench_sink(
    delay: Duration,
    throttle_mode: bool,
    metrics: Arc<MetricsRegistry>,
    rx: watch::Receiver<bool>,
) -> (
    std::net::SocketAddr,
    tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(serve_listener(
        listener,
        SmtpServerConfig {
            bind_addr: addr,
            ..SmtpServerConfig::default()
        },
        Arc::new(BenchSink {
            delay,
            throttle_mode,
            accepted: AtomicUsize::new(0),
        }),
        metrics,
        rx,
    ));
    (addr, handle)
}

fn build_mixed_resolver(slow_port: u16, throttle_port: u16) -> Arc<StaticMxResolver> {
    let resolver = Arc::new(StaticMxResolver::default());
    resolver.set_route(
        "slow.example",
        Ok(MxResolution::Targets(vec![MxTarget {
            exchange: "mx.slow.example".to_string(),
            preference: 10,
            addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
            port: slow_port,
        }])),
    );
    resolver.set_route(
        "gmail.com",
        Ok(MxResolution::Targets(vec![MxTarget {
            exchange: "gmail-smtp-in.l.google.com".to_string(),
            preference: 5,
            addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
            port: throttle_port,
        }])),
    );
    resolver.set_route("nullmx.example", Ok(MxResolution::NullMx));
    resolver.set_route(
        "tempdns.example",
        Err(DnsLookupError::Temporary("SERVFAIL".to_string())),
    );
    resolver
}

#[tokio::test]
async fn benchmark_slow_recipients_dns_failures_and_421_throttling() {
    let (tx, rx) = watch::channel(false);
    let metrics = Arc::new(MetricsRegistry::new().unwrap());

    let (slow_addr, s_slow) = spawn_bench_sink(
        Duration::from_millis(20),
        false,
        Arc::clone(&metrics),
        rx.clone(),
    )
    .await;
    let (throttle_addr, s_throttle) =
        spawn_bench_sink(Duration::ZERO, true, Arc::clone(&metrics), rx).await;

    let resolver = build_mixed_resolver(slow_addr.port(), throttle_addr.port());

    let store = Arc::new(InMemoryMessageStore::default());
    let obj = store
        .put_message("org-mixed", b"Subject: Mixed\r\n\r\nHi\r\n")
        .await
        .unwrap();
    let state_store = Arc::new(InMemoryDeliveryStateStore::default());
    let smtp_pool = Arc::new(OutboundSmtpPool::new(OutboundClientConfig::default()));

    let engine = Arc::new(DeliveryEngine::new(
        DeliveryEngineConfig {
            transactional_workers: 8,
            bulk_workers: 8,
            retry_policy: RetryPolicy::default(),
            domain_limits: DomainLimitConfig {
                max_concurrent_per_domain: 8,
                initial_rate_per_sec: 100.0,
                throttle_cooldown: Duration::from_secs(5),
                ..DomainLimitConfig::default()
            },
            block_private_mx_ips: false,
            ..DeliveryEngineConfig::default()
        },
        resolver,
        store,
        smtp_pool,
        Arc::clone(&state_store),
        Arc::clone(&metrics),
    ));

    let workers = tokio::spawn({
        let eng = Arc::clone(&engine);
        async move { eng.run_workers().await }
    });

    let start = Instant::now();
    let targets = [
        ("slow.example", DeliveryPoolKind::Bulk, 30),
        ("gmail.com", DeliveryPoolKind::Transactional, 10),
        ("nullmx.example", DeliveryPoolKind::Transactional, 5),
        ("tempdns.example", DeliveryPoolKind::Transactional, 5),
        ("nxdomain.example", DeliveryPoolKind::Transactional, 5),
    ];

    let mut total = 0;
    for (domain, pool, count) in targets {
        for i in 0..count {
            total += 1;
            engine
                .enqueue(DeliveryJob {
                    message_id: format!("mix-{domain}-{i}"),
                    recipient_id: format!("r-{domain}-{i}"),
                    organization_id: "org-mixed".to_string(),
                    pool,
                    envelope_from: "sender@platform.test".to_string(),
                    recipient_email: format!("u{i}@{domain}"),
                    body_storage_key: obj.storage_key.clone(),
                    bind_ip: None,
                    attempt_no: 1,
                    enqueued_at: Instant::now(),
                })
                .await
                .unwrap();
        }
    }

    engine.shutdown_intake();
    workers.await.unwrap().unwrap();
    let wall = start.elapsed();

    let timings = engine.snapshot_timings();
    assert_eq!(timings.len(), total);
    print_report(
        "Mixed Faults (Slow + 421 Throttle + DNS Fail + NullMX)",
        wall,
        &timings,
        engine.peak_concurrency(),
    );

    assert_eq!(classify_provider("gmail.com"), "google");
    let prom = metrics.render_prometheus().unwrap();
    assert!(prom.contains("mta_adaptive_throttles_total{provider=\"google\"}"));

    let _ = tx.send(true);
    s_slow.await.unwrap().unwrap();
    s_throttle.await.unwrap().unwrap();
}
