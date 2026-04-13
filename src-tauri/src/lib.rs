#![recursion_limit = "256"]

pub mod codec;
mod commands;
mod idle;
pub mod native_overlay;
pub mod platform;
mod screen;
mod types;
pub mod video_recv;
mod voice;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use matrix_sdk::Client;
use tauri::Manager;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

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
    pub status_msg_map: Arc<Mutex<HashMap<String, String>>>,
    pub avatar_cache: Arc<Mutex<HashMap<String, String>>>,
    pub sync_running: Arc<Mutex<bool>>,
    /// Background `sync_with_callback` task — must be aborted before deleting the SQLite store
    /// or replacing `client`, otherwise the DB stays locked (especially on Windows).
    pub sync_join: Mutex<Option<JoinHandle<()>>>,
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
    /// Set false when the homeserver rejects MSC4140 delayed leave (e.g. M_MAX_DELAY_UNSUPPORTED).
    /// Reset to true at each `voice_connect` so a new server/session is re-probed.
    pub msc4140_supported: AtomicBool,
    /// Validated LiveKit JWT (`/sfu/get`) base URL for the active voice session.
    /// Used for `m.call.member` refresh so we do not re-read a stale URL from room state.
    pub voice_livekit_jwt_service_url: StdMutex<Option<String>>,
    /// The presence state the user wants (e.g. "online", "unavailable", "offline").
    /// Read by the sync loop so it can set `set_presence` on each `/sync` request:
    /// when "online", the sync itself tells Synapse the user is active (matching
    /// Cinny/Element behaviour); otherwise explicit PUTs handle it.
    pub desired_presence: Arc<StdMutex<String>>,
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

    /// Abort the Matrix sync loop and wait for the task to finish so `Client` / SQLite handles are dropped.
    pub async fn stop_sync_task(&self) {
        let handle = self.sync_join.lock().await.take();
        if let Some(h) = handle {
            h.abort();
            let _ = h.await;
        }
        *self.sync_running.lock().await = false;
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

fn panic_payload_string(payload: &dyn std::any::Any) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

/// Logs panics via `log::error!` (so `pax.log` and stderr targets get them) and always
/// writes to stderr. Hook is installed before most of `run()` so late panics are captured;
/// panics before the log plugin initializes still appear on stderr if a console exists.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = panic_payload_string(info.payload());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let thread = std::thread::current()
            .name()
            .map(String::from)
            .unwrap_or_else(|| format!("{:?}", std::thread::current().id()));
        let backtrace = std::backtrace::Backtrace::capture();
        let msg = format!(
            "PANIC: thread `{thread}` panicked at {location}: {payload}\nbacktrace capture:\n{backtrace}"
        );
        eprintln!("{msg}");
        let _ = std::io::stderr().flush();
        log::error!("{msg}");
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_system_certs();
    install_panic_hook();
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
        status_msg_map: Arc::new(Mutex::new(HashMap::new())),
        avatar_cache: Arc::new(Mutex::new(HashMap::new())),
        sync_running: Arc::new(Mutex::new(false)),
        sync_join: Mutex::new(None),
        display_server,
        livekit,
        giphy_api_key,
        auth_config,
        livekit_matrix_to_sfu_room: StdMutex::new(HashMap::new()),
        heartbeat_stop: Arc::new(AtomicBool::new(true)),
        heartbeat_task: StdMutex::new(None),
        delayed_leave_id: StdMutex::new(None),
        msc4140_supported: AtomicBool::new(true),
        voice_livekit_jwt_service_url: StdMutex::new(None),
        desired_presence: Arc::new(StdMutex::new("online".to_string())),
    });

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // So support bundles match local console timestamps.
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stderr,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Webview,
                ))
                // Release builds: users have no terminal — persist logs for sharing.
                // Windows: %LOCALAPPDATA%\com.carter.pax\logs\pax.log
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("pax.log".to_string()),
                    },
                ))
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
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
            commands::rooms::current_homeserver,
            commands::rooms::join_room,
            commands::rooms::leave_room,
            commands::rooms::knock_room,
            commands::rooms::get_space_info,
            commands::rooms::get_space_settings,
            commands::rooms::apply_space_settings,
            commands::rooms::get_history_visibility,
            commands::rooms::set_history_visibility,
            commands::rooms::get_room_general_settings,
            commands::rooms::apply_room_general_settings,
            commands::rooms::can_create_rooms,
            commands::rooms::create_space,
            commands::rooms::create_sub_space,
            commands::rooms::can_manage_space_children,
            commands::rooms::create_room_in_space,
            commands::rooms::create_standalone_room,
            commands::rooms::link_room_to_space,
            commands::rooms::search_public_spaces,
            commands::rooms::search_public_rooms,
            commands::rooms::resolve_room_alias,
            commands::messages::get_messages,
            commands::messages::get_matrix_image_path,
            commands::members::get_room_members,
            commands::members::get_room_management_members,
            commands::members::get_room_member_profile,
            commands::members::get_matrix_user_profile,
            commands::members::get_user_avatar,
            commands::members::get_knock_members,
            commands::members::preview_leave_space,
            commands::members::invite_user,
            commands::members::search_user_directory,
            commands::members::get_invite_suggestions,
            commands::members::kick_user,
            commands::members::ban_user,
            commands::members::unban_user,
            commands::members::unban_user_from_space_tree,
            commands::members::get_member_moderation_permissions,
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
            commands::voice_matrix::get_low_bandwidth_mode,
            commands::voice_matrix::set_low_bandwidth_mode,
            commands::voice_matrix::get_noise_suppression_config,
            commands::voice_matrix::set_noise_suppression_config,
            commands::voice_matrix::voice_set_participant_volume,
            commands::voice_matrix::voice_list_audio_devices,
            commands::messages::send_message,
            commands::messages::send_first_direct_message,
            commands::messages::edit_message,
            commands::messages::redact_message,
            commands::messages::get_room_redaction_policy,
            commands::messages::start_sync,
            commands::messages::send_typing_notice,
            commands::messages::upload_and_send_file,
            commands::presence::set_presence,
            commands::presence::sync_presence,
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
            commands::embed::fetch_url_metadata,
            commands::embed::proxy_media,
            commands::embed::cleanup_proxy_media,
            commands::embed::cleanup_all_proxy_media,
        ])
        .setup(|app| {
            // Set window icon (taskbar + title bar) from our bundled icons
            let main_window = app
                .get_webview_window("main")
                .expect("main window not found");
            let icon = tauri::include_image!("icons/32x32.png");
            let _ = main_window.set_icon(icon);

            // Clean up leftover proxy media temp files from previous sessions.
            {
                let temp_dir = app.path().temp_dir().ok();
                if let Some(temp_dir) = temp_dir {
                    if temp_dir.exists() {
                        let mut count = 0u32;
                        if let Ok(entries) = std::fs::read_dir(&temp_dir) {
                            for entry in entries.flatten() {
                                let name = entry.file_name();
                                let name_str = name.to_string_lossy();
                                let is_proxy_video = name_str.starts_with("pax_media_")
                                    && name_str.ends_with(".mp4");
                                let is_matrix_img = name_str.starts_with("pax_matrix_img_");
                                if is_proxy_video || is_matrix_img {
                                    if std::fs::remove_file(entry.path()).is_ok() {
                                        count += 1;
                                    }
                                }
                            }
                        }
                        if count > 0 {
                            log::info!("[Pax Media] Startup cleanup: removed {count} temp files");
                        }
                    }
                }
            }

            // On Linux (WebKitGTK), auto-grant microphone/camera permission requests
            // so getUserMedia() works for voice calls.
            #[cfg(target_os = "linux")]
            {
                main_window
                    .with_webview(|webview| {
                        use webkit2gtk::PermissionRequestExt;
                        use webkit2gtk::SettingsExt;
                        use webkit2gtk::WebViewExt;
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
                    })
                    .expect("Failed to configure webview permissions");
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
        log::warn!("GPU adapter probe failed — defaulting to VP9 (safe software fallback)");
    }
}