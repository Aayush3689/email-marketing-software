//! Structured JSON logging, W3C distributed trace context, and Prometheus metrics for the Rust MTA,
//! including per-stage delivery latency histograms and adaptive throttling telemetry.

pub mod trace_context;

use anyhow::Result;
use prometheus::{
    Encoder, HistogramOpts, HistogramVec, IntCounterVec, IntGauge, IntGaugeVec, Opts, Registry,
    TextEncoder,
};
pub use trace_context::TraceContext;
use tracing_subscriber::{fmt, EnvFilter};

/// Initializes structured JSON tracing controlled by `RUST_LOG` (defaulting to `info`).
pub fn init_tracing(service_name: &str) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(true)
        .with_span_list(false)
        .try_init();

    tracing::info!(service = service_name, "Tracing initialized");
}

/// Core Prometheus metrics registry shared across MTA subsystems.
pub struct MetricsRegistry {
    registry: Registry,
    pub smtp_active_connections: IntGauge,
    pub outbound_active_workers: IntGaugeVec,
    pub node_boots_total: IntCounterVec,
    pub delivery_attempts_total: IntCounterVec,
    pub pool_connections_reused_total: IntCounterVec,
    pub adaptive_throttles_total: IntCounterVec,
    pub stage_latency_seconds: HistogramVec,
    pub dkim_signing_attempts_total: IntCounterVec,
    pub dkim_signing_successes_total: IntCounterVec,
    pub dkim_signing_failures_total: IntCounterVec,
    pub dkim_key_reload_total: IntCounterVec,
}

impl MetricsRegistry {
    /// Creates and registers all baseline and delivery-stage MTA metrics.
    ///
    /// # Errors
    /// Returns an error if metric registration with the Prometheus registry fails.
    pub fn new() -> Result<Self> {
        let registry = Registry::new();

        let smtp_active_connections = IntGauge::new(
            "mta_smtp_active_connections",
            "Current active inbound SMTP connections",
        )?;
        let outbound_active_workers = IntGaugeVec::new(
            Opts::new(
                "mta_outbound_active_workers",
                "Current active outbound delivery workers per pool",
            ),
            &["pool"],
        )?;
        let node_boots_total = IntCounterVec::new(
            Opts::new("mta_node_boots_total", "Total mail-engine node starts"),
            &["node_id"],
        )?;
        let delivery_attempts_total = IntCounterVec::new(
            Opts::new(
                "mta_delivery_attempts_total",
                "Total outbound SMTP delivery attempts by pool and outcome",
            ),
            &["pool", "outcome"],
        )?;
        let pool_connections_reused_total = IntCounterVec::new(
            Opts::new(
                "mta_pool_connections_reused_total",
                "Outbound SMTP connection reuse vs new connection count",
            ),
            &["mode"],
        )?;
        let adaptive_throttles_total = IntCounterVec::new(
            Opts::new(
                "mta_adaptive_throttles_total",
                "Count of adaptive rate reductions triggered by provider responses",
            ),
            &["provider"],
        )?;
        let stage_latency_seconds = HistogramVec::new(
            HistogramOpts::new(
                "mta_delivery_stage_duration_seconds",
                "Latency distribution across each delivery pipeline stage",
            )
            .buckets(vec![
                0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 15.0,
            ]),
            &["stage", "pool"],
        )?;
        let dkim_signing_attempts_total = IntCounterVec::new(
            Opts::new(
                "mta_dkim_signing_attempts_total",
                "Total outbound DKIM signing attempts by algorithm and domain policy",
            ),
            &["algorithm", "policy"],
        )?;
        let dkim_signing_successes_total = IntCounterVec::new(
            Opts::new(
                "mta_dkim_signing_successes_total",
                "Total successful outbound DKIM signatures",
            ),
            &["algorithm"],
        )?;
        let dkim_signing_failures_total = IntCounterVec::new(
            Opts::new(
                "mta_dkim_signing_failures_total",
                "Total outbound DKIM signing failures by reason (never includes secret values)",
            ),
            &["reason"],
        )?;
        let dkim_key_reload_total = IntCounterVec::new(
            Opts::new(
                "mta_dkim_key_reload_total",
                "Total DKIM key ring reload attempts from PostgreSQL",
            ),
            &["outcome"],
        )?;

        registry.register(Box::new(smtp_active_connections.clone()))?;
        registry.register(Box::new(outbound_active_workers.clone()))?;
        registry.register(Box::new(node_boots_total.clone()))?;
        registry.register(Box::new(delivery_attempts_total.clone()))?;
        registry.register(Box::new(pool_connections_reused_total.clone()))?;
        registry.register(Box::new(adaptive_throttles_total.clone()))?;
        registry.register(Box::new(stage_latency_seconds.clone()))?;
        registry.register(Box::new(dkim_signing_attempts_total.clone()))?;
        registry.register(Box::new(dkim_signing_successes_total.clone()))?;
        registry.register(Box::new(dkim_signing_failures_total.clone()))?;
        registry.register(Box::new(dkim_key_reload_total.clone()))?;

        Ok(Self {
            registry,
            smtp_active_connections,
            outbound_active_workers,
            node_boots_total,
            delivery_attempts_total,
            pool_connections_reused_total,
            adaptive_throttles_total,
            stage_latency_seconds,
            dkim_signing_attempts_total,
            dkim_signing_successes_total,
            dkim_signing_failures_total,
            dkim_key_reload_total,
        })
    }

    pub fn record_node_boot(&self, node_id: &str) {
        self.node_boots_total.with_label_values(&[node_id]).inc();
    }

    pub fn observe_stage_latency(&self, stage: &str, pool: &str, seconds: f64) {
        self.stage_latency_seconds
            .with_label_values(&[stage, pool])
            .observe(seconds);
    }

    pub fn record_delivery_attempt(&self, pool: &str, outcome: &str) {
        self.delivery_attempts_total
            .with_label_values(&[pool, outcome])
            .inc();
    }

    pub fn record_connection_reuse(&self, reused: bool) {
        let mode = if reused { "reused" } else { "fresh" };
        self.pool_connections_reused_total
            .with_label_values(&[mode])
            .inc();
    }

    pub fn record_adaptive_throttle(&self, provider: &str) {
        self.adaptive_throttles_total
            .with_label_values(&[provider])
            .inc();
    }

    pub fn record_dkim_attempt(&self, algorithm: &str, policy: &str) {
        self.dkim_signing_attempts_total
            .with_label_values(&[algorithm, policy])
            .inc();
    }

    pub fn record_dkim_success(&self, algorithm: &str) {
        self.dkim_signing_successes_total
            .with_label_values(&[algorithm])
            .inc();
    }

    pub fn record_dkim_failure(&self, reason: &str) {
        self.dkim_signing_failures_total
            .with_label_values(&[reason])
            .inc();
    }

    pub fn record_dkim_reload(&self, outcome: &str) {
        self.dkim_key_reload_total
            .with_label_values(&[outcome])
            .inc();
    }

    /// Renders metrics in Prometheus text exposition format.
    ///
    /// # Errors
    /// Returns an error if encoding metric families fails.
    pub fn render_prometheus(&self) -> Result<String> {
        let encoder = TextEncoder::new();
        let metric_families = self.registry.gather();
        let mut buf = Vec::new();
        encoder.encode(&metric_families, &mut buf)?;
        Ok(String::from_utf8(buf)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_prometheus_metrics() {
        let reg = MetricsRegistry::new().expect("registry init");
        reg.record_node_boot("mta-test-1");
        reg.observe_stage_latency("dns_lookup", "transactional", 0.004);
        reg.record_delivery_attempt("transactional", "accepted");
        let output = reg.render_prometheus().expect("encode");
        assert!(output.contains("mta_node_boots_total{node_id=\"mta-test-1\"} 1"));
        assert!(output.contains("mta_delivery_stage_duration_seconds_bucket"));
        assert!(output.contains("mta_delivery_attempts_total"));
    }
}
