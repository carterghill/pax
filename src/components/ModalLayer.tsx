import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

/**
 * Z-index for app-wide modal backdrops (portaled to `document.body`).
 * Must stay above `MessageInput` composer popovers (`COMPOSER_POPOVER_Z` = 12_000)
 * and other chrome so dimmers always cover the full UI.
 */
export const MODAL_LAYER_Z = 13_000;

export interface ModalLayerProps {
  children: ReactNode;
  onBackdropClick?: (e: MouseEvent<HTMLDivElement>) => void;
  /** Merged after base fixed fullscreen layer; omit position/inset/zIndex (handled here). */
  backdropStyle?: CSSProperties;
}

/**
 * Full-viewport modal shell: portals to `document.body` with a consistent top z-index
 * so dialogs are not trapped under sidebar / main stacking contexts.
 */
export default function ModalLayer({
  children,
  onBackdropClick,
  backdropStyle,
}: ModalLayerProps) {
  const node = (
    <div
      onClick={onBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: MODAL_LAYER_Z,
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
        ...backdropStyle,
      }}
    >
      {children}
    </div>
  );
  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
