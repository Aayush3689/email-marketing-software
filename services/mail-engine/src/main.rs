//! Core Rust Mail Transfer Agent entrypoint.
//!
//! Supports modular role selection (`ingress`, `outbound`, `inbound`) so a single binary
//! runs unified in single-node cloud deployments or scales horizontally as independent worker pools.

mod outbound_runner;
mod state_store;
mod storage_and_dkim;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHasher};
use auth_verification::InboundAuthVerifier;
use delivery_engine::{DeliveryEngine, DeliveryEngineConfig, DeliveryPoolKind};
use dkim::{DkimKeyRing, KeyEncryptionKeyRing};
use dns_resolver::{DnsCacheConfig, HickoryDnsResolver};
use mailbox_client::{DovecotLmtpClient, LmtpClientConfig};
use message_storage::{LocalSpoolStore, S3Config, S3MessageStore, SpoolStorage};
use observability::{init_tracing, MetricsRegistry};
use outbound_runner::{
    run_rabbitmq_inbound_consumer, run_rabbitmq_outbound_consumer, PipelineMessageSink,
};
use queue_engine::{RabbitMqClient, QUEUE_OUTBOUND_BULK, QUEUE_OUTBOUND_RETRY, QUEUE_OUTBOUND_TX};
use rand::rngs::OsRng;
use rate_limiter::{IngressRateLimiter, RateLimitConfig};
use smtp_inbound::{
    CredentialRecord, InMemoryCredentialStore, InMemoryDomainDirectory, InboundProcessor,
    IngressPolicyHandler, ListenerRole,
};
use smtp_outbound::{OutboundClientConfig, OutboundSmtpPool};
use smtp_protocol::SessionConfig;
use smtp_server::{
    build_tls_acceptor_from_pem, serve_listener, ListenerTlsMode, SmtpServerConfig, TlsAcceptor,
};
use smtp_session::SessionTimeouts;
use sqlx::postgres::PgPoolOptions;
use state_store::{
    load_or_seed_dkim_keys, reload_dkim_keys_from_db, EngineDeliveryStateStore, PgCredentialStore,
    PgDomainDirectory, PgFeedbackStore,
};
use storage_and_dkim::DkimSigningStore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::signal;
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{info, warn};

const DEFAULT_DEV_DKIM_KEK_HEX: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[derive(Debug, Clone)]
struct EngineConfig {
    node_id: String,
    roles: Vec<String>,
    primary_domain: Option<String>,
    helo_domain: String,
    smtp_port_25: u16,
    smtp_port_587: u16,
    smtp_port_465: u16,
    dovecot_lmtp_host: String,
    dovecot_lmtp_port: u16,
    metrics_port: u16,
    control_token: Option<String>,
    server_domain: String,
    tls_cert_path: Option<String>,
    tls_key_path: Option<String>,
    spool_backend: String,
    spool_dir: String,
    s3_endpoint: Option<String>,
    s3_region: String,
    s3_bucket: String,
    s3_access_key: String,
    s3_secret_key: String,
    database_url: Option<String>,
    rabbitmq_url: Option<String>,
    dkim_selector: String,
    is_production: bool,
    dkim_auto_generate: bool,
    smtp_auth_user: Option<String>,
    smtp_auth_pass: Option<String>,
}

impl EngineConfig {
    fn from_env() -> Result<Self> {
        let primary_domain = env_opt("PRIMARY_DOMAIN");
        let default_domain = primary_domain
            .as_deref()
            .map_or_else(|| "mail.localhost".to_string(), |d| format!("mx1.{d}"));
        let server_domain = env_opt("SMTP_SERVER_DOMAIN").unwrap_or_else(|| default_domain.clone());
        let helo_domain = env_opt("MAIL_HELO_DOMAIN").unwrap_or_else(|| server_domain.clone());
        let control_token = env_opt("MAIL_ENGINE_CONTROL_TOKEN");

        let is_prod = env_opt("NODE_ENV").is_some_and(|v| v.eq_ignore_ascii_case("production"));
        // Validate versioned DKIM KEK ring early on startup without storing raw hex secrets
        let _ = KeyEncryptionKeyRing::from_env_vars(is_prod, DEFAULT_DEV_DKIM_KEK_HEX)?;
        if is_prod && control_token.is_none() {
            anyhow::bail!("MAIL_ENGINE_CONTROL_TOKEN must be set in production");
        }

        Ok(Self {
            node_id: env_opt("MAIL_ENGINE_NODE_ID").unwrap_or_else(|| "mta-local-1".to_string()),
            roles: env_opt("MAIL_ENGINE_ROLES")
                .unwrap_or_else(|| "ingress,outbound,inbound".to_string())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            primary_domain,
            helo_domain,
            smtp_port_25: parse_port("SMTP_PORT_25", 2525),
            smtp_port_587: parse_port("SMTP_PORT_587", 2587),
            smtp_port_465: parse_port("SMTP_PORT_465", 2465),
            dovecot_lmtp_host: env_opt("DOVECOT_LMTP_HOST")
                .unwrap_or_else(|| "127.0.0.1".to_string()),
            dovecot_lmtp_port: parse_port("DOVECOT_LMTP_PORT", 24),
            metrics_port: parse_port("METRICS_PORT", 9100),
            control_token,
            server_domain,
            tls_cert_path: env_opt("TLS_CERT_PATH"),
            tls_key_path: env_opt("TLS_KEY_PATH"),
            spool_backend: env_opt("SPOOL_BACKEND").unwrap_or_else(|| "local".to_string()),
            spool_dir: env_opt("SPOOL_DIR").unwrap_or_else(|| "/var/spool/mailplat".to_string()),
            s3_endpoint: env_opt("S3_ENDPOINT"),
            s3_region: env_opt("S3_REGION").unwrap_or_else(|| "us-east-1".to_string()),
            s3_bucket: env_opt("S3_BUCKET").unwrap_or_else(|| "mail-spool".to_string()),
            s3_access_key: env_opt("S3_ACCESS_KEY").unwrap_or_default(),
            s3_secret_key: env_opt("S3_SECRET_KEY").unwrap_or_default(),
            database_url: env_opt("DATABASE_URL"),
            rabbitmq_url: env_opt("RABBITMQ_URL"),
            dkim_selector: env_opt("DKIM_SELECTOR").unwrap_or_else(|| "mp1".to_string()),
            is_production: is_prod,
            dkim_auto_generate: env_opt("DKIM_AUTO_GENERATE")
                .is_none_or(|v| v != "false" && v != "0"),
            smtp_auth_user: env_opt("SMTP_AUTH_USERNAME"),
            smtp_auth_pass: env_opt("SMTP_AUTH_PASSWORD"),
        })
    }

    fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r.eq_ignore_ascii_case(role))
    }
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

fn parse_port(key: &str, default: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing("mail-engine");
    let config = EngineConfig::from_env()?;
    let metrics = Arc::new(MetricsRegistry::new()?);

    info!(
        node_id = %config.node_id,
        roles = ?config.roles,
        helo_domain = %config.helo_domain,
        spool_backend = %config.spool_backend,
        "Rust mail-engine initialized"
    );
    metrics.record_node_boot(&config.node_id);

    let raw_storage = Arc::new(build_spool_storage(&config).await?);
    let (pg_pool, rmq_client) = connect_infra(&config).await?;
    let (keyring, signing_storage) =
        initialize_dkim(&config, &raw_storage, pg_pool.as_ref(), &metrics).await?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let draining = Arc::new(AtomicBool::new(false));
    let mut handles: Vec<JoinHandle<Result<()>>> = Vec::new();

    let metrics_listener =
        TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], config.metrics_port))).await?;
    handles.push(tokio::spawn(serve_control_and_metrics(
        metrics_listener,
        config.clone(),
        Arc::clone(&metrics),
        Arc::clone(&draining),
        Arc::clone(&keyring),
        Arc::clone(&signing_storage),
        pg_pool.clone(),
        shutdown_rx.clone(),
    )));

    let pub_channel = if let Some(rmq) = &rmq_client {
        Some(Arc::new(Mutex::new(rmq.create_confirm_channel().await?)))
    } else {
        None
    };

    let fallback_dir = Arc::new(InMemoryDomainDirectory::default());
    let domain_dir = Arc::new(PgDomainDirectory::new(
        pg_pool.clone(),
        config.dovecot_lmtp_host.clone(),
        config.dovecot_lmtp_port,
        fallback_dir,
    ));

    if config.has_role("ingress") {
        spawn_ingress_listeners(
            &config,
            &raw_storage,
            pg_pool.as_ref(),
            &domain_dir,
            pub_channel.as_ref(),
            &metrics,
            &draining,
            &shutdown_rx,
            &mut handles,
        )
        .await?;
    }

    if config.has_role("inbound") {
        spawn_inbound_pipeline(
            &config,
            rmq_client.as_ref(),
            pg_pool.as_ref(),
            &domain_dir,
            &raw_storage,
            &shutdown_rx,
            &mut handles,
        );
    }

    if config.has_role("outbound") {
        spawn_outbound_pipeline(
            &config,
            Arc::clone(&signing_storage),
            pg_pool,
            rmq_client,
            &metrics,
            &draining,
            &shutdown_rx,
            &mut handles,
        );
    }

    signal::ctrl_c().await?;
    info!(node_id = %config.node_id, "Graceful shutdown signal received");
    draining.store(true, Ordering::SeqCst);
    let _ = shutdown_tx.send(true);

    for handle in handles {
        handle.await??;
    }
    Ok(())
}

async fn connect_infra(
    config: &EngineConfig,
) -> Result<(Option<sqlx::PgPool>, Option<Arc<RabbitMqClient>>)> {
    let pg_pool = match &config.database_url {
        Some(url) => match PgPoolOptions::new().max_connections(10).connect(url).await {
            Ok(pool) => {
                info!("Connected to PostgreSQL for MTA state, domains, credentials, and DKIM");
                Some(pool)
            }
            Err(err) => {
                warn!(error = %err, "PostgreSQL unreachable on startup; running degraded");
                None
            }
        },
        None => None,
    };

    let rmq_client = match &config.rabbitmq_url {
        Some(url) => match RabbitMqClient::connect(url).await {
            Ok(client) => {
                client.declare_topology().await?;
                Some(Arc::new(client))
            }
            Err(err) => {
                warn!(error = %err, "RabbitMQ unreachable on startup; queue pipeline disabled");
                None
            }
        },
        None => None,
    };

    Ok((pg_pool, rmq_client))
}

fn spawn_inbound_pipeline(
    config: &EngineConfig,
    rmq_client: Option<&Arc<RabbitMqClient>>,
    pg_pool: Option<&sqlx::PgPool>,
    domain_dir: &Arc<PgDomainDirectory>,
    raw_storage: &Arc<SpoolStorage>,
    shutdown_rx: &watch::Receiver<bool>,
    handles: &mut Vec<JoinHandle<Result<()>>>,
) {
    let Some(rmq) = rmq_client else {
        return;
    };
    let lmtp = Arc::new(DovecotLmtpClient::new(LmtpClientConfig {
        lhlo_domain: config.helo_domain.clone(),
        ..LmtpClientConfig::default()
    }));
    let feedback = Arc::new(PgFeedbackStore::new(pg_pool.cloned()));
    let processor = Arc::new(InboundProcessor::new(
        Arc::clone(domain_dir),
        Arc::clone(raw_storage),
        lmtp,
        feedback,
    ));
    let rmq_ref = Arc::clone(rmq);
    let rx_in = shutdown_rx.clone();
    handles.push(tokio::spawn(async move {
        run_rabbitmq_inbound_consumer(rmq_ref, processor, rx_in).await
    }));
}

async fn build_spool_storage(config: &EngineConfig) -> Result<SpoolStorage> {
    if config.spool_backend.eq_ignore_ascii_case("s3") {
        let endpoint = config
            .s3_endpoint
            .clone()
            .ok_or_else(|| anyhow::anyhow!("S3_ENDPOINT is required when SPOOL_BACKEND=s3"))?;
        let s3 = S3MessageStore::new(S3Config {
            endpoint,
            region: config.s3_region.clone(),
            bucket: config.s3_bucket.clone(),
            access_key: config.s3_access_key.clone(),
            secret_key: config.s3_secret_key.clone(),
        })?;
        info!(bucket = %config.s3_bucket, "Using S3-compatible object storage spool");
        Ok(SpoolStorage::S3(s3))
    } else {
        let local = LocalSpoolStore::new(&config.spool_dir).await?;
        info!(spool_dir = %config.spool_dir, "Using local NVMe spool storage");
        Ok(SpoolStorage::Local(local))
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_outbound_pipeline(
    config: &EngineConfig,
    signing_storage: Arc<DkimSigningStore<SpoolStorage>>,
    pg_pool: Option<sqlx::PgPool>,
    rmq_client: Option<Arc<RabbitMqClient>>,
    metrics: &Arc<MetricsRegistry>,
    draining: &Arc<AtomicBool>,
    shutdown_rx: &watch::Receiver<bool>,
    handles: &mut Vec<JoinHandle<Result<()>>>,
) {
    let resolver = Arc::new(HickoryDnsResolver::from_system_or_default(
        DnsCacheConfig::default(),
    ));
    let smtp_pool = Arc::new(OutboundSmtpPool::new(OutboundClientConfig {
        helo_domain: config.helo_domain.clone(),
        ..OutboundClientConfig::default()
    }));
    let state_store = Arc::new(EngineDeliveryStateStore::new(
        pg_pool,
        config.node_id.clone(),
    ));

    let engine = Arc::new(DeliveryEngine::new(
        DeliveryEngineConfig::default(),
        resolver,
        signing_storage,
        smtp_pool,
        state_store,
        Arc::clone(metrics),
    ));

    let engine_workers = Arc::clone(&engine);
    let mut rx_workers = shutdown_rx.clone();
    handles.push(tokio::spawn(async move {
        let shutdown_trigger = Arc::clone(&engine_workers);
        tokio::spawn(async move {
            let _ = rx_workers.changed().await;
            shutdown_trigger.shutdown_intake();
        });
        engine_workers.run_workers().await
    }));

    if let Some(rmq) = rmq_client {
        for (queue, pool_kind) in [
            (QUEUE_OUTBOUND_TX, DeliveryPoolKind::Transactional),
            (QUEUE_OUTBOUND_BULK, DeliveryPoolKind::Bulk),
            (QUEUE_OUTBOUND_RETRY, DeliveryPoolKind::Transactional),
        ] {
            let rmq_ref = Arc::clone(&rmq);
            let eng_ref = Arc::clone(&engine);
            let drain_ref = Arc::clone(draining);
            let rx_q = shutdown_rx.clone();
            handles.push(tokio::spawn(async move {
                run_rabbitmq_outbound_consumer(
                    rmq_ref,
                    queue.to_string(),
                    pool_kind,
                    eng_ref,
                    drain_ref,
                    rx_q,
                )
                .await
            }));
        }
    }
}

fn build_seeded_credential_store(config: &EngineConfig) -> Result<Arc<InMemoryCredentialStore>> {
    let creds = Arc::new(InMemoryCredentialStore::default());
    if let (Some(user), Some(pass)) = (&config.smtp_auth_user, &config.smtp_auth_pass) {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(pass.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!("Argon2 hash failed: {e}"))?
            .to_string();
        let sender_pattern = config
            .primary_domain
            .as_deref()
            .map_or_else(|| "*".to_string(), |d| format!("*@{d}"));
        creds.insert(CredentialRecord {
            username: user.clone(),
            password_hash: hash,
            allowed_sender_patterns: vec![sender_pattern],
            is_revoked: false,
        });
        info!(smtp_username = %user, "Seeded SMTP submission credential from environment");
    }
    Ok(creds)
}

#[allow(clippy::too_many_arguments)]
async fn spawn_ingress_listeners(
    config: &EngineConfig,
    raw_storage: &Arc<SpoolStorage>,
    pg_pool: Option<&sqlx::PgPool>,
    domain_dir: &Arc<PgDomainDirectory>,
    pub_channel: Option<&Arc<Mutex<lapin::Channel>>>,
    metrics: &Arc<MetricsRegistry>,
    draining: &Arc<AtomicBool>,
    shutdown_rx: &watch::Receiver<bool>,
    handles: &mut Vec<JoinHandle<Result<()>>>,
) -> Result<()> {
    let tls_acceptor = if let (Some(cert_p), Some(key_p)) =
        (&config.tls_cert_path, &config.tls_key_path)
    {
        let cert_pem = tokio::fs::read(cert_p).await?;
        let key_pem = tokio::fs::read(key_p).await?;
        Some(build_tls_acceptor_from_pem(&cert_pem, &key_pem)?)
    } else {
        if env_opt("NODE_ENV").is_some_and(|v| v.eq_ignore_ascii_case("production")) {
            anyhow::bail!("TLS_CERT_PATH and TLS_KEY_PATH are required for ingress in production");
        }
        warn!("TLS_CERT_PATH/TLS_KEY_PATH not configured; STARTTLS and port 465 disabled");
        None
    };

    let fallback_creds = build_seeded_credential_store(config)?;
    let creds = Arc::new(PgCredentialStore::new(pg_pool.cloned(), fallback_creds));
    let limiter = IngressRateLimiter::new(RateLimitConfig::default());

    let auth_verifier = InboundAuthVerifier::from_system_conf(config.server_domain.clone())
        .ok()
        .map(Arc::new);
    let mx_sink = Arc::new(PipelineMessageSink::new(
        ListenerRole::ServerToServerMx,
        Arc::clone(raw_storage),
        pub_channel.cloned(),
        auth_verifier,
    ));
    let sub_sink = Arc::new(PipelineMessageSink::new(
        ListenerRole::AuthenticatedSubmission,
        Arc::clone(raw_storage),
        pub_channel.cloned(),
        None,
    ));

    let mx_addr = SocketAddr::from(([0, 0, 0, 0], config.smtp_port_25));
    let mx_listener = TcpListener::bind(mx_addr).await?;
    let mx_handler = Arc::new(IngressPolicyHandler::new(
        ListenerRole::ServerToServerMx,
        Arc::clone(&creds),
        Arc::clone(domain_dir),
        limiter.clone(),
        mx_sink,
    ));
    let mx_cfg = SmtpServerConfig {
        bind_addr: mx_addr,
        max_connections: 1024,
        session_config: SessionConfig {
            server_domain: config.server_domain.clone(),
            advertise_starttls: tls_acceptor.is_some(),
            advertise_auth: false,
            ..SessionConfig::default()
        },
        timeouts: SessionTimeouts::default(),
        tls_mode: tls_acceptor
            .clone()
            .map_or(ListenerTlsMode::Plain, ListenerTlsMode::StartTls),
        rate_limiter: Some(limiter.clone()),
        draining: Some(Arc::clone(draining)),
    };
    let m_ref = Arc::clone(metrics);
    let rx_25 = shutdown_rx.clone();
    handles.push(tokio::spawn(async move {
        serve_listener(mx_listener, mx_cfg, mx_handler, m_ref, rx_25).await
    }));

    if let Some(acceptor) = tls_acceptor {
        spawn_submission_listeners(
            config,
            acceptor,
            &creds,
            domain_dir,
            &limiter,
            &sub_sink,
            metrics,
            draining,
            shutdown_rx,
            handles,
        )
        .await?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn spawn_submission_listeners(
    config: &EngineConfig,
    acceptor: TlsAcceptor,
    creds: &Arc<PgCredentialStore>,
    domain_dir: &Arc<PgDomainDirectory>,
    limiter: &IngressRateLimiter,
    sub_sink: &Arc<PipelineMessageSink<SpoolStorage>>,
    metrics: &Arc<MetricsRegistry>,
    draining: &Arc<AtomicBool>,
    shutdown_rx: &watch::Receiver<bool>,
    handles: &mut Vec<JoinHandle<Result<()>>>,
) -> Result<()> {
    for (port, advertise_starttls, tls_mode) in [
        (
            config.smtp_port_587,
            true,
            ListenerTlsMode::StartTls(acceptor.clone()),
        ),
        (
            config.smtp_port_465,
            false,
            ListenerTlsMode::ImplicitTls(acceptor),
        ),
    ] {
        let bind_addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = TcpListener::bind(bind_addr).await?;
        let sub_policy = Arc::new(IngressPolicyHandler::new(
            ListenerRole::AuthenticatedSubmission,
            Arc::clone(creds),
            Arc::clone(domain_dir),
            limiter.clone(),
            Arc::clone(sub_sink),
        ));
        let srv_cfg = SmtpServerConfig {
            bind_addr,
            max_connections: 1024,
            session_config: SessionConfig {
                server_domain: config.server_domain.clone(),
                advertise_starttls,
                advertise_auth: true,
                require_tls_for_auth: true,
                ..SessionConfig::default()
            },
            timeouts: SessionTimeouts::default(),
            tls_mode,
            rate_limiter: Some(limiter.clone()),
            draining: Some(Arc::clone(draining)),
        };
        let m_ref = Arc::clone(metrics);
        let rx = shutdown_rx.clone();
        handles.push(tokio::spawn(async move {
            serve_listener(listener, srv_cfg, sub_policy, m_ref, rx).await
        }));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn serve_control_and_metrics(
    listener: TcpListener,
    config: EngineConfig,
    metrics: Arc<MetricsRegistry>,
    draining: Arc<AtomicBool>,
    keyring: Arc<DkimKeyRing>,
    signing_storage: Arc<DkimSigningStore<SpoolStorage>>,
    pg_pool: Option<sqlx::PgPool>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    info!(addr = %listener.local_addr()?, "Prometheus /metrics & /control listener started");
    loop {
        tokio::select! {
            res = listener.accept() => {
                if let Ok((stream, _)) = res {
                    let cfg = config.clone();
                    let m = Arc::clone(&metrics);
                    let d = Arc::clone(&draining);
                    let kr = Arc::clone(&keyring);
                    let ss = Arc::clone(&signing_storage);
                    let pool = pg_pool.clone();
                    tokio::spawn(async move {
                        let _ = timeout(
                            Duration::from_secs(5),
                            handle_control_connection(stream, &cfg, &m, &d, &kr, &ss, pool.as_ref()),
                        )
                        .await;
                    });
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
        }
    }
    Ok(())
}

async fn handle_control_connection(
    mut stream: TcpStream,
    config: &EngineConfig,
    metrics: &MetricsRegistry,
    draining: &AtomicBool,
    keyring: &DkimKeyRing,
    signing_storage: &DkimSigningStore<SpoolStorage>,
    pg_pool: Option<&sqlx::PgPool>,
) {
    let is_loopback = stream.peer_addr().is_ok_and(|a| a.ip().is_loopback());
    let mut buf = [0_u8; 4096];
    let Ok(n) = stream.read(&mut buf).await else {
        return;
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");
    let authorized = is_bearer_authorized(&req, config.control_token.as_deref(), is_loopback);

    let (status_line, content_type, body) = if first_line.starts_with("POST /control/drain") {
        if authorized {
            draining.store(true, Ordering::SeqCst);
            info!(node_id = %config.node_id, "Node entered draining mode via control API");
            (
                "200 OK",
                "application/json",
                "{\"draining\":true,\"status\":\"draining\"}".to_string(),
            )
        } else {
            (
                "401 Unauthorized",
                "application/json",
                "{\"error\":\"unauthorized\"}".to_string(),
            )
        }
    } else if first_line.starts_with("POST /control/resume") {
        if authorized {
            draining.store(false, Ordering::SeqCst);
            info!(node_id = %config.node_id, "Node resumed active mode via control API");
            (
                "200 OK",
                "application/json",
                "{\"draining\":false,\"status\":\"healthy\"}".to_string(),
            )
        } else {
            (
                "401 Unauthorized",
                "application/json",
                "{\"error\":\"unauthorized\"}".to_string(),
            )
        }
    } else if let Some(resp) = handle_dkim_control_request(
        first_line,
        authorized,
        config,
        metrics,
        keyring,
        signing_storage,
        pg_pool,
    )
    .await
    {
        resp
    } else if first_line.starts_with("GET /status") || first_line.starts_with("GET /healthz") {
        let is_draining = draining.load(Ordering::Relaxed);
        let active = metrics.smtp_active_connections.get();
        let roles_json = config
            .roles
            .iter()
            .map(|r| format!("\"{}\"", r.replace('"', "")))
            .collect::<Vec<_>>()
            .join(",");
        let json = format!(
            "{{\"nodeId\":\"{}\",\"roles\":[{}],\"status\":\"{}\",\"draining\":{},\"activeConnections\":{}}}",
            config.node_id,
            roles_json,
            if is_draining { "draining" } else { "healthy" },
            is_draining,
            active
        );
        ("200 OK", "application/json", json)
    } else {
        let body = metrics.render_prometheus().unwrap_or_default();
        ("200 OK", "text/plain; version=0.0.4", body)
    };

    let resp = format!(
        "HTTP/1.1 {status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn is_bearer_authorized(req: &str, expected_token: Option<&str>, is_loopback: bool) -> bool {
    let Some(expected) = expected_token else {
        // Without a configured control token, restrict control routes to loopback callers only.
        return is_loopback;
    };
    for line in req.lines() {
        let Some((name, val)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("authorization") {
            continue;
        }
        let Some(token) = val.trim().strip_prefix("Bearer ").map(str::trim) else {
            continue;
        };
        if token.len() == expected.len()
            && token
                .as_bytes()
                .iter()
                .zip(expected.as_bytes())
                .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
                == 0
        {
            return true;
        }
    }
    false
}

async fn initialize_dkim<S>(
    config: &EngineConfig,
    raw_storage: &Arc<S>,
    pg_pool: Option<&sqlx::PgPool>,
    metrics: &Arc<MetricsRegistry>,
) -> Result<(Arc<DkimKeyRing>, Arc<DkimSigningStore<S>>)> {
    let kek_ring = Arc::new(KeyEncryptionKeyRing::from_env_vars(
        config.is_production,
        DEFAULT_DEV_DKIM_KEK_HEX,
    )?);
    let keyring = Arc::new(DkimKeyRing::default());
    load_or_seed_dkim_keys(
        pg_pool,
        &keyring,
        &kek_ring,
        config.primary_domain.as_deref(),
        &config.dkim_selector,
        config.dkim_auto_generate,
    )
    .await;
    let signing_storage = Arc::new(DkimSigningStore::new(
        Arc::clone(raw_storage),
        Arc::clone(&keyring),
        Arc::clone(&kek_ring),
        pg_pool.cloned(),
        Arc::clone(metrics),
    ));
    Ok((keyring, signing_storage))
}

async fn handle_dkim_control_request<S>(
    first_line: &str,
    authorized: bool,
    config: &EngineConfig,
    metrics: &MetricsRegistry,
    keyring: &DkimKeyRing,
    signing_storage: &DkimSigningStore<S>,
    pg_pool: Option<&sqlx::PgPool>,
) -> Option<(&'static str, &'static str, String)> {
    if first_line.starts_with("POST /control/dkim/reload") {
        if !authorized {
            return Some((
                "401 Unauthorized",
                "application/json",
                "{\"error\":\"unauthorized\"}".to_string(),
            ));
        }
        signing_storage.invalidate_policy_cache();
        if let Some(pool) = pg_pool {
            return Some(match reload_dkim_keys_from_db(pool, keyring).await {
                Ok(count) => {
                    metrics.record_dkim_reload("success");
                    let selectors = keyring.active_selectors_by_domain();
                    let json = serde_json::json!({
                        "reloaded": count,
                        "activeSelectors": selectors,
                    })
                    .to_string();
                    info!(reloaded = count, "Reloaded DKIM keys from PostgreSQL");
                    ("200 OK", "application/json", json)
                }
                Err(err) => {
                    metrics.record_dkim_reload("failure");
                    (
                        "500 Internal Server Error",
                        "application/json",
                        serde_json::json!({ "error": err.to_string() }).to_string(),
                    )
                }
            });
        }
        metrics.record_dkim_reload("success");
        return Some((
            "200 OK",
            "application/json",
            serde_json::json!({
                "reloaded": 0,
                "activeSelectors": keyring.active_selectors_by_domain(),
            })
            .to_string(),
        ));
    }

    if first_line.starts_with("GET /control/dkim/status") {
        if authorized {
            let json = serde_json::json!({
                "nodeId": config.node_id,
                "heloDomain": config.helo_domain,
                "activeSelectors": keyring.active_selectors_by_domain(),
            })
            .to_string();
            return Some(("200 OK", "application/json", json));
        }
        return Some((
            "401 Unauthorized",
            "application/json",
            "{\"error\":\"unauthorized\"}".to_string(),
        ));
    }

    None
}
