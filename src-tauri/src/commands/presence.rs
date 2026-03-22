use std::sync::Arc;

use tauri::State;

use crate::{idle, AppState};

use super::get_client;

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

    let client = get_client(&state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();

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
    // Avoid AppHandle::clone from the idle loop task when emitting (Rc in Tauri/Tao).
    let app = Arc::new(app);

    tokio::spawn(async move {
        idle::run_idle_monitor(app, display_server).await;
    });

    Ok(())
}