import { createContext, useContext } from "react";
import { ManualStatus } from "./usePresence";

interface PresenceContextValue {
  manualStatus: ManualStatus;
  setManualStatus: (status: ManualStatus) => void;
}

export const PresenceContext = createContext<PresenceContextValue>({
  manualStatus: "auto",
  setManualStatus: () => {},
});

export function usePresenceContext() {
  return useContext(PresenceContext);
}