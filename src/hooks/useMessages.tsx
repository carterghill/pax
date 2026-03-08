import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Message, MessageBatch } from "../types/matrix";

interface RoomMessagePayload {
  roomId: string;
  message: Message;
}

export function useMessages(roomId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [prevBatch, setPrevBatch] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);

  // Load initial messages when room changes
  useEffect(() => {
    if (!roomId) {
      setMessages([]);
      setPrevBatch(null);
      return;
    }

    setInitialLoading(true);
    invoke<MessageBatch>("get_messages", { roomId, from: null, limit: 50 })
      .then((batch) => {
        setMessages(batch.messages.reverse());
        setPrevBatch(batch.prevBatch);
      })
      .catch((e) => console.error("Failed to load messages:", e))
      .finally(() => setInitialLoading(false));
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
        return [...prev, message];
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
      setMessages((prev) => [...batch.messages.reverse(), ...prev]);
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
      setMessages(batch.messages.reverse());
      setPrevBatch(batch.prevBatch);
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
    refresh,
  };
}