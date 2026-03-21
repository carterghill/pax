//! Native GPU overlay rendering — zero-IPC video display.
//!
//! Creates a native child window (WS_CHILD HWND on Windows) parented to the
//! Tauri window, then renders decoded I420 frames directly to a wgpu surface
//! using a YUV→RGB fragment shader.  Frames never cross the Rust↔WebView IPC
//! boundary — eliminating the ~93 MB/s serialization bottleneck at 1080p30.
//!
//! Architecture
//! ────────────
//! Main thread:   creates / positions / destroys overlay HWNDs
//! Video thread:  creates wgpu device + surface, uploads I420 textures, renders
//!
//! The overlay HWND is z-ordered on top of the WebView2 child.  A future
//! iteration will switch to "punch-through" (overlay behind WebView, with a
//! transparent CSS hole) once WebView2 transparency is wired up.
//!
//! Platform support
//! ────────────────
//!   Windows: Direct3D 12 via wgpu  ← implemented here
//!   Linux:   planned (Wayland subsurface + Vulkan)

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use parking_lot::Mutex;
use once_cell::sync::Lazy;

// ─── WGSL shader (embedded) ─────────────────────────────────────────────────

const YUV_SHADER: &str = r#"
struct VOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    // Fullscreen triangle — 3 verts cover clip space, rasterizer clips.
    var positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f( 3.0, -1.0),
        vec2f(-1.0,  3.0),
    );
    var uvs = array<vec2f, 3>(
        vec2f(0.0, 1.0),
        vec2f(2.0, 1.0),
        vec2f(0.0, -1.0),
    );
    var out: VOut;
    out.pos = vec4f(positions[i], 0.0, 1.0);
    out.uv = uvs[i];
    return out;
}

@group(0) @binding(0) var tex_y: texture_2d<f32>;
@group(0) @binding(1) var tex_u: texture_2d<f32>;
@group(0) @binding(2) var tex_v: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
    let y = textureSample(tex_y, samp, in.uv).r;
    let u = textureSample(tex_u, samp, in.uv).r - 0.5;
    let v = textureSample(tex_v, samp, in.uv).r - 0.5;
    // BT.601 YUV → RGB
    let r = y + 1.402 * v;
    let g = y - 0.344136 * u - 0.714136 * v;
    let b = y + 1.772 * u;
    return vec4f(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), 1.0);
}
"#;

// ─── Global overlay registry ────────────────────────────────────────────────

/// A rectangle to clip out of the video overlay (physical pixels, relative
/// to the overlay's own origin).  Reported by the frontend when DOM elements
/// (modals, dropdowns, tooltips) overlap the video area.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct ObstructionRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// Logical corner radius already scaled to **physical** pixels (matches `x`/`y`/`w`/`h`).
    /// When `0`, a plain rectangle is used (legacy). When non-zero, `CreateRoundRectRgn` is used
    /// so the punched hole matches CSS `border-radius` instead of the axis-aligned bounding box.
    #[serde(default)]
    pub corner_radius: u32,
}

struct OverlayEntry {
    hwnd: isize,
    /// Target rect set by the frontend (physical pixels, parent-relative).
    target_x: std::sync::atomic::AtomicI32,
    target_y: std::sync::atomic::AtomicI32,
    target_w: std::sync::atomic::AtomicU32,
    target_h: std::sync::atomic::AtomicU32,
    visible: std::sync::atomic::AtomicBool,
    /// Rects to clip OUT of the video overlay.
    obstructions: Mutex<Vec<ObstructionRect>>,
}

static OVERLAYS: Lazy<Mutex<HashMap<String, OverlayEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ─── Public API ─────────────────────────────────────────────────────────────

/// Create an overlay child window for the given stream identity.
/// Called from GpuRenderer::new on the video thread — this ensures the HWND
/// is owned by the video thread so all subsequent Win32 calls are thread-local.
pub fn create_overlay(identity: &str, parent_hwnd: isize) -> Result<isize, String> {
    let hwnd = platform::create_child_hwnd(parent_hwnd)?;
    eprintln!(
        "[Pax NativeOverlay] Created overlay HWND {:?} for '{}' (parent={:?})",
        hwnd, identity, parent_hwnd
    );
    OVERLAYS.lock().insert(identity.to_string(), OverlayEntry {
        hwnd,
        target_x: std::sync::atomic::AtomicI32::new(0),
        target_y: std::sync::atomic::AtomicI32::new(0),
        target_w: std::sync::atomic::AtomicU32::new(0),
        target_h: std::sync::atomic::AtomicU32::new(0),
        visible: std::sync::atomic::AtomicBool::new(false),
        obstructions: Mutex::new(Vec::new()),
    });
    Ok(hwnd)
}

/// Remove the overlay from the registry.  The actual HWND is destroyed by
/// `GpuRenderer::Drop` on the video thread (Win32 requires DestroyWindow
/// to be called from the creating thread).
pub fn destroy_overlay(identity: &str) {
    if let Some(entry) = OVERLAYS.lock().remove(identity) {
        // Mark as not visible so render_frame stops drawing
        entry.visible.store(false, Ordering::Relaxed);
        eprintln!("[Pax NativeOverlay] Unregistered overlay for '{}' (HWND destruction deferred to video thread)", identity);
    }
}

/// Store the desired rect for the overlay.  No Win32 calls here — just atomic
/// stores.  The video thread will apply the rect to the HWND on its next frame.
/// This avoids cross-thread SendMessage deadlocks with Tauri's IPC.
pub fn set_overlay_rect(identity: &str, x: i32, y: i32, w: u32, h: u32) {
    let overlays = OVERLAYS.lock();
    if let Some(entry) = overlays.get(identity) {
        entry.target_x.store(x, Ordering::Relaxed);
        entry.target_y.store(y, Ordering::Relaxed);
        entry.target_w.store(w, Ordering::Relaxed);
        entry.target_h.store(h, Ordering::Relaxed);
        if w > 0 && h > 0 {
            entry.visible.store(true, Ordering::Relaxed);
        }
    }
}

/// Show or hide the overlay (stored atomically, applied by video thread).
pub fn set_overlay_visible(identity: &str, visible: bool) {
    let overlays = OVERLAYS.lock();
    if let Some(entry) = overlays.get(identity) {
        entry.visible.store(visible, Ordering::Relaxed);
    }
}

/// Read the target rect for the given identity.  Called by the video thread.
pub fn get_overlay_target(identity: &str) -> Option<(i32, i32, u32, u32, bool)> {
    let overlays = OVERLAYS.lock();
    overlays.get(identity).map(|e| (
        e.target_x.load(Ordering::Relaxed),
        e.target_y.load(Ordering::Relaxed),
        e.target_w.load(Ordering::Relaxed),
        e.target_h.load(Ordering::Relaxed),
        e.visible.load(Ordering::Relaxed),
    ))
}

/// Update the obstruction rects for the given identity.
/// `rects` are in physical pixels, relative to the **overlay's own origin**.
/// The video thread will apply these as a clip region on the next frame.
pub fn set_overlay_obstructions(identity: &str, rects: Vec<ObstructionRect>) {
    let overlays = OVERLAYS.lock();
    if let Some(entry) = overlays.get(identity) {
        *entry.obstructions.lock() = rects;
    }
}

/// Read the current obstruction rects.  Called by the video thread.
pub fn get_overlay_obstructions(identity: &str) -> Vec<ObstructionRect> {
    let overlays = OVERLAYS.lock();
    overlays
        .get(identity)
        .map(|e| e.obstructions.lock().clone())
        .unwrap_or_default()
}

/// Remove all overlays from the registry (called on voice disconnect).
pub fn destroy_all_overlays() {
    let mut overlays = OVERLAYS.lock();
    for (id, entry) in overlays.drain() {
        entry.visible.store(false, Ordering::Relaxed);
        eprintln!("[Pax NativeOverlay] Unregistered overlay for '{}'", id);
    }
}

/// Get hover states for all overlays by checking cursor position against
/// each HWND's screen rect.  Called from frontend (~20fps).  No wnd_proc
/// involvement, no locks held during render.
pub fn get_all_overlay_hover_states() -> HashMap<String, bool> {
    let cursor = platform::get_cursor_pos();
    let overlays = OVERLAYS.lock();
    overlays
        .iter()
        .filter(|(_, e)| e.visible.load(Ordering::Relaxed))
        .map(|(id, e)| {
            let (left, top, right, bottom) = platform::get_hwnd_screen_rect(e.hwnd);
            let hovered = cursor.0 >= left
                && cursor.0 < right
                && cursor.1 >= top
                && cursor.1 < bottom;
            (id.clone(), hovered)
        })
        .collect()
}

/// Check if native overlay is supported on this platform.
pub fn is_supported() -> bool {
    cfg!(target_os = "windows")
}

// ─── GPU Renderer (owned by video receiver thread) ──────────────────────────

/// Align `value` up to the next multiple of `align`.
fn align_up(value: u32, align: u32) -> u32 {
    (value + align - 1) / align * align
}

/// Per-stream GPU renderer.  Created on the video receiver thread using the
/// HWND created by the main thread.  All wgpu state lives here and never
/// crosses thread boundaries.
pub struct GpuRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    // Current YUV textures (recreated when frame resolution changes)
    tex_y: Option<wgpu::Texture>,
    tex_u: Option<wgpu::Texture>,
    tex_v: Option<wgpu::Texture>,
    bind_group: Option<wgpu::BindGroup>,
    current_frame_w: u32,
    current_frame_h: u32,
    // Pre-allocated staging buffers for padded texture uploads.
    // wgpu requires bytes_per_row to be a multiple of 256.
    staging_y: Vec<u8>,
    staging_u: Vec<u8>,
    staging_v: Vec<u8>,
    // Track surface dimensions to detect resize
    surface_w: u32,
    surface_h: u32,
    // HWND for reading client rect
    hwnd: isize,
    identity: String,
    frame_count: u64,
    // Track whether HWND has been positioned/shown by video thread
    hwnd_applied_w: u32,
    hwnd_applied_h: u32,
    hwnd_visible: bool,
    // Track applied clip region to avoid redundant SetWindowRgn calls
    applied_obstructions: Vec<ObstructionRect>,
}

// SAFETY: GpuRenderer is created and used exclusively on a single thread
// (the video receiver thread).  wgpu::Surface is !Send as a conservative
// safety measure, but D3D12/D3D11 swap chains are safe to use from the
// thread that created them.  This matches the SendStream pattern used
// for cpal audio streams elsewhere in Pax.
unsafe impl Send for GpuRenderer {}

impl Drop for GpuRenderer {
    fn drop(&mut self) {
        // Destroy the HWND on the video thread (same thread that created it).
        // This is required by Win32 — DestroyWindow must be called from the
        // creating thread.
        platform::destroy_hwnd(self.hwnd);
        // Also remove from registry if it wasn't already removed
        OVERLAYS.lock().remove(&self.identity);
        eprintln!("[Pax GpuRenderer] Dropped — HWND destroyed for '{}'", self.identity);
    }
}

impl GpuRenderer {
    /// Create a new renderer.  Creates the child HWND **on this thread** (the
    /// video receiver thread) so all subsequent Win32 calls (SetWindowPos,
    /// ShowWindow) go to our own message queue — no cross-thread deadlocks.
    pub async fn new(parent_hwnd: isize, identity: String) -> Result<Self, String> {
        // Create child HWND on the video thread — this is the critical fix.
        let hwnd = create_overlay(&identity, parent_hwnd)?;

        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12 | wgpu::Backends::VULKAN,
            ..Default::default()
        });

        // Create surface from raw HWND
        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: raw_window_handle::RawDisplayHandle::Windows(
                    raw_window_handle::WindowsDisplayHandle::new(),
                ),
                raw_window_handle: {
                    let mut h = raw_window_handle::Win32WindowHandle::new(
                        std::num::NonZeroIsize::new(hwnd)
                            .ok_or("Invalid HWND (zero)")?,
                    );
                    // hinstance is optional for D3D surfaces
                    h.hinstance = None;
                    raw_window_handle::RawWindowHandle::Win32(h)
                },
            })
        }
        .map_err(|e| format!("wgpu create_surface: {}", e))?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .map_err(|e| format!("No suitable GPU adapter: {}", e))?;

        eprintln!(
            "[Pax GpuRenderer] Using adapter: {} ({:?})",
            adapter.get_info().name,
            adapter.get_info().backend
        );

        // Auto-detect best video codec based on GPU capabilities
        crate::codec::detect_best_codec(&adapter.get_info().name);

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("pax-video-overlay"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::Performance,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("wgpu request_device: {}", e))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .find(|f| !f.is_srgb()) // prefer non-sRGB for raw color output
            .or(caps.formats.first())
            .copied()
            .ok_or("No surface formats available")?;

        // Pick best present mode: Mailbox (low-latency) > Fifo (vsync fallback)
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
        } else {
            wgpu::PresentMode::Fifo
        };

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: 1,  // placeholder — real config deferred until first valid HWND size
            height: 1,
            present_mode,
            alpha_mode: wgpu::CompositeAlphaMode::Opaque,
            view_formats: vec![],
            desired_maximum_frame_latency: 1,
        };
        // NOTE: don't configure yet — deferred until HWND is sized by frontend

        // Shader + pipeline
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("yuv_shader"),
            source: wgpu::ShaderSource::Wgsl(YUV_SHADER.into()),
        });

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("yuv_bgl"),
                entries: &[
                    // tex_y
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // tex_u
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // tex_v
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // sampler
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        let pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("yuv_pl"),
                bind_group_layouts: &[&bind_group_layout],
                push_constant_ranges: &[],
            });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("yuv_pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[], // fullscreen triangle, no vertex buffer
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("yuv_sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        eprintln!(
            "[Pax GpuRenderer] Initialized: format={:?} (surface config deferred until HWND resize)",
            format
        );

        Ok(Self {
            device,
            queue,
            surface,
            surface_config,
            pipeline,
            bind_group_layout,
            sampler,
            tex_y: None,
            tex_u: None,
            tex_v: None,
            bind_group: None,
            current_frame_w: 0,
            current_frame_h: 0,
            staging_y: Vec::new(),
            staging_u: Vec::new(),
            staging_v: Vec::new(),
            surface_w: 0,
            surface_h: 0,
            hwnd,
            identity,
            frame_count: 0,
            hwnd_applied_w: 0,
            hwnd_applied_h: 0,
            hwnd_visible: false,
            applied_obstructions: Vec::new(),
        })
    }

    /// Compute the aspect-ratio-preserving dimensions to scale the source
    /// frame to before uploading to GPU.  Uses the same f64 uniform-scale
    /// approach as the WebGL fallback path for pixel-identical results.
    /// Returns (0, 0) if the overlay hasn't received a valid target rect yet.
    pub fn get_fit_dimensions(&self, src_w: u32, src_h: u32) -> (u32, u32) {
        let (_, _, target_w, target_h, _) =
            match get_overlay_target(&self.identity) {
                Some(t) => t,
                None => return (0, 0),
            };
        if target_w < 8 || target_h < 8 || src_w == 0 || src_h == 0 {
            return (0, 0);
        }
        // Same uniform-scale-factor approach as fit_dimensions() in the
        // protocol fallback path — f64 precision, applied to BOTH dimensions.
        let scale_x = target_w as f64 / src_w as f64;
        let scale_y = target_h as f64 / src_h as f64;
        let scale = scale_x.min(scale_y).min(1.0); // never upscale
        let mut w = (src_w as f64 * scale).round() as u32;
        let mut h = (src_h as f64 * scale).round() as u32;
        // I420 requires even dimensions
        w = (w / 2) * 2;
        h = (h / 2) * 2;
        (w.max(2), h.max(2))
    }

    /// Render an I420 frame to the overlay surface.
    ///
    /// The caller should pre-scale the frame to `get_fit_dimensions()` before
    /// calling this — that reduces upload bandwidth by ~15x and uses
    /// libwebrtc's SIMD scaler for better quality than GPU bilinear.
    pub fn render_frame(
        &mut self,
        data_y: &[u8],
        data_u: &[u8],
        data_v: &[u8],
        width: u32,
        height: u32,
        stride_y: u32,
        stride_u: u32,
        stride_v: u32,
    ) {
        // Drain Win32 messages to prevent main-thread deadlock during resize.
        platform::pump_messages();

        if width == 0 || height == 0 {
            return;
        }

        // Read target rect (set atomically by frontend, no mutex contention)
        let (target_x, target_y, target_w, target_h, target_visible) =
            match get_overlay_target(&self.identity) {
                Some(t) => t,
                None => return,
            };

        if target_w < 8 || target_h < 8 {
            return;
        }

        // Apply HWND position/size (thread-local, no cross-thread messaging)
        if target_w != self.hwnd_applied_w || target_h != self.hwnd_applied_h {
            platform::set_hwnd_rect(self.hwnd, target_x, target_y, target_w, target_h);
            self.hwnd_applied_w = target_w;
            self.hwnd_applied_h = target_h;
        }

        if target_visible && !self.hwnd_visible {
            platform::set_hwnd_visible(self.hwnd, true);
            self.hwnd_visible = true;
        } else if !target_visible && self.hwnd_visible {
            platform::set_hwnd_visible(self.hwnd, false);
            self.hwnd_visible = false;
        }

        if !target_visible {
            return;
        }

        // Apply clip region: subtract obstruction rects from the full HWND area.
        // Only update SetWindowRgn when obstructions actually change.
        let obstructions = get_overlay_obstructions(&self.identity);
        if obstructions != self.applied_obstructions {
            platform::apply_clip_region(self.hwnd, target_w, target_h, &obstructions);
            self.applied_obstructions = obstructions;
        }

        // Reconfigure surface on resize
        if target_w != self.surface_w || target_h != self.surface_h {
            self.surface_config.width = target_w;
            self.surface_config.height = target_h;
            self.surface.configure(&self.device, &self.surface_config);
            self.surface_w = target_w;
            self.surface_h = target_h;
        }

        // Recreate YUV textures on frame resolution change
        let cw = width / 2;
        let ch = height / 2;
        if width != self.current_frame_w || height != self.current_frame_h {
            self.recreate_textures(width, height, cw, ch);
            self.current_frame_w = width;
            self.current_frame_h = height;
        }

        // Upload Y/U/V planes
        upload_plane(&self.queue, self.tex_y.as_ref().unwrap(), data_y, stride_y, width, height, &mut self.staging_y);
        upload_plane(&self.queue, self.tex_u.as_ref().unwrap(), data_u, stride_u, cw, ch, &mut self.staging_u);
        upload_plane(&self.queue, self.tex_v.as_ref().unwrap(), data_v, stride_v, cw, ch, &mut self.staging_v);

        // Acquire swap chain frame
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.surface.configure(&self.device, &self.surface_config);
                match self.surface.get_current_texture() {
                    Ok(f) => f,
                    Err(_) => return,
                }
            }
            Err(_) => return,
        };

        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Viewport: center the (pre-scaled) frame within the container.
        // Since the caller already scaled to the correct aspect ratio,
        // the frame dimensions define the viewport directly.
        let vp_x = (target_w.saturating_sub(width)) / 2;
        let vp_y = (target_h.saturating_sub(height)) / 2;

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            pass.set_viewport(vp_x as f32, vp_y as f32, width.max(1) as f32, height.max(1) as f32, 0.0, 1.0);
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, self.bind_group.as_ref().unwrap(), &[]);
            pass.draw(0..3, 0..1);
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();

        self.frame_count += 1;
        if self.frame_count == 1 {
            eprintln!(
                "[Pax GpuRenderer] First frame rendered ({}x{} in {}x{} surface)",
                width, height, self.surface_w, self.surface_h
            );
        } else if self.frame_count % 300 == 0 {
            eprintln!("[Pax GpuRenderer] Frame {}", self.frame_count);
        }
    }

    fn recreate_textures(&mut self, w: u32, h: u32, cw: u32, ch: u32) {
        let make_tex = |device: &wgpu::Device, label: &str, tw: u32, th: u32| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: tw,
                    height: th,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };

        self.tex_y = Some(make_tex(&self.device, "tex_y", w, h));
        self.tex_u = Some(make_tex(&self.device, "tex_u", cw, ch));
        self.tex_v = Some(make_tex(&self.device, "tex_v", cw, ch));

        // Rebuild bind group with new texture views
        let view_y = self.tex_y.as_ref().unwrap().create_view(&Default::default());
        let view_u = self.tex_u.as_ref().unwrap().create_view(&Default::default());
        let view_v = self.tex_v.as_ref().unwrap().create_view(&Default::default());

        self.bind_group = Some(
            self.device
                .create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("yuv_bg"),
                    layout: &self.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&view_y),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&view_u),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(&view_v),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                }),
        );

        // Pre-allocate staging buffers for padded uploads
        let aligned_y = align_up(w, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) as usize;
        let aligned_uv = align_up(cw, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) as usize;
        self.staging_y.resize(aligned_y * h as usize, 0);
        self.staging_u.resize(aligned_uv * ch as usize, 0);
        self.staging_v.resize(aligned_uv * ch as usize, 0);

        eprintln!(
            "[Pax GpuRenderer] Textures recreated: Y={}x{} UV={}x{}",
            w, h, cw, ch
        );
    }
}

/// Upload a single I420 plane to a wgpu texture, handling stride and row alignment.
/// Free function to avoid borrow conflicts (needs &Queue + &mut staging simultaneously).
fn upload_plane(
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    data: &[u8],
    stride: u32,
    width: u32,
    height: u32,
    staging: &mut Vec<u8>,
) {
    let aligned_bpr = align_up(width, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);

    // Fast path 1: source stride already matches alignment — zero copy
    if stride == aligned_bpr {
        let len = (stride * height) as usize;
        if data.len() >= len {
            queue.write_texture(
                texture.as_image_copy(),
                &data[..len],
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(aligned_bpr),
                    rows_per_image: Some(height),
                },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
            return;
        }
    }

    // Fast path 2: source stride equals width (common for scaled I420) but
    // doesn't match alignment.  Copy each row with alignment padding.
    // This is still a memcpy but avoids per-row bounds checks.
    let dst_stride = aligned_bpr as usize;
    let src_stride = stride as usize;
    let row_bytes = width as usize;
    let needed = dst_stride * height as usize;
    if staging.len() < needed {
        staging.resize(needed, 0);
    }

    // Use copy_from_slice for each row — compiler can auto-vectorize
    for row in 0..height as usize {
        let src_start = row * src_stride;
        let dst_start = row * dst_stride;
        staging[dst_start..dst_start + row_bytes]
            .copy_from_slice(&data[src_start..src_start + row_bytes]);
    }

    queue.write_texture(
        texture.as_image_copy(),
        &staging[..needed],
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(aligned_bpr),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
}

// ─── Platform: Windows ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::Once;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    /// Convert our cross-platform isize handle to the windows-sys HWND type.
    fn to_hwnd(h: isize) -> HWND {
        h as HWND
    }

    static REGISTER: Once = Once::new();

    fn class_name() -> Vec<u16> {
        "PaxVideoOverlay\0"
            .encode_utf16()
            .collect()
    }

    fn register_class() {
        REGISTER.call_once(|| unsafe {
            let name = class_name();
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_OWNDC,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: name.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            RegisterClassExW(&wc);
        });
    }

    /// Find the deepest descendant HWND of the WebView2 — that's where
    /// Chromium actually processes mouse input (Chrome_RenderWidgetHostHWND).
    /// Walks: parent → first non-overlay child (WebView2 container) → deepest child.
    unsafe fn find_webview_input_hwnd(parent: HWND, skip_hwnd: HWND) -> HWND {
        // Step 1: find the WebView2 container (sibling of our overlay)
        let mut container = GetWindow(parent, GW_CHILD);
        while !container.is_null() {
            if container != skip_hwnd {
                break;
            }
            container = GetWindow(container, GW_HWNDNEXT);
        }
        if container.is_null() {
            return std::ptr::null_mut();
        }

        // Step 2: drill down to the deepest child (Chrome_RenderWidgetHostHWND)
        let mut target = container;
        loop {
            let child = GetWindow(target, GW_CHILD);
            if child.is_null() {
                break;
            }
            target = child;
        }
        target
    }

    /// Forward a mouse message from the overlay HWND to the WebView2 sibling.
    /// Converts coordinates from our client space → screen → WebView2 client space.
    unsafe fn forward_mouse_to_webview(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> bool {
        let webview = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as HWND;
        if webview.is_null() {
            return false;
        }

        let x = (lparam & 0xFFFF) as i16 as i32;
        let y = ((lparam >> 16) & 0xFFFF) as i16 as i32;

        // Get screen-space positions of both windows to compute offset
        let mut our_rect: RECT = std::mem::zeroed();
        let mut wv_rect: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut our_rect);
        GetWindowRect(webview, &mut wv_rect);

        // our client (x,y) → screen → webview client
        let screen_x = our_rect.left + x;
        let screen_y = our_rect.top + y;
        let wv_x = screen_x - wv_rect.left;
        let wv_y = screen_y - wv_rect.top;

        let new_lparam = ((wv_y as u16 as usize) << 16) | (wv_x as u16 as usize);
        PostMessageW(webview, msg, wparam, new_lparam as LPARAM);
        true
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            // Forward mouse messages to the WebView2 so clicks pass through
            WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK
            | WM_RBUTTONDOWN | WM_RBUTTONUP | WM_RBUTTONDBLCLK
            | WM_MBUTTONDOWN | WM_MBUTTONUP
            | WM_MOUSEMOVE => {
                if forward_mouse_to_webview(hwnd, msg, wparam, lparam) {
                    return 0;
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            // WM_MOUSEWHEEL coordinates are already in screen space
            WM_MOUSEWHEEL => {
                let webview = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as HWND;
                if !webview.is_null() {
                    PostMessageW(webview, msg, wparam, lparam);
                    return 0;
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            // Prevent the overlay from changing the cursor
            WM_SETCURSOR => 1,
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn create_child_hwnd(parent: isize) -> Result<isize, String> {
        register_class();
        unsafe {
            let name = class_name();
            let hwnd = CreateWindowExW(
                0, // no extended styles
                name.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                to_hwnd(parent),
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err(format!(
                    "CreateWindowExW failed: {}",
                    std::io::Error::last_os_error()
                ));
            }

            // Find the WebView2 sibling HWND and cache it in our window's user data.
            // This lets wnd_proc forward mouse messages without searching each time.
            let webview = find_webview_input_hwnd(to_hwnd(parent), hwnd);
            if !webview.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, webview as isize);
                eprintln!("[Pax NativeOverlay] Cached Chromium input HWND for mouse forwarding");
            } else {
                eprintln!("[Pax NativeOverlay] WARNING: Could not find Chromium input HWND");
            }

            SetWindowPos(
                hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );

            Ok(hwnd as isize)
        }
    }

    pub fn destroy_hwnd(hwnd: isize) {
        unsafe {
            DestroyWindow(to_hwnd(hwnd));
        }
    }

    pub fn set_hwnd_rect(hwnd: isize, x: i32, y: i32, w: u32, h: u32) {
        unsafe {
            SetWindowPos(
                to_hwnd(hwnd),
                HWND_TOP,
                x,
                y,
                w as i32,
                h as i32,
                SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
    }

    pub fn set_hwnd_visible(hwnd: isize, visible: bool) {
        unsafe {
            ShowWindow(to_hwnd(hwnd), if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }

    pub fn get_client_size(hwnd: isize) -> (u32, u32) {
        unsafe {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetClientRect(to_hwnd(hwnd), &mut rect) != 0 {
                (
                    (rect.right - rect.left).max(0) as u32,
                    (rect.bottom - rect.top).max(0) as u32,
                )
            } else {
                (1, 1)
            }
        }
    }

    /// Apply a clip region to the HWND that subtracts obstruction rects.
    /// If `obstructions` is empty, removes the clip region (full visibility).
    /// Coordinates are relative to the HWND's own client area.
    pub fn apply_clip_region(
        hwnd: isize,
        total_w: u32,
        total_h: u32,
        obstructions: &[super::ObstructionRect],
    ) {
        use windows_sys::Win32::Graphics::Gdi::*;
        unsafe {
            if obstructions.is_empty() {
                // Remove clip region — full HWND is visible
                SetWindowRgn(to_hwnd(hwnd), std::ptr::null_mut(), 1);
                return;
            }

            // Start with the full HWND rect
            let full = CreateRectRgn(0, 0, total_w as i32, total_h as i32);
            if full.is_null() {
                return;
            }

            // Subtract each obstruction (rounded when corner_radius matches CSS border-radius)
            for obs in obstructions {
                let obs_rgn = if obs.corner_radius > 0 {
                    let ell = (obs.corner_radius as i32).saturating_mul(2);
                    let max_ell = obs.w.min(obs.h).max(2) as i32;
                    let ell = ell.clamp(2, max_ell);
                    CreateRoundRectRgn(
                        obs.x,
                        obs.y,
                        obs.x + obs.w as i32,
                        obs.y + obs.h as i32,
                        ell,
                        ell,
                    )
                } else {
                    CreateRectRgn(
                        obs.x,
                        obs.y,
                        obs.x + obs.w as i32,
                        obs.y + obs.h as i32,
                    )
                };
                if !obs_rgn.is_null() {
                    CombineRgn(full, full, obs_rgn, RGN_DIFF);
                    DeleteObject(obs_rgn as _);
                }
            }

            // Apply.  SetWindowRgn takes ownership of the region — do NOT
            // call DeleteObject on `full` after this.
            SetWindowRgn(to_hwnd(hwnd), full, 1);
        }
    }

    /// Drain all pending Win32 messages for this thread.
    /// Must be called regularly from the video thread to prevent the main
    /// thread from deadlocking during window resize.  When the user resizes
    /// the Tauri window, Win32 sends WM_SIZE to child HWNDs.  If the child's
    /// thread never processes them → main thread blocks → freeze.
    pub fn pump_messages() {
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// Get the current cursor position in screen coordinates.
    pub fn get_cursor_pos() -> (i32, i32) {
        unsafe {
            let mut pt = POINT { x: 0, y: 0 };
            GetCursorPos(&mut pt);
            (pt.x, pt.y)
        }
    }

    /// Get the screen-space rect of a HWND: (left, top, right, bottom).
    pub fn get_hwnd_screen_rect(hwnd: isize) -> (i32, i32, i32, i32) {
        unsafe {
            let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            GetWindowRect(to_hwnd(hwnd), &mut rect);
            (rect.left, rect.top, rect.right, rect.bottom)
        }
    }
}

// ─── Platform: Linux (stub) ─────────────────────────────────────────────────

#[cfg(not(target_os = "windows"))]
mod platform {
    pub fn create_child_hwnd(_parent: isize) -> Result<isize, String> {
        Err("Native overlay not yet implemented on this platform".to_string())
    }
    pub fn destroy_hwnd(_hwnd: isize) {}
    pub fn set_hwnd_rect(_hwnd: isize, _x: i32, _y: i32, _w: u32, _h: u32) {}
    pub fn set_hwnd_visible(_hwnd: isize, _visible: bool) {}
    pub fn get_client_size(_hwnd: isize) -> (u32, u32) {
        (1, 1)
    }
    pub fn pump_messages() {}
    pub fn apply_clip_region(_hwnd: isize, _w: u32, _h: u32, _obs: &[super::ObstructionRect]) {}
    pub fn get_cursor_pos() -> (i32, i32) { (0, 0) }
    pub fn get_hwnd_screen_rect(_hwnd: isize) -> (i32, i32, i32, i32) { (0, 0, 0, 0) }
}