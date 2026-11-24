import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Hash, Layers, LoaderCircle } from "lucide-react";
import type { Room } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import { avatarSrc } from "../utils/avatarSrc";
import { roomLinkActionFailure, roomLinkPresentation, roomLinkTarget, type RoomLinkAction, type RoomPreviewFailure } from "../utils/roomLinks";
import RoomAvatar from "./RoomAvatar";

interface LinkedRoomPreview {
  roomId: string;
  viaServers: string[];
  name: string | null;
  avatarUrl: string | null;
  isSpace: boolean;
  membership: string | null;
  joinRule: string | null;
  allowedRoomIds: string[];
}

type PreviewResult = LinkedRoomPreview | RoomPreviewFailure | null;

interface PreviewSource {
  getRoom: (roomId: string, includeHistory?: boolean) => Room | null;
  openRoom: (roomId: string) => void;
  load: (url: string, refresh: boolean) => Promise<PreviewResult>;
}

const RoomLinks = createContext<PreviewSource | null>(null);
const PREVIEW_CACHE_LIMIT = 128;
const PREVIEW_CACHE_TTL_MS = 60_000;

export function RoomLinkPreviewProvider({ getRoom, openRoom, children }: Pick<PreviewSource, "getRoom" | "openRoom"> & {
  children: ReactNode;
}) {
  const cache = useRef(new Map<string, { expires: number; result: Promise<PreviewResult> }>());
  const load = useCallback((url: string, refresh: boolean) => {
    const previous = cache.current.get(url);
    if (!refresh && previous && previous.expires > Date.now()) return previous.result;
    const result = invoke<LinkedRoomPreview>("get_linked_room_preview", { url }).catch((reason: unknown) =>
      reason === "invalidLink" || reason === "roomNotFound" ? reason : null);
    cache.current.delete(url);
    if (cache.current.size >= PREVIEW_CACHE_LIMIT) {
      const oldest = cache.current.keys().next().value;
      if (oldest !== undefined) cache.current.delete(oldest);
    }
    cache.current.set(url, { expires: Date.now() + PREVIEW_CACHE_TTL_MS, result });
    return result;
  }, []);
  const source = useMemo(() => ({ getRoom, openRoom, load }), [getRoom, openRoom, load]);
  return <RoomLinks.Provider value={source}>{children}</RoomLinks.Provider>;
}

export default function RoomLinkPreview({ url, allowUnknownJoin = false }: { url: string; allowUnknownJoin?: boolean }) {
  const source = useContext(RoomLinks);
  const target = roomLinkTarget(url);
  if (!source || !target) return null;
  return <RoomLinkCard key={url} url={url} target={target} source={source} allowUnknownJoin={allowUnknownJoin} />;
}

function RoomLinkCard({ url, target, source, allowUnknownJoin }: {
  url: string;
  target: string;
  source: PreviewSource;
  allowUnknownJoin: boolean;
}) {
  const { palette, typography } = useTheme();
  const [preview, setPreview] = useState<PreviewResult>();
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failedAttempt, setFailedAttempt] = useState<{
    presentation: ReturnType<typeof roomLinkPresentation>;
    feedback: ReturnType<typeof roomLinkActionFailure>;
  } | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<string>();
  const wasKnown = useRef(false);
  const { getRoom, load, openRoom } = source;
  const data = typeof preview === "string" ? null : preview;
  const room = getRoom(data?.roomId ?? target);
  const known = room != null;

  useEffect(() => {
    const refresh = wasKnown.current && !known;
    wasKnown.current = known;
    if (refresh) setPreview(undefined);
    let active = true;
    void load(url, refresh).then((result) => {
      if (active) setPreview(result);
    });
    return () => { active = false; };
  }, [known, load, url]);

  const resolved = !known && wasKnown.current ? undefined : data;
  const roomId = room?.id ?? resolved?.roomId ?? target;
  const isSpace = room?.isSpace ?? resolved?.isSpace ?? false;
  const label = isSpace ? "space" : "room";
  const name = room?.name || resolved?.name || (target.startsWith("#") ? target : `Matrix ${label}`);
  const membership = room?.membership ?? resolved?.membership;
  const joinRule = resolved?.joinRule;
  // Directory-only previews may omit the allowed rooms. Try the join when access is unknown.
  const meetsRestriction = resolved?.allowedRoomIds?.length
    ? resolved.allowedRoomIds.some((id) => getRoom(id, true)?.membership === "joined")
    : undefined;
  const loading = resolved === undefined;
  const previewFailure = typeof preview === "string" ? preview : undefined;
  const presentation = useMemo(() => roomLinkPresentation(membership, joinRule, {
    label, requested, loading, allowUnknownJoin, meetsRestriction, previewFailure,
  }), [membership, joinRule, label, requested, loading, allowUnknownJoin, meetsRestriction, previewFailure]);
  const { action, buttonLabel, status } = presentation;
  // An earlier refusal can arrive after sync delivers an invite or updates space membership.
  const failure = failedAttempt?.presentation === presentation ? failedAttempt.feedback : null;
  const disabled = busy || !action || !!failure?.buttonLabel;
  const canRequestAfterFailedJoin = allowUnknownJoin && action === "join" && joinRule == null && failure?.offerKnock;

  async function activate(action: RoomLinkAction) {
    if (busyRef.current) return;
    if (action === "open") {
      openRoom(roomId);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailedAttempt(null);
    try {
      const { viaServers } = resolved ?? await invoke<{ viaServers: string[] }>("parse_room_link", { url });
      const joinedId = await invoke<string>(action === "knock" ? "knock_room" : "join_room", {
        roomId,
        viaServers,
        resolveVia: false,
      });
      if (action === "knock") setRequested(true);
      else openRoom(joinedId);
    } catch (reason) {
      const feedback = roomLinkActionFailure(reason, action, label);
      // A temporary knock failure still allows retrying the request after a refused join.
      setFailedAttempt({
        presentation,
        feedback: action === "knock" && canRequestAfterFailedJoin && !feedback.buttonLabel
          ? { ...failure, status: feedback.status }
          : feedback,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const icon = isSpace ? <Layers size={19} /> : <Hash size={19} />;
  const remoteAvatar = avatarSrc(resolved?.avatarUrl);
  const avatarStyle = { width: "100%", height: "100%", objectFit: "cover" as const };
  return (
    <div aria-label={`Preview of ${name}`} style={{
      width: "min(100%, 360px)", boxSizing: "border-box", padding: "9px 10px",
      background: palette.bgSecondary, border: `1px solid ${palette.border}`, borderRadius: 10,
      display: "grid", gap: 5, marginTop: 3,
    }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 9 }}>
        <span aria-hidden="true" style={{
          flexShrink: 0, width: 34, height: 34, borderRadius: 8, overflow: "hidden",
          display: "grid", placeItems: "center", background: palette.bgTertiary, color: palette.textSecondary,
        }}>
          {room || (roomId && (membership === "invited" || membership === "joined")) ? (
            <RoomAvatar roomId={roomId ?? null} avatarUrlHint={room?.avatarUrl ?? resolved?.avatarUrl}
              alt="" loading="lazy" fallback={icon} style={avatarStyle} />
          ) : remoteAvatar && remoteAvatar !== failedAvatar ? (
            <img src={remoteAvatar} alt="" loading="lazy" style={avatarStyle} onError={() => setFailedAvatar(remoteAvatar)} />
          ) : icon}
        </span>
        <div style={{ flex: "1 1 105px", minWidth: 0, lineHeight: 1.35 }}>
          <div title={name} style={{ fontWeight: typography.fontWeightMedium, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </div>
          <div role={failure ? "alert" : undefined} style={{ color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>
            {failure?.status ?? status}
          </div>
        </div>
        <button type="button" disabled={disabled} onClick={(event) => {
          event.stopPropagation();
          if (action) void activate(action);
        }} style={{
          display: "inline-flex", alignItems: "center", gap: 5, border: 0, borderRadius: 7, padding: "6px 9px",
          background: disabled || action === "open" ? palette.bgTertiary : palette.accent,
          color: disabled ? palette.textSecondary : action === "open" ? palette.textPrimary : "#fff",
          fontSize: typography.fontSizeSmall,
          fontFamily: typography.fontFamily, fontWeight: typography.fontWeightMedium,
          cursor: disabled ? "default" : "pointer",
        }}>
          {busy && <LoaderCircle size={12} style={{ animation: "spin .8s linear infinite" }} aria-hidden="true" />}
          {failure?.buttonLabel ?? buttonLabel}
        </button>
      </div>
      {canRequestAfterFailedJoin && (
        <button type="button" disabled={busy} onClick={() => void activate("knock")}
          style={{ justifySelf: "end", color: palette.accent, background: "none", border: 0, cursor: "pointer" }}>
          Request to join
        </button>
      )}
    </div>
  );
}
