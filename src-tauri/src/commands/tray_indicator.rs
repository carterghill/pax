//! System tray unread indicator (desktop): composite a small dot onto the tray icon.

use std::sync::OnceLock;

use serde::Deserialize;
use tauri::AppHandle;

/// Stable id for `TrayIconBuilder::with_id` / `AppHandle::tray_by_id`.
pub const PAX_TRAY_ICON_ID: &str = "pax-main";

/// Which badge variant to paint on the tray icon.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayIndicatorDot {
    None,
    Red,
    Blue,
}

#[cfg(desktop)]
static TRAY_ICONS: OnceLock<(
    tauri::image::Image<'static>,
    tauri::image::Image<'static>,
    tauri::image::Image<'static>,
)> = OnceLock::new();

#[cfg(desktop)]
fn tray_icon_triple(
) -> &'static (
    tauri::image::Image<'static>,
    tauri::image::Image<'static>,
    tauri::image::Image<'static>,
) {
    TRAY_ICONS.get_or_init(|| {
        let bytes = include_bytes!("../../../public/logoWhiteAltBig.png");
        let base = tauri::image::Image::from_bytes(bytes).expect("logoWhiteAltBig.png");
        let base_owned = base.to_owned();
        let w = base_owned.width();
        let h = base_owned.height();
        let rgba_base = base_owned.rgba().to_vec();
        let mut rgba_red = rgba_base.clone();
        paint_dot(&mut rgba_red, w, h, 239, 68, 68);
        let mut rgba_blue = rgba_base.clone();
        paint_dot(&mut rgba_blue, w, h, 59, 130, 246);
        let normal = tauri::image::Image::new_owned(rgba_base, w, h);
        let with_red = tauri::image::Image::new_owned(rgba_red, w, h);
        let with_blue = tauri::image::Image::new_owned(rgba_blue, w, h);
        (normal, with_red, with_blue)
    })
}

#[cfg(desktop)]
fn paint_dot(rgba: &mut [u8], w: u32, h: u32, red: u8, green: u8, blue: u8) {
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
                    px.copy_from_slice(&[red, green, blue, 255]);
                }
            }
        }
    }
}

#[cfg(desktop)]
fn set_tray_unread_indicator_impl(app: AppHandle, dot: TrayIndicatorDot) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(PAX_TRAY_ICON_ID) else {
        log::warn!("[tray] icon id {PAX_TRAY_ICON_ID} not registered");
        return Ok(());
    };
    let (normal, red, blue) = tray_icon_triple();
    let icon = match dot {
        TrayIndicatorDot::None => normal.clone(),
        TrayIndicatorDot::Red => red.clone(),
        TrayIndicatorDot::Blue => blue.clone(),
    };
    tray
        .set_icon(Some(icon))
        .map_err(|e| format!("tray set_icon: {e}"))?;
    let tip = match dot {
        TrayIndicatorDot::None => "Pax",
        TrayIndicatorDot::Red => "Pax — unread",
        TrayIndicatorDot::Blue => "Pax — unread (no notifications)",
    };
    tray
        .set_tooltip(Some(tip))
        .map_err(|e| format!("tray set_tooltip: {e}"))?;
    Ok(())
}

/// Updates tray icon + tooltip: no dot, red (notifications), or blue (unread only).
#[tauri::command]
pub fn set_tray_unread_indicator(app: AppHandle, dot: TrayIndicatorDot) -> Result<(), String> {
    #[cfg(not(desktop))]
    {
        let _ = (app, dot);
        return Ok(());
    }
    #[cfg(desktop)]
    set_tray_unread_indicator_impl(app, dot)
}
