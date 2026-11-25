import { useRoomCallPermissions, type CallPermissions } from "../hooks/useRoomCallPermissions";
import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import type { RemoteCallBarProps } from "../components/ActiveCallBar";
import DiscoverView from "../components/DiscoverView";
import ChatView from "../layouts/ChatView";
import VoiceRoomView, { VoiceCallPanel } from "../components/VoiceRoomView";
import DirectCallControls, { DirectCallError } from "../components/DirectCallControls";
import InvitationView from "../layouts/InvitationView";
import SpaceHomeView from "../layouts/SpaceHomeView";
import type { RoomsForLayout } from "../hooks/useRooms";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import type { Room } from "../types/matrix";
import { usePresence } from "../hooks/usePresence";
import { useVoiceParticipants } from "../hooks/useVoiceParticipants";
import { useVoiceCall, type VoiceCallActions } from "../hooks/useVoiceCall";
import { useRoomMembers } from "../hooks/useRoomMembers";
import { useDirectCall } from "../hooks/useDirectCall";
import { useCallNotifications } from "../hooks/useCallNotifications";
import { ROOM_RECOVERY_MS, VOICE_RECOVERY_REFRESH_MS, useVoiceRecovery } from "../hooks/useVoiceRecovery";
import { useVoiceParticipantStates } from "../hooks/useVoiceParticipantStates";
import { useAudioControls } from "../hooks/useAudioControls";
import { useUnreadRooms, useSpaceUnreadRollup } from "../hooks/useUnreadRooms";
import {
  useNotificationSettings,
  type TrayUnreadIndicatorMode,
} from "../hooks/useNotificationSettings";
import { useDesktopNotifications } from "../hooks/useDesktopNotifications";
import { PresenceContext } from "../hooks/PresenceContext";
import { useState, useRef, useCallback, useMemo, useEffect, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import SettingsDialog from "../components/SettingsDialog";
import {
  VOICE_ROOM_TYPE,
  compareByDisplayThenKey,
  normalizeUserId,
  pendingDmRoomId,
} from "../utils/matrix";
import { collectRoomIdsInSpaceTree } from "../utils/spaceModeration";
import { setAppNotificationCount } from "../utils/appBadge";
import { sortBySpaceChildOrder } from "../utils/spaceChildOrdering";
import { useLivekitVoiceSnapshots } from "../hooks/useLivekitVoiceSnapshots";
import { getRemoteVoiceCalls } from "../data/VoicePresenceStore";
import { useMatrixUserProfile } from "../hooks/useMatrixUserProfile";
import { useUserAvatar } from "../hooks/useUserAvatar";
import { useResizeHandle } from "../hooks/useResizeHandle";
import { useSpaceOrder, applyStoredSpaceOrder } from "../hooks/useSpaceOrder";
import { useIsMobile } from "../hooks/useIsMobile";
import { effectiveDmTitle, isOneToOneChatUi } from "../utils/dmDisplay";
import SideDrawer from "../components/SideDrawer";
import NavBackButton from "../components/NavBackButton";

import { defaultThemeDefinition } from "../theme/themes";

const DISCOVER_PUBLIC_SERVERS = [
  "matrix.org",
  "tchncs.de",
  "4d2.org",
  "nope.chat",
  "mozilla.org",
  "unredacted.org",
];

const ROOM_SIDEBAR_WIDTH_KEY = "pax-room-sidebar-width";
const USER_MENU_WIDTH_KEY = "pax-user-menu-width";
const MIN_ROOM_SIDEBAR_WIDTH = 180;
const MAX_ROOM_SIDEBAR_WIDTH = 400;
const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const MIN_CHAT_VIEW_WIDTH = 200;
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
  joinedInviteRoomId: string | null;
  onInviteRoomOpened: () => void;
}

export default function MainLayout({
  userId,
  onSignOut,
  rooms: { rooms, spaces, roomsBySpace, getRoom, fetchRooms, markInviteSeen, upsertOptimisticRoom },
  joinedInviteRoomId,
  onInviteRoomOpened,
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

  const { manualStatus, setManualStatus, effectivePresence, statusMessage, setStatusMessage } = usePresence(userId);
  const voiceCall = useVoiceCall((roomId) => getRoom(roomId, true)?.roomType === VOICE_ROOM_TYPE);
  const { record: voiceRecovery, ready: voiceRecoveryReady, remember: rememberVoice, forget: forgetVoice } =
    useVoiceRecovery(userId);
  const recoveryRoom = voiceRecovery && getRoom(voiceRecovery.roomId, true);
  const eligibleRecovery = recoveryRoom?.membership === "joined" && !recoveryRoom.upgradePending && !recoveryRoom.replacementRoomId &&
    (voiceRecovery?.direct
      ? recoveryRoom.dmPeerUserId === voiceRecovery.direct.peerUserId
      : recoveryRoom.roomType === VOICE_ROOM_TYPE) ? voiceRecovery : null;
  const {
    call: directCall, matrixMedia, error: directCallError, peerConnection: directCallPeerConnection,
    start: startDirectCall, startGroup: startGroupCall, answer: answerIncomingCall,
    end: endDirectCall, decline: declineDirectCall, endFromNotification: endDirectCallFromNotification,
    clearError: clearDirectCallError, reconnect: reconnectDirectCall,
    isMicEnabled: isDirectCallMicEnabled, toggleMic: toggleDirectCallMic,
  } = useDirectCall(voiceCall, eligibleRecovery, voiceRecoveryReady, rememberVoice, forgetVoice);
  const audioControls = useAudioControls(voiceCall);
  // Unread state for every joined room, used by the sidebar to paint rooms in
  // the primary colour when they have unread activity.  The hook is scoped to
  // MainLayout so one subscription serves both the sidebar today and future
  // consumers (e.g. a window-title unread badge) without duplicating listeners.
  const roomUnread = useUnreadRooms(userId);
  const { hasSnapshot, isUnread, notificationCount } = roomUnread;

  // Badges use the same resolved levels as desktop notifications and server
  // rule maintenance, including direct-parent inheritance and link removal.
  const { notificationSettings, effectiveLevels } = useNotificationSettings();
  const isRoomEffectivelyMuted = useCallback(
    (roomId: string) => effectiveLevels[roomId] === "none",
    [effectiveLevels],
  );

  // Space-level rollup.  Spaces don't have unread state of their own — we walk
  // each space's descendant tree and OR/sum its rooms.  `roomsBySpace` is the
  // tree edges (direct children), `spaces` is the flat list of joined spaces.
  const {
    isSpaceUnread,
    isHomeUnread,
    roomBadgeCount,
    effectiveSpaceMentionCount,
    effectiveHomeMentionCount,
  } = useSpaceUnreadRollup(spaces, roomsBySpace, roomUnread, isRoomEffectivelyMuted);

  const { dot, count } = useMemo(() => {
    const hasUnread =
      isHomeUnread() ||
      topLevelSpaces.some(
        (s) => s.membership === "joined" && isSpaceUnread(s.id),
      );
    const count = rooms.reduce(
      (sum, room) => room.membership === "joined" && !room.isSpace
        ? sum + notificationCount(room.id)
        : sum,
      0,
    );
    const mode: TrayUnreadIndicatorMode =
      notificationSettings.trayUnreadIndicator ?? "split";
    let dot: "none" | "red" | "blue" = "none";
    switch (mode) {
      case "allRed":
        if (hasUnread) dot = "red";
        break;
      case "split":
        if (count > 0) dot = "red";
        else if (hasUnread) dot = "blue";
        break;
      case "notifyOnly":
        if (count > 0) dot = "red";
        break;
      case "never":
        break;
    }
    return { dot, count };
  }, [
    isHomeUnread,
    isSpaceUnread,
    notificationCount,
    rooms,
    topLevelSpaces,
    notificationSettings.trayUnreadIndicator,
  ]);

  useEffect(() => {
    void invoke("set_tray_unread_indicator", { dot }).catch(() => {
      /* web / early startup */
    });
  }, [dot]);

  const showOnDesktop = dot === "red";
  useEffect(() => {
    if (hasSnapshot) setAppNotificationCount(count, showOnDesktop);
  }, [count, hasSnapshot, showOnDesktop]);

  useEffect(() => {
    return () => {
      void invoke("set_tray_unread_indicator", { dot: "none" }).catch(() => {});
    };
  }, []);

  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomBySpace, setActiveRoomBySpace] = useState<Record<string, string | null>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [activeDiscoverServer, setActiveDiscoverServer] = useState<string | null>(null);
  const [currentHomeserver, setCurrentHomeserver] = useState<string | null>(null);
  /** When non-null, ChatView scrolls to this timeline event after the room is active (push/desktop notification tap). */
  const [notificationJump, setNotificationJump] = useState<{
    roomId: string;
    eventId: string;
  } | null>(null);
  /** DM composer before the Matrix room exists (first send creates the room). */
  const [pendingDm, setPendingDm] = useState<{ peerUserId: string; displayNameHint: string } | null>(null);
  const [composerFocusRoomId, setComposerFocusRoomId] = useState<string | null>(null);
  const pendingDmPeerProfile = useMatrixUserProfile(pendingDm?.peerUserId ?? null);
  /** Carries DM metadata across the gap between room creation and sync populating isDirect. */
  const [dmTransitionHint, setDmTransitionHint] = useState<{
    roomId: string;
    peerUserId: string;
    displayName: string;
    avatarUrl: string | null;
  } | null>(null);

  const spaceKey = activeSpaceId ?? "";
  const selectedRoomId = activeRoomBySpace[spaceKey] ?? null;
  const activeRoomId = selectedRoomId ? getRoom(selectedRoomId)?.id ?? selectedRoomId : null;

  const clearComposerFocusRequest = useCallback(() => setComposerFocusRoomId(null), []);
  const onComposerAutoFocus = composerFocusRoomId !== null && composerFocusRoomId === activeRoomId
    ? clearComposerFocusRequest : undefined;

  useEffect(() => {
    if (composerFocusRoomId !== null && (activeRoomId !== composerFocusRoomId || discoverOpen)) {
      setComposerFocusRoomId(null);
    }
  }, [activeRoomId, composerFocusRoomId, discoverOpen]);

  const isMobile = useIsMobile();
  const [mobileNavDrawerOpen, setMobileNavDrawerOpen] = useState(false);

  const openMobileNavDrawer = useCallback(() => {
    setMobileNavDrawerOpen(true);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setMobileNavDrawerOpen(false);
    }
  }, [isMobile]);

  // Android hardware back: MainActivity dispatches `pax-android-back` only when
  // `__paxAndroidBackHandlesNav` is set (mobile drawer layout). Toggle nav drawer.
  useEffect(() => {
    if (!isMobile) return;
    const w = window as Window & { __paxAndroidBackHandlesNav?: boolean };
    w.__paxAndroidBackHandlesNav = true;
    const onBack = () => {
      setMobileNavDrawerOpen((prev) => !prev);
    };
    window.addEventListener("pax-android-back", onBack);
    return () => {
      delete w.__paxAndroidBackHandlesNav;
      window.removeEventListener("pax-android-back", onBack);
    };
  }, [isMobile]);

  const clearNotificationJump = useCallback(() => {
    setNotificationJump(null);
  }, []);

  useEffect(() => {
    if (!notificationJump) return;
    if (activeRoomId !== (getRoom(notificationJump.roomId)?.id ?? notificationJump.roomId)) {
      setNotificationJump(null);
    }
  }, [activeRoomId, getRoom, notificationJump]);

  const setActiveRoomId = useCallback((roomId: string | null) => {
    startTransition(() => {
      setActiveRoomBySpace((prev) => ({ ...prev, [spaceKey]: roomId }));
    });
  }, [spaceKey]);

  const openJoinedRoom = useCallback((roomId: string) => {
    const room = getRoom(roomId, true);
    if (room?.membership !== "joined") return;
    const parentSpaceId = activeRoomId === roomId || (activeSpaceId && room.parentSpaceIds.includes(activeSpaceId))
      ? activeSpaceId
      : room.parentSpaceIds.find((id) => joinedSpaceIdSet.has(id)) ?? null;
    setDiscoverOpen(false);
    setActiveSpaceId(parentSpaceId);
    setActiveRoomBySpace((previous) => ({ ...previous, [parentSpaceId ?? ""]: roomId }));
    if (isMobile) setMobileNavDrawerOpen(false);
  }, [activeRoomId, activeSpaceId, getRoom, isMobile, joinedSpaceIdSet]);

  useEffect(() => {
    if (!joinedInviteRoomId) return;
    const room = getRoom(joinedInviteRoomId);
    if (room?.membership !== "joined") return;
    if (room.isSpace) {
      setDiscoverOpen(false);
      setActiveSpaceId(room.id);
      setActiveRoomBySpace((previous) => ({ ...previous, [room.id]: null }));
      if (isMobile) setMobileNavDrawerOpen(false);
    } else {
      openJoinedRoom(room.id);
    }
    onInviteRoomOpened();
  }, [joinedInviteRoomId, getRoom, isMobile, openJoinedRoom, onInviteRoomOpened]);

  useEffect(() => {
    invoke<string>("current_homeserver")
      .then(setCurrentHomeserver)
      .catch(() => setCurrentHomeserver(null));
  }, []);

  const handleOpenDiscover = useCallback(() => {
    setDiscoverOpen(true);
  }, []);

  const [customDiscoverServers, setCustomDiscoverServers] = useState<string[]>([]);

  const handleAddDiscoverServer = useCallback((server: string) => {
    setCustomDiscoverServers((prev) =>
      prev.includes(server) ? prev : [...prev, server]
    );
  }, []);

  // Full server list for DiscoverView when "All" is selected.
  // Memoized so the array reference is stable across unrelated re-renders —
  // DiscoverView's useEffect depends on this and would otherwise re-fire and
  // cancel in-flight searches on every presence/room update.
  const discoverServers = useMemo(
    () =>
      Array.from(
        new Set(
          [currentHomeserver, ...DISCOVER_PUBLIC_SERVERS, ...customDiscoverServers].filter(
            (s): s is string => !!s
          )
        )
      ),
    [currentHomeserver, customDiscoverServers]
  );

  // Desktop notifications.  The hook watches `room-message`, gates by
  // per-room level + focus, and dispatches via the notification plugin.
  // It also fires a `pax-notification-clicked` CustomEvent on click-to-focus.
  useDesktopNotifications({ userId, activeRoomId, getRoom });

  // Click-to-focus: when the user clicks a notification, jump to that room
  // (and scroll to the notified event when `detail.eventId` is present).
  useEffect(() => {
    function onClicked(e: Event) {
      const ce = e as CustomEvent<{ roomId: string; eventId?: string }>;
      const targetRoomId = ce.detail?.roomId;
      if (!targetRoomId) return;
      const room = getRoom(targetRoomId);
      if (!room) return;
      e.preventDefault();
      const scrollEventId = ce.detail?.eventId?.trim();
      // Pick any joined parent space — if none, null (DMs / orphaned rooms).
      const parentSpaceId = room.parentSpaceIds.find((pid) =>
        joinedSpaceIdSet.has(pid),
      ) ?? null;
      startTransition(() => {
        setNotificationJump(
          scrollEventId
            ? { roomId: targetRoomId, eventId: scrollEventId }
            : null,
        );
        setActiveSpaceId(parentSpaceId);
        setActiveRoomBySpace((prev) => ({
          ...prev,
          [parentSpaceId ?? ""]: room.id,
        }));
      });
      if (isMobile) setMobileNavDrawerOpen(false);
    }
    window.addEventListener("pax-notification-clicked", onClicked);
    window.addEventListener("pax-room-event-link", onClicked);
    return () => {
      window.removeEventListener("pax-notification-clicked", onClicked);
      window.removeEventListener("pax-room-event-link", onClicked);
    };
  }, [getRoom, joinedSpaceIdSet, isMobile, setMobileNavDrawerOpen]);

  // Clicking the already-active space clears room selection to show the space home
  const handleSelectSpace = useCallback((spaceId: string) => {
    const id = spaceId || null;
    startTransition(() => {
      setDiscoverOpen(false);
      // Only clear room selection when re-clicking the active space normally —
      // not when navigating back from discover, where it would incorrectly
      // reset the remembered room for the space that was open before discover.
      if (!discoverOpen && id === activeSpaceId) {
        setActiveRoomBySpace((prev) => ({ ...prev, [spaceId || ""]: null }));
      }
      setActiveSpaceId(id);
    });
  }, [activeSpaceId, discoverOpen]);

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
  const [userMenuWidth, setUserMenuWidth] = useState(() =>
    getStoredUserMenuWidth(defaultThemeDefinition.spacing.userMenuWidth)
  );

  const sidebarResize = useResizeHandle({
    width: roomSidebarWidth,
    onWidthChange: setRoomSidebarWidth,
    min: MIN_ROOM_SIDEBAR_WIDTH,
    max: () =>
      Math.min(
        MAX_ROOM_SIDEBAR_WIDTH,
        window.innerWidth -
          spacing.spaceSidebarWidth -
          MIN_CHAT_VIEW_WIDTH -
          userMenuWidth
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

  const activeDmPeer = activeRoom?.dmPeerUserId;
  const permissionsRoomId = activeRoom?.membership === "joined" && !activeRoom.upgradePending ? activeRoom.id : undefined;
  const callPermissions = useRoomCallPermissions(permissionsRoomId, activeDmPeer, !!activeRoom?.isDirect && !activeDmPeer);

  const moderationSpaceTreeRoomIds = useMemo(() => {
    if (!activeSpaceId || !activeRoom || isOneToOneChatUi(activeRoom)) return null;
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
        if (voiceCall.connectedRoomId === rid) selfIn = true;
      }
      if (hasAny) {
        out[space.id] = selfIn ? "self" : "others";
      }
    }
    return out;
  }, [topLevelSpaces, roomsBySpace, getRoom, allParticipantsByRoom, voiceCall.connectedRoomId]);

  const voicePresence = useLivekitVoiceSnapshots(voiceRoomIds, voiceCall.connectedRoomId, userId);
  const voiceParticipantStatesByRoom = useVoiceParticipantStates(
    voiceRoomIds, allParticipantsByRoom, voicePresence, voiceCall, userId,
    eligibleRecovery?.direct ? undefined : eligibleRecovery?.roomId,
  );
  const {
    connect: connectVoice, disconnect: disconnectVoice, connectedRoomId: connectedVoiceRoomId,
    targetRoomId: targetVoiceRoomId, endedRoomId: endedVoiceRoomId,
  } = voiceCall;
  const connectedVoiceRoom = connectedVoiceRoomId && getRoom(connectedVoiceRoomId, true);
  const connectedChannelId = connectedVoiceRoom && connectedVoiceRoom.roomType === VOICE_ROOM_TYPE
    ? connectedVoiceRoom.id : null;
  const remoteCalls = useMemo(() => getRemoteVoiceCalls(voicePresence), [voicePresence]);
  const showRemoteCalls = !directCall && !eligibleRecovery?.direct && !connectedVoiceRoomId &&
    !voiceCall.isConnecting && !voiceCall.isReconnecting && !voiceCall.disconnectingFromRoomId;

  useEffect(() => {
    if (!connectedChannelId) return;
    const save = () => rememberVoice({ roomId: connectedChannelId, expiresAt: Date.now() + ROOM_RECOVERY_MS });
    save();
    const timer = setInterval(save, VOICE_RECOVERY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [connectedChannelId, rememberVoice]);

  useEffect(() => {
    if (voiceRecovery && !eligibleRecovery) forgetVoice(voiceRecovery.roomId);
    if (endedVoiceRoomId) forgetVoice(endedVoiceRoomId);
  }, [voiceRecovery, eligibleRecovery, endedVoiceRoomId, forgetVoice]);

  const activeVoiceRoomId = directCall && (directCall.established || targetVoiceRoomId === directCall.roomId)
    ? directCall.roomId : targetVoiceRoomId ?? eligibleRecovery?.roomId;
  const latestChannelJoin = useRef(0);
  const disconnectVoiceCall = useCallback(() => {
    latestChannelJoin.current++;
    if (directCall?.roomId === activeVoiceRoomId) return endDirectCall();
    if (!activeVoiceRoomId) return Promise.resolve();
    forgetVoice(activeVoiceRoomId);
    return disconnectVoice(activeVoiceRoomId);
  }, [directCall?.roomId, activeVoiceRoomId, disconnectVoice, endDirectCall, forgetVoice]);

  const connectVoiceCall = useCallback<VoiceCallActions["connect"]>(async (roomId, options) => {
    const request = ++latestChannelJoin.current;
    const permissions = await invoke<CallPermissions>("get_room_call_permissions", { roomId }).catch(() => null);
    if (!permissions?.join || latestChannelJoin.current !== request) return false;
    await endDirectCall();
    if (latestChannelJoin.current !== request) return false;
    const previousRoomId = targetVoiceRoomId ?? eligibleRecovery?.roomId;
    if (previousRoomId && previousRoomId !== roomId && previousRoomId !== directCall?.roomId) {
      forgetVoice(previousRoomId);
      await disconnectVoice(previousRoomId);
    }
    if (latestChannelJoin.current !== request) return false;
    return connectVoice(roomId, {
      ...options,
      replaceOtherSessions: options?.replaceOtherSessions ?? false,
      forceReconnect: options?.forceReconnect ?? (eligibleRecovery?.roomId === roomId && connectedVoiceRoomId !== roomId),
    });
  }, [connectVoice, connectedVoiceRoomId, directCall?.roomId, disconnectVoice, eligibleRecovery?.roomId, endDirectCall, forgetVoice, targetVoiceRoomId]);

  function remoteCallBarFor(room: Room | null): RemoteCallBarProps | undefined {
    if (!showRemoteCalls || room?.roomType !== VOICE_ROOM_TYPE || room.membership !== "joined" ||
      room.upgradePending || room.replacementRoomId) return;
    const mode = remoteCalls.get(room.id);
    if (!mode) return;
    return {
      roomName: room.name,
      status: "remote",
      roomId: room.id,
      joinButton: {
        label: mode === "handoff" ? "Join here instead" : "Join voice",
        onClick: () => {
          openJoinedRoom(room.id);
          void connectVoiceCall(room.id, { replaceOtherSessions: mode === "handoff" ? "required" : false });
        },
      },
    };
  }
  const activeRoomRemoteCall = remoteCallBarFor(activeRoom);
  const remoteCallBar = activeRoomRemoteCall ?? Array.from(remoteCalls.keys(), (id) =>
    remoteCallBarFor(getRoom(id, true))).find((bar) => bar !== undefined);

  const reconnectVoiceCall = useCallback(() => {
    if (directCall?.roomId === activeVoiceRoomId || eligibleRecovery?.direct) {
      return reconnectDirectCall(openJoinedRoom);
    }
    if (activeVoiceRoomId) return connectVoiceCall(activeVoiceRoomId, { forceReconnect: true, replaceOtherSessions: false });
  }, [activeVoiceRoomId, connectVoiceCall, directCall?.roomId, eligibleRecovery?.direct, openJoinedRoom, reconnectDirectCall]);

  const abandonVoiceChannel = useCallback(() => {
    const roomId = targetVoiceRoomId ?? eligibleRecovery?.roomId;
    if (!roomId || getRoom(roomId, true)?.roomType !== VOICE_ROOM_TYPE) return;
    forgetVoice(roomId);
    void disconnectVoice(roomId);
  }, [disconnectVoice, eligibleRecovery?.roomId, forgetVoice, getRoom, targetVoiceRoomId]);

  const placeDirectCall = useCallback((roomId: string, peerUserId: string, options?: { memberCall?: boolean; video?: boolean }) => {
    abandonVoiceChannel();
    startDirectCall(roomId, peerUserId, options);
  }, [abandonVoiceChannel, startDirectCall]);

  const answerDirectCall = useCallback((callId?: string) => {
    answerIncomingCall((roomId) => {
      abandonVoiceChannel();
      openJoinedRoom(roomId);
    }, callId);
  }, [abandonVoiceChannel, answerIncomingCall, openJoinedRoom]);

  useEffect(() => {
    const roomId = directCall?.roomId ?? targetVoiceRoomId;
    if (!roomId) return;
    const room = getRoom(roomId, true);
    if (room?.membership === "joined" && !room.upgradePending && !room.replacementRoomId &&
        (!directCall || directCall.transport !== undefined || room.dmPeerUserId === directCall.peerUserId)) return;
    forgetVoice(roomId);
    if (directCall) void endDirectCall();
    else void disconnectVoice(roomId);
  }, [directCall, disconnectVoice, endDirectCall, forgetVoice, getRoom, targetVoiceRoomId]);

  // Handle room selection — clicking a voice room joins the call (only if already joined/member)
  const handleSelectRoom = useCallback((roomId: string) => {
    if (isMobile && roomId === activeRoomId) {
      setMobileNavDrawerOpen(false);
      return;
    }
    setActiveRoomId(roomId);
    if (isMobile) setMobileNavDrawerOpen(false);

    const room = getRoom(roomId);
    if (room && room.roomType === VOICE_ROOM_TYPE && room.membership === "joined" && connectedVoiceRoomId !== roomId) {
      // Open the lobby for a transferable call so only "Join here instead"
      // disconnects another device. All other channels keep one-click joining.
      if (!showRemoteCalls || remoteCalls.get(roomId) !== "handoff") void connectVoiceCall(roomId);
    }
  }, [
    isMobile,
    activeRoomId,
    setMobileNavDrawerOpen,
    setActiveRoomId,
    getRoom,
    connectedVoiceRoomId,
    connectVoiceCall,
    showRemoteCalls,
    remoteCalls,
  ]);

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
      const matchingChats = collected.filter((room) => {
        const target = room.directTargetUserId ?? room.dmPeerUserId;
        return room.isDirect && room.membership === "joined" && target != null
          && normalizeUserId(target) === peerNorm;
      });
      const existingDm = matchingChats.find(isOneToOneChatUi) ?? matchingChats[0];
      const room = existingDm ? getRoom(existingDm.id) ?? existingDm : null;
      const targetId = room?.id ?? pendingDmRoomId(peerUserId);
      const parentSpaceId = room?.parentSpaceIds.find((pid) => joinedSpaceIdSet.has(pid)) ?? null;
      setPendingDm(room ? null : { peerUserId, displayNameHint });
      setActiveSpaceId(parentSpaceId);
      setActiveRoomBySpace((prev) => ({ ...prev, [parentSpaceId ?? ""]: targetId }));
      setComposerFocusRoomId(targetId);
      if (isMobile) setMobileNavDrawerOpen(false);
    },
    [spaces, roomsBySpace, getRoom, joinedSpaceIdSet, isMobile, setMobileNavDrawerOpen],
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
      if (isMobile) setMobileNavDrawerOpen(false);
    },
    [fetchRooms, setActiveRoomId, pendingDm, pendingDmPeerProfile, isMobile, setMobileNavDrawerOpen],
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
        (r) => r.membership === "joined" && !isOneToOneChatUi(r)
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
    const optimisticRooms = [
      ...(payload?.optimisticRooms ?? []),
      ...(payload?.optimisticRoom ? [payload.optimisticRoom] : []),
    ];
    if (optimisticRooms.length > 0) {
      for (const room of optimisticRooms) {
        upsertOptimisticRoom(room);
      }
      if (payload?.openRoomId) {
        const openedRoom = optimisticRooms.find((room) => room.id === payload.openRoomId);
        const parentSpaceId = openedRoom?.parentSpaceIds[0] ?? null;
        setDiscoverOpen(false);
        setActiveSpaceId(parentSpaceId);
        setActiveRoomBySpace((prev) => ({ ...prev, [parentSpaceId ?? ""]: payload.openRoomId! }));
        if (isMobile) setMobileNavDrawerOpen(false);
      }
      void fetchRooms();
      return;
    }

    await fetchRooms();
  }, [fetchRooms, upsertOptimisticRoom, isMobile]);

  const handleLeftRoom = useCallback(
    (roomId: string) => {
      if (directCall?.roomId === roomId) void endDirectCall();
      else if (activeVoiceRoomId === roomId) void disconnectVoiceCall();
      void fetchRooms();
      if (activeRoomId === roomId) {
        setActiveRoomId(null);
      }
    },
    [fetchRooms, activeRoomId, setActiveRoomId, activeVoiceRoomId, disconnectVoiceCall, directCall?.roomId, endDirectCall]
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
      if (directCall && set.has(directCall.roomId)) void endDirectCall();
      else if (activeVoiceRoomId && set.has(activeVoiceRoomId)) void disconnectVoiceCall();
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
      activeVoiceRoomId,
      disconnectVoiceCall,
      directCall,
      endDirectCall,
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

  const mobileRoomDrawerPanelWidth = Math.min(
    roomSidebarWidth,
    Math.max(MIN_ROOM_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.92))
  );
  const mobileNavDrawerTotalWidth = Math.min(
    spacing.spaceSidebarWidth + mobileRoomDrawerPanelWidth,
    typeof window !== "undefined" ? window.innerWidth : spacing.spaceSidebarWidth + mobileRoomDrawerPanelWidth
  );
  const mobileRoomPanelInNavDrawer =
    mobileNavDrawerTotalWidth - spacing.spaceSidebarWidth;
  const roomSidebarWidthApplied = isMobile ? mobileRoomPanelInNavDrawer : roomSidebarWidth;

  const spaceSidebarEl = (
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
      isDiscoverOpen={discoverOpen}
      onToggleDiscover={handleOpenDiscover}
    />
  );

  const directCallRoom = directCall && getRoom(directCall.roomId, true);
  const groupCall = directCall?.transport === "group";
  const { members: callMembers } = useRoomMembers(directCall?.roomId ?? "");
  const peer = callMembers.find(member => member.userId === directCall?.peerUserId);
  const peerName = peer?.displayName || directCall?.peerUserId || "";
  const roomDescribesPeer = directCallRoom && directCallRoom.dmPeerUserId === directCall.peerUserId;
  const directCallName = groupCall ? directCallRoom?.name || "Group chat"
    : roomDescribesPeer ? effectiveDmTitle(directCallRoom) : peerName;
  const callAvatar = roomDescribesPeer ? directCallRoom.avatarUrl : peer?.avatarUrl;
  const quietIncoming = directCall?.phase === "incoming" && directCall.silent;
  useCallNotifications(quietIncoming ? null : directCall, groupCall && directCall.phase === "incoming" ? `${peerName} · ${directCallName}` : directCallName, answerDirectCall, endDirectCallFromNotification,
    !!voiceCall.connectedRoomId || voiceCall.isConnecting);
  const roomSidebarEl = (
    <>
      <RoomSidebar
        width={roomSidebarWidthApplied}
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
        callBar={remoteCallBar ?? (activeVoiceRoomId || voiceCall.disconnectingFromRoomId ? {
          roomName: directCall?.roomId === activeVoiceRoomId && directCallName
            ? directCallName
            : getRoom(activeVoiceRoomId ?? voiceCall.disconnectingFromRoomId!, true)?.name ?? "Voice Call",
          status: voiceCall.disconnectingFromRoomId ? "disconnecting"
            : directCall?.phase === "resuming" || voiceCall.isReconnecting ? "reconnecting"
            : voiceCall.isConnecting ? "connecting"
            : connectedVoiceRoomId || directCall?.phase === "active" ? "connected" : "disconnected",
          detail: directCallPeerConnection === "lost" ? `${directCallName} lost connection`
            : directCallPeerConnection === "interrupted" ? `${directCallName}’s connection was interrupted` : undefined,
          canReconnect: directCall ? !!directCall.established && !directCall.transport : !!targetVoiceRoomId || !!eligibleRecovery,
          onReconnect: reconnectVoiceCall,
          onGoToRoom: activeVoiceRoomId ? () => openJoinedRoom(activeVoiceRoomId) : undefined,
          onDisconnect: disconnectVoiceCall,
        } : undefined)}
        screenSharingOwners={voiceCall.screenSharingOwners}
        voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
        onSetParticipantVolume={voiceCall.setParticipantVolume}
        audioControls={audioControls}
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
        roomBadgeCount={roomBadgeCount}
        onClearInvite={markInviteSeen}
        discoverMode={discoverOpen}
        activeDiscoverServer={activeDiscoverServer}
        discoverHomeserver={currentHomeserver}
        discoverPublicServers={DISCOVER_PUBLIC_SERVERS}
        discoverCustomServers={customDiscoverServers}
        onSelectDiscoverServer={setActiveDiscoverServer}
        onAddDiscoverServer={handleAddDiscoverServer}
      />
      {!isMobile && (
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
      )}
    </>
  );

  const viewingCallRoom = directCall && !discoverOpen && !showingDraftDm && activeRoom?.id === directCall.roomId
    && activeRoom.membership === "joined" && !activeRoom.upgradePending;
  const matrixCallInVoiceRoom = viewingCallRoom && activeRoom.roomType === VOICE_ROOM_TYPE
    && directCall.transport === "matrix" && directCall.phase === "active";
  const inlineCall = viewingCallRoom && (activeRoom.roomType !== VOICE_ROOM_TYPE || matrixCallInVoiceRoom)
    && (directCall.phase !== "incoming" || quietIncoming)
    ? directCall : null;
  const showCallPanel = inlineCall?.phase === "active" && (inlineCall.transport === "matrix" || connectedVoiceRoomId === inlineCall.roomId);
  const directCallStatus = directCall && (
    <DirectCallControls
      call={directCall}
      name={directCallName}
      groupCaller={groupCall ? peerName : undefined}
      avatarUrl={callAvatar}
      isMicEnabled={isDirectCallMicEnabled}
      peerConnection={directCallPeerConnection}
      canMute={directCall.transport === "matrix" || connectedVoiceRoomId === directCall.roomId}
      isReconnecting={voiceCall.isReconnecting && targetVoiceRoomId === directCall.roomId}
      showActions={!showCallPanel || voiceCall.isConnecting}
      onAnswer={() => answerDirectCall()}
      onDecline={declineDirectCall}
      onEnd={endDirectCall}
      onToggleMic={toggleDirectCallMic}
    />
  );
  const inlineCallContent = inlineCall && (
    <>
      {showCallPanel && (
        <VoiceCallPanel
          key={inlineCall.callId}
          roomId={inlineCall.roomId}
          voiceCall={voiceCall}
          matrixMedia={inlineCall.transport === "matrix" ? matrixMedia : undefined}
          onDisconnect={endDirectCall}
          userId={userId}
          groupCall={groupCall}
          participantStates={groupCall ? voiceParticipantStatesByRoom[inlineCall.roomId] : undefined}
          voiceParticipants={groupCall ? callMembers : undefined}
          directCall={groupCall ? undefined : {
            peer: {
              userId: inlineCall.peerUserId,
              displayName: directCallName,
              avatarUrl: callAvatar ?? null,
            },
            peerDeviceId: inlineCall.peerDeviceId,
            peerConnection: directCallPeerConnection,
          }}
        />
      )}
      {directCallStatus}
    </>
  );
  const callUnavailable = (directCall && !quietIncoming) || connectedVoiceRoomId || voiceCall.isConnecting
    ? "End the current call before starting another"
    : activeRoom?.upgradePending || activeRoom?.membership !== "joined" ? "Join the room to call" : undefined;

  const headerCallUnavailable = callUnavailable ?? (
    !(activeDmPeer ? callPermissions?.member : callPermissions?.group) ? "This call is unavailable with the current membership or room permissions" : undefined
  );

  return (
    <PresenceContext.Provider value={{ manualStatus, setManualStatus, effectivePresence, statusMessage, setStatusMessage }}>
      <div style={{
        display: "flex",
        height: "100%",
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
      }}>
        {!isMobile ? spaceSidebarEl : null}
        {!isMobile ? (
          <div style={{ position: "relative", flexShrink: 0, zIndex: 1 }}>{roomSidebarEl}</div>
        ) : (
          <SideDrawer
            open={mobileNavDrawerOpen}
            onClose={() => setMobileNavDrawerOpen(false)}
            side="left"
            widthPx={mobileNavDrawerTotalWidth}
            enableSwipeGesture
            onSwipeOpen={openMobileNavDrawer}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                flex: 1,
                width: "100%",
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              {spaceSidebarEl}
              <div style={{ position: "relative", flexShrink: 0, minWidth: 0, zIndex: 1 }}>
                {roomSidebarEl}
              </div>
            </div>
          </SideDrawer>
        )}
        <main style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          backgroundColor: palette.bgPrimary,
          color: palette.textPrimary,
          display: "flex",
          flexDirection: "column",
          paddingBottom: isMobile ? "env(safe-area-inset-bottom, 0px)" : 0,
        }}>
          {!inlineCall && (!quietIncoming || viewingCallRoom) && directCallStatus}
          {directCallError && <DirectCallError message={directCallError} onDismiss={clearDirectCallError} />}
          <div style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>
            {discoverOpen ? (
              <DiscoverView
                server={activeDiscoverServer}
                discoverServers={discoverServers}
                onJoined={handleSpacesChanged}
              />
            ) : showingDraftDm && pendingDm ? (
              <ChatView
                draftDm={pendingDm}
                onComposerAutoFocus={onComposerAutoFocus}
                userId={userId}
                userMenuWidth={userMenuWidth}
                isMobile={isMobile}
                onUserMenuWidthChange={(next: number) => {
                  const clamped = Math.max(MIN_USER_MENU_WIDTH, Math.min(MAX_USER_MENU_WIDTH, next));
                  setUserMenuWidth(clamped);
                }}
                onStartDirectMessage={handleStartDirectMessage}
                onDraftDmResolved={handleDraftDmResolved}
                onCancelDraftDm={handleCancelDraftDm}
                onOpenNavigation={openMobileNavDrawer}
              />
            ) : activeRoom && activeRoom.membership === "invited" ? (
              <InvitationView room={activeRoom} onJoined={fetchRooms}
                onViewed={mobileNavDrawerOpen || settingsOpen ? undefined : markInviteSeen} />
            ) : matrixCallInVoiceRoom ? (
              inlineCallContent
            ) : activeRoom && !activeRoom.upgradePending && activeRoom.roomType === VOICE_ROOM_TYPE ? (
              <VoiceRoomView
                room={activeRoom}
                voiceCall={{ ...voiceCall, connect: connectVoiceCall }}
                onDisconnect={disconnectVoiceCall}
                voiceParticipants={voiceParticipants[activeRoom.id] ?? []}
                participantStates={voiceParticipantStatesByRoom[activeRoom.id]}
                canReconnect={eligibleRecovery?.roomId === activeRoom.id || targetVoiceRoomId === activeRoom.id}
                canJoin={callPermissions?.join ?? false}
                joinButton={activeRoomRemoteCall?.joinButton}
                userId={userId}
              />
            ) : activeRoom ? (
              <ChatView
                room={activeRoom}
                onComposerAutoFocus={onComposerAutoFocus}
                userId={userId}
                userMenuWidth={userMenuWidth}
                isMobile={isMobile}
                notificationJump={notificationJump}
                onNotificationJumpConsumed={clearNotificationJump}
                onUserMenuWidthChange={(next: number) => {
                  const clamped = Math.max(MIN_USER_MENU_WIDTH, Math.min(MAX_USER_MENU_WIDTH, next));
                  setUserMenuWidth(clamped);
                }}
                onStartDirectMessage={handleStartDirectMessage}
                onCallMember={callUnavailable || !callPermissions?.member ? undefined : (user) => placeDirectCall(activeRoom.id, user, { memberCall: true })}
                onStartCall={headerCallUnavailable || !activeRoom.isDirect ? undefined : (video) => {
                  if (activeDmPeer) placeDirectCall(activeRoom.id, activeDmPeer, { video });
                  else { abandonVoiceChannel(); startGroupCall(activeRoom.id, userId, video); }
                }}
                callUnavailable={headerCallUnavailable}
                callContent={inlineCallContent}
                moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
                moderationSpaceName={moderationSpaceName}
                onOpenNavigation={openMobileNavDrawer}
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
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                color: palette.textSecondary,
                gap: isMobile ? spacing.unit * 2 : 0,
              }}>
                Select a room
                {isMobile ? (
                  <NavBackButton onClick={openMobileNavDrawer} palette={palette} />
                ) : null}
              </div>
            )}
          </div>
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
