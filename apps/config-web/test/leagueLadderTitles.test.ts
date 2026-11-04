import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { NotificationInput } from "../src/notifications.js";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";
import { ladderRanking, parseLadderSettings, defaultLadderSettings } from "../src/leagues/ladder.js";
import { runLadderJob } from "../src/leagues/ladderJob.js";
import { titleReplay, defaultTitleSettings } from "../src/leagues/ladderTitles.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { requireSession } from "../src/auth/requireSession.js";
import { onboardingGateApplies } from "../src/auth/onboarding.js";
import { DiscordObserver } from "../src/discord/observer.js";
import { DiscordStateStore } from "../src/discord/store.js";
import { TournamentStore } from "../src/tournaments/store.js";
import type { DiscordPayload } from "../src/leagues/discord.js";
import type { TitleBout } from "../src/leagues/ladderTypes.js";

// Ladder titles (spec-league-ladder-2026-11-02 rounds 4-5): the belt and its points, title history and Honours, the eliminator and
// its fallback, the mandatory 21-day rule and the organiser override, voluntary defences and the 30-day vacate, Money in the
// Bank, the interim champion and unification, the Current Champions panel, period and final honours, the Rumble, Discord,
// access control and CSRF. Every test has its own state dir; every transport is a stub.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
const OTTO: LeagueApiIdentity = { coach: "Otto", admin: false, organizer: true };
const coach = (name: string): LeagueApiIdentity => ({ coach: name, admin: false });
const L = "rivertown";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const H = 3_600_000;
const D = 24 * H;

function team(id: string, coachName: string): LeagueTeam {
  return {
    id, name: `${coachName}'s team`, race: "Human", coach: coachName, coachId: coachName, coachAssigned: { by: "Olga", at: "2026-10-01T00:00:00.000Z" },
    teamValue: 1_000_000, treasury: 50_000, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "", raceLeague: "",
    players: Array.from({ length: 11 }, (_, i) => ({
      playerId: `p-${id}-${i}`, number: i + 1, name: `P${i}`, position: "Lineman", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50_000,
      level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false,
      stats: { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 },
    })),
    formerPlayers: [], teamUid: `tm-${id}`, entryId: `en-${id}`,
  };
}

interface Sent { coach: string; input: NotificationInput }

function harness(clock = "2026-11-10T12:00:00.000Z") {
  const root = mkdtempSync(join(tmpdir(), "bbtv-titles-"));
  roots.push(root);
  const store = new LeagueStore(root);
  const time = { now: new Date(clock) };
  const sent: Sent[] = [];
  store.upsertLeague({ id: L, name: "Rivertown", fullName: "Rivertown BBL", slug: L, organisers: ["Olga"], owner: "Olga", playOnFork: false } as never);
  store.upsertLeague({ id: "otherbbl", name: "Other BBL", fullName: "Other BBL", slug: "otherbbl", organisers: ["Otto"], owner: "Otto" } as never);
  const season: SeasonRecord = {
    id: "season-1", leagueId: L, number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", stage: "active",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [team("t-amy", "Amy"), team("t-bob", "Bob")], honours: [], awards: [], unattributedStats: [],
    importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
  };
  store.putSeason(season);
  const deps = (body: unknown): LeagueApiDeps => ({
    store,
    readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))),
    now: () => time.now,
    identities: () => [{ coach: "Olga", level: "organizer" }, { coach: "Otto", level: "organizer" }],
    notify: (c, input) => { sent.push({ coach: c, input }); },
  });
  const call = async (method: string, path: string, auth?: LeagueApiIdentity, body?: unknown): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps(body));
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const ladderOf = (id = "ladder-1") => store.season(L, id)!;
  const job = () => runLadderJob({ store, notify: (c, input) => { sent.push({ coach: c, input }); }, now: () => time.now });
  const openLadder = async (settings: Record<string, unknown> = { titles: { belt: true } }) => {
    const created = await call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "Spring", ranking: "points" });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const p = await call("PATCH", `/api/leagues/${L}/ladders/${id}`, OLGA, { revision: ladderOf(id).revision, settings });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await call("POST", `/api/leagues/${L}/ladders/${id}/start`, OLGA, {})).status).toBe(200);
    return id;
  };
  const seed = (id: string, coaches: string[]) => {
    const lad = ladderOf(id);
    for (const [i, c] of coaches.entries()) {
      const t = team(`t-${c.toLowerCase()}`, c);
      lad.teams.push(t);
      lad.ladder!.members.push({ teamId: t.id, joinedAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 1000).toISOString(), via: "organiser" });
    }
    store.putSeason(lad);
  };
  const tid = (c: string) => `t-${c.toLowerCase()}`;
  /** A plain ladder result (no challenge) between two coaches' teams. */
  const result = (id: string, home: string, away: string, hs: number, as: number, at: string) => {
    const lad = ladderOf(id);
    const t = (c: string) => lad.teams.find((x) => x.coach === c)!;
    const side = (x: LeagueTeam, score: number) => ({ team: x.name, teamId: x.id, coach: x.coach, coachId: x.coachId, race: x.race, score, cas: 0, conceded: false });
    const f: LeagueFixture = { id: `f-${lad.fixtures.length + 1}`, category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(t(home), hs), away: side(t(away), as), suspended: false, finishedAt: at };
    lad.fixtures.push(f);
    store.putSeason(lad);
    return f;
  };
  /** Plays a fixture already on the ladder (a title game, a Rumble game). */
  const play = (id: string, fixtureId: string, hs: number, as: number, at?: string) => {
    if (!at) { time.now = new Date(time.now.getTime() + 60_000); at = time.now.toISOString(); }
    const lad = ladderOf(id);
    const f = lad.fixtures.find((x) => x.id === fixtureId)!;
    f.home.score = hs; f.away.score = as; f.finishedAt = at;
    store.putSeason(lad);
    return f;
  };
  const bouts = (id: string) => ladderOf(id).ladder!.titles?.bouts ?? [];
  const live = (id: string, kind?: TitleBout["kind"]) => bouts(id).filter((b) => b.state === "scheduled" && (!kind || b.kind === kind));
  const advance = (ms: number) => { time.now = new Date(time.now.getTime() + ms); };
  const view = async (id: string, who?: LeagueApiIdentity) => (await call("GET", `/api/leagues/${L}/ladders/${id}`, who)).body as {
    ranking: Array<{ teamId: string; points: number; bonus: number; rank: number }>;
    titles: { enabled: boolean; champion: { teamId: string; defences: number; days: number; inactiveSince?: string } | null; interim: { teamId: string } | null; history: Array<{ teamId: string; defences: number; how: string; ended?: string; days: number }>; mandatory: { stage: string; bout?: { home: { teamId: string }; away: { teamId: string } } }; contracts: Array<{ id: string; teamId: string; state: string; mine?: boolean }>; rumbles: Array<{ id: string; state: string; seeds: Array<{ teamId: string }>; rounds: Array<{ matches: Array<{ fixtureId?: string; winnerTeamId?: string; how?: string }> }>; winner?: { teamId: string } }> };
  };
  /** A belt ladder with Amy, Bob, Cara, Dan, Eve, Finn, Gus; Amy crowned by winning the vacant title game against Cara. */
  const crowned = async (extra: Record<string, unknown> = {}) => {
    const id = await openLadder({ titles: { belt: true, ...extra } });
    seed(id, ["Amy", "Bob", "Cara", "Dan", "Eve", "Finn", "Gus"]);
    result(id, "Amy", "Bob", 3, 0, "2026-11-05T10:00:00.000Z");
    result(id, "Cara", "Dan", 2, 0, "2026-11-05T11:00:00.000Z");
    result(id, "Eve", "Finn", 1, 0, "2026-11-05T12:00:00.000Z");
    job();
    const vacant = live(id, "vacant")[0]!;
    expect(vacant).toMatchObject({ homeTeamId: tid("Amy"), awayTeamId: tid("Cara") });
    play(id, vacant.fixtureId, 1, 0);
    job();
    return id;
  };
  return { store, time, sent, call, ladderOf, job, openLadder, seed, tid, result, play, bouts, live, advance, view, crowned, root };
}

const pts = (rows: Array<{ teamId: string; points: number }>, id: string) => rows.find((r) => r.teamId === id)?.points;

// ---------------------------------------------------------------------------------------------------------------------------

describe("the belt: settings, points and bonuses", () => {
  it("is off by default; switching it on makes the ladder rank by points (refused alongside another method); settings parse", () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    expect(defaultLadderSettings().titles).toEqual(defaultTitleSettings());
    expect(defaultTitleSettings()).toMatchObject({ belt: false, bonuses: { defence: 2, weekHeld: 1, winBelt: 3 }, mandatoryDays: 21, defenceRange: 5, inactivityDays: 30, mitb: { enabled: false, streak: 5, cashInDays: 90, playHours: 72 } });
    const on = parseLadderSettings({ titles: { belt: true } }, defaultLadderSettings("position"), now);
    expect(on.ranking).toBe("points");
    expect(on.declineRule.enabled).toBe(false);
    expect(on.challengeRange).toBeNull();
    expect(() => parseLadderSettings({ ranking: "rating", titles: { belt: true } }, defaultLadderSettings("points"), now)).toThrow(/ranks by points/);
    expect(() => parseLadderSettings({ titles: { bogus: 1 } }, defaultLadderSettings(), now)).toThrow();
    expect(() => parseLadderSettings({ titles: { bonuses: { defence: 99 } } }, defaultLadderSettings(), now)).toThrow();
    expect(parseLadderSettings({ titles: { bonuses: { defence: 4 }, mitb: { enabled: true, streak: 3 } } }, defaultLadderSettings(), now).titles).toMatchObject({ bonuses: { defence: 4, weekHeld: 1 }, mitb: { enabled: true, streak: 3, cashInDays: 90 } });
  });

  it("a vacant belt is played for by the top two; winning it is +3; each successful defence +2; each full week held +1", async () => {
    const h = harness();
    const id = await h.crowned();
    let v = await h.view(id);
    expect(v.titles.champion).toMatchObject({ teamId: h.tid("Amy"), defences: 0 });
    expect(v.ranking.find((r) => r.teamId === h.tid("Amy"))).toMatchObject({ points: 3 + 3 + 3, bonus: 3 });
    // A voluntary defence: Gus (4th, in the top 5) challenges, Amy accepts; the fixture is a title defence.
    const ch = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Gus"), { challengerTeamId: h.tid("Gus"), defenderTeamId: h.tid("Amy") });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    const cid = (ch.body as { challenge: { id: string } }).challenge.id;
    const acc = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges/${cid}/accept`, coach("Amy"), {});
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const fid = (acc.body as { fixture: { id: string } }).fixture.id;
    expect(h.ladderOf(id).fixtures.find((f) => f.id === fid)!.ladder).toMatchObject({ title: "defence" });
    h.play(id, fid, 2, 1);
    v = await h.view(id);
    expect(v.titles.champion).toMatchObject({ teamId: h.tid("Amy"), defences: 1 });
    expect(pts(v.ranking, h.tid("Amy"))).toBe(3 + 3 + 3 + 3 + 2);
    // Two full weeks held: +2.
    h.advance(14 * D + H);
    v = await h.view(id);
    expect(v.ranking.find((r) => r.teamId === h.tid("Amy"))!.bonus).toBe(3 + 2 + 2);
    // A draw keeps the belt but isn't a defence; a loss passes it on (+3 to the winner).
    const ch2 = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Eve"), { challengerTeamId: h.tid("Eve"), defenderTeamId: h.tid("Amy") });
    const cid2 = (ch2.body as { challenge: { id: string } }).challenge.id;
    const fid2 = ((await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges/${cid2}/accept`, coach("Amy"), {})).body as { fixture: { id: string } }).fixture.id;
    h.play(id, fid2, 0, 1);
    v = await h.view(id);
    expect(v.titles.champion).toMatchObject({ teamId: h.tid("Eve"), defences: 0 });
    expect(v.ranking.find((r) => r.teamId === h.tid("Eve"))!.bonus).toBe(3);
  });

  it("title history lists every reign with its length and defences; finished reigns go into league Honours", async () => {
    const h = harness();
    const id = await h.crowned();
    h.advance(10 * D);
    // Cara takes the belt in a mandatory... via a defence challenge.
    const ch = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Cara"), { challengerTeamId: h.tid("Cara"), defenderTeamId: h.tid("Amy") });
    const cid = (ch.body as { challenge: { id: string } }).challenge.id;
    const fid = ((await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges/${cid}/accept`, coach("Amy"), {})).body as { fixture: { id: string } }).fixture.id;
    h.play(id, fid, 0, 2);
    h.job();
    const v = await h.view(id);
    expect(v.titles.history.map((r) => r.teamId)).toEqual([h.tid("Cara"), h.tid("Amy")]);
    expect(v.titles.history[1]).toMatchObject({ days: 10, defences: 0, ended: expect.stringContaining("Lost to Cara") });
    const honours = (await h.call("GET", `/api/leagues/${L}/honours`)).body as { awards: Array<{ title: string; toTeam?: string; note: string; seasonName?: string }>; hallOfFame: unknown[] };
    const reign = honours.awards.find((a) => a.title === "Spring belt holder");
    expect(reign).toMatchObject({ toTeam: "Amy's team", seasonName: "Spring" });
    expect(reign!.note).toContain("Held 10 days, 0 defences");
    expect(honours.hallOfFame).toEqual([]); // a ladder is never a season card
    // The coach's own awards page sees it too.
    expect(h.sent.some((s) => s.coach === "Cara" && s.input.title.includes("is the champion"))).toBe(true);
    expect(h.sent.some((s) => s.coach === "Amy" && s.input.title.includes("you lost the belt"))).toBe(true);
  });
});

describe("the mandatory challenger", () => {
  it("when the spot opens #2 v #3 play an eliminator (straight into scheduling); the winner is the mandatory challenger with 21 days", async () => {
    const h = harness();
    const id = await h.crowned();
    const elim = h.live(id, "eliminator")[0]!;
    // Amy is champion (#1); the contenders are Eve and Cara (#2 and #3 by points; Eve has played fewer games).
    expect([elim.homeTeamId, elim.awayTeamId]).toEqual([h.tid("Eve"), h.tid("Cara")]);
    expect(h.ladderOf(id).fixtures.find((f) => f.id === elim.fixtureId)!.ladder).toMatchObject({ title: "eliminator", boutId: elim.id });
    expect(h.sent.some((s) => s.coach === "Eve" && s.input.title.startsWith("Eliminator") && String(s.input.link).includes("propose="))).toBe(true);
    let v = await h.view(id);
    expect(v.titles.mandatory.stage).toBe("eliminator");
    h.play(id, elim.fixtureId, 0, 1);
    h.job();
    const mand = h.live(id, "mandatory")[0]!;
    expect(mand).toMatchObject({ homeTeamId: h.tid("Amy"), awayTeamId: h.tid("Cara") });
    expect(Date.parse(mand.deadline) - h.time.now.getTime()).toBe(21 * D);
    v = await h.view(id);
    expect(v.titles.mandatory).toMatchObject({ stage: "mandatory", bout: { away: { teamId: h.tid("Cara") } } });
    // The mandatory is played (the champion wins): a defence, and the spot opens again (a new eliminator).
    h.play(id, mand.fixtureId, 2, 0);
    h.job();
    expect(titleReplay(h.ladderOf(id), h.time.now).holder).toMatchObject({ teamId: h.tid("Amy"), defences: 1 });
    expect(h.live(id, "eliminator")).toHaveLength(1);
  });

  it("an eliminator not played in its window goes to the higher-ranked of the two", async () => {
    const h = harness();
    const id = await h.crowned();
    const elim = h.live(id, "eliminator")[0]!;
    h.advance(7 * D + 60_000);
    h.job();
    const after = h.bouts(id).find((b) => b.id === elim.id)!;
    expect(after).toMatchObject({ state: "lapsed", winnerTeamId: elim.homeTeamId, how: "fallback" });
    expect(h.ladderOf(id).fixtures.find((f) => f.id === elim.fixtureId)!.deadlineOutcome?.outcome).toBe("no-result");
    expect(h.live(id, "mandatory")[0]).toMatchObject({ awayTeamId: elim.homeTeamId });
  });

  it("a mandatory not played in 21 days passes the title to the challenger, unless the organiser extends or cancels it", async () => {
    const h = harness();
    const id = await h.crowned();
    h.play(id, h.live(id, "eliminator")[0]!.fixtureId, 1, 0); // Eve wins the eliminator
    h.job();
    const mand = h.live(id, "mandatory")[0]!;
    // Organiser override: more time. Others can't.
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/bouts/${mand.id}/extend`, coach("Amy"), { days: 7 })).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/bouts/${mand.id}/extend`, OLGA, { days: 0 })).status).toBe(400);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/bouts/${mand.id}/extend`, OLGA, { days: 7 })).status).toBe(200);
    h.advance(21 * D + H);
    h.job();
    expect(titleReplay(h.ladderOf(id), h.time.now).holder?.teamId).toBe(h.tid("Amy"));
    h.advance(7 * D);
    h.job();
    const state = titleReplay(h.ladderOf(id), h.time.now);
    expect(state.holder).toMatchObject({ teamId: h.tid("Eve"), won: false });
    expect(state.reigns.at(-2)!.ended).toContain("mandatory");
    expect(h.bouts(id).find((b) => b.id === mand.id)).toMatchObject({ state: "lapsed", how: "fallback", winnerTeamId: h.tid("Eve") });
    // No +3 for a title that passed without a game.
    expect(ladderRanking(h.ladderOf(id), h.time.now).find((r) => r.teamId === h.tid("Eve"))!.bonus).toBe(0);
    // Cancelling a mandatory: the spot reopens (the next pass sets a new eliminator).
    const next = h.live(id, "eliminator")[0]!;
    h.play(id, next.fixtureId, 1, 0);
    h.job();
    const m2 = h.live(id, "mandatory")[0]!;
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/bouts/${m2.id}/cancel`, OLGA, {})).status).toBe(200);
    expect(h.bouts(id).find((b) => b.id === m2.id)!.state).toBe("cancelled");
    expect(h.live(id, "eliminator")).toHaveLength(1);
  });
});

describe("voluntary defences", () => {
  it("only the top 5 may challenge the champion; no defence for 30 days sends a reminder, 7 days later the title is vacated", async () => {
    const h = harness();
    const id = await h.crowned({ eliminatorDays: 60, mandatoryDays: 90 });
    // Bob is 7th: refused.
    const v = await h.view(id, coach("Bob"));
    expect(v.ranking.find((r) => r.teamId === h.tid("Bob"))!.rank).toBeGreaterThan(5);
    const refused = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Bob"), { challengerTeamId: h.tid("Bob"), defenderTeamId: h.tid("Amy") });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("top 5");
    // The eliminator (60-day window) is live, but it is not a defence: only inactivity is in play.
    expect(h.live(id).map((b) => b.kind)).toEqual(["eliminator"]);
    h.advance(30 * D + H);
    h.sent.length = 0;
    h.job();
    const remind = h.sent.filter((s) => s.coach === "Amy" && s.input.title.includes("defend your title"));
    expect(remind).toHaveLength(1);
    h.job();
    expect(h.sent.filter((s) => s.coach === "Amy" && s.input.title.includes("defend your title"))).toHaveLength(1); // once
    h.advance(7 * D);
    h.job();
    const state = titleReplay(h.ladderOf(id), h.time.now);
    expect(state.holder?.teamId).not.toBe(h.tid("Amy"));
    expect(state.reigns.find((r) => r.teamId === h.tid("Amy"))!.ended).toContain("no defence for 37 days");
    expect(h.sent.some((s) => s.coach === "Amy" && s.input.title.includes("your title was vacated"))).toBe(true);
  });
});

describe("Money in the Bank", () => {
  it("a win streak earns a contract; the coach cashes in (the champion can't decline, 72 h); winning gives the belt +3 and the MITB +3", async () => {
    const h = harness();
    const id = await h.crowned({ mitb: { enabled: true, streak: 3 } });
    const l = h.ladderOf(id);
    l.ladder!.titles!.mitbOnAt = "2026-11-01T00:00:00.000Z";
    h.store.putSeason(l);
    // Bob wins three in a row (from the MITB switch-on).
    h.result(id, "Bob", "Dan", 1, 0, "2026-11-10T13:00:00.000Z");
    h.result(id, "Bob", "Finn", 1, 0, "2026-11-10T14:00:00.000Z");
    h.result(id, "Bob", "Gus", 1, 0, "2026-11-10T15:00:00.000Z");
    h.advance(4 * H);
    h.job();
    const contracts = h.ladderOf(id).ladder!.titles!.contracts;
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({ teamId: h.tid("Bob"), source: "streak" });
    h.job();
    expect(h.ladderOf(id).ladder!.titles!.contracts).toHaveLength(1); // never twice from one streak
    expect((await h.view(id, coach("Bob"))).titles.contracts[0]).toMatchObject({ state: "held", mine: true });
    // Only the contract's coach cashes in.
    const cid = contracts[0]!.id;
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${cid}/cash-in`, coach("Dan"), {})).status).toBe(403);
    const cash = await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${cid}/cash-in`, coach("Bob"), {});
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${cid}/cash-in`, coach("Bob"), {})).status).toBe(409);
    const bout = h.live(id, "cashin")[0]!;
    expect(bout).toMatchObject({ homeTeamId: h.tid("Amy"), awayTeamId: h.tid("Bob") });
    expect(Date.parse(bout.deadline) - h.time.now.getTime()).toBe(72 * H);
    expect(h.sent.some((s) => s.coach === "Amy" && s.input.body.includes("can't decline"))).toBe(true);
    const bonusBefore = ladderRanking(h.ladderOf(id), h.time.now).find((r) => r.teamId === h.tid("Bob"))!.bonus;
    h.play(id, bout.fixtureId, 0, 1);
    h.job();
    expect(titleReplay(h.ladderOf(id), h.time.now).holder?.teamId).toBe(h.tid("Bob"));
    expect(ladderRanking(h.ladderOf(id), h.time.now).find((r) => r.teamId === h.tid("Bob"))!.bonus - bonusBefore).toBe(3 + 3);
  });

  it("an organiser can award a contract; a cash-in not played in 72 h is discarded and the contract stays usable until it expires", async () => {
    const h = harness();
    const id = await h.crowned({ mitb: { enabled: true } });
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts`, coach("Bob"), { teamId: h.tid("Bob") })).status).toBe(403);
    const award = await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts`, OLGA, { teamId: h.tid("Dan"), note: "League night" });
    expect(award.status, JSON.stringify(award.body)).toBe(200);
    const c = h.ladderOf(id).ladder!.titles!.contracts[0]!;
    expect(c).toMatchObject({ source: "organiser", teamId: h.tid("Dan") });
    expect(Date.parse(c.expiresAt) - h.time.now.getTime()).toBe(90 * D);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${c.id}/cash-in`, coach("Dan"), {})).status).toBe(200);
    h.advance(72 * H + 60_000);
    h.job();
    const after = h.ladderOf(id).ladder!.titles!;
    expect(after.bouts.find((b) => b.kind === "cashin")!.state).toBe("lapsed");
    expect(after.contracts[0]!.usedAt).toBeUndefined();
    expect((await h.view(id, coach("Dan"))).titles.contracts[0]!.state).toBe("held");
    h.advance(90 * D);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${c.id}/cash-in`, coach("Dan"), {})).status).toBe(409);
  });

  it("switched off by default: no streak contracts and no organiser contracts", async () => {
    const h = harness();
    const id = await h.crowned();
    h.result(id, "Bob", "Dan", 1, 0, "2026-11-10T13:00:00.000Z");
    for (let i = 0; i < 5; i += 1) h.result(id, "Bob", "Gus", 1, 0, `2026-11-10T1${4 + i}:00:00.000Z`);
    h.advance(12 * H);
    h.job();
    expect(h.ladderOf(id).ladder!.titles!.contracts).toHaveLength(0);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts`, OLGA, { teamId: h.tid("Dan") })).status).toBe(409);
  });
});

describe("interim champion", () => {
  it("the organiser marks the champion inactive: the top two contenders play for the interim belt; on return a unification game is set", async () => {
    const h = harness();
    const id = await h.crowned();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/titles/inactive`, coach("Bob"), {})).status).toBe(403);
    const r = await h.call("POST", `/api/leagues/${L}/ladders/${id}/titles/inactive`, OLGA, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // In the same write: the eliminator is called off and the interim game is set.
    expect(h.live(id, "eliminator")).toHaveLength(0);
    const interim = h.live(id, "interim")[0]!;
    expect([interim.homeTeamId, interim.awayTeamId]).toEqual([h.tid("Eve"), h.tid("Cara")]);
    // The inactive champion can't be challenged.
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Bob"), { challengerTeamId: h.tid("Bob"), defenderTeamId: h.tid("Amy") })).status).toBe(409);
    h.play(id, interim.fixtureId, 2, 0);
    h.job();
    let v = await h.view(id);
    expect(v.titles.interim?.teamId).toBe(h.tid("Eve"));
    expect(v.titles.champion?.inactiveSince).toBeTruthy();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/titles/return`, OLGA, {})).status).toBe(200);
    const uni = h.live(id, "unification")[0]!;
    expect(uni).toMatchObject({ homeTeamId: h.tid("Amy"), awayTeamId: h.tid("Eve") });
    h.play(id, uni.fixtureId, 1, 2);
    h.job();
    v = await h.view(id);
    expect(v.titles.champion?.teamId).toBe(h.tid("Eve"));
    expect(v.titles.interim).toBeNull();
    expect(v.titles.history[0]!.how).toContain("Unified");
  });
});

describe("the Current Champions panel", () => {
  it("cups = the latest finished season champion (and division winners), belts = current holders with days and defences; empty parts hidden", async () => {
    const h = harness();
    const get = async () => (await h.call("GET", `/api/leagues/${L}/champions`)).body as { cups: Array<{ label: string; team: string; seasonName: string }>; belts: Array<{ ladderName: string; team: string; days: number; defences: number }> };
    expect(await get()).toEqual({ cups: [], belts: [] });
    // A finished season with a podium.
    const s = h.store.season(L, "season-1")!;
    s.status = "completed";
    s.awards = [{ category: "", type: "Overall Champion", name: "", description: "", coach: "Amy", team: "Amy's team", race: "Human", goldenStar: true, podium: true }];
    h.store.putSeason(s);
    expect((await get()).cups).toEqual([expect.objectContaining({ label: "Champion", team: "Amy's team", seasonName: "Season 1" })]);
    expect((await get()).belts).toEqual([]);
    const id = await h.crowned();
    h.advance(3 * D);
    const belts = (await get()).belts;
    expect(belts).toEqual([expect.objectContaining({ ladderName: "Spring", team: "Amy's team", days: 3, defences: 0 })]);
    void id;
    // A ladder without a belt shows nothing.
    const h2 = harness();
    await h2.openLadder({ titles: { belt: false } });
    expect(((await h2.call("GET", `/api/leagues/${L}/champions`)).body as { belts: unknown[] }).belts).toEqual([]);
  });

  it("division winners of the latest finished season are cups too", async () => {
    const h = harness();
    const s = h.store.season(L, "season-1")!;
    s.status = "completed";
    s.phases = [{ id: "season-regular", category: "Season", name: "Regular", groups: ["North", "South"], standings: [] }];
    s.teams.push(team("t-cara", "Cara"), team("t-dan", "Dan"));
    const side = (x: LeagueTeam, score: number) => ({ team: x.name, teamId: x.id, coach: x.coach, coachId: x.coachId, race: x.race, score, cas: 0, conceded: false });
    const t = (id: string) => s.teams.find((x) => x.id === id)!;
    s.fixtures = [
      { id: "s1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "North", round: 1, table: 1, home: side(t("t-amy"), 2), away: side(t("t-bob"), 0), suspended: false },
      { id: "s2", category: "Season", phase: "Regular", phaseId: "season-regular", group: "South", round: 1, table: 2, home: side(t("t-cara"), 0), away: side(t("t-dan"), 1), suspended: false },
    ];
    h.store.putSeason(s);
    const cups = ((await h.call("GET", `/api/leagues/${L}/champions`)).body as { cups: Array<{ label: string; team: string }> }).cups;
    expect(cups).toEqual([expect.objectContaining({ label: "North winner", team: "Amy's team" }), expect.objectContaining({ label: "South winner", team: "Dan's team" })]);
  });
});

describe("period and scheduled-end honours", () => {
  it("each period end puts the top 3 into Honours once; closing freezes the final top 3 and the belt holder at close", async () => {
    const h = harness();
    const id = await h.openLadder({ titles: { belt: true }, periodDays: 7, redraft: { trigger: "schedule" } });
    h.seed(id, ["Amy", "Bob", "Cara", "Dan"]);
    h.result(id, "Amy", "Bob", 2, 0, "2026-11-11T10:00:00.000Z");
    h.result(id, "Cara", "Dan", 1, 0, "2026-11-11T11:00:00.000Z");
    h.result(id, "Bob", "Dan", 1, 0, "2026-11-11T12:00:00.000Z");
    h.advance(7 * D + H);
    h.job();
    h.job();
    const awards = h.ladderOf(id).awards;
    expect(awards.map((a) => a.type)).toEqual(["Spring champion, Period 1", "Spring runner-up, Period 1", "Spring third place, Period 1"]);
    expect(awards[0]).toMatchObject({ team: "Amy's team", coachId: "Amy", key: "period:1:1" });
    expect(h.ladderOf(id).ladder!.periodHonours).toEqual([1]);
    const honours = (await h.call("GET", `/api/leagues/${L}/honours`)).body as { awards: Array<{ title: string }> };
    expect(honours.awards.map((a) => a.title)).toContain("Spring champion, Period 1");
    // The coach's awards (coach page) include it.
    // The vacant title game is played; then close: the final top 3 and the belt holder at close.
    h.play(id, h.live(id, "vacant")[0]!.fixtureId, 1, 0);
    h.job();
    const holder = titleReplay(h.ladderOf(id), h.time.now).holder;
    expect(holder).toBeTruthy();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/close`, OLGA, {})).status).toBe(200);
    const final = h.ladderOf(id).awards.filter((a) => a.key?.startsWith("final"));
    expect(final.map((a) => a.type)).toEqual(["Spring champion", "Spring runner-up", "Spring third place", "Spring belt holder at close"]);
    expect(final.at(-1)!.team).toBe(h.ladderOf(id).teams.find((t) => t.id === holder!.teamId)!.name);
    // Live title games were called off with the close.
    expect(h.live(id)).toHaveLength(0);
  });

  it("the scheduled end writes the same final honours", async () => {
    const h = harness();
    const id = await h.openLadder({ titles: { belt: false }, endsAt: "2026-11-20T00:00:00.000Z" });
    h.seed(id, ["Amy", "Bob"]);
    h.result(id, "Amy", "Bob", 1, 0, "2026-11-11T10:00:00.000Z");
    h.time.now = new Date("2026-11-20T00:01:00.000Z");
    h.job();
    expect(h.ladderOf(id).awards.map((a) => a.type)).toEqual(["Spring champion", "Spring runner-up"]);
  });
});

describe("the Rumble", () => {
  it("top 8 on the date: a knockout drawn by the tournament engine; rounds advance; the winner gets a title shot and 5 points", async () => {
    const h = harness();
    const id = await h.crowned();
    h.seed(id, ["Hal", "Ivy", "Jon"]);
    const date = new Date(h.time.now.getTime() + D).toISOString();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, coach("Amy"), { date, field: "top8" })).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "all" })).status).toBe(400);
    const made = await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "top8", roundDays: 2 });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "top8" })).status).toBe(409);
    h.job();
    expect(h.ladderOf(id).ladder!.rumbles![0]!.state).toBe("entry");
    h.advance(D + 60_000);
    h.job();
    let ru = (await h.view(id)).titles.rumbles[0]!;
    expect(ru.state).toBe("running");
    const ranking = ladderRanking(h.ladderOf(id), h.time.now);
    expect(ru.seeds.map((s) => s.teamId)).toEqual(ranking.slice(0, 8).map((r) => r.teamId));
    // Seeds 1v8, 4v5, 2v7, 3v6 (the engine's bracket order).
    const r1 = h.ladderOf(id).ladder!.rumbles![0]!.rounds[0]!.matches;
    expect(r1).toHaveLength(4);
    const seeds = ru.seeds.map((s) => s.teamId);
    expect([r1[0]!.homeTeamId, r1[0]!.awayTeamId]).toEqual([seeds[0], seeds[7]]);
    for (const m of r1) expect(h.ladderOf(id).fixtures.find((f) => f.id === m.fixtureId)!.ladder).toMatchObject({ title: "rumble" });
    // Round 1: three results, one unplayed (the better seed goes through at the deadline).
    h.play(id, r1[0]!.fixtureId!, 0, 1); // seed 8 upsets seed 1
    h.play(id, r1[1]!.fixtureId!, 1, 1); // a draw: the better seed
    h.play(id, r1[2]!.fixtureId!, 2, 0);
    h.job();
    expect(h.ladderOf(id).ladder!.rumbles![0]!.rounds).toHaveLength(1);
    h.advance(2 * D + 60_000);
    h.job();
    ru = (await h.view(id)).titles.rumbles[0]!;
    expect(ru.rounds[0]!.matches.map((m) => m.how)).toEqual(["result", "result", "result", "fallback"]);
    expect(ru.rounds).toHaveLength(2);
    const r2 = h.ladderOf(id).ladder!.rumbles![0]!.rounds[1]!.matches;
    expect(r2[0]!.homeTeamId).toBe(seeds[7]);
    for (const m of r2) h.play(id, m.fixtureId!, 1, 0);
    h.job();
    const final = h.ladderOf(id).ladder!.rumbles![0]!.rounds[2]!.matches[0]!;
    h.play(id, final.fixtureId!, 3, 1);
    h.job();
    const done = h.ladderOf(id).ladder!.rumbles![0]!;
    expect(done.state).toBe("finished");
    expect(done.winnerTeamId).toBe(final.homeTeamId);
    const contract = h.ladderOf(id).ladder!.titles!.contracts.find((c) => c.source === "rumble")!;
    expect(contract.teamId).toBe(final.homeTeamId);
    const row = ladderRanking(h.ladderOf(id), h.time.now).find((r) => r.teamId === final.homeTeamId)!;
    expect(row.bonus).toBeGreaterThanOrEqual(5);
    expect(h.sent.some((s) => s.input.title.includes("you won The Rumble"))).toBe(true);
  });

  it("open entry: coaches enter and withdraw before the date; fewer than two calls it off", async () => {
    const h = harness();
    const id = await h.crowned();
    const date = new Date(h.time.now.getTime() + D).toISOString();
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "open" });
    const rid = h.ladderOf(id).ladder!.rumbles![0]!.id;
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach("Bob"), { teamId: h.tid("Amy") })).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach("Bob"), { teamId: h.tid("Bob") })).status).toBe(200);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach("Bob"), { teamId: h.tid("Bob") })).status).toBe(409);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach("Dan"), { teamId: h.tid("Dan") })).status).toBe(200);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/withdraw`, coach("Dan"), { teamId: h.tid("Dan") })).status).toBe(200);
    h.advance(D + 60_000);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach("Dan"), { teamId: h.tid("Dan") })).status).toBe(409);
    h.job();
    expect(h.ladderOf(id).ladder!.rumbles![0]).toMatchObject({ state: "cancelled" });
  });
});

describe("Discord", () => {
  it("belt won, defended, eliminator, mandatory, cash-in and Rumble events post once each through the cleaned sender", async () => {
    const h = harness();
    h.store.setSecrets(L, { discordWebhookUrl: HOOK });
    const posts: Array<{ url: string; payload: DiscordPayload }> = [];
    const tstore = new TournamentStore(join(h.root, "tournaments"));
    const state = new DiscordStateStore(join(h.root, "discord"));
    const observer = () => new DiscordObserver({ leagues: h.store, tournaments: tstore, state, poster: async (url, payload) => { posts.push({ url, payload }); return { ok: true, status: 204 }; }, now: () => h.time.now });
    const id = await h.openLadder({ titles: { belt: true, mitb: { enabled: true } } });
    h.seed(id, ["Amy", "Bob", "Cara", "Dan"]);
    await observer().tick(); // first sight baselines
    h.result(id, "Amy", "Bob", 3, 0, "2026-11-05T10:00:00.000Z");
    h.result(id, "Cara", "Dan", 2, 0, "2026-11-05T11:00:00.000Z");
    h.job();
    h.play(id, h.live(id, "vacant")[0]!.fixtureId, 1, 0);
    h.job();
    posts.length = 0;
    await observer().tick();
    const text = () => posts.map((p) => `${p.payload.embeds[0]!.title}\n${p.payload.embeds[0]!.description}`).join("|");
    expect(text()).toContain("new champion");
    expect(text()).toContain("Eliminator");
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts`, OLGA, { teamId: h.tid("Dan") });
    const c = h.ladderOf(id).ladder!.titles!.contracts[0]!;
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${c.id}/cash-in`, coach("Dan"), {});
    posts.length = 0;
    await observer().tick();
    expect(text()).toContain("Dan is cashing in!");
    h.play(id, h.live(id, "cashin")[0]!.fixtureId, 2, 0);
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date: new Date(h.time.now.getTime() + D).toISOString(), field: "top8" });
    posts.length = 0;
    await observer().tick();
    expect(text()).toContain("belt defended");
    expect(text()).toContain("Rumble");
    expect(posts.every((p) => p.url === HOOK && p.payload.allowed_mentions.parse.length === 0)).toBe(true);
    posts.length = 0;
    await observer().tick();
    expect(posts).toHaveLength(0);
    // The Weekly Digest's ladder section names the champion.
    const { ladderDigestFields } = await import("../src/discord/ladderPosts.js");
    const fields = ladderDigestFields([h.ladderOf(id)], 0, h.time.now.getTime() + 1, h.time.now);
    expect(fields[0]!.value).toMatch(/^Champion: Amy's team \(0 days, 1 defence\)/);
  });
});

describe("access control, CSRF and GETs", () => {
  it("title writes are CSRF-gated state changes for organisers (or the contract's / team's coach); GETs are public and never write", async () => {
    for (const p of [`/api/leagues/${L}/ladders/ladder-1/titles/vacate`, `/api/leagues/${L}/ladders/ladder-1/bouts/tb-1/extend`, `/api/leagues/${L}/ladders/ladder-1/contracts`, `/api/leagues/${L}/ladders/ladder-1/contracts/tc-1/cash-in`, `/api/leagues/${L}/ladders/ladder-1/rumbles`, `/api/leagues/${L}/ladders/ladder-1/rumbles/ru-1/enter`]) {
      expect(isStateChangingApiRequest("POST", p)).toBe(true);
      expect(onboardingGateApplies("POST", p)).toBe(true);
    }
    const get = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "GET" } as unknown as IncomingMessage;
    expect(requireSession(get, `/api/leagues/${L}/champions`, "").kind).toBe("allow");
    const post = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "POST" } as unknown as IncomingMessage;
    expect(requireSession(post, `/api/leagues/${L}/ladders/ladder-1/titles/vacate`, "").kind).not.toBe("allow");
    const h = harness();
    const id = await h.crowned();
    const base = `/api/leagues/${L}/ladders/${id}`;
    for (const verb of ["vacate", "crown", "inactive", "return"]) {
      expect((await h.call("POST", `${base}/titles/${verb}`, undefined, {})).status).toBe(401);
      expect((await h.call("POST", `${base}/titles/${verb}`, coach("Amy"), {})).status).toBe(403);
      expect((await h.call("POST", `${base}/titles/${verb}`, OTTO, {})).status).toBe(403);
    }
    expect((await h.call("GET", `${base}/titles/vacate`, OLGA)).status).toBe(405);
    expect((await h.call("POST", `${base}/titles/bogus`, OLGA, {})).status).toBe(404);
    expect((await h.call("POST", `${base}/rumbles/ru-x/enter`, undefined, {})).status).toBe(401);
    // Organiser crown and vacate.
    expect((await h.call("POST", `${base}/titles/crown`, OLGA, { teamId: "t-nobody" })).status).toBe(404);
    expect((await h.call("POST", `${base}/titles/crown`, OLGA, { teamId: h.tid("Bob") })).status).toBe(200);
    expect(titleReplay(h.ladderOf(id), h.time.now).holder?.teamId).toBe(h.tid("Bob"));
    expect((await h.call("POST", `${base}/titles/vacate`, OLGA, { reason: "stripped" })).status).toBe(200);
    expect(titleReplay(h.ladderOf(id), h.time.now).holder).toBeUndefined();
    expect((await h.call("POST", `${base}/titles/vacate`, OLGA, {})).status).toBe(409);
    // GETs never write (also past every deadline: the job decides, not the read).
    const rev = h.ladderOf(id).revision;
    h.advance(60 * D);
    for (const path of [base, `/api/leagues/${L}/ladders`, `/api/leagues/${L}/champions`, `/api/leagues/${L}/honours`]) {
      for (const who of [undefined, coach("Amy"), OLGA]) expect((await h.call("GET", path, who)).status).toBe(200);
    }
    expect(h.ladderOf(id).revision).toBe(rev);
    // A ladder without a belt refuses title actions.
    const h2 = harness();
    const id2 = await h2.openLadder({ titles: { belt: false } });
    expect((await h2.call("POST", `/api/leagues/${L}/ladders/${id2}/titles/vacate`, OLGA, {})).status).toBe(409);
  });
});

// ---- Sol review (P2s): each through the real routes and job ----------------------------------------------------------------

describe("review fixes", () => {
  const challengeAccepted = async (h: ReturnType<typeof harness>, id: string, challenger: string, defender: string) => {
    const ch = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach(challenger), { challengerTeamId: h.tid(challenger), defenderTeamId: h.tid(defender) });
    expect(ch.status, JSON.stringify(ch.body)).toBe(201);
    const acc = await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges/${(ch.body as { challenge: { id: string } }).challenge.id}/accept`, coach(defender), {});
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    return (acc.body as { fixture: { id: string } }).fixture.id;
  };

  it("1: a champion who concedes loses the belt and earns no defence points, whatever the score", async () => {
    const h = harness();
    const id = await h.crowned();
    const fid = await challengeAccepted(h, id, "Gus", "Amy");
    const lad = h.ladderOf(id);
    const f = lad.fixtures.find((x) => x.id === fid)!;
    h.advance(60_000);
    f.home.score = 2; f.away.score = 1; f.home.conceded = true; f.finishedAt = h.time.now.toISOString();
    h.store.putSeason(lad);
    const state = titleReplay(h.ladderOf(id), h.time.now);
    expect(state.holder?.teamId).toBe(h.tid("Gus"));
    expect(state.defences).toHaveLength(0);
    expect(ladderRanking(h.ladderOf(id), h.time.now).find((r) => r.teamId === h.tid("Amy"))!.bonus).toBe(3);
  });

  it("2: a Rumble bye recipient who leaves loses by walkover and the bracket goes on; a broken record never wedges the job", async () => {
    const h = harness();
    const id = await h.crowned();
    const date = new Date(h.time.now.getTime() + D).toISOString();
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "open" });
    const rid = h.ladderOf(id).ladder!.rumbles![0]!.id;
    for (const c of ["Bob", "Dan", "Gus"]) expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach(c), { teamId: h.tid(c) })).status).toBe(200);
    h.advance(D + 60_000);
    h.job();
    const r1 = h.ladderOf(id).ladder!.rumbles![0]!.rounds[0]!.matches;
    const bye = r1.find((m) => !m.awayTeamId)!;
    const game = r1.find((m) => m.awayTeamId)!;
    // The bye recipient leaves the ladder.
    const lad = h.ladderOf(id);
    lad.ladder!.members.find((m) => m.teamId === bye.homeTeamId)!.leftAt = h.time.now.toISOString();
    h.store.putSeason(lad);
    h.play(id, game.fixtureId!, 1, 0);
    const out = h.job();
    expect(out.failed).toEqual([]);
    const ru = h.ladderOf(id).ladder!.rumbles![0]!;
    expect(ru.rounds[1]!.matches[0]).toMatchObject({ how: "walkover", winnerTeamId: game.homeTeamId });
    expect(ru).toMatchObject({ state: "finished", winnerTeamId: game.homeTeamId });
    // A record the rules can't read is logged and skipped; the job keeps going.
    const bad = h.ladderOf(id);
    (bad.ladder!.rumbles![0] as unknown as { rounds: unknown }).rounds = null;
    bad.ladder!.rumbles![0]!.state = "running";
    h.store.putSeason(bad);
    expect(() => h.job()).not.toThrow();
    expect(h.job().failed).toEqual([]);
  });

  it("3: correcting an eliminator result names the right mandatory challenger; clearing it puts the eliminator back in play", async () => {
    const h = harness();
    const id = await h.crowned();
    const elim = h.live(id, "eliminator")[0]!;
    h.play(id, elim.fixtureId, 1, 0); // Eve (home) wins
    h.job();
    const first = h.live(id, "mandatory")[0]!;
    expect(first).toMatchObject({ awayTeamId: h.tid("Eve"), fromBoutId: elim.id });
    h.play(id, elim.fixtureId, 0, 1); // corrected: Cara won
    h.job();
    expect(h.bouts(id).find((b) => b.id === first.id)!.state).toBe("cancelled");
    expect(h.live(id, "mandatory")[0]).toMatchObject({ awayTeamId: h.tid("Cara") });
    const lad = h.ladderOf(id);
    const f = lad.fixtures.find((x) => x.id === elim.fixtureId)!;
    f.home.score = null; f.away.score = null; delete f.finishedAt;
    h.store.putSeason(lad);
    h.job();
    expect(h.live(id, "mandatory")).toHaveLength(0);
    expect(h.bouts(id).find((b) => b.id === elim.id)!.state).toBe("scheduled");
  });

  const rumbleFinal = async (h: ReturnType<typeof harness>, id: string) => {
    const date = new Date(h.time.now.getTime() + D).toISOString();
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "open" });
    const rid = h.ladderOf(id).ladder!.rumbles![0]!.id;
    for (const c of ["Bob", "Dan"]) await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach(c), { teamId: h.tid(c) });
    h.advance(D + 60_000);
    h.job();
    return h.ladderOf(id).ladder!.rumbles![0]!.rounds[0]!.matches[0]!;
  };

  it("4: a corrected Rumble final moves the win, the points and the title-shot contract (or tells the organisers once cashed in)", async () => {
    const h = harness();
    const id = await h.crowned();
    const final = await rumbleFinal(h, id);
    h.play(id, final.fixtureId!, 1, 0);
    h.job();
    const won = h.ladderOf(id).ladder!;
    expect(won.rumbles![0]!.winnerTeamId).toBe(final.homeTeamId);
    const oldContract = won.titles!.contracts.find((c) => c.source === "rumble")!;
    expect(oldContract.teamId).toBe(final.homeTeamId);
    const bonus = (tid: string) => ladderRanking(h.ladderOf(id), h.time.now).find((r) => r.teamId === tid)!.bonus;
    expect(bonus(final.homeTeamId)).toBe(5);
    h.play(id, final.fixtureId!, 0, 1);
    h.job();
    const after = h.ladderOf(id).ladder!;
    expect(after.rumbles![0]).toMatchObject({ state: "finished", winnerTeamId: final.awayTeamId });
    expect(after.titles!.contracts.find((c) => c.id === oldContract.id)!.revokedAt).toBeTruthy();
    expect(after.titles!.contracts.find((c) => c.source === "rumble" && !c.revokedAt)!.teamId).toBe(final.awayTeamId);
    expect(bonus(final.homeTeamId)).toBe(0);
    expect(bonus(final.awayTeamId!)).toBe(5);
    // Cashed in before the correction: kept, and the organisers are told.
    const newC = after.titles!.contracts.find((c) => c.source === "rumble" && !c.revokedAt)!;
    const awayCoach = h.ladderOf(id).teams.find((t) => t.id === final.awayTeamId)!.coach;
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${newC.id}/cash-in`, coach(awayCoach), {})).status).toBe(200);
    h.sent.length = 0;
    h.play(id, final.fixtureId!, 2, 0);
    h.job();
    expect(h.ladderOf(id).ladder!.titles!.contracts.find((c) => c.id === newC.id)!.revokedAt).toBeUndefined();
    expect(h.sent.some((s) => s.coach === "Olga" && s.input.body.includes("already cashed in"))).toBe(true);
  });

  it("5: a streak a corrected result breaks withdraws its uncashed contract; cash-in re-checks it", async () => {
    const h = harness();
    const id = await h.crowned({ mitb: { enabled: true, streak: 3 } });
    const l = h.ladderOf(id); l.ladder!.titles!.mitbOnAt = "2026-11-01T00:00:00.000Z"; h.store.putSeason(l);
    h.result(id, "Bob", "Dan", 1, 0, "2026-11-10T13:00:00.000Z");
    const mid = h.result(id, "Bob", "Finn", 1, 0, "2026-11-10T14:00:00.000Z");
    h.result(id, "Bob", "Gus", 1, 0, "2026-11-10T15:00:00.000Z");
    h.advance(4 * H);
    h.job();
    const c = h.ladderOf(id).ladder!.titles!.contracts[0]!;
    // Corrected: Bob lost the middle game; until the job runs, cash-in itself refuses it.
    const lad = h.ladderOf(id);
    const f = lad.fixtures.find((x) => x.id === mid.id)!; f.home.score = 0; f.away.score = 1;
    h.store.putSeason(lad);
    const refused = await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${c.id}/cash-in`, coach("Bob"), {});
    expect(refused.status).toBe(409);
    h.job();
    expect(h.ladderOf(id).ladder!.titles!.contracts[0]!.revokedAt).toBeTruthy();
    expect(h.sent.some((s) => s.coach === "Bob" && s.input.title.includes("withdrawn"))).toBe(true);
  });

  it("6: a contract dates from the result that completed the streak, never the tick that noticed it; an old streak earns nothing", async () => {
    const h = harness();
    const id = await h.crowned({ mitb: { enabled: true, streak: 2 } });
    const l = h.ladderOf(id); l.ladder!.titles!.mitbOnAt = "2026-01-01T00:00:00.000Z"; h.store.putSeason(l);
    h.result(id, "Dan", "Finn", 1, 0, "2026-06-01T10:00:00.000Z");
    h.result(id, "Dan", "Gus", 1, 0, "2026-06-02T10:00:00.000Z"); // its 90 days ended 2026-08-31: no contract
    h.result(id, "Bob", "Finn", 1, 0, "2026-11-01T10:00:00.000Z");
    h.result(id, "Bob", "Gus", 1, 0, "2026-11-02T10:00:00.000Z");
    h.advance(5 * D);
    h.job();
    const list = h.ladderOf(id).ladder!.titles!.contracts;
    expect(list.map((c) => c.teamId)).toEqual([h.tid("Bob")]);
    expect(list[0]).toMatchObject({ earnedAt: "2026-11-02T10:00:00.000Z", expiresAt: new Date(Date.parse("2026-11-02T10:00:00.000Z") + 90 * D).toISOString() });
  });

  it("7: closing doesn't pay weekly points for time the champion was marked inactive", async () => {
    const h = harness();
    const id = await h.crowned();
    const since = titleReplay(h.ladderOf(id), h.time.now).holder!.since;
    h.time.now = new Date(Date.parse(since) + 3 * D);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/titles/inactive`, OLGA, {})).status).toBe(200);
    h.time.now = new Date(Date.parse(since) + 20 * D);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/close`, OLGA, {})).status).toBe(200);
    const later = new Date(Date.parse(since) + 40 * D);
    expect(ladderRanking(h.ladderOf(id), later).find((r) => r.teamId === h.tid("Amy"))!.bonus).toBe(3);
  });

  it("8 + 9: the scheduled close writes the last period's honours, ranked with the field as it was at each period's end", async () => {
    const h = harness();
    const start = h.time.now.getTime();
    const id = await h.openLadder({ titles: { belt: false }, periodDays: 7, redraft: { trigger: "schedule" }, endsAt: new Date(start + 14 * D).toISOString() });
    h.seed(id, ["Amy", "Bob", "Cara", "Dan"]);
    h.result(id, "Amy", "Bob", 2, 0, new Date(start + D).toISOString());
    h.result(id, "Cara", "Dan", 1, 0, new Date(start + D + H).toISOString());
    h.result(id, "Bob", "Dan", 1, 0, new Date(start + 2 * D).toISOString());
    // Bob leaves after period 1 ended, before anything wrote its honours.
    const lad = h.ladderOf(id);
    lad.ladder!.members.find((m) => m.teamId === h.tid("Bob"))!.leftAt = new Date(start + 8 * D).toISOString();
    h.store.putSeason(lad);
    h.time.now = new Date(start + 14 * D + 60_000);
    h.job(); // one tick at the end: closes the ladder, periods 1 and 2 honoured first
    const awards = h.ladderOf(id).awards;
    expect(h.ladderOf(id).status).toBe("completed");
    expect(awards.filter((a) => a.key?.startsWith("period:1")).map((a) => a.team)).toContain("Bob's team");
    expect(awards.some((a) => a.key?.startsWith("period:2"))).toBe(true);
    expect(awards.some((a) => a.key?.startsWith("final:"))).toBe(true);
  });

  it("10: closing first settles a Rumble whose final result is in (crowned, not cancelled)", async () => {
    const h = harness();
    const id = await h.crowned();
    const final = await rumbleFinal(h, id);
    h.play(id, final.fixtureId!, 0, 2); // the result is in; no tick ran
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/close`, OLGA, {})).status).toBe(200);
    expect(h.ladderOf(id).ladder!.rumbles![0]).toMatchObject({ state: "finished", winnerTeamId: final.awayTeamId });
  });

  it("11: closing honours both the champion and the interim champion (labelled interim)", async () => {
    const h = harness();
    const id = await h.crowned();
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/titles/inactive`, OLGA, {});
    h.play(id, h.live(id, "interim")[0]!.fixtureId, 1, 0);
    h.job();
    expect(titleReplay(h.ladderOf(id), h.time.now).interim).toBeTruthy();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/close`, OLGA, {})).status).toBe(200);
    const types = h.ladderOf(id).awards.map((a) => a.type);
    expect(types).toContain("Spring belt holder at close");
    expect(types).toContain("Spring interim champion at close");
  });
});

// ---- Sol re-review (P2s, round 2) ---------------------------------------------------------------------------------------------

describe("review fixes, round 2", () => {
  const rumbleOpen = async (h: ReturnType<typeof harness>, id: string, coaches: string[]) => {
    const date = new Date(h.time.now.getTime() + D).toISOString();
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date, field: "open" });
    const rid = h.ladderOf(id).ladder!.rumbles![0]!.id;
    for (const c of coaches) expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles/${rid}/enter`, coach(c), { teamId: h.tid(c) })).status).toBe(200);
    h.advance(D + 60_000);
    h.job();
    return h.ladderOf(id).ladder!.rumbles![0]!;
  };

  it("1: a mandatory with a recorded result freezes its eliminator even before a pass marks it played", async () => {
    const h = harness();
    const id = await h.crowned();
    const elim = h.live(id, "eliminator")[0]!;
    h.play(id, elim.fixtureId, 1, 0);
    h.job();
    const mand = h.live(id, "mandatory")[0]!;
    h.play(id, mand.fixtureId, 2, 0); // the mandatory is played (no pass yet) ...
    h.play(id, elim.fixtureId, 0, 1); // ... then the eliminator is corrected
    h.job();
    expect(h.bouts(id).find((b) => b.id === mand.id)!.state).toBe("played");
    expect(titleReplay(h.ladderOf(id), h.time.now).holder).toMatchObject({ teamId: h.tid("Amy"), defences: 1 });
  });

  it("2 + 3: restoring a Rumble winner gives back their own prize (never a second); a displaced winner's cashed contract never re-arms", async () => {
    const h = harness();
    const id = await h.crowned();
    const final = (await rumbleOpen(h, id, ["Bob", "Dan"])).rounds[0]!.matches[0]!;
    const rumbleContracts = () => h.ladderOf(id).ladder!.titles!.contracts.filter((c) => c.source === "rumble");
    h.play(id, final.fixtureId!, 1, 0); h.job();
    h.play(id, final.fixtureId!, 0, 1); h.job();
    h.play(id, final.fixtureId!, 1, 0); h.job(); // the first winner restored
    const list = rumbleContracts();
    expect(list.filter((c) => c.teamId === final.homeTeamId)).toHaveLength(1);
    expect(list.find((c) => c.teamId === final.homeTeamId)!.revokedAt).toBeUndefined();
    expect(list.find((c) => c.teamId === final.awayTeamId)!.revokedAt).toBeTruthy();
    expect(list.every((c) => c.rumbleId === h.ladderOf(id).ladder!.rumbles![0]!.id)).toBe(true);
    // The winner cashes in, is then displaced (contract kept, consumed), and the cash-in game lapses: it does not come back.
    const homeCoach = h.ladderOf(id).teams.find((t) => t.id === final.homeTeamId)!.coach;
    const mine = list.find((c) => c.teamId === final.homeTeamId)!;
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${mine.id}/cash-in`, coach(homeCoach), {})).status).toBe(200);
    h.play(id, final.fixtureId!, 0, 1); h.job();
    const kept = rumbleContracts().find((c) => c.id === mine.id)!;
    expect(kept).toMatchObject({ consumed: true });
    expect(kept.revokedAt).toBeUndefined();
    h.advance(8 * D);
    h.job();
    const after = rumbleContracts().find((c) => c.id === mine.id)!;
    expect(after.usedAt).toBeTruthy();
    expect((await h.view(id, coach(homeCoach))).titles.contracts.find((c) => c.id === mine.id)).toBeUndefined();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${mine.id}/cash-in`, coach(homeCoach), {})).status).toBe(409);
  });

  it("4: a Rumble side marked inactive with \"leave scheduled\" keeps its game until the deadline; then the active side walks over", async () => {
    const h = harness();
    const id = await h.crowned();
    const final = (await rumbleOpen(h, id, ["Bob", "Dan"])).rounds[0]!.matches[0]!;
    const lad = h.ladderOf(id);
    const away = lad.teams.find((t) => t.id === final.awayTeamId)!;
    away.status = "inactive";
    away.statusChanged = { by: "Olga", at: h.time.now.toISOString() };
    lad.fixtures.find((f) => f.id === final.fixtureId)!.inactiveDecision = { teamId: away.id, decision: "leave", by: "Olga", at: h.time.now.toISOString() };
    h.store.putSeason(lad);
    h.job();
    expect(h.ladderOf(id).ladder!.rumbles![0]!.rounds[0]!.matches[0]!.winnerTeamId).toBeUndefined();
    h.advance(3 * D + 60_000);
    h.job();
    expect(h.ladderOf(id).ladder!.rumbles![0]!.rounds[0]!.matches[0]).toMatchObject({ how: "walkover", winnerTeamId: final.homeTeamId });
  });

  it("5: raising the streak requirement never withdraws a contract earned under the old one", async () => {
    const h = harness();
    const id = await h.crowned({ mitb: { enabled: true, streak: 3 } });
    const l = h.ladderOf(id); l.ladder!.titles!.mitbOnAt = "2026-11-01T00:00:00.000Z"; h.store.putSeason(l);
    h.result(id, "Bob", "Dan", 1, 0, "2026-11-10T13:00:00.000Z");
    h.result(id, "Bob", "Finn", 1, 0, "2026-11-10T14:00:00.000Z");
    h.result(id, "Bob", "Gus", 1, 0, "2026-11-10T15:00:00.000Z");
    h.advance(4 * H);
    h.job();
    expect(h.ladderOf(id).ladder!.titles!.contracts[0]).toMatchObject({ streak: 3 });
    const p = await h.call("PATCH", `/api/leagues/${L}/ladders/${id}`, OLGA, { revision: h.ladderOf(id).revision, settings: { titles: { mitb: { streak: 5 } } } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    h.job();
    const c = h.ladderOf(id).ladder!.titles!.contracts[0]!;
    expect(c.revokedAt).toBeUndefined();
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/contracts/${c.id}/cash-in`, coach("Bob"), {})).status).toBe(200);
  });

  it("6 + 7: period honours leave out teams that were inactive at the period's end, and never award a period after the scheduled end", async () => {
    const h = harness();
    const start = h.time.now.getTime();
    const id = await h.openLadder({ titles: { belt: false }, periodDays: 7, redraft: { trigger: "schedule" }, endsAt: new Date(start + 10 * D).toISOString() });
    h.seed(id, ["Amy", "Bob", "Cara", "Dan"]);
    h.result(id, "Amy", "Bob", 2, 0, new Date(start + D).toISOString());
    h.result(id, "Cara", "Dan", 1, 0, new Date(start + D + H).toISOString());
    // Cara was marked inactive (team page history) before period 1 ended.
    const lad = h.ladderOf(id);
    const cara = lad.teams.find((t) => t.id === h.tid("Cara"))!;
    cara.status = "inactive";
    cara.statusChanged = { by: "Olga", at: new Date(start + 3 * D).toISOString() };
    cara.history = [{ at: new Date(start + 3 * D).toISOString(), by: "Olga", kind: "status", changes: [{ what: "Status", from: "Active", to: "Inactive" }] }];
    h.store.putSeason(lad);
    h.time.now = new Date(start + 30 * D); // a very late tick: the close runs well after the scheduled end
    h.job();
    const awards = h.ladderOf(id).awards;
    const p1 = awards.filter((a) => a.key?.startsWith("period:1:"));
    expect(p1.map((a) => a.team)).not.toContain("Cara's team");
    expect(p1.map((a) => a.team)).toContain("Amy's team");
    expect(awards.some((a) => a.key?.startsWith("period:2"))).toBe(false); // period 2 would end after the scheduled end
    expect(h.ladderOf(id).ladder!.periodHonours).toEqual([1]);
  });

  it("8: a failing title step is skipped while the others run; the job reports it and organisers see the alert; null lists are repaired", async () => {
    const h = harness();
    const id = await h.crowned();
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/rumbles`, OLGA, { date: new Date(h.time.now.getTime() + D).toISOString(), field: "top8" });
    // A malformed record: a list stored as null is mended, not a failure.
    const l = h.ladderOf(id);
    (l.ladder!.rumbles![0] as unknown as { entries: unknown }).entries = null;
    h.store.putSeason(l);
    expect(h.job().failed).toEqual([]);
    // A record the rules can't mend (a null match): the Rumble step fails; the belt step still sets the next title game.
    const bad = h.ladderOf(id);
    bad.ladder!.rumbles![0]!.state = "running";
    bad.ladder!.rumbles![0]!.seeds = [h.tid("Bob"), h.tid("Dan")];
    (bad.ladder!.rumbles![0] as unknown as { rounds: unknown }).rounds = [{ number: 1, deadline: h.time.now.toISOString(), matches: [null] }];
    bad.ladder!.titles!.bouts = bad.ladder!.titles!.bouts.map((b) => (b.state === "scheduled" ? { ...b, state: "cancelled" as const } : b));
    h.store.putSeason(bad);
    const out = h.job();
    expect(out.failed).toEqual([`${L}/${id}:titles:rumble`]);
    expect(h.live(id).length).toBeGreaterThan(0); // the belt step still ran
    const forOrganiser = (await h.call("GET", `/api/leagues/${L}/ladders/${id}`, OLGA)).body as { ladder: { titleFailures?: Array<{ step: string }> } };
    expect(forOrganiser.ladder.titleFailures).toEqual([expect.objectContaining({ step: "rumble" })]);
    const forCoach = (await h.call("GET", `/api/leagues/${L}/ladders/${id}`, coach("Bob"))).body as { ladder: { titleFailures?: unknown } };
    expect(forCoach.ladder.titleFailures).toBeUndefined();
  });
});
