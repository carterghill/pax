import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Volume2, Mic, MicOff, PhoneOff, Loader2, Monitor, MonitorUp, Video, VideoOff, Headphones, Settings, Slash } from "lucide-react";
import { createPortal } from "react-dom";
import { useTheme } from "../theme/ThemeContext";
import { Room, VoiceParticipant as MatrixVoiceParticipant } from "../types/matrix";
import { ScreenShareWindowOption, VoiceCall } from "../hooks/useVoiceCall";
import {
  compareByDisplayThenKey,
  isVoiceParticipantOnDevice,
  localpartFromUserId,
} from "../utils/matrix";
import UserAvatar from "./UserAvatar";
import RoomHeaderTitle, { RoomHeaderIcon } from "./RoomHeaderTitle";
import { useUserVolume } from "../hooks/useUserVolume";
import VolumeContextMenu from "./VolumeContextMenu";
import VoiceAudioSettingsSection from "./VoiceAudioSettingsSection";
import ScreenShareGrid from "./ScreenShareGrid";
import CallVideo from "./CallVideo";
import { callVideoLayout } from "../utils/callVideoLayout";
import VoiceLinkStatus from "./VoiceLinkStatus";
import type { VoiceJoinButton } from "./ActiveCallBar";
import type { VoiceParticipantState } from "../hooks/useVoiceParticipantStates";
import type { MatrixCallMedia } from "../hooks/useMatrixVoip";
import type { DirectCallPeerConnection } from "../hooks/useDirectCall";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

interface VoiceCallPanelProps {
  roomId: string;
  voiceCall: VoiceCall;
  matrixMedia?: MatrixCallMedia;
  onDisconnect: () => void;
  voiceParticipants?: MatrixVoiceParticipant[];
  participantStates?: Record<string, VoiceParticipantState>;
  canReconnect?: boolean;
  canJoin?: boolean;
  joinButton?: VoiceJoinButton;
  userId: string;
  groupCall?: boolean;
  directCall?: { peer: MatrixVoiceParticipant; peerDeviceId?: string; peerConnection: DirectCallPeerConnection };
}

const EMPTY_VOICE_PARTICIPANTS: MatrixVoiceParticipant[] = [];
const EMPTY_PARTICIPANT_STATES: Record<string, VoiceParticipantState> = {};

export default function VoiceRoomView({
  room,
  ...panelProps
}: Omit<VoiceCallPanelProps, "roomId" | "directCall"> & { room: Room }) {
  const { palette, spacing, typography } = useTheme();
  const { connectedRoomId, isConnecting } = panelProps.voiceCall;
  const topic = room.topic?.trim();
  const encryptionLabel = room.isEncrypted === true ? "Encrypted room" : undefined;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{
        padding: `0 ${spacing.unit * 4}px`,
        borderBottom: `1px solid ${palette.border}`,
        height: spacing.headerHeight,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
      }}>
        <RoomHeaderIcon encryptionLabel={encryptionLabel} announceEncryption={Boolean(topic)}>
          <Volume2 size={20} color={palette.textSecondary} style={{ flexShrink: 0 }} />
        </RoomHeaderIcon>
        <RoomHeaderTitle name={room.name} caption={topic || encryptionLabel} />
        {connectedRoomId === room.id && !isConnecting && (
          <span style={{
            fontSize: typography.fontSizeSmall,
            color: "#23a55a",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            gap: spacing.unit,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#23a55a" }} />
            Connected
          </span>
        )}
      </div>
      <VoiceCallPanel key={room.id} roomId={room.id} {...panelProps} />
    </div>
  );
}

export function VoiceCallPanel({
  roomId,
  voiceCall: callState,
  matrixMedia,
  onDisconnect,
  voiceParticipants = EMPTY_VOICE_PARTICIPANTS,
  participantStates = EMPTY_PARTICIPANT_STATES,
  canReconnect = false,
  canJoin = true,
  joinButton,
  userId,
  directCall,
  groupCall = false,
}: VoiceCallPanelProps) {
  const {
    connect: onConnect,
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
  } = callState;
  const { palette, spacing, typography } = useTheme();
  const { getVolume, setVolume } = useUserVolume();
  const media = matrixMedia ?? callState;
  const isMatrixCall = !!matrixMedia;
  const cameraUnavailable = matrixMedia?.canShareCamera === false;
  const cameraLabel = cameraUnavailable ? "This Matrix peer cannot add video to a voice call"
    : media.cameraPending ? "Cancel camera startup" : media.localCamera ? "Turn camera off" : "Turn camera on";
  const isConnected = isMatrixCall || (callState.connectedRoomId === roomId && !callState.isConnecting);
  const isConnecting = callState.isConnecting && callState.targetRoomId === roomId;
  const roomError = callState.targetRoomId === roomId || callState.endedRoomId === roomId ? callState.error : null;
  const error = isConnected ? media.cameraError ?? roomError : roomError;
  const inChat = !!directCall || groupCall;
  const isDirectCall = directCall != null;
  const { tiles, avatarCameras } = callVideoLayout(media.remoteVideo, matrixMedia ? userId : callState.localParticipant?.identity ?? userId,
    media.localCamera, !matrixMedia && callState.isLocalScreenSharing);
  const localCameraError = media.localCamera && "error" in media.localCamera ? media.localCamera.error : null;
  const hasVideo = isConnected && tiles.length > 0;
  const participantsBesideShare = hasVideo && !directCall;
  const avatarSize = inChat ? (hasVideo ? 40 : 64) : 80;
  const peer = directCall?.peer;
  const [screenShareMenuOpen, setScreenShareMenuOpen] = useState(false);
  const [generalSettingsOpen, setGeneralSettingsOpen] = useState(false);
  const [generalSettingsTab, setGeneralSettingsTab] = useState<"stream" | "audio">("stream");
  const [lowBandwidthMode, setLowBandwidthMode] = useState(false);
  const [isStartingScreenShare, setIsStartingScreenShare] = useState(false);
  const screenShareMenuRef = useRef<HTMLDivElement>(null);
  const screenShareMenuPopupRef = useRef<HTMLDivElement>(null);
  const generalSettingsRef = useRef<HTMLDivElement>(null);
  const generalSettingsPopupRef = useRef<HTMLDivElement>(null);
  const isLinux = navigator.userAgent.includes("Linux");
  const [windowList, setWindowList] = useState<ScreenShareWindowOption[]>([]);
  const [windowListLoading, setWindowListLoading] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const showScreenShareMenu = isConnected && screenShareMenuOpen && !callState.isLocalScreenSharing;
  const showGeneralSettings = isConnected && generalSettingsOpen;
  useOverlayObstruction(screenShareMenuPopupRef, showScreenShareMenu && menuPosition !== null);
  useOverlayObstruction(generalSettingsPopupRef, showGeneralSettings && menuPosition !== null);

  useEffect(() => {
    if (isMatrixCall) return;
    onGetLowBandwidthMode().then(setLowBandwidthMode).catch(() => {});
  }, [isMatrixCall, onGetLowBandwidthMode]);

  const reconnectAfterDeviceChange = useCallback(async () => {
    if (isConnected) {
      await onConnect(roomId, { forceReconnect: true, replaceOtherSessions: inChat ? false : undefined });
    }
  }, [isConnected, onConnect, roomId, inChat]);

  useEffect(() => {
    if (!showScreenShareMenu || isLinux) return;
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
  }, [showScreenShareMenu, isLinux, onEnumerateScreenShareWindows]);

  useEffect(() => {
    if (!showScreenShareMenu && !showGeneralSettings) {
      setMenuPosition(null);
      return;
    }

    function updateMenuPosition() {
      const anchor = showScreenShareMenu ? screenShareMenuRef.current : generalSettingsRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 12;
      const gap = spacing.unit * 2;
      const width = Math.min(showScreenShareMenu && !isLinux ? 760 : 320, window.innerWidth - margin * 2);
      const centeredLeft = rect.left + rect.width / 2 - width / 2;
      const left = Math.min(Math.max(centeredLeft, margin), window.innerWidth - width - margin);
      const above = rect.top - gap - margin;
      const below = window.innerHeight - rect.bottom - gap - margin;
      const openBelow = below > above;

      setMenuPosition({
        top: openBelow ? rect.bottom + gap : undefined,
        bottom: openBelow ? undefined : window.innerHeight - rect.top + gap,
        left,
        width,
        maxHeight: Math.min(window.innerHeight * 0.7, Math.max(above, below)),
      });
    }

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [showScreenShareMenu, showGeneralSettings, hasVideo, isLinux, spacing.unit]);

  const startShare = useCallback(
    async (mode: "screen" | "window", windowTitle?: string, windowHandle?: string) => {
      setIsStartingScreenShare(true);
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
      } catch (e) {
        console.error("Failed to toggle low bandwidth mode:", e);
      }
    },
    [lowBandwidthMode, onSetLowBandwidthMode]
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
        !generalSettingsRef.current.contains(target) &&
        !generalSettingsPopupRef.current?.contains(target)
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

  const showLobby = !isDirectCall && !isConnected && !isConnecting;
  const peerConnection = directCall?.peerConnection;
  const peerDeviceId = directCall?.peerDeviceId;
  const participants = useMemo(() => {
    const roster = new Map(voiceParticipants.map((participant) => [participant.userId, participant]));
    if (peer) roster.set(peer.userId, peer);
    const rows = new Map<string, VoiceParticipantState>(Object.entries(participantStates));
    if (peerConnection === "lost" && peer) rows.set(peer.userId, { status: "lost" });

    if (matrixMedia && peer) {
      rows.set(userId, { status: "connected", isMuted: !matrixMedia.isMicEnabled });
      rows.set(peer.userId, { status: peerConnection ?? "connected" });
    } else if (isConnected && isDirectCall) {
      for (const participant of callState.participants) {
        const id = participant.isLocal ? userId : peer?.userId;
        if (!id || (!participant.isLocal && !isVoiceParticipantOnDevice(participant.identity, id, peerDeviceId))) continue;
        const status = !participant.isLocal && peerConnection === "interrupted" ? "interrupted" : "connected";
        rows.set(id, { ...participant, status });
      }
    }

    return Array.from(rows, ([id, state]) => {
      const profile = roster.get(id);
      return {
        userId: id,
        ...state,
        identity: state.identity ?? id,
        displayName: profile?.displayName || localpartFromUserId(id),
        avatarUrl: profile?.avatarUrl ?? null,
        isLocal: id === userId,
      };
    }).sort((a, b) => compareByDisplayThenKey(a.displayName, a.identity, b.displayName, b.identity));
  }, [callState.participants, isConnected, isDirectCall, matrixMedia, participantStates, peer, peerDeviceId, peerConnection, userId, voiceParticipants]);

  return (
    <section aria-label={inChat ? "Voice call" : undefined} style={{
      flex: inChat ? "0 1 auto" : 1,
      display: "flex",
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
      height: inChat ? (hasVideo ? "min(55vh, 460px)" : 180) : undefined,
      maxHeight: inChat ? "55%" : undefined,
    }}>
      {/* Main content: screen share (primary) or participant grid */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: participantsBesideShare ? "row" : "column",
        overflow: "hidden",
      }}>
        {hasVideo && (
          <ScreenShareGrid
            streams={tiles}
            getVolume={getStreamVolume}
            onVolumeChange={matrixMedia ? undefined : handleStreamVolumeChange}
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
          flex: hasVideo ? "0 0 auto" : 1,
          display: "flex",
          flexWrap: "wrap",
          alignContent: participantsBesideShare ? "flex-start" : "safe center",
          justifyContent: "center",
          gap: spacing.unit * 4,
          padding: spacing.unit * (inChat ? 2 : 6),
          overflowY: "auto",
          width: participantsBesideShare ? 180 : undefined,
        }}>
        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          .voice-peer-reconnect-ring { animation: spin 1s linear infinite; }
          @media (prefers-reduced-motion: reduce) {
            .voice-peer-reconnect-ring { animation: none; }
          }
        `}</style>
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
            <span style={{ fontSize: typography.fontSizeLarge }}>{callState.isReconnecting ? "Reconnecting…" : "Connecting…"}</span>
          </div>
        )}

        {error && !isConnected && !isConnecting && (
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
              {error}
            </span>
          </div>
        )}

        {showLobby && participants.map((p) => (
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
              userId={p.userId}
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
                <VoiceLinkStatus status={p.status} />
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

        {showLobby && participants.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeBase,
            textAlign: "center",
            maxWidth: 360,
          }}>
            No one is in this call yet.
          </div>
        )}

        {/* Show errors (e.g. screen share failure) even when connected */}
        {error && isConnected && (
          <div role="alert" style={{
            padding: spacing.unit * 2,
            margin: spacing.unit * 2,
            backgroundColor: "rgba(242, 63, 67, 0.15)",
            borderRadius: 8,
            color: "#f23f43",
            fontSize: typography.fontSizeSmall,
          }}>
            {error}
          </div>
        )}

        {isConnected && participants.map((p) => (
          <div
            key={p.userId}
            onContextMenu={(e) => {
              if (p.isLocal || (p.status !== "connected" && p.status !== "interrupted")) return;
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
            <div style={{ position: "relative", display: "flex" }}>
              {avatarCameras.has(p.identity) ? (
                <div aria-label={`${p.displayName}'s camera`} style={{
                  width: avatarSize, height: avatarSize, borderRadius: "50%", overflow: "hidden",
                  boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                }}>
                  <CallVideo stream={avatarCameras.get(p.identity)!} avatar />
                </div>
              ) : (
                <UserAvatar
                  userId={p.userId}
                  displayName={p.displayName}
                  avatarUrlHint={p.avatarUrl}
                  size={avatarSize}
                  fontSize={28}
                  style={{
                    boxShadow: p.isSpeaking ? "0 0 0 3px #23a55a" : "none",
                    transition: "box-shadow 0.15s ease",
                  }}
                />
              )}
              {isDirectCall && p.userId === peer?.userId && (p.status === "interrupted" || p.status === "lost") && (
                <span className="voice-peer-reconnect-ring" aria-hidden="true" style={{
                  position: "absolute",
                  inset: -3,
                  borderRadius: "50%",
                  border: `2px solid ${palette.border}`,
                  borderTopColor: palette.textPrimary,
                  pointerEvents: "none",
                }} />
              )}
            </div>
            {p.isLocal && avatarCameras.has(p.identity) && localCameraError && (
              <span className="call-camera-error" role="status">{localCameraError}</span>
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
                {(p.status === "connected" || p.status === "interrupted") && tiles.some((tile) => tile.identity === p.identity && tile.source === "screen") && (
                  <Monitor size={12} color="#23a55a" />
                )}
                {p.isMuted && <MicOff size={12} color={palette.textSecondary} />}
                {p.isDeafened && (
                  <span style={{ position: "relative", width: 12, height: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <Headphones size={12} color={palette.textSecondary} />
                    <Slash size={10} color={palette.textSecondary} style={{ position: "absolute" }} />
                  </span>
                )}
                <VoiceLinkStatus status={p.status} />
              </span>
            </span>
          </div>
        ))}

        {isConnected && participants.length === 0 && !hasVideo && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeBase,
          }}>
            No one else is here yet
          </div>
        )}
        {isConnected && participants.length === 0 && hasVideo && (
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
            disabled={!canJoin}
            title={canJoin ? undefined : "Your room role cannot join voice sessions"}
            onClick={joinButton?.onClick ?? (() => onConnect(roomId))}
            style={{
              opacity: canJoin ? 1 : 0.5,
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
            {joinButton?.label ?? (canReconnect ? "Reconnect" : "Join voice")}
          </button>
        </div>
      )}

      {/* Controls bar */}
      {isConnected && (
        <div style={{
          padding: spacing.unit * (inChat ? 2 : 4),
          borderTop: `1px solid ${palette.border}`,
          display: "flex",
          flexShrink: 0,
          flexWrap: "wrap",
          justifyContent: "center",
          gap: spacing.unit * (inChat ? 2 : 3),
        }}>
          {/* Mute/Unmute */}
          <button
            type="button"
            onClick={media.toggleMic}
            title={media.isMicEnabled ? "Mute" : "Unmute"}
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: media.isMicEnabled
                ? palette.bgActive
                : palette.textPrimary,
              color: media.isMicEnabled ? palette.textPrimary : palette.bgPrimary,
              transition: "background-color 0.15s ease",
            }}
          >
            {media.isMicEnabled ? <Mic size={20} /> : <MicOff size={20} />}
          </button>

          {/* Deafen/Undeafen (local playback mute) */}
          {!matrixMedia && <button
            type="button"
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
          </button>}

          <button
            type="button"
            onClick={media.toggleCamera}
            title={cameraLabel}
            aria-label={cameraLabel}
            disabled={cameraUnavailable}
            aria-pressed={!!media.localCamera}
            aria-busy={media.cameraPending}
            style={{
              marginInlineStart: spacing.unit * 2, position: "relative",
              opacity: cameraUnavailable ? 0.5 : 1,
              width: 48, height: 48, borderRadius: "50%", border: "none", cursor: cameraUnavailable ? "default" : "pointer",
              display: "grid", placeItems: "center",
              backgroundColor: media.localCamera ? palette.textPrimary : palette.bgActive,
              color: media.localCamera ? palette.bgPrimary : palette.textPrimary,
            }}
          >
            {!matrixMedia && <span aria-hidden="true" style={{
              position: "absolute", insetInlineStart: -(spacing.unit * (inChat ? 2 : 2.5)),
              top: "50%", transform: "translateY(-50%)", width: 1, height: 16,
              backgroundColor: palette.textSecondary, opacity: 0.3, pointerEvents: "none",
            }} />}
            {media.cameraPending ? <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
              : media.localCamera ? <Video size={20} /> : <VideoOff size={20} />}
          </button>

          {!matrixMedia && <>
          {/* Screen Share */}
          <div ref={screenShareMenuRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 2 }}>
            <button
              type="button"
              onClick={() => {
                if (callState.isLocalScreenSharing) {
                  void stopShare();
                } else {
                  setScreenShareMenuOpen((v) => !v);
                  setGeneralSettingsOpen(false);
                }
              }}
              title={callState.isLocalScreenSharing ? "Stop sharing screen" : "Share screen"}
              aria-expanded={callState.isLocalScreenSharing ? undefined : showScreenShareMenu}
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
            {showScreenShareMenu && menuPosition &&
              createPortal(
              <div
                ref={screenShareMenuPopupRef}
                style={{
                position: "fixed",
                ...menuPosition,
                backgroundColor: palette.bgSecondary,
                border: `1px solid ${palette.border}`,
                borderRadius: spacing.unit * 2,
                padding: spacing.unit * 4,
                display: "flex",
                flexDirection: "column",
                gap: spacing.unit * 2,
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
              type="button"
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
              aria-expanded={showGeneralSettings}
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
            {showGeneralSettings && menuPosition && createPortal(
              <div
                ref={generalSettingsPopupRef}
                style={{
                position: "fixed",
                ...menuPosition,
                backgroundColor: palette.bgSecondary,
                border: `1px solid ${palette.border}`,
                borderRadius: spacing.unit * 2,
                padding: spacing.unit * 4,
                overflowY: "auto",
                zIndex: 2000,
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
              </div>,
              document.body
            )}
          </div>

          </>}

          {/* Disconnect */}
          <button
            type="button"
            onClick={onDisconnect}
            title={inChat ? "Hang up" : "Disconnect"}
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
    </section>
  );
}
