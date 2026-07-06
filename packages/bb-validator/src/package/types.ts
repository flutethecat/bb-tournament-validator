/**
 * SKETCH (unbuilt). TournamentPackage — TS mirror of schemas/tournament-package.schema.json.
 * In the real build this is a zod schema (z.infer gives the type + runtime validation of
 * TO-authored files); sketched here as plain interfaces to stay toolchain-free.
 */

/** One tier's roster membership + per-tier overrides (gold, star access, banned stars). */
export interface TierDef {
  tier: number;
  label?: string;
  /** Race names assigned to this tier. */
  rosters: string[];
  /** Per-tier gold/team-value cap; null = fall back to the package goldBudget. */
  gold: number | null;
  /** Per-tier Skill-Point budget; null/undefined = fall back to skillAllotment.skillPointBudget. */
  skillPointBudget?: number | null;
  /** Whether Star Players may be hired by teams in this tier. */
  starPlayersAllowed: boolean;
  /** Star names banned specifically for this tier. */
  bannedStars: string[];
}

export interface SkillAllotment {
  /** Total SP a team may spend on ADDED skills. */
  skillPointBudget: number;
  primaryCostSP: number; // default 1
  /** Secondary SP = primaryCostSP * this. Ignored when secondaryCostSP is set. */
  secondaryMultiplier: number; // default 2
  secondaryCostSP?: number | null; // default null
  eliteSurchargeSP: number; // default 1
  /** Effective Elite set; defaults to the rulebook-Elite skills. */
  eliteSkills: string[]; // default ["Block","Guard","Mighty Blow","Dodge"]
  /** Per-skill overrides — highest precedence. Loadable from CSV. */
  skillCostSP: Record<string, number>; // default {}
  maxPerPlayer: number | null; // default 2
  maxSameSkillTeamwide: number | null; // default null
}

export interface TournamentPackage {
  name: string;
  ruleset: string; // default "bb2025-default"
  description?: string;
  /** Optional tournament date (ISO yyyy-mm-dd); informational, not validated. */
  date?: string;
  /** Base package to merge over (resolved by loadPackage before validate()). */
  extends?: string;
  /** Race names, or ["*"] for all. When `tiers` is set, tier membership also grants eligibility. */
  eligibleRosters: string[];
  /**
   * Tier configuration. When present, a team's tier drives its gold cap, star
   * access, and banned stars, overriding the package-level equivalents.
   */
  tiers?: TierDef[];
  skillAllotment: SkillAllotment;
  /** Optional parallel gold cap; null = SP-only tournament. */
  goldBudget: number | null;
  starPlayers: {
    allowed: boolean;
    maxCount: number | null;
    maxCombinedCost: number | null;
  };
  inducements: {
    /** Inducement ids, ["*"] for all, [] for none. */
    allowed: string[];
    caps: Record<string, number>;
  };
  sideline: {
    maxReRolls: number | null;
    maxApothecary: number | null;
    maxCheerleaders: number | null;
    maxAssistantCoaches: number | null;
    maxDedicatedFans: number | null;
  };
  special: {
    insignificantTraitConstraint: boolean; // default true
    stalling: boolean; // default true
    slannAllowed: boolean; // default false
    statIncreasesAllowed: boolean; // default false
    bannedSkills: string[]; // default []
    minPlayers: number; // default 11
  };
}

/** Owner-default costing (BB2025 defaults layer). */
export const DEFAULT_SKILL_ALLOTMENT: SkillAllotment = {
  skillPointBudget: 0,
  primaryCostSP: 1,
  secondaryMultiplier: 2,
  secondaryCostSP: null,
  eliteSurchargeSP: 1,
  eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"],
  skillCostSP: {},
  maxPerPlayer: 2,
  maxSameSkillTeamwide: null,
};
