/**
 * Golden end-to-end validation: the example Amazon roster passes the sample
 * Lustrian Superleague package (10 SP budget, exactly on budget) and fails a
 * stricter one with the right message + suggestion.
 */

import { describe, expect, it } from "vitest";
import { bb2025 } from "@bb/validator/dataset";
import { loadPackage, validate, type Roster, type TournamentPackage } from "@bb/validator";
import fixtureJson from "../../../fixtures/amazon-example.roster.json";
import lustrianJson from "../../../tournament-packages/lustrian-superleague.example.json";
import defaultJson from "../../../tournament-packages/bb2025-default.json";

const fixture = fixtureJson as unknown as Roster;

function lustrian(): TournamentPackage {
  const { pkg, problems } = loadPackage(lustrianJson as unknown as Partial<TournamentPackage>, {
    resolveExtends: (name) =>
      name === "bb2025-default" ? (defaultJson as unknown as Partial<TournamentPackage>) : undefined,
  });
  expect(problems).toEqual([]);
  return pkg;
}

describe("golden validation of the example Amazon roster", () => {
  it("PASSES the Lustrian Superleague sample package at exactly 10/10 SP", () => {
    const result = validate(fixture, lustrian(), bb2025);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.recomputedSummary.skillPointsUsed).toBe(10);
    expect(result.recomputedSummary.skillPointBudget).toBe(10);
    // matches the PDF's own summary: 6 primary, 0 secondary
    expect(result.recomputedSummary.primarySkillCount).toBe(6);
    expect(result.recomputedSummary.secondarySkillCount).toBe(0);
    // and the recomputed gold matches the sheet total (1200k) => no reconciliation warning
    expect(result.recomputedSummary.goldUsed).toBe(1_200_000);
    expect(result.warnings).toEqual([]);
  });

  it("FAILS a stricter package (8 SP budget) with the right message and suggestion", () => {
    const strict = lustrian();
    strict.skillAllotment.skillPointBudget = 8;
    const result = validate(fixture, strict, bb2025);
    expect(result.valid).toBe(false);
    const f = result.errors.find((e) => e.ruleId === "skill-points");
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/10 Skill Points.*budget is 8.*2 over/);
    expect(f!.suggestion).toMatch(/raise the budget to 10/);
  });

  it("FAILS when Amazon is not eligible", () => {
    const strict = lustrian();
    strict.eligibleRosters = ["Orc", "Dwarf"];
    const result = validate(fixture, strict, bb2025);
    expect(result.errors.some((e) => e.ruleId === "roster-eligibility")).toBe(true);
  });

  it("banning Block breaks the example team (3x Block added)", () => {
    const strict = lustrian();
    strict.special.bannedSkills = ["Block"];
    const result = validate(fixture, strict, bb2025);
    const banned = result.errors.filter((e) => e.ruleId === "special-rules");
    expect(banned).toHaveLength(3);
  });
});
