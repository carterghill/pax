import { Phone, Loader2, Wifi } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

interface ActiveCallBarProps {
  roomName: string;
  isConnecting: boolean;
  isDisconnecting: boolean;
  onDisconnect: () => void;
}

export default function ActiveCallBar({
  roomName,
  isConnecting,
  isDisconnecting,
  onDisconnect,
}: ActiveCallBarProps) {
  const { palette, spacing, typography } = useTheme();

  const statusLabel = isDisconnecting
    ? "Disconnecting..."
    : isConnecting
      ? "Connecting..."
      : "Connected";

  const statusColor = isDisconnecting
    ? palette.textSecondary
    : isConnecting
      ? palette.textSecondary
      : "#23a55a";

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
        {isConnecting || isDisconnecting ? (
          <Loader2
            size={typography.fontSizeSmall + typography.fontSizeSmall - 1}
            style={{ animation: "spin 1s linear infinite" }}
          />
        ) : (
          <Wifi size={typography.fontSizeSmall + typography.fontSizeSmall - 1} />
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
        <div
          style={{
            fontSize: typography.fontSizeSmall - 1,
            color: statusColor,
          }}
        >
          {statusLabel}
        </div>
      </div>

      <button
        onClick={onDisconnect}
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
        title="Disconnect"
      >
        <Phone size={18} />
      </button>
    </div>
  );
}
