//! System tray unread indicator (desktop): composite a small red dot onto the tray icon.

use std::sync::OnceLock;

use tauri::AppHandle;

/// Stable id for `TrayIconBuilder::with_id` / `AppHandle::tray_by_id`.
pub const PAX_TRAY_ICON_ID: &str = "pax-main";

#[cfg(desktop)]
static TRAY_ICONS: OnceLock<(tauri::image::Image<'static>, tauri::image::Image<'static>)> =
    OnceLock::new();

#[cfg(desktop)]
fn tray_icon_pair() -> &'static (tauri::image::Image<'static>, tauri::image::Image<'static>) {
    TRAY_ICONS.get_or_init(|| {
        let bytes = include_bytes!("../../../public/logoWhiteAltBig.png");
        let base = tauri::image::Image::from_bytes(bytes).expect("logoWhiteAltBig.png");
        let base_owned = base.to_owned();
        let w = base_owned.width();
        let h = base_owned.height();
        let mut rgba = base_owned.rgba().to_vec();
        paint_unread_dot(&mut rgba, w, h);
        let with_dot = tauri::image::Image::new_owned(rgba, w, h);
        (base_owned, with_dot)
    })
}

#[cfg(desktop)]
fn paint_unread_dot(rgba: &mut [u8], w: u32, h: u32) {
    let wf = w as f32;
    // ~3× the original ~5.8% radius so the badge reads clearly after OS downscale.
    let r = (wf * 0.174).max(18.0);
    let cx = wf - r * 0.9;
    let cy = r * 0.9;
    let r2 = r * r;
    for y in 0..h {
        for x in 0..w {
            let dx = (x as f32 + 0.5) - cx;
            let dy = (y as f32 + 0.5) - cy;
            if dx * dx + dy * dy <= r2 {
                let i = ((y * w + x) * 4) as usize;
                if let Some(px) = rgba.get_mut(i..i + 4) {
                    px.copy_from_slice(&[239, 68, 68, 255]);
                }
            }
        }
    }
}

#[cfg(desktop)]
fn set_tray_unread_indicator_impl(app: AppHandle, has_unread: bool) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(PAX_TRAY_ICON_ID) else {
        log::warn!("[tray] icon id {PAX_TRAY_ICON_ID} not registered");
        return Ok(());
    };
    let (normal, badged) = tray_icon_pair();
    let icon = if has_unread {
        badged.clone()
    } else {
        normal.clone()
    };
    tray
        .set_icon(Some(icon))
        .map_err(|e| format!("tray set_icon: {e}"))?;
    let tip = if has_unread {
        "Pax — unread messages"
    } else {
        "Pax"
    };
    tray
        .set_tooltip(Some(tip))
        .map_err(|e| format!("tray set_tooltip: {e}"))?;
    Ok(())
}

/// Updates tray icon + tooltip to reflect whether any room has unread activity.
#[tauri::command]
pub fn set_tray_unread_indicator(app: AppHandle, has_unread: bool) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (app, has_unread);
        return Ok(());
    }
    #[cfg(desktop)]
    set_tray_unread_indicator_impl(app, has_unread)
}
