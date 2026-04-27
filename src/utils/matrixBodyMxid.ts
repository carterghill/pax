/**
 * Matrix MXIDs (and `@room`) in plain message body text.
 * Keep in sync with mention pills in MessageMarkdown and the composer.
 */
export const MATRIX_BODY_MXID_PATTERN =
  "@(?:room|[a-zA-Z0-9._=\\-/]+:[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}(?::\\d+)?)";

export const MATRIX_BODY_MXID_RE_GLOBAL = new RegExp(MATRIX_BODY_MXID_PATTERN, "g");
