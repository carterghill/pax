import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Volume2, Mic, MicOff, PhoneOff, Loader2, Monitor, MonitorUp, Headphones, Settings, Slash } from "lucide-react";
import { createPortal } from "react-dom";
import { useTheme } from "../theme/ThemeContext";
import { LivekitVoiceParticipantInfo, Room, VoiceParticipant as MatrixVoiceParticipant } from "../types/matrix";
import { ScreenShareWindowOption, VoiceCall } from "../hooks/useVoiceCall";
import {
  compareByDisplayThenKey,
  extractMatrixUserId,
  localpartFromUserId,
  normalizeUserId,
} from "../utils/matrix";
import UserAvatar from "./UserAvatar";
import { useUserVolume } from "../hooks/useUserVolume";
import VolumeContextMenu from "./VolumeContextMenu";
import VoiceAudioSettingsSection from "./VoiceAudioSettingsSection";
import ScreenShareGrid from "./ScreenShareGrid";
import { useOverlayObstruction, registerObstruction, unregisterObstruction } from "../hooks/useOverlayObstruction";

interface VoiceRoomViewProps {
  room: Room;
  voiceCall: VoiceCall;
  voiceParticipants: MatrixVoiceParticipant[];
  /** LiveKit Room Service snapshot (mute/deafen/speaking) when not connected */
  livekitInRoom: LivekitVoiceParticipantInfo[];
  userId: string;
}

export default function VoiceRoomView({
  room,
  voiceCall,
  voiceParticipants,
  livekitInRoom,
  userId,
}: VoiceRoomViewProps) {
  // Destructure actions from voiceCall; use voiceCall directly as callState
  // since VoiceCall extends VoiceCallState.
  const callState = voiceCall;
  const {
    connect: onConnect,
    disconnect: onDisconnect,
    toggleMic: onToggleMic,
    toggleDeafen: onToggleDeafen,
    toggleNoiseSuppression: onToggleNoiseSuppression,
    startScreenShare: onStartScreenShare,
    enumerateScreenShareWindows: onEnumerateScreenShareWindows,
    stopScreenShare: onStopScreenShare,
    getLowBandwidthMode: onGetLowBandwidthMode,
    setLowBandwidthMode: onSetLowBandwidthMode,
    getNoiseSuppressionConfig: onGetNoiseSuppressionConfig,
    setNoiseSuppressionConfig: onSetNoiseSuppressionConfig,
    setParticipantVolume: onSetParticipantVolume,
    listAudioDevices: onListAudioDevices,
  } = voiceCall;
  const { palette, spacing, typography } = useTheme();
  const { getVolume, setVolume } = useUserVolume();
  const [screenShareMenuOpen, setScreenShareMenuOpen] = useState(false);
  const [generalSettingsOpen, setGeneralSettingsOpen] = useState(false);
  const [generalSettingsTab, setGeneralSettingsTab] = useState<"stream" | "audio">("stream");
  const [lowBandwidthMode, setLowBandwidthMode] = useState(false);
  const [isStartingScreenShare, setIsStartingScreenShare] = useState(false);
  const screenShareMenuRef = useRef<HTMLDivElement>(null);
  const screenShareMenuPopupRef = useRef<HTMLDivElement>(null);
  const generalSettingsRef = useRef<HTMLDivElement>(null);
  const generalSettingsPopupRef = useRef<HTMLDivElement>(null);
  const activeShareRef = useRef<{
    mode: "screen" | "window";
    windowTitle?: string;
    windowHandle?: string;
  } | null>(null);
  const isLinux = navigator.userAgent.includes("Linux");

  // Popups are `position: absolute` — parent `getBoundingClientRect()` excludes them; ref the panels.
  // Screen share popup obstruction is managed via callback ref below
  // because the portal doesn't mount until screenShareMenuPos is set
  // (async in useEffect), so useOverlayObstruction's useLayoutEffect
  // fires before the ref is populated and never re-runs.
  const screenShareObsIdRef = useRef<number | null>(null);
  const screenSharePopupCallbackRef = useCallback((el: HTMLDivElement | null) => {
    // Also keep the regular ref updated for click-outside detection
    screenShareMenuPopupRef.current = el;
    if (el) {
      screenShareObsIdRef.current = registerObstruction(el);
    } else if (screenShareObsIdRef.current !== null) {
      unregisterObstruction(screenShareObsIdRef.current);
      screenShareObsIdRef.current = null;
    }
  }, []);
  useOverlayObstruction(generalSettingsPopupRef, generalSettingsOpen);
  const [windowList, setWindowList] = useState<ScreenShareWindowOption[]>([]);
  const [windowListLoading, setWindowListLoading] = useState(false);
  const [screenShareMenuPos, setScreenShareMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    onGetLowBandwidthMode().then(setLowBandwidthMode).catch(() => {});
  }, [onGetLowBandwidthMode]);

  const reconnectAfterDeviceChange = useCallback(async () => {
    if (callState.connectedRoomId === room.id && !callState.isConnecting) {
      await onConnect(room.id, { forceReconnect: true });
    }
  }, [callState.connectedRoomId, callState.isConnecting, onConnect, room.id]);

  useEffect(() => {
    if (!screenShareMenuOpen || isLinux) return;
    let cancelled = false;
    setWindowList([]);
    setWindowListLoading(true);
    onEnumerateScreenShareWindows()
      .then((list) => {
        if (!cancelled) {
          setWindowList(list);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.error("Failed to enumerate windows:", e);
          setWindowList([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWindowListLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [screenShareMenuOpen, isLinux, onEnumerateScreenShareWindows]);

  useEffect(() => {
    if (!screenShareMenuOpen) {
      setScreenShareMenuPos(null);
      return;
    }

    function updateScreenShareMenuPos() {
      const anchor = screenShareMenuRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const gap = spacing.unit * 2;
      const width = isLinux
        ? Math.min(320, Math.max(220, viewportWidth - 24))
        : Math.min(760, Math.max(320, viewportWidth - 24));
      const minLeft = 12;
      const maxLeft = Math.max(minLeft, viewportWidth - width - 12);
      const centeredLeft = rect.left + rect.width / 2 - width / 2;
      const left = Math.min(Math.max(centeredLeft, minLeft), maxLeft);

      setScreenShareMenuPos({
        top: rect.top - gap,
        left,
        width,
      });
    }

    updateScreenShareMenuPos();
    window.addEventListener("resize", updateScreenShareMenuPos);
    window.addEventListener("scroll", updateScreenShareMenuPos, true);
    return () => {
      window.removeEventListener("resize", updateScreenShareMenuPos);
      window.removeEventListener("scroll", updateScreenShareMenuPos, true);
    };
  }, [screenShareMenuOpen, isLinux, spacing.unit]);

  const startShare = useCallback(
    async (mode: "screen" | "window", windowTitle?: string, windowHandle?: string) => {
      setIsStartingScreenShare(true);
      activeShareRef.current = { mode, windowTitle, windowHandle };
      try {
        await onStartScreenShare(mode, windowTitle, windowHandle);
      } catch (e) {
        setIsStartingScreenShare(false);
        console.error("Failed to start screen share:", e);
      }
    },
    [onStartScreenShare]
  );

  const stopShare = useCallback(async () => {
    setIsStartingScreenShare(false);
    activeShareRef.current = null;
    try {
      await onStopScreenShare();
    } catch (e) {
      console.error("Failed to stop screen share:", e);
    }
  }, [onStopScreenShare]);

  const toggleLowBandwidth = useCallback(
    async () => {
      const next = !lowBandwidthMode;
      setLowBandwidthMode(next);
      try {
        await onSetLowBandwidthMode(next);
        // Restart active screen share so bitrate/fps settings take effect
        const active = activeShareRef.current;
        if (callState.isLocalScreenSharing && active) {
          await onStopScreenShare();
          await onStartScreenShare(active.mode, active.windowTitle, active.windowHandle);
        }
      } catch (e) {
        console.error("Failed to toggle low bandwidth mode:", e);
      }
    },
    [lowBandwidthMode, onSetLowBandwidthMode, callState.isLocalScreenSharing, onStopScreenShare, onStartScreenShare]
  );

  useEffect(() => {
    if (callState.isLocalScreenSharing) {
      setIsStartingScreenShare(false);
    }
  }, [callState.isLocalScreenSharing]);

  // Close context menus on outside click.
  useEffect(() => {
    if (!generalSettingsOpen && !screenShareMenuOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        generalSettingsOpen &&
        generalSettingsRef.current &&
        !generalSettingsRef.current.contains(target)
      ) {
        setGeneralSettingsOpen(false);
      }
      if (
        screenShareMenuOpen &&
        screenShareMenuRef.current &&
        !screenShareMenuRef.current.contains(target) &&
        (!screenShareMenuPopupRef.current || !screenShareMenuPopupRef.current.contains(target))
      ) {
        setScreenShareMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [generalSettingsOpen, screenShareMenuOpen]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    identity: string;
    displayName: string;
  } | null>(null);

  /** Shared volume change handler for screen share streams — persists + sends to Rust. */
  const handleStreamVolumeChange = useCallback(
    (identity: string, vol: number) => {
      setVolume(identity, vol, "screenshare_audio");
      onSetParticipantVolume(identity, vol, "screenshare_audio");
    },
    [setVolume, onSetParticipantVolume],
  );

  /** Get stream (screenshare_audio) volume for a participant. */
  const getStreamVolume = useCallback(
    (identity: string) => getVolume(identity, "screenshare_audio"),
    [getVolume],
  );

  const isConnected = callState.connectedRoomId === room.id && !callState.isConnecting;
  const isConnecting = callState.isConnecting && callState.connectedRoomId === room.id;
  const hasScreenShare = callState.screenSharingOwners.length > 0 || callState.isLocalScreenSharing;

  // Build set of LiveKit participant identities (normalized) for matching
  // Build avatar lookup from Matrix roster (keyed by normalized userId)
  const avatarByUserId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const p of voiceParticipants) {
      map.set(normalizeUserId(p.userId), p.avatarUrl);
    }
    return map;
  }, [voiceParticipants]);

  const liveKitIdentitySet = useMemo(() => {
    const set = new Set<string>();
    for (const p of callState.participants) {
      set.add(normalizeUserId(p.identity));
      set.add(normalizeUserId(localpartFromUserId(p.identity)));
    }
    return set;
  }, [callState.participants]);

  // Merged participants: LiveKit-connected + room participants who are still connecting
  const allParticipants = useMemo(() => {
    const result: Array<{
      identity: string;
      displayName: string;
      avatarUrl?: string | null;
      isLocal: boolean;
      isConnecting: boolean;
      isSpeaking?: boolean;
      isMuted?: boolean;
      isDeafened?: boolean;
    }> = [];

    // Add connected LiveKit participants
    for (const p of callState.participants) {
      const mxid = extractMatrixUserId(p.identity);
      const displayName = localpartFromUserId(p.identity);
      result.push({
        identity: p.identity,
        displayName,
        avatarUrl: avatarByUserId.get(normalizeUserId(mxid)) ?? null,
        isLocal: p.isLocal,
        isConnecting: false,
        isSpeaking: p.isSpeaking,
        isMuted: p.isMuted,
        isDeafened: p.isDeafened,
      });
    }

    // When we're connected (not just connecting), add room participants not yet in LiveKit
    const isConnectedToThisRoom = callState.connectedRoomId === room.id && !callState.isConnecting;
    if (isConnectedToThisRoom && voiceParticipants) {
      for (const p of voiceParticipants) {
        const normalized = normalizeUserId(p.userId);
        const localpart = localpartFromUserId(p.userId);
        const inLiveKit = liveKitIdentitySet.has(normalized) || liveKitIdentitySet.has(normalizeUserId(localpart));
        if (inLiveKit) continue;

        const displayName = p.displayName ?? p.userId;
        const localDisplayName = localpartFromUserId(displayName);
        const isLocal = p.userId === userId;
        result.push({
          identity: p.userId,
          displayName: localDisplayName,
          avatarUrl: p.avatarUrl,
          isLocal,
          isConnecting: true,
        });
      }
    }

    result.sort((a, b) =>
      compareByDisplayThenKey(a.displayName, a.identity, b.displayName, b.identity)
    );
    return result;
  }, [callState.participants, callState.connectedRoomId, callState.isConnecting, room.id, voiceParticipants, userId, liveKitIdentitySet, avatarByUserId]);

  const showLobby = !isConnected && !isConnecting && !callState.error;

  const lobbyParticipants = useMemo(() => {
    if (!showLobby) return [];
    type Row = {
      identity: string;
      displayName: string;
      avatarUrl: string | null;
      isLocal: boolean;
      isMuted: boolean;
      isDeafened: boolean;
      isSpeaking: boolean;
    };
    const result: Row[] = [];
    const liveByMxid = new Map<string, LivekitVoiceParticipantInfo>();
    for (const lp of livekitInRoom) {
      const mxid = extractMatrixUserId(lp.identity);
      liveByMxid.set(normalizeUserId(mxid), lp);
      liveByMxid.set(normalizeUserId(lp.identity), lp);
    }
    const covered = new Set<string>();
    for (const p of voiceParticipants) {
      const nk = normalizeUserId(p.userId);
      covered.add(nk);
      const lp = liveByMxid.get(nk);
      const displayName = p.displayName ?? p.userId;
      const localDisplayName = localpartFromUserId(displayName);
      result.push({
        identity: p.userId,
        displayName: localDisplayName,
        avatarUrl: p.avatarUrl,
        isLocal: p.userId === userId,
        isMuted: lp?.isMuted ?? false,
        isDeafened: lp?.isDeafened ?? false,
        isSpeaking: lp?.isSpeaking ?? false,
      });
    }
    for (const lp of livekitInRoom) {
      const mxid = extractMatrixUserId(lp.identity);
      const nk = normalizeUserId(mxid);
      if (covered.has(nk)) continue;
      const localDisplayName = localpartFromUserId(mxid);
      result.push({
        identity: lp.identity,
        displayName: localDisplayName,
        avatarUrl: avatarByUserId.get(nk) ?? null,
        isLocal: nk === normalizeUserId(userId),
        isMuted: lp.isMuted,
        isDeafened: lp.isDeafened,
        isSpeaking: lp.isSpeaking,
      });
    }
    result.sort((a, b) =>
      compareByDisplayThenKey(a.displayName, a.identity, b.displayName, b.identity)
    );
    return result;
  }, [showLobby, voiceParticipants, livekitInRoom, userId, avatarByUserId]);

  // Display names for screen share header
  const remoteSharers = callState.screenSharingOwners.filter(id => {
    // Filter out local identity (we show "You are sharing" separately)
    return localpartFromUserId(id) !== localpartFromUserId(userId);
  });
  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      {/* Header */}
      <div style={{
        padding: `${spacing.unit * 4}px ${spacing.unit * 4}px`,
        borderBottom: `1px solid ${palette.border}`,
        height: spacing.headerHeight,
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
      }}>
        <Volume2 size={20} color={palette.textSecondary} />
        <span style={{
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          fontSize: typography.fontSizeBase,
          flex: 1,
        }}>
          {room.name}
        </span>
        {isConnected && (
          <span style={{
            fontSize: typography.fontSizeSmall,
            color: "#23a55a",
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              backgroundColor: "#23a55a",
            }} />
            Connected
          </span>
        )}
      </div>

      {/* Main content: screen share (primary) or participant grid */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: hasScreenShare ? "row" : "column",
        overflow: "hidden",
      }}>
        {hasScreenShare && (
          <ScreenShareGrid
            remoteSharers={remoteSharers}
            isLocalScreenSharing={callState.isLocalScreenSharing}
            getVolume={getStreamVolume}
            onVolumeChange={handleStreamVolumeChange}
            onStreamContextMenu={(e, identity, displayName) => {
              e.preventDefault();
              setContextMenu({
                x: e.clientX,
                y: e.clientY,
                identity,
                displayName,
              });
            }}
          />
        )}
        <div style={{
          flex: hasScreenShare ? "0 0 auto" : 1,
          display: "flex",
          flexWrap: "wrap",
          alignContent: hasScreenShare ? "flex-start" : "center",
          justifyContent: "center",
          gap: spacing.unit * 4,
          padding: spacing.unit * 6,
          overflowY: "auto",
          width: hasScreenShare ? 180 : undefined,
        }}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        {isConnecting && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: spacing.unit * 3,
            color: palette.textSecondary,
          }}>
            <Loader2
              size={48}
              color={palette.textSecondary}
              style={{ animation: "spin 1s linear infinite" }}
            />
            <span style={{ fontSize: typography.fontSizeLarge }}>Connecting...</span>
          </div>
        )}

        {callState.error && !isConnected && !isConnecting && (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: spacing.unit * 3,
            color: palette.textSecondary,
            maxWidth: 400,
            textAlign: "center",
          }}>
            <Volume2 size={64} color={palette.textSecondary} opacity={0.4} />
            <span style={{ fontSize: typography.fontSizeBase, color: "#f23f43" }}>
              {callState.error}
            </span>
          </div>
        )}

        {showLobby && lobbyParticipants.map((p) => (
          <div
            key={p.identity}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: spacing.unit * 2,
              width: 120,
            }}
          >
            <UserAvatar
              userId={extractMatrixUserId(p.identity)}
              displayName={p.displayName}
              avatarUrlHint={p.avatarUrl}
              size={80}
              fontSize={28}
              style={{
                boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                transition: "box-shadow 0.15s ease",
              }}
            />
            <span style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textPrimary,
              textAlign: "center",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: spacing.unit,
            }}>
              {p.displayName}{p.isLocal ? " (you)" : ""}
              <span style={{ marginLeft: spacing.unit, display: "inline-flex", alignItems: "center", gap: spacing.unit }}>
                {p.isMuted && <MicOff size={12} color={palette.textSecondary} />}
                {p.isDeafened && (
                  <span style={{ position: "relative", width: 12, height: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <Headphones size={12} color={palette.textSecondary} />
                    <Slash size={10} color={palette.textSecondary} style={{ position: "absolute" }} />
                  </span>
                )}
              </span>
            </span>
          </div>
        ))}

        {showLobby && lobbyParticipants.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeBase,
            textAlign: "center",
            maxWidth: 360,
          }}>
            No one is listed in this call yet. Join to connect, or wait for Matrix roster updates.
          </div>
        )}

        {/* Show errors (e.g. screen share failure) even when connected */}
        {callState.error && isConnected && (
          <div style={{
            padding: spacing.unit * 2,
            margin: spacing.unit * 2,
            backgroundColor: "rgba(242, 63, 67, 0.15)",
            borderRadius: 8,
            color: "#f23f43",
            fontSize: typography.fontSizeSmall,
          }}>
            {callState.error}
          </div>
        )}

        {isConnected && allParticipants.map((p) => (
          <div
            key={p.identity}
            onContextMenu={(e) => {
              if (p.isLocal || p.isConnecting) return; // No volume control for yourself or connecting users
              e.preventDefault();
              setContextMenu({
                x: e.clientX,
                y: e.clientY,
                identity: p.identity,
                displayName: p.displayName,
              });
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: spacing.unit * 2,
              width: 120,
              cursor: p.isLocal ? "default" : "context-menu",
            }}
          >
            {/* Avatar circle - circular progress when connecting */}
            {p.isConnecting ? (
              <div style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                backgroundColor: palette.bgActive,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                <Loader2
                  size={32}
                  color={palette.textSecondary}
                  style={{ animation: "spin 1s linear infinite" }}
                />
              </div>
            ) : (
              <UserAvatar
                userId={extractMatrixUserId(p.identity)}
                displayName={p.displayName}
                avatarUrlHint={p.avatarUrl}
                size={80}
                fontSize={28}
                style={{
                  boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                  transition: "box-shadow 0.15s ease",
                }}
              />
            )}
            <span style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textPrimary,
              textAlign: "center",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: spacing.unit,
            }}>
              {p.displayName}{p.isLocal ? " (you)" : ""}
              <span style={{ marginLeft: spacing.unit, display: "inline-flex", alignItems: "center", gap: spacing.unit }}>
                {!p.isConnecting && callState.screenSharingOwners.includes(p.identity) && (
                  <Monitor size={12} color="#23a55a" />
                )}
                {!p.isConnecting && p.isMuted && <MicOff size={12} color={palette.textSecondary} />}
                {!p.isConnecting && p.isDeafened && (
                  <span style={{ position: "relative", width: 12, height: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <Headphones size={12} color={palette.textSecondary} />
                    <Slash size={10} color={palette.textSecondary} style={{ position: "absolute" }} />
                  </span>
                )}
                {p.isConnecting && (
                  <Loader2
                    size={12}
                    color={palette.textSecondary}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                )}
              </span>
            </span>
          </div>
        ))}

        {isConnected && allParticipants.length === 0 && !hasScreenShare && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeBase,
          }}>
            No one else is here yet
          </div>
        )}
        {isConnected && allParticipants.length === 0 && hasScreenShare && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
          }}>
            Participants
          </div>
        )}
      </div>
      </div>

      {/* Lobby: join call */}
      {showLobby && (
        <div style={{
          padding: `${spacing.unit * 4}px`,
          borderTop: `1px solid ${palette.border}`,
          display: "flex",
          justifyContent: "center",
        }}>
          <button
            type="button"
            onClick={() => voiceCall.connect(room.id)}
            style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 5}px`,
              borderRadius: spacing.unit * 2,
              border: "none",
              cursor: "pointer",
              fontSize: typography.fontSizeBase,
              fontWeight: typography.fontWeightBold,
              backgroundColor: "#23a55a",
              color: "#fff",
            }}
          >
            Join voice
          </button>
        </div>
      )}

      {/* Controls bar */}
      {isConnected && (
        <div style={{
          padding: `${spacing.unit * 4}px`,
          borderTop: `1px solid ${palette.border}`,
          display: "flex",
          justifyContent: "center",
          gap: spacing.unit * 3,
        }}>
          {/* Mute/Unmute */}
          <button
            onClick={onToggleMic}
            title={callState.isMicEnabled ? "Mute" : "Unmute"}
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: callState.isMicEnabled
                ? palette.bgActive
                : palette.textPrimary,
              color: callState.isMicEnabled ? palette.textPrimary : palette.bgPrimary,
              transition: "background-color 0.15s ease",
            }}
          >
            {callState.isMicEnabled ? <Mic size={20} /> : <MicOff size={20} />}
          </button>

          {/* Deafen/Undeafen (local playback mute) */}
          <button
            onClick={onToggleDeafen}
            title={callState.isDeafened ? "Undeafen" : "Deafen"}
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: callState.isDeafened
                ? palette.textPrimary
                : palette.bgActive,
              color: callState.isDeafened ? palette.bgPrimary : palette.textPrimary,
              transition: "background-color 0.15s ease",
            }}
          >
            {callState.isDeafened ? (
              <span style={{ position: "relative", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <Headphones size={20} />
                <Slash size={14} style={{ position: "absolute" }} />
              </span>
            ) : (
              <Headphones size={20} />
            )}
          </button>

          {/* Screen Share */}
          <div ref={screenShareMenuRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 2 }}>
            <button
              onClick={() => {
                if (callState.isLocalScreenSharing) {
                  void stopShare();
                } else {
                  setScreenShareMenuOpen((v) => !v);
                }
              }}
              title={callState.isLocalScreenSharing ? "Stop sharing screen" : "Share screen"}
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: (callState.isLocalScreenSharing || isStartingScreenShare || screenShareMenuOpen) ? palette.textPrimary : palette.bgActive,
                color: (callState.isLocalScreenSharing || isStartingScreenShare || screenShareMenuOpen) ? palette.bgPrimary : palette.textPrimary,
                transition: "background-color 0.15s ease",
              }}
            >
              {callState.isLocalScreenSharing ? <MonitorUp size={20} /> : <Monitor size={20} />}
            </button>
            {screenShareMenuOpen &&
              !callState.isLocalScreenSharing &&
              screenShareMenuPos &&
              createPortal(
              <div
                ref={screenSharePopupCallbackRef}
                style={{
                position: "fixed",
                top: screenShareMenuPos.top,
                left: screenShareMenuPos.left,
                transform: "translateY(-100%)",
                backgroundColor: palette.bgSecondary,
                border: `1px solid ${palette.border}`,
                borderRadius: spacing.unit * 2,
                padding: spacing.unit * 4,
                display: "flex",
                flexDirection: "column",
                gap: spacing.unit * 2,
                width: screenShareMenuPos.width,
                maxWidth: screenShareMenuPos.width,
                maxHeight: "70vh",
                overflowY: "auto",
                zIndex: 2000,
                boxShadow: "0 12px 36px rgba(0,0,0,0.45)",
              }}
              >
                <button
                  onClick={() => {
                    void startShare("screen");
                    setScreenShareMenuOpen(false);
                  }}
                  style={{
                    border: `1px solid ${palette.border}`,
                    borderRadius: spacing.unit * 1.5,
                    cursor: "pointer",
                    backgroundColor: palette.bgActive,
                    color: palette.textPrimary,
                    padding: spacing.unit * 2,
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.unit * 2,
                    textAlign: "left",
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: spacing.unit * 1.5,
                      backgroundColor: palette.bgTertiary,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Monitor size={20} color={palette.textPrimary} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: typography.fontSizeSmall, fontWeight: 600 }}>
                      Share screen
                    </div>
                    <div style={{ fontSize: typography.fontSizeSmall - 1, color: palette.textSecondary }}>
                      Start sharing your primary display immediately
                    </div>
                  </div>
                </button>
                {isLinux ? (
                  <button
                    onClick={() => {
                      void startShare("window");
                      setScreenShareMenuOpen(false);
                    }}
                    style={{
                      padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                      border: "none",
                      borderRadius: spacing.unit,
                      cursor: "pointer",
                      backgroundColor: palette.bgActive,
                      color: palette.textPrimary,
                      fontSize: typography.fontSizeSmall,
                      textAlign: "left",
                    }}
                  >
                    Share application window...
                  </button>
                ) : (
                  <>
                    <div
                      style={{
                        paddingTop: spacing.unit,
                        borderTop: `1px solid ${palette.border}`,
                        fontSize: typography.fontSizeSmall,
                        fontWeight: 600,
                        color: palette.textSecondary,
                      }}
                    >
                      Share application window
                    </div>
                    {windowListLoading ? (
                      <div
                        style={{
                          padding: spacing.unit * 2,
                          color: palette.textSecondary,
                          fontSize: typography.fontSizeSmall,
                          textAlign: "center",
                        }}
                      >
                        Loading window previews...
                      </div>
                    ) : windowList.length === 0 ? (
                      <div
                        style={{
                          padding: spacing.unit * 2,
                          color: palette.textSecondary,
                          fontSize: typography.fontSizeSmall,
                          textAlign: "center",
                        }}
                      >
                        No windows found
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                          gap: spacing.unit * 2,
                        }}
                      >
                        {windowList.map((windowItem) => (
                          <button
                            key={windowItem.id}
                            onClick={() => {
                              void startShare("window", windowItem.title, windowItem.id);
                              setScreenShareMenuOpen(false);
                            }}
                            style={{
                              border: `1px solid ${palette.border}`,
                              borderRadius: spacing.unit * 1.5,
                              cursor: "pointer",
                              backgroundColor: palette.bgActive,
                              color: palette.textPrimary,
                              textAlign: "left",
                              padding: 0,
                              overflow: "hidden",
                              display: "flex",
                              flexDirection: "column",
                              minWidth: 0,
                            }}
                          >
                            <div
                              style={{
                                height: 110,
                                backgroundColor: palette.bgTertiary,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                overflow: "hidden",
                              }}
                            >
                              {windowItem.thumbnailDataUrl ? (
                                <img
                                  src={windowItem.thumbnailDataUrl}
                                  alt=""
                                  style={{
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "cover",
                                    display: "block",
                                  }}
                                />
                              ) : windowItem.iconDataUrl ? (
                                <img
                                  src={windowItem.iconDataUrl}
                                  alt=""
                                  style={{
                                    width: 40,
                                    height: 40,
                                    objectFit: "contain",
                                    display: "block",
                                  }}
                                />
                              ) : (
                                <Monitor size={28} color={palette.textSecondary} />
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: spacing.unit * 1.5,
                                padding: spacing.unit * 1.5,
                                minWidth: 0,
                              }}
                            >
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 8,
                                  backgroundColor: palette.bgSecondary,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  flexShrink: 0,
                                  overflow: "hidden",
                                }}
                              >
                                {windowItem.iconDataUrl ? (
                                  <img
                                    src={windowItem.iconDataUrl}
                                    alt=""
                                    style={{
                                      width: 20,
                                      height: 20,
                                      objectFit: "contain",
                                      display: "block",
                                    }}
                                  />
                                ) : (
                                  <Monitor size={14} color={palette.textSecondary} />
                                )}
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    fontSize: typography.fontSizeSmall,
                                    fontWeight: 600,
                                    color: palette.textPrimary,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {windowItem.title || "(no title)"}
                                </div>
                                <div
                                  style={{
                                    fontSize: typography.fontSizeSmall - 1,
                                    color: palette.textSecondary,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {windowItem.processName || "Application"}
                                </div>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>,
              document.body
            )}
          </div>

          {/* General settings */}
          <div ref={generalSettingsRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <button
              onClick={() => {
                setGeneralSettingsOpen((v) => {
                  const next = !v;
                  if (next) {
                    setGeneralSettingsTab("stream");
                  }
                  return next;
                });
                setScreenShareMenuOpen(false);
              }}
              title="Voice settings"
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: generalSettingsOpen ? palette.textPrimary : palette.bgActive,
                color: generalSettingsOpen ? palette.bgPrimary : palette.textPrimary,
                transition: "background-color 0.15s ease",
              }}
            >
              <Settings size={20} />
            </button>
            {generalSettingsOpen && (
              <div
                ref={generalSettingsPopupRef}
                style={{
                position: "absolute",
                bottom: `calc(100% + ${spacing.unit * 4}px)`,
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: palette.bgSecondary,
                border: `1px solid ${palette.border}`,
                borderRadius: spacing.unit * 2,
                padding: spacing.unit * 4,
                minWidth: 260,
                zIndex: 10,
              }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: spacing.unit * 3,
                    marginBottom: spacing.unit * 3,
                    borderBottom: `1px solid ${palette.border}`,
                    paddingBottom: spacing.unit,
                  }}
                >
                  <button
                    onClick={() => setGeneralSettingsTab("stream")}
                    style={{
                      padding: `${spacing.unit / 2}px 0`,
                      borderRadius: 0,
                      border: "none",
                      borderBottom: `2px solid ${generalSettingsTab === "stream" ? palette.accent : "transparent"}`,
                      cursor: "pointer",
                      backgroundColor: "transparent",
                      color: generalSettingsTab === "stream" ? palette.textHeading : palette.textSecondary,
                      fontSize: typography.fontSizeSmall,
                      fontWeight: 600,
                      marginBottom: -((spacing.unit) + 1),
                    }}
                  >
                    Stream
                  </button>
                  <button
                    onClick={() => setGeneralSettingsTab("audio")}
                    style={{
                      padding: `${spacing.unit / 2}px 0`,
                      borderRadius: 0,
                      border: "none",
                      borderBottom: `2px solid ${generalSettingsTab === "audio" ? palette.accent : "transparent"}`,
                      cursor: "pointer",
                      backgroundColor: "transparent",
                      color: generalSettingsTab === "audio" ? palette.textHeading : palette.textSecondary,
                      fontSize: typography.fontSizeSmall,
                      fontWeight: 600,
                      marginBottom: -((spacing.unit) + 1),
                    }}
                  >
                    Audio
                  </button>
                </div>

                {generalSettingsTab === "stream" && (
                  <>
                    <div style={{ marginBottom: spacing.unit * 2, fontWeight: 600, fontSize: typography.fontSizeSmall }}>
                      Low bandwidth mode
                    </div>
                    <button
                      onClick={() => { void toggleLowBandwidth(); }}
                      style={{
                        width: "100%",
                        padding: `${spacing.unit}px ${spacing.unit * 1.5}px`,
                        borderRadius: spacing.unit,
                        border: `1px solid ${palette.border}`,
                        cursor: "pointer",
                        backgroundColor: lowBandwidthMode ? palette.accent : palette.bgTertiary,
                        color: lowBandwidthMode ? "#fff" : palette.textPrimary,
                        fontSize: typography.fontSizeSmall,
                      }}
                    >
                      {lowBandwidthMode
                        ? "On — 500 kbps / 24 fps, no simulcast"
                        : isLinux
                          ? "Off — full quality, single layer (Linux)"
                          : "Off — simulcast enabled"}
                    </button>
                  </>
                )}

                {generalSettingsTab === "audio" && (
                  <VoiceAudioSettingsSection
                    active={generalSettingsOpen && generalSettingsTab === "audio"}
                    listAudioDevices={onListAudioDevices}
                    getNoiseSuppressionConfig={onGetNoiseSuppressionConfig}
                    setNoiseSuppressionConfig={onSetNoiseSuppressionConfig}
                    toggleNoiseSuppression={onToggleNoiseSuppression}
                    isNoiseSuppressed={callState.isNoiseSuppressed}
                    onAfterDevicePreferenceChange={reconnectAfterDeviceChange}
                  />
                )}
              </div>
            )}
          </div>

          {/* Disconnect */}
          <button
            onClick={onDisconnect}
            title="Disconnect"
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#f23f43",
              color: "#fff",
            }}
          >
            <PhoneOff size={20} />
          </button>
        </div>
      )}

      {/* Volume context menu */}
      {contextMenu && (
        <VolumeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          displayName={contextMenu.displayName}
          volume={getVolume(contextMenu.identity, "microphone")}
          onVolumeChange={(vol) => {
            setVolume(contextMenu.identity, vol, "microphone");
            onSetParticipantVolume(contextMenu.identity, vol, "microphone");
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}