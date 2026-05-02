import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import UserAvatar from "./UserAvatar";
import {
  Hash,
  House,
  ArrowLeft,
  Volume2,
  Monitor,
  MicOff,
  Headphones,
  Slash,
  Loader2,
  UserPlus,
  Plus,
  ChevronRight,
  ChevronDown,
  ExternalLink,
} from "lucide-react";
import { Room, VoiceParticipant } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import StatusDropdown from "./StatusDropdown";
import VolumeContextMenu from "./VolumeContextMenu";
import RoomContextMenu from "./RoomContextMenu";
import RoomSettingsDialog from "./RoomSettingsDialog";
import { collectRoomIdsInSpaceTree } from "../utils/spaceModeration";
import InviteDialog from "./InviteDialog";
import LeaveConfirmDialog from "./LeaveConfirmDialog";
import ParentSpacesDialog from "./ParentSpacesDialog";
import CreateRoomDialog from "./CreateRoomDialog";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import { useUserVolume } from "../hooks/useUserVolume";
import { dmPresenceDotColor, effectiveDmTitle, isDmChatUi } from "../utils/dmDisplay";
import { resolvePresenceWithDnd, parseStatusMsg } from "../utils/statusMessage";
import {
  VOICE_ROOM_TYPE,
  isPendingDmRoomId,
  normalizeUserId,
  parsePendingDmPeerUserId,
  voiceStateLookupKeysForParticipant,
} from "../utils/matrix";
import {
  buildReorderPlan,
  type SpaceChildOrderWrite,
} from "../utils/spaceChildOrdering";

/** DM peer circle in the channel list (slightly larger than default 16px icons). */
const DM_SIDEBAR_AVATAR_PX = 28;

function resolveVoiceStateForRoom(
  participant: VoiceParticipant,
  roomStateMap: Record<
    string,
    { isMuted: boolean; isDeafened: boolean; isSpeaking: boolean }
  >
) {
  for (const key of voiceStateLookupKeysForParticipant(participant)) {
    const state = roomStateMap[key];
    if (state) return state;
  }
  return undefined;
}

/**
 * Wrapper that adds drag + drop-indicator visuals to any row (room or
 * sub-space header).  The row's own click handlers still work through the
 * wrapper; we only intercept drag events.  Insertion indicator is drawn
 * above the wrapper when `showIndicatorAbove` is true, and immediately
 * below when `showIndicatorBelowLast` is true (last-in-list + drop-at-end
 * case).
 */
function DraggableRow({
  draggable,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  isBeingDragged,
  showIndicatorAbove,
  showIndicatorBelowLast,
  indicatorColor,
  children,
  style,
}: {
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isBeingDragged: boolean;
  showIndicatorAbove: boolean;
  showIndicatorBelowLast: boolean;
  indicatorColor: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        position: "relative",
        opacity: isBeingDragged ? 0.4 : 1,
        transition: "opacity 0.08s linear",
        cursor: draggable ? "grab" : undefined,
        ...style,
      }}
    >
      {/* Insertion indicators get their own minimal `dragover` handler
          (preventDefault only — no state changes).  WebView2/Chromium
          don't reliably skip absolutely-positioned elements during drag
          hit-testing even with `pointer-events: none`, so without this
          the cursor would briefly flicker to the deny icon while crossing
          the indicator's pixels.  The `onDrop` is the parent row's drop
          handler, so a drop on the indicator uses the already-correct
          `dropIndicator` state set by the surrounding rows. */}
      {showIndicatorAbove && (
        <div
          aria-hidden
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDrop}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: -2,
            height: 2,
            borderRadius: 1,
            backgroundColor: indicatorColor,
            zIndex: 1,
          }}
        />
      )}
      {children}
      {showIndicatorBelowLast && (
        <div
          aria-hidden
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={onDrop}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -2,
            height: 2,
            borderRadius: 1,
            backgroundColor: indicatorColor,
            zIndex: 1,
          }}
        />
      )}
    </div>
  );
}

export type RoomSidebarSubSpaceSection = { subSpace: Room; rooms: Room[] };

interface RoomSidebarProps {
  width: number;
  /**
   * Items to render in the room list.  When the user is on Home (no active
   * space), this is the list of Home-bucket rooms.  When inside an active
   * space, this is the unified list of that space's direct children
   * (sub-space headers AND direct rooms, interleaved per the active
   * space's `m.space.child` order so the visual position matches Matrix's
   * stored order in every case).  Each item dispatches at render time:
   * `isSpace === true` renders as a sub-space header (with an expandable
   * interior fed by {@link getSubSpaceRoomsOrdered}); otherwise it
   * renders as a regular channel row.
   */
  rooms: Room[];
  /**
   * Look up the rooms inside a given sub-space, sorted by that sub-space's
   * own `m.space.child` order with optimistic overrides applied.  Called
   * lazily when a sub-space header is rendered so collapsed sections
   * don't pay the sort cost.
   */
  getSubSpaceRoomsOrdered: (subSpaceId: string) => Room[];
  getRoom: (roomId: string) => Room | null;
  /** Optional: open sub-space home (small control only; row click toggles expand/collapse). */
  onOpenSubSpace?: (spaceId: string) => void;
  activeRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  /** Clears room selection so the joined space home is shown (same as re-clicking the space). */
  onSelectSpaceHome: () => void;
  isSpaceHomeActive: boolean;
  showSpaceHomeNav: boolean;
  spaceName: string;
  /** When set, show an invite button in the header for this space (Matrix room id). */
  spaceInviteId?: string | null;
  userId: string;
  userAvatarUrl: string | null;
  voiceParticipants: Record<string, VoiceParticipant[]>;
  connectedVoiceRoomId: string | null;
  isVoiceConnecting: boolean;
  disconnectingFromRoomId: string | null;
  screenSharingOwners: string[];
  /** Per Matrix voice room id: lookup keys → mute/deafen/speaking (LiveKit snapshot + in-call overlay). */
  voiceParticipantStatesByRoom: Record<
    string,
    Record<string, { isMuted: boolean; isDeafened: boolean; isSpeaking: boolean }>
  >;
  onSetParticipantVolume: (identity: string, volume: number, source: string) => void;
  /** Called after successfully leaving a room from the context menu */
  onLeftRoom?: (roomId: string) => void;
  /** Active space (for moderation scope in room settings when the room is in its tree). */
  activeSpaceId: string | null;
  roomsBySpace: (spaceId: string | null) => Room[];
  /** Global home list (no space): show add/join room above DMs and rooms. */
  showHomeAddRoom?: boolean;
  onRoomsChanged?: (payload?: RoomsChangedPayload) => void | Promise<void>;
  /** When the active space is a sub-space, show back navigation above Home. */
  parentSpace?: { id: string; name: string } | null;
  onNavigateToParentSpace?: () => void;
  /**
   * Returns true when a room should be painted in the primary colour even if
   * it's not currently selected — i.e. there are unread messages in it.  Should
   * come from `useUnreadRooms` (mounted in `MainLayout`).
   */
  isUnread: (roomId: string) => boolean;
  /**
   * Highlight / mention count for the room.  When > 0 we render a small red
   * pill next to the room name (Discord-style).
   */
  mentionCount: (roomId: string) => number;
  /**
   * Whether the current user may rewrite `m.space.child` state events in the
   * currently-active space (pre-resolved in `MainLayout`).  Used to gate
   * drag-to-reorder for top-level rooms and sub-space headers.  Interior
   * reorders (rooms inside a sub-space) use a lazily-resolved per-sub-space
   * permission check, since they target a different parent.
   */
  canManageActiveSpaceChildren?: boolean;
  /**
   * Apply a batch of `m.space.child` `order` updates for a given parent
   * space, in the order produced by `buildReorderPlan`.  Parent passes this
   * so failures can be logged/retried at the layout level and so a single
   * `fetchRooms()` pulls the new order back consistently.
   */
  onReorderSpaceChildren?: (
    parentSpaceId: string,
    writes: SpaceChildOrderWrite[]
  ) => void | Promise<void>;
  /**
   * Set of child room/sub-space ids whose `m.space.child` order write is
   * still in flight (optimistic update applied locally; homeserver round-
   * trip not yet resolved).  These render dimmed and are temporarily
   * un-draggable to prevent the user from kicking off a follow-up reorder
   * that would race the in-flight one.  Cleared by the layout-level
   * handler once `fetchRooms()` returns.
   */
  pendingReorderIds?: ReadonlySet<string>;
}

function VoiceParticipantRow({
  participant,
  isLocalUser,
  isSharingScreen,
  isMuted,
  isDeafened,
  isSpeaking,
  isConnecting,
  onContextMenu,
}: {
  participant: VoiceParticipant;
  isLocalUser: boolean;
  isSharingScreen: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  isConnecting: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { palette, spacing, typography } = useTheme();
  const name = participant.displayName ?? participant.userId;

  return (
    <div
      onContextMenu={(e) => {
        if (!isLocalUser) {
          e.preventDefault();
          onContextMenu(e);
        }
      }}
      style={{
      display: "flex",
      alignItems: "center",
      gap: spacing.unit * 2,
      padding: `${spacing.unit}px ${spacing.unit * 3}px ${spacing.unit}px ${spacing.unit * 8}px`,
      fontSize: typography.fontSizeSmall,
      color: palette.textSecondary,
      cursor: isLocalUser ? "default" : "context-menu",
    }}>
      <UserAvatar
        userId={participant.userId}
        displayName={name}
        avatarUrlHint={participant.avatarUrl}
        size={20}
        fontSize={10}
        style={{
          boxSizing: "border-box",
          boxShadow: isSpeaking ? "0 0 0 2px #23a55a" : "none",
          transition: "box-shadow 0.15s ease",
        }}
      />
      <span style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        flex: 1,
      }}>
        {name}
      </span>
      <span style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "center",
        gap: spacing.unit,
        flexShrink: 0,
      }}>
        {isConnecting && (
          <Loader2
            size={12}
            color={palette.textSecondary}
            style={{ animation: "spin 1s linear infinite" }}
          />
        )}
        {isSharingScreen && <Monitor size={12} color="#23a55a" />}
        {isMuted && <MicOff size={12} color={palette.textSecondary} />}
        {isDeafened && (
          <span style={{ position: "relative", width: 12, height: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <Headphones size={12} color={palette.textSecondary} />
            <Slash size={10} color={palette.textSecondary} style={{ position: "absolute" }} />
          </span>
        )}
      </span>
    </div>
  );
}

function ChannelBlock({
  room,
  activeRoomId,
  userId,
  onSelectRoom,
  onRoomContextMenu,
  voiceParticipants,
  connectedVoiceRoomId,
  isVoiceConnecting,
  disconnectingFromRoomId,
  screenSharingOwners,
  voiceParticipantStatesByRoom,
  onParticipantContextMenu,
  peerPresenceByUserId,
  peerStatusMsgByUserId,
  palette,
  spacing,
  typography,
  indent = false,
  isUnread,
  mentionCount,
}: {
  room: Room;
  activeRoomId: string | null;
  userId: string;
  onSelectRoom: (roomId: string) => void;
  onRoomContextMenu: (roomId: string, roomName: string, e: React.MouseEvent) => void;
  voiceParticipants: Record<string, VoiceParticipant[]>;
  connectedVoiceRoomId: string | null;
  isVoiceConnecting: boolean;
  disconnectingFromRoomId: string | null;
  screenSharingOwners: string[];
  voiceParticipantStatesByRoom: Record<
    string,
    Record<string, { isMuted: boolean; isDeafened: boolean; isSpeaking: boolean }>
  >;
  onParticipantContextMenu: (
    e: React.MouseEvent,
    identity: string,
    displayName: string
  ) => void;
  /** Live presence from sync (`presence` events), keyed by normalized user id. */
  peerPresenceByUserId: Record<string, string>;
  /** Live status_msg from sync, keyed by normalized user id. */
  peerStatusMsgByUserId: Record<string, string | null>;
  palette: ReturnType<typeof useTheme>["palette"];
  spacing: ReturnType<typeof useTheme>["spacing"];
  typography: ReturnType<typeof useTheme>["typography"];
  indent?: boolean;
  isUnread: (roomId: string) => boolean;
  mentionCount: (roomId: string) => number;
}) {
  const isVoice = room.roomType === VOICE_ROOM_TYPE;
  const isDraftDmRow = isPendingDmRoomId(room.id);
  const dmPeerId = room.dmPeerUserId ?? parsePendingDmPeerUserId(room.id) ?? room.id;
  const rawPeerPresence =
    peerPresenceByUserId[normalizeUserId(dmPeerId)] ?? room.dmPeerPresence ?? "offline";
  const peerStatusMsg =
    peerStatusMsgByUserId[normalizeUserId(dmPeerId)] ?? room.dmPeerStatusMsg ?? null;
  const dmPeerPresenceLive = resolvePresenceWithDnd(rawPeerPresence, peerStatusMsg);
  const peerStatusText = parseStatusMsg(peerStatusMsg).text;
  const participants = isVoice ? (voiceParticipants[room.id] ?? []) : [];
  const isConnectedHere = connectedVoiceRoomId === room.id;
  const padLeft = indent ? spacing.unit * 6 : spacing.unit * 3;
  const roomTitle = isDmChatUi(room) ? effectiveDmTitle(room) : room.name;
  const titleFadePx = 20;
  const titleFadeMask = `linear-gradient(to right, #000 calc(100% - ${titleFadePx}px), transparent)`;

  // "Highlighted" = should be painted in the primary foreground colour rather
  // than the muted secondary.  True when the room is currently selected OR has
  // unread messages.  Discord-style: selected rooms and unread rooms share the
  // same bright label treatment, with the selected one additionally getting the
  // bgActive background so you can still tell which one you're looking at.
  const isActive = activeRoomId === room.id;
  const hasUnread = isUnread(room.id);
  const isHighlighted = isActive || hasUnread;
  const unreadMentions = mentionCount(room.id);
  const labelColor = isHighlighted ? palette.textHeading : palette.textSecondary;

  return (
    <div>
      <div
        onClick={() => onSelectRoom(room.id)}
        onContextMenu={(e) => {
          if (isDraftDmRow) return;
          onRoomContextMenu(room.id, room.name, e);
        }}
        style={{
          padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
          paddingLeft: padLeft,
          borderRadius: spacing.unit,
          cursor: "pointer",
          color: labelColor,
          backgroundColor: isActive ? palette.bgActive : "transparent",
          fontSize: typography.fontSizeBase,
          fontWeight:
            isHighlighted
              ? typography.fontWeightMedium
              : typography.fontWeightNormal,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            minWidth: 0,
            width: "100%",
          }}
        >
          {isVoice ? (
            <Volume2
              size={16}
              color={
                isConnectedHere
                  ? "#23a55a"
                  : isHighlighted
                    ? palette.textHeading
                    : palette.textSecondary
              }
            />
          ) : isDmChatUi(room) ? (
            <div
              style={{
                position: "relative",
                width: DM_SIDEBAR_AVATAR_PX,
                height: DM_SIDEBAR_AVATAR_PX,
                flexShrink: 0,
              }}
            >
              <UserAvatar
                userId={dmPeerId}
                displayName={effectiveDmTitle(room)}
                avatarUrlHint={room.isDirect ? room.avatarUrl : undefined}
                size={DM_SIDEBAR_AVATAR_PX}
                fontSize={13}
              />
              {room.membership === "joined" && !!room.dmPeerUserId && (
                <span
                  title={dmPeerPresenceLive}
                  style={{
                    position: "absolute",
                    bottom: -1,
                    right: -1,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: dmPresenceDotColor(dmPeerPresenceLive),
                    border: `2px solid ${palette.bgSecondary}`,
                    boxSizing: "border-box",
                  }}
                />
              )}
            </div>
          ) : (
            <Hash
              size={16}
              color={isHighlighted ? palette.textHeading : palette.textSecondary}
            />
          )}
          <div
            title={roomTitle}
            style={{
              marginLeft: spacing.unit,
              color: isConnectedHere ? "#23a55a" : undefined,
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              whiteSpace: "nowrap",
              maskImage: titleFadeMask,
              WebkitMaskImage: titleFadeMask,
            }}
          >
            {roomTitle}
            {isDmChatUi(room) && peerStatusText && (
              <div style={{
                fontSize: typography.fontSizeSmall - 1,
                color: palette.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                lineHeight: 1.2,
              }}>
                {peerStatusText}
              </div>
            )}
          </div>
          {unreadMentions > 0 && (
            <span
              aria-label={`${unreadMentions} unread mention${unreadMentions === 1 ? "" : "s"}`}
              style={{
                flexShrink: 0,
                minWidth: 18,
                height: 18,
                padding: "0 6px",
                borderRadius: 9,
                backgroundColor: "#f23f43",
                color: "#ffffff",
                fontSize: 11,
                fontWeight: typography.fontWeightBold,
                lineHeight: "18px",
                textAlign: "center",
                boxSizing: "border-box",
              }}
            >
              {unreadMentions > 99 ? "99+" : unreadMentions}
            </span>
          )}
        </span>
      </div>

      {isVoice && participants.length > 0 && (
        <div style={{ paddingBottom: spacing.unit }}>
          {participants.map((p) => {
            const state = resolveVoiceStateForRoom(
              p,
              voiceParticipantStatesByRoom[room.id] ?? {}
            );
            const isLocalConnecting =
              isConnectedHere && p.userId === userId && isVoiceConnecting;
            const isLocalDisconnecting =
              room.id === disconnectingFromRoomId && p.userId === userId;
            const isRemoteConnecting =
              isConnectedHere && !isVoiceConnecting && p.userId !== userId && !state;
            const isParticipantConnecting =
              isLocalConnecting || isLocalDisconnecting || isRemoteConnecting;
            return (
              <VoiceParticipantRow
                key={p.userId}
                participant={p}
                isLocalUser={p.userId === userId}
                isSharingScreen={screenSharingOwners.includes(p.userId)}
                isMuted={!!state?.isMuted}
                isDeafened={!!state?.isDeafened}
                isSpeaking={!!state?.isSpeaking}
                isConnecting={isParticipantConnecting}
                onContextMenu={(e) => {
                  onParticipantContextMenu(e, p.userId, p.displayName ?? p.userId);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RoomSidebar({
  width,
  rooms,
  getSubSpaceRoomsOrdered,
  getRoom,
  onOpenSubSpace,
  activeRoomId,
  onSelectRoom,
  onSelectSpaceHome,
  isSpaceHomeActive,
  showSpaceHomeNav,
  spaceName,
  spaceInviteId,
  userId,
  userAvatarUrl,
  voiceParticipants,
  connectedVoiceRoomId,
  isVoiceConnecting,
  disconnectingFromRoomId,
  screenSharingOwners,
  voiceParticipantStatesByRoom,
  onSetParticipantVolume,
  onLeftRoom,
  activeSpaceId,
  roomsBySpace,
  showHomeAddRoom = false,
  onRoomsChanged,
  parentSpace = null,
  onNavigateToParentSpace,
  isUnread,
  mentionCount,
  canManageActiveSpaceChildren = false,
  onReorderSpaceChildren,
  pendingReorderIds,
}: RoomSidebarProps) {
  const { palette, spacing, typography } = useTheme();
  /** Sub-space id → expanded; absence means expanded (default open). */
  const [subSpaceExpanded, setSubSpaceExpanded] = useState<Record<string, boolean>>({});
  const { getVolume, setVolume } = useUserVolume();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    identity: string;
    displayName: string;
  } | null>(null);
  const [roomContextMenu, setRoomContextMenu] = useState<{
    x: number;
    y: number;
    roomId: string;
    roomName: string;
  } | null>(null);
  const [settingsRoomId, setSettingsRoomId] = useState<string | null>(null);
  const [inviteRoom, setInviteRoom] = useState<{ id: string; name: string } | null>(null);
  const [inviteSpaceFromHeader, setInviteSpaceFromHeader] = useState<{ id: string; name: string } | null>(
    null
  );
  const [leaveRoom, setLeaveRoom] = useState<{ id: string; name: string } | null>(null);
  const [leaveRoomError, setLeaveRoomError] = useState<string | null>(null);
  const [leaveRoomSubmitting, setLeaveRoomSubmitting] = useState(false);
  const [parentSpacesRoom, setParentSpacesRoom] = useState<{ id: string; name: string } | null>(null);
  const [showAddRoomDialog, setShowAddRoomDialog] = useState(false);
  const settingsRoom = settingsRoomId ? getRoom(settingsRoomId) : null;

  useEffect(() => {
    if (!showHomeAddRoom) setShowAddRoomDialog(false);
  }, [showHomeAddRoom]);

  const moderationSpaceTreeRoomIds = useMemo(() => {
    if (!settingsRoom || settingsRoom.isDirect) return null;
    if (!activeSpaceId) return null;
    const inTree =
      settingsRoom.id === activeSpaceId ||
      settingsRoom.parentSpaceIds.includes(activeSpaceId);
    if (!inTree) return null;
    return collectRoomIdsInSpaceTree(activeSpaceId, roomsBySpace);
  }, [settingsRoom, activeSpaceId, roomsBySpace]);

  const moderationSpaceRootId =
    settingsRoom &&
    activeSpaceId &&
    !settingsRoom.isDirect &&
    (settingsRoom.id === activeSpaceId || settingsRoom.parentSpaceIds.includes(activeSpaceId))
      ? activeSpaceId
      : null;

  const moderationSpaceName =
    moderationSpaceRootId && activeSpaceId
      ? getRoom(activeSpaceId)?.name ?? null
      : null;

  /** Live DM peer presence from sync (same `presence` event as space home / member list). */
  const [peerPresenceByUserId, setPeerPresenceByUserId] = useState<Record<string, string>>({});
  const [peerStatusMsgByUserId, setPeerStatusMsgByUserId] = useState<Record<string, string | null>>({});
  useEffect(() => {
    const unlisten = listen<{ userId: string; presence: string; statusMsg: string | null }>("presence", (event) => {
      const { userId, presence, statusMsg } = event.payload;
      const key = normalizeUserId(userId);
      setPeerPresenceByUserId((prev) => ({ ...prev, [key]: presence }));
      setPeerStatusMsgByUserId((prev) => ({ ...prev, [key]: statusMsg ?? null }));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const isSubSpaceExpanded = (id: string) => subSpaceExpanded[id] !== false;

  const toggleSubSpace = useCallback((spaceId: string) => {
    setSubSpaceExpanded((prev) => {
      const cur = prev[spaceId] !== false;
      return { ...prev, [spaceId]: !cur };
    });
  }, []);

  // ------ Drag-and-drop state (room / sub-space reordering) ------
  //
  // Unlike the space sidebar (user-level, account data), reordering rooms
  // and sub-spaces inside a space writes `m.space.child` events — the
  // admin-set, federated Matrix standard.  Only users with sufficient
  // power level in the relevant space may drag.
  //
  // Two drag scopes, each with its own parent space:
  //   1. Direct children of the active space (sub-space headers AND
  //      direct rooms — they share Matrix's `m.space.child` order
  //      namespace under the active space, so they're freely
  //      interleavable in the unified `rooms` list).
  //                                              → parent = activeSpaceId
  //   2. Rooms inside a specific sub-space      → parent = that sub-space
  //
  // A drag is always constrained to its original bucket: you cannot drag a
  // room out of a sub-space into the top-level list — that would imply
  // reparenting (a `m.space.child` add+remove), which is a different
  // Matrix operation than reordering.  We enforce this by embedding the
  // parent id into the drag state and rejecting cross-scope drops.
  interface ActiveDrag {
    /** Matrix room id of the dragged child (room or sub-space). */
    childId: string;
    /** Parent space whose `m.space.child` event we'd write on drop. */
    parentSpaceId: string;
    /** Scope — used to only show drop indicators in matching rows. */
    scope: "activeSpaceChild" | "subSpaceRoom";
    /** When scope === "subSpaceRoom", which sub-space's room list. */
    subSpaceId?: string;
  }

  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  /**
   * Drop-indicator position: "before this child id" / sentinel "end".
   * Paired with the drag scope so sub-space-room indicators don't leak into
   * the top-level list or vice versa.
   */
  const [dropIndicator, setDropIndicator] = useState<{
    beforeId: string | "end";
    scope: ActiveDrag["scope"];
    subSpaceId?: string;
  } | null>(null);

  /**
   * Permission cache for dragging inside each sub-space's room list.
   * Top-level drag permission comes from `canManageActiveSpaceChildren`
   * (resolved once in MainLayout).  Sub-space interiors require a per-
   * sub-space check because each is its own Matrix room with its own
   * power-level state.  We resolve lazily on first interaction and cache
   * for the session; stale cache on power-level changes is not a critical
   * issue (the homeserver will still reject unauthorised writes and we
   * show the error via the existing toast path in `handleReorderSpaceChildren`).
   */
  const [subSpaceCanManage, setSubSpaceCanManage] = useState<Record<string, boolean>>({});
  const subSpaceCanManageRef = useRef(subSpaceCanManage);
  subSpaceCanManageRef.current = subSpaceCanManage;

  const ensureSubSpacePermission = useCallback((subSpaceId: string) => {
    if (subSpaceCanManageRef.current[subSpaceId] !== undefined) return;
    invoke<boolean>("can_manage_space_children", { spaceId: subSpaceId })
      .then((v) => {
        setSubSpaceCanManage((prev) => ({ ...prev, [subSpaceId]: v }));
      })
      .catch(() => {
        setSubSpaceCanManage((prev) => ({ ...prev, [subSpaceId]: false }));
      });
  }, []);

  /**
   * Compute insertion position for a drag-over on a row.  Returns either
   * the child id immediately after the insertion (so the indicator renders
   * above that row) or "end" when dropping past the last row.  Returns
   * `null` when the insertion would be a no-op (dropping on itself or
   * immediately next to itself).
   */
  const computeInsertBeforeId = useCallback(
    (
      e: React.DragEvent,
      rowChildId: string,
      siblingsOrdered: string[],
      draggedChildId: string
    ): string | "end" | null => {
      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midpoint;
      const idx = siblingsOrdered.indexOf(rowChildId);
      if (idx < 0) return null;
      let target: string | "end";
      if (insertBefore) {
        target = rowChildId;
      } else if (idx === siblingsOrdered.length - 1) {
        target = "end";
      } else {
        target = siblingsOrdered[idx + 1];
      }
      // Filter no-ops: dropping on self or immediately next to self
      // (the slot the dragged item already occupies).
      if (target === draggedChildId) return null;
      if (target !== "end") {
        const targetIdx = siblingsOrdered.indexOf(target);
        if (targetIdx > 0 && siblingsOrdered[targetIdx - 1] === draggedChildId) {
          return null;
        }
      } else {
        if (siblingsOrdered[siblingsOrdered.length - 1] === draggedChildId) {
          return null;
        }
      }
      return target;
    },
    []
  );

  /**
   * Kick off a drag for a child row.  `scope` and `subSpaceId` together
   * identify which Matrix parent the drop would write to.
   */
  const handleChildDragStart = useCallback(
    (
      e: React.DragEvent,
      childId: string,
      scope: ActiveDrag["scope"],
      subSpaceId?: string
    ) => {
      // Block drag while a previous reorder for this child is still
      // mid-flight — re-dragging during the pending window would race
      // the still-resolving optimistic update and could land the user
      // with a confusing intermediate order.
      if (pendingReorderIds && pendingReorderIds.has(childId)) {
        console.warn(`[drag] blocked: ${childId} is pending reorder`);
        e.preventDefault();
        return;
      }

      // Work out the parent space for the drop.
      let parentSpaceId: string | null;
      if (scope === "subSpaceRoom") {
        parentSpaceId = subSpaceId ?? null;
      } else {
        parentSpaceId = activeSpaceId;
      }
      if (!parentSpaceId) {
        console.warn(`[drag] blocked: no parentSpaceId (scope=${scope}, activeSpaceId=${activeSpaceId})`);
        return;
      }

      // Gate on permission — for the active-space scope we use the
      // layout-level resolved flag; for sub-space interiors we
      // lazy-resolve and fall back to rejecting the drag if not yet
      // resolved (next attempt will succeed).
      let allowed = false;
      if (scope === "subSpaceRoom") {
        const cached = subSpaceCanManageRef.current[parentSpaceId];
        if (cached === undefined) {
          console.warn(`[drag] blocked: permission not yet resolved for sub-space ${parentSpaceId}`);
          ensureSubSpacePermission(parentSpaceId);
          e.preventDefault();
          return;
        }
        allowed = cached;
      } else {
        allowed = canManageActiveSpaceChildren;
      }
      if (!allowed) {
        console.warn(`[drag] blocked: no permission (scope=${scope}, canManage=${canManageActiveSpaceChildren})`);
        e.preventDefault();
        return;
      }

      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", childId);
      } catch {
        /* ignore */
      }
      setActiveDrag({ childId, parentSpaceId, scope, subSpaceId });
      setDropIndicator(null);
    },
    [activeSpaceId, canManageActiveSpaceChildren, ensureSubSpacePermission, pendingReorderIds]
  );

  const handleChildDragEnd = useCallback(() => {
    setActiveDrag(null);
    setDropIndicator(null);
  }, []);

  /**
   * Drag-over on a row: figure out where the drop indicator should render
   * and update state.  Scope-matched: a top-level room drag hovering over
   * a sub-space room row is a no-op (indicator stays null).
   */
  const handleRowDragOver = useCallback(
    (
      e: React.DragEvent,
      rowChildId: string,
      rowScope: ActiveDrag["scope"],
      rowSubSpaceId: string | undefined,
      siblingsOrdered: string[]
    ) => {
      if (!activeDrag) return;
      if (activeDrag.scope !== rowScope) return;
      if (rowScope === "subSpaceRoom" && activeDrag.subSpaceId !== rowSubSpaceId) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = computeInsertBeforeId(
        e,
        rowChildId,
        siblingsOrdered,
        activeDrag.childId
      );
      if (target === null) {
        setDropIndicator(null);
        return;
      }
      setDropIndicator((prev) => {
        if (
          prev &&
          prev.beforeId === target &&
          prev.scope === rowScope &&
          prev.subSpaceId === rowSubSpaceId
        ) {
          return prev;
        }
        return { beforeId: target, scope: rowScope, subSpaceId: rowSubSpaceId };
      });
    },
    [activeDrag, computeInsertBeforeId]
  );

  /**
   * Drop on a row: build the reorder plan and hand it to the parent.  We
   * always target the parent space embedded in the drag state (so a bad
   * target-row computation can never silently write to the wrong space).
   */
  const handleRowDrop = useCallback(
    (
      e: React.DragEvent,
      siblingsOrderedRooms: Room[]
    ) => {
      e.preventDefault();
      const drag = activeDrag;
      const indicator = dropIndicator;
      setActiveDrag(null);
      setDropIndicator(null);
      if (!drag || !indicator || !onReorderSpaceChildren) return;
      if (drag.scope !== indicator.scope) return;
      if (drag.scope === "subSpaceRoom" && drag.subSpaceId !== indicator.subSpaceId) {
        return;
      }

      // `buildReorderPlan` takes the drop target directly — the row the
      // user is hovering immediately above, or `null` to mean "append to
      // the end".
      const beforeChildId =
        indicator.beforeId === "end" ? null : indicator.beforeId;

      console.log(
        `[drop] scope=${drag.scope} dragged=${drag.childId} before=${beforeChildId} parent=${drag.parentSpaceId}`,
        `\n  siblings:`,
        siblingsOrderedRooms.map((r) => ({
          id: r.id.slice(0, 12),
          name: r.name,
          order: r.spaceChildOrders?.[drag.parentSpaceId]?.order ?? "(none)",
          isSpace: r.isSpace,
        }))
      );

      const plan = buildReorderPlan(
        siblingsOrderedRooms,
        drag.childId,
        beforeChildId,
        drag.parentSpaceId
      );

      console.log(`[drop] plan: ${plan.writes.length} writes`, plan.writes);

      if (plan.writes.length === 0) return;
      void onReorderSpaceChildren(drag.parentSpaceId, plan.writes);
    },
    [activeDrag, dropIndicator, onReorderSpaceChildren]
  );

  /**
   * Prefetch permission for every visible sub-space's interior drag.  A
   * single `can_manage_space_children` call each is cheap and prevents
   * the first-drag-is-lost problem in `handleChildDragStart` (where an
   * unresolved permission cancels the drag).  We walk `rooms` for items
   * with `isSpace === true`, which in the active-space view are
   * sub-space headers.
   */
  useEffect(() => {
    for (const r of rooms) {
      if (r.isSpace) ensureSubSpacePermission(r.id);
    }
  }, [rooms, ensureSubSpacePermission]);

  /**
   * Active-space child ids (sub-space headers + direct rooms, in unified
   * Matrix order) for `handleRowDragOver`'s sibling-list parameter.  All
   * top-level reorders inside the active space share this id list.
   */
  const activeSpaceChildIds = useMemo(() => rooms.map((r) => r.id), [rooms]);

  const hasChannelList = rooms.length > 0;

  // Extract local part of userId for display (e.g. @carter:matrix.org → carter)
  const displayName = userId.startsWith("@")
    ? userId.slice(1).split(":")[0]
    : userId;

  const handleConfirmLeaveRoom = useCallback(async () => {
    if (!leaveRoom) return;
    setLeaveRoomError(null);
    setLeaveRoomSubmitting(true);
    try {
      await invoke("leave_room", { roomId: leaveRoom.id });
      onLeftRoom?.(leaveRoom.id);
      setLeaveRoom(null);
    } catch (e) {
      setLeaveRoomError(String(e));
    } finally {
      setLeaveRoomSubmitting(false);
    }
  }, [leaveRoom, onLeftRoom]);

  return (
    <div style={{
      width,
      minWidth: width,
      backgroundColor: palette.bgSecondary,
      borderRight: `1px solid ${palette.border}`,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          paddingTop: spacing.unit * 4,
          paddingBottom: spacing.unit * 4,
          paddingLeft: spacing.unit * 4,
          paddingRight: spacing.unit * 2,
          height: spacing.headerHeight,
          borderBottom: `1px solid ${palette.border}`,
          boxSizing: "border-box",
          minHeight: spacing.headerHeight,
        }}
      >
        <h2
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: typography.fontSizeLarge,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            margin: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {spaceName}
        </h2>
        {spaceInviteId ? (
          <button
            type="button"
            title="Invite people to this space"
            aria-label="Invite people to this space"
            onClick={() =>
              setInviteSpaceFromHeader({ id: spaceInviteId, name: spaceName })
            }
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: 0,
              padding: spacing.unit * 1.5,
              border: "none",
              borderRadius: 6,
              backgroundColor: "transparent",
              color: palette.textSecondary,
              cursor: "pointer",
              lineHeight: 0,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
              (e.currentTarget as HTMLButtonElement).style.color = palette.textPrimary;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = palette.textSecondary;
            }}
          >
            <UserPlus size={20} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: spacing.unit * 2 }}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        {showHomeAddRoom && (
          <div style={{ marginBottom: spacing.unit * 2 }}>
            <button
              type="button"
              title="Join a room or browse the public directory"
              aria-label="Add or join a room"
              onClick={() => setShowAddRoomDialog(true)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: spacing.unit * 1.5,
                width: "100%",
                margin: 0,
                padding: `${spacing.unit * 2.25}px ${spacing.unit * 4}px`,
                border: "none",
                borderRadius: 9999,
                backgroundColor: palette.accent,
                color: "#fff",
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                fontFamily: typography.fontFamily,
                cursor: "pointer",
                boxSizing: "border-box",
                transition: "background-color 0.15s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.accentHover;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.accent;
              }}
            >
              <Plus size={18} strokeWidth={2} aria-hidden />
              Add or join room
            </button>
          </div>
        )}
        {showSpaceHomeNav && (
          <div style={{ marginBottom: spacing.unit }}>
            {parentSpace && onNavigateToParentSpace ? (
              <button
                type="button"
                onClick={onNavigateToParentSpace}
                title={`Back to ${parentSpace.name}`}
                aria-label={`Back to ${parentSpace.name}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 1.5,
                  width: "100%",
                  margin: 0,
                  marginBottom: spacing.unit,
                  padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                  border: "none",
                  borderRadius: spacing.unit,
                  cursor: "pointer",
                  color: palette.textSecondary,
                  backgroundColor: "transparent",
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightNormal,
                  fontFamily: typography.fontFamily,
                  textAlign: "left",
                  boxSizing: "border-box",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                    palette.bgActive;
                  (e.currentTarget as HTMLButtonElement).style.color =
                    palette.textHeading;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                    "transparent";
                  (e.currentTarget as HTMLButtonElement).style.color =
                    palette.textSecondary;
                }}
              >
                <ArrowLeft
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                  style={{ flexShrink: 0 }}
                />
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
            <div
              onClick={() => onSelectSpaceHome()}
              style={{
                padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                borderRadius: spacing.unit,
                cursor: "pointer",
                color: isSpaceHomeActive ? palette.textHeading : palette.textSecondary,
                backgroundColor: isSpaceHomeActive ? palette.bgActive : "transparent",
                fontSize: typography.fontSizeBase,
                fontWeight: isSpaceHomeActive
                  ? typography.fontWeightMedium
                  : typography.fontWeightNormal,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: spacing.unit }}>
                <House
                  size={16}
                  color="currentColor"
                  fill={isSpaceHomeActive ? "currentColor" : "none"}
                  strokeWidth={isSpaceHomeActive ? 0 : 2}
                />
                <div style={{ marginLeft: spacing.unit }}>Home</div>
              </span>
            </div>
          </div>
        )}
        {/* Active-space children — sub-space headers and direct rooms
            interleaved by Matrix's `m.space.child` order, plus Home rooms
            when no space is active.  Each item dispatches at render time:
            sub-space headers get a chevron + expandable interior; regular
            rooms get a `ChannelBlock`.  All top-level items share a single
            "activeSpaceChild" drag scope so the user can freely reorder
            sub-spaces among rooms.  Sub-space INTERIOR rooms are a
            separate "subSpaceRoom" scope (different parent in Matrix). */}
        {rooms.map((item, itemIdx) => {
          const isLast = itemIdx === rooms.length - 1;
          const isPending = !!pendingReorderIds && pendingReorderIds.has(item.id);

          const isDragged =
            activeDrag?.scope === "activeSpaceChild" &&
            activeDrag.childId === item.id;
          const indicatorAbove =
            dropIndicator?.scope === "activeSpaceChild" &&
            dropIndicator.beforeId === item.id;
          const indicatorBelowLast =
            dropIndicator?.scope === "activeSpaceChild" &&
            dropIndicator.beforeId === "end" &&
            isLast;

          const topLevelDraggable =
            !!onReorderSpaceChildren &&
            !!activeSpaceId &&
            canManageActiveSpaceChildren &&
            !isPending;

          if (item.isSpace) {
            // Sub-space header (Discord-style "category"): chevron toggle,
            // uppercase title, optional ExternalLink to open the sub-space's
            // home, plus an expandable interior with its own drag scope for
            // the rooms inside it.
            const subSpace = item;
            const expanded = isSubSpaceExpanded(subSpace.id);
            const ChevronIcon = expanded ? ChevronDown : ChevronRight;
            const subRooms = getSubSpaceRoomsOrdered(subSpace.id);
            const subRoomIds = subRooms.map((r) => r.id);

            return (
              <div key={subSpace.id} style={{ marginBottom: spacing.unit }}>
                <DraggableRow
                  draggable={topLevelDraggable}
                  onDragStart={(e) =>
                    handleChildDragStart(e, subSpace.id, "activeSpaceChild")
                  }
                  onDragEnd={handleChildDragEnd}
                  onDragOver={(e) =>
                    handleRowDragOver(
                      e,
                      subSpace.id,
                      "activeSpaceChild",
                      undefined,
                      activeSpaceChildIds
                    )
                  }
                  onDrop={(e) => handleRowDrop(e, rooms)}
                  isBeingDragged={isDragged}
                  showIndicatorAbove={indicatorAbove}
                  showIndicatorBelowLast={indicatorBelowLast}
                  indicatorColor={palette.textPrimary}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => toggleSubSpace(subSpace.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleSubSpace(subSpace.id);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: spacing.unit,
                      padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                      borderRadius: spacing.unit,
                      userSelect: "none",
                      cursor: topLevelDraggable ? "grab" : "pointer",
                      // Pending dim: matches the channel-row treatment so
                      // a sub-space header mid-reorder reads as "in flight"
                      // at a glance.  Returns to full opacity when the
                      // homeserver round-trip clears the pending entry.
                      opacity: isPending ? 0.5 : 1,
                      transition: "opacity 0.12s linear",
                    }}
                  >
                    <ChevronIcon
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                      style={{ flexShrink: 0, color: palette.textSecondary }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: typography.fontSizeSmall,
                        fontWeight: typography.fontWeightBold,
                        color: palette.textSecondary,
                        textTransform: "uppercase" as const,
                        letterSpacing: "0.02em",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {subSpace.name}
                    </span>
                    {onOpenSubSpace ? (
                      <button
                        type="button"
                        title="Open sub-space home"
                        aria-label={`Open ${subSpace.name} home`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenSubSpace(subSpace.id);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        style={{
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 28,
                          height: 28,
                          padding: 0,
                          border: "none",
                          borderRadius: spacing.unit * 0.75,
                          backgroundColor: "transparent",
                          color: palette.textSecondary,
                          cursor: "pointer",
                        }}
                      >
                        <ExternalLink size={14} strokeWidth={2} aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </DraggableRow>
                {expanded &&
                  subRooms.map((room, roomIdx) => {
                    const roomPending =
                      !!pendingReorderIds && pendingReorderIds.has(room.id);
                    const roomDragged =
                      activeDrag?.scope === "subSpaceRoom" &&
                      activeDrag.subSpaceId === subSpace.id &&
                      activeDrag.childId === room.id;
                    const roomIndicatorAbove =
                      dropIndicator?.scope === "subSpaceRoom" &&
                      dropIndicator.subSpaceId === subSpace.id &&
                      dropIndicator.beforeId === room.id;
                    const roomIndicatorBelowLast =
                      dropIndicator?.scope === "subSpaceRoom" &&
                      dropIndicator.subSpaceId === subSpace.id &&
                      dropIndicator.beforeId === "end" &&
                      roomIdx === subRooms.length - 1;
                    const subRoomDraggable =
                      !!onReorderSpaceChildren &&
                      !!subSpaceCanManage[subSpace.id] &&
                      !roomPending;

                    return (
                      <DraggableRow
                        key={room.id}
                        draggable={subRoomDraggable}
                        onDragStart={(e) =>
                          handleChildDragStart(
                            e,
                            room.id,
                            "subSpaceRoom",
                            subSpace.id
                          )
                        }
                        onDragEnd={handleChildDragEnd}
                        onDragOver={(e) =>
                          handleRowDragOver(
                            e,
                            room.id,
                            "subSpaceRoom",
                            subSpace.id,
                            subRoomIds
                          )
                        }
                        onDrop={(e) => handleRowDrop(e, subRooms)}
                        isBeingDragged={roomDragged}
                        showIndicatorAbove={roomIndicatorAbove}
                        showIndicatorBelowLast={roomIndicatorBelowLast}
                        indicatorColor={palette.textPrimary}
                        style={{
                          opacity: roomPending ? 0.5 : 1,
                          transition: "opacity 0.12s linear",
                        }}
                      >
                        <ChannelBlock
                          room={room}
                          activeRoomId={activeRoomId}
                          userId={userId}
                          onSelectRoom={onSelectRoom}
                          onRoomContextMenu={(rid, rname, e) => {
                            e.preventDefault();
                            setRoomContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              roomId: rid,
                              roomName: rname,
                            });
                          }}
                          voiceParticipants={voiceParticipants}
                          connectedVoiceRoomId={connectedVoiceRoomId}
                          isVoiceConnecting={isVoiceConnecting}
                          disconnectingFromRoomId={disconnectingFromRoomId}
                          screenSharingOwners={screenSharingOwners}
                          voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
                          onParticipantContextMenu={(e, identity, displayName) => {
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              identity,
                              displayName,
                            });
                          }}
                          peerPresenceByUserId={peerPresenceByUserId}
                          peerStatusMsgByUserId={peerStatusMsgByUserId}
                          palette={palette}
                          spacing={spacing}
                          typography={typography}
                          isUnread={isUnread}
                          mentionCount={mentionCount}
                          indent
                        />
                      </DraggableRow>
                    );
                  })}
              </div>
            );
          }

          // Regular channel row (direct child of active space, OR a Home
          // room when no active space is selected).  Drag is gated on
          // `canManageActiveSpaceChildren` AND on having an active space —
          // Home rooms are not part of any `m.space.child` and so aren't
          // reorderable through this scope.
          return (
            <DraggableRow
              key={item.id}
              draggable={topLevelDraggable}
              onDragStart={(e) => handleChildDragStart(e, item.id, "activeSpaceChild")}
              onDragEnd={handleChildDragEnd}
              onDragOver={(e) =>
                handleRowDragOver(
                  e,
                  item.id,
                  "activeSpaceChild",
                  undefined,
                  activeSpaceChildIds
                )
              }
              onDrop={(e) => handleRowDrop(e, rooms)}
              isBeingDragged={isDragged}
              showIndicatorAbove={indicatorAbove}
              showIndicatorBelowLast={indicatorBelowLast}
              indicatorColor={palette.textPrimary}
              style={{
                opacity: isPending ? 0.5 : 1,
                transition: "opacity 0.12s linear",
              }}
            >
              <ChannelBlock
                room={item}
                activeRoomId={activeRoomId}
                userId={userId}
                onSelectRoom={onSelectRoom}
                onRoomContextMenu={(rid, rname, e) => {
                  e.preventDefault();
                  setRoomContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    roomId: rid,
                    roomName: rname,
                  });
                }}
                voiceParticipants={voiceParticipants}
                connectedVoiceRoomId={connectedVoiceRoomId}
                isVoiceConnecting={isVoiceConnecting}
                disconnectingFromRoomId={disconnectingFromRoomId}
                screenSharingOwners={screenSharingOwners}
                voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
                onParticipantContextMenu={(e, identity, displayName) => {
                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    identity,
                    displayName,
                  });
                }}
                peerPresenceByUserId={peerPresenceByUserId}
                peerStatusMsgByUserId={peerStatusMsgByUserId}
                palette={palette}
                spacing={spacing}
                typography={typography}
                isUnread={isUnread}
                mentionCount={mentionCount}
              />
            </DraggableRow>
          );
        })}
        {!hasChannelList && (
          <div style={{
            color: palette.textSecondary,
            padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
            fontSize: typography.fontSizeSmall,
          }}>
            No rooms in this space
          </div>
        )}
      </div>

      {/* User status at bottom — flexShrink: 0 so it stays full width */}
      <div style={{ flexShrink: 0 }}>
        <StatusDropdown displayName={displayName} avatarUrl={userAvatarUrl} userId={userId} />
      </div>

      {/* Volume context menu */}
      {contextMenu && (
        <VolumeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          displayName={contextMenu.displayName}
          volume={getVolume(contextMenu.identity, "microphone")}
          onVolumeChange={(vol) => {
            setVolume(contextMenu.identity, vol, "microphone");
            onSetParticipantVolume(contextMenu.identity, vol, "microphone");
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Room context menu */}
      {roomContextMenu && (
        <RoomContextMenu
          x={roomContextMenu.x}
          y={roomContextMenu.y}
          roomName={roomContextMenu.roomName}
          onInvite={() => {
            const t = roomContextMenu;
            setInviteRoom({ id: t.roomId, name: t.roomName });
          }}
          onOpenSettings={() => setSettingsRoomId(roomContextMenu.roomId)}
          onViewParentSpaces={() => {
            const t = roomContextMenu;
            setParentSpacesRoom({ id: t.roomId, name: t.roomName });
          }}
          onLeave={() => {
            const t = roomContextMenu;
            setLeaveRoomError(null);
            setLeaveRoom({ id: t.roomId, name: t.roomName });
          }}
          onClose={() => setRoomContextMenu(null)}
        />
      )}

      {/* Room settings modal */}
      {settingsRoom && (
        <RoomSettingsDialog
          roomId={settingsRoom.id}
          roomName={settingsRoom.name}
          moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
          moderationSpaceName={moderationSpaceName}
          moderationSpaceRootId={moderationSpaceRootId}
          onClose={() => setSettingsRoomId(null)}
        />
      )}

      {inviteRoom && (
        <InviteDialog
          roomId={inviteRoom.id}
          targetName={inviteRoom.name}
          kind="room"
          currentUserId={userId}
          onClose={() => setInviteRoom(null)}
        />
      )}

      {inviteSpaceFromHeader && (
        <InviteDialog
          roomId={inviteSpaceFromHeader.id}
          targetName={inviteSpaceFromHeader.name}
          kind="space"
          currentUserId={userId}
          onClose={() => setInviteSpaceFromHeader(null)}
        />
      )}

      {leaveRoom && (
        <LeaveConfirmDialog
          kind="room"
          targetName={leaveRoom.name}
          onlyAdminWarning={false}
          leaving={leaveRoomSubmitting}
          error={leaveRoomError}
          onConfirm={handleConfirmLeaveRoom}
          onClose={() => {
            if (!leaveRoomSubmitting) {
              setLeaveRoom(null);
              setLeaveRoomError(null);
            }
          }}
        />
      )}

      {parentSpacesRoom && (
        <ParentSpacesDialog
          roomId={parentSpacesRoom.id}
          roomName={parentSpacesRoom.name}
          onClose={() => setParentSpacesRoom(null)}
        />
      )}

      {showAddRoomDialog && showHomeAddRoom && (
        <CreateRoomDialog
          spaceId={null}
          onClose={() => setShowAddRoomDialog(false)}
          onCreated={async (payload) => {
            await onRoomsChanged?.(payload);
            setShowAddRoomDialog(false);
          }}
        />
      )}
    </div>
  );
}