import { invoke } from "@tauri-apps/api/core";

interface ArticleMetadata {
  title: string | null;
  description: string | null;
  siteName: string | null;
  via: string | null;
  image: string | null;
  authorImage: string | null;
  siteImage: string | null;
  publishedAt: string | null;
  authors: string[];
}

const imageFields = ["image", "authorImage", "siteImage"] as const;

export interface RssArticlePreview {
  article: ArticleMetadata;
  images: Partial<Record<(typeof imageFields)[number], string>>;
}

function previewCache<T>(limit: number) {
  type Entry = { promise: Promise<T | null>; expires: number; value?: T | null };
  const entries = new Map<string, Entry>();
  function load(key: string, request: () => Promise<T | null>) {
    const existing = entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.promise;
    if (existing) entries.delete(key);
    if (entries.size >= limit) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const entry: Entry = {
      promise: request().catch(() => null),
      expires: Date.now() + 10 * 60_000,
    };
    entries.set(key, entry);
    void entry.promise.then((result) => {
      entry.value = result;
      if (result === null) entry.expires = Date.now() + 60_000;
    });
    return entry.promise;
  }
  function peek(key: string) {
    const entry = entries.get(key);
    return entry && entry.expires > Date.now() ? entry.value : undefined;
  }
  return { load, peek };
}

const cacheArticle = previewCache<ArticleMetadata>(160);
const cacheImage = previewCache<string>(32);

export function getRssPreviewImage(url: string) {
  return cacheImage.load(url, () => invoke<string | null>("get_rss_preview_image", { url }));
}

function cachedImages(article: ArticleMetadata) {
  const images: RssArticlePreview["images"] = {};
  for (const field of imageFields) {
    const url = article[field];
    const image = url && cacheImage.peek(url);
    if (image) images[field] = image;
  }
  return images;
}

export function cachedRssArticlePreview(key: string): RssArticlePreview | null {
  const article = cacheArticle.peek(key);
  return article ? { article, images: cachedImages(article) } : null;
}

export function loadRssArticlePreview(
  key: string,
  feedUrl: string | null,
  articleUrl: string,
  onPreview: (preview: RssArticlePreview) => void,
): () => void {
  let disposed = false;

  void cacheArticle.load(key, () => invoke<ArticleMetadata | null>("get_rss_article_preview", {
    feedUrl,
    articleUrl,
  })).then((article) => {
    if (disposed || !article) return;
    let images = cachedImages(article);
    onPreview({ article, images });

    for (const field of imageFields) {
      const url = article[field];
      if (!url || images[field]) continue;
      void getRssPreviewImage(url).then((image) => {
        if (disposed || !image) return;
        images = { ...images, [field]: image };
        onPreview({ article, images });
      });
    }
  });

  return () => {
    disposed = true;
  };
}
