import type { Message, RssProvider } from "../../../types/matrix";

export interface RssArticleCandidate {
  feedUrl: string;
  url: string;
  hostname: string;
  headline?: string;
  siteName?: string;
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

export function rssArticleCandidate(
  message: Message,
  provider?: RssProvider,
): RssArticleCandidate | null {
  if (
    !provider?.url ||
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
  if (!update && /^(?:error\b|failed\b|could not\b|unable to\b|subscribed\b|unsubscribed\b|usage\b|!rss\b)/i.test(body)) {
    return null;
  }

  const links = (update?.[2] ?? body).match(webLink);
  for (const link of links?.reverse() ?? []) {
    try {
      const url = new URL(link.replace(/[.,;:]+$/, ""));
      if (url.username || url.password || (url.pathname === "/" && !url.search)) continue;
      const headline = update ? announcementText(update[2]) : undefined;
      return {
        feedUrl: provider.url,
        url: url.href,
        hostname: url.hostname.replace(/^www\./i, ""),
        headline: headline || undefined,
        siteName: update ? announcementText(update[1]) : undefined,
      };
    } catch {
      // Try the next link when a provider sends a malformed URL.
    }
  }
  return null;
}
