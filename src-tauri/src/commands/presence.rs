use std::sync::Arc;

use tauri::{Emitter, State};

use crate::types::PresencePayload;
use crate::{idle, AppState};

use super::{fmt_error_chain, get_client};

#[tauri::command]
pub async fn set_presence(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    presence: String,
) -> Result<(), String> {
    let presence_state = match presence.as_str() {
        "online" => matrix_sdk::ruma::presence::PresenceState::Online,
        "unavailable" => matrix_sdk::ruma::presence::PresenceState::Unavailable,
        "offline" => matrix_sdk::ruma::presence::PresenceState::Offline,
        _ => return Err(format!("Invalid presence state: {presence}")),
    };

    let client = get_client(&state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();
    let user_id_str = user_id.to_string();

    let request = matrix_sdk::ruma::api::client::presence::set_presence::v3::Request::new(
        user_id,
        presence_state,
    );

    client
        .send(request)
        .await
        .map_err(|e| format!("Failed to set presence: {}", fmt_error_chain(&e)))?;

    // Sync only fills `presence_map` from presence events in the sync response; our own
    // presence is set out-of-band and may not echo back immediately, so keep the map
    // in sync with what we actually sent (avoids showing the local user as offline).
    state
        .presence_map
        .lock()
        .await
        .insert(user_id_str.clone(), presence.clone());

    let _ = app.emit(
        "presence",
        PresencePayload {
            user_id: user_id_str,
            presence,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn start_idle_monitor(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let display_server = state.display_server;
    // Avoid AppHandle::clone from the idle loop task when emitting (Rc in Tauri/Tao).
    let app = Arc::new(app);

    tokio::spawn(async move {
        idle::run_idle_monitor(app, display_server).await;
    });

    Ok(())
}
