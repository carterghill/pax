use std::sync::Arc;

use tauri::State;

use crate::AppState;

use super::{encode_avatar_data_url, fmt_error_chain, get_client};

/// Return the logged-in user's display name (from the account profile, not a
/// per-room override).
#[tauri::command]
pub async fn get_display_name(state: State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let client = get_client(&state).await?;
    let name = client
        .account()
        .get_display_name()
        .await
        .map_err(|e| format!("Failed to get display name: {}", fmt_error_chain(&e)))?;
    Ok(name)
}

/// Update the logged-in user's global display name.
#[tauri::command]
pub async fn set_display_name(state: State<'_, Arc<AppState>>, name: String) -> Result<(), String> {
    let client = get_client(&state).await?;
    client
        .account()
        .set_display_name(Some(&name))
        .await
        .map_err(|e| format!("Failed to set display name: {}", fmt_error_chain(&e)))?;
    Ok(())
}

/// Upload a new avatar image. The frontend sends the raw file bytes as a
/// base64-encoded string plus the MIME type (e.g. "image/png").
#[tauri::command]
pub async fn set_user_avatar(
    state: State<'_, Arc<AppState>>,
    data: String,
    mime: String,
) -> Result<String, String> {
    let client = get_client(&state).await?;
    let bytes = data_encoding::BASE64
        .decode(data.as_bytes())
        .map_err(|e| format!("Invalid base64: {e}"))?;

    let content_type = mime
        .parse::<mime::Mime>()
        .map_err(|e| format!("Invalid MIME type: {e}"))?;

    client
        .account()
        .upload_avatar(&content_type, bytes.clone())
        .await
        .map_err(|e| format!("Failed to upload avatar: {}", fmt_error_chain(&e)))?;

    // Invalidate the cached avatar so the UI picks up the new one
    state.avatar_cache.lock().await.clear();

    // Return a data URL so the frontend can display it immediately
    Ok(encode_avatar_data_url(&bytes))
}

/// Remove the logged-in user's avatar entirely.
#[tauri::command]
pub async fn remove_user_avatar(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let client = get_client(&state).await?;
    let user_id = client.user_id().ok_or("No user ID")?.to_owned();

    // matrix-sdk 0.16 has no `remove_avatar()` — send the profile request
    // with avatar_url = None to clear it.
    #[allow(deprecated)]
    let request =
        matrix_sdk::ruma::api::client::profile::set_avatar_url::v3::Request::new(user_id, None);

    client
        .send(request)
        .await
        .map_err(|e| format!("Failed to remove avatar: {}", fmt_error_chain(&e)))?;

    state.avatar_cache.lock().await.clear();
    Ok(())
}
