import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { loadPackage, type DeepPartial, type TournamentPackage } from "@bb/validator";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentCreator, packageReview } from "../spa/src/tournaments/creator";
import { freshView, normalizePackage, type RawDoc } from "../spa/src/tournaments/creatorCore";

// Tournament Creator (owner 11-02): the summary page (Preview tab) styled like the Roster Builder (grouped band panels,
// tiles, key/value rows, rule chips, the summary rows and the save panel), and a package with no format of its own that
// extends a Sevens base: every tab reads the RESOLVED base (Sevens controls, inherited values tagged), an override writes
// locally, and a save leaves the inherited fields out of the document.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const REPO = new URL("../../../", import.meta.url);
const SHIPPED = JSON.parse(readFileSync(new URL("tournament-packages/sevens-matched-play.json", REPO), "utf8")) as RawDoc;
const MATCHED = loadPackage(SHIPPED as DeepPartial<TournamentPackage>).pkg as unknown as RawDoc;
const NAME = String(SHIPPED.name);
const ENC = encodeURIComponent(NAME);

type Routes = Record<string, unknown>;
interface Call { path: string; method: string; body?: unknown }
function mockFetcher(routes: Routes): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}

const NUT_CUP: RawDoc = {
  name: "Nut Cup", ruleset: "bb2025-default", goldBudget: 1150000,
  skillAllotment: { skillPointBudget: 6, eliteSkills: ["Block"] },
  starPlayers: { allowed: true, maxCount: 2 },
  special: { bannedSkills: ["Dodge"] },
};
const CLUB: RawDoc = { name: "Club Sevens", extends: NAME, skillAllotment: {} };
const PLAIN: RawDoc = { name: "Plain", skillAllotment: { skillPointBudget: 4 } };

const API: Routes = {
  "/api/packages": ["Club Sevens", "Nut Cup", "Plain", NAME],
  "/api/presets": [], "/api/skills": { elite: [], general: [] }, "/api/stars": [], "/api/positions": [],
  "/api/teams": [{ name: "Dwarf", defaultTier: 1 }, { name: "Amazon", defaultTier: 1 }, { name: "Goblin", defaultTier: 4 }],
  "/api/packages/Nut%20Cup": () => ({ raw: structuredClone(NUT_CUP), revision: "r-nut", problems: [], schemaProblems: [] }),
  "/api/packages/Club%20Sevens": () => ({ raw: structuredClone(CLUB), revision: "r-club", problems: [], schemaProblems: [] }),
  "/api/packages/Plain": () => ({ raw: structuredClone(PLAIN), revision: "r-plain", problems: [], schemaProblems: [] }),
  [`/api/packages/${ENC}`]: () => ({ pkg: structuredClone(MATCHED), raw: structuredClone(SHIPPED), revision: "r-7s", problems: [], schemaProblems: [] }),
  "/crests/manifest.json": { crests: {} },
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const SECTIONS = ["overview", "team", "skills", "inducements", "special"];

describe("summary page model (packageReview)", () => {
  it("a standard package: every section, gold money, on/off chips", () => {
    const pkg = normalizePackage(NUT_CUP);
    const r = packageReview(pkg, { teams: [{ name: "Dwarf" }], view: freshView("skillpoints", "pool"), sevens: false, problems: 0 })!;
    expect(r.sections.map((s) => s.id)).toEqual(SECTIONS);
    const team = r.sections.find((s) => s.id === "team")!;
    expect(team.tiles.find((t) => t.key === "budget")).toMatchObject({ value: "1,150k", gold: true });
    expect(team.tiles.find((t) => t.key === "players")!.value).toBe("11–16");
    const ind = r.sections.find((s) => s.id === "inducements")!;
    expect(ind.tiles.find((t) => t.key === "stars")!.value).toBe("Max 2");
    expect(ind.chips.find((c) => c.key === "starsAllowed")!.on).toBe(true);
    expect(r.sections.find((s) => s.id === "skills")!.rows.find((x) => x.key === "bannedSkills")!.value).toBe("Dodge");
    expect(r.summary.find((x) => x.key === "valid")).toMatchObject({ value: "OK", tone: "ok" });
  });

  it("a Sevens package: Sevens tiles (players, non-Linemen), the Veteran, the Sevens list, no stars, staff prices", () => {
    const pkg = normalizePackage(SHIPPED);
    const r = packageReview(pkg, { teams: [], view: freshView("tiers", "pool"), sevens: true, problems: 2 })!;
    expect(r.sevens).toBe(true);
    expect(r.sections.map((s) => s.id)).toEqual(SECTIONS);
    const team = r.sections.find((s) => s.id === "team")!;
    expect(team.tiles.find((t) => t.key === "budget")!.value).toBe("600k");
    expect(team.tiles.find((t) => t.key === "players")!.value).toBe("7–11");
    expect(team.tiles.find((t) => t.key === "nonLineman")!.value).toBe("Max 4");
    expect(team.rows.find((x) => x.key === "price-reRoll")).toMatchObject({ value: "100k", tone: "gold" });
    expect(team.chips.find((c) => c.key === "veteran")!.on).toBe(true);
    const ind = r.sections.find((s) => s.id === "inducements")!;
    expect(ind.cap).toBe("Sevens list");
    expect(ind.chips.some((c) => c.label === "Desperate Measures" && c.on)).toBe(true);
    expect(ind.chips.find((c) => c.key === "starsAllowed")).toMatchObject({ on: false, label: "No Star Players (Sevens)" });
    expect(r.sections.find((s) => s.id === "special")!.chips.some((c) => c.key === "slannAllowed")).toBe(false);
    expect(r.summary.find((x) => x.key === "valid")).toMatchObject({ value: "2 problems", tone: "off" });
  });
});

describe("inherited Sevens: the controller reads the resolved base", () => {
  it("fills absent keys from the base, tags them inherited, and a save leaves them out", async () => {
    let posted: unknown = null;
    const f = mockFetcher({ ...API, "POST /api/packages": (body: unknown) => { posted = body; return { name: "Club Sevens", revision: "r-club-2", problems: [] }; } });
    const c = createTournamentCreator({ api: f });
    await c.init();
    await c.open("Club Sevens");
    await settle();
    expect(c.sevens()).toBe(true);
    expect(c.state.pkg!.format).toBeUndefined(); // the format stays the base's
    expect(c.state.pkg!.special.maxPlayers).toBe(11);
    expect(c.state.pkg!.special.maxNonLineman).toBe(4);
    expect(c.state.pkg!.special.veteran).toBe(true);
    expect(c.state.pkg!.inducements.set).toBe("sevens");
    expect(c.state.pkg!.staffPrices?.reRoll).toBe(100000);
    expect(c.state.pkg!.tiers.length).toBe(4); // the base's Sevens tier list
    expect(c.inheritedFrom(["special", "maxPlayers"])).toBe(NAME);
    // Untouched: a save would send the document as authored.
    expect(c.serialize()).toEqual(CLUB);
    expect(c.dirty()).toBe(false);

    // Override: written into this package, no longer tagged; everything else stays inherited.
    c.setBound(["special", "maxPlayers"], "int", "delete", "9");
    expect(c.inheritedFrom(["special", "maxPlayers"])).toBeNull();
    expect(c.inheritedFrom(["special", "maxNonLineman"])).toBe(NAME);
    c.toggleSpecial("veteran");
    expect(c.serialize()).toEqual({ ...CLUB, special: { maxPlayers: 9, veteran: false } });

    // Save round-trip: the body carries only the overrides; the inherited fields are untouched (absent).
    await c.save();
    expect(posted).toEqual({ ...CLUB, special: { maxPlayers: 9, veteran: false } });
    expect(c.sevens()).toBe(true);
    expect(c.state.pkg!.special.maxNonLineman).toBe(4);
    expect(c.inheritedFrom(["special", "maxNonLineman"])).toBe(NAME);
    expect(c.dirty()).toBe(false);
  });

  it("an inherited cap edit writes the whole caps block; the inducement list stays inherited", async () => {
    const c = createTournamentCreator({ api: mockFetcher(API) });
    await c.init();
    await c.open("Club Sevens");
    await settle();
    c.stepInducement("bribes", -1);
    const out = c.serialize() as { inducements?: Record<string, unknown> };
    expect(Object.keys(out.inducements ?? {})).toEqual(["caps"]);
    expect((out.inducements!.caps as Record<string, number>).bribes).toBe(1);
  });

  it("picking a Sevens base mid-edit refills untouched fields from it and keeps the edits", async () => {
    const c = createTournamentCreator({ api: mockFetcher(API) });
    await c.init();
    await c.open("Plain");
    await settle();
    expect(c.sevens()).toBe(false);
    c.setField("description", "Club night");
    c.setField("extends", NAME);
    await settle();
    expect(c.sevens()).toBe(true);
    expect(c.state.pkg!.special.maxPlayers).toBe(11);
    expect(c.state.pkg!.skillAllotment.skillPointBudget).toBe(4); // the package's own value wins
    expect(c.serialize()).toEqual({ ...PLAIN, description: "Club night", extends: NAME });
    c.setField("extends", "");
    await settle();
    expect(c.sevens()).toBe(false);
    expect(c.state.pkg!.special.maxPlayers).toBeUndefined();
    expect(c.serialize()).toEqual({ ...PLAIN, description: "Club night" });
  });
});

describe("inherited refill edge cases (Sol fa781b7a)", () => {
  /** A base whose GET waits until release() (the base still loading while the organiser edits). */
  function delayed(): { routes: Routes; release: () => void } {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    return { routes: { [`/api/packages/${ENC}`]: async () => { await gate; return { pkg: structuredClone(MATCHED), raw: structuredClone(SHIPPED), revision: "r-7s", problems: [], schemaProblems: [] }; } }, release: () => release() };
  }

  it("#1 a value the organiser set stays saved after a base change, even when it equals the new base's value", async () => {
    const c = createTournamentCreator({ api: mockFetcher(API) });
    await c.init();
    await c.open("Plain");
    await settle();
    c.setBound(["special", "maxPlayers"], "int", "delete", "11"); // the Sevens base's value too
    c.setBound(["staffPrices", "reRoll"], "gold", "delete", "100"); // ditto
    c.setField("extends", NAME);
    await settle();
    expect(c.sevens()).toBe(true);
    const out = c.serialize() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.special).toEqual({ maxPlayers: 11 });
    expect(out.staffPrices).toEqual({ reRoll: 100000 });
    expect(c.inheritedFrom(["special", "maxPlayers"])).toBeNull();
    expect(c.inheritedFrom(["special", "maxNonLineman"])).toBe(NAME);
  });

  it("#2 a value cleared to inherit while the base loads stays absent once it arrives", async () => {
    const d = delayed();
    const own = { ...CLUB, special: { maxPlayers: 9 } };
    const c = createTournamentCreator({ api: mockFetcher({ ...API, ...d.routes, "/api/packages/Club%20Sevens": () => ({ raw: structuredClone(own), revision: "r", problems: [], schemaProblems: [] }) }) });
    await c.init();
    await c.open("Club Sevens");
    c.setOverrideMode(["special", "maxPlayers"], "inherit");
    d.release();
    await settle(); await settle();
    expect(c.sevens()).toBe(true);
    expect(c.state.pkg!.special.maxPlayers).toBe(11); // shown from the base
    expect(c.inheritedFrom(["special", "maxPlayers"])).toBe(NAME);
    expect((c.serialize() as { special?: Record<string, unknown> }).special ?? {}).not.toHaveProperty("maxPlayers");
    expect(c.dirty()).toBe(true);
  });

  it("#3 a base change re-reads the tournament system (skill points -> the base's tiers)", async () => {
    const c = createTournamentCreator({ api: mockFetcher(API) });
    await c.init();
    await c.open("Plain");
    await settle();
    expect(c.state.view.system).toBe("skillpoints");
    c.setField("description", "edit first");
    c.setField("extends", NAME);
    await settle();
    expect(c.state.view.system).toBe("tiers");
    expect(c.serialize()).toEqual({ ...PLAIN, description: "edit first", extends: NAME });
  });

  it("#4 a system picked while the base loads is kept when it arrives", async () => {
    const d = delayed();
    const c = createTournamentCreator({ api: mockFetcher({ ...API, ...d.routes }) });
    await c.init();
    await c.open("Club Sevens");
    c.setSystem("packages");
    d.release();
    await settle(); await settle();
    expect(c.sevens()).toBe(true);
    expect(c.state.view.system).toBe("packages");
    expect(c.state.view.systemTouched).toBe(true);
  });

  it("#5 the review model: pending and failed previews never read OK", () => {
    const pkg = normalizePackage(NUT_CUP);
    const ctx = { teams: [], view: freshView("skillpoints", "pool"), sevens: false };
    expect(packageReview(pkg, { ...ctx, problems: null })!.summary.find((r) => r.key === "valid")).toMatchObject({ value: "Checking…", tone: "muted" });
    expect(packageReview(pkg, { ...ctx, problems: "error" })!.summary.find((r) => r.key === "valid")).toMatchObject({ value: "Unavailable", tone: "off" });
  });
});

describe("Tournament Creator views (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, creator, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/tournaments/creator.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { app, creator, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", organizer: true, authMethod: "discord", discordSsoEnabled: true } };
  async function render(open: string, tab: string, extra: Routes = {}, preview = false): Promise<string> {
    const f = mockFetcher({ ...API, ...ORGANISER, ...extra });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const c = mods.creator.createTournamentCreator({ api: f });
    await c.init();
    await c.open(open);
    await settle();
    if (preview) await c.requestPreview();
    spa.app.provide(mods.creator.TOURNAMENT_CREATOR_KEY, c);
    await spa.router.push(`/tournament-creator?package=${encodeURIComponent(open)}&tab=${tab}`);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }
  const sectionsIn = (html: string): void => {
    for (const id of SECTIONS) expect(html).toContain(`data-section="${id}"`);
    for (const title of ["Overview", "Team building", "Skills &amp; advancement", "Inducements &amp; stars", "Special rules", "Package summary", "Ruleset table preview"]) expect(html).toContain(`>${title}</h2>`);
    expect(html).toContain('class="cr-review"');
    expect(html).toContain("cr-page-wide");
    // the save panel moves into the summary column (one Save button, styled like EXPORT PDF)
    expect(html).toMatch(/class="hm-panel cr-actions cr-actions-summary"/);
    expect(html.match(/>Save package<\/button>/g)?.length).toBe(1);
  };

  const PREVIEW = (problems: string[]) => ({ "POST /api/packages/preview": () => ({ preview: { system: "matrix", tiers: [], exceptions: [] }, overview: null, problems }) });
  it("validation follows the CURRENT server preview: checking until it is in, its problems after (Sol #5)", async () => {
    expect(await render("Nut Cup", "preview")).toMatch(/data-row="valid" data-tone="muted"><dt>Validation<\/dt><dd>Checking…<\/dd>/);
    expect(await render("Nut Cup", "preview", PREVIEW(["tiers[1]: bad cap"]), true)).toMatch(/data-row="valid" data-tone="off"><dt>Validation<\/dt><dd>1 problem<\/dd>/);
    const failed = await render("Nut Cup", "preview", { "POST /api/packages/preview": new ApiError(422, "nope") }, true);
    expect(failed).toMatch(/<dt>Validation<\/dt><dd>Unavailable<\/dd>/);
  });

  it("the summary page renders every section for a standard package", async () => {
    const html = await render("Nut Cup", "preview", PREVIEW([]), true);
    sectionsIn(html);
    expect(html).toContain('data-format="standard"');
    expect(html).toMatch(/data-tile="budget" data-gold="true"><b>1,150k<\/b>/);
    expect(html).toMatch(/data-chip="starsAllowed" data-on="true"/);
    expect(html).toMatch(/data-row="valid" data-tone="ok"><dt>Validation<\/dt><dd>OK<\/dd>/);
  });

  it("the summary page renders every section for a Sevens package", async () => {
    const html = await render(NAME, "preview");
    sectionsIn(html);
    expect(html).toContain('data-format="sevens"');
    expect(html).toMatch(/data-tile="players"><b>7–11<\/b>/);
    expect(html).toMatch(/data-tile="nonLineman"><b>Max 4<\/b>/);
    expect(html).toContain("No Star Players (Sevens)");
    expect(html).toContain("Desperate Measures");
  });

  it("other tabs keep the plain save panel above the pane", async () => {
    const html = await render("Nut Cup", "skills");
    expect(html).toMatch(/class="hm-panel cr-actions"/);
    expect(html).not.toContain("cr-actions-summary");
    expect(html).not.toContain("cr-page-wide");
  });

  it("inherited Sevens: Advanced and Inducements show the Sevens controls with inherited markers", async () => {
    const adv = await render("Club Sevens", "advanced");
    expect(adv).toContain("Max players without the Lineman keyword");
    expect(adv).toContain("Veteran required");
    expect(adv).toContain("Sevens (inherited)");
    expect(adv).toContain(`Sevens rules inherited from ${NAME}`);
    expect(adv).toContain("Staff prices");
    expect(adv).not.toContain("Slann allowed");
    expect(adv).not.toContain("Stars are the 11th player");
    expect(adv).toMatch(/Maximum players<small class="cr-inh"[^>]*data-inherited/);
    expect(adv).toContain('placeholder="11 (inherited)"');
    const ind = await render("Club Sevens", "inducements");
    expect(ind).toContain("Sevens inducements</h2>");
    expect(ind).toContain("Desperate Measures");
    expect(ind).toContain(`Ticks and caps inherited from ${NAME}`);
    const stars = await render("Club Sevens", "stars");
    expect(stars).toContain("Sevens has no Star Players or Mercenaries");
    const sum = await render("Club Sevens", "preview");
    expect(sum).toContain('data-format="sevens"');
    expect(sum).toContain("format inherited");
    expect(sum).toMatch(/data-tile="players"><b>7–11<\/b><span>Players<\/span><small class="cr-inh">inherited<\/small>/);
  });
});
