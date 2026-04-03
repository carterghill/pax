import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Plus,
  Loader2,
  ImagePlus,
  Globe,
  Lock,
  Trash2,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

type HistoryVisibility = "shared" | "joined" | "invited" | "world_readable";
type GuestAccess = "can_join" | "forbidden";

interface CreateSpaceDialogProps {
  canCreate: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateSpaceDialog({
  canCreate,
  onClose,
  onCreated,
}: CreateSpaceDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  // Tab state — if user can't create, only show join (no tabs at all)
  const [activeTab, setActiveTab] = useState<"join" | "create">(
    canCreate ? "create" : "join"
  );

  // ── Create form state ──
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [roomAlias, setRoomAlias] = useState("");
  const [federate, setFederate] = useState(true);
  const [historyVisibility, setHistoryVisibility] =
    useState<HistoryVisibility>("shared");
  const [guestAccess, setGuestAccess] = useState<GuestAccess>("forbidden");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [avatarMime, setAvatarMime] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Avatar file pick
  const handleAvatarPick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAvatarChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // result is "data:<mime>;base64,<data>"
        const commaIdx = result.indexOf(",");
        const mimeMatch = result.match(/^data:([^;]+);/);
        if (commaIdx >= 0 && mimeMatch) {
          setAvatarData(result.slice(commaIdx + 1));
          setAvatarMime(mimeMatch[1]);
          setAvatarPreview(result);
        }
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleRemoveAvatar = useCallback(() => {
    setAvatarData(null);
    setAvatarMime(null);
    setAvatarPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Create space submission
  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      setError("Space name is required.");
      return;
    }
    setCreating(true);
    setError(null);

    try {
      await invoke<string>("create_space", {
        name: name.trim(),
        topic: topic.trim() || null,
        isPublic,
        roomAlias: roomAlias.trim() || null,
        federate,
        avatarData,
        avatarMime,
        historyVisibility,
        guestAccess,
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }, [
    name,
    topic,
    isPublic,
    roomAlias,
    federate,
    avatarData,
    avatarMime,
    historyVisibility,
    guestAccess,
    onCreated,
    onClose,
  ]);

  // ── Shared styles ──
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
    padding: "8px 12px",
    fontSize: typography.fontSizeBase,
    fontFamily: typography.fontFamily,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 4,
    color: palette.textPrimary,
    outline: "none",
    boxSizing: "border-box",
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: 16,
  };

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
        zIndex: 9999,
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: 480,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 16px 0 16px",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
            }}
          >
            {canCreate ? "Add a Space" : "Join a Space"}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              display: "flex",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* ── Tabs (only if user can create) ── */}
        {canCreate && (
          <div
            style={{
              display: "flex",
              gap: 0,
              padding: "12px 16px 0 16px",
              borderBottom: `1px solid ${palette.border}`,
              flexShrink: 0,
            }}
          >
            {(["join", "create"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab);
                  setError(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom:
                    activeTab === tab
                      ? `2px solid ${palette.accent}`
                      : "2px solid transparent",
                  color:
                    activeTab === tab
                      ? palette.textPrimary
                      : palette.textSecondary,
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightMedium,
                  fontFamily: typography.fontFamily,
                  padding: "8px 16px",
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                  textTransform: "capitalize",
                }}
              >
                {tab}
              </button>
            ))}
          </div>
        )}

        {/* ── Body ── */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 16,
          }}
        >
          {activeTab === "join" && (
            <div
              style={{
                color: palette.textSecondary,
                fontSize: typography.fontSizeBase,
                textAlign: "center",
                padding: "32px 0",
              }}
            >
              Join functionality coming soon.
            </div>
          )}

          {activeTab === "create" && (
            <>
              {/* ── Avatar + Name row ── */}
              <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
                {/* Avatar picker */}
                <div style={{ flexShrink: 0, position: "relative" }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    style={{ display: "none" }}
                    onChange={handleAvatarChange}
                  />
                  <button
                    onClick={handleAvatarPick}
                    title="Upload avatar"
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: 16,
                      border: `2px dashed ${palette.border}`,
                      backgroundColor: palette.bgTertiary,
                      cursor: "pointer",
                      overflow: "hidden",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                    }}
                  >
                    {avatarPreview ? (
                      <img
                        src={avatarPreview}
                        alt="Avatar preview"
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : (
                      <ImagePlus
                        size={28}
                        color={palette.textSecondary}
                        style={{ opacity: 0.6 }}
                      />
                    )}
                  </button>
                  {avatarPreview && (
                    <button
                      onClick={handleRemoveAvatar}
                      title="Remove avatar"
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        border: "none",
                        backgroundColor: "#ed4245",
                        color: "#fff",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                {/* Name */}
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>
                    Space Name <span style={{ color: "#ed4245" }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Space"
                    maxLength={255}
                    style={inputStyle}
                    autoFocus
                  />
                </div>
              </div>

              {/* ── Topic ── */}
              <div style={sectionStyle}>
                <label style={labelStyle}>Description</label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="What is this space about?"
                  rows={3}
                  maxLength={512}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    minHeight: 60,
                  }}
                />
              </div>

              {/* ── Visibility ── */}
              <div style={sectionStyle}>
                <label style={labelStyle}>Visibility</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <VisibilityButton
                    icon={<Lock size={16} />}
                    label="Private"
                    description="Only people who are invited can find and join"
                    selected={!isPublic}
                    onClick={() => setIsPublic(false)}
                    palette={palette}
                    typography={typography}
                  />
                  <VisibilityButton
                    icon={<Globe size={16} />}
                    label="Public"
                    description="Anyone can find this space and join"
                    selected={isPublic}
                    onClick={() => setIsPublic(true)}
                    palette={palette}
                    typography={typography}
                  />
                </div>
              </div>

              {/* ── Room Alias (only for public spaces) ── */}
              {isPublic && (
                <div style={sectionStyle}>
                  <label style={labelStyle}>Space Address</label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      backgroundColor: palette.bgTertiary,
                      border: `1px solid ${palette.border}`,
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        padding: "8px 0 8px 12px",
                        color: palette.textSecondary,
                        fontSize: typography.fontSizeBase,
                        userSelect: "none",
                        flexShrink: 0,
                      }}
                    >
                      #
                    </span>
                    <input
                      type="text"
                      value={roomAlias}
                      onChange={(e) =>
                        setRoomAlias(
                          e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "")
                        )
                      }
                      placeholder="my-space"
                      style={{
                        flex: 1,
                        padding: "8px 12px 8px 4px",
                        fontSize: typography.fontSizeBase,
                        fontFamily: typography.fontFamily,
                        backgroundColor: "transparent",
                        border: "none",
                        color: palette.textPrimary,
                        outline: "none",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall - 1,
                      color: palette.textSecondary,
                      marginTop: 4,
                      opacity: 0.7,
                    }}
                  >
                    This will make the space discoverable via its address.
                  </div>
                </div>
              )}

              {/* ── Advanced options ── */}
              <AdvancedSection
                palette={palette}
                typography={typography}
                federate={federate}
                setFederate={setFederate}
                historyVisibility={historyVisibility}
                setHistoryVisibility={setHistoryVisibility}
                guestAccess={guestAccess}
                setGuestAccess={setGuestAccess}
                inputStyle={inputStyle}
                labelStyle={labelStyle}
              />

              {/* ── Error ── */}
              {error && (
                <div
                  style={{
                    padding: "8px 12px",
                    backgroundColor: "rgba(237,66,69,0.15)",
                    border: "1px solid rgba(237,66,69,0.3)",
                    borderRadius: 4,
                    color: "#ed4245",
                    fontSize: typography.fontSizeSmall,
                    marginBottom: 12,
                  }}
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        {activeTab === "create" && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 16px",
              borderTop: `1px solid ${palette.border}`,
              flexShrink: 0,
            }}
          >
            <button
              onClick={onClose}
              disabled={creating}
              style={{
                padding: "8px 16px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor: "transparent",
                border: `1px solid ${palette.border}`,
                borderRadius: 4,
                color: palette.textPrimary,
                cursor: creating ? "not-allowed" : "pointer",
                opacity: creating ? 0.5 : 1,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              style={{
                padding: "8px 20px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor:
                  creating || !name.trim() ? palette.accent + "80" : palette.accent,
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor:
                  creating || !name.trim() ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {creating ? (
                <>
                  <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                  Creating…
                </>
              ) : (
                <>
                  <Plus size={16} />
                  Create Space
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Sub-components ──

function VisibilityButton({
  icon,
  label,
  description,
  selected,
  onClick,
  palette,
  typography,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: "12px",
        backgroundColor: selected ? palette.bgActive : palette.bgTertiary,
        border: selected
          ? `2px solid ${palette.accent}`
          : `2px solid ${palette.border}`,
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color 0.15s, background-color 0.15s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: selected ? palette.accent : palette.textPrimary,
          fontWeight: typography.fontWeightMedium,
          fontSize: typography.fontSizeBase,
        }}
      >
        {icon} {label}
      </div>
      <div
        style={{
          fontSize: typography.fontSizeSmall - 1,
          color: palette.textSecondary,
          lineHeight: 1.3,
        }}
      >
        {description}
      </div>
    </button>
  );
}

function AdvancedSection({
  palette,
  typography,
  federate,
  setFederate,
  historyVisibility,
  setHistoryVisibility,
  guestAccess,
  setGuestAccess,
  inputStyle,
  labelStyle,
}: {
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
  federate: boolean;
  setFederate: (v: boolean) => void;
  historyVisibility: HistoryVisibility;
  setHistoryVisibility: (v: HistoryVisibility) => void;
  guestAccess: GuestAccess;
  setGuestAccess: (v: GuestAccess) => void;
  inputStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    cursor: "pointer",
    WebkitAppearance: "none",
    MozAppearance: "none",
    appearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    paddingRight: 32,
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: "none",
          border: "none",
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          fontFamily: typography.fontFamily,
          cursor: "pointer",
          padding: "4px 0",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        <span
          style={{
            display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
            fontSize: 10,
          }}
        >
          ▶
        </span>
        Advanced Settings
      </button>

      {expanded && (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            paddingLeft: 4,
          }}
        >
          {/* Federation */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={federate}
              onChange={(e) => setFederate(e.target.checked)}
              style={{
                accentColor: palette.accent,
                width: 16,
                height: 16,
                cursor: "pointer",
              }}
            />
            <div>
              <div
                style={{
                  fontSize: typography.fontSizeBase,
                  color: palette.textPrimary,
                  fontWeight: typography.fontWeightMedium,
                }}
              >
                Allow federation
              </div>
              <div
                style={{
                  fontSize: typography.fontSizeSmall - 1,
                  color: palette.textSecondary,
                  marginTop: 2,
                }}
              >
                Let users from other Matrix servers join this space
              </div>
            </div>
          </label>

          {/* History Visibility */}
          <div>
            <label style={labelStyle}>History Visibility</label>
            <select
              value={historyVisibility}
              onChange={(e) =>
                setHistoryVisibility(e.target.value as HistoryVisibility)
              }
              style={selectStyle}
            >
              <option value="shared">
                Members only (full history)
              </option>
              <option value="joined">
                Members only (since they joined)
              </option>
              <option value="invited">
                Members only (since they were invited)
              </option>
              <option value="world_readable">Anyone</option>
            </select>
          </div>

          {/* Guest Access */}
          <div>
            <label style={labelStyle}>Guest Access</label>
            <select
              value={guestAccess}
              onChange={(e) =>
                setGuestAccess(e.target.value as GuestAccess)
              }
              style={selectStyle}
            >
              <option value="forbidden">Guests cannot join</option>
              <option value="can_join">Guests can join</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}