import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import type { TournamentAwardsView, TournamentStatistics } from "../spa/src/tournaments/honours";

// Tournament Statistics / Honours / Awards tabs, server-rendered through the SPA's Vite config with a preloaded
// controller over a mocked Fetcher. Fake coaches and teams only.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Call = { path: string; init?: { method?: string; body?: unknown; headers?: Record<string, string> } };
function mockFetcher(routes: Record<string, unknown>): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init?: Call["init"]) => {
    calls.push({ path, init });
    const key = init?.method && init.method !== "GET" ? `${init.method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${key}`);
    if (hit instanceof ApiError) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}

const line = (o: Partial<Record<string, number>>) => ({
  games: 2, wins: 1, draws: 1, losses: 0, points: 4, td: 3, tdAgainst: 1, cas: 0, casAgainst: 0, completions: 0, interceptions: 0, fouls: 0, blocks: 0, mvp: 0,
  injuriesFor: 0, injuriesAgainst: 0, deathsFor: 0, deathsAgainst: 0, ...o,
});
const SCORES_ONLY = (): TournamentStatistics => ({
  tournamentId: "t1", status: "active",
  totals: { games: 2, touchdowns: 4, casualties: null, teams: 2, coaches: 2, players: 0 },
  coverage: { games: 2, casualties: 0, players: 0, blocks: 0 },
  stats: ["td", "tdAgainst"], playerStats: [],
  teams: [{ entrantId: "e-ann", team: "Ann's Orcs", coach: "Ann", race: "Orc", ...line({}) }, { entrantId: "e-bob", team: "Bob's Elves", coach: "Bob", race: "Wood Elf", ...line({ wins: 0, losses: 1, points: 1, td: 1, tdAgainst: 3 }) }],
  coaches: [{ coach: "Ann", teams: 1, ...line({}) }, { coach: "Bob", teams: 1, ...line({ points: 1 }) }],
  races: [{ race: "Orc", teams: 1, games: 2, wins: 1, draws: 1, losses: 0, winPct: 0.75 }, { race: "Wood Elf", teams: 1, games: 2, wins: 0, draws: 1, losses: 1, winPct: 0.25 }],
  honours: [{ key: "team-td", kind: "team", stat: "td", title: "Most touchdowns", rows: [{ rank: 1, name: "Ann's Orcs", team: "Ann's Orcs", coach: "Ann", value: 3 }] }],
  cards: [{ id: "best-attack", title: "Best attack", value: "3", unit: "TD", name: "Ann's Orcs", team: "Ann's Orcs", race: "Orc", coach: "Ann", detail: "1-1-0 in 2 games", tied: [], icon: "/icons/panel/teams.png" }],
});
const FULL = (): TournamentStatistics => ({
  ...SCORES_ONLY(),
  totals: { games: 2, touchdowns: 4, casualties: 3, teams: 2, coaches: 2, players: 2 },
  coverage: { games: 2, casualties: 2, players: 1, blocks: 1 },
  stats: ["td", "tdAgainst", "cas", "casAgainst", "completions", "blocks"], playerStats: ["td", "blocks"],
  honours: [
    ...SCORES_ONLY().honours,
    { key: "player-td", kind: "player", stat: "td", title: "Most touchdowns", rows: [{ rank: 1, name: "Grok", team: "Ann's Orcs", coach: "Ann", value: 2 }] },
  ],
});
const AWARDS = (over: Partial<TournamentAwardsView> = {}): TournamentAwardsView => ({
  revision: 2, finished: true,
  podium: [
    { id: "podium-champion", source: "podium", tournamentId: "t1", title: "Overall Champion", icon: "legend", toCoach: "Ann", toTeam: "Ann's Orcs", entrantId: "e-ann", race: "Orc", note: "Final standings", at: "2026-10-30T00:00:00.000Z", star: true },
    { id: "podium-runnerUp", source: "podium", tournamentId: "t1", title: "Runner-up", icon: "super-star", toCoach: "Bob", toTeam: "Bob's Elves", entrantId: "e-bob", race: "Wood Elf", note: "Final standings", at: "2026-10-30T00:00:00.000Z", star: false },
  ],
  awards: [{ id: "a-1", source: "custom", tournamentId: "t1", title: "Best sportsmanship", icon: "captain", toCoach: "Bob", toTeam: "Bob's Elves", entrantId: "e-bob", race: "Wood Elf", note: "Always on time.", by: "Veers", at: "2026-10-31T00:00:00.000Z", star: false }],
  ...over,
});
const MANAGER = (): TournamentAwardsView => AWARDS({ recipients: { teams: [{ id: "e-ann", name: "Ann's Orcs", race: "Orc", coach: "Ann" }], coaches: [{ id: "Ann", name: "Ann" }] } });

describe("SPA: tournament Statistics, Honours and Awards", () => {
  let vite: ViteDevServer | undefined;
  let m: {
    honours: typeof import("../spa/src/tournaments/honours");
    detail: typeof import("../spa/src/tournaments/detail");
    leagueHonours: typeof import("../spa/src/leagues/honours");
    renderToString: (app: unknown) => Promise<string>;
    Stats: unknown; Honours: unknown; Awards: unknown; Give: unknown;
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [honours, detail, leagueHonours, renderer, stats, hon, aw, give] = await Promise.all([
      vite.ssrLoadModule("/src/tournaments/honours.ts"), vite.ssrLoadModule("/src/tournaments/detail.ts"), vite.ssrLoadModule("/src/leagues/honours.ts"),
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/TournamentStatistics.vue"),
      vite.ssrLoadModule("/src/components/TournamentHonours.vue"), vite.ssrLoadModule("/src/components/TournamentAwards.vue"),
      vite.ssrLoadModule("/src/components/LeagueGiveAward.vue"),
    ]);
    m = {
      honours: honours as typeof import("../spa/src/tournaments/honours"), detail: detail as typeof import("../spa/src/tournaments/detail"),
      leagueHonours: leagueHonours as typeof import("../spa/src/leagues/honours"), renderToString: renderer.renderToString,
      Stats: stats.default, Honours: hon.default, Awards: aw.default, Give: give.default,
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, routes: Record<string, unknown>, props: Record<string, unknown> = { id: "t1" }) {
    const f = mockFetcher(routes);
    const ctl = m.honours.createTournamentHonours({ api: f });
    if (routes["/api/tournaments/t1/statistics"]) await ctl.loadStats("t1");
    if (routes["/api/tournaments/t1/awards"]) await ctl.loadAwards("t1");
    const app = createSSRApp({ render: () => h(component as never, props) });
    app.provide(m.honours.TOURNAMENT_HONOURS_KEY, ctl);
    return (await m.renderToString(app)).replace(/<!--[^>]*-->/g, "");
  }

  it("the tournament page has Statistics, Honours and Awards tabs before Manage", () => {
    expect(m.detail.tabsFor(true).map((t) => t.id)).toEqual(["overview", "entrants", "rounds", "standings", "statistics", "honours", "awards", "manage"]);
    expect(m.detail.isDetailTab("awards")).toBe(true);
  });

  it("Statistics, scores only: TD columns, no casualty or player columns, the coverage line", async () => {
    const html = await render(m.Stats, { "/api/tournaments/t1/statistics": SCORES_ONLY() });
    expect(html).toContain('data-card="best-attack"');
    expect(html).not.toContain("<a "); // tournament cards are not links
    expect(html).toContain("Scores only: these results carry no player stats.");
    expect(html).toContain(">TD</abbr>");
    expect(html).toContain(">TDA</abbr>");
    for (const s of [">CAS</abbr>", ">COM</abbr>", ">BLK</abbr>", "<dt>Casualties</dt>", "<dt>Players</dt>"]) expect(html).not.toContain(s);
    expect(html).toMatch(/Ann&#39;s Orcs[^]*Ann · Orc[^]*1-1-0/);
    expect(html).toContain('role="radiogroup" aria-label="Records by"');
    expect(html).toContain("Race win rates");
  });

  it("Statistics with player rows: the recorded columns show, the partial coverage is named", async () => {
    const html = await render(m.Stats, { "/api/tournaments/t1/statistics": FULL() });
    for (const s of [">CAS</abbr>", ">CASA</abbr>", ">COM</abbr>", ">BLK</abbr>", "<dt>Casualties</dt>"]) expect(html).toContain(s);
    expect(html).not.toContain(">INT</abbr>");
    expect(html).toContain("Player stats from 1 of 2 games.");
  });

  it("Honours: Team / Player / Coach toggles over the boards, team boards first", async () => {
    const html = await render(m.Honours, { "/api/tournaments/t1/statistics": FULL() });
    expect(html).toContain('role="radiogroup" aria-label="Honours for"');
    expect(html).toMatch(/aria-checked="true"[^>]*>Team</);
    expect(html).toContain('data-kind="team"');
    expect(html).toContain('data-board="team-td"');
    expect(html).not.toContain('data-board="player-td"');
    expect(m.honours.boardGroups(FULL().honours, "player")[0]!.tables.map((t) => t.key)).toEqual(["player-td"]);
    expect(m.honours.boardGroups(SCORES_ONLY().honours, "player")).toEqual([]);
  });

  it("Awards, public: the podium and the given awards, no organiser controls", async () => {
    const html = await render(m.Awards, { "/api/tournaments/t1/awards": AWARDS() });
    expect(html).toMatch(/data-slot="champion"[^]*Champion[^]*★[^]*Ann&#39;s Orcs[^]*Ann · Orc/);
    expect(html).toContain('src="/icons/coach-badges/legend-retro.png"');
    expect(html).toMatch(/data-award-id="a-1"[^]*Best sportsmanship[^]*Bob&#39;s Elves · Bob · Wood Elf[^]*Given by Veers[^]*Always on time\./);
    expect(html).not.toContain("League-wide");
    for (const s of ["Give award", ">Remove<", 'class="aw-actions"']) expect(html).not.toContain(s);
  });

  it("Awards before the finish: the podium waits; organisers get Give award and Remove", async () => {
    const pending = await render(m.Awards, { "/api/tournaments/t1/awards": AWARDS({ finished: false, podium: [] }) });
    expect(pending).toContain("The podium fills in when the tournament finishes.");
    const html = await render(m.Awards, { "/api/tournaments/t1/awards": MANAGER() });
    expect(html).toContain(">Give award<");
    expect(html).toContain(">Remove<");
    const testSession = await render(m.Awards, { "/api/tournaments/t1/awards": MANAGER() }, { id: "t1", writes: false });
    expect(testSession).not.toContain(">Give award<");
  });

  it("Give award dialog in tournament scope: no season, the entrants as recipients", async () => {
    const f = mockFetcher({ "/api/tournaments/t1/awards": MANAGER() });
    const ctl = m.honours.createTournamentHonours({ api: f });
    await ctl.loadAwards("t1");
    const app = createSSRApp({ render: () => h(m.Give as never, { scope: "tournament" }) });
    app.provide(m.leagueHonours.AWARD_GIVER_KEY, m.honours.asGiver(ctl));
    const html = (await m.renderToString(app)).replace(/<!--[^>]*-->/g, "");
    expect(html).toContain(">Give award</h2>");
    expect(html).not.toContain("League-wide (no season)");
    expect(html).toContain("Ann&#39;s Orcs (Ann, Orc)</option>");
    expect(html).not.toContain("reached through their team");
  });

  it("results stamp: a new result, status, round, updatedAt, awards revision or standings change moves it", () => {
    const base = { tournament: { status: "active", currentRound: 1, updatedAt: "a", awardsRevision: 0 }, fixtures: [{ result: {} }, {}], standings: [{ played: 1, points: 3, touchdownsFor: 2, casualtiesFor: 0 }] };
    const s0 = m.honours.resultsStamp(base);
    expect(m.honours.resultsStamp({ ...base })).toBe(s0);
    for (const changed of [
      { ...base, fixtures: [{ result: {} }, { result: {} }] },
      { ...base, tournament: { ...base.tournament, status: "completed" } },
      { ...base, tournament: { ...base.tournament, currentRound: 2 } },
      { ...base, tournament: { ...base.tournament, updatedAt: "b" } },
      { ...base, tournament: { ...base.tournament, awardsRevision: 1 } },
      { ...base, standings: [{ played: 2, points: 3, touchdownsFor: 2, casualtiesFor: 0 }] },
    ]) expect(m.honours.resultsStamp(changed)).not.toBe(s0);
    expect(m.honours.resultsStamp({ ...base, tournament: null })).toBe("");
  });

  it("controller: views load once per stamp; a new stamp refetches the next load and keeps the old view meanwhile", async () => {
    const f = mockFetcher({ "/api/tournaments/t1/statistics": SCORES_ONLY(), "/api/tournaments/t1/awards": AWARDS() });
    const ctl = m.honours.createTournamentHonours({ api: f });
    ctl.noteStamp("s1");
    await ctl.loadStats("t1");
    await ctl.loadStats("t1");
    await ctl.loadAwards("t1");
    await ctl.loadAwards("t1");
    const count = (p: string) => f.calls.filter((c) => c.path === p).length;
    expect(count("/api/tournaments/t1/statistics")).toBe(1);
    expect(count("/api/tournaments/t1/awards")).toBe(1);
    ctl.noteStamp("s2");
    const pending = ctl.loadStats("t1");
    expect(ctl.state.statsStatus).toBe("ok"); // the stale numbers stay on screen while refetching
    expect(ctl.state.stats).not.toBeNull();
    await pending;
    await ctl.loadAwards("t1");
    expect(count("/api/tournaments/t1/statistics")).toBe(2);
    expect(count("/api/tournaments/t1/awards")).toBe(2);
    await ctl.loadStats("t1");
    expect(count("/api/tournaments/t1/statistics")).toBe(2);
  });

  it("opening Statistics, Honours or Awards polls the standings too", async () => {
    const f = mockFetcher({
      "/api/tournaments/t1": { tournament: { id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "Rules", maxPlayers: 8, roundCount: 3, currentRound: 1 }, entrants: [], rounds: [], scheduledMatches: [] },
      "/api/tournaments/t1/standings": { standings: [] },
    });
    const d = m.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    await d.ensureTab("awards");
    expect(d.state.standingsStatus).toBe("ok");
  });

  it("controller: give sends the revision and the entrant; remove sends If-Match; a 409 reloads", async () => {
    let posted: unknown;
    const after = { ...MANAGER(), revision: 3 };
    const f = mockFetcher({
      "/api/tournaments/t1/awards": MANAGER(),
      "POST /api/tournaments/t1/awards": (b: unknown) => { posted = b; return { awards: after }; },
      "DELETE /api/tournaments/t1/awards/a-1": new ApiError(409, "The awards changed since you opened them.", { revision: 9 }),
    });
    const ctl = m.honours.createTournamentHonours({ api: f });
    await ctl.loadAwards("t1");
    expect(ctl.state.view?.recipients?.teams[0]).toMatchObject({ seasonId: "t1", id: "e-ann" });
    expect(await ctl.give({ title: "Fair play", icon: "star", recipient: { kind: "team", seasonId: "t1", teamId: "e-ann" }, note: "" })).toBe(true);
    expect(posted).toEqual({ title: "Fair play", icon: "star", note: "", revision: 2, recipient: { kind: "team", teamId: "e-ann" } });
    expect(ctl.state.awards!.revision).toBe(3);
    expect(await ctl.removeAward("a-1")).toBe(false);
    const del = f.calls.find((c) => c.init?.method === "DELETE")!;
    expect(del.init!.headers).toEqual({ "If-Match": '"3"' });
    expect(ctl.state.writeError).toContain("changed");
    expect(f.calls.filter((c) => c.path === "/api/tournaments/t1/awards" && !c.init?.method).length).toBe(2); // reloaded
  });
});
