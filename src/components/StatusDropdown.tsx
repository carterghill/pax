import { useState, useRef, useEffect, useCallback } from "react";
import { useTheme } from "../theme/ThemeContext";
import { usePresenceContext } from "../hooks/PresenceContext";
import { ManualStatus } from "../hooks/usePresence";
import { X, Mic, MicOff, Headphones, Slash, ChevronUp } from "lucide-react";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import UserAvatar from "./UserAvatar";
import type { AudioControls } from "../hooks/useAudioControls";
import type { AudioDeviceList } from "../hooks/useVoiceAudioDevices";
import {
  getStoredInputDeviceId,
  getStoredOutputDeviceId,
  storeInputDeviceId,
  storeOutputDeviceId,
  SYSTEM_AUDIO_DEVICE_ID,
} from "../hooks/useVoiceAudioDevices";

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
  audioControls: AudioControls;
}

type DeviceMenuKind = "input" | "output";

export default function StatusDropdown({ displayName, avatarUrl, userId, audioControls }: StatusDropdownProps) {
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

  // ── Device picker menu state ──
  const [deviceMenu, setDeviceMenu] = useState<{ kind: DeviceMenuKind; x: number; y: number } | null>(null);
  const [devices, setDevices] = useState<AudioDeviceList>({ input: [], output: [] });
  const [loadingDevices, setLoadingDevices] = useState(false);
  const deviceMenuRef = useRef<HTMLDivElement>(null);

  const openDeviceMenu = useCallback(
    async (kind: DeviceMenuKind, anchorEl: HTMLElement) => {
      const rect = anchorEl.getBoundingClientRect();
      setDeviceMenu({ kind, x: rect.left, y: rect.top });
      setLoadingDevices(true);
      try {
        setDevices(await audioControls.listAudioDevices());
      } catch {
        setDevices({ input: [], output: [] });
      } finally {
        setLoadingDevices(false);
      }
    },
    [audioControls],
  );

  useEffect(() => {
    if (!deviceMenu) return;
    function handleClick(e: MouseEvent) {
      if (deviceMenuRef.current && !deviceMenuRef.current.contains(e.target as Node)) {
        setDeviceMenu(null);
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setDeviceMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [deviceMenu]);

  const handleDeviceSelect = useCallback(
    async (kind: DeviceMenuKind, deviceId: string) => {
      if (kind === "input") storeInputDeviceId(deviceId);
      else storeOutputDeviceId(deviceId);
      setDeviceMenu(null);
      try { await audioControls.reconnectAfterDeviceChange(); } catch {}
    },
    [audioControls],
  );

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
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {/* Clickable presence area */}
        <div
          onClick={() => setOpen(!open)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 3,
            cursor: "pointer",
            padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
            borderRadius: spacing.unit,
            flex: 1,
            minWidth: 0,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
          }}
        >
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

        </div>

        {/* Audio controls — mic & headphones with device chevrons */}
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0, gap: 2, marginLeft: spacing.unit }}>
          <button
            onClick={audioControls.toggleMic}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              padding: `${spacing.unit}px`, borderRadius: spacing.unit,
              color: audioControls.isMuted ? "#ed4245" : palette.textSecondary,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgHover; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
            title={audioControls.isMuted ? "Unmute" : "Mute"}
          >
            {audioControls.isMuted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (deviceMenu?.kind === "input") setDeviceMenu(null);
              else openDeviceMenu("input", e.currentTarget);
            }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              padding: `${spacing.unit}px 2px`, borderRadius: spacing.unit,
              color: palette.textSecondary,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgHover; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
            title="Change input device"
          >
            <ChevronUp size={10} />
          </button>

          <div style={{ width: 1, height: 16, backgroundColor: palette.border, margin: `0 ${spacing.unit / 2}px` }} />

          <button
            onClick={audioControls.toggleDeafen}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              padding: `${spacing.unit}px`, borderRadius: spacing.unit,
              color: audioControls.isDeafened ? "#ed4245" : palette.textSecondary,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgHover; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
            title={audioControls.isDeafened ? "Undeafen" : "Deafen"}
          >
            <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              <Headphones size={18} />
              {audioControls.isDeafened && <Slash size={16} style={{ position: "absolute" }} />}
            </span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (deviceMenu?.kind === "output") setDeviceMenu(null);
              else openDeviceMenu("output", e.currentTarget);
            }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none", cursor: "pointer",
              padding: `${spacing.unit}px 2px`, borderRadius: spacing.unit,
              color: palette.textSecondary,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgHover; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
            title="Change output device"
          >
            <ChevronUp size={10} />
          </button>
        </div>
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

      {/* Device selection popup */}
      {deviceMenu && (
        <div
          ref={deviceMenuRef}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            position: "fixed",
            left: deviceMenu.x,
            bottom: window.innerHeight - deviceMenu.y + spacing.unit,
            minWidth: 200,
            maxWidth: 300,
            backgroundColor: palette.bgTertiary,
            borderRadius: spacing.unit * 2,
            padding: `${spacing.unit}px 0`,
            zIndex: 9999,
            boxShadow: "0 -4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <div style={{
            padding: `${spacing.unit}px ${spacing.unit * 3}px ${spacing.unit * 1.5}px`,
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightBold,
            color: palette.textSecondary,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}>
            {deviceMenu.kind === "input" ? "Input Device" : "Output Device"}
          </div>
          <div style={{
            height: 1,
            backgroundColor: palette.border,
            margin: `0 ${spacing.unit * 2}px ${spacing.unit}px`,
          }} />
          {loadingDevices ? (
            <div style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
            }}>
              Loading devices...
            </div>
          ) : (() => {
            const selectedId = deviceMenu.kind === "input" ? getStoredInputDeviceId() : getStoredOutputDeviceId();
            const menuDevices = deviceMenu.kind === "input" ? devices.input : devices.output;
            return (
              <>
                <DeviceMenuItem
                  label="System Default"
                  isSelected={selectedId === SYSTEM_AUDIO_DEVICE_ID}
                  onClick={() => handleDeviceSelect(deviceMenu.kind, SYSTEM_AUDIO_DEVICE_ID)}
                />
                {menuDevices.map((device) => (
                  <DeviceMenuItem
                    key={device.id}
                    label={device.isDefault ? `${device.name} (current default)` : device.name}
                    isSelected={selectedId === device.id}
                    onClick={() => handleDeviceSelect(deviceMenu.kind, device.id)}
                  />
                ))}
                {menuDevices.length === 0 && (
                  <div style={{
                    padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                    fontSize: typography.fontSizeSmall,
                    color: palette.textSecondary,
                  }}>
                    No devices found
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function DeviceMenuItem({
  label,
  isSelected,
  onClick,
}: {
  label: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { palette, spacing, typography } = useTheme();
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 2,
        padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
        cursor: "pointer",
        fontSize: typography.fontSizeSmall,
        color: isSelected ? palette.textPrimary : palette.textSecondary,
        backgroundColor: isSelected ? palette.bgActive : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = isSelected ? palette.bgActive : "transparent";
      }}
    >
      {isSelected && (
        <div style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: palette.accent,
          flexShrink: 0,
        }} />
      )}
      <span style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        marginLeft: isSelected ? 0 : spacing.unit * 2 + 6,
      }}>
        {label}
      </span>
    </div>
  );
}