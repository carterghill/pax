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

export function searchRssFeeds(query: string) {
  return invoke<FeedSearchResult[]>("search_rss_feeds", { query });
}

export function listRssSubscriptions(roomId: string) {
  return invoke<RoomFeedSubscriptions>("list_rss_subscriptions", { roomId });
}

export function updateRssSubscription(roomId: string, expectedBotUserId: string, change: SubscriptionChange) {
  return invoke<RoomFeedSubscription | null>("update_rss_subscription", { roomId, expectedBotUserId, change });
}
