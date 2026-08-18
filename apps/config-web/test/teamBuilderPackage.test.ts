import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPackage } from "@bb/validator";
import { PackageFiles } from "../src/data";
import { packageResponseInfo, resolveBuilderPackage } from "../src/teamBuilderPackage";

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
