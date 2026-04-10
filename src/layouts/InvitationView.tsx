import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import { spaceInitialAvatarBackground } from "../utils/userAvatarColor";

interface InvitationViewProps {
  room: Room;
  onJoined: () => void;
}

export default function InvitationView({ room, onJoined }: InvitationViewProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initials = room.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  async function handleJoin() {
    setJoining(true);
    setError(null);
    try {
      await invoke("join_room", { roomId: room.id });
      onJoined();
    } catch (e) {
      setError(String(e));
    }
    setJoining(false);
  }

  return (
    <div style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.bgPrimary,
    }}>
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: spacing.unit * 4,
        padding: spacing.unit * 8,
        backgroundColor: palette.bgSecondary,
        borderRadius: spacing.unit * 2,
        maxWidth: 400,
        width: "100%",
      }}>
        {/* Room avatar */}
        {room.avatarUrl ? (
          <img
            src={room.avatarUrl}
            alt={room.name}
            style={{
              width: 80,
              height: 80,
              borderRadius: room.isSpace ? 24 : "50%",
              objectFit: "cover",
            }}
          />
        ) : (
          <div style={{
            width: 80,
            height: 80,
            borderRadius: room.isSpace ? 24 : "50%",
            backgroundColor: room.isSpace
              ? spaceInitialAvatarBackground(room.id, resolvedColorScheme)
              : palette.accent,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 28,
            fontWeight: typography.fontWeightBold,
          }}>
            {initials}
          </div>
        )}

        {/* Room name */}
        <div style={{
          fontSize: typography.fontSizeLarge + 4,
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          textAlign: "center",
        }}>
          {room.name}
        </div>

        {/* Invitation label */}
        <div style={{
          fontSize: typography.fontSizeBase,
          color: palette.textSecondary,
          textAlign: "center",
        }}>
          You've been invited to join this {room.isSpace ? "space" : "room"}
        </div>

        {/* Join button */}
        <button
          onClick={handleJoin}
          disabled={joining}
          style={{
            padding: `${spacing.unit * 3}px ${spacing.unit * 8}px`,
            borderRadius: spacing.unit * 1.5,
            border: "none",
            backgroundColor: palette.accent,
            color: "#fff",
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightBold,
            cursor: joining ? "default" : "pointer",
            opacity: joining ? 0.7 : 1,
            transition: "opacity 0.15s, background-color 0.15s",
          }}
          onMouseEnter={(e) => {
            if (!joining) e.currentTarget.style.backgroundColor = palette.accentHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = palette.accent;
          }}
        >
          {joining ? "Joining..." : "Accept Invitation"}
        </button>

        {error && (
          <div style={{
            color: "#f38ba8",
            fontSize: typography.fontSizeSmall,
            textAlign: "center",
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}