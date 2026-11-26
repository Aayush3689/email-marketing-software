//! Bounded async TCP/TLS listener and graceful connection draining for SMTP ports 25, 587, and 465.

use std::io::BufReader;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use observability::MetricsRegistry;
use rate_limiter::IngressRateLimiter;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use smtp_protocol::{SessionConfig, SmtpResponse};
use smtp_session::{run_session, SessionHandler, SessionStream, SessionTimeouts};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::timeout;
pub use tokio_rustls::TlsAcceptor;
use tracing::{error, info, warn};

/// TLS mode for an SMTP listener port.
#[derive(Clone)]
pub enum ListenerTlsMode {
    /// Unencrypted only (local test or plaintext port 25 without cert).
    Plain,
    /// Starts plaintext, upgrades via `STARTTLS` (ports 25 and 587).
    StartTls(TlsAcceptor),
    /// Immediate TLS handshake on TCP accept (port 465).
    ImplicitTls(TlsAcceptor),
}

/// Configuration for a single TCP SMTP listener (e.g., port 25, 587, or 465).
#[derive(Clone)]
pub struct SmtpServerConfig {
    pub bind_addr: SocketAddr,
    pub max_connections: usize,
    pub session_config: SessionConfig,
    pub timeouts: SessionTimeouts,
    pub tls_mode: ListenerTlsMode,
    pub rate_limiter: Option<IngressRateLimiter>,
    pub draining: Option<Arc<AtomicBool>>,
}

impl Default for SmtpServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: SocketAddr::from(([127, 0, 0, 1], 2525)),
            max_connections: 1024,
            session_config: SessionConfig::default(),
            timeouts: SessionTimeouts::default(),
            tls_mode: ListenerTlsMode::Plain,
            rate_limiter: None,
            draining: None,
        }
    }
}

/// Builds a [`TlsAcceptor`] from PEM-encoded certificate chain and PKCS#8/RSA/EC private key bytes.
///
/// # Errors
/// Returns an error if PEM parsing fails, no certificate/key is present, or `rustls` rejects the config.
pub fn build_tls_acceptor_from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<TlsAcceptor> {
    let mut cert_reader = BufReader::new(cert_pem);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_reader)
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("failed to parse PEM certificates")?;
    if certs.is_empty() {
        bail!("no certificates found in PEM input");
    }

    let mut key_reader = BufReader::new(key_pem);
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)
        .context("failed to parse PEM private key")?
        .context("no private key found in PEM input")?;

    let _ = rustls::crypto::ring::default_provider().install_default();

    let server_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("failed to build rustls ServerConfig")?;

    Ok(TlsAcceptor::from(Arc::new(server_config)))
}

/// Runs an SMTP TCP/TLS listener until `shutdown` becomes `true`,
/// then drains active connection tasks gracefully.
///
/// # Errors
/// Returns an error if reading the bound local address fails.
pub async fn serve_listener<H>(
    listener: TcpListener,
    config: SmtpServerConfig,
    handler: Arc<H>,
    metrics: Arc<MetricsRegistry>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()>
where
    H: SessionHandler + 'static,
{
    let semaphore = Arc::new(Semaphore::new(config.max_connections));
    let mut tasks = JoinSet::new();

    info!(
        bind_addr = %listener.local_addr()?,
        max_connections = config.max_connections,
        "SMTP listener started"
    );

    loop {
        tokio::select! {
            accept_res = listener.accept() => {
                match accept_res {
                    Ok((stream, peer_addr)) => {
                        if config
                            .draining
                            .as_ref()
                            .is_some_and(|d| d.load(Ordering::Relaxed))
                        {
                            warn!(%peer_addr, "Rejecting new SMTP connection while node is draining");
                            tokio::spawn(reject_over_capacity(
                                stream,
                                "MTA node draining; try another MX",
                            ));
                            continue;
                        }
                        let ip_guard = if let Some(limiter) = &config.rate_limiter {
                            if let Some(g) = limiter.try_acquire_connection(peer_addr.ip()) {
                                Some(g)
                            } else {
                                warn!(%peer_addr, "Per-IP concurrent SMTP connection limit exceeded");
                                tokio::spawn(reject_over_capacity(
                                    stream,
                                    "Too many concurrent connections from your IP",
                                ));
                                continue;
                            }
                        } else {
                            None
                        };

                        if let Ok(permit) = semaphore.clone().try_acquire_owned() {
                            let handler_ref = Arc::clone(&handler);
                            let metrics_ref = Arc::clone(&metrics);
                            let cfg_clone = config.clone();
                            let shutdown_rx = shutdown.clone();

                            metrics_ref.smtp_active_connections.inc();
                            tasks.spawn(async move {
                                let _permit = permit;
                                let _ip_guard = ip_guard;
                                handle_accepted_stream(
                                    stream,
                                    peer_addr,
                                    cfg_clone,
                                    handler_ref,
                                    metrics_ref,
                                    shutdown_rx,
                                )
                                .await;
                            });
                        } else {
                            drop(ip_guard);
                            warn!(%peer_addr, "Max concurrent SMTP connections reached; rejecting");
                            tokio::spawn(reject_over_capacity(
                                stream,
                                "Too many concurrent connections; try again later",
                            ));
                        }
                    }
                    Err(err) => error!(error = %err, "TCP accept error"),
                }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    info!("SMTP listener draining {} active connection(s)", tasks.len());
                    break;
                }
            }
        }
    }

    while tasks.join_next().await.is_some() {}
    info!("SMTP listener stopped cleanly");
    Ok(())
}

async fn handle_accepted_stream<H: SessionHandler>(
    stream: TcpStream,
    peer_addr: SocketAddr,
    config: SmtpServerConfig,
    handler: Arc<H>,
    metrics: Arc<MetricsRegistry>,
    shutdown_rx: watch::Receiver<bool>,
) {
    let (session_stream, starttls_acceptor) = match config.tls_mode {
        ListenerTlsMode::Plain => (SessionStream::Plain(stream), None),
        ListenerTlsMode::StartTls(acc) => (SessionStream::Plain(stream), Some(acc)),
        ListenerTlsMode::ImplicitTls(acc) => {
            match timeout(config.timeouts.tls_handshake, acc.accept(stream)).await {
                Ok(Ok(tls)) => (SessionStream::Tls(Box::new(tls)), None),
                Ok(Err(err)) => {
                    warn!(%peer_addr, error = %err, "Implicit TLS handshake failed");
                    metrics.smtp_active_connections.dec();
                    return;
                }
                Err(_) => {
                    warn!(%peer_addr, "Implicit TLS handshake timed out");
                    metrics.smtp_active_connections.dec();
                    return;
                }
            }
        }
    };

    if let Err(err) = run_session(
        session_stream,
        peer_addr,
        config.session_config,
        config.timeouts,
        starttls_acceptor,
        handler.as_ref(),
        shutdown_rx,
    )
    .await
    {
        warn!(%peer_addr, error = %err, "SMTP session terminated with I/O error");
    }
    metrics.smtp_active_connections.dec();
}

async fn reject_over_capacity(mut stream: TcpStream, reason: &str) {
    let resp = SmtpResponse::service_unavailable(reason);
    let _ = stream.write_all(&resp.encode()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use smtp_session::{ReceivedMessage, SessionContext};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::*;

    #[derive(Default)]
    struct CaptureHandler {
        messages: Mutex<Vec<ReceivedMessage>>,
    }

    impl SessionHandler for CaptureHandler {
        fn on_message(
            &self,
            _ctx: &SessionContext,
            message: ReceivedMessage,
        ) -> impl std::future::Future<Output = Result<SmtpResponse, SmtpResponse>> + Send {
            self.messages.lock().unwrap().push(message);
            std::future::ready(Ok(SmtpResponse::ok("2.0.0 Queued test")))
        }
    }

    async fn read_line_crlf<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> String {
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read line");
        line
    }

    #[tokio::test]
    async fn handles_fragmented_and_pipelined_tcp_smtp_sessions() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let handler = Arc::new(CaptureHandler::default());
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let srv_handler = Arc::clone(&handler);
        let server_task = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                max_connections: 4,
                session_config: SessionConfig {
                    server_domain: "mx.test.local".to_string(),
                    ..SessionConfig::default()
                },
                ..SmtpServerConfig::default()
            },
            srv_handler,
            metrics,
            shutdown_rx,
        ));

        let stream = TcpStream::connect(addr).await.unwrap();
        let (r, mut w) = stream.into_split();
        let mut reader = BufReader::new(r);

        assert!(read_line_crlf(&mut reader)
            .await
            .starts_with("220 mx.test.local"));

        for b in b"EHLO sender.test\r\n".chunks(1) {
            w.write_all(b).await.unwrap();
        }
        loop {
            let line = read_line_crlf(&mut reader).await;
            if line.starts_with("250 ") {
                break;
            }
            assert!(line.starts_with("250-"));
        }

        let pipelined = concat!(
            "MAIL FROM:<alice@sender.test>\r\n",
            "RCPT TO:<bob@hosted.test>\r\n",
            "DATA\r\n",
            "Subject: Pipelined\r\n",
            "\r\n",
            "..dot line\r\n",
            ".\r\n",
            "QUIT\r\n"
        );
        w.write_all(pipelined.as_bytes()).await.unwrap();
        w.flush().await.unwrap();

        assert!(read_line_crlf(&mut reader).await.starts_with("250 "));
        assert!(read_line_crlf(&mut reader).await.starts_with("250 "));
        assert!(read_line_crlf(&mut reader).await.starts_with("354 "));
        assert!(read_line_crlf(&mut reader).await.starts_with("250 "));
        assert!(read_line_crlf(&mut reader).await.starts_with("221 "));

        {
            let captured = handler.messages.lock().unwrap();
            assert_eq!(captured.len(), 1);
            assert_eq!(
                captured[0].reverse_path.as_deref(),
                Some("alice@sender.test")
            );
            assert_eq!(captured[0].recipients, vec!["bob@hosted.test"]);
            assert_eq!(captured[0].data, b"Subject: Pipelined\r\n\r\n.dot line\r\n");
        }

        let _ = shutdown_tx.send(true);
        server_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn enforces_connection_limit_and_idle_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let handler = Arc::new(CaptureHandler::default());
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let server_task = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                max_connections: 1,
                timeouts: SessionTimeouts {
                    command_idle: Duration::from_millis(120),
                    data_idle: Duration::from_millis(120),
                    tls_handshake: Duration::from_secs(5),
                },
                ..SmtpServerConfig::default()
            },
            handler,
            metrics,
            shutdown_rx,
        ));

        let s1 = TcpStream::connect(addr).await.unwrap();
        let mut r1 = BufReader::new(s1);
        assert!(read_line_crlf(&mut r1).await.starts_with("220 "));

        let s2 = TcpStream::connect(addr).await.unwrap();
        let mut r2 = BufReader::new(s2);
        assert!(read_line_crlf(&mut r2).await.starts_with("421 "));
        assert!(read_line_crlf(&mut r1).await.starts_with("421 "));

        let _ = shutdown_tx.send(true);
        server_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn draining_rejects_new_connections_while_inflight_completes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let handler = Arc::new(CaptureHandler::default());
        let metrics = Arc::new(MetricsRegistry::new().unwrap());
        let draining = Arc::new(AtomicBool::new(false));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let srv_handler = Arc::clone(&handler);
        let server_task = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                max_connections: 4,
                draining: Some(Arc::clone(&draining)),
                ..SmtpServerConfig::default()
            },
            srv_handler,
            metrics,
            shutdown_rx,
        ));

        let s1 = TcpStream::connect(addr).await.unwrap();
        let (r1, mut w1) = s1.into_split();
        let mut reader1 = BufReader::new(r1);
        assert!(read_line_crlf(&mut reader1).await.starts_with("220 "));

        // Trigger node draining while s1 is mid-transaction
        draining.store(true, Ordering::SeqCst);

        // New connection s2 must be rejected immediately with 421
        let s2 = TcpStream::connect(addr).await.unwrap();
        let mut reader2 = BufReader::new(s2);
        let line2 = read_line_crlf(&mut reader2).await;
        assert!(line2.starts_with("421 "));
        assert!(line2.contains("draining"));

        // Existing session s1 finishes cleanly
        w1.write_all(b"EHLO client.test\r\n").await.unwrap();
        loop {
            let line = read_line_crlf(&mut reader1).await;
            if line.starts_with("250 ") {
                break;
            }
        }
        w1.write_all(
            b"MAIL FROM:<a@client.test>\r\nRCPT TO:<b@hosted.test>\r\nDATA\r\nSubject: Inflight\r\n\r\nBody\r\n.\r\nQUIT\r\n",
        )
        .await
        .unwrap();
        assert!(read_line_crlf(&mut reader1).await.starts_with("250 "));
        assert!(read_line_crlf(&mut reader1).await.starts_with("250 "));
        assert!(read_line_crlf(&mut reader1).await.starts_with("354 "));
        assert!(read_line_crlf(&mut reader1).await.starts_with("250 "));
        assert!(read_line_crlf(&mut reader1).await.starts_with("221 "));

        assert_eq!(handler.messages.lock().unwrap().len(), 1);
        let _ = shutdown_tx.send(true);
        server_task.await.unwrap().unwrap();
    }
}
