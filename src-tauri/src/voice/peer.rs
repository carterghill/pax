use libwebrtc::{
    audio_track::RtcAudioTrack,
    ice_candidate::IceCandidate,
    media_stream_track::MediaStreamTrack,
    peer_connection::{
        AnswerOptions, IceGatheringState, OfferOptions, PeerConnection, PeerConnectionState,
    },
    peer_connection_factory::{
        native::PeerConnectionFactoryExt, ContinualGatheringPolicy, PeerConnectionFactory,
        RtcConfiguration,
    },
    session_description::{SdpType, SessionDescription},
};
use serde::{Deserialize, Serialize};

use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Candidate {
    pub candidate: String,
    #[serde(rename = "sdpMid", skip_serializing_if = "Option::is_none")]
    pub mid: Option<String>,
    #[serde(rename = "sdpMLineIndex", skip_serializing_if = "Option::is_none")]
    pub line: Option<i32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Description {
    #[serde(rename = "type")]
    pub kind: String,
    pub sdp: String,
}

impl Description {
    pub fn parse(&self) -> Result<SessionDescription, String> {
        let kind = self.kind.parse::<SdpType>().map_err(str::to_owned)?;
        SessionDescription::parse(&self.sdp, kind)
            .map_err(|_| "The peer sent an invalid WebRTC session description.".into())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerStatus<'a> {
    call_id: &'a str,
    status: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerCandidate<'a> {
    call_id: &'a str,
    candidate: Candidate,
}

pub(crate) struct PeerMedia {
    pub id: String,
    pub room_id: String,
    pc: PeerConnection,
    track: RtcAudioTrack,
    source: NativeAudioSource,
    audio: Arc<Mutex<AudioState>>,
    remote_mids: Mutex<Vec<Option<String>>>,
    streams: Option<(AudioStream, AudioStream)>,
    stop: tokio_util::sync::CancellationToken,
}

impl PeerMedia {
    pub fn open(
        app: &AppHandle,
        id: String,
        room_id: String,
        ice_servers: Vec<libwebrtc::peer_connection_factory::IceServer>,
    ) -> Result<Self, String> {
        let peer = Self::new(id, room_id, ice_servers)?;
        let pc = &peer.pc;
        let app_status = app.clone();
        let status_id = peer.id.clone();
        pc.on_connection_state_change(Some(Box::new(move |status| {
            log::info!("Matrix WebRTC connection is {status:?}");
            let status = match status {
                PeerConnectionState::Connected => "connected",
                PeerConnectionState::Disconnected => "disconnected",
                PeerConnectionState::Failed => "failed",
                _ => return,
            };
            let _ = app_status.emit(
                "matrix-voip-status",
                PeerStatus {
                    call_id: &status_id,
                    status,
                },
            );
        })));
        let app_ice = app.clone();
        let ice_id = peer.id.clone();
        pc.on_ice_candidate(Some(Box::new(move |candidate| {
            let candidate = Candidate::from(candidate);
            log::info!("Matrix WebRTC gathered a {} ICE candidate", candidate.kind());
            let _ = app_ice.emit(
                "matrix-voip-ice",
                PeerCandidate {
                    call_id: &ice_id,
                    candidate,
                },
            );
        })));
        pc.on_ice_candidate_error(Some(Box::new(|error| {
            log::warn!("Matrix WebRTC ICE server reported code {}", error.error_code);
        })));
        let app_gathering = app.clone();
        let gathering_id = peer.id.clone();
        pc.on_ice_gathering_state_change(Some(Box::new(move |status| {
            if status == IceGatheringState::Complete {
                log::info!("Matrix WebRTC finished gathering ICE candidates");
                let _ = app_gathering.emit(
                    "matrix-voip-ice",
                    PeerCandidate {
                        call_id: &gathering_id,
                        candidate: Candidate {
                            candidate: String::new(),
                            mid: None,
                            line: None,
                        },
                    },
                );
            }
        })));
        Ok(peer)
    }

    fn new(
        id: String,
        room_id: String,
        ice_servers: Vec<libwebrtc::peer_connection_factory::IceServer>,
    ) -> Result<Self, String> {
        let factory = PeerConnectionFactory::default();
        let pc = factory
            .create_peer_connection(RtcConfiguration {
                ice_servers,
                continual_gathering_policy: ContinualGatheringPolicy::GatherOnce,
                ..Default::default()
            })
            .map_err(|error| error.to_string())?;
        let source = NativeAudioSource::new(
            AudioSourceOptions::default(),
            SAMPLE_RATE,
            NUM_CHANNELS,
            100,
        );
        let label = format!("microphone-{}", uuid::Uuid::new_v4());
        let track = factory.create_audio_track(&label, source.clone());
        let audio = Arc::new(Mutex::new(AudioState::default()));
        let stop = tokio_util::sync::CancellationToken::new();
        let playback = audio.clone();
        let playback_stop = stop.clone();
        let runtime = tokio::runtime::Handle::current();
        pc.on_track(Some(Box::new(move |event| {
            if event.streams.is_empty() { return }
            let MediaStreamTrack::Audio(track) = event.track else { return };
            let playback = playback.clone();
            let stop = playback_stop.clone();
            let key = track.id();
            runtime.spawn(async move {
                tokio::select! {
                    _ = stop.cancelled() => {},
                    _ = handle_remote_audio(track, "peer".into(), key, "microphone".into(), false, playback) => {},
                }
            });
        })));
        Ok(Self {
            id,
            room_id,
            pc,
            track,
            source,
            audio,
            remote_mids: Mutex::default(),
            streams: None,
            stop,
        })
    }

    pub async fn setup(&self, offer: Option<Description>) -> Result<Description, String> {
        self.pc
            .add_track(MediaStreamTrack::Audio(self.track.clone()), &["pax-audio"])
            .map_err(|error| error.to_string())?;
        let local = if let Some(offer) = &offer {
            self.remote_description(offer).await?;
            self.answer_offer().await
        } else {
            self.pc
                .create_offer(OfferOptions {
                    offer_to_receive_audio: true,
                    ..Default::default()
                })
                .await
        }
        .map_err(|error| error.to_string())?;
        self.publish_description(local).await
    }

    async fn answer_offer(&self) -> Result<SessionDescription, libwebrtc::RtcError> {
        for transceiver in self.pc.transceivers() {
            if matches!(
                transceiver.receiver().track(),
                Some(MediaStreamTrack::Video(_))
            ) {
                transceiver.stop()?;
            }
        }
        self.pc.create_answer(AnswerOptions::default()).await
    }

    async fn publish_description(&self, local: SessionDescription) -> Result<Description, String> {
        let description = Description {
            kind: local.sdp_type().to_string(),
            sdp: local.to_string(),
        };
        self.pc
            .set_local_description(local)
            .await
            .map_err(|error| error.to_string())?;
        Ok(description)
    }

    pub async fn remote_description(&self, description: &Description) -> Result<(), String> {
        self.pc
            .set_remote_description(description.parse()?)
            .await
            .map_err(|_| "Could not apply the peer’s WebRTC session description.".to_owned())?;
        let mut mids = self.remote_mids.lock();
        mids.clear();
        for line in description.sdp.lines() {
            if line.starts_with("m=") {
                mids.push(None);
            } else if let (Some(mid), Some(section)) =
                (line.strip_prefix("a=mid:"), mids.last_mut())
            {
                *section = Some(mid.to_owned());
            }
        }
        Ok(())
    }

    pub async fn renegotiate(
        &self,
        description: &Description,
    ) -> Result<Option<Description>, String> {
        self.remote_description(description).await?;
        if description.kind == "answer" {
            return Ok(None);
        }
        let answer = self
            .answer_offer()
            .await
            .map_err(|error| error.to_string())?;
        self.publish_description(answer).await.map(Some)
    }

    pub async fn add_candidates(&self, candidates: Vec<Candidate>) {
        for candidate in candidates {
            // The empty end-of-candidates indication has no native ICE candidate.
            if candidate.candidate.is_empty() {
                continue;
            }
            let kind = candidate.kind();
            let coordinates = {
                let mids = self.remote_mids.lock();
                match (candidate.mid, candidate.line) {
                    (Some(mid), Some(line)) => Some((mid, line)),
                    (Some(mid), None) => mids
                        .iter()
                        .position(|value| value.as_ref() == Some(&mid))
                        .map(|line| (mid, line as i32)),
                    (None, Some(line)) if line >= 0 => mids
                        .get(line as usize)
                        .and_then(Clone::clone)
                        .map(|mid| (mid, line)),
                    _ => None,
                }
            };
            let Some((mid, line)) = coordinates else {
                log::warn!("Matrix WebRTC ignored a remote ICE candidate with no media section");
                continue;
            };
            if let Ok(ice) = IceCandidate::parse(&mid, line, &candidate.candidate) {
                if self.pc.add_ice_candidate(ice).await.is_ok() {
                    log::info!("Matrix WebRTC applied a remote {kind} ICE candidate");
                } else {
                    log::warn!("Matrix WebRTC could not apply a remote ICE candidate");
                }
            } else {
                log::warn!("Matrix WebRTC could not parse a remote ICE candidate");
            }
        }
    }

    pub fn start_audio(&mut self, input: Option<&str>, output: Option<&str>) -> Result<(), String> {
        if self.streams.is_none() {
            let (input, output, _) =
                start_call_audio(&self.audio, self.source.clone(), input, output)?;
            self.streams = Some((input, output));
        }
        Ok(())
    }

    pub fn toggle_mic(&self) -> bool {
        let mut audio = self.audio.lock();
        audio.mic_enabled = !audio.mic_enabled;
        self.track.set_enabled(audio.mic_enabled);
        audio.mic_enabled
    }
}

impl Candidate {
    fn kind(&self) -> &'static str {
        match self.candidate.split_whitespace().nth(7) {
            Some("host") => "host",
            Some("srflx") => "server-reflexive",
            Some("prflx") => "peer-reflexive",
            Some("relay") => "relay",
            _ => "unknown",
        }
    }
}

impl From<IceCandidate> for Candidate {
    fn from(candidate: IceCandidate) -> Self {
        let line = candidate.sdp_mline_index();
        Self {
            candidate: candidate.to_string(),
            mid: Some(candidate.sdp_mid()),
            line: (line >= 0).then_some(line),
        }
    }
}

impl Drop for PeerMedia {
    fn drop(&mut self) {
        self.stop.cancel();
        self.streams.take();
        self.pc.on_connection_state_change(None);
        self.pc.on_ice_candidate(None);
        self.pc.on_ice_candidate_error(None);
        self.pc.on_ice_gathering_state_change(None);
        self.pc.on_track(None);
        self.pc.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch_candidates(peer: &PeerMedia) -> mpsc::UnboundedReceiver<Candidate> {
        let (tx, rx) = mpsc::unbounded_channel();
        peer.pc.on_ice_candidate(Some(Box::new(move |candidate| {
            let _ = tx.send(candidate.into());
        })));
        rx
    }

    #[tokio::test]
    async fn matrix_web_rtc_offer_answer_and_trickle_ice_carry_audio_both_ways() {
        let caller = PeerMedia::new("caller".into(), "room".into(), vec![]).unwrap();
        let callee = PeerMedia::new("callee".into(), "room".into(), vec![]).unwrap();
        let mut caller_ice = watch_candidates(&caller);
        let mut callee_ice = watch_candidates(&callee);
        let offer = caller.setup(None).await.unwrap();
        let answer = callee.setup(Some(offer)).await.unwrap();
        assert!(
            answer.sdp.contains("a=sendrecv"),
            "answer negotiates two-way audio"
        );
        assert!(
            answer.sdp.contains("a=msid:pax-audio"),
            "answer identifies its audio stream"
        );
        caller.remote_description(&answer).await.unwrap();

        tokio::time::timeout(Duration::from_secs(10), async {
            while caller.pc.connection_state() != PeerConnectionState::Connected
                || callee.pc.connection_state() != PeerConnectionState::Connected
            {
                tokio::select! {
                    Some(mut candidate) = caller_ice.recv() => {
                        candidate.line = None;
                        callee.add_candidates(vec![candidate]).await;
                    },
                    Some(mut candidate) = callee_ice.recv() => {
                        candidate.mid = None;
                        caller.add_candidates(vec![candidate]).await;
                    },
                    _ = tokio::time::sleep(Duration::from_millis(10)) => {},
                }
            }
        })
        .await
        .expect("WebRTC connected with exchanged ICE candidates");

        let frame = AudioFrame {
            sample_rate: SAMPLE_RATE,
            num_channels: NUM_CHANNELS,
            samples_per_channel: SAMPLES_PER_10MS,
            data: (0..SAMPLES_PER_10MS)
                .map(|sample| {
                    (f32::sin(sample as f32 * std::f32::consts::TAU * 440.0 / SAMPLE_RATE as f32)
                        * 12_000.0) as i16
                })
                .collect::<Vec<_>>()
                .into(),
        };
        let audio = tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                caller.source.capture_frame(&frame).await.unwrap();
                callee.source.capture_frame(&frame).await.unwrap();
                let received = [&caller, &callee].into_iter().all(|peer| {
                    peer.audio
                        .lock()
                        .playback_buffers
                        .values()
                        .flatten()
                        .any(|sample| sample.abs() > 0.03)
                });
                if received {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            audio.is_ok(),
            "both peers should receive microphone audio (caller {} samples, callee {} samples)",
            caller
                .audio
                .lock()
                .playback_buffers
                .values()
                .map(VecDeque::len)
                .sum::<usize>(),
            callee
                .audio
                .lock()
                .playback_buffers
                .values()
                .map(VecDeque::len)
                .sum::<usize>()
        );
    }
}
