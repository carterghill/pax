/** Matrix room type for voice channels (MSC3417).
 *  Also defined in the Rust backend at `src-tauri/src/commands/voice_matrix.rs` — keep both in sync. */
 export const VOICE_ROOM_TYPE = "org.matrix.msc3417.call";

/** Matrix space rooms (`creation_content.type` / room type `m.space`). */
export const SPACE_ROOM_TYPE = "m.space";

 export const normalizeUserId = (id: string): string => id.trim().toLowerCase();

 const SIGNUP_LOCALPART_ALLOWED = /[^0-9a-z._=\-\/]/g;

 /**
  * Registration username as stored: first whitespace-delimited word only, lowercased,
  * characters limited to Matrix unquoted localpart set (digits, a-z, . _ = - /).
  */
 export function sanitizeSignupUsernameInput(raw: string): string {
   const trimmed = raw.trim();
   if (!trimmed) return "";
   const first = trimmed.split(/\s+/)[0] ?? "";
   return first.toLowerCase().replace(SIGNUP_LOCALPART_ALLOWED, "");
 }

 /** Hostname from a homeserver base URL (for @user:server previews). */
 export function homeserverUrlToHostname(url: string): string | null {
   const t = url.trim();
   if (!t) return null;
   try {
     const parsed = new URL(t.includes("://") ? t : `https://${t}`);
     return parsed.hostname || null;
   } catch {
     return null;
   }
 }

 const MXID_RE = /^@[^:\s]+:[^:\s/]+$/;

 /**
  * Parse pasted or typed invite input into a canonical Matrix user ID, or null if invalid.
  * Accepts `@localpart:server`, `localpart:server`, and matrix.to user links.
  */
 export function parseInviteUserInput(raw: string): string | null {
   const trimmed = raw.trim();
   if (!trimmed) return null;

   let candidate = trimmed;

   // matrix.to user link: https://matrix.to/#/@user:server or #/@user:server
   const matrixTo = trimmed.match(/#\/(@[^/?#]+:[^/?#]+)/);
   if (matrixTo?.[1]) {
     candidate = matrixTo[1];
   } else if (trimmed.includes("matrix.to")) {
     const hash = trimmed.split("#")[1];
     if (hash) {
       const m = hash.match(/(@[^/?#]+:[^/?#]+)/);
       if (m?.[1]) candidate = m[1];
     }
   }

   if (!candidate.startsWith("@")) {
     const colonIdx = candidate.indexOf(":");
     if (colonIdx > 0 && !candidate.includes(" ") && !candidate.includes("/")) {
       candidate = `@${candidate}`;
     }
   }

   candidate = normalizeUserId(candidate);
   return MXID_RE.test(candidate) ? candidate : null;
 }

 /** Case-insensitive display order; tie-break on stable id for deterministic lists. */
 export function compareByDisplayThenKey(
   aDisplay: string,
   aKey: string,
   bDisplay: string,
   bKey: string
 ): number {
   const c = aDisplay.toLowerCase().localeCompare(bDisplay.toLowerCase());
   if (c !== 0) return c;
   return aKey.localeCompare(bKey);
 }
 
 export const localpartFromUserId = (id: string): string => {
   const trimmed = id.trim();
   if (!trimmed.startsWith("@")) return trimmed;
   const withoutAt = trimmed.slice(1);
   const idx = withoutAt.indexOf(":");
   return idx === -1 ? withoutAt : withoutAt.slice(0, idx);
 };
 
 /**
  * Normalize a LiveKit / SFU identity toward a Matrix MXID for lookups.
  *
  * LiveKit identities use the format `@localpart:server:deviceId` (the Rust
  * backend joins `userId:deviceId`).  Matrix MXIDs are `@localpart:server`.
  * We need to strip the trailing `:deviceId` to get a matchable MXID.
  *
  * Also handles `|device` suffixes (older format) and bare `localpart:server`.
  */
 export const extractMatrixUserId = (identity: string): string => {
   // Strip |device suffix (older format)
   const trimmed = identity.trim().split("|")[0].trim();
 
   if (trimmed.startsWith("@")) {
     // Split into parts: ["", "localpart", "server", ...deviceId...]
     // We want @localpart:server — the first two colon-separated segments after @
     const rest = trimmed.slice(1); // remove @
     const parts = rest.split(":");
     if (parts.length >= 2) {
       return normalizeUserId(`@${parts[0]}:${parts[1]}`);
     }
     return normalizeUserId(trimmed);
   }
 
   // Bare localpart:server or localpart:server:device
   const parts = trimmed.split(":");
   if (parts.length >= 2) {
     return normalizeUserId(`@${parts[0]}:${parts[1]}`);
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

/** Synthetic room id for a DM draft before the Matrix room exists (must not collide with real ids). */
export const PENDING_DM_ROOM_PREFIX = "__pax_dm_draft:";

export function pendingDmRoomId(peerUserId: string): string {
  return `${PENDING_DM_ROOM_PREFIX}${peerUserId}`;
}

export function isPendingDmRoomId(roomId: string): boolean {
  return roomId.startsWith(PENDING_DM_ROOM_PREFIX);
}

export function parsePendingDmPeerUserId(roomId: string): string | null {
  if (!isPendingDmRoomId(roomId)) return null;
  return roomId.slice(PENDING_DM_ROOM_PREFIX.length);
}