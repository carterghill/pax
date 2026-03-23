import { useCallback, useRef, useState } from "react";

interface UseResizeHandleOptions {
  /** Current width of the panel being resized. */
  width: number;
  /** Setter called with the new clamped width on each mouse move. */
  onWidthChange: (width: number) => void;
  /** Minimum allowed width. */
  min: number;
  /** Maximum allowed width, or a function that computes it dynamically per drag frame. */
  max: number | (() => number);
  /**
   * Drag direction:
   *   1  = dragging right increases width (default, left-side panels)
   *  -1  = dragging right decreases width (right-side panels)
   */
  direction?: 1 | -1;
}

/**
 * Reusable drag-to-resize logic for panel dividers.
 *
 * Returns `onMouseDown` + hover state to wire onto a thin `<div>` handle.
 */
export function useResizeHandle({
  width,
  onWidthChange,
  min,
  max,
  direction = 1,
}: UseResizeHandleOptions) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const [isHovered, setIsHovered] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startXRef.current;
        const maxW = typeof max === "function" ? max() : max;
        const next = Math.max(min, Math.min(maxW, startWidthRef.current + dx * direction));
        onWidthChange(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, onWidthChange, min, max, direction],
  );

  return { onMouseDown, isHovered, setIsHovered };
}