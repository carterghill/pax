import { useRef } from "react";
import { X } from "lucide-react";
import ModalLayer from "./ModalLayer";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogOuterBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

export interface ModerationScopeDialogProps {
  kind: "kick" | "ban" | "unban";
  targetDisplayName: string;
  /** Current channel/room label for the secondary action. */
  currentRoomName: string;
  /** When true, primary action applies to the whole space tree. */
  showSpaceScope: boolean;
  /** Label for the space (optional; falls back to “this space”). */
  spaceName?: string | null;
  onSpaceScope: () => void;
  onRoomOnly: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export default function ModerationScopeDialog({
  kind,
  targetDisplayName,
  currentRoomName,
  showSpaceScope,
  spaceName,
  onSpaceScope,
  onRoomOnly,
  onCancel,
  busy = false,
}: ModerationScopeDialogProps) {
  const { palette, typography, spacing } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const verb =
    kind === "kick" ? "Kick" : kind === "ban" ? "Ban" : "Unban";
  const verbLower = verb.toLowerCase();
  const isUnban = kind === "unban";
  const hasSpace = showSpaceScope;
  const spaceLabel = spaceName?.trim() || "this space";

  return (
    <ModalLayer
      onBackdropClick={busy ? undefined : onCancel}
      backdropStyle={{
        backgroundColor: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        fontFamily: typography.fontFamily,
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="moderation-scope-title"
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: "min(420px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 24px 48px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06) inset",
          border: paletteDialogOuterBorderStyle(palette),
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: spacing.unit * 2,
            padding: `${spacing.unit * 3}px ${spacing.unit * 3}px ${spacing.unit * 2}px`,
            borderBottom: `1px solid ${palette.border}`,
          }}
        >
          <h2
            id="moderation-scope-title"
            style={{
              margin: 0,
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
              lineHeight: 1.3,
            }}
          >
            {verb} {targetDisplayName}?
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onCancel}
            style={{
              flexShrink: 0,
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: palette.bgHover,
              color: palette.textSecondary,
            }}
          >
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>

        <div style={{ padding: spacing.unit * 3, fontSize: typography.fontSizeSmall, color: palette.textSecondary, lineHeight: 1.55 }}>
          {hasSpace ? (
            isUnban ? (
              <>
                Choose whether to unban them only in this space room ({currentRoomName}), or lift bans
                across the whole space &quot;{spaceLabel}&quot; (including every room and sub-space in it).
              </>
            ) : (
              <>
                Choose whether to {verbLower} them only from this room ({currentRoomName}), or from the
                whole space &quot;{spaceLabel}&quot; (including every room and sub-space in it) where you have
                permission.
              </>
            )
          ) : isUnban ? (
            <>They will be unbanned in {currentRoomName} only.</>
          ) : (
            <>
              They will be {kind === "kick" ? "removed" : "banned"} from {currentRoomName} only.
            </>
          )}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing.unit * 1.5,
            padding: `0 ${spacing.unit * 3}px ${spacing.unit * 3}px`,
          }}
        >
          {hasSpace && (
            <button
              type="button"
              disabled={busy}
              onClick={onSpaceScope}
              style={{
                width: "100%",
                padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                borderRadius: 6,
                border: "none",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.7 : 1,
                backgroundColor: isUnban ? "#23a55a" : "#ed4245",
                color: "#fff",
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightBold,
                fontFamily: typography.fontFamily,
              }}
            >
              {isUnban ? "Unban from space and all rooms" : `${verb} from space and all rooms`}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onRoomOnly}
            style={{
              width: "100%",
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              borderRadius: 6,
              border: `1px solid ${palette.border}`,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
              backgroundColor: palette.bgTertiary,
              color: palette.textPrimary,
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              fontFamily: typography.fontFamily,
            }}
          >
            {isUnban ? "Unban from this space only" : `${verb} from this room only`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              width: "100%",
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              borderRadius: 6,
              border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              backgroundColor: "transparent",
              color: palette.textSecondary,
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              fontFamily: typography.fontFamily,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}
