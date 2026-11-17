import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogOuterBorderStyle } from "../theme/paletteBorder";
import Dialog from "./Dialog";

interface QuitConfirmDialogProps {
  onClose: () => void;
}

export default function QuitConfirmDialog({ onClose }: QuitConfirmDialogProps) {
  const { palette, typography } = useTheme();
  const [rememberChoice, setRememberChoice] = useState(false);

  const minimize = useCallback(async () => {
    try {
      if (rememberChoice) {
        await invoke("set_close_window_preference", { action: "minimize_tray" });
      }
      await invoke("hide_main_window");
      onClose();
    } catch (e) {
      console.error(e);
    }
  }, [onClose, rememberChoice]);

  const exit = useCallback(async () => {
    try {
      if (rememberChoice) {
        await invoke("set_close_window_preference", { action: "quit" });
      }
      await invoke("exit_app");
    } catch (e) {
      console.error(e);
    }
  }, [rememberChoice]);

  const secondaryButtonStyle = {
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${palette.border}`,
    backgroundColor: palette.bgTertiary,
    color: palette.textPrimary,
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    cursor: "pointer" as const,
  };

  return (
    <Dialog
      onClose={onClose}
      aria-labelledby="quit-dialog-title"
      style={{
        backgroundColor: palette.bgSecondary,
        borderRadius: 12,
        width: "min(420px, calc(100vw - 32px))",
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
        border: paletteDialogOuterBorderStyle(palette),
      }}
    >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "16px 16px 8px 16px",
          }}
        >
          <h2
            id="quit-dialog-title"
            style={{
              margin: 0,
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
            }}
          >
            Close Pax?
          </h2>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: "pointer",
              padding: 4,
              borderRadius: 6,
              display: "flex",
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: "0 16px 16px 16px" }}>
          <p
            style={{
              margin: "0 0 16px 0",
              fontSize: typography.fontSizeBase,
              color: palette.textSecondary,
              lineHeight: 1.5,
            }}
          >
            Do you want to quit completely, or keep Pax running in the background (system tray)?
          </p>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
              cursor: "pointer",
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }}
            />
            <span>Remember my choice</span>
          </label>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button type="button" onClick={onClose} style={secondaryButtonStyle}>
              Cancel
            </button>
            <button type="button" onClick={exit} style={secondaryButtonStyle}>
              Quit completely
            </button>
            <button
              type="button"
              onClick={minimize}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                backgroundColor: palette.accent,
                color: "#fff",
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = palette.accentHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = palette.accent;
              }}
            >
              Minimize to tray
            </button>
          </div>
        </div>
    </Dialog>
  );
}
