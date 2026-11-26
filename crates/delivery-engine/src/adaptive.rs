//! Per-domain and per-provider AIMD adaptive throttling and concurrency limits.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Groups major mailbox providers for shared ISP-level throttling.
#[must_use]
pub fn classify_provider(domain: &str) -> &'static str {
    match domain.to_ascii_lowercase().as_str() {
        "gmail.com" | "googlemail.com" => "google",
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => "microsoft",
        "yahoo.com" | "ymail.com" | "aol.com" => "yahoo",
        "icloud.com" | "me.com" | "mac.com" => "apple",
        _ => "default",
    }
}

/// Configuration for per-domain concurrency and AIMD adaptive rate limits.
#[derive(Debug, Clone, Copy)]
pub struct DomainLimitConfig {
    pub max_concurrent_per_domain: usize,
    pub initial_rate_per_sec: f64,
    pub min_rate_per_sec: f64,
    pub max_rate_per_sec: f64,
    pub throttle_cooldown: Duration,
}

impl Default for DomainLimitConfig {
    fn default() -> Self {
        Self {
            max_concurrent_per_domain: 32,
            initial_rate_per_sec: 100.0,
            min_rate_per_sec: 1.0,
            max_rate_per_sec: 500.0,
            throttle_cooldown: Duration::from_secs(5),
        }
    }
}

#[derive(Debug)]
struct DomainState {
    active_conns: usize,
    tokens: f64,
    current_rate: f64,
    last_refill: Instant,
    cooldown_until: Option<Instant>,
    consecutive_ok: u32,
}

#[derive(Debug, Default)]
struct LimiterMap {
    domains: HashMap<String, DomainState>,
}

/// RAII concurrency guard for a recipient domain.
pub struct DomainPermit {
    key: String,
    state: Arc<Mutex<LimiterMap>>,
}

impl Drop for DomainPermit {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.lock() {
            if let Some(st) = guard.domains.get_mut(&self.key) {
                st.active_conns = st.active_conns.saturating_sub(1);
            }
        }
    }
}

/// Thread-safe AIMD limiter keyed by `(provider, domain)`.
#[derive(Debug)]
pub struct AdaptiveDomainLimiter {
    cfg: DomainLimitConfig,
    state: Arc<Mutex<LimiterMap>>,
}

impl AdaptiveDomainLimiter {
    #[must_use]
    pub fn new(cfg: DomainLimitConfig) -> Self {
        Self {
            cfg,
            state: Arc::new(Mutex::new(LimiterMap::default())),
        }
    }

    /// Attempts to acquire both a per-domain concurrency slot and a token-bucket permit.
    #[must_use]
    pub fn try_acquire(&self, provider: &str, domain: &str) -> Option<DomainPermit> {
        let key = format!("{provider}:{domain}");
        let now = Instant::now();
        let mut guard = self.state.lock().ok()?;
        if guard.domains.len() >= 100_000 && !guard.domains.contains_key(&key) {
            guard.domains.retain(|_, st| st.active_conns > 0);
            if guard.domains.len() >= 100_000 {
                if let Some(evict_key) = guard.domains.keys().next().cloned() {
                    guard.domains.remove(&evict_key);
                }
            }
        }
        let st = guard
            .domains
            .entry(key.clone())
            .or_insert_with(|| DomainState {
                active_conns: 0,
                tokens: self.cfg.initial_rate_per_sec,
                current_rate: self.cfg.initial_rate_per_sec,
                last_refill: now,
                cooldown_until: None,
                consecutive_ok: 0,
            });

        if st.cooldown_until.is_some_and(|until| now < until) {
            return None;
        }
        if st.active_conns >= self.cfg.max_concurrent_per_domain {
            return None;
        }

        let elapsed = now.duration_since(st.last_refill).as_secs_f64();
        st.tokens = (st.tokens + elapsed * st.current_rate).min(st.current_rate);
        st.last_refill = now;

        if st.tokens < 1.0 {
            return None;
        }
        st.tokens -= 1.0;
        st.active_conns += 1;

        Some(DomainPermit {
            key,
            state: Arc::clone(&self.state),
        })
    }

    /// Multiplicatively reduces rate and enters cooldown after a `421`/`429` throttle signal.
    pub fn record_throttle(&self, provider: &str, domain: &str) {
        let key = format!("{provider}:{domain}");
        let now = Instant::now();
        if let Ok(mut guard) = self.state.lock() {
            if let Some(st) = guard.domains.get_mut(&key) {
                st.current_rate = (st.current_rate * 0.5).max(self.cfg.min_rate_per_sec);
                st.tokens = 0.0;
                st.consecutive_ok = 0;
                st.cooldown_until = Some(now + self.cfg.throttle_cooldown);
            }
        }
    }

    /// Additively recovers rate after sustained successful deliveries.
    pub fn record_success(&self, provider: &str, domain: &str) {
        let key = format!("{provider}:{domain}");
        if let Ok(mut guard) = self.state.lock() {
            if let Some(st) = guard.domains.get_mut(&key) {
                st.consecutive_ok += 1;
                if st.consecutive_ok >= 10 {
                    st.consecutive_ok = 0;
                    st.current_rate = (st.current_rate + 10.0).min(self.cfg.max_rate_per_sec);
                }
            }
        }
    }

    /// Returns the current adaptive rate limit (msgs/sec) for testing/observability.
    #[must_use]
    pub fn current_rate(&self, provider: &str, domain: &str) -> Option<f64> {
        let key = format!("{provider}:{domain}");
        self.state
            .lock()
            .ok()
            .and_then(|g| g.domains.get(&key).map(|s| s.current_rate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aimd_cuts_rate_on_throttle_and_recovers_on_success() {
        let limiter = AdaptiveDomainLimiter::new(DomainLimitConfig {
            initial_rate_per_sec: 100.0,
            min_rate_per_sec: 5.0,
            max_rate_per_sec: 200.0,
            throttle_cooldown: Duration::from_secs(10),
            ..DomainLimitConfig::default()
        });

        let permit = limiter.try_acquire("google", "gmail.com");
        assert!(permit.is_some());
        drop(permit);

        limiter.record_throttle("google", "gmail.com");
        assert_eq!(limiter.current_rate("google", "gmail.com"), Some(50.0));
        // Cooldown blocks immediate acquisition
        assert!(limiter.try_acquire("google", "gmail.com").is_none());

        for _ in 0..10 {
            limiter.record_success("google", "gmail.com");
        }
        assert_eq!(limiter.current_rate("google", "gmail.com"), Some(60.0));
    }
}
