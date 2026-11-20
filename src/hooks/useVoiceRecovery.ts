import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceRecovery = {
  roomId: string;
  expiresAt: number;
  direct?: { callId: string; peerUserId: string; peerDeviceId: string };
};

export const VOICE_RECOVERY_REFRESH_MS = 10_000;
export const ROOM_RECOVERY_MS = 15 * 60_000;

function loadRecovery(saved: string): VoiceRecovery | null {
  const record: VoiceRecovery | null = JSON.parse(saved);
  if (typeof record?.roomId !== "string" || !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= Date.now()) return null;
  if (record.direct && (typeof record.direct.callId !== "string" ||
      typeof record.direct.peerUserId !== "string" || typeof record.direct.peerDeviceId !== "string")) return null;
  return record;
}

export function useVoiceRecovery(userId: string) {
  const [record, setRecord] = useState<VoiceRecovery | null>(null);
  const [ready, setReady] = useState(false);
  const current = useRef<VoiceRecovery | null>(null);
  const storageKey = useRef<string | null>(null);
  const changed = useRef(false);

  const write = useCallback((next: VoiceRecovery | null) => {
    current.current = next;
    setRecord(next);
    const key = storageKey.current;
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch (error) {
      console.warn("Could not save voice recovery:", error);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void invoke<string>("voice_device_id", { userId }).then(async (deviceId) => {
      if (disposed) return;
      const key = `pax-voice-recovery:${userId}:${deviceId}`;
      storageKey.current = key;
      if (changed.current) {
        write(current.current);
        return;
      }
      const saved = localStorage.getItem(key);
      if (saved !== null) {
        write(loadRecovery(saved));
        return;
      }
      // Upgrades can restore a voice channel from this device's existing membership.
      const roomId = await invoke<string | null>("voice_find_previous_room");
      if (!disposed && !changed.current) {
        write(roomId ? { roomId, expiresAt: Date.now() + ROOM_RECOVERY_MS } : null);
      }
    }).catch((error) => console.warn("Could not restore voice recovery:", error))
      .finally(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; };
  }, [userId, write]);

  const remember = useCallback((next: VoiceRecovery) => {
    changed.current = true;
    write(next);
  }, [write]);

  const forget = useCallback((roomId?: string, callId?: string) => {
    if (roomId && current.current?.roomId !== roomId) return;
    if (callId && current.current?.direct?.callId !== callId) return;
    changed.current = true;
    write(null);
  }, [write]);

  useEffect(() => {
    if (!record) return;
    const timer = setTimeout(() => {
      if (current.current === record) forget();
    }, Math.max(0, record.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [record, forget]);

  return { record, ready, remember, forget };
}
