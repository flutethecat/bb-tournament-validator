"""Shared helpers for the hand-drawn site sprites (tools/draw-nav-icons.py, tools/draw-panel-icons.py).

Original Super FUMBBL art: 16 x 16 pixel maps, one character per pixel ("." = transparent), upscaled x4 nearest-neighbour
to 64 x 64 RGBA masters. 1 px dark outline, 3-tone shading, a restrained palette (greens, golds, browns, stone greys,
blues; red only as a small accent).
"""
import os

from PIL import Image

PALETTE = {
    "K": "#1b1512",  # outline
    "w": "#f2e8cc",  # bone / parchment / snow
    "T": "#cdd0d6", "s": "#8e939c", "S": "#555a64",  # stone light / mid / dark
    "Y": "#ffe27a", "y": "#e8b02c", "1": "#9c6a14",  # gold light / mid / dark
    "n": "#c88a4c", "b": "#8f5a2c", "B": "#5a3418",  # brown light / mid / dark
    "G": "#8fd45a", "g": "#4fa83c", "h": "#2c6a2c",  # green light / mid / dark
    "U": "#9cc8ff", "u": "#4a86e8", "V": "#23479a",  # blue light / mid / dark
    "r": "#e04a3c", "R": "#a02424",  # red accent
}

SCALE = 4


def render(rows):
    """One 16 x 16 pixel map -> a 64 x 64 RGBA image (nearest-neighbour, transparent background)."""
    assert len(rows) == 16, len(rows)
    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        assert len(row) == 16, (y, row, len(row))
        for x, ch in enumerate(row):
            if ch == ".":
                continue
            c = PALETTE[ch]
            im.putpixel((x, y), (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255))
    return im.resize((16 * SCALE, 16 * SCALE), Image.NEAREST)


def sheet(images, path, sizes=(64, 30, 26)):
    """Each icon at the given sizes (nearest, like image-rendering: pixelated) on the dark and light panels."""
    names = list(images)
    cell = 76
    bgs = [(14, 17, 21, 255), (236, 232, 222, 255)]
    w = cell * len(sizes) * len(bgs)
    h = cell * len(names)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    for bi, bg in enumerate(bgs):
        out.paste(Image.new("RGBA", (cell * len(sizes), h), bg), (bi * cell * len(sizes), 0))
        for i, n in enumerate(names):
            for j, size in enumerate(sizes):
                im = images[n].resize((size, size), Image.NEAREST)
                x = bi * cell * len(sizes) + j * cell + (cell - size) // 2
                out.alpha_composite(im, (x, i * cell + (cell - size) // 2))
    out.save(path)


def write_all(icons, dest, sheet_path=None, sizes=(64, 30, 26)):
    """Render every map in `icons` to dest/<name>.png; optionally write a contact sheet."""
    images = {name: render(rows) for name, rows in icons.items()}
    os.makedirs(dest, exist_ok=True)
    for name, im in images.items():
        im.save(os.path.join(dest, f"{name}.png"), optimize=True)
    if sheet_path:
        sheet(images, sheet_path, sizes)
    return images
