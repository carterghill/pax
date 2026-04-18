import { useState, useRef, useEffect } from "react";
import { useTheme } from "../theme/ThemeContext";
import { usePresenceContext } from "../hooks/PresenceContext";
import { ManualStatus } from "../hooks/usePresence";
import { ChevronDown, X } from "lucide-react";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import UserAvatar from "./UserAvatar";

const presenceColor: Record<string, string> = {
  online: "#23a55a",
  unavailable: "#f0b232",
  dnd: "#f23f43",
  offline: "#80848e",
};

const statusOptions: { value: ManualStatus; label: string; color: string }[] = [
  { value: "auto", label: "Automatic", color: presenceColor.online },
  { value: "online", label: "Online", color: presenceColor.online },
  { value: "unavailable", label: "Away", color: presenceColor.unavailable },
  { value: "dnd", label: "Do Not Disturb", color: presenceColor.dnd },
  { value: "offline", label: "Offline", color: presenceColor.offline },
];

function getDisplayColor(presence: string): string {
  return presenceColor[presence] ?? presenceColor.offline;
}

function getDisplayLabel(presence: string): string {
  const labels: Record<string, string> = {
    online: "Online",
    unavailable: "Away",
    dnd: "Do Not Disturb",
    offline: "Offline",
  };
  return labels[presence] ?? "Online";
}

interface StatusDropdownProps {
  displayName: string;
  avatarUrl: string | null;
  userId: string;
}

export default function StatusDropdown({ displayName, avatarUrl, userId }: StatusDropdownProps) {
  const { palette, typography, spacing } = useTheme();
  const { manualStatus, setManualStatus, effectivePresence, statusMessage, setStatusMessage } = usePresenceContext();
  const [open, setOpen] = useState(false);
  const [editingStatus, setEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState(statusMessage);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const statusInputRef = useRef<HTMLInputElement>(null);
  useOverlayObstruction(popupRef, open);

  // Sync draft when dropdown opens
  useEffect(() => {
    if (open) {
      setStatusDraft(statusMessage);
      setEditingStatus(false);
    }
  }, [open, statusMessage]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingStatus && statusInputRef.current) {
      statusInputRef.current.focus();
    }
  }, [editingStatus]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const commitStatus = () => {
    setStatusMessage(statusDraft.trim());
    setEditingStatus(false);
  };

  const clearStatus = () => {
    setStatusDraft("");
    setStatusMessage("");
    setEditingStatus(false);
  };

  return (
    <div ref={dropdownRef} style={{
      padding: `${spacing.unit * 2}px`,
      borderTop: `1px solid ${palette.border}`,
      position: "relative",
    }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 3,
          cursor: "pointer",
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
          borderRadius: spacing.unit,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
        }}
      >
        {/* Avatar */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <UserAvatar
            userId={userId}
            displayName={displayName}
            avatarUrlHint={avatarUrl}
            size={32}
            fontSize={typography.fontSizeSmall}
          />
          <div style={{
            position: "absolute",
            bottom: -1,
            right: -1,
            width: 10,
            height: 10,
            borderRadius: "50%",
            backgroundColor: getDisplayColor(effectivePresence),
            border: `2px solid ${palette.bgSecondary}`,
          }} />
        </div>

        {/* Name + status */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textPrimary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {displayName}
          </div>
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {statusMessage || getDisplayLabel(effectivePresence)}
          </div>
        </div>

        <ChevronDown size={14} color={palette.textSecondary} />
      </div>

      {/* Dropdown menu — opens upward */}
      {open && (
        <div ref={popupRef} style={{
          position: "absolute",
          bottom: "100%",
          left: spacing.unit * 2,
          right: spacing.unit * 2,
          backgroundColor: palette.bgTertiary,
          borderRadius: spacing.unit * 2,
          padding: `${spacing.unit}px 0`,
          zIndex: 100,
          boxShadow: "0 -4px 12px rgba(0,0,0,0.3)",
          marginBottom: spacing.unit,
        }}>
          {/* ── Set Status section ── */}
          <div style={{ padding: `${spacing.unit * 2}px ${spacing.unit * 3}px` }}>
            {editingStatus ? (
              <div style={{ display: "flex", alignItems: "center", gap: spacing.unit }}>
                <input
                  ref={statusInputRef}
                  type="text"
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitStatus();
                    if (e.key === "Escape") setEditingStatus(false);
                  }}
                  onBlur={commitStatus}
                  placeholder="What's on your mind?"
                  maxLength={100}
                  style={{
                    flex: 1,
                    background: palette.bgPrimary,
                    border: `1px solid ${palette.border}`,
                    borderRadius: spacing.unit,
                    padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                    color: palette.textPrimary,
                    fontSize: typography.fontSizeSmall,
                    outline: "none",
                    minWidth: 0,
                  }}
                />
              </div>
            ) : (
              <div
                onClick={() => setEditingStatus(true)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 2,
                  padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                  borderRadius: spacing.unit,
                  cursor: "pointer",
                  border: `1px dashed ${palette.border}`,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
                }}
              >
                <span style={{
                  flex: 1,
                  fontSize: typography.fontSizeSmall,
                  color: statusMessage ? palette.textPrimary : palette.textSecondary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {statusMessage || "Set a status..."}
                </span>
                {statusMessage && (
                  <X
                    size={14}
                    color={palette.textSecondary}
                    style={{ flexShrink: 0, cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      clearStatus();
                    }}
                  />
                )}
              </div>
            )}
          </div>

          {/* ── Separator ── */}
          <div style={{
            height: 1,
            backgroundColor: palette.border,
            margin: `${spacing.unit}px ${spacing.unit * 3}px`,
          }} />

          {/* ── Presence options ── */}
          {statusOptions.map((opt) => (
            <div
              key={opt.value}
              onClick={() => {
                setManualStatus(opt.value);
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.unit * 3,
                padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                cursor: "pointer",
                backgroundColor: manualStatus === opt.value ? palette.bgActive : "transparent",
              }}
              onMouseEnter={(e) => {
                if (manualStatus !== opt.value)
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.backgroundColor =
                  manualStatus === opt.value ? palette.bgActive : "transparent";
              }}
            >
              <div style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                backgroundColor: opt.color,
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: typography.fontSizeBase,
                color: palette.textPrimary,
              }}>
                {opt.label}
              </span>
              {opt.value === "auto" && (
                <span style={{
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                  marginLeft: "auto",
                }}>
                  default
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}