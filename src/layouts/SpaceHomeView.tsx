import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Hash,
  MessageCircle,
  Volume2,
  Users,
  LogIn,
  Check,
  Mail,
  RefreshCw,
  Plus,
  X,
  Loader2,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  ArrowLeft,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import { dmPresenceDotColor, effectiveDmTitle } from "../utils/dmDisplay";
import { resolvePresenceWithDnd } from "../utils/statusMessage";
import { VOICE_ROOM_TYPE, SPACE_ROOM_TYPE, compareByDisplayThenKey } from "../utils/matrix";
import {
  spaceInitialAvatarBackground,
  userInitialAvatarBackground,
} from "../utils/userAvatarColor";
import CreateRoomDialog from "../components/CreateRoomDialog";
import CreateSpaceDialog from "../components/CreateSpaceDialog";
import LinkExistingToSpaceDialog from "../components/LinkExistingToSpaceDialog";
import { useResolvedDmPeerAvatarUrl } from "../context/PeerAvatarContext";
import type { SpaceChildInfo, SpaceInfo } from "../utils/spaceHomeCache";
import { getCachedSpaceInfo, setCachedSpaceInfo } from "../utils/spaceHomeCache";
import { avatarSrc } from "../utils/avatarSrc";

function isChildMatrixSpace(c: SpaceChildInfo): boolean {
  return c.roomType === SPACE_ROOM_TYPE;
}

function roomToSpaceChildInfo(r: Room, fromHierarchy?: SpaceChildInfo): SpaceChildInfo {
  return {
    id: r.id,
    name: r.name,
    topic: r.topic ?? null,
    avatarUrl: r.avatarUrl,
    membership: r.membership,
    joinRule: fromHierarchy?.joinRule ?? null,
    roomType: r.roomType,
    numJoinedMembers: fromHierarchy?.numJoinedMembers ?? 0,
    isDirect: r.isDirect ?? false,
    dmPeerUserId: r.dmPeerUserId ?? null,
    dmPeerPresence: r.dmPeerPresence ?? null,
    dmPeerStatusMsg: r.dmPeerStatusMsg ?? null,
  };
}

/** Merge hierarchy children of a sub-space with rooms from sync (invited/joined). */
function mergeSubSpaceChannels(
  syncRooms: Room[],
  hierarchyChildren: SpaceChildInfo[] | undefined
): SpaceChildInfo[] {
  const byId = new Map<string, SpaceChildInfo>();
  for (const c of hierarchyChildren ?? []) {
    if (isChildMatrixSpace(c)) continue;
    byId.set(c.id, c);
  }
  for (const r of syncRooms) {
    if (r.isSpace) continue;
    const fromH = byId.get(r.id);
    byId.set(r.id, roomToSpaceChildInfo(r, fromH));
  }
  return [...byId.values()].sort((a, b) =>
    compareByDisplayThenKey(a.name, a.id, b.name, b.id)
  );
}

interface SpaceHomeViewProps {
  space: Room;
  onSelectRoom: (roomId: string) => void;
  /** Switch the main layout to a child space (sidebar / home for that space). */
  onSelectChildSpace?: (spaceId: string) => void;
  /** Joined channels for a child space id (from sync / get_rooms). */
  getRoomsInChildSpace: (spaceId: string) => Room[];
  onRoomsChanged: (payload?: RoomsChangedPayload) => void | Promise<void>;
  /** Joined rooms with no parent space — can be linked into this space. */
  orphanRooms: Room[];
  /** Joined top-level spaces (excluding this one) — can be linked as sub-spaces. */
  orphanSpaces: Room[];
  /** When this space is nested under a joined parent, show back navigation at the top. */
  parentSpace?: { id: string; name: string } | null;
  onNavigateToParentSpace?: () => void;
}

function mergeCreatedChildIntoSpaceInfo(
  prev: SpaceInfo,
  room: Room,
  topic: string | null
): SpaceInfo {
  const child: SpaceChildInfo = {
    id: room.id,
    name: room.name,
    topic,
    avatarUrl: room.avatarUrl,
    membership: "joined",
    joinRule: null,
    roomType: room.roomType,
    numJoinedMembers: 1,
  };
  const others = prev.children.filter((c) => c.id !== child.id);
  return { ...prev, children: [child, ...others] };
}

function mergeJoinedChildIntoSpaceInfo(prev: SpaceInfo, roomId: string): SpaceInfo {
  return {
    ...prev,
    children: prev.children.map((c) =>
      c.id === roomId ? { ...c, membership: "joined" as const } : c
    ),
  };
}

type FetchSpaceInfoOptions = {
  /** If true, keep showing existing UI and refresh in the background (no full-page loading state). */
  background?: boolean;
};

interface KnockMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  reason: string | null;
}

interface KnockData {
  members: KnockMember[];
  canInvite: boolean;
  canKick: boolean;
}

interface PresencePayload {
  userId: string;
  presence: string;
  statusMsg: string | null;
}

export default function SpaceHomeView({
  space,
  onSelectRoom,
  onSelectChildSpace,
  getRoomsInChildSpace,
  onRoomsChanged,
  orphanRooms,
  orphanSpaces,
  parentSpace = null,
  onNavigateToParentSpace,
}: SpaceHomeViewProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const [info, setInfo] = useState<SpaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  /** Always matches the latest `space.id` so in-flight fetches for an old space are ignored. */
  const activeSpaceIdRef = useRef(space.id);
  activeSpaceIdRef.current = space.id;

  const [canManageChildren, setCanManageChildren] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showCreateSubSpace, setShowCreateSubSpace] = useState(false);
  const [showLinkExistingRoom, setShowLinkExistingRoom] = useState(false);
  const [showLinkExistingSpace, setShowLinkExistingSpace] = useState(false);
  const [addRoomMenuOpen, setAddRoomMenuOpen] = useState(false);
  const [addSpaceMenuOpen, setAddSpaceMenuOpen] = useState(false);
  const [roomsListCollapsed, setRoomsListCollapsed] = useState(false);
  const addRoomMenuRef = useRef<HTMLDivElement>(null);
  const addSpaceMenuRef = useRef<HTMLDivElement>(null);
  /** Sub-space id → expanded in space home (absent = expanded). */
  const [subSpaceExpandedHome, setSubSpaceExpandedHome] = useState<Record<string, boolean>>({});
  /** Per–sub-space hierarchy from `get_space_info(sub.id)` (joinable rooms not in sync). */
  const [subSpaceHierarchyChildren, setSubSpaceHierarchyChildren] = useState<
    Record<string, SpaceChildInfo[]>
  >({});
  const isHomeSubExpanded = (id: string) => subSpaceExpandedHome[id] !== false;
  const toggleHomeSub = useCallback((id: string) => {
    setSubSpaceExpandedHome((prev) => {
      const cur = prev[id] !== false;
      return { ...prev, [id]: !cur };
    });
  }, []);
  const permCheckedRef = useRef<string | null>(null);

  // ── Knock requests ──
  const [knockData, setKnockData] = useState<KnockData | null>(null);
  const [knockActionId, setKnockActionId] = useState<string | null>(null);

  const fetchInfo = useCallback((options?: FetchSpaceInfoOptions) => {
    const requestedId = space.id;
    const background = options?.background ?? false;

    if (!background) {
      setLoading(true);
      setError(null);
    }

    invoke<SpaceInfo>("get_space_info", { spaceId: requestedId })
      .then((data) => {
        setCachedSpaceInfo(requestedId, data);
        if (activeSpaceIdRef.current !== requestedId) return;
        setInfo(data);
        if (!background) setError(null);
      })
      .catch((e) => {
        if (activeSpaceIdRef.current !== requestedId) return;
        if (background) {
          console.error("Background space home refresh failed:", e);
          return;
        }
        console.error("Failed to fetch space info:", e);
        setError(String(e));
      })
      .finally(() => {
        if (activeSpaceIdRef.current !== requestedId) return;
        if (!background) setLoading(false);
      });
  }, [space.id]);

  // Live-update DM presence dots on the space home list (sync pushes `presence` events).
  useEffect(() => {
    const unlisten = listen<PresencePayload>("presence", (event) => {
      const { userId, presence, statusMsg } = event.payload;
      setInfo((prev) => {
        if (!prev) return prev;
        let changed = false;
        const children = prev.children.map((c) => {
          if (c.dmPeerUserId === userId && (c.dmPeerPresence !== presence || c.dmPeerStatusMsg !== statusMsg)) {
            changed = true;
            return { ...c, dmPeerPresence: presence, dmPeerStatusMsg: statusMsg };
          }
          return c;
        });
        if (!changed) return prev;
        const next = { ...prev, children };
        if (activeSpaceIdRef.current === space.id) {
          setCachedSpaceInfo(space.id, next);
        }
        return next;
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [space.id]);

  useEffect(() => {
    setSubSpaceExpandedHome({});
    setSubSpaceHierarchyChildren({});
  }, [space.id]);

  useEffect(() => {
    if (!info) {
      setSubSpaceHierarchyChildren({});
      return;
    }
    const subs = info.children
      .filter((c) => c.membership === "joined" && isChildMatrixSpace(c))
      .sort((a, b) => compareByDisplayThenKey(a.name, a.id, b.name, b.id));
    if (subs.length === 0) {
      setSubSpaceHierarchyChildren({});
      return;
    }
    let cancelled = false;
    (async () => {
      const map: Record<string, SpaceChildInfo[]> = {};
      await Promise.all(
        subs.map(async (sub) => {
          try {
            const si = await invoke<SpaceInfo>("get_space_info", { spaceId: sub.id });
            if (!cancelled) map[sub.id] = si.children;
          } catch {
            if (!cancelled) map[sub.id] = [];
          }
        })
      );
      if (!cancelled) setSubSpaceHierarchyChildren(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [info, space.id]);

  useEffect(() => {
    setJoiningRoomId(null);
    setShowCreateRoom(false);
    setShowCreateSubSpace(false);
    setShowLinkExistingRoom(false);
    setShowLinkExistingSpace(false);
    setAddRoomMenuOpen(false);
    setAddSpaceMenuOpen(false);
    setRoomsListCollapsed(false);

    const cached = getCachedSpaceInfo(space.id);
    if (cached) {
      setInfo(cached);
      setError(null);
      setLoading(false);
      fetchInfo({ background: true });
    } else {
      setInfo(null);
      setError(null);
      setLoading(true);
      fetchInfo();
    }
  }, [space.id, fetchInfo]);

  // Check whether the user can add rooms to this space
  useEffect(() => {
    if (permCheckedRef.current === space.id) return;
    permCheckedRef.current = space.id;
    invoke<boolean>("can_manage_space_children", { spaceId: space.id })
      .then(setCanManageChildren)
      .catch(() => setCanManageChildren(false));
  }, [space.id]);

  // ── Fetch knock requests for this space ──
  const fetchKnocks = useCallback(() => {
    const target = space.id;
    invoke<KnockData>("get_knock_members", { roomId: target })
      .then((result) => {
        if (activeSpaceIdRef.current === target) setKnockData(result);
      })
      .catch(() => {
        if (activeSpaceIdRef.current === target) {
          setKnockData({ members: [], canInvite: false, canKick: false });
        }
      });
  }, [space.id]);

  useEffect(() => {
    setKnockData(null);
    fetchKnocks();
  }, [space.id, fetchKnocks]);

  // Refetch knocks on membership changes
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => { fetchKnocks(); });
    return () => { unlisten.then((fn) => fn()); };
  }, [fetchKnocks]);

  useEffect(() => {
    if (!addRoomMenuOpen && !addSpaceMenuOpen) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addRoomMenuRef.current?.contains(t)) return;
      if (addSpaceMenuRef.current?.contains(t)) return;
      setAddRoomMenuOpen(false);
      setAddSpaceMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [addRoomMenuOpen, addSpaceMenuOpen]);

  const handleAcceptKnock = useCallback(async (knockUserId: string) => {
    setKnockActionId(knockUserId);
    try {
      await invoke("invite_user", { roomId: space.id, userId: knockUserId });
      setKnockData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) } : prev
      );
    } catch (e) {
      console.error("Failed to accept knock:", e);
    } finally {
      setKnockActionId(null);
    }
  }, [space.id]);

  const handleDenyKnock = useCallback(async (knockUserId: string) => {
    setKnockActionId(knockUserId);
    try {
      await invoke("kick_user", { roomId: space.id, userId: knockUserId, reason: "Join request denied" });
      setKnockData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) } : prev
      );
    } catch (e) {
      console.error("Failed to deny knock:", e);
    } finally {
      setKnockActionId(null);
    }
  }, [space.id]);

  // When `get_rooms` includes `topic` (after sync / space settings), merge into space home state.
  // Skip if `topic` is absent on `Room` so we don't clear data from `get_space_info`.
  useEffect(() => {
    if (space.topic === undefined) return;
    const t = (space.topic ?? "").trim() || null;
    setInfo((prev) => {
      if (!prev) return prev;
      const prevT = prev.topic?.trim() || null;
      if (prevT === t) return prev;
      const next = { ...prev, topic: t };
      setCachedSpaceInfo(space.id, next);
      return next;
    });
  }, [space.id, space.topic]);

  const joinedSubspaces = useMemo(() => {
    if (!info) return [];
    return info.children
      .filter((c) => c.membership === "joined" && isChildMatrixSpace(c))
      .sort((a, b) => compareByDisplayThenKey(a.name, a.id, b.name, b.id));
  }, [info]);

  const mergedSubChannelsBySubId = useMemo(() => {
    const result: Record<string, SpaceChildInfo[]> = {};
    for (const sub of joinedSubspaces) {
      const sync = getRoomsInChildSpace(sub.id);
      result[sub.id] = mergeSubSpaceChannels(sync, subSpaceHierarchyChildren[sub.id]);
    }
    return result;
  }, [joinedSubspaces, getRoomsInChildSpace, subSpaceHierarchyChildren]);

  const roomIdsListedUnderSubspaces = useMemo(() => {
    const s = new Set<string>();
    for (const sub of joinedSubspaces) {
      for (const c of mergedSubChannelsBySubId[sub.id] ?? []) {
        if (!isChildMatrixSpace(c)) s.add(c.id);
      }
    }
    return s;
  }, [joinedSubspaces, mergedSubChannelsBySubId]);

  const joinedRoomsDirectFiltered = useMemo(() => {
    if (!info) return [];
    const joinedChildren = info.children.filter((c) => c.membership === "joined");
    const joinedRoomsDirect = joinedChildren.filter((c) => !isChildMatrixSpace(c));
    return joinedRoomsDirect.filter((c) => !roomIdsListedUnderSubspaces.has(c.id));
  }, [info, roomIdsListedUnderSubspaces]);

  const directMessageRoomsHome = useMemo(
    () => joinedRoomsDirectFiltered.filter((c) => c.isDirect),
    [joinedRoomsDirectFiltered],
  );
  const nonDirectChannelsHome = useMemo(
    () => joinedRoomsDirectFiltered.filter((c) => !c.isDirect),
    [joinedRoomsDirectFiltered],
  );

  const totalChannelCount = useMemo(() => {
    let n = joinedRoomsDirectFiltered.length;
    for (const sub of joinedSubspaces) {
      for (const c of mergedSubChannelsBySubId[sub.id] ?? []) {
        if (!isChildMatrixSpace(c)) n += 1;
      }
    }
    return n;
  }, [joinedSubspaces, mergedSubChannelsBySubId, joinedRoomsDirectFiltered]);

  const invitedRoomsFiltered = useMemo(() => {
    if (!info) return [];
    return info.children.filter(
      (c) => c.membership === "invited" && !roomIdsListedUnderSubspaces.has(c.id)
    );
  }, [info, roomIdsListedUnderSubspaces]);

  const availableRoomsFiltered = useMemo(() => {
    if (!info) return [];
    return info.children.filter(
      (c) => c.membership === "none" && !roomIdsListedUnderSubspaces.has(c.id)
    );
  }, [info, roomIdsListedUnderSubspaces]);

  const spaceDescription = useMemo(() => {
    const t = (info?.topic ?? "").trim();
    return t || null;
  }, [info?.topic]);

  const handleJoinRoom = useCallback(
    async (roomId: string, optimisticParentSpaceId?: string) => {
      setJoiningRoomId(roomId);
      const parentForOptimistic = optimisticParentSpaceId ?? space.id;
      const childMeta =
        info?.children.find((c) => c.id === roomId) ??
        (() => {
          for (const sub of joinedSubspaces) {
            const found = (mergedSubChannelsBySubId[sub.id] ?? []).find((c) => c.id === roomId);
            if (found) return found;
          }
          return undefined;
        })();
      try {
        await invoke("join_room", { roomId });
        const optimisticRoom: Room = {
          id: roomId,
          name: childMeta?.name ?? roomId,
          avatarUrl: childMeta?.avatarUrl ?? null,
          isSpace: false,
          parentSpaceIds: [parentForOptimistic],
          roomType: childMeta?.roomType ?? null,
          membership: "joined",
          isDirect: false,
        };
        await onRoomsChanged({ optimisticRoom });
        setInfo((prev) => {
          if (!prev) return prev;
          const next = mergeJoinedChildIntoSpaceInfo(prev, roomId);
          setCachedSpaceInfo(space.id, next);
          return next;
        });
        if (optimisticParentSpaceId && optimisticParentSpaceId !== space.id) {
          try {
            const si = await invoke<SpaceInfo>("get_space_info", { spaceId: optimisticParentSpaceId });
            setSubSpaceHierarchyChildren((prev) => ({
              ...prev,
              [optimisticParentSpaceId]: si.children,
            }));
          } catch {
            /* ignore */
          }
        }
        fetchInfo({ background: true });
      } catch (e) {
        console.error("Failed to join room:", e);
      }
      setJoiningRoomId(null);
    },
    [info, space.id, joinedSubspaces, mergedSubChannelsBySubId, onRoomsChanged, fetchInfo]
  );

  const initials = space.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  if (loading && !info) {
    return (
      <div style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: palette.textSecondary,
      }}>
        Loading space info...
      </div>
    );
  }

  if (error && !info) {
    return (
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.unit * 3,
      }}>
        <span style={{ color: "#f38ba8", fontSize: typography.fontSizeSmall }}>
          {error}
        </span>
        <button
          onClick={() => fetchInfo()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
            borderRadius: spacing.unit * 1.5,
            border: "none",
            backgroundColor: palette.accent,
            color: "#fff",
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightBold,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} />
          Retry
        </button>
      </div>
    );
  }

  if (!info) return null;

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative",
    }}>
      {parentSpace && onNavigateToParentSpace ? (
        <button
          type="button"
          onClick={onNavigateToParentSpace}
          title={`Back to ${parentSpace.name}`}
          aria-label={`Back to ${parentSpace.name}`}
          style={{
            position: "absolute",
            top: spacing.unit * 6,
            right: spacing.unit * 6,
            zIndex: 2,
            display: "inline-flex",
            alignItems: "center",
            gap: spacing.unit * 1.5,
            margin: 0,
            padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
            border: "none",
            borderRadius: spacing.unit * 1.5,
            backgroundColor: palette.bgSecondary,
            color: palette.textSecondary,
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            fontFamily: typography.fontFamily,
            cursor: "pointer",
            maxWidth: "min(50vw, 280px)",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
              palette.bgActive;
            (e.currentTarget as HTMLButtonElement).style.color =
              palette.textPrimary;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
              palette.bgSecondary;
            (e.currentTarget as HTMLButtonElement).style.color =
              palette.textSecondary;
          }}
        >
          <ArrowLeft size={18} strokeWidth={2} aria-hidden style={{ flexShrink: 0 }} />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {parentSpace.name}
          </span>
        </button>
      ) : null}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: spacing.unit * 6,
        minHeight: 0,
      }}>
        {/* Space hero */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: spacing.unit * 3,
          marginBottom: spacing.unit * 8,
          paddingTop: spacing.unit * 4,
        }}>
          {info.avatarUrl ? (
            <img
              src={avatarSrc(info.avatarUrl)}
              alt={info.name}
              style={{
                width: 72,
                height: 72,
                borderRadius: 20,
                objectFit: "cover",
              }}
            />
          ) : (
            <div style={{
              width: 72,
              height: 72,
              borderRadius: 20,
              backgroundColor: spaceInitialAvatarBackground(space.id, resolvedColorScheme),
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              fontWeight: typography.fontWeightBold,
            }}>
              {initials}
            </div>
          )}
          <div style={{
            fontSize: typography.fontSizeLarge + 4,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            textAlign: "center",
          }}>
            {info.name}
          </div>
          {spaceDescription ? (
            <div style={{
              fontSize: typography.fontSizeBase,
              color: palette.textSecondary,
              textAlign: "center",
              maxWidth: 500,
              lineHeight: typography.lineHeight,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>
              {spaceDescription}
            </div>
          ) : null}
        </div>

        {/* Channels header + Add Room / Add Space (aligned with listing, Cinny-style) */}
        {canManageChildren && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: spacing.unit * 2,
              flexWrap: "wrap",
              marginBottom: spacing.unit * 3,
            }}
          >
            <button
              type="button"
              onClick={() => setRoomsListCollapsed((c) => !c)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: spacing.unit * 1.5,
                padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                margin: 0,
                border: "none",
                borderRadius: spacing.unit * 1.5,
                backgroundColor: "transparent",
                color: palette.textHeading,
                fontSize: typography.fontSizeBase,
                fontWeight: typography.fontWeightBold,
                fontFamily: typography.fontFamily,
                cursor: "pointer",
              }}
            >
              <span>Channels</span>
              <span style={{ color: palette.textSecondary, fontWeight: typography.fontWeightMedium }}>
                · {totalChannelCount}
              </span>
              {roomsListCollapsed ? (
                <ChevronRight size={18} strokeWidth={2} aria-hidden />
              ) : (
                <ChevronDown size={18} strokeWidth={2} aria-hidden />
              )}
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
              <div ref={addRoomMenuRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => {
                    setAddSpaceMenuOpen(false);
                    setAddRoomMenuOpen((o) => !o);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 12px",
                    borderRadius: 9999,
                    border: "none",
                    backgroundColor: palette.accent,
                    color: "#fff",
                    fontSize: typography.fontSizeSmall,
                    fontWeight: typography.fontWeightMedium,
                    fontFamily: typography.fontFamily,
                    cursor: "pointer",
                  }}
                >
                  <Plus size={14} strokeWidth={2.5} aria-hidden />
                  Add Room
                </button>
                {addRoomMenuOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      right: 0,
                      marginTop: 6,
                      minWidth: 220,
                      padding: spacing.unit,
                      borderRadius: 8,
                      backgroundColor: palette.bgTertiary,
                      border: `1px solid ${palette.border}`,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                      zIndex: 50,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAddRoomMenuOpen(false);
                        setShowCreateRoom(true);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                        border: "none",
                        borderRadius: 6,
                        backgroundColor: "transparent",
                        color: palette.textPrimary,
                        fontSize: typography.fontSizeSmall,
                        fontFamily: typography.fontFamily,
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = palette.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      Create new room
                    </button>
                    <button
                      type="button"
                      title={orphanRooms.length === 0 ? "No rooms without a parent space" : undefined}
                      disabled={orphanRooms.length === 0}
                      onClick={() => {
                        if (orphanRooms.length === 0) return;
                        setAddRoomMenuOpen(false);
                        setShowLinkExistingRoom(true);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                        border: "none",
                        borderRadius: 6,
                        backgroundColor: "transparent",
                        color: orphanRooms.length === 0 ? palette.textSecondary : palette.textPrimary,
                        fontSize: typography.fontSizeSmall,
                        fontFamily: typography.fontFamily,
                        cursor: orphanRooms.length === 0 ? "default" : "pointer",
                        opacity: orphanRooms.length === 0 ? 0.55 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (orphanRooms.length === 0) return;
                        e.currentTarget.style.backgroundColor = palette.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      Add existing room
                    </button>
                  </div>
                )}
              </div>
              <div ref={addSpaceMenuRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => {
                    setAddRoomMenuOpen(false);
                    setAddSpaceMenuOpen((o) => !o);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 12px",
                    borderRadius: 9999,
                    border: `1px solid ${palette.border}`,
                    backgroundColor: palette.bgTertiary,
                    color: palette.textPrimary,
                    fontSize: typography.fontSizeSmall,
                    fontWeight: typography.fontWeightMedium,
                    fontFamily: typography.fontFamily,
                    cursor: "pointer",
                  }}
                >
                  <Plus size={14} strokeWidth={2.5} aria-hidden />
                  Add Space
                </button>
                {addSpaceMenuOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      right: 0,
                      marginTop: 6,
                      minWidth: 220,
                      padding: spacing.unit,
                      borderRadius: 8,
                      backgroundColor: palette.bgTertiary,
                      border: `1px solid ${palette.border}`,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                      zIndex: 50,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAddSpaceMenuOpen(false);
                        setShowCreateSubSpace(true);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                        border: "none",
                        borderRadius: 6,
                        backgroundColor: "transparent",
                        color: palette.textPrimary,
                        fontSize: typography.fontSizeSmall,
                        fontFamily: typography.fontFamily,
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = palette.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      Create new space
                    </button>
                    <button
                      type="button"
                      title={orphanSpaces.length === 0 ? "No other top-level spaces to add" : undefined}
                      disabled={orphanSpaces.length === 0}
                      onClick={() => {
                        if (orphanSpaces.length === 0) return;
                        setAddSpaceMenuOpen(false);
                        setShowLinkExistingSpace(true);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                        border: "none",
                        borderRadius: 6,
                        backgroundColor: "transparent",
                        color: orphanSpaces.length === 0 ? palette.textSecondary : palette.textPrimary,
                        fontSize: typography.fontSizeSmall,
                        fontFamily: typography.fontFamily,
                        cursor: orphanSpaces.length === 0 ? "default" : "pointer",
                        opacity: orphanSpaces.length === 0 ? 0.55 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (orphanSpaces.length === 0) return;
                        e.currentTarget.style.backgroundColor = palette.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      Add existing space
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Channels: sub-space groups + direct (merged with per–sub-space hierarchy for join + counts) */}
        {(joinedSubspaces.length > 0 || joinedRoomsDirectFiltered.length > 0) &&
          (!canManageChildren || !roomsListCollapsed) && (
          <div style={{ marginBottom: spacing.unit * 6 }}>
            {joinedSubspaces.map((sub) => {
              const channels = mergedSubChannelsBySubId[sub.id] ?? [];
              const expanded = isHomeSubExpanded(sub.id);
              const ChevronIcon = expanded ? ChevronDown : ChevronRight;
              const nonSpaceCount = channels.filter((c) => !isChildMatrixSpace(c)).length;
              return (
                <div key={sub.id} style={{ marginBottom: spacing.unit * 4 }}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => toggleHomeSub(sub.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleHomeSub(sub.id);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: spacing.unit * 2,
                      marginBottom: spacing.unit * 2,
                      padding: `${spacing.unit * 2}px ${spacing.unit * 2}px`,
                      borderRadius: spacing.unit * 1.5,
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <ChevronIcon size={18} strokeWidth={2} style={{ flexShrink: 0, color: palette.textSecondary }} aria-hidden />
                    {sub.avatarUrl ? (
                      <img
                        src={avatarSrc(sub.avatarUrl)}
                        alt=""
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          objectFit: "cover",
                          flexShrink: 0,
                        }}
                      />
                    ) : null}
                    <span style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightBold,
                      color: palette.textHeading,
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.02em",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {sub.name}
                      {nonSpaceCount > 0 ? (
                        <span style={{ color: palette.textSecondary, fontWeight: typography.fontWeightNormal }}>
                          {" "}— {nonSpaceCount}
                        </span>
                      ) : null}
                    </span>
                    {onSelectChildSpace ? (
                      <button
                        type="button"
                        title="Open sub-space home"
                        aria-label={`Open ${sub.name} home`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectChildSpace(sub.id);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 32,
                          height: 32,
                          padding: 0,
                          border: "none",
                          borderRadius: spacing.unit * 1.5,
                          backgroundColor: "transparent",
                          color: palette.textSecondary,
                          cursor: "pointer",
                        }}
                      >
                        <ExternalLink size={16} strokeWidth={2} aria-hidden />
                      </button>
                    ) : null}
                  </div>
                  {expanded && (channels.filter((c) => !isChildMatrixSpace(c)).length > 0 ? (
                    <div style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: spacing.unit,
                      paddingLeft: spacing.unit * 2,
                    }}>
                      {channels.filter((c) => !isChildMatrixSpace(c)).map((room) => (
                        <RoomRow
                          key={room.id}
                          room={room}
                          isJoining={joiningRoomId === room.id}
                          onClick={() => {
                            if (room.membership === "joined") {
                              onSelectRoom(room.id);
                            }
                          }}
                          onJoin={() => handleJoinRoom(room.id, sub.id)}
                          palette={palette}
                          typography={typography}
                          spacing={spacing}
                        />
                      ))}
                    </div>
                  ) : (
                    <div style={{
                      color: palette.textSecondary,
                      fontSize: typography.fontSizeSmall,
                      paddingLeft: spacing.unit * 2,
                    }}>
                      No channels in this sub-space yet
                    </div>
                  ))}
                </div>
              );
            })}
            {directMessageRoomsHome.length > 0 && (
              <RoomSection
                title="Direct messages"
                rooms={directMessageRoomsHome}
                onClickRoom={onSelectRoom}
                joiningRoomId={joiningRoomId}
                onJoinRoom={handleJoinRoom}
                palette={palette}
                typography={typography}
                spacing={spacing}
              />
            )}
            {nonDirectChannelsHome.length > 0 && (
              <RoomSection
                title={joinedSubspaces.length > 0 ? "Other channels" : "Channels"}
                showHeader={!(joinedSubspaces.length === 0 && canManageChildren)}
                rooms={nonDirectChannelsHome}
                onClickRoom={onSelectRoom}
                joiningRoomId={joiningRoomId}
                onJoinRoom={handleJoinRoom}
                palette={palette}
                typography={typography}
                spacing={spacing}
              />
            )}
          </div>
        )}

        {invitedRoomsFiltered.length > 0 && (
          <RoomSection
            title="Pending Invitations"
            rooms={invitedRoomsFiltered}
            onClickRoom={onSelectRoom}
            joiningRoomId={joiningRoomId}
            onJoinRoom={handleJoinRoom}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        )}

        {availableRoomsFiltered.length > 0 && (
          <RoomSection
            title="Available Rooms"
            rooms={availableRoomsFiltered}
            onClickRoom={onSelectRoom}
            joiningRoomId={joiningRoomId}
            onJoinRoom={handleJoinRoom}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        )}

        {/* ── Join Requests ── */}
        {knockData && knockData.members.length > 0 && (knockData.canInvite || knockData.canKick) && (
          <div style={{ marginBottom: spacing.unit * 6 }}>
            <div style={{
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              color: palette.textSecondary,
              textTransform: "uppercase" as const,
              letterSpacing: "0.02em",
              padding: `${spacing.unit * 2}px ${spacing.unit * 2}px`,
              marginBottom: spacing.unit,
            }}>
              Join Requests — {knockData.members.length}
            </div>
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit,
            }}>
              {knockData.members.map((knock) => {
                const isActing = knockActionId === knock.userId;
                return (
                  <KnockRow
                    key={knock.userId}
                    knock={knock}
                    isActing={isActing}
                    canInvite={knockData.canInvite}
                    canKick={knockData.canKick}
                    onAccept={() => handleAcceptKnock(knock.userId)}
                    onDeny={() => handleDenyKnock(knock.userId)}
                    palette={palette}
                    typography={typography}
                    spacing={spacing}
                    resolvedColorScheme={resolvedColorScheme}
                  />
                );
              })}
            </div>
          </div>
        )}

        {info.children.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            textAlign: "center",
            padding: spacing.unit * 6,
          }}>
            {canManageChildren
              ? "No rooms in this space yet. Use Add Room or Add Space above to create or link one."
              : "No rooms in this space yet"}
          </div>
        )}
      </div>

      {/* Create room dialog */}
      {showCreateRoom && (
        <CreateRoomDialog
          spaceId={space.id}
          onClose={() => setShowCreateRoom(false)}
          onCreated={async (payload) => {
            await onRoomsChanged(payload);
            if (payload?.optimisticRoom) {
              setInfo((prev) => {
                if (!prev) return prev;
                const next = mergeCreatedChildIntoSpaceInfo(
                  prev,
                  payload.optimisticRoom!,
                  payload.newSpaceChildTopic ?? null
                );
                setCachedSpaceInfo(space.id, next);
                return next;
              });
            }
            fetchInfo({ background: true });
          }}
        />
      )}
      {showCreateSubSpace && (
        <CreateSpaceDialog
          canCreate
          parentSpace={{ id: space.id, name: info.name }}
          onClose={() => setShowCreateSubSpace(false)}
          onCreated={async (payload) => {
            await onRoomsChanged(payload);
            if (payload?.optimisticRoom) {
              setInfo((prev) => {
                if (!prev) return prev;
                const next = mergeCreatedChildIntoSpaceInfo(
                  prev,
                  payload.optimisticRoom!,
                  payload.newSpaceChildTopic ?? null
                );
                setCachedSpaceInfo(space.id, next);
                return next;
              });
            }
            fetchInfo({ background: true });
          }}
        />
      )}
      {showLinkExistingRoom && (
        <LinkExistingToSpaceDialog
          kind="room"
          parentSpaceId={space.id}
          candidates={orphanRooms}
          onClose={() => setShowLinkExistingRoom(false)}
          onLinked={async () => {
            await onRoomsChanged();
            fetchInfo({ background: true });
          }}
        />
      )}
      {showLinkExistingSpace && (
        <LinkExistingToSpaceDialog
          kind="space"
          parentSpaceId={space.id}
          candidates={orphanSpaces}
          onClose={() => setShowLinkExistingSpace(false)}
          onLinked={async () => {
            await onRoomsChanged();
            fetchInfo({ background: true });
          }}
        />
      )}
    </div>
  );
}

function RoomSection({
  title,
  showHeader = true,
  rooms,
  onClickRoom,
  joiningRoomId,
  onJoinRoom,
  palette,
  typography,
  spacing,
}: {
  title: string;
  /** When false, only the room rows are shown (e.g. top bar already shows channel count). */
  showHeader?: boolean;
  rooms: SpaceChildInfo[];
  onClickRoom: (id: string) => void;
  joiningRoomId: string | null;
  onJoinRoom: (id: string) => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
}) {
  return (
    <div style={{ marginBottom: spacing.unit * 6 }}>
      {showHeader && (
      <div style={{
        fontSize: typography.fontSizeSmall,
        fontWeight: typography.fontWeightBold,
        color: palette.textSecondary,
        textTransform: "uppercase" as const,
        letterSpacing: "0.02em",
        padding: `${spacing.unit * 2}px ${spacing.unit * 2}px`,
        marginBottom: spacing.unit,
      }}>
        {title} — {rooms.length}
      </div>
      )}
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing.unit,
      }}>
        {rooms.map((room) => (
          <RoomRow
            key={room.id}
            room={room}
            isJoining={joiningRoomId === room.id}
            onClick={() => {
              if (room.membership === "joined") {
                onClickRoom(room.id);
              }
            }}
            onJoin={() => onJoinRoom(room.id)}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        ))}
      </div>
    </div>
  );
}

function RoomRow({
  room,
  isJoining,
  onClick,
  onJoin,
  palette,
  typography,
  spacing,
}: {
  room: SpaceChildInfo;
  isJoining: boolean;
  onClick: () => void;
  onJoin: () => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
}) {
  const { resolvedColorScheme } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedAvatar = useResolvedDmPeerAvatarUrl({
    avatarUrl: room.avatarUrl,
    isDirect: room.isDirect,
    dmPeerUserId: room.dmPeerUserId,
  });
  const isVoice = room.roomType === VOICE_ROOM_TYPE;
  const isJoined = room.membership === "joined";
  const isInvited = room.membership === "invited";
  const canJoin = !isJoined;
  const isDm = room.isDirect === true;
  const dmPresence = resolvePresenceWithDnd(room.dmPeerPresence ?? "offline", room.dmPeerStatusMsg);
  const dmTitle = effectiveDmTitle({ name: room.name, dmPeerUserId: room.dmPeerUserId ?? null });
  const initials = dmTitle
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  useEffect(() => {
    setImageFailed(false);
  }, [room.id, resolvedAvatar]);

  const fallbackBg =
    isDm && room.dmPeerUserId
      ? userInitialAvatarBackground(room.dmPeerUserId, resolvedColorScheme)
      : palette.bgActive;

  const fallbackIcon = isVoice ? (
    <Volume2 size={18} color={palette.textSecondary} />
  ) : isDm ? (
    <span
      style={{
        fontSize: typography.fontSizeSmall,
        fontWeight: typography.fontWeightBold,
        color: palette.textPrimary,
      }}
    >
      {initials || "?"}
    </span>
  ) : (
    <Hash size={18} color={palette.textSecondary} />
  );

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={isJoined ? onClick : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
        padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
        borderRadius: spacing.unit * 1.5,
        cursor: isJoined ? "pointer" : "default",
        backgroundColor: hovered ? palette.bgHover : "transparent",
        transition: "background-color 0.1s",
      }}
    >
      {/* Room icon or avatar */}
      <div style={{ position: "relative", width: 36, height: 36, flexShrink: 0 }}>
        {resolvedAvatar && !imageFailed ? (
          <img
            src={avatarSrc(resolvedAvatar)}
            alt={dmTitle}
            onError={() => setImageFailed(true)}
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
              backgroundColor: fallbackBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {fallbackIcon}
          </div>
        )}
        {isDm && isJoined && !!room.dmPeerUserId && (
          <span
            title={dmPresence}
            style={{
              position: "absolute",
              bottom: 0,
              right: 0,
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor: dmPresenceDotColor(dmPresence),
              border: `2px solid ${palette.bgPrimary}`,
              boxSizing: "border-box",
            }}
          />
        )}
      </div>

      {/* Room info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit,
        }}>
          <span style={{
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textHeading,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {isDm ? dmTitle : room.name}
          </span>
        </div>
        {room.topic && !isDm && (
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {room.topic}
          </div>
        )}
        {isDm ? (
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            marginTop: 1,
          }}>
            <MessageCircle size={11} color={palette.textSecondary} />
            <span>Direct message</span>
          </div>
        ) : (
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            marginTop: 1,
          }}>
            <Users size={11} color={palette.textSecondary} />
            <span>{room.numJoinedMembers} member{room.numJoinedMembers !== 1 ? "s" : ""}</span>
          </div>
        )}
      </div>

      {/* Status / action */}
      <div style={{ flexShrink: 0 }}>
        {isJoined ? (
          <span style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            fontSize: typography.fontSizeSmall,
            color: "#23a55a",
          }}>
            <Check size={14} />
            Joined
          </span>
        ) : isInvited ? (
          <button
            onClick={(e) => { e.stopPropagation(); onJoin(); }}
            disabled={isJoining}
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: palette.accent,
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isJoining ? "default" : "pointer",
              opacity: isJoining ? 0.7 : 1,
            }}
          >
            <Mail size={13} />
            {isJoining ? "Joining..." : "Accept"}
          </button>
        ) : canJoin ? (
          <button
            onClick={(e) => { e.stopPropagation(); onJoin(); }}
            disabled={isJoining}
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: palette.accent,
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isJoining ? "default" : "pointer",
              opacity: isJoining ? 0.7 : 1,
            }}
          >
            <LogIn size={13} />
            {isJoining ? "Joining..." : "Join"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function KnockRow({
  knock,
  isActing,
  canInvite,
  canKick,
  onAccept,
  onDeny,
  palette,
  typography,
  spacing,
  resolvedColorScheme,
}: {
  knock: { userId: string; displayName: string | null; avatarUrl: string | null; reason: string | null };
  isActing: boolean;
  canInvite: boolean;
  canKick: boolean;
  onAccept: () => void;
  onDeny: () => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
  resolvedColorScheme: ReturnType<typeof useTheme>["resolvedColorScheme"];
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
        padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
        borderRadius: spacing.unit * 1.5,
        backgroundColor: hovered ? palette.bgHover : "transparent",
        transition: "background-color 0.1s",
      }}
    >
      {/* Avatar */}
      {knock.avatarUrl ? (
        <img
          src={avatarSrc(knock.avatarUrl)}
          alt={knock.displayName ?? knock.userId}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : (
        <div style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          backgroundColor: userInitialAvatarBackground(knock.userId, resolvedColorScheme),
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: typography.fontSizeSmall,
          fontWeight: typography.fontWeightBold,
        }}>
          {(knock.displayName ?? knock.userId).charAt(0).toUpperCase()}
        </div>
      )}

      {/* Name + reason */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: typography.fontSizeBase,
          fontWeight: typography.fontWeightMedium,
          color: palette.textHeading,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {knock.displayName ?? knock.userId}
        </span>
        {knock.reason && (
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {knock.reason}
          </div>
        )}
      </div>

      {/* Accept / Deny */}
      <div style={{ display: "flex", gap: spacing.unit, flexShrink: 0 }}>
        {canInvite && (
          <button
            onClick={onAccept}
            disabled={isActing}
            title="Accept"
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: "#23a55a",
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isActing ? "default" : "pointer",
              opacity: isActing ? 0.7 : 1,
            }}
          >
            {isActing ? (
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Check size={13} />
            )}
            Accept
          </button>
        )}
        {canKick && (
          <button
            onClick={onDeny}
            disabled={isActing}
            title="Deny"
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: "#ed4245",
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isActing ? "default" : "pointer",
              opacity: isActing ? 0.7 : 1,
            }}
          >
            <X size={13} />
            Deny
          </button>
        )}
      </div>
    </div>
  );
}