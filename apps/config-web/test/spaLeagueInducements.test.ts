import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { effectiveInducements } from "../src/leagues/inducements";
import type { InducementTableView, SeasonInducements } from "../src/leagues/inducementRules";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  changeSummary, createInducementTable, draftFromTable, draftProblem, offeredByCategory, payloadFromDraft, resetStandard,
} from "../spa/src/leagues/inducements";
import type { LeagueSettingsView, LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";

// SPA league inducement table: the editor helpers and controller, the Inducements settings tab and the coaches' panel on
// the league page, server-rendered against a mocked Fetcher. Fake data only.

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

const keg = { id: "c-0000abcd", name: "Lucky Keg", price: 25_000, cap: 2, icon: "keg", effectText: "Once per game, reroll one KO recovery roll.", category: "special" as const };
const config = (): SeasonInducements => ({ standard: { bribes: { cap: 1, price: 150_000 }, weather_mage: { enabled: false } }, custom: [keg], revision: 4 });
const tableView = (over: Partial<InducementTableView> = {}): InducementTableView => ({
  leagueId: "tabbl", seasonId: "season-6", seasonName: "Season 6", ruleset: "BB2025", revision: 4, table: effectiveInducements(config()), canEdit: true, ...over,
});
const P = "/api/leagues/tabbl/seasons/season-6/inducements";

describe("editor helpers and controller", () => {
  it("draft round trip: only changed rows and the custom types are sent; reset puts the standard rows back", () => {
    const d = draftFromTable(tableView().table);
    expect(payloadFromDraft(d)).toEqual({
      standard: { bribes: { cap: 1, price: 150_000 }, weather_mage: { enabled: false } },
      custom: [{ id: "c-0000abcd", name: "Lucky Keg", price: 25_000, cap: 2, icon: "keg", effectText: keg.effectText, category: "special" }],
    });
    d.custom.push({ id: "", name: " New Thing ", price: 10_000, cap: 1, icon: "star", effectText: "", category: "staff" });
    expect(payloadFromDraft(d).custom.at(-1)).toEqual({ name: "New Thing", price: 10_000, cap: 1, icon: "star", effectText: "", category: "staff" }); // no id = new
    resetStandard(d);
    expect(payloadFromDraft(d).standard).toEqual({});
    expect(draftProblem(d)).toBe("");
    d.standard.find((r) => r.id === "bribes")!.price = 12_345;
    expect(draftProblem(d)).toMatch(/steps of 5,000/);
    d.standard.find((r) => r.id === "bribes")!.price = 100_000;
    d.standard.find((r) => r.id === "bribes")!.cap = 17;
    expect(draftProblem(d)).toMatch(/0 to 16/);
    d.standard.find((r) => r.id === "bribes")!.cap = 3;
    d.custom.push({ ...d.custom[0]!, id: "", name: "bribes" });
    expect(draftProblem(d)).toMatch(/already an inducement called bribes/);
  });

  it("coaches' grouping: offered rows only, by category; the change caption", () => {
    const t = tableView().table;
    const groups = offeredByCategory(t);
    expect(groups.map((g) => g.label)).toEqual(["Staff", "Star", "Special", "Mercenary"]); // the fixed category order
    const all = groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(all).toContain("c-0000abcd");
    expect(all).not.toContain("weather_mage");
    expect(all).not.toContain("canopic_jar"); // opt-in, off by default
    expect(changeSummary(t)).toBe("2 changed · 1 custom");
    expect(changeSummary(effectiveInducements(undefined))).toBe("");
  });

  it("controller: load, save sends the revision and the payload, a 409 reloads and says so", async () => {
    const f = mockFetcher({ [P]: tableView(), [`PUT ${P}`]: (b: unknown) => ({ ...tableView(), revision: (b as { revision: number }).revision + 1 }) });
    const c = createInducementTable({ api: f });
    await c.load("tabbl", "season-6");
    expect(c.state.view?.revision).toBe(4);
    expect(await c.save(draftFromTable(c.state.view!.table))).toBe(true);
    const put = f.calls.find((x) => x.method === "PUT")!;
    expect(put.body).toMatchObject({ revision: 4, standard: { bribes: { cap: 1 } }, custom: [{ id: "c-0000abcd" }] });
    expect(c.state.view?.revision).toBe(5);
    expect(c.state.notice).toBe("Inducements saved.");
    const stale = mockFetcher({ [P]: tableView({ revision: 9 }), [`PUT ${P}`]: new ApiError(409, "changed") });
    const c2 = createInducementTable({ api: stale });
    await c2.load("tabbl", "season-6");
    expect(await c2.save(draftFromTable(c2.state.view!.table))).toBe(false);
    expect(c2.state.saveError).toMatch(/Another organiser changed this table/);
    const missing = createInducementTable({ api: mockFetcher({}) });
    await missing.load("tabbl", "season-6");
    expect(missing.state.error).toBe("Season not found.");
  });
});

const s6: SeasonSummary = { id: "season-6", number: 6, name: "Season 6", ruleset: "BB2025", status: "active", teamCount: 0, fixtureCount: 0, playedCount: 0 };
const league = (): LeagueSummary => ({ id: "tabbl", name: "TABBL", fullName: "Test Area League", slug: "tabbl", description: "", organisers: ["Jay"], playOnFork: false, createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1, currentSeason: s6 });
const season6 = (): SeasonRecord => ({
  id: "season-6", leagueId: "tabbl", number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active", importedAt: "2026-10-30T00:00:00.000Z",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }], fixtures: [], participants: [], teams: [], honours: [], awards: [],
});
const settingsView = (): LeagueSettingsView => ({
  id: "tabbl", revision: 1,
  information: { name: "TABBL", fullName: "Test Area League", description: "", ruleset: "BB2025", mode: "individual" },
  permissions: { owner: "Jay", organisers: [], admins: [], canEditOrganisers: true, canChangeOwner: false },
  registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null },
  connections: { playOnFork: false, discord: { configured: false, maskedUrl: "", events: { news: true, fixtureCreated: true, matchStarted: true, matchResult: true, milestones: true } }, naf: { available: false, note: "" } },
  teamBuilding: { seasonId: "season-6", seasonName: "Season 6", ruleset: "BB2025", rules: { eliteSkills: [], rosters: [] } },
  regions: { US: [], CA: [] }, rulesets: ["BB2020", "BB2025"], eliteSkills: [],
} as unknown as LeagueSettingsView);

describe("Inducements tab and the coaches' panel (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    settings: typeof import("../spa/src/leagues/settings");
    league: typeof import("../spa/src/leagues/league");
    inducements: typeof import("../spa/src/leagues/inducements");
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, settings, league, inducements, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/settings.ts"), vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("/src/leagues/inducements.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      settings: settings as never, league: league as never, inducements: inducements as never,
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const SESSION = (coach: string) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", discordSsoEnabled: true } });
  const API: Routes = {
    "/api/leagues/tabbl": { league: league(), seasons: [s6] },
    "/api/leagues/tabbl/settings": { settings: settingsView() },
    "/api/leagues/tabbl/seasons/season-6": () => ({ league: league(), season: season6() }),
    "/crests/manifest.json": { crests: {} },
    [P]: tableView(),
  };
  async function render(path: string, coach: string, view: InducementTableView, prep: "settings" | "detail") {
    const f = mockFetcher({ ...API, ...SESSION(coach), [P]: view });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const table = mods.inducements.createInducementTable({ api: f });
    await table.load("tabbl", "season-6");
    spa.app.provide(mods.inducements.INDUCEMENT_TABLE_KEY, table);
    if (prep === "settings") {
      const s = mods.settings.createLeagueSettings({ api: f });
      await s.load("tabbl");
      spa.app.provide(mods.settings.LEAGUE_SETTINGS_KEY, s);
    } else {
      const d = mods.league.createLeagueDetail({ api: f });
      await d.load("tabbl");
      await d.ensureSeason("season-6");
      spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }

  it("settings tab: standard rows with toggle, cap and price; custom types with edit / remove; reset to defaults", async () => {
    const html = await render("/leagues/tabbl/settings?tab=inducements", "Jay", tableView(), "settings");
    expect(html).toMatch(/aria-current="page"[^>]*>Inducements</);
    for (const t of ["Inducement", "Offered", "Cap (0-16)", "Price (k)"]) expect(html).toContain(`>${t}</th>`);
    expect(html).toMatch(/data-id="bribes" data-changed="true"/);
    expect(html).toContain('aria-label="Bribes cap"');
    expect(html).toContain('value="150"'); // 150k
    expect(html).toContain("was 100k");
    expect(html).toMatch(/data-id="star_players"[\s\S]*?Own cost/);
    expect(html).toContain("Lucky Keg");
    expect(html).toContain('aria-label="Edit Lucky Keg"');
    expect(html).toContain('aria-label="Remove Lucky Keg"');
    expect(html).toContain(">Add inducement type</button>");
    expect(html).toContain(">Reset to defaults</button>");
    expect(html).toContain('src="/icons/inducements/bloodweiser_keg.png"');
  });

  it("league page Overview: the coaches' panel lists offered inducements with the league's own types", async () => {
    const coach = await render("/leagues/tabbl", "Mallory", tableView({ canEdit: false }), "detail");
    expect(coach).toContain('id="lg-ind-h"');
    expect(coach).toContain("2 changed · 1 custom");
    expect(coach).toContain("Lucky Keg");
    expect(coach).toContain(keg.effectText);
    expect(coach).toContain("Not offered this season: Weather Mage.");
    expect(coach).not.toContain("tab=inducements");
    const organiser = await render("/leagues/tabbl", "Jay", tableView(), "detail");
    expect(organiser).toContain('href="/app/leagues/tabbl/settings?tab=inducements"');
  });

  it("recorder picker: a league season's custom type shows its own icon and effect text next to the standard rows", async () => {
    const [renderer, picker] = await Promise.all([vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/TabletopInducementPicker.vue")]);
    const app = createSSRApp((picker as { default: object }).default, {
      side: "away", teamName: "Orc XI", coach: "Bob", busy: false, canEdit: true, submitted: false,
      icons: { bribes: "icons/inducements/bribe.png" },
      options: [
        { id: "bribes", name: "Bribes", price: 50_000, max: 1 },
        { id: "c-0000abcd", name: "Lucky Keg", price: 25_000, max: 2, custom: true, icon: "/icons/inducements/bloodweiser_keg.png", effectText: keg.effectText },
      ],
      budget: { role: "favourite", pettyCash: 0, treasury: 100_000, topUpLimit: 100_000, spent: 0, submitted: false },
    });
    const html = await (renderer as typeof import("vue/server-renderer")).renderToString(app);
    expect(html).toContain('src="/icons/inducements/bribe.png"');
    expect(html).toContain('src="/icons/inducements/bloodweiser_keg.png"');
    expect(html).toContain(`Lucky Keg<small class="tt-ipk-effect">${keg.effectText}</small>`);
    expect(html).toContain("25k");
  });
});
