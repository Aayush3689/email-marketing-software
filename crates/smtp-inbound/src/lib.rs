//! Inbound SMTP policy enforcement, Argon2id submission auth,
//! sender authorization, Port 25 open-relay prevention, and Dovecot LMTP routing.

pub mod processor;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, RwLock};

use argon2::{Argon2, PasswordHash, PasswordVerifier};
pub use processor::{
    ExpandedRouting, FeedbackStore, InMemoryFeedbackStore, InboundProcessReport, InboundProcessor,
    InboundRouter, MailboxTarget, SpoolingMessageSink,
};
use rate_limiter::IngressRateLimiter;
use smtp_protocol::{MailParams, SmtpResponse};
use smtp_session::{ReceivedMessage, SessionContext, SessionHandler};
use tracing::warn;
use zeroize::Zeroizing;

/// Listener role determining relay and authentication enforcement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenerRole {
    /// Port 25: unauthenticated server-to-server MX ingress (no open relay).
    ServerToServerMx,
    /// Ports 587 / 465: authenticated SMTP submission over TLS.
    AuthenticatedSubmission,
}

/// Stored SMTP submission credential record.
#[derive(Debug, Clone)]
pub struct CredentialRecord {
    pub username: String,
    pub password_hash: String,
    pub allowed_sender_patterns: Vec<String>,
    pub is_revoked: bool,
}

/// Classification of a `RCPT TO` target during Port 25 MX reception.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientRouting {
    HostedMailbox,
    FeedbackAddress,
    UnknownLocalUser,
    ExternalDomain,
}

/// Lookup interface for SMTP submission credentials.
pub trait CredentialStore: Send + Sync {
    fn find_credential(
        &self,
        username: &str,
    ) -> impl Future<Output = Option<CredentialRecord>> + Send;
}

/// Lookup interface for hosted domains, mailboxes, and feedback addresses.
pub trait DomainDirectory: Send + Sync {
    fn classify_recipient(&self, email: &str) -> impl Future<Output = RecipientRouting> + Send;
}

/// Sink called after `DATA` completes and passes all policy checks.
pub trait MessageSink: Send + Sync {
    fn accept_message(
        &self,
        ctx: &SessionContext,
        message: ReceivedMessage,
    ) -> impl Future<Output = Result<SmtpResponse, SmtpResponse>> + Send;
}

/// In-memory credential store for tests and local smoke runs.
#[derive(Debug, Default)]
pub struct InMemoryCredentialStore {
    records: RwLock<HashMap<String, CredentialRecord>>,
}

impl InMemoryCredentialStore {
    pub fn insert(&self, record: CredentialRecord) {
        if let Ok(mut guard) = self.records.write() {
            guard.insert(record.username.to_ascii_lowercase(), record);
        }
    }
}

impl CredentialStore for InMemoryCredentialStore {
    fn find_credential(
        &self,
        username: &str,
    ) -> impl Future<Output = Option<CredentialRecord>> + Send {
        let found = self
            .records
            .read()
            .ok()
            .and_then(|g| g.get(&username.to_ascii_lowercase()).cloned());
        std::future::ready(found)
    }
}

#[derive(Debug, Clone)]
struct ForwardingRule {
    forward_to: String,
    keep_local_copy: bool,
}

/// In-memory hosted domain, mailbox, alias, forwarding, and catch-all directory.
#[derive(Debug, Default)]
pub struct InMemoryDomainDirectory {
    hosted_domains: RwLock<HashSet<String>>,
    mailboxes: RwLock<HashMap<String, (String, u16)>>,
    aliases: RwLock<HashMap<String, Vec<String>>>,
    forwards: RwLock<HashMap<String, Vec<ForwardingRule>>>,
    catch_alls: RwLock<HashMap<String, String>>,
    feedback_domains: RwLock<HashSet<String>>,
}

impl InMemoryDomainDirectory {
    pub fn add_hosted_domain(&self, domain: &str) {
        if let Ok(mut guard) = self.hosted_domains.write() {
            guard.insert(domain.to_ascii_lowercase());
        }
    }

    pub fn add_mailbox(&self, email: &str) {
        self.add_mailbox_on_server(email, "127.0.0.1", 2424);
    }

    pub fn add_mailbox_on_server(&self, email: &str, lmtp_host: &str, lmtp_port: u16) {
        if let Some((_, domain)) = email.rsplit_once('@') {
            self.add_hosted_domain(domain);
        }
        if let Ok(mut guard) = self.mailboxes.write() {
            guard.insert(
                email.to_ascii_lowercase(),
                (lmtp_host.to_string(), lmtp_port),
            );
        }
    }

    pub fn add_alias(&self, source: &str, destinations: Vec<String>) {
        if let Some((_, domain)) = source.rsplit_once('@') {
            self.add_hosted_domain(domain);
        }
        if let Ok(mut guard) = self.aliases.write() {
            guard.insert(
                source.to_ascii_lowercase(),
                destinations
                    .into_iter()
                    .map(|d| d.to_ascii_lowercase())
                    .collect(),
            );
        }
    }

    pub fn add_forwarding(&self, mailbox: &str, forward_to: &str, keep_local_copy: bool) {
        if let Ok(mut guard) = self.forwards.write() {
            guard
                .entry(mailbox.to_ascii_lowercase())
                .or_default()
                .push(ForwardingRule {
                    forward_to: forward_to.to_ascii_lowercase(),
                    keep_local_copy,
                });
        }
    }

    pub fn set_catch_all(&self, domain: &str, target_mailbox: &str) {
        self.add_hosted_domain(domain);
        if let Ok(mut guard) = self.catch_alls.write() {
            guard.insert(
                domain.to_ascii_lowercase(),
                target_mailbox.to_ascii_lowercase(),
            );
        }
    }

    pub fn add_feedback_domain(&self, domain: &str) {
        if let Ok(mut guard) = self.feedback_domains.write() {
            guard.insert(domain.to_ascii_lowercase());
        }
    }
}

impl DomainDirectory for InMemoryDomainDirectory {
    fn classify_recipient(&self, email: &str) -> impl Future<Output = RecipientRouting> + Send {
        let lower = email.to_ascii_lowercase();
        let Some((_, domain)) = lower.rsplit_once('@') else {
            return std::future::ready(RecipientRouting::ExternalDomain);
        };

        if self
            .feedback_domains
            .read()
            .is_ok_and(|g| g.contains(domain))
        {
            return std::future::ready(RecipientRouting::FeedbackAddress);
        }

        if !self.hosted_domains.read().is_ok_and(|g| g.contains(domain)) {
            return std::future::ready(RecipientRouting::ExternalDomain);
        }

        let exists = self.mailboxes.read().is_ok_and(|g| g.contains_key(&lower))
            || self.aliases.read().is_ok_and(|g| g.contains_key(&lower))
            || self.catch_alls.read().is_ok_and(|g| g.contains_key(domain));

        std::future::ready(if exists {
            RecipientRouting::HostedMailbox
        } else {
            RecipientRouting::UnknownLocalUser
        })
    }
}

impl InboundRouter for InMemoryDomainDirectory {
    fn expand_recipient(&self, email: &str) -> impl Future<Output = ExpandedRouting> + Send {
        let mut out = ExpandedRouting::default();
        let mut queue = vec![email.to_ascii_lowercase()];
        let mut visited = HashSet::new();
        let mut depth = 0_usize;

        while let Some(curr) = queue.pop() {
            if depth >= 32 || !visited.insert(curr.clone()) {
                continue;
            }
            depth += 1;

            let Some((_, domain)) = curr.rsplit_once('@') else {
                continue;
            };

            if self
                .feedback_domains
                .read()
                .is_ok_and(|g| g.contains(domain))
            {
                out.is_feedback = true;
                continue;
            }

            if let Some(dests) = self.aliases.read().ok().and_then(|g| g.get(&curr).cloned()) {
                for d in dests {
                    queue.push(d);
                }
                continue;
            }

            let mailbox_srv = self
                .mailboxes
                .read()
                .ok()
                .and_then(|g| g.get(&curr).cloned());
            if let Some((lmtp_host, lmtp_port)) = mailbox_srv {
                let fwd_rules = self
                    .forwards
                    .read()
                    .ok()
                    .and_then(|g| g.get(&curr).cloned());
                let keep_local = fwd_rules
                    .as_ref()
                    .is_none_or(|rules| rules.iter().any(|r| r.keep_local_copy));
                if keep_local {
                    out.local_targets.push(MailboxTarget {
                        email: curr.clone(),
                        lmtp_host,
                        lmtp_port,
                    });
                }
                if let Some(rules) = fwd_rules {
                    for rule in rules {
                        if self.hosted_domains.read().is_ok_and(|g| {
                            rule.forward_to
                                .rsplit_once('@')
                                .is_some_and(|(_, fd)| g.contains(fd))
                        }) {
                            queue.push(rule.forward_to);
                        } else {
                            out.external_forwards.push(rule.forward_to);
                        }
                    }
                }
                continue;
            }

            if self.hosted_domains.read().is_ok_and(|g| g.contains(domain)) {
                if let Some(catch_all) = self
                    .catch_alls
                    .read()
                    .ok()
                    .and_then(|g| g.get(domain).cloned())
                {
                    queue.push(catch_all);
                }
            } else {
                out.external_forwards.push(curr);
            }
        }

        std::future::ready(out)
    }
}

/// Production policy handler enforcing TLS/AUTH, Argon2id verification, rate limits,
/// sender ownership, and strict no-open-relay rules.
pub struct IngressPolicyHandler<C, D, S> {
    role: ListenerRole,
    credentials: Arc<C>,
    directory: Arc<D>,
    rate_limiter: IngressRateLimiter,
    sink: Arc<S>,
}

impl<C, D, S> IngressPolicyHandler<C, D, S> {
    #[must_use]
    pub fn new(
        role: ListenerRole,
        credentials: Arc<C>,
        directory: Arc<D>,
        rate_limiter: IngressRateLimiter,
        sink: Arc<S>,
    ) -> Self {
        Self {
            role,
            credentials,
            directory,
            rate_limiter,
            sink,
        }
    }
}

impl<C, D, S> SessionHandler for IngressPolicyHandler<C, D, S>
where
    C: CredentialStore,
    D: DomainDirectory,
    S: MessageSink,
{
    async fn authenticate(
        &self,
        ctx: &SessionContext,
        username: &str,
        password: &str,
    ) -> Result<String, SmtpResponse> {
        if self.role != ListenerRole::AuthenticatedSubmission {
            return Err(SmtpResponse::not_implemented());
        }
        if !ctx.tls_active {
            return Err(SmtpResponse::single(
                538,
                Some("5.7.11"),
                "Encryption required for requested authentication mechanism",
            ));
        }

        let ip = ctx.peer_addr.ip();
        if self.rate_limiter.is_auth_locked(ip) {
            return Err(SmtpResponse::single(
                454,
                Some("4.7.0"),
                "Too many failed authentication attempts; try again later",
            ));
        }

        let Some(record) = self.credentials.find_credential(username).await else {
            let _ = self.rate_limiter.record_auth_failure(ip);
            return Err(SmtpResponse::single(
                535,
                Some("5.7.8"),
                "Authentication credentials invalid",
            ));
        };

        if record.is_revoked {
            let _ = self.rate_limiter.record_auth_failure(ip);
            return Err(SmtpResponse::single(
                535,
                Some("5.7.8"),
                "Authentication credentials invalid",
            ));
        }

        let stored_hash = record.password_hash.clone();
        let candidate_pw = Zeroizing::new(password.to_string());
        let verified = tokio::task::spawn_blocking(move || {
            let Ok(parsed) = PasswordHash::new(&stored_hash) else {
                return false;
            };
            Argon2::default()
                .verify_password(candidate_pw.as_bytes(), &parsed)
                .is_ok()
        })
        .await
        .unwrap_or(false);

        if verified {
            self.rate_limiter.record_auth_success(ip);
            Ok(record.username)
        } else {
            let locked = self.rate_limiter.record_auth_failure(ip);
            warn!(%ip, username, locked, "SMTP authentication failed");
            Err(SmtpResponse::single(
                535,
                Some("5.7.8"),
                "Authentication credentials invalid",
            ))
        }
    }

    async fn validate_mail_from(
        &self,
        ctx: &SessionContext,
        reverse_path: Option<&str>,
        _params: &MailParams,
    ) -> Result<(), SmtpResponse> {
        if !self
            .rate_limiter
            .check_and_record_message(ctx.peer_addr.ip())
        {
            return Err(SmtpResponse::single(
                421,
                Some("4.7.0"),
                "Message rate limit exceeded; try again later",
            ));
        }

        if self.role == ListenerRole::AuthenticatedSubmission {
            let Some(user) = ctx.authenticated_user.as_deref() else {
                return Err(SmtpResponse::single(
                    530,
                    Some("5.7.0"),
                    "Authentication required",
                ));
            };

            let Some(sender) = reverse_path else {
                return Err(SmtpResponse::single(
                    553,
                    Some("5.7.1"),
                    "Null reverse-path not allowed on submission port",
                ));
            };

            let Some(record) = self.credentials.find_credential(user).await else {
                return Err(SmtpResponse::single(
                    535,
                    Some("5.7.8"),
                    "Authenticated credential no longer valid",
                ));
            };

            if record.is_revoked {
                return Err(SmtpResponse::single(
                    535,
                    Some("5.7.8"),
                    "Authenticated credential no longer valid",
                ));
            }

            if !sender_matches_patterns(sender, &record.allowed_sender_patterns) {
                return Err(SmtpResponse::single(
                    553,
                    Some("5.7.1"),
                    "Sender address rejected: not owned by authenticated user",
                ));
            }
        }

        Ok(())
    }

    async fn validate_rcpt_to(
        &self,
        ctx: &SessionContext,
        forward_path: &str,
    ) -> Result<(), SmtpResponse> {
        match self.role {
            ListenerRole::AuthenticatedSubmission => {
                if ctx.authenticated_user.is_none() {
                    return Err(SmtpResponse::single(
                        530,
                        Some("5.7.0"),
                        "Authentication required",
                    ));
                }
                Ok(())
            }
            ListenerRole::ServerToServerMx => {
                match self.directory.classify_recipient(forward_path).await {
                    RecipientRouting::HostedMailbox | RecipientRouting::FeedbackAddress => Ok(()),
                    RecipientRouting::UnknownLocalUser => Err(SmtpResponse::single(
                        550,
                        Some("5.1.1"),
                        "Recipient address rejected: User unknown",
                    )),
                    RecipientRouting::ExternalDomain => {
                        warn!(
                            peer = %ctx.peer_addr,
                            recipient = forward_path,
                            "Blocked unauthenticated open-relay attempt"
                        );
                        Err(SmtpResponse::single(
                            550,
                            Some("5.7.1"),
                            "Relay access denied",
                        ))
                    }
                }
            }
        }
    }

    fn on_message(
        &self,
        ctx: &SessionContext,
        message: ReceivedMessage,
    ) -> impl Future<Output = Result<SmtpResponse, SmtpResponse>> + Send {
        self.sink.accept_message(ctx, message)
    }
}

fn sender_matches_patterns(sender: &str, patterns: &[String]) -> bool {
    let lower_sender = sender.to_ascii_lowercase();
    let sender_domain = lower_sender.rsplit_once('@').map(|(_, d)| d);

    patterns.iter().any(|pat| {
        let lower_pat = pat.to_ascii_lowercase();
        if lower_pat == "*" || lower_pat == lower_sender {
            return true;
        }
        if let Some(pat_domain) = lower_pat.strip_prefix("*@") {
            return sender_domain == Some(pat_domain);
        }
        false
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use argon2::password_hash::SaltString;
    use argon2::PasswordHasher;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use bounce_handler::FeedbackClassification;
    use mailbox_client::{DovecotLmtpClient, LmtpClientConfig};
    use message_storage::{InMemoryMessageStore, MessageStore};
    use observability::MetricsRegistry;
    use rate_limiter::RateLimitConfig;
    use rustls::pki_types::ServerName;
    use smtp_protocol::SessionConfig;
    use smtp_server::{
        build_tls_acceptor_from_pem, serve_listener, ListenerTlsMode, SmtpServerConfig,
    };
    use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::watch;
    use tokio_rustls::TlsConnector;

    use super::*;

    #[derive(Default)]
    struct TestSink {
        messages: Mutex<Vec<ReceivedMessage>>,
    }

    impl MessageSink for TestSink {
        fn accept_message(
            &self,
            _ctx: &SessionContext,
            message: ReceivedMessage,
        ) -> impl Future<Output = Result<SmtpResponse, SmtpResponse>> + Send {
            self.messages.lock().unwrap().push(message);
            std::future::ready(Ok(SmtpResponse::ok("Queued")))
        }
    }

    fn hash_password(pw: &str) -> String {
        let salt = SaltString::from_b64("c2FsdHNhbHRzYWx0c2FsdA").unwrap();
        Argon2::default()
            .hash_password(pw.as_bytes(), &salt)
            .unwrap()
            .to_string()
    }

    fn generate_test_tls() -> (Vec<u8>, Vec<u8>, rustls::ClientConfig) {
        let cert = rcgen::generate_simple_self_signed(vec!["mail.test.local".to_string()]).unwrap();
        let cert_pem = cert.cert.pem().into_bytes();
        let key_pem = cert.key_pair.serialize_pem().into_bytes();

        let mut root_store = rustls::RootCertStore::empty();
        root_store.add(cert.cert.der().clone()).unwrap();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client_cfg = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();

        (cert_pem, key_pem, client_cfg)
    }

    async fn read_line<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> String {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        line
    }

    async fn read_ehlo<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Vec<String> {
        let mut lines = Vec::new();
        loop {
            let line = read_line(reader).await;
            let done = line.starts_with("250 ");
            lines.push(line);
            if done {
                break;
            }
        }
        lines
    }

    async fn spawn_starttls_submission(
        username: &str,
        password: &str,
        patterns: Vec<String>,
    ) -> (
        std::net::SocketAddr,
        rustls::ClientConfig,
        Arc<TestSink>,
        watch::Sender<bool>,
        tokio::task::JoinHandle<anyhow::Result<()>>,
    ) {
        let (cert_pem, key_pem, client_cfg) = generate_test_tls();
        let acceptor = build_tls_acceptor_from_pem(&cert_pem, &key_pem).unwrap();

        let creds = Arc::new(InMemoryCredentialStore::default());
        creds.insert(CredentialRecord {
            username: username.to_string(),
            password_hash: hash_password(password),
            allowed_sender_patterns: patterns,
            is_revoked: false,
        });
        let dir = Arc::new(InMemoryDomainDirectory::default());
        let sink = Arc::new(TestSink::default());

        let policy = Arc::new(IngressPolicyHandler::new(
            ListenerRole::AuthenticatedSubmission,
            creds,
            dir,
            IngressRateLimiter::new(RateLimitConfig {
                max_auth_failures_per_ip: 2,
                auth_lockout_duration: Duration::from_secs(60),
                ..RateLimitConfig::default()
            }),
            Arc::clone(&sink),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = watch::channel(false);
        let srv = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                session_config: SessionConfig {
                    server_domain: "submit.platform.test".to_string(),
                    advertise_starttls: true,
                    advertise_auth: true,
                    require_tls_for_auth: true,
                    ..SessionConfig::default()
                },
                tls_mode: ListenerTlsMode::StartTls(acceptor),
                ..SmtpServerConfig::default()
            },
            policy,
            Arc::new(MetricsRegistry::new().unwrap()),
            rx,
        ));
        (addr, client_cfg, sink, tx, srv)
    }

    #[tokio::test]
    async fn port_25_blocks_open_relay_and_unknown_users_but_accepts_hosted() {
        let creds = Arc::new(InMemoryCredentialStore::default());
        let dir = Arc::new(InMemoryDomainDirectory::default());
        dir.add_mailbox("alice@hosted.example");
        let sink = Arc::new(TestSink::default());

        let policy = Arc::new(IngressPolicyHandler::new(
            ListenerRole::ServerToServerMx,
            creds,
            dir,
            IngressRateLimiter::new(RateLimitConfig::default()),
            Arc::clone(&sink),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = watch::channel(false);
        let srv = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                session_config: SessionConfig {
                    server_domain: "mx.platform.test".to_string(),
                    ..SessionConfig::default()
                },
                ..SmtpServerConfig::default()
            },
            policy,
            Arc::new(MetricsRegistry::new().unwrap()),
            rx,
        ));

        let stream = TcpStream::connect(addr).await.unwrap();
        let mut reader = BufReader::new(stream);
        assert!(read_line(&mut reader).await.starts_with("220 "));

        reader
            .get_mut()
            .write_all(b"EHLO remote.example\r\n")
            .await
            .unwrap();
        let ehlo = read_ehlo(&mut reader).await;
        assert!(!ehlo.iter().any(|l| l.contains("AUTH")));

        reader
            .get_mut()
            .write_all(b"MAIL FROM:<outsider@remote.example>\r\n")
            .await
            .unwrap();
        assert!(read_line(&mut reader).await.starts_with("250 "));

        reader
            .get_mut()
            .write_all(b"RCPT TO:<victim@external.org>\r\n")
            .await
            .unwrap();
        assert!(read_line(&mut reader).await.starts_with("550 5.7.1"));

        reader
            .get_mut()
            .write_all(b"RCPT TO:<nobody@hosted.example>\r\n")
            .await
            .unwrap();
        assert!(read_line(&mut reader).await.starts_with("550 5.1.1"));

        reader
            .get_mut()
            .write_all(
                b"RCPT TO:<alice@hosted.example>\r\nDATA\r\nSubject: Hi\r\n\r\nHello\r\n.\r\nQUIT\r\n",
            )
            .await
            .unwrap();
        assert!(read_line(&mut reader).await.starts_with("250 "));
        assert!(read_line(&mut reader).await.starts_with("354 "));
        assert!(read_line(&mut reader).await.starts_with("250 "));
        assert!(read_line(&mut reader).await.starts_with("221 "));

        assert_eq!(sink.messages.lock().unwrap().len(), 1);
        let _ = tx.send(true);
        srv.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn port_587_requires_starttls_auth_and_sender_ownership_and_blocks_cve_2011_0411() {
        let (addr, client_cfg, sink, tx, srv) = spawn_starttls_submission(
            "smtp_org1",
            "correct-horse-battery",
            vec!["*@verified-org.com".to_string()],
        )
        .await;

        {
            let mut inj = BufReader::new(TcpStream::connect(addr).await.unwrap());
            assert!(read_line(&mut inj).await.starts_with("220 "));
            inj.get_mut()
                .write_all(b"EHLO test\r\nSTARTTLS\r\nMAIL FROM:<evil@x.com>\r\n")
                .await
                .unwrap();
            let _ = read_ehlo(&mut inj).await;
            assert!(read_line(&mut inj).await.starts_with("501 "));
        }

        let stream = TcpStream::connect(addr).await.unwrap();
        let mut reader = BufReader::new(stream);
        assert!(read_line(&mut reader).await.starts_with("220 "));

        reader
            .get_mut()
            .write_all(b"EHLO app.local\r\nAUTH PLAIN dGVzdA==\r\nMAIL FROM:<a@verified-org.com>\r\nSTARTTLS\r\n")
            .await
            .unwrap();
        let ehlo_plain = read_ehlo(&mut reader).await;
        assert!(ehlo_plain.iter().any(|l| l.contains("STARTTLS")));
        assert!(!ehlo_plain.iter().any(|l| l.contains("AUTH")));
        assert!(read_line(&mut reader).await.starts_with("538 "));
        assert!(read_line(&mut reader).await.starts_with("530 "));
        assert!(read_line(&mut reader).await.starts_with("220 "));

        let tcp = reader.into_inner();
        let connector = TlsConnector::from(Arc::new(client_cfg));
        let tls = connector
            .connect(ServerName::try_from("mail.test.local").unwrap(), tcp)
            .await
            .unwrap();
        let mut tls_reader = BufReader::new(tls);

        tls_reader
            .get_mut()
            .write_all(b"EHLO app.local\r\n")
            .await
            .unwrap();
        let ehlo_tls = read_ehlo(&mut tls_reader).await;
        assert!(ehlo_tls.iter().any(|l| l.contains("AUTH PLAIN LOGIN")));

        let token = BASE64.encode(b"\0smtp_org1\0correct-horse-battery");
        tls_reader
            .get_mut()
            .write_all(format!("AUTH PLAIN {token}\r\n").as_bytes())
            .await
            .unwrap();
        assert!(read_line(&mut tls_reader).await.starts_with("235 "));

        tls_reader
            .get_mut()
            .write_all(b"MAIL FROM:<spoof@other.com>\r\n")
            .await
            .unwrap();
        assert!(read_line(&mut tls_reader).await.starts_with("553 "));

        tls_reader
            .get_mut()
            .write_all(
                b"MAIL FROM:<alerts@verified-org.com>\r\nRCPT TO:<user@gmail.com>\r\nDATA\r\nSubject: Auth OK\r\n\r\nBody\r\n.\r\nQUIT\r\n",
            )
            .await
            .unwrap();
        assert!(read_line(&mut tls_reader).await.starts_with("250 "));
        assert!(read_line(&mut tls_reader).await.starts_with("250 "));
        assert!(read_line(&mut tls_reader).await.starts_with("354 "));
        assert!(read_line(&mut tls_reader).await.starts_with("250 "));
        assert!(read_line(&mut tls_reader).await.starts_with("221 "));

        assert_eq!(sink.messages.lock().unwrap().len(), 1);
        let _ = tx.send(true);
        srv.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn port_465_implicit_tls_and_auth_login_and_lockout() {
        let (cert_pem, key_pem, client_cfg) = generate_test_tls();
        let acceptor = build_tls_acceptor_from_pem(&cert_pem, &key_pem).unwrap();

        let creds = Arc::new(InMemoryCredentialStore::default());
        creds.insert(CredentialRecord {
            username: "login_user".to_string(),
            password_hash: hash_password("pass12345"),
            allowed_sender_patterns: vec!["me@org.test".to_string()],
            is_revoked: false,
        });
        let dir = Arc::new(InMemoryDomainDirectory::default());
        let sink = Arc::new(TestSink::default());

        let policy = Arc::new(IngressPolicyHandler::new(
            ListenerRole::AuthenticatedSubmission,
            creds,
            dir,
            IngressRateLimiter::new(RateLimitConfig {
                max_auth_failures_per_ip: 2,
                auth_lockout_duration: Duration::from_secs(60),
                ..RateLimitConfig::default()
            }),
            Arc::clone(&sink),
        ));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = watch::channel(false);
        let srv = tokio::spawn(serve_listener(
            listener,
            SmtpServerConfig {
                bind_addr: addr,
                session_config: SessionConfig {
                    server_domain: "smtps.platform.test".to_string(),
                    advertise_starttls: false,
                    advertise_auth: true,
                    require_tls_for_auth: true,
                    ..SessionConfig::default()
                },
                tls_mode: ListenerTlsMode::ImplicitTls(acceptor),
                ..SmtpServerConfig::default()
            },
            policy,
            Arc::new(MetricsRegistry::new().unwrap()),
            rx,
        ));

        let connector = TlsConnector::from(Arc::new(client_cfg));
        let tcp = TcpStream::connect(addr).await.unwrap();
        let tls = connector
            .connect(ServerName::try_from("mail.test.local").unwrap(), tcp)
            .await
            .unwrap();
        let mut r = BufReader::new(tls);

        assert!(read_line(&mut r).await.starts_with("220 "));
        r.get_mut().write_all(b"EHLO app.local\r\n").await.unwrap();
        let _ = read_ehlo(&mut r).await;

        for _ in 0..2 {
            r.get_mut().write_all(b"AUTH LOGIN\r\n").await.unwrap();
            assert!(read_line(&mut r).await.starts_with("334 VXNlcm5hbWU6"));
            r.get_mut()
                .write_all(format!("{}\r\n", BASE64.encode("login_user")).as_bytes())
                .await
                .unwrap();
            assert!(read_line(&mut r).await.starts_with("334 UGFzc3dvcmQ6"));
            r.get_mut()
                .write_all(format!("{}\r\n", BASE64.encode("wrong-pw")).as_bytes())
                .await
                .unwrap();
            assert!(read_line(&mut r).await.starts_with("535 "));
        }

        r.get_mut()
            .write_all(
                format!(
                    "AUTH PLAIN {}\r\n",
                    BASE64.encode(b"\0login_user\0pass12345")
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        assert!(read_line(&mut r).await.starts_with("454 "));

        let _ = tx.send(true);
        srv.await.unwrap().unwrap();
    }

    async fn spawn_mock_lmtp_server() -> (
        std::net::SocketAddr,
        Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let lmtp_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let lmtp_addr = lmtp_listener.local_addr().unwrap();
        let delivered_to = Arc::new(Mutex::new(Vec::<String>::new()));
        let dt_ref = Arc::clone(&delivered_to);

        let handle = tokio::spawn(async move {
            let (sock, _) = lmtp_listener.accept().await.unwrap();
            let mut r = BufReader::new(sock);
            r.get_mut()
                .write_all(b"220 dovecot LMTP\r\n")
                .await
                .unwrap();
            let mut rcpts = Vec::new();
            let mut line = String::new();
            loop {
                line.clear();
                if r.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let upper = line.trim().to_ascii_uppercase();
                if upper.starts_with("LHLO") || upper.starts_with("MAIL FROM:") {
                    r.get_mut().write_all(b"250 OK\r\n").await.unwrap();
                } else if let Some(addr_part) = line.trim().strip_prefix("RCPT TO:<") {
                    rcpts.push(addr_part.trim_end_matches('>').to_string());
                    r.get_mut().write_all(b"250 OK\r\n").await.unwrap();
                } else if upper == "DATA" {
                    r.get_mut().write_all(b"354 Go ahead\r\n").await.unwrap();
                    loop {
                        line.clear();
                        r.read_line(&mut line).await.unwrap();
                        if line == ".\r\n" {
                            break;
                        }
                    }
                    let mut replies = String::new();
                    for addr in &rcpts {
                        dt_ref.lock().unwrap().push(addr.clone());
                        replies.push_str("250 2.0.0 Saved\r\n");
                    }
                    r.get_mut().write_all(replies.as_bytes()).await.unwrap();
                } else if upper == "QUIT" {
                    r.get_mut().write_all(b"221 Bye\r\n").await.unwrap();
                    break;
                }
            }
        });
        (lmtp_addr, delivered_to, handle)
    }

    #[tokio::test]
    async fn inbound_processor_expands_alias_delivers_lmtp_and_records_verp_bounce() {
        let (lmtp_addr, delivered_to, mock_lmtp) = spawn_mock_lmtp_server().await;

        let dir = Arc::new(InMemoryDomainDirectory::default());
        dir.add_mailbox_on_server("alice@hosted.example", "127.0.0.1", lmtp_addr.port());
        dir.add_mailbox_on_server("bob@hosted.example", "127.0.0.1", lmtp_addr.port());
        dir.add_alias(
            "sales@hosted.example",
            vec![
                "alice@hosted.example".to_string(),
                "bob@hosted.example".to_string(),
            ],
        );
        dir.add_forwarding("bob@hosted.example", "backup@gmail.com", true);
        dir.add_feedback_domain("bounce.platform.test");

        let store = Arc::new(InMemoryMessageStore::default());
        let lmtp = Arc::new(DovecotLmtpClient::new(LmtpClientConfig::default()));
        let fb_store = Arc::new(InMemoryFeedbackStore::default());
        let processor = InboundProcessor::new(dir, Arc::clone(&store), lmtp, Arc::clone(&fb_store));

        // 1. Alias + forwarding delivery via LMTP
        let obj = store
            .put_message("org-1", b"Subject: Sales Lead\r\n\r\nInterested!\r\n")
            .await
            .unwrap();
        let report = processor
            .process_message(
                "lead@prospect.com",
                &["sales@hosted.example".to_string()],
                &obj.storage_key,
            )
            .await
            .unwrap();

        assert_eq!(report.lmtp_delivered.len(), 2);
        assert_eq!(report.external_forwards, vec!["backup@gmail.com"]);
        let recvd = delivered_to.lock().unwrap().clone();
        assert!(recvd.contains(&"alice@hosted.example".to_string()));
        assert!(recvd.contains(&"bob@hosted.example".to_string()));

        // 2. VERP bounce ingestion
        let dsn = concat!(
            "From: MAILER-DAEMON@mx.example\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/report; report-type=delivery-status; boundary=\"x\"\r\n\r\n",
            "--x\r\nContent-Type: message/delivery-status\r\n\r\n",
            "Final-Recipient: rfc822; bad@remote.example\r\nAction: failed\r\nStatus: 5.1.1\r\n--x--\r\n"
        );
        let dsn_obj = store.put_message("platform", dsn.as_bytes()).await.unwrap();
        let fb_report = processor
            .process_message(
                "",
                &["bounces+rcpt-42@bounce.platform.test".to_string()],
                &dsn_obj.storage_key,
            )
            .await
            .unwrap();

        assert_eq!(fb_report.feedback_events, 1);
        assert!(matches!(
            fb_store.events.lock().unwrap()[0],
            FeedbackClassification::HardBounce {
                recipient_id: Some(_),
                ..
            }
        ));

        mock_lmtp.await.unwrap();
    }
}
