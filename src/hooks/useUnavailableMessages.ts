import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Message } from "../types/matrix";
import { acknowledgedUnavailableIds, unavailableReceiptPolicy } from "../features/chat/messages/unavailableMessages.mjs";

interface Acknowledgement { schemaVersion: number; userId: string; roomId: string; eventIds: string[]; throughEventId: string | null }

function warningWasIgnored(key: string): boolean {
  try { return localStorage.getItem(key) === "true"; } catch { return false; }
}

export function useUnavailableMessages(roomId: string | null, userId: string, messages: Message[], isAtLatest: boolean, latestEventId: string | null) {
  const scope = `${userId}\0${roomId}`;
  const generation = useRef(0);
  const revision = useRef(0);
  const latestEvent = useRef(latestEventId);
  latestEvent.current = latestEventId;
  const visibleMessages = useRef(messages);
  visibleMessages.current = messages;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [ack, setAck] = useState<{ scope: string; ids: string[] | null; through: string | null }>({ scope, ids: null, through: null });
  const [operation, setOperation] = useState<{ scope: string; busy: boolean; error: string | null }>({ scope, busy: false, error: null });
  const unavailable = messages.filter((m) => m.decryptionFailed);
  const hasUnavailable = unavailable.length > 0;
  const ids = ack.scope === scope ? ack.ids : null;
  const warningKey = `pax.unavailableMessages.ignored.${encodeURIComponent(userId)}.${encodeURIComponent(roomId ?? "")}`;
  const [ignored, setIgnored] = useState({ scope, value: warningWasIgnored(warningKey) });
  const warningIgnored = ignored.scope === scope ? ignored.value : warningWasIgnored(warningKey);

  useEffect(() => {
    const reload = () => setIgnored({ scope, value: warningWasIgnored(warningKey) });
    reload();
    const onStorage = (event: StorageEvent) => { if (event.key === warningKey || event.key === null) reload(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [scope, warningKey]);

  const ignoreWarning = useCallback(() => {
    setIgnored({ scope, value: true });
    try { localStorage.setItem(warningKey, "true"); } catch { /* Keep the current conversation dismissible when storage is unavailable. */ }
  }, [scope, warningKey]);

  useEffect(() => {
    const token = ++generation.current;
    const initialRevision = revision.current;
    setAck({ scope, ids: null, through: null });
    setOperation({ scope, busy: false, error: null });
    if (!roomId || !hasUnavailable) return;
    let cancelled = false;
    const current = () => !cancelled && generation.current === token && activeScope.current === scope;
    const unlisten = listen<Acknowledgement>("room-unavailable-acknowledged", ({ payload }) => {
      if (current() && payload.schemaVersion === 1 && payload.userId === userId && payload.roomId === roomId && Array.isArray(payload.eventIds)) {
        revision.current++;
        // A context-menu clear can include older placeholders already loaded
        // in this view. Only acknowledge them if its server head still matches;
        // messages arriving after the clear's target keep their unread state.
        setAck({ scope, ids: acknowledgedUnavailableIds(visibleMessages.current, payload.eventIds, payload.throughEventId, latestEvent.current), through: payload.throughEventId });
      }
    });
    void invoke<Acknowledgement>("get_unavailable_message_acknowledgement", { roomId }).then((record) => {
      if (current() && revision.current === initialRevision) {
        setAck({ scope, ids: acknowledgedUnavailableIds(visibleMessages.current, record.eventIds, record.throughEventId, latestEvent.current), through: record.throughEventId });
      }
    }).catch((e) => {
      if (current() && revision.current === initialRevision) setOperation({ scope, busy: false, error: String(e) });
    });
    return () => { cancelled = true; void unlisten.then((stop) => stop()); };
  }, [roomId, userId, scope, hasUnavailable]);

  const clearNotification = useCallback(async () => {
    if (!roomId || !isAtLatest || operation.scope === scope && operation.busy) return;
    const unavailableEventIds = messages.filter((m) => m.decryptionFailed).map((m) => m.eventId);
    if (!latestEventId || unavailableEventIds.length === 0) return;
    const token = generation.current;
    setOperation({ scope, busy: true, error: null });
    try {
      const record = await invoke<Acknowledgement>("acknowledge_unavailable_messages", {
        roomId, eventId: latestEventId, unavailableEventIds, expectedUserId: userId,
      });
      if (activeScope.current === scope && generation.current === token) {
        revision.current++;
        setAck({ scope, ids: record.eventIds, through: record.throughEventId });
      }
    } catch (e) {
      if (activeScope.current === scope && generation.current === token) setOperation({ scope, busy: false, error: String(e) });
      return;
    }
    if (activeScope.current === scope && generation.current === token) setOperation({ scope, busy: false, error: null });
  }, [roomId, userId, scope, messages, isAtLatest, latestEventId, operation]);

  return {
    hasUnavailable,
    warningIgnored,
    ignoreWarning,
    ...unavailableReceiptPolicy(messages, userId, ids),
    acknowledged: ids !== null && unavailable.every((m) => ids.includes(m.eventId)),
    acknowledgedThrough: ack.scope === scope ? ack.through : null,
    canClear: latestEventId !== null,
    busy: operation.scope === scope && operation.busy,
    error: operation.scope === scope ? operation.error : null,
    clearNotification,
  };
}
