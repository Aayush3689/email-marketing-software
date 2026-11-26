//! Incremental SMTP TCP stream framing, command parsing, and DATA dot-unstuffing.

use bytes::{Buf, BytesMut};
use thiserror::Error;

/// Default RFC 5321 command line limit (extended slightly to accommodate AUTH lines).
pub const DEFAULT_MAX_COMMAND_LINE_LEN: usize = 2048;
/// Default per-line cap inside DATA to prevent unbounded line buffering on malformed streams.
pub const DEFAULT_MAX_DATA_LINE_LEN: usize = 16384;

/// Parsed ESMTP parameters attached to `MAIL FROM`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MailParams {
    pub size: Option<u64>,
    pub body_8bit: bool,
    pub smtp_utf8: bool,
}

/// Parsed SMTP command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SmtpCommand {
    Ehlo(String),
    Helo(String),
    MailFrom {
        reverse_path: Option<String>,
        params: MailParams,
    },
    RcptTo {
        forward_path: String,
    },
    Data,
    Rset,
    Noop(Option<String>),
    Quit,
    StartTls,
    Auth {
        mechanism: String,
        initial_response: Option<String>,
    },
}

/// Errors produced while framing or parsing SMTP commands.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ParseError {
    #[error("command line exceeds maximum length")]
    CommandLineTooLong,
    #[error("bare LF without CR in command line")]
    BareLineFeed,
    #[error("non-UTF8 command line")]
    InvalidUtf8,
    #[error("unrecognized command")]
    UnknownCommand,
    #[error("invalid command syntax: {0}")]
    InvalidSyntax(&'static str),
    #[error("unsupported ESMTP parameter: {0}")]
    UnsupportedParameter(String),
}

/// Errors produced while framing DATA stream.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DataFrameError {
    #[error("DATA line exceeds maximum buffered length")]
    LineTooLong,
    #[error("message exceeds maximum allowed size")]
    SizeExceeded,
}

/// Result of feeding bytes in DATA mode.
#[derive(Debug, PartialEq, Eq)]
pub enum DataLineResult {
    /// Normal line appended (not yet end of DATA).
    NeedMoreData,
    /// Encountered `<CRLF>.<CRLF>` terminator; returns finalized message bytes.
    Complete(Vec<u8>),
}

/// Incremental TCP stream buffer handling fragmented and coalesced SMTP reads.
#[derive(Debug)]
pub struct SmtpFrameBuffer {
    buf: BytesMut,
    max_command_line_len: usize,
    max_data_line_len: usize,
}

impl Default for SmtpFrameBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_COMMAND_LINE_LEN, DEFAULT_MAX_DATA_LINE_LEN)
    }
}

impl SmtpFrameBuffer {
    #[must_use]
    pub fn new(max_command_line_len: usize, max_data_line_len: usize) -> Self {
        Self {
            buf: BytesMut::with_capacity(4096),
            max_command_line_len,
            max_data_line_len,
        }
    }

    /// Appends newly read bytes from the TCP socket.
    pub fn push_bytes(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// Returns true if unconsumed bytes remain in the framing buffer.
    #[must_use]
    pub fn has_buffered_bytes(&self) -> bool {
        !self.buf.is_empty()
    }

    /// Clears all buffered bytes (used when resetting or rejecting post-STARTTLS pipelined bytes).
    pub fn clear(&mut self) {
        self.buf.clear();
    }

    /// Extracts the next complete CRLF-terminated command line if available.
    ///
    /// # Errors
    /// Returns [`ParseError::BareLineFeed`] on `\n` without `\r` or [`ParseError::CommandLineTooLong`]
    /// if the buffered line exceeds `max_command_line_len`.
    pub fn next_command_line(&mut self) -> Result<Option<String>, ParseError> {
        let search_limit = self.buf.len().min(self.max_command_line_len);
        for idx in 0..search_limit {
            if self.buf[idx] == b'\n' {
                if idx == 0 || self.buf[idx - 1] != b'\r' {
                    self.buf.advance(idx + 1);
                    return Err(ParseError::BareLineFeed);
                }
                let line_bytes = self.buf.split_to(idx + 1);
                let content = &line_bytes[..idx - 1];
                let line = std::str::from_utf8(content)
                    .map_err(|_| ParseError::InvalidUtf8)?
                    .to_string();
                return Ok(Some(line));
            }
        }

        if self.buf.len() >= self.max_command_line_len {
            self.buf.clear();
            return Err(ParseError::CommandLineTooLong);
        }

        Ok(None)
    }

    /// Drains complete CRLF-terminated lines in DATA mode, performing RFC 5321 dot-unstuffing
    /// into `body` until `<CRLF>.<CRLF>` (or leading `.\r\n`) is encountered.
    ///
    /// # Errors
    /// Returns [`DataFrameError::LineTooLong`] if a single DATA line exceeds the configured bound,
    /// or [`DataFrameError::SizeExceeded`] if `body.len()` exceeds `max_message_size`.
    pub fn drain_data_lines(
        &mut self,
        body: &mut Vec<u8>,
        max_message_size: u64,
    ) -> Result<DataLineResult, DataFrameError> {
        loop {
            let search_limit = self.buf.len().min(self.max_data_line_len);
            let mut found_lf = None;
            for idx in 0..search_limit {
                if self.buf[idx] == b'\n' {
                    found_lf = Some(idx);
                    break;
                }
            }

            let Some(lf_idx) = found_lf else {
                if self.buf.len() >= self.max_data_line_len {
                    self.buf.clear();
                    return Err(DataFrameError::LineTooLong);
                }
                return Ok(DataLineResult::NeedMoreData);
            };

            let has_cr = lf_idx > 0 && self.buf[lf_idx - 1] == b'\r';
            let raw_line = self.buf.split_to(lf_idx + 1);
            let line_without_eol = if has_cr {
                &raw_line[..lf_idx - 1]
            } else {
                &raw_line[..lf_idx]
            };

            // End of DATA indicator: a single '.' on a line by itself
            if line_without_eol == b"." && has_cr {
                return Ok(DataLineResult::Complete(std::mem::take(body)));
            }

            // RFC 5321 Section 4.5.2 dot-unstuffing: leading '.' followed by another char
            let unstuffed = if line_without_eol.starts_with(b".") {
                &line_without_eol[1..]
            } else {
                line_without_eol
            };

            let additional = unstuffed.len() + if has_cr { 2 } else { 1 };
            let next_len = (body.len() + additional) as u64;
            if next_len > max_message_size {
                return Err(DataFrameError::SizeExceeded);
            }

            body.extend_from_slice(unstuffed);
            if has_cr {
                body.extend_from_slice(b"\r\n");
            } else {
                body.push(b'\n');
            }
        }
    }
}

/// Parses a single CRLF-stripped SMTP command line.
///
/// # Errors
/// Returns [`ParseError`] for unknown verbs, syntax violations, or unsupported parameters.
pub fn parse_command(line: &str) -> Result<SmtpCommand, ParseError> {
    if line.is_empty() {
        return Err(ParseError::InvalidSyntax("empty command"));
    }

    let (verb_raw, rest) = match line.find(' ') {
        Some(idx) => (&line[..idx], line[idx + 1..].trim_start_matches(' ')),
        None => (line, ""),
    };

    let verb = verb_raw.to_ascii_uppercase();
    match verb.as_str() {
        "EHLO" => {
            let domain = rest.trim();
            if domain.is_empty() || domain.contains(char::is_whitespace) {
                return Err(ParseError::InvalidSyntax(
                    "EHLO requires a single domain argument",
                ));
            }
            Ok(SmtpCommand::Ehlo(domain.to_string()))
        }
        "HELO" => {
            let domain = rest.trim();
            if domain.is_empty() || domain.contains(char::is_whitespace) {
                return Err(ParseError::InvalidSyntax(
                    "HELO requires a single domain argument",
                ));
            }
            Ok(SmtpCommand::Helo(domain.to_string()))
        }
        "MAIL" => parse_mail_from(rest),
        "RCPT" => parse_rcpt_to(rest),
        "DATA" => {
            if !rest.is_empty() {
                return Err(ParseError::InvalidSyntax("DATA takes no arguments"));
            }
            Ok(SmtpCommand::Data)
        }
        "RSET" => {
            if !rest.is_empty() {
                return Err(ParseError::InvalidSyntax("RSET takes no arguments"));
            }
            Ok(SmtpCommand::Rset)
        }
        "NOOP" => Ok(SmtpCommand::Noop(if rest.is_empty() {
            None
        } else {
            Some(rest.to_string())
        })),
        "QUIT" => {
            if !rest.is_empty() {
                return Err(ParseError::InvalidSyntax("QUIT takes no arguments"));
            }
            Ok(SmtpCommand::Quit)
        }
        "STARTTLS" => {
            if !rest.is_empty() {
                return Err(ParseError::InvalidSyntax("STARTTLS takes no arguments"));
            }
            Ok(SmtpCommand::StartTls)
        }
        "AUTH" => parse_auth(rest),
        _ => Err(ParseError::UnknownCommand),
    }
}

fn parse_mail_from(rest: &str) -> Result<SmtpCommand, ParseError> {
    let prefix = rest
        .get(..5)
        .ok_or(ParseError::InvalidSyntax("expected MAIL FROM:<...>"))?;
    if !prefix.eq_ignore_ascii_case("FROM:") {
        return Err(ParseError::InvalidSyntax("expected MAIL FROM:<...>"));
    }

    let after_colon = rest[5..].trim_start();
    let (reverse_path, params_raw) = parse_angle_bracket_path(after_colon, true)?;
    let mut params = MailParams::default();

    for token in params_raw.split_whitespace() {
        let upper = token.to_ascii_uppercase();
        if let Some(size_str) = upper.strip_prefix("SIZE=") {
            let size = size_str
                .parse::<u64>()
                .map_err(|_| ParseError::InvalidSyntax("invalid SIZE parameter"))?;
            params.size = Some(size);
        } else if upper == "BODY=8BITMIME" {
            params.body_8bit = true;
        } else if upper == "BODY=7BIT" {
            params.body_8bit = false;
        } else if upper == "SMTPUTF8" {
            params.smtp_utf8 = true;
        } else {
            return Err(ParseError::UnsupportedParameter(token.to_string()));
        }
    }

    Ok(SmtpCommand::MailFrom {
        reverse_path,
        params,
    })
}

fn parse_rcpt_to(rest: &str) -> Result<SmtpCommand, ParseError> {
    let prefix = rest
        .get(..3)
        .ok_or(ParseError::InvalidSyntax("expected RCPT TO:<...>"))?;
    if !prefix.eq_ignore_ascii_case("TO:") {
        return Err(ParseError::InvalidSyntax("expected RCPT TO:<...>"));
    }

    let after_colon = rest[3..].trim_start();
    let (forward_path, trailing) = parse_angle_bracket_path(after_colon, false)?;
    if !trailing.trim().is_empty() {
        return Err(ParseError::UnsupportedParameter(
            trailing.trim().to_string(),
        ));
    }

    let addr = forward_path.ok_or(ParseError::InvalidSyntax("RCPT TO cannot be empty"))?;
    Ok(SmtpCommand::RcptTo { forward_path: addr })
}

fn parse_auth(rest: &str) -> Result<SmtpCommand, ParseError> {
    let trimmed = rest.trim();
    if trimmed.is_empty() {
        return Err(ParseError::InvalidSyntax("AUTH requires mechanism"));
    }
    let (mechanism, initial_response) = match trimmed.find(' ') {
        Some(idx) => {
            let init = trimmed[idx + 1..].trim();
            (
                trimmed[..idx].to_ascii_uppercase(),
                if init.is_empty() {
                    None
                } else {
                    Some(init.to_string())
                },
            )
        }
        None => (trimmed.to_ascii_uppercase(), None),
    };
    Ok(SmtpCommand::Auth {
        mechanism,
        initial_response,
    })
}

fn parse_angle_bracket_path(
    input: &str,
    allow_null: bool,
) -> Result<(Option<String>, &str), ParseError> {
    if !input.starts_with('<') {
        return Err(ParseError::InvalidSyntax(
            "address must be enclosed in <...>",
        ));
    }
    let close_idx = input[1..]
        .find('>')
        .map(|i| i + 1)
        .ok_or(ParseError::InvalidSyntax("missing closing '>' in address"))?;

    let inner = &input[1..close_idx];
    let trailing = &input[close_idx + 1..];

    if inner.is_empty() {
        if allow_null {
            return Ok((None, trailing));
        }
        return Err(ParseError::InvalidSyntax("empty path not allowed"));
    }

    if !is_valid_email_path(inner) {
        return Err(ParseError::InvalidSyntax("malformed email address"));
    }

    Ok((Some(inner.to_string()), trailing))
}

fn is_valid_email_path(addr: &str) -> bool {
    if addr.len() > 320 || addr.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let Some((local, domain)) = addr.rsplit_once('@') else {
        return false;
    };
    if local.is_empty() || local.len() > 64 || domain.is_empty() || domain.len() > 253 {
        return false;
    }
    if domain.starts_with('.') || domain.ends_with('.') || domain.contains("..") {
        return false;
    }
    // Reject angle brackets inside path
    !local.contains('<') && !local.contains('>') && !domain.contains('<') && !domain.contains('>')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_fragmented_one_byte_reads_and_coalesced_commands() {
        let mut buf = SmtpFrameBuffer::default();
        let stream = b"EHLO client.example.com\r\nMAIL FROM:<sender@example.com> SIZE=512 BODY=8BITMIME\r\nRCPT TO:<user@domain.com>\r\n";

        let mut lines = Vec::new();
        for byte in stream.chunks(1) {
            buf.push_bytes(byte);
            while let Some(line) = buf.next_command_line().expect("valid framing") {
                lines.push(line);
            }
        }

        assert_eq!(lines.len(), 3);
        assert_eq!(
            parse_command(&lines[0]).unwrap(),
            SmtpCommand::Ehlo("client.example.com".to_string())
        );
        assert_eq!(
            parse_command(&lines[1]).unwrap(),
            SmtpCommand::MailFrom {
                reverse_path: Some("sender@example.com".to_string()),
                params: MailParams {
                    size: Some(512),
                    body_8bit: true,
                    smtp_utf8: false,
                }
            }
        );
        assert_eq!(
            parse_command(&lines[2]).unwrap(),
            SmtpCommand::RcptTo {
                forward_path: "user@domain.com".to_string()
            }
        );
    }

    #[test]
    fn parses_null_reverse_path_and_rejects_bad_paths() {
        let cmd = parse_command("MAIL FROM:<> SMTPUTF8").unwrap();
        assert_eq!(
            cmd,
            SmtpCommand::MailFrom {
                reverse_path: None,
                params: MailParams {
                    size: None,
                    body_8bit: false,
                    smtp_utf8: true,
                }
            }
        );
        assert!(parse_command("RCPT TO:<>").is_err());
        assert!(parse_command("MAIL FROM:user@example.com").is_err());
    }

    #[test]
    fn unstuffs_dots_and_handles_empty_data_across_chunks() {
        let mut buf = SmtpFrameBuffer::default();
        let mut body = Vec::new();
        buf.push_bytes(b".\r\n");
        let res = buf.drain_data_lines(&mut body, 1024).unwrap();
        assert_eq!(res, DataLineResult::Complete(Vec::new()));

        let mut buf2 = SmtpFrameBuffer::default();
        let mut body2 = Vec::new();
        let payload = b"Subject: Test\r\n\r\n..leading dot\r\n.\r\n";
        let mut final_body = None;
        for chunk in payload.chunks(3) {
            buf2.push_bytes(chunk);
            if let DataLineResult::Complete(msg) = buf2.drain_data_lines(&mut body2, 1024).unwrap()
            {
                final_body = Some(msg);
            }
        }
        assert_eq!(
            final_body.unwrap(),
            b"Subject: Test\r\n\r\n.leading dot\r\n"
        );
    }

    #[test]
    fn rejects_oversized_data_and_oversized_command_lines() {
        let mut buf = SmtpFrameBuffer::new(32, 64);
        buf.push_bytes(&[b'A'; 40]);
        assert_eq!(buf.next_command_line(), Err(ParseError::CommandLineTooLong));

        let mut data_buf = SmtpFrameBuffer::default();
        let mut body = Vec::new();
        data_buf.push_bytes(b"Hello World\r\n");
        assert_eq!(
            data_buf.drain_data_lines(&mut body, 5),
            Err(DataFrameError::SizeExceeded)
        );
    }
}
