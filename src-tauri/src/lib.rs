use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;
use matrix_sdk::{Client, config::SyncSettings, media::MediaFormat, ruma::serde::base64};
use serde::Serialize;
use data_encoding::BASE64;

pub struct AppState {
    pub client: Mutex<Option<Client>>,
}

#[derive(Serialize)]
struct RoomInfo {
    id: String,
    name: String,
    avatar_url: Option<String>,
    is_space: bool,
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

    client
        .sync_once(SyncSettings::default())
        .await
        .map_err(|e| format!("Initial sync failed: {e}"))?;

    let user_id = client
        .user_id()
        .ok_or("No user ID after login")?
        .to_string();

    *state.client.lock().await = Some(client);
    Ok(user_id)
}

#[tauri::command]
async fn get_rooms(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RoomInfo>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("Not logged in")?;

    let mut room_list = Vec::new();

    for room in client.joined_rooms() {
        let avatar_url = match room.avatar(MediaFormat::File).await {
            Ok(Some(bytes)) => {
                let b64 = BASE64.encode(&bytes);
                Some(format!("data:image/png;base64,{}", b64))
            }
            _ => None,
        };

        room_list.push(RoomInfo {
            id: room.room_id().to_string(),
            name: room.name().unwrap_or_else(|| "Unnamed".to_string()),
            avatar_url,
            is_space: room.is_space(),
        });
    }

    Ok(room_list)
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