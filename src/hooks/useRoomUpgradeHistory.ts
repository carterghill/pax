import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getMessages, getMessagesAroundEvent } from "../features/chat/api";
import type { Message } from "../types/matrix";
import type { MessageRedactedPayload } from "./useMessages";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";
import { projectMessages } from "../features/chat/messages/ignoredUsers";

type HistoryPage = {
  messages: Message[];
  olderToken: string | null;
};

const NO_ROOMS: string[] = [];
const PAGE_SIZE = 40;
const NO_PAGES: Record<string, HistoryPage> = {};

export function useRoomUpgradeHistory(
  roomId: string | null,
  predecessorIds: string[] = NO_ROOMS,
) {
  const { userIds: ignoredUsers, revision: ignoreListRevision } = useIgnoredUsers();
  const [history, setHistory] = useState<{
    roomId: string | null;
    pages: Record<string, HistoryPage>;
  }>({ roomId, pages: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef<symbol | null>(null);
  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;

  useLayoutEffect(() => {
    activeRequest.current = null;
    setHistory({ roomId, pages: {} });
    setLoading(false);
    setError(null);
    return () => { activeRequest.current = null; };
  }, [roomId]);

  useEffect(() => {
    if (predecessorIds.length === 0) return;
    const unlisten = listen<MessageRedactedPayload>("room-message-redacted", ({ payload }) => {
      setHistory((current) => {
        const page = current.pages[payload.roomId];
        if (!page) return current;
        return {
          ...current,
          pages: {
            ...current.pages,
            [payload.roomId]: {
              ...page,
              messages: page.messages.filter((message) => message.eventId !== payload.redactedEventId),
            },
          },
        };
      });
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [predecessorIds]);

  const pages = history.roomId === roomId ? history.pages : NO_PAGES;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const nextRoom = predecessorIds.find((id) => !pages[id] || pages[id].olderToken !== null);
  const load = useCallback(async (source: string, eventId?: string) => {
    if (!roomId || (!eventId && activeRequest.current)) return;
    const request = Symbol();
    activeRequest.current = request;
    setLoading(true);
    setError(null);
    try {
      const previous = pagesRef.current[source];
      const token = eventId ? null : previous?.olderToken ?? null;
      const result = eventId
        ? await getMessagesAroundEvent({ roomId: source, eventId })
        : await getMessages({ roomId: source, from: token, limit: PAGE_SIZE });
      if (activeRoom.current !== roomId || activeRequest.current !== request) return;
      const earlier = result.messages.slice().reverse().map((message) => ({
        ...message,
        historyRoomId: source,
      }));
      const byId = new Map<string, Message>();
      for (const message of earlier) byId.set(message.eventId, message);
      if (!eventId) {
        for (const message of previous?.messages ?? []) byId.set(message.eventId, message);
      }
      setHistory((current) => ({
        roomId,
        pages: {
          ...current.pages,
          [source]: {
            messages: [...byId.values()],
            olderToken: result.prevBatch === token ? null : result.prevBatch,
          },
        },
      }));
    } catch {
      if (activeRequest.current === request) {
        setError("Earlier messages couldn’t be loaded. Try again.");
      }
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [roomId]);

  const loadOlder = useCallback(() => {
    if (nextRoom) void load(nextRoom);
  }, [load, nextRoom]);

  const loadAround = useCallback(async (source: string, eventId: string) => {
    if (predecessorIds.includes(source)) await load(source, eventId);
  }, [load, predecessorIds]);

  const messages = predecessorIds.slice().reverse().flatMap((id) => pages[id]?.messages ?? []);
  return { messages: projectMessages(messages, ignoredUsers, ignoreListRevision), hasOlder: !!nextRoom, loadOlder, loadAround, loading, error };
}
