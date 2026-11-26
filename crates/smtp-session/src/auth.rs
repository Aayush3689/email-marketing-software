//! SASL PLAIN and LOGIN credential decoding for SMTP AUTH (RFC 4954 / RFC 4616).

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use smtp_protocol::SmtpResponse;
use zeroize::Zeroizing;

/// Decoded username and password extracted from SASL PLAIN or LOGIN.
pub struct AuthCredentials {
    pub username: String,
    pub password: Zeroizing<String>,
}

/// Decodes a base64 SASL `PLAIN` payload (`[authzid]\0authcid\0password`).
///
/// # Errors
/// Returns an SMTP `501` or `535` response if the payload is malformed or `authzid != authcid`.
pub fn decode_sasl_plain(encoded: &str) -> Result<AuthCredentials, SmtpResponse> {
    let raw = Zeroizing::new(
        BASE64
            .decode(encoded.trim())
            .map_err(|_| SmtpResponse::invalid_args("Invalid base64 in AUTH PLAIN"))?,
    );

    let mut parts = raw.split(|&b| b == 0);
    let authz_bytes = parts
        .next()
        .ok_or_else(|| SmtpResponse::invalid_args("Malformed AUTH PLAIN payload"))?;
    let user_bytes = parts
        .next()
        .ok_or_else(|| SmtpResponse::invalid_args("Malformed AUTH PLAIN payload"))?;
    let pass_bytes = parts
        .next()
        .ok_or_else(|| SmtpResponse::invalid_args("Malformed AUTH PLAIN payload"))?;

    if parts.next().is_some() || user_bytes.is_empty() || pass_bytes.is_empty() {
        return Err(SmtpResponse::invalid_args(
            "Malformed AUTH PLAIN credentials",
        ));
    }

    let authz_str = std::str::from_utf8(authz_bytes)
        .map_err(|_| SmtpResponse::invalid_args("Non-UTF8 authzid"))?;
    let user_str = std::str::from_utf8(user_bytes)
        .map_err(|_| SmtpResponse::invalid_args("Non-UTF8 username"))?;
    let pass_str = std::str::from_utf8(pass_bytes)
        .map_err(|_| SmtpResponse::invalid_args("Non-UTF8 password"))?;

    if !authz_str.is_empty() && authz_str != user_str {
        return Err(SmtpResponse::single(
            535,
            Some("5.7.8"),
            "Authorization identity mismatch",
        ));
    }

    Ok(AuthCredentials {
        username: user_str.to_string(),
        password: Zeroizing::new(pass_str.to_string()),
    })
}

/// Decodes a single base64 SASL `LOGIN` field (username or password).
///
/// # Errors
/// Returns an SMTP `501` response if base64 or UTF-8 decoding fails.
pub fn decode_sasl_login_field(encoded: &str) -> Result<Zeroizing<String>, SmtpResponse> {
    let raw = Zeroizing::new(
        BASE64
            .decode(encoded.trim())
            .map_err(|_| SmtpResponse::invalid_args("Invalid base64 in AUTH LOGIN"))?,
    );
    let text = std::str::from_utf8(&raw)
        .map_err(|_| SmtpResponse::invalid_args("Non-UTF8 AUTH LOGIN field"))?;
    Ok(Zeroizing::new(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_valid_plain_and_rejects_mismatch() {
        let encoded = BASE64.encode(b"\0user@example.com\0s3cret!");
        let creds = decode_sasl_plain(&encoded).unwrap();
        assert_eq!(creds.username, "user@example.com");
        assert_eq!(creds.password.as_str(), "s3cret!");

        let mismatch = BASE64.encode(b"other@example.com\0user@example.com\0s3cret!");
        assert_eq!(decode_sasl_plain(&mismatch).err().unwrap().code, 535);
    }
}
