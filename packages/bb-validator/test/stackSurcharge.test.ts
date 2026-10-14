/**
 * Owner 09-09 (NAF World Cup V2.1 p.3): every added skill beyond a player's FIRST costs +stackSurchargeSP —
 * primary 6 then 8, secondary 10 then 12. Flat per extra skill; pick order does not matter.
 */
import { describe, expect, it } from "vitest";
import { loadPackage, validate, type DeepPartial, type Roster, type RosterPlayer, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import fixtureJson from "../../../fixtures/amazon-example.roster.json";

const amazon = () => structuredClone(fixtureJson) as unknown as Roster;
const load = (raw: DeepPartial<TournamentPackage>) => loadPackage(raw).pkg;
const wc = (budget: number) => load({
  name: "WC", eligibleRosters: ["Amazon"], goldBudget: 1_200_000,
  skillAllotment: { skillPointBudget: budget, primaryCostSP: 6, secondaryCostSP: 10, eliteSurchargeSP: 2, stackSurchargeSP: 2, maxPerPlayer: 2 },
});
// The example roster already carries added skills; strip every player to a blank slate so the totals below are
// exactly the skills this test adds (Eagle Warriors' base Dodge is re-added so it is not an "added" skill).
function withSkills(extra: Record<number, string[]>): Roster {
  const r = amazon();
  r.players = r.players.map((p: RosterPlayer) => {
    const base = bb2025.rosters[r.rosterName]?.positions.find((po) => po.name === p.positionName)?.skills ?? [];
    return { ...p, skills: [...base, ...(extra[p.number] ?? [])] };
  });
  return r;
}
const spError = (r: ReturnType<typeof validate>) => r.errors.find((e) => e.ruleId === "skill-points" && /Skill Points/.test(e.message));

describe("stackSurchargeSP (owner 09-09)", () => {
  it("defaults to 0 — a second skill on one player costs its plain price", () => {
    const pkg = load({ name: "flat", eligibleRosters: ["Amazon"], goldBudget: 1_200_000, skillAllotment: { skillPointBudget: 0, primaryCostSP: 6, eliteSurchargeSP: 0 } });
    expect(pkg.skillAllotment.stackSurchargeSP).toBe(0);
    const r = validate(withSkills({ 1: ["Wrestle", "Tackle"] }), pkg, bb2025);
    expect(spError(r)?.message).toMatch(/spends 12 Skill Points;/);
  });

  it("World Cup: 1st primary 6, 2nd primary 8 → 14; the over-budget message shows the breakdown", () => {
    const r = validate(withSkills({ 1: ["Wrestle", "Tackle"] }), wc(0), bb2025);
    expect(spError(r)?.message).toMatch(/spends 14 Skill Points \(12 in skills \+ 2 stacking surcharge\);/);
    expect(spError(r)?.actual).toBe("14 (12 in skills + 2 stacking surcharge)");
  });

  it("two single-skill players pay no surcharge (12), and a 2nd elite primary is 6 + 8 + 2", () => {
    expect(spError(validate(withSkills({ 1: ["Wrestle"], 2: ["Tackle"] }), wc(0), bb2025))?.message).toMatch(/spends 12 Skill Points;/);
    expect(spError(validate(withSkills({ 1: ["Wrestle", "Block"] }), wc(0), bb2025))?.message).toMatch(/spends 16 Skill Points \(14 in skills \+ 2 stacking surcharge\)/);
  });

  it("fits inside the budget when the surcharge is covered", () => {
    expect(spError(validate(withSkills({ 1: ["Wrestle", "Tackle"] }), wc(14), bb2025))).toBeUndefined();
  });
});
