import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CAMERA_FRAME_RATE, openCallCamera, type LocalCameraPreview } from "../utils/callCameraCapture";

const STILL_REFRESH_MS = 30_000;
const VIEWER_STARTUP_MS = 3_000;
const VIEWER_FRAME_MS = 200;

export interface CameraTransport {
  start: (callId: string, cameraId: string, width: number, height: number, jpeg: string, signal: AbortSignal) => Promise<void>;
  frame: (callId: string, cameraId: string, jpeg: string) => Promise<void>;
  stop: (callId: string, cameraId: string) => Promise<void>;
}

const livekit: CameraTransport = {
  start: (attemptId, cameraId, width, height, jpeg) =>
    invoke("voice_start_camera", { attemptId, cameraId, width, height, jpeg }),
  frame: (_, cameraId, jpeg) => invoke("voice_camera_frame", { cameraId, jpeg }),
  stop: (_, cameraId) => invoke("voice_stop_camera", { cameraId }),
};

/** Own capture at call scope so switching rooms or moving a tile keeps the same camera. */
export function useCallCamera(callId: string | null, transport = livekit) {
  const active = useRef<AbortController | null>(null);
  const closing = useRef<Promise<void>>(Promise.resolve());
  const [localCamera, setLocalCamera] = useState<LocalCameraPreview | null>(null);
  const [cameraPending, setPending] = useState(false);
  const [cameraError, setError] = useState<string | null>(null);
  const viewerNeedsFrame = useRef(false);
  const refreshCamera = useCallback(() => {
    viewerNeedsFrame.current = true;
  }, []);

  const stop = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setLocalCamera(null);
    setPending(false);
  }, []);

  useLayoutEffect(() => {
    setError(null);
    return stop;
  }, [callId, stop]);

  const startCamera = useCallback(async () => {
    if (active.current || !callId) return;
    setError(null);
    const controller = new AbortController();
    const { signal } = controller;
    active.current = controller;
    setPending(true);
    const cameraId = crypto.randomUUID();
    let publish: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      if (publish) {
        closing.current = publish.catch(() => {}).then(() => transport.stop(callId, cameraId))
          .catch((error) => console.warn("Could not unpublish camera:", error));
      }
    }, { once: true });

    const fail = (message: string) => {
      if (signal.aborted) return;
      stop();
      setError(message);
    };

    try {
      const capture = await openCallCamera(signal);
      await closing.current;
      if (signal.aborted) return;
      const first = await capture.readFrame();
      if (signal.aborted) return;
      publish = transport.start(callId, cameraId, capture.width, capture.height, first.jpeg, signal);
      await publish;
      if (signal.aborted) return;
      let preview = first.preview;
      setLocalCamera(preview);
      setPending(false);
      let lastSent = performance.now();
      let refreshUntil = lastSent + VIEWER_STARTUP_MS;

      // Keep at most one frame in flight, including encoding and native publication.
      const send = async () => {
        const start = performance.now();
        try {
          const frame = await capture.readFrame();
          if (signal.aborted) return;
          const still = "error" in frame.preview;
          if (viewerNeedsFrame.current || (still && !("error" in preview))) {
            refreshUntil = start + VIEWER_STARTUP_MS;
            viewerNeedsFrame.current = false;
          }
          if (!still || start < refreshUntil || start - lastSent >= STILL_REFRESH_MS) {
            await transport.frame(callId, cameraId, frame.jpeg);
            if (signal.aborted) return;
            lastSent = start;
          }
          if (preview !== frame.preview) {
            preview = frame.preview;
            setLocalCamera(preview);
          }
          // Check for camera recovery and new viewers even while the outgoing still is idle.
          const stillInterval = start < refreshUntil ? VIEWER_FRAME_MS : 1000;
          const interval = still ? stillInterval : 1000 / CAMERA_FRAME_RATE;
          timer = setTimeout(send, Math.max(0, interval - (performance.now() - start)));
        } catch (error) {
          fail(String(error));
        }
      };
      timer = setTimeout(send, 1000 / CAMERA_FRAME_RATE);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }, [callId, stop, transport]);

  const toggleCamera = useCallback(() => active.current ? stop() : startCamera(), [startCamera, stop]);
  return { localCamera, cameraPending, cameraError, startCamera, toggleCamera, refreshCamera };
}
