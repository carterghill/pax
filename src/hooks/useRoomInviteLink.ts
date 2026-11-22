import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface RoomInvite {
  url: string;
  roomId: string;
  viaServers: string[];
}

export function useRoomInviteLink() {
  const [invite, setInvite] = useState<RoomInvite | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const dismiss = useCallback((url?: string) => {
    if (url) {
      setInvite((current) => current?.url === url ? null : current);
    } else {
      request.current += 1;
      setInvite(null);
      setError("");
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const initialSequence = request.current;
    let pendingUrl: string | undefined;
    async function receive(urls: string[]) {
      const url = urls[urls.length - 1];
      if (stopped || !url || pendingUrl === url) return;
      pendingUrl = url;
      const sequence = ++request.current;
      setLoading(true);
      setError("");
      setInvite(null);
      try {
        const room = await invoke<Omit<RoomInvite, "url">>("parse_room_link", { url });
        if (!stopped && request.current === sequence) {
          setInvite({ url, ...room });
        }
      } catch (e) {
        if (!stopped && request.current === sequence) setError(String(e));
      } finally {
        if (pendingUrl === url) pendingUrl = undefined;
        if (!stopped && request.current === sequence) setLoading(false);
      }
    }

    const onRoomLink = (event: Event) => {
      const url = (event as CustomEvent<unknown>).detail;
      if (typeof url === "string") void receive([url]);
    };
    window.addEventListener("pax-room-link", onRoomLink);
    const subscription = listen<string[]>("deep-link://new-url", ({ payload }) => void receive(payload));
    void subscription.then(async () => {
      if (stopped || request.current !== initialSequence) return;
      const current = await invoke<string[] | null>("plugin:deep-link|get_current");
      if (current && request.current === initialSequence) await receive(current);
    }).catch(() => {});
    return () => {
      stopped = true;
      window.removeEventListener("pax-room-link", onRoomLink);
      void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  return { invite, error, loading, dismiss };
}
