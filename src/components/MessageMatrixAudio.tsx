import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { acquireMatrixMedia } from "../features/chat/media";
import { useTheme } from "../theme/ThemeContext";

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
    let disposed = false;
    void media.path.then((path) => {
      if (!disposed) setSrc(convertFileSrc(path));
    }).catch(() => {
      if (!disposed) setFailed(true);
    });
    return () => {
      disposed = true;
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
