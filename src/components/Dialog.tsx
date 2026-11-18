import { createContext, useContext, useLayoutEffect, useRef, type CSSProperties, type HTMLAttributes, type RefObject } from "react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogOuterBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";

interface DialogProps extends HTMLAttributes<HTMLDivElement> {
  onClose: () => void;
  backdropStyle?: CSSProperties;
}

type PanelRef = RefObject<HTMLDivElement | null>;
const DialogParent = createContext<PanelRef | null>(null);
const openDialogs: { ref: PanelRef; parent: PanelRef | null }[] = [];
const focusableSelector = "a[href],button,input,select,textarea,[tabindex],[contenteditable='true']";

/** Shared dismissal, focus and accessibility behavior for app dialogs. */
export default function Dialog({ onClose, children, style, backdropStyle, ...props }: DialogProps) {
  const { palette, typography } = useTheme();
  const parent = useContext(DialogParent);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(typeof document === "undefined" ? null : document.activeElement);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const startedOnBackdrop = useRef(true);
  useOverlayObstruction(panelRef);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const entry = { ref: panelRef, parent };
    // Child layout effects run first; insert a parent below its already-mounted children.
    const childIndex = openDialogs.findIndex((dialog) => dialog.parent === panelRef);
    openDialogs.splice(childIndex < 0 ? openDialogs.length : childIndex, 0, entry);
    // Focus the panel without highlighting a control or drawing a native outline.
    if (openDialogs[openDialogs.length - 1] === entry) panel.focus({ preventScroll: true });

    const handleKey = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== entry) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const controls = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
          .filter((control) => control.tabIndex >= 0 && !control.matches(":disabled,[hidden],[inert] *") && control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) {
          event.preventDefault();
          panel.focus({ preventScroll: true });
        } else if (!panel.contains(document.activeElement) || document.activeElement === panel) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      const wasTop = openDialogs[openDialogs.length - 1] === entry;
      openDialogs.splice(openDialogs.indexOf(entry), 1);
      if (wasTop) {
        const next = openDialogs[openDialogs.length - 1]?.ref.current;
        const previous = previousFocus.current;
        if (previous instanceof HTMLElement && previous.isConnected && (!next || next.contains(previous))) {
          previous.focus({ preventScroll: true });
        } else {
          next?.focus({ preventScroll: true });
        }
      }
    };
  }, []);

  return (
    <DialogParent.Provider value={panelRef}>
      <ModalLayer
        onBackdropPointerDown={(event) => { startedOnBackdrop.current = event.target === event.currentTarget; }}
        onBackdropClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget && startedOnBackdrop.current && openDialogs[openDialogs.length - 1]?.ref === panelRef) {
            onClose();
          }
        }}
        backdropStyle={{
          backgroundColor: "rgba(0,0,0,0.7)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          ...backdropStyle,
        }}
      >
        <div
          {...props}
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          style={{
            backgroundColor: palette.bgSecondary,
            color: palette.textPrimary,
            fontFamily: typography.fontFamily,
            border: paletteDialogOuterBorderStyle(palette),
            borderRadius: 12,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "85vh",
            overflow: "auto",
            boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
            ...style,
            outline: "none",
          }}
        >
          {children}
        </div>
      </ModalLayer>
    </DialogParent.Provider>
  );
}
