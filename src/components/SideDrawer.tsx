import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
  type MouseEvent,
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

export interface SideDrawerProps {
  open: boolean;
  onClose: () => void;
  side: "left" | "right";
  /** Panel width in px (fixed); content should match. */
  widthPx: number;
  children: ReactNode;
  /** When true, locks document body scroll while open. */
  lockBodyScroll?: boolean;
}

export default function SideDrawer({
  open,
  onClose,
  side,
  widthPx,
  children,
  lockBodyScroll = true,
}: SideDrawerProps) {
  const [drawIn, setDrawIn] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      setDrawIn(false);
      return;
    }
    const id = requestAnimationFrame(() => setDrawIn(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open || !lockBodyScroll) return;
    acquireBodyScrollLock();
    return () => {
      releaseBodyScrollLock();
    };
  }, [open, lockBodyScroll]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const stopPanelClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  if (!open || typeof document === "undefined") return null;

  const hidden =
    side === "left" ? "translateX(-100%)" : "translateX(100%)";
  const shown = "translateX(0)";

  const node = (
    <>
      <div
        role="presentation"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.45)",
          zIndex: SIDE_DRAWER_BACKDROP_Z,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        onClick={stopPanelClick}
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          left: side === "left" ? 0 : undefined,
          right: side === "right" ? 0 : undefined,
          width: widthPx,
          maxWidth: "min(100vw, 100dvw)",
          zIndex: SIDE_DRAWER_PANEL_Z,
          transform: drawIn ? shown : hidden,
          transition: "transform 0.2s ease-out",
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
        }}
      >
        {children}
      </div>
    </>
  );

  return createPortal(node, document.body);
}
