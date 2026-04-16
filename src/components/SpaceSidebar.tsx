import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Settings } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { Room } from "../types/matrix";
import { collectRoomIdsInSpaceTree } from "../utils/spaceModeration";
import { spaceInitialAvatarBackground } from "../utils/userAvatarColor";
import CreateSpaceDialog from "./CreateSpaceDialog";
import CreateRoomDialog from "./CreateRoomDialog";
import SpaceContextMenu from "./SpaceContextMenu";
import SpaceSettingsDialog from "./SpaceSettingsDialog";
import InviteDialog from "./InviteDialog";
import LeaveConfirmDialog, { fetchLeaveSpacePreview } from "./LeaveConfirmDialog";
import { avatarSrc } from "../utils/avatarSrc";

type RoomsChangedPayload = {
  joinedRoomId?: string;
  optimisticRoom?: Room;
};

interface SpaceSidebarProps {
  spaces: Room[];
  /** Used to kick/ban across the whole space tree from space settings. */
  roomsBySpace: (spaceId: string | null) => Room[];
  activeSpaceId: string | null;
  /** Top-level space to show as selected when the user is inside a nested sub-space. */
  spaceHighlightId: string | null;
  onSelectSpace: (spaceId: string) => void;
  onSpacesChanged: (payload?: RoomsChangedPayload) => void | Promise<void>;
  onOpenSettings: () => void;
  userId: string;
  /** Called after successfully leaving a space from the context menu */
  onLeftSpace?: (spaceId: string) => void;
  /** Rollup predicate: does this space (or a descendant) have unread activity? */
  isSpaceUnread: (spaceId: string) => boolean;
  /** Rollup count: total mentions across the space tree (for the red badge). */
  spaceMentionCount: (spaceId: string) => number;
  /** True when any Home-bucket room (not under any joined space) has unread activity. */
  isHomeUnread: boolean;
  /** Total mentions across Home-bucket rooms. */
  homeMentionCount: number;
}

/** Constant icon geometry shared by every row (Home, spaces, add, settings). */
const ICON_SIZE = 48;
/** Always-squircle radius — applied to every icon regardless of state.  The old
 *  circle-to-squircle shape animation shifted neighbours on click, which is
 *  exactly the spacing jitter we're getting rid of. */
const ICON_RADIUS = 16;

/** Width of the parent sidebar column.  Kept in sync with the outer `<div>`'s
 *  explicit `width`.  Used to position the left-edge indicator relative to the
 *  window edge instead of the individual icon (otherwise the indicator ends up
 *  against the icon's left side because the wrapper `<div>` shrinks to fit the
 *  centered icon, not the full column width). */
const SIDEBAR_WIDTH = 72;

/** Left-edge "selected / unread" indicator geometry.
 *
 *  `INDICATOR_WIDTH` is the total horizontal extent; we position the indicator
 *  so its horizontal centre lines up with the window's left edge — half of it
 *  is clipped by the window, half is visible flush against the sidebar's left
 *  wall.  That gives you a long pill whose right edge reads as a straight line
 *  running parallel to the icons.
 *
 *  The indicator element is always mounted (just at `height: 0` when inactive)
 *  so that the CSS transitions on `height` / `margin-top` actually animate
 *  when selection or unread state changes.  If we conditionally mounted it,
 *  a newly-selected indicator would pop in at full size in one frame because
 *  there's no previous value for the transition to interpolate from. */
const INDICATOR_WIDTH = 8;
const INDICATOR_PILL_HEIGHT = 32;
const INDICATOR_DOT_HEIGHT = 8;
/** Horizontal offset that places the indicator's centre on the window's left
 *  edge.  The wrapper `<div>` is centred in the 72px column, so its own left
 *  edge sits at `(SIDEBAR_WIDTH - ICON_SIZE) / 2 = 12px` inside the window.
 *  Subtract `INDICATOR_WIDTH / 2` more to reach x = -INDICATOR_WIDTH / 2 in
 *  window coordinates. */
const INDICATOR_LEFT_OFFSET =
  -((SIDEBAR_WIDTH - ICON_SIZE) / 2) - INDICATOR_WIDTH / 2;

/** The squircle avatar by itself — no selected-state ring, no radius animation.
 *  Selection is communicated by the external left-edge indicator; the icon
 *  shape no longer changes on click. */
function SpaceAvatar({ space }: { space: Room }) {
  const { resolvedColorScheme } = useTheme();
  const initials = space.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <button
      onClick={() => {}}
      title={space.name}
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        borderRadius: ICON_RADIUS,
        border: "none",
        cursor: "pointer",
        overflow: "hidden",
        padding: 0,
        flexShrink: 0,
      }}
    >
      {space.avatarUrl ? (
        <img
          src={avatarSrc(space.avatarUrl)}
          alt={space.name}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            backgroundColor: spaceInitialAvatarBackground(space.id, resolvedColorScheme),
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {initials}
        </div>
      )}
    </button>
  );
}

/**
 * Wraps any sidebar icon (Home, a space, etc.) with:
 *   - a left-edge indicator that morphs between "unread dot" and "selected pill"
 *   - a top-right mention-count badge when `mentions > 0`
 *
 * The wrapper is purely presentational — selection click handlers still live on
 * the icon itself.  We position the indicator *outside* the wrapper's right
 * edge using negative `left`, so half of it gets clipped by the parent column
 * (which has no horizontal padding against the window edge on the left side).
 *
 * Rendering the indicator only when `selected || unread` avoids a stray
 * invisible element sitting in the layout.  The transition from "no indicator"
 * to "dot" isn't animated (it just appears); dot → pill on click *is* animated
 * because the element is continuously mounted across both states.
 */
function SpaceIconRow({
  selected,
  unread,
  mentions,
  children,
  indicatorColor,
}: {
  selected: boolean;
  unread: boolean;
  mentions: number;
  children: React.ReactNode;
  /** Primary text colour for the indicator; threaded from theme by the caller. */
  indicatorColor: string;
}) {
  // Compute target geometry.  The element is always mounted; height 0 means
  // "invisible for now, ready to grow from the centre on the next state flip".
  const height = selected
    ? INDICATOR_PILL_HEIGHT
    : unread
      ? INDICATOR_DOT_HEIGHT
      : 0;

  return (
    <div style={{ position: "relative" }}>
      {children}
      <span
        aria-hidden
        style={{
          position: "absolute",
          // Position relative to the wrapper, but the offset pushes the
          // indicator out past the sidebar's left wall so half of it clips
          // against the window edge.  See INDICATOR_LEFT_OFFSET for the math.
          left: INDICATOR_LEFT_OFFSET,
          top: "50%",
          width: INDICATOR_WIDTH,
          height,
          // Keep the indicator vertically centred on the icon as it grows.
          // Negating half the height via marginTop means height changes expand
          // symmetrically from the centre (so the pill grows out of a dot, and
          // the dot grows out of nothing, both centred).
          marginTop: -height / 2,
          backgroundColor: indicatorColor,
          borderRadius: INDICATOR_WIDTH / 2,
          pointerEvents: "none",
          transition: "height 0.18s ease, margin-top 0.18s ease",
        }}
      />
      {mentions > 0 && (
        <span
          aria-label={`${mentions} unread mention${mentions === 1 ? "" : "s"}`}
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            backgroundColor: "#f23f43",
            color: "#ffffff",
            fontSize: 11,
            fontWeight: 700,
            lineHeight: "18px",
            textAlign: "center",
            boxSizing: "border-box",
            // Small dark halo so the badge reads on top of both the avatar
            // and the sidebar background when they have similar tones.
            border: "2px solid rgba(0,0,0,0.2)",
            pointerEvents: "none",
          }}
        >
          {mentions > 99 ? "99+" : mentions}
        </span>
      )}
    </div>
  );
}

export default function SpaceSidebar({
  spaces,
  roomsBySpace,
  activeSpaceId,
  spaceHighlightId,
  onSelectSpace,
  onSpacesChanged,
  onOpenSettings,
  userId,
  onLeftSpace,
  isSpaceUnread,
  spaceMentionCount,
  isHomeUnread,
  homeMentionCount,
}: SpaceSidebarProps) {
  const { palette } = useTheme();
  const [showDialog, setShowDialog] = useState(false);
  const [canCreate, setCanCreate] = useState(true);
  const [addHovered, setAddHovered] = useState(false);
  const [settingsHovered, setSettingsHovered] = useState(false);
  const [spaceContextMenu, setSpaceContextMenu] = useState<{
    x: number;
    y: number;
    spaceId: string;
    spaceName: string;
    /** When set, whether the user can send `m.space.child` in this space (same as Space Home "Create Room"). */
    canManageChildren?: boolean;
  } | null>(null);
  const [spaceSettingsTarget, setSpaceSettingsTarget] = useState<{
    spaceId: string;
    spaceName: string;
  } | null>(null);
  const [inviteSpace, setInviteSpace] = useState<{ id: string; name: string } | null>(null);
  const [leaveSpace, setLeaveSpace] = useState<{ id: string; name: string } | null>(null);
  const [leaveSpaceOnlyAdmin, setLeaveSpaceOnlyAdmin] = useState<boolean | null>(null);
  const [leaveSpaceError, setLeaveSpaceError] = useState<string | null>(null);
  const [leaveSpaceSubmitting, setLeaveSpaceSubmitting] = useState(false);
  const [createRoomSpaceId, setCreateRoomSpaceId] = useState<string | null>(null);
  const [createSubSpaceParent, setCreateSubSpaceParent] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const checkedRef = useRef(false);

  // Check room creation permission once on mount
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    invoke<boolean>("can_create_rooms")
      .then(setCanCreate)
      .catch(() => setCanCreate(true)); // Optimistic fallback
  }, []);

  const handleOpenDialog = useCallback(() => {
    setShowDialog(true);
  }, []);

  const handleCloseDialog = useCallback(() => {
    setShowDialog(false);
  }, []);

  const handleCreated = useCallback((payload?: RoomsChangedPayload) => {
    return onSpacesChanged(payload);
  }, [onSpacesChanged]);

  useEffect(() => {
    if (!leaveSpace) {
      setLeaveSpaceOnlyAdmin(null);
      return;
    }
    let cancelled = false;
    setLeaveSpaceOnlyAdmin(null);
    fetchLeaveSpacePreview(leaveSpace.id)
      .then((v) => {
        if (!cancelled) setLeaveSpaceOnlyAdmin(v);
      })
      .catch(() => {
        if (!cancelled) setLeaveSpaceOnlyAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leaveSpace?.id]);

  useEffect(() => {
    const sid = spaceContextMenu?.spaceId;
    if (!sid) return;
    let cancelled = false;
    invoke<boolean>("can_manage_space_children", { spaceId: sid })
      .then((v) => {
        if (cancelled) return;
        setSpaceContextMenu((prev) =>
          prev && prev.spaceId === sid ? { ...prev, canManageChildren: v } : prev
        );
      })
      .catch(() => {
        if (cancelled) return;
        setSpaceContextMenu((prev) =>
          prev && prev.spaceId === sid ? { ...prev, canManageChildren: false } : prev
        );
      });
    return () => {
      cancelled = true;
    };
  }, [spaceContextMenu?.spaceId]);

  const moderationSpaceTreeRoomIds = useMemo(() => {
    if (!spaceSettingsTarget) return null;
    const ids = collectRoomIdsInSpaceTree(spaceSettingsTarget.spaceId, roomsBySpace);
    return ids.length > 0 ? ids : null;
  }, [spaceSettingsTarget, roomsBySpace]);

  const handleConfirmLeaveSpace = useCallback(async () => {
    if (!leaveSpace) return;
    setLeaveSpaceError(null);
    setLeaveSpaceSubmitting(true);
    try {
      await invoke("leave_room", { roomId: leaveSpace.id });
      onLeftSpace?.(leaveSpace.id);
      await onSpacesChanged();
      setLeaveSpace(null);
    } catch (e) {
      setLeaveSpaceError(String(e));
    } finally {
      setLeaveSpaceSubmitting(false);
    }
  }, [leaveSpace, onLeftSpace, onSpacesChanged]);

  return (
    <>
      <div
        style={{
          width: 72,
          minWidth: 72,
          flexShrink: 0,
          backgroundColor: palette.bgTertiary,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "12px 0",
          gap: 8,
          overflowY: "auto",
          height: "100vh",
        }}
      >
        {/* Home button */}
        <SpaceIconRow
          selected={activeSpaceId === "" || activeSpaceId === null}
          unread={isHomeUnread}
          mentions={homeMentionCount}
          indicatorColor={palette.textHeading}
        >
          <button
            type="button"
            aria-label="Home"
            onClick={() => onSelectSpace("")}
            title="Home"
            style={{
              width: ICON_SIZE,
              height: ICON_SIZE,
              borderRadius: ICON_RADIUS,
              border: "none",
              backgroundColor: palette.accent,
              cursor: "pointer",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 5,
            }}
          >
            <img
              src="/logo.png"
              alt=""
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                display: "block",
                filter: "brightness(0) invert(1)",
              }}
            />
          </button>
        </SpaceIconRow>

        {/* Divider */}
        <div
          style={{
            width: 32,
            height: 2,
            backgroundColor: "#35363c",
            borderRadius: 1,
            flexShrink: 0,
          }}
        />

        {/* Space avatars */}
        {spaces.map((space) => {
          const selected = spaceHighlightId === space.id;
          const unread = !selected && isSpaceUnread(space.id);
          const mentions = spaceMentionCount(space.id);
          return (
            <div
              key={space.id}
              onClick={() => onSelectSpace(space.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSpaceContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  spaceId: space.id,
                  spaceName: space.name,
                });
              }}
            >
              <SpaceIconRow
                selected={selected}
                unread={unread}
                mentions={mentions}
                indicatorColor={palette.textHeading}
              >
                <SpaceAvatar space={space} />
              </SpaceIconRow>
            </div>
          );
        })}

        {/* Add space button */}
        <button
          onClick={handleOpenDialog}
          onMouseEnter={() => setAddHovered(true)}
          onMouseLeave={() => setAddHovered(false)}
          title="Create or join a space"
          style={{
            width: ICON_SIZE,
            height: ICON_SIZE,
            borderRadius: ICON_RADIUS,
            border: "none",
            backgroundColor: addHovered ? "#3ba55d" : palette.bgPrimary,
            color: addHovered ? "#fff" : "#3ba55d",
            cursor: "pointer",
            transition: "background-color 0.2s ease, color 0.2s ease",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <Plus size={24} strokeWidth={2} />
        </button>

        {/* Spacer to keep settings pinned at the bottom */}
        <div style={{ flex: 1 }} />

        {/* Divider before settings button */}
        <div
          style={{
            width: 32,
            height: 2,
            backgroundColor: "#35363c",
            borderRadius: 1,
            flexShrink: 0,
          }}
        />

        <button
          onClick={onOpenSettings}
          onMouseEnter={() => setSettingsHovered(true)}
          onMouseLeave={() => setSettingsHovered(false)}
          title="Settings"
          style={{
            width: ICON_SIZE,
            height: ICON_SIZE,
            borderRadius: ICON_RADIUS,
            border: "none",
            backgroundColor: settingsHovered ? palette.bgActive : palette.bgPrimary,
            color: settingsHovered ? palette.textPrimary : palette.textSecondary,
            cursor: "pointer",
            transition: "background-color 0.2s ease, color 0.2s ease",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <Settings size={22} strokeWidth={2} />
        </button>
      </div>

      {/* Create/Join dialog */}
      {showDialog && (
        <CreateSpaceDialog
          canCreate={canCreate}
          onClose={handleCloseDialog}
          onCreated={handleCreated}
        />
      )}

      {spaceContextMenu && (
        <SpaceContextMenu
          x={spaceContextMenu.x}
          y={spaceContextMenu.y}
          spaceName={spaceContextMenu.spaceName}
          canCreateRoom={spaceContextMenu.canManageChildren === true}
          onInvite={() => {
            const t = spaceContextMenu;
            setInviteSpace({ id: t.spaceId, name: t.spaceName });
          }}
          onCreateRoom={() => {
            const t = spaceContextMenu;
            setCreateRoomSpaceId(t.spaceId);
          }}
          onCreateSubSpace={() => {
            const t = spaceContextMenu;
            setCreateSubSpaceParent({ id: t.spaceId, name: t.spaceName });
          }}
          onLeave={() => {
            const t = spaceContextMenu;
            setLeaveSpaceError(null);
            setLeaveSpace({ id: t.spaceId, name: t.spaceName });
          }}
          onOpenSpaceSettings={() =>
            setSpaceSettingsTarget({
              spaceId: spaceContextMenu.spaceId,
              spaceName: spaceContextMenu.spaceName,
            })
          }
          onClose={() => setSpaceContextMenu(null)}
        />
      )}

      {createRoomSpaceId && (
        <CreateRoomDialog
          spaceId={createRoomSpaceId}
          onClose={() => setCreateRoomSpaceId(null)}
          onCreated={handleCreated}
        />
      )}

      {createSubSpaceParent && (
        <CreateSpaceDialog
          canCreate
          parentSpace={createSubSpaceParent}
          onClose={() => setCreateSubSpaceParent(null)}
          onCreated={handleCreated}
        />
      )}

      {spaceSettingsTarget && (
        <SpaceSettingsDialog
          spaceId={spaceSettingsTarget.spaceId}
          titleFallback={spaceSettingsTarget.spaceName}
          moderationSpaceTreeRoomIds={moderationSpaceTreeRoomIds}
          onClose={() => setSpaceSettingsTarget(null)}
          onSaved={() => onSpacesChanged()}
        />
      )}

      {inviteSpace && (
        <InviteDialog
          roomId={inviteSpace.id}
          targetName={inviteSpace.name}
          kind="space"
          currentUserId={userId}
          onClose={() => setInviteSpace(null)}
        />
      )}

      {leaveSpace && (
        <LeaveConfirmDialog
          kind="space"
          targetName={leaveSpace.name}
          onlyAdminWarning={leaveSpaceOnlyAdmin}
          leaving={leaveSpaceSubmitting}
          error={leaveSpaceError}
          onConfirm={handleConfirmLeaveSpace}
          onClose={() => {
            if (!leaveSpaceSubmitting) {
              setLeaveSpace(null);
              setLeaveSpaceError(null);
            }
          }}
        />
      )}
    </>
  );
}