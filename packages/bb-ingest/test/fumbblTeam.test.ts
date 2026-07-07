import { describe, expect, it } from "vitest";
import { fumbblTeamToRoster, type FumbblTeam } from "@bb/ingest";
import { bb2025 } from "@bb/validator/dataset";
import { findPosition, findRoster } from "@bb/validator";

const team: FumbblTeam = {
  name: "Jungle Queens",
  coach: { name: "Xoco" },
  roster: { name: "Amazon" },
  rerolls: 3,
  apothecary: "Yes",
  assistantCoaches: 1,
  cheerleaders: 2,
  dedicatedFans: 1,
  specialRules: [{ name: "Lustrian Superleague" }],
  players: [
    { number: 1, position: "Eagle Warrior", skills: ["Dodge", "Block"] },
    { number: 2, position: "Piranha Warrior", skills: ["Dodge"] },
  ],
};

describe("fumbblTeamToRoster", () => {
  it("converts a FUMBBL team, filling stats/cost/keywords from the dataset", () => {
    const { roster, problems } = fumbblTeamToRoster(team, bb2025);
    expect(problems).toEqual([]);
    expect(roster).toBeDefined();
    expect(roster!.rosterName).toBe("Amazon");
    expect(roster!.coach).toBe("Xoco");
    expect(roster!.teamName).toBe("Jungle Queens");
    expect(roster!.specialRules).toEqual(["Lustrian Superleague"]);
    expect(roster!.sideline).toEqual({
      apothecary: true,
      assistantCoaches: 1,
      cheerleaders: 2,
      dedicatedFans: 1,
      reRolls: 3,
    });

    const amazon = findRoster(bb2025, "Amazon")!;
    const eagle = findPosition(amazon, "Eagle Warrior")!;
    const p0 = roster!.players[0]!;
    expect(p0.skills).toEqual(["Dodge", "Block"]); // passed through from FUMBBL
    expect({ MA: p0.MA, ST: p0.ST, AV: p0.AV, cost: p0.cost }).toEqual({
      MA: eagle.MA,
      ST: eagle.ST,
      AV: eagle.AV,
      cost: eagle.cost,
    });
    expect(p0.keywords).toEqual(eagle.keywords); // race + role from the dataset
  });

  it("falls back to fanFactor when dedicatedFans is absent", () => {
    const { roster } = fumbblTeamToRoster({ ...team, dedicatedFans: null, fanFactor: 4 }, bb2025);
    expect(roster!.sideline.dedicatedFans).toBe(4);
  });

  it("flags an unknown position but still includes the player (zero cost)", () => {
    const { roster, problems } = fumbblTeamToRoster(
      { ...team, players: [{ number: 1, position: "Space Marine", skills: [] }] },
      bb2025,
    );
    expect(problems.some((p) => /Space Marine/.test(p))).toBe(true);
    expect(roster!.players[0]!.cost).toBe(0);
  });

  it("refuses a team with no roster/race", () => {
    const { roster, problems } = fumbblTeamToRoster({ players: [{ position: "Eagle Warrior" }] }, bb2025);
    expect(roster).toBeUndefined();
    expect(problems[0]).toMatch(/no roster\/race/);
  });
});
