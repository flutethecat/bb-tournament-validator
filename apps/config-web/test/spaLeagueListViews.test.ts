import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { filterList, foldText, LIST_VIEW_KEYS, listCount, matchesWords, queryWords, readListView, writeListView } from "../spa/src/shared/listView";

// League pages treatment (owner 11-13: "Let's give the league pages the same treatment"): the shared Cards / Table switch
// and filter (shared/listView.ts, ListViewToggle, ListFilter), My teams moved onto them unchanged, and the league lists.
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher {
  return (async (path: string) => {
    if (!(path in routes)) throw new ApiError(404, `no mock for ${path}`);
    return routes[path];
  }) as Fetcher;
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  };
}

describe("shared list helper", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("folds case and accents; every typed word must appear in the row", () => {
    expect(foldText("Élan SÄVE")).toBe("elan save");
    expect(queryWords("  Orc   élan ")).toEqual(["orc", "elan"]);
    expect(matchesWords(["orc", "elan"], ["Élan Säve", "Orc"])).toBe(true);
    expect(matchesWords(["orc", "dwarf"], ["Élan Säve", "Orc"])).toBe(false);
    expect(matchesWords([], "anything")).toBe(true);
    const rows = [{ n: "Reikland Roosters", c: "Alice", r: "Human" }, { n: "Gloom Lords", c: "Bea", r: "Dark Elf" }, { n: "Karak Hammers", c: "Carol", r: "Dwarf" }];
    expect(filterList(rows, "", (x) => [x.n, x.c, x.r])).toBe(rows); // an empty box keeps the list itself
    expect(filterList(rows, "dark", (x) => [x.n, x.c, x.r]).map((x) => x.n)).toEqual(["Gloom Lords"]);
    expect(filterList(rows, "CAROL dwarf", (x) => [x.n, x.c, x.r]).map((x) => x.n)).toEqual(["Karak Hammers"]);
    expect(filterList(rows, "carol human", (x) => [x.n, x.c, x.r])).toEqual([]);
  });

  it("counts read 'N things', or 'N of M things' while filtering", () => {
    expect(listCount(12, 12, "team")).toBe("12 teams");
    expect(listCount(1, 1, "team")).toBe("1 team");
    expect(listCount(3, 12, "fixture")).toBe("3 of 12 fixtures");
    expect(listCount(0, 12, "match", "matches")).toBe("0 of 12 matches");
  });

  it("the remembered view is per key, guarded, and anything but cards / table falls back", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readListView("k")).toBe("cards");
    expect(readListView("k", "table")).toBe("table");
    writeListView("k", "table");
    expect(readListView("k")).toBe("table");
    expect(readListView("other")).toBe("cards");
    localStorage.setItem("k", "grid");
    expect(readListView("k")).toBe("cards");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readListView("k", "table")).toBe("table");
    expect(() => writeListView("k", "cards")).not.toThrow();
  });

  it("keeps the existing stored keys (My teams, fixtures, awards) so nobody's remembered choice is lost", () => {
    expect(LIST_VIEW_KEYS.myTeams).toBe("sf.myTeams.view");
    expect(LIST_VIEW_KEYS.fixtures).toBe("sf-league-fixtures-view");
    expect(LIST_VIEW_KEYS.awards).toBe("sf-league-awards-view");
    expect(new Set(Object.values(LIST_VIEW_KEYS)).size).toBe(Object.values(LIST_VIEW_KEYS).length);
  });

  it("useListView reads storage only once mounted (server rendering and hydration always start from the default)", () => {
    const lv = src("shared/listView.ts");
    expect(lv).toMatch(/const view = ref<ListView>\(isView\(start\) \? start : fallback\);\s*onMounted\(\(\) => \{ view\.value = readListView\(key, fallback\); \}\);/);
    expect(lv).toContain("const start = inject(LIST_VIEW_START, null)?.[key];"); // tests only: the app never provides it
    for (const file of ["views/MyTeamsView.vue", "components/LeagueOverview.vue", "components/LeagueFixtures.vue", "components/LeagueAwards.vue", "components/LeagueHallOfFame.vue", "components/LeagueParticipantsList.vue"]) {
      const vue = src(file);
      expect(vue, file).toContain("useListView(LIST_VIEW_KEYS.");
      expect(vue, file).not.toMatch(/localStorage|readFixturesView\(|readAwardsLayout\(/);
    }
    // no app code provides the start view
    for (const file of ["app.ts", "main.ts", "views/LeagueDetailView.vue", "views/MyTeamsView.vue"]) expect(src(file), file).not.toContain("LIST_VIEW_START");
  });
});

describe("My teams on the shared helper: rendered output unchanged", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { app, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); vi.unstubAllGlobals(); });

  // Captured from MyTeamsView before the refactor (c0f48832), Vue's comment anchors stripped. The one serialisation
  // difference: the old inline v-model input printed value="", the shared ListFilter (which also carries a data attribute)
  // prints a bare value; both are the same empty value attribute in the DOM.
  const BEFORE_TEAMS = "<div class=\"hm-page sf-fit\"><div class=\"hm-grid sf-fill sf-cols\"><div class=\"hm-col hm-col-main\"><section id=\"teams\" class=\"hm-panel\" aria-labelledby=\"mt-teams-h\"><header class=\"hm-band\"><h2 id=\"mt-teams-h\">My teams</h2><span class=\"hm-cap\">2 teams</span><span class=\"sf-tabs mt-view-toggle\" role=\"group\" aria-label=\"Teams view\"><button type=\"button\" class=\"sf-tab\" aria-pressed=\"true\" data-teams-view=\"cards\">Cards</button><button type=\"button\" class=\"sf-tab\" aria-pressed=\"false\" data-teams-view=\"table\">Table</button></span></header><label class=\"sf-field mt-filter\"><span class=\"sf-sr\">Filter teams</span><input value=\"\" class=\"sf-input\" type=\"search\" placeholder=\"Filter by team, race or competition\" autocomplete=\"off\" data-teams-filter></label><ul class=\"hm-teams hm-teams-lg\"><li><a href=\"/app/teams/library%3A77\" class=\"hm-team\" title=\"Manage Alice Lib\"><span class=\"hm-team-crest hm-team-blank\" aria-hidden=\"true\">A</span><span class=\"hm-team-name\">Alice Lib</span><small class=\"hm-team-race\">Human</small></a></li><li><a href=\"/app/teams/sv_a\" class=\"hm-team\" title=\"Manage Élan Säve\"><span class=\"hm-team-crest hm-team-blank\" aria-hidden=\"true\">É</span><span class=\"hm-team-name\">Élan Säve</span><small class=\"hm-team-race\">Orc</small></a></li></ul></section></div><div class=\"hm-col hm-col-side\"><section id=\"build\" class=\"hm-panel\" aria-labelledby=\"mt-build-h\"><header class=\"hm-band\"><h2 id=\"mt-build-h\">Build a team</h2></header><p class=\"hm-links\"><a href=\"/team-builder.html\">Team Builder</a> · <a href=\"/app/tournament-team-builder\" class=\"\">Roster Builder</a></p></section></div></div></div>";
  const BEFORE_EMPTY = "<div class=\"hm-page sf-fit\"><div class=\"hm-grid sf-fill sf-cols\"><div class=\"hm-col hm-col-main\"><section id=\"teams\" class=\"hm-panel\" aria-labelledby=\"mt-teams-h\"><header class=\"hm-band\"><h2 id=\"mt-teams-h\">My teams</h2><span class=\"hm-cap\">0 teams</span><span class=\"sf-tabs mt-view-toggle\" role=\"group\" aria-label=\"Teams view\"><button type=\"button\" class=\"sf-tab\" aria-pressed=\"true\" data-teams-view=\"cards\">Cards</button><button type=\"button\" class=\"sf-tab\" aria-pressed=\"false\" data-teams-view=\"table\">Table</button></span></header><p class=\"hm-empty\">No teams yet. <a href=\"/team-builder.html\">Build one</a>.</p></section></div><div class=\"hm-col hm-col-side\"><section id=\"build\" class=\"hm-panel\" aria-labelledby=\"mt-build-h\"><header class=\"hm-band\"><h2 id=\"mt-build-h\">Build a team</h2></header><p class=\"hm-links\"><a href=\"/team-builder.html\">Team Builder</a> · <a href=\"/app/tournament-team-builder\" class=\"\">Roster Builder</a></p></section></div></div></div>";
  const norm = (html: string): string => html.replace(/<!--[^>]*-->/g, "").replace(/<input value="" /g, "<input value ");

  async function myTeams(teams: unknown[]): Promise<string> {
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true,
      fetcher: mockFetcher({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" }, "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams } }) });
    await spa.router.push("/my-teams");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    return html.slice(html.indexOf('<div class="hm-page sf-fit">'), html.indexOf("</main>"));
  }

  it("renders exactly what it rendered before, with teams and empty, even when the browser remembered Table", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ [LIST_VIEW_KEYS.myTeams]: "table" }));
    const teams = [{ ref: "library:77", name: "Alice Lib", race: "Human", tv: 1_050_000, registered: [{ id: "x", name: "Rivertown" }], actions: { count: 2, items: ["a", "b"] } }, { ref: "sv_a", name: "Élan Säve", race: "Orc" }];
    expect(norm(await myTeams(teams))).toBe(norm(BEFORE_TEAMS));
    expect(norm(await myTeams([]))).toBe(norm(BEFORE_EMPTY));
  });
});

// ---- league lists (owner 11-13: "Let's give the league pages the same treatment") ----
const side = (team: string, coach: string, race: string, score: number | null) => ({ team, coach, race, score, cas: score === null ? null : 0, conceded: false });
const fx = (id: string, round: number, home: ReturnType<typeof side>, away: ReturnType<typeof side>, finishedAt?: string) => ({
  id, phaseId: "regular", phase: "Regular", category: "Season", group: "", round, table: 1, suspended: false, home, away, ...(finishedAt ? { finishedAt } : { date: "2026-12-01" }),
});
const lteam = (id: string, name: string, coach: string, race: string, status?: string) => ({
  id, name, race, coach, coachId: coach, teamValue: 1_000_000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "", raceLeague: "",
  players: [], formerPlayers: [], ...(status ? { status } : {}),
});
const leagueSeason = () => ({
  id: "season-2", leagueId: "rivertown", number: 2, name: "Season 2", sourceSlug: "s2", ruleset: "BB2025", status: "active", importedAt: "2026-10-01T00:00:00.000Z",
  phases: [{ id: "regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [
    fx("f1", 1, side("Karak Hammers", "Carol", "Dwarf", 2), side("Gloom Lords", "Bea", "Dark Elf", 1), "2026-09-01T19:00:00.000Z"),
    fx("f2", 1, side("Élan Vital", "Émile", "Wood Elf", 0), side("Reikland Roosters", "Alice", "Human", 0), "2026-09-02T19:00:00.000Z"),
    fx("f3", 2, side("Gloom Lords", "Bea", "Dark Elf", null), side("Élan Vital", "Émile", "Wood Elf", null)),
  ],
  participants: [], honours: [], awards: [],
  teams: [lteam("t1", "Karak Hammers", "Carol", "Dwarf"), lteam("t2", "Gloom Lords", "Bea", "Dark Elf"), lteam("t3", "Élan Vital", "Émile", "Wood Elf"), lteam("t4", "Old Boys", "Dan", "Human", "inactive")],
});

describe("league lists: filters (pure)", () => {
  it("fixtures: team, coach, race, round and phase, accent-insensitive; empty rounds drop out and played counts follow", async () => {
    const { filterFixturesText, fixtureCount, fixtureHay } = await import("../spa/src/leagues/fixtureNav");
    const { fixturesByPhase } = await import("../spa/src/leagues/league");
    const groups = fixturesByPhase(leagueSeason() as never);
    expect(fixtureCount(groups)).toBe(3);
    expect(filterFixturesText(groups, "")).toBe(groups);
    expect(fixtureCount(filterFixturesText(groups, "elan"))).toBe(2);
    const dwarf = filterFixturesText(groups, "dwarf");
    expect(dwarf[0]!.rounds.map((r) => [r.round, r.fixtures.length, r.played])).toEqual([[1, 1, 1]]); // round 2 dropped out
    expect(fixtureCount(filterFixturesText(groups, "round 2"))).toBe(1);
    expect(fixtureCount(filterFixturesText(groups, "regular carol"))).toBe(1);
    expect(filterFixturesText(groups, "zebra")).toEqual([]);
    expect(fixtureHay(groups[0]!.rounds[0]!.fixtures[0]!, "Regular")).toEqual(["Karak Hammers", "Carol", "Dwarf", "Gloom Lords", "Bea", "Dark Elf", "Round 1", "", "Regular"]);
  });
});

describe("league lists: rendered (server)", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const load = (p: string) => vite!.ssrLoadModule(p);
    const [renderer, vueRouter, app, honours, listView, Overview, Participants, Hall, Boards, Results] = await Promise.all([
      load("vue/server-renderer"), load("vue-router"), load("/src/app.ts"), load("/src/leagues/honours.ts"), load("/src/shared/listView.ts"),
      load("/src/components/LeagueOverview.vue"), load("/src/components/LeagueParticipantsList.vue"), load("/src/components/LeagueHallOfFame.vue"),
      load("/src/components/HonourBoards.vue"), load("/src/components/LeagueResultsTable.vue"),
    ]);
    m = { renderer, vueRouter, app, honours, listView, Overview: Overview.default, Participants: Participants.default, Hall: Hall.default, Boards: Boards.default, Results: Results.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); vi.unstubAllGlobals(); });

  async function render(component: unknown, props: Record<string, unknown>, start?: Record<string, string>, hall?: unknown): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [
      { path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/leagues/:id/settings", name: "league-settings", component: blank }, { path: "/:p(.*)*", component: blank },
    ] });
    await router.push("/leagues/rivertown");
    await router.isReady();
    const app = createSSRApp(component as never, props);
    app.use(router);
    const api = (async () => { throw new Error("no api in this test"); }) as never;
    app.provide(m.app.API_KEY, api);
    if (start) app.provide(m.listView.LIST_VIEW_START, start);
    const h = m.honours.createHonours({ api });
    h.state.leagueId = "rivertown";
    h.state.loaded = true;
    h.state.view = hall ?? null;
    app.provide(m.honours.LEAGUE_HONOURS_KEY, h);
    return ((await m.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }
  const LEAGUE = { id: "rivertown", name: "Rivertown BBL", organisers: ["Veers"], description: "", ruleset: "BB2025" };
  const SUMMARY = { id: "season-2", name: "Season 2", ruleset: "BB2025", status: "active", teamCount: 4, fixtureCount: 3, playedCount: 2 };

  it("Overview latest results: cards by default (even with Table remembered), the switch in the band; Table renders the same games with summary links", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ [LIST_VIEW_KEYS.fixtures]: "table" }));
    const props = { league: LEAGUE, season: leagueSeason(), summary: SUMMARY, crests: {} };
    const cards = await render(m.Overview, props);
    expect(cards).toContain('<ul class="lg-results lg-results-sm" aria-label="Latest results">');
    expect(cards).toMatch(/<span class="sf-tabs small lg-view-toggle" role="group" aria-label="Latest results view"><button type="button" class="sf-tab" aria-pressed="true" data-results-view="cards">Cards<\/button><button type="button" class="sf-tab" aria-pressed="false" data-results-view="table">Table<\/button><\/span>/);
    expect(cards).not.toContain("data-results-table");
    const table = await render(m.Overview, props, { [LIST_VIEW_KEYS.fixtures]: "table" });
    expect(table).not.toContain('class="lg-results lg-results-sm"');
    expect(table).toContain('<th scope="col">Date and round</th><th scope="col">Home</th><th scope="col" class="lg-fx-c">Score</th><th scope="col">Away</th><th scope="col">Status</th>');
    expect(table.match(/class="lg-fx-row"/g)).toHaveLength(2); // the played games only, as the cards
    expect(table).toMatch(/<a [^>]*href="\/app\/leagues\/rivertown\?tab=fixtures&amp;fixture=f2"[^>]*class="[^"]*lg-fx-score"[^>]*aria-label="Fixture summary: Élan Vital 0–0 Reikland Roosters"/);
    expect(table.indexOf('data-fixture="f2"')).toBeLessThan(table.indexOf('data-fixture="f1"')); // newest first, as the cards
    expect(table).toContain("Round 1 · Regular");
    expect(table).toContain('<span class="lg-team-name">Karak Hammers</span><small>Carol</small>');
  });

  it("Participants: the table stays the default with a labelled filter box; Cards are the team tiles with the same links; inactive teams stay apart", async () => {
    const props = { season: leagueSeason(), leagueId: "rivertown", crests: {} };
    const table = await render(m.Participants, props);
    expect(table).toContain('class="lg-table lg-plist-table"');
    expect(table).toMatch(/aria-pressed="true" data-participants-view="table">Table</);
    expect(table).toMatch(/<label class="sf-field lg-list-filter"><span class="sf-sr">Filter participants<\/span><input[^>]*type="search"[^>]*data-participants-filter><span class="sf-sr" role="status" aria-live="polite">4 teams<\/span><\/label>/);
    expect(table).toContain("Season 2 · 4 teams");
    const cards = await render(m.Participants, props, { [LIST_VIEW_KEYS.participants]: "cards" });
    expect(cards).toContain("data-participants-cards");
    expect(cards).not.toContain('<th scope="col" class="lg-num">Team value</th>');
    for (const id of ["t1", "t2", "t3"]) {
      const href = `href="/app/leagues/rivertown?tab=teams&amp;team=${id}"`;
      expect(table, id).toContain(href);
      expect(cards, id).toContain(href);
    }
    expect(cards.match(/<a [^>]*class="[^"]*hm-team"/g)).toHaveLength(3); // a tile per active team
    expect(cards).toContain("Inactive (1)");
    expect(cards).not.toContain("data-coach-profile"); // public: no coach profile buttons
    const org = await render(m.Participants, { ...props, organiser: true }, { [LIST_VIEW_KEYS.participants]: "cards" });
    expect(org.match(/data-coach-profile/g)).toHaveLength(3); // organisers keep the coach profile on each active tile
  });

  const HALL = {
    revision: 1, awards: [], pins: [],
    hallOfFame: [
      { seasonId: "season-1", number: 1, name: "Season 1", ruleset: "BB2025", champion: { team: "Karak Hammers", coach: "Carol", race: "Dwarf" }, runnerUp: { team: "Gloom Lords", coach: "Bea", race: "Dark Elf" }, source: "podium" },
      { seasonId: "season-0", number: 0, name: "Season 0", ruleset: "BB2020", champion: { team: "Élan Vital", coach: "Émile", race: "Wood Elf" }, source: "podium" },
    ],
  };
  it("Hall of Fame: cards by default; Table lists the same seasons with scoped headers and row headers; the filter narrows both and counts", async () => {
    const cards = await render(m.Hall, { manage: false, crests: {} }, undefined, HALL);
    expect(cards).toContain('<ul class="hof-cards" aria-label="Season champions">');
    expect(cards).toMatch(/role="group" aria-label="Hall of Fame layout"><button type="button" class="sf-tab" aria-pressed="true" data-hof-layout="cards">Cards/);
    expect(cards).toContain('<span class="sf-sr">Filter honours</span>');
    const table = await render(m.Hall, { manage: false, crests: {} }, { [LIST_VIEW_KEYS.champions]: "table" }, HALL);
    expect(table).toContain('data-hof-table="team"');
    expect(table).toContain('<thead><tr><th scope="col">Season</th><th scope="col">Rules</th><th scope="col">Dates</th><th scope="col">Champion</th><th scope="col">Race</th><th scope="col">Runner-up</th><th scope="col">Consolation</th></tr></thead>');
    expect(table.match(/<th scope="row">Season [01]/g)).toHaveLength(2);
    const narrowed = await render(m.Hall, { manage: false, crests: {}, query: "elan" }, { [LIST_VIEW_KEYS.champions]: "table" }, HALL);
    expect(narrowed.match(/<th scope="row">Season/g)).toHaveLength(1);
    expect(narrowed).toMatch(/role="status" aria-live="polite">1 of 2 seasons</);
    const narrowedCards = await render(m.Hall, { manage: false, crests: {}, query: "elan" }, undefined, HALL);
    expect(narrowedCards.match(/class="hof-card"/g)).toHaveLength(1);
    const none = await render(m.Hall, { manage: false, crests: {}, query: "zebra" }, undefined, HALL);
    expect(none).toContain('<p class="hm-empty" role="status">No seasons match that filter.</p>');
    const org = await render(m.Hall, { manage: true, crests: {} }, { [LIST_VIEW_KEYS.champions]: "table" }, HALL);
    expect(org.match(/class="hof-pin"/g)).toHaveLength(2); // organisers keep the champion pin in the table
  });

  it("honour boards: no query = unchanged (tournaments); a query keeps matching rows with their rank and drops empty boards", async () => {
    const groups = [{ kind: "player", title: "Players", tables: [
      { key: "td", title: "Touchdowns", rows: [{ rank: 1, name: "Grim", team: "Karak Hammers", coach: "Carol", value: 5 }, { rank: 2, name: "Ezra", team: "Élan Vital", coach: "Émile", value: 3 }] },
      { key: "cas", title: "Casualties", rows: [{ rank: 1, name: "Bash", team: "Gloom Lords", coach: "Bea", value: 4 }] },
    ] }];
    const all = await render(m.Boards, { groups, value: String });
    expect(all.match(/class="lg-board"/g)).toHaveLength(2);
    const elan = await render(m.Boards, { groups, value: String, query: "elan" });
    expect(elan.match(/class="lg-board"/g)).toHaveLength(1);
    expect(elan).toMatch(/<span class="lg-board-rank">2<\/span><span class="lg-board-who"><strong>Ezra/);
    expect(elan).not.toContain("Grim");
  });

  it("the results table renders the rows it is given, each score linking to its fixture summary", async () => {
    const html = await render(m.Results, { fixtures: leagueSeason().fixtures.slice(0, 1), label: "Latest results", seasonId: "season-2" });
    expect(html).toContain('<table class="sf-table lg-fx-table lg-res-table" aria-label="Latest results" data-results-table>');
    expect(html).toContain('href="/app/leagues/rivertown?season=season-2&amp;tab=fixtures&amp;fixture=f1"');
  });
});

describe("league lists: source pins", () => {
  it("each converted list has its switch (labelled button group) and filter; Standings and Statistics stay tables with a filter only", () => {
    const has = (file: string, ...needles: string[]) => { const s = src(file); for (const n of needles) expect(s, `${file}: ${n}`).toContain(n); };
    has("components/LeagueFixtures.vue", 'label="Filter fixtures"', 'label="Fixtures view"', "useListView(LIST_VIEW_KEYS.fixtures)");
    has("components/LeagueOverview.vue", 'label="Latest results view"', 'label="Current Champions view"', "useListView(LIST_VIEW_KEYS.fixtures)", "useListView(LIST_VIEW_KEYS.champions)");
    has("components/LeagueAwards.vue", 'label="Filter awards"', 'aria-label="Awards view"', "useListView(LIST_VIEW_KEYS.awards)");
    has("components/LeagueHallOfFame.vue", 'label="Filter honours"', 'label="Hall of Fame layout"', "useListView(LIST_VIEW_KEYS.champions)");
    has("components/LeagueParticipantsList.vue", 'label="Filter participants"', 'label="Participants view"', 'useListView(LIST_VIEW_KEYS.participants, "table")');
    has("components/LeagueStandings.vue", 'label="Filter standings"');
    has("views/LeagueStatsView.vue", 'label="Filter statistics"');
    for (const f of ["components/LeagueStandings.vue", "views/LeagueStatsView.vue", "components/LeagueCalendar.vue", "components/MessageBoard.vue", "components/LeagueDraws.vue"]) expect(src(f), f).not.toContain("ListViewToggle");
    const toggle = src("components/ListViewToggle.vue");
    expect(toggle).toContain('role="group" :aria-label="label"');
    expect(toggle).toContain(`type="button" class="sf-tab" :aria-pressed="modelValue === v.id ? 'true' : 'false'"`);
    const filter = src("components/ListFilter.vue");
    expect(filter).toContain('<span class="sf-sr">{{ label }}</span>');
    expect(filter).toContain('role="status" aria-live="polite"');
  });

  it("the league roster popup is the team page's table (TeamRosterTable over summaryFromLeague)", () => {
    const pop = src("components/RosterDialog.vue");
    expect(pop).toContain("<TeamRosterTable");
    expect(pop).toContain("summaryFromLeague(props.team");
    expect(pop).not.toContain("<table");
  });

  it("the new rules use tokens only (no raw colours)", () => {
    for (const file of ["leagues/leagues.css", "leagues/honours.css"]) {
      const css = src(file);
      expect(css.slice(css.indexOf("League pages treatment")), file).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});

// ---- fix round 1 (Sol 6.1 review of the league treatment) ----
describe("fix round 1: filters cover every list, honest counts, no reorder while filtered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let m: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const load = (p: string) => vite!.ssrLoadModule(p);
    const [renderer, vueRouter, app, honours, league, Hall] = await Promise.all([
      load("vue/server-renderer"), load("vue-router"), load("/src/app.ts"), load("/src/leagues/honours.ts"), load("/src/leagues/league.ts"), load("/src/components/LeagueHallOfFame.vue"),
    ]);
    m = { renderer, vueRouter, app, honours, league, Hall: Hall.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function hall(props: Record<string, unknown>, view: unknown, coaches: unknown[] = []): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: blank }] });
    await router.push("/leagues/rivertown?tab=honours");
    await router.isReady();
    const app = createSSRApp(m.Hall, props);
    app.use(router);
    const api = (async () => { throw new Error("no api in this test"); }) as never;
    app.provide(m.app.API_KEY, api);
    const h = m.honours.createHonours({ api });
    h.state.leagueId = "rivertown";
    h.state.loaded = true;
    h.state.view = view;
    app.provide(m.honours.LEAGUE_HONOURS_KEY, h);
    const stats = m.league.createLeagueStats({ api });
    stats.state.id = "rivertown";
    stats.state.byScope.all = { coaches, teams: [], leaders: {}, champions: [] };
    app.provide(m.league.LEAGUE_STATS_KEY, stats);
    return ((await m.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }
  const pin = (id: string, title: string, team: string) => ({ id, kind: "record", note: "", by: "Veers", at: "2026-11-01T00:00:00.000Z", resolved: { title, team, coach: "C", race: "R" } });
  const PINNED = { revision: 1, awards: [], hallOfFame: [], pins: [pin("a", "Alpha", "Karak Hammers"), pin("h", "Hidden", "Gloom Lords"), pin("n", "Another", "Karak Hammers")] };

  it("pins: Up / Down are not offered while the filter hides pins (a move would swap with a hidden pin); unfiltered they are", async () => {
    const full = await hall({ manage: true, crests: {} }, PINNED);
    expect(full.match(/aria-label="Move [^"]+ up"/g)).toHaveLength(3);
    expect(full.match(/aria-label="Move [^"]+ down"/g)).toHaveLength(3);
    expect(full).not.toContain("data-pin-reorder-note");
    const filtered = await hall({ manage: true, crests: {}, query: "karak" }, PINNED);
    expect(filtered).toContain(">Alpha<");
    expect(filtered).toContain(">Another<");
    expect(filtered).not.toContain(">Hidden<");
    expect(filtered).not.toMatch(/aria-label="Move /);
    expect(filtered).toContain("Clear the filter to reorder the pins.");
    expect(filtered.match(/aria-label="Unpin"/g)).toHaveLength(2); // unpinning goes by id and stays
  });

  const rec = (coach: string, games: number, wins: number) => ({ coach, games, wins, draws: 0, losses: games - wins, winPct: wins / games, points: wins * 3, tdFor: 0, tdAgainst: 0, casFor: 0, casAgainst: 0, seasons: [1], teams: 1, titles: 0 });
  const COACHES = [rec("Dee", 11, 8), rec("Alice", 11, 7), rec("Nia", 11, 6), rec("Kit", 11, 5), rec("Ivy", 11, 4)];
  const TITLES = { revision: 1, awards: [], pins: [], hallOfFame: [{ seasonId: "s1", number: 1, name: "Season 1", ruleset: "BB2025", champion: { team: "Karak Hammers", coach: "Carol", race: "Dwarf" }, source: "podium" }] };

  it("Coach view: the filter narrows the best records too (rank kept), counts both lists, and says when nothing matches", async () => {
    const all = await hall({ manage: false, crests: {}, view: "coach" }, TITLES, COACHES);
    expect(all.match(/data-hof="coach-record"/g)).toHaveLength(5);
    const nia = await hall({ manage: false, crests: {}, view: "coach", query: "nia" }, TITLES, COACHES);
    expect(nia.match(/data-hof="coach-record"/g)).toHaveLength(1);
    expect(nia).toMatch(/<span class="hof-rank">3<\/span><strong>Nia<\/strong>/);
    expect(nia).toContain("0 of 1 champion · 1 of 5 best records");
    const none = await hall({ manage: false, crests: {}, view: "coach", query: "zebra" }, TITLES, COACHES);
    expect(none).not.toContain('data-hof="coach-record"');
    expect(none).not.toContain("Best records");
    expect(none).toContain('<p class="hm-empty" role="status">No coaches match that filter.</p>');
  });

  it("Standings: with several divisions a division without a match hides while filtering; nothing anywhere = one line", async () => {
    const { filterStandings } = await import("../spa/src/leagues/standingsView");
    const row = (team: string, coach: string, race: string, rank: number) => ({ team, coach, race, rank }) as never;
    const north = { key: "regular:North", title: "Regular · North", rows: [row("Karak Hammers", "Carol", "Dwarf", 1), row("Gloom Lords", "Bea", "Dark Elf", 2)] };
    const south = { key: "regular:South", title: "Regular · South", rows: [row("Élan Vital", "Émile", "Wood Elf", 1), row("Pie Eaters", "Mo", "Halfling", 2)] };
    const open = filterStandings([north, south], "");
    expect(open.tables.map((t) => t.key)).toEqual(["regular:North", "regular:South"]);
    expect(open).toMatchObject({ multi: true, filtering: false, none: false, count: "4 teams" });
    const elan = filterStandings([north, south], "elan");
    expect(elan.tables.map((t) => t.key)).toEqual(["regular:South"]);
    expect(elan.tables[0]!.shownRows.map((r) => (r as { rank: number }).rank)).toEqual([1]);
    expect(elan).toMatchObject({ none: false, count: "1 of 4 teams" });
    const none = filterStandings([north, south], "zebra");
    expect(none.tables).toEqual([]);
    expect(none).toMatchObject({ none: true, count: "0 of 4 teams" });
    // one division hides the same way: the filter lives in the bar above the tables (fix round 2), not in a table
    const single = filterStandings([north], "zebra");
    expect(single.tables).toEqual([]);
    expect(single).toMatchObject({ multi: false, none: true });
    const vue = src("components/LeagueStandings.vue");
    expect(vue).toContain('<div v-if="all.length" class="lg-st-bar" data-standings-bar>');
    expect(vue).toContain('<p v-if="view.none" class="hm-empty" role="status" data-standings-none>No teams match that filter.</p>');
    expect(vue.match(/<ListFilter /g)).toHaveLength(1);
    expect(vue.match(/<select data-standings-phase/g)).toHaveLength(1);
  });

  it("every band over a filtered list reads 'N of M' while filtering (Statistics, honour boards, Participants, Fixtures)", () => {
    const stats = src("views/LeagueStatsView.vue");
    for (const needle of [
      'filtering ? of(coaches.length, Math.min(stats.coaches.length, 25), "coach", "coaches")', 'filtering ? of(teams.length, Math.min(stats.teams.length, 20), "team")',
      'of(races.length, stats.races.length, "race")', 'of(champions.length, stats.champions.length, "champion")', 'of(leaderRows, leaderTotal, "player row")',
      'of(wins.length, stats.biggestWins.length, "game")', 'of(most.length, stats.mostGames.length, "coach", "coaches")',
    ]) expect(stats, needle).toContain(needle);
    expect(src("components/HonourBoards.vue")).toContain('listCount(b.tables.length, b.total, "board")');
    expect(src("components/LeagueParticipantsList.vue")).toContain("Inactive ({{ filtering ? `${inactiveRows.length} of ${inactiveAll}` : inactiveRows.length }})");
    const fx = src("components/LeagueFixtures.vue");
    expect(fx).toContain('<span class="hm-cap">{{ phaseCap(g) }}');
    expect(fx).toContain('<span class="hm-cap">{{ roundCap(g.phase.id, r) }}</span>');
  });

  it("honour boards: counts follow the filter", async () => {
    const Boards = (await vite!.ssrLoadModule("/src/components/HonourBoards.vue")).default;
    const groups = [{ kind: "team", title: "Teams", tables: [{ key: "td", title: "Touchdowns", rows: Array.from({ length: 7 }, (_, i) => ({ rank: i + 1, name: i === 6 ? "Élan Vital" : `Team ${i}`, team: "", coach: "C", value: 9 - i })) }, { key: "cas", title: "Casualties", rows: [{ rank: 1, name: "Team 0", team: "", coach: "C", value: 3 }] }] }];
    const render = async (query: string) => {
      const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] });
      await router.push("/"); await router.isReady();
      const app = createSSRApp(Boards, { groups, value: String, query });
      app.use(router);
      return ((await m.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
    };
    expect(await render("")).toContain(">2 boards<");
    expect(await render("elan")).toContain(">1 of 2 boards<");
  });

  it("the Overview side column keeps three full house-rules rows in view and a token-only scroll shade", () => {
    const css = src("leagues/leagues.css");
    expect(css).toContain(".lg-ov > .lg-ov-side > .cf-house-panel { min-height: 136px; }");
    expect(css).toMatch(/linear-gradient\(transparent, color-mix\(in srgb, var\(--ui-heading\) 28%, transparent\)\) scroll bottom/);
    expect(css).toMatch(/linear-gradient\(var\(--sf-panel-bottom\), var\(--sf-panel-bottom\)\) local bottom/);
  });
});
