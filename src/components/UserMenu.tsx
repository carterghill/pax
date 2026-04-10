import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, X, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import { useRoomMembers } from "../hooks/useRoomMembers";
import { usePresenceContext } from "../hooks/PresenceContext";
import MemberContextMenu from "./MemberContextMenu";
import UserProfileDialog from "./UserProfileDialog";

interface UserMenuProps {
  width: number;
  roomId: string;
  userId: string;
}

interface KnockMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  reason: string | null;
}

interface KnockMembersResponse {
  members: KnockMember[];
  canInvite: boolean;
  canKick: boolean;
}

const presenceColor: Record<string, string> = {
  online: "#23a55a",
  unavailable: "#f0b232",
  dnd: "#f23f43",
  offline: "#80848e",
};

export default function UserMenu({ width, roomId, userId }: UserMenuProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const {
    members,
    loading,
    listPartial,
    cachedPresenceForHeader,
    totalJoinedCount,
  } = useRoomMembers(roomId);
  /** Lets React yield so applying a huge member list does not block the main thread in one frame. */
  const deferredMembers = useDeferredValue(members);
  const { effectivePresence } = usePresenceContext();

  // ── Knock requests state ──
  const [knockData, setKnockData] = useState<KnockMembersResponse | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [memberContextMenu, setMemberContextMenu] = useState<{
    x: number;
    y: number;
    userId: string;
    displayName: string;
  } | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const activeRoomRef = useRef(roomId);
  activeRoomRef.current = roomId;

  const fetchKnocks = useCallback(() => {
    const target = roomId;
    invoke<KnockMembersResponse>("get_knock_members", { roomId: target })
      .then((result) => {
        if (activeRoomRef.current === target) setKnockData(result);
      })
      .catch((e) => {
        console.error("Failed to fetch knock members:", e);
        if (activeRoomRef.current === target) {
          setKnockData({ members: [], canInvite: false, canKick: false });
        }
      });
  }, [roomId]);

  // Reset + fetch on room change
  useEffect(() => {
    setKnockData(null);
    setMemberContextMenu(null);
    setProfileUserId(null);
    fetchKnocks();
  }, [roomId, fetchKnocks]);

  // Refetch on rooms-changed
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => {
      fetchKnocks();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [fetchKnocks]);

  const handleAccept = useCallback(async (knockUserId: string) => {
    setActionInProgress(knockUserId);
    try {
      await invoke("invite_user", { roomId, userId: knockUserId });
      setKnockData((prev) =>
        prev
          ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) }
          : prev
      );
    } catch (e) {
      console.error("Failed to accept knock:", e);
    } finally {
      setActionInProgress(null);
    }
  }, [roomId]);

  const handleDeny = useCallback(async (knockUserId: string) => {
    setActionInProgress(knockUserId);
    try {
      await invoke("kick_user", { roomId, userId: knockUserId, reason: "Join request denied" });
      setKnockData((prev) =>
        prev
          ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) }
          : prev
      );
    } catch (e) {
      console.error("Failed to deny knock:", e);
    } finally {
      setActionInProgress(null);
    }
  }, [roomId]);

  // Override the current user's presence with local intent (instant, no server round-trip)
  const displayMembers = deferredMembers.map((m) =>
    m.userId === userId ? { ...m, presence: effectivePresence } : m
  );

  /** Section header counts: use last full snapshot while list is capped so totals match room size. */
  const presenceForGroupLabels = useMemo(() => {
    if (listPartial && cachedPresenceForHeader) {
      return cachedPresenceForHeader;
    }
    const online = displayMembers.filter((m) => m.presence === "online" || m.presence === "dnd").length;
    const unavailable = displayMembers.filter((m) => m.presence === "unavailable").length;
    const offline = displayMembers.filter((m) => m.presence === "offline").length;
    return { online, unavailable, offline };
  }, [listPartial, cachedPresenceForHeader, displayMembers]);

  // Group members by presence (rows are always from the loaded slice only)
  const online = displayMembers.filter((m) => m.presence === "online" || m.presence === "dnd");
  const unavailable = displayMembers.filter((m) => m.presence === "unavailable");
  const offline = displayMembers.filter((m) => m.presence === "offline");

  const showAwaySection =
    unavailable.length > 0 ||
    (listPartial && presenceForGroupLabels.unavailable > 0);

  const groups = [
    { label: `Online — ${presenceForGroupLabels.online}`, members: online },
    ...(showAwaySection
      ? [{ label: `Away — ${presenceForGroupLabels.unavailable}`, members: unavailable }]
      : []),
    { label: `Offline — ${presenceForGroupLabels.offline}`, members: offline },
  ];

  const knockMembers = knockData?.members ?? [];
  const canInvite = knockData?.canInvite ?? false;
  const canKick = knockData?.canKick ?? false;
  const showKnocks = knockMembers.length > 0 && (canInvite || canKick);

  return (
    <>
    <div style={{
      width,
      minWidth: width,
      minHeight: 0,
      height: "100%",
      flexShrink: 0,
      backgroundColor: palette.bgSecondary,
      borderLeft: `1px solid ${palette.border}`,
      overflowY: "auto",
      padding: `${spacing.unit * 4}px 0`,
      boxSizing: "border-box",
    }}>
      {/* ── Knock Requests ── */}
      {showKnocks && (
        <div style={{ marginBottom: spacing.unit * 2 }}>
          <div style={{
            padding: `0 ${spacing.unit * 4}px ${spacing.unit * 2}px`,
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightBold,
            color: palette.textSecondary,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}>
            Requests — {knockMembers.length}
          </div>

          {knockMembers.map((knock) => {
            const isActing = actionInProgress === knock.userId;
            return (
              <div
                key={knock.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 2,
                  padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
                  margin: `0 ${spacing.unit * 2}px`,
                  borderRadius: spacing.unit,
                }}
              >
                {/* Avatar */}
                <div style={{ flexShrink: 0 }}>
                  {knock.avatarUrl ? (
                    <img
                      src={knock.avatarUrl}
                      alt={knock.displayName ?? knock.userId}
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
                      backgroundColor: userInitialAvatarBackground(knock.userId, resolvedColorScheme),
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightBold,
                    }}>
                      {(knock.displayName ?? knock.userId).charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>

                {/* Name + reason */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: typography.fontSizeBase,
                    fontWeight: typography.fontWeightMedium,
                    color: palette.textPrimary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>
                    {knock.displayName ?? knock.userId}
                  </div>
                  {knock.reason && (
                    <div style={{
                      fontSize: typography.fontSizeSmall - 1,
                      color: palette.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      marginTop: 1,
                    }}>
                      {knock.reason}
                    </div>
                  )}
                </div>

                {/* Accept / Deny buttons */}
                <div style={{ display: "flex", gap: spacing.unit, flexShrink: 0 }}>
                  {canInvite && (
                    <button
                      onClick={() => handleAccept(knock.userId)}
                      disabled={isActing}
                      title="Accept"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        border: "none",
                        backgroundColor: "#23a55a",
                        color: "#fff",
                        cursor: isActing ? "not-allowed" : "pointer",
                        opacity: isActing ? 0.5 : 1,
                        padding: 0,
                      }}
                    >
                      {isActing ? (
                        <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                      ) : (
                        <Check size={14} />
                      )}
                    </button>
                  )}
                  {canKick && (
                    <button
                      onClick={() => handleDeny(knock.userId)}
                      disabled={isActing}
                      title="Deny"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        border: "none",
                        backgroundColor: "#ed4245",
                        color: "#fff",
                        cursor: isActing ? "not-allowed" : "pointer",
                        opacity: isActing ? 0.5 : 1,
                        padding: 0,
                      }}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Divider */}
          <div style={{
            height: 1,
            backgroundColor: palette.border,
            margin: `${spacing.unit * 3}px ${spacing.unit * 4}px`,
          }} />
        </div>
      )}

      {/* ── Member list ── */}
      {loading ? (
        <div style={{
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
        }}>
          Loading members...
        </div>
      ) : (
        <>
        {listPartial && totalJoinedCount > displayMembers.length && (
          <div style={{
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
            padding: `${spacing.unit * 2}px ${spacing.unit * 4}px ${spacing.unit * 3}px`,
          }}>
            Showing {displayMembers.length} of {totalJoinedCount} members
          </div>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <div style={{
              padding: `${spacing.unit * 4}px ${spacing.unit * 4}px ${spacing.unit * 2}px`,
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              color: palette.textSecondary,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}>
              {group.label}
            </div>

            {group.members.slice().sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '')).map((member) => (
              <div
                key={member.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 3,
                  padding: `${spacing.unit * 1.5}px ${spacing.unit * 4}px`,
                  cursor: "pointer",
                  borderRadius: spacing.unit,
                  margin: `0 ${spacing.unit * 2}px`,
                  opacity: member.presence === "offline" ? 0.5 : 1,
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMemberContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    userId: member.userId,
                    displayName: member.displayName ?? member.userId,
                  });
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
                }}
              >
                <div style={{ position: "relative", flexShrink: 0 }}>
                  {member.avatarUrl ? (
                    <img
                      src={member.avatarUrl}
                      alt={member.displayName ?? member.userId}
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
                      backgroundColor: userInitialAvatarBackground(member.userId, resolvedColorScheme),
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightBold,
                    }}>
                      {(member.displayName ?? member.userId).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div style={{
                    position: "absolute",
                    bottom: -1,
                    right: -1,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: presenceColor[member.presence] ?? presenceColor.offline,
                    border: `2px solid ${palette.bgSecondary}`,
                  }} />
                </div>

                <span style={{
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightMedium,
                  color: member.presence === "offline" ? palette.textSecondary : palette.textPrimary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {member.displayName ?? member.userId}
                </span>
              </div>
            ))}
          </div>
        ))}
        </>
      )}
    </div>
    {memberContextMenu && (
      <MemberContextMenu
        x={memberContextMenu.x}
        y={memberContextMenu.y}
        displayName={memberContextMenu.displayName}
        userId={memberContextMenu.userId}
        onClose={() => setMemberContextMenu(null)}
        onProfile={() => {
          const id = memberContextMenu.userId;
          setMemberContextMenu(null);
          setProfileUserId(id);
        }}
      />
    )}
    {profileUserId && (
      <UserProfileDialog
        roomId={roomId}
        userId={profileUserId}
        currentUserId={userId}
        onClose={() => setProfileUserId(null)}
      />
    )}
    </>
  );
}