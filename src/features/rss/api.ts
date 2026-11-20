import { invoke } from "@tauri-apps/api/core";

export interface FeedSearchResult {
  url: string;
  title: string;
  description: string | null;
  website: string | null;
  imageUrl: string | null;
  iconUrl: string | null;
}

export interface RoomFeedSubscription {
  id: string;
  title: string;
  url: string;
}

export interface RoomFeedSubscriptions {
  botUserId: string;
  canManage: boolean;
  subscriptions: RoomFeedSubscription[];
}

export type SubscriptionChange = { kind: "subscribe"; url: string } | { kind: "unsubscribe"; id: string };

// The timeline can use feed metadata from lists already fetched by the selector.
// The selector itself always reads the bot.
const recentLists = new Map<string, RoomFeedSubscriptions>();
const listListeners = new Set<() => void>();

export function subscribeToRssLists(listener: () => void) {
  listListeners.add(listener);
  return () => { listListeners.delete(listener); };
}

export function recentRssList(roomId: string | null, botUserId: string | undefined) {
  if (!roomId) return;
  const list = recentLists.get(roomId);
  return list && list.botUserId === botUserId ? list.subscriptions : undefined;
}

export function searchRssFeeds(query: string) {
  return invoke<FeedSearchResult[]>("search_rss_feeds", { query });
}

export async function listRssSubscriptions(roomId: string) {
  const list = await invoke<RoomFeedSubscriptions>("list_rss_subscriptions", { roomId });
  recentLists.delete(roomId);
  recentLists.set(roomId, list);
  const oldest = recentLists.keys().next().value;
  if (recentLists.size > 32 && oldest) recentLists.delete(oldest);
  for (const listener of listListeners) listener();
  return list;
}

export function updateRssSubscription(roomId: string, expectedBotUserId: string, change: SubscriptionChange) {
  return invoke<RoomFeedSubscription | null>("update_rss_subscription", { roomId, expectedBotUserId, change });
}
