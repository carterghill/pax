//! Feed camera frames from the WebView into native WebRTC and publish them in LiveKit calls.
use super::{LocalTrack, LocalVideoTrack, TrackPublishOptions, TrackSource, VoiceManager};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegDecoder, DynamicImage, ImageDecoder};
use libwebrtc::{
    video_frame::{I420Buffer, VideoFrame, VideoRotation},
    video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
};
use tauri::State;

pub(super) struct CameraPublication {
    capture: CameraCapture,
    track: LocalVideoTrack,
}

pub(crate) struct CameraCapture {
    pub id: String,
    pub source: NativeVideoSource,
    width: u32,
    height: u32,
}

fn decode_frame(jpeg: &str, width: u32, height: u32) -> Result<VideoFrame<I420Buffer>, String> {
    if !(2..=640).contains(&width) || !(2..=640).contains(&height) || jpeg.len() > 1_048_576 {
        return Err("Invalid camera frame dimensions or size".into());
    }
    let bytes = STANDARD.decode(jpeg).map_err(|_| "Invalid camera frame")?;
    let decoder = JpegDecoder::new(bytes.as_slice()).map_err(|e| e.to_string())?;
    if decoder.dimensions() != (width, height) {
        return Err("Camera frame size changed".into());
    }
    let rgba = DynamicImage::from_decoder(decoder)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let mut buffer = I420Buffer::new(width, height);
    let (sy, su, sv) = buffer.strides();
    let (y, u, v) = buffer.data_mut();
    libwebrtc::native::yuv_helper::abgr_to_i420(
        &rgba,
        width * 4,
        y,
        sy,
        u,
        su,
        v,
        sv,
        width as i32,
        height as i32,
    );
    Ok(VideoFrame {
        rotation: VideoRotation::VideoRotation0,
        timestamp_us: 0,
        buffer,
    })
}

impl CameraCapture {
    pub fn open(id: String, width: u32, height: u32, jpeg: &str) -> Result<Self, String> {
        let first = decode_frame(jpeg, width, height)?;
        let source = NativeVideoSource::new(VideoResolution { width, height }, false);
        source.capture_frame(&first);
        Ok(Self {
            id,
            source,
            width,
            height,
        })
    }

    pub fn push(&self, jpeg: &str) -> Result<(), String> {
        self.source
            .capture_frame(&decode_frame(jpeg, self.width, self.height)?);
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn voice_start_camera(
    voice_mgr: State<'_, VoiceManager>,
    attempt_id: String,
    camera_id: String,
    width: u32,
    height: u32,
    jpeg: String,
) -> Result<(), String> {
    let (room, camera) = {
        let session = voice_mgr.session.lock();
        let session = session
            .as_ref()
            .filter(|s| s.audio_state.lock().attempt_id == attempt_id)
            .ok_or("The voice call has ended")?;
        (session.room.clone(), session.camera.clone())
    };
    let mut current = camera.lock().await;
    if current.is_some() {
        return Err("A camera is already active in this call".into());
    }
    let capture = CameraCapture::open(camera_id, width, height, &jpeg)?;
    let track = LocalVideoTrack::create_video_track(
        "camera",
        RtcVideoSource::Native(capture.source.clone()),
    );
    room.local_participant()
        .publish_track(
            LocalTrack::Video(track.clone()),
            TrackPublishOptions {
                source: TrackSource::Camera,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| format!("Could not share the camera: {e}"))?;
    *current = Some(CameraPublication { capture, track });
    Ok(())
}

#[tauri::command]
pub(crate) async fn voice_camera_frame(
    voice_mgr: State<'_, VoiceManager>,
    camera_id: String,
    jpeg: String,
) -> Result<(), String> {
    let slot = voice_mgr
        .session
        .lock()
        .as_ref()
        .map(|s| s.camera.clone())
        .ok_or("The call has ended")?;
    let current = slot.lock().await;
    let camera = current
        .as_ref()
        .filter(|c| c.capture.id == camera_id)
        .ok_or("The camera has stopped")?;
    camera.capture.push(&jpeg)
}

#[tauri::command]
pub(crate) async fn voice_stop_camera(
    voice_mgr: State<'_, VoiceManager>,
    camera_id: String,
) -> Result<(), String> {
    let session = voice_mgr
        .session
        .lock()
        .as_ref()
        .map(|s| (s.room.clone(), s.camera.clone()));
    if let Some((room, slot)) = session {
        let mut current = slot.lock().await;
        if current.as_ref().is_some_and(|c| c.capture.id == camera_id) {
            let camera = current.take().unwrap();
            camera.track.mute();
            room.local_participant()
                .unpublish_track(&camera.track.sid())
                .await
                .map_err(|e| format!("Could not unpublish the camera: {e}"))?;
        }
    }
    Ok(())
}
