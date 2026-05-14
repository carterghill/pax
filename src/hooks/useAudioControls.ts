import { useState, useCallback, useEffect, useRef } from "react";
import {
  getStoredMutePreference,
  setStoredMutePreference,
  getStoredDeafenPreference,
  setStoredDeafenPreference,
} from "./voicePreferences";
import type { AudioDeviceList } from "./useVoiceAudioDevices";

export interface AudioControls {
  isMuted: boolean;
  isDeafened: boolean;
  toggleMic: () => void;
  toggleDeafen: () => void;
  listAudioDevices: () => Promise<AudioDeviceList>;
  reconnectAfterDeviceChange: () => Promise<void>;
}

interface VoiceCallSlice {
  connectedRoomId: string | null;
  isConnecting: boolean;
  isMicEnabled: boolean;
  isDeafened: boolean;
  toggleMic: () => void;
  toggleDeafen: () => void;
  listAudioDevices: () => Promise<AudioDeviceList>;
  connect: (roomId: string, options?: { forceReconnect?: boolean }) => Promise<void>;
}

export function useAudioControls(voiceCall: VoiceCallSlice): AudioControls {
  const [localMuted, setLocalMuted] = useState(getStoredMutePreference);
  const [localDeafened, setLocalDeafened] = useState(getStoredDeafenPreference);

  const inCall =
    voiceCall.connectedRoomId !== null && !voiceCall.isConnecting;

  // Track connecting→connected transitions so we apply stored preferences
  // exactly once per connection (including forceReconnect).
  const wasConnecting = useRef(false);

  useEffect(() => {
    if (voiceCall.isConnecting) {
      wasConnecting.current = true;
      return;
    }

    if (!inCall) {
      wasConnecting.current = false;
      return;
    }

    // Just transitioned from connecting → connected
    if (wasConnecting.current) {
      wasConnecting.current = false;

      const wantMuted = getStoredMutePreference();
      const backendMuted = !voiceCall.isMicEnabled;
      if (wantMuted !== backendMuted) {
        voiceCall.toggleMic();
      }

      const wantDeafened = getStoredDeafenPreference();
      if (wantDeafened !== voiceCall.isDeafened) {
        voiceCall.toggleDeafen();
      }
      return;
    }

    // Steady-state in-call: backend is authoritative, sync to local + storage
    const backendMuted = !voiceCall.isMicEnabled;
    setLocalMuted(backendMuted);
    setStoredMutePreference(backendMuted);
    setLocalDeafened(voiceCall.isDeafened);
    setStoredDeafenPreference(voiceCall.isDeafened);
  }, [
    voiceCall.isConnecting,
    inCall,
    voiceCall.connectedRoomId,
    voiceCall.isMicEnabled,
    voiceCall.isDeafened,
    voiceCall.toggleMic,
    voiceCall.toggleDeafen,
  ]);

  const toggleMic = useCallback(() => {
    if (inCall) {
      voiceCall.toggleMic();
    } else {
      setLocalMuted((prev) => {
        const next = !prev;
        setStoredMutePreference(next);
        return next;
      });
    }
  }, [inCall, voiceCall.toggleMic]);

  const toggleDeafen = useCallback(() => {
    if (inCall) {
      voiceCall.toggleDeafen();
    } else {
      setLocalDeafened((prev) => {
        const next = !prev;
        setStoredDeafenPreference(next);
        return next;
      });
    }
  }, [inCall, voiceCall.toggleDeafen]);

  const reconnectAfterDeviceChange = useCallback(async () => {
    const rid = voiceCall.connectedRoomId;
    if (rid && !voiceCall.isConnecting) {
      await voiceCall.connect(rid, { forceReconnect: true });
    }
  }, [voiceCall.connectedRoomId, voiceCall.isConnecting, voiceCall.connect]);

  return {
    isMuted: inCall ? !voiceCall.isMicEnabled : localMuted,
    isDeafened: inCall ? voiceCall.isDeafened : localDeafened,
    toggleMic,
    toggleDeafen,
    listAudioDevices: voiceCall.listAudioDevices,
    reconnectAfterDeviceChange,
  };
}
