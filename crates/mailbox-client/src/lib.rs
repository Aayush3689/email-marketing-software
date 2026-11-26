//! Async RFC 2033 Dovecot LMTP client for local mailbox delivery.
//!
//! Unlike SMTP, LMTP returns one final status reply per accepted `RCPT TO`
//! after `<CRLF>.<CRLF>`, enabling per-mailbox quota/status handling.

use std::future::Future;
use std::time::Duration;

use anyhow::{bail, Result};
use smtp_outbound::dot_stuff_payload;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;

const MAX_LMTP_LINE_BYTES: usize = 16 * 1024;

fn has_crlf_or_nul(s: &str) -> bool {
    s.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
}

/// Per-recipient delivery status returned by Dovecot LMTP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LmtpRecipientStatus {
    Delivered { smtp_code: u16, message: String },
    TempFail { smtp_code: u16, message: String },
    PermFail { smtp_code: u16, message: String },
}

/// Per-recipient delivery outcome pairing address with its LMTP status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LmtpRecipientResult {
    pub recipient: String,
    pub status: LmtpRecipientStatus,
}

/// Configuration for connecting to a Dovecot LMTP endpoint.
#[derive(Debug, Clone)]
pub struct LmtpClientConfig {
    pub lhlo_domain: String,
    pub connect_timeout: Duration,
    pub command_timeout: Duration,
    pub data_timeout: Duration,
}

impl Default for LmtpClientConfig {
    fn default() -> Self {
        Self {
            lhlo_domain: "mta.platform.local".to_string(),
            connect_timeout: Duration::from_secs(5),
            command_timeout: Duration::from_secs(15),
            data_timeout: Duration::from_secs(60),
        }
    }
}

/// Transport/protocol errors from an LMTP session.
#[derive(Debug, Error)]
pub enum LmtpError {
    #[error("LMTP connection failed: {0}")]
    Connect(String),
    #[error("LMTP protocol error: {0}")]
    Protocol(String),
    #[error("LMTP I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Abstraction over LMTP delivery so tests and production Dovecot share one interface.
pub trait MailboxDeliverer: Send + Sync {
    fn deliver_lmtp(
        &self,
        lmtp_host: &str,
        lmtp_port: u16,
        envelope_from: &str,
        recipients: &[String],
        raw_mime: &[u8],
    ) -> impl Future<Output = Result<Vec<LmtpRecipientResult>>> + Send;
}

/// Async TCP LMTP client speaking RFC 2033 to Dovecot (`lmtpd`).
#[derive(Debug, Clone)]
pub struct DovecotLmtpClient {
    config: LmtpClientConfig,
}

impl DovecotLmtpClient {
    #[must_use]
    pub fn new(config: LmtpClientConfig) -> Self {
        Self { config }
    }
}

impl MailboxDeliverer for DovecotLmtpClient {
    async fn deliver_lmtp(
        &self,
        lmtp_host: &str,
        lmtp_port: u16,
        envelope_from: &str,
        recipients: &[String],
        raw_mime: &[u8],
    ) -> Result<Vec<LmtpRecipientResult>> {
        if recipients.is_empty() {
            return Ok(Vec::new());
        }
        if has_crlf_or_nul(&self.config.lhlo_domain)
            || has_crlf_or_nul(envelope_from)
            || recipients.iter().any(|r| has_crlf_or_nul(r))
        {
            bail!(LmtpError::Protocol(
                "CR/LF/NUL rejected in LMTP command parameters".to_string()
            ));
        }

        let addr = format!("{lmtp_host}:{lmtp_port}");
        let stream = timeout(self.config.connect_timeout, TcpStream::connect(&addr))
            .await
            .map_err(|_| LmtpError::Connect(format!("timed out connecting to {addr}")))?
            .map_err(|e| LmtpError::Connect(format!("{addr}: {e}")))?;

        let mut reader = BufReader::new(stream);

        // 1. 220 greeting
        let (code, msg) = read_reply(&mut reader, self.config.command_timeout).await?;
        if code != 220 {
            bail!(LmtpError::Protocol(format!(
                "unexpected greeting {code}: {msg}"
            )));
        }

        // 2. LHLO
        write_cmd(
            &mut reader,
            &format!("LHLO {}\r\n", self.config.lhlo_domain),
        )
        .await?;
        let (lhlo_code, lhlo_msg) = read_reply(&mut reader, self.config.command_timeout).await?;
        if lhlo_code != 250 {
            bail!(LmtpError::Protocol(format!(
                "LHLO rejected {lhlo_code}: {lhlo_msg}"
            )));
        }

        // 3. MAIL FROM
        write_cmd(&mut reader, &format!("MAIL FROM:<{envelope_from}>\r\n")).await?;
        let (mail_code, mail_msg) = read_reply(&mut reader, self.config.command_timeout).await?;
        if mail_code != 250 {
            bail!(LmtpError::Protocol(format!(
                "MAIL FROM rejected {mail_code}: {mail_msg}"
            )));
        }

        // 4. RCPT TO per recipient (track accepted vs early-rejected)
        let mut results = Vec::with_capacity(recipients.len());
        let mut accepted_indices = Vec::new();

        for (idx, rcpt) in recipients.iter().enumerate() {
            write_cmd(&mut reader, &format!("RCPT TO:<{rcpt}>\r\n")).await?;
            let (rcpt_code, rcpt_msg) =
                read_reply(&mut reader, self.config.command_timeout).await?;
            if (200..300).contains(&rcpt_code) {
                accepted_indices.push(idx);
                results.push(LmtpRecipientResult {
                    recipient: rcpt.clone(),
                    status: LmtpRecipientStatus::Delivered {
                        smtp_code: rcpt_code,
                        message: rcpt_msg,
                    },
                });
            } else {
                results.push(LmtpRecipientResult {
                    recipient: rcpt.clone(),
                    status: classify_lmtp_status(rcpt_code, rcpt_msg),
                });
            }
        }

        if accepted_indices.is_empty() {
            let _ = write_cmd(&mut reader, "QUIT\r\n").await;
            return Ok(results);
        }

        // 5. DATA + dot-stuffed message
        write_cmd(&mut reader, "DATA\r\n").await?;
        let (data_code, data_msg) = read_reply(&mut reader, self.config.command_timeout).await?;
        if data_code != 354 {
            bail!(LmtpError::Protocol(format!(
                "DATA rejected {data_code}: {data_msg}"
            )));
        }

        let stuffed = dot_stuff_payload(raw_mime);
        timeout(self.config.data_timeout, async {
            reader.get_mut().write_all(&stuffed).await?;
            reader.get_mut().flush().await
        })
        .await
        .map_err(|_| LmtpError::Protocol("LMTP DATA write timed out".to_string()))??;

        // 6. RFC 2033: read one final status line per accepted RCPT TO
        for idx in accepted_indices {
            let (code, msg) = read_reply(&mut reader, self.config.data_timeout).await?;
            results[idx].status = classify_lmtp_status(code, msg);
        }

        let _ = write_cmd(&mut reader, "QUIT\r\n").await;
        let _ = read_reply(&mut reader, self.config.command_timeout).await;
        let _ = reader.get_mut().shutdown().await;

        Ok(results)
    }
}

fn classify_lmtp_status(code: u16, message: String) -> LmtpRecipientStatus {
    if (200..300).contains(&code) {
        LmtpRecipientStatus::Delivered {
            smtp_code: code,
            message,
        }
    } else if (400..500).contains(&code) {
        LmtpRecipientStatus::TempFail {
            smtp_code: code,
            message,
        }
    } else {
        LmtpRecipientStatus::PermFail {
            smtp_code: code,
            message,
        }
    }
}

async fn write_cmd(reader: &mut BufReader<TcpStream>, cmd: &str) -> std::io::Result<()> {
    reader.get_mut().write_all(cmd.as_bytes()).await?;
    reader.get_mut().flush().await
}

async fn read_reply(
    reader: &mut BufReader<TcpStream>,
    cmd_timeout: Duration,
) -> Result<(u16, String)> {
    let mut lines = Vec::new();
    let mut code = 0_u16;
    loop {
        let mut line = String::new();
        let mut limited = reader.take((MAX_LMTP_LINE_BYTES + 1) as u64);
        let n = timeout(cmd_timeout, limited.read_line(&mut line))
            .await
            .map_err(|_| LmtpError::Protocol("LMTP reply timed out".to_string()))??;
        if n == 0 {
            bail!(LmtpError::Protocol(
                "unexpected EOF reading LMTP reply".to_string()
            ));
        }
        if line.len() > MAX_LMTP_LINE_BYTES {
            bail!(LmtpError::Protocol(
                "LMTP reply line exceeded maximum allowed length".to_string()
            ));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.len() < 3 {
            bail!(LmtpError::Protocol(format!("malformed reply: {trimmed}")));
        }
        if code == 0 {
            code = trimmed[..3]
                .parse()
                .map_err(|_| LmtpError::Protocol(format!("invalid status code: {trimmed}")))?;
        }
        let sep = trimmed.as_bytes().get(3).copied().unwrap_or(b' ');
        lines.push(trimmed.get(4..).unwrap_or("").to_string());
        if sep == b' ' {
            break;
        }
    }
    Ok((code, lines.join(" ")))
}

#[cfg(test)]
mod tests {
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn handles_per_recipient_lmtp_post_data_replies() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let mock_dovecot = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            reader
                .get_mut()
                .write_all(b"220 dovecot.local LMTP ready\r\n")
                .await
                .unwrap();

            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.unwrap();
                if n == 0 {
                    break;
                }
                let upper = line.trim().to_ascii_uppercase();
                if upper.starts_with("LHLO") {
                    reader
                        .get_mut()
                        .write_all(b"250-dovecot.local\r\n250 PIPELINING\r\n")
                        .await
                        .unwrap();
                } else if upper.starts_with("MAIL FROM:") || upper.starts_with("RCPT TO:") {
                    reader
                        .get_mut()
                        .write_all(b"250 2.1.5 OK\r\n")
                        .await
                        .unwrap();
                } else if upper == "DATA" {
                    reader
                        .get_mut()
                        .write_all(b"354 OK send data\r\n")
                        .await
                        .unwrap();
                    loop {
                        line.clear();
                        reader.read_line(&mut line).await.unwrap();
                        if line == ".\r\n" {
                            break;
                        }
                    }
                    // RFC 2033: 1st recipient saved, 2nd recipient over quota
                    reader
                        .get_mut()
                        .write_all(b"250 2.0.0 <alice@hosted.test> Saved\r\n552 5.2.2 <full@hosted.test> Quota exceeded\r\n")
                        .await
                        .unwrap();
                } else if upper == "QUIT" {
                    reader
                        .get_mut()
                        .write_all(b"221 2.0.0 Bye\r\n")
                        .await
                        .unwrap();
                    break;
                }
            }
        });

        let client = DovecotLmtpClient::new(LmtpClientConfig::default());
        let recipients = vec![
            "alice@hosted.test".to_string(),
            "full@hosted.test".to_string(),
        ];
        let results = client
            .deliver_lmtp(
                "127.0.0.1",
                addr.port(),
                "sender@remote.test",
                &recipients,
                b"Subject: LMTP\r\n\r\nHello\r\n",
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert!(matches!(
            results[0].status,
            LmtpRecipientStatus::Delivered { smtp_code: 250, .. }
        ));
        assert!(matches!(
            results[1].status,
            LmtpRecipientStatus::PermFail { smtp_code: 552, .. }
        ));

        mock_dovecot.await.unwrap();
    }
}
