//! Domain-specific DKIM key generation (RSA-2048 & Ed25519), AES-256-GCM envelope
//! encryption, selector rotation, and RFC 6376 signing via `mail-auth`.

use std::collections::HashMap;
use std::sync::RwLock;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{bail, Context, Result};
use mail_auth::common::crypto::{Ed25519Key, RsaKey, Sha256};
use mail_auth::common::headers::HeaderWriter;
use mail_auth::dkim::generate::DkimKeyPair;
use mail_auth::dkim::{Canonicalization, DkimSigner};
use rand::RngCore;
use zeroize::{Zeroize, Zeroizing};

/// Supported DKIM signing algorithms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DkimAlgorithm {
    Rsa2048,
    Ed25519,
}

/// Lifecycle state of a domain DKIM key selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DkimKeyStatus {
    Active,
    Retiring,
    Revoked,
}

/// 256-bit Key Encryption Key (KEK) protecting stored DKIM private keys at rest.
#[derive(Clone)]
pub struct KeyEncryptionKey {
    bytes: [u8; 32],
}

impl Drop for KeyEncryptionKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

impl KeyEncryptionKey {
    /// Parses a 64-character hex-encoded 256-bit key.
    ///
    /// # Errors
    /// Returns an error if hex decoding fails or the key length is not 32 bytes.
    pub fn from_hex(hex_str: &str) -> Result<Self> {
        let decoded = Zeroizing::new(hex::decode(hex_str.trim()).context("invalid KEK hex")?);
        if decoded.len() != 32 {
            bail!("DKIM KEK must be exactly 32 bytes (64 hex chars)");
        }
        let mut bytes = [0_u8; 32];
        bytes.copy_from_slice(&decoded);
        Ok(Self { bytes })
    }
}

/// Persisted domain DKIM key record (never exposes plaintext private key).
#[derive(Debug, Clone)]
pub struct StoredDkimKey {
    pub domain: String,
    pub selector: String,
    pub algorithm: DkimAlgorithm,
    pub dns_record_name: String,
    pub public_key_dns_txt: String,
    pub encrypted_private_key: Vec<u8>,
    pub status: DkimKeyStatus,
}

/// Encrypts DER-encoded private key material using AES-256-GCM (`nonce_12B || ciphertext`).
///
/// # Errors
/// Returns an error if AEAD encryption fails.
pub fn encrypt_private_key(kek: &KeyEncryptionKey, plaintext_der: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(&kek.bytes)
        .map_err(|e| anyhow::anyhow!("cipher init error: {e}"))?;
    let mut nonce_bytes = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext_der)
        .map_err(|e| anyhow::anyhow!("DKIM key encryption failed: {e}"))?;

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypts an envelope-encrypted DKIM private key into a zeroizing buffer.
///
/// # Errors
/// Returns an error if ciphertext is truncated or authentication tag verification fails.
pub fn decrypt_private_key(kek: &KeyEncryptionKey, encrypted: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if encrypted.len() <= 12 {
        bail!("encrypted DKIM private key payload is malformed");
    }
    let (nonce_bytes, ciphertext) = encrypted.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&kek.bytes)
        .map_err(|e| anyhow::anyhow!("cipher init error: {e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|e| anyhow::anyhow!("DKIM key decryption failed: {e}"))?;
    Ok(Zeroizing::new(plain))
}

/// Generates a new DKIM keypair and returns a [`StoredDkimKey`] with encrypted private material.
///
/// # Errors
/// Returns an error if key generation or encryption fails.
pub fn generate_domain_dkim_key(
    domain: &str,
    selector: &str,
    algorithm: DkimAlgorithm,
    kek: &KeyEncryptionKey,
) -> Result<StoredDkimKey> {
    let normalized_domain = domain.trim().to_ascii_lowercase();
    let normalized_selector = selector.trim().to_ascii_lowercase();

    let (pair, txt_prefix) = match algorithm {
        DkimAlgorithm::Rsa2048 => (
            DkimKeyPair::generate_rsa(2048)
                .map_err(|e| anyhow::anyhow!("RSA keygen failed: {e}"))?,
            "v=DKIM1; k=rsa; p=",
        ),
        DkimAlgorithm::Ed25519 => (
            DkimKeyPair::generate_ed25519()
                .map_err(|e| anyhow::anyhow!("Ed25519 keygen failed: {e}"))?,
            "v=DKIM1; k=ed25519; p=",
        ),
    };

    let public_key_dns_txt = format!("{txt_prefix}{}", pair.encoded_public_key());
    let private_der = Zeroizing::new(pair.private_key().to_vec());
    let encrypted_private_key = encrypt_private_key(kek, &private_der)?;

    Ok(StoredDkimKey {
        dns_record_name: format!("{normalized_selector}._domainkey.{normalized_domain}"),
        domain: normalized_domain,
        selector: normalized_selector,
        algorithm,
        public_key_dns_txt,
        encrypted_private_key,
        status: DkimKeyStatus::Active,
    })
}

/// Multi-selector domain DKIM keyring supporting key rotation.
#[derive(Debug, Default)]
pub struct DkimKeyRing {
    keys_by_domain: RwLock<HashMap<String, Vec<StoredDkimKey>>>,
}

impl DkimKeyRing {
    /// Registers or rotates a domain's active DKIM key, demoting any previous active key to `Retiring`.
    pub fn install_active_key(&self, key: StoredDkimKey) {
        if let Ok(mut guard) = self.keys_by_domain.write() {
            let entries = guard.entry(key.domain.clone()).or_default();
            for existing in entries.iter_mut() {
                if existing.status == DkimKeyStatus::Active {
                    existing.status = DkimKeyStatus::Retiring;
                }
            }
            entries.push(key);
        }
    }

    /// Generates a new selector key and promotes it to `Active` while keeping older keys `Retiring`.
    ///
    /// # Errors
    /// Returns an error if key generation or encryption fails.
    pub fn rotate_key(
        &self,
        domain: &str,
        new_selector: &str,
        algorithm: DkimAlgorithm,
        kek: &KeyEncryptionKey,
    ) -> Result<StoredDkimKey> {
        let key = generate_domain_dkim_key(domain, new_selector, algorithm, kek)?;
        self.install_active_key(key.clone());
        Ok(key)
    }

    /// Returns the currently active signing key for `domain`, if any.
    #[must_use]
    pub fn active_key(&self, domain: &str) -> Option<StoredDkimKey> {
        self.keys_by_domain.read().ok().and_then(|g| {
            g.get(&domain.to_ascii_lowercase())?
                .iter()
                .find(|k| k.status == DkimKeyStatus::Active)
                .cloned()
        })
    }

    /// Lists all selectors (active + retiring) for a domain.
    #[must_use]
    pub fn list_keys(&self, domain: &str) -> Vec<StoredDkimKey> {
        self.keys_by_domain
            .read()
            .ok()
            .and_then(|g| g.get(&domain.to_ascii_lowercase()).cloned())
            .unwrap_or_default()
    }

    /// Atomically replaces all loaded keys (used during dynamic Postgres reload).
    pub fn replace_all_keys(&self, keys: Vec<StoredDkimKey>) {
        let mut next: HashMap<String, Vec<StoredDkimKey>> = HashMap::new();
        for key in keys {
            next.entry(key.domain.to_ascii_lowercase())
                .or_default()
                .push(key);
        }
        if let Ok(mut guard) = self.keys_by_domain.write() {
            *guard = next;
        }
    }

    /// Returns active selector names keyed by normalized domain.
    #[must_use]
    pub fn active_selectors_by_domain(&self) -> HashMap<String, Vec<String>> {
        self.keys_by_domain.read().ok().map_or_default(|g| {
            g.iter()
                .map(|(dom, keys)| {
                    let active_selectors = keys
                        .iter()
                        .filter(|k| k.status == DkimKeyStatus::Active)
                        .map(|k| k.selector.clone())
                        .collect();
                    (dom.clone(), active_selectors)
                })
                .collect()
        })
    }
}

/// Signs an RFC 5322 email payload using the domain's encrypted DKIM key and prepends
/// the `DKIM-Signature` header.
///
/// # Errors
/// Returns an error if decryption, key parsing, or RFC 6376 signing fails.
pub fn sign_rfc5322_message(
    raw_mime: &[u8],
    key: &StoredDkimKey,
    kek: &KeyEncryptionKey,
) -> Result<Vec<u8>> {
    let private_der = decrypt_private_key(kek, &key.encrypted_private_key)?;
    let headers_to_sign = [
        "From",
        "To",
        "Subject",
        "Date",
        "Message-ID",
        "MIME-Version",
        "Content-Type",
    ];

    let sig_header = match key.algorithm {
        DkimAlgorithm::Rsa2048 => {
            let rsa = RsaKey::<Sha256>::from_der(&private_der)
                .map_err(|e| anyhow::anyhow!("invalid RSA DKIM key: {e}"))?;
            let sig = DkimSigner::from_key(rsa)
                .domain(&key.domain)
                .selector(&key.selector)
                .headers(headers_to_sign)
                .header_canonicalization(Canonicalization::Relaxed)
                .body_canonicalization(Canonicalization::Relaxed)
                .sign(raw_mime)
                .map_err(|e| anyhow::anyhow!("DKIM RSA signing failed: {e}"))?;
            sig.to_header()
        }
        DkimAlgorithm::Ed25519 => {
            let ed = Ed25519Key::from_pkcs8_der(&private_der)
                .map_err(|e| anyhow::anyhow!("invalid Ed25519 DKIM key: {e}"))?;
            let sig = DkimSigner::from_key(ed)
                .domain(&key.domain)
                .selector(&key.selector)
                .headers(headers_to_sign)
                .header_canonicalization(Canonicalization::Relaxed)
                .body_canonicalization(Canonicalization::Relaxed)
                .sign(raw_mime)
                .map_err(|e| anyhow::anyhow!("DKIM Ed25519 signing failed: {e}"))?;
            sig.to_header()
        }
    };

    let mut signed = Vec::with_capacity(sig_header.len() + raw_mime.len());
    signed.extend_from_slice(sig_header.as_bytes());
    signed.extend_from_slice(raw_mime);
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use mail_auth::common::parse::TxtRecordParser;
    use mail_auth::common::verify::DomainKey;
    use mail_auth::{AuthenticatedMessage, DkimResult, Resolver};

    use super::*;

    const TEST_KEK_HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[tokio::test]
    async fn generates_encrypts_rotates_and_signs_valid_dkim_rsa_and_ed25519() {
        let kek = KeyEncryptionKey::from_hex(TEST_KEK_HEX).unwrap();
        let ring = DkimKeyRing::default();

        let rsa_key = ring
            .rotate_key("example.com", "s1", DkimAlgorithm::Rsa2048, &kek)
            .unwrap();
        assert!(rsa_key.public_key_dns_txt.starts_with("v=DKIM1; k=rsa; p="));

        // Rotate to Ed25519 s2; s1 becomes Retiring
        let ed_key = ring
            .rotate_key("example.com", "s2", DkimAlgorithm::Ed25519, &kek)
            .unwrap();
        assert!(ed_key
            .public_key_dns_txt
            .starts_with("v=DKIM1; k=ed25519; p="));

        let all = ring.list_keys("example.com");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].status, DkimKeyStatus::Retiring);
        assert_eq!(all[1].status, DkimKeyStatus::Active);

        // Wrong KEK must fail decryption
        let wrong_kek = KeyEncryptionKey::from_hex(
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        )
        .unwrap();
        assert!(decrypt_private_key(&wrong_kek, &rsa_key.encrypted_private_key).is_err());

        let msg = b"From: hello@example.com\r\nTo: user@remote.org\r\nSubject: DKIM Test\r\n\r\nSigned body.\r\n";
        let signed_rsa = sign_rfc5322_message(msg, &rsa_key, &kek).unwrap();
        let signed_ed = sign_rfc5322_message(msg, &ed_key, &kek).unwrap();

        let resolver = Resolver::new_system_conf().unwrap();
        resolver.txt_add(
            "s1._domainkey.example.com.".to_string(),
            DomainKey::parse(rsa_key.public_key_dns_txt.as_bytes()).unwrap(),
            Instant::now() + Duration::from_secs(3600),
        );
        resolver.txt_add(
            "s2._domainkey.example.com.".to_string(),
            DomainKey::parse(ed_key.public_key_dns_txt.as_bytes()).unwrap(),
            Instant::now() + Duration::from_secs(3600),
        );

        let auth_rsa = AuthenticatedMessage::parse(&signed_rsa).unwrap();
        let res_rsa = resolver.verify_dkim(&auth_rsa).await;
        assert_eq!(res_rsa.len(), 1);
        assert_eq!(res_rsa[0].result(), &DkimResult::Pass);

        let auth_ed = AuthenticatedMessage::parse(&signed_ed).unwrap();
        let res_ed = resolver.verify_dkim(&auth_ed).await;
        assert_eq!(res_ed.len(), 1);
        assert_eq!(res_ed[0].result(), &DkimResult::Pass);
    }

    #[test]
    fn keyring_replace_all_keys_and_active_selectors_work() {
        let kek = KeyEncryptionKey::from_hex(TEST_KEK_HEX).unwrap();
        let ring = DkimKeyRing::default();

        let k1 = ring
            .rotate_key("alpha.test", "mp1", DkimAlgorithm::Rsa2048, &kek)
            .unwrap();
        let k2 = ring
            .rotate_key("beta.test", "s2", DkimAlgorithm::Ed25519, &kek)
            .unwrap();

        let selectors = ring.active_selectors_by_domain();
        assert_eq!(
            selectors
                .get("alpha.test")
                .and_then(|v| v.first())
                .map(String::as_str),
            Some("mp1")
        );
        assert_eq!(
            selectors
                .get("beta.test")
                .and_then(|v| v.first())
                .map(String::as_str),
            Some("s2")
        );

        // Replace keyring atomically from DB snapshot containing only k2
        ring.replace_all_keys(vec![k2]);
        assert!(ring.active_key("alpha.test").is_none());
        assert_eq!(
            ring.active_key("beta.test")
                .as_ref()
                .map(|k| k.selector.as_str()),
            Some("s2")
        );
        assert_eq!(k1.selector, "mp1");
    }
}
