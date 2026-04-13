import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Users, Shield, Settings as SettingsIcon } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogShellBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";
import ModerationScopeDialog from "./ModerationScopeDialog";
import SettingsMemberCategory from "./SettingsMemberCategory";
import type { RoomManagementMembersResponse } from "../types/matrix";

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

type SettingsTab = "general" | "members" | "permissions";

interface RoomGeneralSnapshot {
  roomId: string;
  homeserverName: string;
  federate: boolean;
  joinRule: string;
  roomAliasLocal: string | null;
  canonicalAlias: string | null;
}

interface RoomGeneralPermissions {
  roomAlias: boolean;
}

export interface RoomSettingsDialogProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
  /** Room ids in the active space tree (for kick/ban/unban scope). */
  moderationSpaceTreeRoomIds?: string[] | null;
  /** Space display name for the scope dialog. */
  moderationSpaceName?: string | null;
  /** Root space room id for `unban_user_from_space_tree` (active space when the room is in its tree). */
  moderationSpaceRootId?: string | null;
}

export default function RoomSettingsDialog({
  roomId,
  roomName,
  onClose,
  moderationSpaceTreeRoomIds = null,
  moderationSpaceName = null,
  moderationSpaceRootId = null,
}: RoomSettingsDialogProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  const [currentVisibility, setCurrentVisibility] =
    useState<HistoryVisibility | null>(null);
  const [selectedVisibility, setSelectedVisibility] =
    useState<HistoryVisibility | null>(null);
  const [visibilityLoading, setVisibilityLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

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

  const [roomGeneralLoading, setRoomGeneralLoading] = useState(true);
  const [roomSnap, setRoomSnap] = useState<RoomGeneralSnapshot | null>(null);
  const [roomPerms, setRoomPerms] = useState<RoomGeneralPermissions | null>(null);
  const [roomAliasDraft, setRoomAliasDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    setVisibilityLoading(true);
    setRoomGeneralLoading(true);
    setSaveError(null);
    setRoomSnap(null);
    setRoomPerms(null);
    setRoomAliasDraft("");

    Promise.all([
      invoke<string>("get_history_visibility", { roomId }),
      invoke<{ snapshot: RoomGeneralSnapshot; permissions: RoomGeneralPermissions }>(
        "get_room_general_settings",
        { roomId },
      ),
    ])
      .then(([vis, general]) => {
        if (cancelled) return;
        const v = vis as HistoryVisibility;
        setCurrentVisibility(v);
        setSelectedVisibility(v);
        setVisibilityLoading(false);
        setRoomSnap(general.snapshot);
        setRoomPerms(general.permissions);
        setRoomAliasDraft(general.snapshot.roomAliasLocal ?? "");
        setRoomGeneralLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setSaveError(String(e));
          setVisibilityLoading(false);
          setRoomGeneralLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const loadManagementMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const data = await invoke<RoomManagementMembersResponse>(
        "get_room_management_members",
        { roomId },
      );
      setMemberData(data);
    } catch (e) {
      setMembersError(String(e));
    } finally {
      setMembersLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (activeTab !== "members") return;
    void loadManagementMembers();
  }, [activeTab, loadManagementMembers]);

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
    [onClose],
  );

  const adminMembers = useMemo(
    () =>
      memberData.joined.filter(
        (m) => m.role === "creator" || m.role === "administrator",
      ),
    [memberData.joined],
  );
  const moderatorMembers = useMemo(
    () => memberData.joined.filter((m) => m.role === "moderator"),
    [memberData.joined],
  );
  const regularMembers = useMemo(
    () => memberData.joined.filter((m) => m.role === "user"),
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
            moderationSpaceTreeRoomIds.length > 0 &&
            moderationSpaceRootId;
          if (useTree) {
            await invoke("unban_user_from_space_tree", {
              spaceId: moderationSpaceRootId,
              userId,
            });
          } else {
            await invoke("unban_user", { roomId, userId });
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
          : [roomId];
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
    [
      moderationDialog,
      moderationSpaceTreeRoomIds,
      moderationSpaceRootId,
      roomId,
      loadManagementMembers,
    ],
  );

  async function handleSaveGeneral() {
    if (!selectedVisibility) return;

    const aliasTrim = roomAliasDraft.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const prevAlias = (roomSnap?.roomAliasLocal ?? "").trim().toLowerCase();
    const hasAliasChange =
      !!roomPerms?.roomAlias && aliasTrim !== prevAlias && aliasTrim.length > 0;

    const hasVisibilityChange =
      selectedVisibility !== null && selectedVisibility !== currentVisibility;

    if (!hasVisibilityChange && !hasAliasChange) return;

    setSaving(true);
    setSaveError(null);
    setSuccess(false);
    try {
      if (hasVisibilityChange) {
        await invoke("set_history_visibility", {
          roomId,
          visibility: selectedVisibility,
        });
        setCurrentVisibility(selectedVisibility);
      }
      if (hasAliasChange) {
        await invoke("apply_room_general_settings", {
          roomId,
          patch: { roomAliasLocal: aliasTrim },
        });
        const refreshed = await invoke<{
          snapshot: RoomGeneralSnapshot;
          permissions: RoomGeneralPermissions;
        }>("get_room_general_settings", { roomId });
        setRoomSnap(refreshed.snapshot);
        setRoomPerms(refreshed.permissions);
        setRoomAliasDraft(refreshed.snapshot.roomAliasLocal ?? "");
      }
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (e) {
      setSaveError(String(e));
    }
    setSaving(false);
  }

  const hasVisibilityChanges =
    selectedVisibility !== null && selectedVisibility !== currentVisibility;

  const aliasTrimForSave = roomAliasDraft
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  const prevAliasForSave = (roomSnap?.roomAliasLocal ?? "").trim().toLowerCase();
  const hasAliasSave =
    !!roomPerms?.roomAlias &&
    !!roomSnap &&
    aliasTrimForSave !== prevAliasForSave &&
    aliasTrimForSave.length > 0;

  const hasGeneralChanges = hasVisibilityChanges || hasAliasSave;

  const showPublishAddress = !!roomPerms?.roomAlias && !!roomSnap;

  const headerTitle = roomName;

  const scopeDialogSpaceLabel = moderationSpaceName?.trim() || headerTitle;

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
                Room Settings
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
                    type="button"
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
                {activeTab === "general" && (
                  <div>
                    {!roomGeneralLoading && roomSnap && (
                      <div style={{ marginBottom: spacing.unit * 4 }}>
                        <h3
                          style={{
                            margin: "0 0 12px 0",
                            fontSize: typography.fontSizeBase,
                            fontWeight: typography.fontWeightBold,
                            color: palette.textHeading,
                          }}
                        >
                          Federation
                        </h3>
                        <label
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: spacing.unit * 2,
                            padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
                            borderRadius: 8,
                            border: `1px solid ${palette.border}`,
                            backgroundColor: palette.bgPrimary,
                            cursor: "not-allowed",
                            opacity: 0.85,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={roomSnap.federate}
                            disabled
                            style={{
                              accentColor: palette.accent,
                              width: 16,
                              height: 16,
                              marginTop: 2,
                              cursor: "not-allowed",
                            }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: typography.fontSizeSmall,
                                fontWeight: typography.fontWeightMedium,
                                color: palette.textHeading,
                              }}
                            >
                              Allow federation
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: palette.textSecondary,
                                marginTop: spacing.unit,
                                lineHeight: 1.4,
                              }}
                            >
                              When enabled, users on other Matrix homeservers can participate. This
                              is fixed when the room is created and cannot be changed afterward.
                            </div>
                          </div>
                        </label>
                      </div>
                    )}

                    {showPublishAddress && (
                      <div style={{ marginBottom: spacing.unit * 4 }}>
                        <h3
                          style={{
                            margin: "0 0 12px 0",
                            fontSize: typography.fontSizeBase,
                            fontWeight: typography.fontWeightBold,
                            color: palette.textHeading,
                          }}
                        >
                          Publish address
                        </h3>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            backgroundColor: palette.bgTertiary,
                            border: `1px solid ${palette.border}`,
                            borderRadius: 8,
                            overflow: "hidden",
                            opacity: roomPerms?.roomAlias ? 1 : 0.5,
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
                            value={roomAliasDraft}
                            onChange={(e) =>
                              setRoomAliasDraft(
                                e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "")
                              )
                            }
                            placeholder="room-name"
                            disabled={!roomPerms?.roomAlias}
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
                            opacity: 0.75,
                          }}
                        >
                          :{roomSnap.homeserverName}
                          {roomSnap.canonicalAlias && (
                            <span style={{ marginLeft: 8, userSelect: "all" }}>
                              Current: {roomSnap.canonicalAlias}
                            </span>
                          )}
                        </div>
                        {!roomPerms?.roomAlias && (
                          <div
                            style={{
                              fontSize: typography.fontSizeSmall - 1,
                              color: palette.textSecondary,
                              marginTop: 6,
                            }}
                          >
                            You need permission to set the canonical alias for this room.
                          </div>
                        )}
                      </div>
                    )}

                    <h3
                      style={{
                        margin: "0 0 12px 0",
                        fontSize: typography.fontSizeBase,
                        fontWeight: typography.fontWeightBold,
                        color: palette.textHeading,
                      }}
                    >
                      Who can read history?
                    </h3>

                    {visibilityLoading ? (
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
                            >
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
                                name="history_visibility_room"
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

                    <div
                      style={{
                        marginTop: spacing.unit * 3,
                        paddingTop: spacing.unit * 2,
                        borderTop: `1px solid ${palette.border}`,
                      }}
                    >
                      <div
                        style={{
                          fontSize: typography.fontSizeSmall,
                          color: palette.textSecondary,
                          fontWeight: typography.fontWeightMedium,
                        }}
                      >
                        Room ID
                      </div>
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

                    {saveError && activeTab === "general" && (
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
                        {saveError}
                      </div>
                    )}
                  </div>
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

                      <SettingsMemberCategory
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
                      <SettingsMemberCategory
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
                      <SettingsMemberCategory
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
                      <SettingsMemberCategory
                        title="Banned"
                        members={memberData.banned}
                        searchTerm={memberSearch}
                        palette={palette}
                        typography={typography}
                        spacing={spacing}
                        emptyMessage="No banned users in this room."
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
                    <Shield
                      size={48}
                      style={{ marginBottom: spacing.unit * 4, opacity: 0.5 }}
                    />
                    <div
                      style={{
                        fontSize: typography.fontSizeLarge,
                        marginBottom: spacing.unit * 2,
                      }}
                    >
                      Permissions
                    </div>
                    <div style={{ maxWidth: 400, margin: "0 auto" }}>
                      Role-based permissions and power level controls will be implemented here.
                    </div>
                  </div>
                )}
              </div>

              {activeTab === "general" && !visibilityLoading && !roomGeneralLoading && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: 8,
                    padding: "12px 20px 12px 20px",
                    borderTop: `1px solid ${palette.border}`,
                    flexShrink: 0,
                  }}
                >
                  {success && (
                    <span
                      style={{
                        marginRight: "auto",
                        color: "#23a55a",
                        fontSize: typography.fontSizeSmall,
                      }}
                    >
                      Saved
                    </span>
                  )}
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
                    onClick={() => void handleSaveGeneral()}
                    disabled={!hasGeneralChanges || saving}
                    style={{
                      padding: "8px 20px",
                      fontSize: typography.fontSizeBase,
                      fontFamily: typography.fontFamily,
                      fontWeight: typography.fontWeightMedium,
                      backgroundColor:
                        !hasGeneralChanges || saving
                          ? palette.accent + "80"
                          : palette.accent,
                      border: "none",
                      borderRadius: 4,
                      color: "#fff",
                      cursor:
                        !hasGeneralChanges || saving ? "not-allowed" : "pointer",
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
          spaceName={scopeDialogSpaceLabel}
          onSpaceScope={() => void runModeration("space")}
          onRoomOnly={() => void runModeration("room")}
          onCancel={() => !moderationBusy && setModerationDialog(null)}
          busy={moderationBusy}
        />
      )}
    </>
  );
}
