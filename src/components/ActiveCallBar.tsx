import { useRoomCallPermissions } from "../hooks/useRoomCallPermissions";
import { ArrowRightToLine, Laptop, PhoneIncoming, PhoneOff, Loader2, Wifi, WifiOff, X, type LucideIcon } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

export interface VoiceJoinButton {
  label: "Join here instead" | "Join voice";
  onClick: () => void;
}

export interface RemoteCallBarProps {
  roomId: string;
  roomName: string;
  status: "remote";
  joinButton: VoiceJoinButton;
}

export type ActiveCallBarProps = RemoteCallBarProps | {
  roomName: string;
  status: "connecting" | "reconnecting" | "connected" | "disconnected" | "disconnecting";
  detail?: string;
  canReconnect: boolean;
  onReconnect: () => void;
  onGoToRoom?: () => void;
  onDisconnect: () => void;
};

function CallBarIconButton({ label, icon: Icon, onClick, disabled }: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  const { palette, spacing } = useTheme();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, padding: 0, flexShrink: 0, borderRadius: spacing.unit,
        backgroundColor: "transparent", border: "none", cursor: "pointer", color: palette.textSecondary,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = palette.bgHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}

export default function ActiveCallBar(props: ActiveCallBarProps) {
  const { palette, spacing, typography } = useTheme();
  const { roomName, status } = props;
  const permissions = useRoomCallPermissions(status === "remote" ? props.roomId : undefined);
  const detail = status === "remote" ? undefined : props.detail;

  const labels = {
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    connected: "Connected",
    disconnected: "Connection lost",
    disconnecting: "Disconnecting…",
    remote: "On another device",
  };
  const statusColor = status === "connected" && !detail ? "#23a55a" : palette.textSecondary;
  const isWaiting = status === "connecting" || status === "reconnecting" || status === "disconnecting";
  const statusIconSize = typography.fontSizeSmall * 2 - 1;
  const ActionIcon = status === "remote" ? PhoneIncoming : status === "disconnected" ? X : PhoneOff;
  const actionLabel = status === "remote" ? props.joinButton.label
    : status === "disconnected" ? "Dismiss voice session" : "Disconnect";

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
        {status === "remote" ? <Laptop size={statusIconSize} /> : isWaiting ? (
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
          title={roomName}
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

      {status === "disconnected" && props.canReconnect && (
        <button type="button" onClick={props.onReconnect} style={{
          border: "none", borderRadius: spacing.unit, padding: spacing.unit,
          background: palette.bgHover, color: palette.textPrimary, cursor: "pointer", font: "inherit",
          fontSize: typography.fontSizeSmall, flexShrink: 0,
        }}>
          Reconnect
        </button>
      )}
      {status === "connected" && props.onGoToRoom && (
        <CallBarIconButton label="Go to room" icon={ArrowRightToLine} onClick={props.onGoToRoom} />
      )}
      <CallBarIconButton
        label={actionLabel}
        icon={ActionIcon}
        onClick={status === "remote" ? props.joinButton.onClick : props.onDisconnect}
        disabled={status === "disconnecting" || (status === "remote" && !permissions?.join)}
      />
    </div>
  );
}
