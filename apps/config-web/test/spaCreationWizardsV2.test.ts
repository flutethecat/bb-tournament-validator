// Creation wizards v2 (lane 1), SPA side: tournament step order and old-draft migration (sessionStorage), Played on in
// General for both wizards, the Featured ruleset cards with BB2025 preselected, the house rules round trip through the
// wizard bodies, league-only vs tournament-only house rules, the Progression tickboxes, Review's whole-form validation
// for both buttons, the league wizard's General / Connections split, the avatar menu by role, and the overview HOUSE RULES
// panel. Server-rendered with mocked fetchers; no live data.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createSSRApp, h, reactive } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { blankWizardForm, createTournamentWizard, DRAFT_KEY, migrateStep, stepProblem, WIZARD_STEPS, wizardBody } from "../spa/src/tournaments/wizard";
import {
  BB2020_CARD, createLeagueWizard, emptyForm, RULES_STASH_KEY, rulesErrors, selectedCardKey, stepPayload, summaryGroups, WIZARD_STEPS as LEAGUE_STEPS, type WizardDraft,
} from "../spa/src/leagues/wizard";
import { DEFAULT_RULESET_PACKAGE, FEATURED_RULESETS, filterCards, rulesetCards, rulesetLabel } from "../spa/src/shared/competition";

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Handler = unknown | ((body: unknown) => unknown);
function mockFetcher(routes: Record<string, Handler>): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, ...(init?.body !== undefined ? { body: init.body } : {}) });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const v = typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
    if (v instanceof Error) throw v;
    return v;
  }) as unknown as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

function withSession<T>(store: Map<string, string>, run: () => T): T {
  const g = globalThis as { sessionStorage?: unknown };
  const had = g.sessionStorage;
  g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try { return run(); } finally { g.sessionStorage = had; }
}

const PACKAGES = [
  { name: "BB2025 Default", description: "Baseline" }, { name: "EuroBowl 2026" }, { name: "Small Gods" },
  { name: "NAF World Cup 2027 (Malta) - Rules Pack V3.0" }, { name: "Spike! 2026" },
];

describe("tournament wizard v2: steps, drafts, defaults", () => {
  it("runs Ruleset -> General -> Format -> Registration -> Review", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["ruleset", "general", "format", "registration", "review"]);
  });
  it("maps an old saved draft's step and single tiebreaker onto v2 (sessionStorage)", () => {
    expect(migrateStep("details")).toBe("general");
    expect(migrateStep("format")).toBe("format");
    expect(migrateStep("nonsense")).toBeUndefined();
    const store = new Map<string, string>([[DRAFT_KEY, JSON.stringify({ step: "details", form: { name: "Old Cup", packageName: "Nut Cup", primaryTiebreaker: "sonnebornBerger", maxPlayers: 12 } })]]);
    const w = withSession(store, () => { const x = createTournamentWizard({ api: mockFetcher({}) }); x.start(); return x; });
    expect(w.state.step).toBe("general");
    expect(w.state.form).toMatchObject({ name: "Old Cup", packageName: "Nut Cup", maxPlayers: 12, tiebreakerChain: ["sonnebornBerger", "touchdownDifferential", "casualtyDifferential"] });
    // v2 fields from an old draft keep their defaults; a broken object value never replaces them
    expect(w.state.form.houseRules.progression?.enabled).toBe(false);
    const bad = new Map<string, string>([[DRAFT_KEY, JSON.stringify({ step: "format", form: { houseRules: { prayers: { mode: "nope" } }, points: { win: "x" }, tiebreakerChain: ["seed"] } })]]);
    const b = withSession(bad, () => { const x = createTournamentWizard({ api: mockFetcher({}) }); x.start(); return x; });
    expect(b.state.step).toBe("format");
    expect(b.state.form.houseRules).toEqual(blankWizardForm().houseRules);
    expect(b.state.form.points).toEqual({ win: 3, draw: 1, loss: 0 });
    expect(b.state.form.tiebreakerChain).toEqual(["buchholz", "touchdownDifferential", "casualtyDifferential"]);
  });
  it("preselects BB2025 and keeps it only when this server has the package", async () => {
    expect(blankWizardForm().packageName).toBe(DEFAULT_RULESET_PACKAGE);
    const have = createTournamentWizard({ api: mockFetcher({ "/api/packages": PACKAGES }) });
    have.start({ restore: false });
    await have.loadPackages();
    expect(have.state.form.packageName).toBe("BB2025 Default");
    const none = createTournamentWizard({ api: mockFetcher({ "/api/packages": [{ name: "Spike! 2026" }] }) });
    none.start({ restore: false });
    await none.loadPackages();
    expect(none.state.form.packageName).toBe("");
  });
  it("Featured cards first (BB2025, EuroBowl 2026, Small Gods, World Cup 3.0), then the rest", () => {
    const t = rulesetCards(PACKAGES, "tournament");
    expect(t.featured.map((c) => c.label)).toEqual(["BB2025", "EuroBowl 2026", "Small Gods", "World Cup 3.0"]);
    expect(t.others.map((c) => c.packageName)).toEqual(["Spike! 2026"]);
    expect(FEATURED_RULESETS[3]!.packageName).toBe("NAF World Cup 2027 (Malta) - Rules Pack V3.0");
    // a featured package this server lacks is left out
    expect(rulesetCards([{ name: "EuroBowl 2026" }], "tournament").featured.map((c) => c.label)).toEqual(["EuroBowl 2026"]);
    // leagues: BB2025 is always the plain base ruleset; BB2020 joins the rest
    const l = rulesetCards(PACKAGES, "league", [BB2020_CARD]);
    expect(l.featured[0]).toMatchObject({ packageName: "", ruleset: "BB2025", label: "BB2025" });
    expect(l.others.map((c) => c.label)).toEqual(["BB2020", "Spike! 2026"]);
    expect(filterCards(t.featured, "malta").map((c) => c.label)).toEqual(["World Cup 3.0"]);
    expect(rulesetLabel("EuroBowl 2026")).toBe("EuroBowl 2026");
    expect(rulesetLabel("", "BB2020")).toBe("BB2020");
  });
  it("sends house rules, the progression tickboxes, points, the chain, avoidance (Swiss only) and regions", () => {
    const form = { ...blankWizardForm(), name: "Grill Cup", pairingAvoid: "club" as const, regions: [" North ", "", "South"], points: { win: 2000, draw: 1000, loss: 0 } };
    form.houseRules = { ...form.houseRules, prayers: { mode: "cost", costK: 60 }, progression: { enabled: true, spp: true, injuries: false, treasury: true } };
    form.tiebreakerChain = ["headToHead", "touchdownDifferential"];
    const body = wizardBody(form, true);
    expect(body).toMatchObject({
      publish: true, tiebreakers: ["headToHead", "touchdownDifferential"], points: { win: 2000, draw: 1000, loss: 0 }, pairingAvoid: "club", regions: ["North", "South"],
      houseRules: { prayers: { mode: "cost", costK: 60 }, progression: { enabled: true, spp: true, injuries: false, treasury: true } },
    });
    expect(wizardBody({ ...form, format: "knockout" }, true)).not.toHaveProperty("pairingAvoid");
    expect(stepProblem("ruleset", { ...form, houseRules: { ...form.houseRules, mvp: "pick3" } })).toContain("league settings");
  });
  it("Review: Save as draft and Publish now both check the whole form and open the first step with a problem", async () => {
    const f = mockFetcher({ "POST /api/tournaments": { tournament: { id: "t1" } } });
    const w = createTournamentWizard({ api: f });
    w.start({ restore: false });
    w.state.form.name = "Grill Cup";
    w.state.form.points = { win: 1, draw: 2, loss: 0 };
    w.state.step = "review";
    expect(await w.submit(false)).toBeUndefined();
    expect(w.state.step).toBe("format");
    expect(w.state.error).toContain("more points than a draw");
    w.state.form.points = { win: 3, draw: 1, loss: 0 };
    w.state.form.maxPlayers = 1;
    expect(await w.submit(true)).toBeUndefined();
    expect(w.state.step).toBe("registration");
    expect(f.calls).toHaveLength(0);
    w.state.form.maxPlayers = 8;
    expect(await w.submit(true)).toBe("t1");
    expect((f.calls[0]!.body as { publish: boolean }).publish).toBe(true);
  });
});

const draft = (over: Partial<WizardDraft> = {}): WizardDraft => ({
  id: "grill", revision: 1, visibility: "draft", step: 2, test: false,
  identity: { name: "Grill", fullName: "", slug: "grill", description: "", address: null, playOnFork: true },
  rules: { ruleset: "BB2025", rulesetPackage: "EuroBowl 2026", allowedRosters: { official: true, nafApproved: true, unofficial: false }, maxRegistrations: null, maxPerRace: null, teamBuilding: { rosters: [], eliteSkills: [] }, houseRules: { prayers: { mode: "banned" }, brawlingBrutes: "on", maxStatIncreasesTeam: 3, maxStatIncreasesPlayer: null, mvp: "random", hireFire: "enforced" } },
  season: null,
  connections: { playOnFork: false, discord: { configured: false, maskedUrl: "", events: {} } },
  ...over,
});

describe("league wizard v2", () => {
  it("runs General -> Rules -> Season 1 -> Connections -> Review; Played on is General, Connections is Discord only", () => {
    expect(LEAGUE_STEPS.map((s) => s.label)).toEqual(["General", "Rules", "Season 1", "Connections", "Review"]);
    const f = emptyForm();
    f.identity.name = "Grill";
    f.identity.playOnFork = true;
    expect(stepPayload("identity", f)).toEqual({ identity: { name: "Grill", fullName: "", description: "", playOnFork: true } });
    expect(stepPayload("connections", f)).toEqual({ connections: { discord: { events: f.connections.events } } });
    const groups = summaryGroups(f, null);
    expect(groups[0]!.title).toBe("General");
    expect(groups[0]!.rows).toContainEqual({ k: "Played on", v: "Super FUMBBL" });
    expect(groups.find((g) => g.step === "connections")!.rows.map((r) => r.k)).toEqual(["Discord"]);
  });
  it("Rules: BB2025 preselected, a package card picks a BB2025 pack, house rules (league-only fields) ride the rules step", () => {
    const f = emptyForm();
    expect(selectedCardKey(f.rules)).toBe("base:BB2025");
    f.rules.rulesetPackage = "Small Gods";
    f.rules.houseRules = { ...f.rules.houseRules, mvp: "pick3", hireFire: "notEnforced" };
    const p = stepPayload("rules", f) as { rules: Record<string, unknown> };
    expect(p.rules).toMatchObject({ ruleset: "BB2025", rulesetPackage: "Small Gods", houseRules: { mvp: "pick3", hireFire: "notEnforced" } });
    expect((p.rules.houseRules as Record<string, unknown>).progression).toBeUndefined();
    expect(summaryGroups(f, null).find((g) => g.step === "rules")!.rows).toEqual(expect.arrayContaining([{ k: "Ruleset", v: "Small Gods" }, { k: "MVP", v: "Pick 3" }]));
  });
  it("a resumed draft fills General, Rules and the house rules from the server; an older draft's Played on comes from connections", async () => {
    const w = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
    await w.start("grill");
    expect(w.state.form.identity.playOnFork).toBe(true);
    expect(w.state.form.rules).toMatchObject({ rulesetPackage: "EuroBowl 2026", houseRules: { prayers: { mode: "banned" }, mvp: "random" } });
    const old = draft({ identity: { name: "Grill", fullName: "", slug: "grill", description: "", address: null }, connections: { playOnFork: true, discord: { configured: false, maskedUrl: "", events: {} } } });
    const o = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: old } }) });
    await o.start("grill");
    expect(o.state.form.identity.playOnFork).toBe(true);
    // back from "Create a new ruleset": the new package is picked on the Rules step
    const back = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
    await back.start("grill", { packageName: "Fresh Pack" });
    expect(back.state.step).toBe("rules");
    expect(back.state.form.rules.rulesetPackage).toBe("Fresh Pack");
  });
  it("\"Create a new ruleset\" keeps the Rules step's unsaved edits and restores them on return (sessionStorage)", async () => {
    const store = new Map<string, string>();
    const g = globalThis as { sessionStorage?: unknown };
    const had = g.sessionStorage;
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      const w = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
      await w.start("grill");
      w.state.step = "rules";
      // the number inputs (v-model.number) hand back numbers, not strings
      (w.state.form.rules as unknown as Record<string, unknown>).maxRegistrations = 12;
      (w.state.form.rules as unknown as Record<string, unknown>).maxPerRace = 2;
      w.state.form.rules.houseRules = { ...w.state.form.rules.houseRules, hireFire: "notEnforced", maxStatIncreasesPlayer: 2 };
      w.stashRules();
      expect([...store.keys()]).toEqual([`${RULES_STASH_KEY}:grill`]);
      const back = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
      await back.start("grill", { packageName: "Fresh Pack" });
      expect(back.state.step).toBe("rules");
      expect(back.state.form.rules).toMatchObject({ maxRegistrations: "12", maxPerRace: "2", rulesetPackage: "Fresh Pack", houseRules: { hireFire: "notEnforced", maxStatIncreasesPlayer: 2, mvp: "random" } });
      expect(store.size).toBe(0);
      // "Cost change" with the cost cleared: that field comes back without a cost (the step flags it); nothing else is lost
      const half = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
      await half.start("grill");
      half.state.form.rules.houseRules = { ...half.state.form.rules.houseRules, prayers: { mode: "cost", costK: "" as unknown as number }, maxStatIncreasesTeam: 5, mvp: "pick3" };
      half.stashRules();
      const again = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
      await again.start("grill");
      expect(again.state.form.rules.houseRules).toMatchObject({ prayers: { mode: "cost" }, maxStatIncreasesTeam: 5, mvp: "pick3", brawlingBrutes: "on", hireFire: "enforced" });
      expect(again.state.form.rules.houseRules.prayers.costK).toBeUndefined();
      expect(rulesErrors(again.state.form).houseRules).toContain("Enter the Prayers to Nuffle cost");
      // a broken stash is dropped and the saved draft stands
      store.set(`${RULES_STASH_KEY}:grill`, "{not json");
      const broken = createLeagueWizard({ api: mockFetcher({ "/api/leagues/grill/draft": { draft: draft() } }) });
      await broken.start("grill");
      expect(broken.state.form.rules.houseRules.mvp).toBe("random");
    } finally {
      g.sessionStorage = had;
    }
    expect(readFileSync(fileURLToPath(new URL("../spa/src/components/LeagueWizardRules.vue", import.meta.url)), "utf8")).toMatch(/wizard\.stashRules\(\);\s*void router\.push/);
  });
  it("Review: Save as draft and Publish now validate every step first; Publish now also publishes", async () => {
    const routes: Record<string, Handler> = { "/api/leagues/grill/draft": { draft: draft({ step: 5 }) }, "PATCH /api/leagues/grill/draft": { draft: draft({ step: 5, revision: 2 }) }, "POST /api/leagues/grill/publish": { ok: true } };
    const f = mockFetcher(routes);
    const w = createLeagueWizard({ api: f });
    await w.start("grill");
    w.state.step = "review";
    w.state.form.season.regions = ["North", "north"];
    expect(await w.finish(true)).toBe(false);
    expect(w.state.step).toBe("season");
    expect(w.state.errors.regions).toContain("twice");
    expect(f.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    w.state.form.season.regions = ["North"];
    w.state.step = "review";
    expect(await w.finish(false)).toBe(true);
    expect(f.calls.some((c) => c.path.endsWith("/publish"))).toBe(false);
    expect(await w.finish(true)).toBe(true);
    expect(f.calls.filter((c) => c.path.endsWith("/publish"))).toHaveLength(1);
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ complete: true });
  });
});

describe("views (server-rendered)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [vueRouter, renderer, menu, panel, fields, picker] = await Promise.all([
      vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/AccountMenu.vue"),
      vite.ssrLoadModule("/src/components/HouseRulesPanel.vue"), vite.ssrLoadModule("/src/components/HouseRulesFields.vue"), vite.ssrLoadModule("/src/components/RulesetCardPicker.vue"),
    ]);
    mods = { vueRouter, renderer, menu, panel, fields, picker };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function renderComp(comp: unknown, props: Record<string, unknown>): Promise<string> {
    const app = createSSRApp({ render: () => h(comp as never, props) });
    app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] }));
    return (await mods.renderer.renderToString(app)) as string;
  }
  const itemsOf = (html: string) => [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((m) => m[1]);

  it("avatar menu by role: organisers create, others ask to organise", async () => {
    // a site organiser / admin who is not a member of anything (the global role decides)
    expect(itemsOf(await renderComp(mods.menu.default, { canCreate: true, canCreateLeague: true, askToOrganise: false }))).toEqual(["Account", "Create league", "Create tournament", "Sign out"]);
    // a coach who organises one league (a scoped role) but is not a site organiser: asks
    expect(itemsOf(await renderComp(mods.menu.default, { canCreate: false, canCreateLeague: false, askToOrganise: true }))).toEqual(["Account", "Ask to organise", "Sign out"]);
    const html = await renderComp(mods.menu.default, { canCreate: false, canCreateLeague: false, askToOrganise: true });
    expect(html).toContain('href="/organiser/request"');
    // "Ask to organise" never shows beside a create item
    expect(itemsOf(await renderComp(mods.menu.default, { canCreate: true, canCreateLeague: false, askToOrganise: true }))).toEqual(["Account", "Create tournament", "Sign out"]);
    const app = readFileSync(fileURLToPath(new URL("../spa/src/App.vue", import.meta.url)), "utf8");
    expect(app).toContain("const askToOrganise = computed(() => session.signedIn() && !canCreate.value && !canCreateLeagueHere.value);");
  });

  it("house rules group: league shows MVP and hire/fire, tournament shows Progression and its tickboxes", async () => {
    const league = await renderComp(mods.fields.default, { kind: "league", idPrefix: "x", modelValue: reactive(emptyForm().rules.houseRules) });
    expect(league).toContain('data-hr="mvp"');
    expect(league).toContain('data-hr="hireFire"');
    expect(league).not.toContain('data-hr="progression"');
    const off = await renderComp(mods.fields.default, { kind: "tournament", idPrefix: "x", modelValue: reactive(blankWizardForm().houseRules) });
    expect(off).toContain('data-hr="progression"');
    expect(off).not.toContain('data-hr="mvp"');
    expect(off).not.toContain("data-carry");
    const onRules = { ...blankWizardForm().houseRules, progression: { enabled: true, spp: true, injuries: false, treasury: true } };
    const on = await renderComp(mods.fields.default, { kind: "tournament", idPrefix: "x", modelValue: reactive(onRules) });
    expect([...on.matchAll(/data-carry="(\w+)"/g)].map((m) => m[1])).toEqual(["spp", "injuries", "treasury"]);
    expect(on).toMatch(/<input type="checkbox" checked data-carry="spp">/);
    expect(on).toMatch(/<input type="checkbox" data-carry="injuries">/);
    expect(on).toMatch(/data-progression="on"[^>]*>Progression|aria-pressed="true" data-progression="on"/);
  });

  it("ruleset picker: the Featured row first with the picked card pressed", async () => {
    const html = await renderComp(mods.picker.default, { kind: "tournament", packages: PACKAGES, status: "ready", selected: "BB2025 Default" });
    expect(html.indexOf('data-row="featured"')).toBeLessThan(html.indexOf('data-row="all"'));
    expect(html).toMatch(/data-featured="true" data-package="BB2025 Default" aria-pressed="true"/);
    expect([...html.matchAll(/data-featured="true"[^>]*><strong>([^<]+)</g)].map((m) => m[1])).toEqual(["BB2025", "EuroBowl 2026", "Small Gods", "World Cup 3.0"]);
    expect(html).toContain("Create a new ruleset");
  });

  it("overview HOUSE RULES panel: changed rows, the rest collapsed into one line, Edit for organisers", async () => {
    const plain = await renderComp(mods.panel.default, { kind: "league", rules: null, ruleset: "BB2025", idPrefix: "lg" });
    expect(plain).toContain("Everything as BB2025.");
    expect(plain).not.toContain("data-house-edit");
    const changed = { ...emptyForm().rules.houseRules, prayers: { mode: "banned" as const }, mvp: "pick3" as const };
    const org = await renderComp(mods.panel.default, { kind: "league", rules: changed, ruleset: "EuroBowl 2026", idPrefix: "lg", editTo: "/leagues/x/settings?tab=information#house-rules" });
    expect(org).toMatch(/<dt>Prayers to Nuffle<\/dt><dd>Banned<\/dd>/);
    expect(org).toMatch(/<dt>MVP<\/dt><dd>Pick 3<\/dd>/);
    expect(org).not.toContain("<dt>Brawling Brutes</dt>");
    expect(org).toContain("Everything else as EuroBowl 2026.");
    expect(org).toContain("data-house-edit");
    const t = { ...blankWizardForm().houseRules, progression: { enabled: true, spp: true, injuries: true, treasury: false } };
    const tour = await renderComp(mods.panel.default, { kind: "tournament", rules: t, ruleset: "Small Gods", idPrefix: "tn" });
    expect(tour).toMatch(/<dt>Progression<\/dt><dd>On: SPP and advancements, Lasting injuries and deaths<\/dd>/);
  });

  it("the overview panels and settings forms carry the new pieces (source checks)", () => {
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(src("../spa/src/components/LeagueOverview.vue")).toContain('<HouseRulesPanel kind="league"');
    expect(src("../spa/src/components/TournamentOverview.vue")).toContain('<HouseRulesPanel kind="tournament"');
    expect(src("../spa/src/components/LeagueSettingsInfo.vue")).toContain('<PlayedOnToggle v-model="form.playOnFork" />');
    expect(src("../spa/src/components/LeagueSettingsInfo.vue")).toContain("<LeagueSettingsHouseRules />");
    expect(src("../spa/src/components/LeagueSettingsConnections.vue")).not.toContain("Let league games be played on Super FUMBBL");
    expect(src("../spa/src/components/TournamentSettingsForm.vue")).toContain('<PlayedOnToggle v-model="form.playOnFork" />');
    expect(src("../spa/src/components/TournamentSettingsForm.vue")).toContain('<HouseRulesFields v-model="form.houseRules" kind="tournament"');
    expect(src("../spa/src/components/LeagueWizardConnections.vue")).not.toContain("playOnFork");
    expect(src("../spa/src/components/LeagueWizardIdentity.vue")).toContain('<PlayedOnToggle v-model="f.playOnFork" />');
    // admins see the read-only authorised chip
    expect(src("../spa/src/components/TournamentSettingsForm.vue")).toMatch(/v-if="session.admin\(\)"[^\n]*data-authorised/);
    expect(src("../spa/src/components/LeagueSettingsInfo.vue")).toMatch(/v-if="isAdmin"[^\n]*data-authorised/);
    // the payment slot is named in both wizards
    expect(src("../spa/src/tournaments/wizard.ts")).toContain("PAYMENT SLOT");
    expect(src("../spa/src/leagues/wizard.ts")).toContain("PAYMENT SLOT");
  });
});
