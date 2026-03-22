/// Idle-time detection with per-display-server backends.
///
/// * **X11** – uses the `user-idle` crate (XScreenSaver / MIT-SCREEN-SAVER).
/// * **Wayland** – queries D-Bus, trying in order:
///   1. `org.gnome.Mutter.IdleMonitor` (GNOME / Mutter-based compositors)
///   2. `org.freedesktop.ScreenSaver` `GetSessionIdleTime` (KDE Plasma)
///   3. `org.freedesktop.login1.Session` `IdleSinceHint` (systemd-logind,
///      works across most compositors but depends on the DE setting the hint)

use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::platform::DisplayServer;

#[cfg(target_os = "linux")]
use zbus::Proxy;

#[cfg(target_os = "linux")]
use zbus::proxy::Builder;

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

/// Spawn the idle-monitoring loop that emits `"idle-changed"` events.
///
/// Picks the right backend based on the display server detected at startup.
pub async fn run_idle_monitor(app: Arc<AppHandle>, display_server: DisplayServer) {
    let idle_threshold_ms: u64 = 300_000; // 5 minutes
    let poll_interval = Duration::from_secs(15);
    let mut was_idle = false;

    // On Wayland, open a D-Bus connection once and reuse it.
    #[cfg(target_os = "linux")]
    let dbus_conn = if display_server == DisplayServer::Wayland {
        match zbus::Connection::session().await {
            Ok(c) => Some(c),
            Err(e) => {
                log::warn!("failed to connect to session D-Bus: {e}");
                None
            }
        }
    } else {
        None
    };

    loop {
        tokio::time::sleep(poll_interval).await;

        let idle_ms: Option<u64> = match display_server {
            DisplayServer::Wayland => {
                #[cfg(target_os = "linux")]
                {
                    if let Some(conn) = &dbus_conn {
                        get_idle_ms_dbus(conn).await
                    } else {
                        None
                    }
                }
                #[cfg(not(target_os = "linux"))]
                { None }
            }
            _ => {
                // X11 / macOS / Windows – use the user-idle crate.
                match user_idle::UserIdle::get_time() {
                    Ok(idle) => Some(idle.as_milliseconds() as u64),
                    Err(_) => None,
                }
            }
        };

        let idle_ms = match idle_ms {
            Some(v) => v,
            None => continue,
        };

        let is_idle = idle_ms >= idle_threshold_ms;

        if is_idle != was_idle {
            was_idle = is_idle;
            let _ = app.emit("idle-changed", is_idle);
        }
    }
}

// ---------------------------------------------------------------------------
// D-Bus helpers (Linux / Wayland only)
// ---------------------------------------------------------------------------

/// Try several D-Bus interfaces to get the idle time in milliseconds.
///
/// Returns `None` if every method fails (so the poll loop simply skips that
/// tick rather than emitting a spurious state change).
#[cfg(target_os = "linux")]
async fn get_idle_ms_dbus(conn: &zbus::Connection) -> Option<u64> {
    // 1. GNOME Mutter IdleMonitor  – GetIdletime() → u64 (ms)
    if let Some(ms) = try_mutter_idle(conn).await {
        return Some(ms);
    }

    // 2. KDE Plasma ScreenSaver – GetSessionIdleTime() → u32 (ms)
    if let Some(ms) = try_kde_idle(conn).await {
        return Some(ms);
    }

    // 3. systemd-logind – IdleSinceHint property (µs since epoch)
    if let Some(ms) = try_logind_idle().await {
        return Some(ms);
    }

    None
}

/// GNOME Mutter: `org.gnome.Mutter.IdleMonitor.GetIdletime`
///
/// Returns idle time in milliseconds directly.
#[cfg(target_os = "linux")]
async fn try_mutter_idle(conn: &zbus::Connection) -> Option<u64> {
    let proxy: Proxy = Builder::new(conn)
        .destination("org.gnome.Mutter.IdleMonitor").ok()?
        .path("/org/gnome/Mutter/IdleMonitor/Core").ok()?
        .interface("org.gnome.Mutter.IdleMonitor").ok()?
        .build()
        .await
        .ok()?;

    let reply = proxy.call_method("GetIdletime", &()).await.ok()?;
    let ms: u64 = reply.body().deserialize().ok()?;
    Some(ms)
}

/// KDE Plasma: `org.freedesktop.ScreenSaver.GetSessionIdleTime`
///
/// Returns idle time in milliseconds.
#[cfg(target_os = "linux")]
async fn try_kde_idle(conn: &zbus::Connection) -> Option<u64> {
    let proxy: Proxy = Builder::new(conn)
        .destination("org.freedesktop.ScreenSaver").ok()?
        .path("/ScreenSaver").ok()?
        .interface("org.freedesktop.ScreenSaver").ok()?
        .build()
        .await
        .ok()?;

    let reply = proxy.call_method("GetSessionIdleTime", &()).await.ok()?;
    let ms: u32 = reply.body().deserialize().ok()?;
    Some(ms as u64)
}

/// systemd-logind: read `IdleSinceHint` from the current session.
///
/// `IdleSinceHint` is a timestamp in **microseconds** since the Unix epoch
/// representing when the session became idle.  We convert that to a
/// millisecond duration.  A value of 0 means the session is not idle.
///
/// Uses the *system* bus (logind lives there, not on the session bus).
#[cfg(target_os = "linux")]
async fn try_logind_idle() -> Option<u64> {
    let sys_conn = zbus::Connection::system().await.ok()?;

    // Resolve the current session's object path via GetSession("auto").
    let manager_proxy: Proxy = Builder::new(&sys_conn)
        .destination("org.freedesktop.login1").ok()?
        .path("/org/freedesktop/login1").ok()?
        .interface("org.freedesktop.login1.Manager").ok()?
        .build()
        .await
        .ok()?;

    let reply = manager_proxy
        .call_method("GetSession", &("auto",))
        .await
        .ok()?;
    let session_path: zbus::zvariant::OwnedObjectPath =
        reply.body().deserialize().ok()?;

    // Read the IdleSinceHint property via org.freedesktop.DBus.Properties.
    let props_proxy: Proxy = Builder::new(&sys_conn)
        .destination("org.freedesktop.login1").ok()?
        .path(session_path).ok()?
        .interface("org.freedesktop.DBus.Properties").ok()?
        .build()
        .await
        .ok()?;

    let reply = props_proxy
        .call_method(
            "Get",
            &("org.freedesktop.login1.Session", "IdleSinceHint"),
        )
        .await
        .ok()?;

    let val: zbus::zvariant::OwnedValue = reply.body().deserialize().ok()?;

    let idle_since_us: u64 = match val.downcast_ref::<u64>() {
        Ok(v) => v,
        Err(_) => 0,
    };

    if idle_since_us == 0 {
        return Some(0); // session not marked idle
    }

    let now_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_micros() as u64;

    let idle_us = now_us.saturating_sub(idle_since_us);
    Some(idle_us / 1000) // µs → ms
}