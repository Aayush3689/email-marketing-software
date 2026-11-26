//! Inbound SPF, DKIM, and DMARC verification, anti-spoofing `Authentication-Results`
//! header generation, and DMARC policy disposition.

use std::net::IpAddr;

use anyhow::Result;
use mail_auth::common::headers::HeaderWriter;
use mail_auth::dmarc::Policy as DmarcPolicy;
use mail_auth::{
    AuthenticatedMessage, AuthenticationResults, DkimResult, DmarcResult, Resolver, SpfResult,
};

/// Action derived from DMARC policy evaluation for inbound mail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DmarcDisposition {
    Accept,
    Quarantine,
    Reject,
}

/// Complete inbound authentication evaluation result.
#[derive(Debug, Clone)]
pub struct InboundAuthReport {
    pub spf_pass: bool,
    pub dkim_pass: bool,
    pub dmarc_pass: bool,
    pub disposition: DmarcDisposition,
    pub authentication_results_header: String,
}

/// Verifies SPF, DKIM, and DMARC for an inbound message and constructs a trusted
/// `Authentication-Results` header.
pub struct InboundAuthVerifier {
    authserv_id: String,
    resolver: Resolver,
}

impl InboundAuthVerifier {
    /// Creates a verifier backed by a `mail_auth::Resolver`.
    #[must_use]
    pub fn new(authserv_id: impl Into<String>, resolver: Resolver) -> Self {
        Self {
            authserv_id: authserv_id.into(),
            resolver,
        }
    }

    /// Creates a verifier using system DNS resolver configuration.
    ///
    /// # Errors
    /// Returns an error if the system DNS resolver configuration cannot be loaded.
    pub fn from_system_conf(authserv_id: impl Into<String>) -> Result<Self> {
        let resolver = Resolver::new_system_conf().map_err(|err| {
            anyhow::anyhow!("failed initializing mail-auth DNS resolver: {err:?}")
        })?;
        Ok(Self::new(authserv_id, resolver))
    }

    /// Evaluates SPF, DKIM, and DMARC and returns [`InboundAuthReport`].
    ///
    /// # Errors
    /// Returns an error if the raw RFC 5322 message headers cannot be parsed.
    pub async fn verify(
        &self,
        remote_ip: IpAddr,
        helo_domain: &str,
        mail_from: &str,
        raw_mime: &[u8],
    ) -> Result<InboundAuthReport> {
        let auth_msg = AuthenticatedMessage::parse(raw_mime)
            .ok_or_else(|| anyhow::anyhow!("failed to parse RFC 5322 headers"))?;

        let spf_out = self
            .resolver
            .verify_spf_sender(remote_ip, helo_domain, &self.authserv_id, mail_from)
            .await;

        let mail_from_domain = mail_from.rsplit_once('@').map_or(helo_domain, |(_, d)| d);
        let dkim_out = self.resolver.verify_dkim(&auth_msg).await;
        let dmarc_out = self
            .resolver
            .verify_dmarc(&auth_msg, &dkim_out, mail_from_domain, &spf_out)
            .await;

        let header_from_domain = dmarc_out.domain();
        let ar_header = AuthenticationResults::new(&self.authserv_id)
            .with_spf_mailfrom_result(&spf_out, remote_ip, mail_from, helo_domain)
            .with_dkim_results(&dkim_out, header_from_domain)
            .with_dmarc_result(&dmarc_out)
            .to_header();

        let spf_pass = spf_out.result() == SpfResult::Pass;
        let dkim_pass = dkim_out.iter().any(|d| d.result() == &DkimResult::Pass);
        let dmarc_pass = dmarc_out.spf_result() == &DmarcResult::Pass
            || dmarc_out.dkim_result() == &DmarcResult::Pass;

        let has_temp_error = matches!(dmarc_out.spf_result(), DmarcResult::TempError(_))
            || matches!(dmarc_out.dkim_result(), DmarcResult::TempError(_))
            || spf_out.result() == SpfResult::TempError
            || dkim_out
                .iter()
                .any(|d| matches!(d.result(), DkimResult::TempError(_)));

        let disposition = if dmarc_pass || has_temp_error {
            DmarcDisposition::Accept
        } else if dmarc_out.dmarc_record().is_some() {
            match dmarc_out.policy() {
                DmarcPolicy::Reject => DmarcDisposition::Reject,
                DmarcPolicy::Quarantine => DmarcDisposition::Quarantine,
                DmarcPolicy::None | DmarcPolicy::Unspecified => DmarcDisposition::Accept,
            }
        } else {
            DmarcDisposition::Accept
        };

        Ok(InboundAuthReport {
            spf_pass,
            dkim_pass,
            dmarc_pass,
            disposition,
            authentication_results_header: ar_header,
        })
    }

    /// Strips any untrusted pre-existing `Authentication-Results` headers matching
    /// `authserv_id` and prepends the newly computed trusted header.
    #[must_use]
    pub fn prepend_sanitized_header(&self, raw_mime: &[u8], report: &InboundAuthReport) -> Vec<u8> {
        let cleaned = strip_spoofed_auth_results(raw_mime, &self.authserv_id);
        let mut out =
            Vec::with_capacity(report.authentication_results_header.len() + cleaned.len());
        out.extend_from_slice(report.authentication_results_header.as_bytes());
        out.extend_from_slice(&cleaned);
        out
    }
}

/// Removes any incoming `Authentication-Results` header lines claiming our `authserv_id`
/// while preserving raw header/body bytes (including non-UTF-8 payloads).
#[must_use]
pub fn strip_spoofed_auth_results(raw_mime: &[u8], authserv_id: &str) -> Vec<u8> {
    let Some((headers_part, body_part)) = split_headers_and_body_bytes(raw_mime) else {
        return raw_mime.to_vec();
    };

    let authserv_lower = authserv_id.as_bytes().to_ascii_lowercase();
    let mut out = Vec::with_capacity(raw_mime.len());
    let mut skipping_folded = false;

    for line in headers_part.split_inclusive(|&b| b == b'\n') {
        let is_continuation = matches!(line.first(), Some(b' ' | b'\t'));
        if is_continuation {
            if !skipping_folded {
                out.extend_from_slice(line);
            }
            continue;
        }

        skipping_folded = false;
        let prefix = b"authentication-results:";
        if line.len() >= prefix.len() && line[..prefix.len()].eq_ignore_ascii_case(prefix) {
            let trimmed = trim_ascii_start(&line[prefix.len()..]);
            if trimmed.len() >= authserv_lower.len()
                && trimmed[..authserv_lower.len()].eq_ignore_ascii_case(&authserv_lower)
                && trimmed
                    .get(authserv_lower.len())
                    .is_none_or(|b| matches!(b, b';' | b' ' | b'\t' | b'\r' | b'\n'))
            {
                skipping_folded = true;
                continue;
            }
        }
        out.extend_from_slice(line);
    }

    out.extend_from_slice(body_part);
    out
}

fn trim_ascii_start(mut slice: &[u8]) -> &[u8] {
    while let Some((&b, rest)) = slice.split_first() {
        if b == b' ' || b == b'\t' {
            slice = rest;
        } else {
            break;
        }
    }
    slice
}

fn split_headers_and_body_bytes(raw: &[u8]) -> Option<(&[u8], &[u8])> {
    let crlf_idx = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let lf_idx = raw.windows(2).position(|w| w == b"\n\n");
    match (crlf_idx, lf_idx) {
        (Some(c), Some(l)) if c <= l => Some((&raw[..c + 2], &raw[c + 2..])),
        (Some(c), None) => Some((&raw[..c + 2], &raw[c + 2..])),
        (_, Some(l)) => Some((&raw[..=l], &raw[l + 1..])),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::time::{Duration, Instant};

    use dkim::{generate_domain_dkim_key, sign_rfc5322_message, DkimAlgorithm, KeyEncryptionKey};
    use mail_auth::common::parse::TxtRecordParser;
    use mail_auth::common::verify::DomainKey;
    use mail_auth::dmarc::Dmarc;
    use mail_auth::spf::Spf;

    use super::*;

    #[tokio::test]
    async fn verifies_spf_dkim_dmarc_and_strips_spoofed_auth_results() {
        let kek = KeyEncryptionKey::from_hex(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        let dkim_key =
            generate_domain_dkim_key("sender.example", "s1", DkimAlgorithm::Ed25519, &kek).unwrap();

        let raw = b"Authentication-Results: mx.platform.test;\r\n\tdkim=pass\r\nFrom: alert@sender.example\r\nTo: bob@hosted.example\r\nSubject: Auth Check\r\n\r\nHello\r\n";
        let signed = sign_rfc5322_message(raw, &dkim_key, &kek).unwrap();

        let resolver = Resolver::new_system_conf().unwrap();
        resolver.txt_add(
            "s1._domainkey.sender.example.".to_string(),
            DomainKey::parse(dkim_key.public_key_dns_txt.as_bytes()).unwrap(),
            Instant::now() + Duration::from_secs(3600),
        );
        resolver.txt_add(
            "sender.example.".to_string(),
            Spf::parse(b"v=spf1 ip4:198.51.100.10 -all").unwrap(),
            Instant::now() + Duration::from_secs(3600),
        );
        resolver.txt_add(
            "_dmarc.sender.example.".to_string(),
            Dmarc::parse(b"v=DMARC1; p=reject; adkim=r; aspf=r").unwrap(),
            Instant::now() + Duration::from_secs(3600),
        );

        let verifier = InboundAuthVerifier::new("mx.platform.test", resolver);

        // 1. Valid IP + valid DKIM -> Accept
        let ok_report = verifier
            .verify(
                IpAddr::V4(Ipv4Addr::new(198, 51, 100, 10)),
                "mail.sender.example",
                "alert@sender.example",
                &signed,
            )
            .await
            .unwrap();
        assert!(ok_report.spf_pass);
        assert!(ok_report.dkim_pass);
        assert!(ok_report.dmarc_pass);
        assert_eq!(ok_report.disposition, DmarcDisposition::Accept);

        let final_bytes = verifier.prepend_sanitized_header(&signed, &ok_report);
        let final_str = String::from_utf8_lossy(&final_bytes);
        // Only ONE Authentication-Results header (spoofed one stripped!)
        assert_eq!(
            final_str
                .matches("Authentication-Results: mx.platform.test")
                .count(),
            1
        );

        // 2. Spoofed unsigned message from wrong IP with p=reject -> Reject
        let unsigned_spoof = b"From: alert@sender.example\r\nTo: bob@hosted.example\r\nSubject: Spoof\r\n\r\nPhish\r\n";
        let bad_report = verifier
            .verify(
                IpAddr::V4(Ipv4Addr::new(203, 0, 113, 99)),
                "evil.invalid",
                "alert@sender.example",
                unsigned_spoof,
            )
            .await
            .unwrap();
        assert!(!bad_report.spf_pass);
        assert!(!bad_report.dkim_pass);
        assert!(!bad_report.dmarc_pass);
        assert_eq!(bad_report.disposition, DmarcDisposition::Reject);
    }

    #[test]
    fn strip_spoofed_auth_results_preserves_non_utf8_body_bytes() {
        let mut raw = Vec::new();
        raw.extend_from_slice(
            b"Authentication-Results: mx.platform.test;\r\n\tdkim=pass\r\nFrom: a@example.com\r\n\r\n",
        );
        raw.extend_from_slice(&[0xff, 0xfe, 0xe9, b'H', b'i', 0x00]);
        let cleaned = strip_spoofed_auth_results(&raw, "mx.platform.test");
        assert!(!String::from_utf8_lossy(&cleaned).contains("Authentication-Results"));
        assert!(cleaned.ends_with(&[0xff, 0xfe, 0xe9, b'H', b'i', 0x00]));
    }
}
