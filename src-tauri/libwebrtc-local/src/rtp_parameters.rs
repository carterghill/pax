// Copyright 2025 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use crate::rtp_transceiver::RtpTransceiverDirection;

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum Priority {
    VeryLow,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone)]
pub struct RtpHeaderExtensionParameters {
    pub uri: String,
    pub id: i32,
    pub encrypted: bool,
}

/// Matches WebRTC / libwebrtc `DegradationPreference` (from `getParameters`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DegradationPreference {
    Disabled,
    MaintainFramerate,
    MaintainResolution,
    Balanced,
}

#[derive(Debug, Clone)]
pub struct RtpParameters {
    pub transaction_id: String,
    pub mid: String,
    pub codecs: Vec<RtpCodecParameters>,
    pub header_extensions: Vec<RtpHeaderExtensionParameters>,
    pub encodings: Vec<RtpEncodingParameters>,
    pub rtcp: RtcpParameters,
    /// Preserved from `getParameters`; must be round-tripped for `setParameters` to succeed.
    pub degradation_preference: Option<DegradationPreference>,
}

#[derive(Debug, Clone, Default)]
pub struct RtpCodecParameters {
    pub payload_type: u8,
    pub mime_type: String, // read-only
    pub clock_rate: Option<u64>,
    pub channels: Option<u16>,
}

#[derive(Debug, Clone, Default)]
pub struct RtcpParameters {
    pub cname: String,
    pub reduced_size: bool,
    pub mux: bool,
    /// RTP SSRC for RTCP when present; required for `setParameters` parity with libwebrtc.
    pub ssrc: Option<u32>,
}

/// Default `bitrate_priority` from WebRTC (must match when round-tripping `RtpEncodingParameters`).
pub const DEFAULT_ENCODING_BITRATE_PRIORITY: f64 = 1.0;

#[derive(Debug, Clone)]
pub struct RtpEncodingParameters {
    pub active: bool,
    pub max_bitrate: Option<u64>,
    pub max_framerate: Option<f64>,
    pub priority: Priority,
    pub rid: String,
    pub scale_resolution_down_by: Option<f64>,
    pub bitrate_priority: f64,
    /// Per-encoding SSRC when assigned; must be preserved across `setParameters`.
    pub ssrc: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct RtpCodecCapability {
    pub channels: Option<u16>,
    pub clock_rate: Option<u64>,
    pub mime_type: String,
    pub sdp_fmtp_line: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RtpHeaderExtensionCapability {
    pub uri: String,
    pub direction: RtpTransceiverDirection,
}

#[derive(Debug, Clone)]
pub struct RtpCapabilities {
    pub codecs: Vec<RtpCodecCapability>,
    pub header_extensions: Vec<RtpHeaderExtensionCapability>,
}

impl Default for RtpEncodingParameters {
    fn default() -> Self {
        Self {
            active: true,
            max_bitrate: None,
            max_framerate: None,
            priority: Priority::Low,
            rid: String::default(),
            scale_resolution_down_by: None,
            bitrate_priority: DEFAULT_ENCODING_BITRATE_PRIORITY,
            ssrc: None,
        }
    }
}
