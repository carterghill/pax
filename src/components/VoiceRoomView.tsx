import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Volume2, Mic, MicOff, PhoneOff, Loader2, AudioLines, Monitor, MonitorUp, Headphones, Settings, Slash } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { LivekitVoiceParticipantInfo, Room, VoiceParticipant as MatrixVoiceParticipant } from "../types/matrix";
import { VoiceCall } from "../hooks/useVoiceCall";
import {
  compareByDisplayThenKey,
  extractMatrixUserId,
  localpartFromUserId,
  normalizeUserId,
} from "../utils/matrix";
import { useUserVolume } from "../hooks/useUserVolume";
import VolumeContextMenu from "./VolumeContextMenu";
import ScreenShareGrid from "./ScreenShareGrid";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

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
    disconnect: onDisconnect,
    toggleMic: onToggleMic,
    toggleDeafen: onToggleDeafen,
    toggleNoiseSuppression: onToggleNoiseSuppression,
    startScreenShare: onStartScreenShare,
    enumerateScreenShareWindows: onEnumerateScreenShareWindows,
    stopScreenShare: onStopScreenShare,
    getScreenSharePreset: onGetScreenSharePreset,
    setScreenSharePreset: onSetScreenSharePreset,
    getNoiseSuppressionConfig: onGetNoiseSuppressionConfig,
    setNoiseSuppressionConfig: onSetNoiseSuppressionConfig,
    setParticipantVolume: onSetParticipantVolume,
  } = voiceCall;
  const { palette, spacing, typography } = useTheme();
  const { getVolume, setVolume } = useUserVolume();
  const [screenShareMenuOpen, setScreenShareMenuOpen] = useState(false);
  const [generalSettingsOpen, setGeneralSettingsOpen] = useState(false);
  const [screenSharePreset, setScreenSharePreset] = useState<"720p" | "1080p">("1080p");
  const [isStartingScreenShare, setIsStartingScreenShare] = useState(false);
  const [windowPickerOpen, setWindowPickerOpen] = useState(false);
  const [noiseConfig, setNoiseConfig] = useState({ extraAttenuation: 0.1, agcTargetRms: 6000 });
  const screenShareMenuRef = useRef<HTMLDivElement>(null);
  const screenShareMenuPopupRef = useRef<HTMLDivElement>(null);
  const generalSettingsRef = useRef<HTMLDivElement>(null);
  const generalSettingsPopupRef = useRef<HTMLDivElement>(null);
  const windowPickerOverlayRef = useRef<HTMLDivElement>(null);
  const activeShareRef = useRef<{ mode: "screen" | "window"; windowTitle?: string } | null>(null);

  // Popups are `position: absolute` — parent `getBoundingClientRect()` excludes them; ref the panels.
  useOverlayObstruction(screenShareMenuPopupRef, screenShareMenuOpen);
  useOverlayObstruction(generalSettingsPopupRef, generalSettingsOpen);
  useOverlayObstruction(windowPickerOverlayRef, windowPickerOpen);
  const [windowList, setWindowList] = useState<[string, string][]>([]);
  const [windowListLoading, setWindowListLoading] = useState(false);

  useEffect(() => {
    onGetScreenSharePreset().then(setScreenSharePreset).catch(() => {});
    onGetNoiseSuppressionConfig().then(setNoiseConfig).catch(() => {});
  }, [onGetScreenSharePreset, onGetNoiseSuppressionConfig]);

  const startShare = useCallback(
    async (mode: "screen" | "window", windowTitle?: string) => {
      setIsStartingScreenShare(true);
      activeShareRef.current = { mode, windowTitle };
      try {
        await onStartScreenShare(mode, windowTitle);
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

  const setPresetAndRestartIfNeeded = useCallback(
    async (preset: "720p" | "1080p") => {
      setScreenSharePreset(preset);
      try {
        await onSetScreenSharePreset(preset);
        if (!callState.isLocalScreenSharing) return;
        setIsStartingScreenShare(true);
        const activeShare = activeShareRef.current;
        if (!activeShare) return;
        await onStopScreenShare();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await onStartScreenShare(activeShare.mode, activeShare.windowTitle);
      } catch (e) {
        console.error("Failed to apply screen share preset:", e);
      }
    },
    [callState.isLocalScreenSharing, onSetScreenSharePreset, onStartScreenShare, onStopScreenShare]
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
        !screenShareMenuRef.current.contains(target)
      ) {
        setScreenShareMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [generalSettingsOpen, screenShareMenuOpen]);

  const openWindowPicker = useCallback(async () => {
    setWindowListLoading(true);
    setWindowPickerOpen(true);
    try {
      const list = await onEnumerateScreenShareWindows();
      setWindowList(list);
    } catch (e) {
      console.error("Failed to enumerate windows:", e);
      setWindowList([]);
    } finally {
      setWindowListLoading(false);
    }
  }, [onEnumerateScreenShareWindows]);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    identity: string;
    displayName: string;
  } | null>(null);

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
            {p.avatarUrl ? (
              <img
                src={p.avatarUrl}
                alt={p.displayName}
                style={{
                  display: "block",
                  width: 80,
                  height: 80,
                  borderRadius: "50%",
                  objectFit: "cover",
                  boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                  transition: "box-shadow 0.15s ease",
                }}
              />
            ) : (
              <div style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                backgroundColor: palette.bgActive,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                fontWeight: typography.fontWeightBold,
                color: palette.textHeading,
                boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                transition: "box-shadow 0.15s ease",
              }}>
                {p.displayName.charAt(0).toUpperCase()}
              </div>
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
            ) : p.avatarUrl ? (
              <img
                src={p.avatarUrl}
                alt={p.displayName}
                style={{
                  display: "block",
                  width: 80,
                  height: 80,
                  borderRadius: "50%",
                  objectFit: "cover",
                  boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                  transition: "box-shadow 0.15s ease",
                }}
              />
            ) : (
              <div style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                backgroundColor: palette.bgActive,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
                fontWeight: typography.fontWeightBold,
                color: palette.textHeading,
                boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                transition: "box-shadow 0.15s ease",
              }}>
                {p.displayName.charAt(0).toUpperCase()}
              </div>
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
            {screenShareMenuOpen && !callState.isLocalScreenSharing && (
              <div
                ref={screenShareMenuPopupRef}
                style={{
                position: "absolute",
                bottom: `calc(100% + ${spacing.unit * 4}px)`,
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: palette.bgSecondary,
                border: `1px solid ${palette.border}`,
                borderRadius: spacing.unit * 2,
                padding: spacing.unit * 4,
                display: "flex",
                flexDirection: "column",
                gap: spacing.unit,
                zIndex: 10,
              }}
              >
                <button
                  onClick={() => {
                    void startShare("screen");
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
                  Share entire screen
                </button>
                <button
                  onClick={() => { setScreenShareMenuOpen(false); openWindowPicker(); }}
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
                  Share application window
                </button>
              </div>
            )}
            {windowPickerOpen && (
              <div
                ref={windowPickerOverlayRef}
                style={{
                position: "fixed",
                inset: 0,
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
                onClick={() => setWindowPickerOpen(false)}
              >
                <div style={{
                  backgroundColor: palette.bgSecondary,
                  border: `1px solid ${palette.border}`,
                  borderRadius: spacing.unit * 2,
                  padding: spacing.unit * 2,
                  maxWidth: 400,
                  maxHeight: 400,
                  overflow: "auto",
                }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ marginBottom: spacing.unit, fontWeight: 600 }}>Select window to share</div>
                  {windowListLoading ? (
                    <div style={{ padding: spacing.unit * 2 }}>Loading windows...</div>
                  ) : windowList.length === 0 ? (
                    <div style={{ padding: spacing.unit * 2, color: palette.textSecondary }}>No windows found</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: spacing.unit / 2 }}>
                      {windowList.map(([title, process], i) => (
                        <button
                          key={i}
                          onClick={() => {
                            void startShare("window", title);
                            setWindowPickerOpen(false);
                          }}
                          style={{
                            padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                            border: `1px solid ${palette.border}`,
                            borderRadius: spacing.unit,
                            cursor: "pointer",
                            backgroundColor: palette.bgActive,
                            color: palette.textPrimary,
                            fontSize: typography.fontSizeSmall,
                            textAlign: "left",
                          }}
                        >
                          {title || "(no title)"}
                          {process && <span style={{ color: palette.textSecondary, fontSize: "0.85em" }}> — {process}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => setWindowPickerOpen(false)}
                    style={{
                      marginTop: spacing.unit,
                      padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                      border: "none",
                      borderRadius: spacing.unit,
                      cursor: "pointer",
                      backgroundColor: palette.bgSecondary,
                      color: palette.textSecondary,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* General settings */}
          <div ref={generalSettingsRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <button
              onClick={() => { setGeneralSettingsOpen((v) => !v); setScreenShareMenuOpen(false); }}
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
                <div style={{ marginBottom: spacing.unit * 2, fontWeight: 600, fontSize: typography.fontSizeSmall }}>
                  Screen share quality
                </div>
                <div style={{ display: "flex", gap: spacing.unit }}>
                  {(["720p", "1080p"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => { void setPresetAndRestartIfNeeded(p); }}
                      style={{
                        flex: 1,
                        padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                        backgroundColor: screenSharePreset === p ? palette.accent : palette.bgTertiary,
                        color: screenSharePreset === p ? "#fff" : palette.textPrimary,
                        border: `1px solid ${screenSharePreset === p ? palette.accent : palette.border}`,
                        borderRadius: spacing.unit,
                        cursor: "pointer",
                        fontSize: typography.fontSizeSmall,
                        fontWeight: screenSharePreset === p ? 600 : 400,
                      }}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: spacing.unit * 3, marginBottom: spacing.unit * 2, fontWeight: 600, fontSize: typography.fontSizeSmall }}>
                  Noise suppression
                </div>
                <button
                  onClick={onToggleNoiseSuppression}
                  style={{
                    width: "100%",
                    padding: `${spacing.unit}px ${spacing.unit * 1.5}px`,
                    borderRadius: spacing.unit,
                    border: `1px solid ${palette.border}`,
                    cursor: "pointer",
                    backgroundColor: callState.isNoiseSuppressed ? palette.accent : palette.bgTertiary,
                    color: callState.isNoiseSuppressed ? "#fff" : palette.textPrimary,
                    fontSize: typography.fontSizeSmall,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: spacing.unit,
                  }}
                >
                  <AudioLines size={16} />
                  {callState.isNoiseSuppressed ? "Enabled" : "Disabled"}
                </button>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: spacing.unit * 2,
                    marginTop: spacing.unit * 2,
                    opacity: callState.isNoiseSuppressed ? 1 : 0.45,
                    pointerEvents: callState.isNoiseSuppressed ? "auto" : "none",
                  }}
                >
                  <label style={{ fontSize: typography.fontSizeSmall }}>
                    Extra attenuation: {noiseConfig.extraAttenuation.toFixed(2)}
                    <input type="range" min="0" max="1" step="0.05" value={noiseConfig.extraAttenuation}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setNoiseConfig((c) => {
                          const next = { ...c, extraAttenuation: v };
                          onSetNoiseSuppressionConfig(next);
                          return next;
                        });
                      }}
                      style={{ display: "block", width: "100%", marginTop: 4 }} />
                    <span style={{ fontSize: typography.fontSizeSmall - 1, color: palette.textSecondary }}>
                      0 = pure RNNoise, higher = more silence suppression
                    </span>
                  </label>
                  <label style={{ fontSize: typography.fontSizeSmall }}>
                    AGC target RMS: {noiseConfig.agcTargetRms} {noiseConfig.agcTargetRms === 0 ? "(off)" : ""}
                    <input type="range" min="0" max="12000" step="500" value={noiseConfig.agcTargetRms}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setNoiseConfig((c) => {
                          const next = { ...c, agcTargetRms: v };
                          onSetNoiseSuppressionConfig(next);
                          return next;
                        });
                      }}
                      style={{ display: "block", width: "100%", marginTop: 4 }} />
                    <span style={{ fontSize: typography.fontSizeSmall - 1, color: palette.textSecondary }}>
                      0 = disabled, higher = louder normalisation target
                    </span>
                  </label>
                </div>
                <div style={{ fontSize: typography.fontSizeSmall, color: palette.textSecondary, marginTop: spacing.unit * 2 }}>
                  Noise suppression settings apply immediately
                </div>
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
          volume={getVolume(contextMenu.identity)}
          onVolumeChange={(vol) => {
            setVolume(contextMenu.identity, vol);
            onSetParticipantVolume(contextMenu.identity, vol);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}