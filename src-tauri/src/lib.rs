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
use std::sync::Arc;

use matrix_sdk::Client;
use tokio::sync::Mutex;
use tauri::Manager;

use platform::DisplayServer;

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub http_client: reqwest::Client,
    pub presence_map: Arc<Mutex<HashMap<String, String>>>,
    pub avatar_cache: Arc<Mutex<HashMap<String, String>>>,
    pub sync_running: Arc<Mutex<bool>>,
    pub display_server: DisplayServer,
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

    // Detect best video codec based on GPU before any screen share publishes
    detect_codec_early();

    let state = Arc::new(AppState {
        client: Mutex::new(None),
        http_client: reqwest::Client::new(),
        presence_map: Arc::new(Mutex::new(HashMap::new())),
        avatar_cache: Arc::new(Mutex::new(HashMap::new())),
        sync_running: Arc::new(Mutex::new(false)),
        display_server,
    });

    tauri::Builder::default()
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
            commands::messages::start_sync,
            commands::messages::send_typing_notice,
            commands::presence::set_presence,
            commands::presence::start_idle_monitor,
            commands::overlay::overlay_is_supported,
            commands::overlay::overlay_set_rect,
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
        eprintln!("[Pax] GPU adapter probe failed — defaulting to H264");
    }
}