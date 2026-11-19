import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Global click interceptor for external links.
 *
 * Tauri's webview on Linux doesn't handle `<a target="_blank">` — it silently
 * does nothing.  This hook attaches a single delegated listener on `document`
 * that catches clicks on `<a>` elements with external `href`s and opens them
 * via the Tauri opener plugin (which uses xdg-open / open / start under the
 * hood).
 *
 * Call once at the app root (App.tsx).
 */
export function useExternalLinkInterceptor(): void {
  useEffect(() => {
    function handler(e: MouseEvent) {
      // Walk up from the click target to find the nearest <a>.
      const anchor = (e.target as HTMLElement)?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;

      // Inline image / GIF links open in the in-app media viewer (see MessageMarkdown).
      if (anchor.closest("[data-pax-open-image-viewer]")) return;

      // Only intercept external (http/https) links.
      if (!/^https?:\/\//i.test(href)) return;

      // Don't intercept if inside an iframe (e.g. YouTube embed controls).
      if (anchor.ownerDocument !== document) return;

      e.preventDefault();
      e.stopPropagation();

      // A message permalink keeps the original room ID across upgrades.
      try {
        const url = new URL(href);
        if (url.origin === "https://matrix.to" && url.hash.startsWith("#/")) {
          const [roomId, eventId] = url.hash.slice(2).split("?")[0].split("/").map(decodeURIComponent);
          if (roomId?.startsWith("!") && eventId?.startsWith("$")) {
            const accepted = !window.dispatchEvent(new CustomEvent("pax-room-event-link", {
              detail: { roomId, eventId },
              cancelable: true,
            }));
            if (accepted) return;
          }
        }
      } catch {
        // Malformed Matrix links follow the existing external-opening path.
      }
      openUrl(href).catch((err) => {
        console.error("[Pax] Failed to open external URL:", href, err);
      });
    }

    document.addEventListener("click", handler, { capture: true });
    return () => document.removeEventListener("click", handler, { capture: true });
  }, []);
}
