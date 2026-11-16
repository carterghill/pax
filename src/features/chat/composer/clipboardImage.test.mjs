import assert from "node:assert/strict";
import { test } from "node:test";
import { getClipboardImageFile } from "./clipboardImage.ts";

const imageItem = (file) => ({ kind: "file", type: file.type, getAsFile: () => file });

test("Copy Image uses the image bytes even when a source URL and HTML are also present", async () => {
  const image = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const clipboard = {
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "string", type: "text/html", getAsFile: () => null },
      imageItem(image),
    ],
    files: [image],
  };
  assert.equal(getClipboardImageFile(clipboard), image);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
});

test("file-list clipboard images work even if the matching item cannot be read", () => {
  const image = new File(["screenshot"], "Screenshot.png", { type: "image/png" });
  assert.equal(getClipboardImageFile({
    items: [{ kind: "file", type: "image/png", getAsFile: () => null }],
    files: [image],
  }), image);
});

test("unnamed clipboard images get a filename while retaining their bytes and MIME type", async () => {
  for (const [mimeType, extension] of [["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]]) {
    const image = new File(["clipboard image"], "", { type: mimeType, lastModified: 42 });
    const result = getClipboardImageFile({ items: [imageItem(image)], files: [] });
    assert.equal(result.name, `pasted-image.${extension}`);
    assert.equal(result.type, mimeType);
    assert.equal(result.lastModified, 42);
    assert.equal(await result.text(), await image.text());
  }
});

test("text, copied image addresses, and non-image files stay on the existing paste path", () => {
  const file = new File(["pdf"], "document.pdf", { type: "application/pdf" });
  assert.equal(getClipboardImageFile({
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      imageItem(file),
    ],
    files: [file],
  }), null);
  assert.equal(getClipboardImageFile({ items: [], files: [] }), null);
});

test("a multi-image paste selects the first image for the composer's single attachment slot", () => {
  const first = new File(["first"], "first.png", { type: "image/png" });
  const second = new File(["second"], "second.png", { type: "image/png" });
  assert.equal(getClipboardImageFile({ items: [imageItem(first), imageItem(second)], files: [first, second] }), first);
});
