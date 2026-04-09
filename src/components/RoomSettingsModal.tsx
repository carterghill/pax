import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Check, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

type HistoryVisibility = "joined" | "shared" | "invited" | "world_readable";

const VISIBILITY_OPTIONS: {
  value: HistoryVisibility;
  label: string;
  description: string;
}[] = [
  {
    value: "shared",
    label: "Members only (since selecting this option)",
    description:
      "Anyone who is a member of the room can see the full message history, including messages from before they joined.",
  },
  {
    value: "joined",
    label: "Members only (since they joined)",
    description:
      "Each member can only see messages from the point they joined. Earlier messages are hidden.",
  },
  {
    value: "invited",
    label: "Members only (since they were invited)",
    description:
      "Each member can see messages from the point they were invited, even before they accepted.",
  },
  {
    value: "world_readable",
    label: "Anyone",
    description:
      "Anyone can read the room history, even without joining the room.",
  },
];

interface RoomSettingsModalProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
}

export default function RoomSettingsModal({
  roomId,
  roomName,
  onClose,
}: RoomSettingsModalProps) {
  const { palette, spacing, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [currentVisibility, setCurrentVisibility] =
    useState<HistoryVisibility | null>(null);
  const [selectedVisibility, setSelectedVisibility] =
    useState<HistoryVisibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Fetch current visibility on mount
  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_history_visibility", { roomId })
      .then((vis) => {
        if (!cancelled) {
          const v = vis as HistoryVisibility;
          setCurrentVisibility(v);
          setSelectedVisibility(v);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSave() {
    if (!selectedVisibility || selectedVisibility === currentVisibility) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await invoke("set_history_visibility", {
        roomId,
        visibility: selectedVisibility,
      });
      setCurrentVisibility(selectedVisibility);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }

  const hasChanges =
    selectedVisibility !== null && selectedVisibility !== currentVisibility;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 12,
          border: `1px solid ${palette.border}`,
          width: 480,
          maxWidth: "90vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: `${spacing.unit * 4}px ${spacing.unit * 5}px`,
            borderBottom: `1px solid ${palette.border}`,
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: typography.fontSizeLarge,
                fontWeight: typography.fontWeightBold,
                color: palette.textHeading,
              }}
            >
              Room Settings
            </h2>
            <div
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                marginTop: spacing.unit,
              }}
            >
              {roomName}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "50%",
              border: "none",
              backgroundColor: "transparent",
              color: palette.textSecondary,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                palette.bgActive;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent";
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: `${spacing.unit * 5}px`,
            overflowY: "auto",
            flex: 1,
          }}
        >
          {/* Section: History Visibility */}
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: typography.fontSizeBase,
                fontWeight: typography.fontWeightBold,
                color: palette.textHeading,
                marginBottom: spacing.unit * 2,
              }}
            >
              Who can read history?
            </h3>

            {loading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 2,
                  color: palette.textSecondary,
                  fontSize: typography.fontSizeSmall,
                  padding: spacing.unit * 3,
                }}
              >
                <Loader2
                  size={16}
                  style={{ animation: "spin 1s linear infinite" }}
                />
                Loading...
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: spacing.unit * 2,
                }}
              >
                {VISIBILITY_OPTIONS.map((opt) => {
                  const isSelected = selectedVisibility === opt.value;
                  return (
                    <label
                      key={opt.value}
                      style={{
                        display: "flex",
                        gap: spacing.unit * 3,
                        padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
                        borderRadius: 8,
                        cursor: "pointer",
                        border: `1px solid ${
                          isSelected ? palette.accent : palette.border
                        }`,
                        backgroundColor: isSelected
                          ? `${palette.accent}15`
                          : palette.bgPrimary,
                        transition: "border-color 0.15s, background-color 0.15s",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          (e.currentTarget as HTMLLabelElement).style.borderColor =
                            palette.textSecondary;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) {
                          (e.currentTarget as HTMLLabelElement).style.borderColor =
                            palette.border;
                        }
                      }}
                    >
                      {/* Custom radio circle */}
                      <div
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          border: `2px solid ${
                            isSelected ? palette.accent : palette.textSecondary
                          }`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          marginTop: 1,
                          transition: "border-color 0.15s",
                        }}
                      >
                        {isSelected && (
                          <div
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              backgroundColor: palette.accent,
                            }}
                          />
                        )}
                      </div>
                      <input
                        type="radio"
                        name="history_visibility"
                        value={opt.value}
                        checked={isSelected}
                        onChange={() => setSelectedVisibility(opt.value)}
                        style={{ display: "none" }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: typography.fontSizeSmall,
                            fontWeight: typography.fontWeightMedium,
                            color: palette.textHeading,
                          }}
                        >
                          {opt.label}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: palette.textSecondary,
                            marginTop: spacing.unit,
                            lineHeight: 1.4,
                          }}
                        >
                          {opt.description}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Room ID */}
          <div
            style={{
              marginTop: spacing.unit * 3,
              paddingTop: spacing.unit * 2,
              borderTop: `1px solid ${palette.border}`,
            }}
          >
            <label
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                fontWeight: typography.fontWeightMedium,
              }}
            >
              Room ID
            </label>
            <div
              style={{
                fontSize: typography.fontSizeSmall - 1,
                color: palette.textSecondary,
                userSelect: "all",
                wordBreak: "break-all",
                cursor: "pointer",
                opacity: 0.7,
                marginTop: 2,
              }}
              title="Click to copy"
              onClick={() => navigator.clipboard.writeText(roomId)}
            >
              {roomId}
            </div>
          </div>

          {/* Error message */}
          {error && (
            <div
              style={{
                marginTop: spacing.unit * 3,
                padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                borderRadius: 6,
                backgroundColor: "rgba(243, 139, 168, 0.1)",
                color: "#f38ba8",
                fontSize: typography.fontSizeSmall,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: spacing.unit * 2,
            padding: `${spacing.unit * 3}px ${spacing.unit * 5}px`,
            borderTop: `1px solid ${palette.border}`,
          }}
        >
          {success && (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.unit,
                color: "#23a55a",
                fontSize: typography.fontSizeSmall,
                marginRight: "auto",
              }}
            >
              <Check size={14} />
              Saved
            </span>
          )}
          <button
            onClick={onClose}
            style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
              borderRadius: 6,
              border: "none",
              backgroundColor: "transparent",
              color: palette.textPrimary,
              fontSize: typography.fontSizeSmall,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                palette.bgActive;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                "transparent";
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
              borderRadius: 6,
              border: "none",
              backgroundColor: hasChanges ? palette.accent : palette.bgActive,
              color: hasChanges ? "#fff" : palette.textSecondary,
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              cursor: hasChanges ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving && (
              <Loader2
                size={14}
                style={{ animation: "spin 1s linear infinite" }}
              />
            )}
            Save
          </button>
        </div>

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}