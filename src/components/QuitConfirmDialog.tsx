import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogOuterBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";

interface QuitConfirmDialogProps {
  onClose: () => void;
}

export default function QuitConfirmDialog({ onClose }: QuitConfirmDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const minimize = useCallback(async () => {
    try {
      await invoke("hide_main_window");
      onClose();
    } catch (e) {
      console.error(e);
    }
  }, [onClose]);

  const exit = useCallback(async () => {
    try {
      await invoke("exit_app");
    } catch (e) {
      console.error(e);
    }
  }, []);

  return (
    <ModalLayer
      onBackdropClick={handleBackdropClick}
      backdropStyle={{
        backgroundColor: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
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

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${palette.border}`,
                backgroundColor: palette.bgTertiary,
                color: palette.textPrimary,
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={minimize}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${palette.border}`,
                backgroundColor: palette.bgTertiary,
                color: palette.textPrimary,
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                cursor: "pointer",
              }}
            >
              Minimize to tray
            </button>
            <button
              type="button"
              onClick={exit}
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
            >
              Quit completely
            </button>
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}
