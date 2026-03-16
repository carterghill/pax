/**
 * OverlayObstructions — manages clip regions for native video overlays.
 *
 * When DOM elements (modals, dropdowns, tooltips) overlap the native video
 * HWND, we need to clip those pixels out so the DOM content shows through.
 *
 * Architecture:
 *   - ScreenShareViewer registers its identity + container rect
 *   - Any component with a popup/overlay calls registerObstruction(element)
 *   - A rAF loop computes intersections and sends clip rects to Rust
 *   - Rust applies SetWindowRgn to cut holes in the HWND
 *
 * Usage:
 *   // In ScreenShareViewer (already done — registers via containerRef)
 *   registerOverlay(identity, containerElement);
 *   unregisterOverlay(identity);
 *
 *   // In any popup/modal/dropdown component:
 *   const id = registerObstruction(myDivRef.current);
 *   // on cleanup:
 *   unregisterObstruction(id);
 *
 *   // Or use the React hook:
 *   useOverlayObstruction(ref, isVisible);
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface OverlayInfo {
  identity: string;
  element: HTMLElement;
}

interface ObstructionInfo {
  id: number;
  element: HTMLElement;
}

interface ObstructionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ─── Global state ───────────────────────────────────────────────────────────

const overlays: Map<string, OverlayInfo> = new Map();
const obstructions: Map<number, ObstructionInfo> = new Map();
let nextObstructionId = 1;
let rafId = 0;
let running = false;

// Cache last-sent obstructions per identity to avoid redundant invokes
const lastSent: Map<string, string> = new Map();

// ─── Registration API ───────────────────────────────────────────────────────

/** Register a native video overlay.  Called by ScreenShareViewer. */
export function registerOverlay(identity: string, element: HTMLElement) {
  overlays.set(identity, { identity, element });
  startLoop();
}

/** Unregister a native video overlay.  Called on ScreenShareViewer cleanup. */
export function unregisterOverlay(identity: string) {
  overlays.delete(identity);
  lastSent.delete(identity);
  // Clear obstructions on Rust side
  invoke("overlay_set_obstructions", { identity, obstructions: [] }).catch(() => {});
  if (overlays.size === 0) {
    stopLoop();
  }
}

/**
 * Register a DOM element as an obstruction (modal, dropdown, tooltip, etc).
 * Returns an ID for unregistration.
 */
export function registerObstruction(element: HTMLElement): number {
  const id = nextObstructionId++;
  obstructions.set(id, { id, element });
  return id;
}

/** Unregister an obstruction. */
export function unregisterObstruction(id: number) {
  obstructions.delete(id);
}

// ─── React hook ─────────────────────────────────────────────────────────────

/**
 * Hook for popup/modal/dropdown components.
 * Pass a ref to the popup's root element and whether it's currently visible.
 * Automatically registers/unregisters the obstruction.
 *
 * @example
 *   const menuRef = useRef<HTMLDivElement>(null);
 *   useOverlayObstruction(menuRef, isMenuOpen);
 */
export function useOverlayObstruction(
  ref: React.RefObject<HTMLElement | null>,
  visible: boolean = true,
) {
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    if (visible && ref.current) {
      idRef.current = registerObstruction(ref.current);
    }
    return () => {
      if (idRef.current !== null) {
        unregisterObstruction(idRef.current);
        idRef.current = null;
      }
    };
  }, [visible, ref.current]);
}

// ─── Intersection computation loop ─────────────────────────────────────────

function startLoop() {
  if (running) return;
  running = true;
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
}

function tick() {
  if (!running) return;
  rafId = requestAnimationFrame(tick);

  if (overlays.size === 0) return;

  const dpr = window.devicePixelRatio || 1;

  // For each overlay, compute which obstructions intersect it
  for (const [identity, overlay] of overlays) {
    const overlayRect = overlay.element.getBoundingClientRect();
    if (overlayRect.width <= 0 || overlayRect.height <= 0) continue;

    const clipRects: ObstructionRect[] = [];

    for (const [, obs] of obstructions) {
      const obsRect = obs.element.getBoundingClientRect();
      if (obsRect.width <= 0 || obsRect.height <= 0) continue;

      // Compute intersection in CSS pixels
      const ix1 = Math.max(overlayRect.left, obsRect.left);
      const iy1 = Math.max(overlayRect.top, obsRect.top);
      const ix2 = Math.min(overlayRect.right, obsRect.right);
      const iy2 = Math.min(overlayRect.bottom, obsRect.bottom);

      if (ix2 > ix1 && iy2 > iy1) {
        // Convert to physical pixels relative to overlay origin
        clipRects.push({
          x: Math.round((ix1 - overlayRect.left) * dpr),
          y: Math.round((iy1 - overlayRect.top) * dpr),
          w: Math.round((ix2 - ix1) * dpr),
          h: Math.round((iy2 - iy1) * dpr),
        });
      }
    }

    // Only invoke if obstructions changed
    const key = JSON.stringify(clipRects);
    if (lastSent.get(identity) !== key) {
      lastSent.set(identity, key);
      invoke("overlay_set_obstructions", { identity, obstructions: clipRects })
        .catch(() => {});
    }
  }
}