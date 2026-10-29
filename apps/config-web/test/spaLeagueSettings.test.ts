import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  createLeagueSettings, isSettingsTab, isWebhookUrl, nextSeasonDefaults, openSeason, postcodeError, teamBuildingError,
} from "../spa/src/leagues/settings";
import { createLeagueDetail } from "../spa/src/leagues/league";
import type { LeagueFixture, LeagueSettingsView, LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";

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
  registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, hideTeamComposition: false, maxRegistrations: 24, maxPerRace: null },
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
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Start a new season<\/button>/); // a season is open
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
    for (const t of ["Official", "NAF-approved", "Unofficial", "Allow registration", "Hide team composition", "Max registrations", "Max per race"]) expect(html).toContain(t);
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
});
