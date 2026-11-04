import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { NotificationInput } from "../src/notifications.js";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";
import { ladderTeamGamesSinceRedraft, parseLadderSettings } from "../src/leagues/ladder.js";
import { runLadderJob } from "../src/leagues/ladderJob.js";
import { runRedraftWindowJob } from "../src/leagues/redraftWindow.js";
import { ladderTeamRecord } from "../src/leagues/ladderRedraft.js";
import { fixturePlayBlock } from "../src/leagues/playBlock.js";
import { syncGateTargets } from "../src/leagues/gates.js";

// Cleanup lane 11-03 (spec-grill-round2-leftovers Q8, spec-league-ladder "Redraft"): ladder redrafts run the season redraft in
// place. The per-team "after N games" trigger is enforced (task + challenge block + Redraft mode), the period-end trigger opens a
// redraft for every member with the same window job, and the organiser board works for ladders (statuses, overrides, Lift to
// budget, skip, close). Each test has its own state dir; every transport is a stub.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
const coach = (name: string): LeagueApiIdentity => ({ coach: name, admin: false });
const L = "rivertown";
const H = 3_600_000;
const D = 24 * H;

function team(id: string, coachName: string, extra: Partial<LeagueTeam> = {}): LeagueTeam {
  return {
    id, name: `${coachName}'s ${id}`, race: "Human", coach: coachName, coachId: coachName, coachAssigned: { by: "Olga", at: "2026-10-01T00:00:00.000Z" },
    teamValue: 1_000_000, treasury: 50_000, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "", raceLeague: "",
    players: Array.from({ length: 11 }, (_, i) => ({
      playerId: `p-${id}-${i}`, number: i + 1, name: `P${i}`, position: "Lineman", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50_000,
      level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false,
      stats: { td: i === 0 ? 3 : 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: i === 0 ? 9 : 0, performance: 0 },
    })),
    formerPlayers: [], teamUid: `tm-${id}`, entryId: `en-${id}`, ...extra,
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "bbtv-ladder-redraft-"));
  roots.push(root);
  const store = new LeagueStore(root);
  const clock = { now: new Date("2026-11-10T12:00:00.000Z") };
  const sent: Array<{ coach: string; input: NotificationInput }> = [];
  store.upsertLeague({ id: L, name: "Rivertown", fullName: "Rivertown BBL", slug: L, organisers: ["Olga"], owner: "Olga", rulesetPackage: "EuroBowl 2026" } as never);
  const season: SeasonRecord = {
    id: "season-1", leagueId: L, number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", stage: "active",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
  };
  store.putSeason(season);
  const deps = (body: unknown): LeagueApiDeps => ({
    store, readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))), now: () => clock.now,
    identities: () => [{ coach: "Olga", level: "organizer" }], notify: (c, input) => { sent.push({ coach: c, input }); },
    packageExists: (name) => name === "EuroBowl 2026", rollD6: () => 6,
  });
  const call = async (method: string, path: string, auth?: LeagueApiIdentity, body?: unknown): Promise<LeagueApiResult> => {
    const [p, q] = path.split("?");
    const r = await leagueApi(method, p!, new URLSearchParams(q ?? ""), auth, deps(body));
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const ladderOf = (id = "ladder-1") => store.season(L, id)!;
  const openLadder = async (settings: Record<string, unknown> = {}) => {
    const created = await call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "Spring", ranking: "points" });
    const id = (created.body as { id: string }).id;
    if (Object.keys(settings).length) expect((await call("PATCH", `/api/leagues/${L}/ladders/${id}`, OLGA, { revision: ladderOf(id).revision, settings })).status).toBe(200);
    expect((await call("POST", `/api/leagues/${L}/ladders/${id}/start`, OLGA, {})).status).toBe(200);
    const lad = ladderOf(id);
    for (const [i, c] of ["Amy", "Bob", "Cara"].entries()) {
      const t = team(`t-${c.toLowerCase()}`, c);
      lad.teams.push(t);
      lad.ladder!.members.push({ teamId: t.id, joinedAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 1000).toISOString(), via: "organiser" });
    }
    store.putSeason(lad);
    return id;
  };
  const result = (id: string, home: string, away: string, hs: number, as: number, at: string) => {
    const lad = ladderOf(id);
    const t = (c: string) => lad.teams.find((x) => x.coach === c)!;
    const side = (x: LeagueTeam, score: number) => ({ team: x.name, teamId: x.id, coach: x.coach, coachId: x.coachId, race: x.race, score, cas: 0, conceded: false });
    const f: LeagueFixture = { id: `f-${lad.fixtures.length + 1}`, category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(t(home), hs), away: side(t(away), as), suspended: false, finishedAt: at };
    lad.fixtures.push(f);
    store.putSeason(lad);
  };
  return { store, clock, sent, call, ladderOf, openLadder, result };
}

const keepAll = { keep: Array.from({ length: 11 }, (_, i) => `p-t-bob-${i}`), hires: [], staff: { rerolls: 2, assistantCoaches: 0, cheerleaders: 0, apothecary: false } };

describe("per-team trigger (after N games)", () => {
  it("a team that reached N games is blocked from challenges, gets one task, redrafts in Redraft mode in place, and plays on", async () => {
    const h = harness();
    const id = await h.openLadder({ redraft: { trigger: "games", everyGames: 2 } });
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const base = `/api/leagues/${L}/ladders/${id}`;
    h.result(id, "Bob", "Cara", 2, 0, new Date(h.clock.now.getTime() - 9 * D).toISOString());
    h.result(id, "Cara", "Bob", 1, 1, new Date(h.clock.now.getTime() - D).toISOString());
    expect(ladderTeamRecord(h.ladderOf(id), tid("Bob"))).toEqual({ played: 2, wins: 1, draws: 1, losses: 0 });
    // Blocked as challenger and as defender (a GET writes nothing: no task yet).
    expect(((await h.call("POST", `${base}/challenges`, coach("Bob"), { challengerTeamId: tid("Bob"), defenderTeamId: tid("Amy") })).body as { error: string }).error).toContain("must redraft");
    expect(((await h.call("POST", `${base}/challenges`, coach("Amy"), { challengerTeamId: tid("Amy"), defenderTeamId: tid("Bob") })).body as { error: string }).error).toContain("must redraft");
    expect(h.ladderOf(id).redraft).toBeUndefined();
    // The job hands Bob and Cara (2 games each; Amy has none) a task, once, and tells each coach with a Redraft mode link.
    const out = runLadderJob({ store: h.store, now: () => h.clock.now, notify: (c, i) => h.sent.push({ coach: c, input: i }) });
    expect(out.redrafts.sort()).toEqual([`${L}/${id}/${tid("Bob")}`, `${L}/${id}/${tid("Cara")}`]);
    expect(runLadderJob({ store: h.store, now: () => h.clock.now }).redrafts).toEqual([]);
    const st = h.ladderOf(id).redraft!;
    expect(st.window).toBeUndefined();
    expect(st.teams.map((t) => [t.teamId, t.status]).sort()).toEqual([[tid("Bob"), "pending"], [tid("Cara"), "pending"]]);
    // Budget from the games since joining: 1,000,000 base + 50k treasury + 2x20k games + 20k win + 10k draw.
    expect(st.teams.find((t) => t.teamId === tid("Bob"))!.budget.capped).toBe(1_120_000);
    const note = h.sent.find((s) => s.coach === "Bob" && s.input.title.includes("time to redraft"));
    expect(note?.input.link).toBe(`/app/tournament-team-builder/redraft/${L}?team=${encodeURIComponent(tid("Bob"))}&ladder=${id}`);
    // Redraft mode (?ladder=): only the coach (and organisers) see it.
    const rd = `/api/leagues/${L}/redraft/teams/${encodeURIComponent(tid("Bob"))}?ladder=${id}`;
    expect((await h.call("GET", rd, coach("Amy"))).status).toBe(403);
    const view = (await h.call("GET", rd, coach("Bob"))).body as { redraft: { revision: number; targetSeason: { id: string }; spendable: number } };
    expect(view.redraft.targetSeason.id).toBe(id);
    // Release one player, keep the rest: the team stays in the ladder, kept players keep their ids and ladder stats.
    const keep = keepAll.keep.filter((p) => p !== "p-t-bob-10");
    const sub = await h.call("POST", `${rd.split("?")[0]}/submit?ladder=${id}`, coach("Bob"), { revision: view.redraft.revision, ...keepAll, keep, hires: [{ position: "Lineman", count: 1 }] });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const after = h.ladderOf(id);
    const bob = after.teams.find((t) => t.id === tid("Bob"))!;
    expect(bob.players.slice(0, 10).map((p) => p.playerId)).toEqual(keep);
    expect(bob.players).toHaveLength(11);
    expect(bob.players[10]!.playerId).not.toBe("p-t-bob-10");
    expect(bob.players[0]!.stats.td).toBe(3);
    expect(bob.formerPlayers.map((p) => p.playerId)).toEqual(["p-t-bob-10"]);
    expect(bob.entryId).toBe("en-t-bob");
    expect(after.redraft!.teams.find((t) => t.teamId === tid("Bob"))!.status).toBe("submitted");
    expect(ladderTeamGamesSinceRedraft(after, tid("Bob"))).toBe(0);
    const again = await h.call("POST", `${base}/challenges`, coach("Bob"), { challengerTeamId: tid("Bob"), defenderTeamId: tid("Amy") });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("an organiser skipping the task lets the team carry on (its count restarts, no new task)", async () => {
    const h = harness();
    const id = await h.openLadder({ redraft: { trigger: "games", everyGames: 1 } });
    const bob = h.ladderOf(id).teams.find((t) => t.coach === "Bob")!.id;
    h.result(id, "Bob", "Amy", 1, 0, new Date(h.clock.now.getTime() - D).toISOString());
    runLadderJob({ store: h.store, now: () => h.clock.now });
    const board = `/api/leagues/${L}/redraft?ladder=${id}`;
    const read = (await h.call("GET", board, OLGA)).body as { redraft: { revision: number; ladder: { trigger: string }; active: Array<{ teamId: string; phase: string }> } };
    expect(read.redraft.ladder.trigger).toBe("games");
    expect(read.redraft.active.find((r) => r.teamId === bob)!.phase).toBe("not-started");
    expect((await h.call("POST", board, OLGA, { revision: read.redraft.revision, ladderId: id, action: "team", teamId: bob, skip: true })).status).toBe(200);
    expect(ladderTeamGamesSinceRedraft(h.ladderOf(id), bob)).toBe(0);
    expect(runLadderJob({ store: h.store, now: () => h.clock.now }).redrafts).toEqual([]);
  });
});

describe("period-end trigger and the organiser board", () => {
  it("a period end opens a redraft for every member; the board shows statuses, overrides and Lift to budget; the window job rebuilds in place", async () => {
    const h = harness();
    h.store.updateLeague(L, (l) => { l.redraftRules = { setBudget: 1_200_000, windowDays: 3 } as never; });
    const id = await h.openLadder({ periodDays: 14 });
    const start = Date.parse(h.ladderOf(id).ladder!.startedAt!);
    h.clock.now = new Date(start + 14 * D + 60_000);
    const sent: string[] = [];
    runLadderJob({ store: h.store, now: () => h.clock.now, notify: (c) => sent.push(c) });
    const st = h.ladderOf(id).redraft!;
    expect(st.teams.filter((t) => t.selected).length).toBe(3);
    expect(st.window!.openNotifiedAt).toBeDefined();
    expect(sent.sort()).toEqual(["Amy", "Bob", "Cara"]);
    // During the window a member's fixture can't be played (season and ladder redrafts alike).
    const bobTeam = h.ladderOf(id).teams.find((t) => t.coach === "Bob")!;
    const amyTeam = h.ladderOf(id).teams.find((t) => t.coach === "Amy")!;
    expect(fixturePlayBlock(h.store, L, id, { home: { team: bobTeam.name, teamId: bobTeam.id }, away: { team: amyTeam.name, teamId: amyTeam.id } } as never, h.clock.now)).toContain("redrafting");
    // The board: nobody earned the 1,200k set budget, but the league's lift toggle is off, so the organiser lifts by hand.
    const board = `/api/leagues/${L}/redraft?ladder=${id}`;
    const read = async () => ((await h.call("GET", board, OLGA)).body as { redraft: { revision: number; ladders: Array<{ id: string }>; active: Array<{ teamId: string; phase: string; liftApplies: boolean; spendable: number }> } }).redraft;
    let v = await read();
    expect(v.ladders.map((l) => l.id)).toEqual([id]);
    expect(v.active.every((r) => r.phase === "not-started" && r.liftApplies)).toBe(true);
    expect((await h.call("POST", board, OLGA, { revision: v.revision, ladderId: id, action: "lift", teamId: amyTeam.id })).status).toBe(200);
    v = await read();
    expect(v.active.find((r) => r.teamId === amyTeam.id)!.spendable).toBe(1_200_000);
    expect((await h.call("POST", board, OLGA, { revision: v.revision, ladderId: id, action: "team", teamId: bobTeam.id, override: { budget: 500_000, reason: "Fair play" } })).status).toBe(200);
    // Not the board of anyone but organisers; a stale revision is refused.
    expect((await h.call("GET", board, coach("Amy"))).status).toBe(403);
    expect((await h.call("POST", board, OLGA, { revision: 1, ladderId: id, action: "lift", all: true })).status).toBe(409);
    // The window closes: Amy and Cara are rebuilt in place, Bob (500k can't keep 11 players + rerolls) needs a redraft and is
    // blocked from challenges until he submits.
    h.clock.now = new Date(Date.parse(h.ladderOf(id).redraft!.window!.closesAt) + 60_000);
    const closed = runRedraftWindowJob({ store: h.store, now: () => h.clock.now, rollD6: () => 6 });
    expect(closed.closed).toEqual([{ leagueId: L, seasonId: id, rebuilt: [amyTeam.id, h.ladderOf(id).teams.find((t) => t.coach === "Cara")!.id].sort(), needsRedraft: [bobTeam.id] }]);
    const lad = h.ladderOf(id);
    expect(lad.teams.find((t) => t.id === amyTeam.id)!.players.map((p) => p.playerId)).toEqual(amyTeam.players.map((p) => p.playerId));
    expect(lad.ladder!.members.find((m) => m.teamId === amyTeam.id)!.redraftedAt).toBeDefined();
    expect(((await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Bob"), { challengerTeamId: bobTeam.id, defenderTeamId: amyTeam.id })).body as { error: string }).error).toContain("must finish its redraft");
    // Close from the board: Bob is skipped and carries on.
    v = await read();
    expect((await h.call("POST", board, OLGA, { revision: v.revision, ladderId: id, action: "close" })).status).toBe(200);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Bob"), { challengerTeamId: bobTeam.id, defenderTeamId: amyTeam.id })).status).toBe(201);
  });

  it("organisers can start a ladder redraft from the board; the league's redraft window gate never moves it; a ladder in setup has no board", async () => {
    const h = harness();
    const id = await h.openLadder();
    const board = `/api/leagues/${L}/redraft?ladder=${id}`;
    const v = ((await h.call("GET", board, OLGA)).body as { redraft: { revision: number; state: unknown; active: Array<{ teamId: string }> } }).redraft;
    expect(v.state).toBeNull();
    const teams = v.active.map((r) => ({ teamId: r.teamId, selected: true }));
    const ok = await h.call("POST", board, OLGA, { revision: 0, ladderId: id, action: "confirm", capEnabled: false, cap: 1_300_000, teams });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const st = h.ladderOf(id).redraft!;
    expect(st.targetSeasonId).toBe(id);
    expect(h.store.league(L)!.redraftCap).toBeUndefined();
    // A second confirm while it is open is refused.
    expect((await h.call("POST", board, OLGA, { revision: st.revision, ladderId: id, action: "confirm", capEnabled: false, teams })).status).toBe(409);
    // A league redraft-window gate only shapes the season redraft.
    const opens = st.window!.opensAt;
    h.store.putLeagueGates(L, { revision: 1, gates: [{ id: "redraft-window:league", kind: "redraft-window", target: "league", opensAt: "2027-01-01T19:00", armedAt: h.clock.now.toISOString(), state: "shut", revision: 1, createdAt: "", updatedAt: "" }] });
    syncGateTargets(h.store, L, h.clock.now);
    expect(h.ladderOf(id).redraft!.window!.opensAt).toBe(opens);
    // A ladder still in setup has no redraft board.
    const created = await h.call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "Autumn" });
    expect((await h.call("GET", `/api/leagues/${L}/redraft?ladder=${(created.body as { id: string }).id}`, OLGA)).status).toBe(404);
  });
});
