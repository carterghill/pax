import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Message, MessageBatch } from "../types/matrix";

interface RoomMessagePayload {
  roomId: string;
  message: Message;
}

interface CachedRoom {
  messages: Message[];
  prevBatch: string | null;
}

function mergeMessages(prev: Message[], fetched: Message[]): Message[] {
  const prevIds = new Set(prev.map((m) => m.eventId));
  const merged = [...prev];
  for (const msg of fetched) {
    if (!prevIds.has(msg.eventId)) {
      merged.push(msg);
      prevIds.add(msg.eventId);
    }
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

const globalCache = new Map<string, CachedRoom>();

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
    if (fetchingRef.current === roomId) {
      console.log(`[useMessages] SKIPPED duplicate fetch for ${roomId}`);
      return;
    }
    console.log(`[useMessages] starting fetch for ${roomId}, fetchingRef=${fetchingRef.current}`);

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
        const merged = prev.length === 0 ? fetched : mergeMessages(prev, fetched);

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
        // Deduplicate by eventId (sent messages arrive via both refresh and sync)
        if (prev.some((m) => m.eventId === message.eventId)) return prev;
        const next = [...prev, message];
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
        const merged = [...older, ...prev];
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
      const merged = mergeMessages(prev, fetched);

      setMessages(merged);
      setPrevBatch(batch.prevBatch);
      cacheRef.current.set(roomId, { messages: merged, prevBatch: batch.prevBatch });
    } catch (e) {
      console.error("Failed to refresh messages:", e);
    }
  }, [roomId]);

  return {
    messages,
    loadMore,
    hasMore: prevBatch !== null,
    loading,
    initialLoading,
    refreshing,
    refresh,
  };
}