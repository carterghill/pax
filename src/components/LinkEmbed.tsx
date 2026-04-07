import { useState, useEffect, useRef, type CSSProperties } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Play, ExternalLink, AlertCircle } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { EmbedInfo, IframeEmbed } from "../utils/urlEmbed";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface UrlMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  video_url: string | null;
}

interface LinkEmbedProps {
  embed: EmbedInfo;
  /** The original URL the user posted (for the "open" fallback link). */
  href: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_EMBED_WIDTH = 480;
const MAX_EMBED_HEIGHT = 320;

/* ------------------------------------------------------------------ */
/*  Iframe embed                                                       */
/* ------------------------------------------------------------------ */

function IframeEmbedView({ embed, href }: { embed: IframeEmbed; href: string }) {
  const { palette, spacing, typography, resolvedColorScheme } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const width = MAX_EMBED_WIDTH;
  const height = Math.round(width / embed.aspect);
  const clampedHeight = Math.min(height, MAX_EMBED_HEIGHT);

  const containerStyle: CSSProperties = {
    position: "relative",
    width,
    maxWidth: "100%",
    borderRadius: spacing.unit * 1.5,
    overflow: "hidden",
    border: `1px solid ${palette.border}`,
    borderLeft: `3px solid ${embed.color}`,
    backgroundColor: palette.bgSecondary,
    marginTop: spacing.unit,
    marginBottom: spacing.unit,
    boxShadow:
      resolvedColorScheme === "light"
        ? "0 1px 3px rgba(0,0,0,0.06)"
        : "0 2px 8px rgba(0,0,0,0.25)",
  };

  if (error) {
    return (
      <div style={containerStyle}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            padding: spacing.unit * 2,
            color: palette.textSecondary,
            textDecoration: "none",
            fontSize: typography.fontSizeSmall,
          }}
        >
          <AlertCircle size={16} />
          <span>Could not load {embed.provider} embed —</span>
          <span style={{ color: palette.accent, textDecoration: "underline" }}>open link</span>
        </a>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Provider label */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${spacing.unit}px ${spacing.unit * 1.5}px`,
          backgroundColor: palette.bgTertiary,
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: typography.fontSizeSmall - 1,
            fontWeight: typography.fontWeightMedium,
            color: embed.color,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {embed.provider}
        </span>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in browser"
          style={{ color: palette.textSecondary, lineHeight: 0 }}
        >
          <ExternalLink size={13} strokeWidth={2} />
        </a>
      </div>

      {/* Iframe */}
      <div style={{ position: "relative", width: "100%", height: clampedHeight }}>
        {!loaded && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: palette.bgSecondary,
            }}
          >
            <Play size={32} color={palette.textSecondary} style={{ opacity: 0.4 }} />
          </div>
        )}
        <iframe
          src={embed.src}
          title={embed.title ?? `${embed.provider} embed`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            border: "none",
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.2s ease",
          }}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Module-level metadata cache                                        */
/* ------------------------------------------------------------------ */

/** Shared cache so duplicate URLs across messages don't re-fetch. */
const metadataCache = new Map<string, Promise<UrlMetadata>>();

function fetchMetadataCached(url: string): Promise<UrlMetadata> {
  const existing = metadataCache.get(url);
  if (existing) return existing;

  const promise = invoke<UrlMetadata>("fetch_url_metadata", { url }).catch(
    (err) => {
      // Evict on failure so the next attempt can retry.
      metadataCache.delete(url);
      throw err;
    }
  );
  metadataCache.set(url, promise);
  return promise;
}

/* ------------------------------------------------------------------ */
/*  Metadata embed (Twitter, generic OG previews)                      */
/* ------------------------------------------------------------------ */

function MetadataEmbedView({
  embed,
  href,
}: {
  embed: Extract<EmbedInfo, { kind: "metadata" }>;
  href: string;
}) {
  const { palette, spacing, typography, resolvedColorScheme } = useTheme();
  const [meta, setMeta] = useState<UrlMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const fetched = useRef(false);
  /** The on-disk temp path returned by proxy_media, for cleanup. */
  const tempFilePath = useRef<string | null>(null);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;

    fetchMetadataCached(embed.url)
      .then((data) => {
        setMeta(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [embed.url]);

  // Clean up the temp video file when this embed unmounts.
  useEffect(() => {
    return () => {
      const path = tempFilePath.current;
      if (path) {
        invoke("cleanup_proxy_media", { path }).catch(() => {});
      }
    };
  }, []);

  // Download video via Rust proxy and create an asset URL from the temp file
  const handlePlay = async (videoUrl: string) => {
    setPlaying(true);
    setVideoLoading(true);
    try {
      const filePath = await invoke<string>("proxy_media", { url: videoUrl });
      tempFilePath.current = filePath;
      setVideoSrc(convertFileSrc(filePath));
    } catch (err) {
      console.error("[Pax Embed] Failed to proxy video:", err);
      setPlaying(false);
    } finally {
      setVideoLoading(false);
    }
  };

  const containerStyle: CSSProperties = {
    width: MAX_EMBED_WIDTH,
    maxWidth: "100%",
    borderRadius: spacing.unit * 1.5,
    overflow: "hidden",
    border: `1px solid ${palette.border}`,
    borderLeft: `3px solid ${embed.color}`,
    backgroundColor: palette.bgSecondary,
    marginTop: spacing.unit,
    marginBottom: spacing.unit,
    boxShadow:
      resolvedColorScheme === "light"
        ? "0 1px 3px rgba(0,0,0,0.06)"
        : "0 2px 8px rgba(0,0,0,0.25)",
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            padding: spacing.unit * 2,
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
          }}
        >
          Loading preview…
        </div>
      </div>
    );
  }

  if (error || !meta) {
    return null;
  }

  const hasImage = Boolean(meta.image);
  const hasVideo = Boolean(meta.video_url);

  // Media section: video player or thumbnail
  const mediaSection = (() => {
    if (playing && hasVideo) {
      return (
        <div style={{ position: "relative", width: "100%", backgroundColor: "#000" }}>
          {videoLoading || !videoSrc ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 200,
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
              }}
            >
              Loading video…
            </div>
          ) : (
            <video
              src={videoSrc}
              controls
              autoPlay
              style={{ display: "block", width: "100%", maxHeight: 400 }}
              onError={(e) => {
                const vid = e.currentTarget;
                console.error("[Pax Embed] Video error:", {
                  src: vid.src,
                  originalUrl: meta.video_url,
                  error: vid.error?.message,
                  code: vid.error?.code,
                  networkState: vid.networkState,
                });
              }}
            />
          )}
        </div>
      );
    }

    if (hasImage) {
      return (
        <div
          style={{
            position: "relative",
            width: "100%",
            backgroundColor: palette.bgTertiary,
            cursor: hasVideo ? "pointer" : "default",
          }}
          onClick={
            hasVideo
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handlePlay(meta.video_url!);
                }
              : undefined
          }
        >
          <img
            src={meta.image!}
            alt=""
            style={{
              display: "block",
              width: "100%",
              maxHeight: 250,
              objectFit: "cover",
            }}
          />
          {hasVideo && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(0,0,0,0.3)",
                transition: "background 0.15s ease",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  backgroundColor: "rgba(0,0,0,0.6)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "transform 0.15s ease",
                }}
              >
                <Play size={28} color="#fff" fill="#fff" />
              </div>
            </div>
          )}
        </div>
      );
    }
    return null;
  })();

  // Text content section (always links to original URL)
  const textSection = (
    <div style={{ padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px` }}>
      {meta.site_name && (
        <div
          style={{
            fontSize: typography.fontSizeSmall - 1,
            fontWeight: typography.fontWeightMedium,
            color: embed.color,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: spacing.unit * 0.5,
          }}
        >
          {meta.site_name}
        </div>
      )}
      {meta.title && (
        <div
          style={{
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textPrimary,
            lineHeight: typography.lineHeight,
            marginBottom: meta.description ? spacing.unit * 0.5 : 0,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {meta.title}
        </div>
      )}
      {meta.description && (
        <div
          style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            lineHeight: typography.lineHeight,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {meta.description}
        </div>
      )}
    </div>
  );

  // When there's a video, keep the media section outside the <a> tag entirely
  // so clicks on the thumbnail/play button and video controls don't get
  // intercepted by the global external-link handler (capture phase).
  if (hasVideo) {
    return (
      <div style={containerStyle}>
        {mediaSection}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none", display: "block" }}
        >
          {textSection}
        </a>
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: "none", display: "block" }}
    >
      <div style={containerStyle}>
        {mediaSection}
        {textSection}
      </div>
    </a>
  );
}

/* ------------------------------------------------------------------ */
/*  Main export                                                        */
/* ------------------------------------------------------------------ */

export default function LinkEmbed({ embed, href }: LinkEmbedProps) {
  if (embed.kind === "iframe") {
    return <IframeEmbedView embed={embed} href={href} />;
  }
  return <MetadataEmbedView embed={embed} href={href} />;
}