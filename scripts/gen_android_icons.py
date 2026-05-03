"""Generate launcher mipmaps and notification drawables from Pax brand PNGs."""
from __future__ import annotations

import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
ROOT = os.path.normpath(ROOT)

IRIS = os.path.join(ROOT, "public", "logoIrisAltAndroid.png")
WHITE = os.path.join(ROOT, "public", "logoWhiteAlt.png")
RES = os.path.join(
    ROOT,
    "src-tauri",
    "gen",
    "android",
    "app",
    "src",
    "main",
    "res",
)


def resize_save(img: Image.Image, size: int, path: str) -> None:
    img.resize((size, size), Image.Resampling.LANCZOS).save(path, "PNG")


def white_logo_to_notify_icon(src_rgba: Image.Image) -> Image.Image:
    """Status bar template: opaque white RGB; shape from luminance x alpha."""
    w, h = src_rgba.size
    out = Image.new("RGBA", (w, h))
    pin = src_rgba.load()
    pout = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = pin[x, y]
            af = a / 255.0
            lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
            ai = int(round(lum * af * 255))
            pout[x, y] = (255, 255, 255, ai)
    return out


def main() -> None:
    iris = Image.open(IRIS).convert("RGBA")
    corner = iris.getpixel((0, 0))
    hex_color = "#{0:02x}{1:02x}{2:02x}".format(corner[0], corner[1], corner[2])

    adaptive = {
        "mipmap-mdpi": 108,
        "mipmap-hdpi": 162,
        "mipmap-xhdpi": 216,
        "mipmap-xxhdpi": 324,
        "mipmap-xxxhdpi": 432,
    }
    legacy = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }

    for folder, size in adaptive.items():
        resize_save(iris, size, os.path.join(RES, folder, "ic_launcher_foreground.png"))

    for folder, size in legacy.items():
        resize_save(iris, size, os.path.join(RES, folder, "ic_launcher.png"))
        resize_save(iris, size, os.path.join(RES, folder, "ic_launcher_round.png"))

    notify_src = white_logo_to_notify_icon(Image.open(WHITE).convert("RGBA"))

    notif_sizes = {
        "drawable-mdpi": 24,
        "drawable-hdpi": 36,
        "drawable-xhdpi": 48,
        "drawable-xxhdpi": 72,
        "drawable-xxxhdpi": 96,
    }
    for folder, size in notif_sizes.items():
        os.makedirs(os.path.join(RES, folder), exist_ok=True)
        resize_save(notify_src, size, os.path.join(RES, folder, "ic_stat_pax.png"))

    os.makedirs(os.path.join(RES, "drawable"), exist_ok=True)
    resize_save(notify_src, 96, os.path.join(RES, "drawable", "ic_stat_pax.png"))

    xml_path = os.path.join(RES, "values", "ic_launcher_background.xml")
    with open(xml_path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n')
        f.write(f'  <color name="ic_launcher_background">{hex_color}</color>\n')
        f.write("</resources>\n")

    print("ic_launcher_background:", hex_color)


if __name__ == "__main__":
    main()
