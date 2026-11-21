import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { composeStatusMsg } from "../utils/statusMessage";

export type ManualStatus = "auto" | "online" | "unavailable" | "dnd" | "offline";

// What gets PUT to the Matrix server.
function statusToPresence(status: ManualStatus, systemIdle: boolean): string {
  switch (status) {
    case "online":      return "online";
    case "unavailable": return "unavailable";
    case "dnd":         return "unavailable"; // Matrix has no DND; use "unavailable" so non-Pax clients see away
    case "offline":     return "offline";
    case "auto":
    default:
      return systemIdle ? "unavailable" : "online";
  }
}

// What to show locally.  Must match what we PUT so local and remote agree.
function statusToDisplay(status: ManualStatus, systemIdle: boolean): string {
  if (status === "dnd") return "dnd"; // purely local concept
  return statusToPresence(status, systemIdle);
}

// Re-PUT interval (ms).  When the user's desired presence is "online", the
// sync loop now sets set_presence=Online on each /sync request (matching
// Cinny/Element), so Synapse auto-manages presence.  For manual statuses
// (unavailable, offline, idle) the sync uses set_presence=Offline and this
// heartbeat is the only keep-alive.  20 s keeps us well within Synapse's
// ~30 s SYNC_ONLINE_TIMEOUT.
const HEARTBEAT_MS = 20_000;

export function usePresence(userId: string) {
  const [manualStatus, setManualStatus] = useState<ManualStatus>("auto");
  const [systemIdle, setSystemIdle]     = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  // What was last sent to the server (for dedup on state changes).
  const lastSent = useRef({ presence: "", statusMsg: "" });
  const idleStarted = useRef(false);

  // ── Helpers ──

  const sendPresence = useCallback((presence: string, statusMsg: string) => {
    if (
      presence === lastSent.current.presence &&
      statusMsg === lastSent.current.statusMsg
    ) return;
    lastSent.current = { presence, statusMsg };
    invoke("set_presence", {
      presence,
      statusMsg: statusMsg || null,
      expectedUserId: userId,
    }).catch((e) =>
      console.error("Failed to set presence:", e)
    );
  }, [userId]);

  // Bypass dedup — used by the heartbeat to re-PUT the same value.
  const heartbeat = useCallback(() => {
    const { presence, statusMsg } = lastSent.current;
    if (presence) {
      invoke("set_presence", {
        presence,
        statusMsg: statusMsg || null,
        expectedUserId: userId,
      }).catch(() => {});
    }
  }, [userId]);

  // ── One-time setup ──

  // Start the native idle monitor.
  useEffect(() => {
    if (idleStarted.current) return;
    idleStarted.current = true;
    invoke("start_idle_monitor").catch((e) =>
      console.error("Failed to start idle monitor:", e)
    );
  }, []);

  // Listen for idle state transitions from the Rust backend.
  useEffect(() => {
    const ul = listen<boolean>("idle-changed", (e) => setSystemIdle(e.payload));
    return () => { ul.then((fn) => fn()); };
  }, []);

  // Subscribe before reading readiness so a first sync completed before
  // MainLayout mounted still starts presence.
  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const syncPresence = () => {
      if (cancelled) return;
      void invoke("sync_presence", { expectedUserId: userId }).catch((e) =>
        console.error("Failed to sync presence:", e)
      );
    };
    const unlisten = listen("sync-ready", () => {
      receivedEvent = true;
      syncPresence();
    });
    void unlisten.catch(() => {}).then(async () => {
      if (cancelled || receivedEvent) return;
      if (await invoke<boolean>("is_sync_ready") && !receivedEvent) syncPresence();
    }).catch((e) => console.error("Failed to check sync readiness:", e));
    return () => {
      cancelled = true;
      void unlisten.then((stop) => stop(), () => {});
    };
  }, [userId]);

  // ── Core presence logic ──

  // Publishing our status only needs the signed-in session. The first sync
  // can still be catching up or waiting on a connection.
  useEffect(() => {
    const composed = composeStatusMsg(manualStatus === "dnd", statusMessage);
    sendPresence(statusToPresence(manualStatus, systemIdle), composed);
  }, [manualStatus, systemIdle, statusMessage, sendPresence]);

  // Heartbeat: re-PUT periodically.  For "online" this is a redundant safety
  // net (the sync loop handles it); for manual statuses it's the primary
  // keep-alive since the sync uses set_presence=Offline for those.
  useEffect(() => {
    const id = setInterval(heartbeat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [heartbeat]);

  // ── Public state ──

  const effectivePresence = statusToDisplay(manualStatus, systemIdle);

  return { manualStatus, setManualStatus, effectivePresence, statusMessage, setStatusMessage };
}
