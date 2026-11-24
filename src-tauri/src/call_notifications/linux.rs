use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use tauri::AppHandle;
use zbus::{zvariant::Value, Connection, Proxy};

use super::{report_action, Action, IncomingCall};

pub(super) struct Notification {
    proxy: Proxy<'static>,
    id: u32,
    listener: tauri::async_runtime::JoinHandle<()>,
}

impl Notification {
    pub(super) async fn show(
        app: &AppHandle,
        call: &IncomingCall,
        remaining: u64,
    ) -> Result<Self, String> {
        tokio::time::timeout(
            Duration::from_millis(remaining.min(1_500)),
            Self::post(app.clone(), call, remaining),
        )
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
    }

    async fn post(app: AppHandle, call: &IncomingCall, remaining: u64) -> zbus::Result<Self> {
        let proxy = Proxy::new_owned(
            Connection::session().await?,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await?;
        let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await?;
        let actions = if capabilities
            .iter()
            .any(|capability| capability == "actions")
        {
            vec![
                "default", "Open Pax", "answer", "Answer", "decline", "Decline",
            ]
        } else {
            Vec::new()
        };
        let mut invoked = proxy.receive_signal("ActionInvoked").await?;
        let config = app.config();
        let hints = HashMap::from([
            ("desktop-entry", Value::new(config.identifier.as_str())),
            ("urgency", Value::new(2u8)),
            ("suppress-sound", Value::new(true)),
        ]);
        let id: u32 = proxy
            .call(
                "Notify",
                &(
                    "Pax",
                    0u32,
                    config.identifier.as_str(),
                    if call.video { "Incoming video call" } else { "Incoming call" },
                    call.caller.as_str(),
                    actions,
                    hints,
                    remaining.min(i32::MAX as u64) as i32,
                ),
            )
            .await?;

        let call_id = call.call_id;
        let listener = tauri::async_runtime::spawn(async move {
            while let Some(message) = invoked.next().await {
                let Ok((notification_id, key)) = message.body().deserialize::<(u32, String)>()
                else {
                    continue;
                };
                if notification_id != id {
                    continue;
                }
                let action = match key.as_str() {
                    "answer" => Action::Answer,
                    "decline" => Action::Decline,
                    "default" => Action::Open,
                    _ => continue,
                };
                report_action(&app, call_id, action);
            }
        });
        Ok(Self {
            proxy,
            id,
            listener,
        })
    }

    pub(super) async fn close(self) {
        self.listener.abort();
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            self.proxy
                .call::<_, _, ()>("CloseNotification", &(self.id,)),
        )
        .await;
    }
}
