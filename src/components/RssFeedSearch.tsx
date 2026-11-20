import { useId, useRef, useState, type CSSProperties } from "react";
import { Search } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { searchRssFeeds, type FeedSearchResult } from "../features/rss/api";

type SearchState =
  | { status: "loading" }
  | { status: "done"; results: FeedSearchResult[] }
  | { status: "error"; message: string };

export default function RssFeedSearch({ disabled, onAdd }: {
  disabled?: boolean;
  onAdd: (url: string) => void;
}) {
  const { palette, typography } = useTheme();
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const requestId = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState | null>(null);
  const term = query.trim();
  const searching = search?.status === "loading";

  async function findFeeds() {
    if (disabled || !term || searching) return;
    const id = ++requestId.current;
    setSearch({ status: "loading" });
    try {
      const results = await searchRssFeeds(term);
      if (id === requestId.current) setSearch({ status: "done", results });
    } catch (error) {
      if (id !== requestId.current) return;
      const message = typeof error === "string" ? error : "Could not search Feedly.";
      setSearch({ status: "error", message });
    }
  }

  function addFeed(url: string) {
    onAdd(url);
    setOpen(false);
    toggleRef.current?.focus();
  }

  const controlStyle: CSSProperties = {
    border: `1px solid ${palette.border}`,
    borderRadius: 4,
    background: palette.bgTertiary,
    color: palette.textPrimary,
    padding: "6px 9px",
    font: "inherit",
  };
  const buttonStyle: CSSProperties = { ...controlStyle, cursor: "pointer", flexShrink: 0 };
  const secondaryText: CSSProperties = { color: palette.textSecondary, overflowWrap: "anywhere" };
  const canSearch = !disabled && !!term && !searching;

  return (
    <div style={{ marginTop: 8, fontSize: typography.fontSizeSmall }}>
      <button
        ref={toggleRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Search size={14} aria-hidden="true" />
        Find a feed
      </button>
      <div id={panelId} hidden={!open}>
        {open && (
          <>
            <div style={{ display: "flex", gap: 6, margin: "8px 0 6px" }}>
              <input
                type="search"
                aria-label="Search RSS feeds on Feedly"
                placeholder="Publisher, topic, or website URL"
                value={query}
                maxLength={512}
                spellCheck={false}
                autoCapitalize="off"
                autoFocus
                disabled={disabled}
                onChange={(event) => {
                  requestId.current += 1;
                  setQuery(event.target.value);
                  setSearch(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void findFeeds();
                  }
                }}
                style={{ ...controlStyle, flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                disabled={!canSearch}
                onClick={() => void findFeeds()}
                style={{ ...buttonStyle, opacity: canSearch ? 1 : 0.55 }}
              >
                Search
              </button>
            </div>
            {searching && <div role="status" style={secondaryText}>Searching Feedly…</div>}
            {search?.status === "error" && <div role="alert">{search.message}</div>}
            {search?.status === "done" && (search.results.length === 0 ? (
              <div role="status" style={secondaryText}>No feeds found on Feedly.</div>
            ) : (
              <ul
                aria-label="Feedly search results"
                style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 240, overflowY: "auto" }}
              >
                {search.results.map((result, index) => (
                  <li
                    key={`${result.url}-${index}`}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                      borderTop: `1px solid ${palette.border}`, padding: "8px 0",
                    }}
                  >
                    <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      <div style={{ color: palette.textHeading, fontWeight: typography.fontWeightMedium }}>
                        {result.title}
                      </div>
                      <div style={secondaryText}>{result.url}</div>
                      {result.description && <div style={{
                        ...secondaryText, display: "-webkit-box", WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical", overflow: "hidden",
                      }}>
                        {result.description}
                      </div>}
                    </div>
                    <button
                      type="button"
                      aria-label={`Add ${result.title}`}
                      disabled={disabled}
                      onClick={() => addFeed(result.url)}
                      style={buttonStyle}
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
