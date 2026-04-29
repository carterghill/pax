//! Stubs for `native_overlay` on platforms without the GPU / Win32 overlay path.

use std::collections::HashMap;

use tokio::sync::mpsc;

/// See desktop `ObstructionRect` — serde shape must stay compatible with the frontend.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct ObstructionRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    #[serde(alias = "cornerRadius")]
    pub corner_radius: u32,
}

pub fn register_overlay_clip_notifier(_identity: &str, _tx: mpsc::UnboundedSender<()>) {}

pub fn unregister_overlay_clip_notifier(_identity: &str) {}

pub fn reset_shared_gpu() {}

pub fn create_overlay(_identity: &str, _parent_hwnd: isize) -> Result<isize, String> {
    Err("native overlay unsupported on this platform".into())
}

pub fn destroy_overlay(_identity: &str) {}

pub fn set_overlay_rect(_identity: &str, _x: i32, _y: i32, _w: u32, _h: u32) {}

pub fn set_overlay_visible(_identity: &str, _visible: bool) {}

pub fn get_overlay_target(_identity: &str) -> Option<(i32, i32, u32, u32, bool)> {
    let _ = _identity;
    None
}

pub fn set_overlay_letterbox_color(_identity: &str, _r: f32, _g: f32, _b: f32) {}

pub fn get_overlay_letterbox_color(_identity: &str) -> (f32, f32, f32) {
    let _ = _identity;
    (0.0, 0.0, 0.0)
}

pub fn set_overlay_obstructions(_identity: &str, _rects: Vec<ObstructionRect>) {}

pub fn get_overlay_obstructions(_identity: &str) -> Vec<ObstructionRect> {
    let _ = _identity;
    Vec::new()
}

pub fn destroy_all_overlays() {}

pub fn get_all_overlay_hover_states() -> HashMap<String, bool> {
    HashMap::new()
}

pub fn is_supported() -> bool {
    false
}

pub fn pump_messages() {}

pub struct GpuRenderer;

impl GpuRenderer {
    pub async fn new(_parent_hwnd: isize, _identity: String) -> Result<Self, String> {
        Err("native GPU overlay is not available on this platform".into())
    }

    pub fn get_fit_dimensions(&self, _src_w: u32, _src_h: u32) -> (u32, u32) {
        (0, 0)
    }

    pub fn refresh_obstruction_clip(&mut self) {}

    pub fn render_frame(
        &mut self,
        _data_y: &[u8],
        _data_u: &[u8],
        _data_v: &[u8],
        _width: u32,
        _height: u32,
        _stride_y: u32,
        _stride_u: u32,
        _stride_v: u32,
    ) {
    }
}
