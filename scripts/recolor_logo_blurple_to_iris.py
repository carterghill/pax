"""
Replace blurple fill (#5865f2) with default theme iris (#7158d8) in Pax logos.
Preserves black, white, transparency, and anti-aliased blurple↔black edges.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image

OLD = (88, 101, 242)
NEW = (113, 88, 216)


def dist_sq(r: int, g: int, b: int) -> float:
    return (r - OLD[0]) ** 2 + (g - OLD[1]) ** 2 + (b - OLD[2]) ** 2


def recolor_rgba(r: int, g: int, b: int, a: int) -> tuple[int, int, int, int]:
    if a < 8:
        return (r, g, b, a)
    if r > 210 and g > 210 and b > 210:
        return (r, g, b, a)

    if dist_sq(r, g, b) < 58 * 58:
        return (*NEW, a)

    tr, tg, tb = r / 88.0, g / 101.0, b / 242.0
    t_vals = (tr, tg, tb)
    if max(t_vals) < 0.018:
        return (r, g, b, a)
    t_m = sum(t_vals) / 3.0
    std = math.sqrt(sum((t - t_m) ** 2 for t in t_vals) / 3)
    if std < 0.11 and 0.04 < t_m < 0.995:
        return (
            int(max(0, min(255, NEW[0] * t_m))),
            int(max(0, min(255, NEW[1] * t_m))),
            int(max(0, min(255, NEW[2] * t_m))),
            a,
        )

    return (r, g, b, a)


def process(src: Path, dst: Path) -> None:
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            px[x, y] = recolor_rgba(*px[x, y])
    im.save(dst)
    print(f"Wrote {dst}")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    public = root / "public"
    pairs = [
        (public / "logoBlurple.png", public / "logoIris.png"),
        (public / "logoBlurpleBigger.png", public / "logoIrisBigger.png"),
    ]
    for src, dst in pairs:
        if not src.exists():
            print(f"Skip missing {src}", file=sys.stderr)
            continue
        process(src, dst)


if __name__ == "__main__":
    main()
