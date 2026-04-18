import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUserAvatarStoreOptional } from "../context/UserAvatarStore";

export type MatrixUserProfileState = {
  loading: boolean;
  displayName: string | null;
  avatarUrl: string | null;
};

/**
 * Global Matrix profile for a user (for DM UI before/without room member state).
 */
export function useMatrixUserProfile(userId: string | null): MatrixUserProfileState {
  const [loading, setLoading] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const userAvatarStore = useUserAvatarStoreOptional();

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      setDisplayName(null);
      setAvatarUrl(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDisplayName(null);
    setAvatarUrl(null);
    invoke<{ displayName: string | null; avatarUrl: string | null }>("get_matrix_user_profile", {
      userId,
    })
      .then((p) => {
        if (cancelled) return;
        setDisplayName(p.displayName ?? null);
        setAvatarUrl(p.avatarUrl ?? null);
        setLoading(false);
        userAvatarStore?.prime(userId, p.avatarUrl ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setDisplayName(null);
        setAvatarUrl(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, userAvatarStore]);

  return { loading, displayName, avatarUrl };
}
