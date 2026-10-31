"""Draw the original Super FUMBBL-style Team Captain badge assets."""

from __future__ import annotations

import json
from pathlib import Path
import struct
import zlib


ROOT = Path(__file__).resolve().parent
SCALE = 4
DATE = "2026-10-31"
MODEL = "gpt-5.6-sol"

PALETTE = {
    "K": "#1b1512",  # outline
    "w": "#f2e8cc",  # bone (reserved accent)
    "Y": "#ffe27a",  # gold highlight
    "y": "#e8b02c",  # gold midtone
    "1": "#9c6a14",  # gold shadow
}

Pixel = tuple[int, int, int, int]
Canvas = list[list[Pixel]]


def make_grid() -> tuple[str, ...]:
    """Build the exact 16x16 source grid for a round gold badge and open C."""
    pixels = [["." for _ in range(16)] for _ in range(16)]

    # Inclusive row spans for the roundel silhouette.
    spans = {
        1: (6, 9),
        2: (4, 11),
        3: (3, 12),
        4: (2, 13),
        5: (1, 14),
        6: (1, 14),
        7: (1, 14),
        8: (1, 14),
        9: (1, 14),
        10: (2, 13),
        11: (2, 13),
        12: (3, 12),
        13: (4, 11),
        14: (6, 9),
    }

    # Start with mid-gold, then add a one-source-pixel dark outline.
    for y, (left, right) in spans.items():
        for x in range(left, right + 1):
            pixels[y][x] = "y"
    for y, (left, right) in spans.items():
        for x in range(left, right + 1):
            if any(
                ny not in spans or nx < spans[ny][0] or nx > spans[ny][1]
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))
            ):
                pixels[y][x] = "K"

    # Inner rim: highlight at upper-left, shadow at lower-right.
    for x, y in (
        (5, 3), (6, 3), (7, 3), (4, 4), (5, 4), (3, 5),
        (3, 6), (2, 6), (2, 7), (2, 8),
    ):
        if pixels[y][x] != "K":
            pixels[y][x] = "Y"
    for x, y in (
        (13, 6), (13, 7), (13, 8), (13, 9), (12, 10), (12, 11),
        (11, 12), (10, 13), (9, 13), (8, 13),
    ):
        if pixels[y][x] != "K":
            pixels[y][x] = "1"

    # A single-colour 8x9 C drawn directly on the gold face. The two-pixel
    # spine and rounded bars keep the gold counter empty, while the right-side
    # opening is three source pixels tall (rows 7-9).
    letter_c = {
        *((x, 4) for x in range(6, 11)),
        *((x, 5) for x in range(5, 12)),
        (4, 6), (5, 6), (6, 6), (10, 6), (11, 6),
        (4, 7), (5, 7),
        (4, 8), (5, 8),
        (4, 9), (5, 9),
        (4, 10), (5, 10), (6, 10), (10, 10), (11, 10),
        *((x, 11) for x in range(5, 12)),
        *((x, 12) for x in range(6, 11)),
    }
    for x, y in letter_c:
        pixels[y][x] = "K"

    return tuple("".join(row) for row in pixels)


def rgb(hex_color: str) -> tuple[int, int, int, int]:
    return (
        int(hex_color[1:3], 16),
        int(hex_color[3:5], 16),
        int(hex_color[5:7], 16),
        255,
    )


def render(rows: tuple[str, ...]) -> Canvas:
    assert len(rows) == 16 and all(len(row) == 16 for row in rows)
    source: Canvas = [[(0, 0, 0, 0) for _ in range(16)] for _ in range(16)]
    for y, row in enumerate(rows):
        for x, symbol in enumerate(row):
            if symbol != ".":
                source[y][x] = rgb(PALETTE[symbol])
    return resize_nearest(source, 64, 64)


def canvas_size(canvas: Canvas) -> tuple[int, int]:
    return len(canvas[0]), len(canvas)


def resize_nearest(canvas: Canvas, width: int, height: int) -> Canvas:
    source_width, source_height = canvas_size(canvas)
    return [
        [canvas[(y * source_height) // height][(x * source_width) // width] for x in range(width)]
        for y in range(height)
    ]


def make_off(master: Canvas) -> Canvas:
    """Desaturate and dim to 60% luminance while preserving alpha and outline."""
    outline = rgb(PALETTE["K"])
    width, height = canvas_size(master)
    off: Canvas = [[(0, 0, 0, 0) for _ in range(width)] for _ in range(height)]
    for y in range(height):
        for x in range(width):
            r, g, b, a = master[y][x]
            if a == 0:
                continue
            if (r, g, b, a) == outline:
                off[y][x] = outline
                continue
            luminance = round((0.299 * r + 0.587 * g + 0.114 * b) * 0.60)
            off[y][x] = (luminance, luminance, luminance, a)
    return off


def make_sheet(images: tuple[Canvas, Canvas]) -> Canvas:
    sizes = (64, 32, 26)
    backgrounds = ((14, 17, 21, 255), (236, 232, 222, 255))
    cell = 76
    sheet: Canvas = [[backgrounds[0] for _ in range(cell * 6)] for _ in range(cell * 2)]
    for bg_index, background in enumerate(backgrounds):
        x_origin = bg_index * cell * len(sizes)
        for y in range(len(sheet)):
            for x in range(x_origin, x_origin + cell * len(sizes)):
                sheet[y][x] = background
        for row_index, icon in enumerate(images):
            for size_index, size in enumerate(sizes):
                preview = resize_nearest(icon, size, size)
                x = x_origin + size_index * cell + (cell - size) // 2
                y = row_index * cell + (cell - size) // 2
                for preview_y, preview_row in enumerate(preview):
                    for preview_x, pixel in enumerate(preview_row):
                        if pixel[3] == 255:
                            sheet[y + preview_y][x + preview_x] = pixel
    return sheet


def write_png(path: Path, canvas: Canvas) -> None:
    """Write an 8-bit RGBA PNG with filter type 0 using only Python stdlib."""
    width, height = canvas_size(canvas)
    raw = b"".join(
        b"\x00" + bytes(channel for pixel in row for channel in pixel)
        for row in canvas
    )

    def chunk(kind: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", checksum)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk("IHDR".encode("ascii"), struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk("IDAT".encode("ascii"), zlib.compress(raw, level=9))
    png += chunk("IEND".encode("ascii"), b"")
    path.write_bytes(png)


def main() -> None:
    rows = make_grid()
    master = render(rows)
    off = make_off(master)
    write_png(ROOT / "captain.png", master)
    write_png(ROOT / "captain-off.png", off)
    write_png(ROOT / "captain-sheet.png", make_sheet((master, off)))

    palette_text = ", ".join(f"{symbol}={color}" for symbol, color in PALETTE.items())
    exact_grid = "\n".join(rows)
    provenance = {
        "asset": "captain.png",
        "tool": "hand-authored pixel grid via Python stdlib RGBA PNG encoder",
        "model": MODEL,
        "date": DATE,
        "prompt": (
            "Exact 16x16 pixel grid ('.' is transparent), followed by the exact palette:\n"
            f"{exact_grid}\nPalette: {palette_text}"
        ),
        "negative": (
            "No Games Workshop, Warhammer, or Blood Bowl imagery; no eagle or Aquila; "
            "no trademarked logos; no image-to-image source; no filled counter; no closed "
            "right side; no G-shaped crossbar."
        ),
        "edits": (
            "Replaced the filled bone-and-outline mark with a single-colour dark C drawn "
            "directly on the gold face: an 8x9 glyph with a two-pixel spine, rounded bars, "
            "an empty gold counter, and a three-pixel-tall centred opening at right. "
            "Rendered the hand-authored 16x16 RGBA grid, then upscaled 4x to 64x64 "
            "with integer nearest-neighbour sampling and encoded an 8-bit RGBA PNG using "
            "Python's struct and zlib standard-library modules. Derived captain-off.png pixel-by-pixel "
            "from captain.png: preserved transparent pixels and the #1b1512 outline exactly; "
            "converted every other opaque pixel to Rec.601 luminance "
            "(0.299R + 0.587G + 0.114B), multiplied by 0.60, rounded to the nearest integer, "
            "and wrote that value to R, G, and B while preserving alpha. Created "
            "captain-sheet.png using nearest-neighbour previews at 64, 32, and 26 px on "
            "#0e1115 and #ece8de backgrounds."
        ),
    }
    (ROOT / "captain.provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
