import { useState, useRef, useEffect } from "react";
import { useTheme } from "../theme/ThemeContext";
import { usePresenceContext } from "../hooks/PresenceContext";
import { ManualStatus } from "../hooks/usePresence";
import { ChevronDown } from "lucide-react";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";

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
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const { manualStatus, setManualStatus, effectivePresence } = usePresenceContext();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(popupRef, open);

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

  return (
    <div ref={dropdownRef} style={{
      padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
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
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              style={{
                display: "block",
                width: 32,
                height: 32,
                borderRadius: "50%",
                objectFit: "cover",
              }}
            />
          ) : (
            <div style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              backgroundColor: userInitialAvatarBackground(userId, resolvedColorScheme),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
            }}>
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
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
          }}>
            {getDisplayLabel(effectivePresence)}
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