import { useSyncExternalStore } from "react";

const STORAGE_KEY_PREFIX = "pax-user-volume:";
const sessionVolumes: Record<string, number> = {};
const listeners = new Set<() => void>();
let revision = 0;

// Match the mixer key for both Matrix peers and device-qualified LiveKit identities.
function volumeUserId(identity: string): string {
  const [user] = identity.split("|");
  return user.split(":").slice(0, 2).join(":");
}

export function getStoredVolume(identity: string, source = "microphone"): number {
  const user = volumeUserId(identity);
  const key = `${user}::${source}`;
  if (key in sessionVolumes) return sessionVolumes[key];

  try {
    let raw = localStorage.getItem(STORAGE_KEY_PREFIX + key);
    if (raw === null) {
      // A direct call has only the MXID when looking up an older room's device-keyed slider.
      const devicePrefix = `${STORAGE_KEY_PREFIX}${user}|`;
      const legacyKey = Object.keys(localStorage).find(item => item.startsWith(devicePrefix) && item.endsWith(`::${source}`));
      if (legacyKey) raw = localStorage.getItem(legacyKey);
      if (raw !== null) localStorage.setItem(STORAGE_KEY_PREFIX + key, raw);
    }
    if (raw !== null) {
      const value = parseFloat(raw);
      if (value >= 0 && value <= 2) {
        sessionVolumes[key] = value;
        return value;
      }
    }
    sessionVolumes[key] = 1;
  } catch {
    // localStorage may be unavailable.
  }
  return 1;
}

function setVolume(identity: string, volume: number, source = "microphone") {
  const key = `${volumeUserId(identity)}::${source}`;
  const clamped = Math.max(0, Math.min(2, volume));
  sessionVolumes[key] = clamped;
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + key, String(clamped));
  } catch {
    // The in-memory preference still applies to this session.
  }
  revision++;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

const getRevision = () => revision;

export function useUserVolume() {
  useSyncExternalStore(subscribe, getRevision);
  return { getVolume: getStoredVolume, setVolume, volumes: sessionVolumes };
}
