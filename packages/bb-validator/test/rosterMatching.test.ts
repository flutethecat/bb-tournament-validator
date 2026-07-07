import { describe, expect, it } from "vitest";
import { findRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

describe("findRoster tolerant matching (real dataset)", () => {
  it("resolves short/variant race names to the canonical team", () => {
    expect(findRoster(bb2025, "Underworld")?.name).toBe("Underworld Denizens");
    expect(findRoster(bb2025, "Undead")?.name).toBe("Shambling Undead");
    expect(findRoster(bb2025, "Necromantic")?.name).toBe("Necromantic Horror");
    expect(findRoster(bb2025, "Chaos Renegades")?.name).toBe("Chaos Renegade"); // plural
    expect(findRoster(bb2025, "OWA")?.name).toBe("Old World Alliance"); // abbreviation
  });

  it("still matches exact names", () => {
    expect(findRoster(bb2025, "Dwarf")?.name).toBe("Dwarf");
    expect(findRoster(bb2025, "underworld denizens")?.name).toBe("Underworld Denizens");
  });

  it("refuses ambiguous prefixes rather than guessing", () => {
    // "Chaos" is a prefix of Chosen/Dwarf/Renegade — must not resolve.
    expect(findRoster(bb2025, "Chaos")).toBeUndefined();
    expect(findRoster(bb2025, "Elf")).toBeUndefined(); // Dark/High/Wood Elf
  });
});
