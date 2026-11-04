import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toZoneInput, zoneCaption } from "../spa/src/shared/localTime";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { boardPath, createRedraftBoard, createRedraftTeam, redraftModePath } from "../spa/src/leagues/redraft";
import { gatesApiAt, resetGateStores, tournamentGateBase, useLeagueGates, useTournamentGates } from "../spa/src/leagues/gates";
import { wallValue } from "../spa/src/leagues/wizard";
import type { RedraftBoardView } from "../spa/src/leagues/types";

// Cleanup lane 11-03, the SPA side: the redraft board's Competition picker (ladder redrafts), Redraft mode's ?ladder=, the
// gate store and editor scoped to a tournament, and league-zone registration times. Fake data only.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Calls = Array<{ path: string; method: string; body?: unknown }>;
function mockFetcher(routes: Record<string, unknown>): Fetcher & { calls: Calls } {
  const calls: Calls = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Calls };
  f.calls = calls;
  return f;
}

const row = (teamId: string, name: string, over: Record<string, unknown> = {}) => ({
  teamId, sourceSeasonId: "ladder-1", sourceSeasonName: "Spring Ladder", name, coach: "Ann", race: "Human", played: 4, wins: 2, draws: 1, losses: 1, treasury: 50_000,
  budget: { base: 1_000_000, treasury: 50_000, played: 4, wins: 2, draws: 1, bonus: 130_000, raw: 1_180_000, capped: 1_180_000 }, players: [], selected: true, status: "pending",
  spendable: 1_180_000, earned: 1_180_000, setBudget: 1_200_000, liftApplies: true, phase: "not-started", ...over,
});
export const LADDER_BOARD: RedraftBoardView = {
  leagueId: "tabbl", leagueName: "TABBL", timeZone: "Europe/London", revision: 4,
  source: { id: "ladder-1", name: "Spring Ladder", number: 9, ruleset: "BB2025" }, target: { id: "ladder-1", name: "Spring Ladder" }, sources: [], targets: [],
  state: { startedAt: "2026-11-01T00:00:00.000Z", byCoach: "League", capEnabled: true, cap: 1_300_000, revision: 4, log: [{ at: "2026-11-01T00:00:00.000Z", by: "League", text: "Fake Orcs has played 4 ladder games since its last redraft and must redraft before its next challenge." }] },
  capEnabled: true, cap: 1_300_000,
  rules: { base: null, perGame: 20_000, perWin: 20_000, perDraw: 10_000, perLoss: 0, capEnabled: true, cap: 1_300_000, agentFee: 20_000, windowDays: 7, setBudget: 1_200_000, liftToBudget: false } as never,
  settingsRevision: 2, window: null,
  active: [row("t1", "Fake Orcs") as never, row("t2", "Sample Elves", { phase: "submitted", status: "submitted", liftApplies: false }) as never, row("t3", "Demo Dwarfs", { phase: "needs-redraft", needsRedraft: { at: "x", reason: "Over budget." } }) as never, row("t4", "Mock Mudders", { phase: "not-selected", selected: false, status: undefined }) as never],
  inactive: [], note: "Each team redrafts after its set number of ladder games, before its next challenge. Redrafted teams stay in Spring Ladder.",
  ladder: { id: "ladder-1", name: "Spring Ladder", trigger: "games", everyGames: 4 }, ladders: [{ id: "ladder-1", name: "Spring Ladder" }],
};

describe("ladder redraft board and Redraft mode (controllers)", () => {
  it("the board reads ?ladder= and every action sends ladderId; Redraft mode adds ?ladder= to its reads and writes", async () => {
    expect(boardPath("tabbl", { ladder: "ladder-1", source: "season-2" })).toBe("/api/leagues/tabbl/redraft?ladder=ladder-1");
    expect(boardPath("tabbl", { source: "season-2" })).toBe("/api/leagues/tabbl/redraft?source=season-2");
    expect(redraftModePath("tabbl", "t.1", "ladder-1")).toBe("/tournament-team-builder/redraft/tabbl?team=t.1&ladder=ladder-1");
    const f = mockFetcher({
      "/api/leagues/tabbl/redraft": { redraft: { ...LADDER_BOARD, ladder: null, ladders: LADDER_BOARD.ladders, source: null, active: [], state: null } },
      "/api/leagues/tabbl/redraft?ladder=ladder-1": { redraft: LADDER_BOARD },
      "POST /api/leagues/tabbl/redraft": { redraft: LADDER_BOARD },
    });
    const board = createRedraftBoard({ api: f });
    await board.load("tabbl");
    await board.pickLadder("ladder-1");
    expect(board.state.view?.ladder?.id).toBe("ladder-1");
    await board.lift("t1");
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", body: { revision: 4, ladderId: "ladder-1", action: "lift", teamId: "t1" } });
    const team = createRedraftTeam({ api: mockFetcher({ "/api/leagues/tabbl/redraft/teams/t1?ladder=ladder-1": { redraft: { revision: 1, status: "pending", closed: false, rest: { needed: [], done: true, rolls: [], target: 4 }, players: [], positions: [], staff: { current: { rerolls: 0, assistantCoaches: 0, cheerleaders: 0, apothecary: false }, maxRerolls: 8 }, limits: { assistantCoaches: 6, cheerleaders: 12 } } } }) });
    await team.load("tabbl", "t1", "ladder-1");
    expect(team.state.denied).toBe("");
    expect(team.state.ladderId).toBe("ladder-1");
  });
});

describe("gates scoped to a tournament (controllers)", () => {
  it("a tournament's gates use their own base and store, apart from any league's", async () => {
    resetGateStores();
    expect(tournamentGateBase("t 1")).toBe("/api/tournaments/t%201");
    const f = mockFetcher({ "/api/tournaments/t1/gates": { timeZone: "UTC", now: "", manage: true, gates: [] }, "/api/leagues/t1/gates": { timeZone: "Europe/London", now: "", manage: false, gates: [] } });
    const t = useTournamentGates(f, "t1");
    const l = useLeagueGates(f, "t1");
    await t.reload();
    await l.reload();
    expect(t.state.read?.timeZone).toBe("UTC");
    expect(l.state.read?.timeZone).toBe("Europe/London");
    const put = mockFetcher({ "PUT /api/tournaments/t1/gates/registration/tournament": { gate: null } });
    await gatesApiAt.save(put, t.base, "registration", "tournament", 2, { mode: "time", opensAt: "2026-11-12T19:00" });
    expect(put.calls[0]).toMatchObject({ method: "PUT", body: { mode: "time", opensAt: "2026-11-12T19:00", revision: 2 } });
  });

  it("registration times are wall values (never a browser-zone conversion)", () => {
    expect(wallValue("2026-11-05T19:00")).toBe("2026-11-05T19:00");
    expect(wallValue("2026-11-05T19:00:30")).toBe("2026-11-05T19:00");
    expect(wallValue("")).toBeNull();
  });
});

describe("cleanup lane surfaces (server-rendered)", () => {
  let vite: ViteDevServer | undefined;
  let mods: {
    createSpa: (o: unknown) => { app: { provide: (k: unknown, v: unknown) => void }; router: { addRoute: (r: unknown) => void; push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    gates: typeof import("../spa/src/leagues/gates");
    redraft: typeof import("../spa/src/leagues/redraft");
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, gates, redraft, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/gates.ts"), vite.ssrLoadModule("/src/leagues/redraft.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, gates: gates as never, redraft: redraft as never };
  }, 120_000);
  afterAll(async () => { await vite?.close(); });
  const SESSION = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };

  async function mount(file: string, props: Record<string, unknown>, before?: (spa: ReturnType<typeof mods.createSpa>) => void): Promise<string> {
    const Comp = (await vite!.ssrLoadModule(file)).default;
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: mockFetcher(SESSION) });
    before?.(spa);
    spa.router.addRoute({ path: "/__probe", component: Comp, props });
    await spa.router.push("/__probe");
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }

  it("the tournament gate editor: At a time only, typed in the viewer's own zone (owner 11-04); the coach banner counts down", async () => {
    mods.gates.resetGateStores();
    const store = mods.gates.useTournamentGates(mockFetcher({}), "spike");
    const soon = new Date(Date.now() + 26 * 3600_000).toISOString();
    store.state.read = { timeZone: "UTC", now: new Date().toISOString(), manage: true, gates: [{ id: "registration:tournament", kind: "registration", target: "tournament", targetName: "Spike Open", label: "Registration", title: "Spike Open: Registration opens", state: "shut", opensAt: soon, secondsLeft: 93_600, mode: "time", wall: soon.slice(0, 16), revision: 1 }] };
    store.state.loaded = true;
    const html = await mount("/src/components/LeagueGatesPanel.vue", { tournamentId: "spike", title: "Registration gate", items: [{ kind: "registration", target: "tournament", label: "Registration opens" }] });
    expect(html).toContain("Registration gate");
    expect(html).toContain("typed in your own time zone; each coach sees it in theirs");
    expect(html).toContain(">At a time</button>");
    expect(html).not.toContain("With a League Event");
    expect(html).toContain(`Opens at (${zoneCaption()})`);
    // the form shows the instant in the viewer's zone (never the server's wall value)
    expect(html).toContain(`value="${toZoneInput(soon)}"`);
    expect(html).toContain('data-gate-open="registration"');
    const banner = await mount("/src/components/LeagueGateBanner.vue", { tournamentId: "spike", kinds: ["registration"] });
    expect(banner).toContain("data-gate-banner");
    expect(banner).toContain("Registration opens");
  });

  it("the redraft board runs a ladder: Competition picker, no Inactive tab, statuses, Lift to budget", async () => {
    const board = mods.redraft.createRedraftBoard({ api: mockFetcher({}) });
    board.state.view = LADDER_BOARD;
    board.state.loaded = true;
    board.state.id = "tabbl";
    board.state.ladderPick = "ladder-1";
    const html = await mount("/src/components/LeagueRedraftBoard.vue", {}, (spa) => spa.app.provide(mods.redraft.REDRAFT_BOARD_KEY, board));
    expect(html).toContain("data-redraft-competition");
    expect(html).toContain("Spring Ladder (ladder)");
    expect(html).toContain("Spring Ladder · After games 4");
    expect(html).not.toContain("Inactive (");
    expect(html).toContain('data-status="needs-redraft"');
    expect(html).toContain('data-status="submitted"');
    expect(html).toContain("Lift to budget");
    expect(html).toContain(">Not due</span>");
  });
});
