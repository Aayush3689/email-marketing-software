//! Wire DTOs and `RabbitMQ` outbound/ingress/inbound bridges for `mail-engine`.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use auth_verification::{DmarcDisposition, InboundAuthVerifier};
use delivery_engine::{DeliveryEngine, DeliveryJob, DeliveryPoolKind, DeliveryStateStore};
use dns_resolver::MxResolver;
use futures_lite::StreamExt;
use lapin::options::{
    BasicAckOptions, BasicCancelOptions, BasicConsumeOptions, BasicNackOptions, BasicQosOptions,
};
use lapin::types::FieldTable;
use mailbox_client::MailboxDeliverer;
use message_storage::MessageStore;
use observability::TraceContext;
use queue_engine::{
    consume_queue, publish_confirmed, ConsumeFailure, RabbitMqClient, QUEUE_INBOUND_DELIVERY,
    QUEUE_OUTBOUND_TX,
};
use serde::{Deserialize, Serialize};
use smtp_inbound::processor::{FeedbackStore, InboundProcessor, InboundRouter};
use smtp_inbound::{ListenerRole, MessageSink};
use smtp_protocol::SmtpResponse;
use smtp_session::{ReceivedMessage, SessionContext};
use tokio::sync::{watch, Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio::time::sleep;
use tracing::{error, info, warn};
use uuid::Uuid;

/// JSON job schema matching `@mail/shared-types` `OutboundDispatchJob`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireOutboundJob {
    pub message_id: String,
    pub recipient_id: String,
    pub organization_id: String,
    pub domain_id: Option<String>,
    pub source_type: String,
    pub envelope_from: String,
    pub recipient_email: String,
    pub body_storage_key: String,
    pub ip_pool_id: Option<String>,
    pub attempt_no: u16,
    #[serde(default)]
    pub traceparent: Option<String>,
}

/// JSON job queued when Port 25 MX accepts an external message for local mailbox/feedback processing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireInboundJob {
    pub storage_key: String,
    pub envelope_from: String,
    pub recipients: Vec<String>,
    pub remote_ip: IpAddr,
    pub helo_domain: String,
    #[serde(default)]
    pub traceparent: Option<String>,
}

/// Persists accepted ingress/submission SMTP messages to `MessageStore` and dispatches them into
/// the appropriate `RabbitMQ` pipeline (`QUEUE_OUTBOUND_TX` for 587/465, `QUEUE_INBOUND_DELIVERY` for 25).
pub struct PipelineMessageSink<S> {
    role: ListenerRole,
    storage: Arc<S>,
    rabbitmq_channel: Option<Arc<Mutex<lapin::Channel>>>,
    auth_verifier: Option<Arc<InboundAuthVerifier>>,
}

impl<S> PipelineMessageSink<S> {
    #[must_use]
    pub const fn new(
        role: ListenerRole,
        storage: Arc<S>,
        rabbitmq_channel: Option<Arc<Mutex<lapin::Channel>>>,
        auth_verifier: Option<Arc<InboundAuthVerifier>>,
    ) -> Self {
        Self {
            role,
            storage,
            rabbitmq_channel,
            auth_verifier,
        }
    }
}

impl<S: MessageStore + 'static> MessageSink for PipelineMessageSink<S> {
    async fn accept_message(
        &self,
        ctx: &SessionContext,
        message: ReceivedMessage,
    ) -> std::result::Result<SmtpResponse, SmtpResponse> {
        let trace = TraceContext::new_root();
        let envelope_from = message
            .reverse_path
            .clone()
            .unwrap_or_else(|| "postmaster@localhost".to_string());

        match self.role {
            ListenerRole::ServerToServerMx => {
                self.handle_mx_ingress(
                    ctx,
                    &envelope_from,
                    message.recipients,
                    &message.data,
                    &trace,
                )
                .await
            }
            ListenerRole::AuthenticatedSubmission => {
                self.handle_submission(
                    ctx,
                    &envelope_from,
                    &message.recipients,
                    &message.data,
                    &trace,
                )
                .await
            }
        }
    }
}

impl<S: MessageStore + 'static> PipelineMessageSink<S> {
    async fn handle_mx_ingress(
        &self,
        ctx: &SessionContext,
        envelope_from: &str,
        recipients: Vec<String>,
        raw_mime: &[u8],
        trace: &TraceContext,
    ) -> std::result::Result<SmtpResponse, SmtpResponse> {
        let helo = ctx.client_domain.as_deref().unwrap_or("unknown");
        let sanitized_mime = if let Some(verifier) = &self.auth_verifier {
            let report = verifier
                .verify(ctx.peer_addr.ip(), helo, envelope_from, raw_mime)
                .await
                .map_err(|_| {
                    SmtpResponse::single(550, Some("5.7.1"), "Malformed RFC 5322 headers")
                })?;
            if report.disposition == DmarcDisposition::Reject {
                return Err(SmtpResponse::single(
                    550,
                    Some("5.7.1"),
                    "Message rejected by DMARC policy",
                ));
            }
            verifier.prepend_sanitized_header(raw_mime, &report)
        } else {
            raw_mime.to_vec()
        };

        let stored = self
            .storage
            .put_message("inbound", &sanitized_mime)
            .await
            .map_err(|err| {
                error!(error = %err, "Failed persisting inbound MX payload to storage");
                SmtpResponse::service_unavailable("Temporary storage failure")
            })?;

        let msg_id = Uuid::now_v7().to_string();
        if let Some(ch_lock) = &self.rabbitmq_channel {
            let job = WireInboundJob {
                storage_key: stored.storage_key.clone(),
                envelope_from: envelope_from.to_string(),
                recipients,
                remote_ip: ctx.peer_addr.ip(),
                helo_domain: helo.to_string(),
                traceparent: Some(trace.to_traceparent()),
            };
            let bytes = serde_json::to_vec(&job)
                .map_err(|_| SmtpResponse::service_unavailable("Serialization error"))?;
            let ch = ch_lock.lock().await;
            publish_confirmed(&ch, QUEUE_INBOUND_DELIVERY, &bytes)
                .await
                .map_err(|err| {
                    error!(error = %err, "Failed publishing inbound MX job to RabbitMQ");
                    SmtpResponse::service_unavailable("Queue temporarily unavailable")
                })?;
        } else {
            info!(
                storage_key = %stored.storage_key,
                trace_id = %trace.trace_id,
                "Stored inbound MX message without RabbitMQ configured"
            );
        }

        Ok(SmtpResponse::ok(format!("2.0.0 Queued {msg_id}")))
    }

    async fn handle_submission(
        &self,
        ctx: &SessionContext,
        envelope_from: &str,
        recipients: &[String],
        raw_mime: &[u8],
        trace: &TraceContext,
    ) -> std::result::Result<SmtpResponse, SmtpResponse> {
        let org_id = ctx
            .authenticated_user
            .as_deref()
            .unwrap_or("default-ingress");
        let stored = self
            .storage
            .put_message(org_id, raw_mime)
            .await
            .map_err(|err| {
                error!(error = %err, "Failed persisting submission SMTP payload to storage");
                SmtpResponse::service_unavailable("Temporary storage failure")
            })?;

        let msg_id = Uuid::now_v7().to_string();
        if let Some(ch_lock) = &self.rabbitmq_channel {
            let ch = ch_lock.lock().await;
            for rcpt in recipients {
                let job = WireOutboundJob {
                    message_id: msg_id.clone(),
                    recipient_id: Uuid::now_v7().to_string(),
                    organization_id: org_id.to_string(),
                    domain_id: None,
                    source_type: "smtp".to_string(),
                    envelope_from: envelope_from.to_string(),
                    recipient_email: rcpt.clone(),
                    body_storage_key: stored.storage_key.clone(),
                    ip_pool_id: None,
                    attempt_no: 1,
                    traceparent: Some(trace.to_traceparent()),
                };
                let bytes = serde_json::to_vec(&job)
                    .map_err(|_| SmtpResponse::service_unavailable("Serialization error"))?;
                publish_confirmed(&ch, QUEUE_OUTBOUND_TX, &bytes)
                    .await
                    .map_err(|err| {
                        error!(error = %err, "Failed publishing SMTP submission job to RabbitMQ");
                        SmtpResponse::service_unavailable("Queue temporarily unavailable")
                    })?;
            }
        } else {
            info!(
                storage_key = %stored.storage_key,
                recipients = recipients.len(),
                trace_id = %trace.trace_id,
                "Stored SMTP submission message without RabbitMQ configured"
            );
        }

        Ok(SmtpResponse::ok(format!("2.0.0 Queued {msg_id}")))
    }
}

/// Runs a concurrent late-ACK `RabbitMQ` consumer for outbound SMTP deliveries.
///
/// Only acknowledges (`basic_ack`) each AMQP delivery AFTER [`DeliveryEngine::process_job`]
/// finishes and persists state durably (`timing.persist_succeeded == true`), or dead-letters
/// malformed payloads. On drain or shutdown, cancels consumption and drains all in-flight tasks.
///
/// # Errors
/// Returns an error if `RabbitMQ` channel or `QoS` setup fails.
pub async fn run_rabbitmq_outbound_consumer<R, S, P>(
    rmq: Arc<RabbitMqClient>,
    queue_name: String,
    pool_kind: DeliveryPoolKind,
    engine: Arc<DeliveryEngine<R, S, P>>,
    draining: Arc<AtomicBool>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()>
where
    R: MxResolver + 'static,
    S: MessageStore + 'static,
    P: DeliveryStateStore + 'static,
{
    let prefetch: usize = match pool_kind {
        DeliveryPoolKind::Transactional => 64,
        DeliveryPoolKind::Bulk => 32,
    };
    let channel = rmq.create_confirm_channel().await?;
    channel
        .basic_qos(
            u16::try_from(prefetch).unwrap_or(64),
            BasicQosOptions::default(),
        )
        .await?;

    let consumer_tag = format!("mail-engine-{queue_name}");
    let mut consumer = channel
        .basic_consume(
            &queue_name,
            &consumer_tag,
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    let sem = Arc::new(Semaphore::new(prefetch));
    let mut in_flight = JoinSet::new();
    info!(queue = %queue_name, prefetch, "Starting late-ACK RabbitMQ outbound worker consumer");

    loop {
        while let Some(joined) = in_flight.try_join_next() {
            if let Err(err) = joined {
                error!(error = %err, "Outbound delivery worker task panicked");
            }
        }
        while draining.load(Ordering::Relaxed) {
            if *shutdown.borrow() {
                break;
            }
            sleep(Duration::from_millis(250)).await;
        }
        if *shutdown.borrow() {
            break;
        }

        tokio::select! {
            delivery_opt = consumer.next() => {
                match delivery_opt {
                    Some(Ok(delivery)) => {
                        let Ok(permit) = Arc::clone(&sem).acquire_owned().await else {
                            break;
                        };
                        let eng = Arc::clone(&engine);
                        let q = queue_name.clone();
                        in_flight.spawn(async move {
                            let _permit = permit;
                            handle_outbound_delivery(delivery, &q, pool_kind, &eng).await;
                        });
                    }
                    Some(Err(err)) => {
                        warn!(queue = %queue_name, error = %err, "RabbitMQ outbound consumer stream error");
                        break;
                    }
                    None => break,
                }
            }
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    info!(queue = %queue_name, "Stopping RabbitMQ outbound consumer intake");
                    break;
                }
            }
        }
    }

    let _ = channel
        .basic_cancel(&consumer_tag, BasicCancelOptions::default())
        .await;
    while let Some(joined) = in_flight.join_next().await {
        if let Err(err) = joined {
            error!(error = %err, "In-flight outbound worker panicked during drain");
        }
    }
    info!(queue = %queue_name, "RabbitMQ outbound consumer drained");
    Ok(())
}

async fn handle_outbound_delivery<R, S, P>(
    delivery: lapin::message::Delivery,
    queue_name: &str,
    pool_kind: DeliveryPoolKind,
    engine: &DeliveryEngine<R, S, P>,
) where
    R: MxResolver + 'static,
    S: MessageStore + 'static,
    P: DeliveryStateStore + 'static,
{
    let wire: WireOutboundJob = match serde_json::from_slice(&delivery.data) {
        Ok(parsed) => parsed,
        Err(err) => {
            warn!(queue = %queue_name, error = %err, "Dead-lettering invalid WireOutboundJob JSON");
            let _ = delivery
                .nack(BasicNackOptions {
                    multiple: false,
                    requeue: false,
                })
                .await;
            return;
        }
    };

    let trace_id = wire
        .traceparent
        .as_deref()
        .and_then(TraceContext::from_traceparent)
        .map_or_else(
            || TraceContext::new_root().trace_id,
            |t| t.child_span().trace_id,
        );

    info!(
        trace_id = %trace_id,
        message_id = %wire.message_id,
        recipient = %wire.recipient_email,
        pool = pool_kind.as_str(),
        "Executing late-ACK outbound SMTP delivery job"
    );

    let job = DeliveryJob {
        message_id: wire.message_id,
        recipient_id: wire.recipient_id,
        organization_id: wire.organization_id,
        pool: pool_kind,
        envelope_from: wire.envelope_from,
        recipient_email: wire.recipient_email,
        body_storage_key: wire.body_storage_key,
        bind_ip: None,
        attempt_no: wire.attempt_no.max(1),
        enqueued_at: Instant::now(),
    };

    let timing = engine.process_job(job).await;
    if timing.persist_succeeded {
        if let Err(err) = delivery.ack(BasicAckOptions::default()).await {
            warn!(error = %err, "Failed ACKing completed outbound delivery");
        }
    } else {
        warn!(queue = %queue_name, "State persistence failed; NACK-requeueing outbound delivery");
        let _ = delivery
            .nack(BasicNackOptions {
                multiple: false,
                requeue: true,
            })
            .await;
    }
}

/// Consumes `mail.inbound.delivery` and executes local `Dovecot` LMTP / bounce feedback processing.
///
/// # Errors
/// Returns an error if `RabbitMQ` channel setup fails.
pub async fn run_rabbitmq_inbound_consumer<R, S, M, F>(
    rmq: Arc<RabbitMqClient>,
    processor: Arc<InboundProcessor<R, S, M, F>>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()>
where
    R: InboundRouter + 'static,
    S: MessageStore + 'static,
    M: MailboxDeliverer + 'static,
    F: FeedbackStore + 'static,
{
    let channel = rmq.create_confirm_channel().await?;
    let consumer_tag = format!("mail-engine-{QUEUE_INBOUND_DELIVERY}");
    info!(
        queue = QUEUE_INBOUND_DELIVERY,
        "Starting RabbitMQ inbound delivery consumer"
    );

    tokio::select! {
        res = consume_queue(&channel, QUEUE_INBOUND_DELIVERY, &consumer_tag, 16, move |payload| {
            let proc_ref = Arc::clone(&processor);
            async move {
                let wire: WireInboundJob = serde_json::from_slice(&payload).map_err(|err| {
                    ConsumeFailure::DeadLetter(format!("invalid WireInboundJob JSON: {err}"))
                })?;

                let report = proc_ref
                    .process_message(&wire.envelope_from, &wire.recipients, &wire.storage_key)
                    .await
                    .map_err(|err| {
                        warn!(error = %err, storage_key = %wire.storage_key, "Inbound delivery processing failed");
                        ConsumeFailure::Transient(err.to_string())
                    })?;

                if report.lmtp_failed.iter().any(|(_, code, _)| (400..500).contains(code)) {
                    return Err(ConsumeFailure::Transient(
                        "Temporary LMTP 4xx failure on Dovecot".to_string(),
                    ));
                }

                Ok(())
            }
        }) => {
            res?;
        }
        _ = shutdown.changed() => {
            if *shutdown.borrow() {
                info!("Shutting down RabbitMQ inbound delivery consumer");
            }
        }
    }

    Ok(())
}
