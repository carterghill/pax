/**
 * Read-receipt privacy preference.
 *
 * Matrix has two receipt types that both clear notification counts and sync read
 * state across the user's own devices:
 *
 *   - `m.read`         — public; federated to every other user; drives the avatar
 *                        indicator in Element / Cinny so others can see what you've
 *                        read.
 *   - `m.read.private` — private; never federated; same effect on notification
 *                        counts.
 *
 * Pax defaults to private because that matches modern expectations (Discord-style
 * privacy; the app's primary audience is friend-group servers where "I saw this
 * 3 hours ago and didn't reply" anxiety is a real thing).  This toggle lets users
 * opt in to the public behaviour if they want the social cue.
 *
 * Storage key is namespaced under `pax.settings.*` so we can safely prefix-scan
 * settings later for export/reset without matching legacy keys.
 */

const STORAGE_KEY = "pax.settings.sendPublicReceipts";

export function getSendPublicReceipts(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setSendPublicReceipts(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
    // Notify any listeners in the same tab.  `storage` events only fire across
    // tabs, so we dispatch our own CustomEvent for intra-tab subscribers (e.g.
    // `useReadReceiptSender`, which reads this value at invoke time).
    window.dispatchEvent(new CustomEvent("pax:settings-changed", { detail: { key: STORAGE_KEY } }));
  } catch {
    /* quota / private mode — best effort */
  }
}