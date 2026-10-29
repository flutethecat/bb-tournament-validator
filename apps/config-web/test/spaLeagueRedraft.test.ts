import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { boardPath, budgetNote, createRedraftBoard, redraftPickers, createRedraftTeam, draftTotals, initialPicks, seasonsTitle, stepOf, tasksForTeam } from "../spa/src/leagues/redraft";
import type { CoachRedraftView, RedraftBoardRow, RedraftBoardView } from "../spa/src/leagues/types";

// SPA league redraft: the board and coach controllers, the live draft sums, and the board / dialog server-rendered.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> };
  f.calls = calls;
  return f;
}

const budget = (raw: number, capped = Math.min(raw, 1_300_000)) => ({ base: 1_000_000, treasury: 50_000, played: 3, wins: 2, draws: 1, bonus: 110_000, raw, capped });
const row = (teamId: string, over: Partial<RedraftBoardRow> = {}): RedraftBoardRow => ({
  teamId, sourceSeasonId: "season-6", sourceSeasonName: "Season 6", name: teamId === "orcs" ? "Orcs" : "Elves", coach: teamId === "orcs" ? "Ann" : "Bob", race: "Orc",
  played: 3, wins: 2, draws: 1, losses: 0, treasury: 50_000, budget: budget(1_160_000), players: [{ name: "Ug", position: "Orc Blitzer", seasons: 3 }],
  selected: false, spendable: 1_160_000, ...over,
});
const boardView = (over: Partial<RedraftBoardView> = {}): RedraftBoardView => ({
  leagueId: "tabbl", leagueName: "TABBL", revision: 0, source: { id: "season-6", name: "Season 6", number: 6, ruleset: "BB2025" }, target: null, state: null,
  capEnabled: true, cap: 1_300_000, active: [row("elves"), row("orcs", { budget: budget(1_420_000), spendable: 1_300_000 })],
  inactive: [row("gobbos", { name: "Gobbos", sourceSeasonId: "season-5", sourceSeasonName: "Season 5" })], note: "Draft lists are kept until the next season is started, then go into it.", ...over,
});
const confirmedBoard = (): RedraftBoardView => boardView({
  revision: 1,
  state: { startedAt: "2026-11-01T12:00:00.000Z", byCoach: "Jay", capEnabled: true, cap: 1_300_000, revision: 1, log: [{ at: "2026-11-01T12:00:00.000Z", by: "Jay", text: "Jay started the redraft from Season 6: 1 team selected." }] },
  active: [row("elves", { status: "skipped" }), row("orcs", { selected: true, status: "pending", override: { budget: 1_200_000, reason: "Prize money", by: "Jay", at: "" }, spendable: 1_200_000 })],
});

const coachView = (over: Partial<CoachRedraftView> = {}): CoachRedraftView => ({
  leagueId: "tabbl", revision: 1, teamId: "orcs", name: "Orcs", race: "Orc", coach: "Ann", sourceSeason: { id: "season-6", name: "Season 6" }, targetSeason: null,
  status: "pending", closed: false, budget: budget(1_160_000), capEnabled: true, cap: 1_300_000, override: null, spendable: 1_160_000, apothecaryNow: true,
  rest: { target: 3, done: false, rolls: [], needed: [{ playerId: "p1", name: "Ug", position: "Orc Blitzer", niggling: 1 }] },
  players: [
    { playerId: "p1", number: 1, name: "Ug", position: "Orc Blitzer", value: 105_000, seasons: 3, fee: 60_000, cost: 165_000, niggling: 1, nigglingAfter: 1, missNextGame: true, bigGuy: false },
    ...Array.from({ length: 10 }, (_, i) => ({ playerId: `p${i + 2}`, number: i + 2, name: `Orc ${i + 2}`, position: "Orc Lineman", value: 50_000, seasons: 1, fee: 20_000, cost: 70_000, niggling: 0, nigglingAfter: 0, missNextGame: false, bigGuy: false })),
  ],
  staff: { rerollCost: 60_000, maxRerolls: 8, assistantCoachCost: 10_000, cheerleaderCost: 10_000, apothecaryCost: 50_000, apothecaryAllowed: true, current: { rerolls: 2, assistantCoaches: 1, cheerleaders: 0, apothecary: true } },
  positions: [{ name: "Orc Lineman", cost: 50_000, max: 16, bigGuy: false }, { name: "Orc Blitzer", cost: 85_000, max: 2, bigGuy: false }, { name: "Troll", cost: 115_000, max: 1, bigGuy: true }],
  limits: { minPlayers: 11, maxPlayers: 16, assistantCoaches: 6, cheerleaders: 12, maxBigGuys: 1 },
  draft: null, knownRoster: true, ...over,
});
const rested = (): CoachRedraftView => coachView({ revision: 2, rest: { ...coachView().rest, done: true, rolls: [{ playerId: "p1", roll: 4, target: 3, recovered: true, source: "site" }] } });

describe("redraft helpers and controllers", () => {
  it("[review P2] pickers: source stays pickable after a redraft closes; target locks once confirmed", () => {
    const lists = { sources: [{ id: "season-6", name: "Season 6" }, { id: "season-5", name: "Season 5" }], targets: [{ id: "season-8", name: "Season 8", status: "active" }, { id: "season-7", name: "Season 7", status: "active" }] };
    const running = confirmedBoard().state!;
    expect(redraftPickers({ ...lists, state: null })).toEqual({ source: true, target: true });
    expect(redraftPickers({ ...lists, state: running })).toEqual({ source: false, target: false });
    expect(redraftPickers({ ...lists, state: { ...running, closedAt: "2026-11-02T00:00:00.000Z", closedBy: "Jay" } })).toEqual({ source: true, target: false });
    expect(redraftPickers({ state: null, sources: [lists.sources[0]!], targets: [] })).toEqual({ source: false, target: false });
  });

  it("overlapping seasons: the board reads with the source / target picks and confirm sends them", async () => {
    expect(boardPath("tabbl")).toBe("/api/leagues/tabbl/redraft");
    expect(boardPath("tabbl", { source: "season-5", target: "season-7" })).toBe("/api/leagues/tabbl/redraft?source=season-5&target=season-7");
    const picked = boardView({ source: { id: "season-5", name: "Season 5", number: 5, ruleset: "BB2020" }, target: { id: "season-7", name: "Season 7" },
      sources: [{ id: "season-6", name: "Season 6" }, { id: "season-5", name: "Season 5" }], targets: [{ id: "season-8", name: "Season 8", status: "active" }, { id: "season-7", name: "Season 7", status: "active" }] });
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft": { redraft: boardView() },
      "/api/leagues/tabbl/redraft?source=season-5": { redraft: { ...picked, target: { id: "season-8", name: "Season 8" } } },
      "/api/leagues/tabbl/redraft?source=season-5&target=season-7": { redraft: picked },
      "POST /api/leagues/tabbl/redraft": { redraft: picked },
    });
    const b = createRedraftBoard({ api: f });
    await b.load("tabbl");
    await b.pickSource("season-5");
    expect(b.state.view!.target!.id).toBe("season-8");
    await b.pickTarget("season-7");
    expect(f.calls.at(-1)!.path).toBe("/api/leagues/tabbl/redraft?source=season-5&target=season-7");
    b.state.picked.orcs = true;
    await b.confirm();
    expect(f.calls.at(-1)!.body).toMatchObject({ action: "confirm", sourceSeasonId: "season-5", targetSeasonId: "season-7" });
    // Without a target pick the server default is used (no targetSeasonId sent).
    await b.pickSource("season-5");
    await b.confirm();
    expect((f.calls.at(-1)!.body as Record<string, unknown>).targetSeasonId).toBeUndefined();
  });

  it("budget notes, hover text, step, team-name match", () => {
    expect(budgetNote(row("orcs", { budget: budget(1_420_000) }))).toBe("Capped from 1,420k");
    expect(budgetNote(row("orcs"))).toBe("");
    expect(budgetNote(row("orcs", { override: { budget: 1, reason: "Fees", by: "", at: "" } }))).toBe("Override: Fees");
    expect(seasonsTitle(row("orcs"))).toBe("Ug: 3 seasons");
    expect(stepOf(coachView())).toBe("rest");
    expect(stepOf(rested())).toBe("draft");
    expect(stepOf(coachView({ status: "submitted" }))).toBe("done");
    const tasks = [{ leagueId: "tabbl", leagueName: "TABBL", teamId: "orcs", teamName: "Orcs", race: "Orc", status: "pending" as const, spendable: 1, link: "" }];
    expect(tasksForTeam(tasks, " orcs ")).toHaveLength(1);
    expect(tasksForTeam(tasks, "Elves")).toHaveLength(0);
  });

  it("live draft sums mirror the server price; problems for size, positions and budget", () => {
    const v = rested();
    const picks = initialPicks(v);
    const t = draftTotals(v, picks);
    expect(t.players).toBe(11);
    expect(t.keepCost).toBe(165_000 + 10 * 70_000);
    expect(t.staffCost).toBe(2 * 60_000 + 10_000 + 50_000);
    expect(t.remaining).toBe(1_160_000 - t.spent);
    expect(t.problems).toEqual([]);
    picks.keep.p2 = false;
    expect(draftTotals(v, picks).problems).toContain("A team needs at least 11 players (10 picked).");
    picks.hires["Orc Blitzer"] = 2;
    expect(draftTotals(v, picks).problems).toContain("At most 2 Orc Blitzers.");
    picks.hires["Orc Blitzer"] = 0;
    picks.staff.rerolls = 8;
    picks.keep.p2 = true;
    expect(draftTotals(v, picks).problems.join(" ")).toMatch(/Over the budget by/);
  });

  it("board controller: confirm sends the selection, overrides and revision; 409 reloads", async () => {
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft": { redraft: boardView() },
      "POST /api/leagues/tabbl/redraft": () => ({ redraft: confirmedBoard() }),
    });
    const b = createRedraftBoard({ api: f });
    await b.load("tabbl");
    b.checkAll(b.state.view!.active, true);
    b.state.overrides.orcs = { budget: 1_200_000, reason: "Prize money" };
    expect(await b.confirm()).toBe(true);
    expect(f.calls.at(-1)!.body).toEqual({
      revision: 0, action: "confirm", capEnabled: true, cap: 1_300_000,
      teams: [{ teamId: "elves", selected: true }, { teamId: "orcs", selected: true, override: { budget: 1_200_000, reason: "Prize money" } }, { teamId: "gobbos", selected: false }],
    });
    expect(b.state.view!.revision).toBe(1);
    const stale = createRedraftBoard({ api: mockFetcher({ "/api/leagues/tabbl/redraft": { redraft: confirmedBoard() }, "POST /api/leagues/tabbl/redraft": new ApiError(409, "The redraft changed since you opened it.") }) });
    await stale.load("tabbl");
    expect(await stale.close()).toBe(false);
    expect(stale.state.message).toContain("The board reloaded.");
    const denied = createRedraftBoard({ api: mockFetcher({ "/api/leagues/tabbl/redraft": new ApiError(403, "no") }) });
    await denied.load("tabbl");
    expect(denied.state.denied).toBe("forbidden");
  });

  it("team controller: roll for me, entered results, submit body", async () => {
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft/teams/orcs": { redraft: coachView() },
      "POST /api/leagues/tabbl/redraft/teams/orcs/rest": () => ({ redraft: rested() }),
      "POST /api/leagues/tabbl/redraft/teams/orcs/submit": () => ({ redraft: coachView({ revision: 3, status: "submitted" }) }),
    });
    const t = createRedraftTeam({ api: f });
    await t.load("tabbl", "orcs");
    expect(t.state.step).toBe("rest");
    expect(t.enteredComplete()).toBe(false);
    t.state.entered.p1 = [5];
    expect(t.enteredComplete()).toBe(true);
    expect(await t.enterResults()).toBe(true);
    expect(f.calls.at(-1)!.body).toEqual({ revision: 1, mode: "entered", rolls: { p1: [5] } });
    expect(t.state.step).toBe("draft");
    t.state.picks.keep.p2 = false;
    t.state.picks.hires.Troll = 1;
    expect(await t.submit()).toBe(true);
    expect(f.calls.at(-1)!.body).toMatchObject({ revision: 2, hires: [{ position: "Troll", count: 1 }], staff: { rerolls: 2, assistantCoaches: 1, cheerleaders: 0, apothecary: true } });
    expect((f.calls.at(-1)!.body as { keep: string[] }).keep).not.toContain("p2");
    expect(t.state.step).toBe("done");
  });
});

describe("redraft pages (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown } } };
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    redraft: typeof import("../spa/src/leagues/redraft");
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, redraft, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/redraft.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, redraft: redraft as typeof import("../spa/src/leagues/redraft") };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };

  async function render(path: string, routes: Routes, teamView?: CoachRedraftView) {
    const f = mockFetcher({ ...ORGANISER, ...routes });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const board = mods.redraft.createRedraftBoard({ api: f });
    await board.load("tabbl");
    spa.app.provide(mods.redraft.REDRAFT_BOARD_KEY, board);
    if (teamView) {
      const team = mods.redraft.createRedraftTeam({ api: mockFetcher({ "/api/leagues/tabbl/redraft/teams/orcs": { redraft: teamView } }) });
      await team.load("tabbl", "orcs");
      spa.app.provide(mods.redraft.REDRAFT_TEAM_KEY, team);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa };
  }

  it("board before confirmation: tabs, columns, checkboxes, Check all, cap, Confirm redraft", async () => {
    const { html, spa } = await render("/leagues/tabbl/redraft", { "/api/leagues/tabbl/redraft": { redraft: boardView() } });
    expect(spa.router.currentRoute.value.name).toBe("league-redraft");
    expect(html).toContain("Redraft board");
    expect(html).toContain("From Season 6");
    expect(html).toContain("Active teams (2)");
    expect(html).toContain("Inactive (1)");
    for (const c of ["Team", "Coach", "Race", "GP", "W-D-L", "Treasury", "Budget"]) expect(html).toContain(`>${c}</th>`);
    expect(html).toContain('aria-label="Select Orcs for redraft"');
    expect(html).toContain("Check all");
    expect(html).toContain("Cap budgets at");
    expect(html).toContain("Capped from 1,420k");
    expect(html).toContain('title="Ug: 3 seasons"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm redraft \(0\)<\/button>/);
    expect(html).not.toContain("Progress");
  });

  it("board after confirmation: progress column, override note, highlighted row, log, Close redraft", async () => {
    const { html } = await render("/leagues/tabbl/redraft", { "/api/leagues/tabbl/redraft": { redraft: confirmedBoard() } });
    expect(html).toContain(">Progress</th>");
    expect(html).toContain(">Drafting</span>");
    expect(html).toContain("Not selected");
    expect(html).toContain("Override: Prize money");
    expect(html).toMatch(/class="lg-row-picked" data-team="orcs"/);
    expect(html).toContain("Redraft news");
    expect(html).toContain("Jay started the redraft from Season 6");
    expect(html).toContain(">Close redraft</button>");
    expect(html).not.toContain("Confirm redraft");
  });

  it("coach dialog: Rest & Relaxation step, then the draft list with live remaining budget, then submitted", async () => {
    const routes = { "/api/leagues/tabbl/redraft": new ApiError(403, "no") };
    const rest = await render("/leagues/tabbl/redraft?team=orcs", routes, coachView());
    expect(rest.html).toContain('role="dialog"');
    expect(rest.html).toMatch(/Redraft(<!--\[-->)?: Orcs/);
    expect(rest.html).toContain("Rest &amp; Relaxation");
    expect(rest.html).toContain("rolls off on a 3+ (Apothecary)");
    expect(rest.html).toContain(">Roll for me</button>");
    expect(rest.html).toContain(">Enter result</button>");
    expect(rest.html).toContain("Your redraft"); // the page behind: not an organiser
    const draft = await render("/leagues/tabbl/redraft?team=orcs", routes, rested());
    expect(draft.html).toContain("Re-hire players");
    expect(draft.html).toContain("4 healed");
    expect(draft.html).toContain('aria-label="Keep #1 Ug"');
    expect(draft.html).toContain(">165k</b>");
    expect(draft.html).toContain("Rerolls (60k each, max 8)");
    expect(draft.html).toContain("Hire new players");
    expect(draft.html).toContain("Troll (115k, max 1)");
    expect(draft.html).toMatch(/data-remaining[^>]*>115k</); // 1,160k - 865k re-hires - 180k staff
    expect(draft.html).toContain(">Submit draft list</button>");
    const done = await render("/leagues/tabbl/redraft?team=orcs", routes, coachView({
      status: "submitted", draft: { spent: 1_000_000, treasury: 160_000, keep: [{ playerId: "p1", cost: 165_000 }], hires: [{ position: "Troll", count: 1, cost: 115_000 }] },
    }));
    expect(done.html).toContain("Draft list submitted");
    expect(done.html).toContain("1 player re-hired, 1 new");
    expect(done.html).toContain("becomes your team when the next season starts");
  });
});
