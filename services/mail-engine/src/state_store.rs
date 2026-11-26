//! PostgreSQL-backed persistence stores for `mail-engine`:
//! - Outbound `DeliveryStateStore` aligned with `0001_initial_schema.sql`
//! - `CredentialStore` (`smtp_credentials`)
//! - `DomainDirectory` & `InboundRouter` (`domains`, `mailboxes`, `mailbox_aliases`, `mailbox_forwarding_rules`)
//! - `FeedbackStore` (DSN/ARF bounce updates + `suppression_entries`)
//! - Persistent `dkim_keys` loading and bootstrap.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use bounce_handler::FeedbackClassification;
use delivery_engine::{AttemptRecord, DeliveryStateStore, RecipientDeliveryState};
use dkim::{
    generate_domain_dkim_key, DkimAlgorithm, DkimKeyRing, DkimKeyStatus, KeyEncryptionKey,
    StoredDkimKey,
};
use smtp_inbound::processor::{ExpandedRouting, FeedbackStore, InboundRouter, MailboxTarget};
use smtp_inbound::{CredentialRecord, CredentialStore, DomainDirectory, RecipientRouting};
use sqlx::{PgPool, Row};
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Clone)]
pub struct EngineDeliveryStateStore {
    pg_pool: Option<PgPool>,
    node_id: String,
    recent_records: Arc<Mutex<Vec<AttemptRecord>>>,
}

impl EngineDeliveryStateStore {
    #[must_use]
    pub fn new(pg_pool: Option<PgPool>, node_id: impl Into<String>) -> Self {
        Self {
            pg_pool,
            node_id: node_id.into(),
            recent_records: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl DeliveryStateStore for EngineDeliveryStateStore {
    async fn record_attempt(&self, record: AttemptRecord) -> Result<()> {
        info!(
            message_id = %record.message_id,
            recipient_id = %record.recipient_id,
            attempt_no = record.attempt_no,
            state = ?record.next_state,
            smtp_code = ?record.smtp_code,
            tls_used = record.tls_used,
            duration_ms = record.duration_ms,
            "Recorded outbound SMTP delivery attempt"
        );

        if let Some(pool) = &self.pg_pool {
            let msg_uuid = Uuid::parse_str(&record.message_id)?;
            let rcpt_uuid = Uuid::parse_str(&record.recipient_id)?;
            persist_pg_attempt(pool, &self.node_id, msg_uuid, rcpt_uuid, &record).await?;
        }

        if let Ok(mut guard) = self.recent_records.lock() {
            if guard.len() >= 1000 {
                guard.remove(0);
            }
            guard.push(record);
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_delivery_attempt(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    node_id: &str,
    organization_id: Uuid,
    message_id: Uuid,
    recipient_id: Uuid,
    attempt_outcome: &str,
    record: &AttemptRecord,
) -> Result<()> {
    sqlx::query(
        r"INSERT INTO delivery_attempts (
            id, message_recipient_id, message_id, organization_id, mta_node_id,
            remote_mx_host, tls_used, tls_verified, attempt_no,
            smtp_code, enhanced_code, smtp_response, outcome, duration_ms
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(Uuid::now_v7())
    .bind(recipient_id)
    .bind(message_id)
    .bind(organization_id)
    .bind(node_id)
    .bind(record.remote_mx_host.as_deref())
    .bind(record.tls_used)
    .bind(record.tls_verified)
    .bind(i16::try_from(record.attempt_no).unwrap_or(i16::MAX))
    .bind(
        record
            .smtp_code
            .map(|c| i16::try_from(c).unwrap_or(i16::MAX)),
    )
    .bind(record.enhanced_code.as_deref())
    .bind(&record.message)
    .bind(attempt_outcome)
    .bind(i32::try_from(record.duration_ms).unwrap_or(i32::MAX))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn persist_pg_attempt(
    pool: &PgPool,
    node_id: &str,
    message_id: Uuid,
    recipient_id: Uuid,
    record: &AttemptRecord,
) -> Result<()> {
    let mut tx = pool.begin().await?;

    let rcpt_meta =
        sqlx::query(r"SELECT organization_id FROM message_recipients WHERE id = $1 LIMIT 1")
            .bind(recipient_id)
            .fetch_optional(&mut *tx)
            .await?;

    let Some(row) = rcpt_meta else {
        anyhow::bail!("missing message_recipient row {recipient_id} when persisting attempt");
    };
    let organization_id: Uuid = row.try_get("organization_id")?;

    let (recipient_state, attempt_outcome) = match record.next_state {
        RecipientDeliveryState::AcceptedRemote => ("accepted_remote", "accepted"),
        RecipientDeliveryState::Deferred => ("deferred", "deferred"),
        RecipientDeliveryState::Bounced => ("bounced", "bounced"),
    };

    insert_delivery_attempt(
        &mut tx,
        node_id,
        organization_id,
        message_id,
        recipient_id,
        attempt_outcome,
        record,
    )
    .await?;

    sqlx::query(
        r"UPDATE message_recipients
          SET state = $2,
              attempt_count = $3,
              next_retry_at = $4,
              ambiguous_after_data = $5,
              last_smtp_code = $6,
              last_enhanced_code = $7,
              last_smtp_response = $8,
              remote_mx_host = $9,
              completed_at = CASE WHEN $2 IN ('accepted_remote', 'bounced') THEN NOW() ELSE NULL END
          WHERE id = $1",
    )
    .bind(recipient_id)
    .bind(recipient_state)
    .bind(i16::try_from(record.attempt_no).unwrap_or(i16::MAX))
    .bind(record.next_retry_at)
    .bind(record.ambiguous_after_data)
    .bind(
        record
            .smtp_code
            .map(|c| i16::try_from(c).unwrap_or(i16::MAX)),
    )
    .bind(record.enhanced_code.as_deref())
    .bind(&record.message)
    .bind(record.remote_mx_host.as_deref())
    .execute(&mut *tx)
    .await?;

    // Derive aggregate parent message status without overwriting other recipients' outcomes.
    sqlx::query(
        r"UPDATE messages
          SET state = COALESCE((
                SELECT CASE
                  WHEN BOOL_OR(state IN ('queued', 'processing', 'deferred')) THEN 'processing'
                  WHEN BOOL_AND(state = 'accepted_remote') THEN 'accepted_remote'
                  WHEN BOOL_OR(state = 'bounced') THEN 'bounced'
                  ELSE 'accepted_remote'
                END
                FROM message_recipients WHERE message_id = $1
              ), $2),
              updated_at = NOW()
          WHERE id = $1",
    )
    .bind(message_id)
    .bind(recipient_state)
    .execute(&mut *tx)
    .await?;

    let event_type = match record.next_state {
        RecipientDeliveryState::AcceptedRemote => "delivered",
        RecipientDeliveryState::Deferred => "deferred",
        RecipientDeliveryState::Bounced => "bounced",
    };
    sqlx::query(
        r"INSERT INTO email_events (id, organization_id, message_id, message_recipient_id, event_type, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::now_v7())
    .bind(organization_id)
    .bind(message_id)
    .bind(recipient_id)
    .bind(event_type)
    .bind(serde_json::json!({
        "smtpCode": record.smtp_code,
        "enhancedCode": record.enhanced_code,
        "remoteMxHost": record.remote_mx_host,
        "durationMs": record.duration_ms,
    }))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// PostgreSQL-backed [`CredentialStore`] querying `smtp_credentials`, with optional seeded fallback.
#[derive(Clone)]
pub struct PgCredentialStore {
    pg_pool: Option<PgPool>,
    fallback: Arc<smtp_inbound::InMemoryCredentialStore>,
}

impl PgCredentialStore {
    #[must_use]
    pub const fn new(
        pg_pool: Option<PgPool>,
        fallback: Arc<smtp_inbound::InMemoryCredentialStore>,
    ) -> Self {
        Self { pg_pool, fallback }
    }
}

impl CredentialStore for PgCredentialStore {
    async fn find_credential(&self, username: &str) -> Option<CredentialRecord> {
        if let Some(pool) = &self.pg_pool {
            if let Ok(Some(row)) = sqlx::query(
                r"SELECT c.username, c.password_hash, c.allowed_sender_patterns, (c.revoked_at IS NOT NULL OR o.status = 'suspended') AS is_revoked
                    FROM smtp_credentials c
                    JOIN organizations o ON o.id = c.organization_id
                   WHERE c.username = $1
                   LIMIT 1",
            )
            .bind(username)
            .fetch_optional(pool)
            .await
            {
                let patterns: Vec<String> = row.try_get("allowed_sender_patterns").unwrap_or_default();
                let is_revoked: bool = row.try_get("is_revoked").unwrap_or(true);
                return Some(CredentialRecord {
                    username: row.try_get("username").unwrap_or_else(|_| username.to_string()),
                    password_hash: row.try_get("password_hash").unwrap_or_default(),
                    allowed_sender_patterns: patterns,
                    is_revoked,
                });
            }
        }
        self.fallback.find_credential(username).await
    }
}

/// PostgreSQL-backed [`DomainDirectory`] and [`InboundRouter`] querying `domains`, `mailboxes`, `mailbox_aliases`.
#[derive(Clone)]
pub struct PgDomainDirectory {
    pg_pool: Option<PgPool>,
    lmtp_host: String,
    lmtp_port: u16,
    fallback: Arc<smtp_inbound::InMemoryDomainDirectory>,
}

impl PgDomainDirectory {
    #[must_use]
    pub fn new(
        pg_pool: Option<PgPool>,
        lmtp_host: impl Into<String>,
        lmtp_port: u16,
        fallback: Arc<smtp_inbound::InMemoryDomainDirectory>,
    ) -> Self {
        Self {
            pg_pool,
            lmtp_host: lmtp_host.into(),
            lmtp_port,
            fallback,
        }
    }
}

impl DomainDirectory for PgDomainDirectory {
    async fn classify_recipient(&self, email: &str) -> RecipientRouting {
        let lower = email.trim().to_ascii_lowercase();
        let Some((local, domain)) = lower.split_once('@') else {
            return RecipientRouting::UnknownLocalUser;
        };
        if local.starts_with("bounces+") || local == "fbl" || local == "abuse" {
            if let Some(pool) = &self.pg_pool {
                if let Ok(Some(_)) = sqlx::query(
                    "SELECT 1 FROM domains WHERE LOWER(domain_name::text) = $1 AND is_suspended = FALSE LIMIT 1",
                )
                .bind(domain)
                .fetch_optional(pool)
                .await
                {
                    return RecipientRouting::FeedbackAddress;
                }
            }
        }

        if let Some(pool) = &self.pg_pool {
            let domain_row = sqlx::query(
                r"SELECT id FROM domains WHERE LOWER(domain_name::text) = $1 AND hosting_enabled = TRUE AND is_suspended = FALSE LIMIT 1",
            )
            .bind(domain)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

            let Some(dom) = domain_row else {
                return self.fallback.classify_recipient(&lower).await;
            };
            let dom_id: Uuid = dom.try_get("id").unwrap_or_default();

            let mailbox_exists = sqlx::query(
                r"SELECT 1 FROM mailboxes WHERE domain_id = $1 AND (LOWER(email_address::text) = $2 OR is_catch_all = TRUE) AND status = 'active' LIMIT 1",
            )
            .bind(dom_id)
            .bind(&lower)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .is_some();

            if mailbox_exists {
                return RecipientRouting::HostedMailbox;
            }

            let alias_exists = sqlx::query(
                r"SELECT 1 FROM mailbox_aliases WHERE domain_id = $1 AND LOWER(source_address::text) = $2 AND is_active = TRUE LIMIT 1",
            )
            .bind(dom_id)
            .bind(&lower)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .is_some();

            return if alias_exists {
                RecipientRouting::HostedMailbox
            } else {
                RecipientRouting::UnknownLocalUser
            };
        }

        self.fallback.classify_recipient(&lower).await
    }
}

impl PgDomainDirectory {
    async fn expand_pg_recipient(
        &self,
        pool: &PgPool,
        domain: &str,
        lower: &str,
    ) -> ExpandedRouting {
        let mut local_targets = Vec::new();
        let mut external_forwards = Vec::new();

        // 1. Expand alias targets first (resolving hosted mailboxes vs external forward targets).
        let alias_row = sqlx::query(
            r"SELECT a.destination_addresses
                FROM mailbox_aliases a
                JOIN domains d ON d.id = a.domain_id
               WHERE LOWER(d.domain_name::text) = $1
                 AND d.hosting_enabled = TRUE
                 AND d.is_suspended = FALSE
                 AND a.is_active = TRUE
                 AND LOWER(a.source_address::text) = $2
               LIMIT 1",
        )
        .bind(domain)
        .bind(lower)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

        let candidates = if let Some(row) = alias_row {
            row.try_get::<Vec<String>, _>("destination_addresses")
                .unwrap_or_default()
        } else {
            vec![lower.to_string()]
        };

        for candidate in candidates {
            let cand_lower = candidate.trim().to_ascii_lowercase();
            let Some((_, cand_dom)) = cand_lower.split_once('@') else {
                continue;
            };
            let mb = sqlx::query(
                r"SELECT m.id, m.email_address::text AS addr
                    FROM mailboxes m
                    JOIN domains d ON d.id = m.domain_id
                   WHERE LOWER(d.domain_name::text) = $1
                     AND d.hosting_enabled = TRUE
                     AND d.is_suspended = FALSE
                     AND m.status = 'active'
                     AND (LOWER(m.email_address::text) = $2 OR m.is_catch_all = TRUE)
                   ORDER BY (LOWER(m.email_address::text) = $2) DESC
                   LIMIT 1",
            )
            .bind(cand_dom)
            .bind(&cand_lower)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

            if let Some(row) = mb {
                let mb_id: Uuid = row.try_get("id").unwrap_or_default();
                let addr: String = row.try_get("addr").unwrap_or_else(|_| cand_lower.clone());
                let fwd_rows = sqlx::query(
                    r"SELECT forward_to_address::text AS fwd, keep_local_copy
                        FROM mailbox_forwarding_rules
                       WHERE mailbox_id = $1 AND is_active = TRUE",
                )
                .bind(mb_id)
                .fetch_all(pool)
                .await
                .unwrap_or_default();

                let keep_local = fwd_rows.is_empty()
                    || fwd_rows
                        .iter()
                        .any(|r| r.try_get::<bool, _>("keep_local_copy").unwrap_or(true));
                if keep_local {
                    local_targets.push(MailboxTarget {
                        email: addr,
                        lmtp_host: self.lmtp_host.clone(),
                        lmtp_port: self.lmtp_port,
                    });
                }
                for f in fwd_rows {
                    if let Ok(dest) = f.try_get::<String, _>("fwd") {
                        external_forwards.push(dest.to_ascii_lowercase());
                    }
                }
            } else if cand_lower != lower {
                external_forwards.push(cand_lower);
            }
        }

        ExpandedRouting {
            local_targets,
            external_forwards,
            is_feedback: false,
        }
    }
}

impl InboundRouter for PgDomainDirectory {
    async fn expand_recipient(&self, email: &str) -> ExpandedRouting {
        let lower = email.trim().to_ascii_lowercase();
        let Some((local, domain)) = lower.split_once('@') else {
            return ExpandedRouting::default();
        };
        if local.starts_with("bounces+") || local == "fbl" || local == "abuse" {
            return ExpandedRouting {
                is_feedback: true,
                ..ExpandedRouting::default()
            };
        }

        if let Some(pool) = &self.pg_pool {
            let expanded = self.expand_pg_recipient(pool, domain, &lower).await;
            if !expanded.local_targets.is_empty() || !expanded.external_forwards.is_empty() {
                return expanded;
            }
        }

        self.fallback.expand_recipient(&lower).await
    }
}

/// PostgreSQL-backed [`FeedbackStore`] persisting DSN bounces & ARF complaints into `suppression_entries`.
#[derive(Clone)]
pub struct PgFeedbackStore {
    pg_pool: Option<PgPool>,
}

impl PgFeedbackStore {
    #[must_use]
    pub const fn new(pg_pool: Option<PgPool>) -> Self {
        Self { pg_pool }
    }
}

impl FeedbackStore for PgFeedbackStore {
    async fn record_feedback(&self, feedback: FeedbackClassification) -> Result<()> {
        let Some(pool) = &self.pg_pool else {
            info!(
                ?feedback,
                "Recorded inbound feedback in standalone log mode"
            );
            return Ok(());
        };

        let (rcpt_id_opt, email_opt, reason) = match &feedback {
            FeedbackClassification::HardBounce {
                recipient_id,
                bounced_email,
                ..
            } => (
                recipient_id.as_deref(),
                bounced_email.as_deref(),
                "hard_bounce",
            ),
            FeedbackClassification::Complaint {
                recipient_id,
                complained_email,
                ..
            } => (
                recipient_id.as_deref(),
                complained_email.as_deref(),
                "complaint",
            ),
            FeedbackClassification::SoftBounce { .. } | FeedbackClassification::Unclassified => {
                return Ok(());
            }
        };

        if let Some(rcpt_uuid) = rcpt_id_opt.and_then(|s| Uuid::parse_str(s).ok()) {
            if let Ok(Some(row)) = sqlx::query(
                r"SELECT organization_id, recipient_email::text AS email FROM message_recipients WHERE id = $1",
            )
            .bind(rcpt_uuid)
            .fetch_optional(pool)
            .await
            {
                let org_id: Uuid = row.try_get("organization_id")?;
                let rcpt_email: String = row.try_get("email")?;
                let target_email = email_opt.unwrap_or(&rcpt_email).to_ascii_lowercase();

                if reason == "hard_bounce" {
                    let _ = sqlx::query("UPDATE message_recipients SET state = 'bounced' WHERE id = $1")
                        .bind(rcpt_uuid)
                        .execute(pool)
                        .await;
                }
                let _ = sqlx::query(
                    r"INSERT INTO suppression_entries (id, organization_id, email, reason)
                      VALUES ($1, $2, $3, $4)
                      ON CONFLICT DO NOTHING",
                )
                .bind(Uuid::now_v7())
                .bind(org_id)
                .bind(&target_email)
                .bind(reason)
                .execute(pool)
                .await;
            }
        }

        Ok(())
    }
}

/// Reloads all active DKIM keys from PostgreSQL into `keyring` atomically.
///
/// # Errors
/// Returns an error if querying PostgreSQL fails.
pub async fn reload_dkim_keys_from_db(pool: &PgPool, keyring: &DkimKeyRing) -> Result<usize> {
    let rows = sqlx::query(
        r"SELECT d.domain_name::text AS domain_name, k.selector, k.algorithm, k.public_key_dns_txt, k.encrypted_private_key
            FROM dkim_keys k
            JOIN domains d ON d.id = k.domain_id
           WHERE k.status = 'active' AND d.is_suspended = FALSE",
    )
    .fetch_all(pool)
    .await?;

    let mut loaded = Vec::with_capacity(rows.len());
    for row in rows {
        let domain: String = row.try_get("domain_name").unwrap_or_default();
        let sel: String = row.try_get("selector").unwrap_or_default();
        let algo_str: String = row.try_get("algorithm").unwrap_or_default();
        let pub_txt: String = row.try_get("public_key_dns_txt").unwrap_or_default();
        let enc: Vec<u8> = row.try_get("encrypted_private_key").unwrap_or_default();
        let algorithm = if algo_str.eq_ignore_ascii_case("ed25519") {
            DkimAlgorithm::Ed25519
        } else {
            DkimAlgorithm::Rsa2048
        };
        if !domain.is_empty() && !enc.is_empty() {
            loaded.push(StoredDkimKey {
                dns_record_name: format!("{sel}._domainkey.{domain}"),
                domain: domain.to_ascii_lowercase(),
                selector: sel,
                algorithm,
                public_key_dns_txt: pub_txt,
                encrypted_private_key: enc,
                status: DkimKeyStatus::Active,
            });
        }
    }
    let count = loaded.len();
    keyring.replace_all_keys(loaded);
    Ok(count)
}

/// Loads encrypted DKIM keys from PostgreSQL `dkim_keys` and persists an initial RSA-2048 key for
/// `primary_domain` if none exists yet so restarts never invalidate published DNS records.
pub async fn load_or_seed_dkim_keys(
    pg_pool: Option<&PgPool>,
    keyring: &DkimKeyRing,
    kek: &KeyEncryptionKey,
    primary_domain: Option<&str>,
    selector: &str,
    auto_generate: bool,
) {
    if let Some(pool) = pg_pool {
        if let Err(err) = reload_dkim_keys_from_db(pool, keyring).await {
            warn!(error = %err, "Failed loading DKIM keys from Postgres");
        }
    }

    if auto_generate {
        if let Some(domain) = primary_domain {
            let norm = domain.trim().to_ascii_lowercase();
            if keyring.active_key(&norm).is_none() {
                match generate_domain_dkim_key(&norm, selector, DkimAlgorithm::Rsa2048, kek) {
                    Ok(key) => {
                        if let Some(pool) = pg_pool {
                            if let Ok(Some(dom_row)) = sqlx::query(
                                "SELECT id FROM domains WHERE LOWER(domain_name::text) = $1 LIMIT 1",
                            )
                            .bind(&norm)
                            .fetch_optional(pool)
                            .await
                            {
                                let dom_id: Uuid = dom_row.try_get("id").unwrap_or_default();
                                if let Err(err) = sqlx::query(
                                    r"INSERT INTO dkim_keys (id, domain_id, selector, algorithm, public_key_dns_txt, encrypted_private_key, status)
                                      VALUES ($1, $2, $3, 'rsa2048', $4, $5, 'active')
                                      ON CONFLICT (domain_id, selector) DO NOTHING",
                                )
                                .bind(Uuid::now_v7())
                                .bind(dom_id)
                                .bind(&key.selector)
                                .bind(&key.public_key_dns_txt)
                                .bind(&key.encrypted_private_key)
                                .execute(pool)
                                .await
                                {
                                    warn!(error = %err, "Failed persisting generated DKIM key to Postgres");
                                }
                            }
                        }
                        info!(
                            dns_record_name = %key.dns_record_name,
                            dns_txt_value = %key.public_key_dns_txt,
                            "Active DKIM key ready; publish this TXT record in DNS"
                        );
                        keyring.install_active_key(key);
                    }
                    Err(err) => warn!(error = %err, "Failed generating primary domain DKIM key"),
                }
            }
        }
    }
}
