import { describe, expect, it } from "vitest";
import { eligibleStarsFor, findStar, normName, starEligibleBySpecialRule } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

const jordell = findStar(bb2025, "Jordell Freshbreeze");
if (!jordell) throw new Error("Jordell Freshbreeze is missing from the BB2025 dataset.");

describe("starEligibleBySpecialRule", () => {
  it("makes Jordell eligible for Gnome's Woodland League choice", () => {
    expect(starEligibleBySpecialRule(jordell, "Woodland League")).toBe(true);
    expect(starEligibleBySpecialRule(jordell, "  woodland   league ")).toBe(true);
  });

  it("does not make Jordell eligible for Halfling Thimble Cup or add a new Gnome star", () => {
    expect(starEligibleBySpecialRule(jordell, "Halfling Thimble Cup")).toBe(false);

    const gnomeBase = new Set(
      bb2025.stars.filter((star) => star.teams.some((team) => normName(team) === "gnome")).map((star) => star.name),
    );
    const newlyEligible = bb2025.stars
      .filter((star) => star.playsFor?.some((rule) => normName(rule) === "halfling thimble cup"))
      .filter((star) => !gnomeBase.has(star.name));
    expect(newlyEligible).toEqual([]);
  });

  it("rejects a rule Jordell does not list, including no chosen value", () => {
    expect(starEligibleBySpecialRule(jordell, "Lustrian Superleague")).toBe(false);
    expect(starEligibleBySpecialRule(jordell, "")).toBe(false);
  });

  it("treats the (Any) sentinel as eligible for every chosen rule", () => {
    const akhorne = findStar(bb2025, "Akhorne the Squirrel");
    expect(akhorne).toBeDefined();
    expect(starEligibleBySpecialRule(akhorne!, "Woodland League")).toBe(true);
    expect(starEligibleBySpecialRule(akhorne!, "")).toBe(false);
  });
});

describe("eligibleStarsFor (stars derived from eligibility — owner 2026-08-10)", () => {
  const names = (rule?: string) => new Set(eligibleStarsFor(bb2025, "Gnome", rule).map((s) => s.name));

  it("a Woodland-League Gnome team derives Jordell; a Thimble-Cup Gnome team does not", () => {
    expect(names("Woodland League").has("Jordell Freshbreeze")).toBe(true);
    expect(names("Halfling Thimble Cup").has("Jordell Freshbreeze")).toBe(false);
  });

  it("every derived star is team-eligible, and narrowing by rule never widens the set", () => {
    const noRule = eligibleStarsFor(bb2025, "Gnome");
    expect(noRule.every((s) => s.teams.some((t) => normName(t) === "gnome") || s.teams.length === 0)).toBe(true);
    expect(names("Woodland League").size).toBeLessThanOrEqual(noRule.length);
  });

  it("an off-eligibility star is never derived (Woodland stars stay off a Thimble-Cup team)", () => {
    expect(names("Halfling Thimble Cup").has("Swiftvine Glimmershard")).toBe(false);
  });
});
