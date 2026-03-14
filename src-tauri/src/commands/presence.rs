use std::sync::Arc;

use tauri::State;

use crate::{idle, AppState};

#[tauri::command]
pub async fn set_presence(
    state: State<'_, Arc<AppState>>,
    presence: String,
) -> Result<(), String> {
    let presence_state = match presence.as_str() {
        "online" => matrix_sdk::ruma::presence::PresenceState::Online,
        "unavailable" => matrix_sdk::ruma::presence::PresenceState::Unavailable,
        "offline" => matrix_sdk::ruma::presence::PresenceState::Offline,
        _ => return Err(format!("Invalid presence state: {presence}")),
    };

    let (client, user_id) = {
        let guard = state.client.lock().await;
        let c = guard.as_ref().ok_or("Not logged in")?.clone();
        let uid = c.user_id().ok_or("No user ID")?.to_owned();
        (c, uid)
    };

    let request = matrix_sdk::ruma::api::client::presence::set_presence::v3::Request::new(
        user_id,
        presence_state,
    );

    client
        .send(request)
        .await
        .map_err(|e| format!("Failed to set presence: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn start_idle_monitor(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let display_server = state.display_server;

    tokio::spawn(async move {
        idle::run_idle_monitor(app, display_server).await;
    });

    Ok(())
}
