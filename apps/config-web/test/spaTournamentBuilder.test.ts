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
const TIER_ROW = { name: "Human", tier: 1, statIncreasesAllowed: false, gold: 1150000, maxSecondary: 0, maxStackedPlayers: 1, stackedPlayer: { maxSkills: 2, maxSecondary: 0, maxElite: 0 } };
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
    expect(v.headline).toBe("Team is invalid: 1 issue");
    expect(v.errors).toEqual(["Tier 1 allows no secondary skills (Guard on #2)."]);
    const body = f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/preview")).at(-1)!.body as any;
    expect(body.picks).toEqual([{ positionId: "hlin", count: 1, chosenSkills: ["Tackle", "Wrestle"], names: [expect.any(String)] }, { positionId: "hlin", count: 1, chosenSkills: ["Guard"], names: [expect.any(String)] }]);
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
    expect(b.requestBody().picks.find((p) => p.captain)).toEqual({ positionId: "hbli", count: 1, captain: true, names: [expect.any(String)] });
    expect(b.valueLines().find((l) => l.label === "Team Captain")?.value).toBe("#2 Blitzer");
  });

  it("Reset to base (owner 11-01): drops added skills, keeps name, number and Team Captain, updates costs; nothing to reset is a no-op", async () => {
    const { b } = await ready(mockFetcher(routes()));
    b.setTeamName("Reavers");
    b.addPosition("hbli");
    b.addPosition("hlin");
    b.renameSlot(0, "Ironhide");
    b.toggleCaptain(0);
    expect(b.resetSummary(0)).toEqual({ skills: 0, stats: 0 });
    expect(b.resetPlayer(0)).toEqual({ skills: 0, stats: 0 }); // nothing to reset
    await b.openSkills(0);
    await b.openSkills(1);
    expect(b.addSkill(0, "Tackle")).toBe("");
    expect(b.addSkill(1, "Wrestle")).toBe("");
    const before = b.totals().skillsCost;
    const beforeCount = b.totals().primary + b.totals().secondary;
    expect(b.resetSummary(0)).toEqual({ skills: 1, stats: 0 });
    expect(b.resetPlayer(0)).toEqual({ skills: 1, stats: 0 });
    const s0 = b.state.slots[0]!;
    expect(s0.chosenSkills).toEqual([]);
    expect(s0.chosenStatIncreases).toEqual([]);
    expect(s0.name).toBe("Ironhide");
    expect(s0.captain).toBe(true); // the captain's free Pro comes from the flag, so it stays
    expect(b.captainIndex()).toBe(0);
    expect(b.state.slots[1]!.chosenSkills).toEqual(["Wrestle"]); // other rows untouched
    expect(b.totals().skillsCost).toBeLessThan(before);
    expect(b.totals().primary + b.totals().secondary).toBe(beforeCount - 1);
    expect(b.resetSummary(0)).toEqual({ skills: 0, stats: 0 });
    expect(b.sheetModel().rows[0]!.name).toBe("Ironhide");
  });

  it("tournament stat rules (owner 11-01): the dialog's + carries the rule's reason per player, stat and team", async () => {
    const tier = { ...TIER_ROW, statIncreasesAllowed: true, statIncreases: { allowed: ["MA", "ST", "AV"], costGold: { MA: 20000, ST: 80000, AV: 10000 }, maxPerPlayer: 2 },
      statIncreaseRules: { excludePositions: [{ race: "*", position: "Ogre" }], blockedStats: [{ stat: "ST", keywords: ["Lineman"] }], maxPerTeam: 1 } };
    const f = mockFetcher(routes({ "/api/fork/team-builder/tiers?packageName=Test%20Cup": { races: [tier] }, "/api/fork/team-builder/legal-skills?rosterId=human&positionId=hogr": LEGAL }));
    const { b } = await ready(f);
    b.setTeamName("Reavers");
    b.addPosition("hlin");
    b.addPosition("hbli");
    b.addPosition("hogr");
    const reason = (i: number, stat: string) => b.statSteps(i).find((o) => o.stat === stat)!.reason;
    expect(reason(0, "ST")).toBe("Tournament rule: no ST increases for Lineman players."); // stat blocked for a keyword (type)
    expect(reason(0, "MA")).toBe(""); // another stat is open
    expect(reason(1, "ST")).toBe(""); // another position may
    expect(reason(2, "MA")).toBe("Tournament rule: no stat increases for Ogre players."); // position excluded, every stat
    expect(reason(2, "AV")).toBe("Tournament rule: no stat increases for Ogre players.");
    expect(reason(0, "AG")).toBe("AG increases aren't available here."); // not on the package's stat list
    expect(b.addStat(1, "MA")).toBe("");
    expect(reason(0, "MA")).toBe("Tournament rule: max 1 stat increase per team."); // team cap reached: everyone else greys out
    expect(reason(1, "ST")).toBe("Tournament rule: max 1 stat increase per team.");
    expect(b.statSteps(1).find((o) => o.stat === "MA")).toMatchObject({ has: true, removeReason: "" }); // the holder can still remove it
    b.removeStat(1, "MA");
    expect(reason(0, "MA")).toBe("");
  });

  it("Team Captain: no direct reassignment; clearing the captain (or firing them) frees the toggle (owner 10-31)", async () => {
    const { b } = await ready(mockFetcher(routes()));
    b.setTeamName("Reavers");
    b.addPosition("hbli");
    b.addPosition("hlin");
    b.toggleCaptain(0);
    expect(b.captainIndex()).toBe(0);
    b.toggleCaptain(1); // another row cannot take it while #1 is captain
    expect(b.captainIndex()).toBe(0);
    expect(b.state.slots[1]!.captain).toBeUndefined();
    b.toggleCaptain(0); // clear it on the captain's row
    expect(b.captainIndex()).toBe(-1);
    b.toggleCaptain(1);
    expect(b.captainIndex()).toBe(1);
    b.removeSlot(1); // firing the captain clears it
    expect(b.captainIndex()).toBe(-1);
  });

  it("skill allowance for the Roster header: pack caps, then the race's count limits, then the tier's secondary cap, else none", async () => {
    const withRace = (race: object) => mockFetcher(routes({ "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: { ...RACE, ...race } } } }));
    const count = (await ready(withRace({ skillSystem: { mode: "count", maxPrimary: 6, maxSecondary: 2 } }))).b;
    expect(count.skillAllowance()).toEqual({ primary: 6, secondary: 2 });
    const countNoSecondary = (await ready(withRace({ skillSystem: { mode: "count", maxPrimary: 6, maxSecondary: null } }))).b;
    expect(countNoSecondary.skillAllowance()).toEqual({ primary: 6, secondary: 0 }); // the tier row's maxSecondary 0
    const pack = (await ready(withRace({ packs: [{ label: "Pack A", gold: 1150000, maxSkills: 4, maxSecondary: 1 }], skillSystem: { mode: "packs" } }))).b;
    expect(pack.skillAllowance()).toEqual({ primary: null, secondary: 0 }); // no pack chosen yet: the tier's cap
    pack.setSkillPack("Pack A");
    expect(pack.skillAllowance()).toEqual({ primary: 4, secondary: 1 });
    const points = (await ready(withRace({ skillPointBudget: 6, skillSystem: { mode: "points" } }))).b;
    expect(points.skillAllowance()).toEqual({ primary: null, secondary: 0 });
  });

  it("the left accordion's open panel lives on the controller: Hireable players by default", async () => {
    const { b } = await ready(mockFetcher(routes()));
    expect(b.state.leftPanel).toBe("hire");
    b.state.leftPanel = "staff";
    expect(b.state.leftPanel).toBe("staff");
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
        rosterId: "human", coach: "Alice", teamName: "Reavers", picks: [{ positionId: "hbli", count: 1, names: [expect.any(String)] }], reRolls: 2, apothecary: true,
        assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, packageName: "Test Cup", rosteredInducements: [{ key: "bribes", count: 1 }],
      },
    });
    expect(b.state.currentSave).toEqual({ id: "sv_abc", name: "Reavers" });
    expect(b.state.savesStatus).toBe("Saved “Reavers”. It is in My teams.");
    b.addPosition("hlin");
    expect(await b.saveTeam()).toBe(true);
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect((put.body as any).body.picks).toEqual([{ positionId: "hbli", count: 1, names: [expect.any(String)] }, { positionId: "hlin", count: 1, names: [expect.any(String)] }]); // each player's generated name rides its pick
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
    expect(html).not.toContain('<h1 class="hm-title">'); // the page title lives in the shell's header bar
    const tabs = [...html.matchAll(/role="tab" class="tl-seg-btn" data-tab="(\w+)" aria-selected="(\w+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2], m[3]]);
    expect(tabs).toEqual([["ruleset", "false", "Ruleset"], ["roster", "true", "Roster"], ["sheet", "false", "Sheet"]]);
    expect(html).toContain("Test Cup · Human · Tier 1 · TV cap 1,150k");
    expect(between(html, "tb-validator-h")).toContain('class="tv-totals tb-value"');
    expect(between(html, "tb-validator-h")).not.toMatch(/Server preview|Estimate<\/span><\/header>/i); // no meta label on the Validator header
    expect(html).toContain('<span class="tb-acc-title">Hireable players</span>');
    expect(html).not.toContain(">Add players</h2>");
    expect(html).toContain('aria-label="Add Human Blitzer, ');
    expect(html).toMatch(/<strong>Blitzer<\/strong>/); // short position name (src/positionNames.ts)
  });

  it("the Roster pane: left = the accordion (hireable players, sideline staff, inducements, star players); centre = roster; right = team (save line in its footer), validator (phone order = source order)", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); });
    expect(html).toContain('id="tb-pane-roster"');
    const cols = ["tb-col-left", "tb-col-centre", "tb-col-right"].map((c) => html.indexOf(`class="tb-col ${c}"`));
    expect(cols.every((n) => n > 0)).toBe(true);
    expect(cols).toEqual([...cols].sort((a, b) => a - b));
    const order = ["tb-add-h", "tb-staff-h", "tb-ind-h", "tb-stars-h", "tb-roster-h", "tb-team-name", "tb-valid-h", "tb-validator-h"].map((id) => html.indexOf(`id="${id}"`));
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const id of ["tb-add-h", "tb-staff-h", "tb-ind-h", "tb-stars-h"]) expect(html.indexOf(`id="${id}"`)).toBeLessThan(cols[1]!); // all four in the left column
    expect(html).not.toContain('id="tb-picked-h"'); // no Selected inducements panel anywhere while nothing is picked (and never on the right)
    expect(html).toMatch(/class="tb-positions tb-hire-list tb-row-window"/); // the hire list scrolls (five cards at a time)
    expect(html.indexOf('id="tb-roster-h"')).toBeGreaterThan(cols[1]!);
    expect(html.indexOf('id="tb-team-name"')).toBeGreaterThan(cols[2]!);
    expect(html.indexOf('id="tb-valid-h"')).toBeGreaterThan(html.indexOf('id="tb-team-name"')); // no packs: the save line sits under name / league from the start
    expect(between(html, "tb-team-name", "tb-validator-h")).toContain('<section class="tb-saveline"'); // inside the Team panel, no separate box
    expect(html).not.toContain("Change skill pack");
    // The roster table is the top of the centre column; the skill key sits under it.
    expect(between(html, "tb-roster-h", "tb-team-name")).toContain('aria-label="Skill key"');
    expect(html).toContain('id="tb-team-name"');
  });

  it("hire cards: no role tags; cost over a hired/max count in the top-right corner; printed skills on the roster's grey band", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); });
    const cards = html.slice(html.indexOf('class="tb-positions tb-hire-list'));
    expect(cards).not.toMatch(/ left/);
    expect(cards).not.toContain("Big Guy");
    expect(cards).not.toMatch(/<small>[^<]* · /);
    expect(cards).toMatch(/<span class="tb-corner"><span class="tb-cost">[^<]*<\/span><small class="tb-hired">\d+\/\d+<\/small><\/span>/);
    expect(cards).toMatch(/aria-label="Add [^"]+, \d+ of \d+ hired, [^"]+"/); // the button's accessible name carries the count and cost
    expect(cards).not.toMatch(/<small class="tb-hired" aria-label/);
    expect(cards).toMatch(/class="row-skills tb-printed tb-skillband"/);
    const css = readFileSync(new URL("../spa/src/teams/builder.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tb-position > \.tb-printed \{[^}]*background: var\(--tb-skillbar\); border-radius: 0 0 2px 2px/);
    expect(css).toMatch(/\.tb-position > \.tb-printed \.muted \{ color: var\(--tb-skillbar-muted\)/);
    expect(css.match(/--tb-skillbar-muted: #/g)).toHaveLength(2); // both token blocks
    expect(css).toMatch(/\.tb-position > \.tb-corner \{[^}]*justify-items: end/);
  });

  it("the Ruleset tab's Pick a race table sits in a scroll region with a sticky header; the panel header and helper line stay outside it", async () => {
    const html = await render("/tournament-team-builder?package=Test%20Cup&tab=ruleset", mockFetcher(routes()));
    const region = html.indexOf('class="tb-scroll tb-race-scroll"');
    expect(region).toBeGreaterThan(html.indexOf('id="tb-race-h"'));
    expect(region).toBeGreaterThan(html.indexOf("Each team name picks that race."));
    expect(html.slice(region, region + 400)).toContain("<table");
    const css = readFileSync(new URL("../spa/src/teams/builder.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tb-race-scroll \{[^}]*max-height: max\(320px, calc\(100vh[^}]*overflow: auto/);
    expect(css).toMatch(/\.tb-race-scroll thead th \{[^}]*position: sticky; top: 0/);
  });

  it("the Ruleset tab reflows: DOM order is rulesets, rules summary, Pick a race; once a ruleset is chosen the race picker is the left column and the rulesets sit right", async () => {
    const html = await render("/tournament-team-builder?package=Test%20Cup&tab=ruleset", mockFetcher(routes()));
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(html).toContain('class="tb-rsflow tb-rs-sel"');
    expect(at("tb-rulesets-h")).toBeGreaterThan(-1);
    expect(at("tb-package-h")).toBeGreaterThan(at("tb-rulesets-h"));
    expect(at("tb-race-h")).toBeGreaterThan(at("tb-package-h"));
    for (const a of ["rulesets", "summary", "race"]) expect(html).toContain(`tb-area-${a}`);
    const css = readFileSync(new URL("../spa/src/teams/builder.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tb-area-race \{ grid-area: race; \}/);
    expect(css).toMatch(/\.tb-rsflow \{ grid-template-areas: "rulesets" "summary" "race"; \}/);
    expect(css).toMatch(/@media \(min-width: 1180px\) \{\s*\.tb-rsflow \{[^}]*3fr[^}]*2fr[^}]*"race rulesets" "race summary"/);
    expect(css).toMatch(/\.tb-rsflow\.tb-rs-none \{[^}]*2fr[^}]*3fr[^}]*"rulesets \."/);
    expect(css).toMatch(/\.tb-rsflow\.tb-rs-anim \{ overflow-x: clip; \}/);
    expect(css).toMatch(/\.tb-rsflow \.tb-cards \{ grid-template-columns: repeat\(2,/);
    expect(html).toContain("tb-wide");
  });

  it("no ruleset chosen: only the rulesets panel renders (left column); a deep link renders the final layout with no animating class", async () => {
    const bare = await render("/tournament-team-builder?tab=ruleset", mockFetcher(routes()), async (b) => { await b.choosePackage(""); });
    expect(bare).toContain('class="tb-rsflow tb-rs-none"');
    expect(bare).toContain('id="tb-rulesets-h"');
    expect(bare).not.toContain('id="tb-race-h"');
    expect(bare).not.toContain('id="tb-package-h"');
    expect(bare).not.toContain("Pick a tournament ruleset first.");
    expect(bare).not.toContain("tb-race-scroll");
    expect(bare).not.toContain("<table");
    const deep = await render("/tournament-team-builder?package=Test%20Cup&tab=ruleset", mockFetcher(routes()));
    expect(deep).toContain("tb-rs-sel");
    expect(deep).not.toContain("tb-rs-none");
    expect(deep).not.toContain("tb-rs-anim");
    expect(deep).toContain('id="tb-race-h"');
  });

  it("first-pick motion: slide on a wide screen, fade when stacked, instant (opacity only) under prefers-reduced-motion", async () => {
    const m = await import("../spa/src/teams/rulesetMotion");
    expect(m.pickMotion(true, false)).toBe("slide");
    expect(m.pickMotion(false, false)).toBe("fade");
    expect(m.pickMotion(true, true)).toBe("quick");
    expect(m.pickMotion(false, true)).toBe("quick");
    expect(m.QUICK_MS).toBeLessThanOrEqual(120);
    expect(m.SLIDE_MS).toBeGreaterThanOrEqual(250);
    expect(m.POP_MS).toBeGreaterThanOrEqual(250);
    expect(m.POP_MS).toBeLessThanOrEqual(350);
    expect(m.POP_DELAY_MS).toBeGreaterThan(0);
    const src = readFileSync(new URL("../spa/src/components/TournamentBuilderRuleset.vue", import.meta.url), "utf8");
    // only the quick path returns before animating = reduced motion never sets the animating (overflow clip) class
    expect(src.indexOf('run.motion === "quick"')).toBeLessThan(src.indexOf("animating.value = true"));
    expect(src).toMatch(/if \(!state\.packageName\) \{\s*const motion = currentMotion\(\)/); // only a pick from the empty state arms the motion
  });

  it("the step tabs: the shell header has the (empty-elsewhere) slot; server rendering keeps the tablist inline until mount", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()));
    expect(html).toContain('<div id="sf-header-slot" class="sf-header-slot"></div>');
    expect(html).toMatch(/<div class="sf-titleblock"><a [^>]*class="[^"]*brand sf-wordmark"[^>]*>Super FUMBBL<\/a><h1 class="sf-page-title" aria-live="polite">Roster Builder<\/h1><\/div>/);
    expect(html.indexOf('role="tablist" aria-label="Roster Builder steps"')).toBeGreaterThan(html.indexOf('class="hm-page tm-page tb-page'));
    expect(html).toContain('<p class="tb-locked">'); // not a button off the phone
    const view = readFileSync(new URL("../spa/src/views/TournamentBuilderView.vue", import.meta.url), "utf8");
    expect(view).toContain('<Teleport to="#sf-header-slot" :disabled="!inHeader">');
    expect(view).toContain('aria-label="Change ruleset or race"');
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
    const roster = between(html, "tb-roster-h", "tb-team-name");
    // one square "+" (owner 11-01) replaces + Skill / + Stat; this tier has no stat increases, so it names skills only
    expect(roster.match(/class="tb-advance"/g)).toHaveLength(1);
    expect(roster).toContain('aria-label="Add skill for #1 Blitzer" aria-haspopup="dialog"><span aria-hidden="true">+</span></button>');
    expect(roster).not.toMatch(/>\+ (Skill|Stat)<|data-kind="characteristic"|>Add Skill</);
    expect(roster).toContain("Star player: no added skills");
    // the Roster header carries the skill counts against the allowance (tier 1: no secondary); the player count sits bottom right
    expect(roster).toContain('id="tb-roster-h">Roster</h2><span class="hm-cap tb-skill-meta">Primary 0 · Secondary 0/0</span>');
    expect(roster).not.toContain("Primary skills <b>");
    expect(roster.indexOf('aria-label="Skill key"')).toBeLessThan(roster.indexOf('class="hm-cap tb-player-count">2 / 16 players</span>'));
    // Add Skill sits at the right end of the stat line (owner 10-31: where Fire was); no Fire button, a red X fires instead
    expect(roster).toMatch(/<span class="tb-row-line2"><span class="tb-stats tb-row-stats">.*?<\/span><span class="tb-row-actions"><button type="button" class="tb-advance"/s);
    expect(roster).not.toMatch(/>Fire<\/button>/);
    expect(roster).not.toContain('class="tb-fire"');
    expect(roster).toContain('class="tb-fire-x" aria-label="Fire Human Blitzer #1"');
    expect(roster).toContain('aria-label="Fire Grim Ironjaw #2"');
    // the row number is the captain toggle on eligible rows; the star keeps a plain number, no badge, not a button
    expect(roster).toMatch(/<button type="button" class="tb-num tb-captain" data-tone="grey" aria-pressed="false"[^>]*><img class="tb-captain-img"[^>]*><span class="tb-num-n">1<\/span><\/button>/);
    expect(roster).toContain('<span class="tb-num">2</span>');
    expect(roster).not.toContain("Roster player"); // no subtitle except the star line
    expect(roster).toContain('class="sprite-frame tb-sprite tb-row-sprite"'); // the bigger portrait
    expect(roster.match(/class="row-skills tb-row-skills"/g)).toHaveLength(2); // the skills band on every row
    const validator = between(html, "tb-validator-h");
    expect(validator).toContain("Budget 1,150k");
    expect(validator).toContain("Stars (max 1)");
    expect(validator).toContain("Secondary skills: max 0");
    expect(validator).toContain("Stacked players: max 1");
    expect(validator).not.toContain("Test Cup · Tier 1"); // no package title line above the bullets
    expect(validator).not.toContain("tb-note");           // no data-note paragraph
    expect(html).not.toContain('<span class="tb-chip"');                // the summary bar stays crest · package · race · tier · TV cap
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
    const validator = between(html, "tb-validator-h");
    expect(validator).toContain('class="tb-sp-total">3.5 <small>/ 6 SP</small>');
    expect(validator).toContain("<span>#1 Blitzer</span><b>1 SP</b>");
    expect(validator).toContain("<span>#2 Lineman</span><b>2.5 SP</b>");
    expect(validator).toContain("6 SP"); // the race's rule line: Budget 1,150k · 6 SP
  });

  it("the save line: invalid -> the verdict header and the live issues list replace Export PDF / Create team on Fork (Save Team stays); the Sheet tab is the sheet only", async () => {
    const f = mockFetcher(routes({ "POST /api/fork/team-builder/preview": { valid: false, errors: ["Tier 1 allows no secondary skills (Guard on #1)."], warnings: ["Unspent gold"], summary: { goldUsed: 90000 }, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } } }));
    const prepare = async (b: any) => {
      b.setTeamName("Reavers <x>");
      b.addPosition("hlin");
      await b.openSkills(0);
      b.addSkill(0, "Guard");
      await b.flushPreview();
    };
    const html = await render("/tournament-team-builder?tab=roster", f, prepare);
    expect(html).toContain('<h3 id="tb-valid-h" class="tb-saveline-head" tabindex="-1" aria-live="polite">Team is invalid: 1 issue</h3>');
    const line = between(html, "tb-valid-h", "tb-validator-h");
    const errorAt = line.indexOf('data-kind="error">Tier 1 allows no secondary skills (Guard on #1).</li>');
    const warningAt = line.indexOf('data-kind="warning">Unspent gold</li>');
    expect(errorAt).toBeGreaterThan(0);
    expect(warningAt).toBeGreaterThan(errorAt); // errors first, then warnings
    expect(line).not.toMatch(/>Export PDF<\/button>/);
    expect(line).not.toMatch(/>Create team on Fork<\/button>/);
    expect(line).toMatch(/<button type="button" class="tb-btn">Save Team<\/button>/); // a draft can still be saved
    expect(line.indexOf(">Save Team</button>")).toBeGreaterThan(warningAt); // under the issues
    expect(line).not.toContain("The server checked this team against"); // no explanatory sentence
    expect(between(html, "tb-team-name", "tb-valid-h")).not.toMatch(/class="tb-action-row"/); // the Team controls hold no actions
    const sheet = await render("/tournament-team-builder?tab=sheet", f, prepare);
    // The Sheet tab is the exported PDF previewed on paper (owner 10-30): the PDF's header, ruleset box and roster table.
    expect(sheet).toContain('<h2 id="ps-frame-h">Sheet · preview of the exported PDF</h2>');
    expect(sheet).toContain('<div class="ps-race">Reavers &lt;x&gt;</div>'); // the team's name is the title (owner 11-01)
    expect(sheet).toContain('<span class="ps-label">RACE</span> Human');
    expect(sheet).toContain('<span class="ps-secondary">Guard</span>'); // Guard printed as an added Secondary skill
    expect(sheet).toContain('<th colspan="4">TOURNAMENT RULESET</th>');
    expect(sheet).toContain('<td class="ps-k">Package</td><td class="ps-v">Test Cup</td>');
    expect(sheet).not.toContain('id="tb-valid-h"');
    expect(sheet).not.toMatch(/>Export PDF<\/button>/);
  });

  it("the save line: valid for the current document -> the buttons (Export PDF, Save Team, Create team on Fork), no issues list", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), async (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); await b.flushPreview(); });
    expect(html).toContain('<h3 id="tb-valid-h" class="tb-saveline-head" tabindex="-1" aria-live="polite">Team is valid</h3>');
    expect(html).toContain('<section class="tb-saveline" data-tone="valid"');
    const line = between(html, "tb-valid-h", "tb-validator-h");
    expect(line).not.toContain('class="tb-issues"');
    const at = ["Export PDF", "Save Team", "Create team on Fork"].map((t) => line.indexOf(`>${t}</button>`));
    expect(at.every((n) => n > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("the save line while the preview is out: Checking team..., the issues list (checklist) instead of the buttons", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); b.state.previewPending = true; });
    expect(html).toContain('<h3 id="tb-valid-h" class="tb-saveline-head" tabindex="-1" aria-live="polite">Checking team...</h3>');
    expect(between(html, "tb-valid-h", "tb-validator-h")).not.toMatch(/>Export PDF<\/button>/);
  });

  const PACKS = [{ label: "Pack A", gold: 1150000, skillPointBudget: 4, maxPerPlayer: 2 }, { label: "Pack B", gold: 1100000, skillPointBudget: 8, maxPerPlayer: 2 }];
  const packRoutes = () => routes({ "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: { ...RACE, packs: PACKS } } } });

  it("skill packs: no pack yet -> the pack list, save line and Validator rule bullets hidden; a chosen pack (deep link / save / handoff) -> the save line in its place and Change skill pack", async () => {
    const start = await render("/tournament-team-builder?tab=roster", mockFetcher(packRoutes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); });
    expect(start).toContain('id="tb-team-packs"');
    expect(start).not.toContain('id="tb-valid-h"');
    expect(start).not.toContain('class="tb-rules"');
    expect(between(start, "tb-validator-h")).toContain('class="tv-totals tb-value"'); // the value cards stay
    expect(start).not.toContain("Change skill pack");
    const picked = await render("/tournament-team-builder?tab=roster", mockFetcher(packRoutes()), (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); b.setSkillPack("Pack B"); });
    expect(picked).not.toContain('id="tb-team-packs"');
    expect(picked).toContain('id="tb-valid-h"');
    expect(picked).toContain('class="tb-rules"');
    // Change skill pack sits in the save line, under the buttons (owner 10-31); no Team header band
    const line = between(picked, "tb-valid-h", "tb-validator-h");
    expect(line.indexOf('class="tb-btn small tb-change-pack" aria-controls="tb-team-packs">Change skill pack</button>')).toBeGreaterThan(line.indexOf('class="tb-action-row"'));
    expect(picked).toContain('<section class="hm-panel tb-panel tb-team" aria-label="Team">');
    expect(picked).not.toContain('id="tb-team-h"');
  });

  it("left accordion: fixed order, Hireable players open by default; another panel opens in place (owner 10-31)", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); });
    const bars = [...html.matchAll(/id="tb-acc-(\w+)" type="button" class="tb-acc-btn" aria-expanded="(\w+)"/g)].map((m) => [m[1], m[2]]);
    expect(bars).toEqual([["hire", "true"], ["staff", "false"], ["inducements", "false"], ["stars", "false"]]);
    expect(html).toContain('id="tb-acc-body-hire"');
    expect(html).not.toContain('id="tb-acc-body-staff"');
    expect(html).toContain('aria-controls="tb-acc-body-staff"');
    expect(html).not.toMatch(/<span class="tb-acc-title">Hireable players<\/span><span class="hm-cap">/); // no count meta on Hireable players
    const staff = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Reavers"); b.state.leftPanel = "staff"; });
    const order = [...staff.matchAll(/id="tb-acc-(\w+)" type="button" class="tb-acc-btn" aria-expanded="(\w+)"/g)].map((m) => [m[1], m[2]]);
    expect(order).toEqual([["hire", "false"], ["staff", "true"], ["inducements", "false"], ["stars", "false"]]);
    expect(staff).toContain('id="tb-acc-body-staff"');
    expect(staff).not.toContain('id="tb-acc-body-hire"');
    expect(staff).toContain('class="tb-steppers tb-scroll-list tb-row-window"'); // five lines at a time
  });

  it("NO STAR ACCESS: a race with no stars keeps the bar, muted and never expandable; a remembered Star players panel falls back to Hireable players", async () => {
    const f = mockFetcher(routes({ "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: { ...RACE, stars: { allowed: false } } } } }));
    const html = await render("/tournament-team-builder?tab=roster", f, (b) => { b.setTeamName("Reavers"); b.state.leftPanel = "stars"; });
    expect(html).toMatch(/id="tb-acc-stars" type="button" class="tb-acc-btn" aria-expanded="false" aria-disabled="true"[^>]*><span class="tb-acc-title">NO STAR ACCESS<\/span>/);
    expect(html).toContain('<section class="off hm-panel tb-panel tb-acc" data-panel="stars"');
    expect(html).not.toContain('id="tb-acc-body-stars"');
    expect(html).not.toContain('aria-controls="tb-acc-body-stars"');
    expect(html).toContain('id="tb-acc-body-hire"');
    expect(html).not.toContain(">Star Players<");
  });

  it("captain badge: the owner's painted badge (gold on, grey toggle), only the captain's row while one is set; added skills wear the gold border and the red X badge, printed skills neither", async () => {
    const f = mockFetcher(routes());
    const none = await render("/tournament-team-builder?tab=roster", f, (b) => { b.setTeamName("Reavers"); b.addPosition("hbli"); b.addPosition("hlin"); });
    const rows0 = between(none, "tb-roster-h", "tb-team-name");
    expect(rows0.match(/class="tb-num tb-captain"/g)).toHaveLength(2); // grey badges behind every eligible number
    expect(rows0).toContain('src="/icons/builder/team-captain-grey-48.png" srcset="/icons/builder/team-captain-grey-48.png 1x, /icons/builder/team-captain-grey-64.png 2x" width="40" height="40" alt=""');
    expect(rows0).toContain('title="Make team captain"');
    const set = await render("/tournament-team-builder?tab=roster", f, async (b) => {
      b.setTeamName("Reavers"); b.addPosition("hbli"); b.addPosition("hlin"); b.toggleCaptain(1);
      await b.openSkills(0); b.addSkill(0, "Tackle");
    });
    const rows = between(set, "tb-roster-h", "tb-team-name");
    expect(rows.match(/class="tb-num tb-captain"/g)).toHaveLength(1); // the other eligible row shows its plain number
    expect(rows).toMatch(/class="tb-num tb-captain" data-tone="gold" aria-pressed="true"[^>]*><img[^>]*><span class="tb-num-n">2<\/span>/);
    expect(rows).toContain('<span class="tb-num">1</span>');
    expect(rows).toContain('src="/icons/builder/team-captain-gold-48.png"');
    expect(rows).toContain('aria-pressed="true" title="Team captain. Remove to choose another player." aria-description="Team captain. Remove to choose another player."');
    expect(rows).not.toContain("tb-captain-slot");
    expect(rows).not.toMatch(/<small>Team Captain<\/small>/); // no captain subtitle either
    expect(rows).toMatch(/class="skill skill-general tb-added tb-bought access-primary">\s*(<!---->)?Tackle<button type="button" class="tb-chip-x" aria-label="Remove Tackle">/);
    expect(rows).toMatch(/<span class="skill skill-general tb-elite-chip" title="Elite skill"><img class="tb-elite-dot"[^>]*>Block<\/span>/); // the printed skill: no tb-bought, no X (the elite diamond only)
    expect(rows).not.toContain('aria-label="Remove Block"');
  });

  it("Share link follows the verdict like Export PDF: hidden for an invalid draft or while the preview is out; Unshare always stays", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const bad = { valid: false, errors: ["Too few players."], warnings: [], summary: { goldUsed: 50000 }, package: { name: "Test Cup", budget: 1150000, rules: TIER_ROW } };
    const unshared = await render("/tournament-team-builder/sv_abc?tab=roster", mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/preview": bad,
    })), async (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); await b.saveTeam(); await b.flushPreview(); });
    expect(between(unshared, "tb-valid-h", "tb-validator-h")).not.toMatch(/>Share link<\/button>/);
    const shared = await render("/tournament-team-builder/sv_abc?tab=roster", mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/saves/sv_abc/share": { shareToken: token },
      "POST /api/fork/team-builder/preview": bad,
    })), async (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); await b.saveTeam(); await b.share(); await b.flushPreview(); });
    const line = between(shared, "tb-valid-h", "tb-validator-h");
    expect(line).not.toContain('id="tb-share-url"');
    expect(line).not.toMatch(/>Copy<\/button>/);
    expect(line).toMatch(/>Unshare<\/button>/);
    const pending = await render("/tournament-team-builder/sv_abc?tab=roster", mockFetcher(routes({ "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } } })),
      async (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); await b.saveTeam(); await b.flushPreview(); b.addPosition("hlin"); }); // an edit after the valid preview
    expect(between(pending, "tb-valid-h", "tb-validator-h")).not.toMatch(/>Share link<\/button>/);
    const ok = await render("/tournament-team-builder/sv_abc?tab=roster", mockFetcher(routes({ "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } } })),
      async (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); await b.saveTeam(); await b.flushPreview(); });
    expect(between(ok, "tb-valid-h", "tb-validator-h")).toMatch(/>Share link<\/button>/);
  });

  it("the Team controls with a shared save: the link field, Copy and Unshare", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const f = mockFetcher(routes({
      "POST /api/fork/team-builder/saves": { save: { id: "sv_abc", name: "Reavers" } },
      "POST /api/fork/team-builder/saves/sv_abc/share": { shareToken: token },
    }));
    const html = await render("/tournament-team-builder/sv_abc?tab=roster", f, async (b) => { b.setTeamName("Reavers"); b.addPosition("hlin"); await b.saveTeam(); await b.share(); await b.flushPreview(); });
    const team = between(html, "tb-team-name", "tb-validator-h");
    expect(team).toContain(`value="https://sf.example/t/${token}"`);
    expect(team).toMatch(/>Unshare<\/button>/);
    expect(team).not.toMatch(/>Share link<\/button>/);
    expect(between(html, "tb-team-name", "tb-valid-h")).toContain('<small class="muted tb-editing">Editing Reavers</small>'); // under the name field (no header band)
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
/** A stand-in for the Web Animations API object: `finished` settles only when the test finishes it or cancel() rejects it. */
class FakeAnim {
  cancelled = false;
  finished: Promise<unknown>;
  private done!: (v?: unknown) => void;
  private fail!: (e: unknown) => void;
  constructor(public frames: unknown[], public opts: { duration: number }) { this.finished = new Promise((res, rej) => { this.done = res; this.fail = rej; }); }
  cancel(): void { this.cancelled = true; this.fail(new Error("AbortError")); }
  finish(): void { this.done(); }
}
class FakeEl {
  animations: FakeAnim[] = [];
  rectLeft = 0;
  animate(frames: unknown[], opts: { duration: number }): FakeAnim { const a = new FakeAnim(frames, opts); this.animations.push(a); return a; }
  getBoundingClientRect(): { left: number; top: number } { return { left: this.rectLeft, top: 0 }; }
  scrollIntoView(): void { /* the stacked layout's smooth scroll */ }
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
      const lineman = () => page.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Lineman,"));
      await page.fire(lineman(), "click");
      expect(textOf(verdict())).toContain("You must name your team first.");
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-team-name");
      expect(page.all().filter((e) => e.attrs.class === "tb-row" || String(e.attrs.class ?? "").startsWith("tb-row ")).length).toBe(0);
      // A star player takes the same gate (open the Star players panel of the left accordion first).
      await page.fire(page.find((e) => e.attrs.id === "tb-acc-stars"), "click");
      fakeDocument.activeElement = null;
      await page.fire(page.find((e) => e.attrs["aria-label"] === "Add Grim Ironjaw"), "click");
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-team-name");
      const name = page.find((e) => e.attrs.id === "tb-team-name");
      await page.fire(name, "input", { value: "Reavers" });
      expect(textOf(verdict())).not.toContain("You must name your team first.");
      await page.fire(page.find((e) => e.attrs.id === "tb-acc-hire"), "click"); // back to Hireable players
      await page.fire(lineman(), "click");
      expect(page.all().some((e) => e.attrs["data-row"] === 0)).toBe(true);
    } finally { page.app.unmount(); }
  });

  const bars = (page: { all: () => FakeEl[] }): string[] => page.all().filter((e) => e.tag === "section" && String(e.attrs.class ?? "").includes("tb-acc"))
    .map((e) => `${e.attrs["data-panel"]}${String(e.attrs.class).includes("open") ? "*" : ""}`);

  it("left accordion: a click opens a panel in place (the others collapse, order never changes), focus stays on its header; closing it reopens Hireable players", async () => {
    const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
    try {
      expect(bars(page)).toEqual(["hire*", "staff", "inducements", "stars"]);
      const btn = (p: string) => page.find((e) => e.attrs.id === `tb-acc-${p}`);
      expect(btn("staff").tag).toBe("button"); // Enter / Space activate it natively
      expect(btn("staff").attrs["aria-controls"]).toBe("tb-acc-body-staff");
      await page.fire(btn("inducements"), "click");
      expect(bars(page)).toEqual(["hire", "staff", "inducements*", "stars"]);
      expect(btn("inducements").attrs["aria-expanded"]).toBe("true");
      expect(btn("hire").attrs["aria-expanded"]).toBe("false");
      expect(page.all().some((e) => e.attrs.id === "tb-acc-body-inducements")).toBe(true);
      expect(page.all().some((e) => e.attrs.id === "tb-acc-body-hire")).toBe(false);
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-acc-inducements");
      await page.fire(btn("inducements"), "click"); // close it: Hireable players opens again
      expect(bars(page)).toEqual(["hire*", "staff", "inducements", "stars"]);
      await page.fire(btn("hire"), "click"); // Hireable players stays open until another panel opens
      expect(bars(page)).toEqual(["hire*", "staff", "inducements", "stars"]);
    } finally { page.app.unmount(); }
  });

  it("a hire scrolls the newest row into view and flashes it; loading a saved team does not", async () => {
    const seen: unknown[] = [];
    const proto = FakeEl.prototype as any;
    const was = proto.scrollIntoView;
    proto.scrollIntoView = function (this: FakeEl, o: unknown) { seen.push([this.attrs["data-row"], o]); };
    try {
      const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
      try {
        await page.fire(page.find((e) => e.attrs.id === "tb-team-name"), "input", { value: "Reavers" });
        await page.fire(page.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Lineman,")), "click");
        await page.fire(page.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Blitzer,")), "click");
        expect(seen).toEqual([[0, { block: "nearest", behavior: "smooth" }], [1, { block: "nearest", behavior: "smooth" }]]);
        expect(String(page.find((e) => e.attrs["data-row"] === 1).attrs.class)).toContain("tb-row-new");
        seen.length = 0;
        await page.fire(page.find((e) => e.attrs["aria-label"] === "Fire Human Lineman #1"), "click"); // fire: no scroll
        expect(seen).toEqual([]);
        expect(page.all().filter((e) => e.attrs["data-row"] !== undefined).length).toBe(1);
      } finally { page.app.unmount(); }
      seen.length = 0;
      const save = { id: "sv_abc", name: "Reavers", body: { rosterId: "human", teamName: "Reavers", packageName: "Test Cup", picks: [{ positionId: "hlin", count: 3 }] } };
      const lf = mockFetcher(routes({ "/api/fork/team-builder/saves/sv_abc": { save } }));
      const loaded = await mount("/tournament-team-builder?save=sv_abc", lf); // the test mounts the view as the app root: the ?save= deep link
      try {
        expect(loaded.selectedTab()).toBe("roster");
        expect(loaded.all().filter((e) => e.attrs["data-row"] !== undefined).length).toBe(3);
        expect(seen).toEqual([]);
      } finally { loaded.app.unmount(); }
    } finally { proto.scrollIntoView = was; }
  });

  it("captain badge behind the number: with a captain set the other rows show plain numbers; clearing it or firing the captain restores them; a broken image keeps the number with a ring", async () => {
    const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
    try {
      await page.fire(page.find((e) => e.attrs.id === "tb-team-name"), "input", { value: "Reavers" });
      for (const who of ["Add Human Blitzer", "Add Human Lineman", "Add Human Lineman"]) await page.fire(page.find((e) => String(e.attrs["aria-label"]).startsWith(who + ",")), "click");
      const toggles = () => page.all().filter((e) => e.tag === "button" && String(e.attrs.class ?? "").startsWith("tb-num tb-captain"));
      expect(toggles().length).toBe(3);
      await page.fire(toggles()[1]!, "click");
      expect(toggles().length).toBe(1);
      expect(toggles()[0]!.attrs["aria-pressed"]).toBe("true");
      await page.fire(toggles()[0]!, "click"); // clear it on the captain's row
      expect(toggles().length).toBe(3);
      await page.fire(toggles()[2]!, "click");
      expect(toggles().length).toBe(1);
      await page.fire(page.find((e) => e.attrs["aria-label"] === "Fire Human Lineman #3"), "click"); // fire the captain
      expect(toggles().length).toBe(2);
      const img = toggles()[0]!.children.find((c) => c.tag === "img")!;
      expect(img.attrs.src).toBe("/icons/builder/team-captain-grey-48.png");
      expect(textOf(toggles()[0]!)).toBe("1"); // the number on top of the badge
      await page.fire(img, "error");
      expect(textOf(toggles()[0]!)).toBe("1");
      expect(String(toggles()[0]!.attrs.class)).toContain("broken"); // the ring fallback
      expect(toggles()[0]!.children.some((c) => c.tag === "img")).toBe(false);
    } finally { page.app.unmount(); }
  });

  it("the red X badge on an added skill removes it", async () => {
    const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
    try {
      await page.fire(page.find((e) => e.attrs.id === "tb-team-name"), "input", { value: "Reavers" });
      await page.fire(page.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Lineman,")), "click");
      const inRow = (e: FakeEl): boolean => { for (let p = e.parent; p; p = p.parent) if (p.attrs["data-row"] !== undefined) return true; return false; };
      const chipX = () => page.all().filter((e) => e.attrs.class === "tb-chip-x" && inRow(e));
      expect(chipX()).toEqual([]);
      // add Tackle through the skill picker
      await page.fire(page.find((e) => e.attrs["aria-label"] === "Add skill for #1 Lineman"), "click");
      await page.fire(page.find((e) => e.tag === "button" && textOf(e).startsWith("Tackle")), "click");
      expect(chipX().map((e) => e.attrs["aria-label"])).toEqual(["Remove Tackle"]);
      await page.fire(chipX()[0]!, "click");
      expect(chipX()).toEqual([]);
    } finally { page.app.unmount(); }
  });

  it("the Advance dialog (owner 11-01): Free Create shows the stat bar with + / − per characteristic; a ruleset without increases keeps the bar visible but greyed out", async () => {
    const free = await mount("/tournament-team-builder?package=free-create&race=human", mockFetcher(routes()));
    try {
      await free.fire(free.find((e) => e.attrs.id === "tb-team-name"), "input", { value: "Reavers" });
      await free.fire(free.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Lineman,")), "click");
      await free.fire(free.find((e) => e.attrs["aria-label"] === "Add skill or stat increase for #1 Lineman"), "click");
      expect(textOf(free.find((e) => e.attrs.id === "tb-picker-h"))).toContain("Advance: #1 Lineman");
      const step = (label: string) => free.find((e) => e.tag === "button" && String(e.attrs["aria-label"]).startsWith(label));
      expect(free.all().filter((e) => e.attrs["data-step"]).length).toBe(10); // + and − for MA ST AG PA AV
      expect(step("Improve AG to 2+").attrs["aria-disabled"]).toBeUndefined();
      expect(step("Remove AG increase").attrs["aria-disabled"]).toBe("true");
      expect(step("Remove AG increase").attrs.title).toBe("No AG increase to remove.");
      expect(step("Increase AV to 10+")).toBeTruthy(); // AV rises (9+ -> 10+)
      await free.fire(step("Improve AG to 2+"), "click");
      expect(step("Remove AG increase").attrs["aria-disabled"]).toBeUndefined();
      expect(step("Increase MA").attrs["aria-label"]).toBe("Increase MA: Max 1 per player.");
      expect(step("Increase MA").attrs["aria-disabled"]).toBe("true");
      await free.fire(step("Increase MA"), "click"); // disabled: no change
      const inRow = (e: FakeEl): boolean => { for (let p = e.parent; p; p = p.parent) if (p.attrs["data-row"] !== undefined) return true; return false; };
      expect(free.all().filter((e) => e.attrs["aria-label"] === "Remove +AG" && inRow(e))).toHaveLength(1); // on the roster row
      await free.fire(step("Remove AG increase"), "click");
      expect(free.all().filter((e) => e.attrs["aria-label"] === "Remove +AG")).toHaveLength(0);
      expect(step("Remove AG increase").attrs["aria-disabled"]).toBe("true"); // floors at the printed value
    } finally { free.app.unmount(); }
    const cup = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
    try {
      await cup.fire(cup.find((e) => e.attrs.id === "tb-team-name"), "input", { value: "Reavers" });
      await cup.fire(cup.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Lineman,")), "click");
      await cup.fire(cup.find((e) => e.attrs["aria-label"] === "Add skill for #1 Lineman"), "click");
      expect(textOf(cup.find((e) => e.attrs.id === "tb-picker-h"))).toContain("Advance: #1 Lineman");
      const off = cup.all().filter((e) => e.attrs["data-step"]);
      expect(off).toHaveLength(10); // the tiles stay (current values), every + and − greyed out
      expect(off.every((e) => e.attrs["aria-disabled"] === "true")).toBe(true);
      expect(off.find((e) => e.attrs["data-step"] === "up-ST")!.attrs.title).toBe("This ruleset doesn't allow stat increases.");
      expect(off.find((e) => e.attrs["data-step"] === "down-ST")!.attrs.title).toBe("This ruleset doesn't allow stat increases.");
      expect(cup.all().some((e) => e.attrs["aria-label"] === "Stat increases")).toBe(true);
      expect(cup.all().some((e) => e.tag === "#text" && e.text === "Stat increases")).toBe(false); // no caption (owner 11-01)
      // the elite tag is the diamond (owner 11-01), not the word
      const elite = cup.all().filter((e) => e.tag === "img" && e.attrs.class === "tb-elite");
      expect(elite.length).toBeGreaterThan(0);
      expect(elite[0]!.attrs).toMatchObject({ src: "/icons/builder/elite-diamond.png", alt: "Elite skill", title: "Elite skill" });
      expect(cup.all().some((e) => e.tag === "#text" && e.text === "Elite")).toBe(false);
    } finally { cup.app.unmount(); }
  });

  it("player names (owner 11-01): the name is the row header over the position; click to rename, Escape cancels, Enter saves; reroll", async () => {
    const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", mockFetcher(routes()));
    try {
      await page.fire(page.find((e) => e.attrs.id === "tb-team-name"), "input", { value: "Reavers" });
      await page.fire(page.find((e) => String(e.attrs["aria-label"]).startsWith("Add Human Lineman,")), "click");
      const nameBtn = () => page.find((e) => e.tag === "button" && e.attrs["data-name"] === 0);
      const generated = textOf(nameBtn());
      expect(generated.length).toBeGreaterThan(3);
      expect(nameBtn().attrs.class).toBe("tb-pname");
      expect(textOf(page.find((e) => e.attrs.class === "tb-psub"))).toBe("Lineman"); // the position is the subheader
      const key = async (el: FakeEl, k: string) => { await el.on.keydown?.({ key: k, preventDefault() {}, stopPropagation() {} }); await settle(); };
      const input = () => page.all().find((e) => e.tag === "input" && e.attrs.class === "tb-name-input");
      // click -> the inline field (maxlength 30); Escape cancels
      await page.fire(nameBtn(), "click");
      expect(input()?.attrs.maxlength).toBe(30);
      await page.fire(input()!, "input", { value: "Not Kept" });
      await key(input()!, "Escape");
      expect(input()).toBeUndefined();
      expect(textOf(nameBtn())).toBe(generated);
      // F2 opens it too; Enter saves a trimmed name
      await key(nameBtn(), "F2");
      await page.fire(input()!, "input", { value: "  Gunnar  the Bold " });
      await key(input()!, "Enter");
      expect(textOf(nameBtn())).toBe("Gunnar the Bold");
      // empty keeps the old name
      await page.fire(nameBtn(), "click");
      await page.fire(input()!, "input", { value: "   " });
      await page.fire(input()!, "blur");
      expect(textOf(nameBtn())).toBe("Gunnar the Bold");
      // reroll
      await page.fire(page.find((e) => e.attrs["aria-label"] === "Reroll name for #1"), "click");
      expect(textOf(nameBtn())).not.toBe("Gunnar the Bold");
    } finally { page.app.unmount(); }
  });

  it("skill packs: picking collapses the list into the save line; Change skill pack re-opens it with focus on the chosen pack; re-picking the same pack keeps it", async () => {
    const PACKS = [{ label: "Pack A", gold: 1150000, skillPointBudget: 4 }, { label: "Pack B", gold: 1100000, skillPointBudget: 8 }];
    const f = mockFetcher(routes({ "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "", eligibleRosters: ["Human"] }, rules: { ...RULES, race: { ...RACE, packs: PACKS } } } }));
    const page = await mount("/tournament-team-builder?package=Test%20Cup&race=human", f);
    try {
      const has = (id: string) => page.all().some((e) => e.attrs.id === id);
      const rules = () => page.all().some((e) => e.attrs.class === "tb-rules");
      const pack = (label: string) => page.find((e) => e.tag === "button" && e.attrs.class === "tb-pack" && textOf(e).startsWith(label));
      expect([has("tb-team-packs"), has("tb-valid-h"), rules()]).toEqual([true, false, false]);
      await page.fire(pack("Pack B"), "click");
      expect([has("tb-team-packs"), has("tb-valid-h"), rules()]).toEqual([false, true, true]);
      expect(fakeDocument.activeElement?.attrs.id).toBe("tb-valid-h"); // focus follows to the save line's verdict header
      const change = page.find((e) => e.tag === "button" && textOf(e) === "Change skill pack");
      await page.fire(change, "click");
      expect([has("tb-team-packs"), has("tb-valid-h"), rules()]).toEqual([true, false, false]);
      expect(fakeDocument.activeElement === pack("Pack B")).toBe(true);
      expect(pack("Pack B").attrs["aria-pressed"]).toBe("true");
      await page.fire(pack("Pack B"), "click"); // the same pack: still chosen
      expect(has("tb-valid-h")).toBe(true);
      await page.fire(page.find((e) => e.tag === "button" && textOf(e) === "Change skill pack"), "click");
      expect(pack("Pack B").attrs["aria-pressed"]).toBe("true");
    } finally { page.app.unmount(); }
  });

  const OTHER_RULES = { ...RULES, name: "Other Cup" };
  const otherRoutes = (over: Routes = {}): Routes => routes({
    "/api/packages": [{ name: "Test Cup", description: "A test ruleset" }, { name: "Other Cup" }],
    "/api/packages/Other%20Cup": { pkg: { eligibleRosters: ["Human", "Dwarf"] }, rules: OTHER_RULES },
    "/api/fork/team-builder/tiers?packageName=Other%20Cup": { races: [TIER_ROW] },
    "/api/fork/team-builder/inducements?packageName=Other%20Cup": { inducements: [] },
    ...over,
  });
  const wide = (): void => { (globalThis as any).window.matchMedia = (q: string) => ({ matches: q.includes("min-width") }); };
  const card = (page: { find: (p: (e: FakeEl) => boolean) => FakeEl }, name: string): FakeEl => page.find((e) => e.tag === "button" && e.attrs.class === "tb-card" && textOf(e) === name);
  const hasClass = (e: FakeEl, c: string): boolean => String(e.attrs.class ?? "").split(/\s+/).includes(c);

  it("a re-pick keeps the old table dimmed until the new ruleset's data lands, then crossfades once; mount and deep links never animate", async () => {
    let release!: (v: unknown) => void;
    const later = new Promise((r) => { release = r; });
    const page = await mount("/tournament-team-builder?package=Test%20Cup&tab=ruleset", mockFetcher(otherRoutes({ "/api/packages/Other%20Cup": later })));
    try {
      wide();
      const scroll = () => page.find((e) => hasClass(e, "tb-race-scroll"));
      expect(page.all().every((e) => e.animations.length === 0)).toBe(true); // deep link: straight into place
      expect(hasClass(scroll(), "tb-race-loading")).toBe(false);
      await page.fire(card(page, "Other Cup"), "click");
      expect(hasClass(scroll(), "tb-race-loading")).toBe(true); // still ruleset A's table, dimmed
      expect(scroll().attrs["aria-busy"]).toBe("true");
      expect(scroll().animations).toEqual([]); // no fade while the old table is on screen
      release({ pkg: { eligibleRosters: ["Human", "Dwarf"] }, rules: OTHER_RULES });
      await settle();
      expect(hasClass(scroll(), "tb-race-loading")).toBe(false);
      expect(scroll().animations.map((a) => a.opts.duration)).toEqual([160]); // one crossfade, after the data arrived
      expect(page.all().filter((e) => e !== scroll()).every((e) => e.animations.length === 0)).toBe(true); // no slide on a re-pick
    } finally { page.app.unmount(); }
  });

  it("leaving the Ruleset tab mid-slide cancels every animation and the late finish touches nothing", async () => {
    const page = await mount("/tournament-team-builder?tab=ruleset", mockFetcher(otherRoutes()));
    try {
      wide();
      const rulesets = page.find((e) => hasClass(e, "tb-area-rulesets"));
      await page.fire(card(page, "Test Cup"), "click");
      rulesets.rectLeft = 700; // the layout flip moved the panel right; its first rect was measured at 0
      await settle();
      const flow = page.find((e) => hasClass(e, "tb-rsflow"));
      const live = page.all().flatMap((e) => e.animations);
      expect(live.length).toBe(3); // rulesets slide, summary slide, race pop
      expect(hasClass(flow, "tb-rs-anim")).toBe(true);
      page.app.unmount();
      expect(live.every((a) => a.cancelled)).toBe(true);
      live.forEach((a) => a.finish());
      await settle();
    } finally { try { page.app.unmount(); } catch { /* already unmounted */ } }
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

describe("left accordion five-row window", () => {
  it("rowWindowHeight: the bottom of the 5th row, nothing for five or fewer", async () => {
    const { rowWindowHeight, ROW_WINDOW } = await import("../spa/src/teams/hireWindow");
    expect(ROW_WINDOW).toBe(5);
    const card = (top: number, h: number) => ({ offsetTop: top, offsetHeight: h });
    expect(rowWindowHeight([card(0, 100), card(110, 100), card(220, 100), card(330, 100), card(440, 100)])).toBeUndefined();
    expect(rowWindowHeight([card(0, 100), card(110, 120), card(240, 100), card(350, 140), card(500, 100), card(610, 100)])).toBe(600);
    expect(rowWindowHeight([card(0, 100), card(110, 120), card(240, 100), card(350, 140), card(500, 100)], 4)).toBe(490);
  });

  it("watchRowWindow re-measures on row resize, image load and fonts.ready, re-attaches on rewatch, disconnects on stop", async () => {
    const { watchRowWindow: watchFourCards } = await import("../spa/src/teams/hireWindow");
    const observed = new Set<unknown>();
    let fire: () => void = () => {};
    class FakeRO { constructor(cb: () => void) { fire = cb; } observe(e: unknown) { observed.add(e); } disconnect() { observed.clear(); } }
    let fontsDone: () => void = () => {};
    const g = globalThis as any;
    const saved = { ro: g.ResizeObserver, doc: g.document };
    g.ResizeObserver = FakeRO;
    g.document = { fonts: { ready: new Promise<void>((r) => { fontsDone = r; }) } };
    try {
      const listeners: Record<string, () => void> = {};
      const kids = [1, 2, 3, 4, 5, 6].map((n) => ({ n }));
      const list: any = { children: kids, addEventListener: (t: string, f: () => void) => { listeners[t] = f; }, removeEventListener: (t: string) => { delete listeners[t]; } };
      let calls = 0;
      const w = watchFourCards(list, () => { calls++; }, 4);
      expect([...observed]).toEqual([kids[0], kids[1], kids[2], kids[3], list]); // first four cards + the box, not the rest
      fire(); expect(calls).toBe(1);
      listeners.load!(); expect(calls).toBe(2);
      fontsDone(); await Promise.resolve(); await Promise.resolve(); expect(calls).toBe(3);
      list.children = [{ n: 9 }, ...kids.slice(0, 5)];
      w.rewatch();
      expect(observed.has(list.children[0])).toBe(true);
      w.stop();
      expect(observed.size).toBe(0);
      expect(listeners.load).toBeUndefined();
    } finally { g.ResizeObserver = saved.ro; g.document = saved.doc; }
  });
});

describe("roster scroller, reveal and drag edge (owner 10-31)", () => {
  it("revealRow scrolls the roster scroller when it overflows, else the page; revealTop shows the whole row", async () => {
    const { revealRow, revealTop } = await import("../spa/src/teams/rosterReveal");
    const box = (scrollTop: number) => ({ offsetTop: 0, offsetHeight: 400, scrollTop, clientHeight: 400, scrollHeight: 1200, calls: [] as unknown[], scrollTo(o: unknown) { this.calls.push(o); } });
    expect(revealTop({ offsetTop: 500, offsetHeight: 100 }, box(0))).toBe(200);
    expect(revealTop({ offsetTop: 100, offsetHeight: 100 }, box(300))).toBe(100);
    expect(revealTop({ offsetTop: 100, offsetHeight: 100 }, box(50))).toBeNull();
    const scroller = box(0);
    const row = { offsetTop: 900, offsetHeight: 80, intoView: [] as unknown[], scrollIntoView(o: unknown) { this.intoView.push(o); } };
    revealRow(row, scroller, false);
    expect(scroller.calls).toEqual([{ top: 580, behavior: "smooth" }]); // the container, not the page
    expect(row.intoView).toEqual([]);
    revealRow(row, { ...box(0), scrollHeight: 400 }, true); // not overflowing (stacked layout): the page
    expect(row.intoView).toEqual([{ block: "nearest", behavior: "auto" }]);
  });

  it("rosterHeight fills the viewport below the panel header; edgeStep scrolls near the edges while dragging", async () => {
    const { rosterHeight, edgeStep, ROSTER_MIN_PX } = await import("../spa/src/teams/rosterReveal");
    expect(rosterHeight(1080, 236, 56)).toBe(772);
    expect(rosterHeight(600, 400, 56)).toBe(ROSTER_MIN_PX);
    expect(edgeStep(500, 200, 900)).toBe(0);
    expect(edgeStep(200, 200, 900)).toBe(-16);
    expect(edgeStep(224, 200, 900)).toBe(-8);
    expect(edgeStep(899, 200, 900)).toBeGreaterThan(0);
  });

  it("collapse hooks: a leaving body is inert from the start of its leave; an entering one is not", async () => {
    const { heightEnter, heightLeave } = await import("../spa/src/teams/accordionMotion");
    const attrs: Record<string, string> = {};
    const el: any = { setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; } };
    let done = 0;
    heightLeave(el, () => { done++; });
    expect(attrs.inert).toBe("");
    heightEnter(el, () => { done++; });
    expect(attrs.inert).toBeUndefined();
    expect(done).toBe(2);
  });

  it("accordion motion is instant without matchMedia (and under reduced motion)", async () => {
    const { accordionMotion, ACCORDION_MS } = await import("../spa/src/teams/accordionMotion");
    expect(ACCORDION_MS).toBe(200);
    const g = globalThis as any;
    const saved = g.window;
    try {
      g.window = {};
      expect(accordionMotion()).toBe(false);
      g.window = { matchMedia: (q: string) => ({ matches: q.includes("reduce") }) };
      expect(accordionMotion()).toBe(false);
      g.window = { matchMedia: () => ({ matches: false }) };
      expect(accordionMotion()).toBe(true);
    } finally { g.window = saved; }
  });

  it("builder.css: the roster scroller only in the three-column layout; the skills band and badges use tokens defined in both theme blocks", () => {
    const css = readFileSync(new URL("../spa/src/teams/builder.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(css).toMatch(/@media \(min-width: 1180px\) \{\n  \.tb-roster-scroll \{ overflow-y: auto; overscroll-behavior: contain;/);
    expect(css).not.toMatch(/^\.tb-roster-scroll \{[^}]*overflow/m); // never a nested scroller when stacked
    const dark = css.match(/^\.tb-page \{\n[^}]*\}/m)?.[0] ?? "";
    const light = css.match(/^:root\[data-theme="light"\] \.tb-page \{\n[^}]*\}/m)?.[0] ?? "";
    for (const t of ["--tb-skillbar", "--tb-badge-ink", "--tb-secondary-bar"]) { expect(dark).toContain(`${t}:`); expect(light).toContain(`${t}:`); }
    expect(css).toMatch(/\.tb-row > \.tb-row-skills \{[^}]*background: var\(--tb-skillbar\)/);
    expect(css).toMatch(/\.tb-added\.access-primary \{ box-shadow: inset 0 -3px 0 var\(--ui-heading\); \}/);
    expect(css).toMatch(/\.tb-added\.access-secondary \{ box-shadow: inset 0 -3px 0 var\(--tb-secondary-bar\); \}/);
    expect(css).toMatch(/\.tb-page \.row-skills \.tb-bought \{[^}]*border: 2px solid var\(--ui-gold\)/);
    expect(css).toMatch(/\.tb-captain-img \{ grid-area: 1 \/ 1; width: 40px; height: 40px;/);
    expect(css).not.toMatch(/\.tb-captain-img \{[^}]*pixelated/); // painted art: normal smoothing
  });
});
