import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
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
  /**
   * Persist a new top-level space order after a drag-and-drop.  Receives
   * the full post-drop list of space ids in the user's chosen order.
   * Wrapped in a Promise so the sidebar can await and log on failure, but
   * callers are free to resolve before the network round-trip lands.
   */
  onReorderSpaces?: (nextOrder: string[]) => void | Promise<void>;
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

/**
 * Slight upscale so the squircle clip cuts through more opaque fill and drops
 * the outermost bad AA ring (faint tinted line at curved corners in WebView2).
 */
const SIDEBAR_ICON_BLEED_SCALE = 1.07;

/** Rounded mask only on this shell — inner control stays square and scaled. */
function SpaceSidebarSquircleClip({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        borderRadius: ICON_RADIUS,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

/** Square tile that fills the clip; rounding comes only from the outer shell. */
const SIDEBAR_ICON_INNER_BUTTON_BASE: CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  appearance: "none",
  WebkitAppearance: "none",
  MozAppearance: "none",
  transform: `scale(${SIDEBAR_ICON_BLEED_SCALE})`,
  transformOrigin: "center center",
};

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
  const fill = spaceInitialAvatarBackground(space.id, resolvedColorScheme);
  const initials = space.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <SpaceSidebarSquircleClip>
      <button
        type="button"
        onClick={() => {}}
        style={{
          ...SIDEBAR_ICON_INNER_BUTTON_BASE,
          cursor: "pointer",
          backgroundColor: fill,
          color: "#fff",
          fontSize: 14,
          fontWeight: 600,
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
          initials
        )}
      </button>
    </SpaceSidebarSquircleClip>
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
            // Flex keeps the count vertically centered; a fixed lineHeight on
            // this short pill tends to clip or sink the glyphs.
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            boxSizing: "border-box",
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
  onReorderSpaces,
  userId,
  onLeftSpace,
  isSpaceUnread,
  spaceMentionCount,
  isHomeUnread,
  homeMentionCount,
}: SpaceSidebarProps) {
  const { palette } = useTheme();
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const sidebarTooltipAnchorRef = useRef<HTMLElement | null>(null);
  const [sidebarTooltip, setSidebarTooltip] = useState<{
    name: string;
    left: number;
    top: number;
  } | null>(null);

  const syncSidebarTooltipPosition = useCallback(() => {
    const el = sidebarTooltipAnchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = r.right + 8;
    const top = r.top + r.height / 2;
    setSidebarTooltip((prev) => {
      if (!prev) return null;
      // Avoid returning a new object when nothing moved — otherwise the scroll/resize
      // effect (and its initial sync) re-runs in a loop and blocks the main thread.
      const eps = 0.5;
      if (
        Math.abs(prev.left - left) < eps &&
        Math.abs(prev.top - top) < eps
      ) {
        return prev;
      }
      return { ...prev, left, top };
    });
  }, []);

  const sidebarTooltipActive = sidebarTooltip != null;

  useEffect(() => {
    if (!sidebarTooltipActive) return;
    syncSidebarTooltipPosition();
    const sidebar = sidebarScrollRef.current;
    if (!sidebar) return;
    sidebar.addEventListener("scroll", syncSidebarTooltipPosition, { passive: true });
    window.addEventListener("resize", syncSidebarTooltipPosition);
    return () => {
      sidebar.removeEventListener("scroll", syncSidebarTooltipPosition);
      window.removeEventListener("resize", syncSidebarTooltipPosition);
    };
  }, [sidebarTooltipActive, syncSidebarTooltipPosition]);

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

  // ------ Drag-and-drop state ------
  //
  // Matrix has no standard for top-level space sidebar order; we persist
  // the user's chosen order under the `app.pax.space_order` account-data
  // event (see `useSpaceOrder`).  The interaction pattern here mirrors
  // Discord: grab any space avatar and drag to insert between two other
  // avatars.  Home, the "add space" plus button, and the settings cog are
  // not draggable (Home always pins to the top; the others are actions).
  //
  // We use native HTML5 drag-and-drop because it integrates with Tauri's
  // WebView for free and needs no extra dependency.  `draggedSpaceId`
  // tracks the currently-dragged space id; `dropBeforeId` tracks where an
  // insertion-line indicator should render.  A null `dropBeforeId` with
  // an active drag means "drop at the bottom of the list".
  const [draggedSpaceId, setDraggedSpaceId] = useState<string | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null | "end">(null);

  const handleSpaceDragStart = useCallback(
    (e: React.DragEvent, spaceId: string) => {
      // Use the move effect; copy would imply the original stays put,
      // which isn't the mental model for sidebar reordering.
      e.dataTransfer.effectAllowed = "move";
      // Setting a payload is required on Firefox for the drag to fire at
      // all; the value itself doesn't matter to us since we read
      // `draggedSpaceId` from state.
      try {
        e.dataTransfer.setData("text/plain", spaceId);
      } catch {
        /* some browsers reject setData on synthetic events */
      }
      setDraggedSpaceId(spaceId);
      setDropBeforeId(null);
    },
    []
  );

  const handleSpaceDragEnd = useCallback(() => {
    setDraggedSpaceId(null);
    setDropBeforeId(null);
  }, []);

  /**
   * Update the insertion indicator while hovering over a space avatar.
   * We show the indicator above or below the hovered target based on
   * which vertical half of the avatar the pointer is in — the same
   * pattern Element/Discord use.
   */
  const handleSpaceDragOver = useCallback(
    (e: React.DragEvent, targetSpaceId: string) => {
      if (!draggedSpaceId) return;
      // preventDefault is required or the drop event never fires.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midpoint;
      // Find the target's position in the current list to compute the
      // "insert before" reference.  When dropping on the bottom half of
      // the last item, `dropBeforeId` becomes the sentinel "end".
      const idx = spaces.findIndex((s) => s.id === targetSpaceId);
      if (idx < 0) return;
      let nextDropBeforeId: string | "end";
      if (insertBefore) {
        nextDropBeforeId = targetSpaceId;
      } else if (idx === spaces.length - 1) {
        nextDropBeforeId = "end";
      } else {
        nextDropBeforeId = spaces[idx + 1].id;
      }
      // Suppress indicator when the drop wouldn't move the item:
      //   - dropping immediately before yourself
      //   - dropping immediately after yourself (i.e. your next neighbour is
      //     the drop target)
      //   - dropping at the very end when you're already the last item
      if (
        nextDropBeforeId === draggedSpaceId ||
        (nextDropBeforeId === "end" &&
          spaces[spaces.length - 1]?.id === draggedSpaceId) ||
        (nextDropBeforeId !== "end" &&
          spaces[spaces.findIndex((s) => s.id === nextDropBeforeId) - 1]?.id ===
            draggedSpaceId)
      ) {
        setDropBeforeId(null);
        return;
      }
      setDropBeforeId((prev) =>
        prev === nextDropBeforeId ? prev : nextDropBeforeId
      );
    },
    [draggedSpaceId, spaces]
  );

  const handleSpaceDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const dragged = draggedSpaceId;
      const before = dropBeforeId;
      setDraggedSpaceId(null);
      setDropBeforeId(null);
      if (!dragged || !onReorderSpaces) return;
      if (before === null) return;

      // Rebuild the post-drop order.  `before` is either a space id
      // (meaning "insert immediately before this one") or the sentinel
      // "end" (meaning "append to the bottom").
      const without = spaces.filter((s) => s.id !== dragged);
      const nextOrder: string[] = [];
      if (before === "end") {
        for (const s of without) nextOrder.push(s.id);
        nextOrder.push(dragged);
      } else {
        let inserted = false;
        for (const s of without) {
          if (!inserted && s.id === before) {
            nextOrder.push(dragged);
            inserted = true;
          }
          nextOrder.push(s.id);
        }
        if (!inserted) {
          // `before` is no longer in the list (shouldn't happen because
          // React state for `spaces` is the same we computed against).
          nextOrder.push(dragged);
        }
      }
      if (nextOrder.length === spaces.length) {
        const unchanged = nextOrder.every((id, i) => spaces[i].id === id);
        if (unchanged) return;
      }
      void onReorderSpaces(nextOrder);
    },
    [draggedSpaceId, dropBeforeId, onReorderSpaces, spaces]
  );

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
        ref={sidebarScrollRef}
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
        <div
          onMouseEnter={(e) => {
            sidebarTooltipAnchorRef.current = e.currentTarget;
            const r = e.currentTarget.getBoundingClientRect();
            setSidebarTooltip({
              name: "Home",
              left: r.right + 8,
              top: r.top + r.height / 2,
            });
          }}
          onMouseLeave={() => {
            sidebarTooltipAnchorRef.current = null;
            setSidebarTooltip(null);
          }}
          style={{ position: "relative" }}
        >
          <SpaceIconRow
            selected={activeSpaceId === "" || activeSpaceId === null}
            unread={isHomeUnread}
            mentions={homeMentionCount}
            indicatorColor={palette.textHeading}
          >
            <SpaceSidebarSquircleClip>
              <button
                type="button"
                aria-label="Home"
                onClick={() => onSelectSpace("")}
                style={{
                  ...SIDEBAR_ICON_INNER_BUTTON_BASE,
                  backgroundColor: palette.accent,
                  cursor: "pointer",
                }}
              >
                {/* Filter on a child: `filter` can expand paint bounds; keep it
                    inside the squircle clip so halos don’t leak past corners. */}
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    padding: 5,
                    boxSizing: "border-box",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    filter: "brightness(0) invert(1)",
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
                    }}
                  />
                </div>
              </button>
            </SpaceSidebarSquircleClip>
          </SpaceIconRow>
        </div>

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
        {spaces.map((space, idx) => {
          const selected = spaceHighlightId === space.id;
          const unread = !selected && isSpaceUnread(space.id);
          const mentions = spaceMentionCount(space.id);
          const isBeingDragged = draggedSpaceId === space.id;
          const showInsertBefore = dropBeforeId === space.id;
          const showInsertAfterLast =
            idx === spaces.length - 1 && dropBeforeId === "end";
          return (
            <div
              key={space.id}
              aria-label={space.name}
              draggable={!!onReorderSpaces}
              onDragStart={(e) => handleSpaceDragStart(e, space.id)}
              onDragEnd={handleSpaceDragEnd}
              onDragOver={(e) => handleSpaceDragOver(e, space.id)}
              onDrop={handleSpaceDrop}
              onClick={(e) => {
                // Suppress clicks that are really the tail end of a drag:
                // if we've just reordered, `draggedSpaceId` will have been
                // cleared by onDragEnd before this fires, but defensively
                // ignore when the client coordinates indicate a drag was
                // in progress.
                if (e.defaultPrevented) return;
                onSelectSpace(space.id);
              }}
              onMouseEnter={(e) => {
                sidebarTooltipAnchorRef.current = e.currentTarget;
                const r = e.currentTarget.getBoundingClientRect();
                setSidebarTooltip({
                  name: space.name,
                  left: r.right + 8,
                  top: r.top + r.height / 2,
                });
              }}
              onMouseLeave={() => {
                sidebarTooltipAnchorRef.current = null;
                setSidebarTooltip(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setSpaceContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  spaceId: space.id,
                  spaceName: space.name,
                });
              }}
              style={{
                position: "relative",
                cursor: onReorderSpaces ? "grab" : "pointer",
                // While dragging this avatar, fade it so the source
                // position is visually distinct from the insertion line.
                opacity: isBeingDragged ? 0.35 : 1,
                transition: "opacity 0.08s linear",
              }}
            >
              {/* Insertion indicator drawn above the avatar when this is
                  the drop target with "insert before" semantics. */}
              {showInsertBefore && (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: (SIDEBAR_WIDTH - ICON_SIZE) / 2 - 2,
                    right: (SIDEBAR_WIDTH - ICON_SIZE) / 2 - 2,
                    top: -5,
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: palette.accent,
                    pointerEvents: "none",
                  }}
                />
              )}
              <SpaceIconRow
                selected={selected}
                unread={unread}
                mentions={mentions}
                indicatorColor={palette.textHeading}
              >
                <SpaceAvatar space={space} />
              </SpaceIconRow>
              {/* Insertion indicator at the very bottom of the list when
                  dropping past the last avatar. */}
              {showInsertAfterLast && (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: (SIDEBAR_WIDTH - ICON_SIZE) / 2 - 2,
                    right: (SIDEBAR_WIDTH - ICON_SIZE) / 2 - 2,
                    bottom: -5,
                    height: 3,
                    borderRadius: 2,
                    backgroundColor: palette.accent,
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          );
        })}

        {/* Add space button */}
        <SpaceSidebarSquircleClip>
          <button
            type="button"
            onClick={handleOpenDialog}
            aria-label="Create or join a space"
            onMouseEnter={(e) => {
              setAddHovered(true);
              sidebarTooltipAnchorRef.current = e.currentTarget;
              const r = e.currentTarget.getBoundingClientRect();
              setSidebarTooltip({
                name: "Create or join a space",
                left: r.right + 8,
                top: r.top + r.height / 2,
              });
            }}
            onMouseLeave={() => {
              setAddHovered(false);
              sidebarTooltipAnchorRef.current = null;
              setSidebarTooltip(null);
            }}
            style={{
              ...SIDEBAR_ICON_INNER_BUTTON_BASE,
              backgroundColor: addHovered ? "#3ba55d" : palette.bgPrimary,
              color: addHovered ? "#fff" : "#3ba55d",
              cursor: "pointer",
              transition: "background-color 0.2s ease, color 0.2s ease",
            }}
          >
            <Plus
              size={24}
              strokeWidth={2}
              style={{ display: "block", shapeRendering: "geometricPrecision" }}
            />
          </button>
        </SpaceSidebarSquircleClip>

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

        <SpaceSidebarSquircleClip>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            onMouseEnter={(e) => {
              setSettingsHovered(true);
              sidebarTooltipAnchorRef.current = e.currentTarget;
              const r = e.currentTarget.getBoundingClientRect();
              setSidebarTooltip({
                name: "Settings",
                left: r.right + 8,
                top: r.top + r.height / 2,
              });
            }}
            onMouseLeave={() => {
              setSettingsHovered(false);
              sidebarTooltipAnchorRef.current = null;
              setSidebarTooltip(null);
            }}
            style={{
              ...SIDEBAR_ICON_INNER_BUTTON_BASE,
              backgroundColor: settingsHovered ? palette.bgActive : palette.bgPrimary,
              color: settingsHovered ? palette.textPrimary : palette.textSecondary,
              cursor: "pointer",
              transition: "background-color 0.2s ease, color 0.2s ease",
            }}
          >
            <Settings
              size={22}
              strokeWidth={2}
              style={{ display: "block", shapeRendering: "geometricPrecision" }}
            />
          </button>
        </SpaceSidebarSquircleClip>
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

      {sidebarTooltip &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: "fixed",
              left: sidebarTooltip.left,
              top: sidebarTooltip.top,
              transform: "translateY(-50%)",
              zIndex: 10_000,
              pointerEvents: "none",
              padding: "6px 10px",
              borderRadius: 8,
              backgroundColor: palette.bgPrimary,
              color: palette.textPrimary,
              border: `1px solid ${palette.border}`,
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.28)",
              fontSize: 13,
              fontWeight: 500,
              lineHeight: 1.3,
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sidebarTooltip.name}
          </div>,
          document.body
        )}
    </>
  );
}