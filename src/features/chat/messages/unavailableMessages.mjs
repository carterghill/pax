/** Missing plaintext is availability information, never proof of a read. */
export function unavailableReceiptPolicy(messages, userId, acknowledgedIds) {
  const unavailable = messages.filter((message) => message.decryptionFailed === true);
  const acknowledged = new Set(acknowledgedIds ?? []);
  return {
    privateOnly: unavailable.length > 0,
    blocked: unavailable.some((message) => message.sender !== userId && !acknowledged.has(message.eventId)),
  };
}

/** A room-menu clear covers the current window only at the same known head. */
export function acknowledgedUnavailableIds(messages, acknowledgedIds, throughEventId, latestEventId) {
  const covered = typeof throughEventId === "string" && throughEventId === latestEventId
    ? messages.filter((message) => message.decryptionFailed).map((message) => message.eventId) : [];
  return [...new Set([...acknowledgedIds, ...covered])];
}
