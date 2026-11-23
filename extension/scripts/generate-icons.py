#!/usr/bin/env python3
"""Generate crisp anti-aliased extension PNG icons (16, 32, 48, 128) using 8x supersampling."""
from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = (16, 32, 48, 128)
CANVAS = 1024  # 8x supersampling for 128px


def _bezier(p0, p1, p2, p3, steps=28):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1.0 - t
        x = (u**3) * p0[0] + 3 * (u**2) * t * p1[0] + 3 * u * (t**2) * p2[0] + (t**3) * p3[0]
        y = (u**3) * p0[1] + 3 * (u**2) * t * p1[1] + 3 * u * (t**2) * p2[1] + (t**3) * p3[1]
        pts.append((x, y))
    return pts


def _qbezier(p0, p1, p2, steps=16):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1.0 - t
        x = (u**2) * p0[0] + 2 * u * t * p1[0] + (t**2) * p2[0]
        y = (u**2) * p0[1] + 2 * u * t * p1[1] + (t**2) * p2[1]
        pts.append((x, y))
    return pts


def _shield_points() -> list[tuple[float, float]]:
    # Balanced, modern shield with softly rounded shoulders and bottom point
    pts: list[tuple[float, float]] = []
    pts.extend(_qbezier((484, 80), (512, 68), (540, 80), 12))
    pts.extend(_qbezier((540, 80), (690, 146), (828, 174), 18))
    pts.extend(_qbezier((828, 174), (866, 182), (866, 224), 12))
    pts.extend(_bezier((866, 224), (866, 560), (736, 806), (528, 938), 32))
    pts.extend(_qbezier((528, 938), (512, 948), (496, 938), 8))
    pts.extend(_bezier((496, 938), (288, 806), (158, 560), (158, 224), 32))
    pts.extend(_qbezier((158, 224), (158, 182), (196, 174), 12))
    pts.extend(_qbezier((196, 174), (334, 146), (484, 80), 18))
    return pts


def _draw_emblem(small_mode: bool) -> Image.Image:
    s = CANVAS
    # 1. Shield alpha mask
    mask = Image.new("L", (s, s), 0)
    mdraw = ImageDraw.Draw(mask)
    shield = _shield_points()
    mdraw.polygon(shield, fill=255)

    # 2. Vertical deep security-blue gradient (#2563eb -> #1e3a8a)
    grad = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    top_rgb = (37, 99, 235)
    bot_rgb = (30, 58, 138)
    y0, y1 = 72, 948
    for y in range(s):
        t = min(1.0, max(0.0, (y - y0) / (y1 - y0)))
        r = round(top_rgb[0] + (bot_rgb[0] - top_rgb[0]) * t)
        g = round(top_rgb[1] + (bot_rgb[1] - top_rgb[1]) * t)
        b = round(top_rgb[2] + (bot_rgb[2] - top_rgb[2]) * t)
        gdraw.line([(0, y), (s, y)], fill=(r, g, b, 255))

    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    base.paste(grad, (0, 0), mask)

    # 3. Subtle sky-blue rim highlight clipped to shield mask
    rim = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rdraw = ImageDraw.Draw(rim)
    rdraw.line(shield + [shield[0]], fill=(147, 197, 253, 110), width=32 if small_mode else 24, joint="curve")
    rim_clipped = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rim_clipped.paste(rim, (0, 0), mask)
    base = Image.alpha_composite(base, rim_clipped)

    draw = ImageDraw.Draw(base)

    # 4. Crisp centered white rounded envelope with dark-blue V-flap
    if small_mode:
        ex0, ey0, ex1, ey1, er = 264, 328, 760, 668, 56
        flap_w = 52
    else:
        ex0, ey0, ex1, ey1, er = 278, 344, 746, 654, 42
        flap_w = 34
    draw.rounded_rectangle([ex0, ey0, ex1, ey1], radius=er, fill=(255, 255, 255, 255))
    flap_mid_y = round(ey0 + (ey1 - ey0) * 0.52)
    inset = round(flap_w * 0.65)
    draw.line(
        [(ex0 + inset, ey0 + inset), (512, flap_mid_y), (ex1 - inset, ey0 + inset)],
        fill=(30, 58, 138, 255),
        width=flap_w,
        joint="curve",
    )

    # 5. Emerald verified check badge anchored at bottom-right of shield
    cx, cy = (746, 720) if small_mode else (744, 718)
    outer_r = 188 if small_mode else 174
    inner_r = 148 if small_mode else 142
    draw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r], fill=(30, 58, 138, 255))
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=(16, 185, 129, 255))
    if not small_mode:
        cw = 44
        chk = [(cx - 62, cy + 4), (cx - 16, cy + 52), (cx + 68, cy - 42)]
        draw.line(chk, fill=(255, 255, 255, 255), width=cw, joint="curve")
        # Round line caps manually for crisp ends
        cap_r = cw // 2 - 2
        for px, py in (chk[0], chk[-1]):
            draw.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=(255, 255, 255, 255))
    else:
        cw = 52
        chk = [(cx - 56, cy + 4), (cx - 14, cy + 48), (cx + 62, cy - 36)]
        draw.line(chk, fill=(255, 255, 255, 255), width=cw, joint="curve")

    return base


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
