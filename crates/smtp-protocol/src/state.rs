//! Sans-I/O RFC 5321 SMTP session state machine.

use crate::parser::{MailParams, ParseError, SmtpCommand};
use crate::response::SmtpResponse;

/// Static configuration for an SMTP listener port / session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub server_domain: String,
    pub max_message_size: u64,
    pub max_recipients: usize,
    pub advertise_starttls: bool,
    pub advertise_auth: bool,
    pub require_tls_for_auth: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            server_domain: "mail.localhost".to_string(),
            max_message_size: 25 * 1024 * 1024, // 25 MiB
            max_recipients: 100,
            advertise_starttls: false,
            advertise_auth: false,
            require_tls_for_auth: true,
        }
    }
}

/// Current protocol phase of an SMTP connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Connected,
    Greeted,
    MailFrom,
    RcptTo,
    ReceivingData,
    Closed,
}

/// High-level action emitted by [`SmtpMachine`] for the I/O driver to execute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolStep {
    /// Reply immediately with an SMTP response.
    Reply(SmtpResponse),
    /// Reply and close the underlying TCP connection cleanly.
    ReplyAndClose(SmtpResponse),
    /// Ask policy/auth handler to validate `MAIL FROM` before replying `250 OK`.
    ValidateMailFrom {
        reverse_path: Option<String>,
        params: MailParams,
    },
    /// Ask policy/routing handler to validate `RCPT TO` before replying `250 OK`.
    ValidateRcptTo { forward_path: String },
    /// Begin `STARTTLS` upgrade (`220 Ready to start TLS`).
    BeginStartTls(SmtpResponse),
    /// Ask auth handler to process `AUTH <mechanism> [initial]`.
    BeginAuth {
        mechanism: String,
        initial_response: Option<String>,
    },
    /// Enter `DATA` streaming mode (`354 Start mail input`).
    EnterDataMode(SmtpResponse),
}

/// Pure sans-I/O SMTP session state machine.
#[derive(Debug)]
pub struct SmtpMachine {
    config: SessionConfig,
    state: SessionState,
    tls_active: bool,
    authenticated_user: Option<String>,
    client_domain: Option<String>,
    reverse_path: Option<String>,
    recipients: Vec<String>,
}

impl SmtpMachine {
    #[must_use]
    pub fn new(config: SessionConfig, tls_active: bool) -> Self {
        Self {
            config,
            state: SessionState::Connected,
            tls_active,
            authenticated_user: None,
            client_domain: None,
            reverse_path: None,
            recipients: Vec::new(),
        }
    }

    #[must_use]
    pub fn greeting(&self) -> SmtpResponse {
        SmtpResponse::service_ready(&self.config.server_domain)
    }

    #[must_use]
    pub fn state(&self) -> &SessionState {
        &self.state
    }

    #[must_use]
    pub fn is_tls_active(&self) -> bool {
        self.tls_active
    }

    #[must_use]
    pub fn authenticated_user(&self) -> Option<&str> {
        self.authenticated_user.as_deref()
    }

    #[must_use]
    pub fn client_domain(&self) -> Option<&str> {
        self.client_domain.as_deref()
    }

    #[must_use]
    pub fn reverse_path(&self) -> Option<&str> {
        self.reverse_path.as_deref()
    }

    #[must_use]
    pub fn recipients(&self) -> &[String] {
        &self.recipients
    }

    /// Marks TLS as active and resets session state back to initial pre-EHLO per RFC 3207.
    pub fn on_tls_upgraded(&mut self) {
        self.tls_active = true;
        self.state = SessionState::Connected;
        self.client_domain = None;
        self.reset_transaction();
    }

    /// Marks authentication as succeeded for the given identity.
    pub fn on_auth_succeeded(&mut self, identity: String) {
        self.authenticated_user = Some(identity);
    }

    /// Commits a validated `MAIL FROM` into the state machine.
    pub fn commit_mail_from(&mut self, reverse_path: Option<String>) {
        self.reverse_path = reverse_path;
        self.recipients.clear();
        self.state = SessionState::MailFrom;
    }

    /// Commits a validated `RCPT TO` into the state machine.
    pub fn commit_rcpt_to(&mut self, forward_path: String) {
        self.recipients.push(forward_path);
        self.state = SessionState::RcptTo;
    }

    /// Completes `DATA` reception and resets envelope state back to `Greeted`.
    pub fn complete_data(&mut self) {
        self.reset_transaction();
        self.state = SessionState::Greeted;
    }

    /// Converts a parser error into the appropriate SMTP reply.
    #[must_use]
    pub fn error_to_response(err: &ParseError) -> SmtpResponse {
        match err {
            ParseError::UnknownCommand => SmtpResponse::syntax_error("Command not recognized"),
            ParseError::CommandLineTooLong => SmtpResponse::syntax_error("Line too long"),
            ParseError::BareLineFeed => SmtpResponse::syntax_error("Bare LF not allowed"),
            ParseError::InvalidUtf8 | ParseError::InvalidSyntax(_) => {
                SmtpResponse::invalid_args(err.to_string())
            }
            ParseError::UnsupportedParameter(p) => {
                SmtpResponse::unsupported_param(format!("Unsupported parameter: {p}"))
            }
        }
    }

    /// Advances the state machine with a parsed SMTP command.
    pub fn handle_command(&mut self, cmd: SmtpCommand) -> ProtocolStep {
        match cmd {
            SmtpCommand::Quit => {
                self.state = SessionState::Closed;
                ProtocolStep::ReplyAndClose(SmtpResponse::closing(&self.config.server_domain))
            }
            SmtpCommand::Noop(_) => ProtocolStep::Reply(SmtpResponse::ok("OK")),
            SmtpCommand::Rset => {
                self.reset_transaction();
                if self.state != SessionState::Connected {
                    self.state = SessionState::Greeted;
                }
                ProtocolStep::Reply(SmtpResponse::ok("Reset state"))
            }
            SmtpCommand::Helo(domain) => {
                self.client_domain = Some(domain);
                self.reset_transaction();
                self.state = SessionState::Greeted;
                ProtocolStep::Reply(SmtpResponse::ok(format!(
                    "{} Hello",
                    self.config.server_domain
                )))
            }
            SmtpCommand::Ehlo(domain) => {
                self.client_domain = Some(domain);
                self.reset_transaction();
                self.state = SessionState::Greeted;
                ProtocolStep::Reply(self.build_ehlo_response())
            }
            SmtpCommand::StartTls => self.handle_starttls(),
            SmtpCommand::Auth {
                mechanism,
                initial_response,
            } => self.handle_auth(mechanism, initial_response),
            SmtpCommand::MailFrom {
                reverse_path,
                params,
            } => self.handle_mail_from(reverse_path, params),
            SmtpCommand::RcptTo { forward_path } => self.handle_rcpt_to(forward_path),
            SmtpCommand::Data => self.handle_data(),
        }
    }

    fn build_ehlo_response(&self) -> SmtpResponse {
        let mut caps = vec![
            self.config.server_domain.clone(),
            format!("SIZE {}", self.config.max_message_size),
            "8BITMIME".to_string(),
            "SMTPUTF8".to_string(),
            "PIPELINING".to_string(),
            "ENHANCEDSTATUSCODES".to_string(),
        ];

        if self.config.advertise_starttls && !self.tls_active {
            caps.push("STARTTLS".to_string());
        }

        if self.config.advertise_auth
            && (!self.config.require_tls_for_auth || self.tls_active)
            && self.authenticated_user.is_none()
        {
            caps.push("AUTH PLAIN LOGIN".to_string());
        }

        SmtpResponse::multiline(250, None, caps)
    }

    fn handle_starttls(&self) -> ProtocolStep {
        if !self.config.advertise_starttls {
            return ProtocolStep::Reply(SmtpResponse::not_implemented());
        }
        if self.tls_active {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence("TLS already active"));
        }
        if self.state == SessionState::Connected {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence("Send EHLO/HELO first"));
        }
        ProtocolStep::BeginStartTls(SmtpResponse::ready_for_tls())
    }

    fn handle_auth(&self, mechanism: String, initial_response: Option<String>) -> ProtocolStep {
        if !self.config.advertise_auth {
            return ProtocolStep::Reply(SmtpResponse::not_implemented());
        }
        if self.state != SessionState::Greeted {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence(
                "AUTH only permitted in greeted state outside mail transaction",
            ));
        }
        if self.config.require_tls_for_auth && !self.tls_active {
            return ProtocolStep::Reply(SmtpResponse::single(
                538,
                Some("5.7.11"),
                "Encryption required for requested authentication mechanism",
            ));
        }
        if self.authenticated_user.is_some() {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence("Already authenticated"));
        }
        ProtocolStep::BeginAuth {
            mechanism,
            initial_response,
        }
    }

    fn handle_mail_from(&self, reverse_path: Option<String>, params: MailParams) -> ProtocolStep {
        if self.state != SessionState::Greeted {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence(
                if self.state == SessionState::Connected {
                    "Send EHLO/HELO first"
                } else {
                    "Nested MAIL command"
                },
            ));
        }

        if let Some(declared_size) = params.size {
            if declared_size > self.config.max_message_size {
                return ProtocolStep::Reply(SmtpResponse::size_exceeded());
            }
        }

        ProtocolStep::ValidateMailFrom {
            reverse_path,
            params,
        }
    }

    fn handle_rcpt_to(&self, forward_path: String) -> ProtocolStep {
        if self.state != SessionState::MailFrom && self.state != SessionState::RcptTo {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence(
                "Need MAIL FROM before RCPT TO",
            ));
        }
        if self.recipients.len() >= self.config.max_recipients {
            return ProtocolStep::Reply(SmtpResponse::too_many_recipients());
        }
        ProtocolStep::ValidateRcptTo { forward_path }
    }

    fn handle_data(&mut self) -> ProtocolStep {
        if self.state != SessionState::RcptTo || self.recipients.is_empty() {
            return ProtocolStep::Reply(SmtpResponse::bad_sequence("Need RCPT TO before DATA"));
        }
        self.state = SessionState::ReceivingData;
        ProtocolStep::EnterDataMode(SmtpResponse::start_mail_input())
    }

    fn reset_transaction(&mut self) {
        self.reverse_path = None;
        self.recipients.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_rfc_state_transitions_and_caps() {
        let mut machine = SmtpMachine::new(
            SessionConfig {
                max_message_size: 1024,
                max_recipients: 2,
                advertise_starttls: true,
                advertise_auth: true,
                require_tls_for_auth: true,
                ..SessionConfig::default()
            },
            false,
        );

        // MAIL before EHLO -> 503
        match machine.handle_command(SmtpCommand::MailFrom {
            reverse_path: None,
            params: MailParams::default(),
        }) {
            ProtocolStep::Reply(r) => assert_eq!(r.code, 503),
            other => panic!("unexpected step: {other:?}"),
        }

        // EHLO before TLS must advertise STARTTLS but NOT AUTH
        match machine.handle_command(SmtpCommand::Ehlo("client.local".to_string())) {
            ProtocolStep::Reply(r) => {
                let wire = String::from_utf8(r.encode()).unwrap();
                assert!(wire.contains("STARTTLS"));
                assert!(!wire.contains("AUTH"));
            }
            other => panic!("unexpected step: {other:?}"),
        }

        // AUTH before TLS -> 538
        match machine.handle_command(SmtpCommand::Auth {
            mechanism: "PLAIN".to_string(),
            initial_response: None,
        }) {
            ProtocolStep::Reply(r) => assert_eq!(r.code, 538),
            other => panic!("unexpected step: {other:?}"),
        }

        // Upgrade TLS -> resets to Connected, EHLO now advertises AUTH
        machine.on_tls_upgraded();
        match machine.handle_command(SmtpCommand::Ehlo("client.local".to_string())) {
            ProtocolStep::Reply(r) => {
                let wire = String::from_utf8(r.encode()).unwrap();
                assert!(!wire.contains("STARTTLS"));
                assert!(wire.contains("AUTH PLAIN LOGIN"));
            }
            other => panic!("unexpected step: {other:?}"),
        }

        // SIZE exceeding limit -> 552
        match machine.handle_command(SmtpCommand::MailFrom {
            reverse_path: Some("a@b.com".to_string()),
            params: MailParams {
                size: Some(2048),
                ..MailParams::default()
            },
        }) {
            ProtocolStep::Reply(r) => assert_eq!(r.code, 552),
            other => panic!("unexpected step: {other:?}"),
        }

        // Recipient limit -> 452
        machine.commit_mail_from(Some("a@b.com".to_string()));
        machine.commit_rcpt_to("1@b.com".to_string());
        machine.commit_rcpt_to("2@b.com".to_string());
        match machine.handle_command(SmtpCommand::RcptTo {
            forward_path: "3@b.com".to_string(),
        }) {
            ProtocolStep::Reply(r) => assert_eq!(r.code, 452),
            other => panic!("unexpected step: {other:?}"),
        }
    }
}
