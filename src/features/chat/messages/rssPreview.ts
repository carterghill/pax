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
  const entries = new Map<string, { promise: Promise<T | null>; expires: number }>();
  return (key: string, request: () => Promise<T | null>) => {
    const existing = entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.promise;
    if (existing) entries.delete(key);
    if (entries.size >= limit) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const entry = {
      promise: request().catch(() => null),
      expires: Date.now() + 10 * 60_000,
    };
    entries.set(key, entry);
    void entry.promise.then((result) => {
      if (result === null) entry.expires = Date.now() + 60_000;
    });
    return entry.promise;
  };
}

const cacheArticle = previewCache<ArticleMetadata>(160);
const cacheImage = previewCache<string>(32);

export function getRssPreviewImage(url: string) {
  return cacheImage(url, () => invoke<string | null>("get_rss_preview_image", { url }));
}

export function loadRssArticlePreview(
  key: string,
  feedUrl: string | null,
  articleUrl: string,
  onPreview: (preview: RssArticlePreview) => void,
): () => void {
  let disposed = false;

  void cacheArticle(key, () => invoke<ArticleMetadata | null>("get_rss_article_preview", {
    feedUrl,
    articleUrl,
  })).then((article) => {
    if (disposed || !article) return;
    let images: RssArticlePreview["images"] = {};
    onPreview({ article, images });

    for (const field of imageFields) {
      const url = article[field];
      if (!url) continue;
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
