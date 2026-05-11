import { useCallback, useEffect, useRef } from "react";
import { sendTypingNotice } from "../api";

interface UseComposerTypingNoticeOptions {
  roomId: string;
  draftDmPeerUserId?: string | null;
  interactionLocked: boolean;
  editing: boolean;
  composerPermission: "loading" | "allowed" | "forbidden";
  onLocalTypingActive?: (active: boolean) => void;
}

interface ComposerActivity {
  text: string;
  hasMedia: boolean;
}

export function useComposerTypingNotice({
  roomId,
  draftDmPeerUserId = null,
  interactionLocked,
  editing,
  composerPermission,
  onLocalTypingActive,
}: UseComposerTypingNoticeOptions) {
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const lastTypingSentAt = useRef(0);
  const interactionLockedRef = useRef(interactionLocked);
  interactionLockedRef.current = interactionLocked;

  const clearTypingTimeout = useCallback(() => {
    if (typingTimeout.current) {
      clearTimeout(typingTimeout.current);
      typingTimeout.current = null;
    }
  }, []);

  const sendTyping = useCallback(
    (typing: boolean, options?: { force?: boolean }) => {
      if (draftDmPeerUserId) return;
      if (interactionLockedRef.current && !options?.force) return;

      if (typing) {
        const now = Date.now();
        if (isTyping.current && now - lastTypingSentAt.current < 3000) return;
        lastTypingSentAt.current = now;
        if (!isTyping.current) {
          isTyping.current = true;
          onLocalTypingActive?.(true);
        }
        sendTypingNotice({ roomId, typing: true }).catch(() => {});
      } else {
        if (!isTyping.current) return;
        isTyping.current = false;
        lastTypingSentAt.current = 0;
        onLocalTypingActive?.(false);
        sendTypingNotice({ roomId, typing: false }).catch(() => {});
      }
    },
    [roomId, onLocalTypingActive, draftDmPeerUserId],
  );

  const handleComposerActivity = useCallback(
    ({ text, hasMedia }: ComposerActivity) => {
      if (editing) return;
      if (draftDmPeerUserId) return;

      if (text.trim().length > 0 || hasMedia) {
        sendTyping(true);
        clearTypingTimeout();
        typingTimeout.current = setTimeout(() => {
          sendTyping(false);
        }, 3000);
      } else {
        sendTyping(false);
        clearTypingTimeout();
      }
    },
    [clearTypingTimeout, draftDmPeerUserId, editing, sendTyping],
  );

  useEffect(() => {
    return () => {
      if (draftDmPeerUserId) return;
      clearTypingTimeout();
      if (isTyping.current) {
        sendTypingNotice({ roomId, typing: false }).catch(() => {});
        isTyping.current = false;
        onLocalTypingActive?.(false);
      }
    };
  }, [clearTypingTimeout, roomId, onLocalTypingActive, draftDmPeerUserId]);

  useEffect(() => {
    if (!editing) return;
    clearTypingTimeout();
    sendTyping(false);
  }, [clearTypingTimeout, editing, sendTyping]);

  useEffect(() => {
    if (draftDmPeerUserId) return;
    if (composerPermission !== "forbidden") return;
    clearTypingTimeout();
    sendTyping(false, { force: true });
  }, [clearTypingTimeout, composerPermission, draftDmPeerUserId, sendTyping]);

  return {
    clearTypingTimeout,
    handleComposerActivity,
    sendTyping,
  };
}
