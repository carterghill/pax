#![recursion_limit = "256"]

pub mod platform;
pub mod codec;
mod commands;
mod idle;
pub mod native_overlay;
mod screen;
mod types;
pub mod video_recv;
mod voice;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use matrix_sdk::Client;
use tokio::sync::Mutex;
use tauri::Manager;

use platform::DisplayServer;

/// LiveKit server admin credentials for kicking stale participants.
/// Loaded from .env at startup; all fields optional so the app still
/// works (without kick capability) if the .env is missing.
#[derive(Clone, Default)]
pub struct LivekitConfig {
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    pub url: Option<String>,
}

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub http_client: reqwest::Client,
    pub presence_map: Arc<Mutex<HashMap<String, String>>>,
    pub avatar_cache: Arc<Mutex<HashMap<String, String>>>,
    pub sync_running: Arc<Mutex<bool>>,
    pub display_server: DisplayServer,
    pub livekit: LivekitConfig,
    /// Matrix voice room id → LiveKit SFU room name (learned on connect; used for admin ListParticipants).
    pub livekit_matrix_to_sfu_room: StdMutex<HashMap<String, String>>,
    /// Stops the periodic `m.call.member` refresh task (see `voice_matrix`).
    pub call_member_refresh_stop: Arc<AtomicBool>,
    pub call_member_refresh_task: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl AppState {
    /// Abort the background task that re-sends `m.call.member` to extend `expires`.
    pub fn stop_call_member_refresh_loop(&self) {
        self.call_member_refresh_stop.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.call_member_refresh_task.lock() {
            if let Some(h) = guard.take() {
                h.abort();
            }
        }
    }
}

/// Ensure the system CA certificate store is used for TLS on Linux.
/// When launched from a desktop environment, SSL_CERT_FILE may be unset and rustls
/// can fail to find certs. Setting it to the system bundle fixes connection errors.
#[cfg(target_os = "linux")]
fn ensure_system_certs() {
    if std::env::var("SSL_CERT_FILE").is_ok() || std::env::var("SSL_CERT_DIR").is_ok() {
        return;
    }
    for path in [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/ssl/certs/ca-bundle.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/ca-bundle.pem",
    ] {
        if std::path::Path::new(path).exists() {
            std::env::set_var("SSL_CERT_FILE", path);
            break;
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_system_certs() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_system_certs();
    let display_server = platform::detect_display_server();

    // Load .env (silently ignored if missing — e.g. production builds)
    dotenvy::dotenv().ok();
    let livekit = LivekitConfig {
        api_key: std::env::var("LIVEKIT_API_KEY").ok().filter(|s| !s.is_empty()),
        api_secret: std::env::var("LIVEKIT_API_SECRET").ok().filter(|s| !s.is_empty()),
        url: std::env::var("LIVEKIT_URL").ok().filter(|s| !s.is_empty()),
    };
    if livekit.api_key.is_some() {
        log::info!("LiveKit admin credentials loaded from .env");
    } else {
        log::info!("No LiveKit admin credentials — multi-device kick disabled");
    }

    // Detect best video codec based on GPU before any screen share publishes
    detect_codec_early();

    let state = Arc::new(AppState {
        client: Mutex::new(None),
        http_client: reqwest::Client::new(),
        presence_map: Arc::new(Mutex::new(HashMap::new())),
        avatar_cache: Arc::new(Mutex::new(HashMap::new())),
        sync_running: Arc::new(Mutex::new(false)),
        display_server,
        livekit,
        livekit_matrix_to_sfu_room: StdMutex::new(HashMap::new()),
        call_member_refresh_stop: Arc::new(AtomicBool::new(true)),
        call_member_refresh_task: StdMutex::new(None),
    });

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stderr,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Webview,
                ))
                .build(),
        )
        .manage(state)
        .manage(voice::VoiceManager::new())
        .register_uri_scheme_protocol("paxvideo", |_app, request| {
            video_recv::handle_protocol_request(request)
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth::logout,
            commands::auth::save_credentials,
            commands::auth::load_credentials,
            commands::auth::clear_saved_credentials,
            commands::rooms::login,
            commands::rooms::restore_session,
            commands::rooms::get_rooms,
            commands::messages::get_messages,
            commands::members::get_room_members,
            commands::voice_matrix::get_voice_participants,
            commands::voice_matrix::get_all_voice_participants,
            commands::voice_matrix::get_livekit_voice_room_snapshot,
            commands::voice_matrix::get_all_livekit_voice_snapshots,
            commands::voice_matrix::voice_connect,
            commands::voice_matrix::voice_disconnect,
            commands::voice_matrix::voice_toggle_mic,
            commands::voice_matrix::voice_toggle_deafen,
            commands::voice_matrix::voice_toggle_noise_suppression,
            commands::voice_matrix::voice_start_screen_share,
            commands::voice_matrix::voice_stop_screen_share,
            commands::voice_matrix::enumerate_screen_share_windows,
            commands::voice_matrix::get_screen_share_preset,
            commands::voice_matrix::set_screen_share_preset,
            commands::voice_matrix::get_noise_suppression_config,
            commands::voice_matrix::set_noise_suppression_config,
            commands::voice_matrix::voice_set_participant_volume,
            commands::messages::send_message,
            commands::messages::edit_message,
            commands::messages::redact_message,
            commands::messages::get_room_redaction_policy,
            commands::messages::start_sync,
            commands::messages::send_typing_notice,
            commands::presence::set_presence,
            commands::presence::start_idle_monitor,
            commands::overlay::overlay_is_supported,
            commands::overlay::overlay_set_rect,
            commands::overlay::overlay_set_letterbox_color,
            commands::overlay::overlay_set_visible,
            commands::overlay::overlay_set_obstructions,
            commands::overlay::overlay_get_hover_states,
            commands::codec::get_codec_preference,
            commands::codec::set_codec_preference,
            commands::codec::get_resolved_codec,
        ])
        .setup(|app| {
            // Set window icon (taskbar + title bar) from our bundled icons
            let main_window = app.get_webview_window("main").expect("main window not found");
            let icon = tauri::include_image!("icons/32x32.png");
            let _ = main_window.set_icon(icon);

            // On Linux (WebKitGTK), auto-grant microphone/camera permission requests
            // so getUserMedia() works for voice calls.
            #[cfg(target_os = "linux")]
            {
                main_window.with_webview(|webview| {
                    use webkit2gtk::WebViewExt;
                    use webkit2gtk::PermissionRequestExt;
                    use webkit2gtk::SettingsExt;
                    let wv = webview.inner();

                    // Enable WebRTC and media stream in WebKitGTK settings
                    // (disabled by default since WebKitGTK 2.38)
                    if let Some(settings) = wv.settings() {
                        settings.set_enable_webrtc(true);
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webaudio(true);
                    }

                    // Auto-grant microphone/camera permission requests
                    wv.connect_permission_request(|_wv, request| {
                        request.allow();
                        true
                    });
                }).expect("Failed to configure webview permissions");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Detect the best video codec by probing the GPU adapter at startup.
/// Runs synchronously (blocking) because it's called once during init.
fn detect_codec_early() {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN,
        ..Default::default()
    });
    // Synchronous adapter request (no surface needed for detection)
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }));
    if let Ok(adapter) = adapter {
        codec::detect_best_codec(&adapter.get_info().name);
    } else {
        log::warn!("GPU adapter probe failed — defaulting to H264");
    }
}