import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPackage } from "@bb/validator";
import { PackageFiles } from "../src/data";
import {
  packageRaceRules,
  packageResponseInfo,
  packageRulesInfo,
  packageTierSummary,
  resolveBuilderPackage,
} from "../src/teamBuilderPackage";

const dir = () => mkdtempSync(join(tmpdir(), "bbtv-tbpkg-"));

const { pkg: BASELINE } = loadPackage({
  name: "Team Builder Baseline",
  goldBudget: 1_000_000,
  eligibleRosters: ["*"],
  special: { insignificantTraitConstraint: false },
});

describe("resolveBuilderPackage", () => {
  it("packageName omitted resolves to the baseline, unmarked as selected", () => {
    const pf = new PackageFiles(dir());
    const resolved = resolveBuilderPackage(pf, BASELINE, undefined);
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) throw new Error("unreachable");
    expect(resolved.pkg).toBe(BASELINE);
    expect(resolved.selected).toBeUndefined();
  });

  it("packageName set to an unknown name returns a clear 4xx-shaped error, never a silent baseline fallback", () => {
    const pf = new PackageFiles(dir());
    const resolved = resolveBuilderPackage(pf, BASELINE, "Does Not Exist Cup");
    expect(resolved).toEqual({ error: 'Unknown tournament package "Does Not Exist Cup".' });
  });

  it("packageName set to a saved package resolves that package and marks it selected", () => {
    const pf = new PackageFiles(dir());
    pf.save({ name: "Lustrian Cup", goldBudget: 1_150_000, eligibleRosters: ["*"] });
    const resolved = resolveBuilderPackage(pf, BASELINE, "Lustrian Cup");
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) throw new Error("unreachable");
    expect(resolved.pkg.name).toBe("Lustrian Cup");
    expect(resolved.pkg.goldBudget).toBe(1_150_000);
    expect(resolved.selected).toEqual({ name: "Lustrian Cup", description: undefined });
  });

  it("is case-insensitive on the saved package name, same as PackageFiles.get", () => {
    const pf = new PackageFiles(dir());
    pf.save({ name: "Lustrian Cup", goldBudget: 1_150_000, eligibleRosters: ["*"] });
    const resolved = resolveBuilderPackage(pf, BASELINE, "lustrian cup");
    expect("error" in resolved).toBe(false);
  });
});

describe("packageResponseInfo", () => {
  it("returns undefined when no package was selected (existing callers see no shape change)", () => {
    expect(packageResponseInfo({ pkg: BASELINE }, "Amazon")).toBeUndefined();
  });

  it("surfaces the flat package's name, description and gold budget", () => {
    const { pkg } = loadPackage({
      name: "Lustrian Cup",
      description: "Season 3 tournament rules.",
      goldBudget: 1_150_000,
      eligibleRosters: ["*"],
    });
    const info = packageResponseInfo({ pkg, selected: { name: pkg.name, description: pkg.description } }, "Amazon");
    expect(info).toEqual({ name: "Lustrian Cup", description: "Season 3 tournament rules.", budget: 1_150_000 });
  });

  it("resolves the PER-ROSTER budget through tiers — same package, different race, different budget", () => {
    const { pkg } = loadPackage({
      name: "Tiered Cup",
      eligibleRosters: ["*"],
      goldBudget: 1_000_000, // flat fallback for rosters not in any tier
      tiers: [
        { tier: 1, rosters: ["Amazon"], gold: 1_100_000, starPlayersAllowed: false, bannedStars: [] },
        { tier: 2, rosters: ["Chaos Dwarf"], gold: 1_200_000, starPlayersAllowed: true, bannedStars: [] },
      ],
    });
    const selected = { name: pkg.name, description: pkg.description };
    expect(packageResponseInfo({ pkg, selected }, "Amazon")!.budget).toBe(1_100_000);
    expect(packageResponseInfo({ pkg, selected }, "Chaos Dwarf")!.budget).toBe(1_200_000);
    // A roster in no tier falls back to the package's flat goldBudget.
    expect(packageResponseInfo({ pkg, selected }, "Human")!.budget).toBe(1_000_000);
  });
});

// A compact Spike!-shaped package: two tiers, tier 2 with its own packs, star SP per tier.
const SPIKELIKE = loadPackage({
  name: "Mini Spike",
  dataNote: "Star SP table transcribed - spot-check.",
  eligibleRosters: ["*"],
  goldBudget: null,
  skillAllotment: { skillPointBudget: 0, maxPerPlayer: 1 },
  skillPackages: [
    { label: "Global A", gold: 1_000_000, skillPointBudget: 5 },
    { label: "Global B", gold: 970_000, skillPointBudget: 6, maxPerPlayer: 2 },
  ],
  starPlayers: {
    allowed: true,
    maxCount: 2,
    maxCombinedCost: null,
    paidInSkillPoints: true,
    spCostByTier: {
      "Griff Oberwald": [6, 5],
      "Akhorne the Squirrel": [1, 1],
      "The Black Gobbo": [null, 3],
    },
  },
  tiers: [
    { tier: 1, label: "Tier 1", rosters: ["Amazon"], gold: 1_100_000, skillPointBudget: 6, starPlayersAllowed: true, bannedStars: [] },
    {
      tier: 2,
      rosters: ["Goblin", "Halfling"],
      gold: 1_140_000,
      skillPointBudget: 11,
      starPlayersAllowed: true,
      bannedStars: ["Morg 'n' Thorg"],
      skillPackages: [
        { label: "Pack 1", gold: 1_140_000, skillPointBudget: 11, maxPerPlayer: 1 },
        { label: "Pack 2", gold: 1_110_000, skillPointBudget: 12, maxPerPlayer: 2 },
      ],
    },
  ],
}).pkg;

describe("packageTierSummary", () => {
  it("derives one row per tier with its key numbers", () => {
    const rows = packageTierSummary(SPIKELIKE);
    expect(rows.map((r) => [r.tier, r.label, r.gold, r.skillPointBudget])).toEqual([
      [1, "Tier 1", 1_100_000, 6],
      [2, "Tier 2", 1_140_000, 11], // label defaulted from the tier number
    ]);
    expect(rows[1]!.rosters).toEqual(["Goblin", "Halfling"]);
  });

  it("tier packs override the global set; tiers without their own inherit it", () => {
    const rows = packageTierSummary(SPIKELIKE);
    expect(rows[0]!.packs.map((p) => p.label)).toEqual(["Global A", "Global B"]);
    expect(rows[1]!.packs).toEqual([
      { label: "Pack 1", gold: 1_140_000, skillPointBudget: 11, maxPerPlayer: 1 },
      { label: "Pack 2", gold: 1_110_000, skillPointBudget: 12, maxPerPlayer: 2 },
    ]);
  });

  it("is empty for a non-tiered package", () => {
    expect(packageTierSummary(BASELINE)).toEqual([]);
  });
});

describe("packageRaceRules", () => {
  it("surfaces a tiered race's tier, budget, SP, packs and star SP prices (cheap-first, null-priced omitted)", () => {
    const rules = packageRaceRules(SPIKELIKE, "Goblin");
    expect(rules.tierNumber).toBe(2);
    expect(rules.tierLabel).toBe("Tier 2");
    expect(rules.gold).toBe(1_140_000);
    expect(rules.skillPointBudget).toBe(11);
    expect(rules.packs.map((p) => p.label)).toEqual(["Pack 1", "Pack 2"]);
    expect(rules.bannedStars).toEqual(["Morg 'n' Thorg"]);
    expect(rules.stars).toMatchObject({ allowed: true, maxCount: 2, paidInSkillPoints: true });
    expect(rules.stars.spCosts).toEqual([
      { name: "Akhorne the Squirrel", sp: 1 },
      { name: "The Black Gobbo", sp: 3 },
      { name: "Griff Oberwald", sp: 5 },
    ]);
  });

  it("a tier-1 race omits stars priced null in its tier column", () => {
    const rules = packageRaceRules(SPIKELIKE, "Amazon");
    expect(rules.stars.spCosts).toEqual([
      { name: "Akhorne the Squirrel", sp: 1 },
      { name: "Griff Oberwald", sp: 6 },
    ]);
  });

  it("an untiered race resolves flat: package budget, no tier fields, no star SP list", () => {
    const rules = packageRaceRules(BASELINE, "Human");
    expect(rules.source).toBe("flat");
    expect(rules.tierNumber).toBeUndefined();
    expect(rules.gold).toBe(1_000_000);
    expect(rules.stars.spCosts).toBeUndefined();
  });
});

describe("packageRulesInfo", () => {
  it("without a roster: tier summary + dataNote, no budget/race block", () => {
    const info = packageRulesInfo(SPIKELIKE);
    expect(info.name).toBe("Mini Spike");
    expect(info.dataNote).toBe("Star SP table transcribed - spot-check.");
    expect(info.tierSummary).toHaveLength(2);
    expect(info.budget).toBeUndefined();
    expect(info.race).toBeUndefined();
  });

  it("with a roster: budget populated from that race's resolved gold (the Slot Builder auto-fill)", () => {
    const info = packageRulesInfo(SPIKELIKE, "Halfling");
    expect(info.budget).toBe(1_140_000);
    expect(info.race?.tierNumber).toBe(2);
  });

  it("a package that defines no budget for the race reports null — the client keeps manual entry", () => {
    const { pkg } = loadPackage({ name: "SP Only Cup", eligibleRosters: ["*"], goldBudget: null });
    const info = packageRulesInfo(pkg, "Human");
    expect(info.budget).toBeNull();
    expect(info.dataNote).toBeUndefined();
  });
});
