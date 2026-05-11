import { File, X } from "lucide-react";
import type { Message } from "../../../types/matrix";
import type { ThemePalette, ThemeSpacing, ThemeTypography } from "../../../theme/types";
import CircularUploadRing from "../../../components/CircularUploadRing";
import type { PendingAttachment } from "./fileUpload";

interface ComposerContextBarProps {
  replyDraft: Message | null;
  showReply: boolean;
  pendingFile: PendingAttachment | null;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  onCancelReply?: () => void;
  onClearPendingFile: () => void;
}

function replyTargetSummary(msg: Message): string {
  const who = (msg.senderName?.trim() || msg.sender).trim() || "Message";
  if (msg.imageMediaRequest) return `${who} · Image`;
  if (msg.localImagePreviewObjectUrl) return `${who} · Image`;
  if (msg.videoMediaRequest) return `${who} · Video`;
  if (msg.fileMediaRequest) {
    const fn = msg.fileDisplayName?.trim();
    return fn ? `${who} · ${fn}` : `${who} · File`;
  }
  const t = msg.body.trim();
  if (!t) return who;
  return t.length > 100 ? `${who} · ${t.slice(0, 100)}…` : `${who} · ${t}`;
}

export default function ComposerContextBar({
  replyDraft,
  showReply,
  pendingFile,
  palette,
  typography,
  spacing,
  onCancelReply,
  onClearPendingFile,
}: ComposerContextBarProps) {
  return (
    <>
      {showReply && replyDraft && onCancelReply ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 1.5,
            padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
            borderBottom: `1px solid ${palette.border}`,
            minWidth: 0,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={replyTargetSummary(replyDraft)}
          >
            Replying to {replyTargetSummary(replyDraft)}
          </span>
          <button
            type="button"
            onClick={() => onCancelReply()}
            title="Cancel reply"
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              border: "none",
              borderRadius: spacing.unit,
              background: "transparent",
              color: palette.textSecondary,
              cursor: "pointer",
            }}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}

      {pendingFile && (
        <div
          style={{
            padding: `${spacing.unit * 2}px ${spacing.unit * 3}px 0`,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit,
              backgroundColor: palette.bgTertiary,
              borderRadius: spacing.unit * 1.25,
              border: `1px solid ${palette.border}`,
              padding: `${spacing.unit * 1.25}px ${spacing.unit * 1.5}px`,
              maxWidth: "100%",
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.unit * 2,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.unit * 1.5,
                }}
              >
                {pendingFile.previewUrl ? (
                  <img
                    src={pendingFile.previewUrl}
                    alt=""
                    draggable={false}
                    style={{
                      display: "block",
                      width: 56,
                      height: 56,
                      objectFit: "cover",
                      borderRadius: spacing.unit,
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <File
                    size={20}
                    strokeWidth={2}
                    style={{
                      flexShrink: 0,
                      color: palette.textSecondary,
                    }}
                    aria-hidden
                  />
                )}
                <span
                  style={{
                    fontSize: typography.fontSizeSmall,
                    fontFamily: typography.fontFamily,
                    color: palette.textPrimary,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                  title={pendingFile.name}
                >
                  {pendingFile.name}
                </span>
              </div>

              <div
                style={{
                  position: "relative",
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                }}
              >
                {pendingFile.phase !== "error" ? (
                  <CircularUploadRing
                    progress={pendingFile.progress01}
                    size={30}
                    strokeWidth={2.5}
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                    }}
                  />
                ) : null}
                <button
                  type="button"
                  title="Remove attachment"
                  aria-label="Remove attachment"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onClearPendingFile}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                    width: 22,
                    height: 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    border: "none",
                    borderRadius: "50%",
                    backgroundColor: palette.bgPrimary,
                    color: palette.textSecondary,
                    cursor: "pointer",
                    zIndex: 1,
                    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = palette.textPrimary;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = palette.textSecondary;
                  }}
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            </div>
            {pendingFile.phase === "error" && pendingFile.errorMessage ? (
              <div
                style={{
                  fontSize: typography.fontSizeSmall * 0.95,
                  color: palette.textSecondary,
                }}
              >
                {pendingFile.errorMessage}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
