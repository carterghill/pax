const MUTE_KEY = "pax-voice-muted";
const DEAFEN_KEY = "pax-voice-deafened";

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "true";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export function getStoredMutePreference(): boolean {
  return readBool(MUTE_KEY, true);
}

export function setStoredMutePreference(muted: boolean) {
  writeBool(MUTE_KEY, muted);
}

export function getStoredDeafenPreference(): boolean {
  return readBool(DEAFEN_KEY, false);
}

export function setStoredDeafenPreference(deafened: boolean) {
  writeBool(DEAFEN_KEY, deafened);
}
