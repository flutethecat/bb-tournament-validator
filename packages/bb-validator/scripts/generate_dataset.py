#!/usr/bin/env python3
"""
Dev-time generator for the BB2025 dataset (all 30 teams).

Sources (owner-approved 2026-07-06):
  * ROSTERS: FUMBBL ruleset 3906 "BB2025" REST API (roster/list + roster/get).
    Verified to match the bbtc.pl-generated example Amazon exactly.
  * SKILL CATEGORIES: the fumbbl40k-server fork's Java skill classes
    (com.fumbbl.ffb.skill.**), bb2025 package winning — the authoritative BB2025
    categorization incl. the DEVIOUS ("D") tree that the FUMBBL rosters reference.
  * DESCRIPTIONS: fumbbl40k-client skillDescriptions.json.

Writes:
  packages/bb-validator/src/dataset/bb2025/rosters.json   (array of 30 teams)
  packages/bb-validator/src/dataset/bb2025/skills.json
  packages/bb-validator/src/dataset/bb2025/teams.json     (name + suggested tier)
  packages/bb-validator/src/dataset/bb2025/stars.json     (stars + eligible teams, from roster 8513)

Run:  python packages/bb-validator/scripts/generate_dataset.py
      python packages/bb-validator/scripts/generate_dataset.py --stars-only  (stars only; reuses local rosters.json)
Requires network access to fumbbl.com and the sibling fork repo checked out.
"""
import glob
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "src", "dataset", "bb2025"))
FORK = r"C:\Users\Jay\Documents\Claude\fumbbl40k-server\ffb-common\src\main\java\com\fumbbl\ffb"
SKILL_DESCR = r"C:\Users\Jay\Documents\Claude\fumbbl40k-client\apps\tauri\src\assets\skillDescriptions.json"
RULESET = "3906"
API = "https://fumbbl.com/api"

CODE_TO_CATEGORY = {"G": "General", "A": "Agility", "S": "Strength", "P": "Passing", "M": "Mutation", "D": "Devious"}
SELECTABLE = {"GENERAL": "General", "AGILITY": "Agility", "STRENGTH": "Strength", "PASSING": "Passing", "MUTATION": "Mutation", "DEVIOUS": "Devious"}
ELITE_DEFAULT = {"Block", "Guard", "Mighty Blow", "Dodge"}
# suggested starting tiers (editable per tournament); best-effort NAF-ish grouping
TIER = {
    **{t: 1 for t in ["Amazon", "Chaos Dwarf", "Dark Elf", "Dwarf", "Lizardmen", "Necromantic Horror", "Orc", "Shambling Undead", "Skaven", "Underworld Denizens", "Wood Elf"]},
    **{t: 2 for t in ["Chaos Chosen", "Elven Union", "High Elf", "Human", "Norse", "Nurgle", "Tomb Kings", "Vampire", "Black Orc", "Bretonnian"]},
    **{t: 3 for t in ["Chaos Renegade", "Imperial Nobility", "Khorne", "Old World Alliance"]},
    **{t: 4 for t in ["Goblin", "Ogre", "Snotling", "Gnome", "Halfling"]},
}


def get(path):
    with urllib.request.urlopen(f"{API}/{path}", timeout=30) as r:
        return json.load(r)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def fork_skill_categories():
    """name -> CATEGORY, merging all skill packages with bb2025 winning."""
    cat = {}
    order = ["skill", "skill/bb2016", "skill/bb2020", "skill/bb2020/special", "skill/common", "skill/mixed", "skill/mixed/special", "skill/bb2025", "skill/bb2025/special"]
    for d in order:
        for f in glob.glob(os.path.join(FORK, d, "*.java")):
            txt = open(f, encoding="utf-8", errors="replace").read()
            m = re.search(r'super\("([^"]+)",\s*SkillCategory\.([A-Z_]+)', txt)
            if m:
                cat[m.group(1)] = m.group(2)
    return cat


def pos_type(title, fumbbl_type):
    if fumbbl_type == "BIGGUY":
        return "bigguy"
    t = title.lower()
    for key in ["blitzer", "thrower", "catcher", "runner", "blocker"]:
        if key in t:
            return key
    if "lineman" in t or "linewoman" in t or "lineelf" in t or "hopeful" in t:
        return "lineman"
    return "positional"


def stat_target(v):
    return f"{v}+" if v not in (None, "", "0") else "-"


def base_skill(name):
    # drop trailing "(4+)" style values so base skills match printed rosters
    return re.sub(r"\s*\([^)]*\)\s*$", "", name).strip()


def convert_roster(rid):
    d = get(f"roster/get/{rid}")
    positions = []
    for p in d["positions"]:
        s = p["stats"]
        positions.append({
            "id": f"{slug(d['name'])}.{slug(p['title'])}",
            "name": p["title"],
            "type": pos_type(p["title"], p.get("type")),
            "max": int(p["quantity"]),
            "cost": int(p["cost"]),
            "MA": int(s["MA"]),
            "ST": int(s["ST"]),
            "AG": stat_target(s.get("AG")),
            "PA": stat_target(s.get("PA")),
            "AV": stat_target(s.get("AV")),
            "skills": [base_skill(x) for x in p.get("skills", [])],
            "primaryCategories": [CODE_TO_CATEGORY[c] for c in p.get("normalSkills", []) if c in CODE_TO_CATEGORY],
            "secondaryCategories": [CODE_TO_CATEGORY[c] for c in p.get("doubleSkills", []) if c in CODE_TO_CATEGORY],
            "keywords": [],
        })
    return {
        "id": slug(d["name"]),
        "name": d["name"],
        "ruleset": "bb2025",
        "tier": TIER.get(d["name"]),
        "specialRules": [sr["name"] for sr in d.get("specialRules", [])],
        "reRollCost": int(d["rerollCost"]),
        "maxReRolls": 8,
        "apothecaryAllowed": d.get("apothecary") == "Yes",
        "maxBigGuys": int(d.get("maxBigGuys") or 0),
        "positions": positions,
        "starPlayers": [],
    }


# FUMBBL's "_Star Players" roster (ruleset 3906). Each position carries `playsFor`
# — the special-rule keywords that gate which teams may hire the star. A star is
# eligible for a team iff the team shares one of those special rules.
STAR_ROSTER_ID = "8513"

# FUMBBL's roster API collapses the Chaos deity rules to a single display string
# "Favoured of..." per team, while stars name the specific god ("Favoured of
# Khorne", etc.). This maps each team that carries the generic rule to the set of
# deity keywords it satisfies. Specific-deity teams satisfy only their own god;
# the "pick-any-mark" Chaos teams (Chosen/Renegade/Norse) satisfy all — chosen
# to avoid falsely REJECTING a legal roster in a live tournament (over-rejection
# is the worse failure for a TO validator). Revisit if FUMBBL exposes per-team gods.
ALL_DEITIES = ["Favoured of Khorne", "Favoured of Nurgle", "Favoured of Hashut",
               "Favoured of Tzeentch", "Favoured of Slaanesh", "Favoured of Chaos Undivided"]
FAVOURED_MAP = {
    "Chaos Dwarf": ["Favoured of Hashut"],
    "Khorne": ["Favoured of Khorne"],
    "Nurgle": ["Favoured of Nurgle"],
    "Chaos Chosen": ALL_DEITIES,
    "Chaos Renegade": ALL_DEITIES,
    "Norse": ALL_DEITIES,
}


def team_special_rules(rosters):
    """team name -> set of special rules it satisfies (deity rules expanded)."""
    out = {}
    for r in rosters:
        rules = set(r.get("specialRules", []))
        if "Favoured of..." in rules:
            rules.discard("Favoured of...")
            rules.update(FAVOURED_MAP.get(r["name"], ALL_DEITIES))
        out[r["name"]] = rules
    return out


def build_stars(rosters):
    """Star players + resolved eligible team lists, from FUMBBL roster 8513."""
    tsr = team_special_rules(rosters)
    all_teams = [r["name"] for r in rosters]
    d = get(f"roster/get/{STAR_ROSTER_ID}")
    stars = []
    for p in sorted(d["positions"], key=lambda x: x["title"]):
        plays_for = p.get("playsFor", [])
        if "(Any)" in plays_for:
            teams = list(all_teams)
        elif "(Negate Availability)" in plays_for:
            # Plays for every team EXCEPT those sharing the listed exclusion keyword(s).
            excl = {k for k in plays_for if not k.startswith("(")}
            teams = [t for t in all_teams if not (tsr[t] & excl)]
        else:
            want = set(plays_for)
            teams = [t for t in all_teams if tsr[t] & want]
        stars.append({
            "name": p["title"],
            "cost": int(p["cost"]),
            "playsFor": plays_for,
            "teams": teams,
        })
    return stars


def write_stars(rosters):
    stars = build_stars(rosters)
    json.dump({"_about": "BB2025 star players from FUMBBL roster 8513 (_Star Players). `playsFor` = special-rule keywords gating eligibility; `teams` = resolved eligible BB2025 team names (see build_stars/FAVOURED_MAP in scripts/generate_dataset.py).", "stars": stars},
              open(os.path.join(OUT, "stars.json"), "w", encoding="utf-8"), indent=1)
    print(f"Wrote {len(stars)} stars to {OUT}")


def main():
    if "--stars-only" in sys.argv:
        # Reuse the committed rosters.json (their specialRules) instead of refetching all 30.
        rosters = json.load(open(os.path.join(OUT, "rosters.json"), encoding="utf-8"))["rosters"]
        write_stars(rosters)
        return
    print("Fetching FUMBBL roster list for ruleset", RULESET)
    listing = [r for r in get(f"roster/list/{RULESET}") if r.get("playable") == "1"]
    print(f"  {len(listing)} playable rosters")
    rosters = []
    for r in sorted(listing, key=lambda x: x["name"]):
        print("  -", r["name"])
        rosters.append(convert_roster(r["id"]))

    # skills.json from fork categories
    cats = fork_skill_categories()
    descr = json.load(open(SKILL_DESCR, encoding="utf-8")) if os.path.exists(SKILL_DESCR) else {}
    skills = {}
    for name, cat in sorted(cats.items()):
        if cat in SELECTABLE:
            entry = {"category": SELECTABLE[cat]}
            if name in ELITE_DEFAULT:
                entry["elite"] = True
            skills[name] = entry
        elif cat in ("TRAIT", "EXTRAORDINARY"):
            skills[name] = {"trait": True}
        # STAT_INCREASE skipped

    teams = [{"name": r["name"], "defaultTier": r["tier"] or 2} for r in rosters]

    os.makedirs(OUT, exist_ok=True)
    write_stars(rosters)
    json.dump({"_about": "BB2025 rosters generated from FUMBBL ruleset 3906 (see scripts/generate_dataset.py). Category codes G/A/S/P/M/D -> General/Agility/Strength/Passing/Mutation/Devious.", "rosters": rosters},
              open(os.path.join(OUT, "rosters.json"), "w", encoding="utf-8"), indent=1)
    json.dump({"_about": "BB2025 skill metadata: category (incl. Devious) from the fumbbl40k-server fork's bb2025 skill classes; elite defaults to {Block,Guard,Mighty Blow,Dodge}; traits not selectable.", "categories": ["General", "Agility", "Strength", "Passing", "Mutation", "Devious"], "skills": skills},
              open(os.path.join(OUT, "skills.json"), "w", encoding="utf-8"), indent=1)
    json.dump({"_about": "BB2025 team list + suggested starting tier (editable per tournament).", "teams": teams},
              open(os.path.join(OUT, "teams.json"), "w", encoding="utf-8"), indent=1)

    print(f"\nWrote {len(rosters)} rosters, {len(skills)} skills, {len(teams)} teams to {OUT}")
    print("Sample:", rosters[0]["name"], "-", [p["name"] for p in rosters[0]["positions"]])


if __name__ == "__main__":
    main()
