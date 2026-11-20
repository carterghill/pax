import { useEffect, type CSSProperties } from "react";
import { Mic, MicOff, Phone, PhoneOff, X } from "lucide-react";
import Dialog from "./Dialog";
import UserAvatar from "./UserAvatar";
import type { DirectCall } from "../hooks/useDirectCall";
import { useTheme } from "../theme/ThemeContext";

interface DirectCallControlsProps {
  call: DirectCall;
  name: string;
  avatarUrl?: string | null;
  isMicEnabled: boolean;
  peerJoined: boolean;
  showActions?: boolean;
  onAnswer: () => void;
  onEnd: () => void;
  onToggleMic: () => void;
}

export default function DirectCallControls({
  call, name, avatarUrl, isMicEnabled, peerJoined, showActions = true, onAnswer, onEnd, onToggleMic,
}: DirectCallControlsProps) {
  const { palette, spacing, typography } = useTheme();
  const incoming = call.phase === "incoming";
  useEffect(() => {
    if (!incoming) return;
    const ringtone = new Audio("/sounds/incoming-call.mp3");
    ringtone.loop = true;
    void ringtone.play().catch((reason) => console.warn("Could not play incoming ringtone:", reason));
    return () => { ringtone.pause(); };
  }, [incoming, call.callId]);

  const buttonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.unit,
    padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
    minHeight: 36,
    borderRadius: spacing.unit,
    border: "none",
    cursor: "pointer",
    color: palette.textPrimary,
    background: palette.bgHover,
    font: "inherit",
    flexShrink: 0,
  };
  const endStyle = { ...buttonStyle, background: "#b22e39", color: "#fff" };

  if (incoming) {
    return (
      <Dialog onClose={onEnd} aria-label="Incoming voice call" style={{ width: 340 }}>
        <div style={{ display: "grid", justifyItems: "center", gap: spacing.unit * 2, padding: spacing.unit * 4 }}>
          <UserAvatar userId={call.peerUserId} displayName={name} avatarUrlHint={avatarUrl} size={56} />
          <div style={{ textAlign: "center", overflowWrap: "anywhere", minWidth: 0 }}>
            <div style={{ color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>Incoming voice call</div>
            <div style={{ fontSize: typography.fontSizeBase, fontWeight: typography.fontWeightBold }}>{name}</div>
          </div>
          <div style={{ display: "flex", gap: spacing.unit * 2, flexWrap: "wrap", justifyContent: "center" }}>
            <button type="button" onClick={onEnd} style={endStyle}><PhoneOff size={17} aria-hidden="true" /> Decline</button>
            <button type="button" onClick={onAnswer} style={{ ...buttonStyle, background: "#167343", color: "#fff" }}>
              <Phone size={17} aria-hidden="true" /> Answer
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const active = call.phase === "active";
  const status = call.phase === "dialing" ? `Calling ${name}…`
    : active && peerJoined ? `In a call with ${name}` : `Connecting to ${name}…`;
  const endLabel = active ? "Hang up" : "Cancel call";
  const muteLabel = isMicEnabled ? "Mute microphone" : "Unmute microphone";

  return (
    <div style={{
      flexShrink: 0, display: "flex", alignItems: "center", gap: spacing.unit * 2,
      padding: `${spacing.unit}px ${spacing.unit * 2}px`, background: palette.bgSecondary,
      borderBottom: `1px solid ${palette.border}`, fontSize: typography.fontSizeSmall,
    }}>
      <Phone size={17} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span role="status" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {status}
      </span>
      {showActions && active && (
        <button type="button" aria-label={muteLabel} title={muteLabel} onClick={onToggleMic} style={buttonStyle}>
          {isMicEnabled ? <Mic size={17} aria-hidden="true" /> : <MicOff size={17} aria-hidden="true" />}
        </button>
      )}
      {showActions && (
        <button type="button" aria-label={endLabel} title={endLabel} onClick={onEnd} style={endStyle}>
          <PhoneOff size={17} aria-hidden="true" /> {endLabel}
        </button>
      )}
    </div>
  );
}

export function DirectCallError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { palette, spacing, typography } = useTheme();
  return (
    <div style={{
      flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing.unit,
      padding: `${spacing.unit}px ${spacing.unit * 2}px`, background: palette.bgSecondary,
      borderBottom: `1px solid ${palette.border}`, fontSize: typography.fontSizeSmall,
    }}>
      <span role="alert">{message}</span>
      <button type="button" title="Dismiss" aria-label="Dismiss call message" onClick={onDismiss} style={{
        display: "flex", border: "none", background: "none", color: palette.textPrimary, padding: spacing.unit, cursor: "pointer",
      }}>
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
