import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useSound } from "react-sounds";
import { getStoredVolume } from "./useUserVolume";

/**
 * Participant info emitted from the Rust backend.
 * Matches voice::VoiceParticipantInfo on the Rust side.
 */
export interface VoiceParticipant {
  identity: string;
  isSpeaking: boolean;
  isLocal: boolean;
  isMuted: boolean;
  isDeafened: boolean;
}

/**
 * Full voice state emitted from the Rust backend.
 * Matches voice::VoiceStateEvent on the Rust side.
 */
interface VoiceStateEvent {
  connectedRoomId: string | null;
  isConnecting: boolean;
  isMicEnabled: boolean;
  isDeafened: boolean;
  isNoiseSuppressed: boolean;
  screenSharingOwner: string | null;
  isLocalScreenSharing: boolean;
  error: string | null;
  participants: VoiceParticipant[];
}

export interface VoiceCallState {
  connectedRoomId: string | null;
  isConnecting: boolean;
  isMicEnabled: boolean;
  isDeafened: boolean;
  error: string | null;
  isNoiseSuppressed: boolean;
  screenSharingOwner: string | null;
  isLocalScreenSharing: boolean;
  participants: VoiceParticipant[];
}

export function useVoiceCall() {
  const [state, setState] = useState<VoiceCallState>({
    connectedRoomId: null,
    isConnecting: false,
    isMicEnabled: false,
    isDeafened: false,
    isNoiseSuppressed: true,
    screenSharingOwner: null,
    isLocalScreenSharing: false,
    error: null,
    participants: [],
  });

  const connectedRoomIdRef = useRef<string | null>(null);
  connectedRoomIdRef.current = state.connectedRoomId;
  const isConnectingRef = useRef(false);

  const { play: playConnect } = useSound("notification/success");
  const { play: playDisconnect } = useSound("notification/error");
  const wasConnectedRef = useRef(false);

  // Listen for voice state events from the Rust backend
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<VoiceStateEvent>("voice-state-changed", (event) => {
      const ev = event.payload;
      setState({
        connectedRoomId: ev.connectedRoomId,
        isConnecting: ev.isConnecting,
        isMicEnabled: ev.isMicEnabled,
        isDeafened: ev.isDeafened ?? false,
        isNoiseSuppressed: ev.isNoiseSuppressed,
        screenSharingOwner: ev.screenSharingOwner ?? null,
        isLocalScreenSharing: ev.isLocalScreenSharing ?? false,
        error: ev.error,
        participants: ev.participants,
      });
      // Play connect/disconnect sounds
      const isNowConnected =
        ev.connectedRoomId !== null && !ev.isConnecting && !ev.error;
      if (isNowConnected && !wasConnectedRef.current) {
        playConnect();
      } else if (!isNowConnected && wasConnectedRef.current) {
        playDisconnect();
      }
      wasConnectedRef.current = isNowConnected;
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [playConnect, playDisconnect]);

  const connect = useCallback(async (roomId: string) => {
    if (connectedRoomIdRef.current === roomId) return;
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setState((prev) => ({
      ...prev,
      isConnecting: true,
      error: null,
      connectedRoomId: roomId,
    }));
    try {
      await invoke("voice_connect", { roomId });
      isConnectingRef.current = false;
      // State will be updated via the event listener
    } catch (e) {
      isConnectingRef.current = false;
      setState({
        connectedRoomId: null,
        isConnecting: false,
        isMicEnabled: false,
        isDeafened: false,
        isNoiseSuppressed: false,
        screenSharingOwner: null,
        isLocalScreenSharing: false,
        error: String(e),
        participants: [],
      });
    }
  }, []);

  const disconnect = useCallback(async () => {
    const roomId = connectedRoomIdRef.current;
    if (!roomId) return;
    try {
      await invoke("voice_disconnect", { roomId });
    } catch (e) {
      console.error("Failed to disconnect:", e);
    }
    setState({
      connectedRoomId: null,
      isConnecting: false,
      isMicEnabled: false,
      isDeafened: false,
      isNoiseSuppressed: false,
      screenSharingOwner: null,
      isLocalScreenSharing: false,
      error: null,
      participants: [],
    });
  }, []);

  const toggleMic = useCallback(async () => {
    try {
      const newEnabled = await invoke<boolean>("voice_toggle_mic");
      setState((prev) => ({
        ...prev,
        isMicEnabled: newEnabled,
        participants: prev.participants.map((p) =>
          p.isLocal ? { ...p, isMuted: !newEnabled } : p
        ),
      }));
    } catch (e) {
      console.error("Failed to toggle mic:", e);
    }
  }, []);

  const toggleDeafen = useCallback(async () => {
    try {
      const newDeafened = await invoke<boolean>("voice_toggle_deafen");
      setState((prev) => ({
        ...prev,
        isDeafened: newDeafened,
        participants: prev.participants.map((p) =>
          p.isLocal ? { ...p, isDeafened: newDeafened } : p
        ),
      }));
    } catch (e) {
      console.error("Failed to toggle deafen:", e);
    }
  }, []);

  /**
   * Set the playback volume for a specific remote participant.
   * Volume is 0-2 (0% to 200%).
   */
  const setParticipantVolume = useCallback(
    (identity: string, volume: number) => {
      const clamped = Math.max(0, Math.min(2, volume));
      
      // ←←← DEBUG LOGS (you will see these in DevTools)
      console.log(`[Pax TS] setParticipantVolume called → identity="${identity}" volume=${clamped}`);
      
      invoke("voice_set_participant_volume", { identity, volume: clamped }).catch(
        (e) => {
          console.error("[Pax TS] Failed to set volume in Rust:", e);
        }
      );
    },
    []
  );

  // Send stored volumes to backend when participants change
  useEffect(() => {
    for (const p of state.participants) {
      if (!p.isLocal) {
        const stored = getStoredVolume(p.identity);
        if (stored !== 1.0) {
          invoke("voice_set_participant_volume", {
            identity: p.identity,
            volume: stored,
          }).catch(() => {});
        }
      }
    }
  }, [state.participants]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const roomId = connectedRoomIdRef.current;
      if (roomId) {
        invoke("voice_disconnect", { roomId }).catch(() => {});
      }
    };
  }, []);

  return {
    ...state,
    // Provide remoteParticipants and localParticipant for compatibility
    // with VoiceRoomView and RoomSidebar
    remoteParticipants: state.participants.filter((p) => !p.isLocal),
    localParticipant: state.participants.find((p) => p.isLocal) ?? null,
    connect,
    disconnect,
    toggleMic,
    toggleDeafen,
    toggleNoiseSuppression: () => {
      invoke<boolean>("voice_toggle_noise_suppression")
        .then((enabled) => {
          setState((prev) => ({ ...prev, isNoiseSuppressed: enabled }));
        })
        .catch((e) => {
          console.error("Failed to toggle noise suppression:", e);
        });
    },
    startScreenShare: async (mode: "screen" | "window", windowTitle?: string): Promise<void> => {
      setState((prev) => ({ ...prev, error: null })); // Clear previous error before retry
      try {
        await invoke("voice_start_screen_share", { mode, windowTitle: windowTitle ?? null });
      } catch (e) {
        console.error("Failed to start screen share:", e);
        setState((prev) => ({ ...prev, error: String(e) }));
        throw e;
      }
    },
    enumerateScreenShareWindows: () =>
      invoke<[string, string][]>("enumerate_screen_share_windows"),
    stopScreenShare: async (): Promise<void> => {
      try {
        await invoke("voice_stop_screen_share");
      } catch (e) {
        console.error("Failed to stop screen share:", e);
        throw e;
      }
    },
    getScreenSharePreset: () => invoke<"720p" | "1080p">("get_screen_share_preset"),
    setScreenSharePreset: (preset: "720p" | "1080p") =>
      invoke<void>("set_screen_share_preset", { preset }),
    getNoiseSuppressionConfig: () =>
      invoke<{ extraAttenuation: number; agcTargetRms: number }>("get_noise_suppression_config"),
    setNoiseSuppressionConfig: (config: { extraAttenuation: number; agcTargetRms: number }) =>
      invoke<void>("set_noise_suppression_config", { config }),
    setParticipantVolume,
  };
}
