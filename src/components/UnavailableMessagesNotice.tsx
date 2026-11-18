import { LockKeyhole } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

export default function UnavailableMessagesNotice({ acknowledged, busy, error, isAtLatest, canClear, onClear, onRecover, onIgnore, onJumpToRecent }: {
  acknowledged: boolean; busy: boolean; error: string | null; isAtLatest: boolean; canClear: boolean;
  onClear: () => void; onRecover: () => void; onIgnore: () => void; onJumpToRecent: () => void;
}) {
  const { palette, typography, spacing } = useTheme();
  const button = { padding: "6px 10px", borderRadius: 7, border: `1px solid ${palette.border}`,
    background: palette.bgPrimary, color: palette.textPrimary, font: "inherit", cursor: "pointer" };
  return <div style={{ padding: `${spacing.unit * 3}px ${spacing.unit * 4}px`, borderBottom: `1px solid ${palette.border}`,
    background: palette.bgSecondary, color: palette.textSecondary, fontSize: typography.fontSizeSmall, flexShrink: 0 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", color: palette.textPrimary }}>
      <LockKeyhole size={16} aria-hidden="true" />
      <strong>Some messages are unavailable on this device</strong>
    </div>
    <p style={{ margin: "6px 0 10px", lineHeight: 1.5 }}>
      Someone may have replied even though this device can’t decrypt their message.
      Clearing the notification won’t tell them you’ve read it. The messages may become readable after recovery.
    </p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      {isAtLatest ? <button type="button" disabled={busy || acknowledged || !canClear} style={button} onClick={onClear}>
        {busy ? "Clearing…" : acknowledged ? "Notification cleared" : "Clear notification"}
      </button> : <button type="button" style={button} onClick={onJumpToRecent}>Jump to recent to clear notification</button>}
      <button type="button" style={button} onClick={onRecover}>Try recovery</button>
      <button type="button" style={button} onClick={onIgnore}
        title="Hide this warning for this conversation on this device without changing notifications.">Ignore</button>
    </div>
    {error && <p role="alert" style={{ margin: "8px 0 0", lineHeight: 1.5 }}>{error}</p>}
  </div>;
}
