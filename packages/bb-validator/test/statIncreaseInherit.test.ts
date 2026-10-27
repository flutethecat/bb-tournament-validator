import { describe, expect, it } from "vitest";
import { loadPackage, resolveTeamConfig } from "@bb/validator";

// Sol r2 (10-27): a team rule / tier that only overrides exclusivity must not turn an unlimited
// (null) flat maxPerPlayer into the default 1 — null is an inherited value, not "unset".
describe("statIncreases maxPerPlayer inheritance", () => {
  const base = {
    name: "Stat inherit",
    skillAllotment: { skillPointBudget: 0 },
    statIncreases: { allowed: ["MA", "AV"] as ("MA" | "AV")[], maxPerPlayer: null, exclusiveWithSkills: true },
    tiers: [{ tier: 1, rosters: ["Orc"], gold: 1000000, starPlayersAllowed: true, bannedStars: [], statIncreases: { exclusiveWithSkills: false } }],
    teamRules: [{ team: "Human", statIncreases: { exclusiveWithSkills: false } }],
  };

  it("keeps an unlimited flat maxPerPlayer through a tier and a team rule that only set exclusivity", () => {
    const { pkg } = loadPackage(base);
    const orc = resolveTeamConfig(pkg, "Orc").statIncreases!;
    expect(orc.maxPerPlayer).toBeNull();
    expect(orc.exclusiveWithSkills).toBe(false);
    const human = resolveTeamConfig(pkg, "Human").statIncreases!;
    expect(human.maxPerPlayer).toBeNull();
    expect(human.exclusiveWithSkills).toBe(false);
    expect(resolveTeamConfig(pkg, "Dwarf").statIncreases!.maxPerPlayer).toBeNull();
  });

  it("still defaults to 1 when no level sets maxPerPlayer, and an explicit override wins", () => {
    const { pkg } = loadPackage({ ...base, statIncreases: { allowed: ["MA"] }, teamRules: [{ team: "Human", statIncreases: { maxPerPlayer: 2 } }] });
    expect(resolveTeamConfig(pkg, "Dwarf").statIncreases!.maxPerPlayer).toBe(1);
    expect(resolveTeamConfig(pkg, "Orc").statIncreases!.maxPerPlayer).toBe(1);
    expect(resolveTeamConfig(pkg, "Human").statIncreases!.maxPerPlayer).toBe(2);
  });

  it("a null override (statIncreases: null) keeps an inherited unlimited maxPerPlayer", () => {
    const { pkg } = loadPackage({ ...base, teamRules: [{ team: "Human", statIncreases: null }] });
    expect(resolveTeamConfig(pkg, "Human").statIncreases).toMatchObject({ allowed: [], maxPerPlayer: null });
  });
});
