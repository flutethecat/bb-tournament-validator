import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import { LeagueStore } from "../src/leagues/store";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";
import { MemoryDiceLog, fixtureLogId, type DiceRoll } from "../src/dice/log";
import { sequenceRoller } from "../src/dice/roller";
import { advancementCount, suggestForfeit } from "../src/forfeit/rules";
import { applyForfeit, forfeitModel, rollDefections, undoForfeit } from "../src/leagues/forfeit";
import { createMatch, tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch";
import { FileTabletopRepository } from "../src/tabletop/store";
import { TournamentResultStore } from "../src/tournamentResults";
import { DIE_FACES, dieFaceIndex, dieSpin } from "../spa/src/dice/client";

// Sol review of the dice / forfeit lane (11-02): one test per finding.

const pl = (id: string, position: string, skills: string[] = [], over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: id, number: Number(id.replace(/\D/g, "")) || 1, name: `Orc ${id}`, position, ma: 5, st: 3, ag: 3, pa: 4, av: 10, skills,
  value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, ...over,
});
const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", coachId: "Ann", teamValue: 1000000, treasury: 50000, rerolls: 2, fans: 3,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [pl("p1", "Orc Blitzer", ["Block", "Dodge", "Guard", "Tackle"]), pl("p3", "Orc Lineman", ["Block", "Dodge", "Guard"]), pl("p5", "Orc Lineman")],
  formerPlayers: [],
});
const elves = (): LeagueTeam => ({
  id: "elves", name: "Elves", race: "Wood Elf", coach: "Bob", coachId: "Bob", teamValue: 1000000, treasury: 0, rerolls: 1, fans: 2,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [pl("e1", "Wood Elf Lineman", [], { name: "Elf 1" })], formerPlayers: [],
});
const fx = (): LeagueFixture => ({
  id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 2, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false,
});
const season = (): SeasonRecord => ({
  id: "s1", leagueId: "tabbl", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [fx()], teams: [orcs(), elves()], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

let dir: string;
let store: LeagueStore;
let body: unknown;
let posts: DiscordPayload[];
let log: MemoryDiceLog;
let rolls: number[];
const deps = (): LeagueApiDeps => ({
  store, diceLog: log, roller: sequenceRoller(rolls), publicNames: () => true,
  readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  now: () => new Date("2026-11-02T12:00:00.000Z"),
  postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
});
const call = async (method: string, path: string, b?: unknown, coach = "Jay"): Promise<LeagueApiResult> => {
  body = b;
  return (await leagueApi(method, path, new URLSearchParams(), { coach, admin: false }, deps()))!;
};
const F = "/api/leagues/tabbl/seasons/s1/fixtures/f1/forfeit";
const homeForfeits = (over: Record<string, unknown> = {}) => { const s = suggestForfeit({ home: true, away: false }); return { home: s.home, away: { ...s.away, winnings: 40000, mvp: ["e1"] }, noStandings: false, legalConcession: false, ...over }; };
const IDS = { leagueId: "tabbl", seasonId: "s1", fixtureId: "f1" };
const team = (id: string) => store.season("tabbl", "s1")!.teams.find((t) => t.id === id)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "forfeit-review-"));
  store = new LeagueStore(join(dir, "leagues"));
  store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
  store.setSecrets("tabbl", { discordWebhookUrl: "https://discord.com/api/webhooks/1/x" });
  store.putSeason(season());
  posts = [];
  log = new MemoryDiceLog();
  rolls = [2, 5];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("#1 clearing never re-rolls or re-applies; the undo reverses exactly", () => {
  it("a result edit on a forfeited fixture is refused; undo restores the rosters; re-entering reuses the rolls and applies once", async () => {
    const before = { orcs: structuredClone(team("orcs")), elves: structuredClone(team("elves")) };
    await call("POST", `${F}/defections`, { side: "home" });
    expect((await call("POST", F, homeForfeits())).status).toBe(200);
    expect(team("elves").treasury).toBe(40000);
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/s1/fixtures/f1", { result: null })).status).toBe(409);
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/s1/fixtures/f1", { result: { home: 1, away: 1 } })).status).toBe(409);
    expect((await call("POST", `${F}/undo`, {})).status).toBe(200);
    // the rosters are back exactly; the team history gains one "undone" line
    const { history: oh, ...orcsNow } = team("orcs");
    const { history: eh, ...elvesNow } = team("elves");
    expect(orcsNow).toEqual(before.orcs);
    expect(elvesNow).toEqual(before.elves);
    expect(oh?.map((h) => h.changes[0]!.what)).toEqual(["Forfeit v Elves undone"]);
    expect(eh).toHaveLength(1);
    const f = store.season("tabbl", "s1")!.fixtures[0]!;
    expect(f.forfeit).toBeUndefined();
    expect(f.home.score).toBeNull();
    expect(f.forfeitDraft?.rolls.map((r) => r.roll)).toEqual([2, 5]); // the rolls stay with the fixture
    rolls = [6, 6];
    expect(((await call("POST", `${F}/defections`, { side: "home" })).body as any).draft.rolls.map((r: any) => r.roll)).toEqual([2, 5]);
    expect((await call("POST", F, homeForfeits())).status).toBe(200);
    expect(team("elves").treasury).toBe(40000); // once, not 80k
    expect(team("elves").players[0]!.availableSpp).toBe(4); // once, not 8
    expect(team("orcs").formerPlayers.map((p) => p.playerId)).toEqual(["p1"]);
    // through the shared leave path and the team history (team page)
    expect(team("orcs").history?.[0]).toMatchObject({ kind: "forfeit", changes: expect.arrayContaining([{ what: "Defection roll 2: Orc p1", to: "left the team" }]) });
    expect(team("elves").history?.[0]!.changes.map((c) => c.what)).toEqual(["Won by forfeit v Orcs", "Treasury", "MVP: Elf 1"]);
  });
  it("the undo is refused when a roster changed since the forfeit", async () => {
    await call("POST", `${F}/defections`, { side: "home" });
    await call("POST", F, homeForfeits());
    const s = store.season("tabbl", "s1")!;
    s.teams.find((t) => t.id === "elves")!.treasury = 1;
    store.putSeason(s);
    expect((await call("POST", `${F}/undo`, {})).status).toBe(409);
  });
});

describe("#2 a partial dice-log failure never lets a retry re-roll", () => {
  it("the rolls logged before the failure are reused", async () => {
    let n = 0;
    const flaky = new MemoryDiceLog();
    const failing = { read: (id: string) => flaky.read(id), appendChoice: () => undefined, appendRoll: (r: DiceRoll) => { n += 1; if (n === 2) throw new Error("disk"); flaky.appendRoll(r); } };
    const first = rollDefections({ store, diceLog: failing, roller: sequenceRoller([1, 4]) }, IDS, { coach: "Jay", admin: false }, { side: "home" });
    expect(first.status).toBe(500);
    expect(store.season("tabbl", "s1")!.fixtures[0]!.forfeitDraft).toBeUndefined();
    const retry = rollDefections({ store, diceLog: failing, roller: sequenceRoller([6, 6]) }, IDS, { coach: "Jay", admin: false }, { side: "home" });
    expect(retry.status).toBe(201);
    expect((retry.body as any).draft.rolls.map((r: any) => r.roll)).toEqual([1, 6]); // p1 kept its logged 1
    expect(flaky.read(fixtureLogId("league:tabbl:s1:f1")).map((r) => r.dice[0])).toEqual([1, 6]);
  });
});

describe("#3 legality locks once defections are rolled", () => {
  it("a legal concession after the rolls is refused", async () => {
    await call("POST", `${F}/defections`, { side: "home" });
    const r = await call("POST", F, homeForfeits({ legalConcession: true }));
    expect(r.status).toBe(409);
    expect(((await call("GET", F)).body as any).legalLocked).toBe(true);
  });
});

describe("re-review #3 any logged defection roll locks legality", () => {
  it("a partial log (no draft saved) still refuses a legal concession", async () => {
    let n = 0;
    const flaky = new MemoryDiceLog();
    log = flaky;
    const failing = { read: (i: string) => flaky.read(i), appendChoice: () => undefined, appendRoll: (r: DiceRoll) => { n += 1; if (n === 2) throw new Error("disk"); flaky.appendRoll(r); } };
    expect(rollDefections({ store, diceLog: failing, roller: sequenceRoller([1, 4]) }, IDS, { coach: "Jay", admin: false }, { side: "home" }).status).toBe(500);
    expect(store.season("tabbl", "s1")!.fixtures[0]!.forfeitDraft).toBeUndefined();
    expect(((await call("GET", F)).body as any).legalLocked).toBe(true);
    expect((await call("POST", F, homeForfeits({ legalConcession: true }))).status).toBe(409);
  });
});

describe("#4 advancements are counted one by one", () => {
  it("a listed +MA (cancelled by injury on the line) and a separate ST increase are two advancements", () => {
    expect(advancementCount(pl("x", "Orc Lineman", ["+MA"], { ma: 5, st: 4 }), "Orc", "BB2025")).toBe(2);
    expect(advancementCount(pl("y", "Orc Lineman", ["+MA", "+ST", "Dodge"], { ma: 5, st: 3 }), "Orc", "BB2025")).toBe(3);
    expect(advancementCount(pl("z", "Orc Lineman", ["+MA"], { ma: 6 }), "Orc", "BB2025")).toBe(1); // the same advance, not two
  });
});

describe("#7 a legal concession carries no illegal-only penalties", () => {
  it("the conceder's fan loss is dropped unless overridden; the model offers legal suggestions", async () => {
    const m = (await call("GET", F)).body as any;
    expect(m.legalSuggestions.home.home.fans).toBe(0);
    // no penalty notes; only the default money rules' line (the BB2025 rulebook concession pays the other team)
    expect(m.legalSuggestions.home.notes).toEqual([expect.stringMatching(/^The league's money rules: the other team gets the whole fan attendance/)]);
    const r = await call("POST", F, homeForfeits({ legalConcession: true, away: { ...suggestForfeit({ home: true, away: false }).away } }));
    expect(r.status).toBe(200);
    expect((r.body as any).ignored).toEqual(["home.fans"]);
    expect(team("orcs").fans).toBe(3);
  });
  it("an explicit override keeps it", async () => {
    const r = await call("POST", F, { ...homeForfeits({ legalConcession: true, away: suggestForfeit({ home: true, away: false }).away }), overridePenalties: true });
    expect(r.status).toBe(200);
    expect(team("orcs").fans).toBe(2);
  });
});

// ---- recorder side (#5, #8, #9) ----------------------------------------------------------------------------------

const player = (id: string): TabletopPlayer => ({ id, name: `P ${id}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false });
const tfile = (name: string, prefix: string): TabletopTeamFile => ({ schema: 1, name, race: "Human", treasury: 0, dedicatedFans: 2, players: Array.from({ length: 11 }, (_, i) => player(`${prefix}${i}`)) });
const NOW = new Date("2026-03-01T10:00:00.000Z");

describe("#5 #8 #9 recorder forfeit", () => {
  let repo: FileTabletopRepository;
  let results: TournamentResultStore;
  let announced: string[];
  let applyCalls: number;
  const tdeps = (): TabletopApiDeps => ({
    repo, results, diceLog: log, roller: sequenceRoller([2, 5]),
    loadTeamFile: (coach) => (coach === "Alice" ? tfile("Humans", "h") : tfile("Orcs", "o")),
    isBanned: () => false, drawSeats: () => false, isOrganizer: (c) => c === "Org", now: () => NOW,
    forfeit: {
      model: (_m, who) => forfeitModel({ store, diceLog: log }, IDS, who),
      undo: (m, who) => undoForfeit({ store, diceLog: log }, IDS, who, { matchId: m.id }),
      roll: (m, who, b) => rollDefections({ store, diceLog: log, roller: sequenceRoller([2, 5]) }, IDS, who, b, { matchId: m.id }),
      settings: () => ({ status: 200, body: {} }),
      apply: async (m, who, b) => { applyCalls += 1; return applyForfeit({ store, diceLog: log, postWebhook: async (_u, p) => { posts.push(p); return { ok: true, status: 204 }; } }, IDS, who, b, { matchId: m.id, announce: false }); },
      announce: async (m) => { announced.push(m.id); },
    },
  });
  const as = async (coach: string, method: string, path: string, b?: unknown): Promise<TabletopResult> =>
    (await tabletopApi(method, path, { coach, method: "discord" }, b, tdeps()))!;
  let id = "";
  beforeEach(async () => {
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay", "Org"] });
    repo = new FileTabletopRepository(join(dir, "tt"));
    results = new TournamentResultStore(join(dir, "results"));
    announced = [];
    applyCalls = 0;
    const r = await createMatch("Org", true, { home: { coach: "Alice", team: "a" }, away: { coach: "Bob", team: "b" }, postMatch: "full", pregame: "skip" }, tdeps(), () => NOW);
    id = (r.body as any).match.id;
  });

  it("#9 recorder defection rolls show in the match's dice log too (once each)", async () => {
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" })).status).toBe(201);
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    const dice = (await as("Org", "GET", `/api/tabletop/matches/${id}/dice`)).body as any;
    expect(dice.log.map((r: any) => [r.kind, r.dice[0]])).toEqual([["defection", 2], ["defection", 5]]);
  });

  it("#5 a crash after the league write is finished by the retry; the webhook goes out after both writes, once", async () => {
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    // the league side applied, the match close did not happen (the pending marker is what a crash leaves behind)
    const m = (await repo.getMatch(id))!;
    await repo.updateMatch({ ...m, forfeitPending: { at: NOW.toISOString(), by: "Org" } });
    const applied = await applyForfeit({ store }, IDS, { coach: "Org", admin: false }, homeForfeits() as never, { matchId: id, announce: false });
    expect(applied.status).toBe(200);
    expect(announced).toEqual([]);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [] })).status).toBe(409); // pending blocks writes
    const retry = await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, homeForfeits());
    expect(retry.status).toBe(200);
    expect((retry.body as any).already).toBe(true);
    expect((retry.body as any).match).toMatchObject({ state: "published", forfeit: { by: "Org", score: { home: 0, away: 2 } } });
    expect((await repo.getMatch(id))!.forfeitPending).toBeUndefined();
    expect(team("elves").treasury).toBe(40000); // applied once
    await new Promise((r) => setTimeout(r, 0));
    expect(announced).toEqual([id]);
  });

  it("#5 a refused forfeit leaves no pending marker", async () => {
    const bad = await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, { home: {}, away: {} });
    expect(bad.status).toBe(400);
    expect(applyCalls).toBe(1);
    expect((await repo.getMatch(id))!.forfeitPending).toBeUndefined();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [] })).status).not.toBe(409);
  });

  it("re-review #2 a recorder forfeit is undone in the recorder (the match reopens); the league side refuses and points there", async () => {
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, homeForfeits())).status).toBe(200);
    const league = await call("POST", `${F}/undo`, {});
    expect(league.status).toBe(409);
    expect((league.body as any).matchId).toBe(id);
    const undo = await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/undo`, {});
    expect(undo.status).toBe(200);
    expect((undo.body as any).match).toMatchObject({ state: "recording" });
    expect((undo.body as any).match.forfeit).toBeUndefined();
    expect(store.season("tabbl", "s1")!.fixtures[0]!.forfeit).toBeUndefined();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [] })).status).not.toBe(409); // writable again (not refused as forfeited)
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/forfeit/undo`, {})).status).toBe(403);
  });

  it("re-review #4 a pending close shows in the dialog model and Finish forfeit completes it", async () => {
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    const m = (await repo.getMatch(id))!;
    await repo.updateMatch({ ...m, forfeitPending: { at: NOW.toISOString(), by: "Org" } });
    await applyForfeit({ store, diceLog: log }, IDS, { coach: "Org", admin: false }, homeForfeits() as never, { matchId: id, announce: false });
    const model = (await as("Org", "GET", `/api/tabletop/matches/${id}/forfeit`)).body as any;
    expect(model.pending).toBe(true);
    const finish = await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, {}); // the dialog's Finish forfeit sends no form
    expect(finish.status).toBe(200);
    expect((finish.body as any).match.state).toBe("published");
    const after = (await as("Org", "GET", `/api/tabletop/matches/${id}/forfeit`)).body as any;
    expect(after.pending).toBeUndefined();
    expect(after.closed).toBe(true);
    expect(after.applied.matchId).toBe(id);
  });

  it("re-review #5 a draft rolled in the fixtures editor reaches the recorder's dice log, once", async () => {
    expect((await call("POST", `${F}/defections`, { side: "home" })).status).toBe(201);
    expect(log.read(id)).toHaveLength(0);
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    expect(log.read(id).map((r) => [r.kind, r.dice[0]])).toEqual([["defection", 2], ["defection", 5]]);
  });

  it("#8 the closed recorder shows the forfeit's score", async () => {
    await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/defections`, { side: "home" });
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, homeForfeits())).status).toBe(200);
    const view = (await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as any;
    expect(view.tally.score).toEqual({ home: 0, away: 2 });
    expect(view.match.forfeit.score).toEqual({ home: 0, away: 2 });
  });
});

describe("#10 block faces drive the tumble by index", () => {
  it("every face of every die gives finite rotations; block faces map to their index", () => {
    expect(dieFaceIndex("block", "pow")).toBe(5);
    expect(dieFaceIndex("block", "skull")).toBe(1);
    for (const die of ["d6", "d8", "d16", "block"] as const)
      for (const f of DIE_FACES[die]) for (const v of Object.values(dieSpin(die, f))) expect(Number.isFinite(v)).toBe(true);
  });
});
