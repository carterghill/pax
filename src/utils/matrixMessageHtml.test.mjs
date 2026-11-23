import assert from "node:assert/strict";
import test from "node:test";
import { mentionDisplayName, mentionPillLabel } from "./matrixBodyMxid.ts";
import { isMatrixMediaUri, isMatrixMessageLink, matrixUserIdFromHref, wrapMatrixHtmlInlineRuns } from "./matrixMessageHtml.ts";

const alice = "@alice:example.org";

test("top-level mentions stay in the same inline run as adjacent message text", () => {
  const text = (value) => ({ type: "text", value });
  const element = (tagName, children, properties = {}) => ({ type: "element", tagName, properties, children });
  const aliceLink = element("a", [text("Alice")], { href: "matrix:u/alice:example.org" });
  const sentence = text(", here's an update:");
  const list = element("ol", [element("li", [text("First item")])], { start: 7 });
  const followUp = text("Let me know what you think.");

  assert.deepEqual(wrapMatrixHtmlInlineRuns([text("\n"), aliceLink, sentence, list, followUp]), [
    element("div", [aliceLink, sentence]), list, element("div", [followUp]),
  ]);
});
test("inline image sources must be Matrix content URIs with a server and one opaque media ID", () => {
  for (const source of ["mxc://example.org/Aa-2_", "mxc://example.org:8448/abc", "mxc://[2001:db8::1]:8448/abc"]) {
    assert.equal(isMatrixMediaUri(source), true, source);
  }
  for (const source of ["https://example.org/abc", "//example.org/abc", "data:image/png;base64,abc",
    "mxc://example.org/", "mxc://example.org/abc/def", "mxc://example.org/abc?query=1",
    "mxc://example.org/abc%2fdef", "mxc://example.org:65536/abc", "mxc://user@example.org/abc",
    "mxc://example.org/abc#fragment", "mxc://[invalid]/abc", "mxc://example.org/abc\n"]) {
    assert.equal(isMatrixMediaUri(source), false, source);
  }
});

test("formatted links accept Matrix permalinks and the listed absolute schemes", () => {
  for (const href of ["https://example.org", "http://example.org", "ftp://example.org/file",
    "mailto:alice@example.org", "magnet:?xt=urn:btih:example", "matrix:r/room:example.org"]) {
    assert.equal(isMatrixMessageLink(href), true, href);
  }
  for (const href of ["/path", "//example.org", "#fragment", "javascript:void(0)", "https://", "mxc://example.org/abc"]) {
    assert.equal(isMatrixMessageLink(href), false, href);
  }
  const mention = "matrix:u/alice:example.org";
  assert.equal(isMatrixMessageLink(mention), true);
  assert.equal(matrixUserIdFromHref(mention), alice);
});

test("a known member name takes priority over the mention link text", () => {
  const name = mentionDisplayName(alice, " @Alice: Design ", alice);
  assert.equal(mentionPillLabel(alice, name), "@Alice: Design");
});

test("without a member name, a display name from the link takes priority over the user ID", () => {
  assert.equal(mentionPillLabel(alice, mentionDisplayName(alice, alice, "Alice Rivers")), "@Alice Rivers");
  assert.equal(mentionPillLabel(alice, mentionDisplayName(alice, null, "alice:example.org")), "@alice");
});
