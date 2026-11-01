import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createCoachTree, treeLeagues } from "../spa/src/home/tree";

// Sidebar Leagues section (spec-main-landing-nav §2): the coach's leagues from GET /api/me/leagues, each with the coach's
// team (crest, name, race, W-D-L chip) and next fixture; "No active leagues" when signed out or none. Plus the dead-link
// sweep: every static in-app link in the SPA resolves to a real route.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const NBSP = String.fromCharCode(160);
const SPA_SRC = fileURLToPath(new URL("../spa/src", import.meta.url));

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher {
  return (async (path: string) => {
    const hit = routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    return hit;
  }) as Fetcher;
}

const myLeagues = () => ({
  leagues: [
    {
      id: "alpha", name: "Alpha League", season: { id: "season-2", number: 2, name: "Season 2" }, to: "/leagues/alpha",
      teams: [{
        id: "orcs", name: "Alpha Orcs", race: "Orc", record: { wins: 3, draws: 1, losses: 2 }, to: "/leagues/alpha?tab=teams&team=orcs",
        next: { id: "f9", round: 7, opponent: "Beta Elves", home: true, to: "/leagues/alpha?tab=fixtures&fixture=f9" },
      }],
    },
    {
      id: "beta", name: "Beta Cup", season: { id: "season-3", number: 3, name: "Season 3" }, to: "/leagues/beta?season=season-3",
      teams: [{ id: "dwarfs", name: "Stout Dwarfs", race: "Dwarf", record: { wins: 0, draws: 0, losses: 0 }, to: "/leagues/beta?season=season-3&tab=teams&team=dwarfs", next: null }],
    },
    // malformed rows are dropped
    { id: "evil", name: "Evil", to: "javascript:alert(1)", teams: [] },
    { id: "evil2", name: "Evil 2", to: "/leagues/evil2", teams: [{ name: "X", race: "Orc", to: "//elsewhere.example.com", record: {}, next: null }] },
  ],
});

function signedIn(extra: Routes = {}): Routes {
  return {
    "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
    "/api/fork/tournaments?coach=me&limit=12": { tournaments: [], hasMore: false },
    "/api/fork/tournaments?status=draft&coach=me&limit=12": { tournaments: [], hasMore: false },
    "/api/fork/tournaments?status=completed&coach=me&limit=5": { tournaments: [], hasMore: false },
    "/api/tabletop/fixtures": { fixtures: [] },
    "/api/me/deadlines": { timezone: "Europe/London", deadlines: [] },
    "/crests/manifest.json": { crests: { orc: "crests/orc.png", dwarf: "crests/dwarf.png" } },
    "/api/me/leagues": myLeagues(),
    ...extra,
  };
}

describe("nav tree: leagues", () => {
  it("treeLeagues: label, record chip text, crest, and only app paths", () => {
    const rows = treeLeagues(myLeagues().leagues, { crests: { crests: { orc: "crests/orc.png" } } });
    expect(rows.map((l) => l.id)).toEqual(["alpha", "beta", "evil2"]);
    expect(rows[0]!.teams[0]).toEqual({
      key: "alpha:orcs", name: "Alpha Orcs", race: "Orc", crest: "/crests/orc.png", record: "3-1-2", to: "/leagues/alpha?tab=teams&team=orcs",
      fixture: { label: `vs Beta Elves · Round${NBSP}7`, to: "/leagues/alpha?tab=fixtures&fixture=f9" },
    });
    expect(rows[1]!.teams[0]).toMatchObject({ record: "0-0-0", fixture: null, crest: "" });
    expect(rows[2]!.teams).toEqual([]);
    expect(treeLeagues(undefined, { crests: undefined })).toEqual([]);
  });

  it("the controller reads GET /api/me/leagues; a failing read leaves no leagues; sign-out clears them", async () => {
    const tree = createCoachTree({ api: mockFetcher(signedIn()) });
    await tree.load("Alice");
    expect(tree.state.leagues.map((l) => l.name)).toEqual(["Alpha League", "Beta Cup", "Evil 2"]);
    await tree.load("");
    expect(tree.state.leagues).toEqual([]);
    const failing = createCoachTree({ api: mockFetcher({}) });
    await failing.load("Alice");
    expect(failing.state).toMatchObject({ leagues: [], loaded: true });
  });
});

describe("sidebar Leagues section (SSR)", () => {
  let vite: ViteDevServer | undefined;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: unknown; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; resolve: (p: string) => { name: unknown } };
      ui: { collapsed: boolean; drawerOpen: boolean; narrow: boolean };
    };
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

  async function render(path: string, routes: Routes, setup?: (spa: ReturnType<typeof mods.createSpa>) => void) {
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: mockFetcher(routes) });
    setup?.(spa);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa };
  }
  const leaguesOf = (html: string) => html.slice(html.indexOf('data-tree="leagues"'), html.indexOf('data-tree="tournaments"'));
  const rowFor = (html: string, href: string) => html.match(new RegExp(`<a href="${href.replace(/[?]/g, "\\?")}" class="sf-row"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? "";

  it("two leagues: league row, indented team row (crest, name, race, W-D-L chip), next fixture row; Browse Leagues stays", async () => {
    const { html } = await render("/home", signedIn());
    const nav = leaguesOf(html);
    expect(nav).not.toContain("No active leagues");
    expect(rowFor(nav, "/app/leagues/alpha")).toMatch(/data-level="1"[\s\S]*Alpha League/);
    const team = rowFor(nav, "/app/leagues/alpha?tab=teams&amp;team=orcs");
    expect(team).toContain('data-level="2"');
    expect(team).toMatch(/src="\/crests\/orc.png"[\s\S]*Alpha Orcs[\s\S]*class="sf-sub">Orc<[\s\S]*class="sf-chip" data-tone="muted">3-1-2</);
    expect(rowFor(nav, "/app/leagues/alpha?tab=fixtures&amp;fixture=f9")).toMatch(/data-level="3"[\s\S]*vs Beta Elves · Round\u00a07/);
    expect(rowFor(nav, "/app/leagues/beta?season=season-3")).toContain("Beta Cup");
    expect(nav).toMatch(/href="\/app\/leagues\/beta\?season=season-3&amp;tab=fixtures" class="sf-row"[^>]*data-muted="true"[^>]*>[\s\S]*No fixture yet/);
    expect(nav).toMatch(/>Leagues<\/span><\/a><span class="sf-count"[^>]*>3</);
    expect(nav).toMatch(/<a href="\/app\/leagues" class="sf-nav-btn" data-action="a:leagues">Browse Leagues<\/a>/);
    expect(nav).not.toContain("javascript:");
    expect(nav).not.toContain("elsewhere.example.com");
  });

  it("the fixture row is the one active row on its fixture page", async () => {
    const { html } = await render("/leagues/alpha?tab=fixtures&fixture=f9", { ...signedIn(), "/api/leagues/alpha": { league: { id: "alpha", name: "Alpha League" }, seasons: [] } });
    const nav = html.slice(html.indexOf('<nav class="sf-nav"'), html.indexOf("</nav>"));
    const active = nav.match(/<a href="([^"]+)" class="sf-(?:row|top-link|head-link)"[^>]*data-active="true"[^>]*>/g) ?? [];
    expect(active).toHaveLength(1);
    expect(active[0]).toContain('href="/app/leagues/alpha?tab=fixtures&amp;fixture=f9"');
  });

  it("no leagues, or signed out: the muted note as before", async () => {
    const none = leaguesOf((await render("/home", signedIn({ "/api/me/leagues": { leagues: [] } }))).html);
    expect(none).toMatch(/href="\/app\/leagues" class="sf-row"[^>]*data-muted="true"[^>]*>[\s\S]*No active leagues/);
    expect(none).not.toContain('class="sf-count"');
    const out = leaguesOf((await render("/leagues", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true }, "/api/me/leagues": myLeagues(), "/api/leagues": { leagues: [] } })).html);
    expect(out).toContain("No active leagues");
    expect(out).not.toContain("Alpha League");
  });

  it("collapsed rail: the Leagues icon stays and the rows hide with the rest", async () => {
    const { html } = await render("/home", signedIn(), (spa) => { spa.ui.collapsed = true; });
    expect(html).toContain('<nav class="sf-nav" data-collapsed="true"');
    expect(leaguesOf(html)).toContain('src="/icons/nav/leagues.png"');
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sf-nav\[data-collapsed="true"\] \.sf-rows \{ display: none; \}/);
  });

  it("every static in-app link in the SPA resolves to a route (no dead links such as /series/...)", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(vue|ts)$/.test(n)) files.push(p); } };
    walk(SPA_SRC);
    const targets = new Set<string>();
    const patterns = [
      /\bto="(\/[^"]*)"/g, // <RouterLink to="/x">
      /:to="`(\/[^`]*)`"/g, // :to="`/x/${id}`"
      /\bto: ?"(\/[^"]*)"/g, // { to: "/x" }
      /\bto: ?`(\/[^`]*)`/g,
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of patterns) for (const m of text.matchAll(re)) targets.add(m[1]!.replace(/\$\{[^}]*\}/g, "x1"));
    }
    expect(targets.size).toBeGreaterThan(10);
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: mockFetcher({}) });
    const dead = [...targets].filter((t) => spa.router.resolve(t.split(/[?#]/)[0]!).name === "not-found");
    expect(dead).toEqual([]);
  });

  it("league registration settings no longer point at a Participants tab that does not exist", () => {
    const src = readFileSync(join(SPA_SRC, "components", "LeagueSettingsRegistrations.vue"), "utf8");
    const template = src.slice(src.indexOf("<template>"));
    expect(template).not.toContain("Participants tab");
    expect(template).toContain("Teams tab");
  });
});
