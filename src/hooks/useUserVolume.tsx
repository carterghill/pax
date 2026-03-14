import { useState, useRef, useCallback } from "react";

const STORAGE_KEY_PREFIX = "pax-user-volume:";

/**
 * Get the stored volume for a user from localStorage.
 * Returns a value between 0 and 2 (0% to 200%). Default is 1 (100%).
 */
export function getStoredVolume(userId: string): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + userId);
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
function storeVolume(userId: string, volume: number) {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + userId, String(volume));
  } catch {
    // ignore
  }
}

/**
 * React hook that provides per-user volume state backed by localStorage.
 * Volume is a number from 0 to 2 (representing 0% – 200%).
 */
export function useUserVolume() {
  // In-memory cache of volumes we've loaded this session
  const volumesRef = useRef<Record<string, number>>({});
  // Re-render trigger for controlled UI consumers (e.g. volume slider).
  const [, setVersion] = useState(0);

  const getVolume = useCallback((userId: string): number => {
    if (userId in volumesRef.current) return volumesRef.current[userId];
    const stored = getStoredVolume(userId);
    // Lazy-load into in-memory cache without changing function identity.
    volumesRef.current[userId] = stored;
    return stored;
  }, []);

  const setVolume = useCallback((userId: string, volume: number) => {
    const clamped = Math.max(0, Math.min(2, volume));
    storeVolume(userId, clamped);
    volumesRef.current[userId] = clamped;
    setVersion((v) => v + 1);
  }, []);

  return { getVolume, setVolume, volumes: volumesRef.current };
}