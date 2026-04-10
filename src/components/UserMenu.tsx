import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, X, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import { useRoomMembers } from "../hooks/useRoomMembers";
import { RoomMember } from "../types/matrix";
import { usePresenceContext } from "../hooks/PresenceContext";
import MemberContextMenu from "./MemberContextMenu";
import UserProfileDialog from "./UserProfileDialog";

interface UserMenuProps {
  width: number;
  roomId: string;
  userId: string;
  /** After resolving or creating a 1:1 DM, switch the main view to that room. */
  onOpenDirectMessage: (roomId: string) => void | Promise<void>;
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

// ── Row heights (spacing.unit = 4) ──
const MEMBER_HEIGHT = 44;
const HEADER_HEIGHT = 38;
const OVERSCAN = 8;

type VRow =
  | { type: "header"; key: string; label: string }
  | { type: "member"; key: string; member: RoomMember };

interface MemberRowProps {
  member: RoomMember;
  avatarUrl: string | null;
  onContextMenu: (e: React.MouseEvent, userId: string, displayName: string) => void;
}

const MemberRow = memo(function MemberRow({ member, avatarUrl, onContextMenu }: MemberRowProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
        padding: `${spacing.unit * 1.5}px ${spacing.unit * 4}px`,
        cursor: "pointer",
        borderRadius: spacing.unit,
        margin: `0 ${spacing.unit * 2}px`,
        opacity: member.presence === "offline" ? 0.5 : 1,
        height: MEMBER_HEIGHT,
        boxSizing: "border-box",
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, member.userId, member.displayName ?? member.userId);
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={member.displayName ?? member.userId}
            style={{ display: "block", width: 32, height: 32, borderRadius: "50%", objectFit: "cover" }}
          />
        ) : (
          <div style={{
            width: 32, height: 32, borderRadius: "50%",
            backgroundColor: userInitialAvatarBackground(member.userId, resolvedColorScheme),
            color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: typography.fontSizeSmall, fontWeight: typography.fontWeightBold,
          }}>
            {(member.displayName ?? member.userId).charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{
          position: "absolute", bottom: -1, right: -1, width: 10, height: 10,
          borderRadius: "50%",
          backgroundColor: presenceColor[member.presence] ?? presenceColor.offline,
          border: `2px solid ${palette.bgSecondary}`,
        }} />
      </div>

      <span style={{
        fontSize: typography.fontSizeBase, fontWeight: typography.fontWeightMedium,
        color: member.presence === "offline" ? palette.textSecondary : palette.textPrimary,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {member.displayName ?? member.userId}
      </span>
    </div>
  );
});

// ── Compute visible window from scroll position ──
function computeWindow(
  rows: VRow[],
  offsets: Float64Array,
  scrollTop: number,
  viewHeight: number,
): [number, number] {
  if (rows.length === 0) return [0, -1];
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const rowBottom = offsets[mid] + (rows[mid].type === "header" ? HEADER_HEIGHT : MEMBER_HEIGHT);
    if (rowBottom <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - OVERSCAN);
  const bottomEdge = scrollTop + viewHeight;
  let end = lo;
  while (end < rows.length && offsets[end] < bottomEdge) end++;
  end = Math.min(rows.length - 1, end + OVERSCAN);
  return [start, end];
}

export default function UserMenu({ width, roomId, userId, onOpenDirectMessage }: UserMenuProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const { members, loading, avatarOverrides } = useRoomMembers(roomId);
  const { effectivePresence } = usePresenceContext();

  // ── Knock requests state ──
  const [knockData, setKnockData] = useState<KnockMembersResponse | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [memberContextMenu, setMemberContextMenu] = useState<{
    x: number; y: number; userId: string; displayName: string;
  } | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [dmOpening, setDmOpening] = useState(false);
  const activeRoomRef = useRef(roomId);
  activeRoomRef.current = roomId;

  // ── Virtualization: scroll position lives in refs, not state ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const viewHeightRef = useRef(600);
  // React state only for the visible window boundaries — updates only when they change
  const [visibleWindow, setVisibleWindow] = useState<[number, number]>([0, -1]);
  // Refs to current rows/offsets for the scroll handler (avoids stale closure)
  const rowsRef = useRef<VRow[]>([]);
  const offsetsRef = useRef<Float64Array>(new Float64Array(0));
  const scrollRaf = useRef<number | null>(null);

  const syncVisibleWindow = useCallback(() => {
    const [s, e] = computeWindow(
      rowsRef.current, offsetsRef.current, scrollTopRef.current, viewHeightRef.current,
    );
    setVisibleWindow((prev) => (prev[0] === s && prev[1] === e ? prev : [s, e]));
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    if (scrollRaf.current == null) {
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        syncVisibleWindow();
      });
    }
  }, [syncVisibleWindow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewHeightRef.current = entry.contentRect.height;
        syncVisibleWindow();
      }
    });
    ro.observe(el);
    viewHeightRef.current = el.clientHeight;
    return () => ro.disconnect();
  }, [syncVisibleWindow]);

  // Cleanup RAF
  useEffect(() => {
    return () => { if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current); };
  }, []);

  const fetchKnocks = useCallback(() => {
    const target = roomId;
    invoke<KnockMembersResponse>("get_knock_members", { roomId: target })
      .then((result) => {
        if (activeRoomRef.current === target) setKnockData(result);
      })
      .catch((e) => {
        console.error("Failed to fetch knock members:", e);
        if (activeRoomRef.current === target)
          setKnockData({ members: [], canInvite: false, canKick: false });
      });
  }, [roomId]);

  useEffect(() => {
    setKnockData(null);
    setMemberContextMenu(null);
    setProfileUserId(null);
    setDmOpening(false);
    fetchKnocks();
  }, [roomId, fetchKnocks]);

  useEffect(() => {
    const unlisten = listen("rooms-changed", () => { fetchKnocks(); });
    return () => { unlisten.then((fn) => fn()); };
  }, [fetchKnocks]);

  const handleAccept = useCallback(async (knockUserId: string) => {
    setActionInProgress(knockUserId);
    try {
      await invoke("invite_user", { roomId, userId: knockUserId });
      setKnockData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) } : prev
      );
    } catch (e) { console.error("Failed to accept knock:", e); }
    finally { setActionInProgress(null); }
  }, [roomId]);

  const handleDeny = useCallback(async (knockUserId: string) => {
    setActionInProgress(knockUserId);
    try {
      await invoke("kick_user", { roomId, userId: knockUserId, reason: "Join request denied" });
      setKnockData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) } : prev
      );
    } catch (e) { console.error("Failed to deny knock:", e); }
    finally { setActionInProgress(null); }
  }, [roomId]);

  const handleMemberContextMenu = useCallback(
    (e: React.MouseEvent, uid: string, displayName: string) => {
      setMemberContextMenu({ x: e.clientX, y: e.clientY, userId: uid, displayName });
    }, []
  );

  const handleOpenDirectMessage = useCallback(async () => {
    if (!memberContextMenu) return;
    const peerId = memberContextMenu.userId;
    setDmOpening(true);
    try {
      const rid = await invoke<string>("open_direct_message", { peerUserId: peerId });
      setMemberContextMenu(null);
      await onOpenDirectMessage(rid);
    } catch (e) {
      console.error("Failed to open direct message:", e);
    } finally {
      setDmOpening(false);
    }
  }, [memberContextMenu, onOpenDirectMessage]);

  // Override current user's presence locally
  const displayMembers = useMemo(
    () => members.map((m) => (m.userId === userId ? { ...m, presence: effectivePresence } : m)),
    [members, userId, effectivePresence]
  );

  // ── Build flat virtual row list with offsets ──
  const { rows, offsets, totalHeight } = useMemo(() => {
    const online = displayMembers.filter((m) => m.presence === "online" || m.presence === "dnd");
    const unavailable = displayMembers.filter((m) => m.presence === "unavailable");
    const offline = displayMembers.filter((m) => m.presence === "offline");

    const groups = [
      { label: `Online — ${online.length}`, members: online },
      ...(unavailable.length > 0
        ? [{ label: `Away — ${unavailable.length}`, members: unavailable }]
        : []),
      { label: `Offline — ${offline.length}`, members: offline },
    ];

    const r: VRow[] = [];
    for (const g of groups) {
      r.push({ type: "header", key: `h:${g.label}`, label: g.label });
      for (const m of g.members) r.push({ type: "member", key: m.userId, member: m });
    }

    const o = new Float64Array(r.length);
    let h = 0;
    for (let i = 0; i < r.length; i++) {
      o[i] = h;
      h += r[i].type === "header" ? HEADER_HEIGHT : MEMBER_HEIGHT;
    }

    // Update refs for the scroll handler
    rowsRef.current = r;
    offsetsRef.current = o;

    return { rows: r, offsets: o, totalHeight: h };
  }, [displayMembers]);

  // Recompute visible window when rows change
  useEffect(() => {
    syncVisibleWindow();
  }, [rows, syncVisibleWindow]);

  const [startIdx, endIdx] = visibleWindow;

  const knockMembers = knockData?.members ?? [];
  const canInvite = knockData?.canInvite ?? false;
  const canKick = knockData?.canKick ?? false;
  const showKnocks = knockMembers.length > 0 && (canInvite || canKick);

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          width, minWidth: width, minHeight: 0, height: "100%", flexShrink: 0,
          backgroundColor: palette.bgSecondary, borderLeft: `1px solid ${palette.border}`,
          overflowY: "auto", boxSizing: "border-box",
        }}
      >
        {/* ── Knock Requests (not virtualized — always small) ── */}
        {showKnocks && (
          <div style={{ marginBottom: spacing.unit * 2, paddingTop: spacing.unit * 4 }}>
            <div style={{
              padding: `0 ${spacing.unit * 4}px ${spacing.unit * 2}px`,
              fontSize: typography.fontSizeSmall, fontWeight: typography.fontWeightBold,
              color: palette.textSecondary, textTransform: "uppercase", letterSpacing: 0.5,
            }}>
              Requests — {knockMembers.length}
            </div>
            {knockMembers.map((knock) => {
              const isActing = actionInProgress === knock.userId;
              return (
                <div key={knock.userId} style={{
                  display: "flex", alignItems: "center", gap: spacing.unit * 2,
                  padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
                  margin: `0 ${spacing.unit * 2}px`, borderRadius: spacing.unit,
                }}>
                  <div style={{ flexShrink: 0 }}>
                    {knock.avatarUrl ? (
                      <img src={knock.avatarUrl} alt={knock.displayName ?? knock.userId}
                        style={{ display: "block", width: 32, height: 32, borderRadius: "50%", objectFit: "cover" }} />
                    ) : (
                      <div style={{
                        width: 32, height: 32, borderRadius: "50%",
                        backgroundColor: userInitialAvatarBackground(knock.userId, resolvedColorScheme),
                        color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: typography.fontSizeSmall, fontWeight: typography.fontWeightBold,
                      }}>
                        {(knock.displayName ?? knock.userId).charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: typography.fontSizeBase, fontWeight: typography.fontWeightMedium,
                      color: palette.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {knock.displayName ?? knock.userId}
                    </div>
                    {knock.reason && (
                      <div style={{
                        fontSize: typography.fontSizeSmall - 1, color: palette.textSecondary,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1,
                      }}>
                        {knock.reason}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: spacing.unit, flexShrink: 0 }}>
                    {canInvite && (
                      <button onClick={() => handleAccept(knock.userId)} disabled={isActing} title="Accept"
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          width: 28, height: 28, borderRadius: "50%", border: "none",
                          backgroundColor: "#23a55a", color: "#fff",
                          cursor: isActing ? "not-allowed" : "pointer", opacity: isActing ? 0.5 : 1, padding: 0,
                        }}>
                        {isActing ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}
                      </button>
                    )}
                    {canKick && (
                      <button onClick={() => handleDeny(knock.userId)} disabled={isActing} title="Deny"
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          width: 28, height: 28, borderRadius: "50%", border: "none",
                          backgroundColor: "#ed4245", color: "#fff",
                          cursor: isActing ? "not-allowed" : "pointer", opacity: isActing ? 0.5 : 1, padding: 0,
                        }}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div style={{ height: 1, backgroundColor: palette.border, margin: `${spacing.unit * 3}px ${spacing.unit * 4}px` }} />
          </div>
        )}

        {/* ── Member list (virtualized) ── */}
        {loading ? (
          <div style={{
            color: palette.textSecondary, fontSize: typography.fontSizeSmall,
            padding: `${spacing.unit * 6}px ${spacing.unit * 4}px`,
          }}>
            Loading members...
          </div>
        ) : (
          <div style={{ height: totalHeight, position: "relative" }}>
            {endIdx >= startIdx && rows.slice(startIdx, endIdx + 1).map((row, i) => {
              const idx = startIdx + i;
              const top = offsets[idx];

              if (row.type === "header") {
                return (
                  <div key={row.key} style={{
                    position: "absolute", top, left: 0, right: 0, height: HEADER_HEIGHT,
                    padding: `${spacing.unit * 4}px ${spacing.unit * 4}px ${spacing.unit * 2}px`,
                    fontSize: typography.fontSizeSmall, fontWeight: typography.fontWeightBold,
                    color: palette.textSecondary, textTransform: "uppercase", letterSpacing: 0.5,
                    boxSizing: "border-box",
                  }}>
                    {row.label}
                  </div>
                );
              }

              const resolvedAvatar = avatarOverrides.get(row.member.userId) ?? row.member.avatarUrl;

              return (
                <div key={row.key} style={{ position: "absolute", top, left: 0, right: 0, height: MEMBER_HEIGHT }}>
                  <MemberRow member={row.member} avatarUrl={resolvedAvatar} onContextMenu={handleMemberContextMenu} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {memberContextMenu && (
        <MemberContextMenu
          x={memberContextMenu.x} y={memberContextMenu.y}
          displayName={memberContextMenu.displayName} userId={memberContextMenu.userId}
          onClose={() => setMemberContextMenu(null)}
          onProfile={() => {
            const id = memberContextMenu.userId;
            setMemberContextMenu(null);
            setProfileUserId(id);
          }}
          onSendMessage={
            memberContextMenu.userId.trim().toLowerCase() !== userId.trim().toLowerCase()
              ? handleOpenDirectMessage
              : undefined
          }
          sendMessageBusy={dmOpening}
        />
      )}
      {profileUserId && (
        <UserProfileDialog
          roomId={roomId} userId={profileUserId}
          currentUserId={userId} onClose={() => setProfileUserId(null)}
        />
      )}
    </>
  );
}