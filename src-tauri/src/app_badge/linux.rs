use std::{collections::HashMap, sync::OnceLock};

use tokio::sync::watch;
use zbus::{zvariant::Value, Connection};

static COUNT: OnceLock<watch::Sender<u64>> = OnceLock::new();

pub(super) fn set(count: u64) {
    COUNT
        .get_or_init(|| {
            let (sender, receiver) = watch::channel(0);
            tauri::async_runtime::spawn(publish(receiver));
            sender
        })
        .send_replace(count);
}

async fn publish(mut counts: watch::Receiver<u64>) {
    // Keep the sender on the session bus for the lifetime of the app. Some
    // docks clear their overlays as soon as the sending bus name disappears.
    let mut connection = None;
    while counts.changed().await.is_ok() {
        let count = *counts.borrow_and_update();
        if let Err(error) = update(&mut connection, count).await {
            log::debug!("[badge] launcher update failed: {error}");
            connection = None;
        }
    }
}

async fn update(connection: &mut Option<Connection>, count: u64) -> zbus::Result<()> {
    if connection.is_none() {
        *connection = Some(Connection::session().await?);
    }
    let properties = HashMap::from([
        (
            "count",
            Value::new(i64::try_from(count).unwrap_or(i64::MAX)),
        ),
        ("count-visible", Value::new(count > 0)),
    ]);
    connection
        .as_ref()
        .expect("session connection initialized")
        .emit_signal(
            None::<&str>,
            "/com/canonical/unity/launcherentry",
            "com.canonical.Unity.LauncherEntry",
            "Update",
            &("application://pax.desktop", properties),
        )
        .await
}
