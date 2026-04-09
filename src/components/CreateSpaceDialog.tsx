import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Room } from "../types/matrix";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import {
  X,
  Plus,
  Loader2,
  ImagePlus,
  Globe,
  Lock,
  Trash2,
  Search,
  LogIn,
  DoorOpen,
  Users,
  Check,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";

type HistoryVisibility = "shared" | "joined" | "invited" | "world_readable";
type GuestAccess = "can_join" | "forbidden";
type JoinRule = "public" | "invite" | "knock";

interface PublicSpaceResult {
  room_id: string;
  name?: string;
  topic?: string;
  num_joined_members?: number;
  avatar_url?: string;
  canonical_alias?: string;
  room_type?: string;
  join_rule?: string;
  membership?: string;
}

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

function mergePublicSpaceResults(results: PublicSpaceResult[][]): PublicSpaceResult[] {
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

function buildOptimisticSpaceRoom(
  roomId: string,
  name: string,
  avatarUrl: string | null
): Room {
  return {
    id: roomId,
    name,
    avatarUrl,
    isSpace: true,
    parentSpaceIds: [],
    roomType: "m.space",
    membership: "joined",
  };
}

interface CreateSpaceDialogProps {
  canCreate: boolean;
  onClose: () => void;
  onCreated: (payload?: RoomsChangedPayload) => void | Promise<void>;
}

export default function CreateSpaceDialog({
  canCreate,
  onClose,
  onCreated,
}: CreateSpaceDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  // Tab state — if user can't create, only show join (no tabs at all)
  const [activeTab, setActiveTab] = useState<"join" | "create">("join");

  // ── Create form state ──
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [joinRule, setJoinRule] = useState<JoinRule>("invite");
  const [roomAlias, setRoomAlias] = useState("");
  const [federate, setFederate] = useState(true);
  const [historyVisibility, setHistoryVisibility] =
    useState<HistoryVisibility>("shared");
  const [guestAccess, setGuestAccess] = useState<GuestAccess>("forbidden");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarData, setAvatarData] = useState<string | null>(null);
  const [avatarMime, setAvatarMime] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Join tab state ──
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** One automatic public-space list per dialog open; avoids clobbering results after a manual search when switching tabs. */
  const homeserverPublicListFetchedRef = useRef(false);
  /** When the user runs a manual search, ignore in-flight homeserver auto-list results. */
  const homeserverAutoStaleRef = useRef(false);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    invoke<string>("current_homeserver")
      .then(setCurrentHomeserver)
      .catch(() => setCurrentHomeserver(null));
  }, []);

  // Light, one-time listing of public spaces on your homeserver when the join tab is shown.
  useEffect(() => {
    if (
      activeTab !== "join" ||
      !currentHomeserver ||
      homeserverPublicListFetchedRef.current
    ) {
      return;
    }

    let cancelled = false;
    setHomeserverBrowseLoading(true);

    (async () => {
      try {
        const result = await invoke<{ chunk: PublicSpaceResult[] }>(
          "search_public_spaces",
          {
            searchTerm: null,
            server: currentHomeserver,
            limit: 20,
          }
        );
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

  // When switching to private, demote "public" or "knock" join rules
  // since those options are disabled for private spaces.
  useEffect(() => {
    if (!isPublic && (joinRule === "public" || joinRule === "knock")) {
      setJoinRule("invite");
    }
  }, [isPublic, joinRule]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // ── Avatar handling ──
  const handleAvatarPick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAvatarChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const commaIdx = result.indexOf(",");
        const mimeMatch = result.match(/^data:([^;]+);/);
        if (commaIdx >= 0 && mimeMatch) {
          setAvatarData(result.slice(commaIdx + 1));
          setAvatarMime(mimeMatch[1]);
          setAvatarPreview(result);
        }
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleRemoveAvatar = useCallback(() => {
    setAvatarData(null);
    setAvatarMime(null);
    setAvatarPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // ── Create submission ──
  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      setError("Space name is required.");
      return;
    }
    setCreating(true);
    setError(null);

    try {
      const roomId = await invoke<string>("create_space", {
        name: name.trim(),
        topic: topic.trim() || null,
        isPublic,
        roomAlias: roomAlias.trim() || null,
        federate,
        avatarData,
        avatarMime,
        historyVisibility,
        guestAccess,
        joinRule,
      });
      await onCreated({
        joinedRoomId: roomId,
        optimisticRoom: buildOptimisticSpaceRoom(
          roomId,
          name.trim(),
          avatarPreview
        ),
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }, [
    name, topic, isPublic, roomAlias, federate, avatarData, avatarMime,
    historyVisibility, guestAccess, joinRule, onCreated, onClose,
  ]);

  // ── Search public spaces ──
  const handleSearch = useCallback(async () => {
    homeserverAutoStaleRef.current = true;
    setSearching(true);
    setSearchError(null);
    setHasSearched(true);
    setJoinSuccess(null);

    try {
      const searchTermValue = searchTerm.trim() || null;

      if (searchServers.length <= 1) {
        const result = await invoke<{ chunk: PublicSpaceResult[] }>(
          "search_public_spaces",
          {
            searchTerm: searchTermValue,
            server: searchServers[0] || null,
            limit: 20,
          }
        );
        setSearchResults(result.chunk || []);
        return;
      }

      const settled = await Promise.allSettled(
        searchServers.map((server) =>
          invoke<{ chunk: PublicSpaceResult[] }>("search_public_spaces", {
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

      setSearchResults(mergePublicSpaceResults(successfulResults));

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

  // ── Join a space (by ID or from search result) ──
  const handleJoinSpace = useCallback(
    async (space: PublicSpaceResult) => {
      const roomId = space.room_id;
      const joinTarget = space.canonical_alias || roomId;
      const viaServers = uniqueNonEmpty([
        ...searchServers,
        extractMatrixServerName(space.canonical_alias),
        extractMatrixServerName(roomId),
      ]);

      setJoiningId(roomId);
      setJoinSuccess(null);
      try {
        const isKnock = space.join_rule === "knock";
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
            optimisticRoom: buildOptimisticSpaceRoom(
              joinedRoomId,
              space.name || space.canonical_alias || joinedRoomId,
              null
            ),
          });
        }
        // Update search results to reflect new membership
        setSearchResults((prev) =>
          prev.map((r) =>
            r.room_id === roomId
              ? { ...r, membership: isKnock ? "knocked" : "joined" }
              : r
          )
        );
      } catch (e) {
        setSearchError(`Failed to ${space.join_rule === "knock" ? "request to join" : "join"}: ${e}`);
      } finally {
        setJoiningId(null);
      }
    },
    [onCreated, searchServers]
  );

  // ── Join by address ──
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

  // ── Shared styles ──
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

  const sectionStyle: React.CSSProperties = {
    marginBottom: 16,
  };

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: 500,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        {/* ── Header ── */}
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
            {canCreate ? "Add a Space" : "Join a Space"}
          </h2>
          <button
            onClick={onClose}
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

        {/* ── Tabs (only if user can create) ── */}
        {canCreate && (
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

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {/* ═════════════════ JOIN TAB ═════════════════ */}
          {activeTab === "join" && (
            <>
              {/* Search bar */}
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
                      placeholder="Search public spaces..."
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
                      <Loader2
                        size={16}
                        style={{ animation: "spin 1s linear infinite" }}
                      />
                    ) : (
                      "Search"
                    )}
                  </button>
                </div>
              </div>

              {/* Optional server field */}
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
                  Leave blank to search `matrix.org`, your homeserver, `tchncs.de`, `4d2.org`, and `nope.chat`
                </div>
              </div>

              {/* Error */}
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
                  <Loader2
                    size={16}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  {searching
                    ? "Searching…"
                    : "Loading public spaces from your homeserver…"}
                </div>
              )}

              {/* Results */}
              {searchResults.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    marginBottom: 16,
                  }}
                >
                  {searchResults.map((space) => (
                    <SpaceSearchRow
                      key={space.room_id}
                      space={space}
                      joiningId={joiningId}
                      joinSuccess={joinSuccess}
                      onJoin={handleJoinSpace}
                      palette={palette}
                      typography={typography}
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
                  No public spaces on your homeserver.
                </div>
              )}

              {hasSearched &&
                searchResults.length === 0 &&
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
                  No public spaces found.
                </div>
              )}

              {/* Divider */}
              <div
                style={{
                  height: 1,
                  backgroundColor: palette.border,
                  margin: "16px 0",
                }}
              />

              {/* Join by address */}
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
                    placeholder="#space-name:server.com or !roomid:server.com"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
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
                        !joinAddress.trim() || !!joiningId
                          ? "not-allowed"
                          : "pointer",
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

          {/* ═════════════════ CREATE TAB ═════════════════ */}
          {activeTab === "create" && (
            <>
              {/* Avatar + Name row */}
              <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
                <div style={{ flexShrink: 0, position: "relative" }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    style={{ display: "none" }}
                    onChange={handleAvatarChange}
                  />
                  <button
                    onClick={handleAvatarPick}
                    title="Upload avatar"
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: 16,
                      border: `2px dashed ${palette.border}`,
                      backgroundColor: palette.bgTertiary,
                      cursor: "pointer",
                      overflow: "hidden",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                    }}
                  >
                    {avatarPreview ? (
                      <img
                        src={avatarPreview}
                        alt="Avatar preview"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <ImagePlus size={28} color={palette.textSecondary} style={{ opacity: 0.6 }} />
                    )}
                  </button>
                  {avatarPreview && (
                    <button
                      onClick={handleRemoveAvatar}
                      title="Remove avatar"
                      style={{
                        position: "absolute", top: -6, right: -6,
                        width: 22, height: 22, borderRadius: "50%",
                        border: "none", backgroundColor: "#ed4245",
                        color: "#fff", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>
                    Space Name <span style={{ color: "#ed4245" }}>*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Space"
                    maxLength={255}
                    style={inputStyle}
                    autoFocus
                  />
                </div>
              </div>

              {/* Topic */}
              <div style={sectionStyle}>
                <label style={labelStyle}>Description</label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="What is this space about?"
                  rows={3}
                  maxLength={512}
                  style={{ ...inputStyle, resize: "vertical", minHeight: 60 }}
                />
              </div>

              {/* Visibility */}
              <div style={sectionStyle}>
                <label style={labelStyle}>Visibility</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <VisibilityButton
                    icon={<Lock size={16} />}
                    label="Private"
                    description="Only people who are invited can find and join"
                    selected={!isPublic}
                    onClick={() => setIsPublic(false)}
                    palette={palette}
                    typography={typography}
                  />
                  <VisibilityButton
                    icon={<Globe size={16} />}
                    label="Public"
                    description="Anyone can find this space and join"
                    selected={isPublic}
                    onClick={() => setIsPublic(true)}
                    palette={palette}
                    typography={typography}
                  />
                </div>
              </div>

              {/* Join Rules */}
              <div style={sectionStyle}>
                <label style={labelStyle}>Join Rules</label>
                <div style={{ display: "flex", gap: 8 }}>
                  {(
                    [
                      {
                        value: "public" as JoinRule,
                        icon: <Globe size={16} />,
                        label: "Open",
                        desc: "Anyone can join freely",
                        enabled: isPublic,
                      },
                      {
                        value: "knock" as JoinRule,
                        icon: <DoorOpen size={16} />,
                        label: "Knock",
                        desc: "Users request to join; admins approve",
                        enabled: isPublic,
                      },
                      {
                        value: "invite" as JoinRule,
                        icon: <Lock size={16} />,
                        label: "Invite Only",
                        desc: "Only invited users can join",
                        enabled: true,
                      },
                    ]
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setJoinRule(opt.value);
                        // If selecting "public" join rule, also set visibility to public
                        if (opt.value === "public") setIsPublic(true);
                      }}
                      disabled={!opt.enabled}
                      style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: 3,
                        padding: 10,
                        backgroundColor:
                          joinRule === opt.value
                            ? palette.bgActive
                            : palette.bgTertiary,
                        border:
                          joinRule === opt.value
                            ? `2px solid ${palette.accent}`
                            : `2px solid ${palette.border}`,
                        borderRadius: 8,
                        cursor: opt.enabled ? "pointer" : "not-allowed",
                        textAlign: "left",
                        transition:
                          "border-color 0.15s, background-color 0.15s",
                        opacity: opt.enabled ? 1 : 0.4,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          color:
                            joinRule === opt.value
                              ? palette.accent
                              : palette.textPrimary,
                          fontWeight: typography.fontWeightMedium,
                          fontSize: typography.fontSizeSmall,
                        }}
                      >
                        {opt.icon} {opt.label}
                      </div>
                      <div
                        style={{
                          fontSize: typography.fontSizeSmall - 2,
                          color: palette.textSecondary,
                          lineHeight: 1.3,
                        }}
                      >
                        {opt.desc}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Room Alias (only for public) */}
              {isPublic && (
                <div style={sectionStyle}>
                  <label style={labelStyle}>Space Address</label>
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
                          e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9_-]/g, "")
                        )
                      }
                      placeholder="my-space"
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
                    This will make the space discoverable via its address.
                  </div>
                </div>
              )}

              {/* Advanced options */}
              <AdvancedSection
                palette={palette}
                typography={typography}
                federate={federate}
                setFederate={setFederate}
                historyVisibility={historyVisibility}
                setHistoryVisibility={setHistoryVisibility}
                guestAccess={guestAccess}
                setGuestAccess={setGuestAccess}
                inputStyle={inputStyle}
                labelStyle={labelStyle}
              />

              {/* Error */}
              {error && (
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
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer (create tab only) ── */}
        {activeTab === "create" && (
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
              onClick={onClose}
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
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              style={{
                padding: "8px 20px",
                fontSize: typography.fontSizeBase,
                fontFamily: typography.fontFamily,
                fontWeight: typography.fontWeightMedium,
                backgroundColor:
                  creating || !name.trim()
                    ? palette.accent + "80"
                    : palette.accent,
                border: "none",
                borderRadius: 4,
                color: "#fff",
                cursor:
                  creating || !name.trim() ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              {creating ? (
                <>
                  <Loader2
                    size={16}
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                  Creating…
                </>
              ) : (
                <>
                  <Plus size={16} />
                  Create Space
                </>
              )}
            </button>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Sub-components ──

function SpaceSearchRow({
  space,
  joiningId,
  joinSuccess,
  onJoin,
  palette,
  typography,
}: {
  space: PublicSpaceResult;
  joiningId: string | null;
  joinSuccess: string | null;
  onJoin: (space: PublicSpaceResult) => void;
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
}) {
  const [hovered, setHovered] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const isJoined = space.membership === "joined" || joinSuccess === space.room_id;
  const isKnocked = space.membership === "knocked" || (joinSuccess === space.room_id && space.join_rule === "knock");
  const isJoining = joiningId === space.room_id;
  const isKnock = space.join_rule === "knock";

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 6,
        backgroundColor: hovered ? palette.bgHover : "transparent",
        transition: "background-color 0.1s",
      }}
    >
      {/* Icon */}
      {space.avatar_url && !imageFailed ? (
        <img
          src={space.avatar_url}
          alt={space.name || space.room_id}
          onError={() => setImageFailed(true)}
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundColor: palette.bgActive,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            fontSize: 16,
            fontWeight: 600,
            color: palette.textSecondary,
          }}
        >
          {(space.name || "?")
            .split(" ")
            .map((w) => w[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
      )}

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textHeading,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {space.name || space.room_id}
        </div>
        {space.topic && (
          <div
            style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {space.topic}
          </div>
        )}
        <div
          style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginTop: 2,
          }}
        >
          <Users size={11} />
          {space.num_joined_members ?? 0} member
          {(space.num_joined_members ?? 0) !== 1 ? "s" : ""}
          {space.canonical_alias && (
            <span style={{ marginLeft: 6, opacity: 0.7 }}>
              {space.canonical_alias}
            </span>
          )}
        </div>
      </div>

      {/* Action */}
      <div style={{ flexShrink: 0 }}>
        {isJoined && !isKnock ? (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: typography.fontSizeSmall,
              color: "#23a55a",
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
            }}
          >
            <Check size={14} />
            Requested
          </span>
        ) : (
          <button
            onClick={() => onJoin(space)}
            disabled={isJoining}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: palette.accent,
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              fontFamily: typography.fontFamily,
              cursor: isJoining ? "not-allowed" : "pointer",
              opacity: isJoining ? 0.7 : 1,
            }}
          >
            {isJoining ? (
              <Loader2
                size={13}
                style={{ animation: "spin 1s linear infinite" }}
              />
            ) : (
              <LogIn size={13} />
            )}
            {isJoining
              ? isKnock ? "Requesting…" : "Joining…"
              : isKnock ? "Request to Join" : "Join"}
          </button>
        )}
      </div>
    </div>
  );
}

function VisibilityButton({
  icon, label, description, selected, onClick, palette, typography,
}: {
  icon: React.ReactNode; label: string; description: string;
  selected: boolean; onClick: () => void;
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "flex-start", gap: 4, padding: "12px",
        backgroundColor: selected ? palette.bgActive : palette.bgTertiary,
        border: selected ? `2px solid ${palette.accent}` : `2px solid ${palette.border}`,
        borderRadius: 8, cursor: "pointer", textAlign: "left",
        transition: "border-color 0.15s, background-color 0.15s",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        color: selected ? palette.accent : palette.textPrimary,
        fontWeight: typography.fontWeightMedium, fontSize: typography.fontSizeBase,
      }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: typography.fontSizeSmall - 1, color: palette.textSecondary, lineHeight: 1.3 }}>
        {description}
      </div>
    </button>
  );
}

function AdvancedSection({
  palette, typography, federate, setFederate,
  historyVisibility, setHistoryVisibility, guestAccess, setGuestAccess,
  inputStyle, labelStyle,
}: {
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
  federate: boolean; setFederate: (v: boolean) => void;
  historyVisibility: HistoryVisibility; setHistoryVisibility: (v: HistoryVisibility) => void;
  guestAccess: GuestAccess; setGuestAccess: (v: GuestAccess) => void;
  inputStyle: React.CSSProperties; labelStyle: React.CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);

  const selectStyle: React.CSSProperties = {
    ...inputStyle, cursor: "pointer",
    WebkitAppearance: "none", MozAppearance: "none", appearance: "none",
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
    backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center", paddingRight: 32,
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: "none", border: "none", color: palette.textSecondary,
          fontSize: typography.fontSizeSmall, fontFamily: typography.fontFamily,
          cursor: "pointer", padding: "4px 0",
          display: "flex", alignItems: "center", gap: 4,
        }}
      >
        <span style={{
          display: "inline-block",
          transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 0.15s", fontSize: 10,
        }}>
          ▶
        </span>
        Advanced Settings
      </button>

      {expanded && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14, paddingLeft: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox" checked={federate}
              onChange={(e) => setFederate(e.target.checked)}
              style={{ accentColor: palette.accent, width: 16, height: 16, cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: typography.fontSizeBase, color: palette.textPrimary, fontWeight: typography.fontWeightMedium }}>
                Allow federation
              </div>
              <div style={{ fontSize: typography.fontSizeSmall - 1, color: palette.textSecondary, marginTop: 2 }}>
                Let users from other Matrix servers join this space
              </div>
            </div>
          </label>

          <div>
            <label style={labelStyle}>History Visibility</label>
            <select value={historyVisibility} onChange={(e) => setHistoryVisibility(e.target.value as HistoryVisibility)} style={selectStyle}>
              <option value="shared">Members only (full history)</option>
              <option value="joined">Members only (since they joined)</option>
              <option value="invited">Members only (since they were invited)</option>
              <option value="world_readable">Anyone</option>
            </select>
          </div>

          <div>
            <label style={labelStyle}>Guest Access</label>
            <select value={guestAccess} onChange={(e) => setGuestAccess(e.target.value as GuestAccess)} style={selectStyle}>
              <option value="forbidden">Guests cannot join</option>
              <option value="can_join">Guests can join</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}