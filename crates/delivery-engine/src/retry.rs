//! Exponential backoff with full jitter and conservative ambiguous-failure scheduling.

use std::time::Duration;

use rand::Rng;

/// Retry policy governing deferred SMTP deliveries.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub ambiguous_min_delay: Duration,
    pub max_attempts: u16,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_delay: Duration::from_secs(30),
            max_delay: Duration::from_secs(4 * 3600),
            ambiguous_min_delay: Duration::from_secs(300),
            max_attempts: 12,
        }
    }
}

/// Computes the next retry delay using exponential backoff + full jitter.
/// When `ambiguous_after_data` is true, enforces at least `ambiguous_min_delay`
/// to reduce duplicate deliveries while remote server state is uncertain.
#[must_use]
pub fn compute_retry_delay(
    attempt_no: u16,
    ambiguous_after_data: bool,
    policy: &RetryPolicy,
) -> Duration {
    let shift = u32::from(attempt_no.saturating_sub(1)).min(16);
    let factor = 1_u32 << shift;
    let exp_delay = policy
        .base_delay
        .saturating_mul(factor)
        .min(policy.max_delay);

    let max_millis = u64::try_from(exp_delay.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let jittered_ms = rand::thread_rng().gen_range(0..=max_millis);
    let mut delay = Duration::from_millis(jittered_ms);

    if ambiguous_after_data && delay < policy.ambiguous_min_delay {
        delay = policy.ambiguous_min_delay;
    }
    delay
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_ambiguous_minimum_and_exponential_cap() {
        let policy = RetryPolicy {
            base_delay: Duration::from_secs(10),
            max_delay: Duration::from_secs(600),
            ambiguous_min_delay: Duration::from_secs(300),
            max_attempts: 10,
        };

        let d_normal = compute_retry_delay(1, false, &policy);
        assert!(d_normal <= Duration::from_secs(10));

        let d_ambig = compute_retry_delay(1, true, &policy);
        assert!(d_ambig >= Duration::from_secs(300));

        let d_capped = compute_retry_delay(20, false, &policy);
        assert!(d_capped <= Duration::from_secs(600));
    }
}
