//! Wraps `SpoolStorage` to transparently DKIM-sign outbound RFC 5322 payloads before transmission,
//! enforcing fail-closed `required` vs explicit `optional` signing policies and structured metrics.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use bytes::Bytes;
use dkim::{
    sign_rfc5322_message_with_ring, DkimAlgorithm, DkimKeyRing, DkimKeyStatus, DkimSigningPolicy,
    KeyEncryptionKeyRing, StoredDkimKey,
};
use mail_parser::MessageParser;
use message_storage::{MessageStore, StoredObject};
use observability::MetricsRegistry;
use sqlx::{PgPool, Row};
use tracing::{debug, error, info, warn};

const POLICY_CACHE_TTL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy)]
struct CachedPolicy {
    policy: DkimSigningPolicy,
    is_suspended: bool,
    refreshed_at: Instant,
}

/// Decorator over [`MessageStore`] that signs outbound messages on read using the active DKIM key
/// for the `From:` domain, syncing from PostgreSQL on cache miss / TTL expiry and refusing unsigned
/// delivery when `dkim_policy = 'required'`.
#[derive(Clone)]
pub struct DkimSigningStore<S> {
    inner: Arc<S>,
    keyring: Arc<DkimKeyRing>,
    kek_ring: Arc<KeyEncryptionKeyRing>,
    pg_pool: Option<PgPool>,
    metrics: Arc<MetricsRegistry>,
    default_policy: DkimSigningPolicy,
    policies_by_domain: Arc<RwLock<HashMap<String, CachedPolicy>>>,
}

impl<S> DkimSigningStore<S> {
    #[must_use]
    pub fn new(
        inner: Arc<S>,
        keyring: Arc<DkimKeyRing>,
        kek_ring: Arc<KeyEncryptionKeyRing>,
        pg_pool: Option<PgPool>,
        metrics: Arc<MetricsRegistry>,
    ) -> Self {
        Self::with_default_policy(
            inner,
            keyring,
            kek_ring,
            pg_pool,
            metrics,
            DkimSigningPolicy::Required,
        )
    }

    #[must_use]
    pub fn with_default_policy(
        inner: Arc<S>,
        keyring: Arc<DkimKeyRing>,
        kek_ring: Arc<KeyEncryptionKeyRing>,
        pg_pool: Option<PgPool>,
        metrics: Arc<MetricsRegistry>,
        default_policy: DkimSigningPolicy,
    ) -> Self {
        Self {
            inner,
            keyring,
            kek_ring,
            pg_pool,
            metrics,
            default_policy,
            policies_by_domain: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Explicitly sets a cached domain signing policy in unit tests.
    #[cfg(test)]
    pub fn set_domain_policy(&self, domain: &str, policy: DkimSigningPolicy) {
        if let Ok(mut guard) = self.policies_by_domain.write() {
            guard.insert(
                domain.to_ascii_lowercase(),
                CachedPolicy {
                    policy,
                    is_suspended: false,
                    refreshed_at: Instant::now(),
                },
            );
        }
    }

    /// Clears policy cache entries (called alongside `/control/dkim/reload`).
    pub fn invalidate_policy_cache(&self) {
        if let Ok(mut guard) = self.policies_by_domain.write() {
            guard.clear();
        }
    }
}

impl<S: MessageStore + 'static> MessageStore for DkimSigningStore<S> {
    fn put_message(
        &self,
        organization_id: &str,
        payload: &[u8],
    ) -> impl Future<Output = Result<StoredObject>> + Send {
        let inner = Arc::clone(&self.inner);
        let bytes = payload.to_vec();
        let org = organization_id.to_string();
        async move { inner.put_message(&org, &bytes).await }
    }

    fn get_message(&self, storage_key: &str) -> impl Future<Output = Result<Bytes>> + Send {
        let inner = Arc::clone(&self.inner);
        let keyring = Arc::clone(&self.keyring);
        let kek_ring = Arc::clone(&self.kek_ring);
        let pg_pool = self.pg_pool.clone();
        let metrics = Arc::clone(&self.metrics);
        let default_policy = self.default_policy;
        let policies_by_domain = Arc::clone(&self.policies_by_domain);
        let key = storage_key.to_string();

        async move {
            let raw = inner.get_message(&key).await?;
            let Some(domain) = extract_from_domain(&raw) else {
                if default_policy == DkimSigningPolicy::Required {
                    metrics.record_dkim_failure("missing_from_domain");
                    error!(
                        storage_key = %key,
                        "Blocked outbound delivery: missing valid From domain for required DKIM policy"
                    );
                    anyhow::bail!(
                        "DKIM_SIGNING_FAILED (missing_from_domain): message has no From domain"
                    );
                }
                return Ok(raw);
            };

            let (effective_policy, active) = match resolve_domain_policy_and_key(
                &domain,
                &keyring,
                pg_pool.as_ref(),
                &policies_by_domain,
                default_policy,
            )
            .await
            {
                Ok(v) => v,
                Err(err) => {
                    metrics.record_dkim_failure("domain_suspended");
                    return Err(err);
                }
            };

            sign_or_enforce_policy(&domain, raw, active, effective_policy, &kek_ring, &metrics)
        }
    }

    fn delete_message(&self, storage_key: &str) -> impl Future<Output = Result<()>> + Send {
        let inner = Arc::clone(&self.inner);
        let key = storage_key.to_string();
        async move { inner.delete_message(&key).await }
    }
}

async fn resolve_domain_policy_and_key(
    domain: &str,
    keyring: &DkimKeyRing,
    pg_pool: Option<&PgPool>,
    policies_by_domain: &RwLock<HashMap<String, CachedPolicy>>,
    default_policy: DkimSigningPolicy,
) -> Result<(DkimSigningPolicy, Option<StoredDkimKey>)> {
    let mut cached_policy = policies_by_domain
        .read()
        .ok()
        .and_then(|g| g.get(domain).copied());
    let is_stale = cached_policy.is_none_or(|c| c.refreshed_at.elapsed() >= POLICY_CACHE_TTL);

    let mut active = keyring.active_key(domain);

    if let Some(pool) = pg_pool {
        if is_stale || active.is_none() {
            match fetch_domain_dkim_state(pool, domain).await {
                Ok(Some((policy, is_suspended, db_key))) => {
                    let entry = CachedPolicy {
                        policy,
                        is_suspended,
                        refreshed_at: Instant::now(),
                    };
                    if let Ok(mut guard) = policies_by_domain.write() {
                        guard.insert(domain.to_string(), entry);
                    }
                    cached_policy = Some(entry);
                    if is_suspended {
                        keyring.sync_domain_active_key(domain, None);
                        active = None;
                    } else {
                        keyring.sync_domain_active_key(domain, db_key.clone());
                        active = db_key;
                    }
                }
                Ok(None) => {
                    keyring.sync_domain_active_key(domain, None);
                    active = None;
                }
                Err(err) => {
                    warn!(
                        domain = %domain,
                        error = %err,
                        "Failed refreshing DKIM state from Postgres; using cached state if present"
                    );
                }
            }
        }
    }

    if cached_policy.is_some_and(|c| c.is_suspended) {
        anyhow::bail!("DKIM_DOMAIN_SUSPENDED: sending blocked for {domain}");
    }

    let effective_policy = cached_policy.map_or(default_policy, |c| c.policy);
    Ok((effective_policy, active))
}

fn sign_or_enforce_policy(
    domain: &str,
    raw: Bytes,
    active: Option<StoredDkimKey>,
    effective_policy: DkimSigningPolicy,
    kek_ring: &KeyEncryptionKeyRing,
    metrics: &MetricsRegistry,
) -> Result<Bytes> {
    let Some(active_key) = active else {
        metrics.record_dkim_attempt("none", effective_policy.as_label());
        metrics.record_dkim_failure("missing_active_key");
        if effective_policy == DkimSigningPolicy::Required {
            error!(
                domain = %domain,
                policy = %effective_policy.as_label(),
                "No active DKIM key configured for domain; blocking unsigned delivery"
            );
            anyhow::bail!("DKIM_REQUIRED_KEY_MISSING: no active DKIM key for domain {domain}");
        }
        warn!(
            domain = %domain,
            policy = %effective_policy.as_label(),
            "No active DKIM key found; delivering unsigned because dkim_policy=optional"
        );
        return Ok(raw);
    };

    metrics.record_dkim_attempt(active_key.algorithm.as_label(), effective_policy.as_label());

    match sign_rfc5322_message_with_ring(&raw, &active_key, kek_ring) {
        Ok(signed) => {
            metrics.record_dkim_success(active_key.algorithm.as_label());
            debug!(
                domain = %domain,
                selector = %active_key.selector,
                algorithm = %active_key.algorithm.as_label(),
                kek_version = active_key.key_encryption_version,
                "Applied DKIM signature"
            );
            Ok(Bytes::from(signed))
        }
        Err(err) => {
            metrics.record_dkim_failure(err.reason.as_label());
            error!(
                domain = %domain,
                selector = %active_key.selector,
                reason = %err.reason.as_label(),
                policy = %effective_policy.as_label(),
                error = %err.message,
                "DKIM signing failed"
            );
            if effective_policy == DkimSigningPolicy::Required {
                anyhow::bail!(
                    "DKIM_SIGNING_FAILED ({}): {} [domain={domain}]",
                    err.reason.as_label(),
                    err.message
                );
            }
            warn!(
                domain = %domain,
                selector = %active_key.selector,
                "Sending unsigned payload because dkim_policy=optional"
            );
            Ok(raw)
        }
    }
}

async fn fetch_domain_dkim_state(
    pool: &PgPool,
    domain: &str,
) -> Result<Option<(DkimSigningPolicy, bool, Option<StoredDkimKey>)>> {
    let dom_row = sqlx::query(
        r"SELECT id, dkim_policy, is_suspended
            FROM domains
           WHERE LOWER(domain_name::text) = $1
           LIMIT 1",
    )
    .bind(domain)
    .fetch_optional(pool)
    .await?;

    let Some(dom) = dom_row else {
        return Ok(None);
    };

    let domain_id: sqlx::types::Uuid = dom.try_get("id")?;
    let policy_str: String = dom
        .try_get("dkim_policy")
        .unwrap_or_else(|_| "required".to_string());
    let is_suspended: bool = dom.try_get("is_suspended").unwrap_or(false);
    let policy = DkimSigningPolicy::from_db_str(&policy_str);

    if is_suspended {
        return Ok(Some((policy, true, None)));
    }

    let key_row = sqlx::query(
        r"SELECT selector, algorithm, public_key_dns_txt, encrypted_private_key, key_encryption_version
            FROM dkim_keys
           WHERE domain_id = $1 AND status = 'active'
           ORDER BY created_at DESC
           LIMIT 1",
    )
    .bind(domain_id)
    .fetch_optional(pool)
    .await?;

    let active_key = key_row.and_then(|row| {
        let sel: String = row.try_get("selector").unwrap_or_default();
        let algo_str: String = row.try_get("algorithm").unwrap_or_default();
        let pub_txt: String = row.try_get("public_key_dns_txt").unwrap_or_default();
        let enc: Vec<u8> = row.try_get("encrypted_private_key").unwrap_or_default();
        let ver: i32 = row.try_get("key_encryption_version").unwrap_or(1);
        if sel.is_empty() || enc.is_empty() {
            return None;
        }
        Some(StoredDkimKey {
            dns_record_name: format!("{sel}._domainkey.{domain}"),
            domain: domain.to_string(),
            selector: sel,
            algorithm: if algo_str.eq_ignore_ascii_case("ed25519") {
                DkimAlgorithm::Ed25519
            } else {
                DkimAlgorithm::Rsa2048
            },
            public_key_dns_txt: pub_txt,
            encrypted_private_key: enc,
            key_encryption_version: ver.max(1),
            status: DkimKeyStatus::Active,
        })
    });

    info!(
        domain = %domain,
        policy = %policy.as_label(),
        has_active_key = active_key.is_some(),
        "Refreshed domain DKIM policy and active key from Postgres"
    );

    Ok(Some((policy, false, active_key)))
}

/// Extracts the normalized domain from the MIME `From:` header across any header block length.
#[must_use]
pub fn extract_from_domain(raw_mime: &[u8]) -> Option<String> {
    let parsed = MessageParser::default().parse(raw_mime)?;
    let addr = parsed.from()?.first()?;
    let email = addr.address.as_deref()?;
    let (_, domain) = email.rsplit_once('@')?;
    let trimmed = domain.trim().to_ascii_lowercase();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use dkim::{generate_domain_dkim_key_versioned, KeyEncryptionKey};

    use super::*;

    const TEST_KEK_V1: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TEST_KEK_V2: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    #[derive(Default)]
    struct MemStore {
        items: Mutex<HashMap<String, Bytes>>,
    }

    impl MessageStore for MemStore {
        fn put_message(
            &self,
            _organization_id: &str,
            payload: &[u8],
        ) -> impl Future<Output = Result<StoredObject>> + Send {
            let key = "obj-1".to_string();
            let data = Bytes::copy_from_slice(payload);
            let mut guard = self.items.lock().unwrap();
            guard.insert(key.clone(), data);
            async move {
                Ok(StoredObject {
                    storage_key: key,
                    size_bytes: 0,
                    sha256_hex: String::new(),
                })
            }
        }

        fn get_message(&self, storage_key: &str) -> impl Future<Output = Result<Bytes>> + Send {
            let data = self.items.lock().unwrap().get(storage_key).cloned();
            async move { data.ok_or_else(|| anyhow::anyhow!("missing")) }
        }

        fn delete_message(&self, storage_key: &str) -> impl Future<Output = Result<()>> + Send {
            self.items.lock().unwrap().remove(storage_key);
            async { Ok(()) }
        }
    }

    fn setup_raw(from: &str) -> (Arc<MemStore>, &'static str) {
        let inner = Arc::new(MemStore::default());
        let raw = format!("From: {from}\r\nTo: user@remote.org\r\nSubject: Hi\r\n\r\nHello.\r\n");
        inner
            .items
            .lock()
            .unwrap()
            .insert("k1".to_string(), Bytes::from(raw));
        (inner, "k1")
    }

    #[tokio::test]
    async fn required_policy_blocks_missing_active_key() {
        let (inner, key) = setup_raw("sender@fastconnect.in");
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let ring = Arc::new(DkimKeyRing::default());
        let kek_ring = Arc::new(
            KeyEncryptionKeyRing::single(1, KeyEncryptionKey::from_hex(TEST_KEK_V1).unwrap())
                .unwrap(),
        );
        let store = DkimSigningStore::with_default_policy(
            inner,
            ring,
            kek_ring,
            None,
            metrics,
            DkimSigningPolicy::Required,
        );

        let err = store.get_message(key).await.unwrap_err();
        assert!(err.to_string().contains("DKIM_REQUIRED_KEY_MISSING"));
    }

    #[tokio::test]
    async fn required_policy_blocks_decryption_failure() {
        let (inner, key) = setup_raw("sender@fastconnect.in");
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let k1 = KeyEncryptionKey::from_hex(TEST_KEK_V1).unwrap();
        let k2 = KeyEncryptionKey::from_hex(TEST_KEK_V2).unwrap();

        let dkim_key = generate_domain_dkim_key_versioned(
            "fastconnect.in",
            "mp1",
            DkimAlgorithm::Rsa2048,
            &KeyEncryptionKeyRing::single(1, k1).unwrap(),
        )
        .unwrap();

        let ring = Arc::new(DkimKeyRing::default());
        ring.install_active_key(dkim_key);

        // Configure store with wrong KEK (v2 only while key needs v1)
        let wrong_kek_ring = Arc::new(KeyEncryptionKeyRing::single(2, k2).unwrap());
        let store = DkimSigningStore::new(inner, ring, wrong_kek_ring, None, metrics);

        let err = store.get_message(key).await.unwrap_err();
        assert!(err.to_string().contains("decryption_failed"));
    }

    #[tokio::test]
    async fn required_policy_blocks_invalid_private_key() {
        let (inner, key) = setup_raw("sender@fastconnect.in");
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let kek_ring = Arc::new(
            KeyEncryptionKeyRing::single(1, KeyEncryptionKey::from_hex(TEST_KEK_V1).unwrap())
                .unwrap(),
        );
        let (ver, bad_ct) = kek_ring.encrypt_with_active(b"corrupted-der").unwrap();
        let ring = Arc::new(DkimKeyRing::default());
        ring.install_active_key(StoredDkimKey {
            domain: "fastconnect.in".to_string(),
            selector: "mp1".to_string(),
            algorithm: DkimAlgorithm::Rsa2048,
            dns_record_name: "mp1._domainkey.fastconnect.in".to_string(),
            public_key_dns_txt: "v=DKIM1; k=rsa; p=AAAA".to_string(),
            encrypted_private_key: bad_ct,
            key_encryption_version: ver,
            status: DkimKeyStatus::Active,
        });

        let store = DkimSigningStore::new(inner, ring, kek_ring, None, metrics);
        let err = store.get_message(key).await.unwrap_err();
        assert!(err.to_string().contains("invalid_key"));
    }

    #[tokio::test]
    async fn successful_signing_prepends_dkim_signature() {
        let (inner, key) = setup_raw("sender@fastconnect.in");
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let kek_ring = Arc::new(
            KeyEncryptionKeyRing::single(1, KeyEncryptionKey::from_hex(TEST_KEK_V1).unwrap())
                .unwrap(),
        );
        let dkim_key = generate_domain_dkim_key_versioned(
            "fastconnect.in",
            "mp1",
            DkimAlgorithm::Rsa2048,
            &kek_ring,
        )
        .unwrap();
        let ring = Arc::new(DkimKeyRing::default());
        ring.install_active_key(dkim_key);

        let store = DkimSigningStore::new(inner, ring, kek_ring, None, metrics.clone());
        let signed = store.get_message(key).await.unwrap();
        let text = String::from_utf8_lossy(&signed);
        assert!(text.starts_with("DKIM-Signature:"));
        assert!(text.contains("d=fastconnect.in"));
        assert!(text.contains("s=mp1"));
        assert_eq!(
            metrics
                .dkim_signing_successes_total
                .with_label_values(&["rsa2048"])
                .get(),
            1
        );
    }

    #[tokio::test]
    async fn optional_policy_permits_unsigned_when_missing_or_corrupt() {
        let (inner, key) = setup_raw("sender@fastconnect.in");
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let ring = Arc::new(DkimKeyRing::default());
        let kek_ring = Arc::new(
            KeyEncryptionKeyRing::single(1, KeyEncryptionKey::from_hex(TEST_KEK_V1).unwrap())
                .unwrap(),
        );
        let store = DkimSigningStore::with_default_policy(
            inner,
            ring,
            kek_ring,
            None,
            metrics,
            DkimSigningPolicy::Optional,
        );

        let unsigned = store.get_message(key).await.unwrap();
        let text = String::from_utf8_lossy(&unsigned);
        assert!(!text.starts_with("DKIM-Signature:"));
        assert!(text.starts_with("From: sender@fastconnect.in"));
    }

    #[tokio::test]
    async fn per_domain_optional_policy_override_allows_unsigned_without_changing_default() {
        let (inner, key) = setup_raw("sender@optional.example");
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let ring = Arc::new(DkimKeyRing::default());
        let kek_ring = Arc::new(
            KeyEncryptionKeyRing::single(1, KeyEncryptionKey::from_hex(TEST_KEK_V1).unwrap())
                .unwrap(),
        );
        let store = DkimSigningStore::new(inner, ring, kek_ring, None, metrics);
        store.set_domain_policy("optional.example", DkimSigningPolicy::Optional);

        let unsigned = store.get_message(key).await.unwrap();
        let text = String::from_utf8_lossy(&unsigned);
        assert!(!text.starts_with("DKIM-Signature:"));
    }
}
