#!/usr/bin/env python3
"""
Generate the Spike! 2026 (TG Rules Pack) tournament package JSON from the compact
data transcribed off the two rules-pack images.

Model:
  * 6 tiers (team assignments + base gold + base SP).
  * Each tier offers 3 choose-one skill packages:
      Pack 1: base SP @ base gold
      Pack 2: +1 SP, -30k gold   (Tier 6 Pack 2 also allows stacking 2 skills/player)
      Pack 3: -1 SP, +30k gold
  * Stars are hired with SKILL POINTS, priced per tier (spCostByTier); paidInSkillPoints
    excludes their gold. `null` = star not available in that tier.

⚠ STAR SP TABLE was hand-transcribed from an image — SPOT-CHECK before competitive use.

Run:  python tournament-packages/build-spike-2026.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "spike-2026.json")

# tier -> (gold budget, base SP, [teams])
TIERS = {
    1: (1100000, 6, ["Old World Alliance"]),
    2: (1105000, 7, ["Dark Elf", "High Elf", "Skaven", "Orc", "Shambling Undead",
                      "Underworld Denizens", "Wood Elf", "Lizardmen", "Amazon", "Necromantic Horror"]),
    3: (1110000, 8, ["Dwarf", "Human", "Nurgle", "Norse"]),
    4: (1120000, 9, ["Elven Union", "Imperial Nobility", "Tomb Kings", "Vampire",
                     "Chaos Chosen", "Chaos Renegade", "Chaos Dwarf"]),
    5: (1130000, 10, ["Black Orc", "Bretonnian", "Snotling", "Khorne"]),
    6: (1140000, 11, ["Gnome", "Goblin", "Halfling", "Ogre"]),
}

# Star SP cost per tier (index = tier-1); "X" = not available in that tier.
X = None
STAR_SP = {
    "Akhorne the Squirrel": [1, 1, 1, 1, 1, 1],
    "Anqi Panqi": [X, 3, X, X, X, X],
    "Barik Farblast": [0, X, 0, 0, 0, 0],
    "Bilerot Vomitflesh": [X, X, 3, 3, X, X],
    "Boa Kon'ssstrictor": [X, 2, X, X, X, X],
    "Bommer Dribblesnot": [X, X, X, X, 9, 10],
    "Captain Karina Von Rieze": [X, 4, X, 4, X, X],
    "Cindy Piewhistle": [X, X, X, X, X, 10],
    "Count Luthor": [X, 5, X, 5, X, X],
    "Deeproot Strongbranch": [X, 4, X, X, X, 4],
    "Dribl": [X, 5, X, X, X, X],
    "Drul": [X, 5, X, X, X, X],
    "Eldrel Sidewinder": [X, 4, X, 4, X, X],
    "Estelle La Veneaux": [X, 4, X, X, X, X],
    "Fungus the Loon": [X, 3, X, 3, 3, 3],
    "Glart Smashrip": [X, 4, X, X, 5, 5],
    "Gloriel Summerbloom": [X, 2, X, 2, X, X],
    "Glottal Stop": [X, 3, X, X, X, X],
    "Gombrindal": [3, X, 3, 3, 3, 3],
    "Grak": [3, 3, 3, 3, 3, 3],
    "Crumbleberry": [3, 3, 3, 3, 3, 3],
    "Grashnack Blackhoof": [X, X, 3, 3, 3, X],
    "Gretchen Watcher": [X, 1, X, 1, X, X],
    "Griff Oberwald": [X, X, 8, 8, 9, X],
    "Grim Ironjaw": [X, X, 4, X, X, 4],
    "Guffle Pusmaw": [X, X, 2, 2, X, X],
    "Hackflem Skuttlespike": [X, 6, X, X, X, X],
    "Helmut Wulf": [3, X, 3, 3, 3, X],
    "H'Thark the Unstoppable": [X, 5, X, 5, 6, 7],
    "Ivan the Animal": [X, 5, X, 5, X, X],
    "Ivar Eriksson": [4, X, 4, 4, 4, X],
    "Jerimah Kool": [X, 4, X, 4, X, X],
    "Josef Bugman": [3, X, 3, 3, 3, 3],
    "Jordell Freshbreeze": [X, 3, X, 3, X, 5],
    "Karla Von Kill": [3, 3, 3, 3, 3, X],
    "Kiroth Krackeneye": [X, 3, X, 3, X, X],
    "Kreek Rustgouger": [X, 5, X, X, 5, 5],
    "Lord Borak": [X, X, 4, 4, 4, X],
    "Lucien Swift": [X, 3, X, 3, X, X],
    "Valen Swift": [X, 3, X, 3, X, X],
    "Maple Highgrove": [X, 5, X, X, X, 4],
    "Max Spleenripper": [X, X, X, 3, 3, X],
    "Morg 'n' Thorg": [X, X, 8, 8, 9, 9],
    "Nobbla Blackwart": [X, 4, X, 5, 5, 5],
    "Puggy Baconbreath": [3, X, 3, 3, 3, 3],
    "Rashnack Backstabber": [X, 2, X, 2, 2, 2],
    "Ripper Bolgrot": [X, 4, X, 4, 4, 4],
    "Rodney Roachbait": [X, 2, X, X, X, 2],
    "Rowana Forestfoot": [X, 3, X, X, X, 3],
    "Roxanna Darknail": [X, 3, X, 3, X, X],
    "Rumbelow Sheepskin": [X, X, X, X, X, 3],
    "Scrappa Sorehead": [X, 2, X, 2, 2, 2],
    "Scyla Anfingrimm": [X, X, X, 4, 4, X],
    "Skitter Stab Stab": [X, 4, X, X, X, X],
    "Skrog Snowpelt": [5, X, 5, 5, 6, 6],
    "Skrull Halfheight": [X, 0, 0, 0, X, 0],
    "Swiftvine Shimmershard": [X, 2, X, X, X, 2],
    "The Black Gobbo": [X, 6, X, 7, 7, 8],
    "The Mighty Zug": [3, X, 3, 3, 3, 3],
    "Thorsson Stoutmead": [5, X, 5, 5, 5, 6],
    "Wilhelm Chaney": [X, 4, X, 4, X, X],
    "Willow Rosebark": [X, 1, X, X, X, 1],
    "Withergrasp Doubledrool": [X, X, 2, 2, X, X],
    "Varag Ghoul-Chewer": [X, 4, X, 5, 5, 5],
    "Zolcath the Zoat": [X, 4, X, 4, X, X],
    "Zzarg Madeye": [X, X, X, 2, 2, X],
}

# Inducements permitted (names on the pack → our dataset ids where they exist).
INDUCEMENTS = [
    "temp_agency_cheerleaders", "part_time_assistant_coaches", "team_mascot", "weather_mage",
    "bloodweiser_kegs", "bribes", "extra_team_training", "halfling_master_chef", "biased_referee",
]


def tier_packages(gold, sp, tier):
    packs = [
        {"label": "Pack 1", "gold": gold, "skillPointBudget": sp, "maxPerPlayer": 1},
        {"label": "Pack 2", "gold": gold - 30000, "skillPointBudget": sp + 1,
         "maxPerPlayer": 2 if tier == 6 else 1},
        {"label": "Pack 3", "gold": gold + 30000, "skillPointBudget": sp - 1, "maxPerPlayer": 1},
    ]
    return packs


def main():
    tiers = []
    for t in sorted(TIERS):
        gold, sp, teams = TIERS[t]
        tiers.append({
            "tier": t,
            "label": f"Tier {t}",
            "rosters": teams,
            "gold": gold,
            "skillPointBudget": sp,
            "starPlayersAllowed": True,
            "bannedStars": [],
            "skillPackages": tier_packages(gold, sp, t),
        })

    pkg = {
        "$schema": "../schemas/tournament-package.schema.json",
        "name": "Spike! 2026",
        "ruleset": "bb2025-default",
        "description": "Spike! 2026 (TG Rules Pack). 6 tiers, each choosing one of 3 gold+SP skill packages. Skills: primary 1 SP, secondary 2 SP, elite +0.5 SP. Stars hired with Skill Points, priced per tier (max 2). Min 11 players, no stat increases, 1 skill/player (stacking only via Tier 6 Pack 2). STAR SP TABLE transcribed from the rules-pack image - spot-check before competitive use. Highlander star rule is opponent-dependent and not enforced in single-roster validation.",
        "dataNote": "Star SP table transcribed from the rules-pack image - spot-check before competitive use.",
        "eligibleRosters": sorted({tm for _, _, ts in TIERS.values() for tm in ts}),
        "skillAllotment": {
            "skillPointBudget": 0,
            "primaryCostSP": 1,
            "secondaryMultiplier": 2,
            # OWNER RULING (08-27, supersedes the earlier flat-1.5 transcription): elite is a
            # +0.5 SURCHARGE on top of access cost — primary elite 1.5, SECONDARY elite 2.5.
            # (The rules-pack image's "Elite Skills 1.5 SP" was previously read as a flat
            # override, which priced secondary elites at 1.5; the divergent case was flagged
            # to the owner at the ruling.)
            "eliteSurchargeSP": 0.5,
            "eliteSkills": ["Block", "Guard", "Mighty Blow", "Dodge"],
            "skillCostSP": {},
            "maxPerPlayer": 1,
            "maxSameSkillTeamwide": None,
        },
        "goldBudget": None,
        "starPlayers": {
            "allowed": True,
            "maxCount": 2,
            "maxCombinedCost": None,
            "paidInSkillPoints": True,
            "spCostByTier": STAR_SP,
        },
        "inducements": {"allowed": INDUCEMENTS, "caps": {}},
        "sideline": {"maxReRolls": 8, "maxApothecary": 1, "maxCheerleaders": None,
                     "maxAssistantCoaches": None, "maxDedicatedFans": None},
        "special": {"insignificantTraitConstraint": True, "stalling": True, "slannAllowed": False,
                    "statIncreasesAllowed": False, "bannedSkills": [], "minPlayers": 11},
        "tiers": tiers,
    }
    json.dump(pkg, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"Wrote {OUT}: {len(tiers)} tiers, {sum(len(t['rosters']) for t in tiers)} teams, {len(STAR_SP)} stars.")


if __name__ == "__main__":
    main()
