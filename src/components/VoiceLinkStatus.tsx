import { Loader2, WifiOff } from "lucide-react";
import type { VoiceParticipantState } from "../hooks/useVoiceParticipantStates";

export default function VoiceLinkStatus({ status }: { status?: VoiceParticipantState["status"] }) {
  if (status === "lost") {
    return <span role="img" aria-label="Connection lost" title="Connection lost" style={{ display: "inline-flex" }}>
      <WifiOff size={12} aria-hidden="true" />
    </span>;
  }
  if (status === "connecting") {
    return <span role="img" aria-label="Connecting" title="Connecting" style={{ display: "inline-flex" }}>
      <Loader2 size={12} aria-hidden="true" style={{ animation: "spin 1s linear infinite" }} />
    </span>;
  }
  return null;
}
