import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import { leagueLobbyFixture } from "../src/fixtureLobby/league";
import { datasetRoster, redraftBudget, rehireQuote, spendable } from "../src/leagues/redraft";
import { DEFAULT_REDRAFT_RULES, effectiveRedraftRules, parseRedraftRules, RedraftRulesError } from "../src/leagues/redraftRules";
import { redraftPlayBlock, runRedraftWindowJob } from "../src/leagues/redraftWindow";
import { LeagueStore } from "../src/leagues/store";
import { leagueFixtureView, recordLeagueFixture } from "../src/leagues/tabletopFixtures";
import type { LeagueFixture, LeaguePlayer, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { EMPTY_PLAYER_STATS } from "../src/leagues/types";

// Redraft mode lane (owner 11-02): editable budget rules, Lift to budget (manual + automatic, logged), the redraft
// window (play block, open / reminder notices, rebuild vs needs redraft at the close), the redraftRolls Discord event,
// the team summary budget, access with a scoped organiser and a global-role non-member, CSRF and read-only GETs.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const NOW = new Date("2026-11-02T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const pl = (n: number, position: string, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: `p-orc${n}`, careerKey: `c-orc${n}`, number: n, name: `Orc ${n}`, position, ma: 5, st: 3, ag: 3, pa: 4, av: 10, skills: [],
  value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0, ...over,
});
const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", coachId: "Ann", teamValue: 1000000, treasury: 50000, rerolls: 2, fans: 1,
  assistantCoaches: 1, cheerleaders: 0, apothecary: true, tier: "1", raceLeague: "",
  players: [pl(1, "Orc Blitzer", { value: 105000, seasonsPlayed: 2, niggling: 1 }), pl(2, "Orc Blitzer"), ...Array.from({ length: 10 }, (_, i) => pl(i + 3, "Orc Lineman"))],
  formerPlayers: [],
});
/** A thin team: 11 linemen, no money, no niggles (earns little: a lift raises it). */
const goblins = (): LeagueTeam => ({
  id: "gobbos", name: "Gobbos", race: "Goblin", coach: "Cat", coachId: "Cat", teamValue: 600000, treasury: 0, rerolls: 0, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "4", raceLeague: "",
  players: Array.from({ length: 11 }, (_, i) => pl(i + 1, "Goblin Lineman", { playerId: `p-gob${i + 1}`, careerKey: `c-gob${i + 1}`, name: `Gob ${i + 1}`, value: 40000 })),
  formerPlayers: [],
});
const fx = (id: string, home: [string, number | null], away: [string, number | null]): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: home[0], teamId: home[0].toLowerCase(), coach: "", race: "", score: home[1], cas: 0, conceded: false },
  away: { team: away[0], teamId: away[0].toLowerCase(), coach: "", race: "", score: away[1], cas: 0, conceded: false },
  suspended: false,
});
const season = (number: number, status: "active" | "completed", teams: LeagueTeam[], fixtures: LeagueFixture[] = []): SeasonRecord => ({
  id: `season-${number}`, leagueId: "tabbl", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("redraft rules (editable formula, defaults = the old hardcoded amounts)", () => {
  it("defaults, the old remembered cap, league settings and a ladder-style override layer", () => {
    expect(DEFAULT_REDRAFT_RULES).toMatchObject({ base: null, perGame: 20_000, perWin: 20_000, perDraw: 10_000, perLoss: 0, agentFee: 20_000, capEnabled: true, cap: 1_300_000, liftToBudget: false, windowDays: 7 });
    expect(effectiveRedraftRules({})).toEqual({ ...DEFAULT_REDRAFT_RULES });
    expect(effectiveRedraftRules({ redraftCap: { enabled: false, cap: 900_000 } })).toMatchObject({ capEnabled: false, cap: 900_000 });
    const league = { redraftCap: { enabled: false, cap: 900_000 }, redraftRules: { perWin: 30_000, cap: 1_200_000, capEnabled: true, liftToBudget: true } };
    expect(effectiveRedraftRules(league)).toMatchObject({ perWin: 30_000, cap: 1_200_000, capEnabled: true, liftToBudget: true, perGame: 20_000 });
    // a ladder (later lane) overrides the league default last
    expect(effectiveRedraftRules(league, { perWin: 5_000, windowDays: 3 })).toMatchObject({ perWin: 5_000, windowDays: 3, cap: 1_200_000 });
  });

  it("parse: whole gold in range, booleans, window days, unknown keys refused, base null = roster treasury", () => {
    expect(parseRedraftRules({ perGame: 15_000, perLoss: 5_000, base: null, liftToBudget: true, windowDays: 10 }, { perWin: 1 })).toEqual({ perWin: 1, perGame: 15_000, perLoss: 5_000, base: null, liftToBudget: true, windowDays: 10 });
    expect(() => parseRedraftRules({ perGame: -1 }, undefined)).toThrow(RedraftRulesError);
    expect(() => parseRedraftRules({ perGame: 1.5 }, undefined)).toThrow(/whole number/);
    expect(() => parseRedraftRules({ cap: 9_000_000 }, undefined)).toThrow(/Cap/);
    expect(() => parseRedraftRules({ liftToBudget: "yes" }, undefined)).toThrow(/true or false/);
    expect(() => parseRedraftRules({ windowDays: 0 }, undefined)).toThrow(/1 to 60 days/);
    expect(() => parseRedraftRules({ bonus: 1 }, undefined)).toThrow(/Unknown redraft setting/);
    expect(() => parseRedraftRules([], undefined)).toThrow(/object/);
  });

  it("budget maths use the league's amounts; the agent fee is a setting; spendable = override, else max(earned, lift)", () => {
    const amounts = { perGame: 10_000, perWin: 30_000, perDraw: 5_000, perLoss: 2_000 };
    const b = redraftBudget({ base: 900_000, treasury: 40_000, played: 4, wins: 2, draws: 1, losses: 1 }, { enabled: false, cap: 0 }, amounts);
    expect(b.bonus).toBe(40_000 + 60_000 + 5_000 + 2_000);
    expect(b.raw).toBe(900_000 + 40_000 + 107_000);
    expect(b.amounts).toEqual(amounts);
    expect(redraftBudget({ base: 1_000_000, treasury: 0, played: 1, wins: 0, draws: 0 }, { enabled: true, cap: 1_300_000 }).bonus).toBe(20_000); // defaults
    expect(rehireQuote(pl(1, "Orc Blitzer", { value: 105_000, seasonsPlayed: 2 }), true, datasetRoster("Orc"), 30_000)).toMatchObject({ fee: 90_000, cost: 195_000 });
    const low = { budget: { ...b, capped: 800_000 } };
    expect(spendable(low)).toBe(800_000);
    expect(spendable({ ...low, lift: { to: 1_000_000, by: "Jay", at: "", auto: false } })).toBe(1_000_000);
    expect(spendable({ ...low, lift: { to: 1_000_000, by: "Jay", at: "", auto: false }, override: { budget: 700_000, reason: "x", by: "Jay", at: "" } })).toBe(700_000);
  });
});

describe("redraft mode routes", () => {
  let dir: string;
  let store: LeagueStore;
  let notes: Array<{ coach: string; title: string; body: string; link: string }>;
  let posts: DiscordPayload[];
  let dice: number[];
  let now: Date;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-redraft-mode-"));
    store = new LeagueStore(dir);
    // Jay organises TABBL (a scoped role only); Root is a site admin; Olga is a site-level organiser of another league.
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], redraftRules: { setBudget: 1_000_000 } });
    store.setSecrets("tabbl", { discordWebhookUrl: HOOK });
    store.putSeason(season(6, "completed", [orcs(), goblins()], [fx("f1", ["Orcs", 2], ["Gobbos", 1]), fx("f2", ["Gobbos", 0], ["Orcs", 3])]));
    store.putSeason(season(7, "active", [], [fx("n1", ["Orcs", null], ["Gobbos", null])]));
    notes = [];
    posts = [];
    dice = [];
    now = NOW;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const call = async (method: string, path: string, who: { coach: string; admin?: boolean; organizer?: boolean } | undefined, body?: unknown, over: Partial<LeagueApiDeps> = {}): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path.split("?")[0]!, new URLSearchParams(path.split("?")[1] ?? ""), who ? { coach: who.coach, admin: who.admin ?? false, ...(who.organizer ? { organizer: true } : {}) } : undefined, {
      store,
      readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
      notify: (coach, input) => notes.push({ coach, title: input.title, body: input.body, link: input.link }),
      postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
      rollD6: () => dice.shift() ?? 6,
      now: () => now,
      ...over,
    });
    return r!;
  };
  const JAY = { coach: "Jay" };
  const ANN = { coach: "Ann" };
  const CAT = { coach: "Cat" };
  const OLGA = { coach: "Olga", organizer: true };
  const ROOT = { coach: "Root", admin: true };
  const s6 = () => store.season("tabbl", "season-6")!;
  const task = (id: string) => s6().redraft!.teams.find((t) => t.teamId === id)!;
  const rev = () => s6().redraft?.revision ?? 0;

  async function confirm(extra: Record<string, unknown> = {}): Promise<LeagueApiResult> {
    return call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 0, action: "confirm", capEnabled: true, cap: 1_300_000, teams: [{ teamId: "orcs", selected: true }, { teamId: "gobbos", selected: true }], ...extra });
  }

  it("League settings: the redraft section reads defaults, saves the formula, organisers only; new leagues lift by default", async () => {
    const read = await call("GET", "/api/leagues/tabbl/settings", JAY);
    const rd = (read.body as { settings: { revision: number; redraft: { rules: { liftToBudget: boolean; perGame: number }; set: string[] } } }).settings;
    expect(rd.redraft.rules).toMatchObject({ liftToBudget: false, perGame: 20_000 }); // an existing league keeps today's behaviour
    expect(rd.redraft.set).toEqual(["setBudget"]);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", OLGA, { revision: rd.revision, redraft: { perGame: 1 } })).status).toBe(403);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: rd.revision, redraft: { perGame: -5 } })).status).toBe(400);
    const ok = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: rd.revision, redraft: { perGame: 15_000, perLoss: 5_000, agentFee: 25_000, liftToBudget: true, setBudget: 1_100_000 } });
    expect(ok.status).toBe(200);
    expect(store.league("tabbl")!.redraftRules).toEqual({ setBudget: 1_100_000, perGame: 15_000, perLoss: 5_000, agentFee: 25_000, liftToBudget: true });
    // a league made in the wizard starts with Lift teams to the budget on
    const made = await call("POST", "/api/leagues", { coach: "Nina", organizer: true }, { name: "Fresh League", slug: "fresh-league" });
    expect(made.status).toBe(201);
    expect(effectiveRedraftRules(store.league("fresh-league")!).liftToBudget).toBe(true);
  });

  it("confirm uses the league formula and snapshots it; auto lift on open (logged with actor and time); manual lift per team and for all", async () => {
    store.updateLeague("tabbl", (l) => { l.redraftRules = { perGame: 10_000, perWin: 0, perDraw: 0, agentFee: 30_000, setBudget: 1_100_000, liftToBudget: true }; });
    expect((await confirm()).status).toBe(200);
    const state = s6().redraft!;
    expect(state.rules).toMatchObject({ perGame: 10_000, agentFee: 30_000, setBudget: 1_100_000 });
    // Orcs: 1,000k + 50k + 2 x 10k = 1,070k (below 1,100k); Gobbos: 1,000k + 0 + 2 x 10k = 1,020k
    expect(task("orcs").budget.capped).toBe(1_070_000);
    expect(task("orcs").lift).toEqual({ to: 1_100_000, by: "Jay", at: NOW.toISOString(), auto: true });
    expect(spendable(task("gobbos"))).toBe(1_100_000);
    expect(state.log.filter((l) => l.teamId === "orcs" && /lifted/.test(l.text))).toHaveLength(1);
    // the coach sees the snapshot's agent fee in the re-hire quote
    const v = (await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", ANN)).body as { redraft: { agentFee: number; players: Array<{ playerId: string; fee: number }>; earned: number; setBudget: number; lift: unknown } };
    expect(v.redraft.agentFee).toBe(30_000);
    expect(v.redraft.players.find((p) => p.playerId === "p-orc1")!.fee).toBe(3 * 30_000);
    expect(v.redraft).toMatchObject({ earned: 1_070_000, setBudget: 1_100_000 });
    expect(v.redraft.lift).toBeTruthy();
  });

  it("manual Lift to budget: per team and for all, logged, organisers only (scoped role yes, global-role non-member no)", async () => {
    expect((await confirm()).status).toBe(200); // liftToBudget off: nobody lifted
    store.updateLeague("tabbl", (l) => { l.redraftRules = { setBudget: 1_100_000 }; }); // later settings never change a confirmed redraft
    expect(task("gobbos").lift).toBeUndefined();
    // the confirmed snapshot's set budget is 1,000k: both teams earned more, so nothing to lift
    const none = await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: rev(), action: "lift", all: true });
    expect(none.status).toBe(409);
    // raise the snapshot's set budget the way a fresh redraft would see it
    const s = s6(); s.redraft!.rules = { ...s.redraft!.rules!, setBudget: 1_200_000 }; store.putSeason(s);
    expect((await call("POST", "/api/leagues/tabbl/redraft", OLGA, { revision: rev(), action: "lift", teamId: "gobbos" })).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/redraft", ANN, { revision: rev(), action: "lift", teamId: "gobbos" })).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { action: "lift", teamId: "gobbos" })).status).toBe(428);
    const one = await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: rev(), action: "lift", teamId: "gobbos" });
    expect(one.status).toBe(200);
    expect(task("gobbos").lift).toEqual({ to: 1_200_000, by: "Jay", at: NOW.toISOString(), auto: false });
    expect(notes.at(-1)).toMatchObject({ coach: "Cat", title: "Redraft budget lifted" });
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: rev(), action: "lift", teamId: "gobbos" })).status).toBe(409); // already lifted
    const all = await call("POST", "/api/leagues/tabbl/redraft", ROOT, { revision: rev(), action: "lift", all: true });
    expect(all.status).toBe(200);
    expect(task("orcs").lift).toMatchObject({ to: 1_200_000, by: "Root", auto: false });
    const log = s6().redraft!.log.filter((l) => /lifted/.test(l.text));
    expect(log.map((l) => [l.teamId, l.by])).toEqual([["orcs", "Root"], ["gobbos", "Jay"]]);
    // the board shows earned vs set and the lift
    const board = (await call("GET", "/api/leagues/tabbl/redraft", JAY)).body as { redraft: { active: Array<{ teamId: string; earned: number; setBudget: number; spendable: number; liftApplies: boolean; phase: string }> } };
    expect(board.redraft.active.find((r) => r.teamId === "gobbos")).toMatchObject({ earned: 1_040_000, setBudget: 1_200_000, spendable: 1_200_000, liftApplies: false, phase: "not-started" });
  });

  it("window: opens later (coach waits, job tells them), 24 h reminder, play blocked while open; GETs never run the window", async () => {
    const opensAt = new Date(NOW.getTime() + DAY).toISOString();
    expect((await confirm({ opensAt, windowDays: 3 })).status).toBe(200);
    expect(s6().redraft!.window).toMatchObject({ opensAt, closesAt: new Date(NOW.getTime() + 4 * DAY).toISOString() });
    expect(notes.filter((n) => n.title.startsWith("Redraft:"))).toHaveLength(0); // nobody told yet
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: rev(), mode: "site" })).status).toBe(409);
    expect(redraftPlayBlock(store.seasons("tabbl"), { teamId: "orcs" }, NOW)).toBe(""); // not open yet
    // open: the job tells each coach once
    now = new Date(NOW.getTime() + DAY + 1000);
    // a GET after the open time changes nothing
    const before = JSON.stringify(s6().redraft);
    await call("GET", "/api/leagues/tabbl/redraft", JAY);
    await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", ANN);
    await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/orcs/redraft-budget", ANN);
    expect(JSON.stringify(s6().redraft)).toBe(before);
    const job = (at: Date) => runRedraftWindowJob({ store, notify: (coach, input) => notes.push({ coach, title: input.title, body: input.body, link: input.link }), now: () => at, rollD6: () => 6 });
    expect(job(now).opened).toEqual(["tabbl/season-6"]);
    expect(notes.filter((n) => n.title === "Redraft open").map((n) => n.coach).sort()).toEqual(["Ann", "Cat"]);
    expect(notes.find((n) => n.coach === "Ann")!.link).toBe("/app/tournament-team-builder/redraft/tabbl?team=orcs");
    expect(job(now).opened).toEqual([]); // once
    // play is blocked for both teams while the window is open
    const block = redraftPlayBlock(store.seasons("tabbl"), { teamId: "orcs" }, now);
    expect(block).toMatch(/Orcs is redrafting until .*no games while the redraft window is open/);
    const patch = await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/n1", JAY, { result: { home: 1, away: 0 } }, { now: () => now });
    expect(patch.status).toBe(409);
    expect((patch.body as { error: string }).error).toContain("redrafting");
    expect(store.season("tabbl", "season-7")!.fixtures[0]!.home.score).toBeNull();
    const s7 = store.season("tabbl", "season-7")!;
    const f = s7.fixtures[0]!;
    f.home.coachId = "Ann"; f.away.coachId = "Cat"; store.putSeason(s7);
    expect(leagueFixtureView(store, "league:tabbl:season-7:n1", now)!.open).toBe(false);
    expect(() => recordLeagueFixture(store, "league:tabbl:season-7:n1", { expectedRevision: 0, homeScore: 1, awayScore: 0, homeCasualties: 0, awayCasualties: 0 }, now)).toThrow(/redrafting/);
    const lobby = leagueLobbyFixture(store.league("tabbl")!, store.season("tabbl", "season-7")!, store.season("tabbl", "season-7")!.fixtures[0]!, { coach: "Ann", admin: false }, store, {} as never, now);
    expect(lobby.open).toBe(false);
    expect(lobby.closedReason).toMatch(/redrafting/);
    // the 24 h reminder, once, to coaches still drafting
    const remindAt = new Date(NOW.getTime() + 3 * DAY + 1000);
    expect(job(remindAt).reminded).toEqual(["tabbl/season-6"]);
    expect(notes.filter((n) => n.title === "Redraft closes in 24 hours").map((n) => n.coach).sort()).toEqual(["Ann", "Cat"]);
    expect(job(remindAt).reminded).toEqual([]);
  });

  it("window close: a valid current roster is rebuilt; an invalid one needs a redraft and stays blocked until submitted", async () => {
    expect((await confirm()).status).toBe(200);
    // Gobbos' budget is overridden far too low: their current roster cannot be rebuilt
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: rev(), action: "team", teamId: "gobbos", override: { budget: 100_000, reason: "Owes the league" } })).status).toBe(200);
    const closeAt = new Date(NOW.getTime() + 7 * DAY + 1000);
    const out = runRedraftWindowJob({ store, notify: (coach, input) => notes.push({ coach, title: input.title, body: input.body, link: input.link }), now: () => closeAt, rollD6: () => 6 });
    expect(out.closed).toEqual([{ leagueId: "tabbl", seasonId: "season-6", rebuilt: ["orcs"], needsRedraft: ["gobbos"] }]);
    expect(task("orcs")).toMatchObject({ status: "submitted", auto: true, submittedBy: "League", appliedTo: "season-7" });
    expect(task("orcs").rest!.rolls).toHaveLength(1); // R&R rolled by the site first
    expect(store.season("tabbl", "season-7")!.teams.map((t) => t.id)).toEqual(["orcs"]);
    expect(task("gobbos").status).toBe("pending");
    expect(task("gobbos").needsRedraft!.reason).toMatch(/over the budget/);
    expect(notes.find((n) => n.coach === "Cat" && n.title === "Redraft needed")).toBeTruthy();
    expect(notes.find((n) => n.coach === "Ann" && n.title === "Redraft closed: team rebuilt")).toBeTruthy();
    expect(notes.find((n) => n.coach === "Jay" && n.title === "Redraft window closed")!.link).toBe("/app/leagues/tabbl/settings?tab=redraft");
    // after the close: the rebuilt team may play, the needs-redraft team may not
    expect(redraftPlayBlock(store.seasons("tabbl"), { teamId: "orcs" }, closeAt)).toBe("");
    expect(redraftPlayBlock(store.seasons("tabbl"), { teamId: "gobbos" }, closeAt)).toMatch(/needs to finish its redraft/);
    const board = (await call("GET", "/api/leagues/tabbl/redraft", JAY, undefined, { now: () => closeAt })).body as { redraft: { active: Array<{ teamId: string; phase: string }> } };
    expect(board.redraft.active.find((r) => r.teamId === "gobbos")!.phase).toBe("needs-redraft");
    // processed once
    expect(runRedraftWindowJob({ store, now: () => closeAt }).closed).toEqual([]);
    // the coach fixes it: a cheaper list within the override
    const fixed = await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: rev(), action: "team", teamId: "gobbos", override: { budget: 700_000, reason: "Paid up" } });
    expect(fixed.status).toBe(200);
    const sub = await call("POST", "/api/leagues/tabbl/redraft/teams/gobbos/submit", CAT, {
      revision: rev(), keep: goblins().players.map((p) => p.playerId), hires: [], staff: { rerolls: 0, assistantCoaches: 0, cheerleaders: 0, apothecary: false },
    }, { now: () => closeAt });
    expect(sub.status).toBe(200);
    expect(task("gobbos").needsRedraft).toBeUndefined();
    expect(redraftPlayBlock(store.seasons("tabbl"), { teamId: "gobbos" }, closeAt)).toBe("");
  });

  it("draft leagues stay hidden: the window job tells only organisers, the team budget answers 404 to others", async () => {
    expect((await confirm()).status).toBe(200);
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    const closeAt = new Date(NOW.getTime() + 7 * DAY + 1000);
    runRedraftWindowJob({ store, notify: (coach, input) => notes.push({ coach, title: input.title, body: input.body, link: input.link }), now: () => closeAt, rollD6: () => 6 });
    expect(notes.filter((n) => n.title.startsWith("Redraft") && n.title !== "Redraft: build next season's roster").map((n) => n.coach)).toEqual(["Jay"]);
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/orcs/redraft-budget", undefined)).status).toBe(404);
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/orcs/redraft-budget", ANN)).status).toBe(404);
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/orcs/redraft-budget", JAY)).status).toBe(200);
  });

  it("team summary budget: earned by games / wins / draws vs the set budget for anyone who sees the season; task detail only for its coach and organisers", async () => {
    store.updateLeague("tabbl", (l) => { l.redraftRules = { setBudget: 1_050_000, liftToBudget: true }; });
    type B = { budget: { record: { played: number; wins: number }; budget: { bonus: number }; earned: number; setBudget: number; liftWouldApply: boolean; expected: number; redraft: null | { history: Array<{ text: string }>; spendable: number } } };
    const anon = await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/gobbos/redraft-budget", undefined);
    expect(anon.status).toBe(200);
    const a = (anon.body as B).budget;
    expect(a.record).toMatchObject({ played: 2, wins: 0 });
    expect(a.budget.bonus).toBe(40_000);
    expect(a).toMatchObject({ earned: 1_040_000, setBudget: 1_050_000, liftWouldApply: true, expected: 1_050_000, redraft: null });
    expect((await confirm()).status).toBe(200);
    const other = (await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/gobbos/redraft-budget", ANN)).body as B;
    expect(other.budget.redraft).toBeNull();
    const own = await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/gobbos/redraft-budget", CAT);
    expect(own.headers?.["cache-control"]).toBe("private, no-store");
    expect((own.body as B).budget.redraft!.spendable).toBe(1_050_000);
    expect((own.body as B).budget.redraft!.history[0]!.text).toMatch(/lifted/);
    expect(((await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/gobbos/redraft-budget", JAY)).body as B).budget.redraft).not.toBeNull();
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-6/teams/nobody/redraft-budget", JAY)).status).toBe(404);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/teams/gobbos/redraft-budget", JAY, {})).status).toBe(405);
  });

  it("coach access: only the team's own coach (or an organiser) redrafts it; a global organiser who is not a member is refused", async () => {
    expect((await confirm()).status).toBe(200);
    expect((await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", CAT)).status).toBe(403);
    expect((await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", OLGA)).status).toBe(403);
    expect((await call("GET", "/api/leagues/tabbl/redraft", OLGA)).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", CAT, { revision: rev(), mode: "site" })).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: rev(), mode: "site" })).status).toBe(200);
    expect((await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", JAY)).status).toBe(200);
  });

  it("Discord redraftRolls: off by default; when enabled each rest roll posts its player, roll and outcome", async () => {
    expect((await confirm()).status).toBe(200);
    posts = [];
    dice = [2];
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: rev(), mode: "site" })).status).toBe(200);
    expect(posts).toHaveLength(0);
    // Turn it on and roll another team's niggle (Gobbos get one for the test)
    store.updateLeague("tabbl", (l) => { l.discordEvents = { redraftRolls: true }; });
    const s = s6(); s.teams.find((t) => t.id === "gobbos")!.players[0]!.niggling = 1; store.putSeason(s);
    dice = [5];
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/gobbos/rest", CAT, { revision: rev(), mode: "site" })).status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.embeds[0]!.title).toBe("TABBL: Gobbos Rest & Relaxation");
    expect(posts[0]!.embeds[0]!.description).toBe("Gob 1: rolled 5 (needs 4+), niggling injury healed");
  });

  it("CSRF covers every redraft write (by method); the reads are safe methods", () => {
    for (const p of ["/api/leagues/tabbl/redraft", "/api/leagues/tabbl/redraft/teams/orcs/rest", "/api/leagues/tabbl/redraft/teams/orcs/submit"]) expect(isStateChangingApiRequest("POST", p)).toBe(true);
    expect(isStateChangingApiRequest("PATCH", "/api/leagues/tabbl/settings")).toBe(true);
    for (const p of ["/api/leagues/tabbl/redraft", "/api/leagues/tabbl/redraft/teams/orcs", "/api/leagues/tabbl/seasons/season-6/teams/orcs/redraft-budget"]) expect(isStateChangingApiRequest("GET", p)).toBe(false);
  });
});
