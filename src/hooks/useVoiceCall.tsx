import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { playSound } from "react-sounds";
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
  /** Room we're disconnecting from; our name may still appear in the list until Matrix syncs */
  disconnectingFromRoomId: string | null;
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
    disconnectingFromRoomId: null,
  });

  const connectedRoomIdRef = useRef<string | null>(null);
  connectedRoomIdRef.current = state.connectedRoomId;
  const isConnectingRef = useRef(false);

  const wasConnectedRef = useRef(false);
  const prevParticipantIdsRef = useRef<Set<string>>(new Set());

  // Listen for voice state events from the Rust backend
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<VoiceStateEvent>("voice-state-changed", (event) => {
      const ev = event.payload;
      setState((prev) => ({
        connectedRoomId: ev.connectedRoomId,
        isConnecting: ev.isConnecting,
        isMicEnabled: ev.isMicEnabled,
        isDeafened: ev.isDeafened ?? false,
        isNoiseSuppressed: ev.isNoiseSuppressed,
        screenSharingOwner: ev.screenSharingOwner ?? null,
        isLocalScreenSharing: ev.isLocalScreenSharing ?? false,
        error: ev.error,
        participants: ev.participants,
        // Clear disconnecting when we connect to a room; otherwise preserve
        disconnectingFromRoomId: ev.connectedRoomId ? null : prev.disconnectingFromRoomId,
      }));

      const isNowConnected =
        ev.connectedRoomId !== null && !ev.isConnecting && !ev.error;

      // Local user just finished connecting
      if (isNowConnected && !wasConnectedRef.current) {
        playSound("ui/success_bling");
      }

      // Detect remote participant joins/leaves by diffing identities
      if (isNowConnected) {
        const currentIds = new Set(ev.participants.filter(p => !p.isLocal).map(p => p.identity));
        const prevIds = prevParticipantIdsRef.current;
        for (const id of currentIds) {
          if (!prevIds.has(id)) playSound("ui/success_bling");
        }
        for (const id of prevIds) {
          if (!currentIds.has(id)) playSound("notification/popup");
        }
        prevParticipantIdsRef.current = currentIds;
      } else {
        prevParticipantIdsRef.current = new Set();
      }

      wasConnectedRef.current = isNowConnected;
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

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
      setState((prev) => ({
        ...prev,
        connectedRoomId: null,
        isConnecting: false,
        isMicEnabled: false,
        isDeafened: false,
        isNoiseSuppressed: false,
        screenSharingOwner: null,
        isLocalScreenSharing: false,
        error: String(e),
        participants: [],
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    const roomId = connectedRoomIdRef.current;
    if (!roomId) return;
    playSound("notification/popup");
    // Optimistic update: clear UI immediately so disconnect feels instant
    setState((prev) => ({
      ...prev,
      connectedRoomId: null,
      isConnecting: false,
      isMicEnabled: false,
      isDeafened: false,
      isNoiseSuppressed: false,
      screenSharingOwner: null,
      isLocalScreenSharing: false,
      error: null,
      participants: [],
      disconnectingFromRoomId: roomId,
    }));
    invoke("voice_disconnect", { roomId }).catch((e) => {
      console.error("Failed to disconnect:", e);
    });
    // Clear disconnecting state after Matrix has had time to sync
    setTimeout(() => {
      setState((prev) =>
        prev.disconnectingFromRoomId === roomId
          ? { ...prev, disconnectingFromRoomId: null }
          : prev
      );
    }, 4000);
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
