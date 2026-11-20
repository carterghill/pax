import assert from "node:assert/strict";
import test from "node:test";
import { formatRssPublication, rssArticleCandidate } from "./rssArticle.ts";

const provider = { botUserId: "@bot:nope.chat" };
const techFeed = { id: "42", title: "Tech News", url: "https://feeds.example.org/tech" };
const link = "https://tech.example.org/story/";
const update = {
  sender: provider.botUserId,
  senderName: "Bot",
  body: `New post in Tech News: A headline with a colon: the rest (\n${link}\n)`,
};

test("the provider announcement gives the headline, publisher, and original article link", () => {
  assert.deepEqual(rssArticleCandidate(update, provider), {
    url: link,
    hostname: "tech.example.org",
    headline: "A headline with a colon: the rest",
    siteName: "Tech News",
  });
  const markdown = { ...update, body: `New post in [Tech News](https://tech.example.org): [A headline](${link})` };
  assert.equal(rssArticleCandidate(markdown, provider)?.headline, "A headline");
  assert.equal(rssArticleCandidate(markdown, provider)?.siteName, "Tech News");
});

test("other senders, replies, and setup errors keep their regular message layout", () => {
  assert.equal(rssArticleCandidate({ ...update, sender: "@bot:example.org" }, provider), null);
  assert.equal(rssArticleCandidate({ ...update, replyTo: { eventId: "$setup" } }, provider), null);
  assert.equal(rssArticleCandidate({ ...update, body: `Error subscribing to ${techFeed.url}` }, provider), null);
  assert.equal(rssArticleCandidate(update), null);
});

test("a Google News bot announcement supplies publisher credit before the preview loads", () => {
  const googleFeed = "https://news.google.com/rss/search?q=when%3A24h+site%3Areuters.com%2Fworld";
  const headline = "With foreign aid slashed, Africa must 'own its own future', billionaire Ibrahim says";
  const googleLink = "https://news.google.com/rss/articles/abc?oc=5";
  const announcement = {
    ...update,
    body: `New post in "when:24h site:reuters.com/world" - Google News: ${headline} - Reuters (\n${googleLink}\n)`,
  };
  assert.deepEqual(rssArticleCandidate(announcement, provider, [techFeed]), {
    previewFeedUrl: googleFeed,
    url: googleLink,
    hostname: "news.google.com",
    headline,
    siteName: "Reuters",
    via: "Google News",
  });
  const publisherLink = "https://www.reuters.com/world/africa/story/";
  const direct = { ...announcement, body: announcement.body.replace(googleLink, publisherLink) };
  const directCandidate = rssArticleCandidate(direct, provider);
  assert.equal(directCandidate?.siteName, "Reuters");
  assert.equal(directCandidate?.previewFeedUrl, googleFeed);
  const ordinary = { ...update, body: `New post in Tech News: A headline - Analysis (${link})` };
  assert.equal(rssArticleCandidate(ordinary, provider)?.headline, "A headline - Analysis");
});

test("article metadata uses the matching bot subscription when its title is unique", () => {
  const other = { id: "43", title: "Other", url: "https://example.org/rss" };
  assert.equal(rssArticleCandidate(update, provider, [other, techFeed])?.previewFeedUrl, techFeed.url);
  assert.equal(rssArticleCandidate(update, provider, [other])?.previewFeedUrl, undefined);
  assert.equal(
    rssArticleCandidate(update, provider, [techFeed, { ...other, title: techFeed.title }])?.previewFeedUrl,
    undefined,
  );
});

test("publication times are shown for articles published on the local day", () => {
  const now = new Date(2026, 10, 19, 23, 55);
  const today = new Date(2026, 10, 19, 23, 45);
  const previousDay = new Date(2026, 10, 18, 23, 50);
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

  for (const timestamp of [today.toISOString(), today.toUTCString()]) {
    assert.deepEqual(formatRssPublication(timestamp, now), {
      dateTime: today.toISOString(),
      label: `Today at ${timeFormat.format(today)}`,
    });
  }
  assert.equal(formatRssPublication(previousDay.toISOString(), now)?.label, dateFormat.format(previousDay));
  assert.deepEqual(formatRssPublication("2026-11-19", now), {
    dateTime: "2026-11-19",
    label: dateFormat.format(today),
  });
  assert.equal(formatRssPublication("Invalid date", now), null);
});
