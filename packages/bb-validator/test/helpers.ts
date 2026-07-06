/** Shared test fixtures: a small fake dataset + roster/package factories. */

import type {
  Dataset,
  Roster,
  RosterPlayer,
  TournamentPackage,
} from "@bb/validator";
import { DEFAULT_SKILL_ALLOTMENT } from "@bb/validator";

export const fakeData: Dataset = {
  rosters: {
    Testers: {
      id: "testers",
      name: "Testers",
      specialRules: [],
      reRollCost: 50000,
      maxReRolls: 6,
      apothecaryAllowed: false,
      maxBigGuys: 1,
      positions: [
        {
          id: "t.lineman",
          name: "Lineman",
          type: "lineman",
          max: 16,
          cost: 50000,
          MA: 6,
          ST: 3,
          AG: "3+",
          PA: "4+",
          AV: "8+",
          skills: [],
          primaryCategories: ["General"],
          secondaryCategories: ["Agility"],
          keywords: ["Test"],
        },
        {
          id: "t.bruiser",
          name: "Bruiser",
          type: "bigguy",
          max: 2,
          cost: 140000,
          MA: 5,
          ST: 5,
          AG: "4+",
          PA: "5+",
          AV: "10+",
          skills: ["Loner"],
          primaryCategories: ["Strength"],
          secondaryCategories: ["General"],
          keywords: ["Test", "Big Guy"],
        },
      ],
      starPlayers: [{ name: "Star Guy", cost: 200000 }],
    },
  },
  skills: {
    Block: { category: "General", elite: true },
    Wrestle: { category: "General" },
    Tackle: { category: "General" },
    Dodge: { category: "Agility", elite: true },
    "Side Step": { category: "Agility" },
    Guard: { category: "Strength", elite: true },
    "Mighty Blow": { category: "Strength", elite: true },
    Leader: { category: "Passing" },
    Horns: { category: "Mutation" },
    Loner: { trait: true },
    Insignificant: { trait: true },
  },
  inducements: {
    bribes: { name: "Bribes", cost: 100000, max: 3 },
  },
};

let nextNumber = 1;

export function player(over: Partial<RosterPlayer> = {}): RosterPlayer {
  return {
    number: over.number ?? nextNumber++,
    positionName: "Lineman",
    MA: 6,
    ST: 3,
    AG: "3+",
    PA: "4+",
    AV: "8+",
    skills: [],
    keywords: ["Test"],
    cost: 50000,
    ...over,
  };
}

export function roster(over: Partial<Roster> = {}): Roster {
  nextNumber = 1;
  const players =
    over.players ?? Array.from({ length: 11 }, () => player());
  return {
    rosterName: "Testers",
    coach: "Coach",
    teamName: "Team",
    sideline: { apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 0, reRolls: 2 },
    inducements: [],
    leagues: [],
    specialRules: [],
    ...over,
    players,
  };
}

export function pkg(over: Partial<TournamentPackage> = {}): TournamentPackage {
  return {
    name: "Test Pack",
    ruleset: "bb2025-default",
    eligibleRosters: ["Testers"],
    skillAllotment: {
      ...DEFAULT_SKILL_ALLOTMENT,
      eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
      skillCostSP: {},
      skillPointBudget: 6,
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
  };
}
