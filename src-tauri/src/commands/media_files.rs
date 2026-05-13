use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::TryStreamExt;
use serde::Serialize;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::time::MissedTickBehavior;
use tokio_util::io::ReaderStream;

use matrix_sdk::media::{MediaFormat, MediaRequestParameters, UniqueKey};
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::UInt;
use matrix_sdk::Client;
use reqwest::header::{HeaderValue, CONTENT_LENGTH};
use reqwest::Version;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

use super::media_protocol::{
    get_matrix_media_bytes_with_timeout, get_plain_matrix_file_bytes_direct,
    MATRIX_IMAGE_FULL_FETCH_TIMEOUT, MATRIX_IMAGE_THUMB_FETCH_TIMEOUT,
};
use super::message_display::mime_to_file_ext;
use super::{fmt_error_chain, get_client, resolve_room, sniff_media_mime};

#[tauri::command]
pub async fn get_matrix_image_path(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: serde_json::Value,
) -> Result<String, String> {
    let params: MediaRequestParameters =
        serde_json::from_value(request).map_err(|e| format!("Invalid media request: {e}"))?;

    let cache_key = format!("mmedia:{}", params.unique_key());

    if let Some(existing) = state.avatar_cache.get(&cache_key).await {
        if existing.starts_with("data:") {
            state.avatar_cache.remove(&cache_key).await;
        } else if std::path::Path::new(&existing).is_file() {
            return Ok(existing);
        } else {
            state.avatar_cache.remove(&cache_key).await;
        }
    }

    let client = get_client(&state).await?;

    let first_timeout = match &params.format {
        MediaFormat::Thumbnail(_) => MATRIX_IMAGE_THUMB_FETCH_TIMEOUT,
        MediaFormat::File => MATRIX_IMAGE_FULL_FETCH_TIMEOUT,
    };

    let direct_plain_file = matches!(params.format, MediaFormat::File)
        && matches!(&params.source, MediaSource::Plain(_));

    let primary_fetch = if direct_plain_file {
        match get_plain_matrix_file_bytes_direct(&state, &client, &params, first_timeout).await {
            Ok(b) => Ok(b),
            Err(e) => {
                log::warn!("Direct Matrix media fetch failed; falling back to matrix-sdk: {e}");
                get_matrix_media_bytes_with_timeout(&client, &params, false, first_timeout).await
            }
        }
    } else {
        get_matrix_media_bytes_with_timeout(&client, &params, false, first_timeout).await
    };

    let bytes = match primary_fetch {
        Ok(b) => b,
        Err(e) => {
            if matches!(&params.format, MediaFormat::Thumbnail(_)) {
                let fallback = MediaRequestParameters {
                    source: params.source.clone(),
                    format: MediaFormat::File,
                };
                match get_matrix_media_bytes_with_timeout(
                    &client,
                    &fallback,
                    false,
                    MATRIX_IMAGE_FULL_FETCH_TIMEOUT,
                )
                .await
                {
                    Ok(b) => b,
                    Err(e2) => {
                        let msg = format!("Thumbnail failed: {} | Full image failed: {}", e, e2);
                        log::warn!("Matrix image: {msg}");
                        return Err(msg);
                    }
                }
            } else {
                let msg = format!("Failed to load image: {e}");
                log::warn!("Matrix image: {msg}");
                return Err(msg);
            }
        }
    };

    let mime = sniff_media_mime(&bytes);
    let ext = mime_to_file_ext(mime);

    let temp_dir = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {e}"))?;
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    let path = temp_dir.join(format!("pax_matrix_media_{}.{}", uuid::Uuid::new_v4(), ext));

    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write image temp file: {e}"))?;

    let path_str = path
        .to_str()
        .ok_or("Temp file path is not valid UTF-8")?
        .to_string();

    state.avatar_cache.insert(cache_key, path_str.clone()).await;

    Ok(path_str)
}

/// Evict cached attachment temp files and their cache entries on room
/// switch.  Attachments (images/videos/files in message bodies) can be
/// large and there's no reason to keep the previous room's attachments
/// around while the user is looking at a different room.
///
/// **Avatars are deliberately NOT cleared here.**  They are tiny, shared
/// across every view (sidebar, home space, chat header, settings,
/// voice call, …), and cheap to keep.  Wiping them on room switch
/// broke every `<img>` currently on screen — the sidebar and DM banner
/// would 404 the moment the user clicked a room, forcing a cascade of
/// re-fetches, retries, and visible "avatar → initials → avatar-at-
/// different-resolution" flashes.  Keep avatars alive for the session;
/// they get evicted naturally on logout and on startup (see `lib.rs`).
#[tauri::command]
pub async fn clear_media_cache(state: State<'_, Arc<AppState>>) -> Result<u32, String> {
    // Evict only the `mmedia:` entries — avatars (persistent on disk,
    // tiny, shared across every view) are deliberately preserved so
    // we don't cascade 404s into every on-screen `<img>` the moment
    // the user switches rooms.
    let evicted = state.avatar_cache.remove_by_prefix("mmedia:").await.len();

    let temp_dir = super::temp_dir();
    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let n = name.to_string_lossy();
            if n.starts_with("pax_matrix_media_") {
                if std::fs::remove_file(entry.path()).is_ok() {
                    deleted += 1;
                }
            }
        }
    }

    if evicted > 0 || deleted > 0 {
        log::info!(
            "[clear_media_cache] evicted {} attachment entries, deleted {} temp files (avatars preserved)",
            evicted,
            deleted,
        );
    }
    Ok(deleted)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomFileUploadProgressEvent {
    pub upload_id: String,
    pub room_id: String,
    pub sent: u64,
    pub total: u64,
}

fn build_file_room_message(
    mxc_uri: matrix_sdk::ruma::OwnedMxcUri,
    file_name: String,
    content_type: mime::Mime,
    file_size: Option<UInt>,
    caption: Option<String>,
) -> RoomMessageEventContent {
    use matrix_sdk::ruma::events::room::message::MessageType;
    use matrix_sdk::ruma::events::room::MediaSource;

    let body_text = caption
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
        .unwrap_or_else(|| file_name.clone());
    let has_caption = caption.as_deref().map_or(false, |c| !c.is_empty());

    if content_type.type_() == mime::IMAGE {
        use matrix_sdk::ruma::events::room::message::ImageMessageEventContent;
        use matrix_sdk::ruma::events::room::ImageInfo;

        let mut info = ImageInfo::new();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;

        let mut img = ImageMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
        img.info = Some(Box::new(info));
        if has_caption {
            img.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Image(img))
    } else if content_type.type_() == mime::VIDEO {
        use matrix_sdk::ruma::events::room::message::VideoMessageEventContent;

        let mut vid = VideoMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
        let mut info = vid.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        vid.info = Some(info);
        if has_caption {
            vid.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Video(vid))
    } else if content_type.type_() == mime::AUDIO {
        use matrix_sdk::ruma::events::room::message::AudioMessageEventContent;

        let mut aud = AudioMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
        let mut info = aud.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        aud.info = Some(info);
        if has_caption {
            aud.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::Audio(aud))
    } else {
        use matrix_sdk::ruma::events::room::message::FileMessageEventContent;

        let mut file_msg = FileMessageEventContent::new(body_text, MediaSource::Plain(mxc_uri));
        let mut info = file_msg.info.take().unwrap_or_default();
        info.mimetype = Some(content_type.to_string());
        info.size = file_size;
        file_msg.info = Some(info);
        if has_caption {
            file_msg.filename = Some(file_name);
        }
        RoomMessageEventContent::new(MessageType::File(file_msg))
    }
}

fn validate_upload_id(upload_id: &str) -> Result<(), String> {
    if upload_id.is_empty() || upload_id.len() > 200 {
        return Err("Invalid upload id".to_string());
    }
    if !upload_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid upload id".to_string());
    }
    Ok(())
}

fn room_file_staging_path(upload_id: &str) -> PathBuf {
    super::temp_dir().join(format!("pax_upload_staging_{upload_id}.bin"))
}

/// Truncate / create the staging file for an upload (call before chunked appends).
#[tauri::command]
pub async fn room_file_staging_reset(upload_id: String) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let path = room_file_staging_path(&upload_id);
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .await
        .map_err(|e| format!("staging reset: {e}"))?;
    f.flush().await.map_err(|e| format!("staging reset: {e}"))?;
    Ok(())
}

/// Append one base64 chunk (from the webview) to the staging file — avoids multi‑GiB IPC payloads.
#[tauri::command]
pub async fn room_file_staging_append_b64(
    upload_id: String,
    chunk_b64: String,
) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let chunk = data_encoding::BASE64
        .decode(chunk_b64.as_bytes())
        .map_err(|e| format!("chunk base64: {e}"))?;
    let path = room_file_staging_path(&upload_id);
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("staging append: {e}"))?;
    f.write_all(&chunk)
        .await
        .map_err(|e| format!("staging append: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn room_file_staging_byte_len(upload_id: String) -> Result<u64, String> {
    validate_upload_id(&upload_id)?;
    let path = room_file_staging_path(&upload_id);
    match tokio::fs::metadata(&path).await {
        Ok(m) => Ok(m.len()),
        Err(_) => Ok(0),
    }
}

#[tauri::command]
pub async fn room_file_staging_remove(upload_id: String) -> Result<(), String> {
    validate_upload_id(&upload_id)?;
    let path = room_file_staging_path(&upload_id);
    let _ = tokio::fs::remove_file(&path).await;
    Ok(())
}

fn ruma_uint_to_u64(u: UInt) -> u64 {
    i128::from(u) as u64
}

fn format_upload_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let x = n as f64;
    if x >= GB {
        format!("{:.2} GiB", x / GB)
    } else if x >= MB {
        format!("{:.2} MiB", x / MB)
    } else if x >= KB {
        format!("{:.2} KiB", x / KB)
    } else {
        format!("{n} bytes")
    }
}

async fn matrix_reported_max_upload_bytes(client: &Client) -> Option<u64> {
    match client.load_or_fetch_max_upload_size().await {
        Ok(u) => Some(ruma_uint_to_u64(u)),
        Err(e) => {
            log::warn!(
                "Could not fetch Matrix media upload limit (m.upload.size): {}",
                fmt_error_chain(&e)
            );
            None
        }
    }
}

/// Bytes for a single media upload as reported by the homeserver (`m.upload.size` from
/// `GET /_matrix/client/v1/media/config`, with legacy fallback). `None` means the client could
/// not retrieve a limit (still logged in). Uses the Matrix SDK cache after the first fetch.
#[tauri::command]
pub async fn get_matrix_max_upload_bytes(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<u64>, String> {
    let client = get_client(&state).await?;
    Ok(matrix_reported_max_upload_bytes(&client).await)
}

async fn upload_room_file_from_staging_path(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: &str,
    upload_id: &str,
    file_name: &str,
    mime_type: &str,
    staging_path: &std::path::Path,
) -> Result<(String, u64), String> {
    let client = get_client(state).await?;

    let meta = tokio::fs::metadata(staging_path)
        .await
        .map_err(|e| format!("staging metadata: {e}"))?;
    let total = meta.len();

    if total > 0 {
        if let Some(max_b) = matrix_reported_max_upload_bytes(&client).await {
            if total > max_b {
                return Err(format!(
                    "This file is {} but your homeserver only allows {} per upload (Matrix m.upload.size). \
                     Use a smaller file or ask the admin to raise the media upload limit.",
                    format_upload_bytes(total),
                    format_upload_bytes(max_b),
                ));
            }
        }
    }

    let _ = app.emit(
        "room-file-upload-progress",
        RoomFileUploadProgressEvent {
            upload_id: upload_id.to_string(),
            room_id: room_id.to_string(),
            sent: 0,
            total,
        },
    );

    let content_type: mime::Mime = mime_type.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);

    log::info!(
        "[Pax Upload] file={} mime={} size={} (stream from disk)",
        file_name,
        content_type,
        total
    );

    let homeserver = client.homeserver().to_string();
    let access_token = client.access_token().ok_or("No access token")?;

    let upload_url = format!(
        "{}/_matrix/media/v3/upload?filename={}",
        homeserver.trim_end_matches('/'),
        urlencoding::encode(file_name),
    );

    let sent_progress = Arc::new(AtomicU64::new(0));
    let stop_progress_emit = Arc::new(AtomicBool::new(false));

    let progress_task = if total > 0 {
        let app = app.clone();
        let uid = upload_id.to_string();
        let rid = room_id.to_string();
        let sent_progress = sent_progress.clone();
        let stop = stop_progress_emit.clone();
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                interval.tick().await;
                let sent = sent_progress.load(Ordering::Relaxed);
                let _ = app.emit(
                    "room-file-upload-progress",
                    RoomFileUploadProgressEvent {
                        upload_id: uid.clone(),
                        room_id: rid.clone(),
                        sent,
                        total,
                    },
                );
            }
        }))
    } else {
        None
    };

    let stream_body = if total == 0 {
        reqwest::Body::from(Vec::new())
    } else {
        let file = tokio::fs::File::open(staging_path)
            .await
            .map_err(|e| format!("staging open for upload: {e}"))?;
        let reader = BufReader::new(file);
        let sp = sent_progress.clone();
        let stream = ReaderStream::with_capacity(reader, 48 * 1024).map_ok(move |b: Bytes| {
            sp.fetch_add(b.len() as u64, Ordering::Relaxed);
            b
        });
        reqwest::Body::wrap_stream(stream)
    };

    // Assume ≥64 KiB/s effective throughput so huge files get enough wall time; cap at 24h.
    let timeout_secs = if total == 0 {
        120
    } else {
        total.saturating_div(64 * 1024).max(900).min(86_400)
    };

    let content_length = HeaderValue::from_str(&total.to_string())
        .map_err(|e| format!("Invalid Content-Length: {e}"))?;

    let upload_outcome: Result<(String, u64), String> = async {
        let resp = state
            .http_client
            .post(&upload_url)
            .version(Version::HTTP_11)
            .timeout(Duration::from_secs(timeout_secs))
            .bearer_auth(access_token.to_string())
            .header("Content-Type", content_type.to_string())
            .header(CONTENT_LENGTH, content_length)
            .body(stream_body)
            .send()
            .await
            .map_err(|e| format!("Failed to upload file: {}", fmt_error_chain(&e)))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Upload failed ({}): {}", status, body));
        }

        #[derive(serde::Deserialize)]
        struct UploadResponse {
            content_uri: String,
        }

        let upload_result: UploadResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse upload response: {e}"))?;

        log::info!("[Pax Upload] uploaded → {}", upload_result.content_uri);

        Ok((upload_result.content_uri, total))
    }
    .await;

    stop_progress_emit.store(true, Ordering::Release);
    if let Some(t) = progress_task {
        let _ = t.await;
    }

    if upload_outcome.is_ok() && total > 0 {
        let _ = app.emit(
            "room-file-upload-progress",
            RoomFileUploadProgressEvent {
                upload_id: upload_id.to_string(),
                room_id: room_id.to_string(),
                sent: total,
                total,
            },
        );
    }

    upload_outcome
}

async fn upload_room_file_staged_impl(
    app: &AppHandle,
    state: &Arc<AppState>,
    room_id: &str,
    upload_id: &str,
    file_name: &str,
    mime_type: &str,
) -> Result<(String, u64), String> {
    validate_upload_id(upload_id)?;
    let path = room_file_staging_path(upload_id);
    if !path.exists() {
        return Err("Upload staging file missing (finish copying first)".to_string());
    }
    let r = upload_room_file_from_staging_path(
        app, state, room_id, upload_id, file_name, mime_type, &path,
    )
    .await;
    let _ = tokio::fs::remove_file(&path).await;
    r
}

async fn send_file_message_impl(
    state: &Arc<AppState>,
    room_id: &str,
    content_uri: &str,
    file_name: &str,
    mime_type: &str,
    file_size_bytes: Option<u64>,
    caption: Option<&str>,
) -> Result<String, String> {
    let client = get_client(state).await?;
    let room = resolve_room(&client, room_id)?;

    let mxc_uri = matrix_sdk::ruma::OwnedMxcUri::from(content_uri);

    let content_type: mime::Mime = mime_type.parse().unwrap_or(mime::APPLICATION_OCTET_STREAM);

    let file_size = file_size_bytes.and_then(|n| UInt::try_from(n).ok());

    let content = build_file_room_message(
        mxc_uri,
        file_name.to_string(),
        content_type,
        file_size,
        caption.map(|s| s.to_string()),
    );

    let response = room
        .send(content)
        .await
        .map_err(|e| format!("Failed to send file message: {}", fmt_error_chain(&e)))?;

    Ok(response.event_id.to_string())
}

/// Upload only (emits `room-file-upload-progress`). Reads bytes from the on-disk staging file
/// built with `room_file_staging_reset` + `room_file_staging_append_b64`. Returns `(content_uri, byte_size)`.
#[tauri::command]
pub async fn upload_room_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    room_id: String,
    upload_id: String,
    file_name: String,
    mime_type: String,
) -> Result<(String, u64), String> {
    upload_room_file_staged_impl(&app, &state, &room_id, &upload_id, &file_name, &mime_type).await
}

/// Send a previously uploaded MXC as an `m.room.message`. Returns the event id.
#[tauri::command]
pub async fn send_file_message(
    state: State<'_, Arc<AppState>>,
    room_id: String,
    content_uri: String,
    file_name: String,
    mime_type: String,
    file_size: Option<u64>,
    caption: Option<String>,
) -> Result<String, String> {
    send_file_message_impl(
        &state,
        &room_id,
        &content_uri,
        &file_name,
        &mime_type,
        file_size,
        caption.as_deref(),
    )
    .await
}

/// Upload a file to the Matrix media repo and send it as an `m.room.message`.
///
/// `data` is full base64 (legacy / small payloads). Decodes to a staging file on disk, then
/// streams to Matrix — avoids holding the decoded file in RAM. Prefer chunked staging from the UI for large files.
#[tauri::command]
pub async fn upload_and_send_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    room_id: String,
    file_name: String,
    mime_type: String,
    data: String,
    caption: Option<String>,
) -> Result<(), String> {
    let upload_id = uuid::Uuid::new_v4().to_string();
    validate_upload_id(&upload_id)?;

    let uid = upload_id.clone();
    tokio::task::spawn_blocking(move || {
        let mut decoder = base64::read::DecoderReader::new(
            std::io::Cursor::new(data.as_bytes()),
            &base64::engine::general_purpose::STANDARD,
        );
        let path = room_file_staging_path(&uid);
        let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        std::io::copy(&mut decoder, &mut out).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("staging join: {e}"))??;

    let (content_uri, byte_size) =
        upload_room_file_staged_impl(&app, &state, &room_id, &upload_id, &file_name, &mime_type)
            .await?;

    let _ = send_file_message_impl(
        &state,
        &room_id,
        &content_uri,
        &file_name,
        &mime_type,
        Some(byte_size),
        caption.as_deref(),
    )
    .await?;

    Ok(())
}
