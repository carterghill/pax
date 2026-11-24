import { useEffect, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Mic, MicOff, Phone, PhoneOff, Video, X } from "lucide-react";
import Dialog from "./Dialog";
import UserAvatar from "./UserAvatar";
import type { DirectCall, DirectCallPeerConnection } from "../hooks/useDirectCall";
import { useTheme } from "../theme/ThemeContext";

interface DirectCallControlsProps {
  call: DirectCall;
  name: string;
  groupCaller?: string;
  avatarUrl?: string | null;
  isMicEnabled: boolean;
  peerConnection: DirectCallPeerConnection;
  canMute: boolean;
  isReconnecting: boolean;
  showActions?: boolean;
  onAnswer: () => void;
  onDecline: () => void;
  onEnd: () => void;
  onToggleMic: () => void;
}

export default function DirectCallControls({
  call, name, groupCaller, avatarUrl, isMicEnabled, peerConnection, canMute, isReconnecting,
  showActions = true, onAnswer, onDecline, onEnd, onToggleMic,
}: DirectCallControlsProps) {
  const { palette, spacing, typography } = useTheme();
  const incoming = call.phase === "incoming";
  const CallIcon = call.video ? Video : Phone;
  const incomingLabel = call.video ? "Incoming video call" : "Incoming voice call";
  const answerLabel = call.video ? "Answer with video" : "Answer";
  useEffect(() => {
    if (!incoming || call.silent) return;
    const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
      || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
    const android = (window as Window & {
      PaxAndroid?: { canPostIncomingCalls?(): boolean };
    }).PaxAndroid;
    if (isTauri() && (appleMobile || android?.canPostIncomingCalls?.())) return;
    const ringtone = new Audio("/sounds/incoming-call.mp3");
    ringtone.loop = true;
    void ringtone.play().catch((reason) => console.warn("Could not play incoming ringtone:", reason));
    const stopRingtone = () => ringtone.pause();
    if (android) window.addEventListener("pax-notification-permission-granted", stopRingtone);
    return () => {
      window.removeEventListener("pax-notification-permission-granted", stopRingtone);
      stopRingtone();
    };
  }, [incoming, call.callId, call.silent]);

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

  if (incoming && !call.silent) {
    return (
      <Dialog onClose={onEnd} aria-label={incomingLabel} style={{ width: 340 }}>
        <div style={{ display: "grid", justifyItems: "center", gap: spacing.unit * 2, padding: spacing.unit * 4 }}>
          <UserAvatar userId={call.peerUserId} displayName={groupCaller ?? name} avatarUrlHint={avatarUrl} size={56} />
          <div style={{ textAlign: "center", overflowWrap: "anywhere", minWidth: 0 }}>
            <div style={{ color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>{groupCaller
              ? `${groupCaller} is ${call.video ? "video calling" : "calling"} the group` : incomingLabel}</div>
            <div style={{ fontSize: typography.fontSizeBase, fontWeight: typography.fontWeightBold }}>{name}</div>
          </div>
          <div style={{ display: "flex", gap: spacing.unit * 2, flexWrap: "wrap", justifyContent: "center" }}>
            <button type="button" onClick={onDecline} style={endStyle}><PhoneOff size={17} aria-hidden="true" /> Decline</button>
            <button type="button" onClick={onAnswer} style={{ ...buttonStyle, background: "#167343", color: "#fff" }}>
              <CallIcon size={17} aria-hidden="true" /> {answerLabel}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const active = call.phase === "active";
  const status = incoming ? `Silent ${call.video ? "video call" : "call"} from ${groupCaller ?? name}` : call.phase === "dialing" ? `${call.video ? "Video calling" : "Calling"} ${name}…`
    : peerConnection === "lost" ? `${name} lost connection and may reconnect.`
    : peerConnection === "interrupted" ? `${name}’s connection was interrupted.`
    : call.phase === "resuming" || isReconnecting ? "Reconnecting…"
    : call.phase === "interrupted" || (call.established && !canMute) ? "Your voice connection was interrupted."
    : peerConnection === "connected" ? `In a call with ${name}` : `Connecting to ${name}…`;
  const endLabel = active || call.established ? "Hang up" : "Cancel call";
  const muteLabel = isMicEnabled ? "Mute microphone" : "Unmute microphone";

  return (
    <div style={{
      flexShrink: 0, display: "flex", alignItems: "center", gap: spacing.unit * 2,
      padding: `${spacing.unit}px ${spacing.unit * 2}px`, background: palette.bgSecondary,
      borderBottom: `1px solid ${palette.border}`, fontSize: typography.fontSizeSmall,
    }}>
      <CallIcon size={17} aria-hidden="true" style={{ flexShrink: 0 }} />
      <span role="status" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {status}
      </span>
      {showActions && active && canMute && (
        <button type="button" aria-label={muteLabel} title={muteLabel} onClick={onToggleMic} style={buttonStyle}>
          {isMicEnabled ? <Mic size={17} aria-hidden="true" /> : <MicOff size={17} aria-hidden="true" />}
        </button>
      )}
      {incoming && <>
        <button type="button" onClick={onDecline} style={buttonStyle}>Decline</button>
        <button type="button" onClick={onAnswer} style={buttonStyle}>{answerLabel}</button>
      </>}
      {showActions && !incoming && (
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
