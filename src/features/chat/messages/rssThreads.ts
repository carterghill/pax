import type { Message } from "../../../types/matrix";
import type { RssArticleCandidate } from "./rssArticle";

export interface RssThread {
  root: Message;
  article: RssArticleCandidate;
}

export function partitionRssTimeline(
  messages: Message[],
  articles: ReadonlyMap<string, RssThread>,
  extraMessages?: ReadonlyMap<string, Message | null>,
) {
  const replies = new Map<string, Message[]>();
  const rootByReply = new Map<string, string>();
  if (articles.size === 0) return { visibleMessages: messages, replies, rootByReply };
  const byId = new Map(messages.map((message) => [message.eventId, message]));

  for (const message of messages) {
    let current: Message | undefined | null = message;
    const seen = new Set<string>();
    while (current && !seen.has(current.eventId)) {
      seen.add(current.eventId);
      const parent: string | undefined = current.threadRootId ?? current.replyTo?.eventId;
      if (!parent || parent === message.eventId) break;
      if (articles.has(parent)) {
        const thread = replies.get(parent) ?? [];
        thread.push(message);
        replies.set(parent, thread);
        rootByReply.set(message.eventId, parent);
        break;
      }
      if (current.threadRootId) break;
      current = byId.get(parent) ?? extraMessages?.get(parent);
    }
  }

  return {
    visibleMessages: rootByReply.size > 0
      ? messages.filter((message) => !rootByReply.has(message.eventId))
      : messages,
    replies,
    rootByReply,
  };
}

export function mergeThreadReplies(...groups: ReadonlyArray<ReadonlyArray<Message>>) {
  const byId = new Map<string, Message>();
  for (const group of groups) {
    for (const message of group) byId.set(message.eventId, message);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId));
}

export function rssThreadReplyCount(root: Message, replies: ReadonlyArray<Message>) {
  const sent = replies.filter((message) => !message.eventId.startsWith("local:"));
  const native = sent.filter((message) => message.threadRootId === root.eventId);
  const summary = root.threadSummary;
  if (!summary) return sent.length;
  const newer = native.filter((message) => (
    summary.latestTimestamp !== null &&
    message.timestamp > summary.latestTimestamp &&
    message.eventId !== summary.latestEventId
  )).length;
  return Math.max(summary.count + newer, native.length) + sent.length - native.length;
}
