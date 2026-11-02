// Creation wizards v2, lane 2 (SPA): the ruleset's custom stars in the Roster Builder (offered on the roster, tabletop-only,
// their custom traits and rules under "Special rules" in the Stars list, the roster row, the Ruleset step and the Sheet), the
// Creator's "Create a star" row, the change-message dialog and the public ruleset summary page. Server-rendered with mocked
// fetchers; no live data.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createSSRApp, h } from "vue";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentBuilder } from "../spa/src/teams/builder";

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init.body) : hit;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const HOUND = {
  id: "grim-hound", name: "Grim Hound", cost: 150000, MA: 7, ST: 3, AG: 3, PA: null, AV: 9, skills: ["Loner (4+)", "Dodge"],
  specialRules: [{ kind: "trait", name: "Fog Walker", description: "Once per half, ignore one tackle zone when dodging." }, { kind: "rule", name: "Crowd Favourite", description: "Counts as a Team Mascot." }],
};
const HUMAN = {
  rosterId: "human", raceName: "Human", reRollCost: 50000, maxReRolls: 8, apothecaryAllowed: true, leagueOptions: [], specialRules: [], alwaysOnRules: [],
  positions: [{ positionId: "hlin", name: "Human Lineman", type: "Lineman", cost: 50000, max: 16, MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: [], keywords: ["Human", "Lineman"], playsFor: [] }],
};
const RULES = { name: "Hound Cup", budget: 1300000, overview: { summary: [], groups: [] } };
const RACE = { roster: "Human", source: "flat", gold: 1300000, skillPointBudget: 0, packs: [], bannedStars: [], stars: { allowed: true, maxCount: 2 } };
const PKG = { description: "", eligibleRosters: ["*"], customStars: [HOUND] };
function routes(over: Routes = {}): Routes {
  return {
    "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
    "/api/fork/rosters": { rosters: [HUMAN] },
    "/api/packages": [{ name: "Hound Cup" }],
    "/api/packages/Hound%20Cup": { pkg: PKG, rules: RULES },
    "/api/packages/Hound%20Cup?roster=Human": { pkg: PKG, rules: { ...RULES, race: RACE } },
    "/api/fork/team-builder/tiers?packageName=Hound%20Cup": { races: [] },
    "/api/fork/team-builder/inducements?packageName=Hound%20Cup": { inducements: [] },
    "/api/skills": { general: [] },
    "POST /api/fork/team-builder/preview": { valid: true, errors: [], warnings: [], summary: { goldUsed: 700000, goldBudget: 1300000 } },
    ...over,
  };
}

describe("Roster Builder controller: custom stars", () => {
  it("offers the ruleset's custom star on the roster, hires it untouched, refuses the fork build, and restores a save with it", async () => {
    const f = mockFetcher(routes());
    const b = createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
    await b.init({ packageName: "Hound Cup", race: "human" });
    expect(b.starChoices().map((c) => c.label)).toContain("Grim Hound");
    b.setTeamName("Hounds");
    expect(b.addStar(b.starChoices().find((c) => c.label === "Grim Hound")!.key)).toBe(true);
    expect(b.state.slots.map((s) => s.positionId)).toEqual(["cs-grim-hound"]);
    expect(b.specialRulesOf("cs-grim-hound").map((r) => r.name)).toEqual(["Fog Walker", "Crowd Favourite"]);
    expect(b.requestBody().picks).toEqual([expect.objectContaining({ positionId: "cs-grim-hound", count: 1 })]);
    expect(await b.build()).toBe(false);
    expect(b.state.buildResult?.lines.join(" ")).toContain("custom star are tabletop only");
    expect(f.calls.some((c) => c.path === "/api/fork/team-builder/build")).toBe(false);
    // a saved draft with the star restores it
    const saved = { save: { id: "s1", name: "Hounds", body: { packageName: "Hound Cup", rosterId: "human", teamName: "Hounds", picks: [{ positionId: "cs-grim-hound", count: 1 }] } } };
    const again = createTournamentBuilder({ api: mockFetcher(routes({ "/api/fork/team-builder/saves/s1": saved })), coach: () => "Alice", previewDelay: 0 });
    await again.init({});
    expect(await again.loadSave("s1")).toBe(true);
    expect(again.state.slots.map((s) => s.positionId)).toEqual(["cs-grim-hound"]);
  });
});

describe("custom stars and the change message (server-rendered)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, builderMod, dialog, change, appKeys] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/teams/builder.ts"),
      vite.ssrLoadModule("/src/components/CustomStarDialog.vue"), vite.ssrLoadModule("/src/components/RulesChangeDialog.vue"), vite.ssrLoadModule("/src/app.ts"),
    ]);
    mods = { app, vueRouter, renderer, builderMod, dialog, change, appKeys };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function renderBuilder(path: string, prepare: (b: any) => Promise<void> | void): Promise<string> {
    const f = mockFetcher(routes());
    const builder = mods.builderMod.createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
    await builder.init({ packageName: "Hound Cup", race: "human" });
    await prepare(builder);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.builderMod.TOURNAMENT_BUILDER_KEY, builder);
    await spa.session.load();
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }
  const hire = (b: any) => { b.state.leftPanel = "stars"; b.setTeamName("Hounds"); b.addStar(b.starChoices().find((c: { label: string }) => c.label === "Grim Hound").key); };

  it("the roster row and the Stars list print the special rules below the skills", async () => {
    const html = await renderBuilder("/tournament-team-builder?tab=roster", hire);
    const row = html.slice(html.indexOf('data-row="0"'), html.indexOf("</li>", html.indexOf('data-row="0"')));
    expect(row).toContain("Grim Hound");
    expect(row.indexOf("Dodge")).toBeLessThan(row.indexOf("Special rules"));
    expect(row).toContain("Fog Walker");
    expect(row).toContain("Once per half, ignore one tackle zone when dodging.");
    expect(row).not.toContain("tb-advance"); // stars take no added skills or stat increases
    const stars = html.slice(html.indexOf('class="tb-stars'));
    expect(stars).toContain("Crowd Favourite");
  });

  it("the Ruleset step lists the custom stars and links the ruleset summary; the Sheet prints SPECIAL RULES", async () => {
    const ruleset = await renderBuilder("/tournament-team-builder?tab=ruleset", hire);
    expect(ruleset).toContain("Custom stars (1)");
    expect(ruleset).toContain("Fog Walker");
    expect(ruleset).toContain('/app/ruleset-summary?package=Hound%20Cup');
    const sheet = await renderBuilder("/tournament-team-builder?tab=sheet", hire);
    expect(sheet).toContain("SPECIAL RULES");
    expect(sheet).toContain("Crowd Favourite");
  });

  it("Create a star: a Roster Builder row with sprite, name, cost, stat steppers, skills, the + and Special rules", async () => {
    const app = createSSRApp({ render: () => h(mods.dialog.default, { star: HOUND, others: [], datasetStars: [] }) });
    app.provide(mods.appKeys.API_KEY, mockFetcher({}));
    const html = (await mods.renderer.renderToString(app)) as string;
    expect(html).toContain("Edit star");
    expect(html).toContain("data-custom-star-row");
    for (const s of ["MA", "ST", "AG", "PA", "AV"]) expect(html).toContain(`data-step="up-${s}"`);
    expect(html).toContain('aria-label="Add a skill, a custom trait or a custom rule"');
    expect(html).toContain("Special rules");
    expect(html).toContain("Fog Walker");
    expect(html).toContain("Save star");
    const blank = createSSRApp({ render: () => h(mods.dialog.default, { star: null, others: [], datasetStars: [] }) });
    blank.provide(mods.appKeys.API_KEY, mockFetcher({}));
    expect((await mods.renderer.renderToString(blank)) as string).toContain("Create a star");
  });

  it("the change-message dialog lists what changes and counts the message", async () => {
    const html = (await mods.renderer.renderToString(createSSRApp({ render: () => h(mods.change.default, { kind: "tournament", changes: ["Ruleset: A → B"], coaches: 3, afterStart: false }) }))) as string;
    expect(html).toContain("Explain the rules change");
    expect(html).toContain("3 registered coaches");
    expect(html).toContain("Ruleset: A → B");
    expect(html).toContain("0 / 500 (at least 10)");
    expect(html).toContain("Save and notify coaches");
    const started = (await mods.renderer.renderToString(createSSRApp({ render: () => h(mods.change.default, { kind: "league", changes: ["MVP: Pick 3 → Random"], coaches: 0, afterStart: true }) }))) as string;
    expect(started).toContain("Continue");
  });

  it("the public ruleset summary page renders every section and the PDF button, no sign-in", async () => {
    const summary = {
      name: "Hound Cup", description: "A test ruleset", dataNote: "", draft: false, format: "standard", competition: null,
      limits: [{ k: "Team budget", v: "1,300k" }], overview: { summary: [{ label: "Structure", text: "One rule for all." }], groups: [{ label: "All teams", teams: [{ name: "Human", gold: 1300000, goldMax: null, allotment: ["No added skills"] }] }] },
      skillAccess: { categories: ["General", "Agility"], rows: [{ race: "Human", position: "Human Lineman", cells: ["P", "S"] }] },
      bans: { stars: ["Morg 'n' Thorg"], skills: [] }, inducements: [{ name: "Bribes", price: 100000, max: 3, note: "", houseRule: false }],
      houseRules: null, progression: null, customStars: [{ ...HOUND, AG: "3+", PA: "-", AV: "9+", sprite: null }],
    };
    const f = mockFetcher({ "/api/auth/session": { authenticated: false }, "/api/ruleset-summary?package=Hound%20Cup": { summary } });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await spa.session.load();
    await spa.router.push("/ruleset-summary?package=Hound%20Cup");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    for (const section of ["limits", "bans", "house-rules", "custom-stars", "tiers", "inducements", "skill-access"]) expect(html).toContain(`data-section="${section}"`);
    expect(html).toContain("Download PDF");
    expect(html).toContain("Fog Walker");
    expect(html).toContain('data-access="P"');
    expect(html).toContain("Morg &#39;n&#39; Thorg");
    expect(html).not.toContain("comment");
    // a 404 (unknown or draft) says it isn't public
    const f404 = mockFetcher({ "/api/auth/session": { authenticated: false } });
    const spa2 = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f404 });
    await spa2.session.load();
    await spa2.router.push("/ruleset-summary?package=Secret");
    await spa2.router.isReady();
    expect((await mods.renderer.renderToString(spa2.app)) as string).toContain("isn&#39;t public yet");
  });
});
