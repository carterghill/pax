export const VOICE_ROOM_TYPE = "org.matrix.msc3417.call";

export const normalizeUserId = (id: string): string => id.trim().toLowerCase();

export const localpartFromUserId = (id: string): string => {
  const trimmed = id.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  const withoutAt = trimmed.slice(1);
  const idx = withoutAt.indexOf(":");
  return idx === -1 ? withoutAt : withoutAt.slice(0, idx);
};

/** LiveKit identities may include device suffixes; Matrix roster uses plain MXIDs. */
export const extractMatrixUserId = (identity: string): string => {
  const trimmed = identity.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  const match = trimmed.match(/^@[^|/\s]+/);
  return match ? match[0] : trimmed;
};
