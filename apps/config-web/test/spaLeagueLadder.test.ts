import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { ladderFixtureItems, type CalendarContext } from "../spa/src/leagues/seasonCalendar";
import { formOf, pickLadder, rankingColumns, settingsLines, stepBody, timeLeft, type LadderDetail, type LadderSettings, type LadderView } from "../spa/src/leagues/ladder";
import { leagueFacts, SECTION_TABS, visibleTabs } from "../spa/src/shell/sectionNav";
import type { LeagueFixture, LeagueSummary, SeasonSummary } from "../spa/src/leagues/types";

// League ladders in the SPA (lane 8b): the Ladder tab in the league header (shown while a ladder is visible), the picker,
// the ranking columns per method (position ladders keep the rating column), the challenge buttons and their reasons, the
// challenge dialogs (decline-rule warning), the scheduling hand-off to Propose a time, the wizard's step bodies and Review
// lines, the management group, and ladder fixtures on the league calendar.

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
  ranking: "position", style: "league", minGames: 3, points: { win: 3, draw: 1, loss: 0 }, challengeRange: 3, maxOpen: 3, expiryHours: 48, playByDays: 7, rematchDays: 7,
  declineRule: { enabled: true, count: 3, days: 14 }, autoApproveValidated: true, periodDays: null, redraft: { trigger: "period-end", schedule: [], everyGames: 8, tvCap: null }, ...over,
});
const detail = (over: Partial<LadderDetail> = {}): LadderDetail => ({
  id: "ladder-1", name: "Spring Ladder", state: "active", stateLabel: "Open", ranking: "position", rankingLabel: "Position swap", style: "league", teamCount: 3, openChallenges: 1,
  description: "", ruleset: "BB2025", rulesetPackage: null, houseRules: {}, playOnFork: false, authorised: true, settings: settings(), paused: "", revision: 4, ...over,
});
const row = (rank: number, coach: string, over: Record<string, unknown> = {}) => ({
  rank, teamId: `t-${coach.toLowerCase()}`, team: `${coach}'s Team`, race: "Orc", coach, played: 2, wins: 1, draws: 0, losses: 1, declineLosses: 0, points: 3, tdDiff: 1,
  rating: 1500 + (10 - rank) * 10, ranked: true, latest: ["W", "L"] as Array<"W" | "D" | "L">, teamValue: 1_050_000, ...over,
});
const fixture = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, suspended: false,
  home: { team: "Amy's Team", teamId: "t-amy", coach: "Amy", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Dan's Team", teamId: "t-dan", coach: "Dan", race: "Dwarf", score: null, cas: null, conceded: false }, ...over,
} as LeagueFixture);

describe("ladder helpers", () => {
  it("columns per method: position ladders still show the rating; rating and points lead with their own figure", () => {
    expect(rankingColumns("position")).toEqual(["record", "rating", "form"]);
    expect(rankingColumns("rating")[0]).toBe("rating");
    expect(rankingColumns("points")[0]).toBe("points");
  });

  it("the picker: ?ladder= when it names one, else the first open ladder", () => {
    const list = [{ id: "ladder-1", state: "closed" as const }, { id: "ladder-2", state: "active" as const }];
    expect(pickLadder(list, "ladder-1")?.id).toBe("ladder-1");
    expect(pickLadder(list, undefined)?.id).toBe("ladder-2");
    expect(pickLadder(list, "nope")?.id).toBe("ladder-2");
  });

  it("the rules lines say the decline rule, the play-by window and auto-approval in plain words", () => {
    const lines = settingsLines(settings({ endsAt: "2027-03-01T00:00:00.000Z", periodDays: 28 })).join(" ");
    expect(lines).toContain("Challenge up to 3 places above.");
    expect(lines).toContain("3 declines within 14 days count as a loss.");
    expect(lines).toContain("play within 7 days");
    expect(lines).toContain("join straight away");
    expect(lines).toContain("Redraft at each period end.");
    expect(timeLeft(new Date(Date.now() + 50 * 3_600_000).toISOString(), Date.now())).toBe("2 days left");
  });

  it("the wizard's step bodies: General, Rules, Ladder settings (weeks to days, k to gold, blank = none), Review completes", () => {
    const f = formOf(detail());
    f.name = "Winter";
    f.periodWeeks = "4";
    f.tvCapK = "1400";
    f.endsAt = "2027-02-01";
    expect(stepBody("general", f)).toEqual({ general: { name: "Winter", description: "", playOnFork: false } });
    expect(stepBody("rules", f)).toMatchObject({ rules: { ruleset: "BB2025", rulesetPackage: null } });
    const s = stepBody("settings", f) as { settings: Record<string, unknown> };
    expect(s.settings).toMatchObject({ ranking: "position", periodDays: 28, endsAt: "2027-02-01T23:59:00.000Z", redraft: { tvCap: 1_400_000 } });
    f.periodWeeks = ""; f.tvCapK = ""; f.endsAt = "";
    expect((stepBody("settings", f) as { settings: Record<string, unknown> }).settings).toMatchObject({ periodDays: null, endsAt: null, redraft: { tvCap: null } });
    expect(stepBody("review", f)).toEqual({ complete: true });
  });

  it("the Ladder tab sits after Standings and shows only while the league has a visible ladder; ladder fixtures put the Calendar up", () => {
    expect(SECTION_TABS.league.map((t) => t.id).indexOf("ladder")).toBe(SECTION_TABS.league.map((t) => t.id).indexOf("standings") + 1);
    const none = leagueFacts({ seasons: [], ladders: 0 });
    expect(visibleTabs("league", "lg", none).map((t) => t.id)).not.toContain("ladder");
    const some = leagueFacts({ seasons: [], ladders: 2, ladderDated: true });
    expect(visibleTabs("league", "lg", some).map((t) => t.id)).toEqual(expect.arrayContaining(["ladder", "calendar"]));
  });

  it("ladder fixtures on the league calendar link through the ladder and name it", () => {
    const ctx: CalendarContext = { leagueId: "lg", seasonId: "season-3", zone: "UTC" };
    const items = ladderFixtureItems([{ id: "ladder-1", name: "Spring Ladder", fixtures: [fixture("lf-1", { scheduledTime: { start: "2026-11-12T19:00:00.000Z", end: "2026-11-12T21:00:00.000Z", agreedAt: "x" } })] }], ctx);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "ladder:ladder-1:fixture:lf-1", day: "2026-11-12", detail: "Spring Ladder · Challenge", state: "agreed" });
    expect(items[0]!.to).toContain("/seasons/ladder-1/fixtures/lf-1/lobby");
  });

  it("source pins: the management group, the wizard route, the scheduling hand-off, tokens only", () => {
    expect(src("views/LeagueSettingsView.vue")).toContain('{ id: "ladders", label: "Ladders" }');
    expect(src("router.ts")).toContain('name: "league-ladder-setup"');
    const tab = src("components/LeagueLadder.vue");
    expect(tab).toContain("<ProposeDialog");
    expect(tab).toContain("scheduleApi.propose");
    const css = src("leagues/ladder.css");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(css).not.toMatch(/font-family/);
  });
});

describe("Ladder tab: server-rendered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, ladder, vueRouter, renderer, dialog, settingsPanel] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/leagues/ladder.ts"), vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/LadderChallengeDialog.vue"), vite.ssrLoadModule("/src/components/LeagueSettingsLadders.vue"),
    ]);
    mods = { app, league, ladder, vueRouter, renderer, Dialog: dialog.default, Settings: settingsPanel.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const s1: SeasonSummary = { id: "season-1", number: 1, name: "Season 1", ruleset: "BB2025", status: "active", teamCount: 0, fixtureCount: 0, playedCount: 0 };
  const league: LeagueSummary = {
    id: "lg", name: "Rivertown", fullName: "Rivertown BBL", slug: "lg", description: "", organisers: ["Olga"], playOnFork: false, createdAt: "2026-10-01T00:00:00.000Z",
    seasonCount: 1, currentSeason: s1, timeZone: "UTC",
  } as LeagueSummary;
  const view = (ranking: "position" | "rating" | "points"): LadderView => ({
    ladder: detail({ ranking, rankingLabel: ranking === "position" ? "Position swap" : ranking === "rating" ? "Rating" : "Points", settings: settings({ ranking }) }),
    ranking: [row(1, "Amy"), row(2, "Bob", { change: 1 }), row(3, "Dan", ranking === "rating" ? { ranked: false, played: 1 } : {})],
    challenges: { live: [{ id: "lc-1", state: "open", challenger: { teamId: "t-dan", team: "Dan's Team", coach: "Dan", race: "Dwarf" }, defender: { teamId: "t-amy", team: "Amy's Team", coach: "Amy", race: "Orc" }, createdAt: "2026-11-10T00:00:00.000Z", expiresAt: "2026-11-12T00:00:00.000Z", mine: "challenger" }], closed: [] },
    results: [{ fixtureId: "f1", home: { team: "Amy's Team", score: 2 }, away: { team: "Bob's Team", score: 1 }, at: "2026-11-09T20:00:00.000Z", kind: "challenge" }],
    rounds: [], fixtures: [], manage: false,
    me: { teams: ["t-dan"], targets: { "t-dan": { "t-amy": "", "t-bob": "These two teams already have a challenge open." } } },
  });

  async function render(ranking: "position" | "rating" | "points"): Promise<string> {
    const f = mockFetcher({
      "/api/auth/session": { authenticated: true, coach: "Dan", info: { coach: "Dan", admin: false } },
      "/api/leagues/lg": { league, seasons: [s1] },
      "/api/leagues/lg/seasons/season-1": { league, season: { id: "season-1", leagueId: "lg", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", importedAt: "x", phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [] } },
      "/api/leagues/lg/events": { timeZone: "UTC", manage: false, events: [] },
      "/api/leagues/lg/ladders": { ladders: [{ ...detail({ ranking }), fixtures: [] }, { ...detail({ id: "ladder-2", name: "Autumn Ladder", state: "closed", stateLabel: "Closed" }), fixtures: [] }] },
      "/api/leagues/lg/ladders/ladder-1": view(ranking),
      "/api/leagues/lg/ladders/ladder-1/join": { status: { open: true, style: "league", autoApprove: true, moves: true, packageName: "league:lg:ladder-1", shareText: "", regions: [] }, mine: { id: "lr-1", state: "accepted", teamName: "Dan's Team", race: "Dwarf", kind: "new", enteredAt: "x" } },
      "/crests/manifest.json": { crests: {} },
    });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("lg");
    expect(d.state.ladders).toHaveLength(2);
    const l = mods.ladder.createLadders({ api: f });
    await l.loadList("lg");
    await l.open("ladder-1");
    await l.loadJoin();
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    spa.app.provide(mods.ladder.LADDERS_KEY, l);
    await spa.router.push("/leagues/lg?tab=ladder");
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("the header shows the Ladder tab; the picker lists both ladders; ranking, challenges, results and rules render", async () => {
    const html = await render("position");
    expect(html).toMatch(/>Ladder<\/a>/);
    expect(html).toContain('data-ladder="ladder-1"');
    expect(html).toContain('data-ladder="ladder-2"');
    expect(html).toContain('data-ranking="position"');
    expect(html).toContain(">Rating</th>"); // position ladders keep the rating column
    expect(html).toContain('data-challenge-id="lc-1"');
    expect(html).toContain("Amy&#39;s Team");
    expect(html).toContain("Challenge up to 3 places above.");
    expect(html).toContain("On the ladder: Dan&#39;s Team");
  });

  it("challenge buttons follow the server's targets: allowed is enabled; refused is disabled with the reason as its title; own row says You", async () => {
    const html = await render("position");
    // (server-rendered without a session, every button is disabled; the titles carry the server's answer)
    expect(html).toMatch(/<button[^>]*data-challenge="t-amy"[^>]*title="Challenge Amy&#39;s Team"/);
    expect(html).toMatch(/<button[^>]*data-challenge="t-bob"[^>]*title="These two teams already have a challenge open\."/);
    expect(html).toMatch(/data-team="t-dan"[\s\S]*?>You</);
  });

  it("rating ladders lead with the rating and show unranked teams' progress to the minimum games; points ladders show points", async () => {
    const rating = await render("rating");
    expect(rating).toContain("1/3 games");
    expect(rating).toContain('class="ld-unranked"');
    const points = await render("points");
    expect(points).toContain(">Pts</th>");
  });

  it("the answer dialog warns when a decline would count as a loss; Accept hands over to Propose a time", async () => {
    const blank = { render: () => null };
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: blank }] });
    await router.push("/x");
    await router.isReady();
    const app = createSSRApp(mods.Dialog, { mode: "answer", settings: settings(), challenge: view("position").challenges.live[0], declinesUsed: 2, now: Date.parse("2026-11-10T12:00:00.000Z") });
    app.use(router);
    const html = (await mods.renderer.renderToString(app)) as string;
    expect(html).toContain("your 3rd decline in 14 days: it counts as a loss");
    expect(html).toContain("Accept and propose a time");
    const issue = createSSRApp(mods.Dialog, { mode: "issue", settings: settings(), mine: row(3, "Dan"), target: row(1, "Amy"), now: 0 });
    issue.use(router);
    expect((await mods.renderer.renderToString(issue)) as string).toContain("takes 1st place");
  });
});
