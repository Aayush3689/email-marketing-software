//! Wraps `SpoolStorage` to transparently DKIM-sign outbound RFC 5322 payloads before transmission.

use std::future::Future;
use std::sync::Arc;

use anyhow::Result;
use bytes::Bytes;
use dkim::{sign_rfc5322_message, DkimKeyRing, KeyEncryptionKey};
use mail_parser::MessageParser;
use message_storage::{MessageStore, StoredObject};
use tracing::warn;

/// Decorator over [`MessageStore`] that signs outbound messages on read if an active DKIM key
/// matches the sender `From:` domain.
#[derive(Clone)]
pub struct DkimSigningStore<S> {
    inner: Arc<S>,
    keyring: Arc<DkimKeyRing>,
    kek: Arc<KeyEncryptionKey>,
}

impl<S> DkimSigningStore<S> {
    #[must_use]
    pub const fn new(inner: Arc<S>, keyring: Arc<DkimKeyRing>, kek: Arc<KeyEncryptionKey>) -> Self {
        Self {
            inner,
            keyring,
            kek,
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
        let key = storage_key.to_string();

        async move {
            let raw = inner.get_message(&key).await?;
            if let Some(domain) = extract_from_domain(&raw) {
                if let Some(active) = keyring.active_key(&domain) {
                    match sign_rfc5322_message(&raw, &active, &kek) {
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
