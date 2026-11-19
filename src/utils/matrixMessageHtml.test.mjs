import assert from "node:assert/strict";
import test from "node:test";
import { mentionDisplayName, mentionPillLabel } from "./matrixBodyMxid.ts";
import { mergeFormattedMentions } from "./matrixMessageHtml.ts";

const alice = "@alice:example.org";
const href = "https://matrix.to/#/@alice:example.org";
const text = (value) => ({ type: "text", value });
const element = (tagName, ...children) => ({ type: "element", tagName, properties: {}, children });
const anchor = (value) => ({ ...element("a", text(value)), properties: { href } });
const root = (...children) => ({ type: "root", children });

test("formatted mentions keep the Markdown layout and link the right occurrence of a name", () => {
  const heading = element("h2", text("Updates"));
  const emphasis = element("strong", text("Alice"));
  const message = element("p", emphasis, text(" is here. Hey Alice!"));
  const markdown = root(heading, message);
  const formatted = root(element("p", text("Updates Alice is here. Hey "), anchor("Alice"), text("!")));

  assert.equal(mergeFormattedMentions(markdown, formatted, new Set([alice])), undefined);
  assert.strictEqual(markdown.children[0], heading);
  assert.deepEqual(message.children, [emphasis, text(" is here. Hey "), anchor("Alice"), text("!")]);
});

test("formatted HTML without a linked notification leaves the Markdown body alone", () => {
  const markdown = root(element("p", element("strong", text("Hey Alice"))));
  const formatted = root(element("div", anchor("Alice")));
  const original = structuredClone(markdown);

  assert.equal(mergeFormattedMentions(markdown, formatted, new Set()), undefined);
  assert.deepEqual(markdown, original);
});

test("a known member name takes priority over the mention link text", () => {
  const name = mentionDisplayName(alice, " @Alice: Design ", alice);
  assert.equal(mentionPillLabel(alice, name), "@Alice: Design");
});

test("without a member name, a display name from the link takes priority over the user ID", () => {
  assert.equal(mentionPillLabel(alice, mentionDisplayName(alice, alice, "Alice Rivers")), "@Alice Rivers");
  assert.equal(mentionPillLabel(alice, mentionDisplayName(alice, null, "alice:example.org")), "@alice");
});
