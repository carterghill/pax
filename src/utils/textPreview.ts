/** Max raw bytes loaded into the viewer (UTF-8 decoded after). */
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export function bufferLooksBinary(buf: Uint8Array, scanLen = 65536): boolean {
  const n = Math.min(buf.length, scanLen);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Whether we offer syntax-highlighted / plain text preview (not images/PDF/video/binary archives). */
export function isTextPreviewableFile(
  mimeType: string | null | undefined,
  fileName: string,
): boolean {
  const mime = mimeType?.toLowerCase().trim() ?? "";
  const lower = fileName.toLowerCase();

  if (mime.startsWith("text/")) return true;
  if (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime === "application/typescript" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime === "application/x-sh" ||
    mime === "application/sql" ||
    mime === "application/graphql"
  ) {
    return true;
  }

  return /\.(txt|log|md|mdx|tsx?|jsx?|jsonc?|rs|py|go|css|scss|sass|less|html?|xml|yaml|yml|toml|sh|bash|zsh|fish|ps1|sql|vue|svelte|java|kt|kts|swift|rb|php|cs|cpp|cxx|cc|c|h|hpp|graphql|gql|ini|cfg|conf|properties|env|editorconfig|csv|tsv|dockerfile|gradle|plist)$/i.test(
    lower,
  );
}

/**
 * Prism `language` prop for react-syntax-highlighter (refractor).
 * Unknown / unsupported → `log` (Prism’s generic log/plain style).
 */
export function inferPrismLanguage(
  fileName: string,
  mimeType: string | null | undefined,
): string {
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime.includes("json")) return "json";
  if (mime.includes("yaml")) return "yaml";
  if (mime.includes("xml")) return "markup";
  if (mime.includes("javascript")) return "javascript";
  if (mime.includes("typescript")) return "typescript";

  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";

  const map: Record<string, string> = {
    ".tsx": "tsx",
    ".ts": "typescript",
    ".jsx": "jsx",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".jsonc": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".rs": "rust",
    ".py": "python",
    ".go": "go",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".html": "markup",
    ".htm": "markup",
    ".xml": "markup",
    ".svg": "markup",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".fish": "bash",
    ".ps1": "powershell",
    ".sql": "sql",
    ".vue": "markup",
    ".svelte": "markdown",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".swift": "swift",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".cc": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".ini": "ini",
    ".cfg": "ini",
    ".conf": "ini",
    ".properties": "properties",
    ".gradle": "groovy",
    ".plist": "markup",
    ".dockerfile": "docker",
    ".txt": "log",
    ".log": "log",
    ".csv": "csv",
    ".tsv": "csv",
    ".env": "properties",
    ".editorconfig": "ini",
  };

  if (lower.endsWith("dockerfile") || lower.split("/").pop() === "dockerfile") {
    return "docker";
  }
  if (lower.endsWith(".gitignore") || lower.endsWith(".dockerignore")) {
    return "ignore";
  }

  return map[ext] ?? "log";
}
