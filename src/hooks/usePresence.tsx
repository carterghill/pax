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

export function usePresence() {
  const [manualStatus, setManualStatus] = useState<ManualStatus>("auto");
  const [systemIdle, setSystemIdle] = useState(false);
  const currentPresence = useRef<string>("");

  const sendPresence = useCallback((presence: string) => {
    if (presence === currentPresence.current) return;
    currentPresence.current = presence;
    invoke("set_presence", { presence }).catch((e) =>
      console.error("Failed to set presence:", e)
    );
  }, []);

  // Start the system idle monitor on mount
  useEffect(() => {
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

  // Send presence whenever manual status or system idle state changes
  useEffect(() => {
    const presence = statusToPresence(manualStatus, systemIdle);
    sendPresence(presence);
  }, [manualStatus, systemIdle, sendPresence]);

  // Set online on mount
  useEffect(() => {
    sendPresence("online");
    return () => {
      invoke("set_presence", { presence: "offline" }).catch(() => {});
    };
  }, []);

  return { manualStatus, setManualStatus };
}