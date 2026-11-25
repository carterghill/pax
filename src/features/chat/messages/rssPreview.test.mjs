import assert from "node:assert/strict";
import test from "node:test";
import { cachedRssArticlePreview, loadRssArticlePreview } from "./rssPreview.ts";

const feedUrl = "https://example.org/feed";
const article = {
  title: "A headline",
  description: null,
  siteName: null,
  via: null,
  image: null,
  authorImage: null,
  siteImage: null,
  publishedAt: null,
  authors: [],
};
const thumbnail = "https://example.org/thumbnail.png";
const bylinePhoto = "https://example.org/author.png";

function mockPreviews(t) {
  const requests = new Map();
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: (command, args) => new Promise((resolve) => {
        const url = command === "get_rss_article_preview" ? args.articleUrl : args.url;
        requests.set(url, resolve);
      }),
    },
  };
  t.after(() => { delete globalThis.window; });
  return async (url, result) => {
    assert.ok(requests.has(url), `expected a request for ${url}`);
    requests.get(url)(result);
    await new Promise(setImmediate);
  };
}

test("article details publish immediately and images fill in as they arrive", async (t) => {
  const respond = mockPreviews(t);
  const url = "https://example.org/first";
  const previews = [];
  loadRssArticlePreview(url, feedUrl, url, (value) => previews.push(value));

  const illustrated = { ...article, image: thumbnail, authorImage: bylinePhoto };
  await respond(url, illustrated);
  assert.deepEqual(previews, [{ article: illustrated, images: {} }]);

  await respond(thumbnail, "thumbnail data");
  await respond(bylinePhoto, "author data");
  assert.deepEqual(previews, [
    { article: illustrated, images: {} },
    { article: illustrated, images: { image: "thumbnail data" } },
    { article: illustrated, images: { image: "thumbnail data", authorImage: "author data" } },
  ]);
});

test("leaving a row drops late image results", async (t) => {
  const respond = mockPreviews(t);
  const url = "https://example.org/third";
  const image = "https://example.org/third.png";
  const publish = t.mock.fn();
  const cancel = loadRssArticlePreview(url, null, url, publish);

  await respond(url, { ...article, image });
  cancel();
  await respond(image, "late thumbnail data");

  assert.equal(publish.mock.callCount(), 1);
});

test("a returning article row has its cached metadata and images on the first render", async (t) => {
  const respond = mockPreviews(t);
  const url = "https://example.org/returning";
  const image = "https://example.org/returning.png";
  const illustrated = { ...article, image };
  const cancel = loadRssArticlePreview(url, feedUrl, url, () => {});
  await respond(url, illustrated);
  await respond(image, "cached thumbnail");
  cancel();

  const expected = { article: illustrated, images: { image: "cached thumbnail" } };
  assert.deepEqual(cachedRssArticlePreview(url), expected);
  const updates = [];
  loadRssArticlePreview(url, feedUrl, url, (value) => updates.push(value));
  await new Promise(setImmediate);
  assert.deepEqual(updates, [expected]);
});
