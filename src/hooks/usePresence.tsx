import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Manual status options: "auto" means follow system idle detection
export type ManualStatus = "auto" | "online" | "unavailable" | "dnd" | "offline";

// What gets sent to the Matrix server (no "dnd" in Matrix, maps to "online" with a flag)
function statusToPresence(status: ManualStatus, systemIdle: boolean): string {
  switch (status) {
    case "online": return "online";
    case "unavailable": return "unavailable";
    case "dnd": return "online"; // Matrix doesn't have DND; we stay "online"
    case "offline": return "offline";
    case "auto":
    default:
      return systemIdle ? "unavailable" : "online";
  }
}

// What to display locally for the current user (includes dnd which Matrix doesn't know about)
function statusToDisplay(status: ManualStatus, systemIdle: boolean): string {
  switch (status) {
    case "online": return "online";
    case "unavailable": return "unavailable";
    case "dnd": return "dnd";
    case "offline": return "offline";
    case "auto":
    default:
      return systemIdle ? "unavailable" : "online";
  }
}

export function usePresence() {
  const [manualStatus, setManualStatus] = useState<ManualStatus>("auto");
  const [systemIdle, setSystemIdle] = useState(false);
  const [syncReady, setSyncReady] = useState(false);
  const currentPresence = useRef<string>("");
  const idleMonitorStartedRef = useRef(false);

  const sendPresence = useCallback((presence: string) => {
    if (presence === currentPresence.current) return;
    currentPresence.current = presence;
    invoke("set_presence", { presence }).catch((e) =>
      console.error("Failed to set presence:", e)
    );
  }, []);

  // Start the system idle monitor on mount
  useEffect(() => {
    if (idleMonitorStartedRef.current) return;
    idleMonitorStartedRef.current = true;

    invoke("start_idle_monitor").catch((e) =>
      console.error("Failed to start idle monitor:", e)
    );
  }, []);

  // Listen for system idle changes from the Rust backend
  useEffect(() => {
    const unlisten = listen<boolean>("idle-changed", (event) => {
      setSystemIdle(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Wait for the first sync response before sending any presence.
  // This avoids the initial set_presence("online") racing the sync loop's
  // first /sync request (which carries set_presence=offline), which can cause
  // the server to reset our presence back to offline.
  useEffect(() => {
    const unlisten = listen("sync-ready", () => {
      setSyncReady(true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Send presence whenever manual status, system idle, or sync readiness changes.
  // Gated on syncReady so the very first PUT goes out only after the sync loop
  // has processed its first response.
  useEffect(() => {
    if (!syncReady) return;
    const presence = statusToPresence(manualStatus, systemIdle);
    sendPresence(presence);
  }, [manualStatus, systemIdle, syncReady, sendPresence]);

  // Set offline on unmount
  useEffect(() => {
    return () => {
      invoke("set_presence", { presence: "offline" }).catch(() => {});
    };
  }, []);

  // The presence to display locally for the current user (instant, no server round-trip)
  const effectivePresence = statusToDisplay(manualStatus, systemIdle);

  return { manualStatus, setManualStatus, effectivePresence };
}