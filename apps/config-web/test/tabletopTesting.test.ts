import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeElo } from "../src/coachElo.js";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { tabletopApi, type TabletopApiDeps } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { leagueStandings } from "../src/tabletop/standings.js";
import { parseDefaultSide, testingApi } from "../src/tabletop/testing.js";
import { createSave } from "../src/teamBuilderSaves.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

// ---- the suite's logic ----------------------------------------------------------------------------------------
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
  listSaves: (c) => (c === "Alice" ? [{ id: "sv_a", name: "Alice XI" }] : []),
  listTeams: (c) => (c === "Alice" ? [{ ref: "library:77", name: "Alice Lib", race: "Human", tv: 1000 }, { ref: "sv_a", name: "Alice XI", race: "Human", tv: null }] : []),
  isBanned: () => false,
  drawSeats: () => false, isOrganizer: (c) => c === "Org",
  now: () => new Date("2026-03-01T10:00:00.000Z"),
  rollDie: () => 1,
});
const T = (method: string, path: string, body?: unknown, query = "") =>
  testingApi(method, path, new URLSearchParams(query), body, { me: "Org", env: {} }, deps(), () => new Date("2026-03-01T10:00:00.000Z")).then((r) => r!);
const sides = { home: { coach: "Alice", team: "save:sv_a" }, away: { coach: "Bob", team: "save:sv_b" } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-testing-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  files["Alice/sv_a"] = team("a");
  files["Bob/sv_b"] = team("b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("testing suite routes", () => {
  it("lists its tools, and a coach's teams for the pickers", async () => {
    const tools = (await T("GET", "/api/admin/testing/tools")).body as { tools: Array<{ id: string }> };
    expect(tools.tools.map((t) => t.id)).toEqual(["tabletop-test-match"]);
    expect((await T("GET", "/api/admin/testing/teams", undefined, "coach=Alice")).body).toEqual({
      coach: "Alice", teams: [{ ref: "library:77", name: "Alice Lib", race: "Human", tv: 1000 }, { ref: "sv_a", name: "Alice XI", race: "Human", tv: null }],
    });
    expect((await T("GET", "/api/admin/testing/teams")).status).toBe(400);
  });

  it("defaults come from TABLETOP_TEST_HOME / TABLETOP_TEST_AWAY (never hard-coded), else null", async () => {
    const run = (env: Record<string, string | undefined>) =>
      testingApi("GET", "/api/admin/testing/tabletop-defaults", new URLSearchParams(), undefined, { me: "Org", env }, deps()).then((r) => r!.body);
    expect(await run({})).toEqual({ defaults: null });
    expect(await run({ TABLETOP_TEST_HOME: "Alice|library:77" })).toEqual({ defaults: null }); // both are needed
    expect(await run({ TABLETOP_TEST_HOME: "Alice|library:77", TABLETOP_TEST_AWAY: "Bob|save:sv_b" })).toEqual({
      defaults: { home: { coach: "Alice", team: "library:77" }, away: { coach: "Bob", team: "save:sv_b" } },
    });
    expect(await run({ TABLETOP_TEST_HOME: "garbage", TABLETOP_TEST_AWAY: "Bob|save:sv_b" })).toEqual({ defaults: null });
    expect(parseDefaultSide("Some Coach|sv_x")).toEqual({ coach: "Some Coach", team: "save:sv_x" });
    expect(parseDefaultSide("|library:1")).toBeUndefined();
  });

  it("creates a flagged test match like the normal route (skip pre-game: playing at once) and returns its URL", async () => {
    const r = await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "skip", postMatch: "full" });
    expect(r.status).toBe(201);
    const { matchId, url } = r.body as { matchId: string; url: string };
    expect(url).toBe(`/app/tabletop/${matchId}`);
    const m = (await repo.getMatch(matchId))!;
    expect(m).toMatchObject({ test: true, phase: "playing", postMatch: "full", createdBy: "Org", home: { coach: "Alice" } });
    expect(m.fixtureRef).toBeUndefined();
  });

  it("full pre-game starts at pregame:fans; a preset turn timer skips the timers question and engages", async () => {
    const full = await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "full" });
    const id = (full.body as { matchId: string }).matchId;
    expect((await repo.getMatch(id))!.phase).toBe("pregame:fans");
    await repo.updateMatch({ ...(await repo.getMatch(id))!, state: "confirmed" });
    const timed = await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "full", turnTimer: { mode: "on", seconds: 90 } });
    const tid = (timed.body as { matchId: string }).matchId;
    const advance = (body?: unknown, coach = "Alice") => tabletopApi("POST", `/api/tabletop/matches/${tid}/pregame/advance`, { coach, method: "discord" }, body, deps(), new URLSearchParams());
    for (let i = 0; i < 3; i += 1) await advance();
    await advance({ team: "home", skip: true });
    await advance({ team: "away", skip: true });
    // the away coach (Bob) calls; tails called, heads shown: home (Alice) wins and receives
    await advance({ mode: "hand", call: "tails", caller: "away", result: "heads", winner: "home" }, "Bob");
    const coin = await advance({ choice: "receive" });
    expect(coin!.body).toMatchObject({ phase: "playing", clock: { activeTeam: "home", turnTimer: { mode: "on", seconds: 90 } } });
    const skipTimed = await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "skip", turnTimer: { mode: "on", seconds: 60 } });
    expect(skipTimed.status).toBe(409); // the teams are still in the unfinished timed match: same validation as the normal route
  });

  it("validates like the normal route: bad teams, bad options, no fixtures", async () => {
    expect((await T("POST", "/api/admin/testing/tabletop-match", { home: sides.home })).status).toBe(400);
    expect((await T("POST", "/api/admin/testing/tabletop-match", { home: sides.home, away: { coach: "Bob", team: "save:nope" } })).status).toBe(404);
    expect((await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "maybe" })).status).toBe(400);
    expect((await T("POST", "/api/admin/testing/tabletop-match", { ...sides, postMatch: "everything" })).status).toBe(400);
    expect((await T("POST", "/api/admin/testing/tabletop-match", { ...sides, turnTimer: { mode: "off" } })).status).toBe(400);
    expect((await T("POST", "/api/admin/testing/tabletop-match", { ...sides, turnTimer: { mode: "on", seconds: 5 } })).status).toBe(400);
    expect((await T("POST", "/api/admin/testing/tabletop-match", { ...sides, fixtureRef: "cup:round:1:match:1" })).status).toBe(400);
  });

  it("a published test match never reaches standings, Elo or the counted results", async () => {
    const r = await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "skip", postMatch: "none" });
    const id = (r.body as { matchId: string }).matchId;
    const api = (who: string, path: string, body?: unknown) => tabletopApi("POST", `/api/tabletop/matches/${id}/${path}`, { coach: who, method: "discord" }, body, deps(), new URLSearchParams());
    await api("Alice", "events", { events: [{ id: "tst-evt-0001", type: "touchdown", team: "home", player: "a1" }] });
    await api("Alice", "submit");
    expect((await api("Org", "confirm"))!.status).toBe(200);
    expect((await api("Org", "publish"))!.status).toBe(200);
    expect((await repo.getMatch(id))!.state).toBe("published");
    expect(results.listAll()).toHaveLength(1);
    expect(results.listAll()[0]).toMatchObject({ test: true, published: true, source: "tabletop" });
    expect(results.list()).toEqual([]);
    expect(leagueStandings(results.list(), "anything", () => undefined)).toEqual([]);
    expect(computeElo(results.list()).size).toBe(0);
  });

  it("purge removes test matches (and their result rows) and leaves real matches alone", async () => {
    files["Carol/sv_c"] = team("c");
    files["Dave/sv_d"] = team("d");
    const test = (await T("POST", "/api/admin/testing/tabletop-match", { ...sides, pregame: "skip", postMatch: "none" })).body as { matchId: string };
    const real = await tabletopApi("POST", "/api/tabletop/matches", { coach: "Carol", method: "discord" }, {
      pregame: "skip", home: { coach: "Carol", team: "sv_c" }, away: { coach: "Dave", team: "sv_d" },
    }, deps(), new URLSearchParams());
    const realId = (real!.body as { match: { id: string } }).match.id;
    expect((await repo.getMatch(realId))!.test).toBeUndefined();
    const api = (who: string, path: string, body?: unknown) => tabletopApi("POST", `/api/tabletop/matches/${test.matchId}/${path}`, { coach: who, method: "discord" }, body, deps(), new URLSearchParams());
    await api("Alice", "submit");
    await api("Org", "confirm"); // writes the (flagged, uncounted) result row
    expect(results.listAll()).toHaveLength(1);
    const purged = await T("DELETE", "/api/admin/testing/tabletop-matches");
    expect(purged.body).toEqual({ purged: 1 });
    expect(await repo.getMatch(test.matchId)).toBeUndefined();
    expect(await repo.readEvents(test.matchId)).toEqual([]);
    expect(results.listAll()).toEqual([]);
    expect(await repo.getMatch(realId)).toBeDefined();
    expect((await T("DELETE", "/api/admin/testing/tabletop-matches")).body).toEqual({ purged: 0 });
    expect((await T("GET", "/api/admin/testing/tabletop-matches")).status).toBe(405);
  });
});

// ---- the HTTP gate (live host mode: legacy admin password, sidecar off) ----------------------------------------
const root = mkdtempSync(join(tmpdir(), "testing-suite-routes-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "",
    ADMIN_PASSWORD: "admin-secret",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
    TABLETOP_TEST_HOME: "TsAlice|save:PLACEHOLDER",
    TABLETOP_TEST_AWAY: "TsBob|library:4242",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "packages", "tournaments", "state", "saves"]) mkdirSync(join(root, d), { recursive: true });
  const organizer = (id: string) => ({ ffbCoachId: id, level: "organizer", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "2026-08-27T00:00:00.000Z", updatedBy: "Root" });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: { tsorg: organizer("TsOrg") } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  const saveIds: Record<string, string> = {};
  for (const coach of ["TsAlice", "TsBob"]) {
    const made = createSave({ dir: join(root, "saves"), raceNameFor: () => "Human" }, coach, {
      name: `${coach} XI`, body: { rosterId: "human", picks: [{ positionId: "human.human_lineman", count: 11 }] },
    });
    if (!made.ok) throw new Error(made.error);
    saveIds[coach] = made.save.id;
  }
  process.env.TABLETOP_TEST_HOME = `TsAlice|save:${saveIds.TsAlice}`;
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as { __saveIds?: Record<string, string> }).__saveIds = saveIds;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

const cookie = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}`;
const basic = `Basic ${Buffer.from("admin:admin-secret").toString("base64")}`;
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("testing suite HTTP gate", () => {
  it("401 anonymous (JSON), 403 for a signed-in non-organiser, 200 for an organiser session or the admin password", async () => {
    const anon = await call("GET", "/api/admin/testing/tools", {});
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBeNull();
    expect((await call("GET", "/api/admin/testing/tools", { cookie: cookie("TsAlice") })).status).toBe(403);
    expect((await call("POST", "/api/admin/testing/tabletop-match", { cookie: cookie("TsAlice"), "x-cw-auth": "1" }, {})).status).toBe(403);
    expect((await call("DELETE", "/api/admin/testing/tabletop-matches", { cookie: cookie("TsAlice"), "x-cw-auth": "1" })).status).toBe(403);
    expect((await call("GET", "/api/admin/testing/tools", { cookie: cookie("TsOrg") })).status).toBe(200);
    expect((await call("GET", "/api/admin/testing/tools", { authorization: basic })).status).toBe(200);
  });

  it("the control panel ships the (hidden-until-authorised) card and its script, both public static", async () => {
    const page = await fetch(`${origin}/control-panel.html`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="testing-suite" hidden');
    expect(html).toContain('src="./control-panel.js"');
    for (const id of ["tt-home-coach", "tt-home-team", "tt-away-coach", "tt-away-team", "tt-pregame", "tt-postmatch", "tt-timer", "tt-seconds", "tt-create", "tt-purge"]) expect(html).toContain(`id="${id}"`);
    const js = await fetch(`${origin}/control-panel.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toContain("/api/admin/testing/tools");
  });

  it("an organiser reads the env defaults, creates a test match, and purges", async () => {
    const ids = (globalThis as { __saveIds?: Record<string, string> }).__saveIds!;
    const org = { cookie: cookie("TsOrg"), "x-cw-auth": "1" };
    const defaults = (await (await call("GET", "/api/admin/testing/tabletop-defaults", org)).json()) as { defaults: any };
    expect(defaults.defaults).toEqual({ home: { coach: "TsAlice", team: `save:${ids.TsAlice}` }, away: { coach: "TsBob", team: "library:4242" } });
    const bad = await call("POST", "/api/admin/testing/tabletop-match", org, { home: { coach: "TsAlice", team: `save:${ids.TsAlice}` }, away: { coach: "TsBob", team: `save:${ids.TsBob}` }, pregame: "skip", postMatch: "none" });
    expect(bad.status).toBe(201);
    const made = (await bad.json()) as { matchId: string; url: string };
    expect(made.url).toBe(`/app/tabletop/${made.matchId}`);
    expect((await call("GET", `/api/tabletop/matches/${made.matchId}`, { cookie: cookie("TsAlice") })).status).toBe(200); // a participant can open it
    expect(await (await call("DELETE", "/api/admin/testing/tabletop-matches", org)).json()).toEqual({ purged: 1 });
    expect((await call("GET", `/api/tabletop/matches/${made.matchId}`, { cookie: cookie("TsAlice") })).status).toBe(404);
  });
});
