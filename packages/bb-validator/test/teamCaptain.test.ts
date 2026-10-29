import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addedSkills, composeTeam, composeTeamIntrinsic, findPosition, findRoster, rosterOptions, validate } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { pkg } from "./helpers";

// BB2025 Team Captain (https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain).
const snotlingXml = readFileSync(fileURLToPath(new URL("./fixtures/roster_snotling.xml", import.meta.url)), "utf8");

const position = (id: string, name: string, type: string, quantity: number) =>
  `<position id="${id}"><quantity>${quantity}</quantity><name>${name}</name><type>${type}</type><gender>male</gender></position>`;
/** Minimal fork Human roster: the dataset carries stats/costs, the XML the numeric ids. */
const humanXml =
  '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost>' +
  "<maxReRolls>8</maxReRolls><apothecary>true</apothecary><maxBigGuys>1</maxBigGuys>" +
  position("1", "Human Lineman", "Regular", 16) +
  position("2", "Human Blitzer", "Regular", 2) +
  position("3", "Ogre", "Big Guy", 1) +
  '<position id="9"><quantity>1</quantity><name>Morg \'n\' Thorg</name><type>Star</type><cost>340000</cost></position>' +
  "</roster>";

const base = {
  forkRosterXml: humanXml,
  coach: "Kalimar",
  teamName: "Captains",
  reRolls: 2,
  apothecary: false,
  dedicatedFans: 1,
};
const eleven = [
  { positionId: "1", count: 9 },
  { positionId: "2", count: 2 },
];

describe("Team Captain nomination (composer)", () => {
  it("offers the nomination through the roster's always-on Team Captain rule", () => {
    expect(rosterOptions(humanXml, bb2025).specialRules).toContain("Team Captain");
    expect(rosterOptions(snotlingXml, bb2025).specialRules).not.toContain("Team Captain");
  });

  it("accepts a captain on an eligible roster and writes Team Captain + Pro to that player's skillList", () => {
    const r = composeTeam({ ...base, picks: [{ positionId: "2", count: 1, captain: true }, { positionId: "2", count: 1 }, { positionId: "1", count: 9 }] }, bb2025, 42);
    const captainXml = r.xml.match(/<player nr="1"[\s\S]*?<\/player>/)?.[0] ?? "";
    expect(captainXml).toContain("<skillList><skill>Team Captain</skill><skill>Pro</skill></skillList>");
    // Only the captain carries them.
    expect(r.xml.match(/<skill>Team Captain<\/skill>/g)).toHaveLength(1);
    expect(r.xml.match(/<skill>Pro<\/skill>/g)).toHaveLength(1);
    expect(r.roster.players[0]!.skills).toEqual(["Block", "Tackle", "Team Captain", "Pro"]);
    expect(r.roster.players[1]!.skills).toEqual(["Block", "Tackle"]);
  });

  it("keeps the captain's chosen skills after the free grants", () => {
    const r = composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true, chosenSkills: ["Block"] }, { positionId: "1", count: 8 }, { positionId: "2", count: 2 }] }, bb2025, 42);
    expect(r.xml).toContain("<skillList><skill>Team Captain</skill><skill>Pro</skill><skill>Block</skill></skillList>");
  });

  it("validates clean: the captain is legal and is not flagged by any rule", () => {
    const r = composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true }, ...eleven.map((p, i) => (i === 0 ? { ...p, count: 8 } : p))] }, bb2025, 42);
    const result = validate(r.roster, pkg({ eligibleRosters: ["Human"], goldBudget: null }), bb2025);
    expect(result.errors.filter((f) => f.ruleId === "team-captain" || f.ruleId === "skill-access")).toEqual([]);
  });

  it("rejects a Big Guy captain", () => {
    expect(() => composeTeam({ ...base, picks: [...eleven, { positionId: "3", count: 1, captain: true }] }, bb2025, 42))
      .toThrow(/Ogre is a Big Guy and cannot be Team Captain/);
  });

  it("rejects a Star captain", () => {
    expect(() => composeTeam({ ...base, picks: [...eleven, { positionId: "9", count: 1, captain: true }] }, bb2025, 42))
      .toThrow(/cannot be Team Captain/);
  });

  it("rejects a captain on a roster without the Team Captain rule", () => {
    const snot = { ...base, forkRosterXml: snotlingXml, picks: [{ positionId: "66199", count: 1, captain: true }, { positionId: "66199", count: 10 }] };
    expect(() => composeTeam(snot, bb2025, 42)).toThrow(/Snotling teams cannot nominate a Team Captain/);
  });

  it("rejects two captains, in one pick or across picks", () => {
    expect(() => composeTeam({ ...base, picks: [{ positionId: "1", count: 2, captain: true }, { positionId: "1", count: 9 }] }, bb2025, 42))
      .toThrow(/Only one player can be nominated as Team Captain/);
    expect(() => composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true }, { positionId: "2", count: 1, captain: true }, { positionId: "1", count: 9 }] }, bb2025, 42))
      .toThrow(/Only one player can be nominated as Team Captain/);
  });

  it("rejects a captain who also lists Pro as a chosen skill", () => {
    expect(() => composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true, chosenSkills: ["Pro"] }, { positionId: "1", count: 10 }] }, bb2025, 42))
      .toThrow(/already gains Pro as Team Captain/);
  });

  it("charges nothing for the captain's Pro: no skill gold, no SP, no skill count, no per-player limit", () => {
    const captainOnly = composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true }, { positionId: "1", count: 8 }, { positionId: "2", count: 2 }] }, bb2025, 42);
    const none = composeTeam({ ...base, picks: eleven }, bb2025, 42);
    const p = pkg({ eligibleRosters: ["Human"], goldBudget: null });
    const a = validate(captainOnly.roster, p, bb2025);
    const b = validate(none.roster, p, bb2025);
    expect(a.recomputedSummary.skillsCost).toBe(0);
    expect(a.recomputedSummary.skillPointsUsed).toBe(0);
    expect(a.recomputedSummary.primarySkillCount).toBe(0);
    expect(a.recomputedSummary.secondarySkillCount).toBe(0);
    expect(a.recomputedSummary.goldUsed).toBe(b.recomputedSummary.goldUsed);
    expect(captainOnly.roster.summary?.total).toBe(none.roster.summary?.total);

    // A one-skill-per-player limit still lets the captain take one chosen skill (Pro is not counted).
    const withSkill = composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true, chosenSkills: ["Block"] }, { positionId: "1", count: 8 }, { positionId: "2", count: 2 }] }, bb2025, 42);
    const limited = pkg({ eligibleRosters: ["Human"], goldBudget: null, skillAllotment: { ...p.skillAllotment, maxPerPlayer: 1 } });
    const c = validate(withSkill.roster, limited, bb2025);
    expect(c.errors.filter((f) => f.ruleId === "skill-points")).toEqual([]);
    expect(c.recomputedSummary.primarySkillCount).toBe(1);
  });

  it("addedSkills treats the trait and ONE Pro as free grants", () => {
    const lineman = findPosition(findRoster(bb2025, "Human")!, "Human Lineman")!;
    expect(addedSkills(lineman, ["Team Captain", "Pro", "Block"])).toEqual(["Block"]);
    expect(addedSkills(lineman, ["Pro", "Block"])).toEqual(["Pro", "Block"]);
  });

  it("the team-captain rule flags a forged nomination (Big Guy, second captain, wrong roster)", () => {
    const r = composeTeam({ ...base, picks: [{ positionId: "1", count: 1, captain: true }, { positionId: "1", count: 8 }, { positionId: "2", count: 1 }, { positionId: "3", count: 1 }] }, bb2025, 42);
    const ogre = r.roster.players.find((pl) => pl.positionName === "Ogre")!;
    ogre.skills.push("Team Captain", "Pro");
    const result = validate(r.roster, pkg({ eligibleRosters: ["Human"], goldBudget: null }), bb2025);
    const messages = result.errors.filter((f) => f.ruleId === "team-captain").map((f) => f.message);
    expect(messages.some((m) => /only one may be/.test(m))).toBe(true);
    expect(messages.some((m) => /Ogre is a Big Guy/.test(m))).toBe(true);

    const snot = composeTeam({ ...base, forkRosterXml: snotlingXml, picks: [{ positionId: "66199", count: 11 }] }, bb2025, 42);
    snot.roster.players[0]!.skills.push("Team Captain", "Pro");
    const s = validate(snot.roster, pkg({ eligibleRosters: ["Snotling"], goldBudget: null }), bb2025);
    expect(s.errors.some((f) => f.ruleId === "team-captain" && /cannot nominate/.test(f.message))).toBe(true);
  });

  it("the Secret League path rejects a captain when the roster XML has no Team Captain rule", () => {
    const sl = readFileSync(fileURLToPath(new URL("./fixtures/roster_secretleague.xml", import.meta.url)), "utf8");
    const firstId = /<position\b[^>]*\bid="([^"]+)"/.exec(sl)![1]!;
    expect(() => composeTeamIntrinsic({ ...base, forkRosterXml: sl, picks: [{ positionId: firstId, count: 1, captain: true }] }, 42))
      .toThrow(/cannot nominate a Team Captain/);
  });
});
