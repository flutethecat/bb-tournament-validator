import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import type { LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";
import { comingSoon, notYetEarned, type BadgeView, type LeagueBadgesView } from "../spa/src/badges/badges";

// Badges (badges lane 11-04), server-rendered through the SPA's Vite config against a mocked Fetcher: the badge strip
// (chips, tiers, greyed "coming soon"), and the league Awards tab's Badges panel for the public and for organisers.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher {
  return (async (path: string, init?: { method?: string; body?: unknown }) => {
    const key = init?.method && init.method !== "GET" ? `${init.method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${key}`);
    return hit;
  }) as Fetcher;
}

const s1: SeasonSummary = { id: "season-1", number: 1, name: "Season 1", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 0, playedCount: 0 };
const league = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-01T00:00:00.000Z", seasonCount: 1, currentSeason: s1 } as LeagueSummary;
const season = { id: "season-1", leagueId: "tabbl", number: 1, name: "Season 1", sourceSlug: "season-1", ruleset: "BB2025", status: "active", importedAt: "2026-10-01T00:00:00.000Z", phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], source: "manual" } as unknown as SeasonRecord;
const BADGE: BadgeView = { id: "first-win||coach|ann", badgeId: "first-win", source: "site", name: "First win", description: "Won a game.", icon: "star", glyph: "⭐", kind: "badge", at: "2026-10-20T00:00:00.000Z", label: "TABBL" };
const VIEW = (manage: boolean): LeagueBadgesView => ({
  revision: 3, manage,
  badges: [{ id: "cb-1", name: "Iron Man", description: "Played through the flu.", icon: "heart", glyph: "❤️", scope: "both", awards: 1, createdBy: "Jay" }],
  recent: [{ id: "ca-1", badgeId: "cb-1", source: "league", name: "Iron Man", description: "", icon: "heart", glyph: "❤️", kind: "custom", at: "2026-10-21T00:00:00.000Z", by: "Jay", to: { kind: "coach", name: "Ann" } }],
  ...(manage ? { log: [{ id: "l1", at: "2026-10-21T00:00:00.000Z", action: "award", badgeId: "cb-1", subject: { kind: "coach", name: "Ann" }, by: "Jay" }], members: { coaches: ["Ann"], teams: [] }, icons: [] } : {}),
});

describe("SPA: badges", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: any;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, lg, honours, badges, vueRouter, renderer, strip] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/leagues/honours.ts"), vite.ssrLoadModule("/src/badges/badges.ts"),
      vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/BadgeStrip.vue"),
    ]);
    m = { app, lg, honours, badges, vueRouter, renderer, Strip: strip.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  it("helpers: the coming-soon list is the catalog's needs-recorder-data entries; not-yet-earned leaves out earned ones", () => {
    expect(comingSoon().map((d) => d.id)).toEqual(["underdog"]);
    const left = notYetEarned([BADGE]).map((d) => d.id);
    expect(left).not.toContain("first-win");
    expect(left).toContain("games-10");
    expect(left).not.toContain("underdog");
  });

  it("the strip: one chip per badge with its glyph, name, tier and where; coming soon greyed; compact = glyph tiles with labels", async () => {
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] });
    const render = async (props: Record<string, unknown>) => {
      const app = createSSRApp({ render: () => h(m.Strip, props) });
      app.use(router);
      await router.push("/");
      return (await m.renderer.renderToString(app)).replace(/<!--[^>]*-->/g, "");
    };
    const games = { ...BADGE, id: "g", badgeId: "games-50", name: "50 games", tier: "silver", link: "/leagues/tabbl?season=season-1" };
    let html = await render({ badges: [BADGE, games], soon: comingSoon(), label: "My badges" });
    expect(html).toContain('aria-label="My badges"');
    expect(html).toMatch(/data-kind="badge"[^>]*data-badge="first-win"[^]*⭐[^]*First win[^]*TABBL/);
    expect(html).toMatch(/<a[^>]*href="\/leagues\/tabbl\?season=season-1"[^>]*class="bd-chip"[^>]*data-tier="silver"/);
    expect(html).toMatch(/data-soon="true" data-badge="underdog"[^]*Underdog[^]*Coming soon/);
    html = await render({ badges: [BADGE, games], compact: true, max: 1, label: "Ann badges" });
    expect(html).toContain('data-compact="true"');
    expect(html).not.toContain('class="bd-name"');
    expect(html).toContain('aria-label="Badge: First win. Won a game.');
    expect(html).toContain("+1");
  });

  async function awardsTab(view: LeagueBadgesView, session: Routes) {
    const f = mockFetcher({
      "/api/leagues/tabbl": { league, seasons: [s1] }, "/api/leagues/tabbl/seasons/season-1": { league, season }, "/crests/manifest.json": { crests: {} },
      "/api/leagues/tabbl/honours": { revision: 1, hallOfFame: [], pins: [], awards: [] }, "/api/badges/league/tabbl": view, ...session,
    });
    const spa = m.app.createSpa({ history: m.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = m.lg.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-1");
    spa.app.provide(m.lg.LEAGUE_DETAIL_KEY, d);
    const hs = m.honours.createHonours({ api: f });
    await hs.load("tabbl");
    spa.app.provide(m.honours.LEAGUE_HONOURS_KEY, hs);
    const bd = m.badges.createLeagueBadges(f);
    await bd.load("tabbl");
    spa.app.provide(m.badges.LEAGUE_BADGES_KEY, bd);
    await spa.router.push("/leagues/tabbl?tab=awards");
    await spa.router.isReady();
    return (await m.renderer.renderToString(spa.app)).replace(/<!--[^>]*-->/g, "");
  }

  it("league Awards tab, public: the Badges panel lists the league's badges and recent awards, with no organiser controls", async () => {
    const html = await awardsTab(VIEW(false), { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
    expect(html).toContain('class="lg-stack bd-awards-split"');
    expect(html).toMatch(/data-league-badges[^]*Badges[^]*Iron Man[^]*Played through the flu\.[^]*1 award · Coaches and teams/);
    expect(html).toMatch(/Ann<\/span> earned <strong>Iron Man<\/strong>[^]*Given by Jay/);
    for (const s of ["New badge", ">Award<", ">Revoke<", "Badge log"]) expect(html).not.toContain(s);
  });

  it("league Awards tab, organiser: New badge, Award, Archive, Revoke and the log", async () => {
    const html = await awardsTab(VIEW(true), { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } });
    for (const s of [">New badge<", ">Award<", ">Archive<", ">Revoke<", 'aria-label="Badge log"', "Jay awarded Iron Man for Ann"]) expect(html).toContain(s);
  });
});
