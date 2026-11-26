//! Durable message payload storage (`MessageStore` trait) with an atomic `NVMe`
//! filesystem spool implementation, S3-compatible object storage, and an in-memory test store.

pub mod s3;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use anyhow::{bail, Context, Result};
use bytes::Bytes;
pub use s3::{S3Config, S3MessageStore};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

/// Unified storage enum so `mail-engine` switches cleanly between local `NVMe` spool and S3/`MinIO`.
#[derive(Clone)]
pub enum SpoolStorage {
    Local(LocalSpoolStore),
    S3(S3MessageStore),
}

impl MessageStore for SpoolStorage {
    async fn put_message(&self, organization_id: &str, payload: &[u8]) -> Result<StoredObject> {
        match self {
            Self::Local(s) => s.put_message(organization_id, payload).await,
            Self::S3(s) => s.put_message(organization_id, payload).await,
        }
    }

    async fn get_message(&self, storage_key: &str) -> Result<Bytes> {
        match self {
            Self::Local(s) => s.get_message(storage_key).await,
            Self::S3(s) => s.get_message(storage_key).await,
        }
    }

    async fn delete_message(&self, storage_key: &str) -> Result<()> {
        match self {
            Self::Local(s) => s.delete_message(storage_key).await,
            Self::S3(s) => s.delete_message(storage_key).await,
        }
    }
}

/// Receipt returned when persisting an email MIME payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredObject {
    pub storage_key: String,
    pub sha256_hex: String,
    pub size_bytes: usize,
}

/// Abstract payload storage backend (local `NVMe` spool in Phases 1-9, S3/MinIO in Phase 10).
pub trait MessageStore: Send + Sync {
    fn put_message(
        &self,
        organization_id: &str,
        payload: &[u8],
    ) -> impl Future<Output = Result<StoredObject>> + Send;

    fn get_message(&self, storage_key: &str) -> impl Future<Output = Result<Bytes>> + Send;

    fn delete_message(&self, storage_key: &str) -> impl Future<Output = Result<()>> + Send;
}

/// Atomic local-disk `NVMe` spool using 2-level fanout directories (`org/xx/uuid.eml`).
#[derive(Debug, Clone)]
pub struct LocalSpoolStore {
    root_dir: PathBuf,
}

impl LocalSpoolStore {
    /// Initializes the spool directory if it does not yet exist.
    ///
    /// # Errors
    /// Returns an error if creating the spool root fails.
    pub async fn new(root_dir: impl AsRef<Path>) -> Result<Self> {
        let root = root_dir.as_ref().to_path_buf();
        fs::create_dir_all(&root)
            .await
            .with_context(|| format!("failed to create spool dir {}", root.display()))?;
        Ok(Self { root_dir: root })
    }

    fn resolve_safe_path(&self, storage_key: &str) -> Result<PathBuf> {
        if storage_key.contains("..") || storage_key.starts_with('/') {
            bail!("invalid storage key: {storage_key}");
        }
        Ok(self.root_dir.join(storage_key))
    }
}

impl MessageStore for LocalSpoolStore {
    async fn put_message(&self, organization_id: &str, payload: &[u8]) -> Result<StoredObject> {
        let id = Uuid::now_v7().to_string();
        let shard = &id[..2];
        let safe_org: String = organization_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if safe_org.is_empty() {
            bail!("invalid organization_id for storage key");
        }

        let rel_dir = PathBuf::from(&safe_org).join(shard);
        let abs_dir = self.root_dir.join(&rel_dir);
        fs::create_dir_all(&abs_dir).await?;

        let storage_key = format!("{safe_org}/{shard}/{id}.eml");
        let tmp_path = abs_dir.join(format!(".{id}.tmp"));
        let final_path = abs_dir.join(format!("{id}.eml"));

        let mut hasher = Sha256::new();
        hasher.update(payload);
        let sha256_hex = hex::encode(hasher.finalize());

        let mut file = fs::File::create(&tmp_path).await?;
        file.write_all(payload).await?;
        file.sync_all().await?;
        drop(file);

        fs::rename(&tmp_path, &final_path).await?;

        Ok(StoredObject {
            storage_key,
            sha256_hex,
            size_bytes: payload.len(),
        })
    }

    async fn get_message(&self, storage_key: &str) -> Result<Bytes> {
        let path = self.resolve_safe_path(storage_key)?;
        let data = fs::read(&path)
            .await
            .with_context(|| format!("failed to read spool file {}", path.display()))?;
        Ok(Bytes::from(data))
    }

    async fn delete_message(&self, storage_key: &str) -> Result<()> {
        let path = self.resolve_safe_path(storage_key)?;
        if fs::try_exists(&path).await.unwrap_or(false) {
            fs::remove_file(&path).await?;
        }
        Ok(())
    }
}

/// Zero-copy in-memory store for unit tests and isolated load benchmarks.
#[derive(Debug, Default)]
pub struct InMemoryMessageStore {
    objects: RwLock<HashMap<String, Bytes>>,
}

impl MessageStore for InMemoryMessageStore {
    fn put_message(
        &self,
        organization_id: &str,
        payload: &[u8],
    ) -> impl Future<Output = Result<StoredObject>> + Send {
        let id = Uuid::now_v7().to_string();
        let storage_key = format!("{organization_id}/{id}.eml");
        let mut hasher = Sha256::new();
        hasher.update(payload);
        let sha256_hex = hex::encode(hasher.finalize());
        let bytes = Bytes::copy_from_slice(payload);
        let len = bytes.len();

        if let Ok(mut guard) = self.objects.write() {
            guard.insert(storage_key.clone(), bytes);
        }

        std::future::ready(Ok(StoredObject {
            storage_key,
            sha256_hex,
            size_bytes: len,
        }))
    }

    fn get_message(&self, storage_key: &str) -> impl Future<Output = Result<Bytes>> + Send {
        let res = self
            .objects
            .read()
            .ok()
            .and_then(|g| g.get(storage_key).cloned())
            .with_context(|| format!("missing message key {storage_key}"));
        std::future::ready(res)
    }

    fn delete_message(&self, storage_key: &str) -> impl Future<Output = Result<()>> + Send {
        if let Ok(mut guard) = self.objects.write() {
            guard.remove(storage_key);
        }
        std::future::ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_atomically_and_blocks_path_traversal() {
        let tmp_dir = std::env::temp_dir().join(format!("mailplat-spool-{}", Uuid::now_v7()));
        let store = LocalSpoolStore::new(&tmp_dir).await.unwrap();

        let payload = b"From: a@example.com\r\nSubject: Durable\r\n\r\nHello\r\n";
        let obj = store.put_message("org-123", payload).await.unwrap();
        assert_eq!(obj.size_bytes, payload.len());

        let loaded = store.get_message(&obj.storage_key).await.unwrap();
        assert_eq!(loaded.as_ref(), payload);

        assert!(store.get_message("../../etc/passwd").await.is_err());

        store.delete_message(&obj.storage_key).await.unwrap();
        assert!(store.get_message(&obj.storage_key).await.is_err());
        let _ = fs::remove_dir_all(&tmp_dir).await;
    }
}
