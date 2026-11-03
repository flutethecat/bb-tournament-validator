import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp, nextTick, reactive } from "vue";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentEntrant, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { FIT_QUERY } from "../spa/src/shell/fit";
import {
  activeTab, breadcrumbs, leagueFacts, legacyRedirect, manageLocation, SECTION_TABS, seasonSwitchQuery, sectionRole, seriesFacts, showsStrip,
  tabFromQuery, tabLocation, tournamentFacts, visibleTabs,
} from "../spa/src/shell/sectionNav";
import { drawRounds } from "../spa/src/shell/sectionViews";
import { fixtureItems, listMonths, undatedFixtures } from "../spa/src/leagues/seasonCalendar";
import { scheduleCards, type SeriesStandings } from "../spa/src/tournaments/series";
import type { LeagueFixture } from "../spa/src/leagues/types";
import { followSeasons } from "../spa/src/leagues/followSeasons";

// The shared section header (owner 11-02: "a standard Nav Header bar that is shared across all surfaces of the site when
// inside of a section"; spec-section-header-2026-11-02): the tab lists and their rules (shell/sectionNav.ts), the light
// tab views, old URLs, the header server-rendered (cog only for this section's organisers, Participants inert vs
// clickable, private fields absent), the inventory pin of every old header action, and the fit pins.

const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");
const ids = (tabs: ReadonlyArray<{ id: string }>) => tabs.map((t) => t.id);

describe("section tabs: lists, order and visibility", () => {
  it("tournament and league tabs follow TourPlay's order; series has Overview, Schedule, Standings", () => {
    const tourplay = ["overview", "fixtures", "standings", "board", "calendar", "honours", "statistics", "stars", "participants", "draws", "awards"];
    expect(ids(SECTION_TABS.tournament)).toEqual(tourplay);
    expect(ids(SECTION_TABS.league)).toEqual([...tourplay, "events"]);
    expect(ids(SECTION_TABS.series)).toEqual(["overview", "schedule", "standings"]);
    expect(SECTION_TABS.league.find((t) => t.id === "honours")?.label).toBe("Honours"); // British spelling
  });

  it("everything with data shows; Board is greyed 'coming soon' (no link); league Events never shows", () => {
    const all = Object.fromEntries(SECTION_TABS.league.map((t) => [t.id, true]));
    const tabs = visibleTabs("league", "tabbl", all);
    expect(ids(tabs)).toEqual(["overview", "fixtures", "standings", "board", "calendar", "honours", "statistics", "stars", "participants", "draws", "awards"]);
    const board = tabs.find((t) => t.id === "board")!;
    expect(board.soon).toBe(true);
    expect(board.to).toBeUndefined();
    expect(ids(tabs)).not.toContain("events");
  });

  it("hidden while empty: a new section shows Overview and Board only; organisers also keep Awards (they give awards there)", () => {
    expect(ids(visibleTabs("tournament", "t1", {}))).toEqual(["overview", "board"]);
    expect(ids(visibleTabs("tournament", "t1", {}, { manage: true }))).toEqual(["overview", "board", "awards"]);
    expect(ids(visibleTabs("series", "s1", {}))).toEqual(["overview"]);
    // the page being shown always keeps its tab
    expect(ids(visibleTabs("league", "tabbl", {}, { active: "statistics" }))).toContain("statistics");
  });

  it("tournament facts: a draft with entrants has Participants only; once drawn, Fixtures, Standings, Honours, Statistics, Awards; Draws needs visible fixtures", () => {
    const t = { status: "draft" };
    expect(tournamentFacts({ tournament: t, rounds: [], fixtures: [], entrants: [{}] })).toMatchObject({ participants: true, fixtures: false, standings: false, honours: false, draws: false });
    const live = tournamentFacts({ tournament: { status: "active" }, rounds: [{}], fixtures: [], entrants: [{}] });
    expect(live).toMatchObject({ fixtures: true, standings: true, honours: true, statistics: true, awards: true, draws: false }); // anonymous: no fixtures sent
    expect(tournamentFacts({ tournament: { status: "active" }, rounds: [{}], fixtures: [{}], entrants: [] }).draws).toBe(true);
    expect(live.calendar).toBeUndefined(); // no dated tournament fixtures on the server: hidden
    expect(live.stars).toBeUndefined(); // no star data: hidden
  });

  it("league facts: from the season summary before the season loads, from the record after; Calendar needs a dated fixture", () => {
    const summary = leagueFacts({ seasons: [{ playedCount: 0 }], current: { teamCount: 4, fixtureCount: 0 } });
    expect(summary).toMatchObject({ participants: true, standings: true, fixtures: false, draws: false, calendar: false, statistics: false, honours: true, awards: true });
    const undated = { teams: [{}], fixtures: [{}] as Array<{ date?: string }> };
    expect(leagueFacts({ seasons: [{ playedCount: 3 }], season: undated })).toMatchObject({ fixtures: true, draws: true, calendar: false, statistics: true });
    expect(leagueFacts({ seasons: [{ playedCount: 3 }], season: { teams: [], fixtures: [{ date: "2026-11-04" }] } }).calendar).toBe(true);
    expect(leagueFacts({ seasons: [] }).honours).toBe(false);
    expect(seriesFacts({ events: [], rows: [] })).toEqual({ schedule: false, standings: false });
    expect(seriesFacts({ events: [{}], rows: [] })).toEqual({ schedule: true, standings: true });
  });

  it("tab URLs keep the old ?tab= values (rounds, entrants, teams); league Statistics is its own route; the season rides along", () => {
    expect(tabLocation("tournament", "t1", "fixtures")).toEqual({ name: "tournament-detail", params: { id: "t1" }, query: { tab: "rounds" } });
    expect(tabLocation("tournament", "t1", "participants")).toEqual({ name: "tournament-detail", params: { id: "t1" }, query: { tab: "entrants" } });
    expect(tabLocation("league", "tabbl", "participants", { season: "season-1" })).toEqual({ name: "league-detail", params: { id: "tabbl" }, query: { season: "season-1", tab: "teams" } });
    expect(tabLocation("league", "tabbl", "statistics", { season: "season-1" })).toEqual({ name: "league-stats", params: { id: "tabbl" }, query: { season: "season-1" } });
    expect(tabLocation("series", "s1", "overview")).toEqual({ name: "series-detail", params: { id: "s1" }, query: {} });
    expect(manageLocation("league", "tabbl")).toMatchObject({ name: "league-settings" });
    expect(manageLocation("tournament", "t1")).toMatchObject({ name: "tournament-manage" });
    expect(manageLocation("series", "s1")).toMatchObject({ name: "series-manage" });
    expect(tabFromQuery("tournament", "rounds")).toBe("fixtures");
    expect(tabFromQuery("league", "teams")).toBe("participants");
    expect(tabFromQuery("league", "board")).toBe("overview"); // coming soon: no page
    expect(tabFromQuery("league", "events")).toBe("overview");
    expect(tabFromQuery("tournament", "nonsense")).toBe("overview");
  });
});

describe("section tabs: sub-routes, breadcrumbs, seasons, roles, old URLs", () => {
  it("a sub-page keeps its owning tab highlighted: team → Participants; lobby, fixture and game → Fixtures; management → the cog", () => {
    expect(activeTab("tournament", { name: "tournament-team" })).toBe("participants");
    expect(activeTab("tournament", { name: "tournament-fixture-lobby" })).toBe("fixtures");
    expect(activeTab("league", { name: "league-fixture-lobby" })).toBe("fixtures");
    expect(activeTab("tournament", { name: "game" })).toBe("fixtures");
    expect(activeTab("league", { name: "league-stats" })).toBe("statistics");
    expect(activeTab("league", { name: "league-detail", query: { tab: "teams", team: "grudge-rollers" } })).toBe("participants");
    expect(activeTab("league", { name: "league-settings" })).toBe("manage");
    expect(activeTab("tournament", { name: "tournament-manage" })).toBe("manage");
    expect(activeTab("series", { name: "series-manage" })).toBe("manage");
    expect(activeTab("series", { name: "series-detail", query: { tab: "schedule" } })).toBe("schedule");
  });

  it("breadcrumb: '<owning tab> › <page>' with the tab linked", () => {
    expect(breadcrumbs("league", "tabbl", "participants", "Grudge Rollers")).toEqual([
      { label: "Participants", to: { name: "league-detail", params: { id: "tabbl" }, query: { tab: "teams" } } }, { label: "Grudge Rollers" },
    ]);
    expect(breadcrumbs("tournament", "t1", "fixtures", "Round 2 · Table 1")[0]!.label).toBe("Fixtures");
    expect(breadcrumbs("league", "tabbl", "participants", "")).toEqual([]);
  });

  it("season switch keeps the current tab, drops what belongs to one season, and leaves the newest season implicit", () => {
    expect(seasonSwitchQuery({ tab: "standings" }, "season-1", "season-6")).toEqual({ tab: "standings", season: "season-1" });
    expect(seasonSwitchQuery({ tab: "teams", team: "orcs", player: "p1", season: "season-1" }, "season-6", "season-6")).toEqual({ tab: "teams" });
    expect(seasonSwitchQuery({ tab: "fixtures", fixture: "f3", round: "2" }, "season-2", "season-6")).toEqual({ tab: "fixtures", season: "season-2" });
    expect(seasonSwitchQuery({ scope: "bb2025" }, "season-2", "season-6")).toEqual({ scope: "bb2025", season: "season-2" }); // statistics keeps its scope
  });

  it("role chip: organiser of this section, then a managing admin, then a participant", () => {
    expect(sectionRole({ organiser: true, admin: true })).toBe("organiser");
    expect(sectionRole({ organiser: false, admin: true })).toBe("admin");
    expect(sectionRole({ organiser: false, participant: true, participantRole: "entrant" })).toBe("entrant");
    expect(sectionRole({ organiser: false })).toBe("");
  });

  it("the slim banner strip shows on every page with a banner except Overview", () => {
    expect(showsStrip({ banner: "/api/leagues/x/banner", active: "standings" })).toBe(true);
    expect(showsStrip({ banner: "/api/leagues/x/banner", active: "manage" })).toBe(true);
    expect(showsStrip({ banner: "/api/leagues/x/banner", active: "overview" })).toBe(false);
    expect(showsStrip({ banner: "", active: "standings" })).toBe(false);
  });

  it("old URLs redirect: ?tab=manage → the management sub-panel (hash kept), the old league Participants tab → the public one, new spellings → the old values", () => {
    const at = (name: string, query: Record<string, string>, hash = "") => ({ name, params: { id: "x" }, query, hash });
    expect(legacyRedirect(at("tournament-detail", { tab: "manage" }, "#tn-page-h"))).toEqual({ name: "tournament-manage", params: { id: "x" }, query: {}, hash: "#tn-page-h" });
    expect(legacyRedirect(at("tournament-detail", { tab: "fixtures" }))).toMatchObject({ query: { tab: "rounds" } });
    expect(legacyRedirect(at("tournament-detail", { tab: "participants" }))).toMatchObject({ query: { tab: "entrants" } });
    expect(legacyRedirect(at("league-detail", { tab: "participants", season: "season-1" }))).toEqual({ name: "league-detail", params: { id: "x" }, query: { season: "season-1", tab: "teams" }, hash: "" });
    expect(legacyRedirect(at("league-detail", { tab: "statistics", season: "season-1", team: "a" }))).toEqual({ name: "league-stats", params: { id: "x" }, query: { season: "season-1" }, hash: "" });
    // award links from before the Awards tab carry the award's anchor: they open it on Awards
    expect(legacyRedirect(at("league-detail", { tab: "honours" }, "#award-a-1"))).toEqual({ name: "league-detail", params: { id: "x" }, query: { tab: "awards" }, hash: "#award-a-1" });
    for (const keep of [at("tournament-detail", { tab: "rounds" }), at("league-detail", { tab: "teams", team: "a" }), at("league-detail", {}), at("series-detail", { tab: "schedule" }), at("league-detail", { tab: "honours" })]) {
      expect(legacyRedirect(keep)).toBeNull();
    }
  });
});

describe("light tab views from existing data", () => {
  const side = (team: string, score: number | null) => ({ team, coach: `${team} coach`, race: "Orc", score, cas: null, conceded: false });
  const fx = (id: string, round: number, table: number, extra: Partial<LeagueFixture> = {}, scores: [number | null, number | null] = [null, null]): LeagueFixture => ({
    id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table, home: side(`H${id}`, scores[0]), away: side(`A${id}`, scores[1]), suspended: false, ...extra,
  });

  const ctx = { leagueId: "tabbl", seasonId: "season-7", zone: "UTC" };
  it("Calendar: a suspended 0-0 row without a result is not a scored game (the league's fixturePlayed rule)", () => {
    const list = [fx("s", 4, 1, { date: "2026-11-09", suspended: true }, [0, 0]), fx("n", 4, 2, { suspended: true }, [0, 0])];
    expect(fixtureItems(list, ctx)).toEqual([expect.objectContaining({ key: "fixture:s", result: "", state: "scheduled", allDay: true })]);
    expect(undatedFixtures(list, ctx)).toBe(1);
  });

  it("Calendar: played on the day it finished, an agreed time with its time, else the scheduled date; undated only counted", () => {
    const list = [
      fx("a", 1, 1, { finishedAt: "2026-10-03T19:00:00.000Z" }, [2, 1]),
      fx("b", 2, 1, { date: "2026-11-04", scheduledTime: { start: "2026-11-05T18:30:00.000Z", end: "2026-11-05T20:30:00.000Z", agreedAt: "" } }),
      fx("c", 2, 2, { date: "2026-11-04" }),
      fx("d", 3, 1),
    ];
    expect(undatedFixtures(list, ctx)).toBe(1);
    const months = listMonths(fixtureItems(list, ctx));
    expect(months.map((m) => [m.label, m.count])).toEqual([["October 2026", 1], ["November 2026", 2]]);
    expect(months[0]!.days[0]).toMatchObject({ key: "2026-10-03", weekday: "Sat", items: [{ key: "fixture:a", result: "2 - 1", state: "played" }] });
    const nov = months[1]!.days;
    expect(nov.map((d) => d.key)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(nov[1]!.items[0]).toMatchObject({ key: "fixture:b", state: "agreed", time: "18:30" });
  });

  it("Draws: rounds in phase and round order, pairings by table, no scores", () => {
    const rounds = drawRounds([fx("x", 2, 2), fx("y", 1, 2), fx("z", 1, 1, {}, [3, 0]), fx("p", 1, 1, { phase: "Playoffs", phaseId: "playoffs" })]);
    expect(rounds.map((r) => r.label)).toEqual(["Round 1", "Round 2", "Playoffs · Round 1"]);
    expect(rounds[0]!.pairings.map((p) => p.id)).toEqual(["z", "y"]);
    expect(JSON.stringify(rounds)).not.toContain("score");
  });

  it("Series schedule: finished with its top three, in progress, the first not started is NEXT, the rest upcoming", () => {
    const standings: SeriesStandings = {
      scoring: "sum", tiebreaks: [], rows: [
        { rank: 1, coach: "Ann", total: 20, eventsPlayed: 1, best: 20, headToHead: 0, results: [{ tournamentId: "e1", points: 20, rank: 1, played: 3, teamName: "Orcs", counted: true }] },
        { rank: 2, coach: "Bob", total: 16, eventsPlayed: 1, best: 16, headToHead: 0, results: [{ tournamentId: "e1", points: 16, rank: 3, played: 3, counted: true }] },
        { rank: 3, coach: "Cy", total: 12, eventsPlayed: 1, best: 12, headToHead: 0, results: [{ tournamentId: "e1", points: 12, rank: 2, played: 3, counted: true }] },
        { rank: 4, coach: "Di", total: 8, eventsPlayed: 1, best: 8, headToHead: 0, results: [{ tournamentId: "e1", points: 8, rank: 4, played: 3, counted: true }] },
      ],
      events: [
        { id: "e1", name: "One", status: "completed", counted: true, provisional: false },
        { id: "e2", name: "Two", status: "active", counted: true, provisional: true },
        { id: "e3", name: "Three", status: "draft", counted: true, provisional: false },
        { id: "e4", name: "Four", status: "draft", counted: true, provisional: false },
      ],
    };
    const cards = scheduleCards(standings);
    expect(cards.map((c) => c.state)).toEqual(["done", "live", "next", "upcoming"]);
    expect(cards[0]!.podium.map((p) => [p.rank, p.coach])).toEqual([[1, "Ann"], [2, "Cy"], [3, "Bob"]]);
    expect(cards[1]!.podium).toEqual([]);
  });
});

// ---- server-rendered ----

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher {
  return (async (path: string, init?: { method?: string }) => {
    const key = init?.method && init.method !== "GET" ? `${init.method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${key}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as Fetcher;
}
const who = (coach?: string, extra: Record<string, unknown> = {}): Routes => ({
  "/api/auth/session": coach ? { authenticated: true, coach, authMethod: "discord", discordSsoEnabled: true, ...extra } : { authenticated: false, discordSsoEnabled: true },
});

describe("section header (server-rendered)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: any;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, detail, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    m = { app, league, detail, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  // ---- league fixture: Quill is the league's organiser (no global role); Ann is a site organiser who is not
  const s6 = { id: "season-6", number: 6, name: "Season 6", ruleset: "BB2025", status: "active", teamCount: 1, fixtureCount: 0, playedCount: 0 };
  const s1 = { ...s6, id: "season-1", number: 1, name: "Season 1", status: "completed" };
  const league = {
    id: "tabbl", name: "TABBL", fullName: "Tahoma Area League", slug: "tabbl", description: "", organisers: ["Quill"], createdAt: "2026-01-01T00:00:00.000Z", seasonCount: 2,
    bannerUrl: "/api/leagues/tabbl/banner?v=0123456789ab",
  };
  const team = { id: "grudge-rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Bob", coachId: "Bob", teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [] };
  const season = (s: typeof s6) => ({ ...s, leagueId: "tabbl", sourceSlug: "s", phases: [], fixtures: [], participants: [], teams: [team], honours: [], awards: [], unattributedStats: [], importedAt: "", source: "manual" });
  const LEAGUE_API: Routes = {
    "/api/leagues/tabbl": { league, seasons: [s1, s6] },
    "/api/leagues/tabbl/seasons/season-6": { league, season: season(s6) },
    "/api/leagues/tabbl/seasons/season-1": { league, season: season(s1) },
    "/crests/manifest.json": { crests: {} },
  };
  async function renderLeague(path: string, session: Routes, seasonId = "season-6"): Promise<string> {
    const f = mockFetcher({ ...LEAGUE_API, ...session });
    const spa = m.app.createSpa({ history: m.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = m.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason(seasonId);
    spa.app.provide(m.league.LEAGUE_DETAIL_KEY, d);
    await spa.router.push(path);
    await spa.router.isReady();
    return (await m.renderer.renderToString(spa.app)).replace(/<!--[^>]*-->/g, "");
  }

  it("league: one header with name, season dropdown and tabs; the slim banner strip off Overview only", async () => {
    const overview = await renderLeague("/leagues/tabbl", who());
    expect(overview.match(/<header class="sh"/g)).toHaveLength(1);
    expect(overview).toContain('<h2 class="sh-name" title="Tahoma Area League">Tahoma Area League</h2>');
    expect(overview).toMatch(/<select[^>]*data-season-select/);
    expect(overview).toContain('<option value="season-6">Season 6</option>');
    expect(overview).toContain('data-strip="plain"'); // Overview shows the full banner instead
    expect(overview).toContain('class="lg-front" data-banner="image"');
    const standings = await renderLeague("/leagues/tabbl?tab=standings", who());
    expect(standings).toContain('data-strip="banner"');
    expect(standings).toContain("--sh-banner:url(&quot;/api/leagues/tabbl/banner?v=0123456789ab&quot;)");
    expect(standings).not.toContain('class="lg-front"');
    // an older season rides on every tab link, and the tab survives a season switch (seasonSwitchQuery)
    const older = await renderLeague("/leagues/tabbl?season=season-1&tab=standings", who(), "season-1");
    expect(older).toContain('href="/app/leagues/tabbl?season=season-1&amp;tab=teams"');
  });

  it("cog: shown to an actor with ONLY the league's organiser role, never to a site-wide organiser who is not one of its organisers", async () => {
    const scoped = await renderLeague("/leagues/tabbl", who("Quill", { organizer: false, admin: false }));
    expect(scoped).toMatch(/<a[^>]*data-cog[^>]*>|<a[^>]*aria-label="League management"/);
    expect(scoped).toContain('href="/app/leagues/tabbl/settings"');
    expect(scoped).toContain('data-role="organiser"');
    expect(scoped).toContain("data-announce");
    for (const session of [who("Ann", { organizer: true }), who("Bob"), who()]) {
      const html = await renderLeague("/leagues/tabbl", session);
      expect(html).not.toContain("data-cog");
      expect(html).not.toContain("data-announce");
      expect(html).not.toContain('href="/app/leagues/tabbl/settings"');
    }
    // a site admin manages every league (unchanged rule), shown as Admin
    expect(await renderLeague("/leagues/tabbl", who("Root", { admin: true }))).toContain('data-role="admin"');
  });

  it("league team page: Participants stays highlighted with the breadcrumb 'Participants › Grudge Rollers'", async () => {
    const html = await renderLeague("/leagues/tabbl?tab=teams&team=grudge-rollers", who());
    expect(html.match(/<a[^>]*data-tab="participants"[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
    expect(html).toMatch(/<nav class="sh-crumbs" aria-label="Breadcrumb"><ol><li><a[^>]*href="\/app\/leagues\/tabbl\?tab=teams"[^>]*>Participants<\/a><\/li><li><span aria-current="page">Grudge Rollers<\/span>/);
  });

  // ---- tournament fixture
  const T: TournamentSummary = {
    id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3, currentRound: 1, entrantCount: 2,
    ownerCoachId: "Veers", organizerCoachIds: ["Piett"],
  } as TournamentSummary;
  const FLAGS = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
  const SHARED = { coach: "Alice", preferredName: "Alice P", email: "alice@example.com", phones: [{ number: "+15555550101" }] };
  const entrants = (shared: boolean): TournamentEntrant[] => [
    { id: "t1:e1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc", flags: { ...FLAGS }, ...(shared ? { shared: SHARED } : {}) } as TournamentEntrant,
    { id: "t1:e2", seed: 2, coachId: "Bob", teamId: "tm2", teamName: "Bob Elves", race: "Wood Elf", flags: { ...FLAGS } } as TournamentEntrant,
  ];
  const body = (manage: boolean, shared = false): TournamentDetailResponse => ({
    tournament: T, entrants: entrants(shared), rounds: [{ id: "r1", number: 1, status: "active", scheduledMatchIds: [] }], scheduledMatches: [], capabilities: { manage, assignRoles: false },
  });
  async function renderTournament(path: string, session: Routes, b: TournamentDetailResponse): Promise<string> {
    const f = mockFetcher({ ...session, "/api/tournaments/t1": b, "/api/fork/library?coach=Alice": { teams: [] }, "/api/fork/team-builder/saves": { saves: [] } });
    const spa = m.app.createSpa({ history: m.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = m.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    spa.app.provide(m.detail.TOURNAMENT_DETAIL_KEY, d);
    await spa.router.push(path);
    await spa.router.isReady();
    return (await m.renderer.renderToString(spa.app)).replace(/<!--[^>]*-->/g, "");
  }

  it("tournament: the cog follows the server's capabilities.manage, never a global role", async () => {
    const scoped = await renderTournament("/tournaments/t1", who("Piett", { organizer: false }), body(true));
    expect(scoped).toContain("data-cog");
    expect(scoped).toContain('href="/app/tournaments/t1/manage"');
    expect(scoped).toContain('data-role="organiser"');
    const global = await renderTournament("/tournaments/t1", who("Ann", { organizer: true }), body(false));
    expect(global).not.toContain("data-cog");
    expect(global).not.toContain("/app/tournaments/t1/manage");
    // the management sub-panel: its managers get the panels with the left sub-nav; anyone else gets Overview
    const manage = await renderTournament("/tournaments/t1/manage", who("Piett"), body(true));
    expect(manage).toContain('<nav class="sh-subnav" aria-label="Tournament management">');
    expect(manage).toContain(">Summary<");
    expect(manage.match(/<a[^>]*data-cog[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
    const refused = await renderTournament("/tournaments/t1/manage", who("Ann", { organizer: true }), body(false));
    expect(refused).not.toContain("sh-subnav");
    expect(refused).not.toContain(">Summary<");
  });

  it("tournament Participants: public fields for everyone; coaches inert except for organisers; no private field on the page", async () => {
    for (const session of [who(), who("Bob")]) {
      // even if a server ever sent the shared block to a non-organiser, the page never shows it
      const html = await renderTournament("/tournaments/t1?tab=entrants", session, body(false, true));
      for (const t of ["Alice Orcs", "Orc", "Alice", "Bob Elves"]) expect(html).toContain(t);
      expect(html).not.toContain("data-coach-profile");
      expect(html).not.toContain("alice@example.com");
      expect(html).not.toContain("+15555550101");
      expect(html).not.toContain("Alice P");
    }
    const org = await renderTournament("/tournaments/t1?tab=entrants", who("Piett"), body(true, true));
    expect(org.match(/data-coach-profile/g)).toHaveLength(2);
    expect(org).toContain('aria-label="Alice: coach profile"');
    expect(org).not.toContain("alice@example.com"); // only inside the profile dialog, on a click
    expect(org.match(/<a[^>]*data-tab="participants"[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
  });

  it("standalone league page (fixture lobby): the header's own controller reaches the Announcement dialog", async () => {
    const dialogMod = await vite.ssrLoadModule("/src/leagues/dialog.ts");
    const f = mockFetcher({ ...LEAGUE_API, ...who("Quill") });
    const spa = m.app.createSpa({ history: m.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const a = dialogMod.createAnnounce();
    a.open("season-6", "tabbl/season-6"); // the organiser pressed Announcement on the lobby page
    spa.app.provide(dialogMod.ANNOUNCE_KEY, a);
    await spa.router.push("/leagues/tabbl/seasons/season-6/fixtures/f1/lobby");
    await spa.router.isReady();
    const html = (await m.renderer.renderToString(spa.app)).replace(/<!--[^>]*-->/g, ""); // no league controller provided by the page
    expect(html).toContain('<header class="sh"');
    expect(html).toContain('aria-labelledby="lg-announce-h"');
    expect(html).toContain("News post"); // the composer rendered against the header's league controller
  });

  it("league management: after a season action the shared league controller re-reads, so a new season shows without a reload", async () => {
    const settings = reactive({ id: "tabbl", seasons: [{ id: "season-1", status: "active" }] });
    const loads: string[] = [];
    const detail = {
      state: reactive({ id: "tabbl", loaded: true, seasons: [{ id: "season-1", status: "active" }] as Array<{ id: string; status: string }> }),
      async load(id: string) { loads.push(id); this.state.seasons = [...settings.seasons]; },
    };
    const stop = followSeasons(settings, detail, () => "tabbl");
    settings.seasons = [{ id: "season-2", status: "active" }, { id: "season-1", status: "active" }]; // Start a new season
    await nextTick();
    expect(loads).toEqual(["tabbl"]);
    expect(detail.state.seasons.map((s) => s.id)).toEqual(["season-2", "season-1"]);
    settings.seasons = [...settings.seasons]; // the same list again: nothing to do
    await nextTick();
    expect(loads).toEqual(["tabbl"]);
    settings.seasons = [{ id: "season-2", status: "completed" }, { id: "season-1", status: "active" }]; // Finish
    await nextTick();
    expect(loads).toEqual(["tabbl", "tabbl"]);
    stop();
  });

  it("inside a section the name shows in the section header only: the top bar title is visually hidden (kept for assistive tech)", async () => {
    const app = src("App.vue");
    expect(app).toContain(`:class="{ 'sf-sr': inSection }"`);
    expect(src("components/SectionHeader.vue")).toContain("useSectionTitle();");
  });

  it("the coach profile shows the public line and only what was shared with this scope", async () => {
    const dialog = await vite.ssrLoadModule("/src/components/CoachProfileDialog.vue");
    const html = await m.renderer.renderToString(createSSRApp(dialog.default, { coach: "Alice", team: "Alice Orcs", race: "Orc", lines: ["Alice P", "alice@example.com"] }));
    expect(html).toContain("Alice Orcs");
    expect(html).toContain("Alice P · alice@example.com");
    const none = await m.renderer.renderToString(createSSRApp(dialog.default, { coach: "Bob", lines: [] }));
    expect(none).toContain("Not shared");
  });
});

// ---- the old headers: every action still has a home (inventory: docs/config-web/old-section-headers-inventory.md, private) ----

describe("inventory pin: every old header and tab-strip action still exists", () => {
  // [inventory id, what, file, the text that proves it is there]
  const PINS: Array<[string, string, string, string]> = [
    ["L1/T1", "up-link to All leagues / tournaments / series", "shell/sectionNav.ts", 'label: "All leagues"'],
    ["L1/T1", "the header renders the up-link", "components/SectionHeader.vue", ':aria-label="up.label"'],
    ["L2", "full banner on the league Overview", "views/LeagueDetailView.vue", "<LeagueFront :league="],
    ["L2/T2", "slim banner strip behind the header off Overview", "components/SectionHeader.vue", "--sh-banner"],
    ["L3/L4", "league logo and full name in the header", "components/LeagueSectionHeader.vue", "name: league.fullName || league.name"],
    ["L5", "seasons badge", "components/LeagueFront.vue", "lg-seasons-badge"],
    ["L6", "Founded chip", "components/LeagueFront.vue", "Founded {{ founded.short }}"],
    ["L7", "Announcement megaphone", "components/SectionHeader.vue", 'aria-label="Announcement"'],
    ["L7", "Announcement dialog hosted by the league header", "components/LeagueSectionHeader.vue", "<LeagueAnnounce"],
    ["L8", "League settings cog → management", "shell/sectionNav.ts", '"league-settings"'],
    ["L9", "posted confirmation under the header", "components/LeagueSectionHeader.vue", "lg-announced"],
    ["L10", "draft notice", "views/LeagueDetailView.vue", "<LeagueDraftNotice"],
    ["L11", "season cards on Overview", "views/LeagueDetailView.vue", 'class="lg-season-field"'],
    ["L11", "season dropdown in the header", "components/SectionHeader.vue", "data-season-select"],
    ["L12", "Build a team link", "views/LeagueDetailView.vue", "<LeagueBuildTeamLink"],
    ["L13", "Upload / Remove logo and header bar in Management › Artwork", "views/LeagueSettingsView.vue", "<LeagueArtEdit"],
    ["L13", "the artwork controls themselves", "components/LeagueArtEdit.vue", "Upload logo"],
    ["L13", "the artwork controls themselves", "components/LeagueArtEdit.vue", "Upload header bar"],
    ["LT3", "fixture summary under Fixtures", "views/LeagueDetailView.vue", "<LeagueFixtureSummary"],
    ["LT4", "a team's roster under Participants", "views/LeagueDetailView.vue", "<LeagueTeams"],
    ["LT4", "the public Participants list", "views/LeagueDetailView.vue", "<LeagueParticipantsList"],
    ["LT5", "Honours", "views/LeagueDetailView.vue", "<LeagueHonours"],
    ["LT5", "Awards on their own tab", "views/LeagueDetailView.vue", "<LeagueAwards"],
    ["LT6", "participant flags in Management › Participants", "views/LeagueSettingsView.vue", "<LeagueParticipants"],
    ["LT7/LT8", "Statistics route with the header", "views/LeagueStatsView.vue", '<LeagueSectionHeader :id="id" active="statistics" />'],
    ["T2", "tournament banner on Overview", "views/TournamentDetailView.vue", "<TournamentFront />"],
    ["T3", "Series chip in the header", "components/TournamentSectionHeader.vue", "`Series: ${state.series.name}`"],
    ["T3", "Series chip on the Overview hero", "components/TournamentFront.vue", "tn-series-chip"],
    ["T4", "status chip", "components/TournamentSectionHeader.vue", "STATUS_LABEL[t.status]"],
    ["T5", "NAF sanctioned chip", "components/TournamentFront.vue", "NAF sanctioned"],
    ["T6", "Change / Withdraw", "components/TournamentFront.vue", ">Withdraw</button>"],
    ["T7", "Register / Sign in to register", "components/TournamentFront.vue", "Sign in to register"],
    ["T8", "Edit → management page settings", "components/TournamentFront.vue", 'name: "tournament-manage", params: { id: t.value.id }, hash: "#tn-page-h"'],
    ["T9", "Edit ruleset", "components/TournamentFront.vue", "Edit ruleset"],
    ["T10", "created notice", "views/TournamentDetailView.vue", "createdNotice"],
    ["TT2", "Participants (entrants)", "views/TournamentDetailView.vue", "<TournamentEntrants"],
    ["TT3", "Fixtures (rounds)", "views/TournamentDetailView.vue", "<TournamentRounds"],
    ["TT4-7", "Standings, Statistics, Honours, Awards", "views/TournamentDetailView.vue", "<TournamentAwards"],
    ["TT8", "Manage panels in the management sub-panel", "views/TournamentDetailView.vue", "<TournamentManage />"],
    ["TT8", "tournament banner upload stays in Manage", "components/TournamentManage.vue", "<TournamentPageForm />"],
    ["S1/S2", "series name and event count in the header", "components/SeriesSectionHeader.vue", 'events.length === 1 ? "event" : "events"'],
    ["S3", "scoring and seeding chips", "views/SeriesDetailView.vue", "data-seeding"],
    ["S4/S5", "description and Run by", "views/SeriesDetailView.vue", "Run by"],
    ["S6", "Edit", "views/SeriesDetailView.vue", '@click="editing = true">Edit</button>'],
    ["S7", "New tournament", "views/SeriesDetailView.vue", ">New tournament</button>"],
    ["S8", "Delete", "views/SeriesDetailView.vue", ">Delete series</button>"],
    ["S10", "the tournaments as Schedule cards", "views/SeriesDetailView.vue", "sr-cards"],
    ["S11", "Remove / Add a tournament", "views/SeriesDetailView.vue", "Add a tournament"],
    ["S12", "Standings", "views/SeriesDetailView.vue", 'class="sf-table sr-table"'],
    ["LS4", "the six settings groups as the management sub-nav", "views/LeagueSettingsView.vue", "...SETTINGS_TABS"],
    ["RB1", "Roster Builder league mode inside the league section", "views/TournamentBuilderView.vue", "<LeagueSectionHeader"],
  ];
  it.each(PINS)("%s %s", (_id, _what, file, needle) => {
    expect(src(file), `${file} must carry ${needle}`).toContain(needle);
  });

  it("the old strips are gone: no LeagueTabs, no tournament tab strip, no league settings header, no series header panel", () => {
    expect(() => src("components/LeagueTabs.vue")).toThrow();
    expect(src("views/TournamentDetailView.vue")).not.toContain("tn-tabs");
    expect(src("views/LeagueSettingsView.vue")).not.toContain("ls-head");
    expect(src("views/SeriesDetailView.vue")).not.toContain("sr-head\"");
    expect(src("components/LeagueFront.vue")).not.toContain("lg-cog");
    expect(src("views/TournamentBuilderView.vue")).not.toContain("tb-league-line");
  });
});

describe("fit: section pages", () => {
  it("every section page puts the header in the fixed chrome and scrolls a pane under it", () => {
    for (const [file, classes] of [
      ["views/LeagueDetailView.vue", ["sf-fit", "<LeagueSectionHeader", "lg-tab-body sf-fill sf-scroll sf-col"]],
      ["views/LeagueStatsView.vue", ["sf-fit", "<LeagueSectionHeader", "lg-tab-body sf-fill sf-scroll sf-col"]],
      ["views/LeagueSettingsView.vue", ["sf-fit", "<LeagueSectionHeader", "sh-manage sf-fill"]],
      ["views/TournamentDetailView.vue", ["sf-fit", "<TournamentSectionHeader", "tn-tab-body sf-fill", "sh-manage sf-fill"]],
      ["views/SeriesDetailView.vue", ["sf-fit", "<SeriesSectionHeader", "sf-shrink sf-scroll sf-col", "sh-manage sf-fill"]],
      ["views/FixtureLobbyView.vue", ["sf-fit", "<LeagueSectionHeader", "<TournamentSectionHeader"]],
      ["views/GameSummaryView.vue", ["gs-section sf-fit", "<TournamentSectionHeader"]],
    ] as const) {
      for (const c of classes) expect(src(file), `${file}: ${c}`).toContain(c);
    }
  });

  it("section.css: two rows, the tabs on the second (wrapping on a desktop, scrolling only on phones); management panes scroll only inside the desktop fit query; tokens only", () => {
    const css = src("shell/section.css");
    const phone = css.indexOf("@media (max-width: 760px) {");
    // owner 11-02: row 1 = identity + actions, row 2 = every tab; no sideways scroller at desktop widths
    expect(css.slice(0, phone)).toMatch(/\.sh-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "id act" "tabs tabs";/);
    expect(css.slice(0, phone)).toMatch(/\.sh-tabs\.sf-tabs \{[^}]*flex-wrap: wrap;[^}]*overflow: visible;/);
    expect(css.slice(0, phone)).not.toMatch(/\.sh-tabs[^{]*\{[^}]*overflow-x: auto/);
    expect(css.slice(phone)).toMatch(/\.sh-tabs\.sf-tabs \{ flex-wrap: nowrap; overflow-x: auto;/);
    const fit = css.slice(css.indexOf(`@media ${FIT_QUERY} {`));
    expect(fit).toContain(".sh-manage.sf-fill > .sh-subnav, .sh-manage.sf-fill > .sh-manage-body");
    expect(css.slice(0, css.indexOf(`@media ${FIT_QUERY} {`))).not.toMatch(/overflow-y: auto/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^]*grid-template-areas: "id act" "tabs tabs";/); // phones: two rows
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/);
  });
});
