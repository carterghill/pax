import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";

interface MessageInputProps {
  roomId: string;
  roomName: string;
  onMessageSent: () => void;
}

export default function MessageInput({ roomId, roomName, onMessageSent }: MessageInputProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const { palette, typography, spacing } = useTheme();

  // Send typing notice with a 3-second cooldown
  const sendTyping = useCallback((typing: boolean) => {
    if (typing === isTyping.current) return;
    isTyping.current = typing;
    invoke("send_typing_notice", { roomId, typing }).catch(() => {});
  }, [roomId]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);

    if (val.trim().length > 0) {
      sendTyping(true);
      // Reset the stop-typing timer
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => sendTyping(false), 3000);
    } else {
      sendTyping(false);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    }
  }

  // Clear typing state on room change or unmount
  useEffect(() => {
    return () => {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (isTyping.current) {
        invoke("send_typing_notice", { roomId, typing: false }).catch(() => {});
        isTyping.current = false;
      }
    };
  }, [roomId]);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    // Stop typing indicator immediately on send
    sendTyping(false);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);

    setSending(true);
    try {
      await invoke("send_message", { roomId, body: trimmed });
      setText("");
      onMessageSent();
      inputRef.current?.focus();
    } catch (e) {
      console.error("Failed to send:", e);
    }
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div style={{ padding: `0 ${spacing.unit * 3}px ${spacing.unit * 3}px` }}>
      <div style={{
        backgroundColor: palette.bgActive,
        borderRadius: spacing.unit * 1.5,
        display: "flex",
        alignItems: "flex-end",
      }}>
        <textarea
          ref={inputRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={`Message #${roomName}`}
          rows={1}
          style={{
            flex: 1,
            background: "none",
            border: "none",
            outline: "none",
            color: palette.textPrimary,
            fontSize: typography.fontSizeBase,
            fontFamily: typography.fontFamily,
            lineHeight: typography.lineHeight,
            padding: `${spacing.unit * 3}px ${spacing.unit * 4}px`,
            resize: "none",
            maxHeight: 200,
            overflowY: "auto",
          }}
        />
      </div>
    </div>
  );
}