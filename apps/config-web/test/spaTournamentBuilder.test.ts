import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentBuilder, findingText, isExamplePackage, sanitizePackageRules, sanitizeRoster, toBuilderTab } from "../spa/src/teams/builder";
import { core } from "../spa/src/teams/builderCore";

// Tournament Builder in the SPA (/app/tournament-team-builder, owner 10-30). The controller is tested directly; the view is
// server-rendered through the SPA's own Vite config with a pre-initialised controller (as spaTeamManage.test.ts does).
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown | ((body: unknown) => unknown)>;
type Call = { path: string; method: string; body: unknown };
function mockFetcher(routes: Routes): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = `${method} ${path}` in routes ? `${method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown) => unknown)(init.body) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}

const HUMAN = {
  rosterId: "human", raceName: "Human", reRollCost: 50000, maxReRolls: 8, apothecaryAllowed: true, leagueOptions: ["Old World Classic"],
  specialRules: ["Old World Classic"], alwaysOnRules: ["Team Captain"],
  positions: [
    { positionId: "hlin", name: "Human Lineman", type: "Lineman", cost: 50000, max: 16, MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: [], keywords: ["Human", "Lineman"], playsFor: [] },
    { positionId: "hbli", name: "Human Blitzer", type: "Blitzer", cost: 85000, max: 4, MA: 7, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: ["Block"], keywords: ["Human", "Blitzer"], playsFor: [] },
    { positionId: "hogr", name: "Ogre", type: "BigGuy", cost: 140000, max: 1, MA: 5, ST: 5, AG: "4+", PA: "5+", AV: "10+", skills: ["Loner (4+)", "Bone Head"], keywords: ["Big Guy"], playsFor: [] },
    { positionId: "sgrim", name: "Grim Ironjaw", type: "Star", cost: 200000, max: 1, MA: 5, ST: 4, AG: "3+", PA: "-", AV: "9+", skills: ["Block"], isStar: true, playsFor: ["(any)"] },
  ],
};
const TIER_ROW = { name: "Human", tier: 1, gold: 1150000, maxSecondary: 0, maxStackedPlayers: 1, stackedPlayer: { maxSkills: 2, maxSecondary: 0, maxElite: 0 } };
const RULES = {
  name: "Test Cup", budget: 1150000,
  tierSummary: [{ tier: 1, label: "Tier 1", rosters: ["Human"], gold: 1150000 }],
  overview: {
    summary: [{ key: "budget", label: "Budget", text: "1,150k <b>gold</b>" }],
    groups: [{ tier: 1, label: "Tier 1", teams: [{ name: "Human", gold: 1150000, allotment: ["6 Primary"], secondary: "0" }, { name: "Dwarf", gold: 1100000, allotment: ["6 Primary"], secondary: "0" }] }],
  },
};
const RACE = { roster: "Human", source: "tier", tierNumber: 1, tierLabel: "Tier 1", gold: 1150000, skillPointBudget: 0, packs: [], bannedStars: [], stars: { allowed: true, maxCount: 1 } };
const LEGAL = {
  primary: [{ skill: "Block", category: "General", elite: true }, { skill: "Tackle", category: "General" }, { skill: "Wrestle", category: "General" }],
  secondary: [{ skill: "Guard", category: "Strength", elite: true }],
  alreadyPrinted: [],
};

function routes(over: Routes = {}): Routes {
  return {
    "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
    "/api/fork/rosters": { rosters: [HUMAN] },
    "/api/packages": [{ name: "Test Cup", description: "A test ruleset" }, { name: "Lustrian Superleague (Example)" }],
    "/api/packages/Test%20Cup": { pkg: { description: "Organiser <i>text</i>", eligibleRosters: ["Human", "Dwarf"] }, rules: RULES },
    "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "Organiser <i>text</i>", eligibleRosters: ["Human", "Dwarf"] }, rules: { ...RULES, race: RACE } },
    "/api/fork/team-builder/tiers?packageName=Test%20Cup": { races: [TIER_ROW] },
    "/api/fork/team-builder/inducements?packageName=Test%20Cup": { inducements: [{ key: "bribes", label: "Bribes", price: 100000, max: 3, allowed: true, reducedPrice: 50000, reducedMax: 6, reducedSpecialRule: "Bribery and Corruption" }] },
    "/api/skills": { general: [{ name: "Block", category: "General", elite: true }, { name: "Tackle", category: "General" }, { name: "Wrestle", category: "General" }], strength: [{ name: "Guard", category: "Strength", elite: true }] },
    "/api/fork/team-builder/legal-skills?rosterId=human&positionId=hlin": LEGAL,
    "/api/fork/team-builder/legal-skills?rosterId=human&positionId=hbli": LEGAL,
    "POST /api/fork/team-builder/preview": { valid: true, errors: [], warnings: [], summary: { goldUsed: 600000, goldBudget: 1150000 }, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } },
    ...over,
  };
}

async function ready(f: Fetcher, coach = "Alice") {
  const b = createTournamentBuilder({ api: f, coach: () => coach, previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
  const tab = await b.init({ packageName: "Test Cup", race: "human" });
  return { b, tab };
}

describe("tournament builder controller", () => {
  it("boots: example packages hidden, ?package=&race= deep link lands on the roster with the package's race rules", async () => {
    const f = mockFetcher(routes());
    const { b, tab } = await ready(f);
    expect(tab).toBe("roster");
    expect(b.state.packages.map((p) => p.name)).toEqual(["Test Cup"]);
    expect(isExamplePackage("Lustrian Superleague (Example)")).toBe(true);
    expect(b.state.roster?.raceName).toBe("Human");
    expect(b.raceRules()?.tierLabel).toBe("Tier 1");
    expect(b.tierRules()?.stackedPlayer).toEqual({ maxSkills: 2, maxSecondary: 0, maxElite: 0 });
    expect(b.rulesetLines()).toContain("Secondary skills: max 0");
    expect(f.calls.some((c) => c.path === "/api/packages/Test%20Cup?roster=Human")).toBe(true);
  });

  it("the race table: team cells are pick buttons with the crest; a roster missing from the fork is not available", async () => {
    const f = mockFetcher(routes({ "/crests/manifest.json": { crests: { human: "crests/human.png" } } }));
    const { b } = await ready(f);
    await new Promise((r) => setTimeout(r, 0));
    const t = b.raceTable();
    expect(t.selectable).toBe(true);
    expect(t.html).toContain('data-tt-race="human"');
    expect(t.html).toContain('aria-pressed="true"');
    expect(t.html).toContain('src="/crests/human.png"');
    expect(t.html).toContain('Dwarf <small class="tt-team-na">(not available)</small>');
    expect(await b.chooseRace("dwarf")).toBe(false);
  });

  it("adding players needs a team name; position caps and the 16-player cap hold", async () => {
    const { b } = await ready(mockFetcher(routes()));
    expect(b.addPosition("hlin")).toBe(false);
    b.setTeamName("Reikland Reavers");
    expect(b.addPosition("hogr")).toBe(true);
    expect(b.addPosition("hogr")).toBe(false); // max 1
    for (let i = 0; i < 20; i++) b.addPosition("hlin");
    expect(b.state.slots).toHaveLength(16);
    expect(b.positionCards().find((c) => c.position.positionId === "hlin")?.exhausted).toBe(true);
  });

  it("a build that breaks a tier rule: the shared gate refuses the stacked elite skill and the preview's findings show", async () => {
    const preview = (body: any) => {
      const stacked = body.picks.filter((p: any) => (p.chosenSkills ?? []).length > 1).length;
      const secondary = body.picks.some((p: any) => (p.chosenSkills ?? []).includes("Guard"));
      return { valid: !secondary && stacked <= 1, errors: secondary ? ["Tier 1 allows no secondary skills (Guard on #2)."] : [], warnings: [], summary: { goldUsed: 230000 }, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } };
    };
    const f = mockFetcher(routes({ "POST /api/fork/team-builder/preview": preview }));
    const { b } = await ready(f);
    b.setTeamName("Reavers");
    b.addPosition("hlin");
    b.addPosition("hlin");
    expect(await b.openSkills(0)).toBe("");
    expect(b.addSkill(0, "Tackle")).toBe("");
    // Tier 1 stack types: no elite on a stacked player (Small Gods T1-T4).
    expect(b.addSkill(0, "Block")).toMatch(/^Elite skills can't be stacked in this tier/);
    expect(b.addSkill(0, "Wrestle")).toBe("");
    expect(b.addSkill(0, "Tackle")).toBe("Already added.");
    // Stack cap per player (2) reached: no third skill.
    expect(core.moreSkillsAllowed(b.gateCtx(), b.state.slots[0]!)).toBe(false);
    // Only one stacked player in the tier: the second player keeps one skill at most.
    await b.openSkills(1);
    expect(b.addSkill(1, "Tackle")).toBe("");
    expect(b.addSkill(1, "Wrestle")).toBe("This player can't take another skill.");
    expect(b.addSkill(1, "Guard")).toBe("This player can't take another skill.");
    b.removeSkill(1, "Tackle");
    expect(b.addSkill(1, "Guard")).toBe(""); // a single secondary is up to the server's maxSecondary rule
    await b.flushPreview();
    const v = b.validity();
    expect(v.tone).toBe("invalid");
    expect(v.headline).toBe("Team is invalid: 1 issue to fix");
    expect(v.errors).toEqual(["Tier 1 allows no secondary skills (Guard on #2)."]);
    const body = f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/preview")).at(-1)!.body as any;
    expect(body.picks).toEqual([{ positionId: "hlin", count: 1, chosenSkills: ["Tackle", "Wrestle"] }, { positionId: "hlin", count: 1, chosenSkills: ["Guard"] }]);
    expect(b.canExport()).toBe(false);
    expect(b.canBuild()).toBe(false);
  });

  it("stars never take skills; the star cap counts picks; inducements price at the team's terms", async () => {
    const { b } = await ready(mockFetcher(routes()));
    b.setTeamName("Reavers");
    expect(b.starChoices().map((c) => c.label)).toEqual(["Grim Ironjaw"]);
    expect(b.addStar(b.starChoices()[0]!.key)).toBe(true);
    expect(b.starRow(b.starChoices()[0]!).canAdd).toBe(false);
    expect(await b.openSkills(0)).toBe("Stars never take added skills.");
    expect(b.addSkill(0, "Tackle")).toBe("This player can't take added skills.");
    const bribes = b.inducementRows()[0]!;
    expect(bribes.terms).toEqual({ price: 100000, max: 3, reduced: false });
    for (let i = 0; i < 5; i++) b.stepInducement("bribes", 1);
    expect(b.state.inducementCounts.bribes).toBe(3);
  });

  it("Team Captain: one per team, never a Big Guy or a star; the captain's chosen Pro is dropped", async () => {
    const { b } = await ready(mockFetcher(routes()));
    b.setTeamName("Reavers");
    b.addPosition("hogr");
    b.addPosition("hbli");
    expect(b.slotCanCaptain(b.state.slots[0])).toBe(false);
    b.toggleCaptain(1);
    expect(b.state.slots[1]!.captain).toBe(true);
    expect(b.requestBody().picks.find((p) => p.captain)).toEqual({ positionId: "hbli", count: 1, captain: true });
    expect(b.valueLines().find((l) => l.label === "Team Captain")?.value).toBe("#2 Blitzer");
  });

  it("Save Team posts the builder body named after the team, then PUTs the open save", async () => {
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "PUT /api/fork/team-builder/saves/sv_abc": { save: { id: "sv_abc", name: "Reavers" } },
    }));
    const { b } = await ready(f);
    b.setTeamName("Reavers");
    b.addPosition("hbli");
    b.stepStaff("reRolls", 2);
    b.stepStaff("apothecary", 1);
    b.stepInducement("bribes", 1);
    expect(await b.saveTeam()).toBe(true);
    const post = f.calls.find((c) => c.method === "POST" && c.path === "/api/fork/team-builder/saves")!;
    expect(post.body).toEqual({
      name: "Reavers",
      body: {
        rosterId: "human", coach: "Alice", teamName: "Reavers", picks: [{ positionId: "hbli", count: 1 }], reRolls: 2, apothecary: true,
        assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, packageName: "Test Cup", rosteredInducements: [{ key: "bribes", count: 1 }],
      },
    });
    expect(b.state.currentSave).toEqual({ id: "sv_abc", name: "Reavers" });
    expect(b.state.savesStatus).toBe("Saved “Reavers”. It is in My teams.");
    b.addPosition("hlin");
    expect(await b.saveTeam()).toBe(true);
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect((put.body as any).body.picks).toEqual([{ positionId: "hbli", count: 1 }, { positionId: "hlin", count: 1 }]);
  });

  it("saving / sharing need the session; signed out the preview still runs as a guest", async () => {
    const f = mockFetcher(routes());
    const { b } = await ready(f, "");
    b.setTeamName("Reavers");
    b.addPosition("hlin");
    await b.flushPreview();
    expect((f.calls.find((c) => c.path.endsWith("/preview"))!.body as any).coach).toBe("Guest");
    expect(await b.saveTeam()).toBe(false);
    expect(b.canSave()).toBe(false);
    expect(b.validity().notices).toContain("You must sign in with Discord to save or create the team.");
  });

  it("Share link: POST share -> /t/<token>, copied; Unshare: DELETE share", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/saves/sv_abc/share": { shareToken: token, path: `/t/${token}` },
      "DELETE /api/fork/team-builder/saves/sv_abc/share": {},
    }));
    const { b } = await ready(f);
    expect(await b.share()).toBe(false); // nothing saved yet
    b.setTeamName("Reavers");
    await b.saveTeam();
    expect(await b.share()).toBe(true);
    expect(b.state.shareUrl).toBe(`https://sf.example/t/${token}`);
    expect(b.state.savesStatus).toBe("Link copied: anyone with it can view “Reavers”.");
    expect(await b.unshare()).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/fork/team-builder/saves/sv_abc/share" });
    expect(b.state.shareUrl).toBe("");
  });

  it("loads a saved team (restoring skills and inducements) and refuses non-tournament saves", async () => {
    const save = {
      id: "sv_abc", name: "Reavers", shareToken: "0123456789abcdef0123456789abcdef",
      body: { rosterId: "human", teamName: "Reavers", packageName: "Test Cup", picks: [{ positionId: "hlin", count: 2, chosenSkills: ["Tackle"] }, { positionId: "sgrim", count: 1, chosenSkills: ["Dodge"] }], reRolls: 3, apothecary: true, dedicatedFans: 2, rosteredInducements: [{ key: "bribes", count: 2 }] },
    };
    const f = mockFetcher(routes({ "/api/fork/team-builder/saves/sv_abc": { save }, "/api/fork/team-builder/saves/sv_plain": { save: { id: "sv_plain", name: "Plain", body: { rosterId: "human" } } } }));
    const b = createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example" });
    expect(await b.init({ saveId: "sv_abc" })).toBe("roster");
    expect(b.state.slots.map((s) => [s.positionId, s.chosenSkills])).toEqual([["hlin", ["Tackle"]], ["hlin", ["Tackle"]], ["sgrim", []]]);
    expect(b.state.staff).toMatchObject({ reRolls: 3, apothecary: 1, dedicatedFans: 2 });
    expect(b.state.inducementCounts).toEqual({ bribes: 2 });
    expect(b.state.shareUrl).toBe("https://sf.example/t/0123456789abcdef0123456789abcdef");
    expect(await b.loadSave("sv_plain")).toBe(false);
    expect(b.state.savesStatus).toBe("“Plain” isn't a tournament team; open it in the Team Builder.");
  });

  it("Create team on Fork sends the open save id; a refusal lists the validator's errors", async () => {
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/build": new ApiError(422, "Team is not valid.", { errors: [{ message: "Too many players", suggestion: "Fire one" }] }),
    }));
    const { b } = await ready(f);
    b.setTeamName("Reavers");
    b.addPosition("hlin");
    await b.flushPreview();
    await b.saveTeam();
    expect(b.canBuild()).toBe(true);
    expect(await b.build()).toBe(false);
    expect((f.calls.find((c) => c.path.endsWith("/build"))!.body as any).saveId).toBe("sv_abc");
    expect(b.state.buildResult).toEqual({ ok: false, title: "Build failed", lines: ["Team is not valid.", "Too many players — Fire one"] });
  });

  it("Export PDF builds in the browser; a failure falls back to the print dialog", async () => {
    const saved: string[] = [];
    let printed = 0;
    const pdf = {
      loadPdfMake: async () => ({ createPdf: () => ({ getBlob: async () => new Blob(["%PDF"]) }) }),
      buildSheetDocDefinition: (model: any) => ({ model }),
      sheetPdfFileName: (n: string) => n.replace(/\.html$/, ".pdf"),
    };
    const f = mockFetcher(routes());
    const b = createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, loadSheetPdf: async () => pdf, saveBlob: (_b, name) => saved.push(name), print: () => { printed++; } });
    await b.init({ packageName: "Test Cup", race: "human" });
    b.setTeamName("Reavers");
    b.addPosition("hlin");
    expect(await b.exportPdf()).toBe("skipped"); // not previewed valid yet
    await b.flushPreview();
    expect(await b.exportPdf()).toBe("pdf");
    expect(saved).toEqual(["Reavers_roster.pdf"]);
    const broken = createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, loadSheetPdf: async () => { throw new Error("offline"); }, print: () => { printed++; } });
    await broken.init({ packageName: "Test Cup", race: "human" });
    broken.setTeamName("Reavers");
    broken.addPosition("hlin");
    await broken.flushPreview();
    expect(await broken.exportPdf()).toBe("print");
    expect(printed).toBe(1);
    expect(broken.state.printHtml).toContain('<article class="roster-sheet">');
    expect(broken.state.printHtml.startsWith(`<style>${core.SHEET_CSS}</style>`)).toBe(true); // table rules, print colours, A4 landscape
    expect(broken.state.buildResult?.lines).toEqual(["PDF service unavailable, opened the print dialog instead."]);
  });

  it("any edit makes the verdict pending: export / build wait for the preview of the current document", async () => {
    const f = mockFetcher(routes());
    const b = createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 60_000, loadSheetPdf: async () => { throw new Error("unused"); } });
    await b.init({ packageName: "Test Cup", race: "human" });
    b.setTeamName("Reavers");
    b.addPosition("hlin");
    await b.flushPreview();
    expect(b.validity().headline).toBe("Team is valid");
    expect(b.canExport()).toBe(true);
    expect(b.canBuild()).toBe(true);
    // An ordinary edit: the old "valid" no longer describes the team.
    b.stepStaff("reRolls", 1);
    expect(b.validity()).toMatchObject({ tone: "checking", headline: "Checking team..." });
    expect(b.canExport()).toBe(false);
    expect(b.canBuild()).toBe(false);
    await b.flushPreview();
    expect(b.canExport()).toBe(true);
    // Clearing the name: no preview runs, and the last valid verdict must not export an unnamed team.
    b.setTeamName("");
    expect(b.state.previewPending).toBe(false);
    expect(b.validity().tone).toBe("pending");
    expect(b.canExport()).toBe(false);
    expect(b.canBuild()).toBe(false);
    expect(await b.exportPdf()).toBe("skipped");
    // Back to the same document: the verdict for it counts again.
    b.setTeamName("Reavers");
    await b.flushPreview();
    expect(b.canExport()).toBe(true);
  });

  it("a 401 on save keeps the open save and the edits (the page stays at its address)", async () => {
    let signedOut = 0;
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "PUT /api/fork/team-builder/saves/sv_abc": new ApiError(401, "Sign in."),
    }));
    const b = createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, onSignedOut: () => { signedOut++; } });
    await b.init({ packageName: "Test Cup", race: "human" });
    b.setTeamName("Reavers");
    await b.saveTeam();
    b.addPosition("hbli");
    expect(await b.saveTeam()).toBe(false);
    expect(signedOut).toBe(1);
    expect(b.state.currentSave).toEqual({ id: "sv_abc", name: "Reavers" });
    expect(b.state.slots.map((s) => s.positionId)).toEqual(["hbli"]);
    expect(b.state.savesStatus).toBe("Your session expired. Sign in again to use saved teams.");
  });

  it("ingestion copies fields only; findings read as text", () => {
    const r = sanitizeRoster({ ...HUMAN, positions: [{ positionId: "x", name: "<img>", cost: "<b>", extra: 1 }], evil: "x" });
    expect(r.positions[0]).toMatchObject({ positionId: "x", name: "<img>", cost: 0 });
    expect(r).not.toHaveProperty("evil");
    expect(sanitizePackageRules({ name: "x" })).toBeNull();
    expect(findingText({ message: "A", suggestion: "B" })).toBe("A — B");
  });
});

describe("tournament builder page (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, builderMod] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/teams/builder.ts")]);
    mods = { app, vueRouter, renderer, builderMod };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, f: Fetcher, prepare?: (b: any) => Promise<void> | void, coach = "Alice"): Promise<string> {
    const builder = mods.builderMod.createTournamentBuilder({ api: f, coach: () => coach, previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
    await builder.init({ packageName: "Test Cup", race: "human" });
    await prepare?.(builder);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.builderMod.TOURNAMENT_BUILDER_KEY, builder);
    await spa.session.load();
    await spa.router.push(path);
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    if (process.env.DUMP_SSR) console.log(html.slice(html.indexOf("tb-page"), html.indexOf("tb-page") + 6000));
    return html;
  }

  it("the route replaces the LinkOut: band tabs (Ruleset · Roster · Skills, Stars & Inducements · Sheet), the locked line and the value bar", async () => {
    const html = await render("/tournament-team-builder", mockFetcher(routes()));
    expect(html).not.toContain("tournament-team-builder.html\" class=\"lobby-btn");
    expect(html).toContain('<h1 class="hm-title">Tournament Builder');
    const tabs = [...html.matchAll(/role="tab" class="tl-seg-btn" data-tab="(\w+)" aria-selected="(\w+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2], m[3]]);
    expect(tabs).toEqual([["ruleset", "false", "Ruleset"], ["roster", "true", "Roster"], ["skills", "false", "Skills, Stars &amp; Inducements"], ["sheet", "false", "Sheet"]]);
    expect(html).toContain("Test Cup · Human · Tier 1 · TV cap 1,150k");
    expect(html).toContain('class="tv-totals tb-value"');
    expect(html).toContain("Add players");
    expect(html).toContain('aria-label="Add Human Blitzer"');
    expect(html).toMatch(/<strong>Blitzer<\/strong>/); // short position name (src/positionNames.ts)
  });

  it("the Ruleset tab: cards, escaped generated highlights, organiser notes and the race table", async () => {
    const html = await render("/tournament-team-builder?tab=ruleset", mockFetcher(routes()));
    expect(html).toMatch(/role="listitem" class="tb-card" aria-pressed="true"><strong>Test Cup<\/strong>/);
    expect(html).not.toContain("Lustrian Superleague (Example)");
    expect(html).toContain("1,150k &lt;b&gt;gold&lt;/b&gt;");
    expect(html).toContain("Organiser &lt;i&gt;text&lt;/i&gt;");
    expect(html).toContain('data-tt-race="human"');
    expect(html).toContain("Build the Human team");
  });

  it("the Sheet tab shows a tier violation from the preview, the action row and the shared team sheet", async () => {
    const f = mockFetcher(routes({ "POST /api/fork/team-builder/preview": { valid: false, errors: ["Tier 1 allows no secondary skills (Guard on #1)."], warnings: ["Unspent gold"], summary: { goldUsed: 90000 }, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } } }));
    const html = await render("/tournament-team-builder?tab=sheet", f, async (b) => {
      b.setTeamName("Reavers <x>");
      b.addPosition("hlin");
      await b.openSkills(0);
      b.addSkill(0, "Guard");
      await b.flushPreview();
    });
    expect(html).toContain('<h2 id="tb-valid-h">Team is invalid: 1 issue to fix</h2>');
    expect(html).toContain('data-kind="error">Tier 1 allows no secondary skills (Guard on #1).</li>');
    expect(html).toContain('data-kind="warning">Unspent gold</li>');
    expect(html).toMatch(/<button type="button" class="tb-btn primary" disabled>Export PDF<\/button>/);
    expect(html).toMatch(/<button type="button" class="tb-btn">Save Team<\/button>/);
    expect(html).toMatch(/<button type="button" class="tb-btn" disabled>Create team on Fork<\/button>/);
    expect(html).toContain('<h2 class="tv-name">Reavers &lt;x&gt;</h2>');
    expect(html).toContain("tv-secondary"); // Guard printed as an added Secondary skill
  });

  it("the Sheet tab with a shared save: the link field, Copy and Unshare", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/saves/sv_abc/share": { shareToken: token },
    }));
    const html = await render("/tournament-team-builder/sv_abc?tab=sheet", f, async (b) => { b.setTeamName("Reavers"); await b.saveTeam(); await b.share(); });
    expect(html).toContain(`value="https://sf.example/t/${token}"`);
    expect(html).toMatch(/>Unshare<\/button>/);
    expect(html).not.toMatch(/>Share link<\/button>/);
    expect(html).toContain('<span class="hm-led">Reavers</span>');
  });

  it("signed out: building stays open, saving asks for Discord", async () => {
    const f = mockFetcher(routes({ "/api/auth/session": { authenticated: false, discordSsoEnabled: true } }));
    const html = await render("/tournament-team-builder?tab=sheet", f, (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); }, "");
    expect(html).toContain("Sign in to save or create on Fork");
    expect(html).toContain("/api/auth/discord/start?next=");
    expect(html).not.toMatch(/>Save Team<\/button>/);
    expect(html).toContain("You must sign in with Discord to save or create the team.");
  });

  it("the Skills tab: tier rule lines, per-player Add Skill / Add Stat, stars without skill buttons", async () => {
    const html = await render("/tournament-team-builder?tab=skills", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hbli"); b.addStar(b.starChoices()[0].key); });
    expect(html).toContain("Secondary skills: max 0");
    expect(html).toContain("Stacked players: max 1");
    expect(html.match(/>Add Skill<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Star player: no added skills");
  });

  it("the merged pane: Skills, then Stars, then Inducements; the old Staff & Inducements deep link lands on it", async () => {
    for (const q of ["skills", "staff"]) {
      const html = await render(`/tournament-team-builder?tab=${q}`, mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hbli"); });
      expect(html).toContain('id="tb-pane-skills"');
      const at = ["tb-skills-h", "tb-stars-h", "tb-ind-h"].map((id) => html.indexOf(`id="${id}"`));
      expect(at.every((n) => n > 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(html).not.toContain('id="tb-staff-h"');
    }
    expect(toBuilderTab("staff")).toBe("skills");
    expect(toBuilderTab("nope")).toBeNull();
  });

  it("Staff sits in the Roster tab below the roster table", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); });
    expect(html.indexOf('id="tb-roster-h"')).toBeLessThan(html.indexOf('id="tb-staff-h"'));
    expect(html).toContain(">Staff</h2>");
    expect(html).not.toContain('id="tb-stars-h"');
  });
});

describe("tournament builder wiring", () => {
  it("picking a race on the Ruleset tab opens the Roster tab at the top; a ruleset card stays on Ruleset", () => {
    const view = readFileSync(new URL("../spa/src/views/TournamentBuilderView.vue", import.meta.url), "utf8");
    expect(view).toContain('if (await builder.chooseRace(rosterId)) { tab.value = "roster"; scrollToTop(); }');
    expect(view).toContain("window.scrollTo?.({ top: 0 })");
    const pkg = view.slice(view.indexOf("async function pickPackage"), view.indexOf("</script>", view.indexOf("async function pickPackage")));
    expect(pkg).not.toContain('tab.value = "roster"');
    const ruleset = readFileSync(new URL("../spa/src/components/TournamentBuilderRuleset.vue", import.meta.url), "utf8");
    expect(ruleset).toContain('emit("race", id)'); // the table's data-tt-race buttons: Enter / Space fire click natively
  });

  it("the print rule only applies while the builder prints (html.tb-printing); other routes print normally", () => {
    const css = readFileSync(new URL("../spa/src/teams/builder.css", import.meta.url), "utf8");
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toContain("html.tb-printing body * { visibility: hidden; }");
    expect(print).not.toMatch(/^\s*body \* \{/m);
    const view = readFileSync(new URL("../spa/src/views/TournamentBuilderView.vue", import.meta.url), "utf8");
    expect(view).toContain('root.classList.add("tb-printing")');
    expect(view).toContain('root.classList.remove("tb-printing")');
  });

  const router = readFileSync(new URL("../spa/src/router.ts", import.meta.url), "utf8");
  it("routes /tournament-team-builder and /:saveId to the view; the vanilla page still serves", () => {
    expect(router.replace(/\r\n/g, "\n")).toContain('path: "/tournament-team-builder/:saveId([\\\\w-]{1,64})?",\n    name: "tournament-team-builder",\n    component: TournamentBuilderView,');
    expect(router).not.toMatch(/href: "\/tournament-team-builder\.html"/);
    expect(readFileSync(new URL("../public/tournament-team-builder.html", import.meta.url), "utf8")).toContain('<body data-builder="tournament">');
  });
});
