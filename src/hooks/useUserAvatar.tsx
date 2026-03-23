import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Fetches the logged-in user's own avatar as a data URL.
 * Returns null while loading or if the user has no avatar set.
 */
export function useUserAvatar() {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("get_user_avatar")
      .then((url) => {
        if (!cancelled) setAvatarUrl(url);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return avatarUrl;
}