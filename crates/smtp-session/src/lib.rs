//! Async per-connection SMTP session driver supporting TLS (`STARTTLS` and implicit TLS),
//! `AUTH PLAIN`/`LOGIN`, fragmented reads, pipelining, timeouts, and policy hooks.

pub mod auth;
pub mod stream;

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use auth::{decode_sasl_login_field, decode_sasl_plain, AuthCredentials};
use smtp_protocol::{
    parse_command, DataFrameError, DataLineResult, MailParams, ParseError, ProtocolStep,
    SessionConfig, SessionState, SmtpFrameBuffer, SmtpMachine, SmtpResponse,
};
pub use stream::SessionStream;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tracing::{debug, warn};
use zeroize::Zeroizing;

/// Timeout configuration for SMTP connections.
#[derive(Debug, Clone, Copy)]
pub struct SessionTimeouts {
    pub command_idle: Duration,
    pub data_idle: Duration,
    pub tls_handshake: Duration,
}

impl Default for SessionTimeouts {
    fn default() -> Self {
        Self {
            command_idle: Duration::from_secs(300),
            data_idle: Duration::from_secs(120),
            tls_handshake: Duration::from_secs(15),
        }
    }
}

/// Snapshot of the current SMTP session passed to policy handlers.
#[derive(Debug, Clone)]
pub struct SessionContext {
    pub peer_addr: SocketAddr,
    pub tls_active: bool,
    pub authenticated_user: Option<String>,
    pub client_domain: Option<String>,
}

/// Accepted message envelope + unstuffed RFC 5322 payload.
#[derive(Debug, Clone)]
pub struct ReceivedMessage {
    pub reverse_path: Option<String>,
    pub recipients: Vec<String>,
    pub data: Vec<u8>,
}

/// Policy, authentication, and delivery hooks implemented by ingress/submission layers.
pub trait SessionHandler: Send + Sync {
    fn authenticate(
        &self,
        _ctx: &SessionContext,
        _username: &str,
        _password: &str,
    ) -> impl Future<Output = Result<String, SmtpResponse>> + Send {
        std::future::ready(Err(SmtpResponse::not_implemented()))
    }

    fn validate_mail_from(
        &self,
        _ctx: &SessionContext,
        _reverse_path: Option<&str>,
        _params: &MailParams,
    ) -> impl Future<Output = Result<(), SmtpResponse>> + Send {
        std::future::ready(Ok(()))
    }

    fn validate_rcpt_to(
        &self,
        _ctx: &SessionContext,
        _forward_path: &str,
    ) -> impl Future<Output = Result<(), SmtpResponse>> + Send {
        std::future::ready(Ok(()))
    }

    fn on_message(
        &self,
        ctx: &SessionContext,
        message: ReceivedMessage,
    ) -> impl Future<Output = Result<SmtpResponse, SmtpResponse>> + Send;
}

/// Default no-op sink handler useful for protocol smoke tests.
#[derive(Debug, Default, Clone, Copy)]
pub struct AcceptAllHandler;

impl SessionHandler for AcceptAllHandler {
    fn on_message(
        &self,
        _ctx: &SessionContext,
        message: ReceivedMessage,
    ) -> impl Future<Output = Result<SmtpResponse, SmtpResponse>> + Send {
        std::future::ready(Ok(SmtpResponse::ok(format!(
            "OK accepted {} bytes for {} recipient(s)",
            message.data.len(),
            message.recipients.len()
        ))))
    }
}

/// Errors that terminate an SMTP session abnormally.
#[derive(Debug, Error)]
pub enum SessionError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

enum StepFlow {
    NeedRead,
    ReenterLoop,
    Break,
}

/// Runs a complete SMTP session over [`SessionStream`] until `QUIT`, disconnect, timeout, or shutdown.
///
/// # Errors
/// Returns [`SessionError::Io`] on underlying socket write/read failures.
pub async fn run_session<S, H>(
    stream: SessionStream<S>,
    peer_addr: SocketAddr,
    config: SessionConfig,
    timeouts: SessionTimeouts,
    tls_acceptor: Option<TlsAcceptor>,
    handler: &H,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    H: SessionHandler,
{
    let initial_tls = matches!(stream, SessionStream::Tls(_));
    let max_message_size = config.max_message_size;
    let mut stream_opt = Some(stream);
    let mut machine = SmtpMachine::new(config, initial_tls);
    let mut frame = SmtpFrameBuffer::default();
    let mut data_body = Vec::new();

    if let Some(s) = stream_opt.as_mut() {
        write_response(s, &machine.greeting()).await?;
    }

    loop {
        if *shutdown.borrow() && *machine.state() != SessionState::ReceivingData {
            if let Some(s) = stream_opt.as_mut() {
                let _ = write_response(
                    s,
                    &SmtpResponse::service_unavailable("Service shutting down"),
                )
                .await;
            }
            break;
        }

        let flow = step_protocol(
            &mut stream_opt,
            peer_addr,
            &mut machine,
            &mut frame,
            &mut data_body,
            max_message_size,
            timeouts,
            tls_acceptor.as_ref(),
            handler,
        )
        .await?;

        match flow {
            StepFlow::Break => break,
            StepFlow::ReenterLoop => continue,
            StepFlow::NeedRead => {}
        }
        let Some(s) = stream_opt.as_mut() else {
            break;
        };

        let idle_limit = if *machine.state() == SessionState::ReceivingData {
            timeouts.data_idle
        } else {
            timeouts.command_idle
        };

        if matches!(
            read_next_chunk(
                s,
                peer_addr,
                &machine,
                &mut frame,
                idle_limit,
                &mut shutdown
            )
            .await?,
            StepFlow::Break
        ) {
            break;
        }
    }

    if let Some(mut s) = stream_opt {
        let _ = s.shutdown().await;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn step_protocol<S, H>(
    stream_opt: &mut Option<SessionStream<S>>,
    peer_addr: SocketAddr,
    machine: &mut SmtpMachine,
    frame: &mut SmtpFrameBuffer,
    data_body: &mut Vec<u8>,
    max_message_size: u64,
    timeouts: SessionTimeouts,
    tls_acceptor: Option<&TlsAcceptor>,
    handler: &H,
) -> Result<StepFlow, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    H: SessionHandler,
{
    if *machine.state() == SessionState::ReceivingData {
        let Some(s) = stream_opt.as_mut() else {
            return Ok(StepFlow::Break);
        };
        process_data_mode(
            s,
            peer_addr,
            machine,
            frame,
            data_body,
            max_message_size,
            handler,
        )
        .await
    } else {
        process_command_mode(
            stream_opt,
            peer_addr,
            machine,
            frame,
            data_body,
            timeouts,
            tls_acceptor,
            handler,
        )
        .await
    }
}

async fn read_next_chunk<S>(
    stream: &mut SessionStream<S>,
    peer_addr: SocketAddr,
    machine: &SmtpMachine,
    frame: &mut SmtpFrameBuffer,
    idle_limit: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<StepFlow, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut read_buf = [0_u8; 4096];
    let read_res = tokio::select! {
        res = timeout(idle_limit, stream.read(&mut read_buf)) => res,
        _ = shutdown.changed() => {
            if *shutdown.borrow() && *machine.state() != SessionState::ReceivingData {
                let _ = write_response(
                    stream,
                    &SmtpResponse::service_unavailable("Service shutting down"),
                ).await;
                return Ok(StepFlow::Break);
            }
            return Ok(StepFlow::NeedRead);
        }
    };

    match read_res {
        Ok(Ok(0)) => {
            debug!(%peer_addr, "Client closed SMTP connection");
            Ok(StepFlow::Break)
        }
        Ok(Ok(n)) => {
            frame.push_bytes(&read_buf[..n]);
            Ok(StepFlow::ReenterLoop)
        }
        Ok(Err(e)) => Err(SessionError::Io(e)),
        Err(_) => {
            warn!(%peer_addr, "SMTP connection timed out");
            let _ = write_response(
                stream,
                &SmtpResponse::single(421, Some("4.4.2"), "Connection timed out"),
            )
            .await;
            Ok(StepFlow::Break)
        }
    }
}

async fn process_data_mode<S, H>(
    stream: &mut SessionStream<S>,
    peer_addr: SocketAddr,
    machine: &mut SmtpMachine,
    frame: &mut SmtpFrameBuffer,
    data_body: &mut Vec<u8>,
    max_message_size: u64,
    handler: &H,
) -> Result<StepFlow, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    H: SessionHandler,
{
    match frame.drain_data_lines(data_body, max_message_size) {
        Ok(DataLineResult::Complete(msg_bytes)) => {
            let ctx = build_ctx(peer_addr, machine);
            let received = ReceivedMessage {
                reverse_path: machine.reverse_path().map(str::to_string),
                recipients: machine.recipients().to_vec(),
                data: msg_bytes,
            };
            machine.complete_data();
            let reply = match handler.on_message(&ctx, received).await {
                Ok(ok_resp) => ok_resp,
                Err(err_resp) => err_resp,
            };
            write_response(stream, &reply).await?;
            Ok(if frame.has_buffered_bytes() {
                StepFlow::ReenterLoop
            } else {
                StepFlow::NeedRead
            })
        }
        Ok(DataLineResult::NeedMoreData) => Ok(StepFlow::NeedRead),
        Err(DataFrameError::SizeExceeded) => {
            data_body.clear();
            let _ = write_response(stream, &SmtpResponse::size_exceeded()).await;
            Ok(StepFlow::Break)
        }
        Err(DataFrameError::LineTooLong) => {
            data_body.clear();
            let _ = write_response(stream, &SmtpResponse::syntax_error("DATA line too long")).await;
            Ok(StepFlow::Break)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn process_command_mode<S, H>(
    stream_opt: &mut Option<SessionStream<S>>,
    peer_addr: SocketAddr,
    machine: &mut SmtpMachine,
    frame: &mut SmtpFrameBuffer,
    data_body: &mut Vec<u8>,
    timeouts: SessionTimeouts,
    tls_acceptor: Option<&TlsAcceptor>,
    handler: &H,
) -> Result<StepFlow, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    H: SessionHandler,
{
    loop {
        let Some(stream) = stream_opt.as_mut() else {
            return Ok(StepFlow::Break);
        };

        match frame.next_command_line() {
            Ok(Some(line)) => {
                let step = match parse_command(&line) {
                    Ok(cmd) => machine.handle_command(cmd),
                    Err(err) => ProtocolStep::Reply(SmtpMachine::error_to_response(&err)),
                };
                match step {
                    ProtocolStep::Reply(resp) => write_response(stream, &resp).await?,
                    ProtocolStep::ReplyAndClose(resp) => {
                        write_response(stream, &resp).await?;
                        return Ok(StepFlow::Break);
                    }
                    ProtocolStep::ValidateMailFrom {
                        reverse_path,
                        params,
                    } => {
                        let ctx = build_ctx(peer_addr, machine);
                        match handler
                            .validate_mail_from(&ctx, reverse_path.as_deref(), &params)
                            .await
                        {
                            Ok(()) => {
                                machine.commit_mail_from(reverse_path);
                                write_response(stream, &SmtpResponse::ok("OK")).await?;
                            }
                            Err(err_resp) => write_response(stream, &err_resp).await?,
                        }
                    }
                    ProtocolStep::ValidateRcptTo { forward_path } => {
                        let ctx = build_ctx(peer_addr, machine);
                        match handler.validate_rcpt_to(&ctx, &forward_path).await {
                            Ok(()) => {
                                machine.commit_rcpt_to(forward_path);
                                write_response(stream, &SmtpResponse::ok("OK")).await?;
                            }
                            Err(err_resp) => write_response(stream, &err_resp).await?,
                        }
                    }
                    ProtocolStep::EnterDataMode(resp) => {
                        data_body.clear();
                        write_response(stream, &resp).await?;
                        return Ok(if frame.has_buffered_bytes() {
                            StepFlow::ReenterLoop
                        } else {
                            StepFlow::NeedRead
                        });
                    }
                    ProtocolStep::BeginStartTls(resp) => {
                        return upgrade_to_tls(
                            stream_opt,
                            peer_addr,
                            machine,
                            frame,
                            timeouts.tls_handshake,
                            tls_acceptor,
                            &resp,
                        )
                        .await;
                    }
                    ProtocolStep::BeginAuth {
                        mechanism,
                        initial_response,
                    } => {
                        handle_sasl_auth(
                            stream,
                            peer_addr,
                            machine,
                            frame,
                            timeouts.command_idle,
                            handler,
                            &mechanism,
                            initial_response.as_deref(),
                        )
                        .await?;
                    }
                }
            }
            Ok(None) => return Ok(StepFlow::NeedRead),
            Err(err) => {
                write_response(stream, &SmtpMachine::error_to_response(&err)).await?;
                if matches!(err, ParseError::CommandLineTooLong) {
                    return Ok(StepFlow::Break);
                }
            }
        }
    }
}

async fn upgrade_to_tls<S>(
    stream_opt: &mut Option<SessionStream<S>>,
    peer_addr: SocketAddr,
    machine: &mut SmtpMachine,
    frame: &mut SmtpFrameBuffer,
    handshake_timeout: Duration,
    tls_acceptor: Option<&TlsAcceptor>,
    ready_resp: &SmtpResponse,
) -> Result<StepFlow, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let Some(acceptor) = tls_acceptor else {
        if let Some(s) = stream_opt.as_mut() {
            write_response(s, &SmtpResponse::not_implemented()).await?;
        }
        return Ok(StepFlow::NeedRead);
    };

    // Mitigate CVE-2011-0411: reject any clear-text bytes pipelined after STARTTLS.
    if frame.has_buffered_bytes() {
        frame.clear();
        if let Some(s) = stream_opt.as_mut() {
            write_response(
                s,
                &SmtpResponse::invalid_args("Cannot pipeline commands after STARTTLS"),
            )
            .await?;
        }
        return Ok(StepFlow::Break);
    }

    if let Some(s) = stream_opt.as_mut() {
        write_response(s, ready_resp).await?;
    }

    let Some(SessionStream::Plain(plain)) = stream_opt.take() else {
        return Ok(StepFlow::Break);
    };

    match timeout(handshake_timeout, acceptor.accept(plain)).await {
        Ok(Ok(tls_stream)) => {
            *stream_opt = Some(SessionStream::Tls(Box::new(tls_stream)));
            machine.on_tls_upgraded();
            Ok(StepFlow::NeedRead)
        }
        Ok(Err(err)) => {
            warn!(%peer_addr, error = %err, "STARTTLS handshake failed");
            Ok(StepFlow::Break)
        }
        Err(_) => {
            warn!(%peer_addr, "STARTTLS handshake timed out");
            Ok(StepFlow::Break)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_sasl_auth<S, H>(
    stream: &mut SessionStream<S>,
    peer_addr: SocketAddr,
    machine: &mut SmtpMachine,
    frame: &mut SmtpFrameBuffer,
    idle_limit: Duration,
    handler: &H,
    mechanism: &str,
    initial_response: Option<&str>,
) -> Result<(), SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    H: SessionHandler,
{
    let maybe_creds = match mechanism {
        "PLAIN" => sasl_plain_step(stream, frame, idle_limit, initial_response).await?,
        "LOGIN" => sasl_login_step(stream, frame, idle_limit, initial_response).await?,
        _ => {
            write_response(
                stream,
                &SmtpResponse::single(504, Some("5.5.4"), "Unrecognized authentication type"),
            )
            .await?;
            return Ok(());
        }
    };

    let Some(creds) = maybe_creds else {
        return Ok(());
    };

    let ctx = build_ctx(peer_addr, machine);
    match handler
        .authenticate(&ctx, &creds.username, &creds.password)
        .await
    {
        Ok(identity) => {
            machine.on_auth_succeeded(identity);
            write_response(
                stream,
                &SmtpResponse::single(235, Some("2.7.0"), "Authentication successful"),
            )
            .await?;
        }
        Err(err_resp) => write_response(stream, &err_resp).await?,
    }
    Ok(())
}

async fn sasl_plain_step<S>(
    stream: &mut SessionStream<S>,
    frame: &mut SmtpFrameBuffer,
    idle_limit: Duration,
    initial_response: Option<&str>,
) -> Result<Option<AuthCredentials>, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let token = match initial_response {
        Some("=") => String::new(),
        Some(init) => init.to_string(),
        None => {
            let Some(line) = prompt_sasl_line(stream, frame, idle_limit, "").await? else {
                return Ok(None);
            };
            line
        }
    };
    match decode_sasl_plain(&token) {
        Ok(c) => Ok(Some(c)),
        Err(resp) => {
            write_response(stream, &resp).await?;
            Ok(None)
        }
    }
}

async fn sasl_login_step<S>(
    stream: &mut SessionStream<S>,
    frame: &mut SmtpFrameBuffer,
    idle_limit: Duration,
    initial_response: Option<&str>,
) -> Result<Option<AuthCredentials>, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let username_b64 = if let Some(init) = initial_response {
        init.to_string()
    } else {
        let Some(line) = prompt_sasl_line(stream, frame, idle_limit, "VXNlcm5hbWU6").await? else {
            return Ok(None);
        };
        line
    };

    let username: Zeroizing<String> = match decode_sasl_login_field(&username_b64) {
        Ok(u) => u,
        Err(resp) => {
            write_response(stream, &resp).await?;
            return Ok(None);
        }
    };

    let Some(pass_line) = prompt_sasl_line(stream, frame, idle_limit, "UGFzc3dvcmQ6").await? else {
        return Ok(None);
    };

    let password = match decode_sasl_login_field(&pass_line) {
        Ok(p) => p,
        Err(resp) => {
            write_response(stream, &resp).await?;
            return Ok(None);
        }
    };

    Ok(Some(AuthCredentials {
        username: username.to_string(),
        password,
    }))
}

async fn prompt_sasl_line<S>(
    stream: &mut SessionStream<S>,
    frame: &mut SmtpFrameBuffer,
    idle_limit: Duration,
    challenge_b64: &str,
) -> Result<Option<String>, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    write_response(stream, &SmtpResponse::single(334, None, challenge_b64)).await?;
    let Some(line) = read_sasl_line(stream, frame, idle_limit).await? else {
        return Ok(None);
    };
    if line.trim() == "*" {
        write_response(
            stream,
            &SmtpResponse::single(501, Some("5.7.0"), "Authentication cancelled"),
        )
        .await?;
        return Ok(None);
    }
    Ok(Some(line))
}

async fn read_sasl_line<S>(
    stream: &mut SessionStream<S>,
    frame: &mut SmtpFrameBuffer,
    idle_limit: Duration,
) -> Result<Option<String>, SessionError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut read_buf = [0_u8; 1024];
    loop {
        match frame.next_command_line() {
            Ok(Some(line)) => return Ok(Some(line)),
            Ok(None) => {}
            Err(err) => {
                write_response(stream, &SmtpMachine::error_to_response(&err)).await?;
                return Ok(None);
            }
        }

        match timeout(idle_limit, stream.read(&mut read_buf)).await {
            Ok(Ok(0)) | Err(_) => return Ok(None),
            Ok(Ok(n)) => frame.push_bytes(&read_buf[..n]),
            Ok(Err(e)) => return Err(SessionError::Io(e)),
        }
    }
}

fn build_ctx(peer_addr: SocketAddr, machine: &SmtpMachine) -> SessionContext {
    SessionContext {
        peer_addr,
        tls_active: machine.is_tls_active(),
        authenticated_user: machine.authenticated_user().map(str::to_string),
        client_domain: machine.client_domain().map(str::to_string),
    }
}

async fn write_response<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut SessionStream<S>,
    response: &SmtpResponse,
) -> std::io::Result<()> {
    stream.write_all(&response.encode()).await?;
    stream.flush().await
}
