import assert from "node:assert/strict";
import test from "node:test";
import { rssArticleCandidate } from "./rssArticle.ts";

const provider = { url: "https://feeds.example.org/tech", botUserId: "@bot:nope.chat" };
const link = "https://tech.example.org/story/";
const update = {
  sender: provider.botUserId,
  senderName: "Bot",
  body: `New post in Tech News: A headline with a colon: the rest (\n${link}\n)`,
};

test("the provider announcement gives the headline, publisher, and original article link", () => {
  assert.deepEqual(rssArticleCandidate(update, provider), {
    feedUrl: provider.url,
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
  assert.equal(rssArticleCandidate({ ...update, body: `Error subscribing to ${provider.url}` }, provider), null);
  assert.equal(rssArticleCandidate(update), null);
});

test("a custom provider announcement needs a feed match", () => {
  const candidate = rssArticleCandidate({ ...update, body: `Just published: ${link}` }, provider);
  assert.equal(candidate?.url, link);
  assert.equal(candidate?.headline, undefined);
});
