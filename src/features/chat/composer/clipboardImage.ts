/** Prefer image bytes over the URL/HTML that browsers may copy alongside them. */
export function getClipboardImageFile(clipboard: DataTransfer): File | null {
  let image: File | null = null;
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    image = item.getAsFile();
    if (image) break;
  }

  // Some clipboard sources expose files without corresponding file items.
  image ??= Array.from(clipboard.files).find((file) => file.type.startsWith("image/")) ?? null;
  if (!image || image.name.trim()) return image;

  const subtype = image.type.slice("image/".length).split("+")[0];
  const extension = subtype === "jpeg" ? "jpg" : subtype;
  return new File([image], `pasted-image.${extension}`, {
    type: image.type,
    lastModified: image.lastModified,
  });
}
