#!/usr/bin/env python3
"""Растровые версии фавикона из public/favicon.svg (без зависимостей).

Геометрия повторяет SVG в системе 64×64: тёмный скруглённый квадрат, тонкая
янтарная рамка и «9» (кольцо + ножка). Пишем PNG вручную через zlib — так же,
как scripts/make-icon.py в native-проекте: ни Pillow, ни cairo не нужны.

    python3 tools/make-favicon.py
"""
import struct
import zlib
from pathlib import Path

SVG_UNITS = 64.0
BG = (0x12, 0x15, 0x1C)
AMBER = (0xF0, 0xB3, 0x57)
FRAME_ALPHA = 0.35
SS = 4  # суперсэмплинг: 4×4 подпикселя на пиксель

# геометрия в единицах SVG
CORNER = 15.0
LOOP_C = (30.0, 25.0)
LOOP_R = 13.0
LOOP_W = 8.0
STEM = ((42.5, 25.0), (42.5, 47.0))
STEM_W = 8.0
FRAME_INSET = 1.5
FRAME_W = 1.5


def rounded_box_sdf(x, y, half, radius):
    qx = abs(x - SVG_UNITS / 2) - half + radius
    qy = abs(y - SVG_UNITS / 2) - half + radius
    outside = (max(qx, 0.0) ** 2 + max(qy, 0.0) ** 2) ** 0.5
    return outside + min(max(qx, qy), 0.0) - radius


def segment_dist(x, y, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2) ** 0.5


def sample(x, y):
    """Цвет в точке (единицы SVG) и признак непрозрачности."""
    box = rounded_box_sdf(x, y, SVG_UNITS / 2, CORNER)
    if box > 0:
        return None
    r, g, b = BG

    # тонкая рамка по внутреннему краю
    if abs(box + FRAME_INSET) <= FRAME_W / 2:
        r = round(r * (1 - FRAME_ALPHA) + AMBER[0] * FRAME_ALPHA)
        g = round(g * (1 - FRAME_ALPHA) + AMBER[1] * FRAME_ALPHA)
        b = round(b * (1 - FRAME_ALPHA) + AMBER[2] * FRAME_ALPHA)

    # кольцо
    d = ((x - LOOP_C[0]) ** 2 + (y - LOOP_C[1]) ** 2) ** 0.5
    if abs(d - LOOP_R) <= LOOP_W / 2:
        return AMBER
    # ножка
    if segment_dist(x, y, *STEM) <= STEM_W / 2:
        return AMBER
    return (r, g, b)


def render(size):
    rows = []
    step = 1.0 / SS
    scale = SVG_UNITS / size
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0]
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) * step) * scale
                    y = (py + (sy + 0.5) * step) * scale
                    c = sample(x, y)
                    if c is not None:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        hits += 1
            total = SS * SS
            if hits:
                r = round(acc[0] / hits)
                g = round(acc[1] / hits)
                b = round(acc[2] / hits)
                a = round(255 * hits / total)
            else:
                r = g = b = a = 0
            row += bytes((r, g, b, a))
        rows.append(bytes(row))
    return rows


def write_png(path, rows):
    height = len(rows)
    width = len(rows[0]) // 4
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    Path(path).write_bytes(png)
    return len(png)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    for size, name in ((32, "favicon-32.png"), (180, "apple-touch-icon.png")):
        out = root / "public" / name
        written = write_png(out, render(size))
        print(f"  {name}: {size}×{size}, {written} байт")
