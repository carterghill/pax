import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Loader2,
  ImagePlus,
  Globe,
  Lock,
  Trash2,
  DoorOpen,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

type HistoryVisibility = "shared" | "joined" | "invited" | "world_readable";
type GuestAccess = "can_join" | "forbidden";
type JoinRule = "public" | "invite" | "knock";

interface SpaceSettingsSnapshot {
  name: string;
  topic: string;
  avatarUrl: string | null;
  joinRule: string;
  historyVisibility: string;
  guestAccess: string;
  listedInDirectory: boolean;
  roomAliasLocal: string | null;
  homeserverName: string;
}

interface SpaceSettingsPermissions {
  name: boolean;
  topic: boolean;
  avatar: boolean;
  joinRules: boolean;
  historyVisibility: boolean;
  guestAccess: boolean;
  directoryListing: boolean;
  roomAlias: boolean;
}

interface SpaceSettingsData {
  snapshot: SpaceSettingsSnapshot;
  permissions: SpaceSettingsPermissions;
}

function normalizeJoinRule(rule: string): JoinRule {
  if (rule === "public" || rule === "invite" || rule === "knock") return rule;
  return "invite";
}

interface SpaceSettingsDialogProps {
  spaceId: string;
  /** Shown in header while loading or if name missing */
  titleFallback: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export default function SpaceSettingsDialog({
  spaceId,
  titleFallback,
  onClose,
  onSaved,
}: SpaceSettingsDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snap, setSnap] = useState<SpaceSettingsSnapshot | null>(null);
  const [perm, setPerm] = useState<SpaceSettingsPermissions | null>(null);

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [joinRule, setJoinRule] = useState<JoinRule>("invite");
  const [roomAlias, setRoomAlias] = useState("");
  const [historyVisibility, setHistoryVisibility] =
    useState<HistoryVisibility>("shared");
  const [guestAccess, setGuestAccess] = useState<GuestAccess>("forbidden");

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [avatarMime, setAvatarMime] = useState<string | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const rawJoinRuleRef = useRef<string>("invite");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    invoke<SpaceSettingsData>("get_space_settings", { spaceId })
      .then((data) => {
        if (cancelled) return;
        const s = data.snapshot;
        const p = data.permissions;
        setSnap(s);
        setPerm(p);
        rawJoinRuleRef.current = s.joinRule;
        setName(s.name);
        setTopic(s.topic);
        setIsPublic(s.listedInDirectory);
        setJoinRule(normalizeJoinRule(s.joinRule));
        setRoomAlias(s.roomAliasLocal ?? "");
        setHistoryVisibility(s.historyVisibility as HistoryVisibility);
        setGuestAccess(s.guestAccess as GuestAccess);
        setAvatarPreview(s.avatarUrl);
        setAvatarData(null);
        setAvatarMime(null);
        setAvatarRemoved(false);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  useEffect(() => {
    if (!isPublic && (joinRule === "public" || joinRule === "knock")) {
      setJoinRule("invite");
    }
  }, [isPublic, joinRule]);

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

  const handleAvatarPick = useCallback(() => {
    if (!perm?.avatar) return;
    fileInputRef.current?.click();
  }, [perm?.avatar]);

  const handleAvatarChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const commaIdx = result.indexOf(",");
        const mimeMatch = result.match(/^data:([^;]+);/);
        if (commaIdx >= 0 && mimeMatch) {
          setAvatarData(result.slice(commaIdx + 1));
          setAvatarMime(mimeMatch[1]);
          setAvatarPreview(result);
          setAvatarRemoved(false);
        }
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleRemoveAvatar = useCallback(() => {
    if (!perm?.avatar) return;
    setAvatarData(null);
    setAvatarMime(null);
    setAvatarPreview(null);
    setAvatarRemoved(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [perm?.avatar]);

  const canEditJoinRules = perm?.joinRules === true;

  const buildPatch = useCallback(() => {
    if (!snap || !perm) return null;
    const patch: Record<string, unknown> = {};

    if (perm.name && name.trim() !== snap.name) {
      patch.name = name.trim();
    }
    if (perm.topic && topic !== snap.topic) {
      patch.topic = topic;
    }

    if (perm.avatar) {
      if (avatarRemoved && snap.avatarUrl) {
        patch.removeAvatar = true;
      } else if (avatarData && avatarMime) {
        patch.avatarData = avatarData;
        patch.avatarMime = avatarMime;
      }
    }

    if (perm.joinRules && joinRule !== normalizeJoinRule(snap.joinRule)) {
      patch.joinRule = joinRule;
    }

    if (perm.historyVisibility && historyVisibility !== snap.historyVisibility) {
      patch.historyVisibility = historyVisibility;
    }

    if (perm.guestAccess && guestAccess !== snap.guestAccess) {
      patch.guestAccess = guestAccess;
    }

    if (perm.directoryListing && isPublic !== snap.listedInDirectory) {
      patch.listedInDirectory = isPublic;
    }

    const aliasTrim = roomAlias.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const prevAlias = (snap.roomAliasLocal ?? "").trim().toLowerCase();
    if (perm.roomAlias && aliasTrim !== prevAlias) {
      patch.roomAliasLocal = aliasTrim || null;
    }

    return Object.keys(patch).length > 0 ? patch : null;
  }, [
    snap,
    perm,
    name,
    topic,
    avatarRemoved,
    avatarData,
    avatarMime,
    joinRule,
    historyVisibility,
    guestAccess,
    isPublic,
    roomAlias,
  ]);

  const hasChanges = buildPatch() !== null;

  const handleSave = useCallback(async () => {
    const patch = buildPatch();
    if (!patch || !snap) return;

    if (
      patch.listedInDirectory === true &&
      isPublic &&
      !snap.listedInDirectory &&
      !roomAlias.trim()
    ) {
      setSaveError("Add a space address before publishing to the directory.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await invoke("apply_space_settings", { spaceId, patch });
      await onSaved();
      onClose();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [buildPatch, snap, spaceId, onSaved, onClose, isPublic, roomAlias]);

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

  const sectionStyle: React.CSSProperties = { marginBottom: 16 };

  const disabledBlock = (allowed: boolean): React.CSSProperties =>
    allowed
      ? {}
      : { opacity: 0.45, pointerEvents: "none" as const };

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    cursor: perm?.historyVisibility ? "pointer" : "not-allowed",
    WebkitAppearance: "none",
    MozAppearance: "none",
    appearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 10px center",
    paddingRight: 32,
  };

  const headerTitle = snap?.name ?? titleFallback;

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
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: 500,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
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
            Space Settings
          </h2>
          <button
            type="button"
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

        <div
          style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            padding: "4px 16px 12px 16px",
          }}
        >
          {headerTitle}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                color: palette.textSecondary,
                padding: 24,
              }}
            >
              <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
              Loading space settings…
            </div>
          )}

          {loadError && (
            <div
              style={{
                padding: "12px 16px",
                backgroundColor: "rgba(237,66,69,0.15)",
                border: "1px solid rgba(237,66,69,0.3)",
                borderRadius: 4,
                color: "#ed4245",
                fontSize: typography.fontSizeSmall,
              }}
            >
              {loadError}
            </div>
          )}

          {!loading && !loadError && snap && perm && (
            <>
              <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
                <div
                  style={{
                    flexShrink: 0,
                    position: "relative",
                    ...disabledBlock(perm.avatar),
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    style={{ display: "none" }}
                    onChange={handleAvatarChange}
                    disabled={!perm.avatar}
                  />
                  <button
                    type="button"
                    onClick={handleAvatarPick}
                    title="Upload avatar"
                    disabled={!perm.avatar}
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: 16,
                      border: `2px dashed ${palette.border}`,
                      backgroundColor: palette.bgTertiary,
                      cursor: perm.avatar ? "pointer" : "not-allowed",
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
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <ImagePlus size={28} color={palette.textSecondary} style={{ opacity: 0.6 }} />
                    )}
                  </button>
                  {avatarPreview && perm.avatar && (
                    <button
                      type="button"
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

                <div style={{ flex: 1, ...disabledBlock(perm.name) }}>
                  <label style={labelStyle}>
                    Space Name <span style={{ color: "#ed4245" }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={255}
                    style={inputStyle}
                    disabled={!perm.name}
                  />
                </div>
              </div>

              <div style={{ ...sectionStyle, ...disabledBlock(perm.topic) }}>
                <label style={labelStyle}>Description</label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  rows={3}
                  maxLength={512}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
                  disabled={!perm.topic}
                />
              </div>

              <div style={{ ...sectionStyle, ...disabledBlock(perm.directoryListing) }}>
                <label style={labelStyle}>Visibility</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <VisibilityButton
                    icon={<Lock size={16} />}
                    label="Private"
                    description="Not listed in the public directory"
                    selected={!isPublic}
                    onClick={() => setIsPublic(false)}
                    palette={palette}
                    typography={typography}
                    disabled={!perm.directoryListing}
                  />
                  <VisibilityButton
                    icon={<Globe size={16} />}
                    label="Public"
                    description="Listed in the public room directory"
                    selected={isPublic}
                    onClick={() => setIsPublic(true)}
                    palette={palette}
                    typography={typography}
                    disabled={!perm.directoryListing}
                  />
                </div>
              </div>

              <div style={{ ...sectionStyle, ...disabledBlock(canEditJoinRules) }}>
                <label style={labelStyle}>Join Rules</label>
                {!canEditJoinRules && (
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                      marginBottom: 8,
                    }}
                  >
                    Current join rule: <strong>{rawJoinRuleRef.current}</strong>
                    {!["public", "invite", "knock"].includes(rawJoinRuleRef.current)
                      ? " — cannot be edited from this dialog."
                      : " — you don’t have permission to change join rules."}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  {(
                    [
                      {
                        value: "public" as JoinRule,
                        icon: <Globe size={16} />,
                        label: "Open",
                        desc: "Anyone can join freely",
                        enabled: isPublic,
                      },
                      {
                        value: "knock" as JoinRule,
                        icon: <DoorOpen size={16} />,
                        label: "Knock",
                        desc: "Users request to join; admins approve",
                        enabled: isPublic,
                      },
                      {
                        value: "invite" as JoinRule,
                        icon: <Lock size={16} />,
                        label: "Invite Only",
                        desc: "Only invited users can join",
                        enabled: true,
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setJoinRule(opt.value);
                        if (opt.value === "public") setIsPublic(true);
                      }}
                      disabled={!canEditJoinRules || !opt.enabled}
                      style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: 3,
                        padding: 10,
                        backgroundColor:
                          joinRule === opt.value ? palette.bgActive : palette.bgTertiary,
                        border:
                          joinRule === opt.value
                            ? `2px solid ${palette.accent}`
                            : `2px solid ${palette.border}`,
                        borderRadius: 8,
                        cursor:
                          canEditJoinRules && opt.enabled ? "pointer" : "not-allowed",
                        textAlign: "left",
                        transition: "border-color 0.15s, background-color 0.15s",
                        opacity: opt.enabled ? 1 : 0.4,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          color:
                            joinRule === opt.value ? palette.accent : palette.textPrimary,
                          fontWeight: typography.fontWeightMedium,
                          fontSize: typography.fontSizeSmall,
                        }}
                      >
                        {opt.icon} {opt.label}
                      </div>
                      <div
                        style={{
                          fontSize: typography.fontSizeSmall - 2,
                          color: palette.textSecondary,
                          lineHeight: 1.3,
                        }}
                      >
                        {opt.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {isPublic && (
                <div style={{ ...sectionStyle, ...disabledBlock(perm.roomAlias) }}>
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
                      disabled={!perm.roomAlias}
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
                    :{snap.homeserverName}
                  </div>
                </div>
              )}

              <div style={sectionStyle}>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen(!advancedOpen)}
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
                      transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                      fontSize: 10,
                    }}
                  >
                    ▶
                  </span>
                  Advanced Settings
                </button>

                {advancedOpen && (
                  <div
                    style={{
                      marginTop: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 14,
                      paddingLeft: 4,
                    }}
                  >
                    <div style={disabledBlock(perm.historyVisibility)}>
                      <label style={labelStyle}>History Visibility</label>
                      <select
                        value={historyVisibility}
                        onChange={(e) =>
                          setHistoryVisibility(e.target.value as HistoryVisibility)
                        }
                        disabled={!perm.historyVisibility}
                        style={{
                          ...selectStyle,
                          cursor: perm.historyVisibility ? "pointer" : "not-allowed",
                        }}
                      >
                        <option value="shared">Members only (full history)</option>
                        <option value="joined">Members only (since they joined)</option>
                        <option value="invited">Members only (since they were invited)</option>
                        <option value="world_readable">Anyone</option>
                      </select>
                    </div>

                    <div style={disabledBlock(perm.guestAccess)}>
                      <label style={labelStyle}>Guest Access</label>
                      <select
                        value={guestAccess}
                        onChange={(e) => setGuestAccess(e.target.value as GuestAccess)}
                        disabled={!perm.guestAccess}
                        style={{
                          ...selectStyle,
                          cursor: perm.guestAccess ? "pointer" : "not-allowed",
                        }}
                      >
                        <option value="forbidden">Guests cannot join</option>
                        <option value="can_join">Guests can join</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {saveError && (
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
                  {saveError}
                </div>
              )}
            </>
          )}
        </div>

        {!loading && !loadError && snap && perm && (
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
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "8px 16px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor: "transparent",
                border: `1px solid ${palette.border}`,
                borderRadius: 4,
                color: palette.textPrimary,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.5 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !hasChanges || !name.trim()}
              style={{
                padding: "8px 20px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor:
                  saving || !hasChanges || !name.trim()
                    ? palette.accent + "80"
                    : palette.accent,
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor:
                  saving || !hasChanges || !name.trim() ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {saving ? (
                <>
                  <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function VisibilityButton({
  icon,
  label,
  description,
  selected,
  onClick,
  palette,
  typography,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: "12px",
        backgroundColor: selected ? palette.bgActive : palette.bgTertiary,
        border: selected ? `2px solid ${palette.accent}` : `2px solid ${palette.border}`,
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left",
        transition: "border-color 0.15s, background-color 0.15s",
        opacity: disabled ? 0.45 : 1,
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
