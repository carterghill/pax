/**
 * URL embed provider registry.
 *
 * Each provider defines a regex to match URLs and an `embed` function that
 * returns the data needed to render the embed.  Adding a new platform is just
 * pushing another entry onto `EMBED_PROVIDERS`.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface IframeEmbed {
    kind: "iframe";
    provider: string;
    /** Brand colour shown on the accent bar / loading state. */
    color: string;
    src: string;
    /** Aspect ratio as width/height (e.g. 16/9). */
    aspect: number;
    /** Optional title for the iframe (accessibility). */
    title?: string;
  }
  
  export interface MetadataEmbed {
    kind: "metadata";
    provider: string;
    color: string;
    /** Original URL to fetch OG metadata for. */
    url: string;
  }
  
  export type EmbedInfo = IframeEmbed | MetadataEmbed;
  
  interface EmbedProvider {
    name: string;
    /** Test whether this provider handles the URL. */
    match: (url: URL) => boolean;
    /** Build the embed descriptor from the matched URL. */
    embed: (url: URL) => EmbedInfo | null;
  }
  
  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */
  
  function hostMatches(url: URL, ...hosts: string[]): boolean {
    const h = url.hostname.toLowerCase();
    return hosts.some((p) => h === p || h.endsWith(`.${p}`));
  }
  
  /* ------------------------------------------------------------------ */
  /*  Provider definitions                                               */
  /* ------------------------------------------------------------------ */
  
  const YOUTUBE: EmbedProvider = {
    name: "YouTube",
    match: (u) =>
      hostMatches(u, "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"),
    embed: (u) => {
      let videoId: string | null = null;
      let start: string | null = null;
  
      if (hostMatches(u, "youtu.be")) {
        videoId = u.pathname.slice(1).split("/")[0] || null;
      } else {
        // /watch?v=ID  or  /shorts/ID  or  /embed/ID  or  /live/ID
        videoId =
          u.searchParams.get("v") ??
          u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/)?.[2] ??
          null;
      }
      if (!videoId || !/^[\w-]{5,}$/.test(videoId)) return null;
  
      start = u.searchParams.get("t");
      const params = new URLSearchParams({ autoplay: "0", rel: "0" });
      if (start) params.set("start", start.replace(/s$/, ""));
  
      return {
        kind: "iframe",
        provider: "YouTube",
        color: "#FF0000",
        src: `https://www.youtube.com/embed/${videoId}?${params}`,
        aspect: 16 / 9,
        title: "YouTube video",
      };
    },
  };
  
  const TWITCH_CLIP: EmbedProvider = {
    name: "Twitch",
    match: (u) => hostMatches(u, "twitch.tv", "clips.twitch.tv"),
    embed: (u) => {
      // clips.twitch.tv/SLUG  or  twitch.tv/*/clip/SLUG
      const clipSlug =
        (hostMatches(u, "clips.twitch.tv") && u.pathname.slice(1).split("/")[0]) ||
        u.pathname.match(/\/clip\/([\w-]+)/)?.[1] ||
        null;
  
      if (clipSlug) {
        const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";
        return {
          kind: "iframe",
          provider: "Twitch",
          color: "#9146FF",
          src: `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${parent}`,
          aspect: 16 / 9,
          title: "Twitch clip",
        };
      }
  
      // twitch.tv/videos/ID
      const vodId = u.pathname.match(/\/videos\/(\d+)/)?.[1];
      if (vodId) {
        const parent = typeof window !== "undefined" ? window.location.hostname : "localhost";
        return {
          kind: "iframe",
          provider: "Twitch",
          color: "#9146FF",
          src: `https://player.twitch.tv/?video=${vodId}&parent=${parent}`,
          aspect: 16 / 9,
          title: "Twitch VOD",
        };
      }
  
      return null;
    },
  };
  
  const STREAMABLE: EmbedProvider = {
    name: "Streamable",
    match: (u) => hostMatches(u, "streamable.com"),
    embed: (u) => {
      const id = u.pathname.match(/^\/([\w-]+)/)?.[1];
      if (!id || id === "login" || id === "signup") return null;
      return {
        kind: "iframe",
        provider: "Streamable",
        color: "#0A66C2",
        src: `https://streamable.com/e/${id}`,
        aspect: 16 / 9,
        title: "Streamable video",
      };
    },
  };
  
  const VIMEO: EmbedProvider = {
    name: "Vimeo",
    match: (u) => hostMatches(u, "vimeo.com"),
    embed: (u) => {
      const id = u.pathname.match(/^\/(\d+)/)?.[1];
      if (!id) return null;
      return {
        kind: "iframe",
        provider: "Vimeo",
        color: "#1AB7EA",
        src: `https://player.vimeo.com/video/${id}`,
        aspect: 16 / 9,
        title: "Vimeo video",
      };
    },
  };
  
  const SPOTIFY: EmbedProvider = {
    name: "Spotify",
    match: (u) => hostMatches(u, "open.spotify.com"),
    embed: (u) => {
      // /track/ID  /album/ID  /playlist/ID  /episode/ID
      const m = u.pathname.match(/^\/(track|album|playlist|episode)\/([\w]+)/);
      if (!m) return null;
      const [, type, id] = m;
      const isCompact = type === "track";
      return {
        kind: "iframe",
        provider: "Spotify",
        color: "#1DB954",
        src: `https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`,
        aspect: isCompact ? 360 / 80 : 360 / 380,
        title: `Spotify ${type}`,
      };
    },
  };
  
  const TWITTER: EmbedProvider = {
    name: "Twitter",
    match: (u) =>
      hostMatches(u, "twitter.com", "x.com") &&
      /^\/[\w]+\/status\/\d+/.test(u.pathname),
    embed: (u) => ({
      kind: "metadata",
      provider: "Twitter",
      color: "#1DA1F2",
      url: u.href,
    }),
  };
  
  /* ------------------------------------------------------------------ */
  /*  Registry                                                           */
  /* ------------------------------------------------------------------ */
  
  const EMBED_PROVIDERS: EmbedProvider[] = [
    YOUTUBE,
    TWITCH_CLIP,
    STREAMABLE,
    VIMEO,
    SPOTIFY,
    TWITTER,
  ];
  
  /**
   * Try to resolve embed info for a URL string.
   * Returns `null` if no provider matches or the URL is invalid.
   */
  export function resolveEmbed(href: string): EmbedInfo | null {
    let url: URL;
    try {
      const normalized = href.trim().startsWith("//") ? `https:${href.trim()}` : href.trim();
      url = new URL(normalized);
    } catch {
      return null;
    }
    if (!/^https?:$/i.test(url.protocol)) return null;
  
    for (const provider of EMBED_PROVIDERS) {
      if (provider.match(url)) {
        const info = provider.embed(url);
        if (info) return info;
      }
    }
    return null;
  }