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
  /**
   * After leaving multiple rooms at once (e.g. leave space + all rooms), run voice disconnect,
   * clear selection if needed, and refresh — once for the whole batch.
   */
  onRoomsLeft?: (roomIds: string[]) => void;
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
      {/* Using a <div role="button"> instead of <button> because
          Chromium/WebView2 internally marks <button> elements as
          "not droppable" and forces the deny cursor when an HTML5
          drag crosses their border pixels — even when a parent's
          dragover handler calls preventDefault.  A div with
          role="button" is semantically equivalent for accessibility
          but doesn't trigger the form-element quirk. */}
      <div
        role="button"
        tabIndex={0}
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
            draggable={false}
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
      </div>
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
  onRoomsLeft,
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
  const [leaveSpaceSubmitKind, setLeaveSpaceSubmitKind] = useState<"only" | "all" | null>(null);
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
  const spaceListRef = useRef<HTMLDivElement>(null);

  // Ref for the window-level listeners so we can remove the exact same
  // function instances on drag end.
  const windowDragListenersRef = useRef<{
    dragover: (e: DragEvent) => void;
    drop: (e: DragEvent) => void;
  } | null>(null);

  const handleSpaceDragStart = useCallback(
    (e: React.DragEvent, spaceId: string) => {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", spaceId);
      } catch {
        /* some browsers reject setData on synthetic events */
      }
      setDraggedSpaceId(spaceId);
      setDropBeforeId(null);

      // Install window-level listeners SYNCHRONOUSLY in dragstart so
      // they're in place before the very first dragover event fires.
      // The previous useEffect approach had a one-frame timing gap
      // (useEffect runs after paint) where dragover events would fire
      // without a listener, causing the deny cursor to flash.
      if (windowDragListenersRef.current) {
        // Shouldn't happen, but clean up defensively.
        document.removeEventListener("dragover", windowDragListenersRef.current.dragover);
        document.removeEventListener("drop", windowDragListenersRef.current.drop);
      }
      const onDragOver = (ev: DragEvent) => {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      };
      const onDrop = (ev: DragEvent) => {
        ev.preventDefault();
      };
      document.addEventListener("dragover", onDragOver);
      document.addEventListener("drop", onDrop);
      windowDragListenersRef.current = { dragover: onDragOver, drop: onDrop };
    },
    []
  );

  const handleSpaceDragEnd = useCallback(() => {
    setDraggedSpaceId(null);
    setDropBeforeId(null);
    if (windowDragListenersRef.current) {
      document.removeEventListener("dragover", windowDragListenersRef.current.dragover);
      document.removeEventListener("drop", windowDragListenersRef.current.drop);
      windowDragListenersRef.current = null;
    }
  }, []);

  // Safety: clean up document-level listeners if the component unmounts
  // mid-drag (e.g. switching to a different layout).
  useEffect(() => {
    return () => {
      if (windowDragListenersRef.current) {
        document.removeEventListener("dragover", windowDragListenersRef.current.dragover);
        document.removeEventListener("drop", windowDragListenersRef.current.drop);
        windowDragListenersRef.current = null;
      }
    };
  }, []);

  /**
   * Compute the drop insertion point from `clientY` relative to the
   * avatar bounding rects.  This runs on the space-list container's
   * `onDragOver` — one handler for the entire column, no per-element
   * wiring needed.  The Y-position approach is inherently gap-proof:
   * gaps, padding, borders, and indicators don't need their own handlers
   * because the container covers them all.
   */
  const handleContainerDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!draggedSpaceId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const container = spaceListRef.current;
      if (!container) return;

      const y = e.clientY;
      const avatars = container.querySelectorAll<HTMLElement>(
        "[data-space-id]"
      );

      // Walk the avatar list top-to-bottom.  The first avatar whose
      // vertical midpoint is below the cursor is the "insert before"
      // target.  If the cursor is below every avatar's midpoint, the
      // target is "end" (append to the bottom).
      let target: string | "end" = "end";
      for (const el of avatars) {
        const rect = el.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const id = el.dataset.spaceId!;
        if (y < mid) {
          target = id;
          break;
        }
      }

      // Suppress indicator when the drop would be a no-op:
      if (
        target === draggedSpaceId ||
        (target === "end" &&
          spaces[spaces.length - 1]?.id === draggedSpaceId) ||
        (target !== "end" &&
          (() => {
            const idx = spaces.findIndex((s) => s.id === target);
            return (
              idx > 0 && spaces[idx - 1].id === draggedSpaceId
            );
          })())
      ) {
        setDropBeforeId(null);
        return;
      }

      setDropBeforeId((prev) => (prev === target ? prev : target));
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

  const handleLeaveSpaceOnly = useCallback(async () => {
    if (!leaveSpace) return;
    setLeaveSpaceError(null);
    setLeaveSpaceSubmitKind("only");
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
      setLeaveSpaceSubmitKind(null);
    }
  }, [leaveSpace, onLeftSpace, onSpacesChanged]);

  const handleLeaveSpaceAndAllRooms = useCallback(async () => {
    if (!leaveSpace) return;
    setLeaveSpaceError(null);
    setLeaveSpaceSubmitKind("all");
    setLeaveSpaceSubmitting(true);
    try {
      const ids = collectRoomIdsInSpaceTree(leaveSpace.id, roomsBySpace);
      const ordered = [...ids].reverse();
      for (const roomId of ordered) {
        await invoke("leave_room", { roomId });
      }
      onRoomsLeft?.(ordered);
      await onSpacesChanged();
      setLeaveSpace(null);
    } catch (e) {
      setLeaveSpaceError(String(e));
    } finally {
      setLeaveSpaceSubmitting(false);
      setLeaveSpaceSubmitKind(null);
    }
  }, [leaveSpace, roomsBySpace, onRoomsLeft, onSpacesChanged]);

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
              <div
                role="button"
                tabIndex={0}
                aria-label="Home"
                onClick={() => onSelectSpace("")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectSpace("");
                  }
                }}
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
              </div>
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

        {/* Space avatars.
         *
         * Drop-position is computed by the container's `onDragOver` from
         * `clientY` vs each avatar's bounding rect midpoint — one handler
         * for the whole column, no per-element wiring, no spacer elements,
         * no gap-seam issues.  A document-level dragover listener (active
         * only during drags) suppresses the deny cursor everywhere else on
         * screen.
         *
         * Each avatar carries a `data-space-id` attribute so the container
         * handler can identify it via `querySelectorAll`. */}
        <div
          ref={spaceListRef}
          onDragOver={handleContainerDragOver}
          onDrop={handleSpaceDrop}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            width: "100%",
          }}
        >
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
                data-space-id={space.id}
                aria-label={space.name}
                draggable={!!onReorderSpaces}
                onDragStart={(e) => handleSpaceDragStart(e, space.id)}
                onDragEnd={handleSpaceDragEnd}
                onClick={(e) => {
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
                  borderRadius: ICON_RADIUS,
                  opacity: isBeingDragged ? 0.35 : 1,
                  transition: "opacity 0.08s linear",
                }}
              >
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
                      backgroundColor: palette.textPrimary,
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
                      backgroundColor: palette.textPrimary,
                      pointerEvents: "none",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Add space button */}
        <SpaceSidebarSquircleClip>
          <div
            role="button"
            tabIndex={0}
            onClick={handleOpenDialog}
            aria-label="Create or join a space"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleOpenDialog();
              }
            }}
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
          </div>
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
          <div
            role="button"
            tabIndex={0}
            onClick={onOpenSettings}
            aria-label="Settings"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenSettings();
              }
            }}
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
          </div>
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
          submittingKind={leaveSpaceSubmitKind}
          error={leaveSpaceError}
          onLeaveSpaceOnly={handleLeaveSpaceOnly}
          onLeaveSpaceAndAllRooms={handleLeaveSpaceAndAllRooms}
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