use tauri::command;

/// Report the native overlay feature availability.
#[command]
pub fn overlay_is_supported() -> bool {
    let supported = crate::native_overlay::is_supported();
    eprintln!("[Pax Overlay] overlay_is_supported called → {}", supported);
    supported
}

/// Reposition and resize a native overlay to match the frontend container.
#[command]
pub fn overlay_set_rect(identity: String, x: i32, y: i32, w: u32, h: u32) {
    crate::native_overlay::set_overlay_rect(&identity, x, y, w, h);
}

/// Show or hide a native overlay.
#[command]
pub fn overlay_set_visible(identity: String, visible: bool) {
    eprintln!("[Pax Overlay] overlay_set_visible '{}' → {}", identity, visible);
    crate::native_overlay::set_overlay_visible(&identity, visible);
}

/// Update the obstruction rects for a native overlay.
#[command]
pub fn overlay_set_obstructions(
    identity: String,
    obstructions: Vec<crate::native_overlay::ObstructionRect>,
) {
    crate::native_overlay::set_overlay_obstructions(&identity, obstructions);
}

/// Get hover states for all overlays.  Returns a map of identity → hovered.
/// Called by the frontend rAF loop to apply hover styling (e.g. border highlight).
#[command]
pub fn overlay_get_hover_states() -> std::collections::HashMap<String, bool> {
    crate::native_overlay::get_all_overlay_hover_states()
}