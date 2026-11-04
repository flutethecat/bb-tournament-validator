import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  championsVisible, DEFAULT_TITLES, rumbleRoundName, rumbleRounds, settingsLines, stepBody, formOf, titleLines, titlesBody,
  type LadderDetail, type LadderSettings, type LadderView, type TitlesView,
} from "../spa/src/leagues/ladder";
import type { LeagueSummary, SeasonSummary } from "../spa/src/leagues/types";

// Ladder titles in the SPA: the belt holder banner at the top of the Ladder tab, the champion's belt and the MITB badge in the
// ranking, the Title panel (mandatory / eliminator state, title games, contracts with Cash in, title history, organiser
// controls), the Rumble panel (bracket, entry, setup dialog), the wizard's Titles group, and the Current Champions panel's
// visibility rules on the league Overview.

const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
function mockFetcher(routes: Record<string, unknown>): Fetcher {
  return (async (path: string, init?: { method?: string }) => {
    const hit = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    return typeof hit === "function" ? (hit as () => unknown)() : hit;
  }) as Fetcher;
}

const settings = (over: Partial<LadderSettings> = {}): LadderSettings => ({
  ranking: "points", style: "league", minGames: 3, points: { win: 3, draw: 1, loss: 0 }, challengeRange: null, maxOpen: 3, expiryHours: 48, playByDays: 7, rematchDays: 7,
  declineRule: { enabled: false, count: 3, days: 14 }, autoApproveValidated: true, periodDays: null, redraft: { trigger: "period-end", schedule: [], everyGames: 8, tvCap: null },
  titles: { ...DEFAULT_TITLES, belt: true, mitb: { ...DEFAULT_TITLES.mitb, enabled: true } }, ...over,
});
const detail = (over: Partial<LadderDetail> = {}): LadderDetail => ({
  id: "ladder-1", name: "Spring Ladder", state: "active", stateLabel: "Open", ranking: "points", rankingLabel: "Points", style: "league", teamCount: 4, openChallenges: 0,
  description: "", ruleset: "BB2025", rulesetPackage: null, houseRules: {}, playOnFork: false, authorised: true, settings: settings(), paused: "", revision: 4, ...over,
});
const side = (c: string) => ({ teamId: `t-${c.toLowerCase()}`, team: `${c}'s Team`, coach: c, race: "Orc" });
const row = (rank: number, coach: string, over: Record<string, unknown> = {}) => ({
  rank, ...side(coach), played: 3, wins: 2, draws: 0, losses: 1, declineLosses: 0, points: 6, bonus: 0, tdDiff: 1, rating: 1500, ranked: true, latest: ["W", "L", "W"] as Array<"W" | "D" | "L">, teamValue: 1_050_000, ...over,
});
const bout = (kind: "eliminator" | "mandatory", home: string, away: string) => ({
  id: `tb-${kind}`, kind, label: kind === "mandatory" ? "Mandatory defence" : "Eliminator", state: "scheduled" as const, home: side(home), away: side(away),
  deadline: "2026-12-01T12:00:00.000Z", createdAt: "2026-11-10T12:00:00.000Z", fixtureId: `lf-${kind}`,
});
const titles = (over: Partial<TitlesView> = {}): TitlesView => ({
  enabled: true, settings: settings().titles!,
  champion: { ...side("Amy"), since: "2026-11-01T00:00:00.000Z", days: 9, defences: 2, how: "Won the vacant title against Bob's Team", defendBy: "2026-12-01T00:00:00.000Z" },
  interim: null,
  history: [
    { id: "t-amy@1", ...side("Amy"), interim: false, since: "2026-11-01T00:00:00.000Z", days: 9, defences: 2, how: "Beat Bob's Team" },
    { id: "t-bob@0", ...side("Bob"), interim: false, since: "2026-10-20T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z", days: 12, defences: 1, how: "Won the vacant title", ended: "Lost to Amy's Team" },
  ],
  mandatory: { stage: "mandatory", bout: bout("mandatory", "Amy", "Cara") },
  bouts: [bout("mandatory", "Amy", "Cara")], recentBouts: [],
  contracts: [{ id: "tc-1", ...side("Dan"), source: "streak", earnedAt: "2026-11-09T00:00:00.000Z", expiresAt: "2027-02-07T00:00:00.000Z", state: "held", mine: true }],
  rumbles: [{
    id: "ru-1", name: "The Rumble", date: "2026-11-08T19:00:00.000Z", field: "top8", roundDays: 3, points: 5, state: "running", entries: [],
    seeds: ["Amy", "Bob", "Cara", "Dan"].map((c, i) => ({ seed: i + 1, ...side(c) })),
    rounds: [
      { number: 1, deadline: "2026-11-11T19:00:00.000Z", matches: [{ slot: 1, home: side("Amy"), away: side("Dan"), fixtureId: "r1", score: [2, 1], winnerTeamId: "t-amy", how: "result" }, { slot: 2, home: side("Bob"), away: side("Cara"), fixtureId: "r2", winnerTeamId: "t-bob", how: "fallback" }] },
      { number: 2, deadline: "2026-11-14T19:00:00.000Z", matches: [{ slot: 1, home: side("Amy"), away: side("Bob"), fixtureId: "r3" }] },
    ],
  }],
  ...over,
});

describe("titles helpers", () => {
  it("rules lines, the settings PATCH and the form defaults", () => {
    expect(titleLines(undefined)).toEqual([]);
    expect(titleLines({ ...DEFAULT_TITLES })).toEqual([]);
    const lines = titleLines(settings().titles);
    expect(lines.join(" ")).toContain("+2 per defence, +1 per full week held, +3 for winning the belt");
    expect(lines.join(" ")).toContain("21 days to play the mandatory");
    expect(lines.join(" ")).toContain("Money in the Bank: 5 wins in a row");
    expect(settingsLines(settings())).toEqual(expect.arrayContaining([expect.stringContaining("Title belt")]));
    const body = stepBody("settings", formOf(detail())) as { settings: { titles: unknown } };
    expect(body.settings.titles).toEqual(titlesBody(settings().titles!));
    // An old read without titles fills the defaults (belt off).
    const old = detail({ settings: { ...settings(), titles: undefined } });
    expect(formOf(old).settings.titles).toEqual(DEFAULT_TITLES);
    expect(rumbleRounds(8)).toBe(3);
    expect(rumbleRounds(5)).toBe(3);
    expect([0, 1, 2].map((i) => rumbleRoundName(i, 3))).toEqual(["Quarter-finals", "Semi-finals", "Final"]);
  });

  it("the Current Champions panel: an empty part is hidden, and the whole panel when both are", () => {
    expect(championsVisible(null)).toEqual({ cups: false, belts: false, any: false });
    expect(championsVisible({ cups: [], belts: [] }).any).toBe(false);
    expect(championsVisible({ cups: [{ seasonId: "s", seasonName: "S1", label: "Champion", team: "T", coach: "C", race: "R" }], belts: [] })).toEqual({ cups: true, belts: false, any: true });
    expect(championsVisible({ cups: [], belts: [{ ladderId: "l", ladderName: "L", teamId: "t", team: "T", coach: "C", race: "R", since: "x", days: 1, defences: 0 }] })).toEqual({ cups: false, belts: true, any: true });
    const ov = src("components/LeagueOverview.vue");
    expect(ov).toContain('v-if="shown.any"');
    expect(ov).toContain('v-if="shown.cups"');
    expect(ov).toContain('v-if="shown.belts"');
    expect(ov).toContain("/champions");
  });

  it("source pins: the belt glyph is our own token-coloured SVG; the wizard has the Titles group; tokens only", () => {
    const belt = src("components/BeltIcon.vue");
    expect(belt).toContain("currentColor");
    expect(belt).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|<img/i);
    const wiz = src("views/LadderWizardView.vue");
    expect(wiz).toContain('data-field="belt"');
    expect(wiz).toContain('data-field="mitb"');
    for (const f of ["components/LadderTitlePanel.vue", "components/LadderRumblePanel.vue", "leagues/ladder.css"]) expect(src(f)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|font-family/i);
  });
});

describe("Ladder tab with titles: server-rendered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, ladder, vueRouter, renderer, rumble] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/leagues/ladder.ts"), vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/LadderRumblePanel.vue"),
    ]);
    mods = { app, league, ladder, vueRouter, renderer, Rumble: rumble.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const s1: SeasonSummary = { id: "season-1", number: 1, name: "Season 1", ruleset: "BB2025", status: "active", teamCount: 0, fixtureCount: 0, playedCount: 0 };
  const league: LeagueSummary = {
    id: "lg", name: "Rivertown", fullName: "Rivertown BBL", slug: "lg", description: "", organisers: ["Olga"], playOnFork: false, createdAt: "2026-10-01T00:00:00.000Z",
    seasonCount: 1, currentSeason: s1, timeZone: "UTC",
  } as LeagueSummary;
  const view = (t: TitlesView, manage = false): LadderView => ({
    titles: t, ladder: detail(),
    ranking: [row(1, "Amy", { points: 15, bonus: 7 }), row(2, "Cara"), row(3, "Bob"), row(4, "Dan")],
    challenges: { live: [], closed: [] }, results: [], rounds: [], fixtures: [], manage,
    me: { teams: ["t-dan"], targets: { "t-dan": { "t-amy": "", "t-bob": "", "t-cara": "" } } },
  });

  async function render(t: TitlesView, manage = false): Promise<string> {
    const f = mockFetcher({
      "/api/auth/session": { authenticated: true, coach: manage ? "Olga" : "Dan", info: { coach: manage ? "Olga" : "Dan", admin: false } },
      "/api/leagues/lg": { league, seasons: [s1] },
      "/api/leagues/lg/seasons/season-1": { league, season: { id: "season-1", leagueId: "lg", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", importedAt: "x", phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [] } },
      "/api/leagues/lg/events": { timeZone: "UTC", manage: false, events: [] },
      "/api/leagues/lg/ladders": { ladders: [{ ...detail(), fixtures: [] }] },
      "/api/leagues/lg/ladders/ladder-1": view(t, manage),
      "/api/leagues/lg/ladders/ladder-1/join": { status: { open: true, style: "league", autoApprove: true, moves: true, packageName: "x", shareText: "", regions: [] } },
      "/crests/manifest.json": { crests: {} },
    });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("lg");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const l = mods.ladder.createLadders({ api: f });
    await l.loadList("lg");
    await l.open("ladder-1");
    spa.app.provide(mods.ladder.LADDERS_KEY, l);
    await spa.router.push("/leagues/lg?tab=ladder");
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("the belt holder sits at the top with days held and defences; the champion's row has the belt, a contract holder the MITB badge", async () => {
    const html = await render(titles());
    expect(html).toContain('class="ld-belt"');
    expect(html).toMatch(/ld-belt-team">Amy&#39;s Team/);
    expect(html).toContain("9 days");
    expect(html).toMatch(/Defences<\/dt><dd>2/);
    expect(html).toContain("Mandatory: Cara&#39;s Team");
    expect(html).toMatch(/data-team="t-amy"[\s\S]*?ld-row-belt/);
    expect(html).toMatch(/data-team="t-dan"[\s\S]*?class="ld-mitb"/);
    expect(html).toContain("+7"); // the champion's bonus points
  });

  it("the Title panel: the mandatory state, the title game, the coach's contract with Cash in, and the title history", async () => {
    const html = await render(titles());
    expect(html).toContain('data-stage="mandatory"');
    expect(html).toContain("the title passes to Cara&#39;s Team");
    expect(html).toContain('data-bout="mandatory"');
    expect(html).toContain('data-cash-in="tc-1"');
    expect(html).toContain("The champion can&#39;t decline.");
    expect(html).toMatch(/Bob&#39;s Team[\s\S]*?12 days · 1 defence/);
    expect(html).not.toContain('data-title-action="vacate"'); // not an organiser
  });

  it("an eliminator shows as the mandatory spot's stage; a vacant belt says so; organisers get the title controls", async () => {
    const elim = await render(titles({ mandatory: { stage: "eliminator", bout: bout("eliminator", "Cara", "Bob") }, bouts: [bout("eliminator", "Cara", "Bob")] }), true);
    expect(elim).toContain('data-stage="eliminator"');
    expect(elim).toContain("Eliminator: Cara&#39;s Team v Bob&#39;s Team");
    expect(elim).toContain('data-title-action="vacate"');
    expect(elim).toContain('data-title-action="inactive"');
    expect(elim).toContain('data-extend="tb-eliminator"');
    const vacant = await render(titles({ champion: null, history: [], mandatory: { stage: "none" }, bouts: [] }));
    expect(vacant).toContain('data-vacant="true"');
    expect(vacant).toContain("Belt vacant");
  });

  it("the Rumble panel: the bracket with seeds, scores and the better-seed fallback; organisers set one up; open entry offers Enter", async () => {
    const blank = { render: () => null };
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: blank }] });
    await router.push("/x");
    await router.isReady();
    const base = { manage: false, canWrite: true, myTeam: "t-dan", busy: "", error: "", now: Date.parse("2026-11-12T00:00:00.000Z"), points: 5, beltOn: true };
    const app = createSSRApp(mods.Rumble, { ...base, rumbles: titles().rumbles });
    app.use(router);
    const html = (await mods.renderer.renderToString(app)) as string;
    expect(html).toContain("Semi-finals");
    expect(html).toContain("Final");
    expect(html).toContain("Better seed through");
    expect(html).toContain("a guaranteed title shot and 5 points");
    const open = createSSRApp(mods.Rumble, { ...base, rumbles: [{ ...titles().rumbles[0]!, state: "entry", field: "open", seeds: [], rounds: [], date: "2026-11-20T19:00:00.000Z", entries: [side("Bob")] }] });
    open.use(router);
    expect((await mods.renderer.renderToString(open)) as string).toContain('data-rumble="enter"');
    const admin = createSSRApp(mods.Rumble, { ...base, manage: true, rumbles: [] });
    admin.use(router);
    expect((await mods.renderer.renderToString(admin)) as string).toContain('data-rumble="setup"');
  });
});
