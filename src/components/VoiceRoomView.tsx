import { useState, useCallback } from "react";
import { Volume2, Mic, MicOff, PhoneOff, Loader2, AudioLines, Monitor, MonitorOff } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import { VoiceCallState, VoiceParticipant } from "../hooks/useVoiceCall";
import { useUserVolume } from "../hooks/useUserVolume";
import VolumeContextMenu from "./VolumeContextMenu";

interface VoiceRoomViewProps {
  room: Room;
  callState: VoiceCallState;
  onDisconnect: () => void;
  onToggleMic: () => void;
  onToggleNoiseSuppression: () => void;
  onStartScreenShare: (mode: "screen" | "window", windowTitle?: string) => void;
  onEnumerateScreenShareWindows: () => Promise<[string, string][]>;
  onStopScreenShare: () => void;
  onSetParticipantVolume: (identity: string, volume: number) => void;
}

export default function VoiceRoomView({
  room,
  callState,
  onDisconnect,
  onToggleMic,
  onToggleNoiseSuppression,
  onStartScreenShare,
  onEnumerateScreenShareWindows,
  onStopScreenShare,
  onSetParticipantVolume,
}: VoiceRoomViewProps) {
  const { palette, spacing, typography } = useTheme();
  const { getVolume, setVolume } = useUserVolume();
  const [screenShareMenuOpen, setScreenShareMenuOpen] = useState(false);
  const [windowPickerOpen, setWindowPickerOpen] = useState(false);
  const [windowList, setWindowList] = useState<[string, string][]>([]);
  const [windowListLoading, setWindowListLoading] = useState(false);

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
  const hasScreenShare = !!callState.screenSharingOwner || callState.isLocalScreenSharing;

  // Collect all participants from the Rust backend state
  const allParticipants: VoiceParticipant[] = isConnected ? callState.participants : [];

  const sharerDisplayName = callState.isLocalScreenSharing
    ? "You"
    : callState.screenSharingOwner
    ? (callState.screenSharingOwner.startsWith("@")
        ? callState.screenSharingOwner.slice(1).split(":")[0]
        : callState.screenSharingOwner)
    : null;

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
          <div style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            backgroundColor: palette.bgSecondary,
            borderRadius: spacing.unit,
            margin: spacing.unit * 2,
            overflow: "hidden",
            minWidth: 0,
          }}>
            <div style={{
              padding: spacing.unit * 2,
              borderBottom: `1px solid ${palette.border}`,
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}>
              {callState.isLocalScreenSharing
                ? "You are sharing your screen"
                : `${sharerDisplayName} is sharing their screen`}
            </div>
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: palette.bgPrimary,
              color: palette.textSecondary,
            }}>
              <span>Screen share video (native capture in progress)</span>
            </div>
          </div>
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
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
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

        {isConnected && allParticipants.map((p) => {
          // Extract display name from identity (e.g. @user:server → user)
          const displayName = p.identity.startsWith("@")
            ? p.identity.slice(1).split(":")[0]
            : p.identity;

          return (
            <div
              key={p.identity}
              onContextMenu={(e) => {
                if (p.isLocal) return; // No volume control for yourself
                e.preventDefault();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  identity: p.identity,
                  displayName,
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
              {/* Avatar circle with speaking ring */}
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
                border: `3px solid ${p.isSpeaking ? "#23a55a" : "transparent"}`,
                transition: "border-color 0.15s ease",
              }}>
                {displayName.charAt(0).toUpperCase()}
              </div>
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
                {callState.screenSharingOwner === p.identity && (
                  <Monitor size={12} color="#23a55a" />
                )}
                {displayName}{p.isLocal ? " (you)" : ""}
              </span>
            </div>
          );
        })}

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
                : "#f23f43",
              color: callState.isMicEnabled
                ? palette.textHeading
                : "#fff",
              transition: "background-color 0.15s ease",
            }}
          >
            {callState.isMicEnabled ? <Mic size={20} /> : <MicOff size={20} />}
          </button>

          {/* Screen Share */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => callState.isLocalScreenSharing ? onStopScreenShare() : setScreenShareMenuOpen((v) => !v)}
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
                backgroundColor: callState.isLocalScreenSharing ? "#23a55a" : palette.bgActive,
                color: callState.isLocalScreenSharing ? "#fff" : palette.textSecondary,
                transition: "background-color 0.15s ease",
              }}
            >
              {callState.isLocalScreenSharing ? <MonitorOff size={20} /> : <Monitor size={20} />}
            </button>
            {screenShareMenuOpen && !callState.isLocalScreenSharing && (
              <div style={{
                position: "absolute",
                bottom: "100%",
                left: "50%",
                transform: "translateX(-50%)",
                marginBottom: spacing.unit,
                backgroundColor: palette.bgSecondary,
                border: `1px solid ${palette.border}`,
                borderRadius: spacing.unit,
                padding: spacing.unit,
                display: "flex",
                flexDirection: "column",
                gap: spacing.unit,
                zIndex: 10,
              }}>
                <button
                  onClick={() => { onStartScreenShare("screen"); setScreenShareMenuOpen(false); }}
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
              <div style={{
                position: "fixed",
                inset: 0,
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }} onClick={() => setWindowPickerOpen(false)}>
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
                            onStartScreenShare("window", title);
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

          {/* Noise Suppression Toggle */}
          <button
            onClick={onToggleNoiseSuppression}
            title={callState.isNoiseSuppressed ? "Disable noise suppression" : "Enable noise suppression"}
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: callState.isNoiseSuppressed
                ? "#23a55a"
                : palette.bgActive,
              color: callState.isNoiseSuppressed
                ? "#fff"
                : palette.textSecondary,
              transition: "background-color 0.15s ease",
              opacity: callState.isNoiseSuppressed !== undefined ? 1 : 0.5,
            }}
          >
            <AudioLines size={20} />
          </button>

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