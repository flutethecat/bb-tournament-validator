"""Draw the sidebar icons (public/icons/nav/*.png) from hand-made 16 x 16 pixel maps.

Original Super FUMBBL art (owner 10-30): small retro overworld-item sprites with a 1 px dark outline, 3-tone shading and
a restrained palette (greens, golds, browns, stone greys, blues; red only as a small accent). Each map is upscaled
x4 with nearest-neighbour to a 64 x 64 RGBA master with a transparent background, no anti-aliasing.

  python tools/draw-nav-icons.py            # writes public/icons/nav/*.png
  python tools/draw-nav-icons.py --sheet X  # also writes a contact sheet PNG to X
"""
import argparse
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

ICONS = {
    "home": [
        "..........KKKK..",
        ".......KK.KsSK..",
        "......KYYKKsSK..",
        ".....KYYyyKsSK..",
        "....KYYyyyyKSK..",
        "...KYYyyyyy1KK..",
        "..KYYyyyyy111K..",
        ".KKKKKKKKKKKKKK.",
        "..KwwwwwwwwwsK..",
        "..KwKKKwKKKKsK..",
        "..KwKUKwKrRKsK..",
        "..KwKKKwKrRKsK..",
        "..KwwwwwKrYKsK..",
        "..KsssssKrRKSK..",
        ".hKKKKKKKKKKKKh.",
        ".hgGGgGGgGGgGgh.",
    ],
    "leagues": [
        "..KKK...........",
        ".KYy1K..........",
        "..KKKKKKKKKKKKK.",
        "..KnKGggggggghK.",
        "..KnKGgggYggghK.",
        "..KnKGggYy1gghK.",
        "..KnKGgYyry1ghK.",
        "..KnKGggY11gghK.",
        "..KnKGggg1ggghK.",
        "..KnKGggggggghK.",
        "..KnKGgghKGgghK.",
        "..KnKGghK.KGghK.",
        "..KnKKKK...KKKK.",
        "..KnK...........",
        "..KbK...........",
        ".hKKKh..........",
    ],
    "tournaments": [
        "................",
        "..KKKKKKKKKKKK..",
        "KKKwYYyyyyy11KKK",
        "K.KYYyyyyyy11K.K",
        "K.KYYyyyyyy11K.K",
        ".KKKYyyyyy11KKK.",
        "...KYyyyyy11K...",
        "....KYyyy11K....",
        ".....KKyy1KK....",
        "......Ky1K......",
        "......Ky1K......",
        ".....KYyy1K.....",
        "....KKKKKKKK....",
        "...KnbbrrbbBK...",
        "...KBBBBBBBBK...",
        "...KKKKKKKKKK...",
    ],
    "leaderboards": [
        ".......KK.......",
        "......KYyK......",
        "..KKKKYYyyKKKK..",
        "...KYYYyyyy1K...",
        "....KYyyyy1K....",
        "...KYy1KK1y1K...",
        "...KKK....KKK...",
        ".....KKKKKK.....",
        ".....KUuuVK.....",
        "KKKKKKUuuVK.....",
        "KGgghKUuuVK.....",
        "KGgghKUuuVKKKKKK",
        "KGgghKUuuVKnbbBK",
        "KGgghKUuuVKnbbBK",
        "KhhhhKVVVVKBBBBK",
        "KKKKKKKKKKKKKKKK",
    ],
    "help": [
        "..KKKKKKKKKKKK..",
        ".KnnnnnnnnnnnnK.",
        ".KbbbbbbbbbbbBK.",
        "..KwwwwwwwwwsK..",
        "..KwwwwVVVwwsK..",
        "..KwwwVwwwVwsK..",
        "..KwwwwwwwVwsK..",
        "..KwwwwwwVwwsK..",
        "..KwwwwwVwwwsK..",
        "..KwwwwwwwwwsK..",
        "..KwwwwwVwwwsK..",
        "..KwwwwwwwwwsK..",
        "..KssssssssssK..",
        ".KnnnnnnnnnnnnK.",
        ".KbbbbbbbbbbbBK.",
        "..KKKKKKKKKKKK..",
    ],
    "resources": [
        "................",
        "................",
        "...KKKKKKKKKK...",
        "..KnnYnnnnYnnK..",
        ".KnnnYnnnnYnnnK.",
        ".KbbbYbbbbYbbBK.",
        ".KbbbYbbbbYbbBK.",
        ".KKKKKKYyKKKKKK.",
        ".KyyyyKYKKyyyyK.",
        ".KbbbYbK1KYbbBK.",
        ".KbbbYbbbbYbbBK.",
        ".KbbbYbbbbYbbBK.",
        ".KBBBYBBBBYBBBK.",
        ".KKKKKKKKKKKKKK.",
        "................",
        "................",
    ],
    "tools": [
        "................",
        ".KKKKKKKKKKKK...",
        ".KTTTTTTTTTsKK..",
        ".KTsssssssssSsK.",
        ".KsssssssssSSK..",
        ".KKKKKnbKKKKK...",
        ".....KnbK.......",
        ".....KnbK.......",
        ".....KnbK.......",
        ".....KnbK.......",
        ".....KrRK.......",
        ".....KrRK.......",
        ".....KrRK.......",
        ".....KnbK.......",
        ".....KKKK.......",
        "................",
    ],
    "bloodbowlbase": [
        "................",
        "..KKKKKKKKKKK...",
        "..KGGGGGGGGhKK..",
        "..KGggggggghKwK.",
        "..KGKKKKKKKhKwK.",
        "..KGKYYYYYKhKwK.",
        "..KGKY1r1YKhKwK.",
        "..KGKYYYYYKhKwK.",
        "..KGKKKKKKKhKwK.",
        "..KGggggggghKwK.",
        "..KGggggggghKwK.",
        "..KGggggggghKwK.",
        "..KhhhhhhhhhKwK.",
        "..KKKKKKKKKKKwK.",
        "...KKKKKKKKKKKK.",
        "................",
    ],
    "bloodbowldave": [
        "....K......K....",
        ".....K....K.....",
        "......K..K......",
        ".KKKKKKKKKKKKKK.",
        ".KTTTTTTTTTTTsK.",
        ".KTKKKKKKKKTTsK.",
        ".KTKUUuuuuKrTsK.",
        ".KTKUuuuuuKTTsK.",
        ".KTKuuuuuVKSTsK.",
        ".KTKuuuuVVKTTsK.",
        ".KTKKKKKKKKTTsK.",
        ".KsssssssssssSK.",
        ".KKKKKKKKKKKKKK.",
        "..KSK......KSK..",
        "..KKK......KKK..",
        "................",
    ],
    "tabbl": [
        "................",
        "..KKKKKKKKKKKK..",
        "..KYyyyyyyyy1K..",
        "..KyUUUKrUUU1K..",
        "..KyUUUKUUUU1K..",
        "..KyUUUwwUUU1K..",
        "..KyUUwwwsUU1K..",
        "..KyUwsssSSU1K..",
        "..KysssSSSSS1K..",
        "..KyGGgggggh1K..",
        "...KyGggggh1K...",
        "....KyGggh1K....",
        ".....Kyhh1K.....",
        "......Ky1K......",
        ".......KK.......",
        "................",
    ],
    "fumbbl": [
        "................",
        ".....KKKKKK.....",
        "...KKUUuuuuKK...",
        "..KUwGGuuuuuVK..",
        "..KUGGGGuuuuVK..",
        ".KUUGGGGguuuuVK.",
        ".KUuGGGguuGGuVK.",
        ".KuuuGguuGGGgVK.",
        ".KuuuuuuuGGgVVK.",
        ".KuuGguuuuGgVVK.",
        ".KuGGGguuuuVVVK.",
        "..KuGGguuuVVVK..",
        "..KuuguuVVVVVK..",
        "...KKVVVVVVKK...",
        ".....KKKKKK.....",
        "................",
    ],
}

SCALE = 4


def render(rows):
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


def sheet(images, path):
    """Each icon at 64 px, 30 px and 26 px (nearest, like image-rendering: pixelated) on the dark and light panels."""
    names = list(images)
    cell = 76
    bgs = [(14, 17, 21, 255), (236, 232, 222, 255)]
    w = cell * 3 * len(bgs)
    h = cell * len(names)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    for bi, bg in enumerate(bgs):
        out.paste(Image.new("RGBA", (cell * 3, h), bg), (bi * cell * 3, 0))
        for i, n in enumerate(names):
            for j, size in enumerate((64, 30, 26)):
                im = images[n].resize((size, size), Image.NEAREST)
                x = bi * cell * 3 + j * cell + (cell - size) // 2
                out.alpha_composite(im, (x, i * cell + (cell - size) // 2))
    out.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "..", "public", "icons", "nav")
    images = {name: render(rows) for name, rows in ICONS.items()}
    for name, im in images.items():
        im.save(os.path.join(dest, f"{name}.png"), optimize=True)
    if args.sheet:
        sheet(images, args.sheet)


if __name__ == "__main__":
    main()
