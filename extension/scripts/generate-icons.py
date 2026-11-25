#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Generate crisp neo-brutalist extension PNG icons (16, 32, 48, 128) matching the website style.

Run with: uv run extension/scripts/generate-icons.py
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = (16, 32, 48, 128)
CANVAS = 1024  # 8x supersampling for 128px

INK = (17, 17, 17, 255)        # #111111
MINT = (38, 208, 140, 255)     # #26d08c
CORAL = (255, 86, 63, 255)     # #ff563f
WHITE = (255, 255, 255, 255)


def _draw_emblem(small_mode: bool) -> Image.Image:
    s = CANVAS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Dimensions keep the entire hard offset shadow and badge cleanly inside 1024x1024
    margin = 68
    tile_w = 788
    radius = 185 if small_mode else 178
    shadow_dx = 76
    tile_stroke = 84 if small_mode else 68

    # 1. Hard offset black shadow behind the main mint tile
    draw.rounded_rectangle(
        [margin + shadow_dx, margin + shadow_dx, margin + tile_w + shadow_dx, margin + tile_w + shadow_dx],
        radius=radius,
        fill=INK,
    )

    # 2. Mint rounded-square tile with bold black border
    tx0, ty0, tx1, ty1 = margin, margin, margin + tile_w, margin + tile_w
    draw.rounded_rectangle(
        [tx0, ty0, tx1, ty1],
        radius=radius,
        fill=MINT,
        outline=INK,
        width=tile_stroke,
    )

    # 3. Crisp white envelope centered inside the mint tile
    cx, cy = (tx0 + tx1) // 2, (ty0 + ty1) // 2
    ew, eh = (500, 356) if small_mode else (476, 336)
    ex0, ey0, ex1, ey1 = cx - ew // 2, cy - eh // 2, cx + ew // 2, cy + eh // 2
    env_stroke = 62 if small_mode else 48
    env_r = 56 if small_mode else 48
    draw.rounded_rectangle(
        [ex0, ey0, ex1, ey1],
        radius=env_r,
        fill=WHITE,
        outline=INK,
        width=env_stroke,
    )
    flap_inset = round(env_stroke * 0.72)
    flap_y = round(ey0 + eh * 0.54)
    draw.line(
        [(ex0 + flap_inset, ey0 + flap_inset), (cx, flap_y), (ex1 - flap_inset, ey0 + flap_inset)],
        fill=INK,
        width=env_stroke,
        joint="curve",
    )

    # 4. Coral neo-brutalist badge anchored at bottom-right with hard offset black shadow
    bx, by = (756, 748) if small_mode else (758, 750)
    br = 194 if small_mode else 178
    bshadow = 28
    bstroke = 68 if small_mode else 54
    draw.ellipse([bx - br + bshadow, by - br + bshadow, bx + br + bshadow, by + br + bshadow], fill=INK)
    draw.ellipse([bx - br, by - br, bx + br, by + br], fill=CORAL, outline=INK, width=bstroke)

    # Bold white checkmark inside the badge
    cw = 56 if small_mode else 46
    chk = [(bx - 64, by + 6), (bx - 14, by + 56), (bx + 72, by - 44)]
    draw.line(chk, fill=WHITE, width=cw, joint="curve")
    cap_r = cw // 2 - 2
    for px, py in (chk[0], chk[-1]):
        draw.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=WHITE)

    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    hi = _draw_emblem(small_mode=False)
    lo = _draw_emblem(small_mode=True)
    for size in SIZES:
        src = lo if size <= 16 else hi
        out = src.resize((size, size), Image.Resampling.LANCZOS)
        dest = OUT_DIR / f"icon-{size}.png"
        out.save(dest, format="PNG", optimize=True)
        print(f"Wrote {dest} ({out.size[0]}x{out.size[1]}, {dest.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
