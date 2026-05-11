import { createPortal } from "react-dom";
import type { RefObject } from "react";
import type {
  ResolvedColorScheme,
  ThemePalette,
  ThemeSpacing,
  ThemeTypography,
} from "../../../theme/types";
import GiphyPicker from "./GiphyPicker";

export type ComposerPickerTab = "emoji" | "gif";

interface ComposerMediaPickerPopoverProps {
  open: boolean;
  popoverPos: { bottom: number; right: number } | null;
  pickerTab: ComposerPickerTab;
  emojiPickerMountRef: RefObject<HTMLDivElement | null>;
  giphyApiKey: string;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  resolvedColorScheme: ResolvedColorScheme;
  zIndex: number;
  onPickerTabChange: (tab: ComposerPickerTab) => void;
  onGifSelect: (gifUrl: string) => void;
}

function fixedPopoverStyle(bottom: number, right: number, zIndex: number) {
  return {
    position: "fixed" as const,
    bottom,
    right,
    zIndex,
  };
}

export default function ComposerMediaPickerPopover({
  open,
  popoverPos,
  pickerTab,
  emojiPickerMountRef,
  giphyApiKey,
  palette,
  typography,
  spacing,
  resolvedColorScheme,
  zIndex,
  onPickerTabChange,
  onGifSelect,
}: ComposerMediaPickerPopoverProps) {
  if (!open || !popoverPos) return null;

  return createPortal(
    <div
      data-pax-composer-popover
      style={{
        ...fixedPopoverStyle(popoverPos.bottom, popoverPos.right, zIndex),
        borderRadius: spacing.unit * 2,
        overflow: "hidden",
        border: `1px solid ${palette.border}`,
        boxShadow:
          resolvedColorScheme === "light"
            ? `0 8px 28px rgba(0,0,0,0.12), 0 0 0 1px ${palette.border} inset`
            : "0 12px 44px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset",
        backgroundColor: palette.bgTertiary,
        display: "flex",
        flexDirection: "column",
        width: 352,
      }}
    >
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${palette.border}`,
          flexShrink: 0,
        }}
      >
        {(["emoji", "gif"] as const).map((tab) => {
          const active = pickerTab === tab;
          return (
            <button
              key={tab}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPickerTabChange(tab)}
              style={{
                flex: 1,
                padding: `${spacing.unit * 2}px 0`,
                border: "none",
                borderBottom: `2px solid ${active ? palette.textPrimary : "transparent"}`,
                backgroundColor: "transparent",
                color: active ? palette.textPrimary : palette.textSecondary,
                fontSize: typography.fontSizeSmall,
                fontWeight: active
                  ? typography.fontWeightBold
                  : typography.fontWeightNormal,
                fontFamily: typography.fontFamily,
                cursor: "pointer",
                letterSpacing: "0.03em",
                transition: "color 0.1s, border-color 0.1s",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = palette.textPrimary;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.color = palette.textSecondary;
              }}
            >
              {tab === "emoji" ? "Emoji" : "GIF"}
            </button>
          );
        })}
      </div>

      {/* Both panels stay mounted so the imperative emoji picker DOM remains stable. */}
      <div
        ref={emojiPickerMountRef}
        style={{ display: pickerTab === "emoji" ? "block" : "none" }}
      />
      <div style={{ display: pickerTab === "gif" ? "block" : "none" }}>
        {giphyApiKey ? (
          <GiphyPicker
            palette={palette}
            typography={typography}
            spacing={spacing}
            apiKey={giphyApiKey}
            onGifSelect={onGifSelect}
          />
        ) : (
          <div
            style={{
              padding: spacing.unit * 3,
              color: palette.textSecondary,
              fontSize: typography.fontSizeBase * 0.9,
              lineHeight: typography.lineHeight,
            }}
          >
            Add <code style={{ color: palette.textPrimary }}>GIPHY_API_KEY</code> to your .env
            to search GIPHY GIFs (free key from developers.giphy.com).
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
