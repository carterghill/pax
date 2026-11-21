import { useState, useEffect, useId, useRef, type CSSProperties } from "react";
import { invoke, convertFileSrc, isTauri } from "@tauri-apps/api/core";
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
const YOUTUBE_ORIGIN = "https://www.youtube.com";
const YOUTUBE_READY_TIMEOUT_MS = 15_000;

function youtubeCodecError(): string | null {
  const linuxDesktop = navigator.userAgent.includes("Linux") && !navigator.userAgent.includes("Android");
  if (!linuxDesktop || !isTauri() || typeof MediaSource === "undefined") return null;

  // The embedded player can report ready even when WebKit lacks the codecs
  // to start a stream. Ask WebKit directly so alternate plugin sets work too.
  const supportsMp4 =
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.42001E"') &&
    MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
  const supportsWebm =
    MediaSource.isTypeSupported('video/webm; codecs="vp9"') &&
    MediaSource.isTypeSupported('audio/webm; codecs="opus"');
  if (supportsMp4 || supportsWebm) return null;

  return "Linux is missing streaming codecs. Install GStreamer Bad Plug-ins or GStreamer Libav, then restart Pax.";
}

function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 5:
      return "The YouTube player couldn’t play this video.";
    case 100:
      return "The video was removed or is private.";
    case 101:
    case 150:
      return "The video owner has disabled embedded playback.";
    case 153:
      return "YouTube requires a referrer or app identity.";
    default:
      return "YouTube reported a player error.";
  }
}

/* ------------------------------------------------------------------ */
/*  Iframe embed                                                       */
/* ------------------------------------------------------------------ */

function IframeEmbedView({ embed, href }: { embed: IframeEmbed; href: string }) {
  const { palette, spacing, typography, resolvedColorScheme } = useTheme();
  const isYouTube = embed.provider === "YouTube";
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(() => isYouTube ? youtubeCodecError() : null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerId = useId();

  useEffect(() => {
    if (!isYouTube || error) return;
    const frame = iframeRef.current;
    if (!frame) return;

    // Use the iframe's message protocol so YouTube's script stays in its own frame.
    const send = (message: object) => {
      frame.contentWindow?.postMessage(
        JSON.stringify({ ...message, id: playerId, channel: "widget" }),
        YOUTUBE_ORIGIN,
      );
    };

    const listen = () => send({ event: "listening" });
    let subscribed = false;
    const interval = window.setInterval(listen, 250);
    const timeout = window.setTimeout(() => {
      setError("The YouTube player took too long to respond.");
    }, YOUTUBE_READY_TIMEOUT_MS);

    const receive = (event: MessageEvent) => {
      if (event.origin !== YOUTUBE_ORIGIN || event.source !== frame.contentWindow) return;
      if (typeof event.data !== "string") return;
      let message: { event?: unknown; info?: unknown; id?: unknown } | null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.id !== playerId) return;

      if (message.event === "readyToListen") {
        listen();
        return;
      }
      if (!subscribed && (message.event === "initialDelivery" || message.event === "onReady")) {
        send({ event: "command", func: "addEventListener", args: ["onError"] });
        subscribed = true;
      }
      if (message.event === "onReady") {
        window.clearInterval(interval);
        window.clearTimeout(timeout);
        setLoaded(true);
      }
      if (message.event === "onError" && typeof message.info === "number") {
        setError(`${youtubeErrorMessage(message.info)} (YouTube error ${message.info})`);
      }
    };

    window.addEventListener("message", receive);
    listen();
    return () => {
      window.removeEventListener("message", receive);
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [error, isYouTube, playerId]);

  let src = embed.src;
  if (isYouTube && /^https?:$/.test(window.location.protocol)) {
    const url = new URL(src);
    url.searchParams.set("origin", window.location.origin);
    src = url.href;
  }

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

  return (
    <div style={containerStyle}>
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
          aria-label="Open in browser"
          style={{ color: palette.textSecondary, lineHeight: 0 }}
        >
          <ExternalLink size={13} strokeWidth={2} />
        </a>
      </div>

      <div style={{ position: "relative", width: "100%", height: clampedHeight }}>
        {error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: spacing.unit,
              padding: spacing.unit * 2,
              backgroundColor: "#000",
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              textAlign: "center",
            }}
          >
            <AlertCircle size={20} aria-hidden="true" />
            <div role="status">
              <div>Could not {loaded ? "play" : "load"} {embed.provider} embed</div>
              <div style={{ color: "#ccc" }}>{error}</div>
            </div>
            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#fff" }}>
              Open in browser
            </a>
          </div>
        )}
        {!error && !loaded && (
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
        {!error && (
          <iframe
            ref={iframeRef}
            src={src}
            title={embed.title ?? `${embed.provider} embed`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            aria-hidden={!loaded}
            tabIndex={loaded ? undefined : -1}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: "none",
              opacity: loaded ? 1 : 0,
              pointerEvents: loaded ? undefined : "none",
              transition: "opacity 0.2s ease",
            }}
            onLoad={isYouTube ? undefined : () => setLoaded(true)}
            onError={() => setError("The embedded player failed to load.")}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Module-level metadata cache                                        */
/* ------------------------------------------------------------------ */

const MAX_METADATA_CACHE = 50;
const metadataCache = new Map<string, Promise<UrlMetadata>>();

function fetchMetadataCached(url: string): Promise<UrlMetadata> {
  const existing = metadataCache.get(url);
  if (existing) return existing;

  if (metadataCache.size >= MAX_METADATA_CACHE) {
    const oldest = metadataCache.keys().next().value;
    if (oldest) metadataCache.delete(oldest);
  }

  const promise = invoke<UrlMetadata>("fetch_url_metadata", { url }).catch(
    (err) => {
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
            loading="lazy"
            decoding="async"
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
    return <IframeEmbedView key={embed.src} embed={embed} href={href} />;
  }
  return <MetadataEmbedView embed={embed} href={href} />;
}
