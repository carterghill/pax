#![recursion_limit = "256"]

pub mod codec;
mod avatars;
mod attachments;
mod app_badge;
mod call_notifications;
mod file_cache;
mod commands;
mod crypto_store;
mod idle;
pub mod native_overlay;
pub mod platform;
mod room_relationships;
mod screen;
mod setup;
mod types;
pub mod video_recv;
mod voice;
mod voice_presence;
mod voice_service;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use matrix_sdk::Client;
use tauri::Emitter;
use tauri::Manager;
#[cfg(desktop)]
use tauri::WindowEvent;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use platform::DisplayServer;

/// Auth/registration config loaded from .env at startup.
/// Controls pre-fill and field visibility on the login/sign-up screen.
#[derive(Clone, Default, serde::Serialize)]
pub struct AuthConfig {
    /// Default homeserver URL (pre-fills the field).
    pub default_homeserver: Option<String>,
    /// Optional Matrix account domain when the server-key endpoint is unavailable.
    pub server_name: Option<String>,
    /// Registration token (pre-fills the sign-up token field).
    pub registration_token: Option<String>,
    /// When true AND both above are set, hide homeserver + token fields entirely.
    pub hide_server_config: bool,
}

pub struct AppState {
    pub client: Mutex<Option<Client>>,
    pub account_mode: Mutex<commands::pax_auth::AccountMode>,
    pub session_store_dir: Mutex<Option<String>>,
    pub(crate) reauthentication: Mutex<Option<commands::auth::SavedCredentials>>,
    pub encryption: commands::encryption::EncryptionService,
    pub(crate) ignored_users: Arc<commands::ignored_users::IgnoredUsers>,
    pub http_client: reqwest::Client,
    pub(crate) presence: Arc<commands::presence::PresenceCache>,
    pub file_cache: Arc<file_cache::FileCache>,
    pub avatars: Arc<avatars::AvatarService>,
    pub attachments: Arc<attachments::AttachmentCache>,
    pub notifications: commands::reconciler::NotificationService,
    pub voice_presence: voice_presence::VoicePresenceService,
    direct_calls: commands::direct_calls::PendingDirectCalls,
    group_calls: commands::group_calls::Inbox,
    matrix_voip: commands::matrix_voip::MatrixVoip,
    audio_recording: Mutex<Option<voice::recording::AudioRecording>>,
    pub sync_running: Arc<Mutex<bool>>,
    sync_ready: AtomicBool,
    /// Background `sync_with_callback` task — must be aborted before deleting the SQLite store
    /// or replacing `client`, otherwise the DB stays locked (especially on Windows).
    pub sync_join: Mutex<Option<JoinHandle<()>>>,
    pub room_upgrade_operation: Mutex<()>,
    pub voice_room: Mutex<Option<String>>,
    pub display_server: DisplayServer,
    pub giphy_api_key: Option<String>,
    pub auth_config: AuthConfig,
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
    /// Per-room last-emitted unread state.  The sync loop polls `num_unread_*`
    /// after each iteration and only emits `room-unread-changed` for rooms that
    /// actually moved.  See `commands::unread` for the data shape and reasoning
    /// (tl;dr: matrix-sdk 0.16 only flags the broadcast's READ_RECEIPT reason on
    /// the sliding-sync path; legacy sync_once doesn't, so we poll instead).
    pub unread_cache: commands::unread::UnreadStateCache,
    pub(crate) unread_projection: Arc<commands::unread_projection::UnreadProjectionCache>,
    pub pending_unavailable_reads: commands::unavailable_messages::PendingUnavailableReads,
    /// Per-room raw message count since the user's last read receipt, observed
    /// by counting non-self `m.room.message` events in the sync loop's event
    /// handler.
    ///
    /// Why this exists: on legacy `sync_once` (Pax's sync path), matrix-sdk
    /// 0.16's `num_unread_messages()` stays at 0 for most rooms because the
    /// read-receipt tracker isn't populated the same way it is under sliding
    /// sync.  The fallback — the server's `notification_count` — is filtered
    /// by push rules, so a room muted via a room-kind `dont_notify` rule
    /// reports zero even when messages are arriving.  Without this counter,
    /// a muted room would never light up its unread indicator.
    ///
    /// Mutation points:
    ///   - Incremented in the `OriginalSyncRoomMessageEvent` handler in
    ///     `start_sync`, for non-self messages.
    ///   - Cleared in `send_room_read_receipt` (local send).
    ///   - Cleared in the `SyncReceiptEvent` handler in `start_sync`
    ///     when a receipt for our MXID arrives (covers reads on other
    ///     devices syncing down).
    pub raw_unread_messages: Arc<Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, u64>>>,
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
        self.encryption.stop().await;
        let handle = self.sync_join.lock().await.take();
        if let Some(h) = handle {
            h.abort();
            let _ = h.await;
        }
        let mut sync_running = self.sync_running.lock().await;
        self.sync_ready.store(false, Ordering::Release);
        self.presence.clear();
        self.ignored_users.reset();
        *sync_running = false;
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

/// Returns true if the process is running under a KDE Plasma session on
/// native Wayland. Used to decide whether to force GTK/GDK onto the
/// XWayland backend at startup — see the comment in `run()` for context.
///
/// Detection is permissive: any credible signal of KDE combined with any
/// credible signal of Wayland counts. The checks mirror what Qt, Electron,
/// and xdg-utils use, because KDE sets several overlapping env vars.
#[cfg(target_os = "linux")]
fn is_kde_wayland_session() -> bool {
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);

    let is_kde = std::env::var("KDE_FULL_SESSION")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || std::env::var("XDG_CURRENT_DESKTOP")
            .map(|v| v.to_ascii_lowercase().split(':').any(|s| s == "kde"))
            .unwrap_or(false)
        || std::env::var("DESKTOP_SESSION")
            .map(|v| {
                let v = v.to_ascii_lowercase();
                v.contains("plasma") || v == "kde"
            })
            .unwrap_or(false);

    is_wayland && is_kde
}

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

#[cfg(target_os = "android")]
#[no_mangle]
unsafe extern "system" fn JNI_OnLoad(
    vm: *mut jni::sys::JavaVM,
    _reserved: *mut std::ffi::c_void,
) -> jni::sys::jint {
    // Android calls this once with the VM and the app's class loader available.
    let Ok(vm) = (unsafe { jni::JavaVM::from_raw(vm) }) else {
        return jni::sys::JNI_ERR;
    };
    libwebrtc::android::initialize_android(&vm);
    if crate::crypto_store::initialize_android(&vm).is_err() {
        return jni::sys::JNI_ERR;
    }
    jni::sys::JNI_VERSION_1_6
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On KDE Plasma running a native Wayland session, force GTK/GDK to use
    // the XWayland backend.
    //
    // Why: Pax hides the main window to the system tray on close (when the
    // user's close-preference is "minimize_tray"). On KDE's Wayland session
    // this path is broken by a combination of upstream bugs:
    //   - `set_skip_taskbar(true)` is a no-op on Wayland (tauri#9829): the
    //     Wayland protocol has no equivalent of `_NET_WM_STATE_SKIP_TASKBAR`,
    //     so the taskbar icon stays even when we want tray-only presence.
    //   - Calling `win.hide()` destroys the xdg-toplevel surface. When
    //     `win.show()` recreates it, KWin's server-side titlebar region
    //     stops routing pointer events — every button on the titlebar is
    //     dead, `CloseRequested` never fires, and the only way out is to
    //     kill the app. Fully reproducible on KDE+Wayland; does not happen
    //     on KDE+X11 or GNOME+Wayland.
    //
    // XWayland doesn't have either problem: `_NET_WM_STATE_SKIP_TASKBAR`
    // works, and hide/show go through the X11 MapNotify/UnmapNotify path
    // which KWin's X11 window-management handles cleanly. The cost is
    // losing native Wayland niceties (fractional scaling precision,
    // Wayland-only input protocols) for KDE-Wayland users specifically.
    //
    // We override unconditionally when KDE+Wayland is detected: the bug
    // this works around is severe enough (titlebar becomes unclickable
    // after hide-to-tray) that respecting a pre-set GDK_BACKEND=wayland
    // would just ship the broken experience. Tauri's dev CLI and some
    // distro launchers pre-set GDK_BACKEND=wayland incidentally; that's
    // not an "intentional" choice by the user, so there's nothing to
    // respect. If someone needs to force Wayland for debugging, they
    // can set PAX_FORCE_WAYLAND=1 in their environment.
    #[cfg(target_os = "linux")]
    {
        let force_wayland = std::env::var("PAX_FORCE_WAYLAND")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if !force_wayland && is_kde_wayland_session() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    // GTK/Wayland use the program name for the xdg-shell app id when no explicit GTK
    // application id is set. Match `productName` / `pax.desktop` so the taskbar can
    // resolve the icon (see StartupWMClass / icon theme name `pax`).
    #[cfg(target_os = "linux")]
    glib::set_prgname(Some("pax"));

    ensure_system_certs();
    install_panic_hook();
    let display_server = platform::detect_display_server();

    let giphy_api_key = option_env!("GIPHY_API_KEY").map(String::from);

    let default_homeserver = option_env!("PAX_HOMESERVER").map(String::from);
    let registration_token = option_env!("PAX_REGISTRATION_TOKEN").map(String::from);
    let hide_server_config = option_env!("PAX_HIDE_SERVER_CONFIG")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    let auth_config = AuthConfig {
        default_homeserver,
        server_name: option_env!("PAX_SERVER_NAME").map(String::from),
        registration_token,
        hide_server_config,
    };

    // Detect best video codec based on GPU before any screen share publishes (desktop only;
    // mobile uses `DETECTED_CODEC` default in `codec::resolve_codec()`).
    #[cfg(desktop)]
    detect_codec_early();

    let file_cache = Arc::new(file_cache::FileCache::new());
    let state = Arc::new(AppState {
        encryption: commands::encryption::EncryptionService::default(),
        ignored_users: Arc::default(),
        client: Mutex::new(None),
        account_mode: Mutex::new(commands::pax_auth::AccountMode::Matrix),
        session_store_dir: Mutex::new(None),
        reauthentication: Mutex::new(None),
        http_client: reqwest::Client::builder()
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
        presence: Arc::default(),
        avatars: Arc::new(avatars::AvatarService::new(file_cache.clone())),
        attachments: Arc::new(attachments::AttachmentCache::new(attachments::RETAINED_BYTES)),
        notifications: commands::reconciler::NotificationService::default(),
        voice_presence: voice_presence::VoicePresenceService::default(),
        direct_calls: Default::default(),
        group_calls: Default::default(),
        matrix_voip: Default::default(),
        audio_recording: Default::default(),
        file_cache,
        sync_running: Arc::new(Mutex::new(false)),
        sync_ready: AtomicBool::new(false),
        sync_join: Mutex::new(None),
        room_upgrade_operation: Mutex::new(()),
        voice_room: Mutex::new(None),
        display_server,
        giphy_api_key,
        auth_config,
        heartbeat_stop: Arc::new(AtomicBool::new(true)),
        heartbeat_task: StdMutex::new(None),
        delayed_leave_id: StdMutex::new(None),
        msc4140_supported: AtomicBool::new(true),
        voice_livekit_jwt_service_url: StdMutex::new(None),
        desired_presence: Arc::new(StdMutex::new("online".to_string())),
        unread_cache: Arc::new(Mutex::new(HashMap::new())),
        unread_projection: Arc::default(),
        pending_unavailable_reads: Arc::new(Mutex::new(HashMap::new())),
        raw_unread_messages: Arc::new(Mutex::new(HashMap::new())),
    });

    #[cfg(target_os = "android")]
    call_notifications::android::set_app_state(&state);

    let app_builder = tauri::Builder::default();
    #[cfg(desktop)]
    let app_builder = app_builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    let app_builder = app_builder
        .plugin(tauri_plugin_deep_link::init())
        .on_window_event(|window, event| {
            #[cfg(not(desktop))]
            let _ = (window, event);
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Decide hide-vs-quit-vs-dialog synchronously on the Rust
                    // side, rather than round-tripping through the frontend.
                    // The frontend listener still exists for the dialog case
                    // (it needs UI), but for the minimize_tray and quit
                    // branches we don't need a round-trip — deciding here
                    // keeps the close event cycle atomic from GTK's POV.
                    let app = window.app_handle().clone();
                    let pref = commands::lifecycle::get_close_window_preference(app.clone())
                        .ok()
                        .flatten();
                    match pref.as_deref() {
                        Some("minimize_tray") => {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                        Some("quit") => {
                            // Let the close proceed; app.exit(0) matches
                            // exit_app semantics and ensures background tasks
                            // (sync loop, heartbeat) get torn down via Exit.
                            app.exit(0);
                        }
                        _ => {
                            // No saved preference — show the confirm dialog.
                            api.prevent_close();
                            let _ = app.emit("app-close-request", ());
                        }
                    }
                }
            }
        })
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
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
        .plugin(tauri_plugin_notification::init());
    let app_builder = {
        #[cfg(desktop)]
        {
            app_builder.plugin(tauri_plugin_autostart::Builder::new().build())
        }
        #[cfg(not(desktop))]
        {
            app_builder
        }
    };
    app_builder
        .manage(state)
        .manage(call_notifications::CallNotifications::default())
        .manage(voice::VoiceManager::new())
        .register_uri_scheme_protocol("paxvideo", |_app, request| {
            video_recv::handle_protocol_request(request)
        })
        // Asynchronous so slow federation downloads and compat transcodes
        // never block the webview's protocol thread (other media requests
        // keep flowing while a video converts).
        .register_asynchronous_uri_scheme_protocol("paxmatrixmedia", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(
                    commands::media_protocol::handle_matrix_media_protocol_request(app, request)
                        .await,
                );
            });
        })
        .invoke_handler(tauri::generate_handler![
            voice::recording::start_audio_recording,
            voice::recording::stop_audio_recording,
            voice::recording::cancel_audio_recording,
            commands::auth::logout,
            commands::auth::get_access_token,
            commands::auth::save_credentials,
            commands::auth::load_credentials,
            commands::auth::clear_saved_credentials,
            commands::auth::login,
            commands::auth::register,
            commands::invites::room_share_links,
            commands::invites::parse_room_link,
            commands::invites::get_linked_room_preview,
            commands::invites::invite_by_email,
            commands::auth::restore_session,
            commands::account_conversion::get_account_conversion_status,
            commands::account_conversion::convert_account_to_pax,
            commands::account_conversion::resume_pax_conversion,
            commands::encryption::get_encryption_status,
            commands::encryption::get_encryption_identity_change,
            commands::encryption::acknowledge_encryption_identity_change,
            commands::encryption::get_pending_encryption_recovery_key,
            commands::encryption::setup_encryption_recovery,
            commands::encryption::start_encryption_recovery_from_device,
            commands::encryption::acknowledge_encryption_recovery_key,
            commands::encryption::restore_encryption_recovery,
            commands::encryption::replace_encryption_recovery_key,
            commands::encryption::sync_encryption_backup,
            commands::history_backup::export_available_history,
            commands::history_backup::import_available_history,
            commands::encryption::request_encryption_verification,
            commands::encryption::get_encryption_verification,
            commands::encryption::respond_encryption_verification,
            commands::room_listing::get_rooms,
            commands::room_listing::current_homeserver,
            commands::room_membership::join_room,
            commands::room_membership::leave_room,
            commands::room_membership::knock_room,
            commands::room_upgrades::get_room_upgrade_options,
            commands::room_upgrades::upgrade_room,
            commands::room_settings::get_space_info,
            commands::room_settings::get_space_settings,
            commands::room_settings::apply_space_settings,
            commands::room_settings::get_history_visibility,
            commands::room_settings::set_history_visibility,
            commands::room_settings::get_room_general_settings,
            commands::room_settings::apply_room_general_settings,
            commands::room_settings::get_room_power_levels_settings,
            commands::room_settings::set_room_power_levels,
            commands::room_creation::can_create_rooms,
            commands::room_creation::create_space,
            commands::room_creation::create_sub_space,
            commands::room_creation::can_manage_space_children,
            commands::room_creation::create_room_in_space,
            commands::room_creation::create_standalone_room,
            commands::rss::setup_rss_feed,
            commands::rss::get_rss_feed_status,
            commands::rss::get_rss_bot_settings,
            commands::rss::save_rss_bot_settings,
            commands::rss::invite_rss_feed_provider,
            commands::rss::cancel_rss_feed_invitation,
            commands::rss::subscriptions::list_rss_subscriptions,
            commands::rss::subscriptions::update_rss_subscription,
            commands::room_creation::link_room_to_space,
            commands::room_creation::set_space_child_order,
            commands::room_discovery::search_public_spaces,
            commands::room_discovery::search_public_rooms,
            commands::room_discovery::resolve_room_alias,
            commands::room_discovery::get_room_parent_spaces,
            commands::messages::get_messages,
            commands::ignored_users::get_ignored_users,
            commands::ignored_users::set_user_ignored,
            commands::media_files::get_matrix_image_path,
            commands::media_files::release_matrix_media,
            commands::media_files::clear_media_cache,
            commands::members::get_room_members,
            commands::members::get_room_management_members,
            commands::members::get_room_member_profile,
            commands::members::get_matrix_user_profile,
            commands::members::get_user_avatar,
            commands::members::get_user_avatars,
            commands::members::get_room_avatars,
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
            commands::direct_calls::send_direct_call_signal,
            commands::direct_calls::take_direct_call_signals,
            commands::group_calls::ring_group_call,
            commands::call_policy::get_room_call_permissions,
            commands::call_policy::get_incoming_call_mode,
            commands::pax_settings::set_call_preference,
            commands::group_calls::respond_to_group_call,
            commands::group_calls::take_group_call_signals,
            commands::matrix_voip::take_matrix_voip_signals,
            commands::matrix_voip::prefer_livekit_call,
            commands::matrix_voip::send_matrix_voip_signal,
            commands::matrix_voip::open_matrix_voip_media,
            commands::matrix_voip::update_matrix_voip_media,
            commands::matrix_voip::toggle_matrix_voip_mic,
            commands::matrix_voip::close_matrix_voip_media,
            call_notifications::sync_call_notification,
            call_notifications::take_call_notification_action,
            commands::voice_matrix::voice_connect,
            commands::voice_matrix::voice_device_id,
            commands::voice_matrix::voice_find_previous_room,
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
            commands::messages::send_room_reaction,
            commands::messages::remove_room_reaction,
            commands::messages::get_room_redaction_policy,
            commands::messages::get_room_can_send_messages,
            commands::messages::get_room_can_pin_messages,
            commands::messages::get_room_pinned_event_ids,
            commands::messages::get_pinned_message_previews,
            commands::messages::pin_room_message,
            commands::messages::unpin_room_message,
            commands::messages::get_messages_around_event,
            commands::messages::get_room_message,
            commands::messages::get_rss_thread_replies,
            commands::messages::send_rss_thread_reply,
            commands::messages::start_sync,
            commands::messages::send_typing_notice,
            commands::media_files::room_file_staging_reset,
            commands::media_files::room_file_staging_append_b64,
            commands::media_files::room_file_staging_byte_len,
            commands::media_files::room_file_staging_remove,
            commands::media_files::get_matrix_max_upload_bytes,
            commands::media_files::upload_room_file,
            commands::media_files::send_file_message,
            commands::media_files::upload_and_send_file,
            commands::presence::set_presence,
            commands::presence::is_sync_ready,
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
            commands::rss_search::search_rss_feeds,
            commands::rss_preview::get_rss_article_preview,
            commands::rss_preview::get_rss_preview_image,
            commands::embed::proxy_media,
            commands::embed::cleanup_proxy_media,
            commands::embed::cleanup_all_proxy_media,
            commands::downloads::start_room_download,
            commands::downloads::open_containing_folder,
            commands::unread::get_room_unread_state,
            commands::unread::get_all_unread_states,
            commands::unread::send_room_read_receipt,
            commands::unread::acknowledge_viewed_calls,
            commands::unavailable_messages::get_unavailable_message_acknowledgement,
            commands::unavailable_messages::acknowledge_unavailable_messages,
            commands::unavailable_messages::clear_room_notification,
            commands::unread::set_room_marked_unread,
            // --- Push rules (raw CS-API wrappers + master-toggle convenience) ---
            commands::push_rules::get_push_rules,
            commands::push_rules::set_push_rule,
            commands::push_rules::delete_push_rule,
            commands::push_rules::set_push_rule_enabled,
            commands::push_rules::set_push_rule_actions,
            commands::push_rules::get_notifications_enabled_globally,
            commands::push_rules::set_notifications_enabled_globally,
            // --- Pax-specific settings (account data) ---
            commands::pax_settings::get_unread_settings,
            commands::pax_settings::set_global_unread_indicator,
            commands::pax_settings::set_space_unread_indicator,
            commands::pax_settings::set_room_unread_indicator,
            commands::pax_settings::get_notification_settings,
            commands::pax_settings::set_tray_unread_indicator_mode,
            commands::pax_settings::set_global_default_notification_level,
            commands::pax_settings::set_space_notification_level,
            // --- User-level space sidebar order (custom account data) ---
            commands::space_order::get_space_order,
            commands::space_order::set_space_order,
            // --- Notification levels (synthesised onto push rules) ---
            commands::notification_levels::set_room_notification_level,
            commands::notification_levels::clear_room_notification_level,
            commands::notification_levels::get_room_notification_level,
            commands::notification_levels::get_all_room_notification_levels,
            commands::reconciler::reconcile_all_notification_levels,
            // --- Desktop notifications ---
            commands::notifications::notify_supported,
            commands::notifications::notify_send,
            commands::notifications::focus_main_window,
            // --- Push notifications (Android) ---
            commands::push::register_pusher,
            commands::push::unregister_pusher,
            commands::push::push_gateway_configured,
            commands::push::get_ios_voip_token,
            commands::push::get_ios_badge_token,
            commands::tray_indicator::set_tray_unread_indicator,
            app_badge::set_app_notification_count,
            commands::lifecycle::exit_app,
            commands::lifecycle::hide_main_window,
            commands::lifecycle::get_close_window_preference,
            commands::lifecycle::set_close_window_preference,
            commands::lifecycle::clear_close_window_preference,
        ])
        .setup(|app| {
            #[cfg(target_os = "ios")]
            call_notifications::initialize_ios(app.handle());
            #[cfg(target_os = "macos")]
            call_notifications::initialize_macos(app.handle());
            setup::setup(app)
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                if urls.iter().any(|url| url.scheme() == "pax") {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            if let tauri::RunEvent::Exit = event {
                tauri::async_runtime::block_on(commands::lifecycle::close_voice_before_exit(app));
            }
        });
}

/// Detect the best video codec by probing the GPU adapter at startup.
/// Runs synchronously (blocking) because it's called once during init.
#[cfg(desktop)]
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
