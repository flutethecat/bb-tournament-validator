import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentSummary } from "../spa/src/shared/api";
import { createSessionStore, type Fetcher } from "../spa/src/session";
import {
  canCreateTournament, createBody, createdLocation, createTournamentCreator, CREATED_NOTICE, formProblem,
} from "../spa/src/tournaments/create";
import {
  blankWizardForm, createTournamentWizard, DRAFT_KEY, filterPackages, stepProblem, summaryRows, wizardBody,
} from "../spa/src/tournaments/wizard";

// Create Tournament (owner 10-30; the wizard page since lane L3, registration spec 11-02 section 6): the CREATE link on
// the Tournaments toolbar, the account menu item, and /app/tournaments/new (POST /api/tournaments, then the new draft's
// Manage tab). Controller tests with a mocked Fetcher; views server-rendered
// through the SPA's own Vite config, as in spaTournaments.test.ts.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
const AS = (coach: string, extra: Record<string, unknown> = {}) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", ...extra } });
const PACKAGES = { "/api/packages": [{ name: "nut-cup" }, { name: "small-gods" }] };
const listPage = (items: TournamentSummary[] = []) => ({ tournaments: items, page: 1, pageSize: 20, total: items.length, hasMore: false });
type Creator = ReturnType<typeof createTournamentCreator>;
type Wizard = ReturnType<typeof createTournamentWizard>;

describe("create controller", () => {
  it("who may create (registration spec Q1, Q13): a Discord organiser or admin, a test sign-in organiser; never signed out, a plain coach or a password session", async () => {
    const as = async (info: unknown) => { const s = createSessionStore(mockFetcher({ "/api/auth/session": info })); await s.load(); return canCreateTournament(s); };
    expect(await as({ authenticated: true, coach: "Veers", authMethod: "discord", organizer: true })).toBe(true);
    expect(await as({ authenticated: false })).toBe(false);
    expect(await as({ authenticated: true, coach: "Bob", authMethod: "discord", organizer: false })).toBe(false);
    // Site admins create too (Q1).
    expect(await as({ authenticated: true, coach: "Ada", authMethod: "discord", admin: true })).toBe(true);
    expect(await as({ authenticated: true, coach: "Veers", authMethod: "password", organizer: true })).toBe(false);
    // A test sign-in creates test tournaments (the server marks them; Q13).
    expect(await as({ authenticated: true, coach: "Veers", authMethod: "discord", organizer: true, test: true })).toBe(true);
  });

  it("the body: name trimmed, Swiss rounds only when set, other formats never send rounds", () => {
    const base = { name: "  Spike Open ", packageName: "nut-cup", maxPlayers: 16 as number | "", format: "swiss" as const, roundCount: "" as number | "", primaryTiebreaker: "buchholz" as const };
    expect(createBody(base)).toEqual({ name: "Spike Open", packageName: "nut-cup", maxPlayers: 16, format: "swiss", primaryTiebreaker: "buchholz" });
    expect(createBody({ ...base, roundCount: 5 })).toEqual({ name: "Spike Open", packageName: "nut-cup", maxPlayers: 16, format: "swiss", primaryTiebreaker: "buchholz", roundCount: 5 });
    expect(createBody({ ...base, format: "knockout", roundCount: 5, primaryTiebreaker: "sonnebornBerger" } as never)).toEqual({ name: "Spike Open", packageName: "nut-cup", maxPlayers: 16, format: "knockout", primaryTiebreaker: "sonnebornBerger" });
    expect(formProblem({ ...base, name: " " })).toBe("Enter a name.");
    expect(formProblem({ ...base, packageName: "" })).toBe("Choose a ruleset.");
    expect(formProblem({ ...base, maxPlayers: 1 })).toContain("at least 2");
    expect(formProblem({ ...base, roundCount: 51 })).toContain("1 to 50");
    expect(formProblem(base)).toBe("");
  });

  it("submit POSTs the dialog's body, closes, and leaves a one-time notice for the new tournament", async () => {
    const f = mockFetcher({ ...PACKAGES, "POST /api/tournaments": { tournament: { id: "t9", name: "Spike Open" } } });
    let created = 0;
    const c = createTournamentCreator({ api: f, onCreated: () => { created++; } });
    c.show();
    await c.loadPackages();
    expect(c.state.open).toBe(true);
    expect(c.state.packages).toEqual(["nut-cup", "small-gods"]);
    expect(c.state.form.packageName).toBe("nut-cup");
    Object.assign(c.state.form, { name: "Spike Open", packageName: "small-gods", maxPlayers: 12, format: "swiss", roundCount: 4, primaryTiebreaker: "sonnebornBerger" });
    expect(await c.submit()).toBe("t9");
    expect(f.calls.find((x) => x.method === "POST")).toEqual({
      path: "/api/tournaments", method: "POST",
      body: { name: "Spike Open", packageName: "small-gods", maxPlayers: 12, format: "swiss", primaryTiebreaker: "sonnebornBerger", roundCount: 4 },
    });
    expect(c.state.open).toBe(false);
    expect(created).toBe(1);
    expect(createdLocation("t9")).toEqual({ name: "tournament-detail", params: { id: "t9" }, query: { tab: "manage" } });
    expect(c.takeNotice("other")).toBe("");
    expect(c.takeNotice("t9")).toBe(CREATED_NOTICE);
    expect(c.takeNotice("t9")).toBe("");
  });

  it("the ruleset list is refetched on every open; the last list stays while loading and after a failed reread", async () => {
    let names = ["nut-cup"];
    let release: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    let fail = false;
    const f = mockFetcher({ "/api/packages": async () => { await gate; if (fail) throw new ApiError(500, "x"); return names.map((name) => ({ name })); } });
    const c = createTournamentCreator({ api: f });
    c.show();
    await c.loadPackages();
    expect(c.state.packages).toEqual(["nut-cup"]);
    c.close();
    names = ["nut-cup", "fresh-cup"];
    gate = new Promise((r) => { release = r; });
    c.show();
    expect(c.state.packagesStatus).toBe("loading");
    expect(c.state.packages).toEqual(["nut-cup"]);
    expect(c.state.form.packageName).toBe("nut-cup");
    release();
    await c.loadPackages();
    expect(c.state.packages).toEqual(["nut-cup", "fresh-cup"]);
    expect(f.calls.filter((x) => x.path === "/api/packages")).toHaveLength(2);
    c.close();
    fail = true;
    gate = Promise.resolve();
    c.show();
    await c.loadPackages();
    expect(c.state.packages).toEqual(["nut-cup", "fresh-cup"]);
    expect(c.state.packagesStatus).toBe("ready");
  });

  it("server refusals show verbatim and keep the dialog open; a local problem never reaches the server; 401 signs out", async () => {
    let signedOut = 0;
    let reply: unknown = new ApiError(400, "Unknown tournament rules package.");
    const f = mockFetcher({ ...PACKAGES, "POST /api/tournaments": () => reply });
    const c = createTournamentCreator({ api: f, onSignedOut: () => { signedOut++; } });
    c.show();
    await c.loadPackages();
    expect(await c.submit()).toBeUndefined();
    expect(c.state.error).toBe("Enter a name.");
    expect(f.calls.some((x) => x.method === "POST")).toBe(false);
    c.state.form.name = "Spike Open";
    expect(await c.submit()).toBeUndefined();
    expect(c.state.error).toBe("Unknown tournament rules package.");
    expect(c.state.open).toBe(true);
    reply = new ApiError(409, "A tournament with that name already exists.");
    await c.submit();
    expect(c.state.error).toBe("A tournament with that name already exists.");
    reply = new ApiError(401, "Authentication required.");
    await c.submit();
    expect(signedOut).toBe(1);
    expect(c.state.error).toBe("Signed out. Sign in and try again.");
    expect(c.state.signedOut).toBe(true);
    expect(c.state.open).toBe(true);
    expect(c.state.busy).toBe(false);
  });
});

describe("wizard controller (lane L3)", () => {
  const filled = () => ({ ...blankWizardForm(), packageName: "nut-cup", name: " Spike Open ", maxPlayers: 12 as number | "", roundCount: 4 as number | "", nafSanctioned: true, seriesId: "s1" });

  it("the body is exactly the old dialog's (createBody) plus publish and the wizard fields", () => {
    const form = filled();
    const body = wizardBody(form, false);
    const old = createBody({ name: form.name, packageName: form.packageName, maxPlayers: form.maxPlayers, format: form.format, roundCount: form.roundCount, primaryTiebreaker: form.primaryTiebreaker, nafSanctioned: true, seriesId: "s1" });
    expect(body).toMatchObject(old);
    expect(body).toEqual({
      ...old, publish: false, seedingMode: "elo", turnTimer: { enforced: "optional" },
      registration: { approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true } },
    });
    const full = wizardBody({
      ...form, startsAt: "2026-12-05T09:00", endsAt: "2026-12-06T18:00", venue: " Example Hall ", address: "1 Example Street", mapUrl: "https://example.com/map", startTime: "09:00",
      pairingSystem: "monrad", seedingMode: "manual", turnTimer: "required", summary: "Two days.", opensAt: "2026-11-03T09:00", closesAt: "2026-12-01T18:00",
      waitlist: false, approval: "organiser", rosterBy: "2026-12-03T18:00", checkInOpensAt: "2026-12-04T09:00", checkInClosesAt: "2026-12-05T08:30", entryFee: " 15 GBP ",
    }, true);
    expect(full).toMatchObject({
      publish: true, startsAt: "2026-12-05T09:00:00.000Z", endsAt: "2026-12-06T18:00:00.000Z", pairingSystem: "monrad", seedingMode: "manual", turnTimer: { enforced: "required" },
      location: { venue: "Example Hall", address: "1 Example Street", mapUrl: "https://example.com/map" }, startTime: "09:00", entryFee: "15 GBP", summary: "Two days.",
      deadlines: { registration: "2026-12-01T18:00:00.000Z", checkIn: "2026-12-05T08:30:00.000Z" },
      registration: { opensAt: "2026-11-03T09:00:00.000Z", approval: "organiser", waitlist: false, rosterLater: true, rosterBy: "2026-12-03T18:00:00.000Z", checkIn: { self: true, opensAt: "2026-12-04T09:00:00.000Z" } },
    });
    // online play sends no venue; knockout sends no pairing or rounds; switched-off options drop their dates
    const online = wizardBody({ ...form, playOnFork: true, venue: "Hall", startTime: "09:00", format: "knockout", pairingSystem: "monrad", rosterLater: false, rosterBy: "2026-12-03T18:00", selfCheckIn: false, checkInClosesAt: "2026-12-05T08:30" }, true);
    expect(online).toMatchObject({ playOnFork: true, registration: { rosterLater: false, checkIn: { self: false } } });
    for (const key of ["location", "startTime", "pairingSystem", "deadlines", "roundCount"]) expect(online).not.toHaveProperty(key);
    expect(online.registration).not.toHaveProperty("rosterBy");
  });

  it("step checks mirror the server; Next stops at the first problem", () => {
    const form = blankWizardForm();
    expect(stepProblem("ruleset", form)).toBe("Choose a ruleset.");
    expect(stepProblem("details", { ...form, name: " " })).toBe("Enter a name.");
    expect(stepProblem("details", { ...form, name: "A", startsAt: "2026-12-06T00:00", endsAt: "2026-12-05T00:00" })).toContain("end");
    expect(stepProblem("details", { ...form, name: "A", mapUrl: "javascript:x" })).toContain("map link");
    expect(stepProblem("registration", { ...form, maxPlayers: 1 })).toContain("at least 2");
    expect(stepProblem("registration", { ...form, opensAt: "2026-12-02T00:00", closesAt: "2026-12-01T00:00" })).toBe("Registration must open before it closes.");
    expect(stepProblem("registration", { ...form, startsAt: "2026-12-01T00:00", closesAt: "2026-12-02T00:00" })).toBe("Registration must close by the start.");
    expect(stepProblem("registration", { ...form, startsAt: "2026-12-01T00:00", opensAt: "2026-12-02T00:00" })).toBe("Registration must open before the tournament starts.");
    expect(stepProblem("registration", form)).toBe("");
    const w = createTournamentWizard({ api: mockFetcher({}) });
    w.start({ restore: false });
    expect(w.go("registration")).toBe(false);
    expect(w.state).toMatchObject({ step: "ruleset", error: "Choose a ruleset." });
    w.pickPackage("nut-cup");
    expect(w.go("registration")).toBe(false);
    expect(w.state).toMatchObject({ step: "details", error: "Enter a name." });
    w.state.form.name = "Spike Open";
    expect(w.go("review")).toBe(true);
    expect(w.go("ruleset")).toBe(true);
  });

  it("submit POSTs the wizard body once and reports the new id; refusals show verbatim; 401 signs out", async () => {
    let reply: unknown = { tournament: { id: "t9" } };
    const created: Array<[string, boolean]> = [];
    let signedOut = 0;
    const f = mockFetcher({ "POST /api/tournaments": () => reply });
    const w = createTournamentWizard({ api: f, onCreated: (id, published) => { created.push([id, published]); }, onSignedOut: () => { signedOut++; } });
    w.start({ restore: false });
    expect(await w.submit(true)).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    Object.assign(w.state.form, filled());
    expect(await w.submit(true)).toBe("t9");
    expect(f.calls).toEqual([{ path: "/api/tournaments", method: "POST", body: wizardBody(w.state.form, true) }]);
    expect(created).toEqual([["t9", true]]);
    reply = new ApiError(400, "Registration must close by the start.");
    expect(await w.submit(false)).toBeUndefined();
    expect(w.state.error).toBe("Registration must close by the start.");
    reply = new ApiError(401, "Authentication required.");
    await w.submit(false);
    expect(signedOut).toBe(1);
    expect(w.state).toMatchObject({ signedOut: true, error: "Signed out. Sign in and try again.", busy: "" });
  });

  it("the form survives the Tournament Creator round trip (sessionStorage) and ?package= / ?series= apply on top", () => {
    const store = new Map<string, string>();
    const g = globalThis as { sessionStorage?: unknown };
    const had = g.sessionStorage;
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      const w = createTournamentWizard({ api: mockFetcher({}) });
      w.start();
      w.state.form.name = "Spike Open";
      w.state.form.maxPlayers = 24;
      w.remember();
      expect(JSON.parse(store.get(DRAFT_KEY)!)).toMatchObject({ step: "ruleset", form: { name: "Spike Open", maxPlayers: 24 } });
      const back = createTournamentWizard({ api: mockFetcher({}) });
      back.start({ packageName: "fresh-cup", seriesId: "s1" });
      expect(back.state.form).toMatchObject({ name: "Spike Open", maxPlayers: 24, packageName: "fresh-cup", seriesId: "s1" });
      expect(back.state.step).toBe("details");
      back.forget();
      expect(store.has(DRAFT_KEY)).toBe(false);
      store.set(DRAFT_KEY, "{not json");
      const broken = createTournamentWizard({ api: mockFetcher({}) });
      broken.start();
      expect(broken.state.form).toEqual(blankWizardForm());
    } finally {
      g.sessionStorage = had;
    }
  });

  it("search, series and summary helpers", async () => {
    const pk = [{ name: "Nut Cup", description: "Resurrection" }, { name: "Small Gods" }];
    expect(filterPackages(pk, "resur").map((p) => p.name)).toEqual(["Nut Cup"]);
    expect(filterPackages(pk, " ").map((p) => p.name)).toEqual(["Nut Cup", "Small Gods"]);
    const w = createTournamentWizard({ api: mockFetcher({ "/api/series": { series: [{ id: "s1", name: "Mine", canEdit: true, seeding: "elo" }, { id: "s2", name: "Theirs", canEdit: false }] } }) });
    await w.loadSeries();
    expect(w.state.series).toEqual([{ id: "s1", name: "Mine", seeding: "elo" }]);
    const rows = summaryRows({ ...filled(), seriesId: "s1" }, w.state.series);
    expect(rows.details).toEqual(expect.arrayContaining([{ k: "Series", v: "Mine" }, { k: "Pairing", v: "Elo-seeded" }, { k: "Played on", v: "Tabletop" }]));
    expect(rows.registration).toEqual(expect.arrayContaining([{ k: "Opens", v: "When published" }, { k: "Places", v: "12" }, { k: "NAF", v: "Sanctioned" }]));
  });
});

describe("create views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, create, detail, vueRouter, renderer, menu, api, wizard] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/tournaments/create.ts"),
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/AccountMenu.vue"),
      vite.ssrLoadModule("/src/shared/api.ts"),
      vite.ssrLoadModule("/src/tournaments/wizard.ts"),
    ]);
    mods = { app, create, detail, vueRouter, renderer, menu, api, wizard };
  }, 60_000);

  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes, prep?: (inject: (key: symbol, v: unknown) => void, f: Fetcher) => Promise<void>) {
    const f = mockFetcher({ ...ANON, "/api/fork/tournaments": listPage(), ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    await spa.session.load();
    return { html: (await mods.renderer.renderToString(spa.app)) as string, spa, f };
  }

  it("Tournaments toolbar: CREATE (a link to the wizard) right of Search for an organiser, an admin or a test sign-in; none signed out or for a plain coach", async () => {
    for (const routes of [AS("Veers", { organizer: true }), AS("Ada", { admin: true }), AS("Veers", { organizer: true, test: true })]) {
      const { html } = await render("/tournaments", routes);
      expect(html).toMatch(/class="tl-search-btn" type="submit">Search<\/button><\/form><a href="\/app\/tournaments\/new" class="tl-create-btn">Create<\/a><\/div>/);
    }
    for (const routes of [ANON, AS("Bob")]) {
      const { html } = await render("/tournaments", routes);
      expect(html).toContain('class="tl-search-btn"');
      expect(html).not.toContain("tl-create-btn");
    }
  });

  it("account menu: Create tournament between Account and Sign out only when allowed", async () => {
    const menu = async (canCreate: boolean) => {
      const app = createSSRApp(mods.menu.default, { canCreate });
      app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] }));
      return (await mods.renderer.renderToString(app)) as string;
    };
    const itemsOf = (html: string) => [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(itemsOf(await menu(true))).toEqual(["Account", "Create tournament", "Sign out"]);
    expect(itemsOf(await menu(false))).toEqual(["Account", "Sign out"]);
  });

  it("the old entry points open the wizard: /tournaments/new is its own route, the menu, the series page and the Creator link to it", async () => {
    const { spa } = await render("/tournaments", AS("Veers", { organizer: true }));
    expect(spa.router.resolve("/tournaments/new").name).toBe("tournament-new");
    expect(spa.router.resolve("/tournaments/t9").name).toBe("tournament-detail");
    const { readFileSync } = await import("node:fs");
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(src("../spa/src/App.vue")).toContain('void router.push({ name: "tournament-new" })');
    expect(src("../spa/src/App.vue")).not.toContain("TournamentCreateDialog");
    expect(src("../spa/src/views/SeriesDetailView.vue")).toContain('router.push({ name: "tournament-new", query: { series: series.value.id } })');
    expect(src("../spa/src/views/TournamentCreatorView.vue")).toContain('router.push({ name: "tournament-new", query: { package: state.selected } })');
  });

  type WizardPrep = (w: Wizard) => void | Promise<void>;
  const SERIES = { "/api/series": { series: [{ id: "s1", name: "Valley Series", seeding: "monrad", canEdit: true }, { id: "s2", name: "Other Series", canEdit: false }] } };
  async function renderWizard(prep: WizardPrep, routes: Routes = AS("Veers", { organizer: true })) {
    return render("/tournaments/new", { ...routes, ...PACKAGES, ...SERIES }, async (inject, f) => {
      const w: Wizard = mods.wizard.createTournamentWizard({ api: f });
      w.start({ restore: false });
      await w.loadPackages();
      await w.loadSeries();
      await prep(w);
      inject(mods.wizard.TOURNAMENT_WIZARD_KEY, w);
    });
  }
  const captions = (html: string) => [...html.matchAll(/class="sf-k">([^<]+)</g)].map((m) => m[1]);

  it("wizard, step 1: step tabs, band with STEP 1 OF 4, ruleset cards with a search and Create a new ruleset, the summary panel", async () => {
    const { html } = await renderWizard((w) => { w.pickPackage("small-gods"); });
    const steps = [...html.matchAll(/<button type="button" class="tl-seg-btn" data-step="(\w+)"[^>]*><b class="tw-num">(\d)<\/b>(\w+)<\/button>/g)].map((m) => `${m[2]}${m[3]}`);
    expect(steps).toEqual(["1Ruleset", "2Details", "3Registration", "4Review"]);
    expect(html).toMatch(/data-step="ruleset" aria-current="step"/);
    expect(html).toMatch(/<h2 id="tw-step-h">Pick a ruleset<\/h2><span class="hm-cap">Step 1 of 4<\/span>/);
    expect(html).toContain('data-package="nut-cup" aria-pressed="false"');
    expect(html).toContain('data-package="small-gods" aria-pressed="true"');
    expect(html).toContain(">Create a new ruleset</button>");
    expect(html).toContain('<h2 id="tw-sum-h">Tournament summary</h2>');
    expect(html).toMatch(/<dt>Ruleset<\/dt><dd>small-gods<\/dd>/);
    expect(html).toContain(">Next</button>");
    expect(html).not.toContain(">Back</button>");
    expect(html).not.toContain("lobby-");
  });

  it("wizard, step 2: details in grouped panels; tabletop shows the venue fields, Super FUMBBL hides them; only the coach's own series", async () => {
    const tabletop = await renderWizard((w) => { w.pickPackage("nut-cup"); w.go("details"); });
    expect(tabletop.html).toMatch(/<h2 id="tw-step-h">Details<\/h2><span class="hm-cap">Step 2 of 4<\/span>/);
    expect(captions(tabletop.html)).toEqual(["Name", "Series", "Starts (UTC)", "Ends (UTC)", "Summary", "Venue", "Address", "Map link", "Local start time", "Format", "Rounds", "Pairing", "Seeding", "First tiebreaker", "Turn timer"]);
    expect(tabletop.html).toContain('<option value="s1">Valley Series</option>');
    expect(tabletop.html).not.toContain("Other Series");
    const online = await renderWizard((w) => { w.pickPackage("nut-cup"); w.go("details"); w.state.form.playOnFork = true; w.state.form.format = "knockout"; });
    expect(captions(online.html)).not.toContain("Venue");
    expect(captions(online.html)).not.toContain("Rounds");
    expect(online.html).toContain("Fixtures are played online");
  });

  it("wizard, step 3: registration window, places, waitlist, approval, roster later + deadline, check-in, entry fee and the NAF rule-23 note", async () => {
    const { html } = await renderWizard((w) => { w.pickPackage("nut-cup"); w.state.form.name = "Spike Open"; w.go("registration"); w.state.form.nafSanctioned = true; });
    expect(html).toMatch(/Step 3 of 4/);
    expect(captions(html)).toEqual(["Opens (UTC)", "Closes (UTC)", "Places", "Roster deadline (UTC)", "Opens (UTC)", "Closes (UTC)", "Entry fee", "PayPal link (optional)", "Venmo username (optional)"]);
    expect(html).toContain("Waitlist when full");
    expect(html).toMatch(/aria-pressed="true">Automatic<\/button>/);
    // organiser approval waits for the approval flow (lane L4): offered disabled, with the reason beside it
    expect(html).toMatch(/aria-pressed="false" disabled aria-describedby="tw-approval-soon">Organisers approve<\/button>/);
    expect(html).toContain("Organiser approval is coming with registration approvals.");
    expect(html).toContain("Register now, roster later");
    expect(html).toContain("Coaches check themselves in");
    expect(html).toContain('data-naf-note="true"');
  });

  it("wizard, step 4: the choices as key/value blocks with Edit links, then Save draft and Publish", async () => {
    const { html } = await renderWizard((w) => { w.pickPackage("nut-cup"); w.state.form.name = "Spike Open"; w.state.form.seriesId = "s1"; w.go("review"); });
    expect(html).toMatch(/<h2 id="tw-step-h">Review<\/h2><span class="hm-cap">Step 4 of 4<\/span>/);
    expect([...html.matchAll(/aria-label="Edit (\w+)"/g)].map((m) => m[1])).toEqual(["ruleset", "details", "registration"]);
    expect(html).toMatch(/<dt>Name<\/dt><dd>Spike Open<\/dd>/);
    expect(html).toMatch(/<dt>Series<\/dt><dd>Valley Series<\/dd>/);
    expect(html).toMatch(/<dt>Pairing<\/dt><dd>Monrad<\/dd>/);
    expect(html).toMatch(/<dt>Approval<\/dt><dd>Automatic<\/dd>/);
    expect(html).toContain(">Save draft</button>");
    expect(html).toContain(">Publish</button>");
    expect(html).not.toContain(">Next</button>");
  });

  it("wizard: a plain coach gets the organisers-only panel with the request link; a 401 keeps the form with the sign-in link", async () => {
    const plain = await renderWizard(() => undefined, AS("Bob"));
    expect(plain.html).toContain('<h2 id="tw-denied-h">Organisers only</h2>');
    expect(plain.html).toContain('href="/app/organiser/request"');
    expect(plain.html).not.toContain("tw-steps");
    const lapsed = await render("/tournaments/new", { ...AS("Veers", { organizer: true }), ...PACKAGES, ...SERIES, "POST /api/tournaments": new mods.api.ApiError(401, "Authentication required.") }, async (inject, f) => {
      const w: Wizard = mods.wizard.createTournamentWizard({ api: f });
      w.start({ restore: false });
      w.pickPackage("nut-cup");
      w.state.form.name = "Spike Open";
      expect(await w.submit(true)).toBeUndefined();
      inject(mods.wizard.TOURNAMENT_WIZARD_KEY, w);
    });
    expect(lapsed.html).toContain("Signed out. Sign in and try again.");
    expect(lapsed.html).toMatch(/class="sf-discord-login small" href="\/api\/auth\/discord\/start\?next=%2Fapp%2Ftournaments%2Fnew"/);
  });

  it("wizard styles: tokens only, the fit-to-1080 pane rules, one column under 900 px", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tournaments/wizard.css", import.meta.url)), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    // fit to 1920x1080: the shell's screen-only fit query (spaFit.test.ts); the step body scrolls and keeps 160 px
    expect(css).toContain("@media screen and (min-width: 1367px) and (min-height: 700px) {");
    expect(css).toContain(".tw-fit .tw-body { flex: 1 1 auto; min-height: 160px; overflow: auto; }");
    expect(css).toMatch(/@media \(max-width: 900px\) \{ \.tw-grid \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
  });

  it("Manage: Publish on an unpublished draft, Unpublish on a published one (managers); the controller posts to /publish and /unpublish", async () => {
    const t = (over: Partial<TournamentSummary>) => ({ id: "t9", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3, currentRound: 0, entrantCount: 0, ownerCoachId: "Veers", ...over }) as TournamentSummary;
    const page = async (summary: TournamentSummary) => {
      const body: TournamentDetailResponse = { tournament: summary, entrants: [], rounds: [], scheduledMatches: [], capabilities: { manage: true, assignRoles: true } };
      const routes: Routes = { ...AS("Veers", { organizer: true }), "/api/tournaments/t9": body, "POST /api/tournaments/t9/publish": { tournament: summary }, "POST /api/tournaments/t9/unpublish": { tournament: summary } };
      let d: { publish(): Promise<unknown>; unpublish(): Promise<unknown> } | undefined;
      const out = await render("/tournaments/t9?tab=manage", routes, async (inject, f) => {
        d = mods.detail.createTournamentDetail({ api: f });
        await (d as unknown as { load(id: string): Promise<void> }).load("t9");
        inject(mods.detail.TOURNAMENT_DETAIL_KEY, d);
      });
      return { ...out, d: d! };
    };
    const hidden = await page(t({ unpublished: true }));
    expect(hidden.html).toContain("<dt>Visibility</dt><dd>Unpublished: organisers only</dd>");
    expect(hidden.html).toMatch(/class="tn-actions tn-publish"><button class="sf-btn primary" type="button">Publish<\/button>/);
    await hidden.d.publish();
    expect(hidden.f.calls.some((c) => c.method === "POST" && c.path === "/api/tournaments/t9/publish")).toBe(true);
    const shown = await page(t({}));
    expect(shown.html).toContain("<dt>Visibility</dt><dd>Public</dd>");
    expect(shown.html).toMatch(/class="tn-actions tn-publish"><button class="sf-btn" type="button">Unpublish<\/button>/);
    await shown.d.unpublish();
    expect(shown.f.calls.some((c) => c.method === "POST" && c.path === "/api/tournaments/t9/unpublish")).toBe(true);
    const active = await page(t({ status: "active", startedAt: "2026-11-01T00:00:00.000Z" }));
    expect(active.html).not.toContain("tn-publish");
  });

  it("after Create: the new draft's Manage tab shows the created notice once", async () => {
    const t = { id: "t9", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3, currentRound: 0, entrantCount: 0, ownerCoachId: "Veers" } as TournamentSummary;
    const body: TournamentDetailResponse = { tournament: t, entrants: [], rounds: [], scheduledMatches: [], capabilities: { manage: true, assignRoles: true } };
    const routes = { ...AS("Veers", { organizer: true }), ...PACKAGES, "/api/tournaments/t9": body, "POST /api/tournaments": { tournament: t } };
    let creator: Creator | undefined;
    const { html, spa } = await render("/tournaments/t9?tab=manage", routes, async (inject, f) => {
      creator = mods.create.createTournamentCreator({ api: f });
      creator!.show();
      await creator!.loadPackages();
      creator!.state.form.name = "Spike Open";
      expect(await creator!.submit()).toBe("t9");
      inject(mods.create.TOURNAMENT_CREATOR_KEY, creator);
      const d = mods.detail.createTournamentDetail({ api: f });
      await d.load("t9");
      inject(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    });
    expect(spa.router.currentRoute.value.query.tab).toBe("manage");
    // The dialog pushes createdLocation(id): the new draft's Manage tab.
    expect(spa.router.resolve(mods.create.createdLocation("t9")).fullPath).toBe("/tournaments/t9?tab=manage");
    expect(html).toContain('<p class="tn-notice" role="status">Tournament created as a draft.</p>');
    expect(creator!.state.created).toBeNull();
  });
});
