import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
  Participant,
} from "livekit-client";
import { VoiceJoinResult } from "../types/matrix";

export interface VoiceCallState {
  connectedRoomId: string | null;
  isConnecting: boolean;
  isMicEnabled: boolean;
  error: string | null;
  /** Remote participants currently in the call */
  remoteParticipants: RemoteParticipant[];
  /** Local participant (us) once connected */
  localParticipant: LocalParticipant | null;
}

export function useVoiceCall() {
  const livekitRoom = useRef<Room | null>(null);
  const audioElements = useRef<Map<string, HTMLAudioElement>>(new Map());
  const [state, setState] = useState<VoiceCallState>({
    connectedRoomId: null,
    isConnecting: false,
    isMicEnabled: false,
    error: null,
    remoteParticipants: [],
    localParticipant: null,
  });

  // Keep a ref to connectedRoomId for use in cleanup callbacks
  const connectedRoomIdRef = useRef<string | null>(null);
  connectedRoomIdRef.current = state.connectedRoomId;

  const updateParticipants = useCallback(() => {
    const room = livekitRoom.current;
    if (!room) return;

    setState((prev) => ({
      ...prev,
      remoteParticipants: Array.from(room.remoteParticipants.values()),
      localParticipant: room.localParticipant,
    }));
  }, []);

  // Attach an audio track to a hidden audio element for playback
  const attachAudioTrack = useCallback(
    (
      track: Track,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      if (track.kind !== Track.Kind.Audio) return;

      const el = track.attach();
      // Force mono tracks to play through both channels
      el.style.display = "none";
      document.body.appendChild(el);

      // Use Web Audio to ensure mono is centered (plays in both ears)
      try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(el);
        source.connect(audioCtx.destination);
      } catch {
        // Fallback: direct playback (may still be one-sided on some systems)
      }

      audioElements.current.set(participant.identity + ":" + track.sid, el);
    },
    []
  );

  // Detach audio on unsubscribe
  const detachAudioTrack = useCallback(
    (track: Track, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
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

  // Clean up all audio elements
  const cleanupAudio = useCallback(() => {
    audioElements.current.forEach((el) => el.remove());
    audioElements.current.clear();
  }, []);

  const disconnect = useCallback(async () => {
    const room = livekitRoom.current;
    const roomId = connectedRoomIdRef.current;

    if (room) {
      room.disconnect();
      livekitRoom.current = null;
    }

    cleanupAudio();

    // Send leave event to Matrix
    if (roomId) {
      try {
        await invoke("leave_voice_room", { roomId });
      } catch (e) {
        console.error("Failed to send leave event:", e);
      }
    }

    setState({
      connectedRoomId: null,
      isConnecting: false,
      isMicEnabled: false,
      error: null,
      remoteParticipants: [],
      localParticipant: null,
    });
  }, [cleanupAudio]);

  const connect = useCallback(
    async (roomId: string) => {
      // If already connected to this room, do nothing
      if (state.connectedRoomId === roomId && livekitRoom.current) {
        return;
      }

      // If connected to a different room, disconnect first
      if (livekitRoom.current) {
        await disconnect();
      }

      setState((prev) => ({
        ...prev,
        isConnecting: true,
        error: null,
        connectedRoomId: roomId,
      }));

      try {
        // 1. Ask Rust backend to join the room (sends state event, gets JWT)
        const result = await invoke<VoiceJoinResult>("join_voice_room", {
          roomId,
        });

        // 2. Create and connect the LiveKit room
        const room = new Room({
          audioCaptureDefaults: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
          audioOutput: {
            deviceId: "default",
          },
        });

        // Wire up event handlers
        room.on(RoomEvent.TrackSubscribed, attachAudioTrack);
        room.on(RoomEvent.TrackUnsubscribed, detachAudioTrack);
        room.on(RoomEvent.ParticipantConnected, updateParticipants);
        room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
        room.on(RoomEvent.ConnectionStateChanged, (connState: ConnectionState) => {
          if (connState === ConnectionState.Disconnected) {
            // Unexpected disconnect (network issue, etc.)
            cleanupAudio();
            livekitRoom.current = null;
            setState({
              connectedRoomId: null,
              isConnecting: false,
              isMicEnabled: false,
              error: "Disconnected from voice",
              remoteParticipants: [],
              localParticipant: null,
            });
          }
        });
        room.on(RoomEvent.ActiveSpeakersChanged, updateParticipants);

        await room.connect(result.livekitUrl, result.jwt);

        livekitRoom.current = room;

        // 3. Enable microphone by default
        await room.localParticipant.setMicrophoneEnabled(true);

        setState({
          connectedRoomId: roomId,
          isConnecting: false,
          isMicEnabled: true,
          error: null,
          remoteParticipants: Array.from(room.remoteParticipants.values()),
          localParticipant: room.localParticipant,
        });
      } catch (e) {
        console.error("Failed to join voice room:", e);
        setState({
          connectedRoomId: null,
          isConnecting: false,
          isMicEnabled: false,
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

    const newState = !state.isMicEnabled;
    await room.localParticipant.setMicrophoneEnabled(newState);
    setState((prev) => ({ ...prev, isMicEnabled: newState }));
  }, [state.isMicEnabled]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      const room = livekitRoom.current;
      if (room) {
        room.disconnect();
        livekitRoom.current = null;
      }
      cleanupAudio();
      // Best-effort leave event
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
  };
}