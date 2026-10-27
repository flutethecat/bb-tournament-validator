import { describe, expect, it } from "vitest";
import { loadPackage, resolveTier } from "@bb/validator";

// Sol r2 (10-27): resolveTier is a Map lookup after a per-package index; in-place tier edits rebuild it.
describe("resolveTier index", () => {
  const base = () =>
    loadPackage({
      name: "Index",
      skillAllotment: { skillPointBudget: 0 },
      tiers: [
        { tier: 1, rosters: ["Orc", "High Elf"], gold: 1000000, starPlayersAllowed: true, bannedStars: [] },
        { tier: 2, rosters: ["Halfling", "Orc"], gold: 900000, starPlayersAllowed: true, bannedStars: [] },
      ],
    }).pkg;

  it("finds the FIRST tier listing a race, case-insensitively", () => {
    const pkg = base();
    expect(resolveTier(pkg, "orc")?.tier).toBe(1);
    expect(resolveTier(pkg, "Halfling")?.tier).toBe(2);
    expect(resolveTier(pkg, "Dwarf")).toBeUndefined();
  });

  it("sees in-place edits of the rosters and of the tiers array", () => {
    const pkg = base();
    expect(resolveTier(pkg, "Dwarf")).toBeUndefined();
    pkg.tiers![1]!.rosters.push("Dwarf");
    expect(resolveTier(pkg, "Dwarf")?.tier).toBe(2);
    pkg.tiers![0] = { ...pkg.tiers![0]!, rosters: ["High Elf"] };
    expect(resolveTier(pkg, "Orc")?.tier).toBe(2);
  });
});
