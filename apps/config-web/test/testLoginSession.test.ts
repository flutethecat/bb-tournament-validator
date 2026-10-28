import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeElo } from "../src/coachElo.js";
import { createSession, getSession, reloadSessionStore } from "../src/auth/session.js";
import { tabletopApi, type TabletopApiDeps } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { leagueStandings } from "../src/tabletop/standings.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
const files: Record<string, TabletopTeamFile> = {};
const team = (prefix: string): TabletopTeamFile => ({
  schema: 1, name: `${prefix} XI`, race: "Human", treasury: 0, dedicatedFans: 1, teamValue: 1_000_000,
  players: Array.from({ length: 11 }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
});
const deps = (): TabletopApiDeps => ({
  repo, results,
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  listSaves: () => [],
  listTeams: () => [],
  isBanned: () => false,
  isOrganizer: (c) => c === "Org",
  now: () => new Date("2026-03-01T10:00:00.000Z"),
  rollDie: () => 1,
});
const body = { home: { coach: "Alice", team: "save:sv_a" }, away: { coach: "Bob", team: "save:sv_b" }, postMatch: "none" };
const api = (method: string, path: string, who: string, test: boolean, payload?: unknown) =>
  tabletopApi(method, path, { coach: who, method: "discord", ...(test ? { test: true } : {}) }, payload, deps(), new URLSearchParams()).then((r) => r!);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "test-login-session-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  files["Alice/sv_a"] = team("a");
  files["Bob/sv_b"] = team("b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => { delete process.env.SESSIONS_FILE; });

describe("test sessions and the tabletop", () => {
  it("a test session's created match is stored test:true and its published result never counts", async () => {
    const created = await api("POST", "/api/tabletop/matches", "Alice", true, body);
    expect(created.status).toBe(201);
    const id = (created.body as { match: { id: string } }).match.id;
    expect((await repo.getMatch(id))!.test).toBe(true);
    await api("POST", `/api/tabletop/matches/${id}/events`, "Alice", true, { events: [{ id: "tst-evt-0001", type: "touchdown", team: "home", player: "a1" }] });
    const row = await repo.getMatch(id);
    expect(row!.test).toBe(true);
    expect(results.list()).toEqual([]);
    expect(leagueStandings(results.list(), "x", () => undefined)).toEqual([]);
    expect(computeElo(results.list()).size).toBe(0);
  });

  it("a normal session's match is not flagged; a test session cannot link a fixture", async () => {
    const real = await api("POST", "/api/tabletop/matches", "Alice", false, body);
    expect((await repo.getMatch((real.body as { match: { id: string } }).match.id))!.test).toBeUndefined();
    const fixture = await api("POST", "/api/tabletop/matches", "Alice", true, { ...body, fixtureRef: "cup:round:1:match:1" });
    expect(fixture.status).toBe(400);
  });
});

describe("sessions.json round trip", () => {
  it("keeps the test marker across a reload, and leaves ordinary sessions unmarked", () => {
    process.env.SESSIONS_FILE = join(mkdtempSync(join(tmpdir(), "sess-")), "sessions.json");
    reloadSessionStore(1000);
    const t = createSession("Tess", 1000, "discord", { test: true });
    const r = createSession("Real", 1000, "discord");
    reloadSessionStore(2000);
    expect(getSession(t.token, 2000)).toMatchObject({ coach: "Tess", method: "discord", test: true });
    expect(getSession(r.token, 2000)!.test).toBeUndefined();
  });
});
