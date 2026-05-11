import { useContext } from "react";
import {
  Grid as GiphyGrid,
  SearchBar as GiphySearchBar,
  SearchContext,
  SearchContextManager,
} from "@giphy/react-components";
import type { ThemePalette, ThemeSpacing, ThemeTypography } from "../../../theme/types";

interface GiphyPickerProps {
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  apiKey: string;
  onGifSelect: (gifUrl: string) => void;
}

function GiphyPickerInner({
  palette,
  typography,
  spacing,
  onGifSelect,
}: Omit<GiphyPickerProps, "apiKey">) {
  const { fetchGifs, searchKey } = useContext(SearchContext);

  return (
    <div
      style={{
        width: 350,
        height: 380,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: palette.bgPrimary,
      }}
    >
      <div style={{ padding: `${spacing.unit}px ${spacing.unit * 1.5}px` }}>
        <GiphySearchBar placeholder="Search GIPHY" autoFocus />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <GiphyGrid
          key={searchKey}
          columns={3}
          width={350}
          gutter={6}
          fetchGifs={fetchGifs}
          hideAttribution
          noLink
          onGifClick={(gif, e) => {
            e.preventDefault();
            const url = gif.images?.original?.url ?? gif.images?.fixed_height?.url;
            if (url) onGifSelect(url);
          }}
        />
      </div>
      <div
        style={{
          padding: `${spacing.unit * 0.5}px ${spacing.unit}px`,
          textAlign: "right",
          fontSize: typography.fontSizeSmall * 0.85,
          color: palette.textSecondary,
          opacity: 0.7,
        }}
      >
        Powered by GIPHY
      </div>
    </div>
  );
}

export default function GiphyPicker({
  palette,
  typography,
  spacing,
  apiKey,
  onGifSelect,
}: GiphyPickerProps) {
  return (
    <SearchContextManager apiKey={apiKey}>
      <GiphyPickerInner
        palette={palette}
        typography={typography}
        spacing={spacing}
        onGifSelect={onGifSelect}
      />
    </SearchContextManager>
  );
}
