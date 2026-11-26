//! Sending IP warmup ramp-up quotas and automated bounce/complaint abuse circuit breakers.

use std::collections::HashMap;
use std::sync::Mutex;

/// Returns the daily sending volume ceiling for a given IP warmup stage (`1..=6`).
#[must_use]
pub const fn warmup_daily_limit(stage: u8) -> Option<u64> {
    match stage {
        0 | 1 => Some(500),
        2 => Some(2_000),
        3 => Some(10_000),
        4 => Some(50_000),
        5 => Some(250_000),
        _ => None, // fully warmed; governed by plan & provider limits
    }
}

/// Threshold configuration for automated sending suspension.
#[derive(Debug, Clone, Copy)]
pub struct AbuseThresholds {
    pub min_sample_size: u64,
    pub warn_bounce_rate: f64,
    pub suspend_bounce_rate: f64,
    pub warn_complaint_rate: f64,
    pub suspend_complaint_rate: f64,
}

impl Default for AbuseThresholds {
    fn default() -> Self {
        Self {
            min_sample_size: 100,
            warn_bounce_rate: 0.03,
            suspend_bounce_rate: 0.05,
            warn_complaint_rate: 0.001,
            suspend_complaint_rate: 0.003,
        }
    }
}

/// Outcome of evaluating a domain's rolling bounce and complaint rates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReputationDecision {
    Allow,
    Warn { reason: String },
    SuspendSending { reason: String },
}

#[derive(Debug, Default, Clone, Copy)]
struct DomainCounters {
    sent: u64,
    hard_bounces: u64,
    complaints: u64,
}

/// Tracks rolling sender reputation metrics and triggers automatic abuse suspensions.
#[derive(Debug)]
pub struct ReputationMonitor {
    thresholds: AbuseThresholds,
    domains: Mutex<HashMap<String, DomainCounters>>,
}

impl ReputationMonitor {
    #[must_use]
    pub fn new(thresholds: AbuseThresholds) -> Self {
        Self {
            thresholds,
            domains: Mutex::new(HashMap::new()),
        }
    }

    /// Records sent messages for `domain_key` (e.g. `org_id:domain_id`).
    pub fn record_sent(&self, domain_key: &str, count: u64) {
        if let Ok(mut guard) = self.domains.lock() {
            guard.entry(domain_key.to_string()).or_default().sent += count;
        }
    }

    /// Records a hard bounce and returns the updated [`ReputationDecision`].
    #[must_use]
    pub fn record_hard_bounce(&self, domain_key: &str) -> ReputationDecision {
        if let Ok(mut guard) = self.domains.lock() {
            guard
                .entry(domain_key.to_string())
                .or_default()
                .hard_bounces += 1;
        }
        self.evaluate(domain_key)
    }

    /// Records an FBL complaint and returns the updated [`ReputationDecision`].
    #[must_use]
    pub fn record_complaint(&self, domain_key: &str) -> ReputationDecision {
        if let Ok(mut guard) = self.domains.lock() {
            guard.entry(domain_key.to_string()).or_default().complaints += 1;
        }
        self.evaluate(domain_key)
    }

    /// Evaluates current bounce and complaint rates against [`AbuseThresholds`].
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn evaluate(&self, domain_key: &str) -> ReputationDecision {
        let Ok(guard) = self.domains.lock() else {
            return ReputationDecision::Allow;
        };
        let Some(c) = guard.get(domain_key).copied() else {
            return ReputationDecision::Allow;
        };

        if c.sent < self.thresholds.min_sample_size {
            return ReputationDecision::Allow;
        }

        let sent_f = c.sent as f64;
        let bounce_rate = c.hard_bounces as f64 / sent_f;
        let complaint_rate = c.complaints as f64 / sent_f;

        if complaint_rate >= self.thresholds.suspend_complaint_rate {
            return ReputationDecision::SuspendSending {
                reason: format!(
                    "Complaint rate {:.3}% exceeded threshold {:.3}%",
                    complaint_rate * 100.0,
                    self.thresholds.suspend_complaint_rate * 100.0
                ),
            };
        }

        if bounce_rate >= self.thresholds.suspend_bounce_rate {
            return ReputationDecision::SuspendSending {
                reason: format!(
                    "Hard bounce rate {:.2}% exceeded threshold {:.2}%",
                    bounce_rate * 100.0,
                    self.thresholds.suspend_bounce_rate * 100.0
                ),
            };
        }

        if complaint_rate >= self.thresholds.warn_complaint_rate
            || bounce_rate >= self.thresholds.warn_bounce_rate
        {
            return ReputationDecision::Warn {
                reason: format!(
                    "Elevated bounce ({:.2}%) or complaint ({:.3}%) rate",
                    bounce_rate * 100.0,
                    complaint_rate * 100.0
                ),
            };
        }

        ReputationDecision::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_warmup_schedule_and_suspends_abusive_senders() {
        assert_eq!(warmup_daily_limit(1), Some(500));
        assert_eq!(warmup_daily_limit(3), Some(10_000));
        assert_eq!(warmup_daily_limit(6), None);

        let mon = ReputationMonitor::new(AbuseThresholds {
            min_sample_size: 100,
            warn_bounce_rate: 0.03,
            suspend_bounce_rate: 0.05,
            warn_complaint_rate: 0.001,
            suspend_complaint_rate: 0.003,
        });

        mon.record_sent("org1:dom1", 100);
        assert_eq!(mon.evaluate("org1:dom1"), ReputationDecision::Allow);

        // 3 hard bounces -> 3% -> Warn
        for _ in 0..3 {
            let _ = mon.record_hard_bounce("org1:dom1");
        }
        assert!(matches!(
            mon.evaluate("org1:dom1"),
            ReputationDecision::Warn { .. }
        ));

        // 2 more hard bounces -> 5% -> SuspendSending
        let _ = mon.record_hard_bounce("org1:dom1");
        let decision = mon.record_hard_bounce("org1:dom1");
        assert!(matches!(
            decision,
            ReputationDecision::SuspendSending { .. }
        ));
    }
}
