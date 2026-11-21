import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getRoomMessage } from "../api";
import type { Message, RssProvider } from "../../../types/matrix";
import type { RoomFeedSubscription } from "../../rss/api";
import { useIgnoredUsers } from "../../../context/IgnoredUsersContext";
import { rssArticleCandidate } from "./rssArticle";
import { partitionRssTimeline, type RssThread } from "./rssThreads";

const empty = new Map<string, Message | null>();

export function useRssThreads(
  roomId: string | null,
  provider: RssProvider | undefined,
  messages: Message[],
  subscriptions?: readonly RoomFeedSubscription[],
) {
  const { userIds: ignoredUsers, revision } = useIgnoredUsers();
  const key = roomId && provider ? JSON.stringify([roomId, provider.botUserId, revision]) : null;
  const [loaded, setLoaded] = useState<{ key: string; messages: Map<string, Message | null> } | null>(null);
  const extraMessages = loaded?.key === key ? loaded.messages : empty;

  const missing = useMemo(() => {
    if (!key) return [];
    const byId = new Set(messages.map((message) => message.eventId));
    const missingIds = new Set<string>();
    for (const message of messages) {
      const id = message.threadRootId ?? message.replyTo?.eventId;
      if (id && !byId.has(id) && !extraMessages.has(id)) missingIds.add(id);
    }
    return [...missingIds].slice(0, 4);
  }, [extraMessages, key, messages]);

  // Replies and their roots can end up in separate timeline pages.
  const lookup = JSON.stringify(missing);
  useEffect(() => {
    const eventIds = JSON.parse(lookup) as string[];
    if (!roomId || !key || eventIds.length === 0) return;
    let disposed = false;
    void Promise.all(eventIds.map(async (eventId) => (
      [eventId, await getRoomMessage({ roomId, eventId }).catch(() => null)] as const
    ))).then((found) => {
      if (disposed) return;
      setLoaded((previous) => {
        const next = new Map(previous?.key === key ? previous.messages : []);
        for (const [id, message] of found) {
          if (!next.has(id)) next.set(id, message);
        }
        return { key, messages: next };
      });
    });
    return () => { disposed = true; };
  }, [key, lookup, roomId]);

  useEffect(() => {
    if (!roomId || !key) return;
    const unlisten = listen<{ roomId: string; redactedEventId: string }>("room-message-redacted", ({ payload }) => {
      if (payload.roomId !== roomId) return;
      setLoaded((previous) => {
        const next = new Map(previous?.key === key ? previous.messages : []);
        next.set(payload.redactedEventId, null);
        return { key, messages: next };
      });
    });
    return () => { void unlisten.then((stop) => stop(), () => {}); };
  }, [key, roomId]);

  return useMemo(() => {
    const articles = new Map<string, RssThread>();
    if (!key || !provider) {
      return { articles, ...partitionRssTimeline(messages, articles) };
    }
    const add = (root: Message) => {
      const article = ignoredUsers.has(root.sender) ? null : rssArticleCandidate(root, provider, subscriptions);
      if (article) {
        articles.set(root.eventId, { root, article });
      } else {
        articles.delete(root.eventId);
      }
    };
    for (const message of extraMessages.values()) {
      if (message) add(message);
    }
    for (const message of messages) add(message);
    return { articles, ...partitionRssTimeline(messages, articles, extraMessages) };
  }, [extraMessages, ignoredUsers, key, messages, provider, subscriptions]);
}
