import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Plus,
  Loader2,
  Hash,
  Volume2,
  Rss,
  Users,
  Globe,
  Lock,
  Search,
  LogIn,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogShellBorderStyle } from "../theme/paletteBorder";
import Dialog from "./Dialog";
import { VOICE_ROOM_TYPE } from "../utils/matrix";
import type { Room } from "../types/matrix";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import { SpaceSearchRow, type PublicSpaceResult } from "./CreateSpaceDialog";

function extractMatrixServerName(identifier?: string | null): string | null {
  if (!identifier) return null;
  const idx = identifier.lastIndexOf(":");
  if (idx === -1 || idx === identifier.length - 1) return null;
  return identifier.slice(idx + 1);
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => !!value?.trim())));
}

function parseServerInputs(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
}

function mergePublicRoomResults(results: PublicSpaceResult[][]): PublicSpaceResult[] {
  const byId = new Map<string, PublicSpaceResult>();

  for (const group of results) {
    for (const room of group) {
      const existing = byId.get(room.room_id);
      if (!existing) {
        byId.set(room.room_id, room);
        continue;
      }

      byId.set(room.room_id, {
        ...existing,
        ...room,
        name: existing.name || room.name,
        topic: existing.topic || room.topic,
        avatar_url: existing.avatar_url || room.avatar_url,
        canonical_alias: existing.canonical_alias || room.canonical_alias,
        room_type: existing.room_type || room.room_type,
        num_joined_members: existing.num_joined_members ?? room.num_joined_members,
        membership:
          existing.membership === "joined" || room.membership === "joined"
            ? "joined"
            : existing.membership === "invited" || room.membership === "invited"
              ? "invited"
              : existing.membership || room.membership,
      });
    }
  }

  return Array.from(byId.values());
}

function buildDefaultSearchServers(currentHomeserver: string | null): string[] {
  return uniqueNonEmpty([
    "matrix.org",
    currentHomeserver,
    "tchncs.de",
    "4d2.org",
    "nope.chat",
  ]);
}

function buildOptimisticJoinedChatRoom(
  roomId: string,
  name: string,
  roomType: string | null | undefined
): Room {
  return {
    id: roomId,
    name,
    avatarUrl: null,
    isSpace: false,
    parentSpaceIds: [],
    roomType: roomType ?? null,
    membership: "joined",
  };
}

type RoomKind = "text" | "voice" | "rss";
type HistoryVisibility = "shared" | "joined" | "invited" | "world_readable";
type SpaceRoomAccess = "space_members" | "public" | "invite";

interface CreateRoomDialogProps {
  /** Parent space when creating a channel in a space; `null` for global Home (standalone room). */
  spaceId: string | null;
  onClose: () => void;
  onCreated: (payload?: RoomsChangedPayload) => void | Promise<void>;
  /**
   * Permission to create in a space (e.g. `can_manage_space_children`). When `spaceId` is null,
   * this is ignored — the dialog uses `can_create_rooms` from the server instead.
   */
  canCreate?: boolean;
}

export default function CreateRoomDialog({
  spaceId,
  onClose,
  onCreated,
  canCreate = true,
}: CreateRoomDialogProps) {
  const [canCreateGlobally, setCanCreateGlobally] = useState(true);
  useEffect(() => {
    if (spaceId !== null) return;
    invoke<boolean>("can_create_rooms")
      .then(setCanCreateGlobally)
      .catch(() => setCanCreateGlobally(true));
  }, [spaceId]);

  const allowCreate =
    spaceId !== null ? !!spaceId && canCreate : canCreateGlobally;

  const isStandaloneHome = spaceId === null;
  const { palette, typography, resolvedColorScheme } = useTheme();

  const [activeTab, setActiveTab] = useState<"join" | "create">("join");

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [roomKind, setRoomKind] = useState<RoomKind>("text");
  const [feedUrl, setFeedUrl] = useState("");
  const [feedBot, setFeedBot] = useState("@rss:t2bot.io");
  const [pendingRoom, setPendingRoom] = useState<{ room: Room; topic: string | null } | null>(null);
  const creatingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const [roomAccess, setRoomAccess] = useState<SpaceRoomAccess>("space_members");
  const [historyVisibility, setHistoryVisibility] =
    useState<HistoryVisibility>("shared");
  const [roomAlias, setRoomAlias] = useState("");
  const [federate, setFederate] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchServer, setSearchServer] = useState("");
  const [searchResults, setSearchResults] = useState<PublicSpaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [joinAddress, setJoinAddress] = useState("");
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState<string | null>(null);
  const [currentHomeserver, setCurrentHomeserver] = useState<string | null>(null);
  const [homeserverBrowseLoading, setHomeserverBrowseLoading] = useState(false);
  const [homeserverBrowseDone, setHomeserverBrowseDone] = useState(false);

  const homeserverPublicListFetchedRef = useRef(false);
  const homeserverAutoStaleRef = useRef(false);

  useEffect(() => {
    invoke<string>("current_homeserver")
      .then(setCurrentHomeserver)
      .catch(() => setCurrentHomeserver(null));
  }, []);

  useEffect(() => {
    if (activeTab !== "join" || !currentHomeserver || homeserverPublicListFetchedRef.current) {
      return;
    }

    let cancelled = false;
    setHomeserverBrowseLoading(true);

    (async () => {
      try {
        const result = await invoke<{ chunk: PublicSpaceResult[] }>("search_public_rooms", {
          searchTerm: null,
          server: currentHomeserver,
          limit: 20,
        });
        if (!cancelled && !homeserverAutoStaleRef.current) {
          setSearchResults(result.chunk || []);
        }
      } catch {
        if (!cancelled && !homeserverAutoStaleRef.current) {
          setSearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setHomeserverBrowseLoading(false);
          setHomeserverBrowseDone(true);
          homeserverPublicListFetchedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
      setHomeserverBrowseLoading(false);
    };
  }, [activeTab, currentHomeserver]);

  const searchServers = useMemo(() => {
    const explicitServers = parseServerInputs(searchServer);
    if (explicitServers.length > 0) return explicitServers;
    return buildDefaultSearchServers(currentHomeserver);
  }, [searchServer, currentHomeserver]);

  const handleCreate = useCallback(async () => {
    if (creatingRef.current) return;
    if (!pendingRoom && !name.trim()) {
      setError("Room name is required.");
      return;
    }
    if (!pendingRoom && roomKind === "rss") {
      try {
        const url = new URL(feedUrl.trim());
        if (!/^https?:$/.test(url.protocol) || !url.hostname || /\s/.test(feedUrl.trim())) {
          throw new Error("Enter a valid feed URL starting with https:// or http://.");
        }
        if (url.username || url.password) {
          throw new Error("Feed URLs cannot contain a username or password.");
        }
      } catch (e) {
        setError(e instanceof TypeError
          ? "Enter a valid feed URL starting with https:// or http://."
          : String(e).replace(/^Error: /, ""));
        return;
      }
      if (!/^@[^\s:]+:[^\s]+$/.test(feedBot.trim())) {
        setError("Enter a Matrix bot address such as @rss:t2bot.io.");
        return;
      }
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);

    let created = pendingRoom;
    try {
      if (!created) {
        const roomType = roomKind === "voice" ? VOICE_ROOM_TYPE : null;
        const trimmedName = name.trim();
        const trimmedTopic = topic.trim() || null;
        const aliasLocal = roomAlias.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
        const roomId = await invoke<string>(spaceId ? "create_room_in_space" : "create_standalone_room", {
          ...(spaceId ? { spaceId, spaceRoomAccess: roomAccess } : { roomAccess }),
          name: trimmedName,
          topic: trimmedTopic,
          roomType,
          roomAlias: aliasLocal || null,
          historyVisibility,
          federate,
          rssFeed: roomKind === "rss" ? { url: feedUrl.trim(), botUserId: feedBot.trim() } : null,
        });
        created = {
          room: {
            id: roomId,
            name: trimmedName,
            avatarUrl: null,
            isSpace: false,
            parentSpaceIds: spaceId ? [spaceId] : [],
            roomType,
            isRss: roomKind === "rss",
            membership: "joined",
          },
          topic: trimmedTopic,
        };
        setPendingRoom(created);
      }
      onClose();
      await onCreated({
        optimisticRoom: created.room,
        newSpaceChildTopic: created.topic,
        openRoomId: created.room.isRss ? created.room.id : undefined,
      });
    } catch (e) {
      setError(created ? `The room was created, but could not be opened. ${String(e)}` : String(e));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [
    name,
    topic,
    roomKind,
    feedUrl,
    feedBot,
    pendingRoom,
    roomAccess,
    historyVisibility,
    roomAlias,
    federate,
    spaceId,
    onCreated,
    onClose,
  ]);

  const handleClose = useCallback(async () => {
    if (creatingRef.current) return;
    if (pendingRoom) {
      await onCreated({ optimisticRoom: pendingRoom.room, newSpaceChildTopic: pendingRoom.topic, openRoomId: pendingRoom.room.id });
    }
    onClose();
  }, [pendingRoom, onCreated, onClose]);

  const handleSearch = useCallback(async () => {
    homeserverAutoStaleRef.current = true;
    setSearching(true);
    setSearchError(null);
    setHasSearched(true);
    setJoinSuccess(null);

    try {
      const searchTermValue = searchTerm.trim() || null;

      if (searchServers.length <= 1) {
        const result = await invoke<{ chunk: PublicSpaceResult[] }>("search_public_rooms", {
          searchTerm: searchTermValue,
          server: searchServers[0] || null,
          limit: 20,
        });
        setSearchResults(result.chunk || []);
        return;
      }

      const settled = await Promise.allSettled(
        searchServers.map((server) =>
          invoke<{ chunk: PublicSpaceResult[] }>("search_public_rooms", {
            searchTerm: searchTermValue,
            server,
            limit: 20,
          })
        )
      );

      const successfulResults = settled
        .filter(
          (
            result
          ): result is PromiseFulfilledResult<{ chunk: PublicSpaceResult[] }> =>
            result.status === "fulfilled"
        )
        .map((result) => result.value.chunk || []);

      const failedResults = settled
        .map((result, index) => ({ result, server: searchServers[index] }))
        .filter(
          (
            entry
          ): entry is {
            result: PromiseRejectedResult;
            server: string;
          } => entry.result.status === "rejected"
        );

      if (successfulResults.length === 0) {
        throw new Error(
          failedResults
            .map(({ server, result }) => `${server}: ${String(result.reason)}`)
            .join(" | ")
        );
      }

      setSearchResults(mergePublicRoomResults(successfulResults));

      if (failedResults.length > 0) {
        setSearchError(
          `Some servers failed: ${failedResults
            .map(({ server, result }) => `${server}: ${String(result.reason)}`)
            .join(" | ")}`
        );
      } else {
        setSearchError(null);
      }
    } catch (e) {
      setSearchError(String(e));
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchServers, searchTerm]);

  const handleJoinRoom = useCallback(
    async (entry: PublicSpaceResult) => {
      const roomId = entry.room_id;
      const joinTarget = entry.canonical_alias || roomId;
      const viaServers = uniqueNonEmpty([
        ...searchServers,
        extractMatrixServerName(entry.canonical_alias),
        extractMatrixServerName(roomId),
      ]);

      setJoiningId(roomId);
      setJoinSuccess(null);
      try {
        const isKnock = entry.join_rule === "knock";
        let joinedRoomId: string;

        if (isKnock) {
          joinedRoomId = await invoke<string>("knock_room", {
            roomId: joinTarget,
            viaServers: viaServers.length > 0 ? viaServers : null,
          });
        } else {
          joinedRoomId = await invoke<string>("join_room", {
            roomId: joinTarget,
            viaServers: viaServers.length > 0 ? viaServers : null,
          });
        }

        setJoinSuccess(roomId);
        if (!isKnock) {
          await onCreated({
            joinedRoomId,
            optimisticRoom: buildOptimisticJoinedChatRoom(
              joinedRoomId,
              entry.name || entry.canonical_alias || joinedRoomId,
              entry.room_type
            ),
          });
        }
        setSearchResults((prev) =>
          prev.map((r) =>
            r.room_id === roomId
              ? { ...r, membership: isKnock ? "knocked" : "joined" }
              : r
          )
        );
      } catch (e) {
        setSearchError(`Failed to ${entry.join_rule === "knock" ? "request to join" : "join"}: ${e}`);
      } finally {
        setJoiningId(null);
      }
    },
    [onCreated, searchServers]
  );

  const handleJoinByAddress = useCallback(async () => {
    const addr = joinAddress.trim();
    if (!addr) return;
    if (addr.startsWith("#") && !addr.includes(":")) {
      setSearchError("Room aliases must look like #name:server.com");
      return;
    }
    if (addr.startsWith("!") && !addr.includes(":")) {
      setSearchError("Room IDs must look like !opaqueid:server.com");
      return;
    }
    setSearchError(null);
    setJoinSuccess(null);
    setJoiningId(addr);

    try {
      const viaServers = uniqueNonEmpty([
        ...parseServerInputs(searchServer),
        extractMatrixServerName(addr),
      ]);
      const joinedRoomId = await invoke<string>("join_room", {
        roomId: addr,
        viaServers: viaServers.length > 0 ? viaServers : null,
      });
      setJoinAddress("");
      setJoinSuccess(addr);
      await onCreated({ joinedRoomId });
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setJoiningId(null);
    }
  }, [joinAddress, onCreated, searchServer]);

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    color: palette.textSecondary,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    fontSize: typography.fontSizeBase,
    fontFamily: typography.fontFamily,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 4,
    color: palette.textPrimary,
    outline: "none",
    boxSizing: "border-box",
  };

  const showJoinOnly = !allowCreate;
  const createDisabled = creating || (!pendingRoom && (
    !name.trim() || (roomKind === "rss" && (!feedUrl.trim() || !feedBot.trim()))
  ));

  return (
    <Dialog
      onClose={() => { void handleClose().catch((e) => setError(String(e))); }}
      aria-label="Join or create a room"
      style={{
        backgroundColor: palette.bgSecondary,
        borderRadius: 8,
        width: 500,
        maxHeight: "85vh",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        ...paletteDialogShellBorderStyle(palette),
      }}
    >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 16px 0 16px",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
            }}
          >
            {allowCreate ? "Add a Room" : "Join a Room"}
          </h2>
          <button
            onClick={() => { void handleClose().catch((e) => setError(String(e))); }}
            disabled={creating}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              display: "flex",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {allowCreate && (
          <div
            style={{
              display: "flex",
              gap: 0,
              padding: "12px 16px 0 16px",
              borderBottom: `1px solid ${palette.border}`,
              flexShrink: 0,
            }}
          >
            {(["join", "create"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                disabled={creating || !!pendingRoom}
                onClick={() => {
                  setActiveTab(tab);
                  setError(null);
                  setSearchError(null);
                }}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom:
                    activeTab === tab
                      ? `2px solid ${palette.accent}`
                      : "2px solid transparent",
                  color:
                    activeTab === tab
                      ? palette.textPrimary
                      : palette.textSecondary,
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightMedium,
                  fontFamily: typography.fontFamily,
                  padding: "8px 16px",
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                  textTransform: "capitalize",
                }}
              >
                {tab}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {(showJoinOnly || activeTab === "join") && (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ flex: 1, position: "relative" }}>
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSearch();
                      }}
                      placeholder="Search public rooms..."
                      style={{ ...inputStyle, paddingRight: 36 }}
                      autoFocus
                    />
                    <Search
                      size={16}
                      color={palette.textSecondary}
                      style={{
                        position: "absolute",
                        right: 10,
                        top: "50%",
                        transform: "translateY(-50%)",
                        opacity: 0.5,
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleSearch}
                    disabled={searching}
                    style={{
                      padding: "8px 16px",
                      fontSize: typography.fontSizeBase,
                      fontFamily: typography.fontFamily,
                      fontWeight: typography.fontWeightMedium,
                      backgroundColor: palette.accent,
                      border: "none",
                      borderRadius: 4,
                      color: "#fff",
                      cursor: searching ? "not-allowed" : "pointer",
                      opacity: searching ? 0.7 : 1,
                      flexShrink: 0,
                    }}
                  >
                    {searching ? (
                      <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                    ) : (
                      "Search"
                    )}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <input
                  type="text"
                  value={searchServer}
                  onChange={(e) => setSearchServer(e.target.value)}
                  placeholder="Server(s) to search; leave empty for the default list"
                  style={{
                    ...inputStyle,
                    fontSize: typography.fontSizeSmall,
                  }}
                />
                <div
                  style={{
                    fontSize: typography.fontSizeSmall - 1,
                    color: palette.textSecondary,
                    marginTop: 3,
                    opacity: 0.7,
                  }}
                >
                  Leave blank to search `matrix.org`, your homeserver, `tchncs.de`, `4d2.org`, and
                  `nope.chat`
                </div>
              </div>

              {searchError && (
                <div
                  style={{
                    padding: "8px 12px",
                    backgroundColor: "rgba(237,66,69,0.15)",
                    border: "1px solid rgba(237,66,69,0.3)",
                    borderRadius: 4,
                    color: "#ed4245",
                    fontSize: typography.fontSizeSmall,
                    marginBottom: 12,
                  }}
                >
                  {searchError}
                </div>
              )}

              {(homeserverBrowseLoading || searching) && (
                <div
                  style={{
                    color: palette.textSecondary,
                    textAlign: "center",
                    padding: "12px 0",
                    fontSize: typography.fontSizeSmall,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                  {searching ? "Searching…" : "Loading public rooms from your homeserver…"}
                </div>
              )}

              {searchResults.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    marginBottom: 16,
                  }}
                >
                  {searchResults.map((row) => (
                    <SpaceSearchRow
                      key={row.room_id}
                      space={row}
                      joiningId={joiningId}
                      joinSuccess={joinSuccess}
                      onJoin={handleJoinRoom}
                      palette={palette}
                      typography={typography}
                      resolvedColorScheme={resolvedColorScheme}
                    />
                  ))}
                </div>
              )}

              {homeserverBrowseDone &&
                !hasSearched &&
                searchResults.length === 0 &&
                !homeserverBrowseLoading &&
                !searching &&
                !searchError && (
                  <div
                    style={{
                      color: palette.textSecondary,
                      textAlign: "center",
                      padding: "16px 0",
                      fontSize: typography.fontSizeBase,
                    }}
                  >
                    No public rooms on your homeserver.
                  </div>
                )}

              {hasSearched &&
                searchResults.length === 0 &&
                !searching &&
                !homeserverBrowseLoading &&
                !searchError && (
                  <div
                    style={{
                      color: palette.textSecondary,
                      textAlign: "center",
                      padding: "16px 0",
                      fontSize: typography.fontSizeBase,
                    }}
                  >
                    No public rooms found.
                  </div>
                )}

              <div
                style={{
                  height: 1,
                  backgroundColor: palette.border,
                  margin: "16px 0",
                }}
              />

              <div>
                <label style={labelStyle}>Join by Address</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    value={joinAddress}
                    onChange={(e) => setJoinAddress(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && joinAddress.trim()) handleJoinByAddress();
                    }}
                    placeholder="#room-name:server.com or !roomid:server.com"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={handleJoinByAddress}
                    disabled={!joinAddress.trim() || !!joiningId}
                    style={{
                      padding: "8px 16px",
                      fontSize: typography.fontSizeBase,
                      fontFamily: typography.fontFamily,
                      fontWeight: typography.fontWeightMedium,
                      backgroundColor:
                        !joinAddress.trim() || !!joiningId
                          ? palette.accent + "80"
                          : palette.accent,
                      border: "none",
                      borderRadius: 4,
                      color: "#fff",
                      cursor:
                        !joinAddress.trim() || !!joiningId ? "not-allowed" : "pointer",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <LogIn size={14} />
                    Join
                  </button>
                </div>
              </div>
            </>
          )}

          {allowCreate && activeTab === "create" && (
            <>
              <fieldset disabled={creating || !!pendingRoom} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Room Type</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <KindButton
                    icon={<Hash size={18} />}
                    label="Text"
                    description="A channel for text messages"
                    selected={roomKind === "text"}
                    onClick={() => setRoomKind("text")}
                    palette={palette}
                    typography={typography}
                  />
                  <KindButton
                    icon={<Volume2 size={18} />}
                    label="Voice"
                    description="A room for voice calls"
                    selected={roomKind === "voice"}
                    onClick={() => setRoomKind("voice")}
                    palette={palette}
                    typography={typography}
                  />
                  <KindButton
                    icon={<Rss size={18} />}
                    label="RSS Feed"
                    description="Updates from an RSS feed"
                    selected={roomKind === "rss"}
                    onClick={() => setRoomKind("rss")}
                    palette={palette}
                    typography={typography}
                  />
                </div>
              </div>

              {roomKind === "rss" && (
                <div style={{ marginBottom: 16, padding: 12, border: `1px solid ${palette.border}`, borderRadius: 8 }}>
                  <div style={{ marginBottom: 12 }}>
                    <label htmlFor="rss-feed-url" style={labelStyle}>
                      Feed URL <span style={{ color: "#ed4245" }}>*</span>
                    </label>
                    <input
                      id="rss-feed-url"
                      type="url"
                      value={feedUrl}
                      onChange={(e) => setFeedUrl(e.target.value)}
                      placeholder="https://example.com/feed.xml"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      style={inputStyle}
                    />
                  </div>
                  <label htmlFor="rss-feed-bot" style={labelStyle}>
                    Feed Bot <span style={{ color: "#ed4245" }}>*</span>
                  </label>
                  <input
                    id="rss-feed-bot"
                    type="text"
                    value={feedBot}
                    onChange={(e) => setFeedBot(e.target.value)}
                    placeholder="@rss:t2bot.io"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby="rss-feed-bot-help"
                    required
                    style={inputStyle}
                  />
                  <div id="rss-feed-bot-help" style={{ marginTop: 6, color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>
                    The bot joins this room and posts feed updates. Use t2bot.io or another bot that supports !rss subscribe.
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>
                  Room Name <span style={{ color: "#ed4245" }}>*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={roomKind === "voice" ? "General Voice" : roomKind === "rss" ? "News feed" : "general"}
                  maxLength={255}
                  style={inputStyle}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim() && !creating) handleCreate();
                  }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Topic</label>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="What is this room about?"
                  maxLength={512}
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Who can find and join</label>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    width: "100%",
                  }}
                >
                  <KindButton
                    icon={<Users size={18} />}
                    label={isStandaloneHome ? "Private" : "Space members"}
                    description={
                      isStandaloneHome
                        ? "Not listed in the public directory. Invite people to join."
                        : "Not listed in the public directory. Anyone already in this space can see it and join without an invite."
                    }
                    selected={roomAccess === "space_members"}
                    onClick={() => setRoomAccess("space_members")}
                    palette={palette}
                    typography={typography}
                    fullWidth
                  />
                  <KindButton
                    icon={<Globe size={18} />}
                    label="Public"
                    description="Listed in the server's public directory. Anyone can join."
                    selected={roomAccess === "public"}
                    onClick={() => setRoomAccess("public")}
                    palette={palette}
                    typography={typography}
                    fullWidth
                  />
                  <KindButton
                    icon={<Lock size={18} />}
                    label="Invite only"
                    description="Not in the public directory. Only people you invite can join."
                    selected={roomAccess === "invite"}
                    onClick={() => setRoomAccess("invite")}
                    palette={palette}
                    typography={typography}
                    fullWidth
                  />
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>History Visibility</label>
                <select
                  value={historyVisibility}
                  onChange={(e) =>
                    setHistoryVisibility(e.target.value as HistoryVisibility)
                  }
                  style={{
                    ...inputStyle,
                    cursor: "pointer",
                    WebkitAppearance: "none",
                    MozAppearance: "none",
                    appearance: "none",
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 10px center",
                    paddingRight: 32,
                  }}
                >
                  <option value="shared">Members only (full history)</option>
                  <option value="joined">Members only (since they joined)</option>
                  <option value="invited">Members only (since they were invited)</option>
                  <option value="world_readable">Anyone</option>
                </select>
              </div>

              <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Publish address</label>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      backgroundColor: palette.bgTertiary,
                      border: `1px solid ${palette.border}`,
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <span
                      style={{
                        padding: "8px 0 8px 12px",
                        color: palette.textSecondary,
                        fontSize: typography.fontSizeBase,
                        userSelect: "none",
                        flexShrink: 0,
                      }}
                    >
                      #
                    </span>
                    <input
                      type="text"
                      value={roomAlias}
                      onChange={(e) =>
                        setRoomAlias(
                          e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "")
                        )
                      }
                      placeholder="my-room"
                      style={{
                        flex: 1,
                        padding: "8px 12px 8px 4px",
                        fontSize: typography.fontSizeBase,
                        fontFamily: typography.fontFamily,
                        backgroundColor: "transparent",
                        border: "none",
                        color: palette.textPrimary,
                        outline: "none",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall - 1,
                      color: palette.textSecondary,
                      marginTop: 4,
                      opacity: 0.7,
                    }}
                  >
                    Optional. A memorable alias like{" "}
                    {`#${roomAlias || "my-room"}:${currentHomeserver ?? "your-homeserver"}`}{" "}
                    (join rules above still apply).
                  </div>
                </div>

              <div style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((o) => !o)}
                  style={{
                    background: "none",
                    border: "none",
                    color: palette.textSecondary,
                    fontSize: typography.fontSizeSmall,
                    fontFamily: typography.fontFamily,
                    cursor: "pointer",
                    padding: "4px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                      fontSize: 10,
                    }}
                  >
                    ▶
                  </span>
                  Advanced
                </button>
                {advancedOpen && (
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      marginTop: 12,
                      paddingLeft: 4,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={federate}
                      onChange={(e) => setFederate(e.target.checked)}
                      style={{
                        accentColor: palette.accent,
                        width: 16,
                        height: 16,
                        cursor: "pointer",
                      }}
                    />
                    <div>
                      <div
                        style={{
                          fontSize: typography.fontSizeBase,
                          color: palette.textPrimary,
                          fontWeight: typography.fontWeightMedium,
                        }}
                      >
                        Allow federation
                      </div>
                      <div
                        style={{
                          fontSize: typography.fontSizeSmall - 1,
                          color: palette.textSecondary,
                          marginTop: 2,
                        }}
                      >
                        Let users from other Matrix homeservers join this room
                      </div>
                    </div>
                  </label>
                )}
              </div>

              </fieldset>
              {error && (
                <div
                  ref={errorRef}
                  role="alert"
                  style={{
                    padding: "8px 12px",
                    backgroundColor: "rgba(237,66,69,0.15)",
                    border: "1px solid rgba(237,66,69,0.3)",
                    borderRadius: 4,
                    color: "#ed4245",
                    fontSize: typography.fontSizeSmall,
                    marginBottom: 8,
                  }}
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {allowCreate && activeTab === "create" && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 16px",
              borderTop: `1px solid ${palette.border}`,
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => { void handleClose().catch((e) => setError(String(e))); }}
              disabled={creating}
              style={{
                padding: "8px 16px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor: "transparent",
                border: `1px solid ${palette.border}`,
                borderRadius: 4,
                color: palette.textPrimary,
                cursor: creating ? "not-allowed" : "pointer",
                opacity: creating ? 0.5 : 1,
              }}
            >
              {pendingRoom ? "Open Room" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={createDisabled}
              style={{
                padding: "8px 20px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor:
                  createDisabled ? palette.accent + "80" : palette.accent,
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor: createDisabled ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {creating ? (
                <>
                  <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />
                  Creating…
                </>
              ) : (
                <>
                  <Plus size={16} />
                  {pendingRoom ? "Open Room" : "Create Room"}
                </>
              )}
            </button>
          </div>
        )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Dialog>
  );
}

function KindButton({
  icon,
  label,
  description,
  selected,
  onClick,
  palette,
  typography,
  fullWidth,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      style={{
        flex: fullWidth ? undefined : 1,
        minWidth: 0,
        width: fullWidth ? "100%" : undefined,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: 12,
        backgroundColor: selected ? palette.bgActive : palette.bgTertiary,
        border: selected
          ? `2px solid ${palette.accent}`
          : `2px solid ${palette.border}`,
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color 0.15s, background-color 0.15s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: selected ? palette.accent : palette.textPrimary,
          fontWeight: typography.fontWeightMedium,
          fontSize: typography.fontSizeBase,
        }}
      >
        {icon} {label}
      </div>
      <div
        style={{
          fontSize: typography.fontSizeSmall - 1,
          color: palette.textSecondary,
          lineHeight: 1.3,
        }}
      >
        {description}
      </div>
    </button>
  );
}
