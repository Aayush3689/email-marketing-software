//! Domain DNS deliverability verification (SPF, DKIM, DMARC, MX, PTR)
//! with actionable remediation instructions for failed checks.

use std::net::IpAddr;

use crate::HickoryDnsResolver;

/// Verification outcome for an individual DNS check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

/// Detailed result and remediation advice for one DNS record type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticCheck {
    pub status: CheckStatus,
    pub observed: Vec<String>,
    pub remediation: String,
}

/// Complete domain deliverability audit report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainDeliverabilityReport {
    pub domain: String,
    pub spf: DiagnosticCheck,
    pub dkim: DiagnosticCheck,
    pub dmarc: DiagnosticCheck,
    pub mx: DiagnosticCheck,
    pub ptr: DiagnosticCheck,
}

/// Evaluates SPF TXT records for `domain` against an expected `spf_include` or sending IP.
#[must_use]
pub fn evaluate_spf(
    domain: &str,
    txt_records: &[String],
    expected_include: &str,
) -> DiagnosticCheck {
    let spf_records: Vec<String> = txt_records
        .iter()
        .filter(|r| r.to_ascii_lowercase().starts_with("v=spf1"))
        .cloned()
        .collect();

    if spf_records.is_empty() {
        return DiagnosticCheck {
            status: CheckStatus::Fail,
            observed: Vec::new(),
            remediation: format!(
                "Publish a TXT record on {domain}: \"v=spf1 include:{expected_include} ~all\""
            ),
        };
    }

    if spf_records.len() > 1 {
        return DiagnosticCheck {
            status: CheckStatus::Fail,
            observed: spf_records,
            remediation: "Multiple SPF records found (RFC 7208 PermError). Merge them into a single v=spf1 TXT record.".to_string(),
        };
    }

    let rec = &spf_records[0];
    let has_exact_include = rec
        .split_whitespace()
        .any(|tok| tok.eq_ignore_ascii_case(&format!("include:{expected_include}")));
    if !has_exact_include {
        return DiagnosticCheck {
            status: CheckStatus::Fail,
            observed: spf_records,
            remediation: format!(
                "Update your SPF record on {domain} to include \"include:{expected_include}\"."
            ),
        };
    }

    if rec
        .split_whitespace()
        .any(|tok| tok.eq_ignore_ascii_case("+all"))
    {
        return DiagnosticCheck {
            status: CheckStatus::Warn,
            observed: spf_records,
            remediation: "Replace '+all' with '~all' or '-all' to prevent unauthorized senders."
                .to_string(),
        };
    }

    DiagnosticCheck {
        status: CheckStatus::Pass,
        observed: spf_records,
        remediation: String::new(),
    }
}

/// Evaluates DKIM TXT records on `<selector>._domainkey.<domain>` against the expected record value.
#[must_use]
pub fn evaluate_dkim(
    domain: &str,
    selector: &str,
    txt_records: &[String],
    expected_public_key_txt: &str,
) -> DiagnosticCheck {
    let expected_norm: String = expected_public_key_txt.split_whitespace().collect();
    let matched = txt_records.iter().any(|r| {
        let norm: String = r.split_whitespace().collect();
        norm.eq_ignore_ascii_case(&expected_norm)
    });

    if matched {
        DiagnosticCheck {
            status: CheckStatus::Pass,
            observed: txt_records.to_vec(),
            remediation: String::new(),
        }
    } else {
        DiagnosticCheck {
            status: CheckStatus::Fail,
            observed: txt_records.to_vec(),
            remediation: format!(
                "Publish TXT record at {selector}._domainkey.{domain} with value: {expected_public_key_txt}"
            ),
        }
    }
}

/// Evaluates DMARC TXT records on `_dmarc.<domain>`.
#[must_use]
pub fn evaluate_dmarc(domain: &str, txt_records: &[String]) -> DiagnosticCheck {
    let dmarc_records: Vec<String> = txt_records
        .iter()
        .filter(|r| r.to_ascii_lowercase().starts_with("v=dmarc1"))
        .cloned()
        .collect();

    if dmarc_records.is_empty() {
        return DiagnosticCheck {
            status: CheckStatus::Fail,
            observed: Vec::new(),
            remediation: format!(
                "Publish TXT record at _dmarc.{domain}: \"v=DMARC1; p=none; rua=mailto:dmarc@{domain}\""
            ),
        };
    }

    let has_p_none = dmarc_records[0].split(';').any(|part| {
        let trimmed = part.trim();
        trimmed.eq_ignore_ascii_case("p=none")
    });
    if has_p_none {
        return DiagnosticCheck {
            status: CheckStatus::Warn,
            observed: dmarc_records,
            remediation: "DMARC is in monitoring mode (p=none). Advance to p=quarantine or p=reject after verifying alignment.".to_string(),
        };
    }

    DiagnosticCheck {
        status: CheckStatus::Pass,
        observed: dmarc_records,
        remediation: String::new(),
    }
}

/// Evaluates reverse DNS (PTR) hostnames for a sending IP.
#[must_use]
pub fn evaluate_ptr(
    sending_ip: IpAddr,
    ptr_hosts: &[String],
    expected_hostname: &str,
) -> DiagnosticCheck {
    let expected_clean = expected_hostname.trim_end_matches('.').to_ascii_lowercase();
    let matched = ptr_hosts
        .iter()
        .any(|h| h.trim_end_matches('.').to_ascii_lowercase() == expected_clean);

    if matched {
        DiagnosticCheck {
            status: CheckStatus::Pass,
            observed: ptr_hosts.to_vec(),
            remediation: String::new(),
        }
    } else {
        DiagnosticCheck {
            status: CheckStatus::Fail,
            observed: ptr_hosts.to_vec(),
            remediation: format!(
                "Configure reverse DNS (PTR) for {sending_ip} to resolve to {expected_hostname} with matching forward A/AAAA."
            ),
        }
    }
}

/// Input expectations for [`HickoryDnsResolver::check_domain_deliverability`].
#[derive(Debug, Clone, Copy)]
pub struct DeliverabilityExpectations<'a> {
    pub domain: &'a str,
    pub expected_spf_include: &'a str,
    pub dkim_selector: &'a str,
    pub expected_dkim_txt: &'a str,
    pub expected_mx_host: &'a str,
    pub sending_ip: IpAddr,
    pub expected_ptr_host: &'a str,
}

impl HickoryDnsResolver {
    /// Looks up TXT records for `fqdn` using the underlying Hickory async resolver.
    pub async fn lookup_txt_strings(&self, fqdn: &str) -> Vec<String> {
        let Ok(resp) = self.inner.txt_lookup(fqdn).await else {
            return Vec::new();
        };
        resp.iter()
            .map(|r| {
                r.txt_data()
                    .iter()
                    .map(|part| String::from_utf8_lossy(part).into_owned())
                    .collect::<String>()
            })
            .collect()
    }

    /// Looks up reverse DNS PTR hostnames for `ip`.
    pub async fn lookup_ptr_hosts(&self, ip: IpAddr) -> Vec<String> {
        let Ok(resp) = self.inner.reverse_lookup(ip).await else {
            return Vec::new();
        };
        resp.iter().map(|name| name.to_utf8()).collect()
    }

    /// Performs a live DNS deliverability check for `target.domain`.
    pub async fn check_domain_deliverability(
        &self,
        target: &DeliverabilityExpectations<'_>,
    ) -> DomainDeliverabilityReport {
        let spf_txts = self.lookup_txt_strings(target.domain).await;
        let dkim_fqdn = format!("{}._domainkey.{}", target.dkim_selector, target.domain);
        let dkim_txts = self.lookup_txt_strings(&dkim_fqdn).await;
        let dmarc_fqdn = format!("_dmarc.{}", target.domain);
        let dmarc_txts = self.lookup_txt_strings(&dmarc_fqdn).await;
        let ptr_hosts = self.lookup_ptr_hosts(target.sending_ip).await;

        let mx_hosts: Vec<String> = match self.inner.mx_lookup(target.domain).await {
            Ok(mx) => mx.iter().map(|r| r.exchange().to_utf8()).collect(),
            Err(_) => Vec::new(),
        };
        let expected_mx_clean = target
            .expected_mx_host
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let mx_ok = mx_hosts
            .iter()
            .any(|h| h.trim_end_matches('.').to_ascii_lowercase() == expected_mx_clean);
        let mx = if mx_ok {
            DiagnosticCheck {
                status: CheckStatus::Pass,
                observed: mx_hosts,
                remediation: String::new(),
            }
        } else {
            DiagnosticCheck {
                status: CheckStatus::Fail,
                observed: mx_hosts,
                remediation: format!(
                    "Publish MX record for {} pointing to {} (priority 10).",
                    target.domain, target.expected_mx_host
                ),
            }
        };

        DomainDeliverabilityReport {
            domain: target.domain.to_string(),
            spf: evaluate_spf(target.domain, &spf_txts, target.expected_spf_include),
            dkim: evaluate_dkim(
                target.domain,
                target.dkim_selector,
                &dkim_txts,
                target.expected_dkim_txt,
            ),
            dmarc: evaluate_dmarc(target.domain, &dmarc_txts),
            mx,
            ptr: evaluate_ptr(target.sending_ip, &ptr_hosts, target.expected_ptr_host),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    #[test]
    fn evaluates_spf_dkim_dmarc_and_ptr_with_remediation() {
        let spf_bad = evaluate_spf("acme.com", &[], "spf.platform.test");
        assert_eq!(spf_bad.status, CheckStatus::Fail);
        assert!(spf_bad
            .remediation
            .contains("v=spf1 include:spf.platform.test"));

        let spf_dup = evaluate_spf(
            "acme.com",
            &[
                "v=spf1 include:spf.platform.test ~all".to_string(),
                "v=spf1 -all".to_string(),
            ],
            "spf.platform.test",
        );
        assert_eq!(spf_dup.status, CheckStatus::Fail);

        let spf_ok = evaluate_spf(
            "acme.com",
            &["v=spf1 include:spf.platform.test -all".to_string()],
            "spf.platform.test",
        );
        assert_eq!(spf_ok.status, CheckStatus::Pass);

        let dkim_ok = evaluate_dkim(
            "acme.com",
            "s1",
            &["v=DKIM1; k=ed25519; p=ABCD".to_string()],
            "v=DKIM1; k=ed25519; p=ABCD",
        );
        assert_eq!(dkim_ok.status, CheckStatus::Pass);

        let dmarc_warn = evaluate_dmarc("acme.com", &["v=DMARC1; p=none".to_string()]);
        assert_eq!(dmarc_warn.status, CheckStatus::Warn);

        let ptr_fail = evaluate_ptr(
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 10)),
            &["unknown.host.".to_string()],
            "mta1.platform.test",
        );
        assert_eq!(ptr_fail.status, CheckStatus::Fail);
        assert!(ptr_fail.remediation.contains("198.51.100.10"));
    }
}
