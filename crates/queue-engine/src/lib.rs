//! Durable `RabbitMQ` integration via `Lapin` on Tokio with publisher confirms,
//! dead-letter exchanges (`dlx.mail`), and `basic_qos` prefetch backpressure.

use std::future::Future;

use anyhow::Result;
use futures_lite::StreamExt;
use lapin::options::{
    BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicPublishOptions, BasicQosOptions,
    ConfirmSelectOptions, ExchangeDeclareOptions, QueueBindOptions, QueueDeclareOptions,
};
use lapin::types::FieldTable;
use lapin::{BasicProperties, Channel, Connection, ConnectionProperties, ExchangeKind};
use tracing::{error, info, warn};

/// Primary exchange and queue names matching the platform messaging architecture.
pub const MAIL_EXCHANGE: &str = "mail.events";
pub const MAIL_DLX: &str = "dlx.mail";

pub const QUEUE_OUTBOUND_TX: &str = "mail.outbound.transactional";
pub const QUEUE_OUTBOUND_BULK: &str = "mail.outbound.bulk";
pub const QUEUE_OUTBOUND_RETRY: &str = "mail.outbound.retry";
pub const QUEUE_INBOUND_DELIVERY: &str = "mail.inbound.delivery";
pub const QUEUE_INBOUND_FEEDBACK: &str = "mail.inbound.feedback";
pub const QUEUE_WEBHOOKS: &str = "mail.webhooks.dispatch";
pub const QUEUE_ANALYTICS: &str = "mail.analytics.events";

/// Wrapper around an AMQP connection configured for Tokio.
pub struct RabbitMqClient {
    conn: Connection,
}

impl RabbitMqClient {
    /// Connects to `RabbitMQ` using Tokio's async executor and reactor.
    ///
    /// # Errors
    /// Returns an error if AMQP TCP/TLS connection or authentication fails.
    pub async fn connect(amqp_url: &str) -> Result<Self> {
        let props = ConnectionProperties::default()
            .with_executor(tokio_executor_trait::Tokio::current())
            .with_reactor(tokio_reactor_trait::Tokio);
        let conn = Connection::connect(amqp_url, props).await?;
        info!("Connected to RabbitMQ");
        Ok(Self { conn })
    }

    /// Creates an AMQP channel with publisher confirms enabled.
    ///
    /// # Errors
    /// Returns an error if opening the channel or enabling confirms fails.
    pub async fn create_confirm_channel(&self) -> Result<Channel> {
        let ch = self.conn.create_channel().await?;
        ch.confirm_select(ConfirmSelectOptions::default()).await?;
        Ok(ch)
    }

    /// Declares durable exchanges, queues, and dead-letter queues idempotently.
    ///
    /// # Errors
    /// Returns an error if broker topology declaration fails.
    pub async fn declare_topology(&self) -> Result<()> {
        let ch = self.conn.create_channel().await?;
        ch.exchange_declare(
            MAIL_EXCHANGE,
            ExchangeKind::Topic,
            ExchangeDeclareOptions {
                durable: true,
                ..ExchangeDeclareOptions::default()
            },
            FieldTable::default(),
        )
        .await?;

        ch.exchange_declare(
            MAIL_DLX,
            ExchangeKind::Topic,
            ExchangeDeclareOptions {
                durable: true,
                ..ExchangeDeclareOptions::default()
            },
            FieldTable::default(),
        )
        .await?;

        for queue in [
            QUEUE_OUTBOUND_TX,
            QUEUE_OUTBOUND_BULK,
            QUEUE_OUTBOUND_RETRY,
            QUEUE_INBOUND_DELIVERY,
            QUEUE_INBOUND_FEEDBACK,
            QUEUE_WEBHOOKS,
            QUEUE_ANALYTICS,
        ] {
            let dlq = format!("{queue}.dlq");
            ch.queue_declare(
                &dlq,
                QueueDeclareOptions {
                    durable: true,
                    ..QueueDeclareOptions::default()
                },
                FieldTable::default(),
            )
            .await?;
            ch.queue_bind(
                &dlq,
                MAIL_DLX,
                queue,
                QueueBindOptions::default(),
                FieldTable::default(),
            )
            .await?;

            let mut args = FieldTable::default();
            args.insert(
                "x-dead-letter-exchange".into(),
                lapin::types::AMQPValue::LongString(MAIL_DLX.into()),
            );
            args.insert(
                "x-dead-letter-routing-key".into(),
                lapin::types::AMQPValue::LongString(queue.into()),
            );

            ch.queue_declare(
                queue,
                QueueDeclareOptions {
                    durable: true,
                    ..QueueDeclareOptions::default()
                },
                args,
            )
            .await?;
            ch.queue_bind(
                queue,
                MAIL_EXCHANGE,
                queue,
                QueueBindOptions::default(),
                FieldTable::default(),
            )
            .await?;
        }

        info!("RabbitMQ durable topology and DLQs declared");
        Ok(())
    }
}

/// Publishes a persistent JSON message and awaits broker publisher confirmation.
///
/// # Errors
/// Returns an error if publishing or broker confirmation fails/nacks.
pub async fn publish_confirmed(channel: &Channel, routing_key: &str, payload: &[u8]) -> Result<()> {
    let confirm = channel
        .basic_publish(
            MAIL_EXCHANGE,
            routing_key,
            BasicPublishOptions {
                mandatory: true,
                ..BasicPublishOptions::default()
            },
            payload,
            BasicProperties::default()
                .with_delivery_mode(2) // persistent
                .with_content_type("application/json".into()),
        )
        .await?
        .await?;

    if confirm.is_nack() {
        anyhow::bail!("RabbitMQ broker NACKed publish to {routing_key}");
    }
    Ok(())
}

/// Consumes messages with bounded `prefetch_count` backpressure, acknowledging ONLY after
/// `handler` durably completes.
///
/// # Errors
/// Returns an error if `QoS` setup or consumer registration fails.
pub async fn consume_queue<F, Fut>(
    channel: &Channel,
    queue: &str,
    consumer_tag: &str,
    prefetch_count: u16,
    mut handler: F,
) -> Result<()>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: Future<Output = std::result::Result<(), ConsumeFailure>>,
{
    channel
        .basic_qos(prefetch_count, BasicQosOptions::default())
        .await?;

    let mut consumer = channel
        .basic_consume(
            queue,
            consumer_tag,
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;

    while let Some(delivery_res) = consumer.next().await {
        match delivery_res {
            Ok(delivery) => match handler(delivery.data.clone()).await {
                Ok(()) => {
                    delivery.ack(BasicAckOptions::default()).await?;
                }
                Err(ConsumeFailure::DeadLetter(reason)) => {
                    warn!(queue, reason, "Dead-lettering unprocessable AMQP message");
                    delivery
                        .nack(BasicNackOptions {
                            requeue: false,
                            ..BasicNackOptions::default()
                        })
                        .await?;
                }
                Err(ConsumeFailure::Transient(reason)) => {
                    warn!(
                        queue,
                        reason, "Requeueing AMQP message after transient failure"
                    );
                    delivery
                        .nack(BasicNackOptions {
                            requeue: true,
                            ..BasicNackOptions::default()
                        })
                        .await?;
                }
            },
            Err(err) => {
                error!(queue, error = %err, "RabbitMQ consumer stream error");
                return Err(err.into());
            }
        }
    }

    Ok(())
}

/// Disposition returned by a queue consumer handler.
#[derive(Debug, Clone)]
pub enum ConsumeFailure {
    /// Route immediately to Dead-Letter Queue (e.g., malformed JSON).
    DeadLetter(String),
    /// Transient infrastructure error; requeue for retry.
    Transient(String),
}
