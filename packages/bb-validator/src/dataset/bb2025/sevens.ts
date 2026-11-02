/**
 * Blood Bowl Sevens (Spike! Journal 22, https://bloodbowlbase.ru/bb2025/spike_journal/issue_22/), owner-approved defaults
 * 11-02 (spec-sevens-rules-2026-11-02). A package with `format: "sevens"` gets SEVENS_PROFILE layered UNDER it by
 * loadPackage(), so every field stays an organiser override. Pure data; no Node imports.
 *
 *   budget 600k (#team-draft-budget), 7-11 players (#number-of-players), at most 4 players without the Lineman keyword
 *   (#player-positions), one Veteran Lineman (#veterans), rerolls 100k each, capped at 6 (#purchasing-team-re-rolls, the
 *   dugout tracker), coaches / cheerleaders 20k max 3, apothecary 80k max 1, Dedicated Fans 20k each up to 5, starting at 0
 *   in Matched Play (#dedicated-fans), the Sevens inducement list (#list-of-inducements), no Star Players or Mercenaries,
 *   added skills cost no gold (#purchasing-skills: bought skills don't add to Current Value), one added skill per player,
 *   at most 2 Elite skills. Skill Points by Sevens tier (T1 1 ... T4 4) live in the shipped Matched Play package's tiers.
 */

import type { DatasetInducement, DatasetPosition } from "../types";
import { normName } from "../lookup";
import type { DeepPartial } from "../../package/resolve";
import type { StaffPrices, TierDef, TournamentPackage } from "../../package/types";
import sevensInducementsJson from "./sevensInducements.json";

/** The Sevens team tier table (SJ22 #sevens-team-tiers), read from the page's HTML table. Slann is not on it. */
export const SEVENS_TEAM_TIERS: ReadonlyArray<{ tier: number; rosters: readonly string[] }> = [
  { tier: 1, rosters: ["Amazon", "Chaos Dwarf", "Dark Elf", "Elven Union", "Human", "High Elf", "Necromantic Horror", "Norse", "Old World Alliance", "Skaven", "Wood Elf"] },
  { tier: 2, rosters: ["Bretonnian", "Dwarf", "Imperial Nobility", "Lizardmen", "Nurgle", "Orc", "Shambling Undead", "Tomb Kings", "Vampire"] },
  { tier: 3, rosters: ["Black Orc", "Chaos Chosen", "Chaos Renegade", "Halfling", "Khorne", "Underworld Denizens"] },
  { tier: 4, rosters: ["Gnome", "Goblin", "Ogre", "Snotling"] },
];

/** Every team on the Sevens tier table (the default eligible rosters: all BB2025 teams but Slann). */
export const SEVENS_TEAMS: readonly string[] = SEVENS_TEAM_TIERS.flatMap((t) => t.rosters);

/** The keyword that makes a position a Lineman for the non-Lineman cap and Veteran eligibility (owner Q2: the keyword
 *  decides, so Halfling Hopefuls, the OWA Dwarf Lineman and the Chaos Renegade Goblin / Orc / Skaven / Dark Elf count). */
export const SEVENS_LINEMAN_KEYWORD = "Lineman";
/** Does this position carry the Lineman keyword (the Sevens test, keyword only, never the position name or type)? */
export function hasLinemanKeyword(position: Pick<DatasetPosition, "keywords"> | undefined): boolean {
  return (position?.keywords ?? []).some((k) => normName(k) === normName(SEVENS_LINEMAN_KEYWORD));
}

/** The Veteran's printed movement change (owner Q11: just MA -1 in the builder). */
export const SEVENS_VETERAN_MA_DELTA = -1;

/** Sevens staff prices (SJ22 #purchasing-team-re-rolls, #assistant-coaches, #cheerleaders, #apothecary, #dedicated-fans). */
export const SEVENS_STAFF_PRICES: Readonly<Required<StaffPrices>> = {
  reRoll: 100_000,
  assistantCoach: 20_000,
  cheerleader: 20_000,
  apothecary: 80_000,
  dedicatedFan: 20_000,
};

/** The Sevens inducement list (replaces the core list for `inducements.set: "sevens"`), keyed by id. */
export const SEVENS_INDUCEMENTS: Readonly<Record<string, DatasetInducement>> = Object.fromEntries(
  (sevensInducementsJson.inducements as Array<DatasetInducement & { id: string }>).map(({ id, ...row }) => [id, row]),
);

/**
 * Matched Play skills per Sevens tier (SJ22 #skill-points / #purchasing-skills) on the existing COUNT-mode knobs: tier N
 * gives N primary slots; two of them may be swapped for the team's ONE secondary (so Tier 1 can't afford one).
 */
export function sevensTierDef(tier: number, rosters: readonly string[]): TierDef {
  return {
    tier,
    label: `Tier ${tier}`,
    rosters: [...rosters],
    gold: null,
    maxPrimary: tier,
    maxSecondary: 0,
    secondarySwap: true,
    secondarySwapRatio: 2,
    secondarySwapMax: 1,
    starPlayersAllowed: false,
    bannedStars: [],
  };
}

/** The SJ22 tier table as package tiers (what the shipped Matched Play package and the Creator's Sevens toggle write). */
export const sevensTiers = (): TierDef[] => SEVENS_TEAM_TIERS.map((t) => sevensTierDef(t.tier, t.rosters));

/**
 * The Sevens profile: the defaults a `format: "sevens"` package starts from (below any `extends` base and the package
 * itself). Owner 11-02 accepted defaults: reroll cap 6, no stars, skill gold 0, fans start 0 (Matched Play), Team Captain
 * kept (core rules), Slann not eligible, tabletop-only.
 */
export const SEVENS_PROFILE: DeepPartial<TournamentPackage> = {
  format: "sevens",
  eligibleRosters: [...SEVENS_TEAMS],
  goldBudget: 600_000,
  staffPrices: { ...SEVENS_STAFF_PRICES },
  skillAllotment: {
    skillPointBudget: 0,
    maxPerPlayer: 1,
    eliteMaxTotal: 2,
    primaryCostGold: 0,
    secondaryCostGold: 0,
    eliteSurchargeGold: 0,
  },
  starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null },
  inducements: { set: "sevens", allowed: ["*"], caps: {} },
  sideline: {
    maxReRolls: 6,
    maxApothecary: 1,
    maxCheerleaders: 3,
    maxAssistantCoaches: 3,
    maxDedicatedFans: 5,
    dedicatedFansStart: 0,
  },
  special: {
    minPlayers: 7,
    maxPlayers: 11,
    maxNonLineman: 4,
    veteran: true,
  },
};
