declare module "twemoji-parser" {
  export interface ParsedTwemojiEntity {
    url: string;
    indices: [number, number];
    text: string;
    type: string;
  }

  export function parse(
    text: string,
    options?: {
      assetType?: "png" | "svg";
      buildUrl?: (codepoints: string, assetType: string) => string;
    },
  ): ParsedTwemojiEntity[];
}
