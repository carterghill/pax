use tauri::command;

/// Get the current codec preference.
#[command]
pub fn get_codec_preference() -> String {
    crate::codec::get_codec_preference().to_string()
}

/// Set the codec preference.  Accepts: "auto", "h264", "vp9", "av1", "vp8".
#[command]
pub fn set_codec_preference(codec: String) -> Result<(), String> {
    let pref = match codec.to_lowercase().as_str() {
        "auto" => crate::codec::CodecPreference::Auto,
        "h264" => crate::codec::CodecPreference::H264,
        "vp9" => crate::codec::CodecPreference::VP9,
        "av1" => crate::codec::CodecPreference::AV1,
        "vp8" => crate::codec::CodecPreference::VP8,
        other => return Err(format!("Unknown codec: '{}'. Valid: auto, h264, vp9, av1, vp8", other)),
    };
    crate::codec::set_codec_preference(pref);
    Ok(())
}

/// Get the currently resolved codec label (what will actually be used).
#[command]
pub fn get_resolved_codec() -> String {
    crate::codec::resolved_codec_label().to_string()
}