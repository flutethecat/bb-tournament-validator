import { describe, expect, it } from "vitest";
import { loadPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { teamBuilderTierCatalog } from "../src/teamBuilderTiers";

describe("teamBuilderTierCatalog", () => {
  it("uses package tier assignments and falls back to dataset defaults", () => {
    const { pkg } = loadPackage({
      name: "Custom Tier Cup",
      eligibleRosters: ["*"],
      tiers: [
        { tier: 4, rosters: ["Amazon"], gold: null, starPlayersAllowed: true, bannedStars: [] },
        { tier: 1, rosters: ["orc"], gold: null, starPlayersAllowed: true, bannedStars: [] },
      ],
    });

    const catalog = teamBuilderTierCatalog(pkg, bb2025);
    expect(catalog.find((row) => row.name === "Amazon")).toEqual({
      name: "Amazon",
      tier: 4,
      source: "package",
    });
    expect(catalog.find((row) => row.name === "Orc")).toEqual({
      name: "Orc",
      tier: 1,
      source: "package",
    });

    const unassigned = catalog.find((row) => row.name === "Dwarf");
    expect(unassigned).toEqual({
      name: "Dwarf",
      tier: bb2025.teams.find((team) => team.name === "Dwarf")?.defaultTier,
      source: "default",
    });
    expect(catalog.map((row) => row.name)).toEqual(bb2025.teams.map((team) => team.name));
  });
});
