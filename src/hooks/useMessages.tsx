import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Message, MessageBatch } from "../types/matrix";

interface RoomMessagePayload {
  roomId: string;
  message: Message;
}

interface MessageEditPayload {
  roomId: string;
  targetEventId: string;
  body: string;
}

interface MessageRedactedPayload {
  roomId: string;
  redactedEventId: string;
}

interface CachedRoom {
  messages: Message[];
  prevBatch: string | null;
}

/** Merge by `eventId`; later arguments win (used so refresh / newer fetches overwrite bodies + `edited`). */
function mergeMessagesByEventId(first: Message[], second: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of first) map.set(m.eventId, m);
  for (const m of second) map.set(m.eventId, m);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * After fetching the latest window from the server, drop any in-memory rows in that time window
 * that the server no longer returned (e.g. redacted / deleted messages).
 */
function mergeLatestServerWindow(prev: Message[], fetched: Message[]): Message[] {
  if (fetched.length === 0) return prev;
  const oldestFetchedTs = fetched[0].timestamp;
  const olderOnly = prev.filter((m) => m.timestamp < oldestFetchedTs);
  return mergeMessagesByEventId(olderOnly, fetched);
}

const globalCache = new Map<string, CachedRoom>();

export function clearMessageCache() {
  globalCache.clear();
}

export function useMessages(roomId: string | null) {
  const cached = roomId ? globalCache.get(roomId) : undefined;
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [prevBatch, setPrevBatch] = useState<string | null>(cached?.prevBatch ?? null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const cacheRef = useRef(globalCache);
  const fetchingRef = useRef<string | null>(null);

  // Load initial messages when room changes
  useEffect(() => {
    if (!roomId) {
      setMessages([]);
      setPrevBatch(null);
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    // Prevent StrictMode double-invoke serialization
    if (fetchingRef.current === roomId) return;

    const cached = cacheRef.current.get(roomId);

    if (cached) {
      // Show cached messages immediately, then fetch new ones in background
      setMessages(cached.messages);
      setPrevBatch(cached.prevBatch);
      setInitialLoading(false);
      setRefreshing(true);
    } else {
      setInitialLoading(true);
      setRefreshing(false);
    }

    fetchingRef.current = roomId;

    invoke<MessageBatch>("get_messages", { roomId, from: null, limit: 50 })
      .then((batch) => {
        const fetched = batch.messages.reverse();
        const prev = cacheRef.current.get(roomId)?.messages ?? [];
        const merged = mergeLatestServerWindow(prev, fetched);

        setMessages(merged);
        setPrevBatch(batch.prevBatch);
        cacheRef.current.set(roomId, { messages: merged, prevBatch: batch.prevBatch });
      })
      .catch((e) => console.error("Failed to load messages:", e))
      .finally(() => {
        fetchingRef.current = null;
        setInitialLoading(false);
        setRefreshing(false);
      });
  }, [roomId]);

  // Listen for live messages from the sync loop
  useEffect(() => {
    if (!roomId) return;

    const unlisten = listen<RoomMessagePayload>("room-message", (event) => {
      const { roomId: msgRoomId, message } = event.payload;
      if (msgRoomId !== roomId) return;

      setMessages((prev) => {
        const next = mergeMessagesByEventId(prev, [message]);
        cacheRef.current.set(roomId, {
          messages: next,
          prevBatch: cacheRef.current.get(roomId)?.prevBatch ?? null,
        });
        return next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const unlisten = listen<MessageEditPayload>("room-message-edit", (event) => {
      const { roomId: rid, targetEventId, body } = event.payload;
      if (rid !== roomId) return;

      setMessages((prev) => {
        const next = prev.map((m) =>
          m.eventId === targetEventId ? { ...m, body, edited: true } : m,
        );
        cacheRef.current.set(roomId, {
          messages: next,
          prevBatch: cacheRef.current.get(roomId)?.prevBatch ?? null,
        });
        return next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const unlisten = listen<MessageRedactedPayload>("room-message-redacted", (event) => {
      const { roomId: rid, redactedEventId } = event.payload;
      if (rid !== roomId) return;

      setMessages((prev) => {
        const next = prev.filter((m) => m.eventId !== redactedEventId);
        cacheRef.current.set(roomId, {
          messages: next,
          prevBatch: cacheRef.current.get(roomId)?.prevBatch ?? null,
        });
        return next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [roomId]);

  const loadMore = useCallback(async () => {
    if (!roomId || !prevBatch || loading) return;

    setLoading(true);
    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId,
        from: prevBatch,
        limit: 50,
      });
      const older = batch.messages.reverse();
      setMessages((prev) => {
        const merged = mergeMessagesByEventId(older, prev);
        cacheRef.current.set(roomId, {
          messages: merged,
          prevBatch: batch.prevBatch,
        });
        return merged;
      });
      setPrevBatch(batch.prevBatch);
    } catch (e) {
      console.error("Failed to load more messages:", e);
    }
    setLoading(false);
  }, [roomId, prevBatch, loading]);

  // Re-fetch latest messages (after sending)
  const refresh = useCallback(async () => {
    if (!roomId) return;

    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId,
        from: null,
        limit: 50,
      });
      const fetched = batch.messages.reverse();
      const prev = cacheRef.current.get(roomId)?.messages ?? [];
      const merged = mergeLatestServerWindow(prev, fetched);

      setMessages(merged);
      setPrevBatch(batch.prevBatch);
      cacheRef.current.set(roomId, { messages: merged, prevBatch: batch.prevBatch });
    } catch (e) {
      console.error("Failed to refresh messages:", e);
    }
  }, [roomId]);

  const removeMessageById = useCallback(
    (eventId: string) => {
      if (!roomId) return;
      setMessages((prev) => {
        const next = prev.filter((m) => m.eventId !== eventId);
        cacheRef.current.set(roomId, {
          messages: next,
          prevBatch: cacheRef.current.get(roomId)?.prevBatch ?? null,
        });
        return next;
      });
    },
    [roomId],
  );

  return {
    messages,
    loadMore,
    hasMore: prevBatch !== null,
    loading,
    initialLoading,
    refreshing,
    refresh,
    removeMessageById,
  };
}