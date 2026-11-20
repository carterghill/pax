import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Image as ImageIcon, Loader2, Plus, RefreshCw, Rss, Search, X } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import {
  listRssSubscriptions,
  searchRssFeeds,
  updateRssSubscription,
  type FeedSearchResult,
  type RoomFeedSubscriptions,
  type SubscriptionChange,
} from "../features/rss/api";
import { getRssPreviewImage } from "../features/chat/messages/rssPreview";
import Dialog from "./Dialog";
import "./RssFeedsDialog.css";

const subjects = [
  { label: "News", query: "#news" },
  { label: "Technology", query: "#tech" },
  { label: "Science", query: "#science" },
  { label: "Business", query: "#business" },
  { label: "Design", query: "#design" },
  { label: "Gaming", query: "#gaming" },
  { label: "Sports", query: "#sports" },
];

function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url : null;
  } catch {
    return null;
  }
}

function displayHost(value: string) {
  return webUrl(value)?.hostname.replace(/^www\./, "") || value;
}

function FeedArtwork({ imageUrl, iconUrl }: Pick<FeedSearchResult, "imageUrl" | "iconUrl">) {
  const ref = useRef<HTMLDivElement>(null);
  const [artwork, setArtwork] = useState<{ src: string; icon: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      const cover = imageUrl ? await getRssPreviewImage(imageUrl) : null;
      if (!active) return;
      if (cover) {
        setArtwork({ src: cover, icon: false });
      } else if (iconUrl && iconUrl !== imageUrl) {
        const icon = await getRssPreviewImage(iconUrl);
        if (active && icon) setArtwork({ src: icon, icon: true });
      }
    }
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return () => { active = false; };
    }
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [imageUrl, iconUrl]);

  return (
    <div aria-hidden="true" className="rss-feeds-artwork" ref={ref}>
      {artwork ? (
        <img alt="" src={artwork.src} className={artwork.icon ? "rss-feeds-artwork-icon" : undefined}
          onError={() => setArtwork(null)} />
      ) : <ImageIcon size={24} />}
    </div>
  );
}

type SearchRequest = { query: string; subject: string | null };

export default function RssFeedsDialog({ roomId, roomName, onClose }: {
  roomId: string;
  roomName: string;
  onClose: () => void;
}) {
  const { palette, typography } = useTheme();
  const [feeds, setFeeds] = useState<RoomFeedSubscriptions | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const listRequest = useRef<{ roomId: string; reload: number; promise: Promise<RoomFeedSubscriptions> } | null>(null);
  const [pending, setPending] = useState<SubscriptionChange | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchRequest>({ query: subjects[0].query, subject: subjects[0].label });
  const [results, setResults] = useState<FeedSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(true);
  const searchRequest = useRef<{ search: SearchRequest; promise: Promise<FeedSearchResult[]> } | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setListLoading(true);
    setListError(null);
    if (listRequest.current?.roomId !== roomId || listRequest.current.reload !== reload) {
      listRequest.current = { roomId, reload, promise: listRssSubscriptions(roomId) };
    }
    void listRequest.current.promise.then((next) => {
      if (active) setFeeds(next);
    }).catch((error) => {
      if (active) {
        setFeeds(null);
        setListError(String(error));
      }
    }).finally(() => {
      if (active) setListLoading(false);
    });
    return () => { active = false; };
  }, [roomId, reload]);

  useEffect(() => {
    let active = true;
    setSearchLoading(true);
    setSearchError(null);
    setResults([]);
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
    if (searchRequest.current?.search !== search) {
      searchRequest.current = { search, promise: searchRssFeeds(search.query) };
    }
    void searchRequest.current.promise.then((next) => {
      if (active) setResults(next);
    }).catch((error) => {
      if (active) setSearchError(String(error));
    }).finally(() => {
      if (active) setSearchLoading(false);
    });
    return () => { active = false; };
  }, [search]);

  const canChange = !!feeds?.canManage && !listError && !listLoading && !pending;
  const subscriptions = feeds?.subscriptions ?? [];
  const subscribedUrls = new Set(subscriptions.map((feed) => feed.url));
  const pastedUrl = webUrl(query.trim())?.href;

  async function changeSubscription(change: SubscriptionChange) {
    if (!feeds || !canChange) return;
    setPending(change);
    setUpdateError(null);
    setUpdateStatus("");
    try {
      const added = await updateRssSubscription(roomId, feeds.botUserId, change);
      setUpdateStatus(added ? `Added ${added.title}.` : "Feed removed.");
    } catch (error) {
      setUpdateError(String(error));
    }
    try {
      setFeeds(await listRssSubscriptions(roomId));
    } catch (error) {
      setFeeds(null);
      setListError(String(error));
    } finally {
      setPending(null);
    }
  }

  function refresh() {
    setUpdateError(null);
    setUpdateStatus("");
    setReload((value) => value + 1);
  }

  const style = {
    "--rss-bg": palette.bgSecondary,
    "--rss-surface": palette.bgPrimary,
    "--rss-inset": palette.bgTertiary,
    "--rss-hover": palette.bgHover,
    "--rss-text": palette.textPrimary,
    "--rss-muted": palette.textSecondary,
    "--rss-title": palette.textHeading,
    "--rss-accent": palette.accent,
    "--rss-border": palette.border,
    "--rss-font-small": `${typography.fontSizeSmall}px`,
    "--rss-font-base": `${typography.fontSizeBase}px`,
  } as CSSProperties;

  return (
    <Dialog className="rss-feeds-dialog" style={{ ...style, overflow: "hidden" }}
      aria-labelledby="pax-rss-feeds-title" onClose={onClose}>
      <header className="rss-feeds-header">
        <div className="rss-feeds-header-icon"><Rss size={20} aria-hidden="true" /></div>
        <div className="rss-feeds-header-text">
          <h2 id="pax-rss-feeds-title">RSS feeds</h2>
          <span title={roomName}>{roomName}</span>
        </div>
        <button type="button" className="rss-feeds-icon-button" aria-label="Close RSS feeds" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="rss-feeds-columns">
        <aside className="rss-feeds-subscribed" aria-label="Subscribed feeds">
          <div className="rss-feeds-section-heading">
            <h3>Subscribed</h3>
            {feeds && <span className="rss-feeds-count" title={`${subscriptions.length} subscribed`}>{subscriptions.length}</span>}
            <button type="button" className="rss-feeds-icon-button" aria-label="Refresh subscriptions"
              title="Refresh subscriptions" onClick={refresh} disabled={listLoading || !!pending}>
              <RefreshCw size={15} aria-hidden="true" className={listLoading ? "rss-feeds-spin" : undefined} />
            </button>
          </div>
          <div className="rss-feeds-subscription-scroll">
            {listLoading && !feeds && <p className="rss-feeds-message" role="status">Checking with the RSS bot…</p>}
            {listError && <p className="rss-feeds-message" role="alert">{listError}</p>}
            {feeds && !feeds.canManage && <p className="rss-feeds-message">Room permission is required to change subscriptions.</p>}
            {feeds && !listError && !subscriptions.length && <p className="rss-feeds-message">This room has no subscriptions.</p>}
            <ul className="rss-feeds-subscriptions">
              {subscriptions.map((feed) => (
                <li key={feed.id}>
                  <Rss size={15} className="rss-feeds-subscription-icon" aria-hidden="true" />
                  <div className="rss-feeds-subscription-name">
                    <strong title={feed.title}>{feed.title}</strong>
                    <span title={feed.url}>{displayHost(feed.url)}</span>
                  </div>
                  {feeds?.canManage && (
                    <button type="button" className="rss-feeds-icon-button" title={`Remove ${feed.title}`}
                      aria-label={`Remove ${feed.title}`} disabled={!canChange}
                      onClick={() => void changeSubscription({ kind: "unsubscribe", id: feed.id })}>
                      {pending?.kind === "unsubscribe" && pending.id === feed.id
                        ? <Loader2 size={15} className="rss-feeds-spin" aria-hidden="true" />
                        : <X size={15} aria-hidden="true" />}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {feeds && <div className="rss-feeds-bot" title={feeds.botUserId}>{feeds.botUserId}</div>}
        </aside>
        <section className="rss-feeds-discover" aria-label="Discover feeds">
          <form className="rss-feeds-search" onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) setSearch({ query: query.trim(), subject: null });
          }}>
            <label className="rss-feeds-search-field">
              <Search size={18} aria-hidden="true" />
              <input type="search" aria-label="Search RSS feeds" placeholder="Search by publisher, topic, or website"
                value={query} onChange={(event) => setQuery(event.target.value)}
                maxLength={512} spellCheck={false} autoCapitalize="off" />
            </label>
            <button className="rss-feeds-button rss-feeds-primary" type="submit" disabled={!query.trim()}>Search</button>
            {pastedUrl && (
              <button type="button" className="rss-feeds-button" disabled={!canChange || subscribedUrls.has(pastedUrl)}
                onClick={() => void changeSubscription({ kind: "subscribe", url: pastedUrl })}>
                {subscribedUrls.has(pastedUrl) ? "Subscribed" : pending?.kind === "subscribe" && pending.url === pastedUrl ? "Adding…" : "Add URL"}
              </button>
            )}
          </form>
          <div className="rss-feeds-subjects" role="group" aria-label="Browse by subject">
            {subjects.map((subject) => (
              <button key={subject.label} type="button" className="rss-feeds-subject"
                aria-pressed={search.subject === subject.label}
                onClick={() => {
                  setQuery("");
                  if (search.subject !== subject.label || searchError) {
                    setSearch({ query: subject.query, subject: subject.label });
                  }
                }}>
                {subject.label}
              </button>
            ))}
          </div>
          {(updateError || updateStatus) && (
            <p className="rss-feeds-update" role={updateError ? "alert" : "status"}>{updateError || updateStatus}</p>
          )}
          <div className="rss-feeds-results" ref={resultsRef} aria-busy={searchLoading}>
            {searchLoading && <p className="rss-feeds-message" role="status">Finding feeds…</p>}
            {searchError && (
              <div className="rss-feeds-message" role="alert">
                <p>{searchError}</p>
                <button className="rss-feeds-button" type="button" onClick={() => setSearch({ ...search })}>Retry search</button>
              </div>
            )}
            {!searchLoading && !searchError && (
              results.length ? (
                <ul className="rss-feeds-results-grid" aria-label="Feedly search results">
                  {results.map((feed, index) => {
                    const subscribed = subscribedUrls.has(feed.url);
                    const adding = pending?.kind === "subscribe" && pending.url === feed.url;
                    return (
                      <li key={`${feed.url}-${index}`} className="rss-feeds-result">
                        <FeedArtwork imageUrl={feed.imageUrl} iconUrl={feed.iconUrl} />
                        <div className="rss-feeds-result-details">
                          <h4 title={feed.title}>{feed.title}</h4>
                          <span className="rss-feeds-result-host" title={feed.url}>{displayHost(feed.website || feed.url)}</span>
                          {feed.description && <p title={feed.description}>{feed.description}</p>}
                          <button type="button" className="rss-feeds-button rss-feeds-add"
                            aria-label={subscribed ? `Subscribed to ${feed.title}` : `Add ${feed.title}`}
                            disabled={!canChange || subscribed} onClick={() => void changeSubscription({ kind: "subscribe", url: feed.url })}>
                            {subscribed ? <Check size={15} aria-hidden="true" /> : adding
                              ? <Loader2 size={15} aria-hidden="true" className="rss-feeds-spin" />
                              : <Plus size={15} aria-hidden="true" />}
                            {subscribed ? "Subscribed" : adding ? "Adding…" : "Add"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="rss-feeds-message" role="status">No feeds found. Try another search or paste an RSS feed URL.</p>
            )}
          </div>
          <footer className="rss-feeds-search-source">Feed discovery by Feedly</footer>
        </section>
      </div>
    </Dialog>
  );
}
