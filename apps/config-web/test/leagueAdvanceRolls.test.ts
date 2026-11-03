import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RulesChangeCoalescer } from "../src/competition/rulesChange";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { CHARACTERISTIC_TABLE, rollRandomSkill, skillTable, tableEntry } from "../src/advancementRolls";
import { MemoryDiceLog } from "../src/dice/log";
import { sequenceRoller, type Roller } from "../src/dice/roller";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api";
import { LeagueStore } from "../src/leagues/store";
import { ADVANCEMENT_ROWS } from "../src/teamAdvancement";
import type { TeamPageView } from "../src/leagues/teamPage";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";

// Advancement by roll on the league team page (spec-forfeit-and-dice-2026-11-02, Q7; src/leagues/teamAdvance.ts): Random
// Primary skill on the category table (two results, rerolls on owned skills, a double is forced) and Advance Characteristic
// (a D8 on the BB2025 table), rolled on the server, logged before the result is stored or shown, kept pending until picked,
// charged once, and only for the team's coach or the league's organisers.

const lineman = (over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: "p1", careerKey: "c-p1", number: 1, name: "Brokk", position: "Dwarf Blocker Lineman", ma: 4, st: 3, ag: 4, pa: 5, av: 10,
  skills: ["Block", "Defensive", "Thick Skull"], value: 70_000, level: "Rookie", availableSpp: 20, niggling: 0, missNextGame: false,
  stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0, ...over,
});
const dwarves = (players: LeaguePlayer[] = [lineman()]): LeagueTeam => ({
  id: "rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Dee", coachId: "Dee", teamValue: 0, treasury: 50_000, rerolls: 1, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "", players, formerPlayers: [],
});
const orcs = (): LeagueTeam => ({ ...dwarves([]), id: "orcs", name: "Orcs", race: "Orc", coach: "Bob", coachId: "Bob" });
const played = (): LeagueFixture => ({
  id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Grudge Rollers", teamId: "rollers", coach: "Dee", race: "Dwarf", score: 1, cas: 0, conceded: false },
  away: { team: "Orcs", teamId: "orcs", coach: "Bob", race: "Orc", score: 0, cas: 0, conceded: false }, suspended: false,
});
const season = (teams: LeagueTeam[]): SeasonRecord => ({
  id: "season-1", leagueId: "lg", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [played()], teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-11-01T00:00:00.000Z", source: "manual",
});

describe("the BB2025 advancement tables (src/advancementRolls.ts)", () => {
  it("every category table is the dataset's 12 selectable skills in alphabetical order; 2D6 pick the half then the entry", () => {
    for (const c of ["General", "Agility", "Strength", "Passing", "Mutation", "Devious"]) expect(skillTable(c)).toHaveLength(12);
    const general = skillTable("General");
    expect(general.slice(0, 2)).toEqual(["Block", "Dauntless"]);
    expect(tableEntry(general, 1, 1)).toBe("Block");
    expect(tableEntry(general, 3, 6)).toBe(general[5]);
    expect(tableEntry(general, 4, 1)).toBe(general[6]);
    expect(tableEntry(general, 6, 6)).toBe("Wrestle");
    expect(tableEntry(general, 0, 1)).toBeUndefined();
  });

  it("owned or illegal results are rolled again; a double is forced", () => {
    const r = rollRandomSkill(sequenceRoller([1, 1, 1, 2, 4, 6]), "General", (s) => s !== "Block");
    expect(r.rolls).toEqual([{ dice: [1, 1], skill: "Block", rerolled: true }, { dice: [1, 2], skill: "Dauntless" }, { dice: [4, 6], skill: "Wrestle" }]);
    expect(r.picks).toEqual(["Dauntless", "Wrestle"]);
    expect(r.forced).toBe(false);
    expect(rollRandomSkill(sequenceRoller([1, 2, 1, 2]), "General", () => true)).toMatchObject({ picks: ["Dauntless", "Dauntless"], forced: true });
    expect(() => rollRandomSkill(sequenceRoller([1]), "General", () => false)).toThrow();
  });

  it("the characteristic table is the BB2025 D8 table", () => {
    expect(CHARACTERISTIC_TABLE).toEqual({ 1: ["AV"], 2: ["AV", "PA"], 3: ["AV", "MA", "PA"], 4: ["AV", "MA", "PA"], 5: ["MA", "PA"], 6: ["AG", "MA"], 7: ["AG", "ST"], 8: ["MA", "ST", "AG", "PA", "AV"] });
  });
});

describe("league team page: advancement by roll", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let log: MemoryDiceLog;
  let roller: Roller;
  let notes: Array<{ to: string; title: string }>;
  const deps = (): LeagueApiDeps => ({
    store, now: () => new Date("2026-11-03T12:00:00Z"), notify: (to, n) => { notes.push({ to, title: n.title }); },
    teamNotices: new RulesChangeCoalescer(60_000, () => undefined, () => 0), readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    roller, diceLog: log,
  });
  const ORG: LeagueApiIdentity = { coach: "Jay", admin: false };
  const COACH: LeagueApiIdentity = { coach: "dee", admin: false };
  const OTHER_COACH: LeagueApiIdentity = { coach: "Bob", admin: false };
  const OTHER_LEAGUE_ORG: LeagueApiIdentity = { coach: "Zed", admin: false };
  const base = "/api/leagues/lg/seasons/season-1/teams/rollers";
  const rev = () => store.season("lg", "season-1")!.revision ?? 0;
  const p1 = () => store.season("lg", "season-1")!.teams[0]!.players[0]!;
  const call = async (method: string, p: string, auth: LeagueApiIdentity | undefined, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, p, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };
  const edit = (auth: LeagueApiIdentity, mode: "coach" | "organiser", ops: unknown[]) => call("POST", `${base}/edit`, auth, { revision: rev(), mode, ops });
  const view = async (auth: LeagueApiIdentity = COACH): Promise<TeamPageView> => ((await call("GET", `${base}/manage`, auth)).body as { view: TeamPageView }).view;
  const rollRandom = (auth = COACH, mode: "coach" | "organiser" = "coach") => edit(auth, mode, [{ op: "rollAdvance", playerId: "p1", kind: "randomPrimary", category: "General" }]);
  const rollStat = (auth = COACH, mode: "coach" | "organiser" = "coach") => edit(auth, mode, [{ op: "rollAdvance", playerId: "p1", kind: "characteristic" }]);
  const resolve = (choice: unknown, auth = COACH, mode: "coach" | "organiser" = "coach") => edit(auth, mode, [{ op: "resolveAdvance", playerId: "p1", rollId: p1().pendingAdvance?.id, choice }]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-advance-rolls-"));
    store = new LeagueStore(dir);
    log = new MemoryDiceLog();
    notes = [];
    roller = sequenceRoller([1, 1, 1, 2, 4, 6]);
    store.upsertLeague({ id: "lg", name: "Harbour League", fullName: "Harbour League", slug: "lg", organisers: ["Jay"] });
    store.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["Zed"] });
    store.putSeason(season([dwarves(), orcs()]));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("the view prices Random Primary and Characteristic from the BB2025 table and lists the categories with a legal skill", async () => {
    const adv = (await view()).advancement.p1!;
    expect(adv.costs).toEqual({ ...ADVANCEMENT_ROWS[0]!.costs });
    expect(adv.randomCategories).toEqual(["General", "Devious"]);
  });

  it("Random Primary: rolls the category table with rerolls, logs before the result is stored, charges the random price once, then the pick", async () => {
    const r = await rollRandom();
    expect(r.status).toBe(200);
    const pend = p1().pendingAdvance!;
    expect(pend).toMatchObject({ kind: "randomPrimary", category: "General", choices: ["Dauntless", "Wrestle"], cost: 3, count: 0, by: "dee" });
    expect(pend.rolls).toHaveLength(3); // Block (owned) was rolled again
    expect(p1().availableSpp).toBe(17);
    // the dice log has the roll, with the same id, the dice and the result
    const logId = (await view()).diceLog[0]!.logId;
    const [entry] = log.read(logId);
    expect(entry).toMatchObject({ id: pend.id, kind: "advance-skill", by: "dee", dice: [1, 1, 1, 2, 4, 6], result: { picks: ["Dauntless", "Wrestle"], category: "General", cost: 3 } });
    expect(entry!.admin).toBeUndefined();
    // the pick: no second charge; value, rank and history
    expect((await resolve({ type: "skill", skill: "Hatred" })).status).toBe(400);
    expect((await resolve({ type: "skill", skill: "Wrestle" })).status).toBe(200);
    expect(p1()).toMatchObject({ availableSpp: 17, level: "Experienced", value: 90_000 });
    expect(p1().skills).toContain("Wrestle");
    expect(p1().pendingAdvance).toBeUndefined();
    const hist = (await view()).history;
    expect(hist[0]).toMatchObject({ kind: "advancement", by: "dee", changes: [{ what: expect.stringMatching(/took Wrestle \(random Primary, General\)/) }] });
    expect(hist[1]!.changes[0]!.what).toMatch(/rolled a Random Primary skill \(General, 3 SPP\)/);
    expect(hist[1]!.changes[0]!.to).toMatch(/1\+1 Block \(rolled again\), 1\+2 Dauntless, 4\+6 Wrestle/);
    expect(notes).toEqual([]); // a coach's own roll sends no note
  });

  it("a double is taken at once (the rules leave no choice)", async () => {
    roller = sequenceRoller([1, 2, 1, 2]);
    expect((await rollRandom()).status).toBe(200);
    expect(p1().pendingAdvance).toBeUndefined();
    expect(p1().skills).toContain("Dauntless");
    expect(p1()).toMatchObject({ availableSpp: 17, level: "Experienced" });
    expect((await view()).history[0]!.changes[1]!.what).toMatch(/took Dauntless \(both rolls gave it\)/);
  });

  it("a dice log write failure refuses the roll: nothing is charged, stored or shown", async () => {
    log.failNext = true;
    const before = rev();
    const r = await rollRandom();
    expect(r.status).toBe(500);
    expect(rev()).toBe(before);
    expect(p1()).toMatchObject({ availableSpp: 20 });
    expect(p1().pendingAdvance).toBeUndefined();
  });

  it("Advance Characteristic: the D8 maps to the table's characteristics this player can improve, plus Choose Skill", async () => {
    roller = sequenceRoller([7]);
    expect((await rollStat()).status).toBe(200);
    expect(p1().pendingAdvance).toMatchObject({ kind: "characteristic", roll: 7, choices: ["AG", "ST"], cost: 14 });
    expect(p1().pendingAdvance!.skills!.primary).toContain("Dauntless");
    expect(p1().pendingAdvance!.skills!.secondary).toContain("Guard");
    expect(p1().availableSpp).toBe(6);
    expect(log.read((await view()).diceLog[0]!.logId)[0]).toMatchObject({ kind: "advance-stat", dice: [7], result: { roll: 7, choices: ["AG", "ST"], allowed: ["AG", "ST"] } });
    expect((await resolve({ type: "stat", stat: "MA" })).status).toBe(400); // not on this result
    expect((await resolve({ type: "stat", stat: "ST" })).status).toBe(200);
    expect(p1()).toMatchObject({ st: 4, availableSpp: 6, value: 130_000, level: "Experienced" });
    expect(p1().skills).toContain("+ST");
    expect((await view()).advancement.p1!.count).toBe(1); // counted once (the +ST entry and the step agree)
  });

  it("the table filters out what can't improve: at its best, or already improved twice; Choose Skill may take a Secondary", async () => {
    const s = store.season("lg", "season-1")!;
    Object.assign(s.teams[0]!.players[0]!, { av: 11 });
    store.putSeason(s);
    roller = sequenceRoller([1]);
    expect((await rollStat()).status).toBe(200);
    expect(p1().pendingAdvance).toMatchObject({ roll: 1, choices: [] });
    expect((await resolve({ type: "skill", skill: "Guard", access: "secondary" })).status).toBe(200);
    // AV 11 sits one above the printed 10: that is advancement 1, so the roll cost the Veteran price (16); Guard is a
    // Secondary (+40k) and Elite (+10k)
    expect(p1()).toMatchObject({ value: 120_000, availableSpp: 4, level: "Veteran" });
    // twice improved ST: a 7 offers only AG
    const s2 = store.season("lg", "season-1")!;
    Object.assign(s2.teams[0]!.players[0]!, { st: 5, skills: [...s2.teams[0]!.players[0]!.skills, "+ST", "+ST"], availableSpp: 50 });
    store.putSeason(s2);
    roller = sequenceRoller([7]);
    expect((await rollStat()).status).toBe(200);
    expect(p1().pendingAdvance!.choices).toEqual(["AG"]);
  });

  it("the pending choice persists: reopening shows the same roll, a second roll is refused, other advancements wait", async () => {
    roller = sequenceRoller([5]);
    expect((await rollStat()).status).toBe(200);
    const first = (await view()).team.players[0]!.pendingAdvance!;
    roller = sequenceRoller([8]);
    expect((await rollStat()).status).toBe(409);
    expect((await rollRandom()).status).toBe(409);
    expect((await edit(COACH, "coach", [{ op: "advance", playerId: "p1", skill: "Dauntless", method: "chosenPrimary" }])).status).toBe(409);
    const again = (await view()).team.players[0]!.pendingAdvance!;
    expect(again).toEqual(first);
    expect(p1().availableSpp).toBe(6); // charged once
    expect(log.read((await view()).diceLog[0]!.logId)).toHaveLength(1);
    // a stale roll id is refused
    expect((await edit(COACH, "coach", [{ op: "resolveAdvance", playerId: "p1", rollId: "rNOPE", choice: { type: "stat", stat: "MA" } }])).status).toBe(409);
    // the public season read never carries the pending roll
    const pub = ((await call("GET", "/api/leagues/lg/seasons/season-1", undefined)).body as { season: SeasonRecord }).season;
    expect(pub.teams[0]!.players[0]!.pendingAdvance).toBeUndefined();
  });

  it("SPP is checked before the dice: too little SPP rolls nothing and logs nothing", async () => {
    const s = store.season("lg", "season-1")!;
    s.teams[0]!.players[0]!.availableSpp = 2;
    store.putSeason(s);
    const r = await rollRandom();
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/costs 3 SPP/);
    expect((await rollStat()).status).toBe(400);
    expect((await view()).diceLog).toEqual([]);
  });

  it("access: the coach and the league's organisers (on the coach's behalf, logged so); everyone else 403", async () => {
    for (const a of [OTHER_COACH, OTHER_LEAGUE_ORG]) {
      expect((await rollRandom(a, "coach")).status).toBe(403);
      expect((await rollRandom(a, "organiser")).status).toBe(403);
    }
    expect((await rollRandom(ORG, "coach")).status).toBe(403); // an organiser who does not coach the team uses edit mode
    expect((await call("POST", `${base}/edit`, undefined, { revision: rev(), mode: "coach", ops: [] })).status).toBe(401);
    expect((await view()).diceLog).toEqual([]);
    expect((await rollRandom(ORG, "organiser")).status).toBe(200);
    const entry = (await view(ORG)).diceLog[0]!;
    expect(entry).toMatchObject({ by: "Jay", admin: true, kind: "advance-skill" });
    const h = (await view(ORG)).history[0]!;
    expect(h).toMatchObject({ kind: "advancement", by: "Jay" });
    expect(h.changes[0]!.what).toMatch(/an organiser rolled on the coach's behalf/);
    expect(notes.map((n) => n.to)).toContain("Dee"); // the coach hears about it
    // the coach can pick from the organiser's roll
    expect((await resolve({ type: "skill", skill: "Dauntless" })).status).toBe(200);
  });

  it("a roll goes alone in its request; CSRF covers the POST; GET never rolls; before the first game a coach can't roll", async () => {
    expect(isStateChangingApiRequest("POST", `${base}/edit`)).toBe(true);
    const r = await edit(COACH, "coach", [{ op: "rollAdvance", playerId: "p1", kind: "characteristic" }, { op: "player", playerId: "p1", field: "name", value: "X" }]);
    expect(r.status).toBe(400);
    const before = rev();
    await view(); await view(ORG);
    expect(rev()).toBe(before);
    const s = store.season("lg", "season-1")!;
    s.fixtures = [];
    s.teams[0]!.players[0]!.stats = { ...EMPTY_PLAYER_STATS };
    s.teams[0]!.players[0]!.availableSpp = 0;
    store.putSeason(s);
    expect((await rollStat()).status).toBe(403);
  });
});
