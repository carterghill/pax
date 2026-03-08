import { useState, useRef } from "react";
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
  const { palette, typography, spacing } = useTheme();

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

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
          onChange={(e) => setText(e.target.value)}
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