import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, Users, Check, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { PublicSpaceResult } from "./CreateSpaceDialog";
import { spaceInitialAvatarBackground } from "../utils/userAvatarColor";

type FilterMode = "both" | "spaces" | "rooms";
type DiscoverEntry = PublicSpaceResult & { _isSpace: boolean };

function DiscoverCard({
  entry,
  joiningId,
  joinSuccess,
  onJoin,
}: {
  entry: DiscoverEntry;
  joiningId: string | null;
  joinSuccess: string | null;
  onJoin: (entry: DiscoverEntry) => void;
}) {
  const { palette, typography, resolvedColorScheme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const isJoined = entry.membership === "joined" || joinSuccess === entry.room_id;
  const isKnocked = entry.membership === "knocked";
  const isJoining = joiningId === entry.room_id;
  const isKnock = entry.join_rule === "knock";
  const hasLongTopic = !!entry.topic;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => hasLongTopic && setExpanded((p) => !p)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 16px",
        borderRadius: 8,
        backgroundColor: hovered ? palette.bgHover : "transparent",
        border: `1px solid ${palette.border}`,
        cursor: hasLongTopic ? "pointer" : "default",
        transition: "background-color 0.1s",
      }}
    >
      {/* Avatar */}
      {entry.avatar_url && !imageFailed ? (
        <img
          src={entry.avatar_url}
          alt={entry.name || entry.room_id}
          onError={() => setImageFailed(true)}
          style={{
            width: 48,
            height: 48,
            borderRadius: entry._isSpace ? 14 : 24,
            objectFit: "cover",
            flexShrink: 0,
            marginTop: 1,
          }}
        />
      ) : (
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: entry._isSpace ? 14 : 24,
            backgroundColor: spaceInitialAvatarBackground(entry.room_id, resolvedColorScheme),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 18,
            fontWeight: 600,
            color: "#fff",
            marginTop: 1,
          }}
        >
          {(entry.name || "?")
            .split(" ")
            .map((w) => w[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
      )}

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: typography.fontSizeBase,
              fontWeight: typography.fontWeightMedium,
              color: palette.textHeading,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.name || entry.room_id}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: typography.fontWeightMedium,
              color: palette.textSecondary,
              backgroundColor: palette.bgActive,
              padding: "1px 6px",
              borderRadius: 4,
              flexShrink: 0,
              lineHeight: "16px",
            }}
          >
            {entry._isSpace ? "Space" : "Room"}
          </span>
        </div>

        {entry.topic && (
          <div
            style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              marginTop: 3,
              overflow: expanded ? undefined : "hidden",
              display: expanded ? undefined : "-webkit-box",
              WebkitLineClamp: expanded ? undefined : (2 as unknown as string),
              WebkitBoxOrient: expanded ? undefined : ("vertical" as const),
              lineHeight: 1.45,
            }}
          >
            {entry.topic}
          </div>
        )}

        <div
          style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginTop: 5,
          }}
        >
          <Users size={11} />
          {(entry.num_joined_members ?? 0).toLocaleString()} member
          {(entry.num_joined_members ?? 0) !== 1 ? "s" : ""}
          {entry.canonical_alias && (
            <span style={{ marginLeft: 4, opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {entry.canonical_alias}
            </span>
          )}
        </div>
      </div>

      {/* Join action */}
      <div
        style={{ flexShrink: 0, alignSelf: "center", marginLeft: 4 }}
        onClick={(e) => e.stopPropagation()}
      >
        {isJoined && !isKnock ? (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: typography.fontSizeSmall,
              color: "#23a55a",
              whiteSpace: "nowrap",
            }}
          >
            <Check size={14} />
            Joined
          </span>
        ) : isKnocked ? (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              whiteSpace: "nowrap",
            }}
          >
            <Check size={14} />
            Requested
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onJoin(entry)}
            disabled={isJoining}
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              border: isKnock ? `1px solid ${palette.border}` : "none",
              backgroundColor: isKnock ? "transparent" : palette.accent,
              color: isKnock ? palette.textPrimary : "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              cursor: isJoining ? "not-allowed" : "pointer",
              opacity: isJoining ? 0.6 : 1,
              whiteSpace: "nowrap",
              fontFamily: typography.fontFamily,
              transition: "opacity 0.1s",
            }}
          >
            {isJoining ? "…" : isKnock ? "Request" : "Join"}
          </button>
        )}
      </div>
    </div>
  );
}

interface DiscoverViewProps {
  server: string | null;
  discoverServers: string[];
  onJoined: (payload?: { joinedRoomId?: string }) => void | Promise<void>;
}

export default function DiscoverView({ server, discoverServers, onJoined }: DiscoverViewProps) {
  const { palette, spacing, typography } = useTheme();
  const [searchTerm, setSearchTerm] = useState("");
  const [filter, setFilter] = useState<FilterMode>("both");
  const [spaceEntries, setSpaceEntries] = useState<DiscoverEntry[]>([]);
  const [roomEntries, setRoomEntries] = useState<DiscoverEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState<string | null>(null);
  const abortRef = useRef(0);

  const servers = server ? [server] : discoverServers;

  const doSearch = useCallback(
    async (term: string) => {
      const ticket = ++abortRef.current;
      setLoading(true);
      setError(null);
      const termValue = term.trim() || null;

      try {
        const [spaceSettled, roomSettled] = await Promise.all([
          Promise.allSettled(
            servers.map((s) =>
              invoke<{ chunk: PublicSpaceResult[] }>("search_public_spaces", {
                searchTerm: termValue,
                server: s,
                limit: 30,
              })
            )
          ),
          Promise.allSettled(
            servers.map((s) =>
              invoke<{ chunk: PublicSpaceResult[] }>("search_public_rooms", {
                searchTerm: termValue,
                server: s,
                limit: 30,
              })
            )
          ),
        ]);

        if (ticket !== abortRef.current) return;

        const spaceById = new Map<string, DiscoverEntry>();
        for (const r of spaceSettled) {
          if (r.status === "fulfilled") {
            for (const item of r.value.chunk || []) {
              if (!spaceById.has(item.room_id)) {
                spaceById.set(item.room_id, { ...item, _isSpace: true });
              }
            }
          }
        }

        const roomById = new Map<string, DiscoverEntry>();
        for (const r of roomSettled) {
          if (r.status === "fulfilled") {
            for (const item of r.value.chunk || []) {
              // Skip if already found as a space
              if (!spaceById.has(item.room_id) && !roomById.has(item.room_id)) {
                roomById.set(item.room_id, { ...item, _isSpace: false });
              }
            }
          }
        }

        const sortByMembers = (a: DiscoverEntry, b: DiscoverEntry) =>
          (b.num_joined_members ?? 0) - (a.num_joined_members ?? 0);

        setSpaceEntries(Array.from(spaceById.values()).sort(sortByMembers));
        setRoomEntries(Array.from(roomById.values()).sort(sortByMembers));
      } catch (e) {
        if (ticket === abortRef.current) setError(String(e));
      } finally {
        if (ticket === abortRef.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, discoverServers]
  );

  // Re-search when server selection changes
  useEffect(() => {
    doSearch(searchTerm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, discoverServers]);

  const handleSearch = useCallback(() => {
    doSearch(searchTerm);
  }, [doSearch, searchTerm]);

  const handleJoin = useCallback(
    async (entry: DiscoverEntry) => {
      const roomId = entry.room_id;
      const joinTarget = entry.canonical_alias || roomId;
      const viaServers = Array.from(
        new Set(
          [
            ...servers,
            entry.canonical_alias ? entry.canonical_alias.split(":")[1] : null,
            roomId.split(":")[1],
          ].filter((s): s is string => !!s)
        )
      );

      setJoiningId(roomId);
      setError(null);
      try {
        const isKnock = entry.join_rule === "knock";
        let joinedRoomId: string;
        if (isKnock) {
          joinedRoomId = await invoke<string>("knock_room", { roomId: joinTarget, viaServers });
        } else {
          joinedRoomId = await invoke<string>("join_room", { roomId: joinTarget, viaServers });
        }
        setJoinSuccess(roomId);
        const update = (prev: DiscoverEntry[]) =>
          prev.map((e) =>
            e.room_id === roomId ? { ...e, membership: isKnock ? "knocked" : "joined" } : e
          );
        setSpaceEntries(update);
        setRoomEntries(update);
        if (!isKnock) {
          await onJoined({ joinedRoomId });
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setJoiningId(null);
      }
    },
    [servers, onJoined]
  );

  const displayedEntries: DiscoverEntry[] =
    filter === "spaces"
      ? spaceEntries
      : filter === "rooms"
        ? roomEntries
        : (() => {
            const allById = new Map<string, DiscoverEntry>();
            for (const e of [...spaceEntries, ...roomEntries]) {
              allById.set(e.room_id, e);
            }
            return Array.from(allById.values()).sort(
              (a, b) => (b.num_joined_members ?? 0) - (a.num_joined_members ?? 0)
            );
          })();

  const filterBtnStyle = (active: boolean) => ({
    padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
    borderRadius: 6,
    border: "none",
    backgroundColor: active ? palette.bgActive : "transparent",
    color: active ? palette.textHeading : palette.textSecondary,
    fontSize: typography.fontSizeSmall,
    fontWeight: active ? typography.fontWeightMedium : typography.fontWeightNormal,
    cursor: "pointer",
    fontFamily: typography.fontFamily,
    transition: "background-color 0.1s, color 0.1s",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: palette.bgPrimary,
        color: palette.textPrimary,
      }}
    >
      {/* Search header */}
      <div
        style={{
          padding: `${spacing.unit * 3}px ${spacing.unit * 4}px ${spacing.unit * 2}px`,
          borderBottom: `1px solid ${palette.border}`,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: spacing.unit * 2,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: typography.fontSizeLarge,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
          }}
        >
          Discover
        </h1>

        <div style={{ display: "flex", gap: spacing.unit * 2, alignItems: "center" }}>
          {/* Search input */}
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: spacing.unit * 1.5,
              backgroundColor: palette.bgSecondary,
              borderRadius: 8,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
              border: `1px solid ${palette.border}`,
            }}
          >
            <Search size={15} color={palette.textSecondary} style={{ flexShrink: 0 }} />
            <input
              type="text"
              placeholder="Search spaces and rooms…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch();
              }}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                outline: "none",
                color: palette.textPrimary,
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
              }}
            />
            {loading && <Loader2 size={14} color={palette.textSecondary} style={{ flexShrink: 0, animation: "spin 1s linear infinite" }} />}
          </div>

          <button
            type="button"
            onClick={handleSearch}
            disabled={loading}
            style={{
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: 8,
              border: "none",
              backgroundColor: palette.accent,
              color: "#fff",
              fontSize: typography.fontSizeBase,
              fontWeight: typography.fontWeightMedium,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
              fontFamily: typography.fontFamily,
              whiteSpace: "nowrap",
            }}
          >
            Search
          </button>
        </div>

        {/* Filter toggle */}
        <div style={{ display: "flex", gap: spacing.unit, alignItems: "center" }}>
          <button type="button" style={filterBtnStyle(filter === "both")} onClick={() => setFilter("both")}>
            All
          </button>
          <button type="button" style={filterBtnStyle(filter === "spaces")} onClick={() => setFilter("spaces")}>
            Spaces
          </button>
          <button type="button" style={filterBtnStyle(filter === "rooms")} onClick={() => setFilter("rooms")}>
            Rooms
          </button>
          {server && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
              }}
            >
              {server}
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
          display: "flex",
          flexDirection: "column",
          gap: spacing.unit,
        }}
      >
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

        {error && (
          <div
            style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              borderRadius: 6,
              backgroundColor: "rgba(243,59,59,0.1)",
              color: "#f33b3b",
              fontSize: typography.fontSizeSmall,
              marginBottom: spacing.unit,
            }}
          >
            {error}
          </div>
        )}

        {!loading && displayedEntries.length === 0 && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: palette.textSecondary,
              fontSize: typography.fontSizeBase,
              paddingTop: spacing.unit * 8,
            }}
          >
            No results
          </div>
        )}

        {displayedEntries.map((entry) => (
          <DiscoverCard
            key={entry.room_id}
            entry={entry}
            joiningId={joiningId}
            joinSuccess={joinSuccess}
            onJoin={handleJoin}
          />
        ))}
      </div>
    </div>
  );
}
