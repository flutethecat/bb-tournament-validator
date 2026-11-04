import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  createQuickResults, filledGroups, flatItems, initialsOf, isSlashShortcut, moveActive, optionId, routeQuery, routeState, safeImage, searchPageLink, searchPath,
  type SearchResponse,
} from "../spa/src/search/search";
import { browseRows, emptyFilters, leagueFacets } from "../spa/src/leagues/browse";
import { emptyCompetitionFilters, passesCompetitionFilters } from "../src/search/filters";
import type { LeagueSummary, SeasonRecord } from "../spa/src/leagues/types";
import { teamByRef } from "../spa/src/leagues/league";

// Global site search in the SPA (owner 11-04): the header bar's helpers (request path, result order, keyboard), the Search
// page's route state, Browse leagues on the shared filters, and the server-rendered header bar and Search page.

const item = (type: "leagues" | "coaches" | "teams", id: string) => ({ type, id, title: id, url: `/x/${id}` });
const RES: SearchResponse = {
  q: "mud", type: "all",
  groups: {
    teams: { items: [item("teams", "t1")], total: 1, more: false },
    leagues: { items: [item("leagues", "l1"), item("leagues", "l2")], total: 9, more: true },
    tournaments: { items: [], total: 0, more: false },
    coaches: { items: [item("coaches", "c1")], total: 1, more: false },
  },
  facets: { rulesets: ["BB2025"], countries: [{ code: "GB", name: "United Kingdom" }] },
};

describe("header search helpers", () => {
  it("builds the request path: trimmed query, type, filters only for competition types, limits", () => {
    expect(searchPath({ q: "  mud ", type: "all", limit: 4 })).toBe("/api/search?q=mud&limit=4");
    const filters = { ...emptyCompetitionFilters(), countries: ["GB"], formats: ["season" as const], registrationOpen: true, rulesets: ["EuroBowl 2026"] };
    expect(searchPath({ q: "mud", type: "leagues", filters, offset: 20 })).toBe("/api/search?q=mud&type=leagues&ruleset=EuroBowl+2026&country=GB&format=season&open=1&offset=20");
    expect(searchPath({ q: "mud", type: "coaches", filters })).toBe("/api/search?q=mud&type=coaches");
    expect(searchPath({ q: "x".repeat(150), type: "all" }).length).toBeLessThan(130);
  });

  it("groups show in a fixed order (Leagues, Tournaments, Clubs, Coaches, Teams), empty ones left out", () => {
    expect(filledGroups(RES).map((g) => g.type)).toEqual(["leagues", "coaches", "teams"]);
    expect(flatItems(RES).map((i) => i.id)).toEqual(["l1", "l2", "c1", "t1"]);
    expect(flatItems(null)).toEqual([]);
  });

  it("arrow keys wrap through the results; / is the shortcut unless typing or with a modifier", () => {
    expect(moveActive(-1, 1, 4)).toBe(0);
    expect(moveActive(-1, -1, 4)).toBe(3);
    expect(moveActive(3, 1, 4)).toBe(0);
    expect(moveActive(0, -1, 4)).toBe(3);
    expect(moveActive(2, 1, 0)).toBe(-1);
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(isSlashShortcut(key("/"), false)).toBe(true);
    expect(isSlashShortcut(key("/"), true)).toBe(false);
    expect(isSlashShortcut(key("/", { ctrlKey: true }), false)).toBe(false);
    expect(isSlashShortcut(key("a"), false)).toBe(false);
    expect(optionId("ss", { type: "teams", id: "pub/season-1/grudge rollers" })).toBe("ss-teams-pub_season-1_grudge_rollers");
  });

  it("images are same-site routes only; initials fill in; See all keeps the query", () => {
    expect(safeImage("/api/coach-avatars/Amy?v=1")).toBe("/api/coach-avatars/Amy?v=1");
    expect(safeImage("https://cdn.example.com/a.png")).toBe("");
    expect(safeImage("javascript:alert(1)")).toBe("");
    expect(initialsOf("Grudge Rollers")).toBe("GR");
    expect(initialsOf("amy")).toBe("AM");
    expect(searchPageLink(" mud ")).toEqual({ name: "search", query: { q: "mud" } });
    expect(searchPageLink("")).toEqual({ name: "search", query: {} });
  });
});

describe("quick results are keyed by viewer (Sol review)", () => {
  function deferred() {
    const calls: Array<{ path: string; resolve: (v: unknown) => void }> = [];
    const api = <T>(path: string) => new Promise<T>((resolve) => { calls.push({ path, resolve: resolve as (v: unknown) => void }); });
    return { api, calls };
  }
  it("results never outlive a sign-out or a change of coach, and an answer in flight is dropped", async () => {
    let who = "Olga";
    const d = deferred();
    const quick = createQuickResults({ api: d.api, viewer: () => who });
    const first = quick.run("mud");
    d.calls[0]!.resolve(RES);
    expect(await first).toBe(true);
    expect(quick.results()?.q).toBe("mud");
    who = ""; // signed out: the cached results are not shown even before reset()
    expect(quick.results()).toBeNull();
    quick.reset();
    who = "Olga";
    expect(quick.results()).toBeNull(); // reset dropped them for good
    // In flight while the coach signs out: the late answer is ignored.
    const late = quick.run("mud");
    who = "";
    d.calls[1]!.resolve(RES);
    expect(await late).toBe(false);
    expect(quick.results()).toBeNull();
    // In flight across a reset (the header resets on a viewer change): ignored too.
    who = "Bob";
    const raced = quick.run("mud");
    quick.reset();
    d.calls[2]!.resolve(RES);
    expect(await raced).toBe(false);
    expect(quick.results()).toBeNull();
    expect(quick.state.loading).toBe(false);
  });
  it("a newer query wins over an older answer", async () => {
    const d = deferred();
    const quick = createQuickResults({ api: d.api, viewer: () => "" });
    const a = quick.run("mu");
    const b = quick.run("mud");
    d.calls[1]!.resolve({ ...RES, q: "mud" });
    d.calls[0]!.resolve({ ...RES, q: "mu" });
    expect(await b).toBe(true);
    expect(await a).toBe(false);
    expect(quick.results()?.q).toBe("mud");
  });
});

describe("league page opens a search team link", () => {
  it("?team= takes the team's lineage id (opaque), as well as its id and a unique name", () => {
    const t = (id: string, name: string, teamUid?: string) => ({ id, name, ...(teamUid ? { teamUid } : {}) });
    const s = { teams: [t("bashers--alice42", "Bashers"), t("bashers--bob77", "Bashers", "tm-0a1b2c3d4e5f")] } as unknown as SeasonRecord;
    expect(teamByRef(s, "tm-0a1b2c3d4e5f")?.id).toBe("bashers--bob77");
    expect(teamByRef(s, "bashers--alice42")?.id).toBe("bashers--alice42");
    expect(teamByRef(s, "")).toBeUndefined();
  });
});

describe("Search page route state", () => {
  it("reads and writes ?q=&type=&filters, dropping unknown values and filters on non-competition tabs", () => {
    const s = routeState({ q: "mud", type: "leagues", country: "gb", format: ["season", "nope"], playedOn: "fork", open: "1", ruleset: ["EuroBowl 2026"], region: "North" });
    expect(s).toEqual({ q: "mud", type: "leagues", filters: { rulesets: ["EuroBowl 2026"], countries: ["GB"], region: "North", formats: ["season"], playedOn: ["fork"], registrationOpen: true } });
    expect(routeQuery(s)).toEqual({ q: "mud", type: "leagues", ruleset: "EuroBowl 2026", country: "GB", region: "North", format: "season", playedOn: "fork", open: "1" });
    expect(routeState({ type: "bogus" }).type).toBe("all");
    expect(routeQuery({ ...s, type: "coaches" })).toEqual({ q: "mud", type: "coaches" });
    expect(routeState(routeQuery(s))).toEqual(s);
  });
});

describe("Browse leagues on the shared filters", () => {
  const league = (over: Partial<LeagueSummary> & { id: string }): LeagueSummary => ({
    name: over.id, fullName: "", slug: over.id, description: "", organisers: [], createdAt: "2026-10-01T00:00:00.000Z", seasonCount: 1,
    browse: { status: "in-progress", registrationOpen: false, regions: [], seasons: [], teams: [] }, ...over,
  });
  it("Played on and Registration open give the same answer as the shared predicate the server uses", () => {
    const all = [league({ id: "a", playOnFork: true }), league({ id: "b", browse: { status: "registration", registrationOpen: true, regions: [], seasons: [], teams: [] } })];
    for (const f of [{ playedOn: ["fork" as const], registrationOpen: false }, { playedOn: [], registrationOpen: true }, { playedOn: ["tabletop" as const], registrationOpen: true }]) {
      const browse = browseRows(all, "", { ...emptyFilters(), ...f }).map((r) => r.l.id);
      const shared = all.filter((l) => passesCompetitionFilters(leagueFacets(l), { ...emptyCompetitionFilters(), ...f })).map((l) => l.id);
      expect(browse).toEqual(shared);
    }
  });
});

describe("server-rendered header search and Search page", () => {
  const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: unknown; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const fetcher = (): Fetcher => (async (path: string) => {
    if (path === "/api/auth/session") return { authenticated: false, discordSsoEnabled: true };
    if (path.startsWith("/api/search")) return RES;
    if (path === "/api/build-log") return { entries: [] };
    throw new ApiError(404, `no mock for ${path}`);
  }) as Fetcher;
  async function render(path: string): Promise<string> {
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: fetcher() });
    await spa.router.push(path);
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }

  it("every page carries the header search: a combobox with the / hint and the phone icon, before the account control", async () => {
    const html = await render("/leaderboards");
    expect(html).toMatch(/<div class="ss"[^>]*data-sheet="false"/);
    expect(html).toMatch(/<input[^>]*class="ss-input"[^>]*role="combobox"[^>]*aria-expanded="false"[^>]*aria-controls="ss-list"/);
    expect(html).toContain('aria-label="Search the site (/)"');
    expect(html).toContain('<kbd class="ss-kbd" aria-hidden="true">/</kbd>');
    expect(html.indexOf('class="ss"')).toBeLessThan(html.indexOf('class="shell-who"'));
    // Not inside the account control's live region (results would be read out as they change).
    expect(html).not.toMatch(/class="shell-who"[^>]*>(?:(?!<\/div>).)*class="ss"/s);
  });

  it("the Search page: type tabs, the competition filters on All / Leagues / Tournaments only", async () => {
    const leagues = await render("/search?q=mud&type=leagues&country=GB&format=ladder&open=1");
    expect(leagues).toMatch(/<h2 id="sp-tools-h">Search<\/h2>/);
    expect(leagues).toMatch(/data-type="leagues" aria-pressed="true"/);
    expect(leagues).toMatch(/data-filter="format:ladder" aria-pressed="true"/);
    expect(leagues).toMatch(/data-filter="open" aria-pressed="true"/);
    expect(leagues).toContain('data-filter="ruleset"');
    expect(leagues).toContain('data-filter="region"');
    const coaches = await render("/search?q=mud&type=coaches&country=GB");
    expect(coaches).toMatch(/data-type="coaches" aria-pressed="true"/);
    expect(coaches).not.toContain('data-filter="ruleset"');
  });
});
