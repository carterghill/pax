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
import { useEffect, useRef, useState } from "react";

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
  /** Physical px; must match serde field on Rust `ObstructionRect`. */
  corner_radius?: number;
}

/** Used border-radius in CSS px → physical px for native round-rect clip. */
function obstructionCornerRadiusPhysicalPx(el: HTMLElement, dpr: number): number {
  const raw = getComputedStyle(el).borderRadius;
  const token = raw.split(/[\s/]+/)[0]?.trim() ?? "";
  if (!token) return 0;
  if (token.endsWith("%")) {
    const rect = el.getBoundingClientRect();
    const pct = parseFloat(token);
    if (!Number.isFinite(pct)) return 0;
    const basis = Math.min(rect.width, rect.height) * dpr;
    return Math.round((pct / 100) * basis);
  }
  const cssPx = parseFloat(token);
  return Number.isFinite(cssPx) ? Math.round(cssPx * dpr) : 0;
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

  // Same registration pattern as commit ce8d3ec ("added border radius to cut-through").
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
        // Keep rounded corners stable at overlay edges by sending the full
        // obstruction element bounds (not the intersected slice).
        const corner_radius = obstructionCornerRadiusPhysicalPx(obs.element, dpr);
        const w = Math.round(obsRect.width * dpr);
        const h = Math.round(obsRect.height * dpr);
        if (w <= 0 || h <= 0) continue;
        clipRects.push({
          x: Math.round((obsRect.left - overlayRect.left) * dpr),
          y: Math.round((obsRect.top - overlayRect.top) * dpr),
          w,
          h,
          ...(corner_radius > 0 ? { corner_radius } : {}),
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