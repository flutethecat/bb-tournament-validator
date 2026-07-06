/**
 * Built-in tournament-package presets the wizard can load as a starting point.
 *
 * IMPORTANT (owner-approved framing 2026-07-06): our packages use the configurable
 * per-skill Skill-Point (SP) model. Real-world packs use different costing:
 *   - Eurobowl 2026 = GOLD, tiered PER RACE (e.g. Amazon 1060k team + 120k gold
 *     skill budget, max 3 secondary, max 3 stacks, no stars). NAF living ruleset
 *     EB0111.pdf; bbtc.pl ruleset EB2026_02.
 *   - Amorical Cup 2026 = SQUAD format (4 coaches, 10 squad points by team tier).
 * Neither maps 1:1 to a single-roster SP package, so the presets below capture the
 * per-coach constraints that DO map and flag the rest in `description`. They are a
 * starting point for a TO, not a certified reproduction — always verify vs the pack.
 */

import { DEFAULT_SKILL_ALLOTMENT, type TournamentPackage } from "@bb/validator";

export interface Preset {
  id: string;
  label: string;
  pkg: TournamentPackage;
}

const base = (over: Partial<TournamentPackage>): TournamentPackage => ({
  name: "New Tournament",
  ruleset: "bb2025-default",
  eligibleRosters: ["*"],
  skillAllotment: {
    ...DEFAULT_SKILL_ALLOTMENT,
    eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
    skillCostSP: {},
  },
  goldBudget: null,
  starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: null },
  inducements: { allowed: ["*"], caps: {} },
  sideline: {
    maxReRolls: 8,
    maxApothecary: 1,
    maxCheerleaders: null,
    maxAssistantCoaches: null,
    maxDedicatedFans: null,
  },
  special: {
    insignificantTraitConstraint: true,
    stalling: true,
    slannAllowed: false,
    statIncreasesAllowed: false,
    bannedSkills: [],
    minPlayers: 11,
  },
  ...over,
});

export const PRESETS: Preset[] = [
  {
    id: "bb2025-default",
    label: "BB2025 Default (SP)",
    pkg: base({
      name: "BB2025 Default",
      description: "Baseline BB2025 constraints with the default Skill-Point costing. No added-skill budget until you set one.",
      skillAllotment: {
        ...DEFAULT_SKILL_ALLOTMENT,
        eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
        skillCostSP: {},
        skillPointBudget: 0,
      },
    }),
  },
  {
    id: "resurrection-6-2",
    label: "Resurrection 6+2 skills (SP)",
    pkg: base({
      name: "Resurrection (6 primary + 2 secondary)",
      description: "Common resurrection format expressed in Skill Points: 6 primary (1 SP) + 2 secondary (2 SP) = 10 SP, Elite +1. Stars off. Adjust to taste.",
      starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null },
      skillAllotment: {
        ...DEFAULT_SKILL_ALLOTMENT,
        eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
        skillCostSP: {},
        skillPointBudget: 10,
        maxPerPlayer: 2,
      },
    }),
  },
  {
    id: "eurobowl-2026-approx",
    label: "Eurobowl 2026 (approx, SP-mapped)",
    pkg: base({
      name: "Eurobowl 2026 (approx)",
      description:
        "APPROXIMATION. Eurobowl 2026 natively uses a GOLD skill budget tiered PER RACE (e.g. Amazon 1060k team + 120k skill budget) — not representable as one SP number here. Captured faithfully: no Star Players, min 11, max 3 same-skill stacks, max 3 secondary. SP budget is a placeholder — verify vs NAF EB0111.pdf / bbtc ruleset EB2026_02 and set per-race gold budgets by hand.",
      starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null },
      skillAllotment: {
        ...DEFAULT_SKILL_ALLOTMENT,
        eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
        skillCostSP: {},
        skillPointBudget: 12,
        maxPerPlayer: 3,
        maxSameSkillTeamwide: 3,
      },
    }),
  },
  {
    id: "amorical-2026-percoach",
    label: "Amorical Cup 2026 (per-coach subset)",
    pkg: base({
      name: "Amorical Cup 2026 (per-coach subset)",
      description:
        "PARTIAL. Amorical Cup 2026 is a SQUAD format (4 coaches, 10 squad points to buy teams by tier, no duplicate race/star within a squad) — the squad/tier layer is OUT OF SCOPE for single-roster validation. This preset only enforces the per-coach parts: min 11 players before stars, one star cap. Manage squad composition manually.",
      starPlayers: { allowed: true, maxCount: 1, maxCombinedCost: null },
      skillAllotment: {
        ...DEFAULT_SKILL_ALLOTMENT,
        eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
        skillCostSP: {},
        skillPointBudget: 0,
      },
    }),
  },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
