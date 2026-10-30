import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createFixtureSummary, fixtureQuery, forkSteps } from "../spa/src/leagues/fixture";
import type { FixtureForkView, FixtureSummary, LeagueFixture, LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";

// SPA league fixture summary + Play on Super FUMBBL: the controller against a mocked Fetcher, and the summary page
// server-rendered in each state (not generated, scheduled, failed, finished) for coaches, organisers and visitors.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> };
  f.calls = calls;
  return f;
}

const s7: SeasonSummary = { id: "season-7", number: 7, name: "Season 7", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 1, playedCount: 0 };
const league = (over: Partial<LeagueSummary> = {}): LeagueSummary => ({
  id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], playOnFork: true,
  createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1, currentSeason: s7, ...over,
});
const fx = (over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 2, table: 1,
  home: { team: "Grudge Rollers", teamId: "grudge", coach: "Ann", coachId: "Ann", race: "Human", score: null, cas: null, conceded: false },
  away: { team: "Green Tide", teamId: "orcs", coach: "Bob", coachId: "Bob", race: "Orc", score: null, cas: null, conceded: false },
  suspended: false, forkEnabled: true, ...over,
});
const season7 = (fixtures: LeagueFixture[] = [fx()]): SeasonRecord => ({
  id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active", importedAt: "2026-10-30T00:00:00.000Z",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, participants: [], teams: [], honours: [], awards: [],
});
const forkView = (over: Partial<FixtureForkView> = {}): FixtureForkView => ({
  enabled: true, status: "none", statusLabel: "Not generated", allowLate: false, cancelled: false, teams: {},
  canGenerate: false, canStart: false, canReset: false, canConfigure: false, ...over,
});
const summary = (fork: FixtureForkView, fixture = fx()): FixtureSummary => ({
  league: { id: "tabbl", name: "TABBL", playOnFork: true },
  season: { id: "season-7", name: "Season 7", status: "active", ruleset: "BB2025" },
  fixture, fork, forkAvailable: true,
});
const BASE = "/api/leagues/tabbl/seasons/season-7/fixtures/f1";
const SCHEDULED = forkView({ status: "scheduled", statusLabel: "Game scheduled", teams: { home: { builtAt: "x" }, away: { builtAt: "x" } }, gameId: "g42" });

describe("fixture summary controller", () => {
  it("helpers: the steps and the fixtures-list link", () => {
    expect(forkSteps(SCHEDULED).map((s) => s.done)).toEqual([true, true, false, false]);
    expect(forkSteps(forkView({ status: "launch_failed", teams: { home: { builtAt: "" }, away: { builtAt: "" } }, gameId: undefined })).map((s) => s.done)).toEqual([true, false, false, false]);
    expect(fixtureQuery(undefined, "f1")).toEqual({ tab: "fixtures", fixture: "f1" });
    expect(fixtureQuery("season-5", "f1")).toEqual({ season: "season-5", tab: "fixtures", fixture: "f1" });
  });

  it("load, generate (takes the fresh view), start downloads the launch file, reset sends the reason", async () => {
    let current = summary(forkView({ canGenerate: true, mySide: "home" }));
    const downloads: string[] = [];
    const f = mockFetcher({
      [BASE]: () => current,
      [`POST ${BASE}/fork/generate`]: () => { current = summary({ ...SCHEDULED, canStart: true, mySide: "home" }); return { ok: true, fork: current.fork }; },
      [`POST ${BASE}/fork/launch`]: { ok: true, jnlpUrl: `${BASE}/fork/jnlp` },
      [`POST ${BASE}/fork/reset`]: () => ({ ok: true, fork: forkView({ status: "teams_built", canGenerate: true }) }),
    });
    const c = createFixtureSummary({ api: f, download: (h) => downloads.push(h) });
    await c.load("tabbl", "season-7", "f1");
    expect(c.state.summary!.fork.canGenerate).toBe(true);
    expect(await c.generate()).toBe(true);
    expect(c.state.summary!.fork).toMatchObject({ status: "scheduled", canStart: true });
    expect(await c.start()).toBe(true);
    expect(downloads).toEqual([`${BASE}/fork/jnlp`]);
    await c.reset("Fork was down");
    expect(f.calls.find((x) => x.path.endsWith("/fork/reset"))!.body).toEqual({ reason: "Fork was down" });
    expect(c.state.summary!.fork.status).toBe("teams_built");
  });

  it("a failed action shows its error and reloads the summary", async () => {
    const f = mockFetcher({
      [BASE]: () => summary(forkView({ status: "launch_failed", statusLabel: "Failed", error: "team not loaded" })),
      [`POST ${BASE}/fork/generate`]: new ApiError(502, "The teams could not be built on Super FUMBBL: reload refused"),
    });
    const c = createFixtureSummary({ api: f });
    await c.load("tabbl", "season-7", "f1");
    expect(await c.generate()).toBe(false);
    expect(c.state.actionError).toContain("reload refused");
    expect(f.calls.filter((x) => x.path === BASE)).toHaveLength(2);
  });

  it("admin switches PATCH the fixture (late launch, cancel, allow)", async () => {
    const f = mockFetcher({
      [BASE]: () => summary(forkView({ canConfigure: true })),
      [`PATCH ${BASE}`]: (b: unknown) => ({ ok: true, fixture: { ...fx(), ...(b as object) } }),
    });
    const c = createFixtureSummary({ api: f });
    await c.load("tabbl", "season-7", "f1");
    await c.setLate(true);
    await c.setCancelled(true);
    await c.setAllowed(false);
    expect(f.calls.filter((x) => x.method === "PATCH").map((x) => x.body)).toEqual([{ forkAllowLate: true }, { forkCancelled: true }, { forkEnabled: false }]);
  });
});

describe("fixture summary page (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> };
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    league: typeof import("../spa/src/leagues/league");
    fixture: typeof import("../spa/src/leagues/fixture");
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, leagueMod, fixtureMod, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("/src/leagues/fixture.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      league: leagueMod as typeof import("../spa/src/leagues/league"), fixture: fixtureMod as typeof import("../spa/src/leagues/fixture"),
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const COACH = { "/api/auth/session": { authenticated: true, coach: "Ann", authMethod: "discord", discordSsoEnabled: true } };
  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };

  async function render(path: string, view: FixtureSummary, session: Routes = COACH, seasonFixtures = [fx()]) {
    const f = mockFetcher({
      ...session,
      "/api/leagues/tabbl": { league: league(), seasons: [s7] },
      "/api/leagues/tabbl/seasons/season-7": () => ({ league: league(), season: season7(seasonFixtures) }),
      "/crests/manifest.json": { crests: {} },
      [BASE]: view,
    });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-7");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const c = mods.fixture.createFixtureSummary({ api: f });
    await c.load("tabbl", "season-7", "f1");
    spa.app.provide(mods.fixture.FIXTURE_SUMMARY_KEY, c);
    await spa.router.push(path);
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }
  const PAGE = "/leagues/tabbl?tab=fixtures&fixture=f1";

  it("the fixtures list links every fixture to its summary and shows the Super FUMBBL status", async () => {
    const html = await render("/leagues/tabbl?tab=fixtures", summary(forkView()), COACH, [fx({ fork: { status: "scheduled" } })]);
    expect(html).toContain('href="/app/leagues/tabbl?tab=fixtures&amp;fixture=f1"');
    expect(html).toContain('data-fork-status="scheduled"');
    expect(html).toContain("Game scheduled");
  });

  it("not generated: a seated coach gets Generate; no Start yet", async () => {
    const html = await render(PAGE, summary(forkView({ canGenerate: true, mySide: "home" })));
    expect(html).toContain("Fixture summary");
    expect(html).toContain("Grudge Rollers");
    expect(html).toContain("Not generated");
    expect(html).toContain("Generate fixture on Super FUMBBL");
    expect(html).not.toContain("Start Game on Super FUMBBL");
    expect(html).not.toContain("Allow late launch");
  });

  it("a visitor sees the status, no actions; the blocker reason shows to the coach", async () => {
    const visitor = await render(PAGE, summary(forkView()), { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
    expect(visitor).toContain("Not generated");
    expect(visitor).not.toContain("Generate fixture on Super FUMBBL");
    const blocked = await render(PAGE, summary(forkView({ blocker: "Green Tide has no league roster in this season." })));
    expect(blocked).toContain("Green Tide has no league roster in this season.");
  });

  it("scheduled: the seated coach gets Start Game; the steps show teams built and the game", async () => {
    const html = await render(PAGE, summary({ ...SCHEDULED, canStart: true, mySide: "home" }));
    expect(html).toContain("Start Game on Super FUMBBL");
    expect(html).not.toContain("Generate fixture on Super FUMBBL");
    expect(html).toMatch(/data-done="true"[^>]*>Teams built on Super FUMBBL/);
    expect(html).toMatch(/data-done="true"[^>]*>Game g42 scheduled/);
    expect(html).toMatch(/data-done="false"[^>]*>Result recorded/);
  });

  it("failed: the reason, and for organisers the per-game settings, history and Reset fork game", async () => {
    const failed = forkView({
      status: "launch_failed", statusLabel: "Failed", error: "fork admin/schedule: team not loaded", canReset: true, canConfigure: true,
      teams: { home: { builtAt: "x" }, away: { builtAt: "x" } }, log: [{ at: "2026-10-30T12:00:00.000Z", by: "Ann", text: "Scheduling failed" }],
    });
    const html = await render(PAGE, summary(failed), ORGANISER);
    expect(html).toContain("Failed: fork admin/schedule: team not loaded");
    expect(html).toContain("Reset fork game");
    expect(html).toContain("Allow late launch");
    expect(html).toContain("Cancel Super FUMBBL play");
    expect(html).toContain("Allow Super FUMBBL for this fixture");
    expect(html).toContain("History");
    expect(html).toContain("Scheduling failed");
  });

  it("finished: the score, and the player lines from the result", async () => {
    const played = fx({ home: { ...fx().home, score: 2, cas: 1 }, away: { ...fx().away, score: 1, cas: 1 }, finishedAt: "2026-10-30T20:00:00.000Z", fork: { status: "finished" } });
    const done = forkView({
      status: "finished", statusLabel: "Finished", gameId: "g42", teams: { home: { builtAt: "x" }, away: { builtAt: "x" } },
      result: { gameId: "g42", source: "full", appliedAt: "x",
        home: { score: 2, cas: 1, conceded: false, winnings: 60000, lines: [{ playerId: "p1", forkPlayerId: "fp1", name: "Arm", td: 2, cas: 0, completions: 1, interceptions: 0, mvp: 1, fouls: 0, spp: 13, injuries: ["Head Injury (-AV)"] }] },
        away: { score: 1, cas: 1, conceded: false, winnings: 40000, lines: [] } },
    });
    const html = await render(PAGE, summary(done, played));
    expect(html).toContain("2 - 1");
    expect(html).toContain("Finished");
    expect(html).toContain("Home: Grudge Rollers");
    expect(html).toContain("Head Injury (-AV)");
    expect(html).not.toContain("Start Game on Super FUMBBL");
    expect(html).not.toContain("data-financial-pending");
    expect(html).not.toContain("data-cas-suffered"); // the result sent none
    expect(html).not.toContain("data-concession");
  });

  it("finished: casualties suffered per team and the server's legal-concession verdict", async () => {
    const played = fx({ home: { ...fx().home, score: 2, cas: 1 }, away: { ...fx().away, score: 0, cas: 0, conceded: true }, fork: { status: "finished" } });
    const done = forkView({
      status: "finished", statusLabel: "Finished", gameId: "g42", teams: { home: { builtAt: "x" }, away: { builtAt: "x" } },
      result: { gameId: "g42", source: "full", appliedAt: "x",
        home: { score: 2, cas: 1, conceded: false, winnings: 80000, casualtiesSuffered: { badlyHurt: 1, seriousInjury: 0, rip: 1 }, lines: [] },
        away: { score: 0, cas: 0, conceded: true, concededLegally: false, winnings: 0, lines: [] } },
    });
    const html = await render(PAGE, summary(done, played));
    expect(html).toContain("Green Tide conceded (not a legal concession).");
    expect(html).toContain("Casualties suffered: Grudge Rollers 1 BH, 0 SI, 1 dead · Green Tide none");
  });

  it("a basic result says the treasuries wait for an organiser (review P2-9)", async () => {
    const played = fx({ home: { ...fx().home, score: 1, cas: 0 }, away: { ...fx().away, score: 0, cas: 0 }, fork: { status: "finished" } });
    const done = forkView({
      status: "finished", statusLabel: "Finished", gameId: "g42", teams: { home: { builtAt: "x" }, away: { builtAt: "x" } },
      result: { gameId: "g42", source: "basic", appliedAt: "x", financialPending: true,
        home: { score: 1, cas: 0, conceded: false, winnings: 50000, lines: [] }, away: { score: 0, cas: 0, conceded: false, winnings: 0, lines: [] } },
    });
    const html = await render(PAGE, summary(done, played));
    expect(html).toContain("Score and player counters only");
    expect(html).toContain("an organiser settles the winnings");
  });
});
