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
  connectionInterrupted: boolean;
}

/**
 * Full voice state emitted from the Rust backend.
 * Matches voice::VoiceStateEvent on the Rust side.
 */
interface VoiceStateEvent {
  roomId: string;
  attemptId: string;
  isReconnecting: boolean;
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
  targetRoomId: string | null;
  isReconnecting: boolean;
  endedRoomId: string | null;
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
    options?: { forceReconnect?: boolean; replaceOtherSessions?: boolean },
  ) => Promise<boolean>;
  disconnect: (expectedRoomId?: string) => Promise<void>;
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

export function useVoiceCall(isVoiceChannel: (roomId: string) => boolean) {
  const [state, setState] = useState<VoiceCallState>({
    targetRoomId: null,
    isReconnecting: false,
    endedRoomId: null,
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

  const targetRoomIdRef = useRef<string | null>(null);
  const connectedRoomIdRef = useRef<string | null>(null);
  const revision = useRef(0);
  const transportAttempt = useRef<string | null>(null);
  const pendingConnect = useRef<Promise<boolean> | null>(null);
  const pendingDisconnect = useRef<Promise<void> | null>(null);
  const activeScreenShare = useRef<{
    roomId: string;
    source: Parameters<VoiceCallActions["startScreenShare"]>;
  } | null>(null);
  const previousParticipants = useRef<Set<string>>(new Set());
  const checkVoiceChannel = useRef(isVoiceChannel);
  checkVoiceChannel.current = isVoiceChannel;

  const disconnect = useCallback((expectedRoomId?: string) => {
    const target = targetRoomIdRef.current;
    const roomId = expectedRoomId ?? target;
    if (!roomId) return Promise.resolve();
    if (target && target !== roomId) return Promise.resolve();
    if (pendingDisconnect.current) return pendingDisconnect.current;

    revision.current++;
    transportAttempt.current = null;
    targetRoomIdRef.current = null;
    connectedRoomIdRef.current = null;
    activeScreenShare.current = null;
    previousParticipants.current.clear();
    if (target) playSound("ui/pop_close");
    setState((prev) => ({
      ...prev,
      targetRoomId: null,
      connectedRoomId: null,
      isConnecting: false,
      isReconnecting: false,
      isMicEnabled: false,
      isDeafened: false,
      screenSharingOwners: [],
      isLocalScreenSharing: false,
      error: null,
      participants: [],
      disconnectingFromRoomId: roomId,
    }));
    const stopping = (pendingConnect.current ?? Promise.resolve()).then(() =>
      invoke<void>("voice_disconnect", { roomId }),
    ).catch((error) => {
      console.error("Failed to disconnect voice:", error);
    }).finally(() => {
      pendingDisconnect.current = null;
      setState((prev) => ({ ...prev, disconnectingFromRoomId: null }));
    });
    pendingDisconnect.current = stopping;
    return stopping;
  }, []);

  const connectAttempt = useCallback(async (roomId: string, attempt: number, replaceOtherSessions: boolean) => {
    if (pendingDisconnect.current) await pendingDisconnect.current;
    if (revision.current !== attempt) return false;
    const { inputDeviceId, outputDeviceId } = getStoredAudioDevicePreferences();
    const attemptId = crypto.randomUUID();
    transportAttempt.current = attemptId;
    try {
      await invoke("voice_connect", { roomId, attemptId, inputDeviceId, outputDeviceId, replaceOtherSessions });
      return revision.current === attempt && targetRoomIdRef.current === roomId;
    } catch (error) {
      if (revision.current === attempt) {
        connectedRoomIdRef.current = null;
        setState((prev) => ({
          ...prev, connectedRoomId: null, participants: [], isMicEnabled: false,
          isDeafened: false, isLocalScreenSharing: false, screenSharingOwners: [],
          error: String(error),
        }));
      }
      return false;
    }
  }, []);

  const connect = useCallback<VoiceCallActions["connect"]>((roomId, options) => {
    if (pendingConnect.current && !pendingDisconnect.current) return Promise.resolve(false);
    if (!options?.forceReconnect && connectedRoomIdRef.current === roomId && !pendingDisconnect.current) {
      return Promise.resolve(true);
    }
    const wasInRoom = targetRoomIdRef.current === roomId;
    const attempt = ++revision.current;
    transportAttempt.current = null;
    targetRoomIdRef.current = roomId;
    connectedRoomIdRef.current = null;
    activeScreenShare.current = null;
    previousParticipants.current.clear();
    setState((prev) => ({
      ...prev, targetRoomId: roomId, connectedRoomId: null, isConnecting: true,
      isReconnecting: wasInRoom || !!options?.forceReconnect, endedRoomId: null,
      error: null, participants: [], screenSharingOwners: [], isLocalScreenSharing: false,
      disconnectingFromRoomId: null,
    }));
    const joining = connectAttempt(roomId, attempt, options?.replaceOtherSessions ?? !wasInRoom)
      .then((joined) => {
        if (!joined && revision.current === attempt) {
          setState((prev) => ({ ...prev, isConnecting: false, isReconnecting: false }));
        }
        return joined;
      }).finally(() => {
        if (pendingConnect.current === joining) pendingConnect.current = null;
      });
    pendingConnect.current = joining;
    return joining;
  }, [connectAttempt]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    void Promise.allSettled([
      listen<VoiceStateEvent>("voice-state-changed", ({ payload: event }) => {
        if (disposed || targetRoomIdRef.current !== event.roomId || transportAttempt.current !== event.attemptId) return;
        const connected = event.connectedRoomId !== null && !event.isConnecting;
        const wasConnected = connectedRoomIdRef.current === event.roomId;
        connectedRoomIdRef.current = connected ? event.roomId : null;
        setState((prev) => ({
          ...prev,
          connectedRoomId: connected ? event.roomId : null,
          isConnecting: event.isConnecting || (!!event.error && prev.isReconnecting),
          isReconnecting: connected ? false : event.isReconnecting || prev.isReconnecting,
          isMicEnabled: connected && event.isMicEnabled,
          isDeafened: connected && (event.isDeafened ?? false),
          isNoiseSuppressed: event.isNoiseSuppressed,
          screenSharingOwners: connected ? event.screenSharingOwners : [],
          isLocalScreenSharing: connected && event.isLocalScreenSharing,
          error: event.error,
          participants: connected ? event.participants : [],
        }));

        if (!connected) return;
        const ids = new Set(event.participants.filter((p) => !p.isLocal).map((p) => p.identity));
        if (!wasConnected && previousParticipants.current.size === 0) playSound("ui/pop_open");
        for (const id of ids) {
          if (!previousParticipants.current.has(id)) playSound("ui/pop_open");
        }
        if (wasConnected && checkVoiceChannel.current(event.roomId)) {
          for (const id of previousParticipants.current) {
            if (!ids.has(id)) playSound("ui/pop_close");
          }
        }
        previousParticipants.current = ids;
      }),
      listen<{ roomId: string; attemptId: string; message: string }>("voice-session-ended", ({ payload }) => {
        if (disposed || targetRoomIdRef.current !== payload.roomId || transportAttempt.current !== payload.attemptId) return;
        void disconnect(payload.roomId);
        setState((prev) => ({ ...prev, endedRoomId: payload.roomId, error: payload.message }));
      }),
      listen<{ roomId: string; attemptId: string }>("voice-livekit-kicked", async ({ payload: { roomId, attemptId } }) => {
        if (disposed || targetRoomIdRef.current !== roomId || transportAttempt.current !== attemptId) return;
        const attempt = ++revision.current;
        connectedRoomIdRef.current = null;
        activeScreenShare.current = null;
        setState((prev) => ({
          ...prev, connectedRoomId: null, isConnecting: true, isReconnecting: true,
          participants: [], screenSharingOwners: [], isLocalScreenSharing: false,
        }));

        for (const delay of [2000, 4000, 8000, 16000, 30000]) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (disposed || revision.current !== attempt) return;
          const joining = connectAttempt(roomId, attempt, false);
          pendingConnect.current = joining;
          const joined = await joining;
          if (pendingConnect.current === joining) pendingConnect.current = null;
          if (disposed || revision.current !== attempt || joined) return;
        }
        setState((prev) => ({
          ...prev, isConnecting: false, isReconnecting: false, error: "Lost connection to voice chat",
        }));
      }),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (disposed) result.value();
          else unlisteners.push(result.value);
        } else console.error("Failed to subscribe to voice events:", result.reason);
      }
    });
    return () => {
      disposed = true;
      unlisteners.forEach((stop) => stop());
    };
  }, [connectAttempt, disconnect]);

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
      const roomId = connectedRoomIdRef.current;
      setState((prev) => ({ ...prev, error: null }));
      try {
        await invoke("voice_start_screen_share", {
          mode,
          windowTitle: windowTitle ?? null,
          windowHandle: windowHandle ?? null,
        });
        if (roomId && connectedRoomIdRef.current === roomId) {
          activeScreenShare.current = { roomId, source: [mode, windowTitle, windowHandle] };
        }
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
    const previousShare = activeScreenShare.current;
    try {
      await invoke("voice_stop_screen_share");
      if (activeScreenShare.current === previousShare) activeScreenShare.current = null;
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
    async (enabled: boolean) => {
      const share = state.isLocalScreenSharing ? activeScreenShare.current : null;
      await invoke<void>("set_low_bandwidth_mode", { enabled });
      // The capture options belong to the call and survive room navigation.
      if (share && activeScreenShare.current === share && connectedRoomIdRef.current === share.roomId) {
        await stopScreenShare();
        if (connectedRoomIdRef.current === share.roomId) await startScreenShare(...share.source);
      }
    },
    [state.isLocalScreenSharing, startScreenShare, stopScreenShare],
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
      const roomId = targetRoomIdRef.current;
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
