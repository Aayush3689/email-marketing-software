//! VERP bounce token decoding, RFC 3464 DSN bounce classification (hard vs. soft),
//! and RFC 5965 ARF feedback-loop complaint parser.

use mail_parser::{MessageParser, MimeHeaders};

/// Parsed feedback event derived from an inbound bounce or FBL report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedbackClassification {
    HardBounce {
        recipient_id: Option<String>,
        bounced_email: Option<String>,
        enhanced_status: Option<String>,
        diagnostic: String,
        original_message_id: Option<String>,
    },
    SoftBounce {
        recipient_id: Option<String>,
        bounced_email: Option<String>,
        enhanced_status: Option<String>,
        diagnostic: String,
        original_message_id: Option<String>,
    },
    Complaint {
        recipient_id: Option<String>,
        complained_email: Option<String>,
        feedback_type: String,
        original_message_id: Option<String>,
    },
    Unclassified,
}

/// Extracts `recipient_id` from a VERP return-path address such as
/// `bounces+01930000-0000-7000-8000-000000000001@bounce.domain.tld`.
#[must_use]
pub fn parse_verp_recipient_id(address: &str) -> Option<String> {
    let (local, _) = address.rsplit_once('@')?;
    let token = local.strip_prefix("bounces+")?;
    if token.is_empty() || token.len() > 128 {
        return None;
    }
    Some(token.to_string())
}

/// Parses an inbound RFC 5322 message for RFC 3464 DSN bounces or RFC 5965 ARF FBL complaints.
#[must_use]
pub fn classify_feedback_message(
    verp_address: Option<&str>,
    raw_mime: &[u8],
) -> FeedbackClassification {
    let recipient_id = verp_address.and_then(parse_verp_recipient_id);
    let Some(parsed) = MessageParser::default().parse(raw_mime) else {
        return FeedbackClassification::Unclassified;
    };

    let mut is_arf = false;
    let mut is_dsn = false;
    let mut report_text = String::new();
    let mut original_msg_id: Option<String> = None;

    for part in &parsed.parts {
        let ct = part.content_type().map_or_default(|c| {
            let t = c.ctype().to_ascii_lowercase();
            let sub = c.subtype().unwrap_or("").to_ascii_lowercase();
            format!("{t}/{sub}")
        });

        if ct == "message/feedback-report" {
            is_arf = true;
            report_text.push_str(&String::from_utf8_lossy(part.contents()));
            report_text.push('\n');
        } else if ct == "message/delivery-status" {
            is_dsn = true;
            report_text.push_str(&String::from_utf8_lossy(part.contents()));
            report_text.push('\n');
        } else if ct == "text/rfc822-headers" || ct == "message/rfc822" {
            let embedded = String::from_utf8_lossy(part.contents());
            if let Some(id) = extract_header_field(&embedded, "message-id") {
                original_msg_id = Some(id);
            }
        }
    }

    if is_arf {
        let feedback_type = extract_header_field(&report_text, "feedback-type")
            .unwrap_or_else(|| "abuse".to_string());
        let complained_email =
            extract_header_field(&report_text, "original-rcpt-to").map(|v| strip_addr_prefix(&v));
        if original_msg_id.is_none() {
            original_msg_id = extract_header_field(&report_text, "original-message-id");
        }
        return FeedbackClassification::Complaint {
            recipient_id,
            complained_email,
            feedback_type,
            original_message_id: original_msg_id,
        };
    }

    if is_dsn {
        let action = extract_header_field(&report_text, "action")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let status = extract_header_field(&report_text, "status");
        let diagnostic = extract_header_field(&report_text, "diagnostic-code")
            .unwrap_or_else(|| "No diagnostic provided".to_string());
        let bounced_email = extract_header_field(&report_text, "final-recipient")
            .or_else(|| extract_header_field(&report_text, "original-recipient"))
            .map(|v| strip_addr_prefix(&v));

        if is_hard_bounce(&action, status.as_deref()) {
            return FeedbackClassification::HardBounce {
                recipient_id,
                bounced_email,
                enhanced_status: status,
                diagnostic,
                original_message_id: original_msg_id,
            };
        }
        return FeedbackClassification::SoftBounce {
            recipient_id,
            bounced_email,
            enhanced_status: status,
            diagnostic,
            original_message_id: original_msg_id,
        };
    }

    FeedbackClassification::Unclassified
}

fn is_hard_bounce(action: &str, status: Option<&str>) -> bool {
    let Some(code) = status else {
        return action == "failed";
    };
    if code.starts_with('4') {
        return false;
    }
    // 5.2.2 (Mailbox full) and 5.3.4 (Message too big) do not indicate dead addresses.
    if code == "5.2.2" || code == "5.3.4" {
        return false;
    }
    code.starts_with('5') || action == "failed"
}

fn extract_header_field(body: &str, name_lower: &str) -> Option<String> {
    for line in body.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(name_lower) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn strip_addr_prefix(raw: &str) -> String {
    let after_semi = raw.split_once(';').map_or(raw, |(_, addr)| addr).trim();
    after_semi
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_string()
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    let mut key_block = [0_u8; 64];
    if key.len() > 64 {
        let hashed = Sha256::digest(key);
        key_block[..32].copy_from_slice(&hashed);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36_u8; 64];
    let mut opad = [0x5c_u8; 64];
    for i in 0..64 {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

/// Builds a VERP return-path signed with a truncated HMAC-SHA256 tag (`bounces+<id>.<sig>@<domain>`).
#[must_use]
pub fn sign_verp_address(
    local_prefix: &str,
    recipient_id: &str,
    domain: &str,
    secret: &[u8],
) -> String {
    let mac = hmac_sha256(secret, recipient_id.as_bytes());
    let tag = hex::encode(&mac[..8]);
    format!("{local_prefix}+{recipient_id}.{tag}@{domain}")
}

/// Extracts and optionally HMAC-verifies a VERP `recipient_id` from a bounce address.
#[must_use]
pub fn verify_verp_recipient_id(address: &str, secret: Option<&[u8]>) -> Option<String> {
    let token = parse_verp_recipient_id(address)?;
    if let Some((rcpt_id, sig_hex)) = token.rsplit_once('.') {
        if let Some(sec) = secret {
            let expected = hex::encode(&hmac_sha256(sec, rcpt_id.as_bytes())[..8]);
            if expected.len() == sig_hex.len()
                && expected
                    .as_bytes()
                    .iter()
                    .zip(sig_hex.as_bytes())
                    .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
                    == 0
            {
                return Some(rcpt_id.to_string());
            }
            return None;
        }
        return Some(rcpt_id.to_string());
    }
    if secret.is_some() {
        None
    } else {
        Some(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_verp_and_classifies_hard_bounce_soft_bounce_and_arf_complaint() {
        assert_eq!(
            parse_verp_recipient_id("bounces+rcpt-1234@bounce.example.com"),
            Some("rcpt-1234".to_string())
        );

        let dsn_hard = concat!(
            "From: MAILER-DAEMON@remote.example\r\n",
            "To: bounces+rcpt-1@bounce.platform.test\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/report; report-type=delivery-status; boundary=\"b1\"\r\n\r\n",
            "--b1\r\nContent-Type: text/plain\r\n\r\nUser does not exist.\r\n",
            "--b1\r\nContent-Type: message/delivery-status\r\n\r\n",
            "Final-Recipient: rfc822; dead@remote.example\r\n",
            "Action: failed\r\n",
            "Status: 5.1.1\r\n",
            "Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist\r\n",
            "--b1\r\nContent-Type: text/rfc822-headers\r\n\r\n",
            "Message-ID: <msg-1@platform.test>\r\n",
            "--b1--\r\n"
        );
        let res = classify_feedback_message(
            Some("bounces+rcpt-1@bounce.platform.test"),
            dsn_hard.as_bytes(),
        );
        assert_eq!(
            res,
            FeedbackClassification::HardBounce {
                recipient_id: Some("rcpt-1".to_string()),
                bounced_email: Some("dead@remote.example".to_string()),
                enhanced_status: Some("5.1.1".to_string()),
                diagnostic: "smtp; 550 5.1.1 The email account does not exist".to_string(),
                original_message_id: Some("<msg-1@platform.test>".to_string()),
            }
        );

        let dsn_quota = dsn_hard.replace("5.1.1", "5.2.2");
        assert!(matches!(
            classify_feedback_message(None, dsn_quota.as_bytes()),
            FeedbackClassification::SoftBounce { .. }
        ));

        let arf = concat!(
            "From: fbl@isp.example\r\n",
            "To: fbl@platform.test\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/report; report-type=feedback-report; boundary=\"f1\"\r\n\r\n",
            "--f1\r\nContent-Type: text/plain\r\n\r\nAbuse report\r\n",
            "--f1\r\nContent-Type: message/feedback-report\r\n\r\n",
            "Feedback-Type: abuse\r\n",
            "Original-Rcpt-To: <complainer@isp.example>\r\n",
            "--f1\r\nContent-Type: text/rfc822-headers\r\n\r\n",
            "Message-ID: <msg-99@platform.test>\r\n",
            "--f1--\r\n"
        );
        assert_eq!(
            classify_feedback_message(None, arf.as_bytes()),
            FeedbackClassification::Complaint {
                recipient_id: None,
                complained_email: Some("complainer@isp.example".to_string()),
                feedback_type: "abuse".to_string(),
                original_message_id: Some("<msg-99@platform.test>".to_string()),
            }
        );

        let secret = b"verp-hmac-secret-test";
        let signed = sign_verp_address("bounces", "rcpt-42", "bounce.platform.test", secret);
        assert_eq!(
            verify_verp_recipient_id(&signed, Some(secret)),
            Some("rcpt-42".to_string())
        );
        let forged = signed.replace("rcpt-42", "rcpt-99");
        assert_eq!(verify_verp_recipient_id(&forged, Some(secret)), None);
        assert_eq!(
            verify_verp_recipient_id("bounces+rcpt-42@bounce.platform.test", Some(secret)),
            None
        );
    }
}
