import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { useRoomAvatar, useUserAvatarStore } from "../context/UserAvatarStore";
import { avatarSrc } from "../utils/avatarSrc";

/** Room images use the same batched loading and per-identity subscriptions as users. */
export default function RoomAvatar({ roomId, avatarUrlHint, fallback = null, ...props }: {
  roomId: string | null;
  avatarUrlHint?: string | null;
  fallback?: ReactNode;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const path = useRoomAvatar(roomId, avatarUrlHint);
  const store = useUserAvatarStore();
  const resolved = roomId ? store.lookup(roomId) : undefined;
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const retriedPath = useRef<string | null>(null);
  // A missing persisted file can be recreated at the same deterministic path.
  useEffect(() => {
    if (resolved) setFailedPath(null);
  }, [resolved]);
  if (!path || path === failedPath) return <>{fallback}</>;
  return <img {...props} src={avatarSrc(path)} onError={(event) => {
    setFailedPath(path);
    if (roomId && retriedPath.current !== path) {
      retriedPath.current = path;
      store.invalidate(roomId);
    }
    props.onError?.(event);
  }} />;
}
