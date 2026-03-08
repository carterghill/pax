import { Volume2, Mic, MicOff, PhoneOff, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import { VoiceCallState } from "../hooks/useVoiceCall";

interface VoiceRoomViewProps {
  room: Room;
  callState: VoiceCallState;
  onDisconnect: () => void;
  onToggleMic: () => void;
}

export default function VoiceRoomView({
  room,
  callState,
  onDisconnect,
  onToggleMic,
}: VoiceRoomViewProps) {
  const { palette, spacing, typography } = useTheme();

  const isConnected = callState.connectedRoomId === room.id && !callState.isConnecting;
  const isConnecting = callState.isConnecting && callState.connectedRoomId === room.id;

  // Collect all participants: local + remote
  const allParticipants: { identity: string; isSpeaking: boolean; isLocal: boolean }[] = [];

  if (isConnected && callState.localParticipant) {
    allParticipants.push({
      identity: callState.localParticipant.identity,
      isSpeaking: callState.localParticipant.isSpeaking,
      isLocal: true,
    });
  }

  if (isConnected) {
    for (const p of callState.remoteParticipants) {
      allParticipants.push({
        identity: p.identity,
        isSpeaking: p.isSpeaking,
        isLocal: false,
      });
    }
  }

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

      {/* Participant grid */}
      <div style={{
        flex: 1,
        display: "flex",
        flexWrap: "wrap",
        alignContent: "center",
        justifyContent: "center",
        gap: spacing.unit * 4,
        padding: spacing.unit * 6,
        overflowY: "auto",
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

        {isConnected && allParticipants.map((p) => {
          // Extract display name from identity (e.g. @user:server → user)
          const displayName = p.identity.startsWith("@")
            ? p.identity.slice(1).split(":")[0]
            : p.identity;

          return (
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
              }}>
                {displayName}{p.isLocal ? " (you)" : ""}
              </span>
            </div>
          );
        })}

        {isConnected && allParticipants.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeBase,
          }}>
            No one else is here yet
          </div>
        )}
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
    </div>
  );
}