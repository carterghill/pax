import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Loader2,
  ImagePlus,
  Globe,
  Lock,
  Trash2,
  DoorOpen,
  Users,
  Shield,
  Settings as SettingsIcon,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogShellBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";
import ModerationScopeDialog from "./ModerationScopeDialog";
import type {
  RoomManagementMember,
  RoomManagementMembersResponse,
} from "../types/matrix";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import type { ThemePalette, ThemeTypography, ThemeSpacing } from "../theme/types";

type HistoryVisibility = "shared" | "joined" | "invited" | "world_readable";
type GuestAccess = "can_join" | "forbidden";
type JoinRule = "public" | "invite" | "knock";

interface SpaceSettingsSnapshot {
  roomId: string;
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

type SettingsTab = "general" | "members" | "permissions";

interface SpaceSettingsDialogProps {
  spaceId: string;
  /** Shown in header while loading or if name missing */
  titleFallback: string;
  /** Space room plus every room in the tree (for kick/ban scope); from client room list. */
  moderationSpaceTreeRoomIds?: string[] | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export default function SpaceSettingsDialog({
  spaceId,
  titleFallback,
  moderationSpaceTreeRoomIds = null,
  onClose,
  onSaved,
}: SpaceSettingsDialogProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snap, setSnap] = useState<SpaceSettingsSnapshot | null>(null);
  const [perm, setPerm] = useState<SpaceSettingsPermissions | null>(null);

  // General tab state
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

  // Members tab state
  const [memberSearch, setMemberSearch] = useState("");
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberData, setMemberData] = useState<RoomManagementMembersResponse>({
    joined: [],
    banned: [],
  });
  const [unbanBusyId, setUnbanBusyId] = useState<string | null>(null);
  const [moderationDialog, setModerationDialog] = useState<{
    kind: "kick" | "ban" | "unban";
    userId: string;
    displayName: string;
  } | null>(null);
  const [moderationBusy, setModerationBusy] = useState(false);

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

  const loadManagementMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const data = await invoke<RoomManagementMembersResponse>(
        "get_room_management_members",
        { roomId: spaceId },
      );
      setMemberData(data);
    } catch (e) {
      setMembersError(String(e));
    } finally {
      setMembersLoading(false);
    }
  }, [spaceId]);

  useEffect(() => {
    if (activeTab !== "members") return;
    void loadManagementMembers();
  }, [activeTab, loadManagementMembers]);

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
  const adminMembers = useMemo(
    () =>
      memberData.joined.filter(
        (member) =>
          member.role === "creator" || member.role === "administrator",
      ),
    [memberData.joined],
  );
  const moderatorMembers = useMemo(
    () => memberData.joined.filter((member) => member.role === "moderator"),
    [memberData.joined],
  );
  const regularMembers = useMemo(
    () => memberData.joined.filter((member) => member.role === "user"),
    [memberData.joined],
  );

  const openUnbanDialog = useCallback(
    (userId: string) => {
      const m = memberData.banned.find((x) => x.userId === userId);
      setModerationDialog({
        kind: "unban",
        userId,
        displayName: m?.displayName ?? userId,
      });
    },
    [memberData.banned],
  );

  const openKickDialog = useCallback(
    (userId: string) => {
      const m = memberData.joined.find((x) => x.userId === userId);
      setModerationDialog({
        kind: "kick",
        userId,
        displayName: m?.displayName ?? userId,
      });
    },
    [memberData.joined],
  );

  const openBanDialog = useCallback(
    (userId: string) => {
      const m = memberData.joined.find((x) => x.userId === userId);
      setModerationDialog({
        kind: "ban",
        userId,
        displayName: m?.displayName ?? userId,
      });
    },
    [memberData.joined],
  );

  const runModeration = useCallback(
    async (scope: "space" | "room") => {
      if (!moderationDialog) return;
      const { kind, userId } = moderationDialog;

      if (kind === "unban") {
        setModerationBusy(true);
        setUnbanBusyId(userId);
        setMembersError(null);
        try {
          const useTree =
            scope === "space" &&
            moderationSpaceTreeRoomIds &&
            moderationSpaceTreeRoomIds.length > 0;
          if (useTree) {
            await invoke("unban_user_from_space_tree", { spaceId, userId });
          } else {
            await invoke("unban_user", { roomId: spaceId, userId });
          }
          await loadManagementMembers();
        } catch (e) {
          setMembersError(String(e));
        } finally {
          setModerationBusy(false);
          setUnbanBusyId(null);
          setModerationDialog(null);
        }
        return;
      }

      const roomIds =
        scope === "space" && moderationSpaceTreeRoomIds && moderationSpaceTreeRoomIds.length > 0
          ? moderationSpaceTreeRoomIds
          : [spaceId];
      setModerationBusy(true);
      try {
        for (const rid of roomIds) {
          try {
            if (kind === "kick") {
              await invoke("kick_user", { roomId: rid, userId, reason: null });
            } else {
              await invoke("ban_user", { roomId: rid, userId, reason: null });
            }
          } catch (e) {
            console.error(`Moderation failed for room ${rid}:`, e);
          }
        }
        await loadManagementMembers();
      } finally {
        setModerationBusy(false);
        setModerationDialog(null);
      }
    },
    [moderationDialog, moderationSpaceTreeRoomIds, spaceId, loadManagementMembers],
  );

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
    <>
    <ModalLayer
      onBackdropClick={handleBackdropClick}
      backdropStyle={{
        backgroundColor: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: "min(720px, calc(100vw - 40px))",
          maxHeight: "min(90vh, 920px)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          ...paletteDialogShellBorderStyle(palette),
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "16px 20px 14px 20px",
            flexShrink: 0,
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
              {headerTitle}
            </h2>
          </div>
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

        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Left sidebar - Categories */}
          <div
            style={{
              width: 220,
              flexShrink: 0,
              backgroundColor: palette.bgSecondary,
              borderRight: `1px solid ${palette.border}`,
              padding: `${spacing.unit * 4}px`,
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit * 1,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                color: palette.textSecondary,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                marginBottom: spacing.unit * 2,
                paddingLeft: spacing.unit * 1,
              }}
            >
              Space Settings
            </div>

            {[
              { id: "general" as SettingsTab, label: "General", icon: SettingsIcon },
              { id: "members" as SettingsTab, label: "Members", icon: Users },
              { id: "permissions" as SettingsTab, label: "Permissions", icon: Shield },
            ].map((cat) => {
              const Icon = cat.icon;
              const isActive = activeTab === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveTab(cat.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.unit * 2.5,
                    padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
                    borderRadius: 8,
                    border: `1px solid ${isActive ? palette.accent : "transparent"}`,
                    backgroundColor: isActive ? palette.bgActive : "transparent",
                    color: isActive ? palette.textHeading : palette.textSecondary,
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: typography.fontSizeBase,
                    fontWeight: isActive
                      ? typography.fontWeightMedium
                      : typography.fontWeightNormal,
                  }}
                >
                  <Icon size={18} />
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* Main content area */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              minWidth: 0,
            }}
          >
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                overflowX: "hidden",
                padding: "16px 20px 20px 20px",
                minWidth: 0,
              }}
            >
              {loading && activeTab === "general" && (
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

              {!loading && !loadError && snap && perm && activeTab === "general" && (
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

                    <div>
                      <label style={labelStyle}>Room ID</label>
                      <div
                        style={{
                          fontSize: typography.fontSizeSmall - 1,
                          color: palette.textSecondary,
                          userSelect: "all",
                          wordBreak: "break-all",
                          cursor: "pointer",
                          opacity: 0.7,
                        }}
                        title="Click to copy"
                        onClick={() => {
                          navigator.clipboard.writeText(snap.roomId);
                        }}
                      >
                        {snap.roomId}
                      </div>
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

              {activeTab === "members" && (
                <div>
                  <div style={{ marginBottom: spacing.unit * 4 }}>
                    <div
                      style={{
                        position: "relative",
                        marginBottom: spacing.unit * 3,
                      }}
                    >
                      <input
                        type="text"
                        value={memberSearch}
                        onChange={(e) => setMemberSearch(e.target.value)}
                        placeholder="Search members..."
                        style={{
                          width: "100%",
                          padding: `${spacing.unit * 2.5}px ${spacing.unit * 4}px`,
                          fontSize: typography.fontSizeBase,
                          backgroundColor: palette.bgTertiary,
                          border: `1px solid ${palette.border}`,
                          borderRadius: 12,
                          color: palette.textPrimary,
                          outline: "none",
                        }}
                      />
                    </div>

                    {/* Admin */}
                    <MemberCategory
                      title="Admins"
                      members={adminMembers}
                      searchTerm={memberSearch}
                      palette={palette}
                      typography={typography}
                      spacing={spacing}
                      emptyMessage="No admins found."
                      alwaysShow
                      onKick={openKickDialog}
                      onBan={openBanDialog}
                      resolvedColorScheme={resolvedColorScheme}
                    />

                    {/* Moderator */}
                    <MemberCategory
                      title="Moderators"
                      members={moderatorMembers}
                      searchTerm={memberSearch}
                      palette={palette}
                      typography={typography}
                      spacing={spacing}
                      emptyMessage="No moderators found."
                      alwaysShow
                      onKick={openKickDialog}
                      onBan={openBanDialog}
                      resolvedColorScheme={resolvedColorScheme}
                    />

                    {/* Member */}
                    <MemberCategory
                      title="Members"
                      members={regularMembers}
                      searchTerm={memberSearch}
                      palette={palette}
                      typography={typography}
                      spacing={spacing}
                      emptyMessage="No regular members found."
                      alwaysShow
                      onKick={openKickDialog}
                      onBan={openBanDialog}
                      resolvedColorScheme={resolvedColorScheme}
                    />

                    {/* Banned */}
                    <MemberCategory
                      title="Banned"
                      members={memberData.banned}
                      searchTerm={memberSearch}
                      palette={palette}
                      typography={typography}
                      spacing={spacing}
                      emptyMessage="No banned users in this space."
                      alwaysShow
                      onPrimaryAction={openUnbanDialog}
                      primaryActionLabel="Unban"
                      actionBusyUserId={unbanBusyId}
                      resolvedColorScheme={resolvedColorScheme}
                    />
                  </div>

                  {membersLoading && (
                    <div
                      style={{
                        color: palette.textSecondary,
                        textAlign: "center",
                        padding: 20,
                      }}
                    >
                      Loading members...
                    </div>
                  )}
                  {membersError && (
                    <div
                      style={{
                        marginTop: spacing.unit * 3,
                        padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                        borderRadius: 8,
                        border: "1px solid rgba(237,66,69,0.35)",
                        backgroundColor: "rgba(237,66,69,0.12)",
                        color: "#ed4245",
                        fontSize: typography.fontSizeSmall,
                      }}
                    >
                      {membersError}
                    </div>
                  )}
                </div>
              )}

              {activeTab === "permissions" && (
                <div
                  style={{
                    padding: spacing.unit * 6,
                    textAlign: "center",
                    color: palette.textSecondary,
                  }}
                >
                  <Shield size={48} style={{ marginBottom: spacing.unit * 4, opacity: 0.5 }} />
                  <div style={{ fontSize: typography.fontSizeLarge, marginBottom: spacing.unit * 2 }}>
                    Permissions
                  </div>
                  <div style={{ maxWidth: 400, margin: "0 auto" }}>
                    Role-based permissions and power level controls will be implemented here.
                  </div>
                </div>
              )}
            </div>

        {/* Footer - only for general tab for now */}
        {activeTab === "general" && !loading && !loadError && snap && perm && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 20px 12px 20px",
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
                marginRight: spacing.unit,
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
          </div>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </ModalLayer>
    {moderationDialog && (
      <ModerationScopeDialog
        kind={moderationDialog.kind}
        targetDisplayName={moderationDialog.displayName}
        currentRoomName={headerTitle}
        showSpaceScope={!!moderationSpaceTreeRoomIds?.length}
        spaceName={headerTitle}
        onSpaceScope={() => void runModeration("space")}
        onRoomOnly={() => void runModeration("room")}
        onCancel={() => !moderationBusy && setModerationDialog(null)}
        busy={moderationBusy}
      />
    )}
    </>
  );
}

function MemberCategory({
  title,
  members,
  searchTerm,
  palette,
  typography,
  spacing,
  emptyMessage,
  alwaysShow = false,
  onKick,
  onBan,
  onPrimaryAction,
  primaryActionLabel,
  onSecondaryAction,
  secondaryActionLabel,
  actionBusyUserId,
  resolvedColorScheme,
}: {
  title: string;
  members: RoomManagementMember[];
  searchTerm: string;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  emptyMessage?: string;
  alwaysShow?: boolean;
  onKick?: (userId: string) => void;
  onBan?: (userId: string) => void;
  onPrimaryAction?: (userId: string) => void;
  primaryActionLabel?: string;
  onSecondaryAction?: (userId: string) => void;
  secondaryActionLabel?: string;
  actionBusyUserId?: string | null;
  resolvedColorScheme: "light" | "dark";
}) {
  const q = searchTerm.trim().toLowerCase();
  const filtered = members.filter((m) => {
    if (!q) return true;
    const label = (m.displayName ?? m.userId).toLowerCase();
    return label.includes(q);
  });

  if (!alwaysShow && filtered.length === 0) return null;

  return (
    <div style={{ marginBottom: spacing.unit * 4 }}>
      <div
        style={{
          fontSize: typography.fontSizeSmall,
          fontWeight: typography.fontWeightBold,
          color: palette.textSecondary,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: spacing.unit * 2,
        }}
      >
        {title} — {filtered.length}
      </div>
      {filtered.length === 0 ? (
        <div
          style={{
            padding: `${spacing.unit * 3}px ${spacing.unit * 3}px`,
            borderRadius: 8,
            border: `1px solid ${palette.border}`,
            backgroundColor: palette.bgTertiary,
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
          }}
        >
          {emptyMessage ?? `No ${title.toLowerCase()} found.`}
        </div>
      ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: spacing.unit * 1.5 }}>
        {filtered.map((member) => {
          const displayName = member.displayName ?? member.userId;
          const isBusy = actionBusyUserId === member.userId;
          return (
            <div
              key={member.userId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.unit * 3,
                padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                backgroundColor: palette.bgTertiary,
                borderRadius: 8,
                border: `1px solid ${palette.border}`,
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              <div style={{ flexShrink: 0 }}>
                {member.avatarUrl ? (
                  <img
                    src={member.avatarUrl}
                    alt=""
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      backgroundColor: userInitialAvatarBackground(
                        member.userId,
                        resolvedColorScheme,
                      ),
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightBold,
                    }}
                  >
                    {(displayName || "?").charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <div
                  title={displayName}
                  style={{
                    fontWeight: typography.fontWeightMedium,
                    color: palette.textPrimary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {displayName}
                </div>
                <div
                  title={member.userId}
                  style={{
                    fontSize: typography.fontSizeSmall - 1,
                    color: palette.textSecondary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {member.userId}
                </div>
              </div>
              {(onKick || onBan) && (member.canKick || member.canBan) && (
                <div
                  style={{
                    display: "flex",
                    gap: spacing.unit * 1.5,
                    flexShrink: 0,
                    flexWrap: "wrap",
                    justifyContent: "flex-end",
                  }}
                >
                  {onKick && member.canKick && (
                    <button
                      type="button"
                      onClick={() => onKick(member.userId)}
                      style={{
                        padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
                        backgroundColor: palette.bgTertiary,
                        color: palette.textPrimary,
                        border: `1px solid ${palette.border}`,
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: typography.fontSizeSmall,
                        fontWeight: typography.fontWeightMedium,
                      }}
                    >
                      Kick
                    </button>
                  )}
                  {onBan && member.canBan && (
                    <button
                      type="button"
                      onClick={() => onBan(member.userId)}
                      style={{
                        padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
                        backgroundColor: "rgba(237,66,69,0.15)",
                        color: "#ed4245",
                        border: "1px solid rgba(237,66,69,0.35)",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: typography.fontSizeSmall,
                        fontWeight: typography.fontWeightMedium,
                      }}
                    >
                      Ban
                    </button>
                  )}
                </div>
              )}
              {(onPrimaryAction || onSecondaryAction) && (
                <div
                  style={{
                    display: "flex",
                    gap: spacing.unit * 1.5,
                    flexShrink: 0,
                  }}
                >
                  {onSecondaryAction && secondaryActionLabel && (
                    <button
                      type="button"
                      onClick={() => onSecondaryAction(member.userId)}
                      disabled={isBusy}
                      style={{
                        padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
                        backgroundColor: palette.bgActive,
                        color: palette.textPrimary,
                        border: `1px solid ${palette.border}`,
                        borderRadius: 6,
                        cursor: isBusy ? "not-allowed" : "pointer",
                        opacity: isBusy ? 0.6 : 1,
                        fontSize: typography.fontSizeSmall,
                        fontWeight: typography.fontWeightMedium,
                      }}
                    >
                      {secondaryActionLabel}
                    </button>
                  )}
                  {onPrimaryAction && primaryActionLabel && (
                    <button
                      type="button"
                      onClick={() => onPrimaryAction(member.userId)}
                      disabled={isBusy}
                      style={{
                        padding: `${spacing.unit}px ${spacing.unit * 3}px`,
                        backgroundColor: "#23a55a",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        cursor: isBusy ? "not-allowed" : "pointer",
                        opacity: isBusy ? 0.6 : 1,
                        fontSize: typography.fontSizeSmall,
                        fontWeight: typography.fontWeightMedium,
                      }}
                    >
                      {isBusy ? "Working..." : primaryActionLabel}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
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