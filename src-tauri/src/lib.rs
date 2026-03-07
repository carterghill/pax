use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use matrix_sdk::{Client, config::SyncSettings};

// We wrap the client in Arc<Mutex<>> so it can be shared across commands
pub struct AppState {
    pub client: Mutex<Option<Client>>,
}

#[tauri::command]
async fn login(
    state: State<'_, Arc<AppState>>,
    homeserver: String,
    username: String,
    password: String,
) -> Result<String, String> {
    let client = Client::builder()
        .homeserver_url(&homeserver)
        .build()
        .await
        .map_err(|e| format!("Failed to create client: {e}"))?;

    client
        .matrix_auth()
        .login_username(&username, &password)
        .initial_device_display_name("Pax")
        .send()
        .await
        .map_err(|e| format!("Login failed: {e}"))?;

    let user_id = client
        .user_id()
        .ok_or("No user ID after login")?
        .to_string();

    // Store the client for later use
    *state.client.lock().await = Some(client);

    Ok(user_id)
}

#[tauri::command]
async fn get_rooms(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<serde_json::Value>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    // Do an initial sync so we actually have room data
    client
        .sync_once(SyncSettings::default())
        .await
        .map_err(|e| format!("Sync failed: {e}"))?;

    let rooms: Vec<serde_json::Value> = client
        .joined_rooms()
        .iter()
        .map(|room| {
            serde_json::json!({
                "id": room.room_id().to_string(),
                "name": room.name().unwrap_or_else(|| "Unnamed".to_string()),
            })
        })
        .collect();

    Ok(rooms)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        client: Mutex::new(None),
    });

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![login, get_rooms])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}