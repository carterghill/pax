import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Message } from "../types/matrix";

export function useAcknowledgeVisibleCalls(
  viewport: RefObject<HTMLDivElement | null>,
  messages: readonly Message[],
  roomId: string | null,
  userId: string | null,
  loading: boolean,
) {
  const acknowledged = useRef(new Set<string>());
  useEffect(() => { acknowledged.current = new Set(); }, [roomId, userId]);

  useEffect(() => {
    const root = viewport.current;
    if (!root || !roomId || !userId || loading) return;
    const rows = root.querySelectorAll<HTMLElement>("[data-incoming-call-id]");
    if (!rows.length) return;
    const seen = acknowledged.current;
    const visible = new Set<string>();
    let disposed = false;

    function acknowledgeVisible() {
      if (disposed || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const callIds = [...visible].filter((id) => !seen.has(id)).slice(-32);
      if (!callIds.length) return;
      callIds.forEach((id) => seen.add(id));
      void invoke("acknowledge_viewed_calls", { roomId, userId, callIds }).catch((error) => {
        callIds.forEach((id) => seen.delete(id));
        console.warn("Could not acknowledge visible calls:", error);
      });
    }

    const observer = new IntersectionObserver((entries) => {
      for (const { target, isIntersecting, intersectionRatio } of entries) {
        const callId = (target as HTMLElement).dataset.incomingCallId;
        if (!callId) continue;
        if (isIntersecting && intersectionRatio >= 0.5) visible.add(callId);
        else visible.delete(callId);
      }
      acknowledgeVisible();
    }, { root, threshold: 0.5 });
    rows.forEach((row) => observer.observe(row));
    window.addEventListener("focus", acknowledgeVisible);
    document.addEventListener("visibilitychange", acknowledgeVisible);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("focus", acknowledgeVisible);
      document.removeEventListener("visibilitychange", acknowledgeVisible);
    };
  }, [viewport, messages, roomId, userId, loading]);
}
