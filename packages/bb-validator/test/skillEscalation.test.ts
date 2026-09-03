import { describe, expect, it } from "vitest";
import { skillsGold, validate } from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const errorsOf = (result: ReturnType<typeof validate>, ruleId: string) =>
  result.errors.filter((finding) => finding.ruleId === ruleId);

describe("per-player skill stack surcharge", () => {
  it("charges base + base + 2 SP for two legal skills on one player", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Wrestle", "Tackle"] });
    const base = pkg().skillAllotment;
    const result = validate(
      roster({ players }),
      pkg({
        skillAllotment: {
          ...base,
          primaryCostSP: 6,
          eliteSurchargeSP: 0,
          stackSurchargeSP: 2,
          skillPointBudget: 13,
        },
      }),
      fakeData,
    );

    const finding = errorsOf(result, "skill-points")[0]!;
    expect(finding.message).toContain("14 Skill Points (12 in skills + 2 stacking surcharge)");
    expect(finding.actual).toBe("14 (12 in skills + 2 stacking surcharge)");
  });

  it("does not surcharge one legal skill on each of two players", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Wrestle"] });
    players[1] = player({ number: 2, skills: ["Tackle"] });
    const base = pkg().skillAllotment;
    const result = validate(
      roster({ players }),
      pkg({
        skillAllotment: {
          ...base,
          primaryCostSP: 6,
          eliteSurchargeSP: 0,
          stackSurchargeSP: 2,
          skillPointBudget: 12,
        },
      }),
      fakeData,
    );

    expect(errorsOf(result, "skill-points")).toHaveLength(0);
  });

  it("does not surcharge an illegal pick", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Wrestle", "Horns"] });
    const base = pkg().skillAllotment;
    const result = validate(
      roster({ players }),
      pkg({
        skillAllotment: {
          ...base,
          primaryCostSP: 6,
          eliteSurchargeSP: 0,
          stackSurchargeSP: 2,
          skillPointBudget: 6,
        },
      }),
      fakeData,
    );

    expect(errorsOf(result, "skill-points")).toHaveLength(0);
    expect(errorsOf(result, "skill-access")).toHaveLength(1);
  });

  it("mirrors the per-player surcharge in added-skill gold", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Wrestle", "Tackle"] });
    const tournament = pkg({
      skillAllotment: {
        ...pkg().skillAllotment,
        primaryCostGold: 20000,
        eliteSurchargeGold: 0,
        stackSurchargeGold: 10000,
      },
    });

    expect(skillsGold(roster({ players }), fakeData, tournament)).toBe(50000);
  });
});
