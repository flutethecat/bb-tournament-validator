import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resultSummaryOf, tabletopApi, type FixtureView, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { RecorderAnnouncement } from "../src/tabletop/discord.js";
import type { TabletopEvent } from "../src/tabletop/events.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { coinCallerOf } from "../src/tabletop/pregame.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { testingApi } from "../src/tabletop/testing.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

// Owner rulings 10-30 (spec docs/artifact-orchestration/spec-recorder-pregame-2026-10-30.md): random seats at creation
// with an organiser swap, the away coach calls the toss, the Discord result summary, and the read-only spectator view.

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let seatDraws: boolean[] = [];
let announced: RecorderAnnouncement[] = [];
let fixtures: Record<string, FixtureView> = {};
const files: Record<string, TabletopTeamFile> = {};

const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
  schema: 1, name, race: "Human", treasury: 50_000, dedicatedFans: 2, teamValue: 1_000_000,
  players: ["1", "2", "3"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
});

const deps = (): TabletopApiDeps => ({
  repo, results,
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  isBanned: (c) => c === "Banned",
  isOrganizer: (c) => c === "Org",
  now: () => new Date("2026-10-30T10:00:00.000Z"),
  rollDie: () => 1,
  // the seat draw, deterministic: each create takes the next answer (true = swap what the request named)
  drawSeats: () => seatDraws.shift() ?? false,
  announce: (a) => { announced.push(a); },
  fixtures: { get: (id) => fixtures[id], record: () => undefined, retract: () => undefined },
});
const as = async (coach: string | undefined, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  (await tabletopApi(method, path, coach ? { coach, method: "discord" } : undefined, body, deps(), new URLSearchParams()))!;
const create = (body: Record<string, unknown> = {}, who = "Alice") =>
  as(who, "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "none", ...body });
const idOf = (r: TabletopResult): string => (r.body as { match: { id: string } }).match.id;
const events = async (id: string) => (await repo.readEvents(id)) as TabletopEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-rulings-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  seatDraws = [];
  announced = [];
  fixtures = {};
  files["Alice/sv_a"] = mkTeam("Alice XI", "a");
  files["Bob/sv_b"] = mkTeam("Bob XI", "b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ruling 3: home and away are drawn when the match is created", () => {
  it("a draw of 'swap' seats the named teams the other way round, and the log records the draw", async () => {
    seatDraws = [true];
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ match: { home: { coach: "Bob", teamSaveId: "sv_b", teamName: "Bob XI" }, away: { coach: "Alice", teamSaveId: "sv_a" } } });
    const [seats] = await events(idOf(r));
    expect(seats).toMatchObject({ id: "pg-seats", type: "seats", by: "Alice", payload: { stage: "draw", swapped: true, rolledBy: "site", home: { coach: "Bob", teamName: "Bob XI" }, away: { coach: "Alice", teamName: "Alice XI" } } });
  });

  it("the default draw is random: both orders turn up over many creates", async () => {
    const seen = new Set<string>();
    const d = { ...deps() };
    delete d.drawSeats;
    for (let i = 0; i < 40 && seen.size < 2; i += 1) {
      const r = (await tabletopApi("POST", "/api/tabletop/matches", { coach: "Alice", method: "discord" }, { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } }, d, new URLSearchParams()))!;
      expect(r.status).toBe(201);
      seen.add((r.body as { match: { home: { coach: string } } }).match.home.coach);
      await repo.deleteMatch(idOf(r));
    }
    expect([...seen].sort()).toEqual(["Alice", "Bob"]);
  });

  it("test matches are drawn too; a fixture match records which way round it was played", async () => {
    seatDraws = [true];
    const t = (await testingApi("POST", "/api/admin/testing/tabletop-match", new URLSearchParams(), { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } }, { me: "Org" }, deps()))!;
    expect(t.status).toBe(201);
    const test = (await repo.getMatch((t.body as { matchId: string }).matchId))!;
    expect(test).toMatchObject({ test: true, home: { coach: "Bob" }, away: { coach: "Alice" } });
    await repo.deleteMatch(test.id);
    fixtures["cup:round:1:match:1"] = { id: "cup:round:1:match:1", open: true, status: "scheduled", revision: 1, home: { coach: "Alice" }, away: { coach: "Bob" }, tournament: { id: "cup", name: "Cup" } };
    seatDraws = [true];
    const f = await create({ fixtureRef: "cup:round:1:match:1" });
    expect(f.body).toMatchObject({ match: { home: { coach: "Bob" }, away: { coach: "Alice" }, fixtureSwap: true } });
  });

  it("an organiser swaps the seats before the pre-game starts (logged); a coach cannot; not once the fans are rolled", async () => {
    fixtures["cup:round:1:match:1"] = { id: "cup:round:1:match:1", open: true, status: "scheduled", revision: 1, home: { coach: "Alice" }, away: { coach: "Bob" }, tournament: { id: "cup", name: "Cup" } };
    const id = idOf(await create({ fixtureRef: "cup:round:1:match:1" }));
    const before = (await repo.getMatch(id))!;
    expect(before.fixtureSwap).toBeUndefined();
    expect((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body).toMatchObject({ pregame: { step: "fans", seatsSwappable: true } });
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/seats/swap`, {})).status).toBe(403);
    const r = await as("Org", "POST", `/api/tabletop/matches/${id}/seats/swap`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ recorded: ["pg-seatswap-1"], match: { home: { coach: "Bob" }, away: { coach: "Alice" }, fixtureSwap: true, baseRevision: { home: before.baseRevision.away, away: before.baseRevision.home } } });
    expect((await events(id)).at(-1)).toMatchObject({ id: "pg-seatswap-1", type: "seats", by: "Org", admin: true, payload: { stage: "swap", home: { coach: "Bob" }, away: { coach: "Alice" } } });
    // swapping back clears the fixture orientation again
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/seats/swap`, {})).body).toMatchObject({ recorded: ["pg-seatswap-2"], match: { home: { coach: "Alice" } } });
    expect((await repo.getMatch(id))!.fixtureSwap).toBeUndefined();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/pregame/advance`, {})).status).toBe(200); // fans rolled
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/seats/swap`, {})).status).toBe(409);
    expect((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body).toMatchObject({ pregame: { seatsSwappable: false } });
  });
});

describe("ruling 3: the away coach calls the toss", () => {
  it("coinCallerOf: away, unless an old match recorded a drawn caller", () => {
    expect(coinCallerOf([])).toBe("away");
    expect(coinCallerOf([{ id: "pg-coincaller", payload: { caller: "home" } } as unknown as TabletopEvent])).toBe("home");
  });

  it("after a swap the new away coach calls", async () => {
    const id = idOf(await create());
    await as("Org", "POST", `/api/tabletop/matches/${id}/seats/swap`, {});
    for (let i = 0; i < 3; i += 1) await as("Alice", "POST", `/api/tabletop/matches/${id}/pregame/advance`, {});
    for (const team of ["home", "away"]) await as("Alice", "POST", `/api/tabletop/matches/${id}/pregame/advance`, { team, skip: true });
    expect((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body).toMatchObject({ phase: "pregame:coin", pregame: { coin: { caller: "away" } } });
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/pregame/advance`, { mode: "auto", call: "heads" })).status).toBe(403); // Bob is home now
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/pregame/advance`, { mode: "auto", call: "heads" })).status).toBe(200);
    expect((await events(id)).some((e) => e.id === "pg-coincaller")).toBe(false);
  });
});

describe("ruling 7: the read-only spectator view", () => {
  it("a signed-in stranger reads with role spectator and gets 403 on every write; anonymous only for a match that is not a test match", async () => {
    const id = idOf(await create({ pregame: "skip" }));
    const view = await as("Mallory", "GET", `/api/tabletop/matches/${id}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ role: "spectator", match: { id }, phase: "playing", tally: { score: { home: 0, away: 0 } } });
    for (const p of ["events", "submit", "confirm", "publish", "undo-revision", "resolve-conflict", "pregame/advance", "pregame/skip", "seats/swap", "turn/start", "turn/end", "turn/set"])
      expect((await as("Mallory", "POST", `/api/tabletop/matches/${id}/${p}`, {})).status, p).toBe(403);
    expect((await as(undefined, "GET", `/api/tabletop/matches/${id}`)).body).toMatchObject({ role: "spectator" });
    expect((await as(undefined, "POST", `/api/tabletop/matches/${id}/events`, {})).status).toBe(401);
    // a non-Discord session reads like an anonymous visitor and never writes
    const pw = (method: string, sub = "") => tabletopApi(method, `/api/tabletop/matches/${id}${sub}`, { coach: "Pw", method: "password" }, {}, deps(), new URLSearchParams());
    expect((await pw("GET"))!.body).toMatchObject({ role: "spectator" });
    expect((await pw("POST", "/events"))!.status).toBe(403);
    // a banned coach does not get the read either
    expect((await tabletopApi("GET", `/api/tabletop/matches/${id}`, { coach: "Banned", method: "password" }, undefined, deps(), new URLSearchParams()))!.status).toBe(403);
    // a test match: signed-in coaches may watch it, anonymous visitors may not
    await repo.updateMatch({ ...(await repo.getMatch(id))!, test: true });
    expect((await as("Mallory", "GET", `/api/tabletop/matches/${id}`)).body).toMatchObject({ role: "spectator" });
    expect((await as(undefined, "GET", `/api/tabletop/matches/${id}`)).status).toBe(401);
    expect((await as(undefined, "GET", "/api/tabletop/matches/tm_nope")).status).toBe(401);
  });

  it("the spectator's list of matches stays their own", async () => {
    await create({ pregame: "skip" });
    expect((await as("Mallory", "GET", "/api/tabletop/matches")).body).toEqual({ matches: [] });
  });
});

describe("ruling 6: the final result goes to Discord once the match is confirmed", () => {
  it("both confirmations announce one result summary (scorers, casualties, MVPs, concession); nothing before", async () => {
    const id = idOf(await create({ pregame: "skip", postMatch: "spp-only" }));
    const post = (who: string, evs: unknown[]) => as(who, "POST", `/api/tabletop/matches/${id}/events`, { events: evs });
    const first = await post("Alice", [
      { id: "res-td-000001", type: "touchdown", team: "home", player: "a1", payload: {} },
      { id: "res-td-000002", type: "touchdown", team: "home", player: "a1", payload: {} },
      { id: "res-cas-00001", type: "casualty", team: "home", player: "a2", payload: { victim: "b1", result: "DEAD", cause: "block" } },
      { id: "res-mvp-00001", type: "mvp", team: "home", player: "a3", payload: {} },
    ]);
    expect(first.body).toMatchObject({ accepted: ["res-td-000001", "res-td-000002", "res-cas-00001", "res-mvp-00001"] });
    expect((await post("Bob", [{ id: "res-con-00001", type: "concede", team: "away", payload: {} }])).status).toBe(200);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`)).status).toBe(200);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    expect(announced.filter((a) => a.kind === "result")).toHaveLength(0); // one confirmation is not final
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    const res = announced.filter((a) => a.kind === "result");
    expect(res).toHaveLength(1);
    expect(res[0]!.match).toMatchObject({ id, state: "confirmed" });
    expect(res[0]!.result).toEqual({
      home: { score: 2, casualties: { bh: 0, si: 0, rip: 1 }, conceded: false, scorers: [{ name: "a 1", touchdowns: 2 }], mvps: ["a 3"] },
      away: { score: 0, casualties: { bh: 0, si: 0, rip: 0 }, conceded: true, scorers: [], mvps: [] },
    });
  });

  it("an organiser's confirm-and-publish announces too; a failing announcer never fails the confirmation", async () => {
    const id = idOf(await create({ pregame: "skip" }));
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`)).status).toBe(200);
    const bulk = await as("Org", "POST", "/api/tabletop/organiser/bulk", { ids: [id], action: "confirm-publish" });
    expect(bulk.body).toMatchObject({ results: [{ id, ok: true, state: "published" }] });
    expect(announced.filter((a) => a.kind === "result").map((a) => a.match.id)).toEqual([id]);

    files["Carol/sv_c"] = mkTeam("Carol XI", "c");
    files["Dave/sv_d"] = mkTeam("Dave XI", "d");
    const id2 = idOf(await as("Org", "POST", "/api/tabletop/matches", { pregame: "skip", postMatch: "none", home: { coach: "Carol", team: "sv_c" }, away: { coach: "Dave", team: "sv_d" } }));
    const boom = { ...deps(), announce: () => { throw new Error("discord down"); } };
    const call = (who: string, sub: string) => tabletopApi("POST", `/api/tabletop/matches/${id2}/${sub}`, { coach: who, method: "discord" }, {}, boom, new URLSearchParams());
    expect((await call("Carol", "submit"))!.status).toBe(200);
    expect((await call("Org", "confirm"))!.status).toBe(200);
  });

  it("resultSummaryOf names players from the rosters and ignores undone events", () => {
    const ev = (id: string, type: string, team: "home" | "away", player?: string, payload: Record<string, unknown> = {}) =>
      ({ id, matchId: "m", type, team, ...(player ? { player } : {}), payload, ts: "t", by: "x" }) as TabletopEvent;
    const out = resultSummaryOf([
      ev("t1", "touchdown", "away", "b2"), ev("t2", "touchdown", "away", "b2"), ev("u1", "undo", "away", undefined, { target: "t2" }),
    ], { home: mkTeam("Alice XI", "a"), away: mkTeam("Bob XI", "b") });
    expect(out.away).toMatchObject({ score: 1, scorers: [{ name: "b 2", touchdowns: 1 }] });
    expect(out.home.score).toBe(0);
  });
});
