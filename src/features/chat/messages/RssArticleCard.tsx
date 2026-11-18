import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Rss } from "lucide-react";
import { useTheme } from "../../../theme/ThemeContext";
import type { RssArticleCandidate } from "./rssArticle";

interface ArticlePreview {
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
  authorImage: string | null;
  siteImage: string | null;
  publishedAt: string | null;
  authors: string[];
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

const cacheArticle = previewCache<ArticlePreview>(160);
const cacheImage = previewCache<string>(32);

export function useRssArticlePreview(candidate: RssArticleCandidate | null) {
  const rowRef = useRef<HTMLDivElement>(null);
  const feedUrl = candidate?.feedUrl;
  const articleUrl = candidate?.url;
  const allowPageFallback = Boolean(candidate?.headline);
  const key = articleUrl ? JSON.stringify([feedUrl, articleUrl, allowPageFallback]) : null;
  const [result, setResult] = useState<{ key: string; preview: ArticlePreview | null } | null>(null);

  useEffect(() => {
    if (!key || !feedUrl || !articleUrl || !rowRef.current) return;

    let disposed = false;
    const load = () => {
      void cacheArticle(key, () => invoke<ArticlePreview | null>("get_rss_article_preview", {
        feedUrl,
        articleUrl,
        allowPageFallback,
      })).then((preview) => {
        if (!disposed) setResult({ key, preview });
      });
    };

    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => { disposed = true; };
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: "200px" });
    observer.observe(rowRef.current);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [allowPageFallback, articleUrl, feedUrl, key]);

  return { rowRef, preview: result?.key === key ? result.preview : null };
}

function usePreviewImage(url: string | null | undefined) {
  const [result, setResult] = useState<{ url: string; image: string | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    void cacheImage(url, () => invoke<string | null>("get_rss_preview_image", { url }))
      .then((image) => {
        if (!disposed) setResult({ url, image });
      });
    return () => { disposed = true; };
  }, [url]);
  return {
    image: result?.url === url ? result?.image : null,
    onError: () => {
      if (url) setResult({ url, image: null });
    },
  };
}

const publicationDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function RssArticleCard({
  candidate,
  preview,
  sender,
  postedAt,
}: {
  candidate: RssArticleCandidate;
  preview: ArticlePreview | null;
  sender: string;
  postedAt: string;
}) {
  const { palette, spacing, typography } = useTheme();
  const authorImage = usePreviewImage(preview?.authorImage);
  const siteImage = usePreviewImage(preview?.siteImage);
  const articleImage = usePreviewImage(preview?.image);
  const badgeImage = authorImage.image ? authorImage : siteImage;
  const site = preview?.siteName || candidate.siteName || candidate.hostname;
  const authors = preview?.authors.join(", ");
  const title = preview?.title || candidate.headline || candidate.hostname;
  const description = preview?.description;
  const date = preview?.publishedAt ? new Date(preview.publishedAt) : null;
  const published = date && Number.isFinite(date.valueOf()) ? date : null;

  return (
    <article
      style={{
        boxSizing: "border-box",
        maxWidth: 640,
        padding: spacing.unit * 3,
        border: `1px solid ${palette.border}`,
        borderRadius: spacing.unit * 2,
        backgroundColor: palette.bgTertiary,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          marginBottom: spacing.unit * 2,
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          lineHeight: 1.35,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            flexShrink: 0,
            overflow: "hidden",
            borderRadius: "50%",
            backgroundColor: palette.bgHover,
          }}
        >
          {badgeImage.image ? (
            <img
              src={badgeImage.image}
              onError={badgeImage.onError}
              alt=""
              width={28}
              height={28}
              style={{ objectFit: authorImage.image ? "cover" : "contain" }}
            />
          ) : <Rss size={15} />}
        </span>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }} title={`Posted by ${sender} · ${postedAt}`}>
          {authors && (
            <>
              <strong style={{ color: palette.textHeading }}>{authors}</strong>
              <span aria-hidden> · </span>
            </>
          )}
          {site}
          {published && (
            <>
              <span aria-hidden> · </span>
              <time dateTime={published.toISOString()}>{publicationDate.format(published)}</time>
            </>
          )}
        </span>
      </header>
      <div style={{ display: "flex", alignItems: "flex-start", gap: spacing.unit * 3 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <a
            href={candidate.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
              fontWeight: typography.fontWeightBold,
              lineHeight: 1.35,
              textUnderlineOffset: "0.18em",
              overflowWrap: "anywhere",
            }}
          >
            {title} <ExternalLink size={12} aria-hidden style={{ verticalAlign: "baseline", color: palette.textSecondary }} />
          </a>
          {description && (
            <p style={{
              margin: `${spacing.unit}px 0 0`,
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              overflowWrap: "anywhere",
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              lineHeight: 1.4,
            }}>
              {description}
            </p>
          )}
        </div>
        {articleImage.image && (
          <img
            src={articleImage.image}
            onError={articleImage.onError}
            alt=""
            width={128}
            height={80}
            style={{
              objectFit: "cover",
              width: "min(30%, 128px)",
              height: "auto",
              aspectRatio: "8 / 5",
              flexShrink: 0,
              borderRadius: spacing.unit,
            }}
          />
        )}
      </div>
    </article>
  );
}
