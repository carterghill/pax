import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { playSound } from "react-sounds";
import { getStoredVolume } from "./useUserVolume";
import {
  AudioDeviceList,
  getStoredAudioDevicePreferences,
} from "./useVoiceAudioDevices";

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

export interface ScreenShareWindowOption {
  id: string;
  title: string;
  processName: string;
  iconDataUrl: string | null;
  thumbnailDataUrl: string | null;
}

export interface VoiceCallActions {
  connect: (
    roomId: string,
    options?: { forceReconnect?: boolean },
  ) => Promise<void>;
  disconnect: () => void;
  toggleMic: () => void;
  toggleDeafen: () => void;
  toggleNoiseSuppression: () => void;
  startScreenShare: (
    mode: "screen" | "window",
    windowTitle?: string,
    windowHandle?: string,
  ) => Promise<void>;
  enumerateScreenShareWindows: () => Promise<ScreenShareWindowOption[]>;
  stopScreenShare: () => Promise<void>;
  getLowBandwidthMode: () => Promise<boolean>;
  setLowBandwidthMode: (enabled: boolean) => Promise<void>;
  getNoiseSuppressionConfig: () => Promise<{ extraAttenuation: number; agcTargetRms: number }>;
  setNoiseSuppressionConfig: (config: { extraAttenuation: number; agcTargetRms: number }) => Promise<void>;
  setParticipantVolume: (identity: string, volume: number, source: string) => void;
  listAudioDevices: () => Promise<AudioDeviceList>;
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
  /** Tracks which room is being auto-rejoined (null = none). Set to null
   *  by disconnect() to cancel an in-progress rejoin attempt. */
  const rejoinRoomRef = useRef<string | null>(null);

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

  // Listen for force-disconnect events from the Rust backend.
  // Emitted when the m.call.member refresh loop fails too many times
  // (e.g. Matrix membership expired while AFK and couldn't be restored).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<string>("voice-force-disconnect", (event) => {
      const roomId = event.payload;
      console.warn(
        `[Pax] Force-disconnecting from voice room ${roomId} — Matrix call membership expired`
      );
      if (connectedRoomIdRef.current === roomId) {
        playSound("ui/pop_close");
        setState((prev) => ({
          ...prev,
          connectedRoomId: null,
          isConnecting: false,
          isMicEnabled: false,
          isDeafened: false,
          isNoiseSuppressed: false,
          screenSharingOwners: [],
          isLocalScreenSharing: false,
          error: "Disconnected: call membership expired",
          participants: [],
          disconnectingFromRoomId: roomId,
        }));
        invoke("voice_disconnect", { roomId }).catch((e) => {
          console.error("Failed to disconnect after force-disconnect:", e);
        });
        // Clear disconnecting state after Matrix has had time to sync
        setTimeout(() => {
          setState((prev) =>
            prev.disconnectingFromRoomId === roomId
              ? { ...prev, disconnectingFromRoomId: null }
              : prev
          );
        }, 4000);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Auto-rejoin when LiveKit kicks us unexpectedly (JWT expiry, server restart, etc.).
  // This event only fires on unexpected disconnects — manual disconnect takes the
  // shutdown_rx branch in the Rust event loop and never emits this event.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<string>("voice-livekit-kicked", async (event) => {
      const roomId = event.payload;
      console.warn(
        `[Pax] LiveKit kicked from ${roomId} — auto-rejoining`
      );
      rejoinRoomRef.current = roomId;

      const MAX_RETRIES = 5;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Cancelled by disconnect() or connect() to a different room
        if (rejoinRoomRef.current !== roomId) return;

        const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
        setState((prev) => ({
          ...prev,
          connectedRoomId: roomId,
          isConnecting: true,
          error: null,
        }));

        await new Promise((r) => setTimeout(r, delay));
        if (rejoinRoomRef.current !== roomId) return;

        try {
          isConnectingRef.current = true;
          const { inputDeviceId, outputDeviceId } = getStoredAudioDevicePreferences();
          await invoke("voice_connect", { roomId, inputDeviceId, outputDeviceId });
          isConnectingRef.current = false;
          console.log(
            `[Pax] Auto-rejoin succeeded on attempt ${attempt + 1}`
          );
          rejoinRoomRef.current = null;
          return;
        } catch (e) {
          isConnectingRef.current = false;
          console.error(
            `[Pax] Auto-rejoin attempt ${attempt + 1}/${MAX_RETRIES} failed:`,
            e
          );
        }
      }

      // All retries exhausted
      rejoinRoomRef.current = null;
      playSound("ui/pop_close");
      setState((prev) => ({
        ...prev,
        connectedRoomId: null,
        isConnecting: false,
        error: "Lost connection to voice chat",
        participants: [],
      }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      rejoinRoomRef.current = null;
      if (unlisten) unlisten();
    };
  }, []);

  const connect = useCallback(async (
    roomId: string,
    options?: { forceReconnect?: boolean },
  ) => {
    const forceReconnect = options?.forceReconnect ?? false;
    if (!forceReconnect && connectedRoomIdRef.current === roomId) return;
    if (isConnectingRef.current) return;
    // Cancel any in-progress auto-rejoin (e.g. user connects to a different room)
    rejoinRoomRef.current = null;
    isConnectingRef.current = true;
    const { inputDeviceId, outputDeviceId } = getStoredAudioDevicePreferences();
    setState((prev) => ({
      ...prev,
      isConnecting: true,
      error: null,
      connectedRoomId: roomId,
    }));
    try {
      await invoke("voice_connect", { roomId, inputDeviceId, outputDeviceId });
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
    // Cancel any in-progress auto-rejoin
    rejoinRoomRef.current = null;
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

  const toggleNoiseSuppression = useCallback(() => {
    invoke<boolean>("voice_toggle_noise_suppression")
      .then((enabled) => {
        setState((prev) => ({ ...prev, isNoiseSuppressed: enabled }));
      })
      .catch((e) => {
        console.error("Failed to toggle noise suppression:", e);
      });
  }, []);

  const startScreenShare = useCallback(
    async (
      mode: "screen" | "window",
      windowTitle?: string,
      windowHandle?: string,
    ): Promise<void> => {
      setState((prev) => ({ ...prev, error: null }));
      try {
        await invoke("voice_start_screen_share", {
          mode,
          windowTitle: windowTitle ?? null,
          windowHandle: windowHandle ?? null,
        });
      } catch (e) {
        console.error("Failed to start screen share:", e);
        setState((prev) => ({ ...prev, error: String(e) }));
        throw e;
      }
    },
    [],
  );

  const enumerateScreenShareWindows = useCallback(
    () => invoke<ScreenShareWindowOption[]>("enumerate_screen_share_windows"),
    [],
  );

  const stopScreenShare = useCallback(async (): Promise<void> => {
    try {
      await invoke("voice_stop_screen_share");
    } catch (e) {
      console.error("Failed to stop screen share:", e);
      throw e;
    }
  }, []);

  const getLowBandwidthMode = useCallback(
    () => invoke<boolean>("get_low_bandwidth_mode"),
    [],
  );

  const setLowBandwidthMode = useCallback(
    (enabled: boolean) => invoke<void>("set_low_bandwidth_mode", { enabled }),
    [],
  );

  const getNoiseSuppressionConfig = useCallback(
    () =>
      invoke<{ extraAttenuation: number; agcTargetRms: number }>(
        "get_noise_suppression_config",
      ),
    [],
  );

  const setNoiseSuppressionConfig = useCallback(
    (config: { extraAttenuation: number; agcTargetRms: number }) =>
      invoke<void>("set_noise_suppression_config", { config }),
    [],
  );

  const listAudioDevices = useCallback(
    () => invoke<AudioDeviceList>("voice_list_audio_devices"),
    [],
  );

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
    toggleNoiseSuppression,
    startScreenShare,
    enumerateScreenShareWindows,
    stopScreenShare,
    getLowBandwidthMode,
    setLowBandwidthMode,
    getNoiseSuppressionConfig,
    setNoiseSuppressionConfig,
    setParticipantVolume,
    listAudioDevices,
  };
}