/**
 * SKETCH (unbuilt). TournamentPackage — TS mirror of schemas/tournament-package.schema.json.
 * In the real build this is a zod schema (z.infer gives the type + runtime validation of
 * TO-authored files); sketched here as plain interfaces to stay toolchain-free.
 */

/**
 * A gold+SP "skill package" a coach may choose (Spike!-style). A roster is legal
 * if it fits ANY package: gold spend ≤ `gold` AND SP spend ≤ `skillPointBudget`
 * (and per-player skill count ≤ `maxPerPlayer` when set, and — if the roster fields
 * a Star — the package permits stars). All values are ABSOLUTE (the value a coach may
 * spend under this package), NOT deltas from a base. Offered globally (package-level
 * `TournamentPackage.skillPackages`, applied to every tier) or per-tier
 * (`TierDef.skillPackages`, which OVERRIDES the global set for that tier).
 */
export interface SkillPackage {
  label?: string;
  gold: number;
  skillPointBudget: number;
  /** Max added skills per player under this package (e.g. Spike: 1, or 2 for a stacking pack). */
  maxPerPlayer?: number | null;
  /** Whether a roster on THIS package may field Star Players. Absent/true = allowed. */
  starPlayersAllowed?: boolean;
}

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
  /** Choose-one-of gold+SP packages for this tier (Spike!-style); legal if the roster fits any. */
  skillPackages?: SkillPackage[];
  /** Per-tier COUNT-mode primary-skill allotment (set with maxSecondary to use count mode). */
  maxPrimary?: number | null;
  /** Per-tier COUNT-mode secondary-skill allotment. */
  maxSecondary?: number | null;
  /** Row-level "Secondary Swap": two primary slots may be traded for one secondary. */
  secondarySwap?: boolean;
  /** Primary slots spent per secondary swap (default 2). */
  secondarySwapRatio?: number;
  /** Maximum secondary swaps; null/undefined = unlimited. */
  secondarySwapMax?: number | null;
  /** Skill stacking: max players allowed >1 added skill (null/undefined = no cap). */
  maxStackedPlayers?: number | null;
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
  eliteSurchargeSP: number; // default 0.5 (owner SP-model ruling 08-27: +0.5 elite surcharge)
  /** Extra SP charged for each added skill beyond a player's FIRST (NAF: +2). Default 0. */
  stackSurchargeSP?: number;
  /** Effective Elite set; defaults to the rulebook-Elite skills. */
  eliteSkills: string[]; // default ["Block","Guard","Mighty Blow","Dodge"]
  /** Per-skill overrides — highest precedence. Loadable from CSV. */
  skillCostSP: Record<string, number>; // default {}
  /**
   * GOLD cost of an added skill (owner 2026-08-10 cost-bucket model), parallel to the SP knobs.
   * All optional; costGold() falls back to the owner's 2026-08-04 flat defaults when unset:
   * primary 20k, secondary 40k, elite surcharge +10k (⇒ elite-primary 30k, elite-secondary 50k).
   */
  primaryCostGold?: number; // default 20000
  secondaryCostGold?: number; // default 40000
  eliteSurchargeGold?: number; // default 10000
  /** Gold twin, parallel to primaryCostGold etc. Default 0. */
  stackSurchargeGold?: number;
  /** Per-skill gold overrides — highest precedence, mirrors skillCostSP. */
  skillCostGold?: Record<string, number>; // default {}
  maxPerPlayer: number | null; // default 2
  maxSameSkillTeamwide: number | null; // default null
  /**
   * Skill stacking (flat default): max players allowed to carry MORE THAN ONE
   * added skill. null = no cap. Tiers / matrix rows / team rules override it.
   */
  maxStackedPlayers?: number | null; // default null
  /**
   * COUNT mode (alternative to the SP pool). When maxPrimary and/or maxSecondary
   * are set, added skills are limited by COUNT per access category instead of the
   * SP budget. Counts come from each added skill's primary/secondary access (which
   * matches the bbtc.pl "Primary skills / Secondary skills" summary).
   */
  maxPrimary?: number | null;
  maxSecondary?: number | null;
  /** Row-level "Secondary Swap": two primary slots may be traded for one secondary. */
  secondarySwap?: boolean;
  /** Primary slots spent per secondary swap (default 2). */
  secondarySwapRatio?: number;
  /** Maximum secondary swaps; null/undefined = unlimited. */
  secondarySwapMax?: number | null;
}

/** Per-team override (line-item rules). Any unset field falls back up the chain. */
export interface TeamRule {
  team: string;
  gold?: number | null;
  skillPointBudget?: number | null;
  maxPrimary?: number | null;
  maxSecondary?: number | null;
  secondarySwap?: boolean;
  /** Primary slots spent per secondary swap (default 2). */
  secondarySwapRatio?: number;
  /** Maximum secondary swaps; null/undefined = unlimited. */
  secondarySwapMax?: number | null;
  maxStackedPlayers?: number | null;
  starPlayersAllowed?: boolean;
  bannedStars?: string[];
}

export interface MatrixColumn {
  /** Total gold allowed for team construction (in gold, e.g. 1150000). */
  gold: number;
}
export interface MatrixRow {
  label?: string;
  primary: number;
  secondary: number;
  secondarySwap: boolean;
  /** Primary slots spent per secondary swap (default 2). */
  secondarySwapRatio?: number;
  /** Maximum secondary swaps; null/undefined = unlimited. */
  secondarySwapMax?: number | null;
  /** Skill stacking: max players allowed >1 added skill (null/undefined = no cap). */
  maxStackedPlayers?: number | null;
}
export interface MatrixCell {
  col: number;
  row: number;
  teams: string[];
  starPlayersAllowed?: boolean;
  bannedStars?: string[];
}
/** A cash×skills grid; a team's cell sets its gold (column) and skill counts (row). */
export interface Matrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  cells: MatrixCell[];
}

export interface TournamentPackage {
  name: string;
  ruleset: string; // default "bb2025-default"
  description?: string;
  /** Short data-quality caveat surfaced in small print by rules-rendering UIs
   *  (e.g. "star SP table transcribed from an image — spot-check"). */
  dataNote?: string;
  /** Optional tournament date (ISO yyyy-mm-dd); informational, not validated. */
  date?: string;
  /** Base package to merge over (resolved by loadPackage before validate()). */
  extends?: string;
  /** Race names, or ["*"] for all. When `tiers` is set, tier membership also grants eligibility. */
  eligibleRosters: string[];
  /**
   * GLOBAL skill packages (Spike!-style choose-one gold+SP+star packs) offered across
   * EVERY tier. A roster is legal if it fits any package. A tier that defines its own
   * `TierDef.skillPackages` OVERRIDES this global set for that tier; tiers without their
   * own packages inherit these. In a non-tiered package these apply to all teams.
   */
  skillPackages?: SkillPackage[];
  /**
   * Tier configuration. When present, a team's tier drives its gold cap, star
   * access, and banned stars, overriding the package-level equivalents.
   */
  tiers?: TierDef[];
  /** Per-team line-item overrides (highest precedence). */
  teamRules?: TeamRule[];
  /** Cash×skills matrix; a team's cell sets its gold + primary/secondary counts. */
  matrix?: Matrix;
  /** Star names banned globally; tiers/matrix/team rules inherit (union) these. */
  bannedStars?: string[];
  skillAllotment: SkillAllotment;
  /** Optional parallel gold cap; null = SP-only tournament. */
  goldBudget: number | null;
  /**
   * When true, the gold cap is a HARD total-value limit: added-skill gold counts against
   * goldBudget alongside Staff + Inducements. Default (false/undefined) = added skills add TV
   * but do NOT eat the roster budget — the cap checks creation gold (Staff + Inducements) only
   * (owner 2026-08-10).
   */
  goldCapIncludesAddedSkills?: boolean;
  starPlayers: {
    allowed: boolean;
    maxCount: number | null;
    maxCombinedCost: number | null;
    /**
     * Spike!-style: stars are hired with SKILL POINTS, priced per tier. Maps a star
     * name → SP cost indexed by (tier − 1); null/absent entry = not available in that
     * tier. When set, the star's SP cost counts against the tier's SP package.
     */
    spCostByTier?: Record<string, (number | null)[]>;
    /**
     * SPP tax on the skill budget by COMBINED star gold. Brackets are ascending and inclusive
     * of `upToGold`; the last bracket uses `upToGold: null` (open-ended). Applies only when the
     * roster has at least one Star Player. Mutually exclusive with spCostByTier (Spike! model).
     */
    spTaxByCombinedCost?: { upToGold: number | null; sp: number }[];
    /** When true, a star's gold cost is NOT counted against the gold budget (paid in SP instead). */
    paidInSkillPoints?: boolean;
  };
  inducements: {
    /** Inducement ids, ["*"] for all, [] for none. */
    allowed: string[];
    caps: Record<string, number>;
    /** Conditional caps, applied on top of `caps` (lowest wins) when the condition holds. */
    capOverrides?: {
      when: { starHasSkill: string };
      caps: Record<string, number>;
      note?: string;
    }[];
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
  eliteSurchargeSP: 0.5,
  stackSurchargeSP: 0,
  eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"],
  skillCostSP: {},
  maxPerPlayer: 2,
  maxSameSkillTeamwide: null,
  maxStackedPlayers: null,
};
