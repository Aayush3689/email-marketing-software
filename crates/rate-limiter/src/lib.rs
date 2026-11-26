//! Per-IP connection tracking, sliding-window command/message rate limits,
//! authentication brute-force lockout protection, warmup quotas, and abuse circuit breakers.

pub mod reputation;

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Rate limit configuration for an ingress listener.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    pub max_concurrent_per_ip: usize,
    pub max_messages_per_ip_window: usize,
    pub message_window: Duration,
    pub max_auth_failures_per_ip: usize,
    pub auth_lockout_duration: Duration,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_concurrent_per_ip: 20,
            max_messages_per_ip_window: 120,
            message_window: Duration::from_secs(60),
            max_auth_failures_per_ip: 5,
            auth_lockout_duration: Duration::from_secs(300),
        }
    }
}

#[derive(Debug, Default)]
struct LimiterState {
    active_by_ip: HashMap<IpAddr, usize>,
    msg_timestamps: HashMap<IpAddr, VecDeque<Instant>>,
    auth_failures: HashMap<IpAddr, VecDeque<Instant>>,
    locked_until: HashMap<IpAddr, Instant>,
}

/// RAII guard decrementing the per-IP active connection counter on drop.
#[derive(Debug)]
pub struct IpConnectionGuard {
    ip: IpAddr,
    state: Arc<Mutex<LimiterState>>,
}

impl Drop for IpConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.lock() {
            if let Some(count) = guard.active_by_ip.get_mut(&self.ip) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    guard.active_by_ip.remove(&self.ip);
                }
            }
        }
    }
}

/// Thread-safe in-memory rate limiter (with interface designed for Redis backing in Phase 4+).
#[derive(Debug, Clone)]
pub struct IngressRateLimiter {
    config: RateLimitConfig,
    state: Arc<Mutex<LimiterState>>,
}

impl IngressRateLimiter {
    #[must_use]
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(LimiterState::default())),
        }
    }

    /// Attempts to acquire a concurrent connection slot for `ip`.
    #[must_use]
    pub fn try_acquire_connection(&self, ip: IpAddr) -> Option<IpConnectionGuard> {
        let mut guard = self.state.lock().ok()?;
        let current = guard.active_by_ip.get(&ip).copied().unwrap_or(0);
        if current >= self.config.max_concurrent_per_ip {
            return None;
        }
        guard.active_by_ip.insert(ip, current + 1);
        Some(IpConnectionGuard {
            ip,
            state: Arc::clone(&self.state),
        })
    }

    /// Checks and records whether `ip` is permitted to initiate another message transaction.
    #[must_use]
    pub fn check_and_record_message(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let Ok(mut guard) = self.state.lock() else {
            return false;
        };
        let window_start = now.checked_sub(self.config.message_window).unwrap_or(now);
        if guard.msg_timestamps.len() > 50_000 && !guard.msg_timestamps.contains_key(&ip) {
            guard
                .msg_timestamps
                .retain(|_, q| q.back().is_some_and(|ts| *ts >= window_start));
            if guard.msg_timestamps.len() > 50_000 {
                guard.msg_timestamps.clear();
            }
        }
        let queue = guard.msg_timestamps.entry(ip).or_default();
        while queue.front().is_some_and(|&ts| ts < window_start) {
            queue.pop_front();
        }
        if queue.len() >= self.config.max_messages_per_ip_window {
            return false;
        }
        queue.push_back(now);
        true
    }

    /// Returns `true` if `ip` is currently locked out due to repeated failed authentications.
    #[must_use]
    pub fn is_auth_locked(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let Ok(mut guard) = self.state.lock() else {
            return true;
        };
        if let Some(&until) = guard.locked_until.get(&ip) {
            if now < until {
                return true;
            }
            guard.locked_until.remove(&ip);
        }
        false
    }

    /// Records a failed authentication attempt for `ip` and returns `true` if lockout was triggered.
    #[must_use]
    pub fn record_auth_failure(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let Ok(mut guard) = self.state.lock() else {
            return true;
        };
        let window_start = now
            .checked_sub(self.config.auth_lockout_duration)
            .unwrap_or(now);
        let max_failures = self.config.max_auth_failures_per_ip;
        let lockout_dur = self.config.auth_lockout_duration;

        let queue = guard.auth_failures.entry(ip).or_default();
        while queue.front().is_some_and(|&ts| ts < window_start) {
            queue.pop_front();
        }
        queue.push_back(now);

        if queue.len() >= max_failures {
            queue.clear();
            guard.locked_until.insert(ip, now + lockout_dur);
            return true;
        }
        false
    }

    /// Clears failed auth tracking upon successful login.
    pub fn record_auth_success(&self, ip: IpAddr) {
        if let Ok(mut guard) = self.state.lock() {
            guard.auth_failures.remove(&ip);
            guard.locked_until.remove(&ip);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    #[test]
    fn enforces_concurrent_ip_limits_and_releases_on_drop() {
        let limiter = IngressRateLimiter::new(RateLimitConfig {
            max_concurrent_per_ip: 2,
            ..RateLimitConfig::default()
        });
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

        let g1 = limiter.try_acquire_connection(ip);
        let g2 = limiter.try_acquire_connection(ip);
        assert!(g1.is_some());
        assert!(g2.is_some());
        assert!(limiter.try_acquire_connection(ip).is_none());

        drop(g1);
        assert!(limiter.try_acquire_connection(ip).is_some());
    }

    #[test]
    fn locks_out_ip_after_repeated_auth_failures() {
        let limiter = IngressRateLimiter::new(RateLimitConfig {
            max_auth_failures_per_ip: 3,
            auth_lockout_duration: Duration::from_secs(60),
            ..RateLimitConfig::default()
        });
        let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5));

        assert!(!limiter.is_auth_locked(ip));
        assert!(!limiter.record_auth_failure(ip));
        assert!(!limiter.record_auth_failure(ip));
        assert!(limiter.record_auth_failure(ip));
        assert!(limiter.is_auth_locked(ip));
    }

    #[test]
    fn enforces_message_sliding_window() {
        let limiter = IngressRateLimiter::new(RateLimitConfig {
            max_messages_per_ip_window: 2,
            message_window: Duration::from_secs(60),
            ..RateLimitConfig::default()
        });
        let ip = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10));
        assert!(limiter.check_and_record_message(ip));
        assert!(limiter.check_and_record_message(ip));
        assert!(!limiter.check_and_record_message(ip));
    }
}
