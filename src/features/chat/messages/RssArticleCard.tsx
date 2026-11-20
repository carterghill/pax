import { memo, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { ExternalLink, Rss } from "lucide-react";
import { useTheme } from "../../../theme/ThemeContext";
import { formatRssPublication, type RssArticleCandidate } from "./rssArticle";
import { loadRssArticlePreview, type RssArticlePreview } from "./rssPreview";

export function useRssArticlePreview(candidate: RssArticleCandidate | null) {
  const rowRef = useRef<HTMLDivElement>(null);
  const feedUrl = candidate?.previewFeedUrl ?? null;
  const articleUrl = candidate?.url;
  const key = articleUrl ? JSON.stringify([feedUrl, articleUrl]) : null;
  const [result, setResult] = useState<{ key: string; preview: RssArticlePreview } | null>(null);

  useEffect(() => {
    if (!key || !articleUrl || !rowRef.current) return;

    const load = () =>
      loadRssArticlePreview(key, feedUrl, articleUrl, (preview) => {
        setResult({ key, preview });
      });

    if (typeof IntersectionObserver === "undefined") return load();

    let disposed = false;
    let cancelLoad: (() => void) | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (disposed || cancelLoad || !entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      cancelLoad = load();
    }, { rootMargin: "200px" });
    observer.observe(rowRef.current);
    return () => {
      disposed = true;
      observer.disconnect();
      cancelLoad?.();
    };
  }, [articleUrl, feedUrl, key]);

  return { rowRef, preview: result?.key === key ? result.preview : null };
}

const headlineLines = 2;
const summaryLines = 3;
const thumbnailWidth = 128;
const thumbnailHeight = 80;

export const RssArticleCard = memo(function RssArticleCard({
  candidate,
  preview,
  sender,
  postedAt,
}: {
  candidate: RssArticleCandidate;
  preview: RssArticlePreview | null;
  sender: string;
  postedAt: string;
}) {
  const { palette, spacing, typography } = useTheme();
  const [brokenImages, setBrokenImages] = useState(() => new Set<string>());
  const article = preview?.article;
  const via = article?.via || candidate.via;
  const preferAnnouncement = candidate.via && !article?.via;
  const site = (!preferAnnouncement && article?.siteName) || candidate.siteName || candidate.hostname;
  const usableImage = (src?: string) => src && !brokenImages.has(src) ? src : undefined;
  const authorImage = usableImage(preview?.images.authorImage);
  const siteImage = !via || article?.siteName === site ? usableImage(preview?.images.siteImage) : undefined;
  const badgeImage = authorImage ?? siteImage;
  const articleImage = usableImage(preview?.images.image);
  const hideBrokenImage = (event: SyntheticEvent<HTMLImageElement>) => {
    const src = event.currentTarget.getAttribute("src");
    if (!src) return;
    setBrokenImages((previous) => previous.has(src) ? previous : new Set(previous).add(src));
  };
  const authors = article?.authors.join(", ");
  const title = (!preferAnnouncement && article?.title) || candidate.headline || candidate.hostname;
  const description = article?.description;
  const published = formatRssPublication(article?.publishedAt);
  const byline = [authors, site, published?.label, via && `via ${via}`].filter(Boolean).join(" · ");
  const headlineLineHeight = typography.fontSizeBase * 1.35;
  const summaryLineHeight = typography.fontSizeSmall * 1.4;
  const bylineLineHeight = typography.fontSizeSmall * 1.35;
  const bodyHeight = Math.max(
    thumbnailHeight,
    headlineLines * headlineLineHeight + spacing.unit + summaryLines * summaryLineHeight,
  );

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
          height: Math.max(28, bylineLineHeight * 2),
          marginBottom: spacing.unit * 2,
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          lineHeight: `${bylineLineHeight}px`,
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
          {badgeImage ? (
            <img
              src={badgeImage}
              onError={hideBrokenImage}
              alt=""
              width={28}
              height={28}
              style={{ objectFit: authorImage ? "cover" : "contain" }}
            />
          ) : <Rss size={15} />}
        </span>
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
          title={`${byline}\nPosted by ${sender} · ${postedAt}`}
        >
          {authors && (
            <>
              <strong style={{ color: palette.textHeading }}>{authors}</strong>
              <span aria-hidden> · </span>
            </>
          )}
          {via ? (
            <span style={{ color: palette.textHeading, fontWeight: typography.fontWeightMedium }}>{site}</span>
          ) : site}
          {published && (
            <>
              <span aria-hidden> · </span>
              <time dateTime={published.dateTime}>{published.label}</time>
            </>
          )}
          {via && <span style={{ fontSize: "0.85em", whiteSpace: "nowrap" }}> · via {via}</span>}
        </span>
      </header>
      {/* Keep the card's height independent of when its metadata and images arrive. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: spacing.unit * 3, height: bodyHeight }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <a
            href={candidate.url}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            style={{
              display: "-webkit-box",
              WebkitLineClamp: headlineLines,
              WebkitBoxOrient: "vertical",
              height: headlineLineHeight * headlineLines,
              overflow: "hidden",
              color: palette.textHeading,
              fontSize: typography.fontSizeBase,
              fontWeight: typography.fontWeightBold,
              lineHeight: `${headlineLineHeight}px`,
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
              WebkitLineClamp: summaryLines,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              overflowWrap: "anywhere",
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              lineHeight: `${summaryLineHeight}px`,
            }}>
              {description}
            </p>
          )}
        </div>
        <div
          aria-hidden
          style={{
            position: "relative",
            width: `min(30%, ${thumbnailWidth}px)`,
            aspectRatio: `${thumbnailWidth} / ${thumbnailHeight}`,
            flexShrink: 0,
            overflow: "hidden",
            borderRadius: spacing.unit,
          }}
        >
          {articleImage && (
            <img
              src={articleImage}
              onError={hideBrokenImage}
              alt=""
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            />
          )}
        </div>
      </div>
    </article>
  );
});
