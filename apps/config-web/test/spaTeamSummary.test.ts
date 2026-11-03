import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { coachCan, createTeamPage, statStep, summaryFromBuilder, summaryFromLeague, type TeamPageView } from "../spa/src/teams/summary";
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
  advancement: { p1: { count: 1, spp: 0, costs: { chosenPrimary: 8, chosenSecondary: 12 }, primary: ["Guard"], secondary: ["Dodge"] }, p2: { count: 0, spp: 6, costs: { chosenPrimary: 6, chosenSecondary: 10 }, primary: ["Tackle"], secondary: ["Leap"] } },
  skills: ["Block", "Dodge", "Guard", "Tackle"], fixtures: [{ id: "f2", round: 2, phase: "Regular", opponent: "Elves", pending: false }, { id: "f3", round: 3, phase: "Regular", opponent: "Orcs", decision: "leave", pending: false }],
  needDecision: 1, history: [{ at: "2026-11-02T12:00:00.000Z", by: "Jay", kind: "organiser-edit", changes: [{ what: "Treasury", from: "200k", to: "130k" }] }],
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
    const [renderer, vueRouter, summary, menu, status, history, hire, plist, teams] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("/src/components/TeamSummary.vue"), vite.ssrLoadModule("/src/components/TeamPlayerMenu.vue"),
      vite.ssrLoadModule("/src/components/TeamStatusDialog.vue"), vite.ssrLoadModule("/src/components/TeamHistory.vue"), vite.ssrLoadModule("/src/components/TeamHirePanels.vue"),
      vite.ssrLoadModule("/src/components/LeagueParticipantsList.vue"), vite.ssrLoadModule("/src/components/LeagueTeams.vue"),
    ]);
    m = { renderer, vueRouter, Summary: summary.default, Menu: menu.default, Status: status.default, History: history.default, Hire: hire.default, PList: plist.default, Teams: teams.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/:p(.*)*", component: blank }] });
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
