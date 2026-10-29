import { describe, expect, it } from "vitest";
import {
  createGameDetailLoader, maySeePlayerLines, PLAYER_LINES_PRIVATE_NOTE, publicPlayerLinesFromEnv, withoutPlayerLines,
  type GameFixture, type GameStores, type GameTabletopReader,
} from "../src/gameDetailLoader";

// The public game-page read side (src/gameDetailLoader.ts): targeted lookups, ineligible matches rejected before their
// event log is read, a revision-keyed bounded cache with coalesced loads, and the GAME_PAGES_PUBLIC_PLAYER_LINES flag.

const coach = (id: string) => ({ coachId: id, ffbCoachId: id, verifiedAt: "x" });
const fixtureRec = (id: string, extra: Record<string, unknown> = {}) => ({
  id, tournamentId: "t1", roundId: "r1", roundNumber: 1, status: "completed", revision: 1,
  home: { entrantId: "e1", coach: coach("Carol"), teamId: "tc" }, away: { entrantId: "e2", coach: coach("Dan"), teamId: "td" },
  launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
  result: { homeScore: 1, awayScore: 0, reportedAt: "2026-10-10T00:00:00.000Z" }, createdAt: "x", updatedAt: "x", ...extra,
});
const match = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, state, home: { coach: "Eve", teamSaveId: "s1", teamName: "Owls" }, away: { coach: "Finn", teamSaveId: "s2", teamName: "Rats" },
  postMatch: "none", createdBy: "Eve", createdAt: "x", updatedAt: "2026-10-20T00:00:00.000Z", confirmations: {}, baseRevision: { home: 0, away: 0 }, ...extra,
});
const ev = (id: string, type: string, team: "home" | "away", extra: Record<string, unknown> = {}) =>
  ({ id, matchId: "m", type, team, payload: {}, by: "Eve", ts: "2026-10-21T10:00:00.000Z", ...extra });
const forkRow = (gameId: string, extra: Record<string, unknown> = {}) => ({
  gameId, pulledAt: "2026-10-01T00:00:00.000Z", home: { teamId: "h", teamName: "Reavers", coach: "Alice" }, away: { teamId: "a", teamName: "Grinders", coach: "Bob" },
  teams: [
    { teamId: "h", score: 1, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [{ playerId: "p", name: "Grak", touchdowns: 1, casualtiesCaused: 0, blocks: 0, fouls: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 1 }] },
    { teamId: "a", score: 0, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [] },
  ],
  ...extra,
});

function rig(opts: { matches?: unknown[]; events?: Record<string, unknown[]>; fixtures?: Record<string, unknown>; results?: Record<string, unknown> } = {}) {
  const n = { revision: 0, fixture: 0, fixtureForGame: 0, result: 0, tabletop: 0, getMatch: 0, listMatches: 0, readEvents: 0, getChain: 0 };
  let rev = "r1";
  const matches = (opts.matches ?? []) as Array<{ id: string }>;
  const reader: GameTabletopReader = {
    getMatch: async (id) => { n.getMatch += 1; return matches.find((m) => m.id === id) as never; },
    listMatches: async () => { n.listMatches += 1; return matches as never; },
    readEvents: async (id) => { n.readEvents += 1; return (opts.events?.[id] ?? []) as never; },
    getChain: async () => { n.getChain += 1; return undefined; },
  };
  const fixtureOf = (m: unknown): GameFixture => ({ id: "t1", name: "Cup", entrants: [], matches: [m as never], managers: ["Org"] });
  const stores: GameStores = {
    revision: () => { n.revision += 1; return rev; },
    fixture: (id) => { n.fixture += 1; const m = opts.fixtures?.[id]; return m ? fixtureOf(m) : undefined; },
    fixtureForGame: () => { n.fixtureForGame += 1; return undefined; },
    result: (id) => { n.result += 1; return opts.results?.[id] as never; },
    tabletop: async () => { n.tabletop += 1; return reader; },
  };
  return { n, stores, bump: (r: string) => { rev = r; } };
}

describe("game detail loader: bounded reads", () => {
  it("unknown ids: one targeted lookup each, then served from the cache (404s included)", async () => {
    const { n, stores } = rig({ matches: [match("tm1", "confirmed")] });
    const loader = createGameDetailLoader(stores);
    for (let i = 0; i < 5; i++) {
      expect(await loader.load("tabletop", "nope")).toBeUndefined();
      expect(await loader.load("tournament", "nope")).toBeUndefined();
      expect(await loader.load("online", "nope")).toBeUndefined();
    }
    expect(n).toMatchObject({ getMatch: 1, readEvents: 0, getChain: 0, listMatches: 0, fixture: 1, result: 1 });
    expect(n.tabletop).toBe(1); // an unknown fixture never opens the recorder
  });

  it("a still-recording or test match is rejected from its record, before its events or team chains are read", async () => {
    const { n, stores } = rig({ matches: [match("live", "recording"), match("tst", "published", { test: true })], events: { live: [ev("1", "touchdown", "home", { player: "p" })] } });
    const loader = createGameDetailLoader(stores);
    expect(await loader.load("tabletop", "live")).toBeUndefined();
    expect(await loader.load("tabletop", "tst")).toBeUndefined();
    expect(n).toMatchObject({ getMatch: 2, readEvents: 0, getChain: 0 });
  });

  it("repeated and concurrent requests read the game once; a store revision change or the TTL reloads it", async () => {
    let clock = 1_000;
    const { n, stores, bump } = rig({ matches: [match("tm1", "confirmed")], events: { tm1: [ev("1", "touchdown", "home", { player: "p" })] } });
    const loader = createGameDetailLoader(stores, { ttlMs: 60_000, now: () => clock });
    const all = await Promise.all(Array.from({ length: 5 }, () => loader.load("tabletop", "tm1")));
    expect(all.every((g) => g?.detail.card.home.score === 1)).toBe(true);
    for (let i = 0; i < 5; i++) await loader.load("tabletop", "tm1");
    expect(n).toMatchObject({ getMatch: 1, readEvents: 1, getChain: 2 });
    bump("r2");
    await loader.load("tabletop", "tm1");
    expect(n.readEvents).toBe(2);
    clock += 61_000;
    await loader.load("tabletop", "tm1");
    expect(n.readEvents).toBe(3);
  });

  it("fixtures find their recorded tabletop match through an index listed at most once per TTL", async () => {
    const { n, stores } = rig({
      matches: [match("a", "published", { fixtureRef: "f1" }), match("b", "recording", { fixtureRef: "f2" })],
      fixtures: { f1: fixtureRec("f1"), f2: fixtureRec("f2"), f3: fixtureRec("f3") },
    });
    const loader = createGameDetailLoader(stores);
    const f1 = await loader.load("tournament", "f1");
    expect(f1?.detail.reporter?.matchId).toBe("a");
    expect((await loader.load("tournament", "f2"))?.detail.reporter).toBeUndefined(); // still recording: never indexed
    await loader.load("tournament", "f3");
    expect(n).toMatchObject({ listMatches: 1, getMatch: 1, readEvents: 1 });
  });

  it("the cache is bounded", async () => {
    const { stores } = rig();
    const loader = createGameDetailLoader(stores, { max: 3 });
    for (let i = 0; i < 10; i++) await loader.load("online", `g${i}`);
    expect(loader.size()).toBe(3);
  });

  it("access: participants and the tournament's managers", async () => {
    const { stores } = rig({ fixtures: { f1: fixtureRec("f1") }, results: { g1: forkRow("g1") } });
    const loader = createGameDetailLoader(stores);
    expect((await loader.load("tournament", "f1"))?.access).toEqual({ coaches: ["carol", "dan"], managers: ["org"] });
    expect((await loader.load("online", "g1"))?.access).toEqual({ coaches: ["alice", "bob"], managers: [] });
  });
});

describe("GAME_PAGES_PUBLIC_PLAYER_LINES", () => {
  it("defaults on; false / 0 / no / off turn it off", () => {
    expect(publicPlayerLinesFromEnv(undefined)).toBe(true);
    expect(publicPlayerLinesFromEnv("")).toBe(true);
    expect(publicPlayerLinesFromEnv("true")).toBe(true);
    for (const off of ["false", "FALSE", "0", "no", " off "]) expect(publicPlayerLinesFromEnv(off)).toBe(false);
  });

  it("on: everyone sees player lines; off: only signed-in participants, tournament managers and site organisers", () => {
    const access = { coaches: ["alice", "bob"], managers: ["org"] };
    const siteOrg = (c: string) => c === "Admin";
    expect(maySeePlayerLines(true, access, undefined, siteOrg)).toBe(true);
    expect(maySeePlayerLines(false, access, undefined, siteOrg)).toBe(false);
    expect(maySeePlayerLines(false, access, "Mallory", siteOrg)).toBe(false);
    expect(maySeePlayerLines(false, access, "ALICE", siteOrg)).toBe(true);
    expect(maySeePlayerLines(false, access, "Org", siteOrg)).toBe(true);
    expect(maySeePlayerLines(false, access, "Admin", siteOrg)).toBe(true);
  });

  it("the redacted answer keeps scores, casualties, concession and MVP names, and drops every player line", async () => {
    const { stores } = rig({
      matches: [match("tm1", "confirmed")],
      events: { tm1: [ev("1", "touchdown", "home", { player: "p", half: 1, turn: 2 }), ev("2", "mvp", "home", { player: "p" }), ev("3", "concede", "away")] },
      results: { g1: forkRow("g1") },
    });
    const loader = createGameDetailLoader(stores);
    const full = (await loader.load("tabletop", "tm1"))!.detail;
    expect(full.summary.home!.players.length).toBe(1);
    const red = withoutPlayerLines(full);
    expect(red.card).toEqual(full.card);
    expect(red.summary).toMatchObject({ perPlayer: false, note: PLAYER_LINES_PRIVATE_NOTE, casualties: full.summary.casualties, concede: "away" });
    expect(red.summary.home).toMatchObject({ mvps: ["p"], scorers: [], casualtyMakers: [], players: [] });
    expect(red.reporter!.moments).toEqual([{ half: 1, turn: 2, side: "home", kind: "touchdown", text: "Touchdown: Owls" }]);
    const online = withoutPlayerLines((await loader.load("online", "g1"))!.detail);
    expect(online.summary.home).toMatchObject({ mvps: ["Grak"], scorers: [], players: [] });
    expect(JSON.stringify(online.summary)).not.toContain('"touchdowns"');
  });
});
