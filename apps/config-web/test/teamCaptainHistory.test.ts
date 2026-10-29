import { describe, expect, it } from "vitest";
import { composeTeam } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { storedTeamHasHistory } from "../src/teamDetail.js";

// BB2025 Team Captain (https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain): review regressions.

const position = (id: string, name: string, type: string, quantity: number) =>
  `<position id="${id}"><quantity>${quantity}</quantity><name>${name}</name><type>${type}</type><gender>male</gender></position>`;
const humanXml =
  '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  position("1", "Human Lineman", "Regular", 16) + position("2", "Human Blitzer", "Regular", 2) + "</roster>";

describe("Team Captain: a fresh captain team is still editable (storedTeamHasHistory)", () => {
  const team = (skills: string) =>
    `<team id="t"><player nr="1" id="p1"><positionId>1</positionId><playerStatistics currentSpps="0" earnedSpps="0"></playerStatistics><skillList>${skills}</skillList><injuryList/></player></team>`;

  it("exempts the captain's draft grants", () => {
    expect(storedTeamHasHistory(team("<skill>Team Captain</skill><skill>Pro</skill>"))).toBe(false);
    // The composer's real output reads as fresh too.
    const composed = composeTeam({ forkRosterXml: humanXml, coach: "C", teamName: "T", reRolls: 0, apothecary: false, picks: [{ positionId: "1", count: 1, captain: true }, { positionId: "1", count: 10 }] }, bb2025, 1);
    expect(storedTeamHasHistory(composed.xml)).toBe(false);
  });

  it("still counts real history: other acquired skills, a lone Pro, injuries", () => {
    expect(storedTeamHasHistory(team("<skill>Team Captain</skill><skill>Pro</skill><skill>Block</skill>"))).toBe(true);
    expect(storedTeamHasHistory(team("<skill>Pro</skill>"))).toBe(true);
    expect(storedTeamHasHistory(team("<skill>Team Captain</skill><skill>Pro</skill>").replace("<injuryList/>", "<injuryList><injury>Smashed Knee (-MA)</injury></injuryList>"))).toBe(true);
  });
});
