import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  type MouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";

let bodyScrollLockDepth = 0;
let bodyScrollLockSavedOverflow = "";

function acquireBodyScrollLock() {
  if (bodyScrollLockDepth++ === 0) {
    bodyScrollLockSavedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
}

function releaseBodyScrollLock() {
  if (--bodyScrollLockDepth <= 0) {
    bodyScrollLockDepth = 0;
    document.body.style.overflow = bodyScrollLockSavedOverflow;
  }
}

/**
 * App chrome only — stays below {@link MODAL_LAYER_Z} so settings/dialogs stay on top.
 * High enough to cover sidebars and the main composer.
 */
export const SIDE_DRAWER_BACKDROP_Z = 10_000;
export const SIDE_DRAWER_PANEL_Z = 10_001;

/** Edge zone in px where a touch-start begins an edge swipe. */
const EDGE_ZONE_PX = 24;
/** Fraction of panel width a drag must cross to commit open/close. */
const DRAG_COMMIT_FRACTION = 0.35;
/** CSS transition duration in ms. */
const TRANSITION_MS = 200;

export interface SideDrawerProps {
  open: boolean;
  onClose: () => void;
  side: "left" | "right";
  /** Panel width in px (fixed); content should match. */
  widthPx: number;
  children: ReactNode;
  /** When true, locks document body scroll while open. */
  lockBodyScroll?: boolean;
  /** Enable swipe-from-edge to open and drag-to-close gestures. */
  enableSwipeGesture?: boolean;
  /** Called when an edge swipe should open the drawer (caller sets open=true). */
  onSwipeOpen?: () => void;
}

export default function SideDrawer({
  open,
  onClose,
  side,
  widthPx,
  children,
  lockBodyScroll = true,
  enableSwipeGesture = false,
  onSwipeOpen,
}: SideDrawerProps) {
  /* ------------------------------------------------------------------ */
  /*  Mounting & animation state                                        */
  /* ------------------------------------------------------------------ */

  // `mounted` keeps the DOM alive during close animations.
  const [mounted, setMounted] = useState(false);
  // `animTarget` is the end-state the CSS transition is aiming for.
  const [animTarget, setAnimTarget] = useState<"open" | "closed">("closed");
  // Set by edge-swipe commit so the open transition skips the rAF delay.
  const fromEdgeSwipeRef = useRef(false);

  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      if (fromEdgeSwipeRef.current) {
        // Opened via edge swipe — panel is already near the open position,
        // so set animTarget immediately (no two-rAF delay) and clear edge
        // drag state.  Since useLayoutEffect runs before paint, the user
        // sees no jump.
        fromEdgeSwipeRef.current = false;
        setAnimTarget("open");
        setEdgeActive(false);
        setEdgeDragPx(0);
        return;
      }
      // Two rAFs so the browser paints the off-screen position first.
      const id = requestAnimationFrame(() =>
        requestAnimationFrame(() => setAnimTarget("open")),
      );
      return () => cancelAnimationFrame(id);
    } else {
      // Trigger close animation (panel stays mounted until transitionEnd).
      setAnimTarget("closed");
    }
  }, [open]);

  const handleTransitionEnd = useCallback(() => {
    if (animTarget === "closed" && !open) {
      setMounted(false);
    }
  }, [animTarget, open]);

  // Fallback: if transitionEnd never fires (e.g. rapid open/close), unmount after timeout.
  useEffect(() => {
    if (animTarget === "closed" && !open && mounted) {
      const id = setTimeout(() => setMounted(false), TRANSITION_MS + 50);
      return () => clearTimeout(id);
    }
  }, [animTarget, open, mounted]);

  /* ------------------------------------------------------------------ */
  /*  Body scroll lock                                                   */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!mounted || !lockBodyScroll) return;
    acquireBodyScrollLock();
    return () => releaseBodyScrollLock();
  }, [mounted, lockBodyScroll]);

  /* ------------------------------------------------------------------ */
  /*  Escape key                                                         */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /* ------------------------------------------------------------------ */
  /*  Drag-to-close (when panel is open)                                */
  /* ------------------------------------------------------------------ */

  const dragRef = useRef<{
    startX: number;
    startY: number;
    committed: boolean;
    rejected: boolean;
  } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragOffsetRef = useRef(0);
  dragOffsetRef.current = dragOffset;
  const dragging = dragRef.current?.committed === true && dragOffset !== 0;

  const handlePanelTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (!open) return;
      const t = e.touches[0];
      dragRef.current = {
        startX: t.clientX,
        startY: t.clientY,
        committed: false,
        rejected: false,
      };
    },
    [open],
  );

  const handlePanelTouchMove = useCallback(
    (e: ReactTouchEvent) => {
      const d = dragRef.current;
      if (!d || d.rejected) return;
      const t = e.touches[0];
      const dx = t.clientX - d.startX;
      const dy = t.clientY - d.startY;

      if (!d.committed) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          d.rejected = true;
          return;
        }
        d.committed = true;
      }

      // Only allow dragging toward the closed edge.
      const closeDx = side === "left" ? -dx : dx;
      const clamped = Math.max(0, closeDx);
      setDragOffset(clamped);
    },
    [side],
  );

  const handlePanelTouchEnd = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.committed) {
      setDragOffset(0);
      return;
    }
    if (dragOffsetRef.current > widthPx * DRAG_COMMIT_FRACTION) {
      onClose();
    }
    setDragOffset(0);
  }, [widthPx, onClose]);

  /* ------------------------------------------------------------------ */
  /*  Edge-swipe to open (when panel is closed)                         */
  /* ------------------------------------------------------------------ */

  const [edgeDragPx, setEdgeDragPx] = useState(0);
  const edgeDragPxRef = useRef(0);
  edgeDragPxRef.current = edgeDragPx;
  const [edgeActive, setEdgeActive] = useState(false);
  const edgeRef = useRef<{
    startX: number;
    startY: number;
    committed: boolean;
    rejected: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enableSwipeGesture || open || typeof window === "undefined") return;

    const onStart = (e: globalThis.TouchEvent) => {
      const t = e.touches[0];
      const inLeft = side === "left" && t.clientX < EDGE_ZONE_PX;
      const inRight =
        side === "right" && t.clientX > window.innerWidth - EDGE_ZONE_PX;
      if (inLeft || inRight) {
        edgeRef.current = {
          startX: t.clientX,
          startY: t.clientY,
          committed: false,
          rejected: false,
        };
      }
    };

    const onMove = (e: globalThis.TouchEvent) => {
      const d = edgeRef.current;
      if (!d || d.rejected) return;
      const t = e.touches[0];
      const dx = t.clientX - d.startX;
      const dy = t.clientY - d.startY;

      if (!d.committed) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        const isOpening = side === "left" ? dx > 0 : dx < 0;
        if (Math.abs(dy) > Math.abs(dx) || !isOpening) {
          d.rejected = true;
          return;
        }
        d.committed = true;
        setEdgeActive(true);
      }

      const progress = Math.min(widthPx, Math.abs(dx));
      setEdgeDragPx(progress);
      e.preventDefault();
    };

    const onEnd = () => {
      const d = edgeRef.current;
      edgeRef.current = null;
      if (!d?.committed) {
        setEdgeActive(false);
        setEdgeDragPx(0);
        return;
      }
      if (edgeDragPxRef.current > widthPx * DRAG_COMMIT_FRACTION) {
        // Commit: keep edgeActive/edgeDragPx alive so the panel stays in
        // the DOM at its current position.  The useLayoutEffect for `open`
        // will clear them synchronously before paint.
        fromEdgeSwipeRef.current = true;
        onSwipeOpen?.();
      } else {
        setEdgeActive(false);
        setEdgeDragPx(0);
      }
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enableSwipeGesture, open, side, widthPx, onSwipeOpen]);

  /* ------------------------------------------------------------------ */
  /*  Compute transform & backdrop opacity                              */
  /* ------------------------------------------------------------------ */

  const stopPanelClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  const showEdgeOverlay = edgeActive && !open;
  // Keep panel in the DOM during edge-swipe commit (edgeActive && open) so
  // children don't unmount/remount.
  const showPanel = mounted || edgeActive;

  if (!showPanel || typeof document === "undefined") return null;

  let translatePx: number;
  let useTransition: boolean;

  if (showEdgeOverlay) {
    // Dragging from edge: panel tracks finger, no CSS transition.
    const offscreen = side === "left" ? -widthPx : widthPx;
    translatePx = offscreen + (side === "left" ? edgeDragPx : -edgeDragPx);
    useTransition = false;
  } else if (edgeActive && open) {
    // Edge swipe just committed — show panel at fully-open position while
    // useLayoutEffect clears the edge state in the same paint frame.
    translatePx = 0;
    useTransition = false;
  } else if (dragging) {
    // Dragging to close: panel offset by drag amount, no CSS transition.
    translatePx = side === "left" ? -dragOffset : dragOffset;
    useTransition = false;
  } else {
    // Normal open/close via CSS transition.
    translatePx =
      animTarget === "open"
        ? 0
        : side === "left"
          ? -widthPx
          : widthPx;
    useTransition = true;
  }

  const transform = `translateX(${translatePx}px)`;

  // Backdrop opacity: 0 when fully closed, 0.45 when fully open.
  let backdropOpacity: number;
  if (showEdgeOverlay) {
    backdropOpacity = 0.45 * Math.min(1, edgeDragPx / widthPx);
  } else if (edgeActive && open) {
    backdropOpacity = 0.45;
  } else if (dragging) {
    backdropOpacity = 0.45 * Math.max(0, 1 - dragOffset / widthPx);
  } else {
    backdropOpacity = animTarget === "open" ? 0.45 : 0;
  }

  const node = (
    <>
      {/* Backdrop */}
      <div
        role="presentation"
        onClick={open ? onClose : undefined}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: `rgba(0, 0, 0, ${backdropOpacity})`,
          zIndex: SIDE_DRAWER_BACKDROP_Z,
          transition: useTransition
            ? `background-color ${TRANSITION_MS}ms ease-out`
            : "none",
        }}
        onTransitionEnd={handleTransitionEnd}
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        onClick={stopPanelClick}
        onTouchStart={handlePanelTouchStart}
        onTouchMove={handlePanelTouchMove}
        onTouchEnd={handlePanelTouchEnd}
        onTouchCancel={handlePanelTouchEnd}
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: side === "left" ? 0 : undefined,
          right: side === "right" ? 0 : undefined,
          width: widthPx,
          maxWidth: "min(100vw, 100dvw)",
          zIndex: SIDE_DRAWER_PANEL_Z,
          transform,
          transition: useTransition
            ? `transform ${TRANSITION_MS}ms ease-out`
            : "none",
          boxShadow:
            side === "left"
              ? "6px 0 24px rgba(0,0,0,0.28)"
              : "-6px 0 24px rgba(0,0,0,0.28)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          paddingLeft: "env(safe-area-inset-left, 0px)",
          paddingRight: "env(safe-area-inset-right, 0px)",
          willChange: useTransition ? "transform" : undefined,
          touchAction: "pan-y",
        }}
        onTransitionEnd={handleTransitionEnd}
      >
        {children}
      </div>
    </>
  );

  return createPortal(node, document.body);
}