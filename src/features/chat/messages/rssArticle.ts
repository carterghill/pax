import type { Message, RssProvider } from "../../../types/matrix";
import type { RoomFeedSubscription } from "../../rss/api";

export interface RssArticleCandidate {
  previewFeedUrl?: string;
  url: string;
  hostname: string;
  headline: string;
  siteName?: string;
  via?: "Google News";
}

const publicationDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const publicationTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export function formatRssPublication(value: string | null | undefined, now = new Date()) {
  if (!value) return null;
  const timestamp = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(timestamp);
  const date = new Date(dateOnly ? `${timestamp}T00:00:00` : timestamp);
  if (!Number.isFinite(date.valueOf())) return null;

  const hasTime = /[T\s]\d{1,2}:\d{2}/i.test(timestamp);
  const showTime = hasTime && date.toDateString() === now.toDateString();
  return {
    dateTime: dateOnly ? timestamp : date.toISOString(),
    label: showTime ? `Today at ${publicationTime.format(date)}` : publicationDate.format(date),
  };
}

const webLink = /https?:\/\/(?:[^\s<>"'`()[\]]|\([^\s()]*\))+/gi;
const googleNewsArticlePath = /^\/(?:rss\/)?(?:articles|read)\//;
const googleNewsFeedTitle = /(?:^| - )Google News$/i;
const googleNewsSearchTitle = /^"(.+)" - Google News$/i;

function announcement(body: string) {
  // The Maubot and t2bot announcements include a publication before the headline.
  return body.match(/^new post in\s+(.+?):\s+([\s\S]+)$/i);
}

function announcementText(text: string) {
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s]+?\)/gi, "$1")
    .replace(webLink, "")
    .replace(/\(\s*\)/g, "")
    .trim();
}

function googleNewsPreviewFeed(feedTitle: string, article: URL) {
  const query = feedTitle.match(googleNewsSearchTitle)?.[1];
  if (!query || query.length > 512) return;

  const feed = new URL("https://news.google.com/rss/search");
  feed.searchParams.set("q", query);
  if (article.hostname === feed.hostname) {
    for (const key of ["hl", "gl", "ceid"]) {
      const value = article.searchParams.get(key);
      if (value) feed.searchParams.set(key, value);
    }
  }
  return feed.href;
}

export function rssArticleCandidate(
  message: Message,
  provider?: RssProvider,
  subscriptions?: readonly RoomFeedSubscription[],
): RssArticleCandidate | null {
  if (
    !provider ||
    message.sender !== provider.botUserId ||
    message.replyTo ||
    message.threadRootId ||
    message.decryptionFailed ||
    message.imageMediaRequest ||
    message.videoMediaRequest ||
    message.fileMediaRequest ||
    message.unsupportedMatrixMsgtype
  ) {
    return null;
  }

  const body = message.body.trim();
  const update = announcement(body);
  if (!update) return null;

  const headline = announcementText(update[2]);
  const feedTitle = announcementText(update[1]);
  if (!headline) return null;
  const links = update[2].match(webLink);
  for (const link of links?.reverse() ?? []) {
    try {
      const url = new URL(link.replace(/[.,;:]+$/, ""));
      if (url.username || url.password || (url.pathname === "/" && !url.search)) continue;
      const fromGoogleNews = (url.hostname === "news.google.com" && googleNewsArticlePath.test(url.pathname))
        || googleNewsFeedTitle.test(feedTitle);
      // Google News appends the publisher to each item title, even if the item leaves the feed.
      const publisher = fromGoogleNews ? headline.match(/^(.+) - (.+)$/) : null;
      const matchingFeeds = subscriptions?.filter(({ title }) => title === feedTitle);
      const previewFeedUrl = matchingFeeds?.length === 1
        ? matchingFeeds[0].url
        : googleNewsPreviewFeed(feedTitle, url);
      return {
        ...(previewFeedUrl && { previewFeedUrl }),
        url: url.href,
        hostname: url.hostname.replace(/^www\./i, ""),
        headline: publisher?.[1] ?? headline,
        siteName: publisher?.[2] ?? feedTitle,
        ...(publisher && { via: "Google News" }),
      };
    } catch {
      // Try the next link when a provider sends a malformed URL.
    }
  }
  return null;
}
