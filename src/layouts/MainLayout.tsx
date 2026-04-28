import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import ChatView from "../layouts/ChatView";
import VoiceRoomView from "../components/VoiceRoomView";
import InvitationView from "../layouts/InvitationView";
import SpaceHomeView from "../layouts/SpaceHomeView";
import type { RoomsForLayout } from "../hooks/useRooms";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import type { Room } from "../types/matrix";
import { usePresence } from "../hooks/usePresence";
import { useVoiceParticipants } from "../hooks/useVoiceParticipants";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { useUnreadRooms, useSpaceUnreadRollup } from "../hooks/useUnreadRooms";
import {
  useNotificationSettings,
  type TrayUnreadIndicatorMode,
} from "../hooks/useNotificationSettings";
import { useDesktopNotifications } from "../hooks/useDesktopNotifications";
import { PresenceContext } from "../hooks/PresenceContext";
import { useState, useCallback, useMemo, useEffect, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import SettingsDialog from "../components/SettingsDialog";
import {
  VOICE_ROOM_TYPE,
  compareByDisplayThenKey,
  normalizeUserId,
  pendingDmRoomId,
  voiceStateLookupKeysForLiveKitIdentity,
} from "../utils/matrix";
import { collectRoomIdsInSpaceTree } from "../utils/spaceModeration";
import { sortBySpaceChildOrder } from "../utils/spaceChildOrdering";
import { useLivekitVoiceSnapshots } from "../hooks/useLivekitVoiceSnapshots";
import { useMatrixUserProfile } from "../hooks/useMatrixUserProfile";
import { useUserAvatar } from "../hooks/useUserAvatar";
import { useResizeHandle } from "../hooks/useResizeHandle";
import { useSpaceOrder, applyStoredSpaceOrder } from "../hooks/useSpaceOrder";

const ROOM_SIDEBAR_WIDTH_KEY = "pax-room-sidebar-width";
const USER_MENU_WIDTH_KEY = "pax-user-menu-width";
const MIN_ROOM_SIDEBAR_WIDTH = 180;
const MAX_ROOM_SIDEBAR_WIDTH = 400;
const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const MIN_CHAT_VIEW_WIDTH = 200;
const SPACE_SIDEBAR_WIDTH = 72;
const ROOM_SIDEBAR_RESIZE_HANDLE = 6;

function getStoredUserMenuWidth(defaultWidth: number): number {
  try {
    const raw = localStorage.getItem(USER_MENU_WIDTH_KEY);
    if (raw !== null) {
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val >= 180 && val <= 400) return val;
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return defaultWidth;
}

function getStoredRoomSidebarWidth(defaultWidth: number): number {
  try {
    const raw = localStorage.getItem(ROOM_SIDEBAR_WIDTH_KEY);
    if (raw !== null) {
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val >= MIN_ROOM_SIDEBAR_WIDTH && val <= MAX_ROOM_SIDEBAR_WIDTH) return val;
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return defaultWidth;
}

function storeRoomSidebarWidth(width: number) {
  try {
    localStorage.setItem(ROOM_SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

function storeUserMenuWidth(width: number) {
  try {
    localStorage.setItem(USER_MENU_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

interface MainLayoutProps {
  userId: string;
  onSignOut: () => void;
  rooms: RoomsForLayout;
}

export default function MainLayout({
  userId,
  onSignOut,
  rooms: { spaces, roomsBySpace, getRoom, fetchRooms, upsertOptimisticRoom },
}: MainLayoutProps) {
  const joinedSpaceIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const s of spaces) {
      if (s.membership === "joined") ids.add(s.id);
    }
    return ids;
  }, [spaces]);

  const { storedOrder: storedSpaceOrder, setOrder: setStoredSpaceOrder } =
    useSpaceOrder();

  const topLevelSpaces = useMemo(() => {
    const filtered = spaces.filter(
      (s) => !s.parentSpaceIds.some((pid) => joinedSpaceIdSet.has(pid))
    );
    // Alphabetise the "unknown" bucket so spaces the user has never
    // manually ordered have a stable fallback position; `applyStoredSpaceOrder`
    // preserves this tail order.
    const alphaSorted = [...filtered].sort((a, b) =>
      compareByDisplayThenKey(a.name, a.id, b.name, b.id)
    );
    return applyStoredSpaceOrder(alphaSorted, storedSpaceOrder);
  }, [spaces, joinedSpaceIdSet, storedSpaceOrder]);

  const { manualStatus, setManualStatus, effectivePresence, statusMessage, setStatusMessage } = usePresence();
  const voiceCall = useVoiceCall();
  // Unread state for every joined room, used by the sidebar to paint rooms in
  // the primary colour when they have unread activity.  The hook is scoped to
  // MainLayout so one subscription serves both the sidebar today and future
  // consumers (e.g. a window-title unread badge) without duplicating listeners.
  const roomUnread = useUnreadRooms(userId);
  const { isUnread } = roomUnread;

  // Notification settings drive DM-badge muting: a DM explicitly set to
  // `none` (or inheriting `none` from a parent space / global default)
  // should not contribute unread messages to the red badge.  Reading this
  // here costs one React subscription across all rendered sidebar rows —
  // the hook itself caches and only re-renders on `pax-notification-settings-changed`.
  const { notificationSettings } = useNotificationSettings();

  // Does this room effectively resolve to "none"?  We reproduce the
  // resolver's precedence chain here (room → space → global → Element
  // default).  For DMs, Element defaults to `all`, so the terminal branch
  // below returns `false` — only an explicit/ancestor "none" mutes.
  const isRoomEffectivelyMuted = useCallback(
    (roomId: string): boolean => {
      const explicit = notificationSettings.rooms[roomId];
      if (explicit) return explicit === "none";
      // Walk any parent space that has a level set.
      const room = getRoom(roomId);
      if (room) {
        for (const parentId of room.parentSpaceIds) {
          const spaceLevel = notificationSettings.spaces[parentId];
          if (spaceLevel) return spaceLevel === "none";
        }
      }
      if (notificationSettings.globalDefault) {
        return notificationSettings.globalDefault === "none";
      }
      return false;
    },
    [notificationSettings, getRoom],
  );

  // Space-level rollup.  Spaces don't have unread state of their own — we walk
  // each space's descendant tree and OR/sum its rooms.  `roomsBySpace` is the
  // tree edges (direct children), `spaces` is the flat list of joined spaces.
  const {
    isSpaceUnread,
    isSpaceNotified,
    isHomeUnread,
    isHomeNotified,
    effectiveMentionCount,
    effectiveSpaceMentionCount,
    effectiveHomeMentionCount,
  } = useSpaceUnreadRollup(spaces, roomsBySpace, roomUnread, isRoomEffectivelyMuted);

  // Tray icon: behaviour from notification settings (default: red = notify-worthy, blue = other unread).
  useEffect(() => {
    const hasUnread =
      isHomeUnread() ||
      topLevelSpaces.some(
        (s) => s.membership === "joined" && isSpaceUnread(s.id),
      );
    const hasNotify =
      isHomeNotified() ||
      topLevelSpaces.some(
        (s) => s.membership === "joined" && isSpaceNotified(s.id),
      );
    const mode: TrayUnreadIndicatorMode =
      notificationSettings.trayUnreadIndicator ?? "split";
    let dot: "none" | "red" | "blue" = "none";
    switch (mode) {
      case "allRed":
        if (hasUnread) dot = "red";
        break;
      case "split":
        if (hasNotify) dot = "red";
        else if (hasUnread) dot = "blue";
        break;
      case "notifyOnly":
        if (hasNotify) dot = "red";
        break;
      case "never":
        break;
    }
    void invoke("set_tray_unread_indicator", { dot }).catch(() => {
      /* web / early startup */
    });
  }, [
    isHomeUnread,
    isHomeNotified,
    isSpaceUnread,
    isSpaceNotified,
    topLevelSpaces,
    notificationSettings.trayUnreadIndicator,
  ]);

  useEffect(() => {
    return () => {
      void invoke("set_tray_unread_indicator", { dot: "none" }).catch(() => {});
    };
  }, []);

  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomBySpace, setActiveRoomBySpace] = useState<Record<string, string | null>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** DM composer before the Matrix room exists (first send creates the room). */
  const [pendingDm, setPendingDm] = useState<{ peerUserId: string; displayNameHint: string } | null>(null);
  const pendingDmPeerProfile = useMatrixUserProfile(pendingDm?.peerUserId ?? null);
  /** Carries DM metadata across the gap between room creation and sync populating isDirect. */
  const [dmTransitionHint, setDmTransitionHint] = useState<{
    roomId: string;
    peerUserId: string;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);

  const spaceKey = activeSpaceId ?? "";
  const activeRoomId = activeRoomBySpace[spaceKey] ?? null;

  const setActiveRoomId = useCallback((roomId: string | null) => {
    startTransition(() => {
      setActiveRoomBySpace((prev) => ({ ...prev, [spaceKey]: roomId }));
    });
  }, [spaceKey]);

  // Desktop notifications.  The hook watches `room-message`, gates by
  // per-room level + focus, and dispatches via the notification plugin.
  // It also fires a `pax-notification-clicked` CustomEvent on click-to-focus.
  useDesktopNotifications({ userId, activeRoomId, getRoom });

  // Click-to-focus: when the user clicks a notification, jump to that room.
  // The hook only knows the room id — we resolve which space it belongs to
  // (picking the first matching ancestor) and switch both.
  useEffect(() => {
    function onClicked(e: Event) {
      const ce = e as CustomEvent<{ roomId: string }>;
      const targetRoomId = ce.detail?.roomId;
      if (!targetRoomId) return;
      const room = getRoom(targetRoomId);
      if (!room) return;
      // Pick any joined parent space — if none, null (DMs / orphaned rooms).
      const parentSpaceId = room.parentSpaceIds.find((pid) =>
        joinedSpaceIdSet.has(pid),
      ) ?? null;
      startTransition(() => {
        setActiveSpaceId(parentSpaceId);
        setActiveRoomBySpace((prev) => ({
          ...prev,
          [parentSpaceId ?? ""]: targetRoomId,
        }));
      });
    }
    window.addEventListener("pax-notification-clicked", onClicked);
    return () =>
      window.removeEventListener("pax-notification-clicked", onClicked);
  }, [getRoom, joinedSpaceIdSet]);

  // Clicking the already-active space clears room selection to show the space home
  const handleSelectSpace = useCallback((spaceId: string) => {
    const id = spaceId || null;
    startTransition(() => {
      if (id === activeSpaceId) {
        // Re-clicking same space: clear room selection
        setActiveRoomBySpace((prev) => ({ ...prev, [spaceId || ""]: null }));
      }
      setActiveSpaceId(id);
    });
  }, [activeSpaceId]);

  const { palette, spacing } = useTheme();
  const activeSpace = activeSpaceId ? getRoom(activeSpaceId) : null;

  /** Which space icon receives the active outline in the left rail (root when viewing a nested sub-space). */
  const spaceSidebarHighlightId = useMemo(() => {
    if (!activeSpaceId) return null;
    let id = activeSpaceId;
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      if (seen.has(id)) return id;
      seen.add(id);
      const r = getRoom(id);
      if (!r?.isSpace) return null;
      const joinedParent = r.parentSpaceIds.find((pid) => joinedSpaceIdSet.has(pid));
      if (!joinedParent) return id;
      id = joinedParent;
    }
    return id;
  }, [activeSpaceId, getRoom, joinedSpaceIdSet]);

  const fetchedAvatarUrl = useUserAvatar();
  const [avatarOverride, setAvatarOverride] = useState<string | null | undefined>(undefined);
  const userAvatarUrl = avatarOverride !== undefined ? avatarOverride : fetchedAvatarUrl;

  useEffect(() => {
    if (activeRoomId === "settings") {
      setActiveRoomBySpace((prev) => ({ ...prev, [spaceKey]: null }));
    }
  }, [activeRoomId, spaceKey]);

  // Resizable room sidebar width, persisted to localStorage
  const [roomSidebarWidth, setRoomSidebarWidth] = useState(() =>
    getStoredRoomSidebarWidth(spacing.sidebarWidth)
  );
  const [userMenuWidth, setUserMenuWidth] = useState(() => getStoredUserMenuWidth(240));

  const sidebarResize = useResizeHandle({
    width: roomSidebarWidth,
    onWidthChange: setRoomSidebarWidth,
    min: MIN_ROOM_SIDEBAR_WIDTH,
    max: () => Math.min(
      MAX_ROOM_SIDEBAR_WIDTH,
      window.innerWidth - SPACE_SIDEBAR_WIDTH - MIN_CHAT_VIEW_WIDTH - userMenuWidth
    ),
  });

  useEffect(() => {
    storeRoomSidebarWidth(roomSidebarWidth);
  }, [roomSidebarWidth]);
  useEffect(() => {
    storeUserMenuWidth(userMenuWidth);
  }, [userMenuWidth]);

  /**
   * Optimistic `m.space.child` order overrides applied to the sidebar
   * BEFORE the corresponding `set_space_child_order` write completes.
   *
   * Outer key: child room/sub-space id.  Inner key: parent space id.
   * Value: pending order string.
   *
   * On drop, `handleReorderSpaceChildren` populates this map immediately
   * so the visible reorder is instant; once the homeserver write
   * resolves (success or failure) the corresponding entries are cleared
   * and the persisted `spaceChildOrders` from the next `fetchRooms()`
   * takes over as ground truth.
   *
   * Stored as a `Map<string, Map<…>>` and replaced by reference on each
   * change so React can shallow-compare in dependencies.
   */
  const [optimisticOrders, setOptimisticOrders] = useState<
    Map<string, Map<string, string>>
  >(() => new Map());

  /**
   * Set of child ids currently mid-reorder.  Used by `RoomSidebar` to
   * dim the dragged children's text and disable further drags on them
   * until the homeserver round-trip resolves.  Derived from
   * `optimisticOrders` keys so the two stay in lock-step.
   */
  const pendingReorderIds = useMemo(() => {
    const s = new Set<string>();
    for (const id of optimisticOrders.keys()) s.add(id);
    return s;
  }, [optimisticOrders]);

  /**
   * Sub-spaces of the active space (joined membership only), sorted by
   * the active space's `m.space.child` order with optimistic overrides
   * applied.  Used both as the source for the unified active-space
   * children list and to compute `subSpaceRoomIdSet`.
   */
  const childJoinedSubspaces = useMemo(() => {
    if (!activeSpaceId) return [] as Room[];
    const children = spaces.filter(
      (s) =>
        s.isSpace &&
        s.membership === "joined" &&
        s.parentSpaceIds.includes(activeSpaceId)
    );
    return sortBySpaceChildOrder(children, activeSpaceId, optimisticOrders);
  }, [spaces, activeSpaceId, optimisticOrders]);

  /**
   * Set of rooms that live INSIDE a sub-space of the active space — they
   * render under their sub-space's expandable section, not under the
   * active space directly, so we exclude them from the top-level
   * children list.
   */
  const subSpaceRoomIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const ss of childJoinedSubspaces) {
      for (const r of roomsBySpace(ss.id)) {
        set.add(r.id);
      }
    }
    return set;
  }, [childJoinedSubspaces, roomsBySpace]);

  /**
   * Unified list of the active space's direct children (sub-space
   * headers + direct rooms, both sorted together by the active space's
   * `m.space.child` order).  Replaces the old separate `subSpaceSections`
   * + `visibleRooms` split: in Matrix, both kinds are children of the
   * same parent and share a single `order` namespace, so reordering
   * them together is the only model where the visible position matches
   * the stored Matrix order in every case.
   *
   * `null` when no active space is selected (Home view); in that case
   * the room list comes from `homeRooms` instead.
   */
  const activeSpaceChildren = useMemo(() => {
    if (!activeSpaceId) return null;
    const directRooms = roomsBySpace(activeSpaceId).filter(
      (r) => !subSpaceRoomIdSet.has(r.id)
    );
    return sortBySpaceChildOrder(
      [...childJoinedSubspaces, ...directRooms],
      activeSpaceId,
      optimisticOrders
    );
  }, [
    activeSpaceId,
    childJoinedSubspaces,
    roomsBySpace,
    subSpaceRoomIdSet,
    optimisticOrders,
  ]);

  /**
   * Look up the rooms inside a given sub-space, sorted by that
   * sub-space's own `m.space.child` order with optimistic overrides
   * applied.  Used by `RoomSidebar` to render an expanded sub-space's
   * interior.
   */
  const getSubSpaceRoomsOrdered = useCallback(
    (subSpaceId: string) =>
      sortBySpaceChildOrder(roomsBySpace(subSpaceId), subSpaceId, optimisticOrders),
    [roomsBySpace, optimisticOrders]
  );

  /**
   * Rooms shown in the Home view (no active space).  Includes any
   * pending DM placeholder so the user has somewhere to type while the
   * room is being created on the homeserver.
   */
  const homeRooms = useMemo(() => {
    let base: Room[] = roomsBySpace(null);
    if (pendingDm) {
      const fakeId = pendingDmRoomId(pendingDm.peerUserId);
      if (!base.some((r) => r.id === fakeId)) {
        const fake: Room = {
          id: fakeId,
          name: pendingDmPeerProfile.displayName?.trim() || pendingDm.displayNameHint,
          avatarUrl: pendingDmPeerProfile.avatarUrl ?? null,
          isSpace: false,
          parentSpaceIds: [],
          roomType: null,
          membership: "joined",
          isDirect: true,
          dmPeerUserId: pendingDm.peerUserId,
        };
        const merged = [...base, fake];
        merged.sort((a, b) => compareByDisplayThenKey(a.name, a.id, b.name, b.id));
        base = merged;
      }
    }
    if (dmTransitionHint) {
      base = base.map((r) =>
        r.id === dmTransitionHint.roomId && !r.isDirect
          ? {
              ...r,
              isDirect: true,
              dmPeerUserId: dmTransitionHint.peerUserId,
              name: r.name === "Unnamed" ? dmTransitionHint.displayName : r.name,
              avatarUrl: r.avatarUrl ?? dmTransitionHint.avatarUrl,
            }
          : r
      );
    }
    return base;
  }, [
    pendingDm,
    pendingDmPeerProfile.displayName,
    pendingDmPeerProfile.avatarUrl,
    roomsBySpace,
    dmTransitionHint,
  ]);

  /**
   * What `RoomSidebar` actually shows as its room list — Home rooms when
   * no active space, otherwise the unified active-space children
   * (sub-space headers + direct rooms interleaved by Matrix order).
   */
  const visibleRooms = activeSpaceChildren ?? homeRooms;

  const activeRoom = useMemo(() => {
    const raw = activeRoomId ? getRoom(activeRoomId) : null;
    if (raw && !raw.isDirect && dmTransitionHint?.roomId === raw.id) {
      return {
        ...raw,
        isDirect: true,
        dmPeerUserId: dmTransitionHint.peerUserId,
        name: raw.name === "Unnamed" ? dmTransitionHint.displayName : raw.name,
        avatarUrl: raw.avatarUrl ?? dmTransitionHint.avatarUrl,
      };
    }
    return raw;
  }, [activeRoomId, getRoom, dmTransitionHint]);

  const moderationSpaceTreeRoomIds = useMemo(() => {
    if (!activeSpaceId || !activeRoom || activeRoom.isDirect) return null;
    const inTree =
      activeRoom.id === activeSpaceId || activeRoom.parentSpaceIds.includes(activeSpaceId);
    if (!inTree) return null;
    return collectRoomIdsInSpaceTree(activeSpaceId, roomsBySpace);
  }, [activeRoom, activeSpaceId, roomsBySpace]);

  const moderationSpaceName = useMemo(() => {
    if (!activeSpaceId) return null;
    return getRoom(activeSpaceId)?.name ?? null;
  }, [activeSpaceId, getRoom]);

  /** Joined parent space when viewing a nested sub-space (for "back to parent" navigation). */
  const parentSpaceNav = useMemo(() => {
    if (!activeSpaceId || !activeSpace) return null;
    if (!activeSpace.isSpace || activeSpace.membership !== "joined") return null;
    const parentId = activeSpace.parentSpaceIds.find((pid) =>
      joinedSpaceIdSet.has(pid)
    );
    if (!parentId) return null;
    const parent = getRoom(parentId);
    if (!parent?.isSpace) return null;
    return { id: parentId, name: parent.name };
  }, [activeSpaceId, activeSpace, joinedSpaceIdSet, getRoom]);

  const handleNavigateToParentSpace = useCallback(() => {
    if (!parentSpaceNav) return;
    handleSelectSpace(parentSpaceNav.id);
  }, [parentSpaceNav, handleSelectSpace]);

  // Clear transition hint once sync has caught up and the real room has isDirect
  useEffect(() => {
    if (!dmTransitionHint) return;
    const room = getRoom(dmTransitionHint.roomId);
    if (room?.isDirect) {
      setDmTransitionHint(null);
    }
  }, [dmTransitionHint, getRoom, visibleRooms]);

  const draftRoomId = pendingDm ? pendingDmRoomId(pendingDm.peerUserId) : null;
  const showingDraftDm =
    !!pendingDm && draftRoomId !== null && activeRoomId === draftRoomId;

  // Collect voice room IDs in the current space (and any expandable
  // sub-space interiors below it) for participant tracking.
  const voiceRoomIds = useMemo(() => {
    const ids: string[] = [];
    const pushVoice = (list: Room[]) => {
      for (const r of list) {
        if (r.roomType === VOICE_ROOM_TYPE) ids.push(r.id);
      }
    };
    pushVoice(visibleRooms);
    // Sub-space interiors (always included, regardless of whether the user
    // has the section currently expanded) so participants are tracked even
    // for collapsed sections.
    for (const ss of childJoinedSubspaces) {
      pushVoice(roomsBySpace(ss.id));
    }
    return ids;
  }, [visibleRooms, childJoinedSubspaces, roomsBySpace]);
  const { participantsInScope: voiceParticipants, allParticipantsByRoom } =
    useVoiceParticipants(voiceRoomIds);

  /** Per top-level space: active voice in subtree; `self` = current user is in a call (green badge). */
  const spaceVoiceActivity = useMemo(() => {
    const out: Partial<Record<string, "others" | "self">> = {};
    const nu = normalizeUserId(userId);
    for (const space of topLevelSpaces) {
      if (space.membership !== "joined") continue;
      const treeIds = collectRoomIdsInSpaceTree(space.id, roomsBySpace);
      let hasAny = false;
      let selfIn = false;
      for (const rid of treeIds) {
        const room = getRoom(rid);
        if (!room || room.roomType !== VOICE_ROOM_TYPE) continue;
        const parts = allParticipantsByRoom[rid] ?? [];
        if (parts.length === 0) continue;
        hasAny = true;
        if (parts.some((p) => normalizeUserId(p.userId) === nu)) selfIn = true;
      }
      if (hasAny) {
        out[space.id] = selfIn ? "self" : "others";
      }
    }
    return out;
  }, [topLevelSpaces, roomsBySpace, getRoom, allParticipantsByRoom, userId]);

  const livekitByRoom = useLivekitVoiceSnapshots(voiceRoomIds);
  const voiceParticipantStatesByRoom = useMemo(() => {
    type VoiceRowState = {
      isMuted: boolean;
      isDeafened: boolean;
      isSpeaking: boolean;
    };
    const byRoom: Record<string, Record<string, VoiceRowState>> = {};
    for (const rid of voiceRoomIds) {
      byRoom[rid] = {};
      for (const lp of livekitByRoom[rid] ?? []) {
        const st: VoiceRowState = {
          isMuted: lp.isMuted,
          isDeafened: lp.isDeafened,
          isSpeaking: lp.isSpeaking,
        };
        for (const key of voiceStateLookupKeysForLiveKitIdentity(lp.identity)) {
          byRoom[rid][key] = st;
        }
      }
    }
    const cr = voiceCall.connectedRoomId;
    if (cr) {
      if (!byRoom[cr]) {
        byRoom[cr] = {};
      }
      for (const p of voiceCall.participants) {
        const st: VoiceRowState = {
          isMuted: p.isMuted,
          isDeafened: p.isDeafened,
          isSpeaking: p.isSpeaking,
        };
        for (const key of voiceStateLookupKeysForLiveKitIdentity(p.identity)) {
          byRoom[cr][key] = st;
        }
      }
    }
    return byRoom;
  }, [
    voiceRoomIds,
    livekitByRoom,
    voiceCall.participants,
    voiceCall.connectedRoomId,
  ]);

  const { connect: connectVoiceCall, connectedRoomId: connectedVoiceRoomId } = voiceCall;

  // Handle room selection — clicking a voice room joins the call (only if already joined/member)
  const handleSelectRoom = useCallback((roomId: string) => {
    setActiveRoomId(roomId);

    const room = getRoom(roomId);
    if (room && room.roomType === VOICE_ROOM_TYPE && room.membership === "joined" && connectedVoiceRoomId !== roomId) {
      // Join voice room on click (only if not already connected to this room)
      connectVoiceCall(roomId);
    }
  }, [setActiveRoomId, getRoom, connectedVoiceRoomId, connectVoiceCall]);

  const handleStartDirectMessage = useCallback(
    (peerUserId: string, displayNameHint: string) => {
      const peerNorm = normalizeUserId(peerUserId);
      const collected: Room[] = [];
      const seen = new Set<string>();
      const addRooms = (arr: Room[]) => {
        for (const r of arr) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          collected.push(r);
        }
      };
      addRooms(roomsBySpace(null));
      for (const s of spaces) {
        if (s.membership === "joined") addRooms(roomsBySpace(s.id));
      }
      const existingDm = collected.find(
        (r) =>
          r.isDirect &&
          r.membership === "joined" &&
          r.dmPeerUserId != null &&
          normalizeUserId(r.dmPeerUserId) === peerNorm,
      );
      if (existingDm) {
        const room = getRoom(existingDm.id) ?? existingDm;
        const parentSpaceId =
          room.parentSpaceIds.find((pid) => joinedSpaceIdSet.has(pid)) ?? null;
        startTransition(() => {
          setPendingDm(null);
          setActiveSpaceId(parentSpaceId);
          setActiveRoomBySpace((prev) => ({
            ...prev,
            [parentSpaceId ?? ""]: room.id,
          }));
        });
        return;
      }
      const draftId = pendingDmRoomId(peerUserId);
      startTransition(() => {
        setPendingDm({ peerUserId, displayNameHint });
        setActiveSpaceId(null);
        setActiveRoomBySpace((prev) => ({ ...prev, "": draftId }));
      });
    },
    [spaces, roomsBySpace, getRoom, joinedSpaceIdSet],
  );

  const handleDraftDmResolved = useCallback(
    async (dmRoomId: string) => {
      // Capture DM metadata before clearing pendingDm so we can patch the room
      // during the gap before the sync loop sets isDirect on the real room.
      const hint = pendingDm
        ? {
            roomId: dmRoomId,
            peerUserId: pendingDm.peerUserId,
            displayName:
              pendingDmPeerProfile.displayName?.trim() ||
              pendingDm.displayNameHint,
            avatarUrl: pendingDmPeerProfile.avatarUrl ?? null,
          }
        : null;
      setDmTransitionHint(hint);
      await fetchRooms();
      startTransition(() => {
        setPendingDm(null);
        setActiveRoomId(dmRoomId);
      });
    },
    [fetchRooms, setActiveRoomId, pendingDm, pendingDmPeerProfile],
  );

  const handleCancelDraftDm = useCallback(() => {
    setPendingDm((prev) => {
      if (!prev) return null;
      const did = pendingDmRoomId(prev.peerUserId);
      setActiveRoomBySpace((p) => (p[""] === did ? { ...p, "": null } : p));
      return null;
    });
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  /** Joined rooms not under any space (for space home "Add existing room"). */
  const orphanRoomsForSpaceHome = useMemo(
    () =>
      roomsBySpace(null).filter(
        (r) => r.membership === "joined" && !r.isDirect
      ),
    [roomsBySpace]
  );

  /** Joined top-level spaces other than the active one (for "Add existing space"). */
  const orphanSpacesForSpaceHome = useMemo(() => {
    if (!activeSpaceId) return [];
    return spaces.filter(
      (s) =>
        s.membership === "joined" &&
        s.id !== activeSpaceId &&
        s.parentSpaceIds.length === 0
    );
  }, [spaces, activeSpaceId]);

  const handleSpacesChanged = useCallback(async (payload?: RoomsChangedPayload) => {
    if (payload?.optimisticRoom) {
      upsertOptimisticRoom(payload.optimisticRoom);
      void fetchRooms();
      return;
    }

    await fetchRooms();
  }, [fetchRooms, upsertOptimisticRoom]);

  const handleLeftRoom = useCallback(
    (roomId: string) => {
      if (voiceCall.connectedRoomId === roomId) {
        voiceCall.disconnect();
      }
      void fetchRooms();
      if (activeRoomId === roomId) {
        setActiveRoomId(null);
      }
    },
    [fetchRooms, activeRoomId, setActiveRoomId, voiceCall.connectedRoomId, voiceCall.disconnect]
  );

  const handleLeftSpace = useCallback(
    (spaceId: string) => {
      void fetchRooms();
      if (activeSpaceId === spaceId) {
        setActiveSpaceId(null);
      }
    },
    [fetchRooms, activeSpaceId]
  );

  const handleRoomsLeft = useCallback(
    (roomIds: string[]) => {
      const set = new Set(roomIds);
      if (voiceCall.connectedRoomId && set.has(voiceCall.connectedRoomId)) {
        voiceCall.disconnect();
      }
      void fetchRooms();
      if (activeRoomId && set.has(activeRoomId)) {
        setActiveRoomId(null);
      }
      if (activeSpaceId && set.has(activeSpaceId)) {
        setActiveSpaceId(null);
      }
    },
    [
      fetchRooms,
      activeRoomId,
      setActiveRoomId,
      activeSpaceId,
      voiceCall.connectedRoomId,
      voiceCall.disconnect,
    ]
  );

  /**
   * Persist a new user-level top-level space order after a drag-and-drop
   * in the space sidebar.  The sidebar passes in the full post-drop order
   * of currently-rendered top-level spaces (already `spaceHighlightId`-
   * neutral); we forward it directly to the account-data writer.
   */
  const handleReorderSpaces = useCallback(
    async (nextOrder: string[]) => {
      try {
        await setStoredSpaceOrder(nextOrder);
      } catch (e) {
        // `setStoredSpaceOrder` already logs and rolls back; surface to
        // help diagnose if persistent.
        // eslint-disable-next-line no-console
        console.error("Failed to persist space order:", e);
      }
    },
    [setStoredSpaceOrder]
  );

  /**
   * Whether the current user may rewrite `m.space.child` events in the
   * active space (same permission that gates "Create room in space").  We
   * fetch this once per active space; `RoomSidebar` uses it to show/hide
   * drag affordances for sub-spaces and direct rooms.  Sub-space interior
   * reorders (rooms inside a sub-space) are gated separately by the
   * sidebar using a lazily-fetched check per sub-space.
   */
  const [canManageActiveSpace, setCanManageActiveSpace] = useState(false);
  useEffect(() => {
    if (!activeSpaceId) {
      setCanManageActiveSpace(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>("can_manage_space_children", { spaceId: activeSpaceId })
      .then((v) => {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.log(`[canManage] ${activeSpaceId.slice(0, 12)}… = ${v}`);
          setCanManageActiveSpace(v);
        }
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[canManage] ${activeSpaceId.slice(0, 12)}… failed:`, e);
        if (!cancelled) setCanManageActiveSpace(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSpaceId]);

  /**
   * Apply a batch of `m.space.child` order updates for a given parent
   * space.  Lifecycle:
   *
   *   1. Apply optimistic overrides synchronously — the sidebar shows
   *      the new order on the next render, well before any homeserver
   *      round-trip completes.
   *   2. Fire each PUT sequentially.
   *   3. Watch-effect path (fast, normal): the `useEffect` watching
   *      `spaces` clears each optimistic entry as soon as the room's
   *      *persisted* `m.space.child` order matches what we wrote.  This
   *      handles 99% of cases — under normal sync conditions the echo
   *      arrives within hundreds of ms.
   *   4. Safety-net timeout (slow): if the watch effect hasn't cleared
   *      an entry within ~8s of the write completing, force-clear it
   *      anyway.  This guards against (a) Synapse falling behind under
   *      load — we've observed sync iterations taking 17+ seconds in
   *      logs — and (b) hypothetical matrix-sdk state-store
   *      inconsistencies where `room.get_state_events()` returns the
   *      pre-write snapshot for longer than expected.  Without this
   *      timeout the user can end up stuck unable to drag a row for
   *      arbitrarily long, which we've seen happen in practice.
   *   5. Failure path: each PUT that returned an error rolls back
   *      *its specific* optimistic override immediately — succeeded
   *      writes still go through the watch / safety-net path.
   *
   * All state updates use immutable transforms (no mutation of the
   * previous Map or its inner Maps) so React's StrictMode replay
   * doesn't double-mutate and leave the structure in an inconsistent
   * state.
   */
  const handleReorderSpaceChildren = useCallback(
    async (parentSpaceId: string, writes: { childRoomId: string; order: string }[]) => {
      if (writes.length === 0) return;

      // 1. Apply optimistic.
      setOptimisticOrders((prev) => {
        const next = new Map(prev);
        for (const w of writes) {
          // Always copy the inner Map before mutating — never touch
          // anything reachable from `prev`.
          const inner = new Map(next.get(w.childRoomId) ?? new Map());
          inner.set(parentSpaceId, w.order);
          next.set(w.childRoomId, inner);
        }
        return next;
      });

      // 2. Fire writes.
      const failed: typeof writes = [];
      for (const w of writes) {
        try {
          await invoke("set_space_child_order", {
            spaceId: parentSpaceId,
            childRoomId: w.childRoomId,
            order: w.order,
          });
        } catch (e) {
          failed.push(w);
          // eslint-disable-next-line no-console
          console.error(
            `[reorder] set_space_child_order failed for ${w.childRoomId} in ${parentSpaceId}:`,
            e
          );
        }
      }

      // Helper: drop the optimistic override for a single (childId,
      // parentId) pair only if it currently holds the value we wrote
      // (a newer drag may have overwritten it; in that case we leave
      // it alone — the new write owns the slot now).
      const dropIfStill = (childId: string, parentId: string, expected: string) => {
        setOptimisticOrders((prev) => {
          const inner = prev.get(childId);
          if (!inner) return prev;
          if (inner.get(parentId) !== expected) return prev;
          const newInner = new Map(inner);
          newInner.delete(parentId);
          const next = new Map(prev);
          if (newInner.size === 0) next.delete(childId);
          else next.set(childId, newInner);
          return next;
        });
      };

      // 3. Roll back failed writes immediately — persisted state will
      //    never reflect them.
      for (const w of failed) {
        dropIfStill(w.childRoomId, parentSpaceId, w.order);
      }
      if (failed.length > 0) {
        void fetchRooms().catch(() => {});
      }

      // 4. Safety-net: schedule a force-clear for each successful
      //    write.  The watch effect normally handles this much faster
      //    (typically next render after sync echo), but if Synapse is
      //    slow / the state store hiccups, this prevents the row from
      //    staying dimmed forever.  We log when it fires so the
      //    underlying cause can be diagnosed later.
      const succeeded = writes.filter(
        (w) => !failed.some((f) => f.childRoomId === w.childRoomId)
      );
      for (const w of succeeded) {
        setTimeout(() => {
          setOptimisticOrders((prev) => {
            const inner = prev.get(w.childRoomId);
            if (!inner || inner.get(parentSpaceId) !== w.order) {
              // Already cleared by the watch effect (the normal path)
              // or overwritten by a newer drag; nothing to do.
              return prev;
            }
            // eslint-disable-next-line no-console
            console.warn(
              `[reorder] safety-net force-clearing optimistic order for ` +
                `${w.childRoomId} in ${parentSpaceId} ` +
                `(wrote ${JSON.stringify(w.order)}; watch effect never matched). ` +
                `Sync echo may be delayed or matrix-sdk state-store may be stale.`
            );
            const newInner = new Map(inner);
            newInner.delete(parentSpaceId);
            const next = new Map(prev);
            if (newInner.size === 0) next.delete(w.childRoomId);
            else next.set(w.childRoomId, newInner);
            return next;
          });
          // Pull fresh data when we force-clear so the visible order
          // reflects whatever the server now has rather than continuing
          // to display the optimistic value.
          void fetchRooms().catch(() => {});
        }, 8000);
      }
    },
    [fetchRooms]
  );

  /**
   * Reconcile the optimistic-orders map against the latest persisted
   * state.  Runs whenever `spaces` updates (i.e. whenever matrix-sdk's
   * sync delivers a new state event and `useRooms` re-reads).  For each
   * pending optimistic entry: if the corresponding room's persisted
   * order in the relevant parent now equals the optimistic value, we
   * drop the override.  This is what un-dims the row and re-enables
   * dragging on it.
   *
   * The setState updater is fully pure (constructs a new outer Map and
   * new inner Maps from scratch by iterating prev) so StrictMode's
   * double-invocation produces identical results without leaving
   * "ghost" entries with empty inner Maps in the output.
   */
  useEffect(() => {
    if (optimisticOrders.size === 0) return;
    setOptimisticOrders((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map<string, Map<string, string>>();
      for (const [roomId, parentMap] of prev) {
        const room = getRoom(roomId);
        const newInner = new Map<string, string>();
        for (const [parentId, optOrder] of parentMap) {
          const persistedOrder =
            room?.spaceChildOrders?.[parentId]?.order ?? null;
          if (persistedOrder === optOrder) {
            // Caught up — drop this override.
            changed = true;
          } else {
            newInner.set(parentId, optOrder);
          }
        }
        if (newInner.size > 0) {
          next.set(roomId, newInner);
        } else {
          // All overrides for this room cleared (room may have been
          // dropped in its entirety).
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [spaces, getRoom, optimisticOrders]);

  return (
    <PresenceContext.Provider value={{ manualStatus, setManualStatus, effectivePresence, statusMessage, setStatusMessage }}>
      <div style={{
        display: "flex",
        height: "100vh",
        width: "100%",
        minWidth: 0,
        maxWidth: "100vw",
        overflow: "hidden",
      }}>
        <SpaceSidebar
          spaces={topLevelSpaces}
          roomsBySpace={roomsBySpace}
          activeSpaceId={activeSpaceId}
          spaceHighlightId={spaceSidebarHighlightId}
          onSelectSpace={handleSelectSpace}
          onSpacesChanged={handleSpacesChanged}
          onOpenSettings={handleOpenSettings}
          onReorderSpaces={handleReorderSpaces}
          userId={userId}
          onLeftSpace={handleLeftSpace}
          onRoomsLeft={handleRoomsLeft}
          isSpaceUnread={isSpaceUnread}
          spaceMentionCount={effectiveSpaceMentionCount}
          isHomeUnread={isHomeUnread()}
          homeMentionCount={effectiveHomeMentionCount()}
          spaceVoiceActivity={spaceVoiceActivity}
        />
        <div style={{ position: "relative", flexShrink: 0, zIndex: 1 }}>
          <RoomSidebar
            width={roomSidebarWidth}
            rooms={visibleRooms}
            getSubSpaceRoomsOrdered={getSubSpaceRoomsOrdered}
            getRoom={getRoom}
            onOpenSubSpace={handleSelectSpace}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            onSelectSpaceHome={() => setActiveRoomId(null)}
            isSpaceHomeActive={
              activeRoomId === null &&
              !!activeSpace &&
              activeSpace.membership === "joined"
            }
            showSpaceHomeNav={!!activeSpace && activeSpace.membership === "joined"}
            spaceName={activeSpace?.name ?? "Home"}
            spaceInviteId={
              activeSpace && activeSpace.membership === "joined" ? activeSpaceId : null
            }
            userId={userId}
            userAvatarUrl={userAvatarUrl}
            voiceParticipants={voiceParticipants}
            connectedVoiceRoomId={voiceCall.connectedRoomId}
            isVoiceConnecting={voiceCall.isConnecting}
            disconnectingFromRoomId={voiceCall.disconnectingFromRoomId}
            screenSharingOwners={voiceCall.screenSharingOwners}
            voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
            onSetParticipantVolume={voiceCall.setParticipantVolume}
            onLeftRoom={handleLeftRoom}
            activeSpaceId={activeSpaceId}
            roomsBySpace={roomsBySpace}
            showHomeAddRoom={activeSpaceId === null}
            onRoomsChanged={handleSpacesChanged}
            parentSpace={parentSpaceNav}
            onNavigateToParentSpace={handleNavigateToParentSpace}
            canManageActiveSpaceChildren={canManageActiveSpace}
            onReorderSpaceChildren={handleReorderSpaceChildren}
            pendingReorderIds={pendingReorderIds}
            isUnread={isUnread}
            mentionCount={effectiveMentionCount}
          />
          <div
            onMouseDown={sidebarResize.onMouseDown}
            onDoubleClick={() => setRoomSidebarWidth(spacing.sidebarWidth)}
            onMouseEnter={() => sidebarResize.setIsHovered(true)}
            onMouseLeave={() => sidebarResize.setIsHovered(false)}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: -(ROOM_SIDEBAR_RESIZE_HANDLE / 2),
              width: ROOM_SIDEBAR_RESIZE_HANDLE,
              cursor: "col-resize",
              backgroundColor: sidebarResize.isHovered ? palette.border : "transparent",
              transition: "background-color 0.15s",
              zIndex: 2,
            }}
            title="Drag to resize, double-click to reset"
          />
        </div>
        <main style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          backgroundColor: palette.bgPrimary,
          color: palette.textPrimary,
          display: "flex",
        }}>
          {showingDraftDm && pendingDm ? (
            <ChatView
              draftDm={pendingDm}
              userId={userId}
              userMenuWidth={userMenuWidth}
              onUserMenuWidthChange={(next: number) => {
                const clamped = Math.max(MIN_USER_MENU_WIDTH, Math.min(MAX_USER_MENU_WIDTH, next));
                setUserMenuWidth(clamped);
              }}
              onStartDirectMessage={handleStartDirectMessage}
              onDraftDmResolved={handleDraftDmResolved}
              onCancelDraftDm={handleCancelDraftDm}
            />
          ) : activeRoom && activeRoom.membership === "invited" ? (
            <InvitationView room={activeRoom} onJoined={fetchRooms} />
          ) : activeRoom && activeRoom.roomType === VOICE_ROOM_TYPE ? (
            <VoiceRoomView
              room={activeRoom}
              voiceCall={voiceCall}
              voiceParticipants={voiceParticipants[activeRoom.id] ?? []}
              livekitInRoom={livekitByRoom[activeRoom.id] ?? []}
              userId={userId}
            />
          ) : activeRoom ? (
            <ChatView
              room={activeRoom}
              userId={userId}
              userMenuWidth={userMenuWidth}
              onUserMenuWidthChange={(next: number) => {
                const clamped = Math.max(MIN_USER_MENU_WIDTH, Math.min(MAX_USER_MENU_WIDTH, next));
                setUserMenuWidth(clamped);
              }}
              onStartDirectMessage={handleStartDirectMessage}
              moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
              moderationSpaceName={moderationSpaceName}
            />
          ) : activeSpace && activeSpace.membership === "invited" ? (
            <InvitationView room={activeSpace} onJoined={fetchRooms} />
          ) : activeSpace && activeSpace.membership === "joined" ? (
            <SpaceHomeView
              space={activeSpace}
              onSelectRoom={handleSelectRoom}
              onSelectChildSpace={handleSelectSpace}
              getRoomsInChildSpace={roomsBySpace}
              onRoomsChanged={handleSpacesChanged}
              orphanRooms={orphanRoomsForSpaceHome}
              orphanSpaces={orphanSpacesForSpaceHome}
              parentSpace={parentSpaceNav}
              onNavigateToParentSpace={handleNavigateToParentSpace}
            />
          ) : (
            <div style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: palette.textSecondary,
            }}>
              Select a room
            </div>
          )}
        </main>
        {settingsOpen && (
          <SettingsDialog
            onClose={handleCloseSettings}
            onSignOut={onSignOut}
            userId={userId}
            userAvatarUrl={userAvatarUrl}
            onAvatarChanged={setAvatarOverride}
            voiceCall={voiceCall}
          />
        )}
      </div>
    </PresenceContext.Provider>
  );
}