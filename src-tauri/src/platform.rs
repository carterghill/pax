/// Platform / session detection utilities.
///
/// Called **before** GTK / WebKit are initialised so that environment
/// variables take effect.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayServer {
    Wayland,
    X11,
    Unknown,
}

/// Detect the display server from the environment.
pub fn detect_display_server() -> DisplayServer {
    // Prefer the explicit session-type variable set by the login manager.
    if let Ok(session) = std::env::var("XDG_SESSION_TYPE") {
        match session.to_lowercase().as_str() {
            "wayland" => return DisplayServer::Wayland,
            "x11" => return DisplayServer::X11,
            _ => {}
        }
    }

    // Fall back to checking session-specific env vars.
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return DisplayServer::Wayland;
    }
    if std::env::var_os("DISPLAY").is_some() {
        return DisplayServer::X11;
    }

    DisplayServer::Unknown
}

/// Set any environment variables that need to be present before the
/// toolkit / WebKit is initialised.
///
/// Must be called at the very start of `main()`, before `pax_lib::run()`.
pub fn apply_env_overrides() {
    let ds = detect_display_server();

    if ds == DisplayServer::Wayland {
        // WebKitGTK's DMA-BUF renderer triggers "Error 71 (Protocol error)
        // dispatching to Wayland display" on several compositors. Disabling
        // it avoids the crash without visible side-effects.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}