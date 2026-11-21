import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, FilePlus, Mic, Paperclip } from "lucide-react";
import { MODAL_LAYER_Z } from "../../../components/ModalLayer";
import { useTheme } from "../../../theme/ThemeContext";

export default function ComposerAttachmentMenu({
  disabled, disabledReason, canRecord, buttonSize, buttonRadius, iconSize, onAttach, onRecord, onCamera,
}: {
  disabled: boolean;
  disabledReason?: string;
  canRecord: boolean;
  buttonSize: number;
  buttonRadius: number;
  iconSize: number;
  onAttach: () => void;
  onRecord: () => void;
  onCamera?: () => void;
}) {
  const { palette, typography, spacing } = useTheme();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const shown = open && !disabled;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!shown) return;
    function place() {
      const rect = trigger.current?.getBoundingClientRect();
      const row = trigger.current?.parentElement?.getBoundingClientRect();
      const width = menu.current?.offsetWidth;
      if (!rect || !row || !width) return;
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: window.innerHeight - row.top + 8,
      });
    }
    place();
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [shown]);

  const actions = [
    { label: "Attach a file", Icon: FilePlus, run: onAttach, disabled: false },
    { label: "Audio message", Icon: Mic, run: onRecord, disabled: !canRecord },
    { label: "Camera", Icon: Camera, run: onCamera, disabled: !onCamera },
  ];
  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        type="button"
        ref={trigger}
        title={disabledReason ?? "Add attachment"}
        aria-label={disabledReason ?? "Add attachment"}
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        style={{
          flexShrink: 0, display: "grid", placeItems: "center", padding: 0,
          width: buttonSize, height: buttonSize, marginLeft: spacing.unit * 2,
          border: 0, borderRadius: buttonRadius,
          background: shown ? palette.bgHover : "transparent", color: palette.textSecondary,
          cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.35 : 1,
        }}
      >
        <Paperclip size={iconSize} strokeWidth={2} aria-hidden="true" />
      </button>
      {shown && createPortal(
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label="Add attachment"
          data-pax-composer-popover
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }
              closeAndFocus();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
              const offset = event.key === "ArrowDown" ? 1 : -1;
              buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + offset + buttons.length) % buttons.length]?.focus();
            }
          }}
          style={{
            position: "fixed", ...position, zIndex: MODAL_LAYER_Z - 1000,
            minWidth: 208, maxWidth: "calc(100vw - 16px)", padding: spacing.unit,
            border: `1px solid ${palette.border}`, borderRadius: spacing.unit * 2,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)", background: palette.bgTertiary,
          }}
        >
          {actions.map(({ label, Icon, run, disabled: actionDisabled }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={actionDisabled}
              onClick={() => { closeAndFocus(); run?.(); }}
              onPointerEnter={(event) => {
                if (!actionDisabled && event.pointerType === "mouse") event.currentTarget.focus();
              }}
              style={{
                display: "flex", alignItems: "center", gap: spacing.unit * 2,
                width: "100%", minHeight: 44, padding: `${spacing.unit}px ${spacing.unit * 2}px`,
                background: "transparent", color: palette.textPrimary,
                border: 0, borderRadius: spacing.unit, textAlign: "left",
                fontFamily: typography.fontFamily, fontSize: typography.fontSizeBase,
                cursor: actionDisabled ? "default" : "pointer", opacity: actionDisabled ? 0.45 : 1,
              }}
            >
              <Icon size={17} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
