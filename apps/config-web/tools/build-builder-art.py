"""Build the HTML team builders' art from the Super FUMBBL desktop client (read-only via git).

Outputs (committed):
  apps/config-web/public/sprites/<race>/<role>.png   idle portrait, home kit, native size
  apps/config-web/public/sprites/manifest.json       roles per race + the resolver's alias table
  apps/config-web/public/crests/<key>.png|svg        team crest, home kit
  apps/config-web/public/crests/manifest.json        crest key -> file
  apps/config-web/public/icons/inducements/<icon>.png + manifest.json   inducement key -> icon

Mirrors the client exactly:
  * portraits = apps/tauri/src/game/walkerPortrait.ts: the bundled walk sheet chosen by
    resolveBundledWalkRole (home side, else 'any', else first), idle frame = column 0 of the 'S'
    row, cell = sheet height / rows (manifest frame / 64 when it doesn't divide), cropped to the
    opaque bounds (alpha > 16) as a square with a 1 px margin, feet on the floor of the box.
    Kept at native size (the page scales with image-rendering: pixelated) instead of the 2x canvas.
  * resolver tables = packages/ffb-pitch/src/bundledWalk.ts (ROLE_ALIASES is read from the source).
  * inducement icons = apps/tauri/src/game/logic/coachPanelChips.ts INDUCEMENT_ICONS (keyed by the
    fork inducement type = our dataset's wireName, else the camelCased id), files from
    apps/tauri/src/assets/resources/<icon>.png, box-filtered down to 64 px (the desktop shows them
    smoothed at 32 px). Types without an icon get no file; the page draws a neutral placeholder tile.
  * crests = apps/tauri/src/game/teamCrests.ts: a raster pair (<key>.png + <key>-away.png) beats the
    SVG placeholder; the SVG is written with the HOME kit colours substituted and square px size.

Usage (Python with Pillow; run isolated):
  python -I apps/config-web/tools/build-builder-art.py [--repo <client checkout>] [--ref origin/order-66]
"""
import argparse
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.normpath(os.path.join(HERE, "..", "public"))
WALK = "packages/ffb-pitch/assets/walk"
BUNDLED_WALK_TS = "packages/ffb-pitch/src/bundledWalk.ts"
CRESTS = "apps/tauri/src/assets/crests"
HOME_KIT = {"team": "#C2333C", "dark": "#7E1F27"}  # teamCrests.ts KIT.home
CREST_PX = 128
RESOURCES = "apps/tauri/src/assets/resources"
COACH_PANEL_CHIPS_TS = "apps/tauri/src/game/logic/coachPanelChips.ts"
# Inducement catalog of THIS repo: config-web keys + the fork wireName the client's icon map is keyed by.
DATASET_INDUCEMENTS = os.path.normpath(os.path.join(HERE, "..", "..", "..", "packages", "bb-validator", "src", "dataset", "bb2025", "inducements.json"))
ICON_PX = 64
# Never shipped here even though they sit in resources/: upstream FUMBBL skull art (installer-only).
ICON_DENYLIST = {"block_skull", "coin_skull"}


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True).stdout


def show(repo, ref, path):
    return git(repo, "show", f"{ref}:{path}")


def js_round(value):
    """Math.round semantics (half up), not Python's banker's rounding."""
    return math.floor(value + 0.5)


def role_aliases(ts_source):
    """Extract `const ROLE_ALIASES = {...};` from bundledWalk.ts as plain JSON."""
    match = re.search(r"const ROLE_ALIASES[^=]*=\s*(\{.*?\n\});", ts_source, re.S)
    if not match:
        raise SystemExit("ROLE_ALIASES not found in bundledWalk.ts")
    body = re.sub(r"//[^\n]*", "", match.group(1))
    body = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', body)
    body = body.replace("'", '"')
    body = re.sub(r",(\s*[}\]])", r"\1", body)
    return json.loads(body)


def idle_portrait(png_bytes, entry):
    sheet = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    rows = entry.get("rows") or []
    row = max(0, rows.index("S")) if "S" in rows else 0
    by_rows = sheet.height / len(rows) if rows else 0
    size = int(by_rows) if by_rows > 0 and float(by_rows).is_integer() else int(entry.get("frame") or 64)
    column = 0
    cell = sheet.crop((column * size, row * size, column * size + size, row * size + size))
    alpha = cell.getchannel("A").point(lambda a: 255 if a > 16 else 0)
    box = alpha.getbbox()
    sx, sy, sw = 0, 0, size
    if box:
        x0, y0, x1, y1 = box[0], box[1], box[2] - 1, box[3] - 1
        side = max(x1 - x0 + 1, y1 - y0 + 1) + 2
        sx = max(0, min(size - side, js_round((x0 + x1) / 2 - side / 2)))
        sy = max(0, min(size - side, y1 + 1 - side))
        sw = min(side, size)
    return cell.crop((sx, sy, sx + sw, sy + sw))


def save_png(image, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Pixel art: a 256-colour palette with alpha is lossless in practice and a fraction of RGBA's size.
    colours = image.getcolors(maxcolors=256)
    out = image.quantize(colors=256, method=Image.Quantize.FASTOCTREE) if colours is not None else image
    out.save(path, format="PNG", optimize=True)


def build_sprites(repo, ref):
    manifest = json.loads(show(repo, ref, f"{WALK}/manifest.json"))
    aliases = role_aliases(show(repo, ref, BUNDLED_WALK_TS).decode("utf-8"))
    chosen = {}
    for entry in manifest["sheets"]:
        key = (entry["race"], entry["role"])
        current = chosen.get(key)
        rank = {"home": 0, "any": 1}.get(entry.get("side"), 2)
        if current is None or rank < current[0]:
            chosen[key] = (rank, entry)
    out_dir = os.path.join(PUBLIC, "sprites")
    for name in os.listdir(out_dir) if os.path.isdir(out_dir) else []:
        full = os.path.join(out_dir, name)
        if os.path.isdir(full):
            shutil.rmtree(full)
    races = {}
    for (race, role), (_, entry) in sorted(chosen.items()):
        portrait = idle_portrait(show(repo, ref, f"{WALK}/{entry['file']}"), entry)
        rel = f"sprites/{race}/{role}.png"
        save_png(portrait, os.path.join(PUBLIC, *rel.split("/")))
        races.setdefault(race, {})[role] = rel
    sha = git(repo, "rev-parse", ref).decode().strip()
    doc = {
        "_about": "Super FUMBBL walk-sheet idle portraits (home kit) for the HTML team builders. Generated by "
                  "apps/config-web/tools/build-builder-art.py — do not edit by hand.",
        "source": {"ref": ref, "commit": sha, "path": WALK},
        "starRace": "stars",
        "roleAliases": aliases,
        "races": races,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")
    return sum(len(r) for r in races.values()), len(races), sha


def build_crests(repo, ref):
    names = git(repo, "ls-tree", "--name-only", f"{ref}:{CRESTS}").decode().split()
    svgs = {n[:-4] for n in names if re.fullmatch(r"[a-z]+\.svg", n)}
    pngs = set(names)
    out_dir = os.path.join(PUBLIC, "crests")
    if os.path.isdir(out_dir):
        for name in os.listdir(out_dir):
            if name != "README.md":
                os.remove(os.path.join(out_dir, name))
    os.makedirs(out_dir, exist_ok=True)
    crests = {}
    for key in sorted(svgs):
        if f"{key}.png" in pngs and f"{key}-away.png" in pngs:
            image = Image.open(io.BytesIO(show(repo, ref, f"{CRESTS}/{key}.png"))).convert("RGBA")
            if image.width > CREST_PX or image.height > CREST_PX:
                image.thumbnail((CREST_PX, CREST_PX), Image.Resampling.LANCZOS)
            save_png(image, os.path.join(out_dir, f"{key}.png"))
            crests[key] = f"crests/{key}.png"
        else:
            svg = show(repo, ref, f"{CRESTS}/{key}.svg").decode("utf-8")
            svg = re.sub(r"var\(--crest-team-dark\s*,\s*[^)]+\)", HOME_KIT["dark"], svg)
            svg = re.sub(r"var\(--crest-team\s*,\s*[^)]+\)", HOME_KIT["team"], svg)
            svg = re.sub(r"<svg\b([^>]*)>", lambda m: m.group(0) if re.search(r"\bwidth=", m.group(1))
                         else f'<svg{m.group(1)} width="{CREST_PX}" height="{CREST_PX}">', svg, count=1)
            with open(os.path.join(out_dir, f"{key}.svg"), "w", encoding="utf-8", newline="\n") as f:
                f.write(svg)
            crests[key] = f"crests/{key}.svg"
    sha = git(repo, "rev-parse", ref).decode().strip()
    doc = {
        "_about": "Super FUMBBL team crests (home kit) for the HTML team builders; key = roster race key, letters only "
                  "(teamCrests.ts crestKey). Raster pairs win over the SVG placeholders. Generated by "
                  "apps/config-web/tools/build-builder-art.py — do not edit by hand.",
        "source": {"ref": ref, "commit": sha, "path": CRESTS},
        "crests": crests,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")
    return len(crests), sum(1 for v in crests.values() if v.endswith(".png"))


def inducement_icon_map(ts_source):
    match = re.search(r"const INDUCEMENT_ICONS[^=]*=\s*(\{.*?\n\});", ts_source, re.S)
    if not match:
        raise SystemExit("INDUCEMENT_ICONS not found in coachPanelChips.ts")
    return dict(re.findall(r"([A-Za-z0-9_]+)\s*:\s*'([a-z0-9_]+)'", match.group(1)))


def build_icons(repo, ref):
    icons_by_type = inducement_icon_map(show(repo, ref, COACH_PANEL_CHIPS_TS).decode("utf-8"))
    available = {n[:-4] for n in git(repo, "ls-tree", "--name-only", f"{ref}:{RESOURCES}").decode().split() if n.endswith(".png")}
    with open(DATASET_INDUCEMENTS, encoding="utf-8") as f:
        catalog = json.load(f)["inducements"]
    out_dir = os.path.join(PUBLIC, "icons", "inducements")
    if os.path.isdir(out_dir):
        for name in os.listdir(out_dir):
            if name != "README.md":
                os.remove(os.path.join(out_dir, name))
    os.makedirs(out_dir, exist_ok=True)
    camel = lambda key: re.sub(r"_([a-z])", lambda m: m.group(1).upper(), key)
    icons, missing, written = {}, [], set()
    for item in catalog:
        key = item["id"]
        icon = icons_by_type.get(item.get("wireName") or "") or icons_by_type.get(camel(key))
        if not icon or icon not in available or icon in ICON_DENYLIST:
            missing.append(key)
            continue
        if icon not in written:
            image = Image.open(io.BytesIO(show(repo, ref, f"{RESOURCES}/{icon}.png"))).convert("RGBA")
            if image.width > ICON_PX or image.height > ICON_PX:
                image.thumbnail((ICON_PX, ICON_PX), Image.Resampling.BOX)
            image.save(os.path.join(out_dir, f"{icon}.png"), format="PNG", optimize=True)
            written.add(icon)
        icons[key] = f"icons/inducements/{icon}.png"
    sha = git(repo, "rev-parse", ref).decode().strip()
    doc = {
        "_about": "Super FUMBBL inducement icons for the HTML team builders; key = config-web inducement key. "
                  "Missing keys have no icon (the page draws a placeholder tile). Generated by "
                  "apps/config-web/tools/build-builder-art.py — do not edit by hand.",
        "source": {"ref": ref, "commit": sha, "path": RESOURCES, "map": COACH_PANEL_CHIPS_TS},
        "icons": icons,
        "noIcon": sorted(missing),
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")
    return len(icons), missing


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "wt-client-integration-o66aj")))
    parser.add_argument("--ref", default="origin/order-66")
    args = parser.parse_args()
    portraits, races, sha = build_sprites(args.repo, args.ref)
    crests, raster = build_crests(args.repo, args.ref)
    icons, no_icon = build_icons(args.repo, args.ref)
    total = 0
    for folder in ("sprites", "crests", "icons"):
        for root, _, files in os.walk(os.path.join(PUBLIC, folder)):
            total += sum(os.path.getsize(os.path.join(root, f)) for f in files)
    print(f"{portraits} portraits across {races} races, {crests} crests ({raster} raster), {icons} inducement icons "
          f"(none for: {', '.join(no_icon)}) from {sha[:10]}; {total / 1e6:.2f} MB")


if __name__ == "__main__":
    sys.exit(main())
