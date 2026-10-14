import { describe, expect, it } from "vitest";
import { loadPackage, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import eurobowlJson from "../../../tournament-packages/eurobowl-2026.json";
import { packageRaceRules, packageTierSummary } from "../src/teamBuilderPackage";

const { pkg, problems } = loadPackage(
  eurobowlJson as unknown as Partial<TournamentPackage>,
);

describe("EuroBowl 2026 preset", () => {
  it("loads without normalization problems and assigns every published roster once", () => {
    expect(problems).toEqual([]);
    const rosterNames = new Set(bb2025.teams.map((team) => team.name));
    const assigned = pkg.tiers?.flatMap((tier) => tier.rosters) ?? [];

    expect(assigned).toHaveLength(31);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.filter((name) => !rosterNames.has(name))).toEqual(["Slann"]);
  });

  it("encodes the seven published budget, Skill Gold, and Flowing Funds rows", () => {
    expect(packageTierSummary(pkg).map((tier) => ({
      tier: tier.tier,
      gold: tier.gold,
      skillGold: tier.skillPointBudget,
      flowingOptions: tier.packs.length,
    }))).toEqual([
      { tier: 1, gold: 1_070_000, skillGold: 120, flowingOptions: 2 },
      { tier: 2, gold: 1_070_000, skillGold: 140, flowingOptions: 3 },
      { tier: 3, gold: 1_080_000, skillGold: 160, flowingOptions: 4 },
      { tier: 4, gold: 1_100_000, skillGold: 190, flowingOptions: 4 },
      { tier: 5, gold: 1_120_000, skillGold: 220, flowingOptions: 4 },
      { tier: 6, gold: 1_140_000, skillGold: 240, flowingOptions: 5 },
      { tier: 7, gold: 1_150_000, skillGold: 270, flowingOptions: 6 },
    ]);

    expect(packageRaceRules(pkg, "Amazon").packs).toEqual([
      { label: "20 to Skill Gold", gold: 1_070_000, skillPointBudget: 160, maxPerPlayer: 2 },
      { label: "10 Team / 10 Skill", gold: 1_080_000, skillPointBudget: 150, maxPerPlayer: 2 },
      { label: "20 to Team Budget", gold: 1_090_000, skillPointBudget: 140, maxPerPlayer: 2 },
    ]);
  });

  it("applies advancement prices, star access, bans, and inducement allow-list", () => {
    expect(pkg.skillAllotment).toMatchObject({
      primaryCostSP: 20,
      secondaryCostSP: 40,
      eliteSurchargeSP: 10,
      maxPerPlayer: 2,
      maxStackedPlayers: 3,
    });
    expect(packageRaceRules(pkg, "Amazon").stars.allowed).toBe(false);
    expect(packageRaceRules(pkg, "Ogre").stars.allowed).toBe(true);
    expect(pkg.starPlayers.spCostByTier?.["Akhorne the Squirrel"]).toEqual([
      null, null, null, null, 50, 40, 40,
    ]);
    expect(pkg.starPlayers.spCostByTier?.["Deeproot Strongbranch"]).toEqual([
      null, null, null, null, 100, 80, 80,
    ]);
    expect(pkg.bannedStars).toContain("Morg 'n' Thorg");
    expect(pkg.inducements.allowed).toEqual([
      "biased_referee",
      "bloodweiser_kegs",
      "bribes",
      "halfling_master_chef",
      "mortuary_assistant",
      "plague_doctor",
      "riotous_rookies",
      "team_mascot",
      "wandering_apothecaries",
      "weather_mage",
    ]);
  });

  it("uses canonical BB2025 star names for every published Veteran and Legend", () => {
    const starNames = new Set(bb2025.stars.map((star) => star.name));
    const configured = Object.keys(pkg.starPlayers.spCostByTier ?? {});
    expect(configured).toHaveLength(46);
    expect(configured.filter((name) => !starNames.has(name))).toEqual(["Josef Bugman"]);
  });
});
