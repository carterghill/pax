import type { Message } from "../../../types/matrix";
export function acknowledgedUnavailableIds(messages: readonly Message[], acknowledgedIds: readonly string[], throughEventId: string | null, latestEventId: string | null): string[];
export function unavailableReceiptPolicy(messages: readonly Message[], userId: string, acknowledgedIds: readonly string[] | null): {
  privateOnly: boolean;
  blocked: boolean;
};
