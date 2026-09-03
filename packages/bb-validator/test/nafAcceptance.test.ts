import { describe, expect, it } from "vitest";
import {
  findPosition,
  findRoster,
  findStar,
  loadPackage,
  validate,
  type Roster,
  type RosterPlayer,
  type TournamentPackage,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import nafJson from "../../../tournament-packages/naf-world-cup-2027.json";

const { pkg: naf, problems } = loadPackage(nafJson as unknown as Partial<TournamentPackage>);
const blackOrc = findRoster(bb2025, "Black Orc")!;
const goblinPosition = findPosition(blackOrc, "Goblin Bruiser")!;
const nobbla = findStar(bb2025, "Nobbla Blackwart")!;
const bribes = bb2025.inducements.bribes!;

const goblin = (number: number, addedSkills: string[] = []): RosterPlayer => ({
  number,
  positionName: goblinPosition.name,
  MA: goblinPosition.MA,
  ST: goblinPosition.ST,
  AG: goblinPosition.AG,
  PA: goblinPosition.PA,
  AV: goblinPosition.AV,
  skills: [...goblinPosition.skills, ...addedSkills],
  keywords: [...goblinPosition.keywords],
  cost: goblinPosition.cost,
});

const skilledGoblin = (index: number) =>
  goblin(index + 1, index === 0 ? ["Wrestle", "Tackle"] : index < 5 ? ["Catch"] : []);

const nafRoster = (withStar: boolean): Roster => {
  const goblinCount = withStar ? 10 : 11;
  const players = Array.from({ length: goblinCount }, (_, index) => skilledGoblin(index));
  if (withStar) {
    players.push({
      ...goblin(11),
      positionName: nobbla.name,
      skills: [...(nobbla.skills ?? [])],
      cost: nobbla.cost!,
    });
  }
  return {
    rosterName: blackOrc.name,
    coach: "Coach",
    teamName: "Acceptance Team",
    sideline: {
      apothecary: false,
      assistantCoaches: 0,
      cheerleaders: 0,
      dedicatedFans: 0,
      reRolls: 0,
    },
    inducements: [{
      id: "bribes",
      name: bribes.name,
      count: 3,
      cost: (bribes.reducedCost ?? bribes.cost)!,
    }],
    leagues: [...blackOrc.specialRules],
    specialRules: [...blackOrc.specialRules],
    players,
  };
};

describe("NAF World Cup 2027 acceptance", () => {
  it("applies stack surcharge, low-cost star tax, and the Secret Weapon Bribes cap", () => {
    expect(problems).toEqual([]);
    const result = validate(nafRoster(true), naf, bb2025);
    const spFinding = result.errors.find((finding) => finding.ruleId === "skill-points")!;
    const capFinding = result.errors.find((finding) => finding.ruleId === "inducements")!;

    expect(spFinding.message).toBe(
      "Team spends 64 Skill Points (44 in skills + 2 stacking surcharge + 18 Star Player tax at 120k of stars); the budget is 60 (team rule) (4 over).",
    );
    expect(spFinding.actual).toBe(
      "64 (44 in skills + 2 stacking surcharge + 18 Star Player tax at 120k of stars)",
    );
    expect(capFinding.message).toBe(
      "3× Bribes; the limit is 2 while a Secret Weapon star is rostered (Nobbla Blackwart). Secret Weapon star on roster.",
    );
  });

  it("removes the star tax and allows 3 Bribes when the star is removed", () => {
    const result = validate(nafRoster(false), naf, bb2025);

    expect(result.errors.filter((finding) => finding.ruleId === "skill-points")).toHaveLength(0);
    expect(result.errors.filter((finding) => finding.ruleId === "inducements")).toHaveLength(0);
    expect(result.errors).toEqual([]);
  });
});
