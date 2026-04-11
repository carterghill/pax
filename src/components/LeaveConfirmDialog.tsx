import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogOuterBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";

export type LeaveTargetKind = "room" | "space";

interface LeaveConfirmDialogProps {
  kind: LeaveTargetKind;
  targetName: string;
  /** When kind is "space", fetched from the server; null while loading */
  onlyAdminWarning: boolean | null;
  leaving: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export default function LeaveConfirmDialog({
  kind,
  targetName,
  onlyAdminWarning,
  leaving,
  error,
  onConfirm,
  onClose,
}: LeaveConfirmDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !leaving) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, leaving]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && !leaving) onClose();
    },
    [onClose, leaving]
  );

  const noun = kind === "space" ? "space" : "room";
  const title = kind === "space" ? "Leave space?" : "Leave room?";
  const loadingSpaceCheck = kind === "space" && onlyAdminWarning === null;

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
        aria-labelledby="leave-dialog-title"
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 12,
          width: "min(400px, calc(100vw - 32px))",
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
            id="leave-dialog-title"
            style={{
              margin: 0,
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={leaving}
            title="Close"
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: leaving ? "default" : "pointer",
              padding: 4,
              borderRadius: 6,
              display: "flex",
              opacity: leaving ? 0.5 : 1,
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: "0 16px 16px 16px" }}>
          <p
            style={{
              margin: "0 0 12px 0",
              fontSize: typography.fontSizeBase,
              color: palette.textSecondary,
              lineHeight: 1.5,
            }}
          >
            Leave{" "}
            <strong style={{ color: palette.textPrimary, fontWeight: typography.fontWeightMedium }}>
              {targetName}
            </strong>
            ? You will need to be invited again to rejoin this {noun}.
          </p>

          {loadingSpaceCheck && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
                marginBottom: 12,
              }}
            >
              <Loader2 size={16} style={{ animation: "spin 0.8s linear infinite" }} />
              Checking permissions…
            </div>
          )}

          {kind === "space" && onlyAdminWarning === true && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: 12,
                borderRadius: 8,
                backgroundColor: "rgba(237, 66, 69, 0.1)",
                border: "1px solid rgba(237, 66, 69, 0.35)",
                marginBottom: 12,
              }}
            >
              <AlertTriangle size={18} color="#ed4245" style={{ flexShrink: 0, marginTop: 1 }} />
              <div
                style={{
                  fontSize: typography.fontSizeSmall,
                  color: palette.textPrimary,
                  lineHeight: 1.45,
                }}
              >
                You are the only admin in this space (power level 100). If you leave, no one else may
                be able to change space settings, add rooms, or manage members unless another admin is
                promoted first.
              </div>
            </div>
          )}

          {error && (
            <p
              style={{
                margin: "0 0 12px 0",
                fontSize: typography.fontSizeSmall,
                color: "#ed4245",
                lineHeight: 1.4,
              }}
            >
              {error}
            </p>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={leaving}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${palette.border}`,
                backgroundColor: palette.bgTertiary,
                color: palette.textPrimary,
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                cursor: leaving ? "default" : "pointer",
                opacity: leaving ? 0.7 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={leaving || loadingSpaceCheck}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                backgroundColor: "#ed4245",
                color: "#fff",
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                cursor: leaving || loadingSpaceCheck ? "default" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                opacity: leaving || loadingSpaceCheck ? 0.85 : 1,
              }}
            >
              {leaving ? (
                <>
                  <Loader2 size={16} style={{ animation: "spin 0.8s linear infinite" }} />
                  Leaving…
                </>
              ) : (
                `Leave ${noun}`
              )}
            </button>
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    </ModalLayer>
  );
}

/** Load space-only-admin flag; rooms skip this. */
export async function fetchLeaveSpacePreview(roomId: string): Promise<boolean> {
  const res = await invoke<{ isOnlyAdmin: boolean }>("preview_leave_space", { roomId });
  return res.isOnlyAdmin;
}
