#!/usr/bin/env python3
"""Generate all PWA PNG icons using only the Python standard library.

No Pillow, no ImageMagick, no network. Run:  python3 tools/make-icons.py
Design: emerald gradient tile, three rising bars, a gold coin with a ¥ glyph.
"""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def mix(a, b, t):
    t = clamp(t)
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def blend(dst, color, alpha):
    """Source-over blend of an opaque RGB color onto a possibly transparent pixel."""
    alpha = clamp(alpha)
    if alpha <= 0:
        return dst
    dr, dg, db, da = dst
    da /= 255.0
    out_a = alpha + da * (1 - alpha)
    if out_a <= 0:
        return (0, 0, 0, 0)
    r = (color[0] * alpha + dr * da * (1 - alpha)) / out_a
    g = (color[1] * alpha + dg * da * (1 - alpha)) / out_a
    b = (color[2] * alpha + db * da * (1 - alpha)) / out_a
    return (int(round(r)), int(round(g)), int(round(b)), int(round(out_a * 255)))


def cover_round_rect(x, y, x0, y0, x1, y1, radius):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    qx = abs(x - cx) - ((x1 - x0) / 2 - radius)
    qy = abs(y - cy) - ((y1 - y0) / 2 - radius)
    d = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius
    return clamp(0.5 - d)


def cover_circle(x, y, cx, cy, radius):
    return clamp(0.5 - (math.hypot(x - cx, y - cy) - radius))


def cover_line(x, y, x1, y1, x2, y2, width):
    dx, dy = x2 - x1, y2 - y1
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else clamp(((x - x1) * dx + (y - y1) * dy) / length_sq)
    d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - width / 2
    return clamp(0.5 - d)


def render(size, kind):
    s = float(size)
    maskable = kind == "maskable"
    opaque = kind in ("apple", "maskable")
    scale = 0.76 if maskable else 1.0

    def pos(v):
        return (v - 0.5) * scale + 0.5

    def length(v):
        return v * scale

    bars = [(0.27, 0.22), (0.48, 0.35), (0.69, 0.47)]
    bar_half_width = length(0.0675) * s
    bar_bottom = pos(0.79) * s
    coin_cx, coin_cy = pos(0.68) * s, pos(0.27) * s
    coin_r = length(0.155) * s

    yen_stroke = length(0.016) * s
    yen_segments = [
        (coin_cx - length(0.055) * s, coin_cy - length(0.065) * s, coin_cx, coin_cy - length(0.005) * s),
        (coin_cx + length(0.055) * s, coin_cy - length(0.065) * s, coin_cx, coin_cy - length(0.005) * s),
        (coin_cx, coin_cy - length(0.005) * s, coin_cx, coin_cy + length(0.075) * s),
        (coin_cx - length(0.055) * s, coin_cy + length(0.012) * s, coin_cx + length(0.055) * s, coin_cy + length(0.012) * s),
        (coin_cx - length(0.055) * s, coin_cy + length(0.042) * s, coin_cx + length(0.055) * s, coin_cy + length(0.042) * s),
    ]

    top_color = (16, 185, 129)
    bottom_color = (6, 122, 92)
    rows = []

    for y in range(size):
        row = bytearray()
        sy = y + 0.5
        ny = sy / s
        for x in range(size):
            sx = x + 0.5
            nx = sx / s

            bg = mix(top_color, bottom_color, ny)
            glow = clamp(1 - math.hypot(nx - 0.3, ny - 0.15) / 0.9) * 0.10
            bg = mix(bg, (255, 255, 255), glow)

            base_a = 1.0 if opaque else cover_round_rect(sx, sy, 0, 0, s, s, 0.22 * s)
            pixel = (0, 0, 0, 0)
            pixel = blend(pixel, bg, base_a)
            if base_a <= 0:
                row.extend(pixel)
                continue

            for bx, bh in bars:
                cx = pos(bx) * s
                top_y = (pos(0.79) - length(bh)) * s
                a = cover_round_rect(
                    sx, sy,
                    cx - bar_half_width, top_y,
                    cx + bar_half_width, bar_bottom,
                    length(0.028) * s,
                )
                pixel = blend(pixel, (255, 255, 255), a * 0.95 * base_a)

            coin_a = cover_circle(sx, sy, coin_cx, coin_cy, coin_r)
            if coin_a > 0:
                gold = mix(
                    (255, 226, 145), (232, 163, 38),
                    clamp((sy - (coin_cy - coin_r)) / (2 * coin_r)),
                )
                pixel = blend(pixel, gold, coin_a * base_a)

                yen_a = 0.0
                for seg in yen_segments:
                    yen_a = max(yen_a, cover_line(sx, sy, *seg, yen_stroke))
                pixel = blend(pixel, (122, 78, 0), min(yen_a, coin_a) * base_a)

            row.extend(pixel)
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw.extend(row)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    blob = b"\x89PNG\r\n\x1a\n"
    blob += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    blob += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    blob += chunk(b"IEND", b"")
    path.write_bytes(blob)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, "standard"),
        ("icon-512.png", 512, "standard"),
        ("apple-touch-icon.png", 180, "apple"),
        ("maskable-512.png", 512, "maskable"),
    ]
    for name, size, kind in targets:
        write_png(OUT / name, size, render(size, kind))
        print(f"wrote {name} ({size}x{size}, {kind})")


if __name__ == "__main__":
    main()
