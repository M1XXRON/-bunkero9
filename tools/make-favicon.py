#!/usr/bin/env python3
"""Растровые версии фавикона из public/favicon.svg (Радар «Сигнал тишины»).

Геометрия повторяет SVG в системе 64×64: тёмно-оливковый корпус #10150e,
рамка #3d4932, концентрические кольца пеленгатора, оранжевый сектор-луч
#ff5b36, засечка сигнала и зелёное ядро #a9ce7c.

    python3 tools/make-favicon.py
"""
import math
import struct
import zlib
from pathlib import Path

SVG_UNITS = 64.0
BG = (0x10, 0x15, 0x0E)
BORDER = (0x3D, 0x49, 0x32)
RING_OUTER = (0x2C, 0x37, 0x24)
RING_INNER = (0x30, 0x3C, 0x27)
ORANGE = (0xFF, 0x5B, 0x36)
GREEN = (0xA9, 0xCE, 0x7C)
SS = 4


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


def blend(base, over, alpha):
    return (
        round(base[0] * (1 - alpha) + over[0] * alpha),
        round(base[1] * (1 - alpha) + over[1] * alpha),
        round(base[2] * (1 - alpha) + over[2] * alpha),
    )


def sample(x, y):
    box = rounded_box_sdf(x, y, 30.0, 16.0)
    if box > 0:
        return None
    color = BG

    # Рамка корпуса
    if abs(box + 1.25) <= 1.25:
        color = BORDER

    cx, cy = 32.0, 32.0
    dx, dy = x - cx, y - cy
    dist = (dx * dx + dy * dy) ** 0.5
    ang = math.degrees(math.atan2(dy, dx))

    # Концентрические кольца
    if abs(dist - 21.0) <= 1.0:
        color = RING_OUTER
    elif abs(dist - 11.5) <= 0.8 and int((ang + 180.0) / 16.0) % 2 == 0:
        color = RING_INNER

    # Оранжевый сектор сканера (-40° .. 0°)
    if dist <= 21.5 and -40.5 <= ang <= 0.0:
        color = blend(color, ORANGE, 0.34)

    # Луч сканера
    if segment_dist(x, y, (32.0, 32.0), (49.0, 17.5)) <= 1.5:
        color = ORANGE

    # Засечка сигнала
    if ((x - 43.0) ** 2 + (y - 24.5) ** 2) ** 0.5 <= 3.2:
        color = ORANGE

    # Центральное зелёное ядро
    if dist <= 4.2:
        color = GREEN

    return color


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
