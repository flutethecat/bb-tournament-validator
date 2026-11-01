import { fileURLToPath } from "node:url";
import { createSSRApp, h } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentEntrant, type TournamentFixture, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  activityViews, createTournamentDetail, editedTitle, isPageAction, laterRounds, resultEditBody, resultEditForm, resultEditProblem, resultSource, resultText, roundViews,
} from "../spa/src/tournaments/detail";
import { editedLine } from "../spa/src/games/detail";

// Organiser result edits in the SPA: Manage → Rounds with Edit result, the Edit result dialog, the Edited chip and the
// Rounds-tab activity feed. Controller and helper unit tests with a mocked Fetcher, and the views server-rendered
// through the SPA's own Vite config (no port). Fake coaches only.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const tournament = (over: Partial<TournamentSummary> = {}): TournamentSummary => ({
  id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3,
  currentRound: 2, tiebreakers: ["buchholz"], entrantCount: 2, ownerCoachId: "Veers", organizerCoachIds: ["Piett"],
  pairingSystem: "dutch", seedingMode: "elo", remainingRounds: 1, startedAt: "2026-10-29T12:00:00Z", ...over,
});
const entrant = (n: number, coach: string, team: string): TournamentEntrant => ({ id: `e${n}`, seed: n, coachId: coach, teamId: `tm${n}`, teamName: team, race: "Orc" });
const side = (n: number, coach: string) => ({ entrantId: `e${n}`, teamId: `tm${n}`, coach: { ffbCoachId: coach } });
const EDITED = { kind: "result" as const, byCoachId: "Piett", at: "2026-11-01T10:00:00.000Z", reason: "Typo", previous: { homeScore: 2, awayScore: 1 }, original: { homeScore: 2, awayScore: 1 } };
const FIXTURES: TournamentFixture[] = [
  { id: "m1", roundNumber: 1, status: "completed", home: side(1, "Ann"), away: side(2, "Bob"), result: { homeScore: 1, awayScore: 1, homeCasualties: 2, awayCasualties: 0 }, revision: 4, edited: EDITED, launch: { gameId: "g1" } },
  { id: "m2", roundNumber: 1, status: "completed", home: side(3, "Cy"), away: side(4, "Di"), result: { homeScore: 0, awayScore: 2 }, revision: 3 },
  { id: "m3", roundNumber: 2, status: "scheduled", home: side(1, "Ann"), away: side(3, "Cy"), revision: 1 },
];
const ACTIVITY = [{ id: "a1", at: "2026-11-01T10:00:00.000Z", by: "Piett", kind: "result-edited" as const, admin: true as const, fixtureId: "m1", roundNumber: 1, result: { homeScore: 1, awayScore: 1 }, previous: { homeScore: 2, awayScore: 1 }, reason: "Typo" }];
const body = (over: Partial<TournamentDetailResponse> = {}): TournamentDetailResponse => ({
  tournament: tournament(), entrants: [entrant(1, "Ann", "Ann Orcs"), entrant(2, "Bob", "Bob Elves"), entrant(3, "Cy", "Cy Dwarfs"), entrant(4, "Di", "Di Humans")],
  rounds: [{ id: "r1", number: 1, status: "completed" }, { id: "r2", number: 2, status: "active" }] as TournamentDetailResponse["rounds"],
  scheduledMatches: FIXTURES, activity: ACTIVITY, capabilities: { manage: true, assignRoles: false }, ...over,
});

describe("result edit helpers", () => {
  it("the form starts from the current result and validates scores, casualty pairs, no-op and the finished confirm", () => {
    const f = FIXTURES[0]!;
    const form = resultEditForm(f);
    expect(form).toEqual({ homeScore: "1", awayScore: "1", homeCas: "2", awayCas: "0", reason: "", confirmFinished: false });
    expect(resultEditProblem(form, f, false)).toBe("Nothing changed yet.");
    expect(resultEditProblem({ ...form, homeScore: "" }, f, false)).toMatch(/both scores/);
    expect(resultEditProblem({ ...form, homeScore: "2", awayCas: "" }, f, false)).toMatch(/both casualty/);
    expect(resultEditProblem({ ...form, homeScore: "2" }, f, true)).toMatch(/finished/);
    expect(resultEditProblem({ ...form, homeScore: "2", confirmFinished: true }, f, true)).toBe("");
    expect(resultEditBody({ revision: 4 }, { ...form, homeScore: "2", reason: " fixed " })).toEqual({ revision: 4, homeScore: 2, awayScore: 1, homeCasualties: 2, awayCasualties: 0, reason: "fixed" });
    expect(resultEditBody({ revision: 4 }, { ...form, homeCas: "", awayCas: "" })).toEqual({ revision: 4, homeScore: 1, awayScore: 1 });
  });

  it("chip tooltip, activity lines, later rounds, and the game page line", () => {
    expect(editedTitle(EDITED)).toBe("Result edited by Piett on 2026-11-01, was 2 - 1, reason: Typo.");
    expect(editedTitle({ kind: "result", byCoachId: "Piett", at: "2026-11-01T10:00:00.000Z", cleared: true })).toBe("Result cleared by Piett on 2026-11-01.");
    expect(resultText({ homeScore: 1, awayScore: 0, homeCasualties: 3, awayCasualties: 1 })).toBe("1 - 0 (CAS 3 - 1)");
    const s = body();
    expect(activityViews({ activity: s.activity!, fixtures: FIXTURES, entrants: s.entrants })).toEqual([
      { id: "a1", when: "2026-11-01 10:00 UTC", by: "Piett", text: "Round 1: Ann Orcs v Bob Elves edited to 1 - 1 (was 2 - 1)", reason: "Typo" },
    ]);
    expect(laterRounds(s.rounds, 1)).toEqual([2]);
    expect(roundViews({ rounds: s.rounds, fixtures: FIXTURES, entrants: s.entrants })[0]!.fixtures[0]!.edited).toEqual(EDITED);
    expect(isPageAction("result:m1")).toBe(true);
    expect(resultSource(FIXTURES[0]!)).toBe("Online game");
    expect(resultSource({ result: { homeScore: 1, awayScore: 0, opId: "op1" } })).toBe("Tabletop match");
    expect(resultSource(FIXTURES[1]!)).toBe("Entered by an organiser");
    expect(resultSource(FIXTURES[2]!)).toBe("");
    expect(editedLine({ by: "Piett", at: "2026-11-01T10:00:00.000Z", result: { home: { coach: "Ann", score: 1, cas: 2 }, away: { coach: "Bob", score: 1, cas: 0 } } }))
      .toBe("The tournament counts Ann 1 - 1 Bob (CAS 2 - 0), set by Piett on 2026-11-01. The game below is shown as played.");
    expect(editedLine({ by: "Piett", at: "2026-11-01T10:00:00.000Z", cleared: true })).toMatch(/cleared by Piett/);
  });

  it("the controller sends the revision the dialog loaded (PATCH) and the clear (POST), then refetches", async () => {
    const f = mockFetcher({
      "/api/tournaments/t1": body(),
      "PATCH /api/tournaments/t1/fixtures/m1/result": { match: {} },
      "POST /api/tournaments/t1/fixtures/m1/result/clear": { match: {} },
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    expect(d.state.activity).toHaveLength(1);
    expect(await d.editResult("m1", { ...resultEditForm(FIXTURES[0]!), homeScore: "3" }, 4)).toBe(true);
    expect(f.calls.find((c) => c.method === "PATCH")!.body).toEqual({ revision: 4, homeScore: 3, awayScore: 1, homeCasualties: 2, awayCasualties: 0 });
    expect(d.state.notice).toBe("Result edited.");
    expect(await d.clearResult("m1", { reason: "Replay", confirmFinished: false }, 5)).toBe(true);
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ revision: 5, reason: "Replay" });
    expect(f.calls.filter((c) => c.path === "/api/tournaments/t1").length).toBeGreaterThanOrEqual(3);
  });

  it("a refused edit keeps the server's message for the dialog", async () => {
    const f = mockFetcher({
      "/api/tournaments/t1": body(),
      "PATCH /api/tournaments/t1/fixtures/m1/result": new ApiError(409, "This fixture changed since you opened it (now revision 5). Reload to see the latest."),
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    expect(await d.editResult("m1", { ...resultEditForm(FIXTURES[0]!), homeScore: "3" }, 4)).toBe(false);
    expect(d.state.lastAction).toBe("result:m1");
    expect(d.state.actionError).toMatch(/changed since you opened it/);
  });
});

describe("result edit views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [detail, renderer, editor, dialog, rounds, reporter] = await Promise.all([
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/TournamentResultsEditor.vue"),
      vite.ssrLoadModule("/src/components/TournamentResultDialog.vue"),
      vite.ssrLoadModule("/src/components/TournamentRounds.vue"),
      vite.ssrLoadModule("/src/games/detail.ts"),
    ]);
    mods = { detail, renderer, editor, dialog, rounds, reporter };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function controller(over: Partial<TournamentDetailResponse> = {}) {
    const d = mods.detail.createTournamentDetail({ api: mockFetcher({ "/api/tournaments/t1": body(over) }) });
    await d.load("t1");
    return d;
  }
  async function render(component: unknown, props: Record<string, unknown>, d: unknown): Promise<string> {
    const app = createSSRApp({ render: () => h(component as never, props) });
    app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    return (await mods.renderer.renderToString(app)) as string;
  }

  it("Manage → Rounds lists recorded results per round with their source, the Edited chip and Edit result", async () => {
    const d = await controller();
    const html = await render(mods.editor.default, { canWrite: true }, d);
    expect(html).toContain(">Rounds</h2>");
    expect(html).toContain("Round 1");
    expect(html).toContain("1 - 1 (CAS 2 - 0)");
    expect(html).toContain(">Online game<");
    expect(html).toContain(">Entered by an organiser<");
    expect(html).toContain('title="Result edited by Piett on 2026-11-01, was 2 - 1, reason: Typo."');
    expect(html.match(/>Edit result</g)).toHaveLength(2); // m1 and m2; the unplayed m3 is not listed
    expect(html).not.toContain("Round 2");
    const readonly = await render(mods.editor.default, { canWrite: false }, d);
    expect(readonly).not.toContain(">Edit result<");
  });

  it("the dialog shows the fields, the previous values, the drawn-round note, and the finished confirm when finished", async () => {
    const d = await controller();
    const html = await render(mods.dialog.default, { fixture: FIXTURES[0] }, d);
    expect(html).toContain('role="dialog"');
    expect(html).toContain(">Edit result</h2>");
    expect(html).toContain("ROUND 1");
    expect(html).toContain("Reason (shown to both coaches)");
    expect(html).toContain("First reported");
    expect(html).toContain("2 - 1");
    expect(html).toContain("Online game (kept linked)");
    expect(html).toContain("Round 2 is already drawn; its pairings stay.");
    expect(html).not.toContain("This tournament is finished.");
    expect(html).toContain("Clear result...");
    const done = await controller({ tournament: tournament({ status: "completed" }) });
    expect(await render(mods.dialog.default, { fixture: FIXTURES[0] }, done)).toContain("This tournament is finished. Change it anyway");
  });

  it("the Rounds tab shows the Edited chip to everyone who sees the fixture, and the activity feed stamped admin", async () => {
    const d = await controller();
    const html = await render(mods.rounds.default, { data: d.state }, d);
    expect(html).toContain('class="sf-chip tn-edited"');
    expect(html).toContain(">Edited<");
    expect(html).toContain(">Result changes</h2>");
    expect(html).toContain(">Admin<");
    expect(html).toContain("Round 1: Ann Orcs v Bob Elves edited to 1 - 1 (was 2 - 1)");
    expect(html).toContain("Reason: Typo");
    const quiet = await controller({ activity: [], scheduledMatches: [FIXTURES[1]!] });
    const plain = await render(mods.rounds.default, { data: quiet.state }, quiet);
    expect(plain).not.toContain("Result changes");
    expect(plain).not.toContain(">Edited<");
  });
});
