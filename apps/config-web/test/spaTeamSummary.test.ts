import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { coachCan, createTeamPage, loadSharedTeam, statStep, summaryFromBuilder, summaryFromLeague, summaryFromShared, type SharedTeamModel, type TeamPageView } from "../spa/src/teams/summary";
import { ApiError } from "../spa/src/shared/api";
import type { LeagueTeam, SeasonRecord } from "../spa/src/leagues/types";

// Team page v2 (SPA): the shared team summary model, its two adapters (league team, Roster Builder sheet model), the edit
// controller, and the rendered pieces: edit modes, the + menu with the band-aid injury list, the status cog's decision flow
// and the "Inactive" groups.
const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const stats = (over: Record<string, number> = {}) => ({ td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0, ...over });
const team = (over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: "rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Dee", coachId: "Dee", teamValue: 885_000, currentTeamValue: 815_000, treasury: 130_000, rerolls: 1, fans: 3,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "",
  players: [
    { playerId: "p1", number: 1, name: "Zegerd", position: "Dwarf Runner", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: ["Block", "Sprint"], value: 110_000, level: "Experienced",
      availableSpp: 0, niggling: 1, missNextGame: true, stats: stats({ td: 3, spp: 6, blocks: 4 }), seasonsPlayed: 2, injuries: [{ type: "smashed-knee", at: "2026-11-01T00:00:00.000Z" }, { type: "badly-hurt", at: "2026-11-01T00:00:00.000Z" }] },
    { playerId: "p2", number: 4, name: "Dethirord", position: "Troll Slayer", ma: 5, st: 3, ag: 4, pa: 5, av: 9, skills: ["Block", "Hatred (102)"], value: 95_000, level: "Rookie",
      availableSpp: 6, niggling: 0, missNextGame: false, stats: stats({ cas: 2, spp: 6 }) },
  ],
  formerPlayers: [{ playerId: "f1", name: "Getro", position: "Troll Slayer", level: "Rookie", stats: stats({ td: 2, mvp: 1, spp: 8 }) }],
  ...over,
});
const view = (over: Partial<TeamPageView> = {}): TeamPageView => ({
  leagueId: "lg", seasonId: "s1", revision: 7, ruleset: "BB2025", role: { coach: false, organiser: true }, phase: "inseason", gamesPlayed: 2,
  coach: { block: "", rerolls: false, fire: false, staffDown: false, fans: false, advance: true }, team: team(),
  hire: { positions: [{ name: "Dwarf Blocker Lineman", cost: 70_000, max: 16, count: 0, ma: 4, st: 3, ag: 4, pa: 5, av: 10, skills: ["Block"], bigGuy: false }],
    staff: [{ key: "rerolls", label: "Rerolls", price: 100_000, count: 1, min: 0, max: 8 }, { key: "cheerleaders", label: "Cheerleaders", price: 10_000, count: 0, min: 0, max: 12 }], maxBigGuys: 1, maxPlayers: 16 },
  limits: { errors: [], warnings: [] },
  injuries: [
    { key: "badly-hurt", label: "Badly Hurt", text: "Recorded only.", recordOnly: true }, { key: "seriously-hurt", label: "Seriously Hurt", text: "Misses the next game.", mng: "always" },
    { key: "niggling", label: "Niggling Injury", text: "+1 to casualty rolls.", niggling: true, mng: "optional" }, { key: "head-injury", label: "Head Injury", text: "AV −1.", stat: "av", mng: "optional" },
    { key: "smashed-knee", label: "Smashed Knee", text: "MA −1.", stat: "ma", mng: "optional" }, { key: "broken-arm", label: "Broken Arm", text: "PA −1.", stat: "pa", mng: "optional" },
    { key: "neck-injury", label: "Neck Injury", text: "AG −1.", stat: "ag", mng: "optional" }, { key: "dislocated-shoulder", label: "Dislocated Shoulder", text: "ST −1.", stat: "st", mng: "optional" },
    { key: "dead", label: "Dead", text: "Leaves the roster.", dead: true },
  ],
  advancement: {
    p1: { count: 1, spp: 0, costs: { randomPrimary: 4, chosenPrimary: 8, chosenSecondary: 12, characteristic: 16 }, primary: ["Guard"], secondary: ["Dodge"], randomCategories: ["Strength"] },
    p2: { count: 0, spp: 6, costs: { randomPrimary: 3, chosenPrimary: 6, chosenSecondary: 10, characteristic: 14 }, primary: ["Tackle"], secondary: ["Leap"], randomCategories: ["General"] },
  },
  diceLog: [],
  skills: ["Block", "Dodge", "Guard", "Tackle"], fixtures: [{ id: "f2", round: 2, phase: "Regular", opponent: "Elves", pending: false }, { id: "f3", round: 3, phase: "Regular", opponent: "Orcs", decision: "leave", pending: false }],
  needDecision: 1, history: [{ at: "2026-11-02T12:00:00.000Z", by: "Jay", kind: "organiser-edit", changes: [{ what: "Treasury", from: "200k", to: "130k" }] }],
  ...over,
});

/** The share page's model exactly as the server sends it (src/teamShareView.ts SharedTeamView). */
const shared = (over: Partial<SharedTeamModel> = {}): SharedTeamModel => ({
  teamName: "Altdorf Avengers", coach: "Alice", raceName: "Human", crest: "crests/human.png", ruleset: { name: "BB2025 Matched Play", tierLabel: "Tier 2" }, updatedAt: "2026-11-12T00:29:26.070Z",
  players: [
    { name: "Grumbak", number: 1, position: "Ogre", positionFull: "Ogre", isStar: false, captain: false, stats: { MA: 5, ST: 5, AG: "4+", PA: "5+", AV: "10+" },
      printed: [{ name: "Mighty Blow" }, { name: "Bone Head" }], free: [], added: [], statIncreases: [], cost: 140_000, sprite: "sprites/human/ogre.png" },
    { name: "Gus", number: 2, position: "Blitzer", positionFull: "Human Blitzer", isStar: false, captain: true, stats: { MA: 8, ST: 3, AG: "3+", PA: "4+", AV: "9+" },
      printed: [{ name: "Block" }], free: [{ name: "Team Captain" }, { name: "Pro" }], added: [{ name: "Tackle", access: "secondary" }], statIncreases: ["MA"], cost: 85_000, sprite: "sprites/human/blitzer.png" },
    { number: 3, position: "Griff Oberwald", positionFull: "Griff Oberwald", isStar: true, captain: false, stats: { MA: 7, ST: 4, AG: "2+", PA: "3+", AV: "9+" },
      printed: [{ name: "Fend" }], free: [], added: [], statIncreases: [], cost: 280_000, sprite: null },
  ],
  sideline: { reRolls: 2, apothecary: true, assistantCoaches: 1, cheerleaders: 0, dedicatedFans: 1 },
  inducements: [{ name: "Blitzer's Best Kegs", count: 1, icon: "icons/inducements/bloodweiser_kegs.png" }],
  specialRules: ["Old World Classic", "Team Captain"],
  summary: { players: 3, playersCost: 505_000, starsCost: 280_000, skillsCost: 40_000, inducementsCost: 50_000, sidelineCost: 180_000, total: 1_055_000, cap: 1_150_000, primarySkills: 0, secondarySkills: 1 },
  ...over,
});

describe("the shared summary model", () => {
  it("one component in both places: the league team page and the Roster Builder's Summary render TeamSummary", () => {
    expect(src("components/LeagueTeams.vue")).toContain('import TeamSummary from "./TeamSummary.vue";');
    expect(src("components/TournamentBuilderSummary.vue")).toContain('import TeamSummary from "./TeamSummary.vue";');
    expect(src("components/TeamSummary.vue")).toContain('import TeamRosterTable from "./TeamRosterTable.vue";');
    expect(src("components/TournamentBuilderRoster.vue")).toContain('import TeamRosterTable from "./TeamRosterTable.vue";'); // the roster step's table view
  });

  it("a league team: the header strip, rows with level, niggles, lasting injuries and MNG, Seasons Played, former players, counters", () => {
    const s = summaryFromLeague(team(), { shared: (id) => (id === "p2" ? ["Shared total with 1 other: 1 TD"] : []) });
    expect(s.facts.map((f) => [f.label, f.value, f.secondary])).toEqual([
      ["Current team value", "815k", "TV 885k"], ["Treasury", "130k", undefined], ["Rerolls", "1", undefined], ["Fans", "3", undefined],
      ["Assistant coaches", "0", undefined], ["Cheerleaders", "0", undefined], ["Apothecary", "No", undefined], ["Tier", "2", undefined],
    ]);
    expect(s.rows[0]).toMatchObject({ number: 1, sub: ["Experienced", "1 niggling", "Smashed Knee", "misses next game"], seasonsPlayed: 2, mng: true, td: 3, spp: 6, avail: 0, value: 110_000 });
    expect(s.rows[1]!.shared).toEqual(["Shared total with 1 other: 1 TD"]);
    expect(s.counters.map((c) => c.key)).toEqual(["blocks"]);
    expect(s.former).toEqual([{ id: "f1", name: "Getro", position: "Troll Slayer", td: 2, cas: 0, mvp: 1, spp: 8, counters: expect.any(Object) }]);
    expect(s.facts.every((f) => !f.edit)).toBe(true);
    const e = summaryFromLeague(team({ status: "inactive" }), { editable: true });
    expect(e.inactive).toBe(true);
    expect(e.facts.find((f) => f.key === "treasury")!.edit).toEqual({ field: "treasury", kind: "gold", raw: 130_000 });
    expect(e.facts.find((f) => f.key === "apothecary")!.edit).toEqual({ field: "apothecary", kind: "bool", raw: false });
  });

  it("a builder team: the PDF sheet model's rows (printed, captain, added skills, custom-star rules), no season columns", () => {
    const stat = (v: string | number) => ({ value: v, improved: false });
    const model = {
      raceName: "Human", coach: "Alice", teamName: "Reavers", rulesetName: "", sideline: [], inducements: [], specialRules: [], summary: [], keywords: [],
      rows: [
        { number: 1, name: "Liesel", position: "Lineman", positionFull: "Human Lineman", stats: { MA: stat(6), ST: stat(3), AG: stat("3+"), PA: stat("4+"), AV: stat("9+") }, printed: [], added: [{ name: "Dodge", access: "secondary" }],
          captain: true, free: ["Team Captain", "Pro"], statIncreases: [], cost: 50_000, keywords: null, isStar: false },
        { number: 2, name: "", position: "Custom", positionFull: "Custom", stats: { MA: stat(7), ST: stat(4), AG: stat("2+"), PA: stat("-"), AV: stat("10+") }, printed: ["Block"], added: [],
          captain: false, free: [], statIncreases: [], cost: 200_000, keywords: null, isStar: true, specialRules: [{ kind: "rule", name: "Fan Favourite", description: "Fans love them." }] },
      ],
    };
    const s = summaryFromBuilder(model as never, { coach: "Alice", teamValue: 250_000, treasury: 900_000, staff: { reRolls: 2, assistantCoaches: 1, cheerleaders: 0, dedicatedFans: 1, apothecary: 1 }, tier: "Tier 1" });
    expect(s.seasonStats).toBe(false);
    expect(s.caption).toBe("Human · Alice");
    expect(s.rows[0]).toMatchObject({ id: "0", ag: 3, pa: 4, av: 9, sub: ["Team Captain"], skills: [{ name: "Team Captain" }, { name: "Pro" }, { name: "Dodge", added: true, access: "secondary" }] });
    expect(s.rows[1]).toMatchObject({ star: true, pa: null, specialRules: [{ kind: "rule", name: "Fan Favourite", description: "Fans love them." }] });
    expect(s.facts.map((f) => [f.label, f.value])).toContainEqual(["Treasury", "900k"]);
    expect(s.facts.map((f) => [f.label, f.value])).toContainEqual(["Apothecary", "Yes"]);
  });

  it("stat steps: + is better (MA, ST, AV up; AG, PA targets down); coach capabilities follow the server's edit context", () => {
    expect(statStep("ma", 5, true)).toBe(6);
    expect(statStep("av", 9, false)).toBe(8);
    expect(statStep("ag", 3, true)).toBe(2);
    expect(statStep("pa", 4, false)).toBe(5);
    expect(statStep("pa", null, true)).toBeNull();
    expect(coachCan(view())).toMatchObject({ edit: false }); // an organiser only
    expect(coachCan(view({ role: { coach: true, organiser: false } }))).toEqual({ edit: true, hire: true, fire: false, staff: true, advance: true, why: "" });
    const pre = view({ role: { coach: true, organiser: false }, phase: "pregame", coach: { block: "", rerolls: true, fire: true, staffDown: true, fans: true, advance: false } });
    expect(coachCan(pre)).toMatchObject({ fire: true, advance: false });
    expect(coachCan(view({ role: { coach: true, organiser: false }, coach: { block: "This team is inactive in the league.", rerolls: false, fire: false, staffDown: false, fans: false, advance: true } })))
      .toMatchObject({ edit: false, why: "This team is inactive in the league." });
  });
});

describe("portraits, panels and the share page model (owner 11-11)", () => {
  it("league rows carry the race's portrait from the sprite lookup; a missing one, or anything outside the art folders, is none", () => {
    const s = summaryFromLeague(team(), { crest: "/crests/dwarf.png", sprite: (pos) => (pos === "Dwarf Runner" ? "sprites/dwarf/dwarfrunner.png" : pos === "Troll Slayer" ? "https://evil.example/x.png" : "") });
    expect(s.rows.map((r) => r.sprite)).toEqual(["/sprites/dwarf/dwarfrunner.png", ""]);
    expect(s.crest).toBe("/crests/dwarf.png");
    expect(summaryFromLeague(team(), { crest: "javascript:alert(1)" }).crest).toBeUndefined();
    expect(summaryFromLeague(team()).rows.every((r) => r.sprite === "")).toBe(true); // no manifest yet: initials
  });

  it("builder rows take the builder's own sprite path (custom stars wear their pick); the special rules and the inducements panel ride along", () => {
    const stat = (v: string | number) => ({ value: v, improved: false });
    const model = {
      raceName: "Human", coach: "Alice", teamName: "Reavers", rulesetName: "", sideline: [], inducements: [], specialRules: ["Old World Classic"], summary: [], keywords: [],
      rows: [
        { number: 1, name: "Liesel", position: "Lineman", positionFull: "Human Lineman", stats: { MA: stat(6), ST: stat(3), AG: stat("3+"), PA: stat("4+"), AV: stat("9+") }, printed: [], added: [], captain: false, free: [], statIncreases: [], cost: 50_000, keywords: null, isStar: false },
        { number: 2, name: "", position: "Custom", positionFull: "Custom", stats: { MA: stat(7), ST: stat(4), AG: stat("2+"), PA: stat("-"), AV: stat("10+") }, printed: [], added: [], captain: false, free: [], statIncreases: [], cost: 200_000, keywords: null, isStar: true },
      ],
    };
    const s = summaryFromBuilder(model as never, {
      coach: "Alice", teamValue: 250_000, treasury: null, staff: { reRolls: 2, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, apothecary: 0 }, tier: "",
      sprite: (pf) => (pf === "Human Lineman" ? "/sprites/human/lineman.png" : ""), crest: "/crests/human.png",
      inducements: { items: [{ name: "Blitzer's Best Kegs", count: 2, icon: "/icons/inducements/bloodweiser_kegs.png" }], total: 100_000 },
    });
    expect(s.rows.map((r) => r.sprite)).toEqual(["/sprites/human/lineman.png", ""]);
    expect(s.crest).toBe("/crests/human.png");
    expect(s.specialRules).toEqual(["Old World Classic"]);
    expect(s.panels).toEqual({ inducements: { items: [{ name: "Blitzer's Best Kegs", count: 2, icon: "/icons/inducements/bloodweiser_kegs.png" }], total: "100k" } });
  });

  it("the share page model: the strip from the sideline, Team costs against the cap, inducements, portraits; read only and nothing else", () => {
    const s = summaryFromShared(shared());
    expect(s.name).toBe("Altdorf Avengers");
    expect(s.caption).toBe("Human · Alice · BB2025 Matched Play · Tier 2");
    expect(s.crest).toBe("/crests/human.png");
    expect(s.specialRules).toEqual(["Old World Classic", "Team Captain"]);
    expect(s.facts.map((f) => [f.label, f.value])).toEqual([["Team value", "1,055k / 1,150k"], ["Rerolls", "2"], ["Dedicated fans", "1"], ["Assistant coaches", "1"], ["Cheerleaders", "0"], ["Apothecary", "Yes"]]);
    expect(s.facts.every((f) => !f.edit)).toBe(true);
    expect(s.seasonStats).toBe(false);
    expect(s.rows.map((r) => r.sprite)).toEqual(["/sprites/human/ogre.png", "/sprites/human/blitzer.png", ""]); // the star has none: initials
    expect(s.rows[1]).toMatchObject({ name: "Gus", position: "Blitzer", ma: 8, ag: 3, sub: ["Team Captain", "+MA"],
      skills: [{ name: "Block" }, { name: "Team Captain" }, { name: "Pro" }, { name: "Tackle", added: true, access: "secondary" }] });
    expect(s.rows[2]).toMatchObject({ star: true, name: "", sub: ["Star player"] });
    expect(s.panels?.costs?.map((c) => [c.label, c.value, c.tone])).toEqual([
      ["Players", "3", undefined], ["Players cost", "505k", undefined], ["Stars", "280k", undefined], ["Skills", "40k", undefined], ["Inducements", "50k", undefined],
      ["Sideline", "180k", undefined], ["Primary / Secondary", "0 / 1", undefined], ["Total", "1,055k / 1,150k", "total"],
    ]);
    expect(s.panels?.inducements).toEqual({ items: [{ name: "Blitzer's Best Kegs", count: 1, icon: "/icons/inducements/bloodweiser_kegs.png" }], total: "50k" });
    expect(summaryFromShared(shared({ summary: { ...shared().summary, total: 1_200_000 } })).panels?.costs?.at(-1)?.tone).toBe("over");
    // an uploaded avatar replaces the crest; only the avatar route's own shape
    expect(summaryFromShared(shared({ avatarUrl: "/api/fork/teams/t1/avatar?v=3" })).crest).toBe("/api/fork/teams/t1/avatar?v=3");
    expect(summaryFromShared(shared({ avatarUrl: "https://evil.example/a.png" })).crest).toBe("/crests/human.png");
    // fields the model must never read (the owner's save id, the validity findings, anything new) stay out of it
    const extra = { ...shared(), ownerSaveId: "sv_secret1", validity: { valid: false, issues: 1, custom: false, findings: ["SECRET FINDING"] }, rosterId: "human.bb2025", coachEmail: "x@example.com" };
    const json = JSON.stringify(summaryFromShared(extra as SharedTeamModel));
    for (const leak of ["sv_secret1", "SECRET FINDING", "human.bb2025", "x@example.com", "2026-11-12"]) expect(json).not.toContain(leak);
  });

  it("loading a share: a malformed token never asks; the server's 404 is gone; other failures are an error line", async () => {
    const calls: string[] = [];
    const ok = (async (path: string) => { calls.push(path); return { team: shared() }; }) as never;
    expect(await loadSharedTeam(ok, "../../x")).toEqual({ gone: true });
    expect(await loadSharedTeam(ok, "A".repeat(32))).toEqual({ gone: true });
    expect(calls).toEqual([]);
    expect(await loadSharedTeam(ok, "a".repeat(32))).toEqual({ team: shared() });
    expect(calls).toEqual([`/api/fork/team-builder/shared/${"a".repeat(32)}`]);
    expect(await loadSharedTeam((async () => { throw new ApiError(404, "This team link is no longer available."); }) as never, "a".repeat(32))).toEqual({ gone: true });
    expect(await loadSharedTeam((async () => { throw new ApiError(500, "boom"); }) as never, "a".repeat(32))).toEqual({ error: "Couldn't load this team (boom)." });
  });
});

describe("the edit controller", () => {
  it("loads the edit context; anyone else (403) gets none; writes carry the revision, run one at a time and keep the latest view", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    let rev = 7;
    const api = (async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, body: init?.body });
      if (path.endsWith("/manage")) { if (path.includes("/nope/")) throw Object.assign(new Error("Only this team's coach and the league's organisers can manage it."), { status: 403 }); return { view: view({ revision: rev }) }; }
      if ((init?.body as { ops?: Array<{ value?: unknown }> }).ops?.[0]?.value === "boom") throw new Error("Number 7 is already taken.");
      rev += 1;
      return { view: view({ revision: rev }) };
    }) as never;
    const saved: string[] = [];
    const page = createTeamPage(api, (_v, kind) => { saved.push(kind); });
    await page.load("lg", "s1", "nope");
    expect(page.state.view).toBeNull();
    await page.load("lg", "s1", "rollers");
    expect(page.state.view?.revision).toBe(7);
    const a = page.edit("organiser", [{ op: "team", field: "treasury", value: 100_000 }]);
    const b = page.edit("organiser", [{ op: "team", field: "fans", value: 2 }]);
    expect(await a).toBe("");
    expect(await b).toBe("");
    const writes = calls.filter((c) => c.path.endsWith("/edit"));
    expect(writes.map((w) => (w.body as { revision: number }).revision)).toEqual([7, 8]); // the second waited for the first
    expect(writes[0]!.path).toBe("/api/leagues/lg/seasons/s1/teams/rollers/edit");
    expect(writes[0]!.body).toEqual({ revision: 7, mode: "organiser", ops: [{ op: "team", field: "treasury", value: 100_000 }] });
    expect(await page.edit("coach", [{ op: "player", playerId: "p1", field: "name", value: "boom" }])).toBe("Number 7 is already taken.");
    expect(page.state.error).toBe("Number 7 is already taken.");
    await page.setStatus("inactive", { all: "cancel" });
    await page.decide({ decisions: [{ fixtureId: "f2", decision: "forfeit" }] });
    expect(calls.at(-2)).toMatchObject({ path: "/api/leagues/lg/seasons/s1/teams/rollers/status", body: { revision: 9, status: "inactive", all: "cancel" } });
    expect(calls.at(-1)).toMatchObject({ path: "/api/leagues/lg/seasons/s1/teams/rollers/fixtures", body: { revision: 10, decisions: [{ fixtureId: "f2", decision: "forfeit" }] } });
    expect(saved).toEqual(["edit", "edit", "status", "fixtures"]);
  });
});

describe("rendered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, summary, menu, status, history, hire, plist, teams, share] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("/src/components/TeamSummary.vue"), vite.ssrLoadModule("/src/components/TeamPlayerMenu.vue"),
      vite.ssrLoadModule("/src/components/TeamStatusDialog.vue"), vite.ssrLoadModule("/src/components/TeamHistory.vue"), vite.ssrLoadModule("/src/components/TeamHirePanels.vue"),
      vite.ssrLoadModule("/src/components/LeagueParticipantsList.vue"), vite.ssrLoadModule("/src/components/LeagueTeams.vue"), vite.ssrLoadModule("/src/views/TeamShareView.vue"),
    ]);
    m = { renderer, vueRouter, Summary: summary.default, Menu: menu.default, Status: status.default, History: history.default, Hire: hire.default, PList: plist.default, Teams: teams.default, Share: share.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/tournament-team-builder/:saveId?", name: "tournament-team-builder", component: blank }, { path: "/:p(.*)*", component: blank }] });
    await router.push("/leagues/lg?tab=participants");
    await router.isReady();
    const app = createSSRApp(component as never, props);
    app.use(router);
    return ((await m.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }
  const ORGANISER_CAN = { rename: true, renumber: true, fire: true, plus: true, stats: true, numbers: true, mng: true, removeSkill: "all" };

  it("reading: no inputs; the table shows the season columns, Seasons Played when any, and Left the roster", async () => {
    const html = await render(m.Summary, { team: summaryFromLeague(team()) });
    expect(html).toContain("data-team-summary");
    expect(html).not.toContain("<input");
    expect(html).toContain(">Avail.</th>");
    expect(html).toContain('title="Seasons Played">Seas.</th>');
    expect(html).toContain("Block, Sprint");
    expect(html).toContain("Experienced · 1 niggling · Smashed Knee · misses next game");
    expect(html).toContain("Left the roster");
    expect(html).toContain(">815k <small class=\"lg-tv-secondary\">TV 885k</small>");
  });

  it("organiser edit mode: every number an input, +/- over the five stats, MNG toggles, removable skills, the row + and fire", async () => {
    const html = await render(m.Summary, { team: summaryFromLeague(team(), { editable: true }), mode: "organiser", can: ORGANISER_CAN });
    expect(html).toContain('aria-label="Treasury in thousands"');
    expect(html).toContain('aria-label="Rerolls"');
    expect(html).toContain('aria-label="Apothecary"');
    for (const s of ["MA", "ST", "AG", "PA", "AV"]) {
      expect(html).toContain(`aria-label="Raise ${s} of Zegerd #1"`);
      expect(html).toContain(`aria-label="Lower ${s} of Zegerd #1"`);
    }
    expect(html.match(/> MNG<\/label>/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Seasons Played of Zegerd #1"');
    expect(html).toContain('aria-label="Value of Zegerd #1 in thousands"');
    expect(html).toContain('aria-label="Remove Hatred (102) from Dethirord #4"');
    expect(html).toContain('aria-label="Add skill or injury for Zegerd #1"');
    expect(html).toContain('aria-label="Fire Zegerd #1"');
  });

  it("coach editing: names and numbers only; the + only where advancements are on; no steppers", async () => {
    const html = await render(m.Summary, { team: summaryFromLeague(team()), mode: "coach", can: { rename: true, renumber: true, plus: true } });
    expect(html).toContain('aria-label="Name for Dwarf Runner #1"');
    expect(html).toContain('aria-label="Number for Zegerd #1"');
    expect(html).not.toContain("Raise MA");
    expect(html).not.toContain("Fire Zegerd");
    expect(html).toContain('aria-label="Add skill for Zegerd #1"');
  });

  it("the + menu: the organiser's band-aid tab lists the injury table with descriptions; MNG optional on lasting ones, always for Seriously Hurt", async () => {
    const html = await render(m.Menu, { view: view(), playerId: "p1", mode: "organiser", initial: "injury" });
    expect(html).toContain('class="ts-ico"'); // the in-house band-aid
    expect(html).toContain("Injury</button>");
    expect(html.match(/data-injury="/g)).toHaveLength(9);
    for (const label of ["Head Injury", "Smashed Knee", "Broken Arm", "Neck Injury", "Dislocated Shoulder", "Niggling Injury", "Dead", "Seriously Hurt", "Badly Hurt"]) expect(html).toContain(`<strong>${label}</strong>`);
    expect(html.match(/Also misses the next game/g)).toHaveLength(6); // five lasting injuries + niggling
    expect(html).toContain("Sets MNG");
    expect(html).toContain("Record death");
    const skill = await render(m.Menu, { view: view(), playerId: "p1", mode: "organiser" });
    expect(skill).toContain('placeholder="Search or type a skill"');
    expect(skill).toContain(">Guard</button>");
    expect(skill).not.toContain(">Block</button>"); // already owned
  });

  it("the + menu for an in-season coach: Primary and Secondary with this advancement's SPP price; unaffordable skills disabled", async () => {
    const poor = await render(m.Menu, { view: view({ role: { coach: true, organiser: false } }), playerId: "p1", mode: "coach" });
    expect(poor).toContain("Primary · 8 SPP");
    expect(poor).toContain("Secondary · 12 SPP");
    expect(poor).toMatch(/<button type="button" class="sf-btn small" disabled title="Needs 8 SPP">Guard<\/button>/);
    expect(poor).not.toContain("data-injury");
    const rich = await render(m.Menu, { view: view({ role: { coach: true, organiser: false } }), playerId: "p2", mode: "coach" });
    expect(rich).toMatch(/<button type="button" class="sf-btn small">Tackle<\/button>/);
    expect(rich).toMatch(/disabled title="Needs 10 SPP">Leap</);
  });

  it("advancement by roll in the + menu: the two roll options with their BB2025 prices; a waiting roll replaces them and resurfaces settled", async () => {
    const coach = { role: { coach: true, organiser: false } };
    const open = await render(m.Menu, { view: view(coach), playerId: "p2", mode: "coach" });
    expect(open).toContain("Random Primary skill");
    expect(open).toMatch(/data-roll-category="General"/);
    expect(open).toContain("Advance Characteristic");
    expect(open).toMatch(/disabled title="Needs 14 SPP \(has 6\)\."/); // the D8 costs more than p2 has: no roll offered
    const withPending = (pendingAdvance: Record<string, unknown>) => {
      const v = view(coach);
      v.team.players = v.team.players.map((p) => (p.playerId === "p2" ? { ...p, pendingAdvance } : p)) as typeof v.team.players;
      return v;
    };
    const random = await render(m.Menu, { view: withPending({ id: "r1", kind: "randomPrimary", at: "2026-11-03T10:00:00.000Z", by: "Dee", cost: 3, count: 0, category: "General", rolls: [{ dice: [1, 1], skill: "Block", rerolled: true }, { dice: [1, 2], skill: "Dauntless" }, { dice: [4, 6], skill: "Wrestle" }], choices: ["Dauntless", "Wrestle"] }), playerId: "p2", mode: "coach" });
    expect(random).toMatch(/data-pick="Dauntless"/);
    expect(random).toMatch(/data-pick="Wrestle"/);
    expect(random).toContain("This roll is saved");
    expect(random).not.toContain("Primary � 6 SPP"); // other advancements wait for the pick
    const d8 = await render(m.Menu, { view: withPending({ id: "r2", kind: "characteristic", at: "2026-11-03T10:00:00.000Z", by: "Dee", cost: 14, count: 0, roll: 7, choices: ["AG", "ST"], skills: { primary: ["Tackle"], secondary: ["Leap"] } }), playerId: "p2", mode: "coach" });
    expect(d8).toMatch(/class="d8-stage" data-phase="settled" data-play="false"/); // no replay, no new roll
    expect(d8).toMatch(/data-stat="AG"/);
    expect(d8).toMatch(/data-stat="ST"/);
    expect(d8).toContain("Choose Skill");
  });

  it("the status cog: Active / Inactive, never auto-cancel, per-fixture choices and the bulk actions; decide mode shows only the fixtures", async () => {
    const html = await render(m.Status, { view: view(), start: "status" });
    expect(html).toContain('value="active"');
    expect(html).toContain('value="inactive"');
    expect(html).toContain("Unplayed fixtures are never cancelled automatically.");
    expect(html).toContain('aria-label="Decision for round 2 against Elves"');
    expect(html).toContain(">Decide later</option>");
    for (const b of ["Cancel (no result)", "Forfeit (opponent wins)", "Leave scheduled"]) expect(html).toContain(`>${b}</button>`);
    const decide = await render(m.Status, { view: view({ team: team({ status: "inactive" }) }), start: "decide" });
    expect(decide).not.toContain('value="active"');
    expect(decide).toContain("Unplayed fixtures");
  });

  it("history (coach and organisers): collapsed with a count; the hire accordion mirrors the Roster Builder's panels", async () => {
    const h = await render(m.History, { entries: view().history });
    expect(h).toContain("1 change · coach and organisers only");
    const hire = await render(m.Hire, { view: view({ role: { coach: true, organiser: false } }), mode: "coach" });
    expect(hire).toContain('<span class="tb-acc-title">Hireable players</span>');
    expect(hire).toContain('<span class="tb-acc-title">Sideline staff</span>');
    expect(hire).toContain('aria-label="Hire Dwarf Blocker Lineman, 70k"');
    expect(hire).toContain("Treasury <b>130k</b>");
  });

  it("the portrait column: TabletopRosterRow's sprite frame with the art, initials when there is none; not in the organiser's edit mode", async () => {
    const s = summaryFromLeague(team(), { sprite: (pos) => (pos === "Dwarf Runner" ? "/sprites/dwarf/dwarfrunner.png" : "") });
    const html = await render(m.Summary, { team: s });
    expect(html).toContain('<span class="tn-sr">Portrait</span>');
    expect(html.match(/data-sprite-cell/g)).toHaveLength(2);
    expect(html).toContain('<span class="sprite-frame ts-sprite" aria-hidden="true"><span class="sprite-fallback">DR</span><img class="sprite-image" src="/sprites/dwarf/dwarfrunner.png" alt="" loading="lazy" decoding="async">');
    expect(html).toContain('<span class="sprite-frame ts-sprite" aria-hidden="true"><span class="sprite-fallback">TS</span></span>'); // no art: initials only
    expect(await render(m.Summary, { team: summaryFromShared(shared()) })).toContain('<span class="sprite-fallback">GO</span></span>'); // a star without art: its initials
    const organiser = await render(m.Summary, { team: summaryFromLeague(team(), { editable: true }), mode: "organiser", can: ORGANISER_CAN });
    expect(organiser).not.toContain("data-sprite-cell");
    const coach = await render(m.Summary, { team: s, mode: "coach", can: { rename: true, renumber: true } });
    expect(coach).toContain("data-sprite-cell");
  });

  it("the identity block: crest (initials until it loads), the special rules beside the caption; added skills marked in the read-only table", async () => {
    const html = await render(m.Summary, { team: summaryFromShared(shared()) });
    expect(html).toContain('<span class="sprite-frame crest-frame ts-crest" aria-hidden="true" data-team-crest><span class="sprite-fallback">AA</span><img class="crest-image" src="/crests/human.png"');
    expect(html).toContain('aria-label="Special rules" data-special-rules>Old World Classic / Team Captain</small>');
    expect(html).toContain('<span class="ts-secondary ts-skill ts-added" title="Secondary skill added">Tackle</span>');
    expect(html).toContain("Block, Team Captain, Pro, ");
    const plain = await render(m.Summary, { team: summaryFromLeague(team()) });
    expect(plain).toContain('<span class="sprite-fallback">GR</span></span>'); // no crest given: the team's initials
    expect(plain).not.toContain("data-special-rules");
    expect(plain).not.toContain("data-summary-panels"); // the league page has no panel row
  });

  it("the panel row: Team costs and Inducements from the model, right of the roster when nothing stands on its left", async () => {
    const html = await render(m.Summary, { team: summaryFromShared(shared()) });
    expect(html).toContain('<div class="ts-with-side ts-layout">');
    expect(html).toContain("data-summary-costs");
    expect(html).toMatch(/<div data-tone="total"><dt>Total<\/dt><dd>1,055k \/ 1,150k<\/dd><\/div>/);
    expect(html).toMatch(/<li><img class="ts-ind-icon" src="\/icons\/inducements\/bloodweiser_kegs.png"[^>]*><span>Blitzer&#39;s Best Kegs<\/span><b>1<\/b><\/li>/);
    const none = await render(m.Summary, { team: summaryFromShared(shared({ inducements: [] })) });
    expect(none).toContain('<p class="hm-empty hm-small">None</p>');
  });

  it("the share page: the shared summary read only (no inputs, no edit, hire or save controls), the owner's link only for the owner", async () => {
    const html = await render(m.Share, { token: "a".repeat(32), initial: shared() });
    expect(html).toContain("data-team-share");
    expect(html).toContain("data-team-summary");
    expect(html).toContain('class="lg-table lg-players ts-table"');
    expect(html).toContain('<h2 id="ts-share-h">Altdorf Avengers</h2>');
    expect(html).toContain('src="/sprites/human/ogre.png"');
    expect(html).toContain("data-summary-costs");
    expect(html).toContain("data-summary-inducements");
    expect(html).toContain("Updated 12 Nov 2026");
    for (const control of ["<input", "<select", "data-edit-team", "data-edit-mode", "data-builder-edit", "tb-acc-title", "Fire ", "Add skill", "Save Team", "Export PDF", "data-owner-link"]) expect(html).not.toContain(control);
    const owner = await render(m.Share, { token: "a".repeat(32), initial: shared({ ownerSaveId: "sv_abc123" }) });
    expect(owner).toMatch(/<a href="\/app\/tournament-team-builder\/sv_abc123" class="sf-btn small" data-owner-link>Open in Roster Builder<\/a>/);
  });

  it("the league team page: the crest from the league's crests and the portrait column (initials until the sprite set loads)", async () => {
    const season = { id: "s1", name: "Season 1", teams: [team()], unattributedStats: [] } as unknown as SeasonRecord;
    const html = await render(m.Teams, { season, team: "rollers", leagueId: "lg", crests: { dwarf: "crests/dwarf.png" } });
    expect(html).toContain("data-team-summary");
    expect(html).toContain('class="crest-image" src="/crests/dwarf.png"');
    expect(html.match(/data-sprite-cell/g)).toHaveLength(2);
    expect(html).not.toContain("data-summary-panels");
  });

  it("inactive teams sit under their own collapsed Inactive group (participants list and team tiles)", async () => {
    const season = { id: "s1", name: "Season 1", teams: [team(), { ...team(), id: "gone", name: "Gone Team", status: "inactive" }], unattributedStats: [] } as unknown as SeasonRecord;
    const plist = await render(m.PList, { season, leagueId: "lg", crests: {} });
    expect(plist).toContain("Inactive (1)");
    expect(plist).not.toContain("Gone Team"); // collapsed
    expect(plist.match(/data-team="/g)).toHaveLength(1);
    const tiles = await render(m.Teams, { season, team: "", leagueId: "lg", crests: {} });
    expect(tiles).toContain("Inactive (1)");
    expect(tiles).not.toContain("Gone Team");
  });
});
