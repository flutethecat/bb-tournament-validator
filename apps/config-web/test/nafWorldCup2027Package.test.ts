import { describe, expect, it } from "vitest";
import { loadPackage, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import nafJson from "../../../tournament-packages/naf-world-cup-2027.json";
import { packageRaceRules, packageTierSummary } from "../src/teamBuilderPackage";

const { pkg, problems } = loadPackage(nafJson as unknown as Partial<TournamentPackage>);

describe("NAF World Cup 2027 V2.1 package", () => {
  it("loads cleanly and assigns every published roster exactly once", () => {
    expect(problems).toEqual([]);
    const rosterNames = new Set(bb2025.teams.map((team) => team.name));
    const assigned = pkg.tiers?.flatMap((tier) => tier.rosters) ?? [];
    expect(assigned).toHaveLength(31);
    expect(new Set(assigned).size).toBe(31);
    expect(assigned.filter((name) => !rosterNames.has(name))).toEqual(["Slann"]);
    expect((pkg.teamRules ?? []).map((r) => r.team).sort()).toEqual([...assigned].sort());
  });

  it("encodes the six Gold Budget rows", () => {
    expect(packageTierSummary(pkg).map((t) => t.gold)).toEqual([
      1_080_000, 1_100_000, 1_140_000, 1_160_000, 1_180_000, 1_200_000,
    ]);
  });

  it("resolves per-team gold, SPP, stacking and star access from the tier table", () => {
    const cases: [string, number, number, boolean][] = [
      ["Orc", 1_080_000, 44, false],
      ["Shambling Undead", 1_080_000, 52, false],
      ["Snotling", 1_080_000, 60, true],
      ["Human", 1_100_000, 58, false],
      ["Chaos Renegade", 1_140_000, 66, true],
      ["Black Orc", 1_160_000, 60, true],
      ["Ogre", 1_180_000, 66, true],
      ["Norse", 1_200_000, 58, true],
      ["Dwarf", 1_200_000, 60, false],
      ["Vampire", 1_200_000, 44, false],
    ];
    for (const [race, gold, spp, stars] of cases) {
      const rules = packageRaceRules(pkg, race);
      expect(rules.gold, race).toBe(gold);
      expect(rules.skillPointBudget, race).toBe(spp);
      expect(rules.stars.allowed, race).toBe(stars);
      expect(rules.maxPerPlayer, race).toBe(2);
    }
    const stacked = Object.fromEntries((pkg.teamRules ?? []).map((r) => [r.team, r.maxStackedPlayers]));
    expect(stacked["Orc"]).toBe(0);
    expect(stacked["Human"]).toBe(1);
    expect(stacked["Chaos Chosen"]).toBe(2);
    expect(stacked["Ogre"]).toBe(2);
  });

  it("prices skills per the pack and bans the listed stars (Grak and Crumbleberry as two names)", () => {
    expect(pkg.skillAllotment).toMatchObject({ primaryCostSP: 6, secondaryCostSP: 10, eliteSurchargeSP: 2, maxPerPlayer: 2 });
    expect(pkg.bannedStars).toHaveLength(16);
    const known = new Set(bb2025.stars.map((s) => s.name));
    expect((pkg.bannedStars ?? []).filter((n) => !known.has(n))).toEqual([]);
    expect(packageRaceRules(pkg, "Ogre").bannedStars).toContain("Morg 'n' Thorg");
    expect(pkg.inducements).toEqual({
      allowed: ["team_mascot", "bloodweiser_kegs", "bribes", "riotous_rookies", "halfling_master_chef"],
      caps: { bloodweiser_kegs: 2 },
    });
  });
});
