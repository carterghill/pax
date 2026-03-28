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
  screenSharingOwners: string[];
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
  screenSharingOwners: string[];
  isLocalScreenSharing: boolean;
  participants: VoiceParticipant[];
  /** Room we're disconnecting from; our name may still appear in the list until Matrix syncs */
  disconnectingFromRoomId: string | null;
}

export interface VoiceCallActions {
  connect: (roomId: string) => void;
  disconnect: () => void;
  toggleMic: () => void;
  toggleDeafen: () => void;
  toggleNoiseSuppression: () => void;
  startScreenShare: (mode: "screen" | "window", windowTitle?: string) => Promise<void>;
  enumerateScreenShareWindows: () => Promise<[string, string][]>;
  stopScreenShare: () => Promise<void>;
  getScreenShareQuality: () => Promise<"low" | "medium" | "high">;
  setScreenShareQuality: (quality: "low" | "medium" | "high") => Promise<void>;
  getNoiseSuppressionConfig: () => Promise<{ extraAttenuation: number; agcTargetRms: number }>;
  setNoiseSuppressionConfig: (config: { extraAttenuation: number; agcTargetRms: number }) => Promise<void>;
  setParticipantVolume: (identity: string, volume: number, source: string) => void;
}

/** Full return type of useVoiceCall — state + actions. */
export type VoiceCall = VoiceCallState & VoiceCallActions & {
  remoteParticipants: VoiceParticipant[];
  localParticipant: VoiceParticipant | null;
};

export function useVoiceCall() {
  const [state, setState] = useState<VoiceCallState>({
    connectedRoomId: null,
    isConnecting: false,
    isMicEnabled: false,
    isDeafened: false,
    isNoiseSuppressed: true,
    screenSharingOwners: [],
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
        screenSharingOwners: ev.screenSharingOwners ?? [],
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
        playSound("ui/pop_open");
      }

      // Detect remote participant joins/leaves by diffing identities
      if (isNowConnected) {
        const currentIds = new Set(ev.participants.filter(p => !p.isLocal).map(p => p.identity));
        const prevIds = prevParticipantIdsRef.current;
        for (const id of currentIds) {
          if (!prevIds.has(id)) playSound("ui/pop_open");
        }
        for (const id of prevIds) {
          if (!currentIds.has(id)) playSound("ui/pop_close");
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
        screenSharingOwners: [],
        isLocalScreenSharing: false,
        error: String(e),
        participants: [],
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    const roomId = connectedRoomIdRef.current;
    if (!roomId) return;
    playSound("ui/pop_close");
    // Optimistic update: clear UI immediately so disconnect feels instant
    setState((prev) => ({
      ...prev,
      connectedRoomId: null,
      isConnecting: false,
      isMicEnabled: false,
      isDeafened: false,
      isNoiseSuppressed: false,
      screenSharingOwners: [],
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
    (identity: string, volume: number, source: string) => {
      const clamped = Math.max(0, Math.min(2, volume));
      invoke("voice_set_participant_volume", { identity, volume: clamped, source }).catch(
        (e) => {
          console.error("[Pax TS] Failed to set volume in Rust:", e);
        }
      );
    },
    []
  );

  // Send stored volumes to backend only when new participants join
  const volumeSentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(
      state.participants.filter((p) => !p.isLocal).map((p) => p.identity)
    );
    // Prune departed participants so they get re-sent if they rejoin
    for (const id of volumeSentRef.current) {
      if (!currentIds.has(id)) volumeSentRef.current.delete(id);
    }
    // Send stored volumes only for newly-joined participants
    for (const id of currentIds) {
      if (!volumeSentRef.current.has(id)) {
        volumeSentRef.current.add(id);
        // Sync both mic and screenshare_audio volumes
        for (const source of ["microphone", "screenshare_audio"] as const) {
          const stored = getStoredVolume(id, source);
          if (stored !== 1.0) {
            invoke("voice_set_participant_volume", {
              identity: id,
              volume: stored,
              source,
            }).catch(() => {});
          }
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
    getScreenShareQuality: () => invoke<"low" | "medium" | "high">("get_screen_share_quality"),
    setScreenShareQuality: (quality: "low" | "medium" | "high") =>
      invoke<void>("set_screen_share_quality", { quality }),
    getNoiseSuppressionConfig: () =>
      invoke<{ extraAttenuation: number; agcTargetRms: number }>("get_noise_suppression_config"),
    setNoiseSuppressionConfig: (config: { extraAttenuation: number; agcTargetRms: number }) =>
      invoke<void>("set_noise_suppression_config", { config }),
    setParticipantVolume,
  };
}