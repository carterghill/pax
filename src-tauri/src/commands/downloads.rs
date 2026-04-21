//! Save Matrix media and remote URLs into the user Downloads folder with progress events.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDownloadProgressEvent {
    pub job_id: String,
    pub room_id: String,
    pub file_name: String,
    pub status: String,
    pub bytes_received: u64,
    pub total_bytes: Option<u64>,
    pub saved_path: Option<String>,
    pub error: Option<String>,
}

fn sanitize_file_name(name: &str) -> String {
    let name = name.trim();
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'..='\x1f'
            )
        })
        .take(200)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "download".to_string()
    } else {
        cleaned.to_string()
    }
}

fn unique_path_in_dir(dir: &Path, file_name: &str) -> PathBuf {
    let path = dir.join(file_name);
    if !path.exists() {
        return path;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for i in 1..10_000u32 {
        let candidate = dir.join(format!("{} ({}){}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}_{}", stem, uuid::Uuid::new_v4()))
}

fn source_is_under_app_temp(source: &Path) -> bool {
    let temp = crate::commands::temp_dir();
    let Ok(temp_canon) = std::fs::canonicalize(&temp) else {
        return false;
    };
    let Ok(src_canon) = std::fs::canonicalize(source) else {
        return false;
    };
    src_canon.starts_with(&temp_canon)
}

fn emit_progress(app: &AppHandle, ev: RoomDownloadProgressEvent) {
    let _ = app.emit("room-download-progress", ev);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRoomDownloadArgs {
    pub job_id: String,
    pub room_id: String,
    pub file_name: String,
    pub source_kind: String,
    pub source_path: Option<String>,
    pub url: Option<String>,
}

/// Starts a background download/copy into the OS Downloads folder. Progress is emitted on
/// `room-download-progress` (see [`RoomDownloadProgressEvent`]).
#[tauri::command]
pub async fn start_room_download(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    args: StartRoomDownloadArgs,
) -> Result<(), String> {
    let safe_name = sanitize_file_name(&args.file_name);
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("Could not resolve Downloads folder: {e}"))?;
    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    match args.source_kind.as_str() {
        "copy" => {
            let path = args
                .source_path
                .ok_or_else(|| "sourcePath is required for copy".to_string())?;
            let source = PathBuf::from(path.trim());
            let source_canon = source
                .canonicalize()
                .map_err(|e| format!("Invalid source path: {e}"))?;
            if !source_is_under_app_temp(&source_canon) {
                return Err(
                    "Refusing to copy files from outside the application temp directory"
                        .to_string(),
                );
            }
            if !source_canon.is_file() {
                return Err("Source path is not a file".to_string());
            }

            let app2 = app.clone();
            let job_id = args.job_id.clone();
            let room_id = args.room_id.clone();
            let fn_label = safe_name.clone();
            let dest = unique_path_in_dir(&downloads, &safe_name);
            let dest_for_complete = dest.clone();

            tauri::async_runtime::spawn(async move {
                emit_progress(
                    &app2,
                    RoomDownloadProgressEvent {
                        job_id: job_id.clone(),
                        room_id: room_id.clone(),
                        file_name: fn_label.clone(),
                        status: "running".into(),
                        bytes_received: 0,
                        total_bytes: None,
                        saved_path: None,
                        error: None,
                    },
                );
                match tokio::task::spawn_blocking(move || std::fs::copy(&source_canon, &dest))
                    .await
                {
                    Ok(Ok(n)) => {
                        emit_progress(
                            &app2,
                            RoomDownloadProgressEvent {
                                job_id,
                                room_id,
                                file_name: fn_label,
                                status: "complete".into(),
                                bytes_received: n,
                                total_bytes: Some(n),
                                saved_path: Some(dest_for_complete.to_string_lossy().into_owned()),
                                error: None,
                            },
                        );
                    }
                    Ok(Err(e)) => {
                        emit_progress(
                            &app2,
                            RoomDownloadProgressEvent {
                                job_id,
                                room_id,
                                file_name: fn_label,
                                status: "error".into(),
                                bytes_received: 0,
                                total_bytes: None,
                                saved_path: None,
                                error: Some(e.to_string()),
                            },
                        );
                    }
                    Err(e) => {
                        emit_progress(
                            &app2,
                            RoomDownloadProgressEvent {
                                job_id,
                                room_id,
                                file_name: fn_label,
                                status: "error".into(),
                                bytes_received: 0,
                                total_bytes: None,
                                saved_path: None,
                                error: Some(format!("copy task failed: {e}")),
                            },
                        );
                    }
                }
            });
            Ok(())
        }
        "http" => {
            let url_str = args
                .url
                .ok_or_else(|| "url is required for http".to_string())?;
            let parsed = reqwest::Url::parse(url_str.trim())
                .map_err(|e| format!("Invalid URL: {e}"))?;
            let scheme = parsed.scheme();
            if scheme != "https" && scheme != "http" {
                return Err("Only http(s) URLs are allowed".to_string());
            }

            let client = state.http_client.clone();
            let app2 = app.clone();
            let job_id = args.job_id.clone();
            let room_id = args.room_id.clone();
            let dest = unique_path_in_dir(&downloads, &safe_name);

            tauri::async_runtime::spawn(async move {
                emit_progress(
                    &app2,
                    RoomDownloadProgressEvent {
                        job_id: job_id.clone(),
                        room_id: room_id.clone(),
                        file_name: safe_name.clone(),
                        status: "running".into(),
                        bytes_received: 0,
                        total_bytes: None,
                        saved_path: None,
                        error: None,
                    },
                );

                let response = match client.get(url_str).send().await {
                    Ok(r) => r,
                    Err(e) => {
                        emit_progress(
                            &app2,
                            RoomDownloadProgressEvent {
                                job_id,
                                room_id,
                                file_name: safe_name,
                                status: "error".into(),
                                bytes_received: 0,
                                total_bytes: None,
                                saved_path: None,
                                error: Some(e.to_string()),
                            },
                        );
                        return;
                    }
                };

                if !response.status().is_success() {
                    emit_progress(
                        &app2,
                        RoomDownloadProgressEvent {
                            job_id,
                            room_id,
                            file_name: safe_name,
                            status: "error".into(),
                            bytes_received: 0,
                            total_bytes: None,
                            saved_path: None,
                            error: Some(format!("HTTP {}", response.status())),
                        },
                    );
                    return;
                }

                let total_bytes = response.content_length();
                let mut stream = response.bytes_stream();
                let mut file = match tokio::fs::File::create(&dest).await {
                    Ok(f) => f,
                    Err(e) => {
                        emit_progress(
                            &app2,
                            RoomDownloadProgressEvent {
                                job_id,
                                room_id,
                                file_name: safe_name,
                                status: "error".into(),
                                bytes_received: 0,
                                total_bytes: None,
                                saved_path: None,
                                error: Some(e.to_string()),
                            },
                        );
                        return;
                    }
                };

                let mut received: u64 = 0;
                let mut last_emit = Instant::now();
                let mut failed: Option<String> = None;

                while let Some(item) = stream.next().await {
                    match item {
                        Ok(chunk) => {
                            if let Err(e) = file.write_all(&chunk).await {
                                failed = Some(e.to_string());
                                break;
                            }
                            received += chunk.len() as u64;
                            let should_emit = last_emit.elapsed().as_millis() >= 200
                                || total_bytes.map(|t| received >= t).unwrap_or(false);
                            if should_emit {
                                last_emit = Instant::now();
                                emit_progress(
                                    &app2,
                                    RoomDownloadProgressEvent {
                                        job_id: job_id.clone(),
                                        room_id: room_id.clone(),
                                        file_name: safe_name.clone(),
                                        status: "running".into(),
                                        bytes_received: received,
                                        total_bytes,
                                        saved_path: None,
                                        error: None,
                                    },
                                );
                            }
                        }
                        Err(e) => {
                            failed = Some(e.to_string());
                            break;
                        }
                    }
                }

                if let Some(err) = failed {
                    let _ = tokio::fs::remove_file(&dest).await;
                    emit_progress(
                        &app2,
                        RoomDownloadProgressEvent {
                            job_id,
                            room_id,
                            file_name: safe_name,
                            status: "error".into(),
                            bytes_received: received,
                            total_bytes,
                            saved_path: None,
                            error: Some(err),
                        },
                    );
                    return;
                }

                if let Err(e) = file.flush().await {
                    let _ = tokio::fs::remove_file(&dest).await;
                    emit_progress(
                        &app2,
                        RoomDownloadProgressEvent {
                            job_id,
                            room_id,
                            file_name: safe_name,
                            status: "error".into(),
                            bytes_received: received,
                            total_bytes,
                            saved_path: None,
                            error: Some(e.to_string()),
                        },
                    );
                    return;
                }

                emit_progress(
                    &app2,
                    RoomDownloadProgressEvent {
                        job_id,
                        room_id,
                        file_name: safe_name,
                        status: "complete".into(),
                        bytes_received: received,
                        total_bytes: Some(received),
                        saved_path: Some(dest.to_string_lossy().into_owned()),
                        error: None,
                    },
                );
            });
            Ok(())
        }
        other => Err(format!("Unknown source kind: {other}")),
    }
}

/// Open a file manager and **select** `file_path` when the OS supports it (`SHOpenFolderAndSelectItems`
/// on Windows, `NSWorkspace` on macOS, `FileManager1.ShowItems` / XDG portal on Linux), then fall back
/// to opening only the parent folder (`xdg-open` etc.) if reveal is unavailable.
#[tauri::command]
pub fn open_containing_folder(app: AppHandle, file_path: String) -> Result<(), String> {
    use std::path::Path;
    use tauri_plugin_opener::OpenerExt;

    let path = Path::new(file_path.trim());
    if !path.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    std::fs::metadata(path).map_err(|e| format!("File not accessible: {e}"))?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Could not resolve parent directory".to_string())?;

    if app.opener().reveal_item_in_dir(path).is_ok() {
        return Ok(());
    }
    app
        .opener()
        .open_path(parent.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
