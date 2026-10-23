import { describe, expect, it } from "vitest";
import { loadPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { teamBuilderInducementCatalog } from "../src/teamBuilderInducements";

describe("teamBuilderInducementCatalog", () => {
  it("returns every rosterable inducement with package caps and permissions", () => {
    const { pkg } = loadPackage({
      name: "Capped Cup",
      eligibleRosters: ["*"],
      inducements: { allowed: ["bribes"], caps: { bribes: 2 } },
    });

    const catalog = teamBuilderInducementCatalog(pkg, bb2025);
    expect(catalog).toHaveLength(17);
    expect(catalog.find((row) => row.key === "bribes")).toEqual({
      key: "bribes",
      label: "Bribes",
      price: 100_000,
      max: 2,
      allowed: true,
      // Package cap still wins over the dataset's reduced max for B&C teams.
      reducedPrice: 50_000,
      reducedMax: 2,
      reducedSpecialRule: "Bribery and Corruption",
    });
    expect(catalog.find((row) => row.key === "bloodweiser_kegs")).toMatchObject({
      price: 50_000,
      max: 2,
      allowed: false,
    });
    expect(catalog.map((row) => row.key)).toEqual([...catalog.map((row) => row.key)].sort());
  });

  it("marks all 17 rosterable inducements allowed for a wildcard package and uses dataset caps", () => {
    const { pkg } = loadPackage({
      name: "Open Cup",
      eligibleRosters: ["*"],
      inducements: { allowed: ["*"], caps: {} },
    });

    const catalog = teamBuilderInducementCatalog(pkg, bb2025);
    expect(catalog).toHaveLength(17);
    expect(catalog.every((row) => row.allowed)).toBe(true);
    expect(catalog.find((row) => row.key === "infamous_coaching_staff")).toMatchObject({
      price: 100_000,
      max: 1,
    });
    expect(catalog.every((row) => Number.isSafeInteger(row.price))).toBe(true);
  });

  it("carries Bribery and Corruption terms: Bribes 50k (max 6), Biased Referee 80k", () => {
    const { pkg } = loadPackage({ name: "Open Cup", eligibleRosters: ["*"], inducements: { allowed: ["*"], caps: {} } });
    const catalog = teamBuilderInducementCatalog(pkg, bb2025);
    expect(catalog.find((row) => row.key === "bribes")).toMatchObject({
      price: 100_000, max: 3, reducedPrice: 50_000, reducedMax: 6, reducedSpecialRule: "Bribery and Corruption",
    });
    expect(catalog.find((row) => row.key === "biased_referee")).toMatchObject({
      price: 120_000, reducedPrice: 80_000, reducedMax: 1, reducedSpecialRule: "Bribery and Corruption",
    });
    expect(catalog.find((row) => row.key === "team_mascot")).not.toHaveProperty("reducedPrice");
  });
});
