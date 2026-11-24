import { useEffect, useRef } from "react";
import type { CallStream } from "../utils/callVideoLayout";
import ScreenShareViewer from "./ScreenShareViewer";

export default function CallVideo({ stream, avatar = false }: { stream: CallStream; avatar?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const preview = stream.local && stream.source === "camera" ? stream.media : null;
  useEffect(() => {
    const video = ref.current;
    if (!video || !preview) return;
    video.srcObject = preview;
    return () => { video.srcObject = null; };
  }, [preview]);

  if (!stream.local) {
    return <ScreenShareViewer key={stream.streamId} active identity={stream.streamId} camera={stream.source === "camera"} avatar={avatar} />;
  }
  if (!preview) return null;
  return <video ref={ref} autoPlay muted playsInline aria-label="Your camera"
    style={{ display: "block", width: "100%", height: "100%", objectFit: avatar ? "cover" : "contain", transform: "scaleX(-1)" }} />;
}
