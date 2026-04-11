import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ManualStatus = "auto" | "online" | "unavailable" | "dnd" | "offline";

// What gets PUT to the Matrix server.
function statusToPresence(status: ManualStatus, systemIdle: boolean): string {
  switch (status) {
    case "online":      return "online";
    case "unavailable": return "unavailable";
    case "dnd":         return "online"; // Matrix has no DND; stay "online"
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

// Re-PUT interval (ms).  Synapse times out presence after ~5 min if it
// receives no signal.  Because sync uses set_presence=offline (meaning
// "don't auto-manage"), explicit PUTs are the only keep-alive.
const HEARTBEAT_MS = 60_000;

export function usePresence() {
  const [manualStatus, setManualStatus] = useState<ManualStatus>("auto");
  const [systemIdle, setSystemIdle]     = useState(false);
  const [syncReady, setSyncReady]       = useState(false);

  // What was last sent to the server (for dedup on state changes).
  const lastSent = useRef("");
  const idleStarted = useRef(false);
  const presenceFetched = useRef(false);

  // ── Helpers ──

  const sendPresence = useCallback((presence: string) => {
    if (presence === lastSent.current) return;
    lastSent.current = presence;
    invoke("set_presence", { presence }).catch((e) =>
      console.error("Failed to set presence:", e)
    );
  }, []);

  // Bypass dedup — used by the heartbeat to re-PUT the same value.
  const heartbeat = useCallback(() => {
    const p = lastSent.current;
    if (p) invoke("set_presence", { presence: p }).catch(() => {});
  }, []);

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

  // Flip syncReady once the first sync response has been processed.
  useEffect(() => {
    const ul = listen("sync-ready", () => setSyncReady(true));
    return () => { ul.then((fn) => fn()); };
  }, []);

  // ── Core presence logic ──

  // Whenever the desired presence changes AND sync is ready, PUT it.
  useEffect(() => {
    if (!syncReady) return;
    sendPresence(statusToPresence(manualStatus, systemIdle));
  }, [manualStatus, systemIdle, syncReady, sendPresence]);

  // Heartbeat: re-PUT every 60 s to prevent Synapse timeout.
  useEffect(() => {
    if (!syncReady) return;
    const id = setInterval(heartbeat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [syncReady, heartbeat]);

  // After first sync, bulk-fetch current presence for all room members.
  // Covers the gap where restore_session resumes from a stored since-token
  // and incremental syncs don't include users whose status hasn't changed.
  useEffect(() => {
    if (!syncReady || presenceFetched.current) return;
    presenceFetched.current = true;
    invoke("sync_presence").catch((e) =>
      console.error("Failed to sync presence:", e)
    );
  }, [syncReady]);

  // On unmount (tab close / navigation away from MainLayout), try to go
  // offline.  Note: on full logout, auth.rs sends offline before clearing
  // the client, so this is just a safety net for abnormal teardown.
  useEffect(() => {
    return () => {
      invoke("set_presence", { presence: "offline" }).catch(() => {});
    };
  }, []);

  // ── Public state ──

  const effectivePresence = statusToDisplay(manualStatus, systemIdle);

  return { manualStatus, setManualStatus, effectivePresence };
}