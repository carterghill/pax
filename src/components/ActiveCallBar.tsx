import { PhoneOff, Loader2, Wifi, WifiOff, X } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

export interface ActiveCallBarProps {
  roomName: string;
  status: "connecting" | "reconnecting" | "connected" | "disconnected" | "disconnecting";
  detail?: string;
  canReconnect: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export default function ActiveCallBar({
  roomName,
  status,
  detail,
  canReconnect,
  onReconnect,
  onDisconnect,
}: ActiveCallBarProps) {
  const { palette, spacing, typography } = useTheme();

  const labels = {
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    connected: "Connected",
    disconnected: "Connection lost",
    disconnecting: "Disconnecting…",
  };
  const statusColor = status === "connected" && !detail ? "#23a55a" : palette.textSecondary;
  const isWaiting = status !== "connected" && status !== "disconnected";
  const statusIconSize = typography.fontSizeSmall * 2 - 1;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
        borderTop: `1px solid ${palette.border}`,
        gap: spacing.unit * 2,
      }}
    >
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", color: statusColor }}>
        {isWaiting ? (
          <Loader2
            size={statusIconSize}
            style={{ animation: "spin 1s linear infinite" }}
          />
        ) : (
          status === "disconnected" || detail ? <WifiOff size={statusIconSize} /> : <Wifi size={statusIconSize} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightMedium,
            color: palette.textPrimary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {roomName}
        </div>
        <div role="status"
          style={{
            fontSize: typography.fontSizeSmall - 1,
            color: statusColor,
          }}
        >
          {detail ?? labels[status]}
        </div>
      </div>

      {status === "disconnected" && canReconnect && (
        <button type="button" onClick={onReconnect} style={{
          border: "none", borderRadius: spacing.unit, padding: spacing.unit,
          background: palette.bgHover, color: palette.textPrimary, cursor: "pointer", font: "inherit",
          fontSize: typography.fontSizeSmall, flexShrink: 0,
        }}>
          Reconnect
        </button>
      )}
      <button
        type="button"
        onClick={onDisconnect}
        disabled={status === "disconnecting"}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: spacing.unit,
          backgroundColor: "transparent",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
          color: palette.textSecondary,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgHover;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }}
        aria-label={status === "disconnected" ? "Dismiss voice session" : "Disconnect"}
        title={status === "disconnected" ? "Dismiss voice session" : "Disconnect"}
      >
        {status === "disconnected" ? <X size={18} /> : <PhoneOff size={18} />}
      </button>
    </div>
  );
}
