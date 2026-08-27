/**
 * SKETCH (unbuilt). BB2025 rules dataset — the shape of data/bb2025/*.json.
 * INJECTED into the core (imported JSON or passed in); the core never reads disk.
 */

import type { Target } from "../model/roster";

export type SkillCategory = "General" | "Agility" | "Strength" | "Passing" | "Mutation" | "Devious";

export interface DatasetPosition {
  id: string;
  name: string;
  /** Alternate printings, e.g. "Eagle Warrior Linewoman" for "Eagle Warrior". */
  aliases?: string[];
  /** lineman | thrower | blitzer | blocker | catcher | bigguy | special */
  type: string;
  /** Max copies on a team (the 0-16 / 0-2 limits). */
  max: number;
  cost: number;
  MA: number;
  ST: number;
  AG: Target;
  PA: Target;
  AV: Target;
  /** Base (free) skills. */
  skills: string[];
  primaryCategories: SkillCategory[];
  secondaryCategories: SkillCategory[];
  keywords: string[];
}

export interface DatasetStarPlayer {
  name: string;
  cost: number;
}

export interface DatasetRoster {
  id: string;
  name: string;
  tier?: number;
  specialRules: string[];
  reRollCost: number;
  maxReRolls: number;
  apothecaryAllowed: boolean;
  maxBigGuys: number;
  positions: DatasetPosition[];
  starPlayers: DatasetStarPlayer[];
}

export interface SkillMeta {
  category?: SkillCategory;
  /** Rulebook-Elite (the package's eliteSkills defaults to these). */
  elite?: boolean;
  /** Traits are not normally selectable as added skills. */
  trait?: boolean;
}

export interface DatasetInducement {
  name: string;
  /** Exact InducementType.getName() value used by the fork's Inducement XML. */
  wireName?: string;
  cost: number | null;
  max: number | null;
  /** Reduced cap when the team has `reducedSpecialRule` (e.g. Bribes: 3 → 6 under Bribery and Corruption). */
  reducedMax?: number | null;
  /** Reduced per-unit cost under `reducedSpecialRule`. */
  reducedCost?: number | null;
  /** Special rule that unlocks `reducedMax`/`reducedCost`. */
  reducedSpecialRule?: string;
}

export interface DatasetTeam {
  name: string;
  /** Suggested starting tier (editable per tournament). */
  defaultTier: number;
  aliases?: string[];
}

export interface DatasetStar {
  name: string;
  /** BB2025 team names this star may be hired by (resolved from `playsFor`). Empty = no eligibility data. */
  teams: string[];
  cost: number | null;
  /** FUMBBL special-rule keywords gating eligibility, e.g. ["Badlands Brawl"] or ["(Any)"]. Provenance for `teams`. */
  playsFor?: string[];
}

export interface Dataset {
  /** Keyed by race name (case-insensitive lookup via helpers). */
  rosters: Record<string, DatasetRoster>;
  skills: Record<string, SkillMeta>;
  inducements: Record<string, DatasetInducement>;
  /** BB2025 team list (for tier configuration). */
  teams: DatasetTeam[];
  /** Star player names (for banned-star config + generic star detection). */
  stars: DatasetStar[];
}
