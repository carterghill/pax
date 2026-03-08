import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function usePresence() {
  const currentStatus = useRef<string>("online");
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(true);

  function setPresence(status: string) {
    if (status === currentStatus.current) return;
    currentStatus.current = status;
    invoke("set_presence", { presence: status }).catch((e) =>
      console.error("Failed to set presence:", e)
    );
  }

  function resetIdleTimer() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    // Only set online + restart timer if window is focused
    if (focused.current) {
      setPresence("online");
      idleTimer.current = setTimeout(() => {
        setPresence("unavailable");
      }, IDLE_TIMEOUT_MS);
    }
  }

  useEffect(() => {
    // Set online on mount
    setPresence("online");
    resetIdleTimer();

    // Track activity within the window
    const activityEvents = ["mousemove", "keydown", "mousedown", "scroll", "touchstart"];
    const handleActivity = () => resetIdleTimer();

    for (const event of activityEvents) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    // Track window focus/blur via Tauri
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onFocusChanged(({ payload: isFocused }) => {
      focused.current = isFocused;
      if (isFocused) {
        resetIdleTimer();
      } else {
        // Window lost focus — go away immediately
        if (idleTimer.current) clearTimeout(idleTimer.current);
        setPresence("unavailable");
      }
    });

    // Set offline on unmount (logout / close)
    return () => {
      for (const event of activityEvents) {
        window.removeEventListener(event, handleActivity);
      }
      if (idleTimer.current) clearTimeout(idleTimer.current);
      unlisten.then((fn) => fn());
      invoke("set_presence", { presence: "offline" }).catch(() => {});
    };
  }, []);
}