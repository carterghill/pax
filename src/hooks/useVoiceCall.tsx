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
import { getStoredVolume } from "./useUserVolume";

export interface VoiceCallState {
  connectedRoomId: string | null;
  isConnecting: boolean;
  isMicEnabled: boolean;
  isNoiseSuppressed: boolean;
  error: string | null;
  remoteParticipants: RemoteParticipant[];
  localParticipant: LocalParticipant | null;
}

/** Audio routing nodes for a single remote track */
interface ParticipantAudioNodes {
  ctx: AudioContext;
  gain: GainNode;
  source: MediaElementAudioSourceNode;
}

export function useVoiceCall() {
  const livekitRoom = useRef<Room | null>(null);
  const audioElements = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioNodes = useRef<Map<string, ParticipantAudioNodes>>(new Map());
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
  const isConnectingRef = useRef(false);

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

  // Attach remote audio tracks for playback, with per-user GainNode for volume control
  const attachAudioTrack = useCallback(
    (track: Track, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;

      const el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);

      const key = participant.identity + ":" + track.sid;

      // Route through Web Audio with a GainNode for volume control
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();

        // Apply stored volume for this user (defaults to 1.0 = 100%)
        gain.gain.value = getStoredVolume(participant.identity);

        source.connect(gain);
        gain.connect(ctx.destination);

        audioNodes.current.set(key, { ctx, gain, source });
      } catch {
        // Fallback: direct playback (no volume control)
      }

      audioElements.current.set(key, el);
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
      // Clean up Web Audio nodes
      const nodes = audioNodes.current.get(key);
      if (nodes) {
        try { nodes.ctx.close(); } catch { /* ignore */ }
        audioNodes.current.delete(key);
      }
      track.detach();
    },
    []
  );

  const cleanupAudio = useCallback(() => {
    audioElements.current.forEach((el) => el.remove());
    audioElements.current.clear();
    // Close all Web Audio contexts
    audioNodes.current.forEach((nodes) => {
      try { nodes.ctx.close(); } catch { /* ignore */ }
    });
    audioNodes.current.clear();
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
    isConnectingRef.current = false;

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
      // Use refs for guards to avoid stale closure issues
      if (connectedRoomIdRef.current === roomId && livekitRoom.current) return;
      if (isConnectingRef.current) return;
      isConnectingRef.current = true;

      if (livekitRoom.current) await disconnect();

      setState((prev) => ({
        ...prev,
        isConnecting: true,
        error: null,
        connectedRoomId: roomId,
      }));

      try {
        // 0. Clear any stale call.member state from a previous crash
        try {
          await invoke("leave_voice_room", { roomId });
        } catch {
          // Ignore — may not have a stale session
        }

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
            isConnectingRef.current = false;
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

        isConnectingRef.current = false;
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
        isConnectingRef.current = false;
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
    [disconnect, attachAudioTrack, detachAudioTrack, updateParticipants, cleanupAudio]
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

  /**
   * Set the playback volume for a specific remote participant.
   * Volume is 0–2 (0% to 200%). This updates all active audio tracks for that identity.
   */
  const setParticipantVolume = useCallback((identity: string, volume: number) => {
    const clamped = Math.max(0, Math.min(2, volume));
    // Update all GainNodes belonging to this participant
    audioNodes.current.forEach((nodes, key) => {
      if (key.startsWith(identity + ":")) {
        nodes.gain.gain.value = clamped;
      }
    });
  }, []);

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
    setParticipantVolume,
  };
}