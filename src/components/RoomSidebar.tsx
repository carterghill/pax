import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import DmPeerAvatar from "./DmPeerAvatar";
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
import { userInitialAvatarBackground } from "../utils/userAvatarColor";

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

export type RoomSidebarSubSpaceSection = { subSpace: Room; rooms: Room[] };

interface RoomSidebarProps {
  width: number;
  rooms: Room[];
  /** Joined sub-spaces of the active space, each with its channels (Discord-style categories). */
  subSpaceSections: RoomSidebarSubSpaceSection[];
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
  const { palette, spacing, typography, resolvedColorScheme } = useTheme();
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
      {participant.avatarUrl ? (
        <img
          src={participant.avatarUrl}
          alt={name}
          style={{
            display: "block",
            width: 20,
            height: 20,
            borderRadius: "50%",
            objectFit: "cover",
            flexShrink: 0,
            boxSizing: "border-box",
            boxShadow: isSpeaking ? "0 0 0 2px #23a55a" : "none",
            transition: "box-shadow 0.15s ease",
          }}
        />
      ) : (
        <div style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          backgroundColor: userInitialAvatarBackground(participant.userId, resolvedColorScheme),
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          fontWeight: typography.fontWeightBold,
          flexShrink: 0,
          boxSizing: "border-box",
          boxShadow: isSpeaking ? "0 0 0 2px #23a55a" : "none",
          transition: "box-shadow 0.15s ease",
        }}>
          {name.charAt(0).toUpperCase()}
        </div>
      )}
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
          color: activeRoomId === room.id ? palette.textHeading : palette.textSecondary,
          backgroundColor: activeRoomId === room.id ? palette.bgActive : "transparent",
          fontSize: typography.fontSizeBase,
          fontWeight:
            activeRoomId === room.id
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
                  : activeRoomId === room.id
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
              <DmPeerAvatar
                peerUserId={dmPeerId}
                displayName={effectiveDmTitle(room)}
                avatarUrl={room.avatarUrl}
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
              color={activeRoomId === room.id ? palette.textHeading : palette.textSecondary}
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
  subSpaceSections,
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

  const hasChannelList =
    rooms.length > 0 || subSpaceSections.some((s) => s.rooms.length > 0);

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
        {subSpaceSections.map(({ subSpace, rooms: subRooms }) => {
          const expanded = isSubSpaceExpanded(subSpace.id);
          const ChevronIcon = expanded ? ChevronDown : ChevronRight;
          return (
            <div key={subSpace.id} style={{ marginBottom: spacing.unit }}>
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
                  cursor: "pointer",
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
              {expanded &&
                subRooms.map((room) => (
                  <ChannelBlock
                    key={room.id}
                    room={room}
                    activeRoomId={activeRoomId}
                    userId={userId}
                    onSelectRoom={onSelectRoom}
                    onRoomContextMenu={(rid, rname, e) => {
                      e.preventDefault();
                      setRoomContextMenu({ x: e.clientX, y: e.clientY, roomId: rid, roomName: rname });
                    }}
                    voiceParticipants={voiceParticipants}
                    connectedVoiceRoomId={connectedVoiceRoomId}
                    isVoiceConnecting={isVoiceConnecting}
                    disconnectingFromRoomId={disconnectingFromRoomId}
                    screenSharingOwners={screenSharingOwners}
                    voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
                    onParticipantContextMenu={(e, identity, displayName) => {
                      setContextMenu({ x: e.clientX, y: e.clientY, identity, displayName });
                    }}
                    peerPresenceByUserId={peerPresenceByUserId}
                    peerStatusMsgByUserId={peerStatusMsgByUserId}
                    palette={palette}
                    spacing={spacing}
                    typography={typography}
                    indent
                  />
                ))}
            </div>
          );
        })}
        {rooms.map((room) => (
          <ChannelBlock
            key={room.id}
            room={room}
            activeRoomId={activeRoomId}
            userId={userId}
            onSelectRoom={onSelectRoom}
            onRoomContextMenu={(rid, rname, e) => {
              e.preventDefault();
              setRoomContextMenu({ x: e.clientX, y: e.clientY, roomId: rid, roomName: rname });
            }}
            voiceParticipants={voiceParticipants}
            connectedVoiceRoomId={connectedVoiceRoomId}
            isVoiceConnecting={isVoiceConnecting}
            disconnectingFromRoomId={disconnectingFromRoomId}
            screenSharingOwners={screenSharingOwners}
            voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
            onParticipantContextMenu={(e, identity, displayName) => {
              setContextMenu({ x: e.clientX, y: e.clientY, identity, displayName });
            }}
            peerPresenceByUserId={peerPresenceByUserId}
            peerStatusMsgByUserId={peerStatusMsgByUserId}
            palette={palette}
            spacing={spacing}
            typography={typography}
          />
        ))}
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