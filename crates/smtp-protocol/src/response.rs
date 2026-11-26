//! RFC 5321 / RFC 2034 SMTP response formatting, including multiline replies.

use std::fmt::Write as _;

/// Represents an SMTP reply sent from server to client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmtpResponse {
    pub code: u16,
    pub enhanced: Option<&'static str>,
    pub lines: Vec<String>,
}

impl SmtpResponse {
    /// Creates a single-line SMTP response.
    #[must_use]
    pub fn single(code: u16, enhanced: Option<&'static str>, message: impl Into<String>) -> Self {
        Self {
            code,
            enhanced,
            lines: vec![message.into()],
        }
    }

    /// Creates a multiline SMTP response.
    #[must_use]
    pub fn multiline(code: u16, enhanced: Option<&'static str>, lines: Vec<String>) -> Self {
        let lines = if lines.is_empty() {
            vec![String::new()]
        } else {
            lines
        };
        Self {
            code,
            enhanced,
            lines,
        }
    }

    /// Serializes the response into RFC 5321 wire format with CRLF line endings.
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = String::new();
        let last_idx = self.lines.len().saturating_sub(1);
        for (idx, line) in self.lines.iter().enumerate() {
            let sep = if idx == last_idx { ' ' } else { '-' };
            if let Some(enh) = self.enhanced {
                let _ = write!(out, "{}{sep}{enh} {line}\r\n", self.code);
            } else {
                let _ = write!(out, "{}{sep}{line}\r\n", self.code);
            }
        }
        out.into_bytes()
    }

    #[must_use]
    pub fn service_ready(domain: &str) -> Self {
        Self::single(220, None, format!("{domain} ESMTP ready"))
    }

    #[must_use]
    pub fn closing(domain: &str) -> Self {
        Self::single(221, Some("2.0.0"), format!("{domain} closing connection"))
    }

    #[must_use]
    pub fn ok(message: impl Into<String>) -> Self {
        Self::single(250, Some("2.0.0"), message)
    }

    #[must_use]
    pub fn start_mail_input() -> Self {
        Self::single(354, None, "Start mail input; end with <CRLF>.<CRLF>")
    }

    #[must_use]
    pub fn ready_for_tls() -> Self {
        Self::single(220, Some("2.0.0"), "Ready to start TLS")
    }

    #[must_use]
    pub fn service_unavailable(reason: impl Into<String>) -> Self {
        Self::single(421, Some("4.3.2"), reason)
    }

    #[must_use]
    pub fn too_many_recipients() -> Self {
        Self::single(452, Some("4.5.3"), "Too many recipients")
    }

    #[must_use]
    pub fn syntax_error(reason: impl Into<String>) -> Self {
        Self::single(500, Some("5.5.2"), reason)
    }

    #[must_use]
    pub fn invalid_args(reason: impl Into<String>) -> Self {
        Self::single(501, Some("5.5.4"), reason)
    }

    #[must_use]
    pub fn not_implemented() -> Self {
        Self::single(502, Some("5.5.1"), "Command not implemented")
    }

    #[must_use]
    pub fn bad_sequence(reason: impl Into<String>) -> Self {
        Self::single(503, Some("5.5.1"), reason)
    }

    #[must_use]
    pub fn size_exceeded() -> Self {
        Self::single(
            552,
            Some("5.3.4"),
            "Message size exceeds fixed maximum message size",
        )
    }

    #[must_use]
    pub fn unsupported_param(reason: impl Into<String>) -> Self {
        Self::single(555, Some("5.5.4"), reason)
    }
}

#[cfg(test)]
mod tests {
    use super::SmtpResponse;

    #[test]
    fn encodes_single_and_multiline_responses() {
        let single = SmtpResponse::ok("Queued");
        assert_eq!(single.encode(), b"250 2.0.0 Queued\r\n");

        let ehlo = SmtpResponse::multiline(
            250,
            None,
            vec![
                "mail.example.com".to_string(),
                "SIZE 26214400".to_string(),
                "8BITMIME".to_string(),
                "PIPELINING".to_string(),
            ],
        );
        assert_eq!(
            ehlo.encode(),
            b"250-mail.example.com\r\n250-SIZE 26214400\r\n250-8BITMIME\r\n250 PIPELINING\r\n"
        );
    }
}
