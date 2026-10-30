import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  applyTierFill, createLeagueSettings, isSettingsTab, isWebhookUrl, nextSeasonDefaults, openSeason, openSeasons, postcodeError, teamBuildingError, tierFillPlan,
} from "../spa/src/leagues/settings";
import { createFixtureRows, createLeagueDetail, newFixtureError, newsList } from "../spa/src/leagues/league";
import type { LeagueFixture, LeagueSettingsView, LeagueSummary, SeasonRecord, SeasonSummary, TeamBuildingRosterRule } from "../spa/src/leagues/types";

// SPA League settings: the controller and helpers, every tab server-rendered against a mocked Fetcher, the cog on the
// league page by role, and the per-fixture Super FUMBBL switch.

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

const s6: SeasonSummary = { id: "season-6", number: 6, name: "Season 6", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 2, playedCount: 0 };
const s5: SeasonSummary = { id: "season-5", number: 5, name: "Season 5", ruleset: "BB2020", status: "completed", teamCount: 2, fixtureCount: 1, playedCount: 1 };
const league = (over: Partial<LeagueSummary> = {}): LeagueSummary => ({
  id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", description: "", organisers: ["Jay", "Kainis"], playOnFork: true,
  createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 2, currentSeason: s6, ...over,
});

const view = (over: Partial<LeagueSettingsView> = {}): LeagueSettingsView => ({
  id: "tabbl", revision: 3,
  information: { name: "TABBL", fullName: "Tahoma Area Blood Bowl League", description: "Weekly league.", ruleset: "BB2025", mode: "individual",
    address: { country: "CA", region: "BC", postcode: "V6B 4Y8", locality: "Vancouver", street: "1 Main St" } },
  permissions: { owner: "Jay", organisers: ["Kainis"], admins: ["Root"], canEditOrganisers: true, canChangeOwner: false },
  registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: 24, maxPerRace: null },
  connections: {
    playOnFork: true,
    discord: { configured: true, maskedUrl: "https://discord.com/api/webhooks/…/•••", events: { news: true, fixtureCreated: true, matchStarted: false, matchResult: true, milestones: true } },
    naf: { available: false, note: "NAF results reporting is available for tournaments only." },
  },
  teamBuilding: { seasonId: "season-6", seasonName: "Season 6", ruleset: "BB2025", rules: { eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"], rosters: [
    { roster: "Amazon", tier: 1, treasury: 1000, startingSkills: { primary: 0, secondary: 0, elite: 0 } },
    { roster: "Black Orc", tier: 2, treasury: 1100, startingSkills: { primary: 2, secondary: 1, elite: 1 } },
  ] } },
  regions: { US: [{ code: "WA", name: "Washington" }], CA: [{ code: "BC", name: "British Columbia" }, { code: "ON", name: "Ontario" }] },
  rulesets: ["BB2020", "BB2025"],
  eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"],
  ...over,
});

const fx = (id: string, scored: boolean, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Grudge Rollers", coach: "Jay", coachId: "Jay", race: "Dwarf", score: scored ? 2 : null, cas: scored ? 1 : null, conceded: false },
  away: { team: "Rot Girl Summer", coach: "Jeff", race: "Nurgle", score: scored ? 1 : null, cas: scored ? 0 : null, conceded: false },
  suspended: false, ...over,
});
const season6 = (): SeasonRecord => ({
  id: "season-6", leagueId: "tabbl", number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active", importedAt: "2026-10-30T00:00:00.000Z",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [fx("f1", false, { forkEnabled: true }), fx("f2", false), fx("f3", true)], participants: [], teams: [], honours: [], awards: [],
});

const API: Routes = {
  "/api/leagues/tabbl": { league: league(), seasons: [s5, s6] },
  "/api/leagues/tabbl/settings": { settings: view() },
  // fresh per call: a test that flips a fixture must not leak into the next render
  "/api/leagues/tabbl/seasons/season-6": () => ({ league: league(), season: season6() }),
  "/crests/manifest.json": { crests: {} },
};

describe("league settings helpers and controller", () => {
  it("[review P2] fixtures editor rows never leak between seasons that reuse fixture ids", () => {
    const rows = createFixtureRows();
    const a = fx("f1", true);
    const b = fx("f1", false, { date: "2026-12-01" });
    rows.sync("season-5", [a]);
    rows.rowOf("season-5", a).home = "7"; // a pending edit in Season 5
    rows.sync("season-6", [b]);
    expect(rows.rowOf("season-6", b)).toEqual({ date: "2026-12-01", home: "", away: "", homeCas: "", awayCas: "" });
    expect(rows.has("season-5", "f1")).toBe(false); // switching seasons dropped the pending edit
    rows.sync("season-5", [a]);
    expect(rows.rowOf("season-5", a).home).toBe("2"); // fresh from the stored fixture, not the abandoned "7"
    rows.drop("season-5", "f1");
    expect(rows.has("season-5", "f1")).toBe(false);
  });

  it("overlapping seasons: every open season, newest first; the newest is the current one", () => {
    const s7: SeasonSummary = { ...s6, id: "season-7", number: 7, name: "Season 7" };
    expect(openSeasons([s5, s6, s7]).map((s) => s.id)).toEqual(["season-7", "season-6"]);
    expect(openSeason([s6, s7, s5])!.id).toBe("season-7");
  });

  it("Apply to all rosters in this tier: fills treasury + P/S/E of the same tier only; flags non-default rows", () => {
    const r = (roster: string, tier: number, treasury = 1000, p = 0, s = 0, e = 0): TeamBuildingRosterRule => ({ roster, tier, treasury, startingSkills: { primary: p, secondary: s, elite: e } });
    const rows = [r("Amazon", 1, 1100, 1, 0, 1), r("Dwarf", 1), r("Lizardmen", 1, 1000, 0, 2, 0), r("Orc", 2), r("Wood Elf", 1, 1100, 1, 0, 1)];
    expect(tierFillPlan(rows, "Amazon")).toEqual({ targets: ["Dwarf", "Lizardmen"], overwrites: ["Lizardmen"] });
    expect(tierFillPlan(rows, "Nobody")).toEqual({ targets: [], overwrites: [] });
    expect(applyTierFill(rows, "Amazon")).toBe(2);
    expect(rows.find((x) => x.roster === "Dwarf")).toEqual(r("Dwarf", 1, 1100, 1, 0, 1));
    expect(rows.find((x) => x.roster === "Lizardmen")).toEqual(r("Lizardmen", 1, 1100, 1, 0, 1));
    expect(rows.find((x) => x.roster === "Orc")).toEqual(r("Orc", 2)); // another tier: untouched
    rows[0]!.startingSkills.primary = 3;
    expect(rows[1]!.startingSkills.primary).toBe(1); // copies, not shared objects
    expect(applyTierFill(rows, "Orc")).toBe(0);
  });

  it("league detail: news and fixtures editor writes fold the answer into the season", async () => {
    const post = { id: "n1", title: "Hi", body: "There", by: "Jay", at: "2026-11-01T00:00:00.000Z", pinned: false };
    const made = fx("f9", false, { round: 2, date: "2026-11-05" });
    const f = mockFetcher({
      ...API,
      "POST /api/leagues/tabbl/seasons/season-6/news": { post, news: [post] },
      "PATCH /api/leagues/tabbl/seasons/season-6/news/n1": { post: { ...post, pinned: true }, news: [{ ...post, pinned: true }] },
      "DELETE /api/leagues/tabbl/seasons/season-6/news/n1": { news: [] },
      "POST /api/leagues/tabbl/seasons/season-6/fixtures": { ok: true, fixture: made },
      "PATCH /api/leagues/tabbl/seasons/season-6/fixtures/f9": { ok: true, fixture: { ...made, home: { ...made.home, score: 1 }, away: { ...made.away, score: 0 } } },
      "DELETE /api/leagues/tabbl/seasons/season-6/fixtures/f2": { ok: true },
      "DELETE /api/leagues/tabbl/seasons/season-6/fixtures/f3": new ApiError(409, "This fixture has a result: clear the result before deleting it."),
    });
    const d = createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-6");
    expect(await d.postNews("season-6", { title: "Hi", body: "There", pinned: false })).toBe(true);
    expect(d.state.season["season-6"]!.news).toEqual([post]);
    await d.editNews("season-6", "n1", { pinned: true });
    expect(d.state.season["season-6"]!.news![0]!.pinned).toBe(true);
    await d.deleteNews("season-6", "n1");
    expect(d.state.season["season-6"]!.news).toEqual([]);
    expect(await d.createFixture("season-6", { home: "a", away: "b", round: 2, phaseId: "season-regular", date: "2026-11-05", test: true })).toBe(true);
    expect(f.calls.at(-1)!.body).toEqual({ home: "a", away: "b", round: 2, phaseId: "season-regular", date: "2026-11-05", test: true });
    expect(d.state.season["season-6"]!.fixtures.map((x) => x.id)).toEqual(["f1", "f2", "f3", "f9"]);
    await d.editFixture("season-6", "f9", { result: { home: 1, away: 0 } });
    expect(d.state.season["season-6"]!.fixtures.find((x) => x.id === "f9")!.home.score).toBe(1);
    await d.deleteFixture("season-6", "f2");
    expect(d.state.season["season-6"]!.fixtures.map((x) => x.id)).toEqual(["f1", "f3", "f9"]);
    expect(await d.deleteFixture("season-6", "f3")).toBe(false);
    expect(d.state.editError).toContain("clear the result");
    expect(newFixtureError({ home: "a", away: "a", round: 1, phaseId: "", date: "", test: false })).toBe("A team cannot play itself.");
    expect(newFixtureError({ home: "a", away: "b", round: 0, phaseId: "", date: "", test: false })).toBe("Round: 1 to 99.");
    expect(newFixtureError({ home: "a", away: "b", round: 1, phaseId: "", date: "", test: false })).toBe("");
    expect(newsList({ news: [post, { ...post, id: "n0", pinned: true, at: "2020-01-01T00:00:00.000Z" }] }).map((n) => n.id)).toEqual(["n0", "n1"]);
  });


  it("postcodes, webhook URL shape, tabs, ranges, next season", () => {
    expect(postcodeError("US", "98101")).toBe("");
    expect(postcodeError("US", "98101-1234")).toBe("");
    expect(postcodeError("US", "981")).toContain("ZIP");
    expect(postcodeError("CA", "v6b4y8")).toBe("");
    expect(postcodeError("CA", "V6B 4Y8")).toBe("");
    expect(postcodeError("CA", "98101")).toContain("A1A 1A1");
    expect(postcodeError("CA", "")).toBe("");
    expect(isWebhookUrl("https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isWebhookUrl("https://example.com/api/webhooks/1/x")).toBe(false);
    expect(isSettingsTab("team-building")).toBe(true);
    expect(isSettingsTab("billing")).toBe(false);
    expect(teamBuildingError([{ roster: "Orc", tier: 7, treasury: 1000, startingSkills: { primary: 0, secondary: 0, elite: 0 } }])).toBe("Orc tier: 1 to 6.");
    expect(teamBuildingError(view().teamBuilding!.rules.rosters)).toBe("");
    expect(nextSeasonDefaults([s5, s6], "BB2025")).toEqual({ number: 7, name: "Season 7", ruleset: "BB2025" });
    expect(openSeason([s5, s6])!.id).toBe("season-6");
  });

  it("controller: load, 403 / 401 denial, save sends the revision and takes the fresh model, actions reload", async () => {
    const f = mockFetcher({
      ...API,
      "PATCH /api/leagues/tabbl/settings": (b: unknown) => ({ settings: view({ revision: 4, registrations: { ...view().registrations, allowRegistration: (b as { registrations: { allowRegistration: boolean } }).registrations.allowRegistration } }) }),
      "POST /api/leagues/tabbl/seasons/season-6/finish": { ok: true },
      "POST /api/leagues/tabbl/discord/test": new ApiError(502, "Discord did not accept the test post (status 404)."),
    });
    const s = createLeagueSettings({ api: f });
    await s.load("tabbl");
    expect(s.state.view!.revision).toBe(3);
    expect(s.state.seasons.map((x) => x.id)).toEqual(["season-6", "season-5"]);
    expect(await s.save("registrations", { allowRegistration: false })).toBe(true);
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ revision: 3, registrations: { allowRegistration: false } });
    expect(s.state.view!.revision).toBe(4);
    expect(s.state.notices.registrations).toBe("Saved.");
    expect(await s.finishSeason("season-6")).toBe(true);
    expect(s.state.notices.finish).toBe("Season finished.");
    expect(await s.testDiscord()).toBe(false);
    expect(s.state.errors["discord-test"]).toContain("status 404");
    expect(s.exportUrl()).toBe("/api/leagues/tabbl/export.zip");
    expect(s.exportUrl("season-5")).toBe("/api/leagues/tabbl/export.zip?season=season-5");
    const denied = createLeagueSettings({ api: mockFetcher({ ...API, "/api/leagues/tabbl/settings": new ApiError(403, "no") }) });
    await denied.load("tabbl");
    expect(denied.state.denied).toBe("forbidden");
    const anon = createLeagueSettings({ api: mockFetcher({ ...API, "/api/leagues/tabbl/settings": new ApiError(401, "no") }) });
    await anon.load("tabbl");
    expect(anon.state.denied).toBe("signin");
  });

  it("league detail: the fixture switch PATCHes and swaps the fixture in place", async () => {
    const f = mockFetcher({ ...API, "PATCH /api/leagues/tabbl/seasons/season-6/fixtures/f2": { ok: true, fixture: fx("f2", false, { forkEnabled: true }) } });
    const d = createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-6");
    await d.setFixtureFork("season-6", "f2", true);
    expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", body: { forkEnabled: true } });
    expect(d.state.season["season-6"]!.fixtures[1]!.forkEnabled).toBe(true);
    expect(d.state.forkError).toBe("");
  });
});

describe("league settings routes (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown; meta: Record<string, unknown> } } };
      session: { refresh?: () => Promise<void>; load?: () => Promise<void> } & Record<string, unknown>;
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    settings: typeof import("../spa/src/leagues/settings");
    league: typeof import("../spa/src/leagues/league");
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, settings, league, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/leagues/settings.ts"),
      vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      settings: settings as typeof import("../spa/src/leagues/settings"), league: league as typeof import("../spa/src/leagues/league"),
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };
  const ADMIN = { "/api/auth/session": { authenticated: true, coach: "Root", admin: true, authMethod: "discord", discordSsoEnabled: true } };
  const COACH = { "/api/auth/session": { authenticated: true, coach: "Mallory", authMethod: "discord", discordSsoEnabled: true } };

  async function render(path: string, prep: ((inject: (key: symbol, v: unknown) => void, f: Fetcher) => Promise<void>) | undefined, session: Routes, extra: Routes = {}) {
    const f = mockFetcher({ ...API, ...session, ...extra });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa };
  }
  const loaded = (extra: Routes = {}) => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const s = mods.settings.createLeagueSettings({ api: Object.keys(extra).length ? mockFetcher({ ...API, ...extra }) : f });
    await s.load("tabbl");
    inject(mods.settings.LEAGUE_SETTINGS_KEY, s);
  };
  const detail = async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-6");
    inject(mods.league.LEAGUE_DETAIL_KEY, d);
  };

  it("cog on the league header strip: organisers and admins only", async () => {
    const cog = 'aria-label="League settings"';
    expect((await render("/leagues/tabbl", detail, ORGANISER)).html).toContain(cog);
    const admin = await render("/leagues/tabbl", detail, ADMIN);
    expect(admin.html).toContain(cog);
    expect(admin.html).toContain('href="/app/leagues/tabbl/settings"');
    expect(admin.html).toContain('src="/icons/league/league-settings.png"');
    expect((await render("/leagues/tabbl", detail, COACH)).html).not.toContain(cog);
    expect((await render("/leagues/tabbl", detail, ANON)).html).not.toContain(cog);
  });

  it("Administration (default tab): permissions table, season actions, redraft placeholder button", async () => {
    const { html, spa } = await render("/leagues/tabbl/settings", loaded(), ORGANISER);
    expect(spa.router.currentRoute.value.name).toBe("league-settings");
    expect(html).toContain("League settings");
    for (const t of ["Administration", "Information", "Registrations", "Team building", "External connections"]) expect(html).toContain(`>${t}</a>`);
    expect(html).toMatch(/aria-current="page"[^>]*>Administration</);
    expect(html).toContain("League permissions");
    expect(html).toMatch(/data-role="owner"><td><strong>Jay<\/strong><\/td><td>Owner/);
    expect(html).toContain('aria-label="Remove organiser Kainis"');
    expect(html).toMatch(/data-role="admin"><td>Root<\/td><td>Site admin<\/td><td><span class="hm-small">Read-only/);
    expect(html).toContain("Add organiser");
    expect(html).not.toContain("New owner"); // only admins change the owner
    expect(html).toContain("Season 6 in progress");
    expect(html).toContain(">Finish season</button>");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Start a new season<\/button>/); // seasons may overlap
    expect(html).toContain("Seasons may overlap");
    expect(html).toContain(">Start redraft</button>");
  });

  it("Information: fields with the Canadian address, province select and postal code", async () => {
    const { html } = await render("/leagues/tabbl/settings?tab=information", loaded(), ORGANISER);
    expect(html).toMatch(/aria-current="page"[^>]*>Information</);
    expect(html).toContain('value="Tahoma Area Blood Bowl League"');
    expect(html).toContain("Province or territory");
    expect(html).toContain("Postal code");
    expect(html).toContain('value="V6B 4Y8"');
    expect(html).toMatch(/<option value="BC"[^>]*selected/);
    expect(html).toContain(">Individual</option>");
    expect(html).toContain("Save information");
  });

  it("Registrations: allowed rosters, toggles and limits; no bulk actions", async () => {
    const { html } = await render("/leagues/tabbl/settings?tab=registrations", loaded(), ORGANISER);
    for (const t of ["Official", "NAF-approved", "Unofficial", "Allow registration", "Max registrations", "Max per race"]) expect(html).toContain(t);
    expect(html).not.toContain("Hide team composition");
    expect(html).toContain('value="24"');
    expect(html).not.toMatch(/Mark all paid|Check-in all/i);
  });

  it("Team building: a table row per roster with tier, treasury and starting skills", async () => {
    const { html } = await render("/leagues/tabbl/settings?tab=team-building", loaded(), ORGANISER);
    for (const t of ["Roster", "GW tier", "Initial treasury (k)", "Starting skills", "Primary", "Secondary", "Elite"]) expect(html).toContain(`>${t}</th>`);
    expect(html).toContain('data-roster="Black Orc"');
    expect(html).toContain('value="1100"');
    expect(html).toContain("Elite skills: Block, Guard, Mighty Blow, Dodge.");
    expect(html).toContain("Season 6 · BB2025");
    expect(html).toContain(">Apply to all rosters in this tier</button>");
    expect(html).toContain("Apply Black Orc&#39;s treasury and starting skills to all rosters in tier 2");
  });

  it("Administration with two seasons in progress: Finish season picks which one", async () => {
    const s7: SeasonSummary = { ...s6, id: "season-7", number: 7, name: "Season 7" };
    const { html } = await render("/leagues/tabbl/settings", loaded({ "/api/leagues/tabbl": { league: league(), seasons: [s5, s6, s7] } }), ORGANISER);
    expect(html).toContain("2 seasons in progress");
    expect(html).toContain("Season to finish");
    expect(html).toMatch(/<option value="season-6">Season 6<\/option>/);
  });

  it("league page: League news on Overview (composer for organisers), fixtures editor on Fixtures", async () => {
    const withNews = () => ({ league: league(), season: { ...season6(), news: [
      { id: "n1", title: "Old news", body: "Plain.", by: "Jay", at: "2026-10-01T00:00:00.000Z", pinned: false },
      { id: "n2", title: "Pinned rules", body: "Read **this**.", by: "Jay", at: "2026-09-01T00:00:00.000Z", pinned: true },
    ], teams: [{ id: "grudge", name: "Grudge Rollers", race: "Dwarf", coach: "Jay", teamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null, cheerleaders: null, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [] }] } });
    const extra = { "/api/leagues/tabbl/seasons/season-6": withNews };
    const org = await render("/leagues/tabbl", detail, ORGANISER, extra);
    expect(org.html).toContain("League news");
    expect(org.html).toContain(">Post news</button>");
    expect(org.html.indexOf("Pinned rules")).toBeLessThan(org.html.indexOf("Old news"));
    expect(org.html).toContain('class="tn-md"'); // MarkdownLite body
    const anon = await render("/leagues/tabbl", detail, ANON);
    expect(anon.html).not.toContain("League news"); // no news, no composer
    const fixtures = await render("/leagues/tabbl?tab=fixtures", detail, ORGANISER, extra);
    expect(fixtures.html).toContain("Fixtures editor");
    expect(fixtures.html).toContain(">Add fixture</button>");
    expect(fixtures.html).toContain("Grudge Rollers (Jay)");
    expect(fixtures.html).toContain(">Save result</button>");
    expect((await render("/leagues/tabbl?tab=fixtures", detail, COACH)).html).not.toContain("Fixtures editor");
  });

  it("External connections: NAF disabled note, export link, masked webhook only, Super FUMBBL toggle", async () => {
    const { html } = await render("/leagues/tabbl/settings?tab=connections", loaded(), ORGANISER);
    expect(html).toContain("NAF results report");
    expect(html).toContain("available for tournaments only");
    expect(html).toContain('href="/api/leagues/tabbl/export.zip"');
    expect(html).toContain("https://discord.com/api/webhooks/…/•••");
    expect(html).toContain('type="password"');
    expect(html).toContain("Send test post");
    for (const t of ["League news", "Fixture created", "Match started", "Match result", "Redraft and season milestones"]) expect(html).toContain(t);
    expect(html).toContain("Play on Super FUMBBL");
    expect(html).toMatch(/role="switch"[^>]*checked/);
  });

  it("not one of yours: a coach who is not an organiser gets the friendly note", async () => {
    const { html } = await render("/leagues/tabbl/settings", loaded({ "/api/leagues/tabbl/settings": new ApiError(403, "no") }), COACH);
    expect(html).toContain("Not one of yours");
    expect(html).toContain("only its organisers and site admins");
    expect(html).not.toContain("League permissions");
  });

  it("fixtures: the Super FUMBBL chip for everyone, the switch for league admins on unplayed fixtures only", async () => {
    const admin = await render("/leagues/tabbl?tab=fixtures", detail, ORGANISER);
    expect(admin.html.match(/data-fork="on"/g)).toHaveLength(1);
    expect(admin.html.match(/Allow Super FUMBBL for this fixture/g)).toHaveLength(2); // f1, f2 (f3 played)
    const coach = await render("/leagues/tabbl?tab=fixtures", detail, COACH);
    expect(coach.html).toContain('data-fork="on"');
    expect(coach.html).not.toContain("Allow Super FUMBBL");
    const off = await render("/leagues/tabbl?tab=fixtures", detail, ORGANISER, { "/api/leagues/tabbl": { league: league({ playOnFork: false }), seasons: [s5, s6] } });
    expect(off.html).not.toContain("Allow Super FUMBBL");
  });
  it("teams: rosters always render (no hidden-roster note, no player-count-only tile)", async () => {
    const stats = { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 };
    const shown = (): SeasonRecord => ({ ...season6(), teams: [{
      id: "grudge-rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Jay", teamValue: 1000000, treasury: 0, rerolls: 2, fans: 2, assistantCoaches: 0, cheerleaders: 0,
      apothecary: false, tier: "1", raceLeague: "", formerPlayers: [],
      players: [{ playerId: "p-d1", number: 1, name: "Durin", position: "Dwarf Blocker", ma: 4, st: 3, ag: 4, pa: 5, av: 10, skills: ["Block"], value: 70000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats }],
    }] });
    const extra = { "/api/leagues/tabbl/seasons/season-6": () => ({ league: league(), season: shown() }) };
    const list = await render("/leagues/tabbl?tab=teams", detail, COACH, extra);
    expect(list.html).not.toContain("Rosters are hidden");
    expect(list.html).not.toContain("data-roster-hidden");
    const one = await render("/leagues/tabbl?tab=teams&team=grudge-rollers", detail, COACH, extra);
    expect(one.html).not.toContain("Rosters are hidden");
    expect(one.html).toContain("lg-players");
    expect(one.html).toContain("Durin");
    expect(one.html).not.toContain("data-counter"); // no Super FUMBBL counters yet: no extra columns
    const counted = (): SeasonRecord => { const s = shown(); s.teams[0]!.players[0]!.stats = { ...stats, blocks: 4, turnsPlayed: 16 }; return s; };
    const withCounters = await render("/leagues/tabbl?tab=teams&team=grudge-rollers", detail, COACH, { "/api/leagues/tabbl/seasons/season-6": () => ({ league: league(), season: counted() }) });
    expect(withCounters.html).toContain('data-counter="blocks"');
    expect(withCounters.html).toContain('data-counter="turnsPlayed"');
    expect(withCounters.html).not.toContain('data-counter="rushing"');
    expect(withCounters.html).toContain(">BLK<");
  });

  it("teams: Assign coach account in the roster header for organisers only", async () => {
    const withTeam = (): SeasonRecord => ({ ...season6(), teams: [{
      id: "grudge-rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Dee Display", coachId: "ForkTester", coachAssigned: { by: "Jay", at: "2026-10-30T18:00:00Z" },
      teamValue: 1000000, treasury: 0, rerolls: 2, fans: 2, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [],
    }] });
    const extra = { "/api/leagues/tabbl/seasons/season-6": () => ({ league: league(), season: withTeam() }) };
    const org = await render("/leagues/tabbl?tab=teams&team=grudge-rollers", detail, ORGANISER, extra);
    expect(org.html).toContain("data-assign-coach");
    expect(org.html).toContain("Assign coach account");
    expect(org.html).toContain("All seasons of this team");
    expect(org.html).toContain("(assigned by Jay)");
    expect(org.html).toContain(">Clear</button>");
    expect(org.html).toMatch(/Dee Display(<!--\[-->)? · ForkTester/); // header: imported coach + assigned account
    const coach = await render("/leagues/tabbl?tab=teams&team=grudge-rollers", detail, COACH, extra);
    expect(coach.html).not.toContain("data-assign-coach");
    expect(coach.html).not.toContain("Assign coach account");
    expect(coach.html).toMatch(/Dee Display(<!--\[-->)? · ForkTester/);
    const anon = await render("/leagues/tabbl?tab=teams&team=grudge-rollers", detail, ANON, extra);
    expect(anon.html).not.toContain("data-assign-coach");
  });

  it("league detail: assignCoach sends the season revision, re-reads the season, drops other changed seasons", async () => {
    let served = { ...season6(), revision: 7 };
    const f = mockFetcher({
      "/api/leagues/tabbl": { league: league(), seasons: [s6, s5] },
      "/crests/manifest.json": { crests: {} },
      "/api/leagues/tabbl/seasons/season-6": () => ({ season: served }),
      "/api/leagues/tabbl/seasons/season-5": { season: { ...season6(), id: "season-5" } },
      "/api/leagues/tabbl/coaches?q=fork": { coaches: ["ForkTester"] },
      "PATCH /api/leagues/tabbl/seasons/season-6/teams/grudge-rollers": () => {
        served = { ...served, revision: 8, teams: served.teams.map((t) => ({ ...t, coachId: "ForkTester" })) };
        return { ok: true, seasons: ["season-6", "season-5"], revision: 8 };
      },
    });
    const d = createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-6");
    await d.ensureSeason("season-5");
    expect(await d.lookupCoaches("f")).toEqual([]); // under two letters: no lookup
    expect(await d.lookupCoaches("fork")).toEqual(["ForkTester"]);
    expect(await d.assignCoach("season-6", "grudge-rollers", "ForkTester", true)).toBe(true);
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ revision: 7, coachId: "ForkTester", allSeasons: true });
    expect(d.state.season["season-6"]!.revision).toBe(8);
    expect(d.state.season["season-6"]!.teams.every((t) => t.coachId === "ForkTester")).toBe(true);
    expect(d.state.season["season-5"]).toBeUndefined(); // reloads when opened
    expect(d.state.editNotice).toBe("Coach account set to ForkTester.");
  });
});

describe("league settings review regressions (SPA side)", () => {
  it("a 409 on save reloads the settings and says another organiser changed them", async () => {
    let settingsReads = 0;
    const f = mockFetcher({
      ...API,
      "/api/leagues/tabbl/settings": () => { settingsReads += 1; return { settings: view({ revision: 3 }) }; },
      // the reload keeps the team building season it showed
      "/api/leagues/tabbl/settings?season=season-6": () => { settingsReads += 1; return { settings: view({ revision: 5 }) }; },
      "PATCH /api/leagues/tabbl/settings": new ApiError(409, "These settings changed since you opened them."),
    });
    const s = createLeagueSettings({ api: f });
    await s.load("tabbl");
    expect(await s.save("information", { fullName: "Mine" })).toBe(false);
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ revision: 3 });
    expect(settingsReads).toBe(2);
    expect(s.state.view!.revision).toBe(5);
    expect(s.state.errors.information).toContain("Another organiser changed these settings");
  });
});
