import { createContext, useContext } from "react";
import { ManualStatus } from "./usePresence";

interface PresenceContextValue {
  manualStatus: ManualStatus;
  setManualStatus: (status: ManualStatus) => void;
  effectivePresence: string;
}

export const PresenceContext = createContext<PresenceContextValue>({
  manualStatus: "auto",
  setManualStatus: () => {},
  effectivePresence: "online",
});

export function usePresenceContext() {
  return useContext(PresenceContext);
}