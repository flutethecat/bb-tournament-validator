"""Draw the league page icons (public/icons/league/*.png) from hand-made 16 x 16 pixel maps.

Original Super FUMBBL art, same rules as tools/draw-nav-icons.py (pixel_icons.py palette): 1 px dark outline, 3-tone
stone shading lit from the top left, upscaled x4 nearest-neighbour to a 64 x 64 RGBA master, transparent background.

  python tools/draw-league-icons.py            # writes public/icons/league/*.png
  python tools/draw-league-icons.py --sheet X  # also writes a contact sheet PNG to X
"""
import argparse
import os

from pixel_icons import write_all

ICONS = {
    # League settings cog (the 44 px button at the right end of the league header strip).
    "league-settings": [
        "......KKKK......",
        "..KK..KTTK..KK..",
        ".KTTKKKTsKKKssK.",
        ".KTTTTTTsssssSK.",
        "..KTTTTKKssssK..",
        "..KTTTK..KsssK..",
        "KKKTTK....KsSKKK",
        "KTTTTK....KSSSSK",
        "KTTssK....KSSSSK",
        "KKKssK....KSSKKK",
        "..KsssK..KSSSK..",
        "..KssssKKSSSSK..",
        ".KssssSSSSSSSSK.",
        ".KssKKKSSKKKSSK.",
        "..KK..KSSK..KK..",
        "......KKKK......",
    ],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="also write a contact sheet PNG here")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "..", "public", "icons", "league")
    write_all(ICONS, dest, args.sheet, sizes=(64, 44, 28))


if __name__ == "__main__":
    main()
