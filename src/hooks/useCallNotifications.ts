import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DirectCall } from "./useDirectCall";

type CallNotificationAction = {
  callId: string;
  action: "answer" | "decline" | "dismiss" | "end" | "open";
  expiresAt?: number;
};

type AndroidCallNotifications = {
  showIncomingCall(callId: string, roomId: string, caller: string, expiresAt: number, eventId: string): void;
  closeIncomingCall(callId: string, ended: boolean): void;
  takeCallNotificationAction(): string;
  setCallNotificationBusy(busy: boolean): void;
};

export function useCallNotifications(
  call: DirectCall | null,
  caller: string,
  onAnswer: (callId: string) => void,
  onEnd: (callId: string, notifyPeer: boolean, allowActive?: boolean) => void,
  voiceBusy: boolean,
) {
  const state = useRef({ call, onAnswer, onEnd });
  state.current = { call, onAnswer, onEnd };
  const queuedAction = useRef<CallNotificationAction | null>(null);
  const android = (window as Window & { PaxAndroid?: AndroidCallNotifications }).PaxAndroid;
  const systemCallId = useRef<string | null>(null);
  const commands = useRef(Promise.resolve());

  useEffect(() => {
    if (!isTauri()) return;
    const handle = (action: CallNotificationAction) => {
      if (action.expiresAt && action.expiresAt <= Date.now()) return;
      const current = state.current;
      if (action.callId !== current.call?.callId) {
        if (action.expiresAt) queuedAction.current = action;
        return;
      }
      if (action.action === "answer") current.onAnswer(action.callId);
      if (action.action === "decline" || action.action === "dismiss" || action.action === "end") {
        current.onEnd(action.callId, action.action !== "dismiss", action.action === "end");
      }
    };
    if (android) {
      const drain = () => {
        const saved = android.takeCallNotificationAction();
        if (saved) handle(JSON.parse(saved) as CallNotificationAction);
        const queued = queuedAction.current;
        if (queued && (queued.callId === state.current.call?.callId || (queued.expiresAt ?? 0) <= Date.now())) {
          queuedAction.current = null;
          handle(queued);
        }
      };
      drain();
      window.addEventListener("pax-call-notification-action", drain);
      window.addEventListener("focus", drain);
      return () => {
        window.removeEventListener("pax-call-notification-action", drain);
        window.removeEventListener("focus", drain);
      };
    }
    const handleQueued = (action: CallNotificationAction | null) => {
      if (action) handle({ ...action, expiresAt: Date.now() + 30_000 });
    };
    const subscription = listen<CallNotificationAction>("call-notification-action", ({ payload }) => handleQueued(payload));
    void subscription.then(() => invoke<CallNotificationAction | null>("take_call_notification_action")).then(handleQueued).catch(() => {});
    void subscription.catch((error) => console.warn("Could not listen for call notification actions:", error));
    return () => { void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, [android]);

  const callId = call?.callId;
  const phase = call?.phase;
  const roomId = call?.roomId;
  const expiresAt = call?.expiresAt;
  const ringEventId = call?.ringEventId;
  const busy = voiceBusy || (!!phase && phase !== "incoming");
  useEffect(() => {
    const queued = queuedAction.current;
    if (!queued || queued.callId !== callId) return;
    queuedAction.current = null;
    if ((queued.expiresAt ?? 0) <= Date.now()) return;
    const { onAnswer, onEnd } = state.current;
    if (queued.action === "answer") onAnswer(callId);
    if (queued.action === "decline" || queued.action === "dismiss" || queued.action === "end") {
      onEnd(callId, queued.action !== "dismiss", queued.action === "end");
    }
  }, [callId]);
  useEffect(() => {
    if (!isTauri()) return;
    if (android) {
      android.setCallNotificationBusy(busy);
      const previous = systemCallId.current;
      if (previous && (previous !== callId || phase !== "incoming")) {
        android.closeIncomingCall(previous, true);
        systemCallId.current = null;
      }
      if (phase === "incoming" && callId && roomId && expiresAt) {
        systemCallId.current = callId;
        android.showIncomingCall(callId, roomId, caller, expiresAt, ringEventId ?? "");
      }
      return;
    }
    const systemPhase = phase === "incoming" ? "incoming"
      : phase === "answering" || phase === "connecting" ? "answering"
      : phase === "active" || phase === "interrupted" || phase === "resuming" ? "active"
      : null;
    const payload = callId && systemPhase ? { callId, caller, expiresAt, phase: systemPhase } : null;
    commands.current = commands.current
      .then(() => invoke<void>("sync_call_notification", { call: payload, busy }))
      .catch((error) => console.warn("Could not update the call notification:", error));
  }, [android, busy, callId, caller, expiresAt, phase, ringEventId, roomId]);

  useEffect(() => () => {
    if (!isTauri()) return;
    if (android) {
      android.setCallNotificationBusy(false);
      if (systemCallId.current) android.closeIncomingCall(systemCallId.current, false);
    } else {
      commands.current = commands.current.then(() => invoke<void>("sync_call_notification", { call: null, busy: false })).catch(() => {});
    }
  }, [android]);
}
