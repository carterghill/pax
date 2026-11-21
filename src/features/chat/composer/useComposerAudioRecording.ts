import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getStoredAudioDevicePreferences,
  requestMicrophonePermission,
} from "../../../hooks/useVoiceAudioDevices";
import { formatInvokeErr } from "../formatInvokeErr";

type Recording = { phase: "starting" | "stopping" } | {
  phase: "recording";
  startedAt: number;
  limitSeconds: number;
};

export interface RecordedAudio {
  uploadId: string;
  path: string;
  byteSize: number;
  durationMs: number;
}

function cancelNative(recordingId: string) {
  return invoke("cancel_audio_recording", { recordingId }).catch(() => {});
}

export function useComposerAudioRecording({ scope, enabled, onRecorded }: {
  scope: string;
  enabled: boolean;
  onRecorded: (audio: RecordedAudio) => boolean;
}) {
  const activeId = useRef<string | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const discard = useCallback(() => {
    const recordingId = activeId.current;
    activeId.current = null;
    if (recordingId) void cancelNative(recordingId);
  }, []);

  const cancel = useCallback(() => {
    discard();
    setRecording(null);
  }, [discard]);

  useEffect(() => {
    setRecording(null);
    setError(null);
    return discard;
  }, [scope, discard]);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const start = useCallback(async () => {
    if (!enabled || activeId.current) return;
    const recordingId = crypto.randomUUID();
    activeId.current = recordingId;
    setError(null);
    setElapsedSeconds(0);
    setRecording({ phase: "starting" });

    try {
      await requestMicrophonePermission();
      if (activeId.current !== recordingId) return;
      const { inputDeviceId } = getStoredAudioDevicePreferences();
      const limitSeconds = await invoke<number>("start_audio_recording", { recordingId, inputDeviceId });
      if (activeId.current !== recordingId) {
        void cancelNative(recordingId);
        return;
      }
      setRecording({ phase: "recording", limitSeconds, startedAt: Date.now() });
    } catch (err) {
      if (activeId.current !== recordingId) return;
      cancel();
      setError(formatInvokeErr(err));
    }
  }, [enabled, cancel]);

  const stop = useCallback(async () => {
    const recordingId = activeId.current;
    if (!recordingId || recording?.phase !== "recording") return;
    setRecording({ phase: "stopping" });
    try {
      const audio = await invoke<RecordedAudio>("stop_audio_recording", { recordingId });
      if (activeId.current !== recordingId) return;
      if (!onRecorded(audio)) throw new Error("Remove the current attachment before adding a recording.");
      activeId.current = null;
      setRecording(null);
    } catch (err) {
      if (activeId.current === recordingId) setError(formatInvokeErr(err));
    } finally {
      if (activeId.current === recordingId) cancel();
    }
  }, [cancel, onRecorded, recording]);

  useEffect(() => {
    if (recording?.phase !== "recording") return;
    const { startedAt, limitSeconds } = recording;
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(Math.min(elapsed, limitSeconds));
      if (elapsed >= limitSeconds) {
        window.clearInterval(timer);
        void stop();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording, stop]);

  return { phase: recording?.phase, elapsedSeconds, error, start, stop, cancel };
}
