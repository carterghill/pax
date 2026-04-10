import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, UserPlus, Loader2, Check } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import { parseInviteUserInput } from "../utils/matrix";

export type InviteTargetKind = "room" | "space";

interface InviteDialogProps {
  roomId: string;
  /** Display name of the room or space being invited to */
  targetName: string;
  kind: InviteTargetKind;
  /** Current user's Matrix ID — used to block self-invite */
  currentUserId: string;
  onClose: () => void;
}

export default function InviteDialog({
  roomId,
  targetName,
  kind,
  currentUserId,
  onClose,
}: InviteDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMxid, setSuccessMxid] = useState<string | null>(null);

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
    [onClose]
  );

  const submit = useCallback(async () => {
    setError(null);
    const mxid = parseInviteUserInput(input);
    if (!mxid) {
      setError(
        "Enter a valid Matrix ID, for example @username:example.org. You can paste a matrix.to link."
      );
      return;
    }
    const self = currentUserId.trim().toLowerCase();
    if (mxid === self) {
      setError("You cannot invite yourself.");
      return;
    }

    setSubmitting(true);
    try {
      await invoke("invite_user", { roomId, userId: mxid });
      setSuccessMxid(mxid);
      setInput("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }, [input, roomId, currentUserId]);

  const inviteAnother = useCallback(() => {
    setSuccessMxid(null);
    setError(null);
  }, []);

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    color: palette.textSecondary,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    fontSize: typography.fontSizeBase,
    fontFamily: typography.fontFamily,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    color: palette.textPrimary,
    outline: "none",
    boxSizing: "border-box",
  };

  const targetKindLabel = kind === "space" ? "space" : "room";

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        padding: 16,
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-labelledby="invite-dialog-title"
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 12,
          width: "min(480px, calc(100vw - 32px))",
          maxWidth: 480,
          boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
          border: `1px solid ${palette.border}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "20px 20px 8px 20px",
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                backgroundColor: palette.bgTertiary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <UserPlus size={22} color={palette.textSecondary} strokeWidth={2} />
            </div>
            <div>
              <h2
                id="invite-dialog-title"
                style={{
                  margin: 0,
                  fontSize: typography.fontSizeLarge,
                  fontWeight: typography.fontWeightBold,
                  color: palette.textHeading,
                  lineHeight: 1.25,
                }}
              >
                Invite people
              </h2>
              <p
                style={{
                  margin: "6px 0 0 0",
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                  lineHeight: 1.45,
                }}
              >
                Invite someone to the {targetKindLabel}{" "}
                <strong style={{ color: palette.textPrimary, fontWeight: typography.fontWeightMedium }}>
                  {targetName}
                </strong>
                . They will receive an invitation on their account.
              </p>
            </div>
          </div>
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
              flexShrink: 0,
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: "8px 20px 20px 20px" }}>
          {successMxid ? (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: 12,
                  borderRadius: 8,
                  backgroundColor: "rgba(35, 165, 90, 0.12)",
                  border: "1px solid rgba(35, 165, 90, 0.35)",
                  marginBottom: 16,
                }}
              >
                <Check size={18} color="#23a55a" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div
                    style={{
                      fontSize: typography.fontSizeBase,
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textPrimary,
                    }}
                  >
                    Invitation sent
                  </div>
                  <div style={{ fontSize: typography.fontSizeSmall, color: palette.textSecondary, marginTop: 4 }}>
                    {successMxid} will get an invite to join this {targetKindLabel}.
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  type="button"
                  onClick={inviteAnother}
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
                  Invite another
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: "none",
                    backgroundColor: "#5865f2",
                    color: "#fff",
                    fontSize: typography.fontSizeSmall,
                    fontWeight: typography.fontWeightMedium,
                    cursor: "pointer",
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <p
                style={{
                  margin: "0 0 12px 0",
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                  lineHeight: 1.5,
                }}
              >
                Enter their Matrix user ID (MXID). Example:{" "}
                <code style={{ color: palette.textPrimary, fontSize: "0.95em" }}>@username:matrix.org</code>
              </p>

              <label htmlFor="invite-mxid-input" style={labelStyle}>
                User ID
              </label>
              <input
                id="invite-mxid-input"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="@username:example.org"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={submitting}
                style={inputStyle}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !submitting) void submit();
                }}
              />

              {error && (
                <p
                  style={{
                    margin: "10px 0 0 0",
                    fontSize: typography.fontSizeSmall,
                    color: "#ed4245",
                    lineHeight: 1.4,
                  }}
                >
                  {error}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  marginTop: 18,
                }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: `1px solid ${palette.border}`,
                    backgroundColor: palette.bgTertiary,
                    color: palette.textPrimary,
                    fontSize: typography.fontSizeSmall,
                    fontWeight: typography.fontWeightMedium,
                    cursor: submitting ? "default" : "pointer",
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={submitting}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 8,
                    border: "none",
                    backgroundColor: "#5865f2",
                    color: "#fff",
                    fontSize: typography.fontSizeSmall,
                    fontWeight: typography.fontWeightMedium,
                    cursor: submitting ? "default" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    opacity: submitting ? 0.85 : 1,
                  }}
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} style={{ animation: "spin 0.8s linear infinite" }} />
                      Sending…
                    </>
                  ) : (
                    "Send invitation"
                  )}
                </button>
              </div>
              <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
