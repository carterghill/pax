import { Mic, Square, X } from "lucide-react";
import { useTheme } from "../../../theme/ThemeContext";
import type { useComposerAudioRecording } from "./useComposerAudioRecording";

export default function ComposerAudioRecordingBar({
  phase, elapsedSeconds, error, stop, cancel,
}: ReturnType<typeof useComposerAudioRecording>) {
  const { palette, typography, spacing } = useTheme();
  if (!phase && !error) return null;
  const time = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const button = {
    display: "inline-flex", alignItems: "center", gap: spacing.unit,
    minHeight: 40, padding: `0 ${spacing.unit * 2}px`,
    border: `1px solid ${palette.border}`, borderRadius: spacing.unit * 1.5,
    background: palette.bgTertiary, color: palette.textPrimary,
    font: "inherit", cursor: "pointer", flexShrink: 0,
  };

  return (
    <div style={{
      display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.unit * 2,
      padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
      borderBottom: `1px solid ${palette.border}`,
      color: palette.textSecondary, fontSize: typography.fontSizeSmall,
    }}>
      {error && <span role="alert">{error}</span>}
      {phase && (
        <>
          <Mic size={16} aria-hidden="true" style={{ color: palette.accent, flexShrink: 0 }} />
          <span style={{ flex: "1 1 auto" }}>
            {phase === "recording" ? <>Recording <time aria-label={`${elapsedSeconds} seconds`}>{time}</time></>
              : phase === "starting" ? "Starting microphone…" : "Preparing audio…"}
          </span>
          {phase === "recording" && (
            <button type="button" style={button} onClick={() => void stop()}>
              <Square size={13} aria-hidden="true" /> Stop
            </button>
          )}
          <button type="button" aria-label="Cancel recording" style={button} onClick={cancel}>
            <X size={16} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
