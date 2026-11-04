import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  boardPath, budgetNote, createRedraftBoard, redraftPickers, createRedraftTeam, draftTotals, formulaText, initialPicks, localToIso, redraftModePath, seasonsTitle,saveRedraftRules,  stepOf, tasksForTeam,
} from "../spa/src/leagues/redraft";
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
      revision: 0, action: "confirm", capEnabled: true, cap: 1_300_000, windowDays: 7,
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


describe("redraft mode helpers (owner 11-02)", () => {
  it("links, the formula line, Opens at in the browser's timezone", () => {
    expect(redraftModePath("tabbl", "j.smith-orcs")).toBe("/tournament-team-builder/redraft/tabbl?team=j.smith-orcs");
    expect(formulaText({ base: null, perGame: 20_000, perWin: 20_000, perDraw: 10_000, perLoss: 0 })).toBe("Budget = initial treasury + treasury left + 20k per game played + 20k per win + 10k per draw.");
    expect(formulaText({ base: 900_000, perGame: 0, perWin: 30_000, perDraw: 0, perLoss: 5_000 })).toBe("Budget = 900k + treasury left + 30k per win + 5k per loss.");
    expect(localToIso("")).toBe("");
    expect(localToIso("not a date")).toBe("");
    expect(localToIso("2026-11-09T18:00")).toBe(new Date("2026-11-09T18:00").toISOString());
  });

  it("keep / release, hire and staff steppers stay within the limits; big guys and rerolls are checked live", async () => {
    const t = createRedraftTeam({ api: mockFetcher({ "/api/leagues/tabbl/redraft/teams/orcs": { redraft: rested() } }) });
    await t.load("tabbl", "orcs");
    t.toggleKeep("p2");
    expect(t.state.picks.keep.p2).toBe(false);
    t.toggleKeep("p2");
    expect(t.state.picks.keep.p2).toBe(true);
    t.stepHire("Troll", 1);
    t.stepHire("Troll", 1);
    expect(t.state.picks.hires.Troll).toBe(1); // max 1
    t.stepHire("Troll", -5);
    expect(t.state.picks.hires.Troll).toBe(0);
    t.stepStaff("rerolls", 20);
    expect(t.state.picks.staff.rerolls).toBe(8);
    t.stepStaff("cheerleaders", -1);
    expect(t.state.picks.staff.cheerleaders).toBe(0);
    const v = rested();
    const picks = initialPicks(v);
    const big = { ...v, players: v.players.map((p, i) => (i === 1 ? { ...p, bigGuy: true } : p)) };
    picks.hires.Troll = 1;
    expect(draftTotals(big, picks).problems).toContain("At most 1 big guy (2 picked).");
  });

  it("[review P2] saving the budget formula reloads the board; Confirm sends the settings revision it read", async () => {
    let reads = 0;
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft": () => { reads += 1; return { redraft: boardView({ settingsRevision: reads === 1 ? 4 : 5, cap: reads === 1 ? 1_300_000 : 1_250_000 }) }; },
      "POST /api/leagues/tabbl/redraft": () => ({ redraft: confirmedBoard() }),
    });
    const b = createRedraftBoard({ api: f });
    await b.load("tabbl");
    const saves: unknown[] = [];
    const settings = { save: async (_s: "redraft", payload: unknown) => { saves.push(payload); return true; } };
    expect(await saveRedraftRules(settings, b, { cap: 1_250_000 })).toBe(true);
    expect(saves).toEqual([{ cap: 1_250_000 }]);
    expect(reads).toBe(2);
    expect(b.state.cap).toBe(1_250_000);
    b.state.picked.orcs = true;
    await b.confirm();
    expect(f.calls.at(-1)!.body).toMatchObject({ settingsRevision: 5, cap: 1_250_000 });
    // a failed save leaves the board as it is
    expect(await saveRedraftRules({ save: async () => false }, b, {})).toBe(false);
    expect(reads).toBe(2); // no reload after a failed save
  });

  it("[review P3] a board reload keeps the organiser's ticks; another source season starts from the server's selection", async () => {
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft": () => ({ redraft: boardView({ cap: 1_250_000 }) }),
      "/api/leagues/tabbl/redraft?source=season-5": { redraft: boardView({ source: { id: "season-5", name: "Season 5", number: 5, ruleset: "BB2025" } }) },
    });
    const b = createRedraftBoard({ api: f });
    await b.load("tabbl");
    b.state.picked.orcs = true;
    b.state.picked.gobbos = true;
    expect(await saveRedraftRules({ save: async () => true }, b, { cap: 1_250_000 })).toBe(true);
    expect(b.state.picked).toMatchObject({ orcs: true, gobbos: true, elves: false });
    expect(b.state.cap).toBe(1_250_000);
    await b.pickSource("season-5");
    expect(b.state.picked).toMatchObject({ orcs: false, gobbos: false });
  });

  it("board controller: Lift to budget per team and for all; confirm sends the window", async () => {
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft": { redraft: boardView({ rules: { base: null, perGame: 20_000, perWin: 20_000, perDraw: 10_000, perLoss: 0, agentFee: 20_000, capEnabled: true, cap: 1_300_000, setBudget: 1_000_000, liftToBudget: false, windowDays: 5 } }) },
      "POST /api/leagues/tabbl/redraft": () => ({ redraft: confirmedBoard() }),
    });
    const b = createRedraftBoard({ api: f });
    await b.load("tabbl");
    expect(b.state.windowDays).toBe(5);
    b.state.picked.orcs = true;
    b.state.opensAt = "2026-11-09T18:00";
    await b.confirm();
    // Gates lane: the board sends the wall-clock time; the server reads it in the league zone (never the browser zone).
    expect(f.calls.at(-1)!.body).toMatchObject({ windowDays: 5, opensAtWall: "2026-11-09T18:00" });
    expect(f.calls.at(-1)!.body).not.toHaveProperty("opensAt");
    await b.lift("orcs");
    expect(f.calls.at(-1)!.body).toEqual({ revision: 1, action: "lift", teamId: "orcs" });
    await b.liftAll();
    expect(f.calls.at(-1)!.body).toEqual({ revision: 1, action: "lift", all: true });
  });
});

describe("redraft surfaces (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: { provide: (k: unknown, v: unknown) => void };
      router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown; query: Record<string, unknown>; params: Record<string, unknown> } } };
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    redraft: typeof import("../spa/src/leagues/redraft");
    settings: typeof import("../spa/src/leagues/settings");
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, redraft, settings, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/redraft.ts"), vite.ssrLoadModule("/src/leagues/settings.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      redraft: redraft as typeof import("../spa/src/leagues/redraft"), settings: settings as typeof import("../spa/src/leagues/settings"),
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };
  const RULES = { base: null, perGame: 20_000, perWin: 20_000, perDraw: 10_000, perLoss: 0, agentFee: 20_000, capEnabled: true, cap: 1_300_000, setBudget: 1_200_000, liftToBudget: false, windowDays: 7 };
  const SETTINGS = {
    id: "tabbl", revision: 3,
    information: { name: "TABBL", fullName: "TABBL", description: "", ruleset: "BB2025", mode: "individual", address: null },
    permissions: { owner: "Jay", organisers: [], admins: [], canEditOrganisers: true, canChangeOwner: false },
    registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null },
    connections: { playOnFork: false, discord: { configured: false, maskedUrl: "", events: { news: true, fixtureCreated: true, matchStarted: false, matchResult: true, milestones: true, redraftRolls: false } }, naf: { available: false, note: "" } },
    teamBuilding: null, redraft: { rules: RULES, defaults: { ...RULES, setBudget: 1_000_000 }, set: ["setBudget"] },
    regions: { US: [], CA: [] }, rulesets: ["BB2020", "BB2025"], eliteSkills: [],
  };
  const LEAGUE_API = {
    "/api/leagues/tabbl": { league: { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1 }, seasons: [] },
    "/api/leagues/tabbl/settings": { settings: SETTINGS },
  };

  async function render(path: string, opts: { board?: RedraftBoardView; team?: CoachRedraftView; routes?: Routes } = {}) {
    const f = mockFetcher({ ...ORGANISER, ...LEAGUE_API, ...(opts.routes ?? {}) });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const settings = mods.settings.createLeagueSettings({ api: f });
    await settings.load("tabbl");
    spa.app.provide(mods.settings.LEAGUE_SETTINGS_KEY, settings);
    if (opts.board) {
      const board = mods.redraft.createRedraftBoard({ api: mockFetcher({ "/api/leagues/tabbl/redraft": { redraft: opts.board } }) });
      await board.load("tabbl");
      spa.app.provide(mods.redraft.REDRAFT_BOARD_KEY, board);
    }
    if (opts.team) {
      const team = mods.redraft.createRedraftTeam({ api: mockFetcher({ "/api/leagues/tabbl/redraft/teams/orcs": { redraft: opts.team } }) });
      await team.load("tabbl", "orcs");
      spa.app.provide(mods.redraft.REDRAFT_TEAM_KEY, team);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa };
  }

  const liftRows = (): RedraftBoardView => ({
    ...confirmedBoard(), rules: RULES,
    window: { opensAt: "2026-11-02T12:00:00.000Z", closesAt: "2026-11-09T12:00:00.000Z", open: true, before: false },
    active: [
      row("elves", { selected: true, status: "pending", phase: "needs-redraft", earned: 1_100_000, setBudget: 1_200_000, liftApplies: true, needsRedraft: { at: "", reason: "Over budget." } }),
      row("orcs", { selected: true, status: "submitted", phase: "submitted", earned: 1_300_000, setBudget: 1_200_000, liftApplies: false }),
    ],
  });

  it("old URLs redirect: the board to League settings -> Redraft, a team link to its Redraft mode", async () => {
    const board = await render("/leagues/tabbl/redraft", { board: boardView() });
    expect(board.spa.router.currentRoute.value.name).toBe("league-settings");
    expect(board.spa.router.currentRoute.value.query).toEqual({ tab: "redraft" });
    const team = await render("/leagues/tabbl/redraft?team=orcs", { team: coachView() });
    expect(team.spa.router.currentRoute.value.name).toBe("roster-builder-redraft");
    expect(team.spa.router.currentRoute.value.params).toEqual({ leagueId: "tabbl" });
    expect(team.spa.router.currentRoute.value.query).toEqual({ team: "orcs" });
  });

  it("League settings -> Redraft: sub-nav entry, the board (before confirmation, with the window) and the budget formula", async () => {
    const { html } = await render("/leagues/tabbl/settings?tab=redraft", { board: boardView({ rules: RULES }) });
    expect(html).toMatch(/aria-current="page"[^>]*>Redraft</);
    expect(html).toContain("Redraft board");
    expect(html).toContain("Budget = initial treasury + treasury left + 20k per game played + 20k per win + 10k per draw.");
    for (const c of ["Team", "Coach", "Race", "GP", "W-D-L", "Treasury", "Earned", "Budget"]) expect(html).toContain(`>${c}</th>`);
    expect(html).toContain(">Opens at (UTC)</span>"); // gates lane: the league zone, named
    expect(html).toContain("Redraft gates"); // the window / rest rolls / submissions gates beside the board
    expect(html).toContain("Open the Redraft rolls page");
    expect(html).toContain(">Window (days)</span>");
    expect(html).toContain("Redraft budget"); // the formula panel
    expect(html).toContain("Lift teams to the budget");
    for (const f of ["Base (k)", "Per game (k)", "Per win (k)", "Per draw (k)", "Per loss (k)", "Agent fee (k)", "Cap (k)", "Set budget (k)"]) expect(html).toContain(`>${f}</span>`);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save budget<\/button>/); // nothing changed yet
  });

  it("the board after confirmation: statuses, earned vs set, Lift to budget per team and Lift all, the window line", async () => {
    const { html } = await render("/leagues/tabbl/settings?tab=redraft", { board: liftRows() });
    expect(html).toContain(">Status</th>");
    expect(html).toContain(">Needs redraft</span>");
    expect(html).toContain(">Submitted</span>");
    expect(html).toContain("below 1,200k");
    expect(html).toContain('aria-label="Lift Elves to the set budget"');
    expect(html).not.toContain('aria-label="Lift Orcs to the set budget"');
    expect(html).toContain("Lift all to 1,200k");
    expect(html).toContain("Teams in the redraft cannot play until then.");
  });

  it("a coach who follows the board link sees their own redraft tasks", async () => {
    const tasks = [{ leagueId: "tabbl", leagueName: "TABBL", teamId: "orcs", teamName: "Orcs", race: "Orc", status: "pending", spendable: 1_160_000, link: "/app/tournament-team-builder/redraft/tabbl?team=orcs", phase: "not-started" }];
    const { html } = await render("/leagues/tabbl/settings?tab=redraft", {
      routes: { "/api/leagues/tabbl/settings": new ApiError(403, "no"), "/api/leagues?redraft=mine": { tasks } },
    });
    expect(html).toContain("Not one of yours");
    expect(html).toContain("Your redraft");
  });

  it("Redraft mode, step 1: the rest rolls in the Roster Builder layout with the budget beside them", async () => {
    const { html } = await render("/tournament-team-builder/redraft/tabbl?team=orcs", { team: coachView() });
    expect(html).toContain("hm-page tm-page tb-page sf-fit tb-wide rd-mode");
    expect(html).toContain('id="rd-tab-rest"');
    expect(html).toMatch(/id="rd-tab-roster"[^>]*disabled/);
    expect(html).toContain("Rest &amp; Relaxation");
    expect(html).toContain("rolls off on a 3+ (Apothecary)");
    expect(html).toContain(">Roll for me</button>");
    expect(html).toContain(">Enter result</button>");
    expect(html).toContain("Redraft budget");
  });

  it("Redraft mode, step 2: Keep / Release with the re-hire cost, hires and staff the normal way, the value bar against the budget, Submit", async () => {
    const v = rested();
    v.players[0] = { ...v.players[0]!, stats: { MA: "6", ST: "3", AG: "3+", PA: "4+", AV: "10+" }, skills: ["Block"] };
    v.skillCategories = { Block: "General" };
    const { html } = await render("/tournament-team-builder/redraft/tabbl?team=orcs", { team: v });
    expect(html).toContain('class="tb-work"');
    expect(html).toContain("Hireable players");
    expect(html).toContain("Sideline staff");
    expect(html).toMatch(/aria-label="Release Ug \(re-hire 165k\)"/);
    expect(html).toContain('class="skill skill-general">Block');
    expect(html).toContain('aria-label="Hire a Troll, 115k"');
    expect(html).toContain('aria-label="Add Rerolls"');
    expect(html).toMatch(/data-spent[^>]*>1,045k/); // 865k re-hires + 180k staff
    expect(html).toMatch(/data-remaining[^>]*>115k</);
    expect(html).toContain("Valid: ready to submit.");
    expect(html).toContain(">Submit draft list</button>");
  });

  // The old /app/leagues/:id/redraft page's actions (inventoried 11-02, before it became a redirect) and where each lives now.
  const OLD_PAGE_ACTIONS: Array<{ action: string; where: "board-before" | "board-after" | "mode-rest" | "mode-roster" | "mode-done" | "mine"; marker: string | RegExp }> = [
    { action: "pick the season to redraft from", where: "board-before", marker: ">Redraft from</span>" },
    { action: "pick the season receiving the lists", where: "board-before", marker: ">Draft lists go into</span>" },
    { action: "Active / Inactive team tabs", where: "board-before", marker: "Inactive (1)" },
    { action: "select a team", where: "board-before", marker: 'aria-label="Select Orcs for redraft"' },
    { action: "Check all", where: "board-before", marker: "Check all" },
    { action: "budget cap on / amount", where: "board-before", marker: "Cap budgets at" },
    { action: "per-team override before confirmation", where: "board-before", marker: ">Override</button>" },
    { action: "Confirm redraft", where: "board-before", marker: /Confirm redraft \(\d+\)/ },
    { action: "override after confirmation", where: "board-after", marker: ">Override</button>" },
    { action: "Skip a team", where: "board-after", marker: ">Skip</button>" },
    { action: "Close redraft", where: "board-after", marker: ">Close redraft</button>" },
    { action: "redraft news log", where: "board-after", marker: "Redraft news" },
    { action: "a coach's own tasks in the league", where: "mine", marker: "Your redraft" },
    { action: "Roll for me", where: "mode-rest", marker: ">Roll for me</button>" },
    { action: "Enter tabletop results", where: "mode-rest", marker: ">Enter result</button>" },
    { action: "keep or release each player (re-hire cost)", where: "mode-roster", marker: /aria-pressed="true"[^>]*aria-label="Release Ug \(re-hire 165k\)"/ },
    { action: "rerolls / assistant coaches / cheerleaders", where: "mode-roster", marker: 'aria-label="Add Cheerleaders"' },
    { action: "apothecary", where: "mode-roster", marker: "<strong>Apothecary</strong>" },
    { action: "hire new players by position", where: "mode-roster", marker: 'aria-label="Hire a Orc Lineman, 50k"' },
    { action: "live remaining budget", where: "mode-roster", marker: "data-remaining" },
    { action: "Submit draft list", where: "mode-roster", marker: ">Submit draft list</button>" },
    { action: "submitted summary", where: "mode-done", marker: "Draft list submitted" },
  ];

  it("pins every action of the old redraft page in its new place", async () => {
    const picks = { sources: [{ id: "season-6", name: "Season 6" }, { id: "season-5", name: "Season 5" }], targets: [{ id: "season-8", name: "Season 8", status: "active" }, { id: "season-7", name: "Season 7", status: "active" }] };
    // Orcs comes back ticked, so its Override button shows before confirmation
    const before = boardView({ ...picks, active: [row("elves"), row("orcs", { selected: true })] });
    const tasks = [{ leagueId: "tabbl", leagueName: "TABBL", teamId: "orcs", teamName: "Orcs", race: "Orc", status: "pending", spendable: 1, link: "" }];
    const pages: Record<string, string> = {
      "board-before": (await render("/leagues/tabbl/settings?tab=redraft", { board: before })).html,
      "board-after": (await render("/leagues/tabbl/settings?tab=redraft", { board: confirmedBoard() })).html,
      mine: (await render("/leagues/tabbl/settings?tab=redraft", { routes: { "/api/leagues/tabbl/settings": new ApiError(403, "no"), "/api/leagues?redraft=mine": { tasks } } })).html,
      "mode-rest": (await render("/tournament-team-builder/redraft/tabbl?team=orcs", { team: coachView() })).html,
      "mode-roster": (await render("/tournament-team-builder/redraft/tabbl?team=orcs", { team: rested() })).html,
      "mode-done": (await render("/tournament-team-builder/redraft/tabbl?team=orcs", { team: coachView({ status: "submitted", draft: { spent: 1_000_000, treasury: 160_000, keep: [{ playerId: "p1", cost: 165_000 }], hires: [] } }) })).html,
    };
    const missing = OLD_PAGE_ACTIONS.filter((a) => (typeof a.marker === "string" ? !pages[a.where]!.includes(a.marker) : !a.marker.test(pages[a.where]!))).map((a) => `${a.action} (${a.where})`);
    expect(missing).toEqual([]);
    expect(OLD_PAGE_ACTIONS).toHaveLength(22);
  });
});
