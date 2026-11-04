import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  createSeriesDetail, formFromSeries, scoringLabel, seriesBody, seriesFormProblem, blankSeriesForm, submitSeriesForm, type SeriesDetail,
} from "../spa/src/tournaments/series";
import { createBody } from "../spa/src/tournaments/create";

// Tournament Series pages (spec-main-landing-nav §3: /app/series/:id; the list at /app/series) and the dialog controller.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init.body) : hit;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const SERIES = (over: Partial<SeriesDetail["series"]> = {}): SeriesDetail["series"] => ({
  id: "s1", name: "Valley Series", description: "Four Swiss events.", organisers: ["Veers", "Piett"], scoring: "bestN", bestN: 2, seeding: "elo",
  tournaments: ["t1", "t2", "t3"], createdAt: "", updatedAt: "", revision: 4, canEdit: false, ...over,
});
const DETAIL = (over: Partial<SeriesDetail> = {}): SeriesDetail => ({
  series: SERIES(),
  standings: {
    scoring: "bestN", bestN: 2, tiebreaks: ["total points", "best single result", "head-to-head wins", "name"],
    events: [
      { id: "t1", name: "Spring Open", status: "completed", startsAt: "2026-03-01T09:00:00Z", counted: true, provisional: false },
      { id: "t2", name: "Summer Bash", status: "active", startsAt: "2026-07-01T09:00:00Z", endsAt: "2026-07-02T18:00:00Z", counted: true, provisional: true },
      { id: "t3", name: "Autumn Cup", status: "draft", counted: false, provisional: false },
    ],
    rows: [
      { rank: 1, coach: "Alice", total: 9, eventsPlayed: 2, best: 6, headToHead: 0, results: [{ tournamentId: "t1", points: 6, rank: 1, played: 2, teamName: "Alice Orcs", counted: true }, { tournamentId: "t2", points: 3, rank: 2, played: 1, counted: true }] },
      { rank: 2, coach: "Bob", total: 6, eventsPlayed: 2, best: 3, headToHead: 0, results: [{ tournamentId: "t1", points: 3, rank: 2, played: 2, counted: true }, { tournamentId: "t2", points: 3, rank: 1, played: 1, counted: true }] },
    ],
  },
  ...over,
});

describe("series controller", () => {
  it("scoring labels, form checks and the body (organisers split on commas)", () => {
    expect(scoringLabel({ scoring: "sum" })).toBe("All events count");
    expect(scoringLabel({ scoring: "bestN", bestN: 1 })).toBe("Best 1 event");
    expect(scoringLabel({ scoring: "bestN", bestN: 3 })).toBe("Best 3 events");
    const form = { ...blankSeriesForm(), name: "  Cup ", organisers: "Piett, , Ozzel" };
    expect(seriesFormProblem({ ...form, name: "" })).toBe("Enter a name.");
    expect(seriesFormProblem({ ...form, scoring: "bestN", bestN: 0 })).toContain("1 to 50");
    expect(seriesBody(form)).toEqual({ name: "Cup", description: "", scoring: "sum", seeding: "dutch", organisers: ["Piett", "Ozzel"] });
    expect(seriesBody({ ...form, scoring: "bestN", bestN: 4 })).toMatchObject({ scoring: "bestN", bestN: 4 });
  });

  it("writes send the loaded revision; a 409 shows the message and reloads", async () => {
    let reads = 0;
    const f = mockFetcher({
      "GET /api/series/s1": () => { reads++; return DETAIL(); },
      "POST /api/series/s1/tournaments/t9": DETAIL({ series: SERIES({ revision: 5 }) }),
      "DELETE /api/series/s1/tournaments/t1": new ApiError(409, "This series changed since you opened it; current revision is 6."),
    });
    const d = createSeriesDetail({ api: f });
    await d.load("s1");
    expect(await d.attach("t9")).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", body: { revision: 4 } });
    expect(d.state.view!.series.revision).toBe(5);
    expect(await d.detach("t1")).toBe(false);
    expect(f.calls.find((c) => c.method === "DELETE")!.body).toEqual({ revision: 5 });
    expect(d.state.actionError).toContain("changed since you opened it");
    await Promise.resolve();
    expect(reads).toBe(2);
  });

  it("Edit -> Save sends the update (PATCH with the revision) and never a create; no controller = no request", async () => {
    const f = mockFetcher({
      "GET /api/series/s1": DETAIL(),
      "PATCH /api/series/s1": DETAIL({ series: SERIES({ name: "Valley Cup", revision: 5 }) }),
      "POST /api/series": { series: { id: "dup" } },
    });
    const d = createSeriesDetail({ api: f });
    await d.load("s1");
    const form = { ...formFromSeries(d.state.view!.series), name: "Valley Cup" };
    expect(await submitSeriesForm({ api: f, form, editing: d.state.view!.series, controller: d })).toEqual({ kind: "updated" });
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([{ path: "/api/series/s1", method: "PATCH", body: expect.objectContaining({ name: "Valley Cup", revision: 4 }) }]);
    expect(d.state.view!.series.name).toBe("Valley Cup");
    const before = f.calls.length;
    expect(await submitSeriesForm({ api: f, form, editing: { id: "s1" }, controller: null })).toMatchObject({ kind: "error" });
    expect(await submitSeriesForm({ api: f, form, editing: { id: "other" }, controller: d })).toMatchObject({ kind: "error" });
    expect(f.calls.length).toBe(before);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    // Create (no series being edited) is the only path that POSTs.
    expect(await submitSeriesForm({ api: f, form: { ...blankSeriesForm(), name: "New" } })).toEqual({ kind: "created", id: "dup" });
  });

  it("the series page passes its controller to the edit dialog", () => {
    const view = readFileSync(new URL("../spa/src/views/SeriesDetailView.vue", import.meta.url), "utf8");
    expect(view).toContain("provide(SERIES_DETAIL_KEY, detail)");
    expect(view).toMatch(/<SeriesDialog v-if="editing && series" :series="series" :controller="detail"/);
  });

  it("New tournament from a series page sends seriesId with the create body", () => {
    const body = createBody({ name: "Leg 1", packageName: "Rules", maxPlayers: 8, format: "swiss", roundCount: "", primaryTiebreaker: "buchholz", seriesId: "s1", seriesName: "Valley Series" });
    expect(body).toMatchObject({ seriesId: "s1" });
    expect(body).not.toHaveProperty("seriesName");
  });
});

describe("series views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, series, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/tournaments/series.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { app, series, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const AS = (coach: string, organizer = false) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", organizer } });

  async function render(path: string, routes: Routes) {
    const f = mockFetcher({ ...ANON, ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    if (routes["/api/series/s1"]) {
      const d = mods.series.createSeriesDetail({ api: f });
      await d.load("s1");
      spa.app.provide(mods.series.SERIES_DETAIL_KEY, d);
    }
    if (routes["/api/series"]) {
      const l = mods.series.createSeriesList({ api: f });
      await l.load();
      spa.app.provide(mods.series.SERIES_LIST_KEY, l);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("series pages: the section header, Overview (chips, organisers), Schedule round cards, the Standings table", async () => {
    const overview = await render("/series/s1", { "/api/series/s1": DETAIL() });
    expect(overview).toContain('<h2 class="sh-name" title="Valley Series">Valley Series</h2>'); // the shared section header
    expect(overview).toMatch(/data-scoring="true">Best 2 events</);
    expect(overview).toMatch(/data-seeding="true">Seeding: Rating seeded</);
    expect(overview).toContain("Veers, Piett");
    for (const t of ["Overview", "Schedule", "Standings"]) expect(overview).toContain(`>${t}</a>`);
    const schedule = await render("/series/s1?tab=schedule", { "/api/series/s1": DETAIL() });
    expect(schedule).toContain('href="/app/tournaments/t1"');
    expect(schedule).toContain("2026-07-01 to 2026-07-02");
    expect(schedule).toContain("Date not set");
    expect(schedule).toMatch(/data-round-state="live">In progress</);
    expect(schedule).toMatch(/data-round-state="next">Next</);
    const html = await render("/series/s1?tab=standings", { "/api/series/s1": DETAIL() });
    expect(html).toContain('class="sf-table sr-table"');
    expect(html).toMatch(/<th scope="row" class="sr-coach">Alice<\/th>/);
    expect(html).toContain('title="Spring Open: place 1, Alice Orcs"');
    expect(html).toContain('data-provisional="true"');
    expect(html).toContain("Ties: total points, then best single result, then head-to-head wins, then name.");
    // read-only for visitors: no cog, no management
    for (const page of [overview, schedule, html]) {
      expect(page).not.toContain(">Edit</button>");
      expect(page).not.toContain("Add a tournament");
      expect(page).not.toContain("data-cog");
      expect(page).not.toContain("lobby-");
    }
  });

  it("an editor gets the cog; its management sub-panel has Edit, Delete, Remove and Add a tournament (only the attachable ones)", async () => {
    const view = DETAIL({ series: SERIES({ canEdit: true }), attachable: [{ id: "t8", name: "Winter Clash", status: "draft" }] });
    const page = await render("/series/s1", { ...AS("Veers", true), "/api/series/s1": view });
    expect(page).toMatch(/<a[^>]*data-cog[^>]*href="\/app\/series\/s1\/manage"|<a[^>]*href="\/app\/series\/s1\/manage"[^>]*data-cog/);
    expect(page).not.toContain(">Edit</button>"); // management lives behind the cog
    const html = await render("/series/s1/manage", { ...AS("Veers", true), "/api/series/s1": view });
    expect(html).toContain(">Edit</button>");
    expect(html).toContain(">Delete</button>");
    expect(html).toContain(">New tournament</button>");
    expect(html).toContain('aria-label="Remove Spring Open from the series"');
    expect(html).toContain("Winter Clash (Upcoming)");
  });

  it("series list: a card per series with chips and an Open link; Create series for organisers only", async () => {
    const list = { series: [{ ...SERIES(), tournamentCount: 3, activeCount: 1, completedCount: 1, firstStartsAt: "2026-03-01T09:00:00Z", lastStartsAt: "2026-07-01T09:00:00Z" }] };
    const anon = await render("/series", { "/api/series": list });
    expect(anon).toContain('href="/app/series/s1"');
    expect(anon).toMatch(/data-scoring="true">Best 2 events</);
    expect(anon).toContain("2026-03-01 to 2026-07-01");
    expect(anon).not.toContain("Create series");
    const org = await render("/series", { ...AS("Veers", true), "/api/series": list });
    expect(org).toContain(">Create series</button>");
    const none = await render("/series", { "/api/series": { series: [] } });
    expect(none).toContain("No series yet.");
  });

  it("the Tournaments toolbar links to the series list; tokens only in series.css", async () => {
    const html = await render("/tournaments", { "/api/tournaments?category=active&page=1": { tournaments: [], page: 1, pageSize: 20, total: 0, hasMore: false }, "/api/tournaments?status=active&page=1": { tournaments: [], total: 0, hasMore: false } });
    expect(html).toContain('href="/app/series"');
    const css = readFileSync(new URL("../spa/src/tournaments/series.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
