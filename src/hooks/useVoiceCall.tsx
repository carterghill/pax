import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Room,
  RoomEvent,
  Track,
  LocalTrack,
  ConnectionState,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
} from "livekit-client";
import { VoiceJoinResult } from "../types/matrix";
import {
  createNoiseSuppressor,
  NoiseSuppressorHandle,
} from "../audio/noiseSuppression";
import { useSound } from "react-sounds";

export interface VoiceCallState {
  connectedRoomId: string | null;
  isConnecting: boolean;
  isMicEnabled: boolean;
  isNoiseSuppressed: boolean;
  error: string | null;
  remoteParticipants: RemoteParticipant[];
  localParticipant: LocalParticipant | null;
}

export function useVoiceCall() {
  const livekitRoom = useRef<Room | null>(null);
  const audioElements = useRef<Map<string, HTMLAudioElement>>(new Map());
  const noiseSuppressor = useRef<NoiseSuppressorHandle | null>(null);
  const rawMicStream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<VoiceCallState>({
    connectedRoomId: null,
    isConnecting: false,
    isMicEnabled: false,
    isNoiseSuppressed: true,
    error: null,
    remoteParticipants: [],
    localParticipant: null,
  });

  const connectedRoomIdRef = useRef<string | null>(null);
  connectedRoomIdRef.current = state.connectedRoomId;

  const { play: playConnect } = useSound('notification/success'); // Or a specific 'connect' sound if available
  const { play: playDisconnect } = useSound('notification/error'); // Or 'disconnect' equivalent

  const updateParticipants = useCallback(() => {
    const room = livekitRoom.current;
    if (!room) return;
    setState((prev) => ({
      ...prev,
      remoteParticipants: Array.from(room.remoteParticipants.values()),
      localParticipant: room.localParticipant,
    }));
  }, []);

  // Attach remote audio tracks for playback
  const attachAudioTrack = useCallback(
    (track: Track, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;

      const el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);

      // Route through Web Audio to fix mono → stereo (both ears)
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(el);
        source.connect(ctx.destination);
      } catch {
        // Fallback: direct playback
      }

      audioElements.current.set(participant.identity + ":" + track.sid, el);
    },
    []
  );

  const detachAudioTrack = useCallback(
    (track: Track, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      const key = participant.identity + ":" + track.sid;
      const el = audioElements.current.get(key);
      if (el) {
        el.remove();
        audioElements.current.delete(key);
      }
      track.detach();
    },
    []
  );

  const cleanupAudio = useCallback(() => {
    audioElements.current.forEach((el) => el.remove());
    audioElements.current.clear();
    // Clean up noise suppressor
    if (noiseSuppressor.current) {
      noiseSuppressor.current.destroy();
      noiseSuppressor.current = null;
    }
    // Stop raw mic
    if (rawMicStream.current) {
      rawMicStream.current.getTracks().forEach((t) => t.stop());
      rawMicStream.current = null;
    }
  }, []);

  const disconnect = useCallback(async () => {
    const room = livekitRoom.current;
    const roomId = connectedRoomIdRef.current;

    if (room) {
      room.disconnect();
      livekitRoom.current = null;
    }

    cleanupAudio();

    if (roomId) {
      try {
        await invoke("leave_voice_room", { roomId });
      } catch (e) {
        console.error("Failed to send leave event:", e);
      }
    }

    playDisconnect();
    
    setState({
      connectedRoomId: null,
      isConnecting: false,
      isMicEnabled: false,
      isNoiseSuppressed: true,
      error: null,
      remoteParticipants: [],
      localParticipant: null,
    });
  }, [cleanupAudio]);

  const connect = useCallback(
    async (roomId: string) => {
      if (state.connectedRoomId === roomId && livekitRoom.current) return;
      if (livekitRoom.current) await disconnect();

      setState((prev) => ({
        ...prev,
        isConnecting: true,
        error: null,
        connectedRoomId: roomId,
      }));

      try {
        // 1. Get JWT from Rust backend
        const result = await invoke<VoiceJoinResult>("join_voice_room", { roomId });

        // 2. Capture raw microphone
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: false, // We handle this ourselves with RNNoise
            sampleRate: 48000,
          },
        });
        rawMicStream.current = micStream;

        // 3. Set up RNNoise noise suppression pipeline
        let publishTrack: MediaStreamTrack;
        try {
          const suppressor = await createNoiseSuppressor(micStream.getAudioTracks()[0]);
          noiseSuppressor.current = suppressor;
          publishTrack = suppressor.track;
          console.log("[Pax] RNNoise noise suppression active");
        } catch (e) {
          // RNNoise failed to load — fall back to raw mic
          console.warn("[Pax] RNNoise failed to initialize, using raw mic:", e);
          publishTrack = micStream.getAudioTracks()[0];
        }

        // 4. Create and connect LiveKit room
        const room = new Room({
          audioOutput: { deviceId: "default" },
        });

        room.on(RoomEvent.TrackSubscribed, attachAudioTrack);
        room.on(RoomEvent.TrackUnsubscribed, detachAudioTrack);
        room.on(RoomEvent.ParticipantConnected, updateParticipants);
        room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
        room.on(RoomEvent.ConnectionStateChanged, (connState: ConnectionState) => {
          if (connState === ConnectionState.Disconnected) {
            cleanupAudio();
            livekitRoom.current = null;
            setState({
              connectedRoomId: null,
              isConnecting: false,
              isMicEnabled: false,
              isNoiseSuppressed: true,
              error: "Disconnected from voice",
              remoteParticipants: [],
              localParticipant: null,
            });
          }
        });
        room.on(RoomEvent.ActiveSpeakersChanged, updateParticipants);

        await room.connect(result.livekitUrl, result.jwt);
        livekitRoom.current = room;

        // 5. Publish the denoised mic track
        await room.localParticipant.publishTrack(publishTrack, {
          source: Track.Source.Microphone,
        });

        setState({
          connectedRoomId: roomId,
          isConnecting: false,
          isMicEnabled: true,
          isNoiseSuppressed: noiseSuppressor.current !== null,
          error: null,
          remoteParticipants: Array.from(room.remoteParticipants.values()),
          localParticipant: room.localParticipant,
        });
        playConnect();
      } catch (e) {
        console.error("Failed to join voice room:", e);
        cleanupAudio();
        setState({
          connectedRoomId: null,
          isConnecting: false,
          isMicEnabled: false,
          isNoiseSuppressed: true,
          error: String(e),
          remoteParticipants: [],
          localParticipant: null,
        });
      }
    },
    [state.connectedRoomId, disconnect, attachAudioTrack, detachAudioTrack, updateParticipants, cleanupAudio]
  );

  const toggleMic = useCallback(async () => {
    const room = livekitRoom.current;
    if (!room) return;

    const newEnabled = !state.isMicEnabled;
    // Mute/unmute by enabling/disabling the published track
    const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (micPub && micPub.track) {
      if (newEnabled) {
        await micPub.unmute();
      } else {
        await micPub.mute();
      }
    }
    setState((prev) => ({ ...prev, isMicEnabled: newEnabled }));
  }, [state.isMicEnabled]);

  const toggleNoiseSuppression = useCallback(() => {
    const suppressor = noiseSuppressor.current;
    if (!suppressor) return;

    const newEnabled = !state.isNoiseSuppressed;
    suppressor.setEnabled(newEnabled);
    setState((prev) => ({ ...prev, isNoiseSuppressed: newEnabled }));
  }, [state.isNoiseSuppressed]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const room = livekitRoom.current;
      if (room) {
        room.disconnect();
        livekitRoom.current = null;
      }
      cleanupAudio();
      const roomId = connectedRoomIdRef.current;
      if (roomId) {
        invoke("leave_voice_room", { roomId }).catch(() => {});
      }
    };
  }, [cleanupAudio]);

  return {
    ...state,
    connect,
    disconnect,
    toggleMic,
    toggleNoiseSuppression,
  };
}