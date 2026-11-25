interface AndroidMessagePreviews {
  getShowMessagePreviews(): boolean;
  setShowMessagePreviews(enabled: boolean): void;
  showMessageNotification(roomId: string, eventId: string, sender: string, roomLabel: string | null, message: string | null): void;
}

export function androidMessagePreviews(): AndroidMessagePreviews | undefined {
  const bridge = (window as Window & { PaxAndroid?: AndroidMessagePreviews }).PaxAndroid;
  if (typeof bridge?.getShowMessagePreviews === "function" && typeof bridge.setShowMessagePreviews === "function") {
    return bridge;
  }
}
