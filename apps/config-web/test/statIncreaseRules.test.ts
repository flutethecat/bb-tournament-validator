import { describe, expect, it } from "vitest";
import { composeTeam, findRoster, loadPackage, validate, type TeamPick, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { cleanStatIncreaseRules, playerStatRuleBlock, statRuleBlock, teamCapBlock } from "../../../packages/bb-validator/src/cost/statRules";
import { builderRaceRules } from "../src/teamBuilderPackage";
import { createTournamentCreator } from "../spa/src/tournaments/creator";
import { normalizePackage, serializePackage, freshView, type RawDoc } from "../spa/src/tournaments/creatorCore";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";

// Granular stat-increase rules (special.statIncreaseRules): who may not, blocked stats, per-team cap; the same sentences in the
// validator and the Advance dialog; the Tournament Creator edits them and round-trips the package.

function forkXml(race: string): string {
  const r = findRoster(bb2025, race)!;
  const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
  const positions = r.positions.map(
    (p, i) =>
      `<position id="${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
      `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility>` +
      `<passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList></skillList></position>`,
  );
  return `<roster id="dwarf.bb2025"><name>${r.name}</name><reRollCost>${r.reRollCost}</reRollCost><maxReRolls>8</maxReRolls><apothecary>${r.apothecaryAllowed}</apothecary>${positions.join("")}</roster>`;
}
const LINEMAN = "1", BLITZER = "3", DEATHROLLER = "5";

function pkgWith(rules: unknown, extra: Record<string, unknown> = {}): TournamentPackage {
  return loadPackage({
    name: "Rules Cup", eligibleRosters: ["*"],
    statIncreases: { allowed: ["MA", "ST", "AG", "PA", "AV"], costGold: { MA: 20000, ST: 80000, AG: 40000, PA: 20000, AV: 10000 }, maxPerPlayer: 2 },
    special: { statIncreasesAllowed: true, statIncreaseRules: rules },
    ...extra,
  } as never).pkg;
}
function messages(pkg: TournamentPackage, picks: TeamPick[]): string[] {
  const composed = composeTeam({ forkRosterXml: forkXml("Dwarf"), coach: "C", teamName: "T", picks, reRolls: 0, apothecary: false }, bb2025, 7);
  return validate(composed.roster, pkg, bb2025).errors.filter((f) => f.ruleId === "stat-increases").map((f) => f.message);
}
// 11 players: the lines only differ in what the player carries
const team = (lineman: string[] | undefined, deathroller?: string[]): TeamPick[] => [
  { positionId: LINEMAN, count: 1, ...(lineman ? { chosenStatIncreases: lineman as never } : {}) },
  { positionId: BLITZER, count: 9 },
  { positionId: DEATHROLLER, count: 1, ...(deathroller ? { chosenStatIncreases: deathroller as never } : {}) },
];

describe("stat-increase rules: the shared evaluator", () => {
  const dw = { race: "Dwarf", position: "Dwarf Blocker Lineman", keywords: ["Dwarf", "Lineman"], type: "blocker" };
  const ogre = { race: "Ogre", position: "Ogre", keywords: ["Big Guy"], type: "bigguy" };
  it("cleans raw JSON: bad entries dropped, empty rules are null", () => {
    expect(cleanStatIncreaseRules(null)).toBeNull();
    expect(cleanStatIncreaseRules({ blockedStats: [{ stat: "XX" }], excludeKeywords: [""], maxPerTeam: -1 })).toBeNull();
    expect(cleanStatIncreaseRules({ maxPerTeam: 2.9 })).toBeNull(); // not an integer: ignored (and a load problem, below)
    expect(cleanStatIncreaseRules({ excludePositions: [{ position: "Ogre" }], blockedStats: [{ stat: "st", keywords: ["Big Guy"] }], maxPerTeam: 2 })).toEqual({
      excludePositions: [{ race: "*", position: "Ogre" }], blockedStats: [{ stat: "ST", keywords: ["Big Guy"] }], maxPerTeam: 2,
    });
  });
  it("position, keyword, stat for everyone, stat for a keyword, per-team cap", () => {
    expect(playerStatRuleBlock({ excludePositions: [{ race: "Dwarf", position: "Dwarf Blocker Lineman" }] }, dw)).toBe("Tournament rule: no stat increases for Dwarf Blocker Lineman players.");
    expect(playerStatRuleBlock({ excludePositions: [{ race: "Elf", position: "Dwarf Blocker Lineman" }] }, dw)).toBe(""); // another race
    expect(playerStatRuleBlock({ excludeKeywords: ["big guy"] }, ogre)).toBe("Tournament rule: no stat increases for big guy players.");
    expect(statRuleBlock({ blockedStats: [{ stat: "ST" }] }, dw, "ST")).toBe("Tournament rule: no ST increases.");
    expect(statRuleBlock({ blockedStats: [{ stat: "ST" }] }, dw, "MA")).toBe("");
    expect(statRuleBlock({ blockedStats: [{ stat: "ST", keywords: ["Big Guy"] }] }, ogre, "ST")).toBe("Tournament rule: no ST increases for Big Guy players.");
    expect(statRuleBlock({ blockedStats: [{ stat: "ST", keywords: ["Big Guy"] }] }, dw, "ST")).toBe("");
    expect(statRuleBlock({ blockedStats: [{ stat: "AV", positions: [{ race: "*", position: "Ogre" }] }] }, ogre, "AV")).toBe("Tournament rule: no AV increases for Ogre players.");
    expect(statRuleBlock({ excludeKeywords: ["Lineman"] }, dw, "MA")).toBe("Tournament rule: no stat increases for Lineman players."); // every stat
    expect(teamCapBlock({ maxPerTeam: 2 }, 1)).toBe("");
    expect(teamCapBlock({ maxPerTeam: 2 }, 2)).toBe("Tournament rule: max 2 stat increases per team.");
    expect(teamCapBlock({ maxPerTeam: 1 }, 1)).toBe("Tournament rule: max 1 stat increase per team.");
  });
});

describe("stat-increase rules: the server validator", () => {
  it("passes when no rule is hit", () => {
    expect(messages(pkgWith({ blockedStats: [{ stat: "ST", keywords: ["Big Guy"] }] }), team(["MA"]))).toEqual([]);
  });
  it("no stat increases for a position", () => {
    const m = messages(pkgWith({ excludePositions: [{ race: "Dwarf", position: "Dwarf Blocker Lineman" }] }), team(["MA"]));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("#1 Dwarf Blocker Lineman has a characteristic increase (+MA).");
    expect(m[0]).toContain("Tournament rule: no stat increases for Dwarf Blocker Lineman players.");
  });
  it("no stat increases for a keyword (Big Guy)", () => {
    const m = messages(pkgWith({ excludeKeywords: ["Big Guy"] }), team(undefined, ["ST"]));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("Deathroller");
    expect(m[0]).toContain("no stat increases for Big Guy players.");
  });
  it("a stat blocked for everyone, and one blocked for a keyword", () => {
    expect(messages(pkgWith({ blockedStats: [{ stat: "ST" }] }), team(["ST"]))[0]).toContain("is not allowed. Tournament rule: no ST increases.");
    expect(messages(pkgWith({ blockedStats: [{ stat: "ST" }] }), team(["MA"]))).toEqual([]);
    const m = messages(pkgWith({ blockedStats: [{ stat: "ST", keywords: ["Big Guy"] }] }), team(["ST"], ["ST"]));
    expect(m).toHaveLength(1); // the Lineman may take ST, the Deathroller (Big Guy) may not
    expect(m[0]).toContain("Deathroller");
    expect(m[0]).toContain("no ST increases for Big Guy players.");
  });
  it("max per player (the existing knob) and max per team", () => {
    expect(messages(pkgWith({}), team(["MA", "ST", "AG"]))[0]).toContain("the limit is 2 per player."); // the knob caps 2 per player
    const m = messages(pkgWith({ maxPerTeam: 1 }), team(["MA"], ["MA"]));
    expect(m.join("|")).toContain("The team has 2 stat increases. Tournament rule: max 1 stat increase per team.");
    expect(messages(pkgWith({ maxPerTeam: 2 }), team(["MA"], ["MA"]))).toEqual([]);
  });
  it("rules are ignored while Allow stat increases is off, and the switch error wins", () => {
    const off = loadPackage({ name: "Off", eligibleRosters: ["*"], statIncreases: { allowed: ["MA"], costGold: { MA: 1 } }, special: { statIncreaseRules: { maxPerTeam: 5 } } } as never).pkg;
    expect(messages(off, team(["MA"]))[0]).toContain("this ruleset doesn't allow stat increases.");
  });
  it("race-scoped rules use the dataset's race name, like the roster lookup (Dwarfs = Dwarf)", () => {
    const m = messages(pkgWith({ excludePositions: [{ race: "Dwarfs", position: "Dwarf Blocker Lineman" }] }), team(["MA"]));
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("no stat increases for Dwarf Blocker Lineman players.");
    expect(messages(pkgWith({ excludePositions: [{ race: "Elf", position: "Dwarf Blocker Lineman" }] }), team(["MA"]))).toEqual([]);
    expect(builderRaceRules(pkgWith({ excludePositions: [{ race: "Dwarfs", position: "X" }] }), "dwarf")).toMatchObject({
      statRulesRace: "Dwarf", statIncreaseRules: { excludePositions: [{ race: "Dwarf", position: "X" }] },
    });
  });
  it("maxPerTeam must be a non-negative integer: a bad value is a load problem and is ignored", () => {
    for (const bad of [2.5, -1, "3"]) {
      const { problems, pkg } = loadPackage({ name: "Bad", eligibleRosters: ["*"], special: { statIncreasesAllowed: true, statIncreaseRules: { maxPerTeam: bad } } } as never);
      expect(problems).toContain("special.statIncreaseRules.maxPerTeam must be a non-negative integer or null (ignored).");
      expect(builderRaceRules(pkg, "Dwarf").statIncreaseRules).toBeNull();
    }
    expect(loadPackage({ name: "Ok", eligibleRosters: ["*"], special: { statIncreasesAllowed: true, statIncreaseRules: { maxPerTeam: 0 } } } as never).problems).toEqual([]);
  });
  it("Allow stat increases with no stat knobs uses the standard BB2025 increases (every stat, standard costs, one per player)", () => {
    const std = loadPackage({ name: "Std", eligibleRosters: ["*"], special: { statIncreasesAllowed: true } } as never).pkg;
    expect(builderRaceRules(std, "Dwarf").statIncreases).toEqual({ allowed: ["MA", "ST", "AG", "PA", "AV"], costGold: { AV: 10000, MA: 20000, PA: 20000, AG: 30000, ST: 60000 } });
    expect(messages(std, team(["ST"]))).toEqual([]);
    expect(messages(std, team(["ST", "MA"]))[0]).toContain("the limit is 1 per player.");
    const composed = composeTeam({ forkRosterXml: forkXml("Dwarf"), coach: "C", teamName: "T", picks: team(["ST"]), reRolls: 0, apothecary: false }, bb2025, 7);
    expect(validate(composed.roster, std, bb2025).recomputedSummary).toMatchObject({ statIncreasesCost: 60000 });
    // a knob anywhere still wins over the defaults
    const own = loadPackage({ name: "Own", eligibleRosters: ["*"], statIncreases: { allowed: ["MA"], costGold: { MA: 5 } }, special: { statIncreasesAllowed: true } } as never).pkg;
    expect(builderRaceRules(own, "Dwarf").statIncreases).toEqual({ allowed: ["MA"], costGold: { MA: 5 } });
  });
  it("the builder's race rules carry the cleaned rules (or null while the switch is off)", () => {
    const on = pkgWith({ excludeKeywords: ["Big Guy"], maxPerTeam: 3 });
    expect(builderRaceRules(on, "Dwarf").statIncreaseRules).toEqual({ excludeKeywords: ["Big Guy"], maxPerTeam: 3 });
    const off = loadPackage({ name: "Off", eligibleRosters: ["*"], special: { statIncreaseRules: { maxPerTeam: 3 } } } as never).pkg;
    expect(builderRaceRules(off, "Dwarf").statIncreaseRules).toBeNull();
  });
});

describe("stat-increase rules: the Tournament Creator", () => {
  const DOC: RawDoc = { name: "Nut Cup", ruleset: "bb2025-default", goldBudget: 1150000, eligibleRosters: ["*"], skillAllotment: { skillPointBudget: 6 }, starPlayers: { allowed: false } };
  function fetcher(): Fetcher {
    const routes: Record<string, unknown> = {
      "/api/packages": ["Nut Cup"], "/api/presets": [], "/api/skills": { elite: [], general: [] }, "/api/stars": [],
      "/api/teams": [{ name: "Dwarf", defaultTier: 1 }],
      "/api/positions": [{ race: "Dwarf", positions: [{ name: "Deathroller", type: "positional", keywords: ["Big Guy", "Dwarf"] }] }],
      "/api/packages/Nut%20Cup": { raw: structuredClone(DOC), revision: "r1", problems: [], schemaProblems: [] },
    };
    return (async (path: string) => { if (!(path in routes)) throw new ApiError(404, path); return routes[path]; }) as Fetcher;
  }
  it("edits every rule type and round-trips them; an emptied section leaves the package as authored", async () => {
    const c = createTournamentCreator({ api: fetcher() });
    await c.init();
    expect(c.state.positions[0]!.positions[0]!.name).toBe("Deathroller");
    await c.open("Nut Cup");
    c.toggleSpecial("statIncreasesAllowed");
    c.addExcludePosition("Dwarf", "Deathroller");
    c.addExcludePosition("Dwarf", "Deathroller"); // no duplicates
    c.toggleExcludeKeyword("Big Guy");
    c.addBlockedStat("ST");
    c.addBlockedStat("AV");
    c.setBlockedStat(1, "MA");
    c.toggleBlockedKeyword(0, "Lineman");
    c.addBlockedPosition(1, "Dwarf", "Deathroller");
    c.setMaxPerTeam("3");
    const out = c.serialize() as { special: { statIncreasesAllowed: boolean; statIncreaseRules: unknown } };
    expect(out.special.statIncreasesAllowed).toBe(true);
    expect(out.special.statIncreaseRules).toEqual({
      excludePositions: [{ race: "Dwarf", position: "Deathroller" }], excludeKeywords: ["Big Guy"],
      blockedStats: [{ stat: "ST", keywords: ["Lineman"] }, { stat: "MA", positions: [{ race: "Dwarf", position: "Deathroller" }] }], maxPerTeam: 3,
    });
    // reopen: normalise + serialise gives the same document back
    const pkg = normalizePackage(out as unknown as RawDoc);
    expect(serializePackage(pkg, { original: out as unknown as RawDoc, baseline: normalizePackage(out as unknown as RawDoc), view: freshView("tiers", "pool"), book: { touched: new Set(), injected: new Set() } })).toEqual(out);
    // undo everything: the key disappears
    c.removeExcludePosition(0); c.toggleExcludeKeyword("Big Guy"); c.removeBlockedStat(1); c.removeBlockedStat(0); c.setMaxPerTeam("");
    expect((c.serialize() as { special: Record<string, unknown> }).special.statIncreaseRules).toBeUndefined();
  });
});
