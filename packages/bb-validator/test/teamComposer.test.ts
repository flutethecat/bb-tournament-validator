import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeTeam, parseForkRoster, teamCustomFromXml, mintTeamId, rosterOptions, validate } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { pkg } from "./helpers";

const snotlingXml = readFileSync(
  fileURLToPath(new URL("./fixtures/roster_snotling.xml", import.meta.url)),
  "utf8",
);

describe("parseForkRoster", () => {
  it("reads the fork rosterId, race, and reroll/apothecary header", () => {
    const r = parseForkRoster(snotlingXml);
    expect(r.rosterId).toBe("snotling.bb2025");
    expect(r.raceName).toBe("Snotling");
    expect(r.reRollCost).toBe(70000);
    expect(r.maxReRolls).toBe(8);
    expect(r.apothecaryAllowed).toBe(true);
  });

  it("keeps base positions with their NUMERIC positionId and includes Stars", () => {
    const r = parseForkRoster(snotlingXml);
    const lineman = r.positions.find((p) => p.name === "Snotling Lineman");
    expect(lineman?.positionId).toBe("66199"); // numeric FUMBBL id, not the dataset slug
    expect(lineman?.isStar).toBe(false);
    expect(lineman?.urlPortrait).toBe("i/643472");
    expect(lineman?.urlIconSet).toBe("i/643392.png");
    expect(r.positions.find((p) => p.positionId === "65801")).toMatchObject({
      name: "Morg 'n' Thorg",
      isStar: true,
    });
    expect(r.positions.find((p) => p.positionId === "65814")).toMatchObject({
      name: "Akhorne the Squirrel",
      isStar: true,
    });
    expect(r.positions.find((p) => p.name === "Grak")).toMatchObject({
      urlPortrait: "i/674104",
      urlIconSet: "i/674105.gif",
      isStar: true,
    });
  });
});

describe("rosterOptions", () => {
  it("enriches fork positions with dataset cost/cap/stats for the picker", () => {
    const o = rosterOptions(snotlingXml, bb2025);
    expect(o.rosterId).toBe("snotling.bb2025");
    expect(o.reRollCost).toBe(70000);
    const lineman = o.positions.find((p) => p.positionId === "66199");
    expect(lineman).toMatchObject({
      name: "Snotling Lineman",
      cost: 15000,
      max: 16,
      MA: 5,
      AG: "3+",
      urlPortrait: "i/643472",
      urlIconSet: "i/643392.png",
    });
    expect(o.positions.find((p) => p.positionId === "65801")).toMatchObject({
      name: "Morg 'n' Thorg",
      cost: 340000,
      max: 1,
      isStar: true,
      urlIconSet: "i/674075.png",
    });
  });
});

describe("mintTeamId", () => {
  it("is a string in the reserved tb_ namespace (never collides with numeric FUMBBL ids)", () => {
    const id = mintTeamId("Kalimar", "Snotling", 1_000_000);
    expect(id).toMatch(/^tb_kalimar_snotling_[0-9a-z]+$/);
    expect(Number.isNaN(Number(id))).toBe(true); // not a bare number → no collision with FUMBBL ids
  });
});

describe("composeTeam", () => {
  const input = {
    forkRosterXml: snotlingXml,
    coach: "Kalimar",
    teamName: "Kalimar's Snotling",
    reRolls: 3,
    apothecary: true,
    dedicatedFans: 1,
    // 6 linemen + 2 fun-hoppas + 2 trained trolls + 1 fungus flinga = 11
    picks: [
      { positionId: "66199", count: 6 }, // Snotling Lineman
      { positionId: "66201", count: 2 }, // Fun-hoppa
      { positionId: "66204", count: 2 }, // Trained Troll
      { positionId: "66200", count: 1 }, // Fungus Flinga
    ],
  };

  it("builds 11 players and mints a tb_ team id", () => {
    const r = composeTeam(input, bb2025, 42);
    expect(r.teamId).toBe("tb_kalimar_snotling_16");
    expect(r.roster.players).toHaveLength(11);
    expect(r.roster.rosterName).toBe("Snotling");
    expect(r.roster.coach).toBe("Kalimar");
    expect(r.roster.sideline.reRolls).toBe(3);
  });

  it("emits only positionIds that exist in the fork roster (round-trip integrity)", () => {
    const r = composeTeam(input, bb2025, 42);
    const forkIds = new Set(parseForkRoster(snotlingXml).positions.map((p) => p.positionId));
    const emitted = [...r.xml.matchAll(/<positionId>(\d+)<\/positionId>/g)].map((m) => m[1]!);
    expect(emitted).toHaveLength(11);
    expect(emitted.every((id) => forkIds.has(id))).toBe(true);
    // Team-level XML: fork rosterId + coach + player ids namespaced under the team id.
    expect(r.xml).toContain("<rosterId>snotling.bb2025</rosterId>");
    expect(r.xml).toContain("<coach>Kalimar</coach>");
    expect(r.xml).toContain(`id="${r.teamId}1"`);
  });

  it("keeps the existing non-star team XML byte-unchanged", () => {
    const r = composeTeam(input, bb2025, 42);
    expect(r.xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n\n<team id="tb_kalimar_snotling_16">\n\n` +
        `\t<coach>Kalimar</coach>\n` +
        `\t<name>Kalimar's Snotling</name>\n` +
        `\t<race>Snotling</race>\n` +
        `\t<rosterId>snotling.bb2025</rosterId>\n` +
        `\t<reRolls>3</reRolls>\n` +
        `\t<fanFactor>1</fanFactor>\n` +
        `\t<apothecaries>1</apothecaries>\n` +
        `\t<teamRating>65</teamRating>\n` +
        `\t<currentTeamValue>65</currentTeamValue>\n` +
        `\t<teamStrength>65</teamStrength>\n` +
        `\t<division>[X]</division>\n\n` +
        `\t<specialRules></specialRules>\n\n` +
        `\t<player nr="1" id="tb_kalimar_snotling_161"><name>Snotling Lineman 1</name><gender>random</gender><positionId>66199</positionId><skillList></skillList></player>\n` +
        `\t<player nr="2" id="tb_kalimar_snotling_162"><name>Snotling Lineman 2</name><gender>random</gender><positionId>66199</positionId><skillList></skillList></player>\n` +
        `\t<player nr="3" id="tb_kalimar_snotling_163"><name>Snotling Lineman 3</name><gender>random</gender><positionId>66199</positionId><skillList></skillList></player>\n` +
        `\t<player nr="4" id="tb_kalimar_snotling_164"><name>Snotling Lineman 4</name><gender>random</gender><positionId>66199</positionId><skillList></skillList></player>\n` +
        `\t<player nr="5" id="tb_kalimar_snotling_165"><name>Snotling Lineman 5</name><gender>random</gender><positionId>66199</positionId><skillList></skillList></player>\n` +
        `\t<player nr="6" id="tb_kalimar_snotling_166"><name>Snotling Lineman 6</name><gender>random</gender><positionId>66199</positionId><skillList></skillList></player>\n` +
        `\t<player nr="7" id="tb_kalimar_snotling_167"><name>Fun-hoppa 1</name><gender>random</gender><positionId>66201</positionId><skillList></skillList></player>\n` +
        `\t<player nr="8" id="tb_kalimar_snotling_168"><name>Fun-hoppa 2</name><gender>random</gender><positionId>66201</positionId><skillList></skillList></player>\n` +
        `\t<player nr="9" id="tb_kalimar_snotling_169"><name>Trained Troll 1</name><gender>random</gender><positionId>66204</positionId><skillList></skillList></player>\n` +
        `\t<player nr="10" id="tb_kalimar_snotling_1610"><name>Trained Troll 2</name><gender>random</gender><positionId>66204</positionId><skillList></skillList></player>\n` +
        `\t<player nr="11" id="tb_kalimar_snotling_1611"><name>Fungus Flinga 1</name><gender>random</gender><positionId>66200</positionId><skillList></skillList></player>\n\n` +
        `</team>\n`,
    );
  });

  it("applies custom chosenStats to the composed player and emitted player XML", () => {
    const r = composeTeam(
      {
        ...input,
        custom: true,
        picks: [
          {
            positionId: "66199",
            count: 1,
            chosenStats: { MA: 6, ST: 2, AG: 2, PA: 4, AV: 8 },
          },
        ],
      },
      bb2025,
      42,
    );

    expect(r.roster.players[0]).toMatchObject({
      MA: 6,
      ST: 2,
      AG: "2+",
      PA: "4+",
      AV: "8+",
      cost: 15000,
    });
    expect(r.xml).toContain(
      `<positionId>66199</positionId><movement>6</movement><strength>2</strength>` +
        `<agility>2</agility><passing>4</passing><armour>8</armour><skillList></skillList>`,
    );
  });

  it("marks a custom-built team and gated validation rejects it (SR-258)", () => {
    const custom = composeTeam({ ...input, custom: true }, bb2025, 42);
    expect(custom.roster.custom).toBe(true);
    expect(custom.xml).toContain("<custom>true</custom>");
    expect(validate(custom.roster, pkg(), bb2025).errors.some((e) => e.ruleId === "custom-team")).toBe(true);

    const plain = composeTeam(input, bb2025, 42);
    expect(plain.roster.custom).toBe(false);
    expect(plain.xml).not.toContain("<custom>");
    expect(validate(plain.roster, pkg(), bb2025).errors.some((e) => e.ruleId === "custom-team")).toBe(false);
  });

  it("SR-258 submit path: the custom flag survives serialization and drives the gate on parse-back", () => {
    // The real attack path: a custom team's EXPORTED xml, read back, must still reject in gated validation.
    const customXml = composeTeam({ ...input, custom: true }, bb2025, 42).xml;
    expect(teamCustomFromXml(customXml)).toBe(true);
    const reparsed = { ...composeTeam(input, bb2025, 42).roster, custom: teamCustomFromXml(customXml) };
    expect(validate(reparsed, pkg(), bb2025).errors.some((e) => e.ruleId === "custom-team")).toBe(true);
    // a genuinely non-custom export reads false → the gate does not fire
    expect(teamCustomFromXml(composeTeam(input, bb2025, 42).xml)).toBe(false);
  });

  it("ignores chosenStats outside custom mode and preserves the baseline output byte-for-byte", () => {
    const baseline = composeTeam(input, bb2025, 42);
    const ignored = composeTeam(
      {
        ...input,
        custom: false,
        picks: [
          {
            ...input.picks[0]!,
            chosenStats: { MA: 6, ST: 2, AG: 2, PA: 4, AV: 8 },
          },
          ...input.picks.slice(1),
        ],
      },
      bb2025,
      42,
    );

    expect(ignored.roster.players).toEqual(baseline.roster.players);
    expect(ignored.xml).toBe(baseline.xml);
    expect(ignored.xml).not.toMatch(/<(?:movement|strength|agility|passing|armour)>/);
  });

  it("builds a roster-intrinsic Star with its fixed name and empty XML skillList", () => {
    const withStar = {
      ...input,
      picks: [
        { positionId: "66199", count: 5 },
        { positionId: "65801", count: 1 },
        ...input.picks.slice(1),
      ],
    };
    const r = composeTeam(withStar, bb2025, 42);
    expect(r.roster.players).toHaveLength(11);
    expect(r.roster.players.some((p) => p.positionName === "Morg 'n' Thorg")).toBe(true);
    expect(r.xml).toContain(
      `<player nr="6" id="${r.teamId}6"><name>Morg 'n' Thorg</name><gender>male</gender>` +
        `<positionId>65801</positionId><skillList></skillList></player>`,
    );
  });

  it("rejects chosen skills on a Star", () => {
    const withStarSkill = {
      ...input,
      picks: [{ positionId: "65801", count: 1, chosenSkills: ["Block"] }],
    };
    expect(() => composeTeam(withStarSkill, bb2025, 42)).toThrow(/star player.*chosen skills/i);
  });

  it("enforces a Star's roster quantity cap", () => {
    const overStarCap = { ...input, picks: [{ positionId: "65801", count: 2 }] };
    expect(() => composeTeam(overStarCap, bb2025, 42)).toThrow(/star player.*max 1/i);
  });

  // Tournament builder (owner 08-04): per-player ROSTER-LEGAL chosen skills.
  // Snotling Lineman (66199) categories = normal[Agility,Devious] + double[General]:
  // "Block" (General) is legal (secondary access); "Guard" (Strength) is illegal (no Strength access).
  it("injects a roster-LEGAL chosen skill into each copy's player + team XML", () => {
    const withSkill = {
      ...input,
      picks: [{ positionId: "66199", count: 6, chosenSkills: ["Block"] }, ...input.picks.slice(1)],
    };
    const r = composeTeam(withSkill, bb2025, 42);
    expect(r.xml).toContain("<skill>Block</skill>");
    const linemen = r.roster.players.filter((p) => p.positionName === "Snotling Lineman");
    expect(linemen).toHaveLength(6);
    expect(linemen.every((p) => p.skills.includes("Block"))).toBe(true);
    expect(linemen[0]!.skills).toContain("Dodge"); // printed skills preserved
  });

  it("REJECTS an off-category chosen skill (roster-legal enforcement)", () => {
    const bad = {
      ...input,
      picks: [{ positionId: "66199", count: 6, chosenSkills: ["Guard"] }, ...input.picks.slice(1)],
    };
    expect(() => composeTeam(bad, bb2025, 42)).toThrow(/not a legal skill/i);
  });

  it("REJECTS a chosen skill the position already prints (no duplicates)", () => {
    const dup = {
      ...input,
      picks: [{ positionId: "66199", count: 6, chosenSkills: ["Dodge"] }, ...input.picks.slice(1)],
    };
    expect(() => composeTeam(dup, bb2025, 42)).toThrow(/already has/i);
  });

  it("produces a Roster the validator resolves (positions + race known to the dataset)", () => {
    const r = composeTeam(input, bb2025, 42);
    const result = validate(r.roster, pkg({ eligibleRosters: ["Snotling"], goldBudget: null }), bb2025);
    // No dataset-resolution failures: the composed race + every position are recognised.
    expect([...result.errors, ...result.warnings].some((f) => f.ruleId === "dataset")).toBe(false);
    expect(r.roster.players.every((p) => p.positionName.length > 0)).toBe(true);
  });

  it("rejects a pick whose positionId is not in the roster", () => {
    expect(() => composeTeam({ ...input, picks: [{ positionId: "99999", count: 1 }] }, bb2025, 42)).toThrow(
      /not in the Snotling roster/,
    );
  });

  it("counts sideline staff in the summary + the recomputed (preview) gold — owner P3", () => {
    // Snotling reRoll = 70k; input = 3 re-rolls (210k) + apothecary (50k), no coaches/cheerleaders,
    // 1 dedicated fan (0 extra) => 260k of sideline staff. Before the fix, roster.summary was absent
    // so recomputeGold() read sidelineCost as 0 and both the preview total and the over-budget guard
    // silently omitted staff.
    const r = composeTeam(input, bb2025, 42);
    const staffGold = 3 * 70000 + 50000;
    const playersGold = r.roster.players.reduce((s, p) => s + p.cost, 0);
    expect(r.roster.summary?.sidelineCost).toBe(staffGold);
    expect(r.roster.summary?.total).toBe(playersGold + staffGold);

    const result = validate(r.roster, pkg({ eligibleRosters: ["Snotling"], goldBudget: null }), bb2025);
    // The number the preview renders (recomputedSummary.goldUsed) now INCLUDES the staff cost.
    expect(result.recomputedSummary.goldUsed).toBe(playersGold + staffGold);
    // Populated summary is self-consistent => no spurious cost-reconciliation warning.
    expect([...result.warnings].some((f) => f.ruleId === "cost-reconciliation")).toBe(false);
  });

  it("admits/rejects at the budget WITH staff included (over-budget guard, owner P3)", () => {
    const r = composeTeam(input, bb2025, 42);
    const staffGold = 3 * 70000 + 50000;
    const playersGold = r.roster.players.reduce((s, p) => s + p.cost, 0);
    const total = playersGold + staffGold;
    // A budget that would PASS if staff were omitted but FAILS once staff is counted must reject —
    // this is the "validator must not admit an over-budget team the preview blessed" guarantee.
    const between = validate(r.roster, pkg({ eligibleRosters: ["Snotling"], goldBudget: playersGold + 1 }), bb2025);
    expect(between.errors.some((f) => f.ruleId === "gold-budget")).toBe(true);
    // A budget at/above the true total (players + staff) passes the gold check.
    const ample = validate(r.roster, pkg({ eligibleRosters: ["Snotling"], goldBudget: total }), bb2025);
    expect(ample.errors.some((f) => f.ruleId === "gold-budget")).toBe(false);
  });
});
