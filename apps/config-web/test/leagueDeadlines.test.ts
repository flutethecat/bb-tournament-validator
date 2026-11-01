import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboardingGateApplies } from "../src/auth/onboarding";
import { deadlineChip, deriveDeadlines } from "../src/coachHome";
import type { NotificationInput } from "../src/notifications";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { applyDue, dueFixtures, effectiveDeadline, parseDeadline, policyOf, runDeadlineJob, watchedSeasons } from "../src/leagues/deadlines";
import { clearMyLeaguesIndex, myLeagueDeadlines, myLeagues } from "../src/leagues/myLeagues";
import { computePhaseStandings } from "../src/leagues/standings";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";

// League fixture deadlines (src/leagues/deadlines.ts): effective deadline (fixture ?? round), the organiser PATCH (auth,
// season revision 428/409, new revision back), auto-forfeit OFF by default, applied once (idempotent, restart-safe,
// notified once), results and organiser decisions untouched, the sidebar's next-fixture deadline and the coach page
// Deadlines rows.

const team = (id: string, name: string, coachId: string): LeagueTeam => ({
  id, name, race: "Orc", coach: coachId, coachId, teamValue: 1_000_000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0,
  apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [],
});
const fx = (id: string, round: number, home: string, away: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: { team: home, teamId: home.toLowerCase(), coach: "", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: away, teamId: away.toLowerCase(), coach: "", race: "Orc", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const NOW = new Date("2026-11-10T12:00:00.000Z");
const H = 3_600_000;
const iso = (offsetHours: number): string => new Date(NOW.getTime() + offsetHours * H).toISOString();

const baseSeason = (): SeasonRecord => ({
  id: "season-1", leagueId: "tabbl", number: 1, name: "Season 1", sourceSlug: "tabbl-s1", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  teams: [team("orcs", "Orcs", "Ann"), team("elves", "Elves", "Bob"), team("rats", "Rats", "Cat"), team("dwarfs", "Dwarfs", "Dee")],
  fixtures: [
    fx("f1", 1, "Orcs", "Elves"),
    fx("f2", 1, "Rats", "Dwarfs"),
    fx("f3", 2, "Orcs", "Rats"),
  ],
  participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("deadline helpers", () => {
  it("parseDeadline takes an ISO instant with a zone only, as UTC", () => {
    expect(parseDeadline("2026-11-12T18:00:00Z")).toBe("2026-11-12T18:00:00.000Z");
    expect(parseDeadline("2026-11-12T18:00+02:00")).toBe("2026-11-12T16:00:00.000Z");
    for (const bad of ["2026-11-12", "2026-11-12T18:00", "tomorrow", 5, null, "1999-01-01T00:00:00Z", "x".repeat(80)]) expect(parseDeadline(bad)).toBeUndefined();
  });
  it("effective deadline = the fixture's own, else its round's (per phase)", () => {
    const s = baseSeason();
    s.roundDeadlines = [{ phaseId: "season-regular", round: 1, deadline: iso(10) }, { phaseId: "other", round: 2, deadline: iso(20) }];
    expect(effectiveDeadline(s, s.fixtures[0]!)).toBe(iso(10));
    expect(effectiveDeadline(s, s.fixtures[2]!)).toBeUndefined();
    s.fixtures[0]!.deadline = iso(30);
    expect(effectiveDeadline(s, s.fixtures[0]!)).toBe(iso(30));
  });
  it("chip thresholds: ok > 72 h, soon < 72 h, urgent < 24 h, overdue after", () => {
    expect(deadlineChip(iso(73), NOW)).toBe("ok");
    expect(deadlineChip(iso(71), NOW)).toBe("soon");
    expect(deadlineChip(iso(23), NOW)).toBe("urgent");
    expect(deadlineChip(iso(-1), NOW)).toBe("overdue");
  });
  it("auto-forfeit is OFF by default: a passed deadline marks nothing", () => {
    const s = baseSeason();
    s.roundDeadlines = [{ phaseId: "season-regular", round: 1, deadline: iso(-5) }];
    expect(policyOf(s)).toEqual({ autoForfeit: false, outcome: "review" });
    expect(dueFixtures(s, NOW)).toEqual([]);
    expect(applyDue(s, NOW)).toEqual([]);
  });
  it("both-lose counts as a loss for each side in the standings (existing path)", () => {
    const s = baseSeason();
    s.roundDeadlines = [{ phaseId: "season-regular", round: 1, deadline: iso(-5) }];
    s.deadlinePolicy = { autoForfeit: true, outcome: "both-lose" };
    applyDue(s, NOW);
    const rows = computePhaseStandings(s, s.phases[0]!).rows;
    for (const id of ["orcs", "elves", "rats", "dwarfs"]) {
      const r = rows.find((x) => x.teamId === id)!;
      expect(r.played, id).toBe(1);
      expect(r.losses, id).toBe(1);
      expect(r.points, id).toBe(0);
      expect(r.tdFor, id).toBe(0);
    }
  });
});

describe("league deadlines route and job", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let sent: Array<{ coach: string; input: NotificationInput }>;
  let ifMatch: string | undefined;
  let now: Date;
  const deps = (): LeagueApiDeps => ({
    store, now: () => now, ifMatch,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    notify: (coach, input) => { sent.push({ coach, input }); },
  });
  const ORG = { coach: "Org", admin: false };
  const ROOT = { coach: "Root", admin: true };
  const ANN = { coach: "Ann", admin: false };
  const path = "/api/leagues/tabbl/seasons/season-1/deadlines";
  const rev = () => store.season("tabbl", "season-1")!.revision ?? 0;
  const saved = () => store.season("tabbl", "season-1")!;
  const fixture = (id: string) => saved().fixtures.find((f) => f.id === id)!;
  const call = async (method: string, auth: { coach: string; admin: boolean } | undefined, b?: unknown, p = path): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, p, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };
  const job = () => runDeadlineJob({ store, notify: (coach, input) => { sent.push({ coach, input }); }, now: () => now });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-deadlines-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Org"] });
    store.putSeason(baseSeason());
    sent = [];
    ifMatch = undefined;
    now = NOW;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("auth: anonymous 401, a member coach 403, unknown league 404, organiser and admin 200; only PATCH", async () => {
    expect((await call("PATCH", undefined, { revision: rev(), policy: { autoForfeit: true } })).status).toBe(401);
    expect((await call("PATCH", ANN, { revision: rev(), policy: { autoForfeit: true } })).status).toBe(403);
    expect((await call("PATCH", ORG, { revision: 0 }, "/api/leagues/nope/seasons/season-1/deadlines")).status).toBe(404);
    expect((await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true } })).status).toBe(200);
    expect((await call("PATCH", ROOT, { revision: rev(), policy: { autoForfeit: false } })).status).toBe(200);
    expect((await call("GET", ORG)).status).toBe(405);
    expect(saved().deadlinePolicy).toMatchObject({ autoForfeit: false, outcome: "review", updatedBy: "Root" });
  });

  it("revision: missing 428, stale 409, If-Match accepted; the answer carries the new revision and the season", async () => {
    const r428 = await call("PATCH", ORG, { rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(48) }] });
    expect(r428.status).toBe(428);
    expect((r428.body as { revision: number }).revision).toBe(rev());
    expect((await call("PATCH", ORG, { revision: rev() - 1, rounds: [] , policy: {} })).status).toBe(409);
    const before = rev();
    const ok = await call("PATCH", ORG, { revision: before, rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(48) }] });
    expect(ok.status).toBe(200);
    const b = ok.body as { revision: number; season: SeasonRecord };
    expect(b.revision).toBe(before + 1);
    expect(b.revision).toBe(rev());
    expect(b.season.roundDeadlines).toEqual([{ phaseId: "season-regular", round: 1, deadline: iso(48) }]);
    ifMatch = `"${rev()}"`;
    expect((await call("PATCH", ORG, { fixtures: [{ id: "f1", deadline: iso(60) }] })).status).toBe(200);
    expect(fixture("f1").deadline).toBe(iso(60));
    expect(ok.headers?.["cache-control"]).toContain("no-store");
  });

  it("the write path is behind the onboarding gate (428) like every league write", () => {
    expect(onboardingGateApplies("PATCH", path)).toBe(true);
  });

  it("validation: bad deadline, unknown phase / fixture, bad decision or outcome, nothing to change, finished season", async () => {
    for (const b of [
      { rounds: [{ phaseId: "season-regular", round: 1, deadline: "2026-11-12" }] },
      { rounds: [{ phaseId: "nope", round: 1, deadline: iso(5) }] },
      { fixtures: [{ id: "zz", deadline: iso(5) }] },
      { fixtures: [{ id: "f1", decision: "review" }] },
      { fixtures: [{ id: "f1" }] },
      { policy: { outcome: "home-wins" } },
      { policy: { autoForfeit: "yes" } },
      {},
    ]) expect((await call("PATCH", ORG, { revision: rev(), ...b })).status, JSON.stringify(b)).toBe(400);
    const s = saved(); s.status = "completed"; store.putSeason(s);
    expect((await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true } })).status).toBe(409);
  });

  it("clearing: a null round deadline removes it; a null fixture deadline falls back to the round's", async () => {
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(48) }], fixtures: [{ id: "f1", deadline: iso(10) }] });
    expect(effectiveDeadline(saved(), fixture("f1"))).toBe(iso(10));
    await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f1", deadline: null }] });
    expect(fixture("f1").deadline).toBeUndefined();
    expect(effectiveDeadline(saved(), fixture("f1"))).toBe(iso(48));
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: null }] });
    expect(saved().roundDeadlines).toBeUndefined();
  });

  it("job: off by default does nothing; on, it applies the outcome once, notifies coaches + organisers once, and is restart-safe", async () => {
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(2) }] });
    now = new Date(NOW.getTime() + 3 * H);
    expect(job().applied).toEqual([]);
    expect(saved().fixtures.some((f) => f.deadlineOutcome)).toBe(false);
    now = NOW;
    await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true } });
    expect(job().applied).toEqual([]); // deadline not passed yet
    now = new Date(NOW.getTime() + 3 * H);
    const first = job();
    expect(first.applied.map((a) => a.fixtureId).sort()).toEqual(["f1", "f2"]);
    expect(fixture("f1").deadlineOutcome).toMatchObject({ outcome: "review", auto: true, deadline: iso(2) });
    expect(fixture("f1").home.score).toBeNull();
    expect(fixture("f3").deadlineOutcome).toBeUndefined();
    // f1: Ann, Bob, Org; f2: Cat, Dee, Org.
    expect(sent.map((s) => s.coach).sort()).toEqual(["Ann", "Bob", "Cat", "Dee", "Org", "Org"]);
    expect(sent[0]!.input).toMatchObject({ type: "league-broadcast", title: "Fixture deadline passed" });
    expect(sent[0]!.input.link).toMatch(/^\/app\/leagues\/tabbl\?season=season-1&tab=fixtures&fixture=f[12]$/);
    expect(saved().log?.filter((e) => e.kind === "fixture-deadline")).toHaveLength(2);
    const revAfter = rev();
    // Idempotent: a second run, and a "restart" (a fresh store over the same files), apply and announce nothing.
    expect(job().applied).toEqual([]);
    store = new LeagueStore(dir);
    expect(job().applied).toEqual([]);
    expect(sent).toHaveLength(6);
    expect(rev()).toBe(revAfter);
  });

  it("job never touches a fixture with a result, a suspended one, or an organiser decision", async () => {
    const s = saved();
    s.roundDeadlines = [{ phaseId: "season-regular", round: 1, deadline: iso(-1) }, { phaseId: "season-regular", round: 2, deadline: iso(-1) }];
    s.deadlinePolicy = { autoForfeit: true, outcome: "both-lose" };
    s.fixtures[0]!.home.score = 2; s.fixtures[0]!.away.score = 1;
    s.fixtures[1]!.suspended = true;
    s.fixtures[2]!.deadlineOutcome = { outcome: "no-result", by: "Org", at: iso(-0.5) };
    store.putSeason(s);
    expect(job().applied).toEqual([]);
    expect(fixture("f1")).toMatchObject({ home: { score: 2, conceded: false }, away: { score: 1, conceded: false } });
    expect(fixture("f1").deadlineOutcome).toBeUndefined();
    expect(fixture("f3").deadlineOutcome).toEqual({ outcome: "no-result", by: "Org", at: iso(-0.5) });
    expect(sent).toEqual([]);
  });

  it("a deadlines write with a passed deadline and auto-forfeit on applies it in the same write (announced once)", async () => {
    const r = await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true, outcome: "both-lose" }, fixtures: [{ id: "f3", deadline: iso(-1) }] });
    expect(r.status).toBe(200);
    expect(fixture("f3").deadlineOutcome).toMatchObject({ outcome: "both-lose", auto: true });
    expect(fixture("f3")).toMatchObject({ home: { score: 0, conceded: true }, away: { score: 0, conceded: true } });
    expect(saved().resultsChangedAt).toBe(NOW.toISOString());
    expect((r.body as { season: SeasonRecord }).season.fixtures.find((f) => f.id === "f3")!.deadlineOutcome?.outcome).toBe("both-lose");
    expect(sent.map((s) => s.coach).sort()).toEqual(["Ann", "Cat", "Org"]);
    expect(job().applied).toEqual([]);
    expect(sent).toHaveLength(3);
  });

  it("extending the deadline lifts an auto outcome (and its placeholder); an organiser decision stays", async () => {
    await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true, outcome: "both-lose" }, rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(-1) }] });
    expect(fixture("f1").deadlineOutcome?.auto).toBe(true);
    await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f2", decision: "no-result" }] });
    expect(fixture("f2").deadlineOutcome).toMatchObject({ outcome: "no-result", by: "Org" });
    expect(fixture("f2").home.score).toBeNull(); // placeholder cleared when switching from both-lose
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(24) }] });
    expect(fixture("f1").deadlineOutcome).toBeUndefined();
    expect(fixture("f1").home).toMatchObject({ score: null, conceded: false });
    expect(fixture("f2").deadlineOutcome).toMatchObject({ outcome: "no-result", by: "Org" });
  });

  it("decisions: refused on a fixture with a real result; null reopens; a result entered in the editor replaces the outcome", async () => {
    const s = saved(); s.fixtures[0]!.home.score = 1; s.fixtures[0]!.away.score = 0; store.putSeason(s);
    const refused = await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f1", decision: "both-lose" }] });
    expect(refused.status).toBe(400);
    expect(fixture("f1").deadlineOutcome).toBeUndefined();
    await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f2", decision: "both-lose" }] });
    expect(fixture("f2")).toMatchObject({ home: { score: 0, conceded: true }, deadlineOutcome: { outcome: "both-lose", by: "Org" } });
    await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f2", decision: null }] });
    expect(fixture("f2").deadlineOutcome).toBeUndefined();
    expect(fixture("f2").home).toMatchObject({ score: null, conceded: false });
    await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f2", decision: "both-lose" }] });
    // The fixtures editor's result PATCH (events.ts editFixture) replaces it: no concessions left behind.
    const edit = await call("PATCH", ORG, { result: { home: 2, away: 1 } }, "/api/leagues/tabbl/seasons/season-1/fixtures/f2");
    expect(edit.status).toBe(200);
    expect(fixture("f2").deadlineOutcome).toBeUndefined();
    expect(fixture("f2")).toMatchObject({ home: { score: 2, conceded: false }, away: { score: 1, conceded: false } });
  });

  it("the public season read carries the deadlines and outcomes (no private data)", async () => {
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(30) }] });
    const r = await call("GET", undefined, undefined, "/api/leagues/tabbl/seasons/season-1");
    const season = (r.body as { season: SeasonRecord }).season;
    expect(season.roundDeadlines).toEqual([{ phaseId: "season-regular", round: 1, deadline: iso(30) }]);
  });

  it("sidebar next fixture carries the effective deadline; the coach Deadlines rows list open league fixtures nearest first", async () => {
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(30) }, { phaseId: "season-regular", round: 2, deadline: iso(100) }], fixtures: [{ id: "f2", decision: "no-result" }] });
    clearMyLeaguesIndex(store);
    const ann = myLeagues(store, "Ann");
    expect(ann[0]!.teams[0]!.next).toMatchObject({ id: "f1", deadline: iso(30) });
    // Cat's round-1 fixture was decided "no result": her next fixture is round 2.
    expect(myLeagues(store, "Cat")[0]!.teams[0]!.next).toMatchObject({ id: "f3", deadline: iso(100) });
    const rows = myLeagueDeadlines(store, "Ann");
    expect(rows.map((r) => r.at).sort()).toEqual([iso(30), iso(100)]);
    expect(rows.find((r) => r.at === iso(30))).toMatchObject({ title: "Round 1 vs Elves", detail: "TABBL · Orcs", link: "/leagues/tabbl?tab=fixtures&fixture=f1" });
    const list = deriveDeadlines({ coach: "Ann", tournaments: [], entrants: () => [], matches: () => [], tabletop: [], endedAt: () => undefined, leagues: rows, now: NOW });
    expect(list.map((d) => [d.kind, d.at, d.chip])).toEqual([["league", iso(30), "soon"], ["league", iso(100), "ok"]]);
    expect(myLeagueDeadlines(store, "Cat").map((r) => r.at)).toEqual([iso(100)]);
    expect(myLeagueDeadlines(store, "Nobody")).toEqual([]);
  });

  it("Reopen with auto-forfeit on: not re-applied in that PATCH or by the job, no new notice; a changed deadline re-arms it", async () => {
    await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true }, rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(-1) }] });
    expect(fixture("f1").deadlineOutcome?.outcome).toBe("review");
    const told = sent.length;
    for (let i = 0; i < 3; i++) {
      const r = await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f1", decision: null }] });
      expect(r.status).toBe(200);
      expect(fixture("f1").deadlineOutcome).toBeUndefined();
      expect(fixture("f1").deadlineReopenedFor).toBe(iso(-1));
    }
    expect(job().applied).toEqual([]);
    expect(sent.length).toBe(told);
    // A new deadline (still past) is a new deadline: the marker is spent and auto-forfeit applies once more.
    await call("PATCH", ORG, { revision: rev(), fixtures: [{ id: "f1", deadline: iso(-0.5) }] });
    expect(fixture("f1").deadlineReopenedFor).toBeUndefined();
    expect(fixture("f1").deadlineOutcome).toMatchObject({ outcome: "review", deadline: iso(-0.5) });
    expect(sent.length).toBe(told + 3);
  });

  it("job index: only active seasons with auto-forfeit on are watched; nothing on = nothing read; rebuilt after a write", async () => {
    expect(watchedSeasons(store, NOW.getTime())).toEqual([]);
    expect(job().applied).toEqual([]);
    await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true } });
    expect(watchedSeasons(store, NOW.getTime())).toEqual([{ leagueId: "tabbl", seasonId: "season-1" }]);
    const s = saved(); s.status = "completed"; store.putSeason(s);
    expect(watchedSeasons(store, NOW.getTime())).toEqual([]);
  });

  it("coach deadlines cover every active season the coach has a seat in", async () => {
    await call("PATCH", ORG, { revision: rev(), rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(30) }] });
    const older = { ...baseSeason(), id: "season-0", number: 0, sourceSlug: "tabbl-s0", fixtures: [fx("g1", 1, "Orcs", "Dwarfs", { deadline: iso(10) })] };
    store.putSeason(older);
    clearMyLeaguesIndex(store);
    expect(myLeagueDeadlines(store, "Ann").map((r) => r.at).sort()).toEqual([iso(10), iso(30)]);
    expect(myLeagueDeadlines(store, "Ann").find((r) => r.at === iso(10))!.link).toBe("/leagues/tabbl?season=season-0&tab=fixtures&fixture=g1");
  });

  it("an overdue fixture waiting for a decision stays as the next fixture, flagged", async () => {
    await call("PATCH", ORG, { revision: rev(), policy: { autoForfeit: true }, rounds: [{ phaseId: "season-regular", round: 1, deadline: iso(-1) }] });
    clearMyLeaguesIndex(store);
    expect(myLeagues(store, "Ann")[0]!.teams[0]!.next).toMatchObject({ id: "f1", needsDecision: true, deadline: iso(-1) });
    expect(myLeagueDeadlines(store, "Ann")[0]!.title).toBe("Round 1 vs Elves · needs organiser decision");
  });
});
