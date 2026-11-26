//! Inbound message spooling, alias/catch-all/forwarding expansion,
//! Dovecot LMTP delivery, and DSN/ARF feedback dispatch.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use bounce_handler::{classify_feedback_message, FeedbackClassification};
use mailbox_client::{LmtpRecipientStatus, MailboxDeliverer};
use message_storage::MessageStore;
use smtp_protocol::SmtpResponse;
use smtp_session::{ReceivedMessage, SessionContext};
use tracing::{info, warn};

use crate::{DomainDirectory, MessageSink, RecipientRouting};

/// Resolved local Dovecot mailbox target.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MailboxTarget {
    pub email: String,
    pub lmtp_host: String,
    pub lmtp_port: u16,
}

/// Complete inbound routing expansion for one recipient address.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpandedRouting {
    pub local_targets: Vec<MailboxTarget>,
    pub external_forwards: Vec<String>,
    pub is_feedback: bool,
}

/// Extended routing lookup supporting aliases, forwarding rules, and catch-all mailboxes.
pub trait InboundRouter: DomainDirectory {
    fn expand_recipient(&self, email: &str) -> impl Future<Output = ExpandedRouting> + Send;
}

/// Persistence interface for inbound DSN bounces and ARF spam complaints.
pub trait FeedbackStore: Send + Sync {
    fn record_feedback(
        &self,
        feedback: FeedbackClassification,
    ) -> impl Future<Output = Result<()>> + Send;
}

/// In-memory feedback store for tests.
#[derive(Debug, Default)]
pub struct InMemoryFeedbackStore {
    pub events: Mutex<Vec<FeedbackClassification>>,
}

impl FeedbackStore for InMemoryFeedbackStore {
    fn record_feedback(
        &self,
        feedback: FeedbackClassification,
    ) -> impl Future<Output = Result<()>> + Send {
        if let Ok(mut guard) = self.events.lock() {
            guard.push(feedback);
        }
        std::future::ready(Ok(()))
    }
}

/// [`MessageSink`] that persists accepted SMTP payloads atomically into [`MessageStore`]
/// before returning `250 2.0.0 OK` and forwarding storage keys to a dispatcher channel.
pub struct SpoolingMessageSink<S> {
    organization_id: String,
    store: Arc<S>,
    pub accepted_keys: Mutex<Vec<(String, ReceivedMessage)>>,
}

impl<S> SpoolingMessageSink<S> {
    #[must_use]
    pub fn new(organization_id: impl Into<String>, store: Arc<S>) -> Self {
        Self {
            organization_id: organization_id.into(),
            store,
            accepted_keys: Mutex::new(Vec::new()),
        }
    }
}

impl<S: MessageStore> MessageSink for SpoolingMessageSink<S> {
    async fn accept_message(
        &self,
        _ctx: &SessionContext,
        message: ReceivedMessage,
    ) -> std::result::Result<SmtpResponse, SmtpResponse> {
        match self
            .store
            .put_message(&self.organization_id, &message.data)
            .await
        {
            Ok(obj) => {
                let key = obj.storage_key.clone();
                if let Ok(mut guard) = self.accepted_keys.lock() {
                    guard.push((key.clone(), message));
                }
                Ok(SmtpResponse::ok(format!("2.0.0 Queued as {key}")))
            }
            Err(err) => {
                warn!(error = %err, "Failed to persist inbound message to spool");
                Err(SmtpResponse::service_unavailable(
                    "Temporary local storage failure",
                ))
            }
        }
    }
}

/// Summary of processing one inbound spooled message.
#[derive(Debug, Default)]
pub struct InboundProcessReport {
    pub lmtp_delivered: Vec<String>,
    pub lmtp_failed: Vec<(String, u16, String)>,
    pub external_forwards: Vec<String>,
    pub feedback_events: usize,
}

/// Processes spooled inbound messages: classifies VERP/DSN/ARF feedback or expands
/// aliases/forwarding/catch-all and delivers locally via Dovecot LMTP.
pub struct InboundProcessor<R, S, M, F> {
    router: Arc<R>,
    store: Arc<S>,
    lmtp: Arc<M>,
    feedback_store: Arc<F>,
}

impl<R, S, M, F> InboundProcessor<R, S, M, F>
where
    R: InboundRouter,
    S: MessageStore,
    M: MailboxDeliverer,
    F: FeedbackStore,
{
    #[must_use]
    pub fn new(router: Arc<R>, store: Arc<S>, lmtp: Arc<M>, feedback_store: Arc<F>) -> Self {
        Self {
            router,
            store,
            lmtp,
            feedback_store,
        }
    }

    /// Processes a spooled inbound message end-to-end.
    ///
    /// # Errors
    /// Returns an error if reading the spooled payload, recording feedback, or LMTP transport fails.
    pub async fn process_message(
        &self,
        envelope_from: &str,
        recipients: &[String],
        storage_key: &str,
    ) -> Result<InboundProcessReport> {
        let raw_mime = self.store.get_message(storage_key).await?;
        let mut report = InboundProcessReport::default();

        // Group local LMTP deliveries by (lmtp_host, lmtp_port)
        let mut by_server: HashMap<(String, u16), Vec<String>> = HashMap::new();
        let mut seen_local = HashSet::new();
        let mut seen_fwd = HashSet::new();

        for rcpt in recipients {
            let routing = self.router.classify_recipient(rcpt).await;
            if routing == RecipientRouting::FeedbackAddress {
                let classification = classify_feedback_message(Some(rcpt), raw_mime.as_ref());
                self.feedback_store.record_feedback(classification).await?;
                report.feedback_events += 1;
                continue;
            }

            let expanded = self.router.expand_recipient(rcpt).await;
            for target in expanded.local_targets {
                if seen_local.insert(target.email.clone()) {
                    by_server
                        .entry((target.lmtp_host, target.lmtp_port))
                        .or_default()
                        .push(target.email);
                }
            }
            for ext in expanded.external_forwards {
                if seen_fwd.insert(ext.clone()) {
                    report.external_forwards.push(ext);
                }
            }
        }

        for ((host, port), batch) in by_server {
            let lmtp_results = self
                .lmtp
                .deliver_lmtp(&host, port, envelope_from, &batch, raw_mime.as_ref())
                .await?;

            for res in lmtp_results {
                match res.status {
                    LmtpRecipientStatus::Delivered { .. } => {
                        info!(recipient = %res.recipient, host, port, "Delivered to Dovecot LMTP");
                        report.lmtp_delivered.push(res.recipient);
                    }
                    LmtpRecipientStatus::TempFail { smtp_code, message }
                    | LmtpRecipientStatus::PermFail { smtp_code, message } => {
                        warn!(
                            recipient = %res.recipient,
                            smtp_code,
                            message,
                            "Dovecot LMTP rejected recipient"
                        );
                        report.lmtp_failed.push((res.recipient, smtp_code, message));
                    }
                }
            }
        }

        Ok(report)
    }
}
