import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { phaseComplete, phaseFoldId, phaseFoldKey, phaseOpen, readPhaseFolds, writePhaseFold } from "../spa/src/leagues/fixtureNav";
import { currentStandingsPhase, pickStandingsPhase, standingsPhaseOptions } from "../spa/src/leagues/standingsView";
import { coachTitles, honoursView, playerLeaderBoards } from "../spa/src/leagues/hallViews";
import { coachAvatarSrc, coachSummaryOf, findCoachRecord, teamForRow, wdlLine } from "../spa/src/leagues/popups";
import type { CoachRecord, LeagueTeam, SeasonRecord } from "../spa/src/leagues/types";

// League UX pass A (owner 11-02): fixtures phases collapse, the standings phase selector and popups, the honours pin icon
// and Player / Coach / Team selector. Pure helpers here; rendered checks where a template carries the rule.
const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");

const round = (played: number, total: number) => ({ round: 1, played, fixtures: Array.from({ length: total }, () => ({})) });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  };
}

describe("fixtures: collapsible phases", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a phase is complete when every fixture of every round is played; a phase without fixtures is not", () => {
    expect(phaseComplete({ rounds: [round(4, 4), round(2, 2)] as never })).toBe(true);
    expect(phaseComplete({ rounds: [round(4, 4), round(1, 2)] as never })).toBe(false);
    expect(phaseComplete({ rounds: [] })).toBe(false);
  });

  it("defaults: completed phases collapsed, the current and coming ones open; a viewer's toggle wins", () => {
    const done = { rounds: [round(2, 2)] } as never;
    const live = { rounds: [round(2, 2), round(0, 2)] } as never;
    expect(phaseOpen({}, "s6:pre", done)).toBe(false);
    expect(phaseOpen({}, "s6:regular", live)).toBe(true);
    expect(phaseOpen({ "s6:pre": true }, "s6:pre", done)).toBe(true);
    expect(phaseOpen({ "s6:regular": false }, "s6:regular", live)).toBe(false);
  });

  it("toggles persist per league in localStorage, keyed by season and phase; junk and missing storage fall back to the defaults", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readPhaseFolds("harbour")).toEqual({});
    writePhaseFold("harbour", phaseFoldId("season-6", "pre"), true);
    writePhaseFold("harbour", phaseFoldId("season-6", "regular"), false);
    expect(readPhaseFolds("harbour")).toEqual({ "season-6:pre": true, "season-6:regular": false });
    expect(readPhaseFolds("other-league")).toEqual({}); // per league
    expect(localStorage.getItem(phaseFoldKey("harbour"))).toBe('{"season-6:pre":true,"season-6:regular":false}');
    localStorage.setItem(phaseFoldKey("harbour"), "not json");
    expect(readPhaseFolds("harbour")).toEqual({});
    localStorage.setItem(phaseFoldKey("harbour"), '{"a":true,"b":"yes","c":1}');
    expect(readPhaseFolds("harbour")).toEqual({ a: true });
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readPhaseFolds("harbour")).toEqual({});
    expect(writePhaseFold("harbour", "x", true)).toEqual({ x: true }); // no throw; the session keeps the toggle
  });

  it("the phase band is a button with aria-expanded; the table view is unchanged", () => {
    const vue = src("components/LeagueFixtures.vue");
    expect(vue).toMatch(/<button type="button" class="lg-fx-fold" :aria-expanded="isOpen\(g\.phase\.id\) \? 'true' : 'false'" data-phase-toggle @click="toggle\(g\.phase\.id\)">/);
    expect(vue).toContain('<template v-if="!isOpen(g.phase.id)" />');
    expect(vue).toContain('<table v-else class="sf-table lg-fx-table">');
    // completion is judged on the whole phase, not the round on show
    expect(vue).toContain("const wholePhase = (id: string) => groups.value.find((x) => x.phase.id === id)");
  });
});

// ---- standings: phase selector and the shared popups
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const phase = (id: string, name: string, rows = 2) => ({
  id, category: "Season", name, groups: [""], standingsSource: "computed" as const,
  standings: Array.from({ length: rows }, (_, i) => ({ group: "", rank: i + 1, team: `Team ${i + 1}`, teamId: `t${i + 1}`, race: "Orc", coach: `Coach${i + 1}`, coachId: `Coach${i + 1}`,
    points: 3 - i, played: 1, wins: 1 - i, draws: 0, losses: i, tdFor: 2, tdAgainst: 1, casFor: 1, casAgainst: 0 })),
});
const fixture = (id: string, phaseId: string, played: boolean) => ({ id, phaseId, phase: phaseId, category: "Season", group: "", round: 1, table: 1, suspended: false,
  home: { team: "Team 1", coach: "Coach1", race: "Orc", score: played ? 1 : null, cas: played ? 0 : null, conceded: false },
  away: { team: "Team 2", coach: "Coach2", race: "Orc", score: played ? 0 : null, cas: played ? 0 : null, conceded: false } });
const player = { playerId: "p1", number: 1, name: "Grimtooth", position: "Orc Blitzer", ma: 6, st: 3, ag: 3, pa: 4, av: 10, skills: ["Block", "Tackle"], value: 90000, level: "Experienced",
  availableSpp: 2, niggling: 0, missNextGame: false, stats: { td: 2, cas: 1, mvp: 1, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 17, performance: 0 } };
const team = (id: string, name: string): LeagueTeam => ({ id, name, race: "Orc", coach: "Coach1", coachId: "Coach1", teamValue: 1100000, treasury: 20000, rerolls: 3, fans: 2,
  assistantCoaches: 1, cheerleaders: 0, apothecary: true, tier: "", raceLeague: "", players: [player], formerPlayers: [] });
const season = (): SeasonRecord => ({
  id: "season-6", leagueId: "harbour", number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active", importedAt: "2026-10-01T00:00:00.000Z",
  phases: [phase("pre", "Pre"), phase("regular", "Regular", 3), { ...phase("playoffs", "Playoffs", 0), standings: [], format: "knockout" }],
  fixtures: [fixture("f1", "pre", true), fixture("f2", "regular", true), fixture("f3", "regular", false), fixture("f4", "playoffs", false)],
  participants: [], teams: [team("t1", "Team 1"), team("t2", "Team 2")], honours: [], awards: [],
} as unknown as SeasonRecord);
// A record carrying fields that must never reach a popup (a server bug, a future field): the popup copies public fields only.
const leaky = { coach: "Coach1", coachId: "Coach1", seasons: [5, 6], teams: 2, titles: 1, games: 10, wins: 6, draws: 2, losses: 2, points: 20, tdFor: 9, tdAgainst: 5,
  casFor: 4, casAgainst: 3, winPct: 0.7, email: "coach1@example.com", phone: "+1 555 0100", discordId: "123456789012345678" } as CoachRecord;
const leader = (name: string, value: number) => ({ playerId: `p-${name}`, seasonId: "season-6", teamId: "t1", name, position: "Orc Blitzer", team: "Team 1", race: "Orc", coach: "Coach1", seasons: [6], value });
const STATS_ALL = {
  coaches: [leaky], teams: [{ team: "Team 1", race: "Orc", coach: "Coach1", seasons: [5, 6], games: 12, wins: 8, draws: 2, losses: 2, points: 26, tdFor: 20, tdAgainst: 9, casFor: 10, casAgainst: 4, winPct: 0.75 }],
  leaders: { td: [leader("Grimtooth", 21)], cas: [leader("Bonecrusher", 14)], mvp: [leader("Snaga", 6)], spp: [leader("Grimtooth", 88)], int: [], completions: [], fouls: [] },
  champions: [{ seasonId: "season-5", season: 5, ruleset: "BB2025", coach: "Coach1", team: "Team 1", race: "Orc" }],
};

describe("standings: phase selector", () => {
  it("lists the phases that have a table, opens on the phase being played (or the last table before a knockout), honours ?phase=", () => {
    const s = season();
    const tables = [{ key: "pre:" }, { key: "regular:" }];
    const options = standingsPhaseOptions(s, tables);
    expect(options.map((o) => o.id)).toEqual(["pre", "regular"]);
    expect(currentStandingsPhase(s, options)).toBe("regular");
    // every regular game played: the knockout (no table) is live, so the regular table stays the current one
    s.fixtures = s.fixtures.map((f) => (f.phaseId === "regular" ? fixture(f.id, "regular", true) : f)) as never;
    expect(currentStandingsPhase(s, options)).toBe("regular");
    // nothing played after the pre-season: it is the current one
    s.fixtures = [fixture("f1", "pre", false), fixture("f2", "regular", false)] as never;
    expect(currentStandingsPhase(s, options)).toBe("pre");
    expect(pickStandingsPhase("pre", options, "regular")).toBe("pre");
    expect(pickStandingsPhase("all", options, "regular")).toBe("all");
    expect(pickStandingsPhase("playoffs", options, "regular")).toBe("regular"); // no table: the current phase
    expect(pickStandingsPhase(undefined, options, "regular")).toBe("regular");
    expect(currentStandingsPhase(s, [])).toBe("all");
  });
});

describe("shared popups: public fields only", () => {
  it("the coach summary copies the public record fields and finds the coach by account, else by a unique name", () => {
    const stats = { coaches: [leaky, { ...leaky, coach: "Twin", coachId: "a" }, { ...leaky, coach: "Twin", coachId: "b" }] };
    expect(findCoachRecord(stats, "anything", "coach1")).toBe(leaky); // case-insensitive account match
    expect(findCoachRecord(stats, "Coach1")).toBe(leaky);
    expect(findCoachRecord(stats, "Twin")).toBeUndefined(); // two coaches share the name: no guess
    const s = coachSummaryOf(leaky);
    expect(Object.keys(s).sort()).toEqual(["coach", "draws", "games", "losses", "seasons", "teams", "titles", "winRate", "wins"]);
    expect(JSON.stringify(s)).not.toMatch(/example\.com|555|123456789012345678/);
    expect(wdlLine(s)).toBe("6-2-2");
    expect(coachAvatarSrc("Coach One")).toBe("/api/coach-avatars/Coach%20One"); // the site's own public avatar route
    expect(coachAvatarSrc(undefined)).toBe("");
  });

  it("a standings row opens its team by id, else by a unique name", () => {
    const teams = [team("t1", "Team 1"), team("t2", "Team 2"), team("t3", "Twin"), team("t4", "Twin")];
    expect(teamForRow(teams, { teamId: "t2", team: "x" })?.id).toBe("t2");
    expect(teamForRow(teams, { team: "team 1" })?.id).toBe("t1");
    expect(teamForRow(teams, { team: "Twin" })).toBeUndefined();
  });
});

describe("standings + popups: rendered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, app, league, honours, standings, coach, roster, hof] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("/src/leagues/honours.ts"), vite.ssrLoadModule("/src/components/LeagueStandings.vue"), vite.ssrLoadModule("/src/components/CoachSummaryDialog.vue"),
      vite.ssrLoadModule("/src/components/RosterDialog.vue"), vite.ssrLoadModule("/src/components/LeagueHonours.vue"),
    ]);
    m = { renderer, vueRouter, app, league, honours, Standings: standings.default, Coach: coach.default, Roster: roster.default, Honours: hof.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, props: Record<string, unknown>, path = "/leagues/harbour?tab=standings", hall?: unknown): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [
      { path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/leagues/:id/stats", name: "league-stats", component: blank }, { path: "/:p(.*)*", component: blank },
    ] });
    await router.push(path);
    await router.isReady();
    const app = createSSRApp(component as never, props);
    app.use(router);
    const api = (async (p: string) => { if (p.includes("/stats")) return { coaches: [leaky] }; throw new Error(`no mock for ${p}`); }) as never;
    app.provide(m.app.API_KEY, api);
    const stats = m.league.createLeagueStats({ api });
    stats.state.id = "harbour";
    stats.state.byScope.all = STATS_ALL;
    app.provide(m.league.LEAGUE_STATS_KEY, stats);
    const h = m.honours.createHonours({ api });
    h.state.leagueId = "harbour";
    h.state.loaded = true;
    h.state.view = hall ?? null;
    app.provide(m.honours.LEAGUE_HONOURS_KEY, h);
    return ((await m.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }

  it("standings: the selector sits in the first band, opens on the current phase; team and coach names are popup buttons", async () => {
    const html = await render(m.Standings, { season: season(), leagueId: "harbour" });
    expect(html.match(/<section class="hm-panel"/g)).toHaveLength(1); // the current phase only
    expect(html).toContain('aria-label="Regular"');
    expect(html).toMatch(/<select data-standings-phase[^>]*>(<option[^>]*>[^<]*<\/option>){2}<option value="all">All phases<\/option><\/select>/);
    expect(html).toMatch(/<button type="button" class="lg-team-name lg-st-link" data-team-open aria-haspopup="dialog" aria-label="Team 1: roster">Team 1<\/button>/);
    expect(html).toMatch(/<button type="button" class="lg-st-link lg-st-coach" data-coach-open aria-haspopup="dialog" aria-label="Coach1: coach summary">Coach1<\/button>/);
    const all = await render(m.Standings, { season: season(), leagueId: "harbour" }, "/leagues/harbour?tab=standings&phase=all");
    expect(all.match(/<section class="hm-panel"/g)).toHaveLength(2);
  });

  it("the coach summary popup: avatar route, win rate, games, W-D-L, titles, a league-record link; never contact details", async () => {
    const html = await render(m.Coach, { leagueId: "harbour", coach: "Coach1", coachId: "Coach1", team: "Team 1", race: "Orc" });
    expect(html).toContain('src="/api/coach-avatars/Coach1"');
    expect(html).toMatch(/data-stat="winrate"><dt>Win rate<\/dt><dd>70%<\/dd>/);
    expect(html).toMatch(/data-stat="games"><dt>Games<\/dt><dd>10<\/dd>/);
    expect(html).toMatch(/data-stat="wdl"><dt>W-D-L<\/dt><dd>6-2-2<\/dd>/);
    expect(html).toMatch(/<a[^>]*href="\/app\/leagues\/harbour\/stats\?scope=all#lg-coach-h"[^>]*data-coach-profile-link/);
    expect(html).not.toMatch(/example\.com|555 0100|123456789012345678|discord/i);
    const blank = await render(m.Coach, { leagueId: "harbour", coach: "Nobody" });
    expect(blank).toContain('class="cs-avatar cs-avatar-blank"');
    expect(blank).toContain("No games recorded in this league yet.");
  });

  it("the roster popup: the team page's columns at a glance and a link to the full team page", async () => {
    const html = await render(m.Roster, { leagueId: "harbour", seasonId: "season-6", team: team("t1", "Team 1") });
    expect(html).toMatch(/<th scope="col" class="lg-num">#<\/th><th scope="col">Player<\/th><th scope="col" class="lg-num">MA<\/th><th scope="col" class="lg-num">ST<\/th><th scope="col" class="lg-num">AG<\/th><th scope="col" class="lg-num">PA<\/th><th scope="col" class="lg-num">AV<\/th><th scope="col">Skills<\/th><th[^>]*>SPP<\/th><th scope="col" class="lg-num">Value<\/th>/);
    expect(html).toContain(">Grimtooth</span><small>Orc Blitzer</small>");
    expect(html).toContain("Block, Tackle");
    expect(html).toContain(">90k<");
    expect(html).toMatch(/href="\/app\/leagues\/harbour\?season=season-6&amp;tab=teams&amp;team=t1"[^>]*data-team-page-link/);
  });
});

// ---- honours: pin icon (organisers) and the Player / Coach / Team selector
const HALL = {
  revision: 1,
  hallOfFame: [
    { seasonId: "season-5", number: 5, name: "Season 5", ruleset: "BB2025", champion: { team: "Team 1", coach: "Coach1", race: "Orc" }, runnerUp: { team: "Team 2", coach: "Coach2", race: "Elf" }, source: "podium" },
    { seasonId: "season-4", number: 4, name: "Season 4", ruleset: "BB2020", champion: { team: "Team 9", coach: "coach1", race: "Orc" }, runnerUp: { team: "Team 1", coach: "Coach2", race: "Orc" }, source: "podium" },
    { seasonId: "season-3", number: 3, name: "Season 3", ruleset: "BB2020", champion: { team: "Team 2", coach: "Coach2", race: "Elf" }, source: "podium" },
  ],
  pins: [{ id: "pin1", kind: "champion", seasonId: "season-5", note: "", by: "Olga", at: "2026-07-02T00:00:00.000Z", resolved: { title: "Season 5 champion", team: "Team 1", coach: "Coach1", race: "Orc", seasonName: "Season 5" } }],
  awards: [],
};
const seasonWithBoards = (): SeasonRecord => ({
  ...season(),
  honours: [
    { key: "season:td", category: "season", stat: "mosttouchdowns", kind: "player", rows: [{ rank: 1, name: "Grimtooth", team: "Team 1", coach: "Coach1", playerId: "p1", value: 5 }] },
    { key: "season:team-td", category: "season", stat: "mosttouchdowns", kind: "team", rows: [{ rank: 1, name: "Team 1", team: "Team 1", coach: "Coach1", value: 9 }] },
    { key: "season:record", category: "season", stat: "record", kind: "coach", rows: [{ rank: 1, name: "Coach1", team: "Team 1", coach: "Coach1", value: { Wins: 3, Draws: 0, Defeats: 0, Points: 9 } }] },
  ],
} as unknown as SeasonRecord);

describe("honours: helpers", () => {
  it("?view= is player, coach or team (default team)", () => {
    expect(honoursView("player")).toBe("player");
    expect(honoursView(["coach"])).toBe("coach");
    expect(honoursView("nonsense")).toBe("team");
    expect(honoursView(undefined)).toBe("team");
  });
  it("coach titles count the podium champions per coach (case-insensitive), then runner-ups", () => {
    const t = coachTitles(HALL.hallOfFame as never);
    expect(t.map((c) => [c.coach, c.titles, c.runnerUps])).toEqual([["Coach1", 2, 0], ["Coach2", 1, 2]]);
    expect(t[0]!.teams).toEqual(["Team 1", "Team 9"]);
  });
  it("player records: the leader of each stat and the next two, zero rows left out", () => {
    const b = playerLeaderBoards({ leaders: { td: [leader("A", 9), leader("B", 8), leader("C", 7), leader("D", 6)], cas: [leader("Z", 0)], mvp: [], spp: [], int: [], completions: [], fouls: [] } } as never);
    expect(b.map((x) => x.id)).toEqual(["td"]);
    expect(b[0]!.top.name).toBe("A");
    expect(b[0]!.rest.map((r) => r.name)).toEqual(["B", "C"]);
  });
});

describe("honours: rendered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, app, league, honours, hof] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"),
      vite.ssrLoadModule("/src/leagues/honours.ts"), vite.ssrLoadModule("/src/components/LeagueHonours.vue"),
    ]);
    m = { renderer, vueRouter, app, league, honours, Honours: hof.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(view: string, manage: boolean): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [
      { path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/:p(.*)*", component: blank },
    ] });
    await router.push(`/leagues/harbour?tab=honours${view ? `&view=${view}` : ""}`);
    await router.isReady();
    const app = createSSRApp(m.Honours, { season: seasonWithBoards(), manage, awards: false });
    app.use(router);
    const api = (async () => { throw new Error("no api"); }) as never;
    app.provide(m.app.API_KEY, api);
    const stats = m.league.createLeagueStats({ api });
    stats.state.id = "harbour";
    stats.state.byScope.all = STATS_ALL;
    app.provide(m.league.LEAGUE_STATS_KEY, stats);
    const h = m.honours.createHonours({ api });
    Object.assign(h.state, { leagueId: "harbour", loaded: true, view: JSON.parse(JSON.stringify(HALL)) });
    app.provide(m.honours.LEAGUE_HONOURS_KEY, h);
    return ((await m.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }

  it("organisers get a pin icon at the top right of each card (Pin / Unpin); no Pin text buttons", async () => {
    const html = await render("", true);
    expect(html).toMatch(/data-season="season-5" data-pinned="true"[^]*?<button type="button" class="hof-pin" data-pinned="true"[^>]*aria-label="Unpin" title="Unpin the Season 5 champion"/);
    expect(html).toMatch(/data-season="season-4"[^]*?<button type="button" class="hof-pin" data-pinned="false"[^>]*aria-label="Pin" title="Pin the Season 4 champion"/);
    expect(html).not.toMatch(/>\s*Pin\s*</);
    expect(html).not.toContain("hof-pin-mark");
  });

  it("the public sees the pinned mark only, never a pin button", async () => {
    const html = await render("", false);
    expect(html).not.toContain('class="hof-pin"');
    expect(html.match(/class="hof-pin-mark" role="img" aria-label="Pinned"/g)).toHaveLength(1);
    expect(html).toMatch(/data-season="season-5" data-pinned="true"[^]*?hof-pin-mark/);
    expect(html).not.toContain("Unpin");
  });

  it("the selector switches the Hall of Fame and the season's boards together", async () => {
    const team = await render("", false);
    expect(team).toMatch(/<button type="button" class="sf-tab" data-view="team" aria-pressed="true">Team<\/button>/);
    expect(team).toContain('aria-label="Season champions"');
    expect(team).toContain('data-kind="team"');
    expect(team).not.toContain('data-kind="player"');

    const player = await render("player", false);
    expect(player).toMatch(/data-view="player" aria-pressed="true">Player<\/button>/);
    expect(player).toContain('aria-label="Player records"');
    expect(player).toMatch(/data-stat="td"[^]*Most touchdowns[^]*class="hof-team">Grimtooth</);
    expect(player).not.toContain('aria-label="Season champions"');
    expect(player).toContain('data-kind="player"');
    expect(player).not.toContain('data-kind="team"');

    const coach = await render("coach", false);
    expect(coach).toMatch(/data-view="coach" aria-pressed="true">Coach<\/button>/);
    expect(coach).toMatch(/aria-label="Coach titles"[^]*<h3>Coach1<\/h3><span class="sf-chip" data-tone="soon">2 titles<\/span>/);
    expect(coach).toMatch(/aria-label="Best coach records"[^]*Coach1[^]*70% · 6-2-2 · 10 games/);
    expect(coach).toContain('data-kind="coach"');
    expect(coach).not.toContain('data-kind="player"');
  });
});
