import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Convert an avatar URL for use in `<img src>`.
 *
 * The Rust backend returns either:
 * - `null` — no avatar
 * - A raw filesystem path (e.g. `/tmp/pax_avatar_xxx.png`) — needs
 *   `convertFileSrc()` to become an `asset://` URL the WebView can load
 * - A `data:` URL (legacy, from before the temp-file migration)
 *
 * This function handles all cases so every `<img src>` site can just
 * call `avatarSrc(url)` without caring about the format.
 */
export function avatarSrc(
  url: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  // Already a usable URL — pass through.
  if (
    url.startsWith("data:") ||
    url.startsWith("http:") ||
    url.startsWith("https:") ||
    url.startsWith("asset:") ||
    url.startsWith("blob:")
  ) {
    return url;
  }
  // Raw filesystem path — convert via Tauri's asset protocol.
  return convertFileSrc(url);
}