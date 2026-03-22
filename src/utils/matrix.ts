export const VOICE_ROOM_TYPE = "org.matrix.msc3417.call";

export const normalizeUserId = (id: string): string => id.trim().toLowerCase();

export const localpartFromUserId = (id: string): string => {
  const trimmed = id.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  const withoutAt = trimmed.slice(1);
  const idx = withoutAt.indexOf(":");
  return idx === -1 ? withoutAt : withoutAt.slice(0, idx);
};

/**
 * Normalize a LiveKit / SFU identity toward a Matrix MXID for lookups.
 * Strips `|device` suffixes and adds `@` for `localpart:server` forms.
 */
export const extractMatrixUserId = (identity: string): string => {
  const trimmed = identity.trim().split("|")[0].trim();
  if (trimmed.startsWith("@")) {
    const rest = trimmed.slice(1);
    const idx = rest.indexOf(":");
    if (idx >= 0) {
      return normalizeUserId(`@${rest.slice(0, idx)}:${rest.slice(idx + 1)}`);
    }
    return normalizeUserId(trimmed);
  }
  const idx = trimmed.indexOf(":");
  if (idx >= 0) {
    return normalizeUserId(`@${trimmed.slice(0, idx)}:${trimmed.slice(idx + 1)}`);
  }
  return normalizeUserId(trimmed);
};

/** Keys used to match Matrix roster rows to LiveKit / in-call participant state. */
export function voiceStateLookupKeysForParticipant(p: {
  userId: string;
  displayName?: string | null;
}): string[] {
  const keys = new Set<string>();
  const add = (raw: string) => {
    const n = normalizeUserId(raw);
    if (n) keys.add(n);
  };
  add(p.userId.split("|")[0]);
  add(localpartFromUserId(p.userId));
  if (p.displayName) add(p.displayName);
  return [...keys];
}

/** Keys to store LiveKit snapshot / in-call state under (per voice room). */
export function voiceStateLookupKeysForLiveKitIdentity(identity: string): string[] {
  const keys = new Set<string>();
  const add = (raw: string) => {
    const n = normalizeUserId(raw);
    if (n) keys.add(n);
  };
  const base = identity.trim().split("|")[0].trim();
  add(identity.trim());
  add(base);
  if (!base.startsWith("@") && base.includes(":")) {
    add(`@${base}`);
  }
  const mxid = extractMatrixUserId(identity);
  add(mxid);
  add(localpartFromUserId(mxid.startsWith("@") ? mxid : `@${mxid}`));
  return [...keys];
}
