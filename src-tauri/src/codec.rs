//! Video codec selection for screen share publishing.
//!
//! Picks the best codec based on GPU hardware capabilities:
//!   1. H264 — universal HW encode (NVENC, AMF, QSV), great motion handling
//!   2. AV1  — best compression + SVC, but needs RTX 40+/RX 7000+/Intel Arc
//!   3. VP9  — good compression, rare HW encode but SW is fine for 30fps
//!   4. VP8  — legacy fallback
//!
//! H264 is the default because it has near-universal hardware encode support
//! and dramatically better motion compensation than VP8.  The bitrate targets
//! are kept the same — H264 at VP8's bitrate produces noticeably higher quality.

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
/// If `Auto`, returns the auto-detected codec (or H264 if detection
/// hasn't run yet).
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
                .unwrap_or(VideoCodec::H264) // safe default if not yet detected
        }
    }
}

/// Detect the best codec based on the GPU adapter name.
///
/// Call this once at startup (e.g. after the first wgpu adapter is created).
/// The result is cached and used when the preference is `Auto`.
///
/// Detection logic:
///   - NVIDIA RTX 40xx/50xx → AV1 (NVENC AV1 support)
///   - NVIDIA anything else → H264 (NVENC H264, universal)
///   - AMD RX 7000+/RX 9000+ → AV1 (AMF AV1)
///   - AMD anything else → H264 (AMF H264)
///   - Intel Arc → AV1 (QSV AV1)
///   - Intel anything else → H264 (QSV H264)
///   - Unknown → H264 (OpenH264 software fallback)
pub fn detect_best_codec(adapter_name: &str) {
    let name = adapter_name.to_uppercase();

    let codec = if name.contains("NVIDIA") || name.contains("GEFORCE") {
        if has_nvidia_av1_support(&name) {
            eprintln!("[Pax Codec] Detected NVIDIA with AV1 encode support");
            VideoCodec::AV1
        } else {
            eprintln!("[Pax Codec] Detected NVIDIA — using H264 (NVENC)");
            VideoCodec::H264
        }
    } else if name.contains("AMD") || name.contains("RADEON") {
        if has_amd_av1_support(&name) {
            eprintln!("[Pax Codec] Detected AMD with AV1 encode support");
            VideoCodec::AV1
        } else {
            eprintln!("[Pax Codec] Detected AMD — using H264 (AMF)");
            VideoCodec::H264
        }
    } else if name.contains("INTEL") {
        if name.contains("ARC") {
            eprintln!("[Pax Codec] Detected Intel Arc — using AV1 (QSV)");
            VideoCodec::AV1
        } else {
            eprintln!("[Pax Codec] Detected Intel — using H264 (QSV)");
            VideoCodec::H264
        }
    } else {
        eprintln!("[Pax Codec] Unknown GPU '{}' — using H264 (software fallback)", adapter_name);
        VideoCodec::H264
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
    // RTX 40xx, 50xx series have AV1 NVENC
    for prefix in ["RTX 40", "RTX 50", "RTX 60"] {
        if name.contains(prefix) {
            return true;
        }
    }
    // Also check for specific professional cards
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