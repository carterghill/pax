import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const FRAME_RATE = 15;

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

function jpegFrame(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, video: HTMLVideoElement) {
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("Could not read the camera frame.")); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the camera frame."));
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.readAsDataURL(blob);
    }, "image/jpeg", 0.82);
  });
}

/** Own capture at call scope so switching rooms or moving a tile keeps the same camera. */
export function useCallCamera(callId: string | null, transport = livekit) {
  const active = useRef<AbortController | null>(null);
  const closing = useRef<Promise<void>>(Promise.resolve());
  const [localCamera, setLocalCamera] = useState<MediaStream | null>(null);
  const [cameraPending, setPending] = useState(false);
  const [cameraError, setError] = useState<string | null>(null);

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
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    let stream: MediaStream | undefined;
    let publish: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
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
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable on this device.");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: FRAME_RATE, max: FRAME_RATE } },
      });
      if (signal.aborted) { stream.getTracks().forEach((t) => t.stop()); return; }
      const [track] = stream.getVideoTracks();
      track.addEventListener("ended", () => fail("The camera disconnected."), { signal });
      video.srcObject = stream;
      await video.play();
      await closing.current;
      if (signal.aborted) return;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(2, 2 * Math.floor(video.videoWidth * scale / 2));
      canvas.height = Math.max(2, 2 * Math.floor(video.videoHeight * scale / 2));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Camera capture is unavailable.");
      const jpeg = await jpegFrame(canvas, context, video);
      if (signal.aborted) return;
      publish = transport.start(callId, cameraId, canvas.width, canvas.height, jpeg, signal);
      await publish;
      if (signal.aborted) return;
      setLocalCamera(stream);
      setPending(false);

      // Keep at most one frame in flight, including encoding and native publication.
      const send = async () => {
        const start = performance.now();
        try {
          const jpeg = await jpegFrame(canvas, context, video);
          if (signal.aborted) return;
          await transport.frame(callId, cameraId, jpeg);
          if (!signal.aborted) timer = setTimeout(send, Math.max(0, 1000 / FRAME_RATE - (performance.now() - start)));
        } catch (error) {
          fail(String(error));
        }
      };
      timer = setTimeout(send, 1000 / FRAME_RATE);
    } catch (error) {
      fail(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Camera access was denied. Allow camera access and try again."
        : error instanceof Error ? error.message : String(error));
    }
  }, [callId, stop, transport]);

  const toggleCamera = useCallback(() => active.current ? stop() : startCamera(), [startCamera, stop]);
  return { localCamera, cameraPending, cameraError, startCamera, toggleCamera };
}
