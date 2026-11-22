import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface PushRegistration {
  token: string;
  badgeOnly: boolean;
  done: Promise<boolean>;
}

export function usePushNotifications({ userId }: { userId: string | null }) {
  const registrations = useRef(new Map<string, PushRegistration>());
  const signingOut = useRef(false);

  useEffect(() => {
    if (!userId || "PaxAndroid" in window) return;

    let cancelled = false;
    const listeners: UnlistenFn[] = [];

    function register(token: string, deviceDisplayName: string, badgeOnly = false) {
      if (cancelled || signingOut.current) return;
      const key = `${badgeOnly}:${token}`;
      const pending = registrations.current;
      if (pending.has(key)) return;
      const done = invoke("register_pusher", { pushKey: token, deviceDisplayName, badgeOnly })
        .then(() => true)
        .catch((error) => {
          pending.delete(key);
          console.warn("[push] register_pusher failed:", error);
          return false;
        });
      pending.set(key, { token, badgeOnly, done });
    }

    async function watchAppleToken(
      event: string,
      command: string,
      deviceName: string,
      badgeOnly: boolean,
    ) {
      if (!(await invoke<boolean>("push_gateway_configured", { badgeOnly })) || cancelled) return;
      const readToken = async () => {
        const token = await invoke<string | null>(command);
        if (token) register(token, deviceName, badgeOnly);
      };
      const unlisten = await listen(event, () => {
        void readToken().catch((error) => console.warn("[push] Could not read iOS token:", error));
      });
      if (cancelled) {
        unlisten();
        return;
      }
      listeners.push(unlisten);
      await readToken();
    }

    void Promise.all([
      watchAppleToken("voip-token-changed", "get_ios_voip_token", "Pax (iPhone)", false),
      watchAppleToken("badge-token-changed", "get_ios_badge_token", "Pax (iPhone badges)", true),
    ]).catch((error) => {
      if (!cancelled) console.warn("[push] Could not initialize push registration:", error);
    });

    return () => {
      cancelled = true;
      listeners.forEach((unlisten) => unlisten());
    };
  }, [userId]);

  const unregisterPush = useCallback(async () => {
    signingOut.current = true;
    const pending = registrations.current;
    await Promise.all(Array.from(pending.values(), async ({ token, badgeOnly, done }) => {
      if (!(await done)) return;
      try {
        await invoke("unregister_pusher", { pushKey: token, badgeOnly });
      } catch (error) {
        console.warn("[push] unregister_pusher failed:", error);
      }
    }));
    pending.clear();
  }, []);

  return { unregisterPush };
}
