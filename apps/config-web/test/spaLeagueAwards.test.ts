import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import type { HonoursView } from "../spa/src/leagues/honours";
import type { LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";

// League page Honours tab (Hall of Fame + Awards), the Give award dialog and the honours controller, server-rendered
// through the SPA's Vite config against a mocked Fetcher (as in spaLeagues.test.ts). Fake coaches and teams only.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
type Call = { path: string; init?: { method?: string; body?: unknown } };
function mockFetcher(routes: Routes): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    const key = init?.method && init.method !== "GET" ? `${init.method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${key}`);
    if (hit instanceof ApiError) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}

const s2: SeasonSummary = { id: "season-2", number: 2, name: "Season 2", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 0, playedCount: 0 };
const s1: SeasonSummary = { id: "season-1", number: 1, name: "Season 1", ruleset: "BB2020", status: "completed", teamCount: 2, fixtureCount: 1, playedCount: 1 };
const league: LeagueSummary = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-01T00:00:00.000Z", seasonCount: 2, currentSeason: s2 } as LeagueSummary;
const season2 = (): SeasonRecord => ({
  id: "season-2", leagueId: "tabbl", number: 2, name: "Season 2", sourceSlug: "season-2", ruleset: "BB2025", status: "active", importedAt: "2026-10-01T00:00:00.000Z",
  phases: [], fixtures: [], participants: [],
  teams: [{ id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [] }],
  honours: [], awards: [], unattributedStats: [], source: "manual",
} as unknown as SeasonRecord);

const HONOURS = (): HonoursView => ({
  revision: 3,
  hallOfFame: [{
    seasonId: "season-1", number: 1, name: "Season 1", ruleset: "BB2020", startedAt: "2025-01-01T00:00:00.000Z", endedAt: "2025-06-01T00:00:00.000Z", source: "podium",
    champion: { team: "Orcs", coach: "Ann", race: "Orc" }, runnerUp: { team: "Elves", coach: "Bob", race: "Wood Elf" },
  }],
  pins: [
    { id: "p-1", kind: "record", text: "Most TDs in a season: 31", note: "Season 1", by: "Jay", at: "2026-10-05T00:00:00.000Z", resolved: { title: "Most TDs in a season: 31" } },
    { id: "p-2", kind: "champion", seasonId: "season-0", note: "", by: "Jay", at: "2026-10-05T00:00:00.000Z" },
  ],
  awards: [
    { id: "a-1", source: "custom", title: "Best sportsmanship", icon: "captain", toTeam: "Orcs", teamId: "orcs", toCoach: "Ann", race: "Orc", seasonId: "season-2", seasonName: "Season 2", note: "Always on time.", by: "Jay", at: "2026-10-20T00:00:00.000Z", star: false },
    { id: "s-1", source: "podium", title: "Overall Champion", icon: "legend", toTeam: "Orcs", toCoach: "Ann", race: "Orc", seasonId: "season-1", seasonName: "Season 1", note: "", at: "2025-06-01T00:00:00.000Z", star: true },
  ],
  recipients: {
    seasons: [{ id: "season-2", name: "Season 2", number: 2 }, { id: "season-1", name: "Season 1", number: 1 }],
    teams: [{ seasonId: "season-2", id: "orcs", name: "Orcs", race: "Orc", coach: "Ann" }, { seasonId: "season-1", id: "elves", name: "Elves", race: "Wood Elf", coach: "Bob" }],
    coaches: [{ name: "Ann", seasonIds: ["season-2"] }, { name: "Bob", seasonIds: ["season-1"] }],
  },
});
const PUBLIC = (): HonoursView => { const { recipients: _r, ...v } = HONOURS(); return v; };

const API: Routes = {
  "/api/leagues/tabbl": { league, seasons: [s2, s1] },
  "/api/leagues/tabbl/seasons/season-2": { league, season: season2() },
  "/crests/manifest.json": { crests: { orc: "crests/orc.png" } },
};
const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };

describe("SPA: league awards and Hall of Fame", () => {
  let vite: ViteDevServer | undefined;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    league: typeof import("../spa/src/leagues/league");
    honours: typeof import("../spa/src/leagues/honours");
    GiveAward: unknown;
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, honours, vueRouter, renderer, give] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/leagues/honours.ts"),
      vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/LeagueGiveAward.vue"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      league: league as typeof import("../spa/src/leagues/league"), honours: honours as typeof import("../spa/src/leagues/honours"), GiveAward: give.default,
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, view: HonoursView, session: Routes) {
    const f = mockFetcher({ ...API, ...session, "/api/leagues/tabbl/honours": view });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-2");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const hs = mods.honours.createHonours({ api: f });
    await hs.load("tabbl");
    spa.app.provide(mods.honours.LEAGUE_HONOURS_KEY, hs);
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderToString(spa.app)).replace(/<!--[^>]*-->/g, "");
  }

  it("public Honours tab: Hall of Fame card (crest, champion, runner-up, dates), resolved pins only, awards newest first, no organiser controls", async () => {
    const html = await render("/leagues/tabbl?tab=honours", PUBLIC(), ANON);
    expect(html).toContain('aria-labelledby="hof-h"');
    expect(html).toMatch(/data-season="season-1"[^]*src="\/crests\/orc.png"[^]*Champion[^]*class="hof-team">Orcs<[^]*class="hof-coach">Ann<[^]*Runner-up<\/span> Elves/);
    expect(html).toContain("1 Jan 2025 – 1 Jun 2025");
    expect(html).toContain("Most TDs in a season: 31");
    expect(html).not.toContain("No longer recorded"); // the stale pin is hidden from the public
    expect(html).toMatch(/data-award-id="a-1"[^]*Best sportsmanship[^]*Orcs · Ann · Orc[^]*Season 2 · 20 Oct 2026 · Given by Jay[^]*Always on time\.[^]*data-award-id="s-1"[^]*Overall Champion<\/span><span class="aw-star"/);
    expect(html).toContain('src="/icons/builder/team-captain-gold-48.png"');
    for (const s of ["Give award", "Add a record", ">Pin<", "Unpin", ">Remove<"]) expect(html).not.toContain(s);
  });

  it("organiser Honours tab: Give award, Add a record, Pin, Up / Down / Unpin, Remove on given awards only; the stale pin shows", async () => {
    const html = await render("/leagues/tabbl?tab=honours", HONOURS(), ORGANISER);
    expect(html).toContain(">Give award<");
    expect(html).toContain(">Add a record<");
    expect(html).toContain("No longer recorded");
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Move Most TDs in a season: 31 up"/);
    expect(html).toContain('aria-label="Pin the Season 1 champion"');
    const items = html.split('class="aw-item"').slice(1);
    const custom = items.find((i) => i.includes('data-award-id="a-1"'))!;
    const podium = items.find((i) => i.includes('data-award-id="s-1"'))!;
    expect(custom).toContain(">Remove<");
    expect(podium).not.toContain(">Remove<");
    expect(podium).toContain(">Podium<");
  });

  it("Teams tab: a team's awards show in its roster panel", async () => {
    const html = await render("/leagues/tabbl?tab=teams&team=orcs", PUBLIC(), ANON);
    expect(html).toMatch(/aria-label="Orcs awards"[^]*Best sportsmanship/);
    expect(html).not.toMatch(/aria-label="Orcs awards"[^]*Overall Champion/); // that one is Season 1's
  });

  it("Give award dialog: title, icon radio group (our icons), season, team / coach recipient, note", async () => {
    const f = mockFetcher({ "/api/leagues/tabbl/honours": HONOURS() });
    const hs = mods.honours.createHonours({ api: f });
    await hs.load("tabbl");
    const app = createSSRApp({ render: () => h(mods.GiveAward as never) });
    app.provide(mods.honours.LEAGUE_HONOURS_KEY, hs);
    const html = (await mods.renderToString(app)).replace(/<!--[^>]*-->/g, "");
    expect(html).toContain('role="dialog"');
    expect(html).toContain(">Give award</h2>");
    expect(html).toContain('role="radiogroup" aria-label="Icon"');
    expect(html.match(/role="radio"/g)).toHaveLength(Object.keys(mods.honours.AWARD_ICONS).length);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Star"/);
    expect(html).toContain("League-wide (no season)");
    expect(html).toContain("Orcs (Ann, Orc) · Season 2");
    expect(html).toContain("Elves (Bob, Wood Elf) · Season 1");
    expect(html).not.toMatch(/class="[^"]*lobby-/);
  });

  it("controller: give / remove / pin / move send the loaded revision; a 409 reloads", async () => {
    let posted: unknown;
    const after = { ...HONOURS(), revision: 4 };
    const f = mockFetcher({
      "/api/leagues/tabbl/honours": HONOURS(),
      "POST /api/leagues/tabbl/awards": (b: unknown) => { posted = b; return { honours: after }; },
      "PUT /api/leagues/tabbl/hall-of-fame/order": (b: unknown) => { posted = b; return { honours: after }; },
      "DELETE /api/leagues/tabbl/awards/a-1": new ApiError(409, "changed", { revision: 9 }),
    });
    const hs = mods.honours.createHonours({ api: f });
    await hs.load("tabbl");
    expect(await hs.give({ title: "Fair play", icon: "star", recipient: { kind: "coach", coach: "Ann" }, note: "" })).toBe(true);
    expect(posted).toEqual({ title: "Fair play", icon: "star", recipient: { kind: "coach", coach: "Ann" }, note: "", seasonId: null, revision: 3 });
    expect(hs.state.view!.revision).toBe(4);
    expect(hs.state.notice).toBe('Award "Fair play" given.');
    expect(await hs.move("p-2", -1)).toBe(true);
    expect(posted).toEqual({ order: ["p-2", "p-1"], revision: 4 });
    expect(await hs.move("p-1", -1)).toBe(false); // already first: nothing sent
    const before = f.calls.filter((c) => c.path === "/api/leagues/tabbl/honours").length;
    expect(await hs.removeAward("a-1")).toBe(false);
    expect(hs.state.writeError).toBe("changed");
    expect(f.calls.filter((c) => c.path === "/api/leagues/tabbl/honours").length).toBe(before + 1);
  });
});
