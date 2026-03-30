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

/// Auth/registration config loaded from .env at startup.
/// Controls pre-fill and field visibility on the login/sign-up screen.
#[derive(Clone, Default, serde::Serialize)]
pub struct AuthConfig {
    /// Default homeserver URL (pre-fills the field).
    pub default_homeserver: Option<String>,
    /// Registration token (pre-fills the sign-up token field).
    pub registration_token: Option<String>,
    /// When true AND both above are set, hide homeserver + token fields entirely.
    pub hide_server_config: bool,
}

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub http_client: reqwest::Client,
    pub presence_map: Arc<Mutex<HashMap<String, String>>>,
    pub avatar_cache: Arc<Mutex<HashMap<String, String>>>,
    pub sync_running: Arc<Mutex<bool>>,
    pub display_server: DisplayServer,
    pub livekit: LivekitConfig,
    pub giphy_api_key: Option<String>,
    pub auth_config: AuthConfig,
    /// Matrix voice room id → LiveKit SFU room name (learned on connect; used for admin ListParticipants).
    pub livekit_matrix_to_sfu_room: StdMutex<HashMap<String, String>>,
    /// Stops the MSC4140 heartbeat task that restarts the delayed leave event.
    pub heartbeat_stop: Arc<AtomicBool>,
    pub heartbeat_task: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// The delay_id from the server for the current delayed leave event.
    /// Used by voice_disconnect to fire the leave immediately.
    pub delayed_leave_id: StdMutex<Option<String>>,
}

impl AppState {
    /// Stop the MSC4140 heartbeat loop.
    pub fn stop_heartbeat_loop(&self) {
        self.heartbeat_stop.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.heartbeat_task.lock() {
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

    // All env vars are baked in at compile time via build.rs → cargo:rustc-env.
    // option_env!() returns Option<&'static str>; None if the var was unset at build.
    let livekit = LivekitConfig {
        api_key: option_env!("LIVEKIT_API_KEY").map(String::from),
        api_secret: option_env!("LIVEKIT_API_SECRET").map(String::from),
        url: option_env!("LIVEKIT_URL").map(String::from),
    };
    if livekit.api_key.is_some() {
        log::info!("LiveKit admin credentials compiled in");
    } else {
        log::info!("No LiveKit admin credentials — multi-device kick disabled");
    }

    let giphy_api_key = option_env!("GIPHY_API_KEY").map(String::from);

    let default_homeserver = option_env!("PAX_HOMESERVER").map(String::from);
    let registration_token = option_env!("PAX_REGISTRATION_TOKEN").map(String::from);
    let hide_server_config = option_env!("PAX_HIDE_SERVER_CONFIG")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    let auth_config = AuthConfig {
        default_homeserver,
        registration_token,
        hide_server_config,
    };

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
        giphy_api_key,
        auth_config,
        livekit_matrix_to_sfu_room: StdMutex::new(HashMap::new()),
        heartbeat_stop: Arc::new(AtomicBool::new(true)),
        heartbeat_task: StdMutex::new(None),
        delayed_leave_id: StdMutex::new(None),
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
            commands::rooms::register,
            commands::rooms::restore_session,
            commands::rooms::get_rooms,
            commands::rooms::join_room,
            commands::rooms::get_space_info,
            commands::rooms::get_history_visibility,
            commands::rooms::set_history_visibility,
            commands::messages::get_messages,
            commands::members::get_room_members,
            commands::members::get_user_avatar,
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
            commands::voice_matrix::get_screen_share_quality,
            commands::voice_matrix::set_screen_share_quality,
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
            commands::config::get_giphy_api_key,
            commands::config::get_auth_config,
            commands::profile::get_display_name,
            commands::profile::set_display_name,
            commands::profile::set_user_avatar,
            commands::profile::remove_user_avatar,
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