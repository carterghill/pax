import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { acquireMatrixMedia } from "../features/chat/media";
import { useTheme } from "../theme/ThemeContext";

const IS_LINUX_DESKTOP =
  navigator.userAgent.includes("Linux") && !navigator.userAgent.includes("Android");

export default function MessageMatrixAudio({ request, fileName }: { request: unknown; fileName: string }) {
  const requestKey = JSON.stringify(request);
  return <AudioPlayer key={requestKey} requestKey={requestKey} fileName={fileName} />;
}

function AudioPlayer({ requestKey, fileName }: { requestKey: string; fileName: string }) {
  const { palette, typography } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = container.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const media = acquireMatrixMedia(JSON.parse(requestKey));
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void media.path.then(async (path) => {
      if (controller.signal.aborted) return;
      const assetUrl = convertFileSrc(path);
      if (!IS_LINUX_DESKTOP) {
        setSrc(assetUrl);
        return;
      }

      // WebKitGTK can fetch Tauri assets but can reject their byte-range reads
      // from an HTML media element. A Blob URL lets WebKit handle the ranges.
      const response = await fetch(assetUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Audio asset returned HTTP ${response.status}`);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      media.dispose();
    };
  }, [requestKey, visible]);

  return (
    <div ref={container} style={{ minHeight: 40, display: "flex", alignItems: "center" }}>
      {src && !failed ? (
        <audio
          src={src}
          controls
          preload="metadata"
          aria-label={`Play ${fileName}`}
          onError={() => setFailed(true)}
          style={{ width: 300, maxWidth: "100%" }}
        />
      ) : (
        <span style={{ color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>
          {failed ? "Could not play audio" : "Loading audio…"}
        </span>
      )}
    </div>
  );
}
