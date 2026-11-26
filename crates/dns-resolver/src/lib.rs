//! Async DNS MX/A/AAAA resolver with TTL-aware caching, RFC 7505 Null MX handling,
//! RFC 5321 implicit MX fallback, and domain deliverability diagnostics.

pub mod diagnostics;

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::error::ResolveErrorKind;
use hickory_resolver::TokioAsyncResolver;
use rand::seq::SliceRandom;
use thiserror::Error;

/// Resolved MX target host and its IPv4/IPv6 addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MxTarget {
    pub exchange: String,
    pub preference: u16,
    pub addrs: Vec<IpAddr>,
    pub port: u16,
}

/// Result of resolving a recipient domain for SMTP delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MxResolution {
    /// Ordered list of MX targets (lowest preference first, ties randomized).
    Targets(Vec<MxTarget>),
    /// RFC 7505 `MX 0 .`: domain explicitly advertises it accepts no email.
    NullMx,
}

/// DNS lookup failure classification.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DnsLookupError {
    #[error("domain does not exist (NXDOMAIN): {0}")]
    NxDomain(String),
    #[error("temporary DNS resolution failure: {0}")]
    Temporary(String),
}

/// Async DNS MX resolver abstraction (allowing deterministic mock/fault-injection in tests).
pub trait MxResolver: Send + Sync {
    fn resolve_mx(
        &self,
        domain: &str,
    ) -> impl Future<Output = Result<MxResolution, DnsLookupError>> + Send;
}

#[derive(Debug, Clone)]
struct CacheEntry {
    result: Result<MxResolution, DnsLookupError>,
    expires_at: Instant,
}

/// Configuration for [`HickoryDnsResolver`].
#[derive(Debug, Clone, Copy)]
pub struct DnsCacheConfig {
    pub min_ttl: Duration,
    pub max_ttl: Duration,
    pub negative_ttl: Duration,
    pub query_timeout: Duration,
}

impl Default for DnsCacheConfig {
    fn default() -> Self {
        Self {
            min_ttl: Duration::from_secs(30),
            max_ttl: Duration::from_secs(3600),
            negative_ttl: Duration::from_secs(60),
            query_timeout: Duration::from_secs(5),
        }
    }
}

/// Production DNS resolver backed by `hickory-resolver` with an explicit TTL cache.
pub struct HickoryDnsResolver {
    inner: TokioAsyncResolver,
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    cfg: DnsCacheConfig,
}

impl HickoryDnsResolver {
    /// Creates a resolver using system DNS config (or Cloudflare/Quad9 fallback if unavailable).
    #[must_use]
    pub fn from_system_or_default(cfg: DnsCacheConfig) -> Self {
        let mut opts = ResolverOpts::default();
        opts.timeout = cfg.query_timeout;
        opts.attempts = 2;
        opts.cache_size = 4096;

        let inner = TokioAsyncResolver::tokio_from_system_conf()
            .unwrap_or_else(|_| TokioAsyncResolver::tokio(ResolverConfig::cloudflare(), opts));

        Self {
            inner,
            cache: Arc::new(RwLock::new(HashMap::new())),
            cfg,
        }
    }

    async fn lookup_ips(&self, host: &str) -> Vec<IpAddr> {
        let mut ips = Vec::new();
        if let Ok(v4) = self.inner.ipv4_lookup(host).await {
            ips.extend(v4.iter().map(|ip| IpAddr::V4(ip.0)));
        }
        if let Ok(v6) = self.inner.ipv6_lookup(host).await {
            ips.extend(v6.iter().map(|ip| IpAddr::V6(ip.0)));
        }
        ips
    }
}

impl MxResolver for HickoryDnsResolver {
    async fn resolve_mx(&self, domain: &str) -> Result<MxResolution, DnsLookupError> {
        let key = domain.trim_end_matches('.').to_ascii_lowercase();
        let now = Instant::now();

        if let Ok(guard) = self.cache.read() {
            if let Some(entry) = guard.get(&key) {
                if entry.expires_at > now {
                    return entry.result.clone();
                }
            }
        }

        let (result, ttl) = match self.inner.mx_lookup(key.as_str()).await {
            Ok(mx_lookup) => {
                let mut records: Vec<_> = mx_lookup.iter().collect();
                // RFC 7505 Null MX: single record with preference 0 and exchange "."
                if records.len() == 1
                    && records[0].preference() == 0
                    && records[0].exchange().is_root()
                {
                    (Ok(MxResolution::NullMx), self.cfg.max_ttl)
                } else {
                    records.sort_by_key(|r| r.preference());
                    // Shuffle equal-preference MXs for load distribution
                    shuffle_equal_preference(&mut records);

                    let mut targets = Vec::with_capacity(records.len());
                    for rec in records {
                        let ex = rec.exchange().to_utf8();
                        let ex_trimmed = ex.trim_end_matches('.').to_string();
                        let addrs = self.lookup_ips(&ex_trimmed).await;
                        if !addrs.is_empty() {
                            targets.push(MxTarget {
                                exchange: ex_trimmed,
                                preference: rec.preference(),
                                addrs,
                                port: 25,
                            });
                        }
                    }

                    if targets.is_empty() {
                        (
                            Err(DnsLookupError::Temporary(format!(
                                "no A/AAAA addresses resolved for MX hosts of {key}"
                            ))),
                            self.cfg.negative_ttl,
                        )
                    } else {
                        let raw_ttl = mx_lookup
                            .as_lookup()
                            .valid_until()
                            .saturating_duration_since(Instant::now());
                        let clamped_ttl = raw_ttl.clamp(self.cfg.min_ttl, self.cfg.max_ttl);
                        (Ok(MxResolution::Targets(targets)), clamped_ttl)
                    }
                }
            }
            Err(err) => match err.kind() {
                ResolveErrorKind::NoRecordsFound { response_code, .. } => {
                    if *response_code == hickory_resolver::proto::op::ResponseCode::NXDomain {
                        (
                            Err(DnsLookupError::NxDomain(key.clone())),
                            self.cfg.negative_ttl,
                        )
                    } else {
                        // RFC 5321 Section 5.1: implicit MX fallback to domain A/AAAA
                        let addrs = self.lookup_ips(&key).await;
                        if addrs.is_empty() {
                            (
                                Err(DnsLookupError::Temporary(format!(
                                    "no MX or A/AAAA records for {key}"
                                ))),
                                self.cfg.negative_ttl,
                            )
                        } else {
                            (
                                Ok(MxResolution::Targets(vec![MxTarget {
                                    exchange: key.clone(),
                                    preference: 0,
                                    addrs,
                                    port: 25,
                                }])),
                                self.cfg.min_ttl,
                            )
                        }
                    }
                }
                _ => (
                    Err(DnsLookupError::Temporary(err.to_string())),
                    self.cfg.negative_ttl,
                ),
            },
        };

        self.insert_cached(key, result.clone(), ttl);
        result
    }
}

impl HickoryDnsResolver {
    fn insert_cached(
        &self,
        key: String,
        result: Result<MxResolution, DnsLookupError>,
        ttl: Duration,
    ) {
        if let Ok(mut guard) = self.cache.write() {
            let now = Instant::now();
            if guard.len() >= 100_000 {
                guard.retain(|_, entry| entry.expires_at > now);
                if guard.len() >= 100_000 {
                    guard.clear();
                }
            }
            guard.insert(
                key,
                CacheEntry {
                    result,
                    expires_at: now + ttl,
                },
            );
        }
    }
}

fn shuffle_equal_preference(records: &mut [&hickory_resolver::proto::rr::rdata::MX]) {
    let mut rng = rand::thread_rng();
    let mut start = 0;
    while start < records.len() {
        let pref = records[start].preference();
        let mut end = start + 1;
        while end < records.len() && records[end].preference() == pref {
            end += 1;
        }
        if end - start > 1 {
            records[start..end].shuffle(&mut rng);
        }
        start = end;
    }
}

/// Deterministic in-memory MX resolver for tests, fault injection, and local benchmarks.
#[derive(Debug, Default)]
pub struct StaticMxResolver {
    routes: RwLock<HashMap<String, Result<MxResolution, DnsLookupError>>>,
}

impl StaticMxResolver {
    pub fn set_route(&self, domain: &str, res: Result<MxResolution, DnsLookupError>) {
        if let Ok(mut guard) = self.routes.write() {
            guard.insert(domain.to_ascii_lowercase(), res);
        }
    }
}

impl MxResolver for StaticMxResolver {
    fn resolve_mx(
        &self,
        domain: &str,
    ) -> impl Future<Output = Result<MxResolution, DnsLookupError>> + Send {
        let key = domain.to_ascii_lowercase();
        let res = self
            .routes
            .read()
            .ok()
            .and_then(|g| g.get(&key).cloned())
            .unwrap_or(Err(DnsLookupError::NxDomain(key)));
        std::future::ready(res)
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    #[tokio::test]
    async fn static_resolver_returns_targets_null_mx_and_nxdomain() {
        let resolver = StaticMxResolver::default();
        resolver.set_route(
            "example.com",
            Ok(MxResolution::Targets(vec![MxTarget {
                exchange: "mx1.example.com".to_string(),
                preference: 10,
                addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
                port: 2525,
            }])),
        );
        resolver.set_route("nullmx.example", Ok(MxResolution::NullMx));

        let ok = resolver.resolve_mx("EXAMPLE.COM").await.unwrap();
        assert!(matches!(ok, MxResolution::Targets(_)));

        let null_mx = resolver.resolve_mx("nullmx.example").await.unwrap();
        assert_eq!(null_mx, MxResolution::NullMx);

        let missing = resolver.resolve_mx("missing.example").await;
        assert!(matches!(missing, Err(DnsLookupError::NxDomain(_))));
    }
}
