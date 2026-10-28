import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentStandingRow, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentList, listPath, listQuery, parseListQuery } from "../spa/src/tournaments/list";
import { createTournamentDetail, roundViews, safeCrestUrl, standingViews, tiebreakLabel } from "../spa/src/tournaments/detail";
import { startPolling } from "../spa/src/tournaments/poll";
import { createOrganiser } from "../spa/src/tabletop/organiser";

// Phase 1 of the SPA Tournaments: read-only list + detail controllers, and the routes server-rendered through the
// SPA's own Vite config against a mocked Fetcher (no port), as in spaShell.test.ts.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string }> } {
  const calls: Array<{ path: string; method: string }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method });
    const hit = routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const tournament = (over: Partial<TournamentSummary> = {}): TournamentSummary => ({
  id: "t1", name: "Spring Swiss", status: "active", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3,
  currentRound: 2, tiebreakers: ["buchholz"], startsAt: "2026-11-01T18:00:00.000Z", entrantCount: 2, ...over,
});

const listPage = (items: TournamentSummary[], extra: Record<string, unknown> = {}) => ({ tournaments: items, page: 1, pageSize: 20, total: items.length, hasMore: false, ...extra });

const detailBody = (over: Partial<TournamentDetailResponse> = {}): TournamentDetailResponse => ({
  tournament: tournament(),
  entrants: [
    { id: "t1:entrant:1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc", logoUrl: "https://crest.test/a.png" },
    { id: "t1:entrant:2", seed: 2, coachId: "Bob", teamId: "tm2", teamName: "Bob Elves", race: "Wood Elf" },
    { id: "t1:entrant:3", seed: 3, coachId: "Cy", teamId: "tm3", droppedAt: "2026-10-30T00:00:00Z" },
  ],
  rounds: [{ id: "r2", number: 2, status: "active", scheduledMatchIds: [] }, { id: "r1", number: 1, status: "completed", scheduledMatchIds: [] }],
  scheduledMatches: [],
  ...over,
});

const row = (rank: number, entrant: number, coachId: string, teamId: string, over: Partial<TournamentStandingRow> = {}): TournamentStandingRow => ({
  rank, entrantId: `t1:entrant:${entrant}`, coachId, teamId, played: 2, wins: 1, draws: 1, losses: 0, byes: 0, points: 4,
  touchdownsFor: 5, touchdownsAgainst: 3, touchdownDifferential: 2, casualtiesFor: 3, casualtiesAgainst: 1, casualtyDifferential: 2,
  buchholz: 3.5, sonnebornBerger: 2, opponentWinPercentage: 0.5, seed: entrant, ...over,
});

const fixture = (id: string, round: number, result?: { homeScore: number; awayScore: number; homeCasualties?: number; awayCasualties?: number }, bye = false) => ({
  id, roundNumber: round, status: result ? "completed" : "scheduled",
  home: { entrantId: "t1:entrant:1", teamId: "tm1", coach: { ffbCoachId: "Alice" } },
  ...(bye ? {} : { away: { entrantId: "t1:entrant:2", teamId: "tm2", coach: { ffbCoachId: "Bob" } } }),
  ...(result ? { result } : {}),
});

describe("tournament list controller", () => {
  it("tabs map to the all-format status spelling (never category=), search and paging compose", () => {
    expect(listPath("active", "", 1)).toBe("/api/fork/tournaments");
    expect(listPath("upcoming", "", 1)).toBe("/api/fork/tournaments?status=draft");
    expect(listPath("finished", "", 1)).toBe("/api/fork/tournaments?status=completed");
    expect(listPath("finished", " nut cup ", 3)).toBe("/api/fork/tournaments?status=completed&q=nut%20cup&page=3");
    expect(listPath("active", "", 1)).not.toContain("category");
  });

  it("loads a page, switches tab back to page 1, searches and pages", async () => {
    const f = mockFetcher({
      "/api/fork/tournaments": listPage([tournament()], { total: 25, hasMore: true }),
      "/api/fork/tournaments?page=2": listPage([tournament({ id: "t9", name: "Page two" })], { page: 2, total: 25, hasMore: false }),
      "/api/fork/tournaments?status=draft": listPage([tournament({ id: "t2", status: "draft", format: "roundRobin" })]),
      "/api/fork/tournaments?status=draft&q=rr": listPage([]),
    });
    const list = createTournamentList({ api: f });
    await list.load();
    expect(list.state.items.map((t) => t.id)).toEqual(["t1"]);
    expect(list.state.hasMore).toBe(true);
    expect(list.state.total).toBe(25);
    await list.next();
    expect(list.state.page).toBe(2);
    expect(list.state.items[0]!.name).toBe("Page two");
    await list.next();
    expect(list.state.page).toBe(2);
    await list.setTab("upcoming");
    expect(list.state.page).toBe(1);
    expect(list.state.items[0]!.format).toBe("roundRobin");
    await list.search("rr");
    expect(list.state.items).toEqual([]);
    expect(list.state.error).toBe("");
    await list.prev();
    expect(f.calls.at(-1)!.path).toBe("/api/fork/tournaments?status=draft&q=rr");
  });

  it("a failed read is an error state, not a throw; a newer request wins over a slower older one", async () => {
    const down = createTournamentList({ api: mockFetcher({ "/api/fork/tournaments": new ApiError(0, "Can't reach the server. Check your connection.") }) });
    await expect(down.load()).resolves.toBeUndefined();
    expect(down.state.error).toBe("Can't reach the server. Check your connection.");
    expect(down.state.loaded).toBe(true);
    expect(down.state.items).toEqual([]);

    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((r) => { release = r; });
    const calls: string[] = [];
    const racing = createTournamentList({
      api: (async (path: string) => {
        calls.push(path);
        if (path === "/api/fork/tournaments") { await slow; return listPage([tournament({ name: "stale" })]); }
        return listPage([tournament({ id: "t2", name: "fresh", status: "completed" })]);
      }) as Fetcher,
    });
    const first = racing.load();
    await racing.setTab("finished");
    release(null);
    await first;
    expect(racing.state.items.map((t) => t.name)).toEqual(["fresh"]);
    expect(racing.state.loading).toBe(false);
  });
});

describe("tournament detail controller", () => {
  it("loads overview data in one read, rounds sorted, and standings only when the tab asks", async () => {
    const f = mockFetcher({
      "/api/tournaments/t1": detailBody(),
      "/api/tournaments/t1/standings": { tournamentId: "t1", standings: [row(1, 1, "Alice", "tm1"), row(2, 2, "Bob", "tm2", { points: 1, wins: 0, draws: 1 })] },
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    expect(d.state.tournament?.name).toBe("Spring Swiss");
    expect(d.state.entrants).toHaveLength(3);
    expect(d.state.rounds.map((r) => r.number)).toEqual([1, 2]);
    expect(f.calls.map((c) => c.path)).toEqual(["/api/tournaments/t1"]);
    await d.ensureTab("entrants");
    expect(f.calls).toHaveLength(1);
    await d.ensureTab("standings");
    await d.ensureTab("standings");
    expect(f.calls.map((c) => c.path)).toEqual(["/api/tournaments/t1", "/api/tournaments/t1/standings"]);
    expect(d.state.standingsStatus).toBe("ok");
    // the real route answers { tournamentId, standings: Row[] }: the rows must come through
    expect(d.state.standings).toHaveLength(2);
    expect(d.state.standings.map((r) => r.rank)).toEqual([1, 2]);
    const views = standingViews(d.state);
    expect(views[0]).toMatchObject({ rank: 1, team: "Alice Orcs", coach: "Alice", race: "Orc", points: 4, played: 2, td: 5, cas: 3, tiebreak: "3.50" });
    expect(tiebreakLabel(d.state.tournament)).toBe("Buchholz");
    expect(tiebreakLabel(tournament({ tiebreakers: ["casualtyDifferential"] }))).toBe("CAS +/-");
  });

  it("fixtures: score with TD and CAS counts, vs for unplayed, bye; anonymous (none) lists the rounds empty", () => {
    const entrants = detailBody().entrants;
    const rounds = detailBody().rounds;
    const views = roundViews({
      rounds, entrants,
      fixtures: [
        fixture("m1", 1, { homeScore: 2, awayScore: 1, homeCasualties: 3, awayCasualties: 0 }),
        fixture("m2", 2),
        fixture("m3", 2, undefined, true),
      ] as never,
    });
    expect(views.map((r) => r.number)).toEqual([1, 2]);
    expect(views[0]!.fixtures[0]).toMatchObject({ played: true, home: { team: "Alice Orcs", score: 2, cas: 3 }, away: { team: "Bob Elves", score: 1, cas: 0 } });
    expect(views[1]!.fixtures[0]).toMatchObject({ played: false, home: { score: null } });
    expect(views[1]!.fixtures[1]!.away).toBeNull();
    const anon = roundViews({ rounds, entrants, fixtures: [] });
    expect(anon.map((r) => r.fixtures.length)).toEqual([0, 0]);
  });

  it("404 is a not-found error state; other failures keep their message; standings failure is local to that tab", async () => {
    const missing = createTournamentDetail({ api: mockFetcher({ "/api/tournaments/nope": new ApiError(404, "Tournament not found.") }) });
    await missing.load("nope");
    expect(missing.state.notFound).toBe(true);
    expect(missing.state.error).toBe("Tournament not found.");
    expect(missing.state.tournament).toBeNull();
    expect(missing.state.loaded).toBe(true);

    const f = mockFetcher({ "/api/tournaments/t1": detailBody(), "/api/tournaments/t1/standings": new ApiError(500, "Request failed (500).") });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    await d.ensureTab("standings");
    expect(d.state.standingsStatus).toBe("error");
    expect(d.state.standingsError).toBe("Request failed (500).");
    expect(d.state.tournament?.id).toBe("t1");
    expect(d.state.error).toBe("");
  });
});

describe("tournament controllers: hardening", () => {
  it("a stale A -> B -> A standings response is dropped (latest request wins)", async () => {
    const releases: Array<(v: unknown) => void> = [];
    let n = 0;
    const api = (async (path: string) => {
      if (path.endsWith("/standings")) {
        const mine = n++;
        await new Promise((r) => releases.push(r));
        return { standings: [row(1, 1, mine === 0 ? "Stale" : "Fresh", "tm1")] };
      }
      return detailBody();
    }) as Fetcher;
    const d = createTournamentDetail({ api });
    await d.load("t1");
    const first = d.loadStandings();
    const second = d.loadStandings();
    releases[1]!(null);
    await second;
    releases[0]!(null);
    await first;
    expect(d.state.standings.map((r) => r.coachId)).toEqual(["Fresh"]);
    expect(d.state.standingsStatus).toBe("ok");
  });

  it("a stale detail load for another tournament cannot overwrite the current one", async () => {
    const gates: Record<string, (v: unknown) => void> = {};
    const api = (async (path: string) => {
      await new Promise((r) => { gates[path] = r; });
      return detailBody({ tournament: tournament({ id: path.endsWith("t2") ? "t2" : "t1", name: path.endsWith("t2") ? "Two" : "One" }) });
    }) as Fetcher;
    const d = createTournamentDetail({ api });
    const a = d.load("t1");
    const b = d.load("t2");
    gates["/api/tournaments/t2"]!(null);
    await b;
    gates["/api/tournaments/t1"]!(null);
    await a;
    expect(d.state.tournament?.name).toBe("Two");
  });

  it("401 calls onSignedOut (list, detail, standings) instead of showing the generic error", async () => {
    let out = 0;
    const onSignedOut = () => { out++; };
    const unauth = new ApiError(401, "Authentication required.");
    const list = createTournamentList({ api: mockFetcher({ "/api/fork/tournaments": unauth }), onSignedOut });
    await list.load();
    const d = createTournamentDetail({ api: mockFetcher({ "/api/tournaments/t1": unauth }), onSignedOut });
    await d.load("t1");
    const s = createTournamentDetail({ api: mockFetcher({ "/api/tournaments/t1": detailBody(), "/api/tournaments/t1/standings": unauth }), onSignedOut });
    await s.load("t1");
    await s.ensureTab("standings");
    expect(out).toBe(3);
    for (const msg of [list.state.error, d.state.error, s.state.standingsError]) {
      expect(msg).toBe("Signed out. Sign in and try again.");
      expect(msg).not.toContain("Authentication required");
    }
    // without a hook the server's message shows
    const bare = createTournamentList({ api: mockFetcher({ "/api/fork/tournaments": unauth }) });
    await bare.load();
    expect(bare.state.error).toBe("Authentication required.");
  });

  it("silent refresh keeps what is on screen on a transient failure, and picks up changes", async () => {
    let fail = false;
    let name = "Spring Swiss";
    const api = (async () => {
      if (fail) throw new ApiError(500, "Request failed (500).");
      return detailBody({ tournament: tournament({ name }) });
    }) as Fetcher;
    const d = createTournamentDetail({ api });
    await d.load("t1");
    name = "Renamed";
    await d.refresh();
    expect(d.state.tournament?.name).toBe("Renamed");
    fail = true;
    await d.refresh();
    expect(d.state.tournament?.name).toBe("Renamed");
    expect(d.state.error).toBe("");
    const list = createTournamentList({ api: (async () => { if (fail) throw new ApiError(500, "x"); return listPage([tournament()]); }) as Fetcher });
    fail = false;
    await list.load();
    fail = true;
    await list.refresh();
    expect(list.state.items).toHaveLength(1);
    expect(list.state.error).toBe("");
  });

  it("polling runs only while visible and stops when cleared", () => {
    vi.useFakeTimers();
    try {
      let visible = true;
      let ran = 0;
      const stop = startPolling(() => { ran++; }, 30_000, () => visible);
      vi.advanceTimersByTime(30_000);
      expect(ran).toBe(1);
      visible = false;
      vi.advanceTimersByTime(60_000);
      expect(ran).toBe(1);
      visible = true;
      vi.advanceTimersByTime(30_000);
      expect(ran).toBe(2);
      stop();
      vi.advanceTimersByTime(120_000);
      expect(ran).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it("list position round-trips through the query string; junk falls back to defaults", () => {
    expect(listQuery("active", "", 1)).toEqual({});
    expect(listQuery("finished", " nut ", 3)).toEqual({ tab: "finished", q: "nut", page: "3" });
    expect(parseListQuery({ tab: "finished", q: "nut", page: "3" })).toEqual({ tab: "finished", q: "nut", page: 3 });
    expect(parseListQuery({ tab: "bogus", page: "-4", q: ["a", "b"] })).toEqual({ tab: "active", q: "a", page: 1 });
    expect(parseListQuery({})).toEqual({ tab: "active", q: "", page: 1 });
    const list = createTournamentList({ api: mockFetcher({}) });
    expect(list.restore({ tab: "finished", q: "x", page: 2 })).toBe(true);
    expect(list.restore({ tab: "finished", q: "x", page: 2 })).toBe(false);
    expect(list.state.page).toBe(2);
  });

  it("crest URLs: only http(s) survive", () => {
    expect(safeCrestUrl("https://crest.test/a.png")).toBe("https://crest.test/a.png");
    expect(safeCrestUrl("http://crest.test/a.png")).toBe("http://crest.test/a.png");
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "//crest.test/a.png", "/local.png", "ftp://x/y.png", "", undefined, null]) {
      expect(safeCrestUrl(bad as string | undefined), String(bad)).toBe("");
    }
  });
});

describe("organiser console list spelling", () => {
  it("reads /api/fork/tournaments (all formats), not the Swiss-only /api/tournaments alias", async () => {
    const f = mockFetcher({
      "/api/fork/tournaments": { tournaments: [{ id: "rr", name: "Round robin" }] },
      "/api/fork/tournaments?status=draft": { tournaments: [{ id: "ko", name: "Knockout" }] },
    });
    const org = createOrganiser({ api: f, onSignedOut: () => undefined });
    await org.loadTournaments();
    expect(org.state.tournaments.map((t) => t.id)).toEqual(["rr", "ko"]);
    expect(f.calls.every((c) => c.path.startsWith("/api/fork/tournaments"))).toBe(true);
  });
});

describe("tournament routes (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown; meta: Record<string, unknown> } } };
      session: unknown;
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    gateFor: (route: { meta: Record<string, unknown> }, s: unknown) => string;
    createTournamentList: typeof createTournamentList;
    createTournamentDetail: typeof createTournamentDetail;
    TOURNAMENT_LIST_KEY: symbol;
    TOURNAMENT_DETAIL_KEY: symbol;
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, router, list, detail, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/router.ts"),
      vite.ssrLoadModule("/src/tournaments/list.ts"),
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa,
      createMemoryHistory: vueRouter.createMemoryHistory,
      renderToString: renderer.renderToString,
      gateFor: router.gateFor,
      createTournamentList: list.createTournamentList,
      createTournamentDetail: detail.createTournamentDetail,
      TOURNAMENT_LIST_KEY: list.TOURNAMENT_LIST_KEY,
      TOURNAMENT_DETAIL_KEY: detail.TOURNAMENT_DETAIL_KEY,
    };
  }, 60_000);

  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };

  /** Renders `path` anonymously; `prep` runs the controller (the views load on mount, which SSR does not run). */
  async function render(path: string, routes: Routes, prep?: (inject: (key: symbol, v: unknown) => void, f: Fetcher) => Promise<void>) {
    const f = mockFetcher({ ...ANON, ...routes });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa, f };
  }

  const loadedList = (items: TournamentSummary[], extra: Record<string, unknown> = {}) => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const list = mods.createTournamentList({ api: f });
    await list.load();
    inject(mods.TOURNAMENT_LIST_KEY, list);
  };

  const loadedDetail = (id: string, tab?: "standings") => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const d = mods.createTournamentDetail({ api: f });
    await d.load(id);
    if (tab) await d.ensureTab(tab);
    inject(mods.TOURNAMENT_DETAIL_KEY, d);
  };

  it("router gate: the tournament routes are public (no sign-in prompt), the old link-out page is gone from /tournaments", async () => {
    for (const path of ["/tournaments", "/tournaments/t1", "/tournaments/t1?tab=standings"]) {
      const { html, spa } = await render(path, {});
      expect(mods.gateFor(spa.router.currentRoute.value, spa.session), path).toBe("allow");
      expect(html, path).not.toContain("Login with Discord to");
      expect(html, path).not.toContain('href="/tournaments.html"');
    }
    const bad = await render("/tournaments/<x>", {});
    expect(bad.spa.router.currentRoute.value.name).toBe("not-found");
  });

  it("list: anonymous render shows tabs, search and a card per tournament, with no organiser controls", async () => {
    const items = [tournament(), tournament({ id: "t2", name: "Knockout Cup", format: "knockout", maxPlayers: 0, currentRound: 0, startsAt: undefined })];
    const { html } = await render("/tournaments", { "/api/fork/tournaments": listPage(items) }, loadedList(items));
    expect(html).toContain("Tournaments");
    for (const label of ["Active", "Upcoming", "Finished"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('type="search"');
    expect(html).toContain("Spring Swiss");
    expect(html).toContain("Knockout Cup");
    expect(html).toContain("Knockout");
    expect(html).toContain('href="/app/tournaments/t1"');
    expect(html).toContain("Round 2 of 3");
    expect(html).toContain("starts 2026-11-01");
    expect(html).not.toMatch(/New tournament|Create tournament|Generate round|Finish tournament/);
  });

  it("list: empty, error and loading states; paging controls only when there is more", async () => {
    const empty = await render("/tournaments", { "/api/fork/tournaments": listPage([]) }, loadedList([]));
    expect(empty.html).toContain("No active tournaments.");
    const failed = await render("/tournaments", { "/api/fork/tournaments": new ApiError(500, "Request failed (500).") }, loadedList([]));
    expect(failed.html).toContain("Request failed (500).");
    expect(failed.html).toContain('role="alert"');
    const loading = await render("/tournaments", {});
    expect(loading.html).toContain("Loading tournaments...");
    const items = [tournament()];
    const more = await render("/tournaments", { "/api/fork/tournaments": listPage(items, { total: 45, hasMore: true }) }, loadedList(items));
    expect(more.html).toContain("Next");
    expect(more.html).toContain("Page 1");
    const one = await render("/tournaments", { "/api/fork/tournaments": listPage(items) }, loadedList(items));
    expect(one.html).not.toContain("Previous");
  });

  it("detail overview: format, ruleset, status, round x/y, start date, entrant count; tabs present; no organiser controls", async () => {
    const { html } = await render("/tournaments/t1", { "/api/tournaments/t1": detailBody() }, loadedDetail("t1"));
    expect(html).toContain("Spring Swiss");
    expect(html).toContain("Swiss");
    expect(html).toContain("nut-cup");
    expect(html).toContain("Round 2 of 3");
    expect(html).toContain("2026-11-01");
    expect(html).toContain("2 of 8");
    for (const label of ["Overview", "Entrants", "Rounds", "Standings"]) expect(html).toContain(`>${label}</a>`);
    expect(html).toContain("tab=standings");
    expect(html).not.toMatch(/Register|Generate round|Finish tournament|Settings/);
  });

  it("detail entrants tab: seed, team with crest, race, coach, status; dropped is marked", async () => {
    const { html } = await render("/tournaments/t1?tab=entrants", { "/api/tournaments/t1": detailBody() }, loadedDetail("t1"));
    expect(html).toContain("Alice Orcs");
    expect(html).toContain('src="https://crest.test/a.png"');
    expect(html).toContain("Wood Elf");
    expect(html).toContain("Dropped");
    expect(html).toContain("Registered");
    expect(html).toContain("tm3");
  });

  it("crests: http(s) render with no-referrer; other schemes never reach the page", async () => {
    const body = detailBody();
    body.entrants[1]!.logoUrl = "javascript:alert(1)";
    body.entrants[2]!.logoUrl = "data:image/png;base64,AAAA";
    const { html } = await render("/tournaments/t1?tab=entrants", { "/api/tournaments/t1": body }, loadedDetail("t1"));
    expect(html).toContain('src="https://crest.test/a.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
    expect(html.match(/class="tn-crest"/g)).toHaveLength(1);
  });

  it("list: the URL query (?tab=&q=&page=) sets the position the page shows", async () => {
    const items = [tournament({ id: "t5", status: "completed", name: "Old Cup" })];
    const { html } = await render("/tournaments?tab=finished&q=old&page=2", { "/api/fork/tournaments?status=completed&q=old&page=2": listPage(items, { page: 2, total: 21 }) }, async (inject, f) => {
      const list = mods.createTournamentList({ api: f });
      list.restore({ tab: "finished", q: "old", page: 2 });
      await list.load();
      inject(mods.TOURNAMENT_LIST_KEY, list);
    });
    expect(html).toContain("Old Cup");
    expect(html).toContain('value="old"');
    expect(html).toMatch(/class="on tn-tab">Finished</);
    expect(html).toContain("Page 2");
  });

  it("detail rounds tab: anonymous gets the empty state; fixtures render score with CAS and vs / bye", async () => {
    const anon = await render("/tournaments/t1?tab=rounds", { "/api/tournaments/t1": detailBody() }, loadedDetail("t1"));
    expect(anon.html).toContain("Round 1");
    expect(anon.html).toContain("Round 2");
    expect(anon.html).toContain("Fixtures are shown to signed-in participants and organisers.");
    const body = detailBody({ scheduledMatches: [fixture("m1", 1, { homeScore: 2, awayScore: 1, homeCasualties: 3, awayCasualties: 0 }), fixture("m2", 2), fixture("m3", 2, undefined, true)] as never });
    const full = await render("/tournaments/t1?tab=rounds", { "/api/tournaments/t1": body }, loadedDetail("t1"));
    expect(full.html).toContain("2 - 1");
    expect(full.html).toContain("CAS 3 - 0");
    expect(full.html).toContain(">vs<");
    expect(full.html).toContain(">Bye<");
    expect(full.html).not.toContain("Fixtures are shown to signed-in");
  });

  it("detail standings tab: Pts MP W D L TD CAS and the tiebreak column; empty and error states", async () => {
    const ok = await render("/tournaments/t1?tab=standings", {
      "/api/tournaments/t1": detailBody(),
      "/api/tournaments/t1/standings": { tournamentId: "t1", standings: [row(1, 1, "Alice", "tm1")] },
    }, loadedDetail("t1", "standings"));
    for (const h of ["Pts", "MP", "W", "D", "L", "TD", "CAS", "Buchholz"]) expect(ok.html).toContain(`<th>${h}</th>`);
    expect(ok.html).toContain("Alice Orcs");
    expect(ok.html).toContain("3.50");
    const empty = await render("/tournaments/t1?tab=standings", { "/api/tournaments/t1": detailBody(), "/api/tournaments/t1/standings": { standings: [] } }, loadedDetail("t1", "standings"));
    expect(empty.html).toContain("No standings yet.");
    const bad = await render("/tournaments/t1?tab=standings", { "/api/tournaments/t1": detailBody(), "/api/tournaments/t1/standings": new ApiError(500, "Request failed (500).") }, loadedDetail("t1", "standings"));
    expect(bad.html).toContain("Request failed (500).");
    const pending = await render("/tournaments/t1?tab=standings", { "/api/tournaments/t1": detailBody() }, loadedDetail("t1"));
    expect(pending.html).toContain("Loading standings...");
  });

  it("detail: a missing tournament shows the server's message with a way back; loading shows a status line", async () => {
    const gone = await render("/tournaments/nope", { "/api/tournaments/nope": new ApiError(404, "Tournament not found.") }, loadedDetail("nope"));
    expect(gone.html).toContain("Tournament not found.");
    expect(gone.html).toContain('href="/app/tournaments"');
    const loading = await render("/tournaments/t1", {});
    expect(loading.html).toContain("Loading tournament...");
  });
});
