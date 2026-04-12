import { createContext, useContext } from "react";
import { ManualStatus } from "./usePresence";

interface PresenceContextValue {
  manualStatus: ManualStatus;
  setManualStatus: (status: ManualStatus) => void;
  effectivePresence: string;
  statusMessage: string;
  setStatusMessage: (msg: string) => void;
}

export const PresenceContext = createContext<PresenceContextValue>({
  manualStatus: "auto",
  setManualStatus: () => {},
  effectivePresence: "online",
  statusMessage: "",
  setStatusMessage: () => {},
});

export function usePresenceContext() {
  return useContext(PresenceContext);
}