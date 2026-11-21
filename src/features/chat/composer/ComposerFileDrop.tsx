import { useLayoutEffect, useState } from "react";
import { FileUp } from "lucide-react";
import ModalLayer from "../../../components/ModalLayer";
import { useTheme } from "../../../theme/ThemeContext";

export default function ComposerFileDrop({ onFile }: { onFile?: (file: File) => Promise<void> }) {
  const [dragTarget, setDragTarget] = useState<EventTarget | null>(null);
  const { palette, spacing, typography } = useTheme();

  useLayoutEffect(() => {
    function clearDrag() {
      setDragTarget(null);
    }

    function handleDragOver(event: DragEvent) {
      const transfer = event.dataTransfer;
      if (!transfer?.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      transfer.dropEffect = onFile ? "copy" : "none";
      setDragTarget(event.target);
    }

    function handleDragLeave(event: DragEvent) {
      // Entering a new element fires dragenter before dragleave on the old one.
      const { target } = event;
      setDragTarget((current) => current === target ? null : current);
    }

    function handleDrop(event: DragEvent) {
      clearDrag();
      const transfer = event.dataTransfer;
      if (!transfer?.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!onFile) return;
      const file = transfer.files[0];
      const item = Array.from(transfer.items).find((entry) => entry.kind === "file");
      if (file && !item?.webkitGetAsEntry?.()?.isDirectory) void onFile(file);
    }

    window.addEventListener("dragenter", handleDragOver, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", handleDrop, true);
    window.addEventListener("blur", clearDrag);
    return () => {
      window.removeEventListener("dragenter", handleDragOver, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", handleDrop, true);
      window.removeEventListener("blur", clearDrag);
    };
  }, [onFile]);

  if (!dragTarget) return null;

  return (
    <ModalLayer backdropStyle={{
      display: "grid",
      placeItems: "center",
      backgroundColor: onFile ? "rgba(0, 0, 0, 0.25)" : "transparent",
      // Keep file drags in this document when they cross an iframe or media control.
      pointerEvents: "auto",
      zIndex: 60_000,
    }}>
      {onFile && (
        <div role="status" style={{
          display: "grid",
          justifyItems: "center",
          gap: spacing.unit * 2,
          padding: `${spacing.unit * 4}px ${spacing.unit * 6}px`,
          border: `1px solid ${palette.border}`,
          borderRadius: spacing.unit * 2,
          backgroundColor: palette.bgSecondary,
          color: palette.textPrimary,
          fontSize: typography.fontSizeBase,
          fontWeight: typography.fontWeightBold,
          pointerEvents: "none",
        }}>
          <FileUp size={32} aria-hidden="true" />
          Drop to attach file
        </div>
      )}
    </ModalLayer>
  );
}
