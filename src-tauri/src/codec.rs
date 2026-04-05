//! Video codec selection for screen share publishing.
//!
//! Picks the best codec based on GPU hardware capabilities AND what
//! hardware encoders were actually compiled into this build:
//!
//! Cascade:  HW-accelerated H264 → VP9 (libvpx) → VP8 (ultimate fallback)
//!
//! The key insight: just because a GPU *supports* hardware encoding doesn't
//! mean the encoder was compiled in.  On Windows, NVENC requires the CUDA SDK
//! at build time and VA-API (AMD/Intel) isn't wired up yet.  So an AMD GPU on
//! Windows gets VP9 (libvpx software, but with a good screen-content mode)
//! rather than H264 via OpenH264 (which can't keep up at native res).
//!
//! Compile-time cfg flags from build.rs:
//!   has_nvenc         — NVIDIA NVENC encoder compiled in
//!   has_vaapi         — VA-API encoder compiled in (Linux x86)
//!   has_videotoolbox  — Apple VideoToolbox (macOS/iOS, always available)

use livekit::options::VideoCodec;
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// User-facing codec preference.  Maps to `livekit::options::VideoCodec`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodecPreference {
    Auto,
    H264,
    VP9,
    AV1,
    VP8,
}

impl Default for CodecPreference {
    fn default() -> Self {
        Self::Auto
    }
}

impl std::fmt::Display for CodecPreference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auto => write!(f, "auto"),
            Self::H264 => write!(f, "h264"),
            Self::VP9 => write!(f, "vp9"),
            Self::AV1 => write!(f, "av1"),
            Self::VP8 => write!(f, "vp8"),
        }
    }
}

/// Global codec preference.  Set by auto-detection or user override.
static CODEC_PREFERENCE: Lazy<RwLock<CodecPreference>> =
    Lazy::new(|| RwLock::new(CodecPreference::default()));

/// Cached auto-detected codec (computed once, reused).
static DETECTED_CODEC: Lazy<RwLock<Option<VideoCodec>>> =
    Lazy::new(|| RwLock::new(None));

pub fn get_codec_preference() -> CodecPreference {
    *CODEC_PREFERENCE.read()
}

pub fn set_codec_preference(pref: CodecPreference) {
    *CODEC_PREFERENCE.write() = pref;
    eprintln!("[Pax Codec] Preference set to: {}", pref);
}

/// Resolve the current preference to a concrete `VideoCodec`.
/// If `Auto`, returns the auto-detected codec (or VP9 as a safe default
/// if detection hasn't run yet — VP9 libvpx always works).
pub fn resolve_codec() -> VideoCodec {
    let pref = *CODEC_PREFERENCE.read();
    match pref {
        CodecPreference::H264 => VideoCodec::H264,
        CodecPreference::VP9 => VideoCodec::VP9,
        CodecPreference::AV1 => VideoCodec::AV1,
        CodecPreference::VP8 => VideoCodec::VP8,
        CodecPreference::Auto => {
            DETECTED_CODEC
                .read()
                .unwrap_or(VideoCodec::VP9) // safe default — libvpx always works
        }
    }
}

// ── Compile-time hardware encoder availability ──────────────────────────

/// Returns true if this build has a hardware H264 encoder for NVIDIA GPUs.
fn has_hw_h264_nvidia() -> bool {
    cfg!(has_nvenc)
}

/// Returns true if this build has a hardware H264 encoder via VA-API
/// (covers AMD and Intel on Linux).
fn has_hw_h264_vaapi() -> bool {
    cfg!(has_vaapi)
}

/// Returns true if this build has VideoToolbox (Apple platforms).
fn has_hw_videotoolbox() -> bool {
    cfg!(has_videotoolbox)
}

/// Detect the best codec based on GPU adapter name AND what encoders
/// were actually compiled into this build.
///
/// Call this once at startup (after the wgpu adapter probe).
/// The result is cached and used when the preference is `Auto`.
///
/// Cascade per GPU vendor:
///
///   NVIDIA + has_nvenc:
///     RTX 40xx/50xx → AV1 (NVENC AV1)
///     Anything else → H264 (NVENC H264)
///   NVIDIA without has_nvenc → VP9
///
///   AMD + has_vaapi (Linux):
///     RX 7000+/9000+ → AV1 (if supported)
///     Anything else → H264 (VA-API H264)
///   AMD without has_vaapi (Windows) → VP9
///
///   Intel + has_vaapi (Linux):
///     Arc → AV1
///     Anything else → H264 (VA-API H264)
///   Intel without has_vaapi → VP9
///
///   Apple (has_videotoolbox) → H264 (VideoToolbox)
///
///   Unknown → VP9 (safe software fallback)
pub fn detect_best_codec(adapter_name: &str) {
    let name = adapter_name.to_uppercase();

    let codec = if name.contains("NVIDIA") || name.contains("GEFORCE") {
        if has_hw_h264_nvidia() {
            if has_nvidia_av1_support(&name) {
                eprintln!("[Pax Codec] NVIDIA with AV1 (NVENC AV1)");
                VideoCodec::AV1
            } else {
                eprintln!("[Pax Codec] NVIDIA → H264 (NVENC)");
                VideoCodec::H264
            }
        } else {
            eprintln!(
                "[Pax Codec] NVIDIA detected but NVENC not compiled in — falling back to VP9"
            );
            VideoCodec::VP9
        }
    } else if name.contains("AMD") || name.contains("RADEON") {
        if has_hw_h264_vaapi() {
            if has_amd_av1_support(&name) {
                eprintln!("[Pax Codec] AMD with AV1 (VA-API)");
                VideoCodec::AV1
            } else {
                eprintln!("[Pax Codec] AMD → H264 (VA-API)");
                VideoCodec::H264
            }
        } else {
            eprintln!(
                "[Pax Codec] AMD detected but no HW encoder available — using VP9 (libvpx)"
            );
            VideoCodec::VP9
        }
    } else if name.contains("INTEL") {
        if has_hw_videotoolbox() {
            // Intel Mac (unlikely these days, but handle it)
            eprintln!("[Pax Codec] Intel (macOS) → H264 (VideoToolbox)");
            VideoCodec::H264
        } else if has_hw_h264_vaapi() {
            if name.contains("ARC") {
                eprintln!("[Pax Codec] Intel Arc → AV1 (VA-API)");
                VideoCodec::AV1
            } else {
                eprintln!("[Pax Codec] Intel → H264 (VA-API)");
                VideoCodec::H264
            }
        } else {
            eprintln!(
                "[Pax Codec] Intel detected but no HW encoder available — using VP9 (libvpx)"
            );
            VideoCodec::VP9
        }
    } else if has_hw_videotoolbox() {
        // Apple Silicon or other Apple GPU
        eprintln!("[Pax Codec] Apple GPU → H264 (VideoToolbox)");
        VideoCodec::H264
    } else {
        eprintln!(
            "[Pax Codec] Unknown GPU '{}' — using VP9 (libvpx software)",
            adapter_name
        );
        VideoCodec::VP9
    };

    *DETECTED_CODEC.write() = Some(codec);
    eprintln!(
        "[Pax Codec] Auto-detected: {:?} for '{}'",
        codec, adapter_name
    );
}

/// Check if an NVIDIA GPU supports AV1 hardware encode.
/// AV1 NVENC was introduced with Ada Lovelace (RTX 40 series).
fn has_nvidia_av1_support(name: &str) -> bool {
    for prefix in ["RTX 40", "RTX 50", "RTX 60"] {
        if name.contains(prefix) {
            return true;
        }
    }
    if name.contains("L40") || name.contains("L20") || name.contains("ADA") {
        return true;
    }
    false
}

/// Check if an AMD GPU supports AV1 hardware encode.
/// AV1 AMF was introduced with RDNA 3 (RX 7000 series).
fn has_amd_av1_support(name: &str) -> bool {
    for prefix in ["RX 7", "RX 8", "RX 9"] {
        if name.contains(prefix) {
            return true;
        }
    }
    false
}

/// Resolve the codec for screen sharing.
///
/// This is identical to `resolve_codec()` now that detection is honest
/// about hardware availability.  Kept as a separate function so screen-share
/// specific overrides can be added later (e.g. preferring screen-content
/// optimised codecs) without touching the general path.
pub fn resolve_screen_share_codec() -> VideoCodec {
    resolve_codec()
}

/// Get a human-readable label for the currently resolved codec.
pub fn resolved_codec_label() -> &'static str {
    match resolve_codec() {
        VideoCodec::H264 => "H264",
        VideoCodec::VP9 => "VP9",
        VideoCodec::AV1 => "AV1",
        VideoCodec::VP8 => "VP8",
        _ => "Unknown",
    }
}