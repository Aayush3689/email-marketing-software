//! W3C `traceparent` distributed trace context propagation across API, `RabbitMQ`, and Rust MTA.

use rand::RngCore;

/// Parsed or generated W3C trace context (`00-<trace_id_32hex>-<span_id_16hex>-01`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
}

impl TraceContext {
    /// Generates a new root W3C trace context using a CSPRNG.
    #[must_use]
    pub fn new_root() -> Self {
        let mut trace_bytes = [0_u8; 16];
        let mut span_bytes = [0_u8; 8];
        rand::thread_rng().fill_bytes(&mut trace_bytes);
        rand::thread_rng().fill_bytes(&mut span_bytes);
        Self {
            trace_id: encode_hex(&trace_bytes),
            span_id: encode_hex(&span_bytes),
        }
    }

    /// Creates a child span preserving the upstream `trace_id`.
    #[must_use]
    pub fn child_span(&self) -> Self {
        let mut span_bytes = [0_u8; 8];
        rand::thread_rng().fill_bytes(&mut span_bytes);
        Self {
            trace_id: self.trace_id.clone(),
            span_id: encode_hex(&span_bytes),
        }
    }

    /// Parses an incoming W3C `traceparent` header.
    #[must_use]
    pub fn from_traceparent(header: &str) -> Option<Self> {
        let parts: Vec<&str> = header.trim().split('-').collect();
        if parts.len() < 4 {
            return None;
        }
        let trace_id = parts[1];
        let span_id = parts[2];
        if trace_id.len() != 32
            || span_id.len() != 16
            || !trace_id.chars().all(|c| c.is_ascii_hexdigit())
            || !span_id.chars().all(|c| c.is_ascii_hexdigit())
        {
            return None;
        }
        Some(Self {
            trace_id: trace_id.to_ascii_lowercase(),
            span_id: span_id.to_ascii_lowercase(),
        })
    }

    /// Formats as a standard W3C `traceparent` header value.
    #[must_use]
    pub fn to_traceparent(&self) -> String {
        format!("00-{}-{}-01", self.trace_id, self.span_id)
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(char::from(HEX[(b >> 4) as usize]));
        out.push(char::from(HEX[(b & 0x0f) as usize]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_parses_and_propagates_traceparent() {
        let root = TraceContext::new_root();
        let tp = root.to_traceparent();
        let parsed = TraceContext::from_traceparent(&tp).expect("valid traceparent");
        assert_eq!(parsed, root);

        let child = parsed.child_span();
        assert_eq!(child.trace_id, root.trace_id);
        assert_ne!(child.span_id, root.span_id);
        assert_eq!(child.to_traceparent().len(), 55);
    }
}
