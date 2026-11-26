//! Outbound SMTP client with TLS session resumption, opportunistic/strict STARTTLS,
//! PIPELINING, RFC 5321 dot-stuffing, connection reuse pooling, and response classification.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::ClientSessionMemoryCache;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    ClientConfig, DigitallySignedStruct, Error as RustlsError, RootCertStore, SignatureScheme,
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::net::{TcpSocket, TcpStream};
use tokio::time::timeout;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

/// TLS verification policy for outbound Port 25 delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboundTlsPolicy {
    /// Encrypt transport via STARTTLS when offered, accepting mismatched certs (logged in telemetry).
    Opportunistic,
    /// Require STARTTLS and strict `WebPKI` + SAN validation (e.g., MTA-STS).
    Strict,
}

/// Parameters for a single outbound SMTP delivery attempt.
#[derive(Debug, Clone, Copy)]
pub struct OutboundRequest<'a> {
    pub mx_host: &'a str,
    pub target_ip: IpAddr,
    pub port: u16,
    pub bind_ip: Option<IpAddr>,
    pub envelope_from: &'a str,
    pub recipient: &'a str,
    pub raw_mime: &'a [u8],
}

/// Classification of an outbound SMTP delivery attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryOutcome {
    Accepted {
        smtp_code: u16,
        enhanced_code: Option<String>,
        message: String,
    },
    Deferred {
        smtp_code: u16,
        enhanced_code: Option<String>,
        message: String,
        is_throttle: bool,
    },
    Bounced {
        smtp_code: u16,
        enhanced_code: Option<String>,
        message: String,
    },
    /// TCP dropped or timed out AFTER `<CRLF>.<CRLF>` was sent, before reading `250 OK`.
    AmbiguousPostData {
        reason: String,
    },
    NetworkError {
        reason: String,
    },
}

/// Detailed telemetry from one outbound SMTP attempt.
#[derive(Debug, Clone)]
pub struct AttemptTelemetry {
    pub outcome: DeliveryOutcome,
    pub remote_ip: IpAddr,
    pub tls_used: bool,
    pub tls_verified: bool,
    pub connection_reused: bool,
    pub connect_duration: Duration,
    pub tls_duration: Duration,
    pub transaction_duration: Duration,
}

/// Timeout and pool tuning parameters for outbound SMTP connections.
#[derive(Debug, Clone)]
pub struct OutboundClientConfig {
    pub helo_domain: String,
    pub connect_timeout: Duration,
    pub command_timeout: Duration,
    pub data_timeout: Duration,
    pub tls_policy: OutboundTlsPolicy,
    pub max_idle_per_host: usize,
    pub idle_ttl: Duration,
    pub max_messages_per_conn: usize,
}

impl Default for OutboundClientConfig {
    fn default() -> Self {
        Self {
            helo_domain: "mta.localhost".to_string(),
            connect_timeout: Duration::from_secs(10),
            command_timeout: Duration::from_secs(30),
            data_timeout: Duration::from_secs(120),
            tls_policy: OutboundTlsPolicy::Opportunistic,
            max_idle_per_host: 8,
            idle_ttl: Duration::from_secs(60),
            max_messages_per_conn: 50,
        }
    }
}

#[derive(Debug)]
struct NoVerifyCerts;

impl ServerCertVerifier for NoVerifyCerts {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, RustlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ED25519,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
        ]
    }
}

enum ClientTransport {
    Plain(BufReader<TcpStream>),
    Tls(Box<BufReader<TlsStream<TcpStream>>>),
}

impl ClientTransport {
    async fn write_all_flush(&mut self, data: &[u8]) -> std::io::Result<()> {
        match self {
            Self::Plain(r) => {
                r.get_mut().write_all(data).await?;
                r.get_mut().flush().await
            }
            Self::Tls(r) => {
                r.get_mut().write_all(data).await?;
                r.get_mut().flush().await
            }
        }
    }

    async fn read_reply(
        &mut self,
        cmd_timeout: Duration,
    ) -> Result<(u16, Option<String>, Vec<String>)> {
        match self {
            Self::Plain(r) => read_smtp_reply(r, cmd_timeout).await,
            Self::Tls(r) => read_smtp_reply(r.as_mut(), cmd_timeout).await,
        }
    }

    async fn shutdown(&mut self) {
        match self {
            Self::Plain(r) => {
                let _ = r.get_mut().shutdown().await;
            }
            Self::Tls(r) => {
                let _ = r.get_mut().shutdown().await;
            }
        }
    }
}

struct PooledConnection {
    transport: ClientTransport,
    remote_ip: IpAddr,
    tls_used: bool,
    tls_verified: bool,
    supports_pipelining: bool,
    messages_sent: usize,
    last_used: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PoolKey {
    mx_host: String,
    port: u16,
    bind_ip: Option<IpAddr>,
}

/// Reusable outbound SMTP client pool with cached TLS session resumption.
pub struct OutboundSmtpPool {
    config: OutboundClientConfig,
    strict_connector: TlsConnector,
    opportunistic_connector: TlsConnector,
    idle: Mutex<HashMap<PoolKey, VecDeque<PooledConnection>>>,
}

impl OutboundSmtpPool {
    /// Creates an outbound pool with shared `WebPKI` + TLS session resumption caches.
    #[must_use]
    pub fn new(config: OutboundClientConfig) -> Self {
        Self::with_root_store(config, default_root_store())
    }

    /// Creates an outbound pool with a custom [`RootCertStore`] (useful for testing strict TLS).
    #[must_use]
    pub fn with_root_store(config: OutboundClientConfig, roots: RootCertStore) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let mut strict_cfg = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        strict_cfg.resumption =
            rustls::client::Resumption::store(Arc::new(ClientSessionMemoryCache::new(2048)));

        let mut opp_cfg = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerifyCerts))
            .with_no_client_auth();
        opp_cfg.resumption =
            rustls::client::Resumption::store(Arc::new(ClientSessionMemoryCache::new(2048)));

        Self {
            config,
            strict_connector: TlsConnector::from(Arc::new(strict_cfg)),
            opportunistic_connector: TlsConnector::from(Arc::new(opp_cfg)),
            idle: Mutex::new(HashMap::new()),
        }
    }

    /// Sends a single message to the target MX host, reusing a pooled connection if valid.
    pub async fn deliver(&self, req: &OutboundRequest<'_>) -> AttemptTelemetry {
        let pool_key = PoolKey {
            mx_host: req.mx_host.to_ascii_lowercase(),
            port: req.port,
            bind_ip: req.bind_ip,
        };

        if let Some(telemetry) = self.try_deliver_reused(&pool_key, req).await {
            return telemetry;
        }

        self.deliver_fresh(&pool_key, req).await
    }

    async fn try_deliver_reused(
        &self,
        pool_key: &PoolKey,
        req: &OutboundRequest<'_>,
    ) -> Option<AttemptTelemetry> {
        let mut conn = self.take_idle(pool_key)?;
        let tx_start = Instant::now();
        if conn.transport.write_all_flush(b"RSET\r\n").await.is_ok() {
            if let Ok((250, _, _)) = conn.transport.read_reply(self.config.command_timeout).await {
                let outcome = self
                    .transmit_transaction(&mut conn, req.envelope_from, req.recipient, req.raw_mime)
                    .await;
                let tx_dur = tx_start.elapsed();
                let telemetry = AttemptTelemetry {
                    outcome: outcome.clone(),
                    remote_ip: conn.remote_ip,
                    tls_used: conn.tls_used,
                    tls_verified: conn.tls_verified,
                    connection_reused: true,
                    connect_duration: Duration::ZERO,
                    tls_duration: Duration::ZERO,
                    transaction_duration: tx_dur,
                };
                self.return_or_close(pool_key.clone(), conn, &outcome).await;
                return Some(telemetry);
            }
        }
        conn.transport.shutdown().await;
        None
    }

    async fn deliver_fresh(
        &self,
        pool_key: &PoolKey,
        req: &OutboundRequest<'_>,
    ) -> AttemptTelemetry {
        let connect_start = Instant::now();
        let stream = match connect_tcp(
            SocketAddr::new(req.target_ip, req.port),
            req.bind_ip,
            self.config.connect_timeout,
        )
        .await
        {
            Ok(s) => s,
            Err(err) => {
                return AttemptTelemetry {
                    outcome: DeliveryOutcome::NetworkError {
                        reason: err.to_string(),
                    },
                    remote_ip: req.target_ip,
                    tls_used: false,
                    tls_verified: false,
                    connection_reused: false,
                    connect_duration: connect_start.elapsed(),
                    tls_duration: Duration::ZERO,
                    transaction_duration: Duration::ZERO,
                };
            }
        };
        let connect_duration = connect_start.elapsed();

        let (mut conn, tls_duration, handshake_outcome) =
            match self.establish_session(stream, req).await {
                Ok(ok) => ok,
                Err(outcome) => {
                    return AttemptTelemetry {
                        outcome,
                        remote_ip: req.target_ip,
                        tls_used: false,
                        tls_verified: false,
                        connection_reused: false,
                        connect_duration,
                        tls_duration: Duration::ZERO,
                        transaction_duration: Duration::ZERO,
                    };
                }
            };

        if let Some(early_outcome) = handshake_outcome {
            conn.transport.shutdown().await;
            return AttemptTelemetry {
                outcome: early_outcome,
                remote_ip: req.target_ip,
                tls_used: conn.tls_used,
                tls_verified: conn.tls_verified,
                connection_reused: false,
                connect_duration,
                tls_duration,
                transaction_duration: Duration::ZERO,
            };
        }

        let tx_start = Instant::now();
        let outcome = self
            .transmit_transaction(&mut conn, req.envelope_from, req.recipient, req.raw_mime)
            .await;
        let transaction_duration = tx_start.elapsed();

        let tls_used = conn.tls_used;
        let tls_verified = conn.tls_verified;
        self.return_or_close(pool_key.clone(), conn, &outcome).await;

        AttemptTelemetry {
            outcome,
            remote_ip: req.target_ip,
            tls_used,
            tls_verified,
            connection_reused: false,
            connect_duration,
            tls_duration,
            transaction_duration,
        }
    }

    async fn establish_session(
        &self,
        stream: TcpStream,
        req: &OutboundRequest<'_>,
    ) -> std::result::Result<(PooledConnection, Duration, Option<DeliveryOutcome>), DeliveryOutcome>
    {
        let mut transport = ClientTransport::Plain(BufReader::new(stream));

        let (greet_code, greet_enh, greet_lines) = transport
            .read_reply(self.config.command_timeout)
            .await
            .map_err(|e| DeliveryOutcome::NetworkError {
                reason: format!("greeting failed: {e}"),
            })?;
        if greet_code != 220 {
            let outcome = classify_smtp_error(greet_code, greet_enh, &greet_lines);
            transport.shutdown().await;
            return Err(outcome);
        }

        let (ehlo_code, ehlo_enh, ehlo_lines) = send_ehlo(
            &mut transport,
            &self.config.helo_domain,
            self.config.command_timeout,
        )
        .await
        .map_err(|e| DeliveryOutcome::NetworkError {
            reason: format!("EHLO failed: {e}"),
        })?;
        if ehlo_code != 250 {
            let outcome = classify_smtp_error(ehlo_code, ehlo_enh, &ehlo_lines);
            transport.shutdown().await;
            return Err(outcome);
        }

        let supports_starttls = has_capability(&ehlo_lines, "STARTTLS");
        let mut supports_pipelining = has_capability(&ehlo_lines, "PIPELINING");
        let mut tls_used = false;
        let mut tls_verified = false;
        let mut tls_duration = Duration::ZERO;

        if self.config.tls_policy == OutboundTlsPolicy::Strict && !supports_starttls {
            transport.shutdown().await;
            return Err(DeliveryOutcome::Deferred {
                smtp_code: 454,
                enhanced_code: Some("4.7.5".to_string()),
                message: "Strict TLS required but remote MX did not advertise STARTTLS".to_string(),
                is_throttle: false,
            });
        }

        if supports_starttls {
            let tls_start = Instant::now();
            let (next_transport, upgraded, verified) =
                self.try_negotiate_starttls(transport, req).await?;
            transport = next_transport;
            if upgraded {
                tls_used = true;
                tls_verified = verified;
                tls_duration = tls_start.elapsed();

                let (e2_code, e2_enh, e2_lines) = send_ehlo(
                    &mut transport,
                    &self.config.helo_domain,
                    self.config.command_timeout,
                )
                .await
                .map_err(|e| DeliveryOutcome::NetworkError {
                    reason: format!("post-TLS EHLO failed: {e}"),
                })?;
                if e2_code != 250 {
                    let outcome = classify_smtp_error(e2_code, e2_enh, &e2_lines);
                    return Ok((
                        PooledConnection {
                            transport,
                            remote_ip: req.target_ip,
                            tls_used,
                            tls_verified,
                            supports_pipelining: false,
                            messages_sent: 0,
                            last_used: Instant::now(),
                        },
                        tls_duration,
                        Some(outcome),
                    ));
                }
                supports_pipelining = has_capability(&e2_lines, "PIPELINING");
            }
        }

        Ok((
            PooledConnection {
                transport,
                remote_ip: req.target_ip,
                tls_used,
                tls_verified,
                supports_pipelining,
                messages_sent: 0,
                last_used: Instant::now(),
            },
            tls_duration,
            None,
        ))
    }

    async fn try_negotiate_starttls(
        &self,
        mut transport: ClientTransport,
        req: &OutboundRequest<'_>,
    ) -> std::result::Result<(ClientTransport, bool, bool), DeliveryOutcome> {
        if transport.write_all_flush(b"STARTTLS\r\n").await.is_err() {
            return Ok((transport, false, false));
        }
        let Ok((220, _, _)) = transport.read_reply(self.config.command_timeout).await else {
            return Ok((transport, false, false));
        };

        let server_name = ServerName::try_from(req.mx_host.to_string()).map_err(|_| {
            DeliveryOutcome::NetworkError {
                reason: format!("invalid SNI hostname: {}", req.mx_host),
            }
        })?;

        let ClientTransport::Plain(reader) = transport else {
            unreachable!();
        };
        let tcp = reader.into_inner();

        match timeout(
            self.config.command_timeout,
            self.strict_connector.connect(server_name.clone(), tcp),
        )
        .await
        {
            Ok(Ok(tls_stream)) => Ok((
                ClientTransport::Tls(Box::new(BufReader::new(tls_stream))),
                true,
                true,
            )),
            Ok(Err(err)) => {
                if self.config.tls_policy == OutboundTlsPolicy::Strict {
                    return Err(DeliveryOutcome::Deferred {
                        smtp_code: 454,
                        enhanced_code: Some("4.7.5".to_string()),
                        message: format!("Strict TLS verification failed: {err}"),
                        is_throttle: false,
                    });
                }
                // Reconnect and encrypt opportunistically without WebPKI verification
                let tcp2 = connect_tcp(
                    SocketAddr::new(req.target_ip, req.port),
                    req.bind_ip,
                    self.config.connect_timeout,
                )
                .await
                .map_err(|e| DeliveryOutcome::NetworkError {
                    reason: e.to_string(),
                })?;
                let mut opp_plain = ClientTransport::Plain(BufReader::new(tcp2));
                let _ = opp_plain.read_reply(self.config.command_timeout).await;
                let _ = send_ehlo(
                    &mut opp_plain,
                    &self.config.helo_domain,
                    self.config.command_timeout,
                )
                .await;
                let _ = opp_plain.write_all_flush(b"STARTTLS\r\n").await;
                let _ = opp_plain.read_reply(self.config.command_timeout).await;
                let ClientTransport::Plain(r2) = opp_plain else {
                    unreachable!();
                };
                let tls_stream = timeout(
                    self.config.command_timeout,
                    self.opportunistic_connector
                        .connect(server_name, r2.into_inner()),
                )
                .await
                .map_err(|_| DeliveryOutcome::NetworkError {
                    reason: "TLS handshake timed out".to_string(),
                })?
                .map_err(|e| DeliveryOutcome::NetworkError {
                    reason: format!("Opportunistic TLS handshake failed: {e}"),
                })?;
                Ok((
                    ClientTransport::Tls(Box::new(BufReader::new(tls_stream))),
                    true,
                    false,
                ))
            }
            Err(_) => Err(DeliveryOutcome::NetworkError {
                reason: "STARTTLS handshake timed out".to_string(),
            }),
        }
    }

    async fn send_pipelined_envelope(
        &self,
        conn: &mut PooledConnection,
        mail_cmd: &str,
        rcpt_cmd: &str,
    ) -> Option<DeliveryOutcome> {
        let mut batch = Vec::with_capacity(mail_cmd.len() + rcpt_cmd.len() + 6);
        batch.extend_from_slice(mail_cmd.as_bytes());
        batch.extend_from_slice(rcpt_cmd.as_bytes());
        batch.extend_from_slice(b"DATA\r\n");

        if let Err(e) = conn.transport.write_all_flush(&batch).await {
            return Some(DeliveryOutcome::NetworkError {
                reason: e.to_string(),
            });
        }

        let mail_res = conn.transport.read_reply(self.config.command_timeout).await;
        let rcpt_res = conn.transport.read_reply(self.config.command_timeout).await;
        let data_res = conn.transport.read_reply(self.config.command_timeout).await;

        for res in [mail_res, rcpt_res] {
            match res {
                Ok((c, enh, lines)) if !(200..300).contains(&c) => {
                    return Some(classify_smtp_error(c, enh, &lines));
                }
                Err(e) => {
                    return Some(DeliveryOutcome::NetworkError {
                        reason: e.to_string(),
                    });
                }
                _ => {}
            }
        }
        match data_res {
            Ok((354, _, _)) => None,
            Ok((c, enh, lines)) => Some(classify_smtp_error(c, enh, &lines)),
            Err(e) => Some(DeliveryOutcome::NetworkError {
                reason: e.to_string(),
            }),
        }
    }

    async fn transmit_transaction(
        &self,
        conn: &mut PooledConnection,
        envelope_from: &str,
        recipient: &str,
        raw_mime: &[u8],
    ) -> DeliveryOutcome {
        if envelope_from.contains(['\r', '\n', '\0']) || recipient.contains(['\r', '\n', '\0']) {
            return DeliveryOutcome::Bounced {
                smtp_code: 553,
                enhanced_code: Some("5.1.3".to_string()),
                message: "Invalid CRLF characters in envelope address".to_string(),
            };
        }
        let mail_cmd = format!("MAIL FROM:<{envelope_from}>\r\n");
        let rcpt_cmd = format!("RCPT TO:<{recipient}>\r\n");

        if conn.supports_pipelining {
            if let Some(outcome) = self
                .send_pipelined_envelope(conn, &mail_cmd, &rcpt_cmd)
                .await
            {
                return outcome;
            }
        } else {
            for (cmd, expected) in [
                (mail_cmd.as_bytes(), 250_u16),
                (rcpt_cmd.as_bytes(), 250_u16),
                (b"DATA\r\n".as_slice(), 354_u16),
            ] {
                if let Err(e) = conn.transport.write_all_flush(cmd).await {
                    return DeliveryOutcome::NetworkError {
                        reason: e.to_string(),
                    };
                }
                match conn.transport.read_reply(self.config.command_timeout).await {
                    Ok((c, _, _))
                        if c == expected || (expected == 250 && (200..300).contains(&c)) => {}
                    Ok((c, enh, lines)) => return classify_smtp_error(c, enh, &lines),
                    Err(e) => {
                        return DeliveryOutcome::NetworkError {
                            reason: e.to_string(),
                        }
                    }
                }
            }
        }

        let stuffed = dot_stuff_payload(raw_mime);
        match timeout(
            self.config.data_timeout,
            conn.transport.write_all_flush(&stuffed),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                return DeliveryOutcome::NetworkError {
                    reason: format!("DATA write failed: {e}"),
                };
            }
            Err(_) => {
                return DeliveryOutcome::NetworkError {
                    reason: "DATA write timed out".to_string(),
                };
            }
        }

        match conn.transport.read_reply(self.config.data_timeout).await {
            Ok((c, enh, lines)) if (200..300).contains(&c) => {
                conn.messages_sent += 1;
                conn.last_used = Instant::now();
                DeliveryOutcome::Accepted {
                    smtp_code: c,
                    enhanced_code: enh,
                    message: lines.join(" "),
                }
            }
            Ok((c, enh, lines)) => classify_smtp_error(c, enh, &lines),
            Err(e) => DeliveryOutcome::AmbiguousPostData {
                reason: format!("post-DATA reply error: {e}"),
            },
        }
    }

    fn take_idle(&self, key: &PoolKey) -> Option<PooledConnection> {
        let now = Instant::now();
        let mut guard = self.idle.lock().ok()?;
        if guard.len() > 256 {
            guard.retain(|_, q| {
                q.retain(|c| now.duration_since(c.last_used) < self.config.idle_ttl);
                !q.is_empty()
            });
        }
        let queue = guard.get_mut(key)?;
        while let Some(conn) = queue.pop_front() {
            if now.duration_since(conn.last_used) < self.config.idle_ttl
                && conn.messages_sent < self.config.max_messages_per_conn
            {
                return Some(conn);
            }
        }
        None
    }

    async fn return_or_close(
        &self,
        key: PoolKey,
        mut conn: PooledConnection,
        outcome: &DeliveryOutcome,
    ) {
        let reusable = matches!(outcome, DeliveryOutcome::Accepted { .. })
            && conn.messages_sent < self.config.max_messages_per_conn;

        if reusable {
            let returned = if let Ok(mut guard) = self.idle.lock() {
                let queue = guard.entry(key).or_default();
                if queue.len() < self.config.max_idle_per_host {
                    queue.push_back(conn);
                    return;
                }
                Some(conn)
            } else {
                Some(conn)
            };
            if let Some(mut overflow) = returned {
                let _ = overflow.transport.write_all_flush(b"QUIT\r\n").await;
                overflow.transport.shutdown().await;
            }
            return;
        }

        if !matches!(
            outcome,
            DeliveryOutcome::NetworkError { .. } | DeliveryOutcome::AmbiguousPostData { .. }
        ) {
            let _ = conn.transport.write_all_flush(b"QUIT\r\n").await;
        }
        conn.transport.shutdown().await;
    }
}

fn default_root_store() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots
}

async fn connect_tcp(
    addr: SocketAddr,
    bind_ip: Option<IpAddr>,
    connect_timeout: Duration,
) -> std::io::Result<TcpStream> {
    let socket = match addr {
        SocketAddr::V4(_) => TcpSocket::new_v4()?,
        SocketAddr::V6(_) => TcpSocket::new_v6()?,
    };
    if let Some(ip) = bind_ip {
        socket.bind(SocketAddr::new(ip, 0))?;
    }
    timeout(connect_timeout, socket.connect(addr))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "TCP connect timed out"))?
}

async fn send_ehlo(
    transport: &mut ClientTransport,
    helo_domain: &str,
    cmd_timeout: Duration,
) -> Result<(u16, Option<String>, Vec<String>)> {
    let cmd = format!("EHLO {helo_domain}\r\n");
    transport.write_all_flush(cmd.as_bytes()).await?;
    transport.read_reply(cmd_timeout).await
}

fn has_capability(lines: &[String], cap: &str) -> bool {
    let upper = cap.to_ascii_uppercase();
    lines
        .iter()
        .skip(1)
        .any(|l| l.to_ascii_uppercase().split_whitespace().next() == Some(upper.as_str()))
}

async fn read_smtp_reply<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    cmd_timeout: Duration,
) -> Result<(u16, Option<String>, Vec<String>)> {
    let mut lines = Vec::new();
    let mut code = 0_u16;
    let mut enhanced = None;

    loop {
        let mut line = String::new();
        let n = timeout(cmd_timeout, reader.read_line(&mut line))
            .await
            .map_err(|_| anyhow::anyhow!("SMTP reply timed out"))??;
        if n == 0 {
            bail!("unexpected EOF reading SMTP reply");
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.len() < 3 {
            bail!("malformed SMTP reply line: {trimmed}");
        }
        let line_code: u16 = trimmed[..3].parse()?;
        if code == 0 {
            code = line_code;
        }
        let sep = trimmed.as_bytes().get(3).copied().unwrap_or(b' ');
        let rest = trimmed.get(4..).unwrap_or("");
        let (enh, msg) = extract_enhanced_code(rest);
        if enhanced.is_none() {
            enhanced = enh;
        }
        lines.push(msg.to_string());
        if sep == b' ' {
            break;
        }
    }

    Ok((code, enhanced, lines))
}

fn extract_enhanced_code(rest: &str) -> (Option<String>, &str) {
    let Some((first, tail)) = rest.split_once(' ') else {
        return (None, rest);
    };
    let parts: Vec<&str> = first.split('.').collect();
    if parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        (Some(first.to_string()), tail)
    } else {
        (None, rest)
    }
}

/// Performs RFC 5321 Section 4.5.2 dot-stuffing and appends `<CRLF>.<CRLF>`.
#[must_use]
pub fn dot_stuff_payload(raw_mime: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw_mime.len() + 32);
    let mut at_line_start = true;
    let mut ended_with_crlf = false;

    for (i, &b) in raw_mime.iter().enumerate() {
        if at_line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        at_line_start = b == b'\n';
        ended_with_crlf = i > 0 && raw_mime[i - 1] == b'\r' && b == b'\n';
    }

    if !raw_mime.is_empty() && !ended_with_crlf {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

fn classify_smtp_error(code: u16, enhanced: Option<String>, lines: &[String]) -> DeliveryOutcome {
    let msg = lines.join(" ");
    let lower = msg.to_ascii_lowercase();
    let is_throttle = code == 421
        || enhanced.as_deref() == Some("4.7.0")
        || lower.contains("rate")
        || lower.contains("throttl")
        || lower.contains("too many")
        || lower.contains("try again later");

    if (400..500).contains(&code) {
        DeliveryOutcome::Deferred {
            smtp_code: code,
            enhanced_code: enhanced,
            message: msg,
            is_throttle,
        }
    } else {
        DeliveryOutcome::Bounced {
            smtp_code: code,
            enhanced_code: enhanced,
            message: msg,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use observability::MetricsRegistry;
    use smtp_protocol::SessionConfig;
    use smtp_server::{
        build_tls_acceptor_from_pem, serve_listener, ListenerTlsMode, SmtpServerConfig,
    };
    use smtp_session::{ReceivedMessage, SessionContext, SessionHandler};
    use tokio::net::TcpListener;
    use tokio::sync::watch;

    use super::*;

    struct Sink {
        count: AtomicUsize,
        last_body: Mutex<Vec<u8>>,
    }

    impl Sink {
        fn new() -> Self {
            Self {
                count: AtomicUsize::new(0),
                last_body: Mutex::new(Vec::new()),
            }
        }
    }

    impl SessionHandler for Sink {
        fn on_message(
            &self,
            _ctx: &SessionContext,
            message: ReceivedMessage,
        ) -> impl std::future::Future<
            Output = Result<smtp_protocol::SmtpResponse, smtp_protocol::SmtpResponse>,
        > + Send {
            self.count.fetch_add(1, Ordering::SeqCst);
            *self.last_body.lock().unwrap() = message.data;
            std::future::ready(Ok(smtp_protocol::SmtpResponse::ok("2.0.0 Delivered")))
        }
    }

    #[tokio::test]
    async fn delivers_with_starttls_dot_stuffing_and_reuses_pooled_connection() {
        let cert = rcgen::generate_simple_self_signed(vec!["mx.remote.test".to_string()]).unwrap();
        let acceptor = build_tls_acceptor_from_pem(
            cert.cert.pem().as_bytes(),
            cert.key_pair.serialize_pem().as_bytes(),
        )
        .unwrap();

        let mut roots = RootCertStore::empty();
        roots.add(cert.cert.der().clone()).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let sink = Arc::new(Sink::new());
        let (tx, rx) = watch::channel(false);

        let srv = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                session_config: SessionConfig {
                    server_domain: "mx.remote.test".to_string(),
                    advertise_starttls: true,
                    ..SessionConfig::default()
                },
                tls_mode: ListenerTlsMode::StartTls(acceptor),
                ..SmtpServerConfig::default()
            },
            Arc::clone(&sink),
            Arc::new(MetricsRegistry::new().unwrap()),
            rx,
        ));

        let pool = OutboundSmtpPool::with_root_store(
            OutboundClientConfig {
                tls_policy: OutboundTlsPolicy::Strict,
                ..OutboundClientConfig::default()
            },
            roots,
        );

        let body = b"Subject: DotTest\r\n\r\n.first line starts with dot\r\n";
        let t1 = pool
            .deliver(&OutboundRequest {
                mx_host: "mx.remote.test",
                target_ip: addr.ip(),
                port: addr.port(),
                bind_ip: None,
                envelope_from: "sender@platform.test",
                recipient: "user@remote.test",
                raw_mime: body,
            })
            .await;

        assert!(matches!(
            t1.outcome,
            DeliveryOutcome::Accepted { smtp_code: 250, .. }
        ));
        assert!(t1.tls_used);
        assert!(t1.tls_verified);
        assert!(!t1.connection_reused);
        assert_eq!(sink.last_body.lock().unwrap().as_slice(), body);

        let t2 = pool
            .deliver(&OutboundRequest {
                mx_host: "mx.remote.test",
                target_ip: addr.ip(),
                port: addr.port(),
                bind_ip: None,
                envelope_from: "sender@platform.test",
                recipient: "user2@remote.test",
                raw_mime: body,
            })
            .await;
        assert!(matches!(
            t2.outcome,
            DeliveryOutcome::Accepted { smtp_code: 250, .. }
        ));
        assert!(t2.connection_reused);
        assert_eq!(sink.count.load(Ordering::SeqCst), 2);

        let _ = tx.send(true);
        srv.await.unwrap().unwrap();
    }
}
