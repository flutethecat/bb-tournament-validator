import { describe, expect, it } from "vitest";
import { composeTeam, rosterOptions, validate } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { pkg } from "./helpers";

interface BigGuyRosterCase {
  requestedName: string;
  datasetName: string;
  rosterId: string;
  maxBigGuys: number;
  lineman: { name: string; positionId: string };
  bigGuys: Array<{ name: string; positionId: string }>;
}

const rosterCases: BigGuyRosterCase[] = [
  {
    requestedName: "Chaos Chosen",
    datasetName: "Chaos Chosen",
    rosterId: "chaoschosen.bb2025",
    maxBigGuys: 1,
    lineman: { name: "Beastman Runner Lineman", positionId: "66322" },
    bigGuys: [
      { name: "Chaos Troll", positionId: "66324" },
      { name: "Ogre", positionId: "66325" },
      { name: "Minotaur", positionId: "66326" },
    ],
  },
  {
    requestedName: "Old World Alliance",
    datasetName: "Old World Alliance",
    rosterId: "oldworldalliance.bb2025",
    maxBigGuys: 1,
    lineman: { name: "Human Lineman", positionId: "66221" },
    bigGuys: [
      { name: "Ogre", positionId: "66230" },
      { name: "Altern Forest Treeman", positionId: "66231" },
    ],
  },
  {
    requestedName: "Chaos Renegades",
    datasetName: "Chaos Renegade",
    rosterId: "chaosrenegade.bb2025",
    maxBigGuys: 3,
    lineman: { name: "Renegade Human", positionId: "66305" },
    bigGuys: [
      { name: "Troll", positionId: "66311" },
      { name: "Ogre", positionId: "66312" },
      { name: "Minotaur", positionId: "66313" },
      { name: "Rat Ogre", positionId: "66314" },
    ],
  },
  {
    requestedName: "Underworld Denizens",
    datasetName: "Underworld Denizens",
    rosterId: "underworlddenizens.bb2025",
    maxBigGuys: 1,
    lineman: { name: "Goblin Lineman", positionId: "66187" },
    bigGuys: [
      { name: "Troll", positionId: "66193" },
      { name: "Rat Ogre", positionId: "66194" },
    ],
  },
];

function forkRosterXml(testCase: BigGuyRosterCase): string {
  const positions = [testCase.lineman, ...testCase.bigGuys]
    .map(({ name, positionId }) =>
      `<position id="${positionId}"><quantity>16</quantity><name>${name}</name>` +
      `<type>Regular</type><gender>random</gender></position>`,
    )
    .join("");
  return `<roster id="${testCase.rosterId}"><name>${testCase.datasetName}</name>` +
    `<reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>` +
    `<maxBigGuys>${testCase.maxBigGuys}</maxBigGuys>${positions}</roster>`;
}

function composeAndValidate(testCase: BigGuyRosterCase, bigGuyCount: number) {
  const bigGuyPicks = testCase.bigGuys.slice(0, bigGuyCount).map(({ positionId }) => ({ positionId, count: 1 }));
  const composed = composeTeam({
    forkRosterXml: forkRosterXml(testCase),
    coach: "CapTester",
    teamName: `${testCase.requestedName} Cap Test`,
    picks: [
      { positionId: testCase.lineman.positionId, count: 11 - bigGuyPicks.length },
      ...bigGuyPicks,
    ],
    reRolls: 0,
    apothecary: false,
  }, bb2025, 42);
  return {
    composed,
    validation: validate(
      composed.roster,
      pkg({ eligibleRosters: [testCase.datasetName], goldBudget: null }),
      bb2025,
    ),
  };
}

describe("BB2025 requested Big Guy groups", () => {
  it.each(rosterCases)("$requestedName dataset record carries the exact names and cap", (testCase) => {
    const roster = bb2025.rosters[testCase.datasetName];
    expect(roster?.maxBigGuys).toBe(testCase.maxBigGuys);
    expect(roster?.positions.filter((position) => position.type === "bigguy").map((position) => position.name))
      .toEqual(testCase.bigGuys.map((position) => position.name));
  });

  it.each(rosterCases)("$requestedName maps the exact active fork ids into one rosterOptions group", (testCase) => {
    const options = rosterOptions(forkRosterXml(testCase), bb2025);
    expect(options.rosterId).toBe(testCase.rosterId);
    expect(options.positions.filter((position) => position.type === "bigguy").map((position) => position.positionId))
      .toEqual(testCase.bigGuys.map((position) => position.positionId));
    expect(options.positionGroups).toEqual([{
      positions: testCase.bigGuys.map((position) => position.positionId),
      max: testCase.maxBigGuys,
      label: "Big Guy",
    }]);
  });

  it.each(rosterCases)("$requestedName is legal at cap and authoritatively rejected over cap", (testCase) => {
    const atCap = composeAndValidate(testCase, testCase.maxBigGuys);
    const overCap = composeAndValidate(testCase, testCase.maxBigGuys + 1);
    const atCapFindings = atCap.validation.errors.filter((finding) => finding.ruleId === "positional-limits");
    const overCapFindings = overCap.validation.errors.filter((finding) => finding.ruleId === "positional-limits");

    expect(atCap.composed.roster.players).toHaveLength(11);
    expect(atCap.validation.valid).toBe(true);
    expect(atCapFindings).toHaveLength(0);
    expect(overCap.composed.roster.players).toHaveLength(11);
    expect(overCap.validation.valid).toBe(false);
    expect(overCapFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        expected: `<= ${testCase.maxBigGuys}`,
        actual: testCase.maxBigGuys + 1,
      }),
    ]));
  });
});
