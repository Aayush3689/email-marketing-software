//! Domain-specific DKIM key generation (RSA-2048 & Ed25519), versioned AES-256-GCM
//! envelope encryption, selector rotation, and RFC 6376 signing via `mail-auth`.

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

impl DkimAlgorithm {
    #[must_use]
    pub const fn as_label(self) -> &'static str {
        match self {
            Self::Rsa2048 => "rsa2048",
            Self::Ed25519 => "ed25519",
        }
    }
}

/// Outbound domain DKIM signing policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DkimSigningPolicy {
    /// Default safe behavior: refuse unsigned delivery when signing is configured/required and fails.
    #[default]
    Required,
    /// Explicitly allow unsigned delivery when no key is available or signing fails.
    Optional,
}

impl DkimSigningPolicy {
    #[must_use]
    pub fn from_db_str(raw: &str) -> Self {
        if raw.eq_ignore_ascii_case("optional") {
            Self::Optional
        } else {
            Self::Required
        }
    }

    #[must_use]
    pub const fn as_label(self) -> &'static str {
        match self {
            Self::Required => "required",
            Self::Optional => "optional",
        }
    }
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

impl std::fmt::Debug for KeyEncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyEncryptionKey([REDACTED])")
    }
}

impl Drop for KeyEncryptionKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

impl KeyEncryptionKey {
    /// Parses a 64-character hex-encoded 256-bit key without logging or exposing material.
    ///
    /// # Errors
    /// Returns an error if hex decoding fails or the key length is not 32 bytes.
    pub fn from_hex(hex_str: &str) -> Result<Self> {
        let trimmed = hex_str.trim();
        if trimmed.len() != 64 {
            bail!("DKIM KEK must be exactly 64 hex characters (32 bytes)");
        }
        let decoded = Zeroizing::new(hex::decode(trimmed).context("invalid KEK hex")?);
        if decoded.len() != 32 {
            bail!("DKIM KEK decoded length must be 32 bytes");
        }
        let mut bytes = [0_u8; 32];
        bytes.copy_from_slice(&decoded);
        Ok(Self { bytes })
    }
}

/// Versioned keyring of 256-bit KEKs supporting zero-downtime key rotation.
#[derive(Clone, Debug)]
pub struct KeyEncryptionKeyRing {
    keys: HashMap<i32, KeyEncryptionKey>,
    active_version: i32,
}

impl KeyEncryptionKeyRing {
    /// Creates a single-version keyring (e.g. for version 1 compatibility).
    ///
    /// # Errors
    /// Returns an error if `version < 1`.
    pub fn single(version: i32, kek: KeyEncryptionKey) -> Result<Self> {
        if version < 1 {
            bail!("KEK version must be >= 1");
        }
        let mut keys = HashMap::new();
        keys.insert(version, kek);
        Ok(Self {
            keys,
            active_version: version,
        })
    }

    /// Builds a keyring from explicit `(version, kek)` entries and optional active version.
    ///
    /// # Errors
    /// Returns an error if empty, any version is `< 1`, or `active_version` is missing.
    pub fn from_versions(
        entries: Vec<(i32, KeyEncryptionKey)>,
        active_version: Option<i32>,
    ) -> Result<Self> {
        if entries.is_empty() {
            bail!("At least one DKIM KEK must be configured");
        }
        let mut keys = HashMap::new();
        let mut max_ver = 0_i32;
        for (ver, kek) in entries {
            if ver < 1 {
                bail!("KEK version must be >= 1 (got {ver})");
            }
            if ver > max_ver {
                max_ver = ver;
            }
            keys.insert(ver, kek);
        }
        let resolved_active = active_version.unwrap_or(max_ver);
        if !keys.contains_key(&resolved_active) {
            bail!("DKIM_KEK_ACTIVE_VERSION={resolved_active} is not present in configured KEKs");
        }
        Ok(Self {
            keys,
            active_version: resolved_active,
        })
    }

    /// Loads KEKs from environment variables:
    /// - `DKIM_KEK_HEX` -> version 1 (if `DKIM_KEK_V1_HEX` not explicitly specified)
    /// - `DKIM_KEK_V<N>_HEX` for `N >= 1`
    /// - `DKIM_KEK_KEYS` formatted as `1:<64hex>,2:<64hex>`
    /// - `DKIM_KEK_ACTIVE_VERSION` (defaults to highest configured version)
    ///
    /// # Errors
    /// Fails if any key is malformed, missing in production, or uses the default development key in production.
    pub fn from_env_vars(is_prod: bool, default_dev_hex: &str) -> Result<Self> {
        let mut raw_map: HashMap<i32, String> = HashMap::new();

        if let Ok(legacy) = std::env::var("DKIM_KEK_HEX") {
            let trimmed = legacy.trim();
            if !trimmed.is_empty() {
                raw_map.insert(1, trimmed.to_string());
            }
        }

        if let Ok(multi) = std::env::var("DKIM_KEK_KEYS") {
            for pair in multi.split(',') {
                let p = pair.trim();
                if p.is_empty() {
                    continue;
                }
                let Some((ver_str, hex_val)) = p.split_once(':') else {
                    bail!("Invalid DKIM_KEK_KEYS entry; expected <version>:<64-hex>");
                };
                let ver: i32 = ver_str
                    .trim()
                    .strip_prefix('v')
                    .or_else(|| ver_str.trim().strip_prefix('V'))
                    .unwrap_or(ver_str.trim())
                    .parse()
                    .context("Invalid version number in DKIM_KEK_KEYS")?;
                raw_map.insert(ver, hex_val.trim().to_string());
            }
        }

        for (k, v) in std::env::vars() {
            if let Some(rest) = k.strip_prefix("DKIM_KEK_V") {
                if let Some(ver_str) = rest.strip_suffix("_HEX") {
                    let trimmed = v.trim();
                    if !trimmed.is_empty() {
                        let ver: i32 = ver_str
                            .parse()
                            .with_context(|| format!("Invalid version suffix in env var {k}"))?;
                        raw_map.insert(ver, trimmed.to_string());
                    }
                }
            }
        }

        if raw_map.is_empty() {
            if is_prod {
                bail!("DKIM_KEK_HEX or DKIM_KEK_KEYS must be set when NODE_ENV=production");
            }
            raw_map.insert(1, default_dev_hex.to_string());
        }

        let mut parsed: Vec<(i32, KeyEncryptionKey)> = Vec::with_capacity(raw_map.len());
        for (ver, hex_str) in raw_map {
            if is_prod && hex_str.eq_ignore_ascii_case(default_dev_hex) {
                bail!(
                    "DKIM KEK version {ver} must not use the default development key in production"
                );
            }
            let kek = KeyEncryptionKey::from_hex(&hex_str)
                .with_context(|| format!("Invalid DKIM KEK material for version {ver}"))?;
            parsed.push((ver, kek));
        }

        let active_override = std::env::var("DKIM_KEK_ACTIVE_VERSION")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().parse::<i32>())
            .transpose()
            .context("Invalid DKIM_KEK_ACTIVE_VERSION")?;

        Self::from_versions(parsed, active_override)
    }

    #[must_use]
    pub const fn active_version(&self) -> i32 {
        self.active_version
    }

    #[must_use]
    pub fn has_version(&self, version: i32) -> bool {
        self.keys.contains_key(&version)
    }

    /// Encrypts private key DER using the active KEK version.
    ///
    /// # Errors
    /// Returns an error if encryption fails.
    pub fn encrypt_with_active(&self, plaintext_der: &[u8]) -> Result<(i32, Vec<u8>)> {
        let kek = self
            .keys
            .get(&self.active_version)
            .context("Active KEK version missing from keyring")?;
        let encrypted = encrypt_private_key(kek, plaintext_der)?;
        Ok((self.active_version, encrypted))
    }

    /// Decrypts private key DER using the explicit stored `version`.
    ///
    /// # Errors
    /// Returns an error if `version` is missing or GCM authentication fails.
    pub fn decrypt_version(&self, version: i32, encrypted: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let kek = self.keys.get(&version).ok_or_else(|| {
            anyhow::anyhow!("Missing DKIM KEK for key_encryption_version={version}")
        })?;
        decrypt_private_key(kek, encrypted)
    }

    /// Re-encrypts ciphertext from `current_version` to `target_version` (defaults to `active_version`).
    ///
    /// # Errors
    /// Returns an error if old decryption or new encryption fails.
    pub fn reencrypt(
        &self,
        current_version: i32,
        encrypted: &[u8],
        target_version: Option<i32>,
    ) -> Result<(i32, Vec<u8>)> {
        let target_ver = target_version.unwrap_or(self.active_version);
        let target_kek = self
            .keys
            .get(&target_ver)
            .ok_or_else(|| anyhow::anyhow!("Missing target DKIM KEK version={target_ver}"))?;
        let plain = self.decrypt_version(current_version, encrypted)?;
        let reencrypted = encrypt_private_key(target_kek, &plain)?;
        Ok((target_ver, reencrypted))
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
    pub key_encryption_version: i32,
    pub status: DkimKeyStatus,
}

/// Encrypts DER-encoded private key material using AES-256-GCM (`nonce_12B || ciphertext || tag_16B`).
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
    if encrypted.len() <= 28 {
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

/// Generates a new DKIM keypair encrypted under the active KEK version.
///
/// # Errors
/// Returns an error if key generation or encryption fails.
pub fn generate_domain_dkim_key_versioned(
    domain: &str,
    selector: &str,
    algorithm: DkimAlgorithm,
    kek_ring: &KeyEncryptionKeyRing,
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
    let (key_encryption_version, encrypted_private_key) =
        kek_ring.encrypt_with_active(&private_der)?;

    Ok(StoredDkimKey {
        dns_record_name: format!("{normalized_selector}._domainkey.{normalized_domain}"),
        domain: normalized_domain,
        selector: normalized_selector,
        algorithm,
        public_key_dns_txt,
        encrypted_private_key,
        key_encryption_version,
        status: DkimKeyStatus::Active,
    })
}

/// Generates a new DKIM keypair with a single version-1 KEK (backwards-compatible wrapper).
///
/// # Errors
/// Returns an error if key generation or encryption fails.
pub fn generate_domain_dkim_key(
    domain: &str,
    selector: &str,
    algorithm: DkimAlgorithm,
    kek: &KeyEncryptionKey,
) -> Result<StoredDkimKey> {
    let ring = KeyEncryptionKeyRing::single(1, kek.clone())?;
    generate_domain_dkim_key_versioned(domain, selector, algorithm, &ring)
}

/// Multi-selector domain DKIM keyring supporting key rotation.
#[derive(Debug, Default)]
pub struct DkimKeyRing {
    keys_by_domain: RwLock<HashMap<String, Vec<StoredDkimKey>>>,
}

impl DkimKeyRing {
    /// Registers or rotates a domain's active DKIM key, demoting previous active keys to `Retiring`
    /// and updating any matching selector in place without creating duplicates.
    pub fn install_active_key(&self, key: StoredDkimKey) {
        if let Ok(mut guard) = self.keys_by_domain.write() {
            let entries = guard.entry(key.domain.to_ascii_lowercase()).or_default();
            for existing in entries.iter_mut() {
                if existing.status == DkimKeyStatus::Active && existing.selector != key.selector {
                    existing.status = DkimKeyStatus::Retiring;
                }
            }
            entries.retain(|existing| existing.selector != key.selector);
            entries.push(key);
        }
    }

    /// Replaces the cached keys for a single domain cleanly (e.g. during cache refresh).
    pub fn sync_domain_active_key(&self, domain: &str, active_key: Option<StoredDkimKey>) {
        if let Ok(mut guard) = self.keys_by_domain.write() {
            let norm = domain.to_ascii_lowercase();
            match active_key {
                Some(key) => {
                    guard.insert(norm, vec![key]);
                }
                None => {
                    guard.remove(&norm);
                }
            }
        }
    }

    /// Marks a selector as `Revoked` so it can never be chosen as active for outbound signing.
    pub fn revoke_key(&self, domain: &str, selector: &str) {
        if let Ok(mut guard) = self.keys_by_domain.write() {
            if let Some(entries) = guard.get_mut(&domain.to_ascii_lowercase()) {
                for existing in entries.iter_mut() {
                    if existing.selector == selector {
                        existing.status = DkimKeyStatus::Revoked;
                    }
                }
            }
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

    /// Returns the currently active signing key for `domain`, if any (never returns a revoked key).
    #[must_use]
    pub fn active_key(&self, domain: &str) -> Option<StoredDkimKey> {
        self.keys_by_domain.read().ok().and_then(|g| {
            g.get(&domain.to_ascii_lowercase())?
                .iter()
                .find(|k| k.status == DkimKeyStatus::Active)
                .cloned()
        })
    }

    /// Lists all selectors stored in memory for a domain.
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

/// Categorized DKIM signing error for structured metrics & fail-closed diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DkimSigningFailureReason {
    RevokedKey,
    DecryptionFailed,
    InvalidKey,
    SigningError,
}

impl DkimSigningFailureReason {
    #[must_use]
    pub const fn as_label(self) -> &'static str {
        match self {
            Self::RevokedKey => "revoked_key",
            Self::DecryptionFailed => "decryption_failed",
            Self::InvalidKey => "invalid_key",
            Self::SigningError => "signing_error",
        }
    }
}

/// Structured signing error preserving failure classification without leaking key bytes.
#[derive(Debug)]
pub struct DkimSignError {
    pub reason: DkimSigningFailureReason,
    pub message: String,
}

impl std::fmt::Display for DkimSignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DKIM signing error ({}): {}",
            self.reason.as_label(),
            self.message
        )
    }
}

impl std::error::Error for DkimSignError {}

/// Signs an RFC 5322 email payload using a domain's active key and versioned KEK ring.
///
/// # Errors
/// Returns `DkimSignError` if key is revoked, decryption fails, key bytes are invalid, or RFC 6376 signing fails.
pub fn sign_rfc5322_message_with_ring(
    raw_mime: &[u8],
    key: &StoredDkimKey,
    kek_ring: &KeyEncryptionKeyRing,
) -> std::result::Result<Vec<u8>, DkimSignError> {
    if key.status != DkimKeyStatus::Active {
        return Err(DkimSignError {
            reason: DkimSigningFailureReason::RevokedKey,
            message: format!(
                "DKIM key selector '{}' for domain '{}' is {:?}, not Active",
                key.selector, key.domain, key.status
            ),
        });
    }

    let private_der = kek_ring
        .decrypt_version(key.key_encryption_version, &key.encrypted_private_key)
        .map_err(|e| DkimSignError {
            reason: DkimSigningFailureReason::DecryptionFailed,
            message: e.to_string(),
        })?;

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
            let rsa = RsaKey::<Sha256>::from_der(&private_der).map_err(|e| DkimSignError {
                reason: DkimSigningFailureReason::InvalidKey,
                message: format!("invalid RSA DKIM key: {e}"),
            })?;
            let sig = DkimSigner::from_key(rsa)
                .domain(&key.domain)
                .selector(&key.selector)
                .headers(headers_to_sign)
                .header_canonicalization(Canonicalization::Relaxed)
                .body_canonicalization(Canonicalization::Relaxed)
                .sign(raw_mime)
                .map_err(|e| DkimSignError {
                    reason: DkimSigningFailureReason::SigningError,
                    message: format!("DKIM RSA signing failed: {e}"),
                })?;
            sig.to_header()
        }
        DkimAlgorithm::Ed25519 => {
            let ed = Ed25519Key::from_pkcs8_der(&private_der).map_err(|e| DkimSignError {
                reason: DkimSigningFailureReason::InvalidKey,
                message: format!("invalid Ed25519 DKIM key: {e}"),
            })?;
            let sig = DkimSigner::from_key(ed)
                .domain(&key.domain)
                .selector(&key.selector)
                .headers(headers_to_sign)
                .header_canonicalization(Canonicalization::Relaxed)
                .body_canonicalization(Canonicalization::Relaxed)
                .sign(raw_mime)
                .map_err(|e| DkimSignError {
                    reason: DkimSigningFailureReason::SigningError,
                    message: format!("DKIM Ed25519 signing failed: {e}"),
                })?;
            sig.to_header()
        }
    };

    let mut signed = Vec::with_capacity(sig_header.len() + raw_mime.len());
    signed.extend_from_slice(sig_header.as_bytes());
    signed.extend_from_slice(raw_mime);
    Ok(signed)
}

/// Signs an RFC 5322 email payload using a single KEK (backwards-compatible wrapper).
///
/// # Errors
/// Returns an error if decryption, key parsing, or RFC 6376 signing fails.
pub fn sign_rfc5322_message(
    raw_mime: &[u8],
    key: &StoredDkimKey,
    kek: &KeyEncryptionKey,
) -> Result<Vec<u8>> {
    let ring = KeyEncryptionKeyRing::single(key.key_encryption_version.max(1), kek.clone())?;
    sign_rfc5322_message_with_ring(raw_mime, key, &ring).map_err(anyhow::Error::from)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use mail_auth::common::parse::TxtRecordParser;
    use mail_auth::common::verify::DomainKey;
    use mail_auth::{AuthenticatedMessage, DkimResult, Resolver};

    use super::*;

    const TEST_KEK_HEX_V1: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const TEST_KEK_HEX_V2: &str =
        "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[tokio::test]
    async fn generates_encrypts_rotates_and_signs_valid_dkim_rsa_and_ed25519() {
        let kek = KeyEncryptionKey::from_hex(TEST_KEK_HEX_V1).unwrap();
        let ring = DkimKeyRing::default();

        let rsa_key = ring
            .rotate_key("example.com", "s1", DkimAlgorithm::Rsa2048, &kek)
            .unwrap();
        assert!(rsa_key.public_key_dns_txt.starts_with("v=DKIM1; k=rsa; p="));
        assert_eq!(rsa_key.key_encryption_version, 1);

        let ed_key = ring
            .rotate_key("example.com", "s2", DkimAlgorithm::Ed25519, &kek)
            .unwrap();
        assert!(ed_key
            .public_key_dns_txt
            .starts_with("v=DKIM1; k=ed25519; p="));

        // Sign active key (ed_key) and also test rsa_key when marked Active
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
    fn validates_kek_format_nonce_and_tag_tampering() {
        assert!(KeyEncryptionKey::from_hex("short").is_err());
        assert!(KeyEncryptionKey::from_hex(&"zz".repeat(32)).is_err());
        let kek = KeyEncryptionKey::from_hex(TEST_KEK_HEX_V1).unwrap();
        let c1 = encrypt_private_key(&kek, b"secret-der-payload").unwrap();
        let c2 = encrypt_private_key(&kek, b"secret-der-payload").unwrap();
        assert_ne!(&c1[..12], &c2[..12], "nonce must be unique per encryption");

        let mut tampered_tag = c1.clone();
        let last = tampered_tag.len() - 1;
        tampered_tag[last] ^= 0xff;
        assert!(decrypt_private_key(&kek, &tampered_tag).is_err());

        let mut tampered_nonce = c1;
        tampered_nonce[0] ^= 0x01;
        assert!(decrypt_private_key(&kek, &tampered_nonce).is_err());
    }

    #[test]
    fn supports_versioned_kek_ring_rotation_and_reencryption() {
        let k1 = KeyEncryptionKey::from_hex(TEST_KEK_HEX_V1).unwrap();
        let k2 = KeyEncryptionKey::from_hex(TEST_KEK_HEX_V2).unwrap();

        let ring_v1 = KeyEncryptionKeyRing::single(1, k1.clone()).unwrap();
        let key_v1 = generate_domain_dkim_key_versioned(
            "fastconnect.in",
            "mp1",
            DkimAlgorithm::Rsa2048,
            &ring_v1,
        )
        .unwrap();
        assert_eq!(key_v1.key_encryption_version, 1);

        // Step 1: Add v2 alongside v1, verify v1 decryption and v2 encryption both work
        let ring_dual =
            KeyEncryptionKeyRing::from_versions(vec![(1, k1), (2, k2.clone())], Some(2)).unwrap();
        let msg = b"From: hello@fastconnect.in\r\nTo: a@b.com\r\nSubject: Hi\r\n\r\nBody\r\n";
        assert!(sign_rfc5322_message_with_ring(msg, &key_v1, &ring_dual).is_ok());

        // Step 2: Re-encrypt from v1 -> v2
        let (new_ver, new_ct) = ring_dual
            .reencrypt(
                key_v1.key_encryption_version,
                &key_v1.encrypted_private_key,
                None,
            )
            .unwrap();
        assert_eq!(new_ver, 2);

        let mut key_v2 = key_v1;
        key_v2.key_encryption_version = new_ver;
        key_v2.encrypted_private_key = new_ct;

        // Step 3: Retire v1 completely; ring with only v2 must still sign cleanly!
        let ring_v2_only = KeyEncryptionKeyRing::single(2, k2).unwrap();
        assert!(sign_rfc5322_message_with_ring(msg, &key_v2, &ring_v2_only).is_ok());
    }

    #[test]
    fn rejects_revoked_and_invalid_keys() {
        let kek = KeyEncryptionKey::from_hex(TEST_KEK_HEX_V1).unwrap();
        let ring_kek = KeyEncryptionKeyRing::single(1, kek).unwrap();
        let mut key = generate_domain_dkim_key_versioned(
            "example.com",
            "mp1",
            DkimAlgorithm::Rsa2048,
            &ring_kek,
        )
        .unwrap();
        key.status = DkimKeyStatus::Revoked;

        let msg = b"From: hello@example.com\r\nTo: a@b.com\r\nSubject: Hi\r\n\r\nBody\r\n";
        let err = sign_rfc5322_message_with_ring(msg, &key, &ring_kek).unwrap_err();
        assert_eq!(err.reason, DkimSigningFailureReason::RevokedKey);

        // Corrupt private key DER bytes encrypted validly -> InvalidKey error
        let (_, bad_ct) = ring_kek
            .encrypt_with_active(b"not-a-valid-pkcs1-key")
            .unwrap();
        key.status = DkimKeyStatus::Active;
        key.encrypted_private_key = bad_ct;
        let err2 = sign_rfc5322_message_with_ring(msg, &key, &ring_kek).unwrap_err();
        assert_eq!(err2.reason, DkimSigningFailureReason::InvalidKey);
    }

    #[test]
    fn keyring_replace_all_keys_and_revoke_work() {
        let kek = KeyEncryptionKey::from_hex(TEST_KEK_HEX_V1).unwrap();
        let ring = DkimKeyRing::default();

        let _k1 = ring
            .rotate_key("alpha.test", "mp1", DkimAlgorithm::Rsa2048, &kek)
            .unwrap();
        let k2 = ring
            .rotate_key("beta.test", "s2", DkimAlgorithm::Ed25519, &kek)
            .unwrap();

        ring.revoke_key("alpha.test", "mp1");
        assert!(ring.active_key("alpha.test").is_none());

        ring.replace_all_keys(vec![k2]);
        assert!(ring.active_key("alpha.test").is_none());
        assert_eq!(
            ring.active_key("beta.test")
                .as_ref()
                .map(|k| k.selector.as_str()),
            Some("s2")
        );
    }
}
