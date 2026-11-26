//! End-to-end delivery pipeline verification:
//! Spool -> DKIM Signing -> DNS MX -> Outbound SMTP Pool -> Real TCP SMTP Receiver.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use delivery_engine::{
    DeliveryEngine, DeliveryEngineConfig, DeliveryJob, DeliveryPoolKind,
    InMemoryDeliveryStateStore, RecipientDeliveryState,
};
use dkim::{generate_domain_dkim_key, DkimAlgorithm, DkimKeyRing, KeyEncryptionKey};
use dns_resolver::{MxResolution, MxTarget, StaticMxResolver};
use message_storage::{LocalSpoolStore, MessageStore};
use observability::MetricsRegistry;
use smtp_outbound::{OutboundClientConfig, OutboundSmtpPool};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use uuid::Uuid;

async fn spawn_smtp_receiver() -> (u16, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mx_port = listener.local_addr().unwrap().port();
    let received_bodies: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let cap = Arc::clone(&received_bodies);

    let handle = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (r, mut w) = stream.into_split();
        let mut reader = BufReader::new(r);
        w.write_all(b"220 mx.remote.example ESMTP\r\n")
            .await
            .unwrap();

        let mut in_data = false;
        let mut body = String::new();
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await.unwrap();
            if n == 0 {
                break;
            }
            if in_data {
                if line == ".\r\n" {
                    cap.lock().unwrap().push(body.clone());
                    w.write_all(b"250 2.0.0 OK queued\r\n").await.unwrap();
                    in_data = false;
                } else {
                    body.push_str(&line);
                }
            } else if line.to_ascii_uppercase().starts_with("EHLO")
                || line.to_ascii_uppercase().starts_with("HELO")
            {
                w.write_all(b"250-mx.remote.example\r\n250 PIPELINING\r\n")
                    .await
                    .unwrap();
            } else if line.to_ascii_uppercase().starts_with("MAIL FROM")
                || line.to_ascii_uppercase().starts_with("RCPT TO")
            {
                w.write_all(b"250 2.1.0 Ok\r\n").await.unwrap();
            } else if line.eq_ignore_ascii_case("DATA\r\n") {
                in_data = true;
                w.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                    .await
                    .unwrap();
            } else if line.eq_ignore_ascii_case("QUIT\r\n") {
                w.write_all(b"221 Bye\r\n").await.unwrap();
                break;
            }
        }
    });

    (mx_port, received_bodies, handle)
}

#[tokio::test]
async fn delivers_dkim_signed_email_from_local_spool_to_real_smtp_listener() {
    let tmp_dir = std::env::temp_dir().join(format!("mailforge-e2e-{}", Uuid::now_v7()));
    let spool = Arc::new(LocalSpoolStore::new(&tmp_dir).await.unwrap());

    let kek = KeyEncryptionKey::from_hex(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )
    .unwrap();
    let keyring = Arc::new(DkimKeyRing::default());
    let dkim_key =
        generate_domain_dkim_key("acme.example", "mp1", DkimAlgorithm::Rsa2048, &kek).unwrap();
    keyring.install_active_key(dkim_key.clone());

    let raw_mime = b"From: sender@acme.example\r\nTo: recipient@remote.example\r\nSubject: E2E Real SMTP\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello via E2E SMTP!\r\n";
    let signed_mime = dkim::sign_rfc5322_message(raw_mime, &dkim_key, &kek).unwrap();
    let signed_obj = spool.put_message("org-e2e", &signed_mime).await.unwrap();

    let (mx_port, received_bodies, mx_server) = spawn_smtp_receiver().await;
    let resolver = Arc::new(StaticMxResolver::default());
    resolver.set_route(
        "remote.example",
        Ok(MxResolution::Targets(vec![MxTarget {
            exchange: "mx.remote.example".to_string(),
            preference: 10,
            addrs: vec!["127.0.0.1".parse().unwrap()],
            port: mx_port,
        }])),
    );

    let smtp_pool = Arc::new(OutboundSmtpPool::new(OutboundClientConfig {
        helo_domain: "mx1.acme.example".to_string(),
        ..OutboundClientConfig::default()
    }));
    let state_store = Arc::new(InMemoryDeliveryStateStore::default());
    let metrics = Arc::new(MetricsRegistry::new().unwrap());
    let engine = Arc::new(DeliveryEngine::new(
        DeliveryEngineConfig {
            block_private_mx_ips: false,
            ..DeliveryEngineConfig::default()
        },
        resolver,
        spool,
        smtp_pool,
        state_store,
        metrics,
    ));

    let timing = engine
        .process_job(DeliveryJob {
            message_id: Uuid::now_v7().to_string(),
            recipient_id: Uuid::now_v7().to_string(),
            organization_id: "org-e2e".to_string(),
            pool: DeliveryPoolKind::Transactional,
            envelope_from: "sender@acme.example".to_string(),
            recipient_email: "recipient@remote.example".to_string(),
            body_storage_key: signed_obj.storage_key,
            bind_ip: None,
            attempt_no: 1,
            enqueued_at: Instant::now(),
        })
        .await;

    assert_eq!(timing.outcome_state, RecipientDeliveryState::AcceptedRemote);
    {
        let captured = received_bodies.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert!(captured[0].contains("DKIM-Signature:"));
        assert!(captured[0].contains("Hello via E2E SMTP!"));
    }
    mx_server.abort();
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
}
