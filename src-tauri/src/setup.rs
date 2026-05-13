use std::sync::Arc;

use tauri::Manager;

use crate::commands;
use crate::AppState;

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(tauri_temp) = app.path().temp_dir() {
        let _ = std::fs::create_dir_all(&tauri_temp);
        let _ = commands::TAURI_TEMP_DIR.set(tauri_temp);
    }

    if let Ok(cache_root) = app.path().app_cache_dir() {
        let avatar_dir = cache_root.join("avatars");
        let avatar_cache = app.state::<Arc<AppState>>().avatar_cache.clone();
        if let Err(e) = tauri::async_runtime::block_on(avatar_cache.init_with_dir(avatar_dir)) {
            log::warn!("[avatar_cache] init failed: {e}; avatars will not persist this session");
        }
    } else {
        log::warn!(
            "[avatar_cache] app_cache_dir() unavailable; avatars will not persist this session"
        );
    }

    let main_window = app
        .get_webview_window("main")
        .expect("main window not found");
    #[cfg(desktop)]
    {
        let icon = tauri::include_image!("icons/128x128.png");
        let _ = main_window.set_icon(icon);
    }

    #[cfg(desktop)]
    {
        let tray_icon =
            tauri::image::Image::from_bytes(include_bytes!("../../public/logoWhiteAltBig.png"))
                .map_err(|e| format!("tray icon: {e}"))?;
        let menu = tauri::menu::MenuBuilder::new(app)
            .text("tray_show", "Show Pax")
            .text("tray_quit", "Quit")
            .build()?;

        let _tray =
            tauri::tray::TrayIconBuilder::with_id(commands::tray_indicator::PAX_TRAY_ICON_ID)
                .menu(&menu)
                .icon(tray_icon)
                .tooltip("Pax")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "tray_quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    use tauri::tray::TrayIconEvent;
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.unminimize();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;
    }

    cleanup_temp_files(app);

    #[cfg(target_os = "linux")]
    {
        main_window
            .with_webview(|webview| {
                use webkit2gtk::PermissionRequestExt;
                use webkit2gtk::SettingsExt;
                use webkit2gtk::WebViewExt;
                let wv = webview.inner();

                if let Some(settings) = wv.settings() {
                    settings.set_enable_webrtc(true);
                    settings.set_enable_media_stream(true);
                    settings.set_enable_webaudio(true);
                }

                wv.connect_permission_request(|_wv, request| {
                    request.allow();
                    true
                });
            })
            .expect("Failed to configure webview permissions");
    }

    Ok(())
}

fn cleanup_temp_files(app: &mut tauri::App) {
    let Some(temp_dir) = app.path().temp_dir().ok() else {
        return;
    };
    if !temp_dir.exists() {
        return;
    }
    let mut count = 0u32;
    if let Ok(entries) = std::fs::read_dir(&temp_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let is_proxy_video = name_str.starts_with("pax_media_") && name_str.ends_with(".mp4");
            let is_matrix_img = name_str.starts_with("pax_matrix_media_");
            let is_avatar = name_str.starts_with("pax_avatar_");
            if is_proxy_video || is_matrix_img || is_avatar {
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
