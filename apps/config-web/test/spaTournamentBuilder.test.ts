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

  it("skill points: used / budget and each player's SP for added skills, only where the ruleset has an SP budget", async () => {
    const { b } = await ready(mockFetcher(routes()));
    expect(b.skillPoints()).toBeNull(); // Test Cup prices skills in gold
    const f = mockFetcher(routes({ "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: { ...RACE, skillPointBudget: 2 } } } }));
    const sp = (await ready(f)).b;
    sp.setTeamName("Reavers");
    sp.addPosition("hlin");
    sp.addPosition("hlin");
    await sp.openSkills(0);
    sp.addSkill(0, "Tackle");
    await sp.openSkills(1);
    sp.addSkill(1, "Guard");
    expect(sp.skillPoints()).toEqual({ used: 3.5, budget: 2, over: true, players: [{ index: 0, name: "Lineman", sp: 1 }, { index: 1, name: "Lineman", sp: 2.5 }] });
    expect(sp.valueLines().find((l) => l.label === "Skill points")).toEqual({ label: "Skill points", value: "3.5 / 2", tone: "over" });
  });

  it("per-player SP sums to the total: no stacking surcharge with a choose-one skill pack, the surcharge without one", async () => {
    const costs = { primary: 1, secondary: 2, eliteSurcharge: 0, stackSurcharge: 1, eliteSkills: [] };
    const build = async (race: object, summary: object = { goldUsed: 600000 }) => {
      const f = mockFetcher(routes({
        "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: { ...RACE, ...race } } },
        "POST /api/fork/team-builder/preview": { valid: true, errors: [], warnings: [], summary, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } },
      }));
      const { b } = await ready(f);
      b.setTeamName("Reavers");
      b.addPosition("hlin");
      await b.openSkills(0);
      expect(b.addSkill(0, "Tackle")).toBe("");
      expect(b.addSkill(0, "Wrestle")).toBe(""); // two 1-SP primaries stacked on one player
      return b;
    };
    const sum = (sp: { players: Array<{ sp: number }> }) => sp.players.reduce((n, p) => n + p.sp, 0);
    // Choose-one pack: the server charges no stacking surcharge (bb-validator validate.ts); per-player must agree.
    const pack = await build({ skillCosts: costs, packs: [{ label: "Pack A", gold: 1150000, skillPointBudget: 4 }] });
    pack.setSkillPack("Pack A");
    expect(pack.skillPoints()).toMatchObject({ used: 2, budget: 4, players: [{ index: 0, sp: 2 }] });
    expect(sum(pack.skillPoints()!)).toBe(pack.skillPoints()!.used);
    await pack.flushPreview();
    // ...and the same once the server's authoritative count is in.
    const served = await build({ skillCosts: costs, packs: [{ label: "Pack A", gold: 1150000, skillPointBudget: 4 }] }, { goldUsed: 600000, skillPointsUsed: 2, skillPointBudget: 4 });
    served.setSkillPack("Pack A");
    await served.flushPreview();
    expect(served.skillPoints()!.used).toBe(2);
    expect(sum(served.skillPoints()!)).toBe(2);
    // No pack: the NAF-style surcharge applies to the stacked player (1 + 1 + 1).
    const plain = await build({ skillCosts: costs, skillPointBudget: 6 });
    expect(plain.skillPoints()).toMatchObject({ used: 3, budget: 6, players: [{ index: 0, sp: 3 }] });
    expect(sum(plain.skillPoints()!)).toBe(plain.skillPoints()!.used);
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
  /** The part of the page from one heading id to the next listed one (or the end). */
  const between = (html: string, from: string, to?: string): string => html.slice(html.indexOf(`id="${from}"`), to ? html.indexOf(`id="${to}"`) : undefined);

  it("the route replaces the LinkOut: band tabs (Ruleset · Roster · Sheet), the locked line and the value cards in the validator", async () => {
    const html = await render("/tournament-team-builder", mockFetcher(routes()));
    expect(html).not.toContain("tournament-team-builder.html\" class=\"lobby-btn");
    expect(html).toContain('<h1 class="hm-title">Tournament Builder');
    const tabs = [...html.matchAll(/role="tab" class="tl-seg-btn" data-tab="(\w+)" aria-selected="(\w+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2], m[3]]);
    expect(tabs).toEqual([["ruleset", "false", "Ruleset"], ["roster", "true", "Roster"], ["sheet", "false", "Sheet"]]);
    expect(html).toContain("Test Cup · Human · Tier 1 · TV cap 1,150k");
    expect(between(html, "tb-validator-h", "tb-valid-h")).toContain('class="tv-totals tb-value"');
    expect(html).toContain(">Hireable players</h2>");
    expect(html).not.toContain(">Add players</h2>");
    expect(html).toContain('aria-label="Add Human Blitzer"');
    expect(html).toMatch(/<strong>Blitzer<\/strong>/); // short position name (src/positionNames.ts)
  });

  it("the Roster pane: left = hireable players, inducements, star players, staff; centre = roster; right = team, validator, errors (phone order = source order)", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); });
    expect(html).toContain('id="tb-pane-roster"');
    const cols = ["tb-col-left", "tb-col-centre", "tb-col-right"].map((c) => html.indexOf(`class="tb-col ${c}"`));
    expect(cols.every((n) => n > 0)).toBe(true);
    expect(cols).toEqual([...cols].sort((a, b) => a - b));
    const order = ["tb-add-h", "tb-ind-h", "tb-stars-h", "tb-staff-h", "tb-roster-h", "tb-team-h", "tb-validator-h", "tb-valid-h"].map((id) => html.indexOf(`id="${id}"`));
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.indexOf('id="tb-staff-h"')).toBeLessThan(cols[1]!); // Staff: the left column, under Star Players
    expect(html.indexOf('id="tb-roster-h"')).toBeGreaterThan(cols[1]!);
    expect(html.indexOf('id="tb-team-h"')).toBeGreaterThan(cols[2]!);
    // The roster table is the top of the centre column; the skill key sits under it.
    expect(between(html, "tb-roster-h", "tb-team-h")).toContain('aria-label="Skill key"');
    expect(html).toContain('id="tb-team-name"');
  });

  it("old tab ids (skills, staff, stars, inducements) land on the Roster pane", async () => {
    for (const q of ["skills", "staff", "stars", "inducements"]) {
      const html = await render(`/tournament-team-builder?tab=${q}`, mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hbli"); });
      expect(html).toContain('id="tb-pane-roster"');
      expect(html).toMatch(/data-tab="roster" aria-selected="true"/);
      expect(toBuilderTab(q)).toBe("roster");
    }
    expect(toBuilderTab("sheet")).toBe("sheet");
    expect(toBuilderTab("nope")).toBeNull();
  });

  it("the roster rows carry Add Skill / Add Stat as on the team page; stars get neither; the validator lists the tier rules", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hbli"); b.addStar(b.starChoices()[0].key); });
    const roster = between(html, "tb-roster-h", "tb-team-h");
    expect(roster.match(/>Add Skill<\/button>/g)).toHaveLength(1);
    expect(roster).toContain('class="tm-act" data-kind="skill"');
    expect(roster).toContain("Star player: no added skills");
    expect(roster).toContain("Primary skills <b>0</b>");
    const validator = between(html, "tb-validator-h", "tb-valid-h");
    expect(validator).toContain("Budget 1,150k");
    expect(validator).toContain("Stars (max 1)");
    expect(validator).toContain("Secondary skills: max 0");
    expect(validator).toContain("Stacked players: max 1");
    expect(validator).toContain("Test Cup · Tier 1");
  });

  it("the validator shows the SP display (used / budget, each player's SP) where the ruleset has an SP budget", async () => {
    const sp = { ...RACE, skillPointBudget: 6 };
    const f = mockFetcher(routes({ "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: sp } } }));
    const html = await render("/tournament-team-builder?tab=roster", f, async (b) => {
      b.setTeamName("Reavers");
      b.addPosition("hbli");
      b.addPosition("hlin");
      await b.openSkills(0);
      b.addSkill(0, "Tackle");
      await b.openSkills(1);
      b.addSkill(1, "Guard");
    });
    const validator = between(html, "tb-validator-h", "tb-valid-h");
    expect(validator).toContain('class="tb-sp-total">3.5 <small>/ 6 SP</small>');
    expect(validator).toContain("<span>#1 Blitzer</span><b>1 SP</b>");
    expect(validator).toContain("<span>#2 Lineman</span><b>2.5 SP</b>");
    expect(validator).toContain("6 SP"); // the race's rule line: Budget 1,150k · 6 SP
  });

  it("the Errors / Valid box shows a tier violation from the preview; the Team controls carry the actions; the Sheet tab is the sheet only", async () => {
    const f = mockFetcher(routes({ "POST /api/fork/team-builder/preview": { valid: false, errors: ["Tier 1 allows no secondary skills (Guard on #1)."], warnings: ["Unspent gold"], summary: { goldUsed: 90000 }, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } } }));
    const prepare = async (b: any) => {
      b.setTeamName("Reavers <x>");
      b.addPosition("hlin");
      await b.openSkills(0);
      b.addSkill(0, "Guard");
      await b.flushPreview();
    };
    const html = await render("/tournament-team-builder?tab=roster", f, prepare);
    expect(html).toContain('<h2 id="tb-valid-h">Team is invalid: 1 issue to fix</h2>');
    expect(html).toContain('data-kind="error">Tier 1 allows no secondary skills (Guard on #1).</li>');
    expect(html).toContain('data-kind="warning">Unspent gold</li>');
    const team = between(html, "tb-team-h", "tb-validator-h");
    expect(team).toMatch(/<button type="button" class="tb-btn primary" disabled>Export PDF<\/button>/);
    expect(team).toMatch(/<button type="button" class="tb-btn">Save Team<\/button>/);
    expect(team).toMatch(/<button type="button" class="tb-btn" disabled>Create team on Fork<\/button>/);
    const sheet = await render("/tournament-team-builder?tab=sheet", f, prepare);
    expect(sheet).toContain('<h2 class="tv-name">Reavers &lt;x&gt;</h2>');
    expect(sheet).toContain("tv-secondary"); // Guard printed as an added Secondary skill
    expect(sheet).not.toContain('id="tb-valid-h"');
    expect(sheet).not.toMatch(/>Export PDF<\/button>/);
  });

  it("the Team controls with a shared save: the link field, Copy and Unshare", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/saves/sv_abc/share": { shareToken: token },
    }));
    const html = await render("/tournament-team-builder/sv_abc?tab=roster", f, async (b) => { b.setTeamName("Reavers"); await b.saveTeam(); await b.share(); });
    const team = between(html, "tb-team-h", "tb-validator-h");
    expect(team).toContain(`value="https://sf.example/t/${token}"`);
    expect(team).toMatch(/>Unshare<\/button>/);
    expect(team).not.toMatch(/>Share link<\/button>/);
    expect(team).toContain("Editing Reavers");
    expect(html).toContain('<span class="hm-led">Reavers</span>');
  });

  it("signed out: building stays open, saving asks for Discord", async () => {
    const f = mockFetcher(routes({ "/api/auth/session": { authenticated: false, discordSsoEnabled: true } }));
    const html = await render("/tournament-team-builder?tab=roster", f, (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); }, "");
    expect(html).toContain("Sign in to save or create on Fork");
    expect(html).toContain("/api/auth/discord/start?next=");
    expect(html).not.toMatch(/>Save Team<\/button>/);
    expect(between(html, "tb-valid-h")).toContain("You must sign in with Discord to save or create the team.");
  });
});

// ── client behaviour: the real view, compiled for the client, mounted on a small in-memory DOM ───────────────────────
// No jsdom in this repo: the SPA's Vite config is reused with its Vue plugin forced to compile for the client (render
// functions, not ssrRender), the modules run in Node, and the view mounts through Vue's createRenderer onto FakeEl nodes.
// Events are dispatched to the handlers Vue bound (bubbling to the parents), so the test drives the view's own code.
class FakeEl {
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  attrs: Record<string, any> = {};
  on: Record<string, (e: unknown) => unknown> = {};
  text = "";
  scrolled: unknown[] = [];
  constructor(public tag: string) {}
  focus(): void { fakeDocument.activeElement = this; }
  scrollTo(o: unknown): void { this.scrolled.push(o); }
  addEventListener(): void { /* v-model directives only */ }
  removeEventListener(): void { /* v-model directives only */ }
}
const fakeDocument: { activeElement: FakeEl | null; root: FakeEl | null; main: FakeEl } = { activeElement: null, root: null, main: new FakeEl("main") };
const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const textOf = (el: FakeEl): string => (el.tag === "#text" ? el.text : el.children.map(textOf).join(""));
const nodeOps = {
  insert(child: FakeEl, parent: FakeEl, anchor?: FakeEl | null) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    if (at >= 0) parent.children.splice(at, 0, child); else parent.children.push(child);
  },
  remove(child: FakeEl) { if (child.parent) { child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; } },
  createElement: (tag: string) => new FakeEl(tag),
  createText: (text: string) => Object.assign(new FakeEl("#text"), { text }),
  createComment: (text: string) => Object.assign(new FakeEl("#comment"), { text }),
  setText(node: FakeEl, text: string) { node.text = text; },
  setElementText(el: FakeEl, text: string) { el.children = text ? [Object.assign(new FakeEl("#text"), { text, parent: el })] : []; },
  parentNode: (n: FakeEl) => n.parent,
  nextSibling: (n: FakeEl) => (n.parent ? n.parent.children[n.parent.children.indexOf(n) + 1] ?? null : null),
  insertStaticContent(content: string, parent: FakeEl, anchor: FakeEl | null) {
    const el = Object.assign(new FakeEl("#static"), { attrs: { innerHTML: content } });
    nodeOps.insert(el, parent, anchor);
    return [el, el];
  },
  patchProp(el: FakeEl, key: string, _prev: unknown, next: any) {
    if (/^on[A-Z]/.test(key)) { if (next) el.on[key.slice(2).toLowerCase()] = next; else delete el.on[key.slice(2).toLowerCase()]; }
    else if (next == null || next === false) delete el.attrs[key];
    else el.attrs[key] = next;
  },
};

describe("tournament builder page (client behaviour)", () => {
  let vite: ViteDevServer;
  let m: Record<string, any>;
  const saved: Record<string, unknown> = {};
  beforeAll(async () => {
    const { createServer } = await import("vite");
    const clientCompile = {
      name: "test:vue-client-compile",
      // "vue" itself as an entry would be inlined (its CJS build cannot run that way); re-exported from a module it stays
      // externalised, the same instance the components import.
      resolveId: (id: string) => (id === "virtual:test-vue" ? " virtual:test-vue" : undefined),
      load: (id: string) => (id === " virtual:test-vue" ? 'export * from "vue";' : undefined),
      configResolved(config: { plugins: readonly any[] }) {
        const vue = config.plugins.find((p) => p.name === "vite:vue");
        const load = vue.load.handler;
        const transform = vue.transform.handler;
        vue.load.handler = function (this: unknown, id: string, opt: object) { return load.call(this, id, { ...opt, ssr: false }); };
        vue.transform.handler = function (this: unknown, code: string, id: string, opt: object) { return transform.call(this, code, id, { ...opt, ssr: false }); };
      },
    };
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", plugins: [clientCompile], server: { middlewareMode: true, hmr: false, ws: false } });
    const [vue, vueRouter, view, app, session, builderMod] = await Promise.all([
      vite.ssrLoadModule("virtual:test-vue"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("/src/views/TournamentBuilderView.vue"),
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/session.ts"), vite.ssrLoadModule("/src/teams/builder.ts"),
    ]);
    m = { vue, vueRouter, view: view.default, app, session, builderMod };
    for (const k of ["window", "document"]) saved[k] = (globalThis as any)[k];
  }, 60_000);
  afterAll(async () => {
    for (const k of ["window", "document"]) (globalThis as any)[k] = saved[k];
    await vite?.close();
  });

  async function settle(): Promise<void> { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); }
  async function mount(path: string, f: Fetcher) {
    const scrolls: unknown[] = [];
    fakeDocument.activeElement = null;
    fakeDocument.main = new FakeEl("main");
    (globalThis as any).window = { scrollTo: (o: unknown) => scrolls.push(o), confirm: () => true, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, location: { origin: "https://sf.example" } };
    (globalThis as any).document = {
      get activeElement() { return fakeDocument.activeElement; },
      getElementById: (id: string) => (fakeDocument.root ? walk(fakeDocument.root).find((e) => e.attrs.id === id) ?? null : null),
      querySelector: (sel: string) => (sel === "main" ? fakeDocument.main : null),
      documentElement: { classList: { add() {}, remove() {} } },
      contains: () => true, addEventListener() {}, removeEventListener() {},
    };
    const router = m.vueRouter.createRouter({
      history: m.vueRouter.createMemoryHistory("/app/"),
      routes: [{ path: "/tournament-team-builder/:saveId([\\w-]{1,64})?", name: "tournament-team-builder", component: m.view, props: true }],
    });
    await router.push(path);
    await router.isReady();
    const app = m.vue.createRenderer(nodeOps).createApp(m.view);
    app.use(router);
    app.provide(m.app.API_KEY, f);
    app.provide(m.session.SESSION_KEY, m.session.createSessionStore(f));
    const root = new FakeEl("root");
    fakeDocument.root = root;
    app.mount(root);
    await settle();
    const all = () => walk(root);
    const find = (pred: (e: FakeEl) => boolean): FakeEl => { const hit = all().find(pred); if (!hit) throw new Error("element not found"); return hit; };
    /** Dispatch an event at `el`, bubbling through its parents to the handlers Vue bound. */
    async function fire(el: FakeEl, type: string, target: unknown = el): Promise<void> {
      for (let at: FakeEl | null = el; at; at = at.parent) await at.on[type]?.({ type, target, currentTarget: at, preventDefault() {}, stopPropagation() {} });
      await settle();
    }
    const selectedTab = (): string => find((e) => e.attrs.role === "tab" && e.attrs["aria-selected"] === "true").attrs["data-tab"];
    return { root, app, all, find, fire, scrolls, selectedTab };
  }

  it("picking a race in the Ruleset tab's table opens the Roster tab at the top with focus on its tab; a ruleset card stays on Ruleset", async () => {
    const page = await mount("/tournament-team-builder?package=Test%20Cup&tab=ruleset", mockFetcher(routes()));
    try {
      expect(page.selectedTab()).toBe("ruleset");
      await page.fire(page.find((e) => e.tag === "button" && e.attrs.class === "tb-card" && textOf(e) === "Test Cup"), "click");
      expect(page.selectedTab()).toBe("ruleset");
      expect(page.scrolls).toEqual([]);
      // The race table (the core's markup via v-html): its Human cell is a pick button; clicking it bubbles to the table's host.
      const table = page.find((e) => e.tag === "table" && String(e.attrs.innerHTML ?? "").includes('data-tt-race="human"'));
      const cell = { dataset: { ttRace: "human" } };
      await page.fire(table, "click", { closest: (sel: string) => (sel === "[data-tt-race]" ? cell : null) });
      expect(page.selectedTab()).toBe("roster");
      expect(page.find((e) => e.attrs.role === "tabpanel").attrs.id).toBe("tb-pane-roster");
      expect(page.all().some((e) => e.attrs.id === "tb-roster-h")).toBe(true);
      expect(page.scrolls).toEqual([{ top: 0 }]);
      expect(fakeDocument.main.scrolled).toEqual([{ top: 0 }]);
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-tab-roster");
    } finally { page.app.unmount(); }
  });

  it("a cold deep link with an old tab id (?package=&race=&tab=stars / inducements) lands on the Roster pane", async () => {
    for (const q of ["stars", "inducements"]) {
      // The view builds its own controller here (nothing pre-initialised): the roster loads after the first tab guess.
      const page = await mount(`/tournament-team-builder?package=Test%20Cup&race=human&tab=${q}`, mockFetcher(routes()));
      try {
        expect(page.selectedTab()).toBe("roster");
        expect(page.find((e) => e.attrs.role === "tabpanel").attrs.id).toBe("tb-pane-roster");
      } finally { page.app.unmount(); }
    }
  });

  it("hiring with no team name: the Errors / Valid box says so and focus goes to the team name field; naming the team clears it", async () => {
    const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
    try {
      expect(page.selectedTab()).toBe("roster");
      const verdict = () => page.find((e) => e.attrs["aria-labelledby"] === "tb-valid-h");
      const lineman = () => page.find((e) => e.attrs["aria-label"] === "Add Human Lineman");
      await page.fire(lineman(), "click");
      expect(textOf(verdict())).toContain("You must name your team first.");
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-team-name");
      expect(page.all().filter((e) => e.attrs.class === "tb-row" || String(e.attrs.class ?? "").startsWith("tb-row ")).length).toBe(0);
      // A star player takes the same gate.
      fakeDocument.activeElement = null;
      await page.fire(page.find((e) => e.attrs["aria-label"] === "Add Grim Ironjaw"), "click");
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-team-name");
      const name = page.find((e) => e.attrs.id === "tb-team-name");
      await page.fire(name, "input", { value: "Reavers" });
      expect(textOf(verdict())).not.toContain("You must name your team first.");
      await page.fire(lineman(), "click");
      expect(page.all().some((e) => e.attrs["data-row"] === 0)).toBe(true);
    } finally { page.app.unmount(); }
  });
});

describe("tournament builder wiring", () => {
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
