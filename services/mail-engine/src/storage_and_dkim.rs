//! Wraps `SpoolStorage` to transparently DKIM-sign outbound RFC 5322 payloads before transmission.

use std::future::Future;
use std::sync::Arc;

use anyhow::Result;
use bytes::Bytes;
use dkim::{
    sign_rfc5322_message, DkimAlgorithm, DkimKeyRing, DkimKeyStatus, KeyEncryptionKey,
    StoredDkimKey,
};
use mail_parser::MessageParser;
use message_storage::{MessageStore, StoredObject};
use sqlx::{PgPool, Row};
use tracing::warn;

/// Decorator over [`MessageStore`] that signs outbound messages on read if an active DKIM key
/// matches the sender `From:` domain, lazily syncing from PostgreSQL on cache miss.
#[derive(Clone)]
pub struct DkimSigningStore<S> {
    inner: Arc<S>,
    keyring: Arc<DkimKeyRing>,
    kek: Arc<KeyEncryptionKey>,
    pg_pool: Option<PgPool>,
}

impl<S> DkimSigningStore<S> {
    #[must_use]
    pub const fn new(
        inner: Arc<S>,
        keyring: Arc<DkimKeyRing>,
        kek: Arc<KeyEncryptionKey>,
        pg_pool: Option<PgPool>,
    ) -> Self {
        Self {
            inner,
            keyring,
            kek,
            pg_pool,
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
        let kek = Arc::clone(&self.kek);
        let pg_pool = self.pg_pool.clone();
        let key = storage_key.to_string();

        async move {
            let raw = inner.get_message(&key).await?;
            if let Some(domain) = extract_from_domain(&raw) {
                let mut active = keyring.active_key(&domain);
                if active.is_none() {
                    if let Some(pool) = &pg_pool {
                        if let Ok(Some(row)) = sqlx::query(
                            r"SELECT k.selector, k.algorithm, k.public_key_dns_txt, k.encrypted_private_key
                                FROM dkim_keys k
                                JOIN domains d ON d.id = k.domain_id
                               WHERE LOWER(d.domain_name::text) = $1
                                 AND k.status = 'active'
                                 AND d.is_suspended = FALSE
                               ORDER BY k.created_at DESC
                               LIMIT 1",
                        )
                        .bind(&domain)
                        .fetch_optional(pool)
                        .await
                        {
                            let sel: String = row.try_get("selector").unwrap_or_default();
                            let algo_str: String = row.try_get("algorithm").unwrap_or_default();
                            let pub_txt: String = row.try_get("public_key_dns_txt").unwrap_or_default();
                            let enc: Vec<u8> = row.try_get("encrypted_private_key").unwrap_or_default();
                            if !sel.is_empty() && !enc.is_empty() {
                                let loaded = StoredDkimKey {
                                    dns_record_name: format!("{sel}._domainkey.{domain}"),
                                    domain: domain.clone(),
                                    selector: sel,
                                    algorithm: if algo_str.eq_ignore_ascii_case("ed25519") {
                                        DkimAlgorithm::Ed25519
                                    } else {
                                        DkimAlgorithm::Rsa2048
                                    },
                                    public_key_dns_txt: pub_txt,
                                    encrypted_private_key: enc,
                                    status: DkimKeyStatus::Active,
                                };
                                keyring.install_active_key(loaded.clone());
                                active = Some(loaded);
                            }
                        }
                    }
                }
                if let Some(active_key) = active {
                    match sign_rfc5322_message(&raw, &active_key, &kek) {
                        Ok(signed) => return Ok(Bytes::from(signed)),
                        Err(err) => {
                            warn!(domain = %domain, error = %err, "DKIM signing failed; sending unsigned payload");
                        }
                    }
                }
            }
            Ok(raw)
        }
    }

    fn delete_message(&self, storage_key: &str) -> impl Future<Output = Result<()>> + Send {
        let inner = Arc::clone(&self.inner);
        let key = storage_key.to_string();
        async move { inner.delete_message(&key).await }
    }
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
