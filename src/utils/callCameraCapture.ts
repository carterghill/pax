export const CAMERA_FRAME_RATE = 15;

export type LocalCameraPreview = MediaStream | { error: string };

interface CameraFrame {
  jpeg: string;
  preview: LocalCameraPreview;
}

function unavailableJpeg(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const { width, height } = canvas;
  const size = Math.min(width, height) / 3;
  context.fillStyle = "black";
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate((width - size) / 2, (height - size) / 2);
  context.scale(size / 24, size / 24);
  context.strokeStyle = "#b3b3b3";
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  // The same VideoOff glyph used by the call controls, embedded in the outgoing frame.
  context.stroke(new Path2D("M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196 M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2 M2 2l20 20"));
  context.restore();
  return canvas.toDataURL("image/jpeg").split(",")[1];
}

function encodeCameraFrame(canvas: HTMLCanvasElement) {
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

export async function openCallCamera(signal: AbortSignal) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | undefined;
  let captureError: string | undefined;
  const release = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    track = undefined;
    video.srcObject = null;
  };
  signal.addEventListener("abort", release, { once: true });
  const failCapture = (error: unknown) => {
    captureError ??= error instanceof Error ? error.message || error.name
      : typeof error === "string" && error ? error : "Could not capture camera video.";
    release();
  };

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable on this device.");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: CAMERA_FRAME_RATE, max: CAMERA_FRAME_RATE } },
    });
    signal.throwIfAborted();
    [track] = stream.getVideoTracks();
    if (track?.readyState === "live") {
      track.addEventListener("ended", () => failCapture("The camera disconnected."), { once: true, signal });
      video.addEventListener("error", () => failCapture(video.error?.message || "Camera playback failed."), { once: true, signal });
      video.srcObject = stream;
      // A stalled device may leave play() pending until it starts delivering frames.
      // Let the call publish the still in the meantime.
      await new Promise<void>((ready) => {
        const timer = setTimeout(ready, 1000);
        video.play().catch(failCapture).finally(() => { clearTimeout(timer); ready(); });
      });
    } else {
      failCapture(track ? "The camera disconnected." : "The camera did not provide a video track.");
    }
  } catch (error) {
    failCapture(error);
  }
  signal.throwIfAborted();

  // Native camera tracks keep their initial dimensions, including after device loss.
  const settings = track?.getSettings();
  const width = video.videoWidth || settings?.width || 640;
  const height = video.videoHeight || settings?.height || 480;
  const scale = Math.min(1, 640 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, 2 * Math.floor(width * scale / 2));
  canvas.height = Math.max(2, 2 * Math.floor(height * scale / 2));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Camera frame rendering is unavailable.");
  let stillJpeg: string | undefined;
  let unavailablePreview: { error: string } | undefined;

  const readFrame = async (): Promise<CameraFrame> => {
    if (stream && track?.readyState === "live" && !track.muted && video.readyState >= video.HAVE_CURRENT_DATA) {
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const jpeg = await encodeCameraFrame(canvas);
        if (stream && track.readyState === "live" && !track.muted) return { jpeg, preview: stream };
      } catch (error) {
        failCapture(error);
      }
    }
    const error = captureError ?? (track?.readyState === "ended" ? "The camera disconnected."
      : track?.muted ? "The camera is temporarily muted." : "Waiting for video from the camera.");
    if (unavailablePreview?.error !== error) unavailablePreview = { error };
    stillJpeg ??= unavailableJpeg(canvas, context);
    return { jpeg: stillJpeg, preview: unavailablePreview };
  };
  return { width: canvas.width, height: canvas.height, readFrame };
}
