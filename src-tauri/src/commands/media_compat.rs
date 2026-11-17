//! Fallback conversion for videos WebKitGTK refuses to play inline.
//!
//! WebKitGTK only accepts a narrow set of codec/container combos in `<video>`
//! — it rejects e.g. VP9 inside MP4 even when every decoder is installed,
//! while Chromium (Windows WebView2) plays the same file fine.  When the
//! frontend hits a playback error it retries the media URL with `compat=1`,
//! which lands here: download the original, probe it with GStreamer, then
//! produce a playable file with the cheapest operation that fixes it —
//! stream-copy rewrap when only the container is wrong, full transcode to
//! VP8/Opus WebM as a last resort (those encoders ship in gst-plugins-good
//! everywhere).  Results are cached in the temp dir for the session and
//! wiped on startup (see `setup::cleanup_temp_files`).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use matrix_sdk::media::{MediaRequestParameters, UniqueKey};
use matrix_sdk::Client;

use crate::AppState;

use super::media_protocol::{
    get_matrix_media_bytes_with_timeout, get_plain_matrix_file_bytes_direct,
    media_protocol_response, parse_media_byte_range, MATRIX_IMAGE_FULL_FETCH_TIMEOUT,
};

const CONVERT_TIMEOUT: Duration = Duration::from_secs(300);

pub(super) async fn serve_compat_media(
    state: &Arc<AppState>,
    client: &Client,
    params: &MediaRequestParameters,
    range_header: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    let key = compat_cache_key(params);
    let lock = compat_lock(&key);
    let _held = lock.lock().await;

    let output = match ensure_compat_file(state, client, params, &key).await {
        Ok(path) => path,
        Err(e) => {
            log::warn!("[media compat] {key}: {e}");
            return media_protocol_response(502, e);
        }
    };
    serve_file_range(&output, range_header)
}

fn compat_cache_key(params: &MediaRequestParameters) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    params.unique_key().hash(&mut h);
    format!("{:016x}", h.finish())
}

/// One conversion per media item at a time; concurrent range requests for the
/// same video wait for the first to finish instead of transcoding N times.
fn compat_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let map = LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    map.lock()
        .expect("compat lock map poisoned")
        .entry(key.to_string())
        .or_default()
        .clone()
}

async fn ensure_compat_file(
    state: &Arc<AppState>,
    client: &Client,
    params: &MediaRequestParameters,
    key: &str,
) -> Result<PathBuf, String> {
    let dir = super::temp_dir();
    for ext in ["webm", "mp4"] {
        let cached = dir.join(format!("pax_video_compat_{key}.{ext}"));
        if cached.is_file() {
            return Ok(cached);
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir create failed: {e}"))?;

    let started = Instant::now();
    let bytes = match get_plain_matrix_file_bytes_direct(
        state,
        client,
        params,
        MATRIX_IMAGE_FULL_FETCH_TIMEOUT,
    )
    .await
    {
        Ok(b) => b,
        Err(e) => {
            log::info!("[media compat] {key}: direct fetch unavailable ({e}); using matrix-sdk");
            get_matrix_media_bytes_with_timeout(client, params, false, MATRIX_IMAGE_FULL_FETCH_TIMEOUT)
                .await?
        }
    };
    let downloaded_ms = started.elapsed().as_millis();

    let input = dir.join(format!("pax_video_compat_{key}.src"));
    std::fs::write(&input, &bytes).map_err(|e| format!("input temp write failed: {e}"))?;
    drop(bytes);

    let result = tokio::task::spawn_blocking({
        let input = input.clone();
        let dir = dir.clone();
        let key = key.to_string();
        move || convert_to_playable(&input, &dir, &key)
    })
    .await
    .map_err(|e| format!("conversion task panicked: {e}"))
    .and_then(|r| r);

    let _ = std::fs::remove_file(&input);
    let output = result?;
    log::info!(
        "[media compat] {key}: ready at {} (download={}ms total={}ms)",
        output.display(),
        downloaded_ms,
        started.elapsed().as_millis(),
    );
    Ok(output)
}

struct MediaProbe {
    container: String,
    video: Option<String>,
    audio: Option<String>,
    audio_is_aac: bool,
    audio_is_webm_native: bool,
    width: u32,
    height: u32,
}

fn caps_first_name(caps: &gstreamer::Caps) -> String {
    caps.structure(0)
        .map(|s| s.name().to_string())
        .unwrap_or_default()
}

fn probe_media(input: &Path) -> Result<MediaProbe, String> {
    use gstreamer_pbutils::prelude::*;

    let discoverer = gstreamer_pbutils::Discoverer::new(gstreamer::ClockTime::from_seconds(20))
        .map_err(|e| format!("discoverer init failed: {e}"))?;
    let uri = gstreamer::glib::filename_to_uri(input, None)
        .map_err(|e| format!("input uri failed: {e}"))?;
    let info = discoverer
        .discover_uri(&uri)
        .map_err(|e| format!("probe failed: {e}"))?;

    let container = info
        .stream_info()
        .and_then(|s| s.caps())
        .map(|c| caps_first_name(&c))
        .unwrap_or_default();

    let video_streams = info.video_streams();
    let video_info = video_streams.first();
    let video = video_info
        .and_then(|s| s.caps())
        .map(|c| caps_first_name(&c));
    let (width, height) = video_info
        .map(|s| (s.width(), s.height()))
        .unwrap_or((0, 0));

    let audio_streams = info.audio_streams();
    let audio_caps = audio_streams.first().and_then(|s| s.caps());
    let audio = audio_caps.as_ref().map(caps_first_name);
    let audio_is_aac = audio_caps
        .as_ref()
        .and_then(|c| c.structure(0))
        .map(|s| {
            s.name() == "audio/mpeg" && s.get::<i32>("mpegversion").map(|v| v == 4).unwrap_or(false)
        })
        .unwrap_or(false);
    let audio_is_webm_native = matches!(audio.as_deref(), Some("audio/x-opus" | "audio/x-vorbis"));

    Ok(MediaProbe {
        container,
        video,
        audio,
        audio_is_aac,
        audio_is_webm_native,
        width,
        height,
    })
}

fn element_exists(name: &str) -> bool {
    gstreamer::ElementFactory::find(name).is_some()
}

fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

/// Build the cheapest pipeline that fixes the file, or `None` when only a
/// full transcode will do.  Returns (output extension, pipeline description).
fn copy_plan(probe: &MediaProbe, input: &Path, output: &Path) -> Option<(&'static str, String)> {
    let demux = match probe.container.as_str() {
        "video/quicktime" | "application/x-3gp" => "qtdemux",
        "video/x-matroska" | "video/webm" => "matroskademux",
        _ => return None,
    };
    let src = quoted(input);
    let dst = quoted(output);

    match probe.video.as_deref() {
        // WebKitGTK rejects VP8/VP9 inside MP4 but plays them in WebM — pure
        // container swap, video stream copied untouched.
        Some("video/x-vp9" | "video/x-vp8") => {
            let audio = match &probe.audio {
                None => String::new(),
                Some(_) if probe.audio_is_webm_native => " d.audio_0 ! queue ! mux.".to_string(),
                Some(_) => " d.audio_0 ! queue ! decodebin ! audioconvert ! audioresample ! opusenc bitrate=128000 ! mux.".to_string(),
            };
            Some((
                "webm",
                format!(
                    "filesrc location={src} ! {demux} name=d webmmux name=mux ! filesink location={dst} d.video_0 ! queue ! mux.{audio}"
                ),
            ))
        }
        Some("video/x-av1") if element_exists("av1parse") => {
            let audio = match &probe.audio {
                None => String::new(),
                Some(_) if probe.audio_is_webm_native => " d.audio_0 ! queue ! mux.".to_string(),
                Some(_) => " d.audio_0 ! queue ! decodebin ! audioconvert ! audioresample ! opusenc bitrate=128000 ! mux.".to_string(),
            };
            Some((
                "webm",
                format!(
                    "filesrc location={src} ! {demux} name=d webmmux name=mux ! filesink location={dst} d.video_0 ! queue ! av1parse ! mux.{audio}"
                ),
            ))
        }
        // H.264 itself plays fine; the rejection came from the container
        // (mkv) or the audio codec (e.g. AC-3 in an mp4).  An mp4-with-aac
        // source has neither problem, so a remux can't be the fix — fall
        // through to transcode for whatever else is wrong.
        Some("video/x-h264") => {
            let already_fine_mp4 = demux == "qtdemux" && (probe.audio.is_none() || probe.audio_is_aac);
            if already_fine_mp4 {
                return None;
            }
            let audio = match &probe.audio {
                None => String::new(),
                Some(_) if probe.audio_is_aac => " d.audio_0 ! queue ! aacparse ! mux.".to_string(),
                Some(_) if element_exists("avenc_aac") => " d.audio_0 ! queue ! decodebin ! audioconvert ! audioresample ! avenc_aac bitrate=160000 ! aacparse ! mux.".to_string(),
                Some(_) => return None,
            };
            Some((
                "mp4",
                format!(
                    "filesrc location={src} ! {demux} name=d mp4mux name=mux faststart=true ! filesink location={dst} d.video_0 ! queue ! h264parse ! mux.{audio}"
                ),
            ))
        }
        _ => None,
    }
}

fn transcode_plan(probe: &MediaProbe, input: &Path, output: &Path) -> (&'static str, String) {
    let pixels = u64::from(probe.width.max(1)) * u64::from(probe.height.max(1));
    let bitrate = (pixels * 2).clamp(800_000, 6_000_000);
    let audio = if probe.audio.is_some() {
        " d. ! audioconvert ! audioresample ! queue ! opusenc bitrate=128000 ! mux."
    } else {
        ""
    };
    (
        "webm",
        format!(
            "filesrc location={src} ! decodebin name=d webmmux name=mux ! filesink location={dst} \
             d. ! videoconvert ! queue ! vp8enc deadline=1 cpu-used=8 threads=4 target-bitrate={bitrate} keyframe-max-dist=120 ! queue ! mux.{audio}",
            src = quoted(input),
            dst = quoted(output),
        ),
    )
}

fn convert_to_playable(input: &Path, dir: &Path, key: &str) -> Result<PathBuf, String> {
    gstreamer::init().map_err(|e| format!("GStreamer init failed: {e}"))?;

    let probe = probe_media(input)?;
    log::info!(
        "[media compat] {key}: probed container={} video={} audio={} {}x{}",
        probe.container,
        probe.video.as_deref().unwrap_or("<none>"),
        probe.audio.as_deref().unwrap_or("<none>"),
        probe.width,
        probe.height,
    );
    if probe.video.is_none() {
        return Err("no video stream found".to_string());
    }

    // Pipelines write to a .part file so an interrupted conversion is never
    // mistaken for a finished one.
    let part = dir.join(format!("pax_video_compat_{key}.part"));

    if let Some((ext, pipeline)) = copy_plan(&probe, input, &part) {
        log::info!("[media compat] {key}: rewrap pipeline: {pipeline}");
        match run_pipeline(&pipeline, CONVERT_TIMEOUT) {
            Ok(()) => return finalize_output(dir, key, ext, &part),
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                log::warn!("[media compat] {key}: rewrap failed ({e}); falling back to transcode");
            }
        }
    }

    let (ext, pipeline) = transcode_plan(&probe, input, &part);
    log::info!("[media compat] {key}: transcode pipeline: {pipeline}");
    match run_pipeline(&pipeline, CONVERT_TIMEOUT) {
        Ok(()) => finalize_output(dir, key, ext, &part),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(format!("transcode failed: {e}"))
        }
    }
}

fn finalize_output(dir: &Path, key: &str, ext: &str, part: &Path) -> Result<PathBuf, String> {
    let non_trivial = std::fs::metadata(part).map(|m| m.len() > 0).unwrap_or(false);
    if !non_trivial {
        let _ = std::fs::remove_file(part);
        return Err("conversion produced an empty file".to_string());
    }
    let output = dir.join(format!("pax_video_compat_{key}.{ext}"));
    std::fs::rename(part, &output).map_err(|e| format!("output rename failed: {e}"))?;
    Ok(output)
}

fn run_pipeline(desc: &str, timeout: Duration) -> Result<(), String> {
    use gstreamer::prelude::*;

    let pipeline = gstreamer::parse::launch(desc)
        .map_err(|e| format!("pipeline parse failed: {e}"))?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| "parsed element is not a pipeline".to_string())?;
    let bus = pipeline.bus().ok_or("pipeline has no bus")?;
    pipeline
        .set_state(gstreamer::State::Playing)
        .map_err(|e| format!("pipeline start failed: {e}"))?;

    let deadline = Instant::now() + timeout;
    let result = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Err("conversion timed out".to_string());
        }
        let msg = bus.timed_pop_filtered(
            Some(gstreamer::ClockTime::from_mseconds(remaining.as_millis() as u64)),
            &[gstreamer::MessageType::Eos, gstreamer::MessageType::Error],
        );
        use gstreamer::MessageView;
        match msg.as_ref().map(|m| m.view()) {
            Some(MessageView::Eos(_)) => break Ok(()),
            Some(MessageView::Error(e)) => {
                break Err(format!("pipeline error: {} ({:?})", e.error(), e.debug()))
            }
            None => break Err("conversion timed out".to_string()),
            _ => continue,
        }
    };
    let _ = pipeline.set_state(gstreamer::State::Null);
    result
}

fn serve_file_range(path: &Path, range_header: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let content_type = if path.extension().and_then(|e| e.to_str()) == Some("webm") {
        "video/webm"
    } else {
        "video/mp4"
    };
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) => return media_protocol_response(500, format!("compat file stat failed: {e}")),
    };

    let range = range_header.and_then(parse_media_byte_range);
    let (status, start, end) = match range {
        Some(r) if r.start >= len => {
            return tauri::http::Response::builder()
                .status(416)
                .header("access-control-allow-origin", "*")
                .header("content-range", format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap_or_else(|_| media_protocol_response(500, Vec::new()));
        }
        Some(r) => (206, r.start, r.end.min(len.saturating_sub(1))),
        None => (200, 0, len.saturating_sub(1)),
    };

    let read_len = (end - start + 1) as usize;
    let mut body = vec![0u8; read_len];
    let read = std::fs::File::open(path).and_then(|mut f| {
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut body)
    });
    if let Err(e) = read {
        return media_protocol_response(500, format!("compat file read failed: {e}"));
    }

    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("access-control-allow-origin", "*")
        .header("cache-control", "private, max-age=3600")
        .header("content-type", content_type)
        .header("content-length", body.len().to_string())
        .header("accept-ranges", "bytes")
        .header("content-disposition", "inline");
    if status == 206 {
        builder = builder.header("content-range", format!("bytes {start}-{end}/{len}"));
    }
    builder
        .body(body)
        .unwrap_or_else(|_| media_protocol_response(500, Vec::new()))
}
