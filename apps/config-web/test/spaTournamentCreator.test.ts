import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { boundValue, createTournamentCreator, creatorAllowed, isCreatorTab } from "../spa/src/tournaments/creator";
import { freshView, normalizePackage, serializePackage, type RawDoc } from "../spa/src/tournaments/creatorCore";

// SPA Tournament Creator (/app/tournament-creator): the ported core (round-trip law), the controller (edits, save body,
// If-Match, 409), and the view server-rendered against a mocked Fetcher (gate, tabs, ?package= deep link, nav row).

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown>;
interface Call { path: string; method: string; body?: unknown; headers?: Record<string, string> }
function mockFetcher(routes: Routes): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body, headers: init?.headers });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}

const NUT_CUP: RawDoc = {
  name: "Nut Cup",
  ruleset: "bb2025-default",
  goldBudget: 1150000,
  skillAllotment: { skillPointBudget: 6, eliteSkills: ["Block"] },
  tiers: [{ tier: 1, label: "Tier 1", rosters: ["Amazon"], gold: 1100000, skillPointBudget: 5 }],
  starPlayers: { allowed: false },
  futureField: { kept: [1, 2, 3] },
};

const API: Routes = {
  "/api/packages": ["Nut Cup", { name: "Spike Open" }, "Cup v1.2"],
  "/api/packages/Cup%20v1.2": () => ({ raw: { ...structuredClone(NUT_CUP), name: "Cup v1.2" }, revision: "rev-d", problems: [], schemaProblems: [] }),
  "/api/presets": [{ id: "eurobowl", label: "Eurobowl", pkg: { name: "Eurobowl", eligibleRosters: ["*"] } }],
  "/api/skills": { elite: [{ name: "Block", category: "General" }], general: [{ name: "Dodge", category: "Agility" }, { name: "Block", category: "General" }] },
  "/api/stars": [{ name: "Griff Oberwald" }, { name: "Grak", pairedWith: "Crumbleberry", pairPrimary: true }, { name: "Crumbleberry", pairedWith: "Grak" }],
  "/api/teams": [{ name: "Dwarf", defaultTier: 1 }, { name: "Amazon", defaultTier: 1 }, { name: "Goblin", defaultTier: 4 }],
  "/api/packages/Nut%20Cup": () => ({ raw: structuredClone(NUT_CUP), revision: "rev-1", problems: [], schemaProblems: [] }),
  "/crests/manifest.json": { crests: {} },
};

describe("tournament creator core + controller", () => {
  it("round-trip law: an opened package serialises back deep-equal, unknown fields verbatim", () => {
    const filled = new Set<string>();
    const pkg = normalizePackage(NUT_CUP, filled);
    expect(pkg.skillAllotment.maxPerPlayer).toBe(2); // validator default filled for the controls
    expect(filled.has(JSON.stringify(["skillAllotment", "maxPerPlayer"]))).toBe(true);
    const out = serializePackage(pkg, { original: NUT_CUP, baseline: normalizePackage(NUT_CUP), view: freshView("tiers", "pool"), book: { touched: new Set(), injected: filled } });
    expect(out).toEqual(NUT_CUP);
  });

  it("helpers: field conversion, tab ids, the organiser gate", () => {
    expect(boundValue("gold", "delete", "1150")).toBe(1150000);
    expect(boundValue("int", "null", "")).toBeNull();
    expect(boundValue("int", "delete", "2.6")).toBe(3);
    expect(boundValue("tri", "delete", "false")).toBe(false);
    expect(boundValue("str", "empty", "")).toBe("");
    expect(isCreatorTab("skills")).toBe(true);
    expect(isCreatorTab("nope")).toBe(false);
    expect(creatorAllowed({ authenticated: true, organizer: true })).toBe(true);
    expect(creatorAllowed({ authenticated: true, admin: true })).toBe(true);
    expect(creatorAllowed({ authenticated: true })).toBe(false);
    expect(creatorAllowed(null)).toBe(false);
  });

  it("catalogs load; a package opens as authored with its revision", async () => {
    const c = createTournamentCreator({ api: mockFetcher(API) });
    await c.init();
    expect(c.state.packageNames).toEqual(["Cup v1.2", "Nut Cup", "Spike Open"]);
    expect(c.state.skills.map((s) => s.name)).toEqual(["Block", "Dodge"]); // de-duplicated, sorted
    await c.open("Nut Cup");
    expect(c.state.selected).toBe("Nut Cup");
    expect(c.state.revision).toBe("rev-1");
    expect(c.state.view.system).toBe("tiers");
    expect(c.dirty()).toBe(false);
    expect(c.serialize()).toEqual(NUT_CUP);
  });

  it("a field edit + save: the body is the document as edited, If-Match carries the revision", async () => {
    let sent: unknown;
    const f = mockFetcher({ ...API, "POST /api/packages": (b: unknown) => { sent = b; return { ok: true, savedAs: "/data/nut-cup.json", name: "Nut Cup", problems: [], revision: "rev-2" }; } });
    const c = createTournamentCreator({ api: f });
    await c.init();
    await c.open("Nut Cup");
    c.setBound(["skillAllotment", "maxPerPlayer"], "int", "delete", "3"); // a filled default made explicit
    c.setField("description", "Nuts only.");
    c.toggleRace("Goblin"); // all races -> every race but Goblin
    expect(c.dirty()).toBe(true);
    await c.save();
    const call = f.calls.find((x) => x.method === "POST" && x.path === "/api/packages")!;
    expect(call.headers).toEqual({ "If-Match": "rev-1" });
    expect(sent).toEqual({
      ...NUT_CUP,
      description: "Nuts only.",
      eligibleRosters: ["Amazon", "Dwarf"],
      skillAllotment: { skillPointBudget: 6, eliteSkills: ["Block"], maxPerPlayer: 3 },
    });
    expect(c.state.revision).toBe("rev-2");
    expect(c.state.saved).toEqual({ file: "nut-cup.json", count: 0 });
    expect(c.dirty()).toBe(false);
    // Reverting after a later edit goes back to the saved document.
    c.setField("name", "Renamed");
    c.revert();
    expect(c.state.pkg!.name).toBe("Nut Cup");
    expect(c.state.revision).toBe("rev-2");
  });

  it("409: the conflict shows, the edits stay, and the page can reload from the server", async () => {
    const f = mockFetcher({ ...API, "POST /api/packages": new ApiError(409, "This package changed on the server since you opened it.", { revision: "rev-9" }) });
    const c = createTournamentCreator({ api: f });
    await c.init();
    await c.open("Nut Cup");
    c.setField("description", "Mine");
    await c.save();
    expect(c.state.conflict).toBe("This package changed on the server since you opened it.");
    expect(c.state.problems[0]).toBe("This package changed on the server since you opened it.");
    expect(c.state.pkg!.description).toBe("Mine");
    await c.open("Nut Cup");
    expect(c.state.conflict).toBe("");
    expect(c.state.pkg!.description).toBe("");
  });

  it("422 problems list under the error; duplicate opens an unsaved copy with no revision", async () => {
    const f = mockFetcher({ ...API, "POST /api/packages": new ApiError(422, "Invalid package.", { problems: ["Invalid package.", "tiers[0].gold must be a number"] }) });
    const c = createTournamentCreator({ api: f });
    await c.init();
    await c.open("Nut Cup");
    await c.save();
    expect(c.state.problems).toEqual(["Invalid package.", "tiers[0].gold must be a number"]);
    c.duplicate();
    expect(c.state.selected).toBe("");
    expect(c.state.revision).toBeNull();
    expect(c.state.pkg!.name).toBe("Nut Cup copy");
    expect(c.serialize()).toEqual({ ...NUT_CUP, name: "Nut Cup copy" });
  });

  it("schema preflight: unknown fields open read-only; the save is refused client-side", async () => {
    const f = mockFetcher({ ...API, "/api/packages/Nut%20Cup": { raw: NUT_CUP, revision: "rev-1", problems: [], schemaProblems: ["$: unknown property futureField"] } });
    const c = createTournamentCreator({ api: f });
    await c.init();
    await c.open("Nut Cup");
    expect(c.state.readOnly).toContain("futureField");
    await c.save();
    expect(f.calls.some((x) => x.method === "POST")).toBe(false);
  });
});

describe("tournament creator: URL sync, save race, 401", () => {
  it("open saved -> New blank: the editor shows the blank document and ?new=1 keeps it", async () => {
    const { syncCreatorToQuery } = await import("../spa/src/tournaments/creator");
    const c = createTournamentCreator({ api: mockFetcher(API) });
    await c.init();
    expect(await syncCreatorToQuery(c, {})).toBe("Cup v1.2"); // first visit lands on the first saved package
    await syncCreatorToQuery(c, { package: "Nut Cup" });
    expect(c.state.pkg!.name).toBe("Nut Cup");
    c.newBlank();
    await syncCreatorToQuery(c, { new: "1", tab: "skills" });
    expect(c.state.selected).toBe("");
    expect(c.state.pkg!.name).toBe("");
    expect(c.state.pkg!.tiers).toEqual([]);
    c.duplicate(); // a copy of the blank one stays too
    await syncCreatorToQuery(c, { new: "1" });
    expect(c.state.pkg!.name).toBe("Package copy");
    await syncCreatorToQuery(c, { package: "Nut Cup" });
    expect(c.state.pkg!.name).toBe("Nut Cup");
  });

  it("an edit made while a save is in flight survives the save and stays dirty", async () => {
    let release: (v: unknown) => void = () => undefined;
    const f = mockFetcher({ ...API, "POST /api/packages": () => new Promise((r) => { release = r; }) });
    const c = createTournamentCreator({ api: f });
    await c.init();
    await c.open("Nut Cup");
    c.setField("description", "First");
    const saving = c.save();
    await Promise.resolve();
    c.setField("dataNote", "Typed while saving");
    release({ ok: true, savedAs: "nut-cup.json", name: "Nut Cup", problems: [], revision: "rev-2" });
    await saving;
    expect(c.state.revision).toBe("rev-2");
    expect(c.state.pkg!.dataNote).toBe("Typed while saving");
    expect(c.state.pkg!.description).toBe("First");
    expect(c.dirty()).toBe(true);
    expect(c.serialize()).toEqual({ ...NUT_CUP, description: "First", dataNote: "Typed while saving" });
    expect(c.state.original).toEqual({ ...NUT_CUP, description: "First" }); // what the server wrote
  });

  it("401 on save or preview: the sidecar note shows and the editor stays read-only, across packages", async () => {
    const { AUTH_BLOCKED } = await import("../spa/src/tournaments/creator");
    const f = mockFetcher({ ...API, "POST /api/packages": new ApiError(401, "Saving a package requires login (bearer token) or admin auth.") });
    let signedOut = 0;
    const c = createTournamentCreator({ api: f, onSignedOut: () => { signedOut += 1; } });
    await c.init();
    await c.open("Nut Cup");
    c.setField("description", "x");
    await c.save();
    expect(c.state.readOnly).toBe(AUTH_BLOCKED);
    expect(signedOut).toBe(1);
    await c.open("Nut Cup");
    expect(c.state.readOnly).toBe(AUTH_BLOCKED);
    const p = createTournamentCreator({ api: mockFetcher({ ...API, "POST /api/packages/preview": new ApiError(401, "The package preview requires the organiser login.") }) });
    await p.init();
    await p.open("Nut Cup");
    await p.requestPreview();
    expect(p.state.preview.error).toBe(AUTH_BLOCKED);
    expect(p.state.readOnly).toBe(AUTH_BLOCKED);
  });
});

describe("tournament creator view (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown; params: Record<string, unknown>; query: Record<string, unknown> } } };
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    creator: typeof import("../spa/src/tournaments/creator");
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, creator, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/tournaments/creator.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, creator: creator as typeof import("../spa/src/tournaments/creator") };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", organizer: true, authMethod: "discord", discordSsoEnabled: true } };
  const COACH = { "/api/auth/session": { authenticated: true, coach: "Mallory", organizer: false, authMethod: "discord", discordSsoEnabled: true } };

  async function render(path: string, session: Routes, open = "Nut Cup") {
    const f = mockFetcher({ ...API, ...session });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const c = mods.creator.createTournamentCreator({ api: f });
    await c.init();
    if (open) await c.open(open);
    spa.app.provide(mods.creator.TOURNAMENT_CREATOR_KEY, c);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa, c };
  }

  it("gate: signed out gets the sign-in prompt; a coach who is not an organiser gets the friendly note", async () => {
    const anon = await render("/tournament-creator?package=Nut%20Cup", ANON);
    expect(anon.html).toContain("Sign in with Discord to use this page.");
    expect(anon.html).not.toContain("Tournament packages");
    const coach = await render("/tournament-creator?package=Nut%20Cup", COACH);
    expect(coach.html).toContain("Not one of yours");
    expect(coach.html).toContain("only they can create and change ruleset packages");
    expect(coach.html).not.toContain("Save package");
    expect(coach.html).not.toContain(">Tournament Creator</a>"); // no nav row for a coach
  });

  it("organiser: shelf, top row of tabs with Nuffle numerals, centred pane on the Overview tab", async () => {
    const { html, spa } = await render("/tournament-creator?package=Nut%20Cup", ORGANISER);
    expect(spa.router.currentRoute.value.name).toBe("tournament-creator");
    expect(html).toContain("Tournament Creator");
    expect(html).toContain("Tournament packages");
    expect(html).toMatch(/aria-current="page" href="\/app\/tournament-creator\?package=Nut\+Cup" class="[^"]*cr-card">Nut Cup</);
    for (const t of ["Overview", "Tiers", "Team rules", "Skills", "Stars", "Inducements", "Advanced", "Preview"]) expect(html).toContain(`</b>${t}</a>`);
    expect(html).toMatch(/aria-current="page"[^>]*tl-seg-btn"><b class="cr-num">1<\/b>Overview</);
    expect(html).not.toMatch(/aria-current="page"[^>]*tl-seg-btn"><b class="cr-num">2<\/b>/);
    expect(html).toContain("Package details");
    expect(html).toContain('value="Nut Cup"');
    expect(html).toContain("Eligible races");
    expect(html).toContain(">Save package</button>");
    expect(html).toMatch(/href="\/app\/tournament-creator" class="sf-row"[^>]*data-active="true"/); // the nav row, lit on any package
  });

  it("tabs render their section: Tiers, Skills, Stars, Inducements, Advanced", async () => {
    const tiers = (await render("/tournament-creator?package=Nut%20Cup&tab=tiers", ORGANISER)).html;
    expect(tiers).toContain("Tournament system");
    expect(tiers).toContain('aria-label="Tier number"');
    expect(tiers).toContain("Unassigned teams");
    expect(tiers).toMatch(/aria-label="Add Dwarf to the selected tier"/);
    const skills = (await render("/tournament-creator?package=Nut%20Cup&tab=skills", ORGANISER)).html;
    expect(skills).toContain("Skill allotment");
    expect(skills).toContain("Stacked player: max secondary");
    expect(skills).toContain("Banned skills");
    const stars = (await render("/tournament-creator?package=Nut%20Cup&tab=stars", ORGANISER)).html;
    expect(stars).toContain("Grak &amp; Crumbleberry"); // paired stars move together
    expect(stars).toContain("Star packs");
    const ind = (await render("/tournament-creator?package=Nut%20Cup&tab=inducements", ORGANISER)).html;
    expect(ind).toContain("Bretonnian Pastries");
    expect(ind).toContain('aria-label="Raise Bribe cap"');
    const adv = (await render("/tournament-creator?package=Nut%20Cup&tab=advanced", ORGANISER)).html;
    expect(adv).toContain("Sideline staff");
    expect(adv).toContain("Max team rerolls");
    expect(adv).toContain("futureField"); // package JSON shows what a save sends
  });

  it("one route for every document: ?package= (dots survive), ?new=1, tabs; a 409 shows the reload action", async () => {
    const { spa } = await render("/tournament-creator?package=Nut%20Cup&tab=skills", ORGANISER);
    expect(spa.router.currentRoute.value.name).toBe("tournament-creator");
    expect(spa.router.currentRoute.value.query).toEqual({ package: "Nut Cup", tab: "skills" });
    const before = (spa.router.currentRoute.value as unknown as { path: string }).path;
    await spa.router.push("/tournament-creator?new=1");
    // Same path: the shell's RouterView (keyed by path) keeps the view and its controller.
    expect((spa.router.currentRoute.value as unknown as { path: string }).path).toBe(before);
    const dotted = await render("/tournament-creator?package=Cup%20v1.2", ORGANISER, "Cup v1.2");
    expect(dotted.c.state.selected).toBe("Cup v1.2");
    expect(dotted.html).toMatch(/aria-current="page" href="\/app\/tournament-creator\?package=Cup\+v1\.2" class="[^"]*cr-card">Cup v1\.2</);
    expect(dotted.html).toContain('value="Cup v1.2"');

    const f = mockFetcher({ ...API, ...ORGANISER, "POST /api/packages": new ApiError(409, "Changed since you opened it.", { revision: "rev-9" }) });
    const app = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const c = mods.creator.createTournamentCreator({ api: f });
    await c.init();
    await c.open("Nut Cup");
    c.setField("description", "Mine");
    await c.save();
    app.app.provide(mods.creator.TOURNAMENT_CREATOR_KEY, c);
    await app.router.push("/tournament-creator?package=Nut%20Cup");
    await app.router.isReady();
    const html = await mods.renderToString(app.app);
    expect(html).toContain("Changed on the server");
    expect(html).toContain("Reload from the server");
    expect(html).toContain("Unsaved changes");
  });
});
