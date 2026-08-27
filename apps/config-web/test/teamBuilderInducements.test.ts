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
    expect(catalog).toHaveLength(16);
    expect(catalog.find((row) => row.key === "bribes")).toEqual({
      key: "bribes",
      label: "Bribes",
      price: 100_000,
      max: 2,
      allowed: true,
    });
    expect(catalog.find((row) => row.key === "bloodweiser_kegs")).toMatchObject({
      price: 50_000,
      max: 2,
      allowed: false,
    });
    expect(catalog.map((row) => row.key)).toEqual([...catalog.map((row) => row.key)].sort());
  });

  it("marks all 16 rosterable inducements allowed for a wildcard package and uses dataset caps", () => {
    const { pkg } = loadPackage({
      name: "Open Cup",
      eligibleRosters: ["*"],
      inducements: { allowed: ["*"], caps: {} },
    });

    const catalog = teamBuilderInducementCatalog(pkg, bb2025);
    expect(catalog).toHaveLength(16);
    expect(catalog.every((row) => row.allowed)).toBe(true);
    expect(catalog.find((row) => row.key === "infamous_coaching_staff")).toMatchObject({
      price: 100_000,
      max: 1,
    });
    expect(catalog.every((row) => Number.isSafeInteger(row.price))).toBe(true);
  });
});
