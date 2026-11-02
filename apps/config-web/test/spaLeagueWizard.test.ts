import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { canCreateLeague, seasonStageOf, stageActions } from "../spa/src/leagues/lifecycle";
import {
  createLeagueWizard, emptyForm, formFromDraft, fromLocalInput, identityErrors, rulesErrors, seasonErrors, slugify, startDateIso, stepPayload, summaryGroups,
  toLocalInput, type WizardDraft,
} from "../spa/src/leagues/wizard";

// SPA league creation wizard (lane L5): helpers, the controller against a mocked Fetcher (create on the first Next, a PATCH
// with the revision on every later one), and the pages server-rendered: the wizard by role, the Create league entry
// points, Administration's Publish / stage actions and the season registration panel.

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

const rosters = [
  { roster: "Amazon", tier: 1, treasury: 1000, startingSkills: { primary: 0, secondary: 0, elite: 0 } },
  { roster: "Halfling", tier: 4, treasury: 1000, startingSkills: { primary: 0, secondary: 0, elite: 0 } },
];
const draft = (over: Partial<WizardDraft> = {}): WizardDraft => ({
  id: "harbour-league", revision: 0, visibility: "draft", step: 2, test: false,
  identity: { name: "Harbour League", fullName: "", slug: "harbour-league", description: "", address: null },
  rules: { ruleset: "BB2025", allowedRosters: { official: true, nafApproved: true, unofficial: false }, maxRegistrations: null, maxPerRace: null, teamBuilding: { rosters, eliteSkills: ["Block"] } },
  season: { id: "season-1", name: "Season 1", number: 1, stage: "setup", divisions: [], playoffs: false, revision: 1,
    registration: { approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false, entryFee: "" } },
  connections: { playOnFork: false, discord: { configured: false, maskedUrl: "", events: { news: true, fixtureCreated: true, matchStarted: true, matchResult: true, milestones: true } } },
  ...over,
});

describe("wizard helpers", () => {
  it("slug, field checks mirror the server, payloads per step", () => {
    expect(slugify("Tahoma Área B.B.L.")).toBe("tahoma-area-b-b-l");
    const f = emptyForm();
    expect(identityErrors(f, false)).toMatchObject({ name: "Name is required." });
    f.identity.name = "New";
    f.identity.slug = "new";
    expect(identityErrors(f, false).slug).toContain("reserved");
    expect(identityErrors(f, true)).toEqual({}); // the address is fixed once the draft exists
    f.rules.official = f.rules.nafApproved = false;
    f.rules.maxRegistrations = "4";
    f.rules.maxPerRace = "5";
    expect(rulesErrors(f)).toMatchObject({ rosters: "Allow at least one kind of roster.", maxPerRace: "Cannot be more than max teams." });
    f.season.opensAt = "2026-11-20T10:00";
    f.season.closesAt = "2026-11-10T10:00";
    f.season.divisions = ["North", "north"];
    expect(seasonErrors(f)).toMatchObject({ closesAt: "Registration must close after it opens.", divisions: "Each division needs its own name." });
    expect(startDateIso("2026-12-01")).toBe("2026-12-01T12:00:00.000Z");
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(fromLocalInput("2026-11-20T10:30")!)).toBe("2026-11-20T10:30");
    f.connections.webhook = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF";
    expect(stepPayload("connections", f)).toMatchObject({ connections: { discord: { url: f.connections.webhook } } });
    f.connections.webhook = "";
    expect(stepPayload("connections", f)).toEqual({ connections: { playOnFork: false, discord: { events: f.connections.events } } });
    f.connections.clearWebhook = true;
    expect((stepPayload("connections", f).connections as any).discord.url).toBeNull();
    f.season.divisions = [" North ", "", "South"];
    expect((stepPayload("season", f).season as any).divisions).toEqual(["North", "South"]);
    expect((stepPayload("season", f).season as any).registration).toMatchObject({ approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false });
  });

  it("a saved draft fills the form back, and the summary groups every step", () => {
    const d = draft({ rules: { ...draft().rules, maxRegistrations: 12 }, season: { ...draft().season!, playoffs: true, divisions: ["North"], registration: { ...draft().season!.registration, approval: "auto" } } });
    const f = formFromDraft(d);
    expect(f.rules.maxRegistrations).toBe("12");
    expect(f.season).toMatchObject({ playoffs: true, divisions: ["North"], approval: "auto" });
    const g = summaryGroups(f, d);
    expect(g.map((x) => x.step)).toEqual(["identity", "rules", "season", "connections"]);
    expect(g[0]!.rows).toContainEqual({ k: "Address", v: "/leagues/harbour-league" });
    expect(g[1]!.rows).toContainEqual({ k: "Max teams", v: "12" });
    expect(g[2]!.rows).toContainEqual({ k: "Phases", v: "Regular, Play-offs" });
    expect(g[2]!.rows).toContainEqual({ k: "Approval", v: "Auto-accept" });
    expect(g[3]!.rows).toContainEqual({ k: "Discord", v: "Not set" });
  });

  it("stage helpers and who may create", () => {
    expect(seasonStageOf({ status: "active" })).toBe("active");
    expect(seasonStageOf({ status: "completed", stage: "registration" })).toBe("completed");
    expect(stageActions({ status: "active", stage: "setup" }).map((a) => a.label)).toEqual(["Open registration", "Start season"]);
    expect(stageActions({ status: "active", stage: "registration" }).map((a) => a.label)).toEqual(["Start season", "Close registration"]);
    expect(stageActions({ status: "active" })).toEqual([]);
    expect(canCreateLeague({ authenticated: true, authMethod: "discord", organizer: true })).toBe(true);
    expect(canCreateLeague({ authenticated: true, authMethod: "discord", admin: true })).toBe(true);
    expect(canCreateLeague({ authenticated: true, authMethod: "discord" })).toBe(false);
    expect(canCreateLeague({ authenticated: true, authMethod: "password", organizer: true })).toBe(false);
  });
});

describe("wizard controller", () => {
  it("the first Next creates the draft; later Nexts PATCH their step with the revision; Create league completes it", async () => {
    let rev = 0;
    const f = mockFetcher({
      "POST /api/leagues": () => ({ ok: true, id: "harbour-league", draft: draft() }),
      "PATCH /api/leagues/harbour-league/draft": (b: any) => { rev += 1; return { ok: true, draft: draft({ revision: rev, step: b.step ?? 5, ...(b.complete ? { completedAt: "now" } : {}) }) }; },
      "/api/leagues/harbour-league/draft": { draft: draft() },
    });
    const w = createLeagueWizard({ api: f, upload: async () => ({}) });
    await w.start();
    expect(await w.next()).toBe(false); // no name
    expect(w.state.errors.name).toBe("Name is required.");
    expect(f.calls).toHaveLength(0);
    w.state.form.identity.name = "Harbour League";
    expect(await w.next()).toBe(true);
    expect(f.calls[0]).toMatchObject({ method: "POST", path: "/api/leagues", body: { name: "Harbour League", slug: "harbour-league" } });
    expect(w.state.step).toBe("rules");
    expect(w.state.form.rules.rosters.map((r) => r.roster)).toEqual(["Amazon", "Halfling"]); // the server's table
    w.state.form.rules.maxRegistrations = "16";
    expect(await w.next()).toBe(true);
    const patch = f.calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({ revision: 0, step: 3, rules: { maxRegistrations: 16, allowedRosters: { official: true } } });
    expect(w.state.step).toBe("season");
    expect(await w.next()).toBe(true);
    expect(f.calls.at(-1)!.body).toMatchObject({ revision: 1, step: 4, season: { name: "Season 1" } });
    expect(await w.next()).toBe(true);
    expect(w.state.step).toBe("review");
    expect(w.canGo("identity")).toBe(true);
    expect(await w.create()).toBe(true);
    expect(f.calls.at(-1)!.body).toMatchObject({ complete: true, step: 5 });
    w.go("rules");
    expect(w.state.step).toBe("rules");
  });

  it("a server refusal lands on its field; a stale draft reloads", async () => {
    const f = mockFetcher({
      "POST /api/leagues": new ApiError(409, "That league address is taken. Pick another.", { field: "slug" }),
    });
    const w = createLeagueWizard({ api: f });
    await w.start();
    w.state.form.identity.name = "Taken";
    expect(await w.next()).toBe(false);
    expect(w.state.errors.slug).toBe("That league address is taken. Pick another.");
    expect(w.state.step).toBe("identity");
    const g = mockFetcher({
      "/api/leagues/harbour-league/draft": { draft: draft({ step: 3, revision: 4 }) },
      "PATCH /api/leagues/harbour-league/draft": new ApiError(409, "This draft changed since you opened it. Reload to see the latest."),
    });
    const v = createLeagueWizard({ api: g });
    await v.start("harbour-league");
    expect(v.state.step).toBe("season");
    expect(await v.next()).toBe(false);
    expect(v.state.error).toContain("reloaded");
  });
});

describe("league wizard pages (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    wizard: typeof import("../spa/src/leagues/wizard");
    settings: typeof import("../spa/src/leagues/settings");
    league: typeof import("../spa/src/leagues/league");
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, wizard, settings, league, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/wizard.ts"), vite.ssrLoadModule("/src/leagues/settings.ts"), vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      wizard: wizard as typeof import("../spa/src/leagues/wizard"), settings: settings as typeof import("../spa/src/leagues/settings"),
      league: league as typeof import("../spa/src/leagues/league"),
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Olga", organizer: true, authMethod: "discord", discordSsoEnabled: true } };
  const COACH = { "/api/auth/session": { authenticated: true, coach: "Pat", authMethod: "discord", discordSsoEnabled: true } };
  const LEAGUE = { id: "harbour-league", name: "Harbour League", fullName: "", slug: "harbour-league", description: "", organisers: ["Olga"], playOnFork: false, createdAt: "", seasonCount: 1, visibility: "draft" };
  const S1 = { id: "season-1", number: 1, name: "Season 1", ruleset: "BB2025", status: "active", stage: "setup", teamCount: 0, fixtureCount: 0, playedCount: 0 };
  const API: Routes = {
    "/api/leagues": { leagues: [{ ...LEAGUE, currentSeason: S1 }] },
    "/api/leagues/harbour-league": { league: LEAGUE, seasons: [S1] },
    "/crests/manifest.json": { crests: {} },
  };
  async function render(path: string, session: Routes, prep?: (inject: (k: symbol, v: unknown) => void, f: Fetcher) => Promise<void>, extra: Routes = {}) {
    const f = mockFetcher({ ...API, ...session, ...extra });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }
  const atStep = (step: "identity" | "rules" | "season" | "connections" | "review") => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const w = mods.wizard.createLeagueWizard({ api: f });
    if (step === "identity") await w.start();
    else {
      await w.start("harbour-league");
      w.state.reached = 4;
      w.state.step = step;
    }
    inject(mods.wizard.LEAGUE_WIZARD_KEY, w);
  };
  const DRAFT = { "/api/leagues/harbour-league/draft": { draft: draft({ step: 5 }) } };

  it("organisers get the five steps and the summary; a plain coach gets the way to ask", async () => {
    const html = await render("/leagues/new", ORGANISER, atStep("identity"));
    for (const s of ["Identity", "Rules", "Season 1", "Connections", "Review"]) expect(html).toContain(`</span>${s}</button>`);
    expect(html).toContain("Step 1 of 5");
    expect(html).toContain("League summary");
    expect(html).toContain("League address");
    expect(html).toContain(">Next</button>");
    expect(html).not.toContain("Import from TourPlay"); // admins only (Q16)
    const coach = await render("/leagues/new", COACH, atStep("identity"));
    expect(coach).toContain("Organisers only");
    expect(coach).toContain('href="/app/organiser/request"');
    expect(coach).not.toContain("League summary");
  });

  it("each later step renders its fields; the review has Save draft and Create league", async () => {
    const rules = await render("/leagues/new?draft=harbour-league", ORGANISER, atStep("rules"), DRAFT);
    for (const t of ["Default ruleset", "Allowed rosters", "Max teams", "Max per race", "Inducements", "Team building", "Apply to tier"]) expect(rules).toContain(t);
    expect(rules).toContain("Halfling");
    const season = await render("/leagues/new?draft=harbour-league", ORGANISER, atStep("season"), DRAFT);
    for (const t of ["Season name", "Play-offs (knockout)", "Divisions", "Registration opens", "Registration closes", "Organiser approval", "Waitlist when full", "Allow existing teams", "Allow joining mid-season", "Entry fee"]) expect(season).toContain(t);
    expect(season).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*><strong>Organiser approval/);
    const conn = await render("/leagues/new?draft=harbour-league", ORGANISER, atStep("connections"), DRAFT);
    for (const t of ["Discord", "Webhook URL", "Play on Super FUMBBL"]) expect(conn).toContain(t);
    const review = await render("/leagues/new?draft=harbour-league", ORGANISER, atStep("review"), DRAFT);
    expect(review).toContain(">Save draft</button>");
    expect(review).toContain(">Create league</button>");
    expect(review).toContain('aria-label="Edit Rules"');
    expect(review).toContain("only you, its other organisers and site admins can see it");
  });

  it("Create league on the Leagues list for organisers only; a draft card says Draft", async () => {
    const list = async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
      const l = mods.league.createLeagueList({ api: f });
      await l.load();
      inject(mods.league.LEAGUE_LIST_KEY, l);
    };
    const org = await render("/leagues", ORGANISER, list);
    expect(org).toContain('href="/app/leagues/new"');
    expect(org).toMatch(/class="sf-chip" data-tone="muted">Draft</);
    expect(await render("/leagues", COACH, list)).not.toContain('href="/app/leagues/new"');
  });

  it("League settings: Administration offers Publish and the season stage moves; Registrations has the season panel", async () => {
    const view = {
      id: "harbour-league", revision: 2,
      information: { name: "Harbour League", fullName: "", description: "", ruleset: "BB2025", mode: "individual", address: null },
      permissions: { owner: "Olga", organisers: [], admins: [], canEditOrganisers: true, canChangeOwner: false },
      registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: false, maxRegistrations: null, maxPerRace: null },
      connections: { playOnFork: false, discord: { configured: false, maskedUrl: "", events: {} }, naf: { available: false, note: "" } },
      teamBuilding: null, regions: { US: [], CA: [] }, rulesets: ["BB2020", "BB2025"], eliteSkills: [],
    };
    const reg = { registration: { seasonId: "season-1", stage: "setup", stageLabel: "In setup", open: false, reason: "not-yet-open", message: "Registration is not open yet.", revision: 3,
      counts: { teams: 0, cap: 8, placesLeft: 8 },
      settings: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: false, maxRegistrations: 8, maxPerRace: 2, approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false, entryFee: "" } } };
    const extra = { "/api/leagues/harbour-league/settings": { settings: view }, "/api/leagues/harbour-league/seasons/season-1/registration": reg };
    const loaded = async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
      const s = mods.settings.createLeagueSettings({ api: f });
      await s.load("harbour-league");
      inject(mods.settings.LEAGUE_SETTINGS_KEY, s);
    };
    const admin = await render("/leagues/harbour-league/settings", ORGANISER, loaded, extra);
    expect(admin).toContain("Visibility and stage");
    expect(admin).toContain(">Publish league</button>");
    expect(admin).toContain(">Open registration</button>");
    expect(admin).toContain(">Start season</button>");
    expect(admin).toContain('href="/app/leagues/new?draft=harbour-league"');
    const regs = await render("/leagues/harbour-league/settings?tab=registrations", ORGANISER, loaded, extra);
    expect(regs).toContain("Registration defaults");
    expect(regs).toContain("Season registration");
    expect(regs).toMatch(/<option value="season-1"[^>]*>Season 1<\/option>/);
  });
});
