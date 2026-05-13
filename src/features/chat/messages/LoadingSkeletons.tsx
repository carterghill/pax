import type { useTheme } from "../../../theme/ThemeContext";

interface LoadingSkeletonsProps {
  count: number;
  palette: ReturnType<typeof useTheme>["palette"];
  spacingUnit: number;
}

export default function LoadingSkeletons({
  count,
  palette,
  spacingUnit,
}: LoadingSkeletonsProps) {
  return (
    <div
      aria-hidden
      style={{
        padding: `${spacingUnit}px ${spacingUnit * 3}px ${spacingUnit * 2}px`,
        display: "flex",
        flexDirection: "column",
        gap: spacingUnit * 2,
      }}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: spacingUnit * 3,
            paddingLeft: spacingUnit,
            paddingRight: spacingUnit,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              flexShrink: 0,
              backgroundColor: palette.bgActive,
              opacity: 0.8,
            }}
          />
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              gap: spacingUnit * 1.5,
            }}
          >
            <div
              style={{
                width: `${48 + idx * 10}%`,
                maxWidth: 220,
                height: 10,
                borderRadius: 999,
                backgroundColor: palette.bgActive,
                opacity: 0.9,
              }}
            />
            <div
              style={{
                width: `${72 + ((idx + 1) % 3) * 8}%`,
                height: 12,
                borderRadius: 999,
                backgroundColor: palette.bgHover,
                opacity: 0.9,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
