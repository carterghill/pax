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
import { PresenceContext } from "../hooks/PresenceContext";
import { useState, useCallback, useMemo, useEffect, startTransition } from "react";
import { useTheme } from "../theme/ThemeContext";
import SettingsDialog from "../components/SettingsDialog";
import {
  VOICE_ROOM_TYPE,
  compareByDisplayThenKey,
  pendingDmRoomId,
  voiceStateLookupKeysForLiveKitIdentity,
} from "../utils/matrix";
import { useLivekitVoiceSnapshots } from "../hooks/useLivekitVoiceSnapshots";
import { useMatrixUserProfile } from "../hooks/useMatrixUserProfile";
import { useUserAvatar } from "../hooks/useUserAvatar";
import { useResizeHandle } from "../hooks/useResizeHandle";

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

  const topLevelSpaces = useMemo(
    () =>
      spaces.filter((s) => !s.parentSpaceIds.some((pid) => joinedSpaceIdSet.has(pid))),
    [spaces, joinedSpaceIdSet]
  );

  const { manualStatus, setManualStatus, effectivePresence } = usePresence();
  const voiceCall = useVoiceCall();
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

  const childJoinedSubspaces = useMemo(() => {
    if (!activeSpaceId) return [];
    return spaces
      .filter(
        (s) =>
          s.isSpace &&
          s.membership === "joined" &&
          s.parentSpaceIds.includes(activeSpaceId)
      )
      .sort((a, b) => compareByDisplayThenKey(a.name, a.id, b.name, b.id));
  }, [spaces, activeSpaceId]);

  const subSpaceRoomIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const ss of childJoinedSubspaces) {
      for (const r of roomsBySpace(ss.id)) {
        set.add(r.id);
      }
    }
    return set;
  }, [childJoinedSubspaces, roomsBySpace]);

  const visibleRooms = useMemo(() => {
    let base: Room[];
    if (!activeSpaceId) {
      base = roomsBySpace(activeSpaceId);
    } else {
      base = roomsBySpace(activeSpaceId).filter((r) => !subSpaceRoomIdSet.has(r.id));
    }
    if (!activeSpaceId && pendingDm) {
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
        return merged;
      }
    }
    // Patch any room that was just created as a DM but hasn't been marked isDirect by sync yet
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
    activeSpaceId,
    pendingDm,
    pendingDmPeerProfile.displayName,
    pendingDmPeerProfile.avatarUrl,
    roomsBySpace,
    subSpaceRoomIdSet,
    dmTransitionHint,
  ]);

  const subSpaceSections = useMemo(
    () =>
      childJoinedSubspaces.map((subSpace) => ({
        subSpace,
        rooms: roomsBySpace(subSpace.id).sort((a, b) =>
          compareByDisplayThenKey(a.name, a.id, b.name, b.id)
        ),
      })),
    [childJoinedSubspaces, roomsBySpace]
  );

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

  // Collect voice room IDs in the current space for participant tracking
  const voiceRoomIds = useMemo(() => {
    const ids: string[] = [];
    const pushVoice = (list: typeof visibleRooms) => {
      for (const r of list) {
        if (r.roomType === VOICE_ROOM_TYPE) ids.push(r.id);
      }
    };
    pushVoice(visibleRooms);
    for (const { rooms } of subSpaceSections) pushVoice(rooms);
    return ids;
  }, [visibleRooms, subSpaceSections]);
  const voiceParticipants = useVoiceParticipants(voiceRoomIds);
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

  const handleStartDirectMessage = useCallback((peerUserId: string, displayNameHint: string) => {
    const draftId = pendingDmRoomId(peerUserId);
    startTransition(() => {
      setPendingDm({ peerUserId, displayNameHint });
      setActiveSpaceId(null);
      setActiveRoomBySpace((prev) => ({ ...prev, "": draftId }));
    });
  }, []);

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

  return (
    <PresenceContext.Provider value={{ manualStatus, setManualStatus, effectivePresence }}>
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
          activeSpaceId={activeSpaceId}
          spaceHighlightId={spaceSidebarHighlightId}
          onSelectSpace={handleSelectSpace}
          onSpacesChanged={handleSpacesChanged}
          onOpenSettings={handleOpenSettings}
          userId={userId}
          onLeftSpace={handleLeftSpace}
        />
        <div style={{ position: "relative", flexShrink: 0, zIndex: 1 }}>
          <RoomSidebar
            width={roomSidebarWidth}
            rooms={visibleRooms}
            subSpaceSections={subSpaceSections}
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