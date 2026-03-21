/**
 * OverlayObstructions — manages clip regions and hover state for native
 * video overlays.
 *
 * Clip regions:  When DOM elements overlap the native video HWND, we clip
 * those pixels out so the DOM content shows through.
 *
 * Hover state:  The native HWND tracks WM_MOUSEMOVE / WM_MOUSELEAVE in Rust.
 * We poll the hover state and expose it to React via useOverlayHover().
 * This lets the frontend show border highlights, controls, etc.
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

// ─── Hover state ────────────────────────────────────────────────────────────

/** Current hover states, polled from Rust every few frames. */
const hoverStates: Map<string, boolean> = new Map();

/** Listeners that want to be notified when hover states change. */
const hoverListeners: Set<() => void> = new Set();

let hoverPollCounter = 0;

function notifyHoverListeners() {
  for (const listener of hoverListeners) {
    listener();
  }
}

// ─── Registration API ───────────────────────────────────────────────────────

export function registerOverlay(identity: string, element: HTMLElement) {
  overlays.set(identity, { identity, element });
  startLoop();
}

export function unregisterOverlay(identity: string) {
  overlays.delete(identity);
  lastSent.delete(identity);
  hoverStates.delete(identity);
  invoke("overlay_set_obstructions", { identity, obstructions: [] }).catch(() => {});
  if (overlays.size === 0) {
    stopLoop();
  }
}

export function registerObstruction(element: HTMLElement): number {
  const id = nextObstructionId++;
  obstructions.set(id, { id, element });
  return id;
}

export function unregisterObstruction(id: number) {
  obstructions.delete(id);
}

// ─── React hooks ────────────────────────────────────────────────────────────

/**
 * Hook for popup/modal/dropdown components.
 * Automatically registers/unregisters the element as an obstruction.
 */
export function useOverlayObstruction(
  ref: React.RefObject<HTMLElement | null>,
  visible: boolean = true,
) {
  const idRef = useRef<number | null>(null);

  // useLayoutEffect: ref is attached before this runs; avoids a frame where the
  // obstruction map is empty while the menu is already painted.
  useLayoutEffect(() => {
    if (!visible) {
      if (idRef.current !== null) {
        unregisterObstruction(idRef.current);
        idRef.current = null;
      }
      return;
    }
    const el = ref.current;
    if (!el) return;
    if (idRef.current !== null) {
      unregisterObstruction(idRef.current);
    }
    idRef.current = registerObstruction(el);
    return () => {
      if (idRef.current !== null) {
        unregisterObstruction(idRef.current);
        idRef.current = null;
      }
    };
  }, [visible, ref]);
}

/**
 * Hook to get native overlay hover state for a given stream identity.
 * Returns true when the mouse cursor is over the native video HWND.
 * Updates at ~20fps (polled every 3rd rAF frame).
 */
export function useOverlayHover(identity: string): boolean {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const listener = () => {
      const newVal = hoverStates.get(identity) ?? false;
      setHovered((prev) => (prev !== newVal ? newVal : prev));
    };
    hoverListeners.add(listener);
    listener();
    return () => {
      hoverListeners.delete(listener);
    };
  }, [identity]);

  return hovered;
}

// ─── Main loop ──────────────────────────────────────────────────────────────

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

  // ── Obstruction computation ──
  for (const [identity, overlay] of overlays) {
    const overlayRect = overlay.element.getBoundingClientRect();
    if (overlayRect.width <= 0 || overlayRect.height <= 0) continue;

    const clipRects: ObstructionRect[] = [];

    for (const [, obs] of obstructions) {
      const obsRect = obs.element.getBoundingClientRect();
      if (obsRect.width <= 0 || obsRect.height <= 0) continue;

      const ix1 = Math.max(overlayRect.left, obsRect.left);
      const iy1 = Math.max(overlayRect.top, obsRect.top);
      const ix2 = Math.min(overlayRect.right, obsRect.right);
      const iy2 = Math.min(overlayRect.bottom, obsRect.bottom);

      if (ix2 > ix1 && iy2 > iy1) {
        const w = Math.round((ix2 - ix1) * dpr);
        const h = Math.round((iy2 - iy1) * dpr);
        if (w < 1 || h < 1) continue;
        clipRects.push({
          x: Math.round((ix1 - overlayRect.left) * dpr),
          y: Math.round((iy1 - overlayRect.top) * dpr),
          w,
          h,
        });
      }
    }

    const key = JSON.stringify(clipRects);
    if (lastSent.get(identity) !== key) {
      invoke("overlay_set_obstructions", { identity, obstructions: clipRects })
        .then(() => {
          lastSent.set(identity, key);
        })
        .catch((e) => {
          console.error("[Pax] overlay_set_obstructions failed:", e);
        });
    }
  }

  // ── Hover state polling (every 3rd frame ≈ 20fps) ──
  hoverPollCounter++;
  if (hoverPollCounter % 3 === 0) {
    invoke<Record<string, boolean>>("overlay_get_hover_states")
      .then((states) => {
        let changed = false;
        for (const [identity, hovered] of Object.entries(states)) {
          if (hoverStates.get(identity) !== hovered) {
            hoverStates.set(identity, hovered);
            changed = true;
          }
        }
        // Clear stale entries
        for (const [identity] of hoverStates) {
          if (!(identity in states)) {
            hoverStates.delete(identity);
            changed = true;
          }
        }
        if (changed) {
          notifyHoverListeners();
        }
      })
      .catch(() => {});
  }
}