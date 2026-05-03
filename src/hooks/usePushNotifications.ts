/**
 * Push-notification registration for Android.
 *
 * ## How it works
 *
 * 1. On Android, `MainActivity.kt` fetches the FCM device token from
 *    Firebase and injects it into the WebView as `window.__paxFcmToken`,
 *    then dispatches a `pax-fcm-token` CustomEvent.
 *
 * 2. This hook listens for that event (and polls once on mount in case
 *    the token arrived before React hydrated).  When a token is available
 *    and the user is logged in, it calls the Rust `register_pusher`
 *    command to POST `/_matrix/client/v3/pushers/set` on the homeserver.
 *
 * 3. On logout, the caller invokes `unregisterPush()` which removes the
 *    pusher so the server stops sending pushes to this device.
 *
 * On desktop builds, `push_gateway_configured` returns false and the
 * hook is a no-op.  No FCM token is ever injected on desktop.
 */

import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    /** Injected by MainActivity.kt on Android after fetching the FCM token. */
    __paxFcmToken?: string;
  }
}

interface PushNotificationsOptions {
  /** Current user's MXID.  Null = not logged in → skip registration. */
  userId: string | null;
}

interface PushNotificationsReturn {
  /** Call on logout to remove the pusher from the homeserver. */
  unregisterPush: () => Promise<void>;
}

export function usePushNotifications({
  userId,
}: PushNotificationsOptions): PushNotificationsReturn {
  // Track the last-registered token so we don't re-register the same one.
  const registeredTokenRef = useRef<string | null>(null);
  // Track the token across renders so unregister can use it.
  const currentTokenRef = useRef<string | null>(null);

  const registerWithToken = useCallback(
    async (token: string) => {
      if (!userId) return;
      if (token === registeredTokenRef.current) return;

      try {
        // Build a human-readable device name.  "Pax (Android)" is fine;
        // the homeserver stores it for the user's pusher list.
        await invoke("register_pusher", {
          pushKey: token,
          deviceDisplayName: "Pax (Android)",
        });
        registeredTokenRef.current = token;
        currentTokenRef.current = token;
        console.log("[push] pusher registered with homeserver");
      } catch (e) {
        console.warn("[push] register_pusher failed:", e);
      }
    },
    [userId],
  );

  useEffect(() => {
    if (!userId) return;

    let cancelled = false;

    (async () => {
      // Check if the build even has a push gateway configured.
      try {
        const configured = await invoke<boolean>("push_gateway_configured");
        if (!configured) return;
      } catch {
        return;
      }

      if (cancelled) return;

      // Check if the token was injected before React mounted.
      const existing = window.__paxFcmToken;
      if (existing) {
        registerWithToken(existing);
      }

      // Listen for token injection / refresh from Kotlin side.
      const handler = (e: Event) => {
        if (cancelled) return;
        const token = (e as CustomEvent).detail?.token;
        if (token && typeof token === "string") {
          registerWithToken(token);
        }
      };
      window.addEventListener("pax-fcm-token", handler);

      // Cleanup
      return () => {
        cancelled = true;
        window.removeEventListener("pax-fcm-token", handler);
      };
    })();

    // Reset registration tracking when user changes (login/logout cycle).
    return () => {
      registeredTokenRef.current = null;
    };
  }, [userId, registerWithToken]);

  const unregisterPush = useCallback(async () => {
    const token = currentTokenRef.current;
    if (!token) return;
    try {
      await invoke("unregister_pusher", { pushKey: token });
      console.log("[push] pusher unregistered");
    } catch (e) {
      // Non-fatal — we're logging out anyway.
      console.warn("[push] unregister_pusher failed:", e);
    }
    registeredTokenRef.current = null;
    currentTokenRef.current = null;
  }, []);

  return { unregisterPush };
}