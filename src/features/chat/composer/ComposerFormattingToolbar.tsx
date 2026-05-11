import { Fragment, type MouseEvent } from "react";
import { Type, type LucideIcon } from "lucide-react";
import type { ThemePalette, ThemeSpacing } from "../../../theme/types";

export type ComposerFormatItem = {
  icon: LucideIcon;
  label: string;
  run: () => void;
  formatKey?: string;
};

interface ComposerFormattingToggleProps {
  formatOpen: boolean;
  interactionLocked: boolean;
  palette: ThemePalette;
  spacing: ThemeSpacing;
  inputToolBtnSize: number;
  inputToolBtnRadius: number;
  inputToolIconSize: number;
  onToggleFormatOpen: () => void;
  onHoverToolButton: (
    event: MouseEvent<HTMLButtonElement>,
    active: boolean,
    entering: boolean,
  ) => void;
}

interface ComposerFormattingToolbarProps {
  formatOpen: boolean;
  formatGroups: ComposerFormatItem[][];
  activeFormats: Set<string>;
  palette: ThemePalette;
  spacing: ThemeSpacing;
  formatBtnGap: number;
  groupGap: number;
  inputToolBtnSize: number;
  inputToolBtnRadius: number;
  inputToolIconSize: number;
}

export function ComposerFormattingToggle({
  formatOpen,
  interactionLocked,
  palette,
  spacing,
  inputToolBtnSize,
  inputToolBtnRadius,
  inputToolIconSize,
  onToggleFormatOpen,
  onHoverToolButton,
}: ComposerFormattingToggleProps) {
  return (
    <button
      type="button"
      title="Text formatting"
      aria-expanded={formatOpen}
      aria-haspopup="menu"
      disabled={interactionLocked}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggleFormatOpen}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: inputToolBtnSize,
        height: inputToolBtnSize,
        padding: 0,
        margin: spacing.unit,
        marginLeft: 0,
        border: "none",
        borderRadius: inputToolBtnRadius,
        backgroundColor: formatOpen ? palette.bgHover : "transparent",
        color: formatOpen ? palette.textPrimary : palette.textSecondary,
        cursor: interactionLocked ? "default" : "pointer",
        opacity: interactionLocked ? 0.35 : 1,
      }}
      onMouseEnter={(e) => {
        if (interactionLocked) return;
        onHoverToolButton(e, formatOpen, true);
      }}
      onMouseLeave={(e) => {
        if (interactionLocked) return;
        onHoverToolButton(e, formatOpen, false);
      }}
    >
      <Type size={inputToolIconSize} strokeWidth={2} />
    </button>
  );
}

export default function ComposerFormattingToolbar({
  formatOpen,
  formatGroups,
  activeFormats,
  palette,
  spacing,
  formatBtnGap,
  groupGap,
  inputToolBtnSize,
  inputToolBtnRadius,
  inputToolIconSize,
}: ComposerFormattingToolbarProps) {
  if (!formatOpen) return null;

  return (
    <>
      <div
        aria-hidden
        style={{
          height: 1,
          marginLeft: spacing.unit * 2,
          marginRight: spacing.unit * 2,
          backgroundColor: palette.borderSecondary ?? palette.border,
          opacity: palette.borderSecondary ? 1 : 0.25,
        }}
      />
      <div
        role="toolbar"
        aria-label="Markdown formatting"
        style={{
          padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: formatBtnGap,
          columnGap: groupGap,
        }}
      >
        {formatGroups.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {groupIndex > 0 && (
              <div
                aria-hidden
                role="separator"
                style={{
                  width: 1,
                  height: inputToolBtnSize - spacing.unit * 0.75,
                  flexShrink: 0,
                  alignSelf: "center",
                  borderRadius: 1,
                  backgroundColor: palette.border,
                  opacity: 0.3,
                }}
              />
            )}
            <div
              style={{
                display: "flex",
                flexDirection: "row",
                flexWrap: "nowrap",
                alignItems: "center",
                gap: formatBtnGap,
              }}
            >
              {group.map(({ icon: Icon, label, run, formatKey }) => {
                const isActive = formatKey ? activeFormats.has(formatKey) : false;
                return (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    title={label}
                    aria-label={label}
                    aria-pressed={isActive}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={run}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: inputToolBtnSize,
                      height: inputToolBtnSize,
                      padding: 0,
                      border: "none",
                      borderRadius: inputToolBtnRadius,
                      backgroundColor: isActive ? palette.bgHover : "transparent",
                      color: isActive ? palette.textHeading : palette.textSecondary,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = palette.bgHover;
                      e.currentTarget.style.color = palette.textHeading;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = isActive
                        ? palette.bgHover
                        : "transparent";
                      e.currentTarget.style.color = isActive
                        ? palette.textHeading
                        : palette.textSecondary;
                    }}
                  >
                    <Icon size={inputToolIconSize} strokeWidth={2} />
                  </button>
                );
              })}
            </div>
          </Fragment>
        ))}
      </div>
    </>
  );
}
