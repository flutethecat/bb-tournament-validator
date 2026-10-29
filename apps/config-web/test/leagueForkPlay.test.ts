import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, resetForkToggleLimit, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import { syncLeagueForkResults, type ForkScheduleOutcome, type LeagueForkClient } from "../src/leagues/forkPlay";
import { applyForkResult, fromParsedResult, mutateLeagueTeam, type ForkGameResult } from "../src/leagues/forkResult";
import { buildLeagueForkTeam, forkPlayerIdFor, forkTeamIdFor, ForkTeamBuildError, type LeagueForkTeamFile } from "../src/leagues/forkTeam";
import { LeagueStore } from "../src/leagues/store";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";
import type { ParsedGameResult } from "../src/site-backend/fumbblResult";

// Play on Super FUMBBL for league fixtures (src/leagues/forkTeam.ts, forkResult.ts, forkPlay.ts). The fork is a stub:
// no test schedules a real game.

const pos = (id: string, name: string, s: { ma: number; st: number; ag: number; pa: number; av: number; cost: number }, skills: string[] = [], type = "Regular") =>
  `<position id="${id}"><quantity>16</quantity><name>${name}</name><type>${type}</type><gender>male</gender><cost>${s.cost}</cost>` +
  `<movement>${s.ma}</movement><strength>${s.st}</strength><agility>${s.ag}</agility><passing>${s.pa}</passing><armour>${s.av}</armour>` +
  `<skillList>${skills.map((k) => `<skill>${k}</skill>`).join("")}</skillList></position>`;
const HUMAN = '<?xml version="1.0" encoding="UTF-8"?>\n<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  pos("10", "Human Lineman", { ma: 6, st: 3, ag: 3, pa: 4, av: 9, cost: 50000 }) +
  pos("11", "Human Thrower", { ma: 6, st: 3, ag: 3, pa: 2, av: 9, cost: 75000 }, ["Sure Hands", "Pass"]) + "</roster>";
const ORC = '<roster id="orc.bb2025"><name>Orc</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  pos("20", "Orc Lineman", { ma: 5, st: 3, ag: 3, pa: 4, av: 10, cost: 50000 }) + "</roster>";
const ROSTERS = new Map([["human.bb2025", HUMAN], ["orc.bb2025", ORC]]);

const player = (playerId: string, number: number, name: string, position: string, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId, number, name, position, ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0,
  missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, ...over,
});

const humans = (): LeagueTeam => ({
  id: "grudge", name: "Grudge Rollers", race: "Human", coach: "Ann", coachId: "Ann", teamValue: 1_100_000, treasury: 10_000, rerolls: 2, fans: 2,
  assistantCoaches: 1, cheerleaders: 0, apothecary: true, tier: "2", raceLeague: "",
  players: [
    player("p-thrower", 1, "Arm", "Thrower", { pa: 2, skills: ["Sure Hands", "Pass", "Block"], availableSpp: 8, niggling: 1, value: 95000 }),
    player("p-lino", 2, "Limp", "Human Lineman", { ma: 5, skills: ["Hatred (Undead)"], missNextGame: true }),
    player("p-doomed", 3, "Doomed", "Human Lineman"),
  ],
  formerPlayers: [],
});
const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Green Tide", race: "Orc", coach: "Bob", coachId: "Bob", teamValue: 1_000_000, treasury: 0, rerolls: 3, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "",
  players: [player("q-1", 1, "Grot", "Lineman", { ma: 5, av: 10 })],
  formerPlayers: [],
});

const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Grudge Rollers", teamId: "grudge", coach: "Ann", coachId: "Ann", race: "Human", score: null, cas: null, conceded: false },
  away: { team: "Green Tide", teamId: "orcs", coach: "Bob", coachId: "Bob", race: "Orc", score: null, cas: null, conceded: false },
  suspended: false, forkEnabled: true, ...over,
});

const season = (fixtures: LeagueFixture[], status: "active" | "completed" = "active"): SeasonRecord => ({
  id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, participants: [], teams: [humans(), orcs()], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("league roster -> fork team file", () => {
  it("writes every player as the league has them, with the fork id map", () => {
    const file = buildLeagueForkTeam({ leagueId: "tabbl", seasonId: "season-7", team: humans(), coach: "Ann", rosters: ROSTERS, now: new Date(0) });
    const id = forkTeamIdFor("tabbl", "season-7", "grudge");
    expect(file.forkTeamId).toBe(id);
    expect(id).toMatch(/^lg_[a-f0-9]{16}$/);
    expect(file.rosterId).toBe("human.bb2025");
    expect(file.players).toEqual([
      { forkPlayerId: forkPlayerIdFor(id, "p-thrower"), playerId: "p-thrower" },
      { forkPlayerId: forkPlayerIdFor(id, "p-lino"), playerId: "p-lino" },
      { forkPlayerId: forkPlayerIdFor(id, "p-doomed"), playerId: "p-doomed" },
    ]);
    const x = file.xml;
    expect(x).toContain(`<team id="${id}">`);
    expect(x).toContain("<coach>Ann</coach>");
    expect(x).toContain("<name>Grudge Rollers</name>");
    expect(x).toContain("<rosterId>human.bb2025</rosterId>");
    expect(x).toContain("<treasury>10000</treasury>");
    expect(x).toContain("<reRolls>2</reRolls>");
    expect(x).toContain("<fanFactor>2</fanFactor>");
    expect(x).toContain("<apothecaries>1</apothecaries>");
    expect(x).toContain("<assistantCoaches>1</assistantCoaches>");
    expect(x).not.toContain("<custom>");
    expect(x).toContain("<currentTeamValue>110</currentTeamValue>");
    const block = (playerId: string): string => x.match(new RegExp(`<player [^>]*id="${forkPlayerIdFor(id, playerId)}"[\\s\\S]*?</player>`))![0];
    // Thrower: matched by the bare position name, printed skills left out, Block written, SPP and the niggle carried
    expect(block("p-thrower")).toContain("<positionId>11</positionId>");
    expect(block("p-thrower")).toContain("<skillList><skill>Block</skill></skillList>");
    expect(block("p-thrower")).toContain('currentSpps="8"');
    expect(block("p-thrower")).toContain("<injuryList><injury>Serious Injury (NI)</injury></injuryList>");
    expect(block("p-thrower")).not.toContain("<passing>");
    // Lineman with a lost MA point and a missed next game; parameter skills carry their value
    expect(block("p-lino")).toContain("<movement>5</movement>");
    expect(block("p-lino")).toContain('<skill value="undead">Hatred</skill>');
    expect(block("p-lino")).toContain('<injury recovering="true">Seriously Hurt (MNG)</injury>');
    expect(block("p-doomed")).toContain("<injuryList/>");
    expect(file.library).toMatchObject({ teamName: "Grudge Rollers", race: "Human", treasury: 10000, rerolls: 2, apothecary: true });
  });

  it("refuses with a readable reason: unknown race, position or skill, empty roster", () => {
    const build = (team: LeagueTeam) => () => buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS });
    expect(build({ ...humans(), race: "Vampire" })).toThrow("Super FUMBBL has no Vampire roster.");
    expect(build({ ...humans(), players: [player("x", 1, "Odd", "Wizard")] })).toThrow(/no "Wizard" position/);
    expect(build({ ...humans(), players: [player("x", 1, "Odd", "Human Lineman", { skills: ["Laser Eyes"] })] })).toThrow(ForkTeamBuildError);
    expect(build({ ...humans(), players: [] })).toThrow(/no players/);
  });
});

const fullResult = (homeId: string, awayId: string, over: Partial<ForkGameResult> = {}): ForkGameResult => ({
  gameId: "g42", source: "full", playedAt: "2026-10-30T20:00:00.000Z",
  teams: [
    { teamId: homeId, score: 2, conceded: false, winnings: 60_000, treasurySpent: 10_000, dedicatedFansModifier: 1, players: [
      { forkPlayerId: forkPlayerIdFor(homeId, "p-thrower"), name: "Arm", td: 2, cas: 1, completions: 1, interceptions: 0, mvp: 1, fouls: 0, earnedSpps: 6 + 1 + 4 + 2, injuries: ["Head Injury (-AV)"] },
      { forkPlayerId: forkPlayerIdFor(homeId, "p-doomed"), name: "Doomed", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 1, earnedSpps: 0, injuries: ["Dead (RIP)"] },
      { forkPlayerId: "star-1", name: "Hired Star", td: 0, cas: 1, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 2 },
    ] },
    { teamId: awayId, score: 1, conceded: false, winnings: 40_000, treasurySpent: 0, dedicatedFansModifier: 0, players: [
      { forkPlayerId: forkPlayerIdFor(awayId, "q-1"), name: "Grot", td: 1, cas: 1, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 5, injuries: ["Serious Injury (NI)"] },
    ] },
  ],
  ...over,
});

describe("result -> league team mutation (pure)", () => {
  const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
  const map = humans().players.map((p) => ({ forkPlayerId: forkPlayerIdFor(hid, p.playerId), playerId: p.playerId }));

  it("SPP, counters, injuries, death, MNG recovery, treasury, fans; the input is untouched", () => {
    const before = humans();
    const r = fullResult(hid, "away");
    const m = mutateLeagueTeam(before, r.teams[0]!, map, "full");
    expect(before.players).toHaveLength(3);
    const t = m.team;
    const arm = t.players.find((p) => p.playerId === "p-thrower")!;
    expect(arm.availableSpp).toBe(8 + 13);
    expect(arm.stats).toMatchObject({ td: 2, cas: 1, completions: 1, mvp: 1, spp: 13 });
    expect(arm.av).toBe(8);
    expect(arm.missNextGame).toBe(true);
    expect(arm.niggling).toBe(1);
    expect(t.players.find((p) => p.playerId === "p-lino")!.missNextGame).toBe(false); // served last game's MNG
    expect(t.players.find((p) => p.playerId === "p-doomed")).toBeUndefined();
    expect(t.formerPlayers).toEqual([expect.objectContaining({ playerId: "p-doomed", name: "Doomed", stats: expect.objectContaining({ fouls: 1 }) })]);
    expect(m.retired).toEqual(["p-doomed"]);
    expect(t.teamValue).toBe(1_100_000 - 50_000);
    expect(t.treasury).toBe(10_000 - 10_000 + 60_000);
    expect(t.fans).toBe(3);
    expect(t.players.every((p) => p.seasonsPlayed === undefined)).toBe(true);
    expect(m.lines.find((l) => l.forkPlayerId === "star-1")).toMatchObject({ name: "Hired Star", cas: 1 });
    expect(m.lines.find((l) => l.forkPlayerId === "star-1")).not.toHaveProperty("playerId");
  });

  it("injury table: NI adds a niggle, characteristic losses, every serious injury misses the next game", () => {
    const one = (injury: string) => mutateLeagueTeam(humans(), { teamId: hid, score: 0, conceded: false, winnings: 0, players: [
      { forkPlayerId: map[2]!.forkPlayerId, name: "", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0, injuries: [injury] },
    ] }, map, "full").team.players.find((p) => p.playerId === "p-doomed")!;
    expect(one("Serious Injury (NI)")).toMatchObject({ niggling: 1, missNextGame: true });
    expect(one("Smashed Knee (-MA)")).toMatchObject({ ma: 5, missNextGame: true });
    expect(one("Dislocated Shoulder (-ST)")).toMatchObject({ st: 2 });
    expect(one("Dislocated Hip (-AG)")).toMatchObject({ ag: 4 });
    expect(one("Broken Arm (-PA)")).toMatchObject({ pa: 5 });
    expect(one("Seriously Hurt (MNG)")).toMatchObject({ niggling: 0, ma: 6, missNextGame: true });
  });

  it("a conceding team's spendable SPP is cleared; a basic result only adds counters and winnings", () => {
    const conceded = mutateLeagueTeam(humans(), { ...fullResult(hid, "a").teams[0]!, conceded: true }, map, "full").team;
    expect(conceded.players.every((p) => p.availableSpp === 0)).toBe(true);
    const basic = mutateLeagueTeam(humans(), { teamId: hid, score: 1, conceded: false, winnings: 20_000, players: [
      { forkPlayerId: map[0]!.forkPlayerId, name: "Arm", td: 1, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0 },
    ] }, map, "basic").team;
    const arm = basic.players.find((p) => p.playerId === "p-thrower")!;
    expect(arm).toMatchObject({ availableSpp: 8, av: 9, missNextGame: false });
    expect(arm.stats.td).toBe(1);
    expect(basic.players.find((p) => p.playerId === "p-lino")!.missNextGame).toBe(true); // nothing known about recovery
    expect(basic.treasury).toBe(30_000);
    expect(basic.fans).toBe(2);
  });

  it("the server's FumbblResult maps to a full result", () => {
    const parsed: ParsedGameResult = { gameId: "g9", halves: 2, teams: [
      { teamId: "A", score: 1, conceded: false, stalled: false, winnings: 50_000, dedicatedFansModifier: -1, treasurySpentOnInducements: 5000, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [
        { playerId: "a1", name: "X", defecting: false, currentSpps: 0, earnedSpps: 3, completions: 0, touchdowns: 1, deflections: 0, interceptions: 0, casualties: 0, playerAwards: 0, landings: 0, blocks: 2, fouls: 0, rushing: 0, passing: 0, turnsPlayed: 16, injuries: [], gainedHatred: [] },
      ] },
      { teamId: "B", score: 0, conceded: false, stalled: false, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [] },
    ] };
    const r = fromParsedResult(parsed, "2026-10-30T00:00:00.000Z");
    expect(r).toMatchObject({ gameId: "g9", source: "full", teams: [{ teamId: "A", winnings: 50_000, treasurySpent: 5000, dedicatedFansModifier: -1, players: [{ forkPlayerId: "a1", td: 1, earnedSpps: 3 }] }, { teamId: "B", winnings: 0 }] });
  });

  it("closes the fixture once: score, casualties, played; a second apply or another game is refused", () => {
    const s = season([fx("f1")]);
    const f = s.fixtures[0]!;
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    f.fork = { status: "scheduled", gameId: "g42", log: [], teams: {
      home: { teamId: "grudge", forkTeamId: hid, coach: "Ann", builtAt: "", players: map },
      away: { teamId: "orcs", forkTeamId: aid, coach: "Bob", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(aid, "q-1"), playerId: "q-1" }] },
    } };
    expect(applyForkResult(s, f, { ...fullResult(hid, aid), gameId: "g1" }, new Date())).toMatchObject({ applied: false });
    const out = applyForkResult(s, f, fullResult(hid, aid), new Date("2026-10-31T00:00:00Z"));
    expect(out.applied).toBe(true);
    expect(f.home).toMatchObject({ score: 2, cas: 2, conceded: false }); // the hired Star's casualty counts for the team
    expect(f.away).toMatchObject({ score: 1, cas: 1 });
    expect(f.finishedAt).toBe("2026-10-30T20:00:00.000Z");
    expect(f.fork!.status).toBe("finished");
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]).toMatchObject({ niggling: 1, missNextGame: true, availableSpp: 5 });
    const again = applyForkResult(s, f, fullResult(hid, aid), new Date());
    expect(again).toMatchObject({ applied: false, already: true });
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]!.availableSpp).toBe(5);
  });
});

// ---- routes, with a stub fork ----

interface Stub extends LeagueForkClient {
  installs: Array<Array<{ coach: string; file: LeagueForkTeamFile }>>;
  schedules: Array<[string, string]>;
  launches: Array<{ coach: string; teamId: string; gameId: string }>;
  next: ForkScheduleOutcome;
  states: Map<string, { status: "scheduled" | "active" | "finished"; playedAt?: string }>;
  results: Map<string, ForkGameResult>;
}
function stubFork(): Stub {
  const s: Stub = {
    installs: [], schedules: [], launches: [], next: { kind: "scheduled", gameId: "g42" }, states: new Map(), results: new Map(),
    rosters: () => ROSTERS,
    async installTeams(teams) { await new Promise((r) => setTimeout(r, 5)); s.installs.push(teams); },
    async schedule(h, a) { await new Promise((r) => setTimeout(r, 5)); s.schedules.push([h, a]); return s.next; },
    async launchFile(input) { s.launches.push(input); return `<jnlp coach="${input.coach}" team="${input.teamId}" game="${input.gameId}"/>`; },
    async gameStates(ids) { return new Map([...s.states].filter(([id]) => ids.includes(id))); },
    async result(id) { return s.results.get(id); },
  };
  return s;
}

describe("Super FUMBBL fixture routes", () => {
  let dir: string;
  let store: LeagueStore;
  let fork: Stub;
  let body: unknown;
  const notes: Array<{ coach: string; title: string; body: string }> = [];
  const posts: DiscordPayload[] = [];
  const IDS = [{ coach: "Jay", level: "organizer" }, { coach: "Ann", level: "player" }, { coach: "Bob", level: "player" }, { coach: "Root", level: "admin" }, { coach: "Eve", level: "player" }];
  const deps = (): LeagueApiDeps => ({
    store, fork,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date("2026-10-30T12:00:00Z"),
    identities: () => IDS,
    notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body }); },
    postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
  });
  const ANN = { coach: "Ann", admin: false };
  const BOB = { coach: "bob", admin: false };
  const JAY = { coach: "Jay", admin: false };
  const EVE = { coach: "Eve", admin: false };
  const ROOT = { coach: "Root", admin: true };
  const base = "/api/leagues/tabbl/seasons/season-7/fixtures/f1";
  const call = async (method: string, path: string, auth?: { coach: string; admin: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  const fixture = () => store.season("tabbl", "season-7")!.fixtures.find((f) => f.id === "f1")!;
  const view = (r: LeagueApiResult) => (r.body as { fork: Record<string, any> }).fork;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-fork-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], playOnFork: true });
    store.putSeason(season([fx("f1"), fx("f2", { forkEnabled: false })]));
    fork = stubFork();
    notes.length = 0;
    posts.length = 0;
    resetForkToggleLimit();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("summary: public read, Generate offered to the seated coaches and organisers only", async () => {
    const anon = await call("GET", base);
    expect(anon.status).toBe(200);
    expect(view(anon)).toMatchObject({ enabled: true, status: "none", statusLabel: "Not generated", canGenerate: false, canStart: false });
    expect(view(anon)).not.toHaveProperty("log");
    expect(view(await call("GET", base, ANN))).toMatchObject({ canGenerate: true, mySide: "home" });
    expect(view(await call("GET", base, BOB))).toMatchObject({ canGenerate: true, mySide: "away" });
    expect(view(await call("GET", base, JAY))).toMatchObject({ canGenerate: true, canConfigure: true });
    expect(view(await call("GET", base, EVE))).toMatchObject({ canGenerate: false, canConfigure: false });
    expect(view(await call("GET", "/api/leagues/tabbl/seasons/season-7/fixtures/f2", ANN))).toMatchObject({ enabled: false, canGenerate: false, blocker: expect.stringContaining("not allowed") });
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-7/fixtures/nope")).status).toBe(404);
  });

  it("generate: builds both teams, schedules once, invites the opponent and tells organisers and admins", async () => {
    expect((await call("POST", `${base}/fork/generate`, EVE, {})).status).toBe(403);
    expect((await call("POST", `${base}/fork/generate`, undefined, {})).status).toBe(401);
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(200);
    expect(view(r)).toMatchObject({ status: "scheduled", gameId: "g42", canStart: true, canGenerate: false });
    expect(fork.installs).toHaveLength(1);
    expect(fork.installs[0]!.map((t) => t.coach)).toEqual(["Ann", "Bob"]);
    const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    expect(fork.schedules).toEqual([[hid, aid]]);
    const f = fixture();
    expect(f.fork).toMatchObject({ status: "scheduled", gameId: "g42", generatedBy: "Ann", invited: true });
    expect(f.fork!.teams.home).toMatchObject({ teamId: "grudge", forkTeamId: hid, coach: "Ann" });
    expect(f.fork!.teams.home!.players).toHaveLength(3);
    expect(notes.map((n) => n.coach).sort()).toEqual(["Bob", "Jay", "Root"]);
    expect(notes.find((n) => n.coach === "Bob")!.body).toContain("Ann has invited you to play your match on Super FUMBBL");
    expect(notes.find((n) => n.coach === "Jay")!.title).toBe("Fixture generated on Super FUMBBL");
    // idempotent: a second click (either coach) re-uses the teams and the game
    const again = await call("POST", `${base}/fork/generate`, BOB, {});
    expect(again.status).toBe(200);
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(1);
    expect(notes).toHaveLength(3);
  });

  it("a double click at the same moment builds and schedules once", async () => {
    const [a, b] = await Promise.all([call("POST", `${base}/fork/generate`, ANN, {}), call("POST", `${base}/fork/generate`, BOB, {})]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(1);
  });

  it("an organiser generates: both coaches are invited", async () => {
    expect((await call("POST", `${base}/fork/generate`, JAY, {})).status).toBe(200);
    expect(notes.filter((n) => n.title === "Play on Super FUMBBL").map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]);
    expect(notes.find((n) => n.coach === "Ann")!.body).toContain("Jay has invited you");
  });

  it("blocked: fixture not allowed, league toggle off, a played fixture, a finished season unless late launch is allowed", async () => {
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/fixtures/f2/fork/generate", ANN, {})).status).toBe(409);
    store.updateLeague("tabbl", (l) => { l.playOnFork = false; });
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).body).toMatchObject({ error: expect.stringContaining("off for this league") });
    store.updateLeague("tabbl", (l) => { l.playOnFork = true; });
    const s = store.season("tabbl", "season-7")!;
    s.status = "completed";
    store.putSeason(s);
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).body).toMatchObject({ error: expect.stringContaining("late launch") });
    expect((await call("PATCH", base, ANN, { forkAllowLate: true })).status).toBe(403);
    const late = await call("PATCH", base, JAY, { forkAllowLate: true });
    expect(late.status).toBe(200);
    expect((late.body as { fixture: LeagueFixture }).fixture.forkAllowLate).toBe(true);
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect(fork.schedules).toHaveLength(1);
  });

  it("a team build failure is reported and nothing is scheduled", async () => {
    const s = store.season("tabbl", "season-7")!;
    s.teams[0]!.players[0]!.skills.push("Laser Eyes");
    store.putSeason(s);
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("Laser Eyes");
    expect(fork.installs).toHaveLength(0);
    fork.installTeams = async () => { throw new Error("reload refused"); };
    s.teams[0]!.players[0]!.skills.pop();
    store.putSeason(s);
    const r2 = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r2.status).toBe(502);
    expect(fork.schedules).toHaveLength(0);
    expect(view(await call("GET", base, JAY))).toMatchObject({ status: "none", canGenerate: true });
  });

  it("launch failed: reason shown, organiser reset with a logged reason, then generate re-uses the teams", async () => {
    fork.next = { kind: "rejected", error: "fork admin/schedule: team not loaded" };
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(502);
    expect(view(r)).toMatchObject({ status: "launch_failed", statusLabel: "Failed", error: "fork admin/schedule: team not loaded", canStart: false });
    expect(notes).toHaveLength(0);
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(409);
    expect((await call("POST", `${base}/fork/reset`, ANN, { reason: "retry" })).status).toBe(403);
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "  " })).status).toBe(400);
    expect(view(await call("GET", base, JAY))).toMatchObject({ canReset: true });
    const reset = await call("POST", `${base}/fork/reset`, JAY, { reason: "Teams reloaded by hand" });
    expect(reset.status).toBe(200);
    expect(view(reset)).toMatchObject({ status: "teams_built", canGenerate: true });
    expect(view(reset).log.at(-1)).toMatchObject({ by: "Jay", text: "Reset: Teams reloaded by hand" });
    fork.next = { kind: "scheduled", gameId: "g77" };
    expect(view(await call("POST", `${base}/fork/generate`, ANN, {}))).toMatchObject({ status: "scheduled", gameId: "g77" });
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(2);
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "x" })).status).toBe(409);
  });

  it("launch file: the seated coach only (403 for anyone else, organisers and admins too)", async () => {
    expect((await call("GET", `${base}/fork/jnlp`, ANN)).status).toBe(409); // nothing scheduled yet
    await call("POST", `${base}/fork/generate`, ANN, {});
    for (const who of [EVE, JAY, ROOT]) expect((await call("GET", `${base}/fork/jnlp`, who)).status).toBe(403);
    expect((await call("POST", `${base}/fork/launch`, EVE, {})).status).toBe(403);
    const launch = await call("POST", `${base}/fork/launch`, BOB, {});
    expect(launch.body).toMatchObject({ jnlpUrl: `${base}/fork/jnlp`, side: "away", gameId: "g42" });
    expect(fixture().fork!.launched).toEqual({ away: "2026-10-30T12:00:00.000Z" });
    const j = await call("GET", `${base}/fork/jnlp`, BOB);
    expect(j.status).toBe(200);
    expect(j.download!.contentType).toContain("jnlp");
    expect(j.download!.bytes.toString()).toContain(`team="${forkTeamIdFor("tabbl", "season-7", "orcs")}"`);
    expect(fork.launches).toEqual([{ coach: "Bob", teamId: forkTeamIdFor("tabbl", "season-7", "orcs"), gameName: "league-f1", gameId: "g42" }]);
    // cancelled: no launch file
    expect((await call("PATCH", base, JAY, { forkCancelled: true })).status).toBe(200);
    expect(fixture().fork!.status).toBe("cancelled");
    expect((await call("GET", `${base}/fork/jnlp`, BOB)).status).toBe(409);
  });

  it("result sync: in progress, then the result closes the fixture once, mutates both teams and notifies", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    store.setSecrets("tabbl", { discordWebhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123" });
    notes.length = 0;
    fork.states.set("g42", { status: "active" });
    await syncLeagueForkResults({ store, fork, notify: deps().notify, postWebhook: deps().postWebhook });
    expect(fixture().fork!.status).toBe("in_progress");
    const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    fork.states.set("g42", { status: "finished", playedAt: "2026-10-30T20:00:00.000Z" });
    fork.results.set("g42", fullResult(hid, aid));
    const [one, two] = await Promise.all([
      syncLeagueForkResults({ store, fork, notify: deps().notify, postWebhook: deps().postWebhook }),
      call("POST", `${base}/fork/sync`, JAY, {}),
    ]);
    expect(two.status).toBe(200);
    const s = store.season("tabbl", "season-7")!;
    const f = s.fixtures.find((x) => x.id === "f1")!;
    expect(f.home.score).toBe(2);
    expect(f.away.score).toBe(1);
    expect(f.fork!.status).toBe("finished");
    expect(f.fork!.result).toMatchObject({ gameId: "g42", source: "full", home: { score: 2, winnings: 60_000 } });
    const home = s.teams.find((t) => t.id === "grudge")!;
    expect(home.treasury).toBe(60_000);
    expect(home.fans).toBe(3);
    expect(home.players.map((p) => p.playerId)).toEqual(["p-thrower", "p-lino"]);
    expect(home.formerPlayers.map((p) => p.playerId)).toEqual(["p-doomed"]);
    expect(home.players[0]!.availableSpp).toBe(21);
    expect(one.applied.length + ((two.body as { applied: string[] }).applied.length)).toBe(1);
    expect(notes.filter((n) => n.title === "Super FUMBBL result recorded").map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]);
    expect(posts.filter((p) => p.embeds[0]!.title.includes("2 - 1"))).toHaveLength(1);
    // again: nothing more
    await syncLeagueForkResults({ store, fork, notify: deps().notify });
    expect(store.season("tabbl", "season-7")!.teams.find((t) => t.id === "grudge")!.players[0]!.availableSpp).toBe(21);
    expect(notes.filter((n) => n.title === "Super FUMBBL result recorded")).toHaveLength(2);
    // the summary shows the lines; the season read carries the status only
    const sum = view(await call("GET", base, EVE));
    expect(sum).toMatchObject({ status: "finished", result: { home: { lines: expect.arrayContaining([expect.objectContaining({ playerId: "p-thrower", td: 2 })]) } } });
    const read = (await call("GET", "/api/leagues/tabbl/seasons/season-7", EVE)).body as { season: SeasonRecord };
    expect(read.season.fixtures[0]!.fork).toEqual({ status: "finished", teams: {}, log: [] });
  });

  it("a fixture that got a result by hand is never overwritten by the fork result", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    const f = s.fixtures.find((x) => x.id === "f1")!;
    f.home.score = 0; f.away.score = 0;
    store.putSeason(s);
    fork.states.set("g42", { status: "finished" });
    fork.results.set("g42", fullResult(forkTeamIdFor("tabbl", "season-7", "grudge"), forkTeamIdFor("tabbl", "season-7", "orcs")));
    const out = await syncLeagueForkResults({ store, fork });
    expect(out.applied).toEqual([]);
    expect(out.errors[0]).toContain("already has a result");
    expect(store.season("tabbl", "season-7")!.teams[0]!.treasury).toBe(10_000);
  });

  it("no fork connected: actions answer 503, the summary still reads", async () => {
    const plain = { ...deps(), fork: undefined };
    const r = await leagueApi("POST", `${base}/fork/generate`, new URLSearchParams(), ANN, plain);
    expect(r!.status).toBe(503);
    const g = await leagueApi("GET", base, new URLSearchParams(), ANN, plain);
    expect((g!.body as { forkAvailable: boolean }).forkAvailable).toBe(false);
  });
});
