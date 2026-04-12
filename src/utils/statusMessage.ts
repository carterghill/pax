/** Sentinel prepended to `status_msg` when the user enables Do Not Disturb. */
export const DND_PREFIX = "[dnd]";

/**
 * Compose a Matrix `status_msg` string from the DND flag and user-visible status text.
 *
 * Examples:
 *   composeStatusMsg(true,  "Listening to music") → "[dnd]Listening to music"
 *   composeStatusMsg(true,  "")                   → "[dnd]"
 *   composeStatusMsg(false, "Listening to music")  → "Listening to music"
 *   composeStatusMsg(false, "")                    → ""
 */
export function composeStatusMsg(isDnd: boolean, statusText: string): string {
  const trimmed = statusText.trim();
  if (isDnd) return `${DND_PREFIX}${trimmed}`;
  return trimmed;
}

/**
 * Parse a raw Matrix `status_msg` into its DND flag and user-visible text.
 * Handles null/undefined gracefully.
 */
export function parseStatusMsg(raw: string | null | undefined): {
  isDnd: boolean;
  text: string;
} {
  if (!raw) return { isDnd: false, text: "" };
  if (raw.startsWith(DND_PREFIX)) {
    return { isDnd: true, text: raw.slice(DND_PREFIX.length) };
  }
  return { isDnd: false, text: raw };
}

/**
 * Resolve the effective presence for display, taking the `[dnd]` status_msg
 * sentinel into account.  Remote users whose `status_msg` starts with `[dnd]`
 * are shown as "dnd" regardless of the raw Matrix presence state.
 */
export function resolvePresenceWithDnd(
  rawPresence: string,
  statusMsg: string | null | undefined,
): string {
  const { isDnd } = parseStatusMsg(statusMsg);
  if (isDnd) return "dnd";
  return rawPresence;
}