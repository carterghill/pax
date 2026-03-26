import { useState, useRef, useCallback } from "react";

const STORAGE_KEY_PREFIX = "pax-user-volume:";

/**
 * Normalize a LiveKit identity or Matrix userId to just "@user:server"
 * by taking the first two ':'-separated segments.  This matches the Rust
 * vol_key derivation so that the sidebar (which passes Matrix userId) and
 * the voice view (which passes LiveKit identity with device suffix) both
 * resolve to the same key.
 */
function normalizeIdentity(id: string): string {
  return id.split(":").slice(0, 2).join(":");
}

/**
 * Build a localStorage key for a specific user and audio source.
 * e.g. "pax-user-volume:@user:server::microphone"
 */
function storageKey(userId: string, source: string = "microphone"): string {
  return `${STORAGE_KEY_PREFIX}${normalizeIdentity(userId)}::${source}`;
}

/**
 * Get the stored volume for a user + source from localStorage.
 * Returns a value between 0 and 2 (0% to 200%). Default is 1 (100%).
 */
export function getStoredVolume(userId: string, source: string = "microphone"): number {
  try {
    const raw = localStorage.getItem(storageKey(userId, source));
    if (raw !== null) {
      const val = parseFloat(raw);
      if (!isNaN(val) && val >= 0 && val <= 2) return val;
    }
  } catch {
    // localStorage may be unavailable
  }
  return 1; // default 100%
}

/**
 * Persist a user's volume to localStorage.
 */
function storeVolume(userId: string, volume: number, source: string = "microphone") {
  try {
    localStorage.setItem(storageKey(userId, source), String(volume));
  } catch {
    // ignore
  }
}

/**
 * React hook that provides per-user, per-source volume state backed by localStorage.
 * Volume is a number from 0 to 2 (representing 0% – 200%).
 * Source is "microphone" or "screenshare_audio".
 */
export function useUserVolume() {
  // In-memory cache of volumes we've loaded this session
  const volumesRef = useRef<Record<string, number>>({});
  // Re-render trigger for controlled UI consumers (e.g. volume slider).
  const [, setVersion] = useState(0);

  const getVolume = useCallback((userId: string, source: string = "microphone"): number => {
    const cacheKey = `${normalizeIdentity(userId)}::${source}`;
    if (cacheKey in volumesRef.current) return volumesRef.current[cacheKey];
    const stored = getStoredVolume(userId, source);
    // Lazy-load into in-memory cache without changing function identity.
    volumesRef.current[cacheKey] = stored;
    return stored;
  }, []);

  const setVolume = useCallback((userId: string, volume: number, source: string = "microphone") => {
    const clamped = Math.max(0, Math.min(2, volume));
    const cacheKey = `${normalizeIdentity(userId)}::${source}`;
    storeVolume(userId, clamped, source);
    volumesRef.current[cacheKey] = clamped;
    setVersion((v) => v + 1);
  }, []);

  return { getVolume, setVolume, volumes: volumesRef.current };
}