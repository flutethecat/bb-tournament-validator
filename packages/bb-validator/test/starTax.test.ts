import { describe, expect, it } from "vitest";
import {
  loadPackage,
  starTaxSP,
  validate,
  type TournamentPackage,
} from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const brackets: NonNullable<TournamentPackage["starPlayers"]["spTaxByCombinedCost"]> = [
  { upToGold: 199999, sp: 18 },
  { upToGold: 299999, sp: 24 },
  { upToGold: null, sp: 32 },
];

const errorsOf = (result: ReturnType<typeof validate>, ruleId: string) =>
  result.errors.filter((finding) => finding.ruleId === ruleId);

const rosterWithStar = (cost: number) => {
  const players = roster().players;
  players[10] = player({ number: 11, positionName: "Star Guy", cost });
  return roster({ players });
};

describe("Star Player SPP tax", () => {
  it("charges no tax with zero stars", () => {
    expect(starTaxSP(brackets, 0, 0)).toBe(0);
  });

  it("selects the first inclusive combined-cost bracket", () => {
    expect(starTaxSP(brackets, 150000, 1)).toBe(18);
    expect(starTaxSP(brackets, 199999, 1)).toBe(18);
    expect(starTaxSP(brackets, 200000, 1)).toBe(24);
    expect(starTaxSP(brackets, 300000, 1)).toBe(32);
  });

  it("includes the tax in the over-budget finding", () => {
    const team = rosterWithStar(150000);
    for (let i = 0; i < 4; i++) team.players[i]!.skills = ["Wrestle"];
    const tournament = pkg({
      skillAllotment: {
        ...pkg().skillAllotment,
        primaryCostSP: 11,
        eliteSurchargeSP: 0,
        skillPointBudget: 58,
      },
      starPlayers: { ...pkg().starPlayers, spTaxByCombinedCost: brackets },
    });

    const finding = errorsOf(validate(team, tournament, fakeData), "skill-points")[0]!;
    expect(finding.message).toBe(
      "Team spends 62 Skill Points (44 in skills + 18 Star Player tax at 150k of stars); the budget is 58 (4 over).",
    );
    expect(finding.actual).toBe("62 (44 in skills + 18 Star Player tax at 150k of stars)");
  });

  it("combines the tax and stacking-surcharge breakdowns", () => {
    const team = rosterWithStar(150000);
    team.players[0]!.skills = ["Wrestle", "Tackle"];
    for (let i = 1; i < 4; i++) team.players[i]!.skills = ["Wrestle"];
    const tournament = pkg({
      skillAllotment: {
        ...pkg().skillAllotment,
        skillCostSP: { Wrestle: 10, Tackle: 4 },
        stackSurchargeSP: 2,
        skillPointBudget: 58,
      },
      starPlayers: { ...pkg().starPlayers, spTaxByCombinedCost: brackets },
    });

    const finding = errorsOf(validate(team, tournament, fakeData), "skill-points")[0]!;
    expect(finding.message).toContain(
      "64 Skill Points (44 in skills + 2 stacking surcharge + 18 Star Player tax at 150k of stars)",
    );
    expect(finding.actual).toBe(
      "64 (44 in skills + 2 stacking surcharge + 18 Star Player tax at 150k of stars)",
    );
  });

  it("reports misordered brackets as a load problem", () => {
    const { problems } = loadPackage({
      name: "Misordered tax",
      skillAllotment: { skillPointBudget: 58 },
      starPlayers: {
        spTaxByCombinedCost: [
          { upToGold: 299999, sp: 24 },
          { upToGold: 199999, sp: 18 },
          { upToGold: null, sp: 32 },
        ],
      },
    });

    expect(problems).toContain("starPlayers.spTaxByCombinedCost upToGold brackets must be ascending");
  });

  it("reports spCostByTier conflicts and ignores the tax", () => {
    const { pkg: loaded, problems } = loadPackage({
      name: "Conflicting star SP models",
      skillAllotment: { skillPointBudget: 0 },
      starPlayers: {
        spCostByTier: { "Star Guy": [3] },
        spTaxByCombinedCost: brackets,
      },
    });

    expect(problems).toContain(
      "starPlayers.spTaxByCombinedCost and starPlayers.spCostByTier are mutually exclusive; ignoring spTaxByCombinedCost",
    );
    expect(loaded.starPlayers.spTaxByCombinedCost).toBeUndefined();
    expect(errorsOf(validate(rosterWithStar(150000), loaded, fakeData), "skill-points")).toHaveLength(0);
  });
});
