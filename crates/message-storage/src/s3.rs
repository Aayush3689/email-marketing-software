//! S3-compatible (AWS S3 / `MinIO` / Cloudflare R2) `MessageStore` using AWS `SigV4`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use chrono::Utc;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use uuid::Uuid;

use crate::{MessageStore, StoredObject};

const S3_IO_TIMEOUT: Duration = Duration::from_secs(15);

/// Configuration for S3-compatible object storage.
#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

/// Async S3-compatible object storage backend implementing AWS `SigV4` over HTTP/HTTPS.
#[derive(Clone)]
pub struct S3MessageStore {
    cfg: S3Config,
    use_tls: bool,
    host_header: String,
    connect_addr: String,
    base_path: String,
    tls_connector: Arc<TlsConnector>,
}

impl S3MessageStore {
    /// Parses endpoint URL and constructs a reusable TLS/TCP S3 client.
    ///
    /// # Errors
    /// Returns an error if `endpoint` is malformed.
    pub fn new(cfg: S3Config) -> Result<Self> {
        let trimmed = cfg.endpoint.trim_end_matches('/');
        let (use_tls, rest) = if let Some(s) = trimmed.strip_prefix("https://") {
            (true, s)
        } else if let Some(s) = trimmed.strip_prefix("http://") {
            (false, s)
        } else {
            bail!("S3 endpoint must start with http:// or https://");
        };

        let (authority, path_prefix) = rest.split_once('/').unwrap_or((rest, ""));
        let default_port = if use_tls { 443 } else { 80 };
        let (host, port) = parse_authority(authority, default_port);

        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut root_store = RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls_cfg = ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();

        let host_header = authority.to_string();
        let connect_addr = format!("{host}:{port}");
        let base_path = if path_prefix.is_empty() {
            String::new()
        } else {
            format!("/{}", path_prefix.trim_matches('/'))
        };

        Ok(Self {
            cfg,
            use_tls,
            host_header,
            connect_addr,
            base_path,
            tls_connector: Arc::new(TlsConnector::from(Arc::new(tls_cfg))),
        })
    }

    async fn send_signed_request(
        &self,
        method: &str,
        object_key: &str,
        body: &[u8],
    ) -> Result<(u16, Vec<u8>)> {
        if object_key.contains("..") || object_key.starts_with('/') {
            bail!("invalid S3 object key: {object_key}");
        }

        let encoded_key: String = object_key
            .split('/')
            .map(uri_encode_segment)
            .collect::<Vec<_>>()
            .join("/");
        let canonical_uri = format!(
            "{}/{}/{}",
            self.base_path,
            uri_encode_segment(&self.cfg.bucket),
            encoded_key
        );

        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();
        let payload_hash = hex::encode(Sha256::digest(body));

        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n",
            self.host_header
        );
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );

        let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", self.cfg.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );

        let k_secret = format!("AWS4{}", self.cfg.secret_key);
        let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
        let k_region = hmac_sha256(&k_date, self.cfg.region.as_bytes());
        let k_service = hmac_sha256(&k_region, b"s3");
        let k_signing = hmac_sha256(&k_service, b"aws4_request");
        let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.cfg.access_key
        );

        let req_head = format!(
            "{method} {canonical_uri} HTTP/1.1\r\n\
             Host: {}\r\n\
             Content-Length: {}\r\n\
             x-amz-content-sha256: {payload_hash}\r\n\
             x-amz-date: {amz_date}\r\n\
             Authorization: {authorization}\r\n\
             Connection: close\r\n\r\n",
            self.host_header,
            body.len()
        );

        let stream = timeout(S3_IO_TIMEOUT, TcpStream::connect(&self.connect_addr))
            .await
            .context("S3 TCP connect timed out")?
            .with_context(|| format!("failed connecting to S3 endpoint {}", self.connect_addr))?;

        if self.use_tls {
            let (host_only, _) = parse_authority(&self.host_header, 443);
            let sni_host = host_only.trim_matches(&['[', ']'][..]).to_string();
            let sni = ServerName::try_from(sni_host)
                .map_err(|e| anyhow::anyhow!("invalid S3 SNI host: {e}"))?;
            let tls_stream = timeout(S3_IO_TIMEOUT, self.tls_connector.connect(sni, stream))
                .await
                .context("S3 TLS handshake timed out")??;
            execute_http_exchange(tls_stream, &req_head, body).await
        } else {
            execute_http_exchange(stream, &req_head, body).await
        }
    }
}

impl MessageStore for S3MessageStore {
    async fn put_message(&self, organization_id: &str, payload: &[u8]) -> Result<StoredObject> {
        let id = Uuid::now_v7().to_string();
        let shard = &id[..2];
        let safe_org: String = organization_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if safe_org.is_empty() {
            bail!("invalid organization_id for S3 storage key");
        }

        let storage_key = format!("{safe_org}/{shard}/{id}.eml");
        let sha256_hex = hex::encode(Sha256::digest(payload));
        let (status, _) = self
            .send_signed_request("PUT", &storage_key, payload)
            .await?;
        if !(200..300).contains(&status) {
            bail!("S3 transient error PUT {storage_key} HTTP {status}");
        }

        Ok(StoredObject {
            storage_key,
            sha256_hex,
            size_bytes: payload.len(),
        })
    }

    async fn get_message(&self, storage_key: &str) -> Result<Bytes> {
        let (status, body) = self.send_signed_request("GET", storage_key, &[]).await?;
        if status == 404 {
            bail!("OBJECT_NOT_FOUND: missing S3 key {storage_key}");
        }
        if !(200..300).contains(&status) {
            bail!("S3 transient error GET {storage_key} HTTP {status}");
        }
        Ok(Bytes::from(body))
    }

    async fn delete_message(&self, storage_key: &str) -> Result<()> {
        let (status, _) = self.send_signed_request("DELETE", storage_key, &[]).await?;
        if !(200..300).contains(&status) && status != 404 {
            bail!("S3 transient error DELETE {storage_key} HTTP {status}");
        }
        Ok(())
    }
}

fn parse_authority(authority: &str, default_port: u16) -> (&str, u16) {
    if authority.starts_with('[') {
        if let Some((host_bracketed, port_str)) = authority.rsplit_once("]:") {
            if let Ok(port) = port_str.parse::<u16>() {
                let host = authority
                    .split_once("]:")
                    .map_or(host_bracketed, |(h, _)| h);
                return (host, port);
            }
        }
        return (authority, default_port);
    }
    authority
        .rsplit_once(':')
        .and_then(|(h, p)| p.parse::<u16>().ok().map(|port| (h, port)))
        .unwrap_or((authority, default_port))
}

fn uri_encode_segment(input: &str) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

async fn execute_http_exchange<S>(mut stream: S, head: &str, body: &[u8]) -> Result<(u16, Vec<u8>)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    timeout(S3_IO_TIMEOUT, stream.write_all(head.as_bytes()))
        .await
        .context("S3 request write timed out")??;
    if !body.is_empty() {
        timeout(S3_IO_TIMEOUT, stream.write_all(body))
            .await
            .context("S3 body write timed out")??;
    }
    timeout(S3_IO_TIMEOUT, stream.flush())
        .await
        .context("S3 flush timed out")??;

    let mut raw = Vec::new();
    timeout(S3_IO_TIMEOUT, stream.read_to_end(&mut raw))
        .await
        .context("S3 response read timed out")??;

    let mut offset = 0_usize;
    loop {
        let rest = &raw[offset..];
        let header_end = rest
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .context("malformed HTTP response from S3 endpoint")?;

        let header_str = std::str::from_utf8(&rest[..header_end])?;
        let status_line = header_str.lines().next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .context("missing HTTP status code in S3 response")?;

        offset += header_end + 4;
        if status == 100 {
            continue;
        }

        let is_chunked = header_str.lines().any(|l| {
            l.to_ascii_lowercase().starts_with("transfer-encoding:")
                && l.to_ascii_lowercase().contains("chunked")
        });
        let payload = if is_chunked {
            decode_chunked_body(&raw[offset..])?
        } else {
            raw[offset..].to_vec()
        };
        return Ok((status, payload));
    }
}

fn decode_chunked_body(mut input: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let pos = input
            .windows(2)
            .position(|w| w == b"\r\n")
            .context("malformed HTTP chunk header")?;
        let size_hex = std::str::from_utf8(&input[..pos])?
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let size = usize::from_str_radix(size_hex, 16).context("invalid HTTP chunk size")?;
        input = &input[pos + 2..];
        if size == 0 {
            break;
        }
        if input.len() < size + 2 {
            bail!("truncated HTTP chunk body");
        }
        out.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
    Ok(out)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k_pad = [0_u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        k_pad[..32].copy_from_slice(&digest);
    } else {
        k_pad[..key.len()].copy_from_slice(key);
    }

    let mut o_key_pad = [0x5c_u8; BLOCK];
    let mut i_key_pad = [0x36_u8; BLOCK];
    for i in 0..BLOCK {
        o_key_pad[i] ^= k_pad[i];
        i_key_pad[i] ^= k_pad[i];
    }

    let mut inner = Sha256::new();
    inner.update(i_key_pad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(o_key_pad);
    outer.update(inner_hash);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn s3_store_signs_sigv4_and_roundtrips_put_get_delete() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let objects: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
        let seen_auth: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        let obj_srv = Arc::clone(&objects);
        let auth_srv = Arc::clone(&seen_auth);
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(stream);
                let mut req_line = String::new();
                reader.read_line(&mut req_line).await.unwrap();
                let mut parts = req_line.split_whitespace();
                let method = parts.next().unwrap().to_string();
                let path = parts.next().unwrap().to_string();

                let mut content_len = 0_usize;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).await.unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                    let lower = h.to_ascii_lowercase();
                    if let Some(val) = lower.strip_prefix("content-length:") {
                        content_len = val.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth_srv.lock().unwrap().push(h.trim().to_string());
                    }
                }
                let mut body = vec![0_u8; content_len];
                if content_len > 0 {
                    reader.read_exact(&mut body).await.unwrap();
                }

                let mut stream = reader.into_inner();
                match method.as_str() {
                    "PUT" => {
                        obj_srv.lock().unwrap().insert(path, body);
                        stream
                            .write_all(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                            .await
                            .unwrap();
                    }
                    "GET" => {
                        let data = obj_srv.lock().unwrap().get(&path).cloned();
                        if let Some(d) = data {
                            let chunk = format!(
                                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:X}\r\n",
                                d.len()
                            );
                            stream.write_all(chunk.as_bytes()).await.unwrap();
                            stream.write_all(&d).await.unwrap();
                            stream.write_all(b"\r\n0\r\n\r\n").await.unwrap();
                        } else {
                            stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                                .await
                                .unwrap();
                        }
                    }
                    "DELETE" => {
                        obj_srv.lock().unwrap().remove(&path);
                        stream
                            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                            .await
                            .unwrap();
                    }
                    _ => {}
                }
                stream.shutdown().await.unwrap();
            }
        });

        let store = S3MessageStore::new(S3Config {
            endpoint: format!("http://{addr}"),
            region: "us-east-1".to_string(),
            bucket: "mail-spool".to_string(),
            access_key: "minioadmin".to_string(),
            secret_key: "minioadminsecret".to_string(),
        })
        .unwrap();

        let payload = b"From: app@acme.test\r\nSubject: S3 Test\r\n\r\nStored in S3\r\n";
        let obj = store.put_message("org-1", payload).await.unwrap();
        let fetched = store.get_message(&obj.storage_key).await.unwrap();
        assert_eq!(fetched.as_ref(), payload);
        store.delete_message(&obj.storage_key).await.unwrap();

        server.await.unwrap();
        let auths = seen_auth.lock().unwrap();
        assert_eq!(auths.len(), 3);
        assert!(auths[0].contains("AWS4-HMAC-SHA256 Credential=minioadmin/"));
    }
}
