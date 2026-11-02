import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
import { raceTone } from "../spa/src/shared/raceTone";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  canManageLeague, cardQuery, cardSeasonChips, tiedLine, createLeagueDetail, createLeagueList, createLeagueStats, crestFor, fixtureContext, fixturesByPhase, honourBoards, honourValue,
  fixtureOutcome, kValue, teamValueFigures, latestResults, pickSeason, playerByRef, sharedTotalsFor, resultCardProps, safeArtUrl, standingsTables, teamByRef,
} from "../spa/src/leagues/league";
import { currentRound, filterFixtures, fixtureRounds, fixtureStatus, fixtureTeams, keepPhase, keepTeam, parseRound, readFixturesView, roundSteps, scoreLinkLabel, writeFixturesView } from "../spa/src/leagues/fixtureNav";
import { createAnnounce } from "../spa/src/leagues/dialog";
import type { LeagueFixture, LeagueStats, LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";

// SPA Leagues: controllers + display helpers, and the list / league page / statistics routes server-rendered through
// the SPA's Vite config against a mocked Fetcher (as in spaTournaments.test.ts).

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (path: string) => {
    calls.push(path);
    const hit = routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

const s6sum: SeasonSummary = { id: "season-6", number: 6, name: "Season 6", ruleset: "BB2025", status: "active", startedAt: "2026-05-29T00:00:00.000Z", endedAt: "2026-09-01T00:00:00.000Z", teamCount: 2, fixtureCount: 4, playedCount: 3 };
const s1sum: SeasonSummary = { id: "season-1", number: 1, name: "Season 1", ruleset: "BB2020", status: "completed", teamCount: 2, fixtureCount: 1, playedCount: 1, champion: { coach: "Ann", team: "Orcs", race: "Orc" } };
const league: LeagueSummary = {
  id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-30T00:00:00.000Z",
  logoUrl: "/api/leagues/tabbl/logo?v=abcdef123456", bannerUrl: "/api/leagues/tabbl/banner?v=0123456789ab", seasonCount: 2, currentSeason: s6sum,
};

const fx = (id: string, phaseId: string, phase: string, round: number, home: [string, number | null, number | null], away: [string, number | null, number | null], over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase, phaseId, group: phaseId === "season-regular" ? "Tahoma" : "", round, table: 1,
  home: { team: home[0], coach: home[0] === "Grudge Rollers" ? "flutethecat (Jay)" : "Jeff / @Chap", race: home[0] === "Grudge Rollers" ? "Dwarf" : "Nurgle", score: home[1], cas: home[2], conceded: false },
  away: { team: away[0], coach: away[0] === "Grudge Rollers" ? "flutethecat (Jay)" : "Jeff / @Chap", race: away[0] === "Grudge Rollers" ? "Dwarf" : "Nurgle", score: away[1], cas: away[2], conceded: false },
  suspended: false, ...over,
});

const season6 = (): SeasonRecord => ({
  id: "season-6", leagueId: "tabbl", number: 6, name: "Season 6", sourceSlug: "tabbl---season-6", ruleset: "BB2025", status: "active", importedAt: "2026-10-30T00:00:00.000Z",
  startedAt: s6sum.startedAt, endedAt: s6sum.endedAt,
  phases: [
    { id: "season-preseason", category: "Season", name: "PreSeason", groups: [""], standings: [] },
    { id: "season-regular", category: "Season", name: "Regular", groups: ["Tahoma"], includes: ["season-interdivision"], standings: [
      { group: "Tahoma", rank: 1, team: "Grudge Rollers", race: "Dwarf", coach: "flutethecat (Jay)", points: 6, played: 2, wins: 2, draws: 0, losses: 0, tdFor: 4, tdAgainst: 1, casFor: 3, casAgainst: 2 },
      { group: "Tahoma", rank: 2, team: "Rot Girl Summer", race: "Nurgle", coach: "Jeff / @Chap", points: 0, played: 2, wins: 0, draws: 0, losses: 2, tdFor: 1, tdAgainst: 4, casFor: 2, casAgainst: 3 },
    ] },
    { id: "season-interdivision", category: "Season", name: "Interdivision", groups: [""], standings: [] },
  ],
  fixtures: [
    fx("f1", "season-preseason", "PreSeason", 1, ["Grudge Rollers", 1, 2], ["Rot Girl Summer", 1, 3], { finishedAt: "2026-05-29T03:00:00.000Z" }),
    fx("f2", "season-regular", "Regular", 1, ["Grudge Rollers", 3, 1], ["Rot Girl Summer", 0, 2], { finishedAt: "2026-06-10T03:00:00.000Z" }),
    fx("f3", "season-regular", "Regular", 2, ["Rot Girl Summer", 1, 0], ["Grudge Rollers", 2, 1], { finishedAt: "2026-07-01T03:00:00.000Z", suspended: true, away: { team: "Grudge Rollers", coach: "flutethecat (Jay)", race: "Dwarf", score: 2, cas: 1, conceded: false }, home: { team: "Rot Girl Summer", coach: "Jeff / @Chap", race: "Nurgle", score: 1, cas: 0, conceded: true } }),
    fx("f4", "season-regular", "Regular", 3, ["Grudge Rollers", null, null], ["Rot Girl Summer", null, null]),
  ],
  participants: [],
  teams: [
    { id: "grudge-rollers", name: "Grudge Rollers", race: "Dwarf", coach: "flutethecat (Jay)", teamValue: 885000, treasury: 130000, rerolls: 1, fans: 3, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "WorldsEdgeSuperleague",
      players: [{ playerId: "p-deth00000001", number: 4, name: "Dethirord Slenderstrength", position: "Troll Slayer", ma: 5, st: 3, ag: 4, pa: 5, av: 9, skills: ["Block", "Hatred (102)"], value: 95000, level: "Rookie", availableSpp: 6, niggling: 0, missNextGame: false, stats: { td: 2, cas: 1, mvp: 1, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 11, performance: 0 } }, { playerId: "p-bob000000007", number: 7, name: "Bob", position: "Dwarf Lineman", ma: 4, st: 3, ag: 4, pa: null, av: 10, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 } }, { playerId: "p-bob000000008", number: 8, name: "Bob", position: "Dwarf Lineman", ma: 4, st: 3, ag: 4, pa: null, av: 10, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 } }],
      formerPlayers: [{ playerId: "p-gone00000001", name: "Gone Guy", position: "Dwarf Lineman", level: "Rookie", stats: { td: 0, cas: 2, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 4, performance: 0 } }] },
    { id: "rot-girl-summer", name: "Rot Girl Summer", race: "Nurgle", coach: "Jeff / @Chap", teamValue: 1000000, treasury: 0, rerolls: 2, fans: 2, assistantCoaches: 1, cheerleaders: 1, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [] },
  ],
  honours: [
    { key: "season-mosttouchdowns", category: "season", stat: "mosttouchdowns", kind: "player", rows: [{ rank: 1, name: "Dethirord Slenderstrength", team: "Grudge Rollers", coach: "", playerId: "p-deth00000001", value: 2 }] },
    { key: "season-bestrace", category: "season", stat: "bestrace", kind: "coach", rows: [{ rank: 1, name: "Kainis", team: "Caledor Crusaders", coach: "Kainis", value: { WinDrawRatio: 0.955, Wins: 10, Draws: 1, Defeats: 0, Points: 22 } }] },
  ],
  awards: [],
  unattributedStats: [{ team: "Grudge Rollers", teamId: "grudge-rollers", name: "Bob", position: "Dwarf Lineman", stats: { td: 5, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 15, performance: 0 }, reason: "2 players called \"Bob\" (Dwarf Lineman): the export cannot split their totals", candidates: ["p-bob000000007", "p-bob000000008"] }],
});

const stats = (scope: "bb2020" | "bb2025" | "all"): LeagueStats => ({
  scope,
  seasons: scope === "bb2020" ? [{ id: "season-1", number: 1, name: "Season 1", ruleset: "BB2020", status: "completed" }] : [{ id: "season-6", number: 6, name: "Season 6", ruleset: "BB2025", status: "active" }],
  totals: { seasons: 1, games: 3, touchdowns: 8, casualties: 9, teams: 2, coaches: 2, players: 2 },
  leaders: {
    td: [{ playerId: "p-deth00000001", seasonId: "season-6", name: scope === "bb2020" ? "Old Timer" : "Dethirord Slenderstrength", position: "Troll Slayer", team: "Grudge Rollers", race: "Dwarf", coach: "flutethecat (Jay)", seasons: [6], value: 2 }],
    cas: [], mvp: [], int: [], completions: [], fouls: [], spp: [],
  },
  coaches: [{ coach: "flutethecat (Jay)", seasons: [6], teams: 1, titles: 0, games: 3, wins: 2, draws: 1, losses: 0, points: 7, tdFor: 6, tdAgainst: 2, casFor: 4, casAgainst: 5, winPct: 0.833 }],
  teams: [{ team: "Grudge Rollers", race: "Dwarf", coach: "flutethecat (Jay)", seasons: [6], games: 3, wins: 2, draws: 1, losses: 0, points: 7, tdFor: 6, tdAgainst: 2, casFor: 4, casAgainst: 5, winPct: 0.833 }],
  races: [{ race: "Dwarf", teams: 1, games: 3, wins: 2, draws: 1, losses: 0, points: 7, tdFor: 6, tdAgainst: 2, casFor: 4, casAgainst: 5, winPct: 0.833 }],
  biggestWins: [{ seasonId: "season-6", season: 6, phase: "PreSeason", round: 1, margin: 3, winner: { team: "Grudge Rollers", coach: "Jay", race: "Dwarf", score: 3 }, loser: { team: "Rot Girl Summer", coach: "Jeff", race: "Nurgle", score: 0 } }],
  mostGames: [{ coach: "flutethecat (Jay)", seasons: [6], teams: 1, titles: 0, games: 3, wins: 2, draws: 1, losses: 0, points: 7, tdFor: 6, tdAgainst: 2, casFor: 4, casAgainst: 5, winPct: 0.833 }],
  champions: scope === "bb2025" ? [] : [{ seasonId: "season-1", season: 1, ruleset: "BB2020", coach: "Ann", team: "Orcs", race: "Orc" }],
  cards: scope === "bb2020" ? [] : [
    { id: "top-scorer", title: "Top scorer", value: "12", unit: "TD", name: "Dethirord Slenderstrength", team: "Grudge Rollers", race: "Dwarf", coach: "flutethecat (Jay)", detail: "Troll Slayer",
      seasons: [2, 3, 4, 5, 6], tied: ["Bob", "Ug", "Zed"], icon: "/icons/panel/games.png", link: { kind: "player", seasonId: "season-6", teamId: "grudge-rollers", playerId: "p-deth00000001" } },
    { id: "best-team", title: "Best team", value: "7", unit: "Points", name: "Grudge Rollers", team: "Grudge Rollers", race: "Dwarf", coach: "flutethecat (Jay)", detail: "2-1-0 · 83% wins",
      seasons: [6], tied: [], icon: "/icons/panel/teams.png", link: { kind: "team", seasonId: "season-6", teamId: "grudge-rollers" } },
    { id: "biggest-win", title: "Biggest win", value: "3-0", unit: "+3", name: "Grudge Rollers", team: "Grudge Rollers", race: "Nurgle", coach: "Jay", detail: "beat Rot Girl Summer · Round 1",
      seasons: [6], tied: ["Rot Girl Summer 3-0 Grudge Rollers"], icon: "/icons/panel/tournaments.png", link: { kind: "fixture", seasonId: "season-6", fixtureId: "f1" } },
    { id: "dirtiest", title: "Dirtiest", value: "4", unit: "Fouls", name: "Bob", team: "Grudge Rollers", race: "Elf", coach: "Jay", detail: "", seasons: [], tied: [], icon: "",
      link: { kind: "player", seasonId: "season-6", teamId: "grudge-rollers", playerId: "p-bob000000007" } },
  ],
});

const API: Routes = {
  "/api/leagues": { leagues: [league] },
  "/api/leagues/tabbl": { league, seasons: [s1sum, s6sum] },
  "/api/leagues/tabbl/seasons/season-6": { league, season: season6() },
  "/api/leagues/tabbl/stats?scope=all": stats("all"),
  "/api/leagues/tabbl/stats?scope=bb2020": stats("bb2020"),
  "/crests/manifest.json": { crests: { dwarf: "crests/dwarf.png", nurgle: "crests/nurgle.png" } },
};

describe("league review regressions (SPA side)", () => {
  it("fixture outcome: a concession decides before the score; the fixtures tab and cards share it", () => {
    const f = season6().fixtures[2]!; // Rot Girl Summer 1-2 Grudge Rollers, home conceded
    expect(fixtureOutcome(f)).toEqual({ home: "loss", away: "win" });
    const level = { ...f, home: { ...f.home, score: 2 } }; // 2-2 but home conceded
    expect(fixtureOutcome(level)).toEqual({ home: "loss", away: "win" });
    expect(fixtureOutcome({ ...level, home: { ...level.home, conceded: false } })).toEqual({ home: "draw", away: "draw" });
  });

  it("player refs: by id, by an earlier season's id, never by name", () => {
    const s = season6();
    s.teams[0]!.players[0]!.previousIds = ["p-old000000001"];
    expect(playerByRef(s, "p-bob000000007")).toMatchObject({ team: { id: "grudge-rollers" }, player: { number: 7 } });
    expect(playerByRef(s, "p-old000000001")!.player.playerId).toBe("p-deth00000001");
    expect(playerByRef(s, "Bob")).toBeUndefined();
    expect(playerByRef(s, "Dethirord Slenderstrength")).toBeUndefined();
    expect(sharedTotalsFor(s, "p-bob000000007")).toHaveLength(1);
    expect(sharedTotalsFor(s, "p-deth00000001")).toHaveLength(0);
  });

  it("team pages pick a team by id; a bare name shared by two teams picks none", () => {
    const s = season6();
    s.teams.push({ ...s.teams[0]!, id: "grudge-rollers--other", coach: "Someone Else" });
    expect(teamByRef(s, "grudge-rollers--other")!.coach).toBe("Someone Else");
    expect(teamByRef(s, "Grudge Rollers")).toBeUndefined();
    expect(teamByRef(s, "Rot Girl Summer")!.id).toBe("rot-girl-summer");
  });
});

describe("league helpers", () => {
  it("latest results: played only (unplayed and void left out), newest first, capped", () => {
    expect(latestResults(season6()).map((f) => f.id)).toEqual(["f3", "f2", "f1"]);
    expect(latestResults(season6(), 2)).toHaveLength(2);
  });

  it("fixtures by phase and round, standings tables with the included phases noted", () => {
    const groups = fixturesByPhase(season6());
    expect(groups.map((g) => [g.title, g.rounds.map((r) => `${r.round}:${r.played}/${r.fixtures.length}`)])).toEqual([
      ["Pre-season", ["1:1/1"]], ["Regular", ["1:1/1", "2:1/1", "3:0/1"]],
    ]);
    const tables = standingsTables(season6());
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ title: "Regular · Tahoma", note: "Includes Interdivision games." });
  });

  it("result card props, context line, honour values and boards", () => {
    const s = season6();
    const card = resultCardProps(league, s, s.fixtures[2]!, { dwarf: "crests/dwarf.png" });
    expect(card).toMatchObject({
      context: "TABBL · Season 6", concede: "home", suspended: false, playedAt: "2026-07-01T03:00:00.000Z",
      home: { name: "Rot Girl Summer", score: 1, cas: 0, crestUrl: null }, away: { name: "Grudge Rollers", score: 2, cas: 1, crestUrl: "/crests/dwarf.png" },
    });
    expect(fixtureContext({ name: "TABBL" }, { name: "Season 4" }, { ...s.fixtures[0]!, category: "Cup", phase: "Final" })).toBe("TABBL · Season 4 · Cup Final · Round 1");
    expect(honourValue({ WinDrawRatio: 0.955, Wins: 10, Draws: 1, Defeats: 0, Points: 22 })).toBe("10-1-0 · 22 pts");
    expect(honourValue(4.5)).toBe("4.50");
    expect(honourBoards(s).map((b) => b.title)).toEqual(["Players", "Coaches"]);
    expect(kValue(1205000)).toBe("1,205k");
    expect(kValue(null)).toBe("-");
    expect(teamValueFigures({ teamValue: 1_770_000, currentTeamValue: 1_700_000 })).toEqual({ main: { label: "CTV", value: 1_700_000 }, secondary: { label: "TV", value: 1_770_000 } });
    expect(teamValueFigures({ teamValue: 1_700_000, currentTeamValue: 1_700_000 })).toEqual({ main: { label: "TV", value: 1_700_000 } });
    expect(teamValueFigures({ teamValue: 885_000 })).toEqual({ main: { label: "TV", value: 885_000 } });
  });

  it("season pick, artwork URL guard, crest lookup, organiser check", () => {
    expect(pickSeason([s6sum, s1sum], "season-1")!.id).toBe("season-1");
    expect(pickSeason([s1sum, s6sum], "nope")!.id).toBe("season-6");
    expect(pickSeason([], undefined)).toBeUndefined();
    expect(safeArtUrl("/api/leagues/tabbl/logo?v=abc")).toBe("/api/leagues/tabbl/logo?v=abc");
    expect(safeArtUrl("javascript:alert(1)")).toBe("");
    expect(safeArtUrl("https://evil.test/x.png")).toBe("");
    expect(crestFor({ underworlddenizens: "crests/underworlddenizens.png" }, "Underworld Denizen")).toBe("/crests/underworlddenizens.png");
    expect(crestFor({ x: "../../etc" }, "x")).toBe("");
    expect(canManageLeague(league, " jay ", false)).toBe(true);
    expect(canManageLeague(league, "Mallory", false)).toBe(false);
    expect(canManageLeague(league, "Mallory", true)).toBe(true);
    expect(canManageLeague(league, "", true)).toBe(false);
  });

  it("controllers: list, detail with on-demand seasons, stats per scope cached", async () => {
    const f = mockFetcher(API);
    const list = createLeagueList({ api: f });
    await list.load();
    expect(list.state.leagues.map((l) => l.id)).toEqual(["tabbl"]);
    const d = createLeagueDetail({ api: f });
    await d.load("tabbl");
    expect(d.state.seasons.map((s) => s.id)).toEqual(["season-6", "season-1"]);
    expect(d.state.crests.dwarf).toBe("crests/dwarf.png");
    await d.ensureSeason("season-6");
    await d.ensureSeason("season-6");
    expect(f.calls.filter((c) => c.endsWith("/seasons/season-6"))).toHaveLength(1);
    await d.ensureSeason("season-1");
    expect(d.state.seasonError).toContain("no mock");
    const missing = createLeagueDetail({ api: f });
    await missing.load("nope");
    expect(missing.state.error).toBe("League not found.");
    const crestCalls = () => f.calls.filter((c) => c === "/crests/manifest.json").length;
    const crestsBefore = crestCalls();
    const st = createLeagueStats({ api: f });
    await st.load("tabbl", "all");
    await st.load("tabbl", "bb2020");
    await st.load("tabbl", "all");
    expect(f.calls.filter((c) => c.includes("/stats?scope=all"))).toHaveLength(1);
    expect(st.state.byScope.bb2020!.leaders.td[0]!.name).toBe("Old Timer");
    expect(st.state.crests.dwarf).toBe("crests/dwarf.png");
    expect(crestCalls() - crestsBefore).toBe(1); // once per controller, whatever the scopes
  });

  it("spotlight card helpers: link query per kind, season chips, tied line", () => {
    const base = { id: "top-scorer", title: "", value: "", unit: "", name: "", team: "", race: "", coach: "", detail: "", seasons: [], tied: [], icon: "" } as const;
    expect(cardQuery({ ...base, link: { kind: "player", seasonId: "season-6", teamId: "orcs", playerId: "p1" } })).toEqual({ season: "season-6", tab: "teams", team: "orcs", player: "p1" });
    expect(cardQuery({ ...base, link: { kind: "team", seasonId: "season-5", teamId: "Orcs" } })).toEqual({ season: "season-5", tab: "teams", team: "Orcs" });
    expect(cardQuery({ ...base, link: { kind: "fixture", seasonId: "season-6", fixtureId: "f9" } })).toEqual({ season: "season-6", tab: "fixtures", fixture: "f9" });
    expect(cardSeasonChips([6])).toEqual(["S6"]);
    expect(cardSeasonChips([1, 2, 3, 4])).toEqual(["S1", "S2", "S3", "S4"]);
    expect(cardSeasonChips([1, 2, 3, 4, 5, 6])).toEqual(["+3", "S4", "S5", "S6"]);
    expect(tiedLine([])).toBe("");
    expect(tiedLine(["A"])).toBe("Tied with A");
    expect(tiedLine(["A", "B"])).toBe("Tied with A and B");
    expect(tiedLine(["A", "B", "C", "D"])).toBe("Tied with A, B and 2 more");
  });
});

describe("league routes (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown; meta: Record<string, unknown> } } };
      session: unknown;
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    gateFor: (route: { meta: Record<string, unknown> }, s: unknown) => string;
    league: typeof import("../spa/src/leagues/league");
    ResultCard: unknown;
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, router, league, vueRouter, renderer, card] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/router.ts"),
      vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/ResultCard.vue"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, gateFor: router.gateFor,
      league: league as typeof import("../spa/src/leagues/league"), ResultCard: card.default,
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };

  async function render(path: string, prep?: (inject: (key: symbol, v: unknown) => void, f: Fetcher) => Promise<void>, session: Routes = ANON) {
    const f = mockFetcher({ ...API, ...session });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa };
  }
  const loadedDetail = (season = "season-6") => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason(season);
    inject(mods.league.LEAGUE_DETAIL_KEY, d);
  };

  it("router: the league routes are public; bad ids are not found", async () => {
    for (const path of ["/leagues", "/leagues/tabbl", "/leagues/tabbl/stats", "/leagues/tabbl?tab=teams&team=x"]) {
      const { html, spa } = await render(path);
      expect(mods.gateFor(spa.router.currentRoute.value, spa.session), path).toBe("allow");
      expect(html, path).not.toContain("Login with Discord to");
    }
    expect((await render("/leagues/<x>")).spa.router.currentRoute.value.name).toBe("not-found");
  });

  it("list: a card per league with header bar, logo, current season chip and actions", async () => {
    const { html } = await render("/leagues", async (inject, f) => {
      const l = mods.league.createLeagueList({ api: f });
      await l.load();
      inject(mods.league.LEAGUE_LIST_KEY, l);
    });
    expect(html).toContain(`<h1 class="sf-page-title" aria-live="polite">Leagues</h1>`);
    expect(html).toContain('src="/api/leagues/tabbl/banner?v=0123456789ab"');
    expect(html).toContain('class="lg-card-logo" src="/api/leagues/tabbl/logo?v=abcdef123456" alt=""');
    expect(html).toContain("Tahoma Area Blood Bowl League");
    expect(html).toContain("In progress");
    expect(html).toContain('href="/app/leagues/tabbl"');
    expect(html).toContain('href="/app/leagues/tabbl/stats"');
    expect(html).toMatch(/data-tone="ok"[^>]*>BB2025</);
  });

  it("list: empty and loading states", async () => {
    const empty = await render("/leagues", async (inject) => {
      const l = mods.league.createLeagueList({ api: mockFetcher({ "/api/leagues": { leagues: [] } }) });
      await l.load();
      inject(mods.league.LEAGUE_LIST_KEY, l);
    });
    expect(empty.html).toContain("No leagues yet.");
    expect((await render("/leagues")).html).toContain("Loading leagues...");
  });

  it("league page overview: header bar + logo front, season field oldest first with rules chips, tabs, latest results cards", async () => {
    const { html, spa } = await render("/leagues/tabbl", loadedDetail());
    expect(html).toContain('class="lg-front" data-banner="image"');
    expect(spa.pageTitle.state.text).toBe("TABBL"); // the league's name is the header title now
    expect(html).not.toContain("lg-front-name");
    expect(html).toContain('role="radiogroup"');
    const field = html.slice(html.indexOf('role="radiogroup"')); // the header's season dropdown lists newest first
    const s6 = field.indexOf(">Season 6<");
    const s1 = field.indexOf(">Season 1<");
    expect(s6).toBeGreaterThan(0);
    expect(s1).toBeLessThan(s6); // oldest first, left to right
    expect(html).toContain('data-ruleset="BB2020"');
    expect(html).toContain('data-ruleset="BB2025"');
    for (const t of ["Overview", "Fixtures", "Standings", "Honours", "Participants"]) expect(html).toContain(`>${t}</a>`); // the section header tabs
    expect(html).toContain("Latest results");
    expect(html.match(/class="rc-card"/g)).toHaveLength(3);
    expect(html).toContain('<span class="rc-comp">TABBL · Season 6</span>'); // league · season only, no phase, group or round
    expect(html).not.toContain("Tahoma · Round 2");
    expect(html).toContain("Conceded by Jeff / @Chap"); // the live card names the conceding coach
    expect(html).toContain('class="rc-plate-cap">Conceded<');
    expect(html).toContain('href="/app/leagues/tabbl?tab=fixtures"');
    expect(html).toContain("3 played of 4");
    expect(html).not.toContain("League artwork"); // anonymous
  });

  it("league strip: Nuffle full name, seasons highlight and Founded chip on the name line; no Statistics button; Statistics tab", async () => {
    const { html } = await render("/leagues/tabbl", loadedDetail());
    const strip = html.slice(html.indexOf('class="lg-front-body"'), html.indexOf("lg-seasons"));
    expect(strip).toContain('<h2 class="lg-front-title">Tahoma Area Blood Bowl League</h2>');
    expect(html).toMatch(/class="lg-front-line"[^]*lg-front-title[^]*lg-seasons-badge[^]*lg-founded/); // one line, in this order
    expect(html).toContain('<span class="lg-seasons-badge" aria-label="2 seasons"><b class="lg-seasons-num" aria-hidden="true">2</b>');
    expect(html).toContain('title="Founded May 29, 2026, ');
    expect(html).toContain(">Founded 05-29-2026</span>");
    expect(html).not.toContain("lg-stats-link");
    expect(html).not.toMatch(/tl-action[^>]*>Statistics/);
    const statsTab = html.match(/<a[^>]*data-tab="statistics"[^>]*>Statistics<\/a>/)?.[0] ?? "";
    expect(statsTab).toContain('href="/app/leagues/tabbl/stats"'); // the Statistics tab of the section header
    expect(statsTab).not.toContain("aria-current"); // not active on the league page
    expect(html.indexOf('data-tab="statistics"')).toBeGreaterThan(html.indexOf(">Honours</a>")); // TourPlay order
  });

  it("league strip: Founded hidden when no season has a start date; earliest start wins; singular season", () => {
    expect(mods.league.leagueFounded([{ }, { startedAt: "nope" }])).toBeNull();
    const f = mods.league.leagueFounded([{ startedAt: "2026-05-29T00:00:00.000Z" }, { startedAt: "2023-01-02T10:00:00.000Z" }], new Date("2026-10-31T00:00:00Z"))!;
    expect(f.short).toBe("01-02-2023");
    expect(f.years).toBe(3);
    expect(f.title).toBe("Founded January 2, 2023, 3 years ago");
    expect(mods.league.leagueFounded([{ startedAt: "2026-05-29T00:00:00.000Z" }], new Date("2026-10-31T00:00:00Z"))!.title).toContain("less than a year ago");
  });

  it("statistics page: league strip and the tab bar with Statistics active", async () => {
    const { html } = await render("/leagues/tabbl/stats", async (inject, f) => {
      const d = mods.league.createLeagueDetail({ api: f });
      await d.load("tabbl");
      inject(mods.league.LEAGUE_DETAIL_KEY, d);
    });
    expect(html).toContain("Tahoma Area Blood Bowl League");
    expect(html.match(/<a[^>]*data-tab="statistics"[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
    expect(html).toContain('href="/app/leagues/tabbl?tab=standings"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(">Overview</a>");
  });

  it("season row: oldest first left to right, one nowrap scrolling row", async () => {
    const { html } = await render("/leagues/tabbl", loadedDetail());
    const field = html.slice(html.indexOf('role="radiogroup"'));
    expect(field.indexOf(">Season 1<")).toBeLessThan(field.indexOf(">Season 6<"));
    const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/leagues/leagues.css", import.meta.url)), "utf8");
    const rule = css.slice(css.indexOf(".lg-season-field {"), css.indexOf("}", css.indexOf(".lg-season-field {")));
    expect(rule).toContain("flex-wrap: nowrap");
    expect(rule).toContain("overflow-x: auto");
    expect(rule).toContain("scroll-snap-type: x");
  });

  it("season row scroll: right end for the latest, picked older card kept in view, from real row-relative rects", () => {
    // The card sits inside a row that is NOT its offset parent: only rect differences count.
    const rowAt = (scrollLeft: number, scrollWidth = 1000, clientWidth = 400) => ({ scrollLeft, scrollWidth, clientWidth, getBoundingClientRect: () => ({ left: 50 }) });
    // A card whose content-left is `x` in the row's scroll space shows at rect.left = 50 + x - scrollLeft.
    const cardAt = (x: number, scrollLeft: number, width = 112) => ({ getBoundingClientRect: () => ({ left: 50 + x - scrollLeft, width }) });
    expect(mods.league.seasonRowScroll(rowAt(0), cardAt(880, 0), true)).toBe(600); // latest fully visible
    expect(mods.league.seasonRowScroll(rowAt(0, 300), null, true)).toBe(0); // fits: no scroll
    expect(mods.league.seasonRowScroll(rowAt(600), cardAt(120, 600), false)).toBe(120); // older card left of view
    expect(mods.league.seasonRowScroll(rowAt(0), cardAt(500, 0), false)).toBe(212); // right of view
    expect(mods.league.seasonRowScroll(rowAt(300), cardAt(350, 300), false)).toBe(300); // already visible
    expect(mods.league.seasonRowScroll(rowAt(0), cardAt(0, 0), false)).toBe(0);
  });

  it("season carries through every tab link, both ways; the stats page honours it", async () => {
    const { html } = await render("/leagues/tabbl?season=season-1", loadedDetail("season-1"));
    expect(html).toContain('href="/app/leagues/tabbl/stats?season=season-1"');
    expect(html).toContain('href="/app/leagues/tabbl?season=season-1&amp;tab=standings"');
    const latest = await render("/leagues/tabbl", loadedDetail());
    expect(latest.html).toContain('href="/app/leagues/tabbl/stats"'); // the latest needs no season param
    const stats = await render("/leagues/tabbl/stats?season=season-1", async (inject, f) => {
      const d = mods.league.createLeagueDetail({ api: f });
      await d.load("tabbl");
      inject(mods.league.LEAGUE_DETAIL_KEY, d);
    });
    expect(stats.html).toContain('href="/app/leagues/tabbl?season=season-1&amp;tab=standings"');
    expect(stats.html).toContain('href="/app/leagues/tabbl?season=season-1"'); // Overview and the back link
    expect(stats.html).toContain('href="/app/leagues/tabbl/stats?season=season-1"');
    expect(mods.league.carriedSeason([s1sum, s6sum], "season-6")).toBe("");
    expect(mods.league.carriedSeason([s1sum, s6sum], "season-1")).toBe("season-1");
    expect(mods.league.carriedSeason([s1sum, s6sum], "bogus")).toBe("");
  });

  it("a league with no seasons still shows the section header (empty tabs, Statistics included, are hidden)", async () => {
    const { html } = await render("/leagues/tabbl", async (inject, f) => {
      const api = mockFetcher({ ...API, "/api/leagues/tabbl": { league, seasons: [] } });
      void f;
      const d = mods.league.createLeagueDetail({ api });
      await d.load("tabbl");
      inject(mods.league.LEAGUE_DETAIL_KEY, d);
    });
    expect(html).toContain("No seasons yet.");
    expect(html).toContain('class="sf-tabs sh-tabs"');
    expect(html).toContain(">Overview</a>");
    expect(html).not.toContain('data-tab="statistics"'); // nothing played yet: hidden until there is something to show
  });

  it("league page: organisers get the Announcement and the cog in the section header; the artwork moved to management", async () => {
    const { html } = await render("/leagues/tabbl", loadedDetail(), ORGANISER);
    expect(html).not.toContain("League artwork"); // Management › Artwork now
    expect(html).not.toContain("Upload header bar");
    // Announcement megaphone next to the cog (organisers only); no news composer or Message members panel on the page.
    expect(html).toMatch(/<button[^>]*data-announce[^>]*aria-label="Announcement"/);
    expect(html.indexOf('aria-label="Announcement"')).toBeLessThan(html.indexOf('aria-label="League management"'));
    expect(html).not.toContain("lg-message");
    expect(html).not.toContain("Pin to the top");
    expect(html).not.toContain('id="lg-news-h"'); // no news, no panel, organisers too
    const visitor = await render("/leagues/tabbl", loadedDetail());
    expect(visitor.html).not.toContain('aria-label="Announcement"');
  });

  it("Announcement dialog: News post / Message members strip, each composer, Message members newest season only", async () => {
    const [dialog, appMod, sessionMod] = await Promise.all([
      vite.ssrLoadModule("/src/components/LeagueAnnounce.vue"), vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/session.ts"),
    ]);
    const f = mockFetcher({ ...API, ...ORGANISER });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-6");
    const show = (props: Record<string, unknown>) => {
      const app = createSSRApp(dialog.default, { leagueId: "tabbl", season: d.state.season["season-6"], ...props });
      app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
      app.provide(appMod.API_KEY, f);
      app.provide(sessionMod.SESSION_KEY, { coach: () => "Jay", state: {} });
      return mods.renderToString(app);
    };
    const news = await show({ canMessage: true });
    expect(news).toContain('aria-labelledby="lg-announce-h"');
    expect(news).toContain(">Announcement</h2>");
    expect(news).toMatch(/aria-pressed="true"[^>]*>News post</);
    expect(news).toMatch(/aria-pressed="false"[^>]*>Message members</);
    expect(news).toContain("Pin to the top");
    expect(news).toContain("goes to Discord when League news is on");
    expect(news).toMatch(/type="submit"[^>]*>Post news<\/button>/);
    const message = await show({ canMessage: true, initial: "message" });
    expect(message).toMatch(/aria-pressed="true"[^>]*>Message members</);
    expect(message).toContain("All members");
    expect(message).toContain("you never see their address");
    expect(message).toMatch(/type="submit"[^>]*>Send message<\/button>/);
    const older = await show({ canMessage: false, initial: "message" });
    expect(older).toMatch(/aria-pressed="true"[^>]*>News post</); // falls back to the news post
    expect(older).toMatch(/disabled[^>]*>Message members</);
    expect(older).toContain("Message members works from the newest season.");
    // While a submit is in flight: the strip, Cancel and the close button are locked; the footer says Sending...
    d.state.editBusy = "news";
    const busy = await show({ canMessage: true });
    d.state.editBusy = "";
    expect(busy).toMatch(/<button type="button" class="sf-tab" aria-pressed="true" disabled[^>]*>News post</);
    expect(busy).toMatch(/<button type="button" class="sf-tab" aria-pressed="false" disabled[^>]*>Message members</);
    expect(busy).toMatch(/class="ls-dialog-x" aria-label="Close" disabled/);
    expect(busy).toMatch(/<button type="button" class="sf-btn" disabled[^>]*>Cancel</);
    expect(busy).toMatch(/>Sending\.\.\.<\/button>/);
  });

  it("Announcement dialog posts to the season it was opened on, not the one the page moved to", async () => {
    const dialogMod = await vite.ssrLoadModule("/src/leagues/dialog.ts");
    const a = dialogMod.createAnnounce();
    a.open("season-6", "tabbl/season-6");
    const { html } = await render("/leagues/tabbl?season=season-1", async (inject, f) => {
      await loadedDetail("season-6")(inject, f);
      inject(dialogMod.ANNOUNCE_KEY, a);
    }, ORGANISER);
    const dlg = html.slice(html.indexOf('class="ls-dialog-backdrop"'));
    expect(dlg).toContain('<span class="hm-cap">Season 6</span>'); // the captured season, while the page shows Season 1
    expect(dlg).not.toContain("Message members works from the newest season."); // season 6 is the newest
  });

  it("standings, fixtures (cards + an unplayed row), teams, a team roster and honours tabs", async () => {
    const st = await render("/leagues/tabbl?tab=standings", loadedDetail());
    expect(st.html).toContain("Regular · Tahoma");
    expect(st.html).toContain("Includes Interdivision games.");
    expect(st.html).toContain("Grudge Rollers");
    const fx = await render("/leagues/tabbl?tab=fixtures", loadedDetail());
    expect(fx.html).toContain("Round 3");
    expect(fx.html).toContain("0 of 1 played");
    expect(fx.html).toContain("lg-fx-open");
    expect(fx.html).toContain(">Cards</button>");
    expect(fx.html).toContain(">Table</button>");
    const teams = await render("/leagues/tabbl?tab=teams", loadedDetail());
    expect(teams.html).toContain('href="/app/leagues/tabbl?tab=teams&amp;team=grudge-rollers"');
    expect(teams.html).toContain('src="/crests/dwarf.png"');
    const roster = await render("/leagues/tabbl?tab=teams&team=grudge-rollers", loadedDetail());
    expect(roster.html).toContain("Dethirord Slenderstrength");
    expect(roster.html).toContain("Block, Hatred (102)");
    expect(roster.html).toContain("885k");
    expect(roster.html).toContain("Left the roster");
    expect(roster.html).toContain("Gone Guy");
    // totals the export could not split are shown once on the team, never on a player
    expect(roster.html).toContain("Combined totals");
    expect(roster.html).toContain("the export cannot split their totals");
    // ...and on each candidate's own row, muted, as a shared total (never as that player's own stat)
    expect(roster.html.match(/data-shared-total/g)).toHaveLength(2);
    expect(roster.html).toContain("Shared total with 1 other: 5 TD, 0 CAS, 0 MVP, 15 SPP");
    expect(roster.html).toContain('data-player="p-bob000000007"');
    expect(roster.html).toContain('data-player="p-bob000000008"');
    expect(roster.html).not.toContain("lg-row-picked");
    // ?player=<id> opens that player's team with the row marked; an id from an earlier season resolves through previousIds
    const byPlayer = await render("/leagues/tabbl?tab=teams&player=p-bob000000008", loadedDetail());
    expect(byPlayer.html).toContain("Grudge Rollers");
    expect(byPlayer.html).toMatch(/<tr[^>]*data-player="p-bob000000008"[^>]*class="lg-row-picked"[^>]*aria-current="true"/);
    expect(byPlayer.html).not.toMatch(/data-player="p-bob000000007"[^>]*lg-row-picked/);
    const former = await render("/leagues/tabbl?tab=teams&player=p-gone00000001", loadedDetail());
    expect(former.html).toMatch(/data-player="p-gone00000001"[^>]*class="lg-row-picked"/);
    const table = await render("/leagues/tabbl?tab=fixtures&round=all", async (inject, f) => {
      const d = mods.league.createLeagueDetail({ api: f });
      await d.load("tabbl");
      await d.ensureSeason("season-6");
      inject(mods.league.LEAGUE_DETAIL_KEY, d);
    });
    // f3 (home conceded, also marked suspended): the card shows the concession with the coach, not "Suspended"
    expect(table.html).toContain("Conceded by Jeff / @Chap");
    const nobody = await render("/leagues/tabbl?tab=teams&team=Nobody", loadedDetail());
    expect(nobody.html).toContain("No team called");
    const hon = await render("/leagues/tabbl?tab=honours", loadedDetail());
    expect(hon.html).not.toContain("Loading awards..."); // the awards have their own tab now
    expect((await render("/leagues/tabbl?tab=awards", loadedDetail())).html).toContain("Loading awards..."); // league-wide, loaded on mount
    expect(hon.html).toContain("Most touchdowns");
    expect(hon.html).toContain('href="/app/leagues/tabbl?season=season-6&amp;tab=teams&amp;player=p-deth00000001"'); // a board row that is one player links by id
    expect(hon.html).toContain("10-1-0 · 22 pts");
  });

  it("fixtures nav bar: round strip opens on the current round, ?round= picks one or all, Prev / Next, team filter, view toggle", async () => {
    const active = (html: string) => [...html.matchAll(/<a([^>]*)>(All|Round \d+)<\/a>/g)].filter((m) => m[1]!.includes('aria-current="page"')).map((m) => m[2]);
    const cur = await render("/leagues/tabbl?tab=fixtures", loadedDetail());
    expect(cur.html).toContain('aria-labelledby="lg-fx-nav-h"');
    expect(cur.html).toMatch(/aria-label="Rounds"[^]*>All<\/a>[^]*>Round 1<\/a>[^]*>Round 2<\/a>[^]*>Round 3<\/a>/);
    expect(active(cur.html)).toEqual(["Round 3"]); // the first round with an unplayed fixture
    expect(cur.html).toContain("Round 3 · 0 of 1 played");
    expect(cur.html).not.toContain("Conceded by Jeff / @Chap"); // f3 is round 2
    expect(cur.html).toMatch(/aria-label="Previous round, Round 2"/);
    expect(cur.html).toMatch(/<span class="sf-btn small lg-fx-step" aria-disabled="true">Next ›<\/span>/);
    expect(cur.html).toContain('href="/app/leagues/tabbl?tab=fixtures&amp;round=all"');
    expect(cur.html).toMatch(/<option value=""[^>]*>All teams<\/option>/);
    expect(cur.html).toContain('<option value="Grudge Rollers">Grudge Rollers</option>');
    expect(cur.html).toMatch(/aria-pressed="true"[^>]*>Cards<\/button>/);
    expect(cur.html).toMatch(/aria-pressed="false"[^>]*>Table<\/button>/);
    const r2 = await render("/leagues/tabbl?tab=fixtures&round=2", loadedDetail());
    expect(r2.html).toContain("Conceded by Jeff / @Chap");
    expect(active(r2.html)).toEqual(["Round 2"]);
    expect(r2.html.match(/class="rc-card"/g)).toHaveLength(1); // round 2 = f3 only
    const all = await render("/leagues/tabbl?tab=fixtures&round=all", loadedDetail());
    expect(active(all.html)).toEqual(["All"]);
    expect(all.html).toContain("All rounds · 3 of 4 played");
    expect(all.html).not.toContain("Previous round");
    const bogus = await render("/leagues/tabbl?tab=fixtures&round=99", loadedDetail());
    expect(bogus.html).toContain("Round 3 · 0 of 1 played"); // an unknown round falls back to the current one
  });

  it("fixtures table view (remembered per viewer): Round, Date, Home, Score, Away, Status; rows open the fixture summary", async () => {
    const store = new Map<string, string>([["sf-league-fixtures-view", "table"]]);
    const g = globalThis as { localStorage?: unknown };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      const { html } = await render("/leagues/tabbl?tab=fixtures&round=all", loadedDetail());
      expect(html).toMatch(/aria-pressed="true"[^>]*>Table<\/button>/);
      expect(html).toMatch(/<th scope="col">Round<\/th><th scope="col">Date<\/th><th scope="col">Home<\/th><th scope="col" class="lg-fx-c">Score<\/th><th scope="col">Away<\/th><th scope="col">Status<\/th>/);
      expect(html.match(/class="lg-fx-row"/g)).toHaveLength(4);
      expect(html).toContain('class="lg-fx-crest" src="/crests/dwarf.png"');
      expect(html).toMatch(/<a[^>]*href="\/app\/leagues\/tabbl\?tab=fixtures&amp;fixture=f2"[^>]*lg-fx-score"/);
      expect(html).toMatch(/data-open="true"[^>]*>(<!--\[-->)?vs/); // f4 unplayed: "vs" in the box
      expect(html).toContain('data-status="played"');
      expect(html).toContain('data-status="forfeit"'); // f3: home conceded
      expect(html).toContain('data-status="scheduled"');
      expect(html).toContain("Rot Girl Summer conceded");
      expect(html).toContain('aria-label="Fixture summary: Grudge Rollers 1–1 Rot Girl Summer"'); // the score stays in the name
      expect(html).toContain('aria-label="Fixture summary: Grudge Rollers vs Rot Girl Summer"'); // f4 unplayed
      expect(html).not.toContain('class="rc-card"');
    } finally { delete g.localStorage; }
  });

  it("statistics: the BB2020 | BB2025 | All time divider and the aggregate panels", async () => {
    const all = await render("/leagues/tabbl/stats", async (inject, f) => {
      const s = mods.league.createLeagueStats({ api: f });
      await s.load("tabbl", "all");
      inject(mods.league.LEAGUE_STATS_KEY, s);
    });
    expect(all.html).toContain('aria-label="Rules edition"');
    expect(all.html).toMatch(/aria-checked="true"[^>]*>All time</);
    for (const label of ["BB2020", "BB2025", "All time"]) expect(all.html).toContain(`>${label}</button>`);
    for (const panel of ["Champions", "Player leaders", "Coach records", "Team records", "Race win rates", "Biggest wins", "Most games"]) expect(all.html).toContain(panel);
    expect(all.html).toContain("Dethirord Slenderstrength");
    expect(all.html).toContain('href="/app/leagues/tabbl?season=season-6&amp;tab=teams&amp;player=p-deth00000001"'); // leaders link by player id
    expect(all.html).toContain("83%");
    expect(all.html).toContain("Pre-season");
    // spotlight cards on top of the scope, before the totals panel
    expect(all.html).toContain('aria-label="All time spotlight"');
    expect(all.html.indexOf("lg-spot-row")).toBeLessThan(all.html.indexOf('id="lg-tot-h"'));
    expect(all.html.match(/class="lg-spot"/g)).toHaveLength(4);
    expect(all.html).toMatch(/data-card="top-scorer"[\s\S]*?lg-spot-num">12<[\s\S]*?lg-spot-unit">TD</);
    expect(all.html).toContain('href="/app/leagues/tabbl?season=season-6&amp;tab=teams&amp;team=grudge-rollers&amp;player=p-deth00000001"');
    expect(all.html).toContain('href="/app/leagues/tabbl?season=season-6&amp;tab=teams&amp;team=grudge-rollers"');
    expect(all.html).toContain('href="/app/leagues/tabbl?season=season-6&amp;tab=fixtures&amp;fixture=f1"');
    expect(all.html).toContain('src="/icons/panel/games.png"');
    expect(all.html).toContain('class="lg-spot-crest" src="/crests/dwarf.png"'); // race crest via the crest manifest
    expect(all.html).toContain('class="lg-spot-crest lg-spot-blank"'); // a race without a crest: initials
    expect(all.html).toContain("Grudge Rollers · Dwarf"); // a player card: team + race
    expect(all.html).toContain("flutethecat (Jay) · Dwarf"); // a team card: coach + race
    expect(all.html).toContain(">+2</span>"); // five seasons fold into +2 S4 S5 S6
    expect(all.html).toContain("Tied with Bob, Ug and 1 more");
    expect(all.html).toContain("Tied with Rot Girl Summer 3-0 Grudge Rollers");
    const old = await render("/leagues/tabbl/stats?scope=bb2020", async (inject, f) => {
      const s = mods.league.createLeagueStats({ api: f });
      await s.load("tabbl", "bb2020");
      inject(mods.league.LEAGUE_STATS_KEY, s);
    });
    expect(old.html).toMatch(/aria-checked="true"[^>]*>BB2020</);
    expect(old.html).toContain("Old Timer");
    expect(old.html).not.toContain("lg-spot-row"); // no cards in this scope: no row
    expect((await render("/leagues/tabbl/stats")).html).toContain("Loading statistics...");
  });

  it("the league feeds the shared ResultCard: race tones, coach on each side, crest or initials, concession by coach", async () => {
    const renderCard = (props: Record<string, unknown>) => mods.renderToString(createSSRApp(mods.ResultCard as never, props));
    const s = season6();
    const props = mods.league.resultCardProps(league, s, s.fixtures[2]!, { dwarf: "crests/dwarf.png" });
    expect(props).toMatchObject({ concede: "home", suspended: false, home: { coach: "Jeff / @Chap", crestUrl: null }, away: { coach: "flutethecat (Jay)", crestUrl: "/crests/dwarf.png" } });
    const html = await renderCard(props);
    expect(html).toContain(`--rc-home:${raceTone("Nurgle")}`);
    expect(html).toContain(`--rc-away:${raceTone("Dwarf")}`);
    expect(html).toContain('src="/crests/dwarf.png"');
    expect(html).toContain('class="rc-crest rc-initials" aria-hidden="true">RG<');
    expect(html).toContain('<small class="rc-cas">(1)</small>');
    expect(html).toContain("flutethecat (Jay)");
    expect(html).toContain("Conceded by Jeff / @Chap");
    expect(html).toContain('data-conceded="true"');
    expect(html).toContain('<span class="rc-comp">TABBL · Season 6</span>');
    expect(html).not.toMatch(/Round 2|Regular|Tahoma/);
    // an ordinary result: no concession, no flag
    const plain = await renderCard(mods.league.resultCardProps(league, s, s.fixtures[1]!, {}));
    expect(plain).not.toContain("Conceded");
    expect(plain).not.toContain("rc-flag");
    // a suspended game with no concession is not played: it never reaches a card (latestResults / fixturePlayed)
    expect(mods.league.fixturePlayed({ ...s.fixtures[1]!, suspended: true, home: { ...s.fixtures[1]!.home, score: 0 }, away: { ...s.fixtures[1]!.away, score: 0 } })).toBe(false);
  });
});

describe("fixtures nav helpers (round strip, filters, status, remembered view)", () => {
  it("rounds, the current round, ?round= parsing and Prev / Next", () => {
    const groups = fixturesByPhase(season6());
    expect(fixtureRounds(groups)).toEqual([1, 2, 3]);
    expect(currentRound(groups)).toBe(3); // f4 (round 3) is the first unplayed
    const done = fixturesByPhase({ ...season6(), fixtures: season6().fixtures.slice(0, 3) });
    expect(currentRound(done)).toBe(2); // all played: the last round
    expect(currentRound([])).toBe("all");
    expect(parseRound("2", [1, 2, 3])).toBe(2);
    expect(parseRound("all", [1, 2, 3])).toBe("all");
    expect(parseRound("9", [1, 2, 3])).toBeUndefined();
    expect(parseRound("2x", [1, 2, 3])).toBeUndefined();
    expect(parseRound(undefined, [1, 2, 3])).toBeUndefined();
    expect(roundSteps([1, 2, 3], 2)).toEqual({ prev: 1, next: 3 });
    expect(roundSteps([1, 2, 3], 1)).toEqual({ next: 2 });
    expect(roundSteps([1, 2, 3], 3)).toEqual({ prev: 2 });
    expect(roundSteps([1, 2, 3], "all")).toEqual({});
  });

  it("round and team filters drop empty rounds and phases and recount played", () => {
    const groups = fixturesByPhase(season6());
    expect(fixtureTeams(groups)).toEqual(["Grudge Rollers", "Rot Girl Summer"]);
    const r1 = filterFixtures(groups, 1, "");
    expect(r1.map((g) => g.phase.id)).toEqual(["season-preseason", "season-regular"]); // round 1 in both phases
    expect(r1.flatMap((g) => g.rounds.flatMap((r) => r.fixtures.map((f) => f.id)))).toEqual(["f1", "f2"]);
    const r3 = filterFixtures(groups, 3, "");
    expect(r3).toHaveLength(1);
    expect(r3[0]!.rounds[0]!.played).toBe(0);
    expect(filterFixtures(groups, "all", "Nobody")).toEqual([]);
    expect(filterFixtures(groups, "all", "Grudge Rollers").flatMap((g) => g.rounds).length).toBe(4);
  });

  it("status chip: played, forfeit, suspended / not played, overdue, scheduled", () => {
    const [f1, , f3, f4] = season6().fixtures;
    expect(fixtureStatus(f1!, "2026-11-01")).toEqual({ label: "Played", tone: "ok" });
    expect(fixtureStatus(f3!, "2026-11-01")).toEqual({ label: "Forfeit", tone: "soon" });
    expect(fixtureStatus(f4!, "2026-11-01")).toEqual({ label: "Scheduled", tone: "muted" });
    expect(fixtureStatus({ ...f4!, date: "2026-10-01" }, "2026-11-01")).toEqual({ label: "Overdue", tone: "urgent" });
    expect(fixtureStatus({ ...f4!, date: "2026-12-01" }, "2026-11-01").label).toBe("Scheduled");
    expect(fixtureStatus({ ...f4!, suspended: true }, "2026-11-01")).toEqual({ label: "Not played", tone: "muted" });
  });

  it("filters reset to off when the season no longer offers them; the score link label keeps the score", () => {
    expect(keepTeam("Grudge Rollers", ["Grudge Rollers", "Orcs"])).toBe("Grudge Rollers");
    expect(keepTeam("Gone Team", ["Grudge Rollers"])).toBe("");
    expect(keepPhase("season-regular", ["season-regular"])).toBe("season-regular");
    expect(keepPhase("season-playoffs", ["season-regular"])).toBe("all");
    const [f1, , , f4] = season6().fixtures;
    expect(scoreLinkLabel(f1!)).toBe("Fixture summary: Grudge Rollers 1–1 Rot Girl Summer");
    expect(scoreLinkLabel(f4!)).toBe("Fixture summary: Grudge Rollers vs Rot Girl Summer");
  });

  it("Announcement state: captures the season, closes on a league or season move, keeps the confirmation until any move", () => {
    const a = createAnnounce();
    a.open("season-6", "tabbl/season-6");
    expect(a.state.seasonId).toBe("season-6");
    a.moved("tabbl/season-6"); // same league and season (e.g. another tab): stays open
    expect(a.state.seasonId).toBe("season-6");
    a.moved("tabbl/season-5"); // another season: closed, drafts go with the dialog
    expect(a.state.seasonId).toBe("");
    a.open("season-6", "tabbl/season-6");
    a.moved("other/season-1"); // another league
    expect(a.state.seasonId).toBe("");
    a.open("season-6", "tabbl/season-6");
    a.done("News posted.");
    expect(a.state).toMatchObject({ seasonId: "", notice: "News posted." });
    a.moved("tabbl/season-6");
    expect(a.state.notice).toBe("");
    a.open("season-6", "tabbl/season-6");
    a.close();
    expect(a.state.seasonId).toBe("");
  });

  it("the Cards | Table choice is remembered per viewer and never needs storage", () => {
    const g = globalThis as { localStorage?: unknown };
    expect(readFixturesView()).toBe("cards"); // no storage at all
    const store = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      writeFixturesView("table");
      expect(readFixturesView()).toBe("table");
      store.set("sf-league-fixtures-view", "nonsense");
      expect(readFixturesView()).toBe("cards");
      g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
      expect(readFixturesView()).toBe("cards");
      expect(() => writeFixturesView("table")).not.toThrow();
    } finally { delete g.localStorage; }
  });
});
