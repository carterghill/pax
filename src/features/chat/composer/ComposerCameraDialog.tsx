import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Camera, Check, RotateCcw, X } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { useTheme } from "../../../theme/ThemeContext";

function cameraErrorMessage(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was denied. Check your camera permissions and try again.";
  }
  if (name === "NotFoundError") return "No camera was found.";
  return "Couldn’t open the camera. Check that it’s available and try again.";
}

type PhotoPreview = {
  file: File;
  url: string;
  status: "loading" | "ready" | "error";
};

export default function ComposerCameraDialog({
  nativePhoto, onRetryNative, onAccept, onClose,
}: {
  nativePhoto: File | null;
  onRetryNative?: () => void;
  onAccept: (photo: File) => void;
  onClose: () => void;
}) {
  const { palette, spacing, typography } = useTheme();
  const headingId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [desktopPhoto, setDesktopPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<PhotoPreview | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const photo = nativePhoto ?? desktopPhoto;
  const shownPreview = preview?.file === photo ? preview : null;
  const error = photo
    ? shownPreview?.status === "error" ? "Couldn’t preview this photo." : null
    : cameraError;

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    const status = photo.type.startsWith("image/") && photo.size > 0 ? "loading" : "error";
    setPreview({ file: photo, url, status });
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || photo || cameraError) return;
    let disposed = false;
    let stream: MediaStream | undefined;

    function handleCameraEnded() {
      setCameraError("The camera disconnected. Reconnect it and try again.");
    }

    async function startCamera() {
      if (disposed || !video) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("Camera access is unavailable on this device.");
        return;
      }
      try {
        const openedStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (disposed) {
          openedStream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = openedStream;
        stream.getVideoTracks().forEach((track) => track.addEventListener("ended", handleCameraEnded));
        video.srcObject = stream;
        await video.play();
      } catch (err) {
        if (!disposed) setCameraError(cameraErrorMessage(err));
      }
    }

    // Let effect cleanup cancel startup if the dialog was removed before opening the camera.
    queueMicrotask(() => void startCamera());
    return () => {
      disposed = true;
      video.srcObject = null;
      stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", handleCameraEnded);
        track.stop();
      });
    };
  }, [photo, cameraError]);

  async function takePhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight || capturing) return;
    setCapturing(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Could not encode photo");
      if (video.isConnected) setDesktopPhoto(new File([blob], "Camera photo.jpg", { type: "image/jpeg" }));
    } catch {
      if (video.isConnected) setCameraError("Couldn’t take a photo. Try again.");
    } finally {
      if (video.isConnected) setCapturing(false);
    }
  }

  function retry() {
    if (onRetryNative) {
      onRetryNative();
      return;
    }
    setCameraError(null);
    setVideoReady(false);
    setCapturing(false);
    setDesktopPhoto(null);
  }

  const button: CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: spacing.unit * 1.5,
    minHeight: 44, padding: `0 ${spacing.unit * 3}px`,
    border: `1px solid ${palette.border}`, borderRadius: spacing.unit * 1.5,
    background: palette.bgTertiary, color: palette.textPrimary,
    font: "inherit", cursor: "pointer",
  };
  const frame: CSSProperties = {
    display: "block", width: "100%", maxHeight: "min(56dvh, 420px)",
    objectFit: "contain", background: "#000", borderRadius: spacing.unit * 1.5,
  };
  const canAccept = shownPreview?.status === "ready";
  const canTakePhoto = videoReady && !capturing;

  return (
    <Dialog onClose={onClose} aria-labelledby={headingId} style={{ width: 560, maxHeight: "calc(100dvh - 32px)" }}>
      <div style={{ padding: spacing.unit * 4, display: "grid", gap: spacing.unit * 3 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id={headingId} style={{ margin: 0, fontSize: typography.fontSizeLarge }}>
            {photo ? "Photo preview" : "Camera"}
          </h2>
          <button type="button" title="Cancel" aria-label="Cancel camera" onClick={onClose} style={{ ...button, width: 44, padding: 0 }}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        {!onRetryNative && !photo && !error && (
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            aria-label="Live camera preview"
            onPlaying={() => setVideoReady(true)}
            style={{ ...frame, aspectRatio: "16 / 9" }}
          />
        )}
        {shownPreview && !error && (
          <img
            key={shownPreview.url}
            src={shownPreview.url}
            alt="Captured photo"
            onLoad={() => setPreview((current) => current === shownPreview ? { ...current, status: "ready" } : current)}
            onError={() => setPreview((current) => current === shownPreview ? { ...current, status: "error" } : current)}
            style={frame}
          />
        )}
        {error && <span role="alert">{error}</span>}
        {!photo && !videoReady && !error && <span role="status">Starting camera…</span>}

        <div style={{ display: "flex", gap: spacing.unit * 2, justifyContent: "flex-end" }}>
          {(photo || error) && (
            <button type="button" onClick={retry} style={button}>
              <RotateCcw size={16} aria-hidden="true" /> Retry
            </button>
          )}
          {photo ? (
            <button
              type="button" disabled={!canAccept}
              onClick={() => onAccept(photo)}
              style={{ ...button, borderColor: palette.accent, opacity: canAccept ? 1 : 0.5 }}
            >
              <Check size={18} aria-hidden="true" /> Accept
            </button>
          ) : !error && (
            <button
              type="button" disabled={!canTakePhoto}
              onClick={() => void takePhoto()}
              style={{ ...button, borderColor: palette.accent, opacity: canTakePhoto ? 1 : 0.5 }}
            >
              <Camera size={18} aria-hidden="true" /> Take photo
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
