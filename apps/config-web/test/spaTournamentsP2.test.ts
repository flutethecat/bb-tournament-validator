import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentEntrant, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  canGenerateRound, createTournamentDetail, fromLocalInput, nextFixtureFor, onlyMine, registrationOpen, remainingRounds,
  roundViews, rosterState, submitChoices, tabsFor, toLocalInput,
} from "../spa/src/tournaments/detail";
import { adminListPath, createAdminTournaments } from "../spa/src/tournaments/admin";
import { playerRows, sidelineLines } from "../spa/src/tournaments/team";
import type { SharedTeamView } from "../spa/src/shared/api";

// Phases 2 (player actions) and 3 (organiser core) of the SPA tournaments: controller unit tests with a mocked
// Fetcher, and the views server-rendered through the SPA's own Vite config (no port), as in spaTournaments.test.ts.

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
  id: "t1", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3,
  currentRound: 0, tiebreakers: ["buchholz"], startsAt: "2026-11-01T18:00:00.000Z", endsAt: "2026-11-02T18:00:00.000Z",
  entrantCount: 2, ownerCoachId: "Veers", organizerCoachIds: ["Piett"], pairingSystem: "dutch", seedingMode: "elo", remainingRounds: 3, ...over,
});

const FLAGS = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
const alice = (over: Partial<TournamentEntrant> = {}): TournamentEntrant => ({
  id: "t1:entrant:1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc",
  submission: { saveId: "save:s1", submittedAt: "2026-10-29T10:00:00Z", teamName: "Alice Orcs", valid: false, problemCount: 1, problems: ["Team costs 1,010k; the budget is 1,000k."] },
  flags: { ...FLAGS }, ...over,
});
const bob = (over: Partial<TournamentEntrant> = {}): TournamentEntrant => ({
  id: "t1:entrant:2", seed: 2, coachId: "Bob", teamId: "tm2", teamName: "Bob Elves", race: "Wood Elf",
  submission: { submittedAt: "2026-10-29T10:00:00Z", valid: true, problemCount: 0 }, ...over,
});

const detailBody = (over: Partial<TournamentDetailResponse> = {}): TournamentDetailResponse => ({
  tournament: tournament(), entrants: [alice(), bob()], rounds: [], scheduledMatches: [], capabilities: { manage: false, assignRoles: false }, ...over,
});

const sharedView = (): SharedTeamView => ({
  teamName: "Bob Elves", coach: "Bob", raceName: "Wood Elf", ruleset: { name: "nut-cup", tierLabel: null },
  players: [{
    number: 1, position: "Catcher", positionFull: "Wood Elf Catcher", isStar: false,
    stats: { MA: 8, ST: 2, AG: "2+", PA: "4+", AV: "9+" },
    printed: [{ name: "Catch", category: "Agility" }, { name: "Dodge", category: "Agility" }],
    added: [{ name: "Sure Hands", category: "General", access: "primary" }, { name: "Guard", category: "Strength", access: "secondary" }],
    statIncreases: ["MA", "AV"], cost: 90000,
  }],
  sideline: { reRolls: 2, apothecary: true, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 },
  inducements: [{ name: "Bribe", count: 1 }, { name: "Mascot", count: 0 }],
  specialRules: [], summary: { players: 1, total: 1000000, cap: 1000000, primarySkills: 1, secondarySkills: 1 },
  validity: { valid: true, issues: 0, custom: false, findings: [] },
});

const fixture = (id: string, round: number, home: string, away: string | null, status = "scheduled") => ({
  id, roundNumber: round, status,
  home: { entrantId: `t1:entrant:${home}`, teamId: `tm${home}`, coach: { ffbCoachId: home === "1" ? "Alice" : home === "2" ? "Bob" : `C${home}` } },
  ...(away ? { away: { entrantId: `t1:entrant:${away}`, teamId: `tm${away}`, coach: { ffbCoachId: away === "1" ? "Alice" : away === "2" ? "Bob" : `C${away}` } } } : {}),
});

describe("detail controller: player actions", () => {
  it("register, submit and withdraw call the routes, refetch, and show a confirmation", async () => {
    let body = detailBody({ tournament: tournament({ myEntrantId: "t1:entrant:1" }) });
    const f = mockFetcher({
      "GET /api/tournaments/t1": () => body,
      "POST /api/tournaments/t1/entrants": { entrant: {} },
      "POST /api/tournaments/t1/submissions": () => { body = detailBody({ tournament: tournament({ myEntrantId: "t1:entrant:1" }), entrants: [alice({ submission: { submittedAt: "x", valid: true, problemCount: 0, problems: [] }, flags: { ...FLAGS, rosterVerified: true } }), bob()] }); return { submission: {} }; },
      "DELETE /api/tournaments/t1/entrants/t1%3Aentrant%3A1": { entrant: {} },
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    await d.register("tm9");
    expect(f.calls.find((c) => c.method === "POST" && c.path.endsWith("/entrants"))?.body).toEqual({ teamId: "tm9", share: [] });
    expect(d.state.notice).toBe("You are registered.");
    await d.submit("save:s2");
    expect(f.calls.find((c) => c.path.endsWith("/submissions"))?.body).toEqual({ saveId: "save:s2" });
    expect(rosterState(d.state.entrants[0]!)).toBe("valid");
    await d.withdraw();
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(d.state.busy).toBe("");
  });

  it("a refused write shows the server's message and still refetches; 401 signs out", async () => {
    let signedOut = 0;
    const f = mockFetcher({
      "GET /api/tournaments/t1": detailBody(),
      "POST /api/tournaments/t1/submissions": new ApiError(409, "Rosters are locked; ask an organiser to unlock them before resubmitting."),
      "POST /api/tournaments/t1/entrants": new ApiError(401, "Authentication required."),
    });
    const d = createTournamentDetail({ api: f, onSignedOut: () => { signedOut++; } });
    await d.load("t1");
    const before = f.calls.filter((c) => c.path === "/api/tournaments/t1").length;
    await d.submit("save:s1");
    expect(d.state.actionError).toContain("Rosters are locked");
    expect(f.calls.filter((c) => c.path === "/api/tournaments/t1").length).toBe(before + 1);
    await d.register("tm1");
    expect(signedOut).toBe(1);
    expect(d.state.actionError).toBe("Signed out. Sign in and try again.");
  });

  it("team options: library + Team Builder saves; a failed read is an empty list", async () => {
    const f = mockFetcher({
      "/api/fork/library?coach=Alice": { teams: [{ teamId: "tm1", teamName: "Alice Orcs", race: "Orc", teamValue: 1000 }, { teamId: "tm7", teamName: "Spare", race: "Human", teamValue: 1100 }] },
      "/api/fork/team-builder/saves": { saves: [{ id: "s1", name: "Orc sheet", raceName: "Orc", packageName: "nut-cup", teamId: "tm1", updatedAt: "x" }] },
    });
    const d = createTournamentDetail({ api: f });
    await d.loadTeamOptions("Alice");
    expect(submitChoices(d.state.teamOptions)).toEqual([
      { ref: "save:s1", label: "Orc sheet (Orc)", group: "Team Builder saves" },
      { ref: "library:tm7", label: "Spare (Human)", group: "Library teams" },
    ]);
    const empty = createTournamentDetail({ api: mockFetcher({}) });
    await empty.loadTeamOptions("Alice");
    expect(empty.state.teamOptions).toEqual({ status: "ok", library: [], saves: [] });
  });
});

describe("detail controller: organiser actions", () => {
  it("start: a refusal marks the outcome and refetches; force starts", async () => {
    let status: TournamentSummary["status"] = "draft";
    const f = mockFetcher({
      "GET /api/tournaments/t1": () => detailBody({ tournament: tournament({ status, rostersLockedAt: "2026-10-29T12:00:00Z" }), capabilities: { manage: true, assignRoles: true } }),
      "POST /api/tournaments/t1/start": (b: unknown) => {
        if ((b as { force?: boolean }).force) { status = "active"; return { tournament: {} }; }
        return new ApiError(409, "1 roster is not valid. Fix them, verify them by hand, or start anyway.");
      },
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    expect(d.state.capabilities).toEqual({ manage: true, assignRoles: true });
    await d.start();
    expect(d.state.startOutcome).toBe("refused");
    expect(d.state.actionError).toContain("start anyway");
    expect(d.state.tournament?.rostersLockedAt).toBeTruthy();
    await d.start(true);
    expect(d.state.startOutcome).toBe("started");
    expect(d.state.tournament?.status).toBe("active");
  });

  it("preview keeps the server's pairings without a refetch; generate sends the choice and clears the preview", async () => {
    const f = mockFetcher({
      "GET /api/tournaments/t1": detailBody({ tournament: tournament({ status: "active" }) }),
      "POST /api/tournaments/t1/rounds": (b: unknown) => ((b as { preview?: boolean }).preview
        ? { preview: true, roundNumber: 1, pairings: [{ homeEntrantId: "t1:entrant:1", awayEntrantId: "t1:entrant:2" }], seeds: {}, pairingSystem: "monrad", seedingMode: "manual" }
        : { round: {} }),
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    await d.previewRound("monrad", "manual");
    expect(d.state.preview?.pairings).toHaveLength(1);
    expect(f.calls.at(-1)?.body).toEqual({ preview: true, pairingSystem: "monrad", seedingMode: "manual" });
    expect(await d.generateRound("monrad", "manual")).toBe(true);
    expect(f.calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({ pairingSystem: "monrad", seedingMode: "manual" });
    expect(d.state.preview).toBeNull();
  });

  it("settings, roles, lock and participant edits hit their routes", async () => {
    const f = mockFetcher({
      "GET /api/tournaments/t1": detailBody(),
      "PATCH /api/tournaments/t1": {},
      "POST /api/tournaments/t1/owner": {},
      "POST /api/tournaments/t1/organizers/Mr%20Piett": {},
      "DELETE /api/tournaments/t1/organizers/Piett": {},
      "POST /api/tournaments/t1/lock-rosters": {},
      "POST /api/tournaments/t1/unlock-rosters": {},
      "PATCH /api/tournaments/t1/entrants/t1%3Aentrant%3A2": {},
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    await d.saveSettings({ endsAt: "2026-11-03T00:00:00.000Z", pairingSystem: "monrad" });
    await d.setOwner("Bob");
    await d.addOrganizer("Mr Piett");
    await d.removeOrganizer("Piett");
    await d.lockRosters();
    await d.unlockRosters();
    await d.patchEntrant("t1:entrant:2", { flags: { paid: true }, manualSeed: 3 });
    const writes = f.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      "PATCH /api/tournaments/t1", "POST /api/tournaments/t1/owner", "POST /api/tournaments/t1/organizers/Mr%20Piett",
      "DELETE /api/tournaments/t1/organizers/Piett", "POST /api/tournaments/t1/lock-rosters", "POST /api/tournaments/t1/unlock-rosters",
      "PATCH /api/tournaments/t1/entrants/t1%3Aentrant%3A2",
    ]);
    expect(f.calls.find((c) => c.path.endsWith("entrant%3A2"))?.body).toEqual({ flags: { paid: true }, manualSeed: 3 });
  });
});

describe("display helpers", () => {
  it("roster state, registration window, remaining rounds, next fixture, mine filter, generate gate, tabs", () => {
    expect(rosterState(alice())).toBe("invalid");
    expect(rosterState(alice({ flags: { ...FLAGS, rosterVerified: true } }))).toBe("valid");
    expect(rosterState(bob())).toBe("valid");
    expect(rosterState(bob({ submission: undefined }))).toBe("none");
    expect(registrationOpen(tournament(), [])).toBe(true);
    expect(registrationOpen(tournament({ rostersLockedAt: "x" }), [])).toBe(false);
    expect(registrationOpen(tournament({ status: "active" }), [{ id: "r1", number: 1, status: "active", scheduledMatchIds: [] }])).toBe(false);
    expect(remainingRounds(tournament({ remainingRounds: undefined, currentRound: 1 }))).toBe(2);
    expect(remainingRounds(tournament({ remainingRounds: undefined, status: "completed" }))).toBe(0);
    const fixtures = [fixture("m1", 1, "1", "2", "completed"), fixture("m2", 2, "2", "1"), fixture("m3", 2, "3", null)];
    const s = { fixtures: fixtures as never, entrants: [alice(), bob()] };
    expect(nextFixtureFor("t1:entrant:1", s)).toMatchObject({ round: 2, opponentEntrantId: "t1:entrant:2", opponentTeam: "Bob Elves", opponentCoach: "Bob" });
    expect(nextFixtureFor("t1:entrant:3", s)).toMatchObject({ opponentEntrantId: null, opponentTeam: "Bye" });
    const rounds = roundViews({ rounds: [], fixtures: fixtures as never, entrants: [alice(), bob()] });
    expect(onlyMine(rounds, fixtures as never, "t1:entrant:1").flatMap((r) => r.fixtures.map((f) => f.id))).toEqual(["m1", "m2"]);
    const r = (n: number, status: "active" | "completed") => ({ id: `r${n}`, number: n, status, scheduledMatchIds: [] });
    expect(canGenerateRound(tournament({ status: "active" }), [])).toBe(true);
    expect(canGenerateRound(tournament({ status: "active" }), [r(1, "active")])).toBe(false);
    expect(canGenerateRound(tournament({ status: "active", roundCount: 1 }), [r(1, "completed")])).toBe(false);
    expect(canGenerateRound(tournament({ status: "draft" }), [])).toBe(false);
    expect(tabsFor(false).map((t) => t.id)).not.toContain("manage");
    expect(tabsFor(true).map((t) => t.id)).toContain("manage");
  });

  it("datetime-local round trip is UTC; empty clears", () => {
    expect(toLocalInput("2026-11-01T18:30:00.000Z")).toBe("2026-11-01T18:30");
    expect(fromLocalInput("2026-11-01T18:30")).toBe("2026-11-01T18:30:00.000Z");
    expect(fromLocalInput("")).toBe("");
    expect(toLocalInput(undefined)).toBe("");
  });

  it("opponent view rows come from the shared Team Builder view model, stat upgrades included", () => {
    expect(playerRows(sharedView())).toEqual([
      { key: "0", number: 1, position: "Catcher", positionFull: "Wood Elf Catcher", stats: "8 / 2 / 2+ / 4+ / 9+", upgrades: "+MA, +AV", skills: "Catch, Dodge", added: "Sure Hands, Guard (S)" },
    ]);
    expect(sidelineLines(sharedView())).toEqual(["Rerolls 2", "Apothecary", "Dedicated fans 1", "Bribe x1"]);
    expect(playerRows(undefined)).toEqual([]);
  });

  it("admin list path asks for every state", async () => {
    expect(adminListPath("", 1)).toBe("/api/fork/tournaments?status=all");
    expect(adminListPath(" spike ", 2)).toBe("/api/fork/tournaments?status=all&q=spike&page=2");
    const f = mockFetcher({
      "GET /api/fork/tournaments?status=all": { tournaments: [tournament()], page: 1, pageSize: 20, total: 1, hasMore: false },
      "POST /api/tournaments/t1/owner": new ApiError(400, "\"Ghost\" is not a registered coach."),
    });
    const a = createAdminTournaments({ api: f });
    await a.load();
    expect(a.state.items).toHaveLength(1);
    expect(await a.setOwner("t1", "Ghost")).toBe(false);
    expect(a.state.rowError.t1).toBe("\"Ghost\" is not a registered coach.");
  });
});

describe("phase 2/3 views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, detail, team, admin, vueRouter, renderer, startModal] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("/src/tournaments/team.ts"),
      vite.ssrLoadModule("/src/tournaments/admin.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/TournamentStartModal.vue"),
    ]);
    mods = { app, detail, team, admin, vueRouter, renderer, startModal };
  }, 60_000);

  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const AS = (coach: string, extra: Record<string, unknown> = {}) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", ...extra } });

  async function render(path: string, routes: Routes, prep?: (inject: (key: symbol, v: unknown) => void, f: Fetcher) => Promise<void>) {
    const f = mockFetcher({ ...ANON, ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: (await mods.renderer.renderToString(spa.app)) as string, spa, f };
  }

  const loaded = (id: string, coach?: string, tab?: "standings") => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
    const d = mods.detail.createTournamentDetail({ api: f });
    await d.load(id);
    if (coach) await d.loadTeamOptions(coach);
    if (tab) await d.ensureTab(tab);
    inject(mods.detail.TOURNAMENT_DETAIL_KEY, d);
  };

  const OPTIONS = {
    "/api/fork/library?coach=Alice": { teams: [{ teamId: "tm1", teamName: "Alice Orcs", race: "Orc", teamValue: 1000 }, { teamId: "tm7", teamName: "Spare Humans", race: "Human", teamValue: 1100 }] },
    "/api/fork/team-builder/saves": { saves: [{ id: "s1", name: "Orc sheet", raceName: "Orc", packageName: "nut-cup", teamId: "tm1", updatedAt: "x" }] },
  };

  it("anonymous overview: no My entry card, no Manage tab, end date and rounds left shown", async () => {
    const { html } = await render("/tournaments/t1", { "/api/tournaments/t1": detailBody() }, loaded("t1"));
    expect(html).not.toContain("My entry");
    expect(html).not.toContain(">Manage</a>");
    expect(html).toContain("2026-11-02");
    expect(html).toContain("Rounds left");
    expect(html).toContain("Veers, Piett");
  });

  it("signed-in coach not entered: Register with a library team picker", async () => {
    const body = detailBody({ entrants: [bob()] });
    const { html } = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body, ...OPTIONS }, loaded("t1", "Alice"));
    expect(html).toContain("My entry");
    expect(html).toContain("You are not entered yet.");
    expect(html).toContain(">Register</button>");
    expect(html).toContain("Spare Humans (Human");
    expect(html).not.toContain("Submit team");
    // Share picker (owner 10-31): three boxes, none ticked; no NAF block on a tournament that is not NAF sanctioned.
    expect(html).toContain("Share with the organiser");
    for (const label of ["Preferred name", "Email", "Phone"]) expect(html).toContain(`<span>${label}`);
    expect(html).not.toContain("NAF number (required");
  });

  it("NAF pending entry: the coach answers before submitting (Submit team disabled)", async () => {
    const body = detailBody({ tournament: tournament({ nafSanctioned: true, myEntrantId: "t1:entrant:1" }), entrants: [alice({ nafPending: true }), bob()] });
    const { html } = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body, ...OPTIONS }, loaded("t1", "Alice"));
    expect(html).toContain("Give your NAF number, or say you are not a NAF member, before you submit a roster.");
    expect(html).toContain(">Save NAF answer</button>");
    expect(html).toMatch(/<button class="lobby-btn primary" type="submit" disabled[^>]*>Submit team<\/button>/);
  });

  it("NAF-sanctioned tournament: the chip, the required NAF number and the 'I am not a NAF member' box", async () => {
    const body = detailBody({ tournament: tournament({ nafSanctioned: true }), entrants: [bob()] });
    const { html } = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body, ...OPTIONS }, loaded("t1", "Alice"));
    expect(html).toContain('data-naf="sanctioned">NAF sanctioned</span>');
    expect(html).toContain("NAF number (required — this tournament is NAF sanctioned)");
    expect(html).toContain("Not optional: your NAF number is shared with the organisers as part of your entry.");
    expect(html).toContain("I am not a NAF member");
  });

  it("entrant: invalid chip with problems, Submit team from saves and library, Withdraw; opponent link on the next fixture", async () => {
    const body = detailBody({
      tournament: tournament({ status: "active", currentRound: 1, myEntrantId: "t1:entrant:1" }),
      rounds: [{ id: "r1", number: 1, status: "active", scheduledMatchIds: ["m1"] }],
      scheduledMatches: [fixture("m1", 1, "1", "2")] as never,
    });
    const { html } = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body, ...OPTIONS }, loaded("t1", "Alice"));
    expect(html).toContain('data-roster="invalid"');
    expect(html).toContain(">Invalid<");
    expect(html).toContain("Team costs 1,010k; the budget is 1,000k.");
    expect(html).toContain('label="Team Builder saves"');
    expect(html).toContain('label="Library teams"');
    expect(html).toContain("Orc sheet (Orc)");
    expect(html).toContain(">Submit team</button>");
    expect(html).toContain(">Withdraw</button>");
    expect(html).toContain("vs Bob Elves");
    expect(html).toMatch(/href="\/app\/tournaments\/t1\/team\/t1(:|%3A)entrant(:|%3A)2"/);
    expect(html).toContain("Opponent&#39;s team");
  });

  it("locked rosters: the submit control is disabled with the reason", async () => {
    const body = detailBody({ tournament: tournament({ myEntrantId: "t1:entrant:1", rostersLockedAt: "2026-10-29T12:00:00Z" }), entrants: [alice({ flags: { ...FLAGS, frozen: true } }), bob()] });
    const { html } = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body, ...OPTIONS }, loaded("t1", "Alice"));
    expect(html).toContain("Rosters are locked.");
    expect(html).toMatch(/<select id="tn-submit-team"[^>]*disabled/);
  });

  it("rounds: an entrant gets All / My fixtures and their fixture is highlighted", async () => {
    const body = detailBody({
      tournament: tournament({ status: "active", currentRound: 1, myEntrantId: "t1:entrant:1", remainingRounds: 2 }),
      rounds: [{ id: "r1", number: 1, status: "active", scheduledMatchIds: [] }],
      scheduledMatches: [fixture("m1", 1, "1", "2"), fixture("m2", 1, "3", "4")] as never,
    });
    const { html } = await render("/tournaments/t1?tab=rounds", { ...AS("Alice"), "/api/tournaments/t1": body }, loaded("t1"));
    expect(html).toContain(">All fixtures</button>");
    expect(html).toContain(">My fixtures</button>");
    expect(html.match(/tn-mine/g)).toHaveLength(1);
    expect(html).toContain("2 rounds left");
  });

  it("manage tab: only with the manage capability; Summary, Start Tournament, Settings, roles and the Participants table", async () => {
    const plain = await render("/tournaments/t1?tab=manage", { ...AS("Alice"), "/api/tournaments/t1": detailBody() }, loaded("t1"));
    expect(plain.html).not.toContain("Start Tournament");
    expect(plain.html).toContain("Format");
    const body = detailBody({ capabilities: { manage: true, assignRoles: true }, entrants: [alice({ manualSeed: 4, flags: { ...FLAGS, paid: true } }), bob({ flags: { ...FLAGS, rosterVerified: true } })] });
    const { html } = await render("/tournaments/t1?tab=manage", { ...AS("Veers"), "/api/tournaments/t1": body }, loaded("t1"));
    expect(html).toContain(">Manage</a>");
    expect(html).toContain(">Summary<");
    expect(html).toContain(">Start Tournament</button>");
    expect(html).toContain(">Lock rosters</button>");
    expect(html).toContain(">Settings<");
    expect(html).toContain("Pairing system");
    expect(html).toContain("Dutch");
    expect(html).toContain("Monrad");
    expect(html).toContain("Elo-seeded");
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Add organiser");
    expect(html).toContain(">Set owner</button>");
    expect(html).toContain(">Participants<");
    for (const h of ["Seed", "Roster", "Paid", "Verified", "Frozen", "Checked in", "Active", "Next fixture"]) expect(html).toContain(`<th>${h}</th>`);
    expect(html).toContain('value="4"');
    expect(html).toContain(">Not checked in</button>");
    expect(html).not.toContain("Generate round");
  });

  it("manage tab once started: Edit Tournament and Generate round; an organiser sees roles read-only", async () => {
    const body = detailBody({
      tournament: tournament({ status: "active", startedAt: "2026-10-29T12:00:00Z", rostersLockedAt: "2026-10-29T12:00:00Z" }),
      capabilities: { manage: true, assignRoles: false },
    });
    const { html } = await render("/tournaments/t1?tab=manage", { ...AS("Piett"), "/api/tournaments/t1": body }, loaded("t1"));
    expect(html).toContain(">Edit Tournament</button>");
    expect(html).toContain(">Edit Tournament<");
    expect(html).toContain(">Generate round 1</button>");
    expect(html).toContain(">Finish tournament</button>");
    expect(html).toContain("Only the owner or an admin can change the roles.");
    expect(html).not.toContain(">Set owner</button>");
  });

  async function modal(body: TournamentDetailResponse, prep?: (d: ReturnType<typeof createTournamentDetail>) => void | Promise<void>) {
    const f = mockFetcher({ "/api/tournaments/t1": body });
    const d = mods.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    await prep?.(d);
    const app = createSSRApp(mods.startModal.default);
    app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    return (await mods.renderer.renderToString(app)) as string;
  }

  it("Start Tournament modal: the validation table, Verify by hand once locked, Start anyway after a refusal", async () => {
    const html = await modal(detailBody({ tournament: tournament({ rostersLockedAt: "2026-10-29T12:00:00Z" }), capabilities: { manage: true, assignRoles: true } }), (d) => {
      d.state.startOutcome = "refused";
      d.state.actionError = "1 roster is not valid. Fix them, verify them by hand, or start anyway.";
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Start Tournament");
    expect(html).toContain("Lock rosters and check them");
    expect(html).toContain("Alice Orcs");
    expect(html).toContain("Team costs 1,010k");
    expect(html).toContain(">Verify by hand</button>");
    expect(html).toContain(">Start tournament</button>");
    expect(html).toContain("Start anyway (1 invalid)");
    expect(html).toContain("1 roster is not valid.");
  });

  it("Generate fixtures step: system + seeding choice and the preview rows", async () => {
    const html = await modal(detailBody({ tournament: tournament({ status: "active", startedAt: "x" }), capabilities: { manage: true, assignRoles: true } }), (d) => {
      d.state.preview = { roundNumber: 1, pairings: [{ homeEntrantId: "t1:entrant:1", awayEntrantId: "t1:entrant:2" }], seeds: {}, pairingSystem: "dutch", seedingMode: "elo" };
    });
    expect(html).toContain("Generate fixtures · Round 1");
    expect(html).toContain("Pairing system");
    expect(html).toContain("By rating (Elo)");
    expect(html).toContain("Manual seeds");
    expect(html).toContain(">Preview round 1</button>");
    expect(html).toContain(">Generate round 1</button>");
    expect(html).toMatch(/Alice Orcs[\s\S]*vs[\s\S]*Bob Elves/);
  });

  it("opponent's team view: the submitted picks and sideline; a 403 shows the server's message; sign-in gate", async () => {
    const build = { tournamentId: "t1", entrantId: "t1:entrant:2", coachId: "Bob", team: { teamName: "Bob Elves", race: "Wood Elf", teamValue: 1050 },
      submission: { submittedAt: "x", teamName: "Bob Elves", race: "Wood Elf", valid: true, view: sharedView() } };
    const path = "/api/tournaments/t1/entrants/t1%3Aentrant%3A2/build";
    const prep = async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
      const t = mods.team.createTournamentTeam({ api: f });
      await t.load("t1", "t1:entrant:2");
      inject(mods.team.TOURNAMENT_TEAM_KEY, t);
    };
    const ok = await render("/tournaments/t1/team/t1:entrant:2", { ...AS("Alice"), [path]: build }, prep);
    expect(ok.spa.router.currentRoute.value.name).toBe("tournament-team");
    expect(ok.html).toContain("Bob Elves");
    expect(ok.html).toContain("Wood Elf Catcher");
    expect(ok.html).toContain("Catch, Dodge");
    expect(ok.html).toContain("Sure Hands, Guard (S)");
    expect(ok.html).toContain("+MA, +AV");
    expect(ok.html).toContain("8 / 2 / 2+ / 4+ / 9+");
    expect(ok.html).toContain("Rerolls 2");
    expect(ok.html).not.toContain("Roster problems");
    expect(ok.html).toContain(">Valid<");
    const denied = await render("/tournaments/t1/team/t1:entrant:2", { ...AS("Cy"), [path]: new ApiError(403, "You may fetch only your own tournament build or your current opponent's.") }, prep);
    expect(denied.html).toContain("current opponent");
    const anon = await render("/tournaments/t1/team/t1:entrant:2", {});
    expect(anon.html).toContain("Login with Discord");
  });

  it("admin tournaments page: admins get the list with owner, organisers and the role forms; others are told it is admin-only", async () => {
    const list = { tournaments: [tournament(), tournament({ id: "t2", name: "Old Cup", status: "completed", ownerCoachId: undefined, organizerCoachIds: [] })], page: 1, pageSize: 20, total: 2, hasMore: false };
    const prep = async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
      const a = mods.admin.createAdminTournaments({ api: f });
      await a.load();
      inject(mods.admin.ADMIN_TOURNAMENTS_KEY, a);
    };
    const admin = await render("/admin/tournaments", { ...AS("Root", { admin: true }), "/api/fork/tournaments?status=all": list }, prep);
    expect(admin.html).toContain("Tournaments admin");
    expect(admin.html).toContain("Spike Open");
    expect(admin.html).toContain("Old Cup");
    expect(admin.html).toContain("None (admins only)");
    expect(admin.html).toContain("Remove organiser Piett");
    expect(admin.html).toContain(">Set owner</button>");
    expect(admin.html).toContain(">Add organiser</button>");
    expect(admin.html).toContain('href="/app/tournaments/t1?tab=manage"');
    const plain = await render("/admin/tournaments", { ...AS("Alice"), "/api/fork/tournaments?status=all": list }, prep);
    expect(plain.html).toContain("Admins only.");
    expect(plain.html).not.toContain("Spike Open");
  });

  it("test sign-in sessions see no write controls (entry, manage, admin)", async () => {
    const TEST = (coach: string, extra: Record<string, unknown> = {}) => AS(coach, { test: true, ...extra });
    const entry = await render("/tournaments/t1", {
      ...TEST("Alice"), "/api/tournaments/t1": detailBody({ tournament: tournament({ myEntrantId: "t1:entrant:1" }) }), ...OPTIONS,
    }, loaded("t1", "Alice"));
    expect(entry.html).toContain("My entry");
    expect(entry.html).toContain("Test sign-in sessions can look but cannot change tournament data.");
    expect(entry.html).not.toContain(">Submit team</button>");
    expect(entry.html).not.toContain(">Withdraw</button>");
    const reg = await render("/tournaments/t1", { ...TEST("Alice"), "/api/tournaments/t1": detailBody({ entrants: [bob()] }), ...OPTIONS }, loaded("t1", "Alice"));
    expect(reg.html).not.toContain(">Register</button>");
    const manage = await render("/tournaments/t1?tab=manage", {
      ...TEST("Veers"), "/api/tournaments/t1": detailBody({ capabilities: { manage: true, assignRoles: true } }),
    }, loaded("t1"));
    expect(manage.html).toContain(">Summary<");
    for (const control of [">Start Tournament</button>", ">Lock rosters</button>", ">Save settings</button>", ">Set owner</button>", 'type="checkbox"', "tn-seed-input"]) {
      expect(manage.html, control).not.toContain(control);
    }
    const list = { tournaments: [tournament()], page: 1, pageSize: 20, total: 1, hasMore: false };
    const admin = await render("/admin/tournaments", { ...TEST("Root", { admin: true }), "/api/fork/tournaments?status=all": list }, async (inject, f) => {
      const a = mods.admin.createAdminTournaments({ api: f });
      await a.load();
      inject(mods.admin.ADMIN_TOURNAMENTS_KEY, a);
    });
    expect(admin.html).toContain("Spike Open");
    expect(admin.html).not.toContain(">Set owner</button>");
    expect(admin.html).not.toContain("Remove organiser Piett");
  });

  it("copy and layout rules: no hyphenated reroll, a phone breakpoint for the new panels", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tournaments/tournaments.css", import.meta.url)), "utf8");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.tn-form-grid \{ grid-template-columns: 1fr; \}/);
    expect(css).toContain(".tn-modal");
    expect(css).not.toMatch(/#000|#fff\b/i);
    for (const file of ["TournamentMyEntry", "TournamentManage", "TournamentStartModal", "TournamentParticipants", "TournamentSettingsForm"]) {
      const src = readFileSync(fileURLToPath(new URL(`../spa/src/components/${file}.vue`, import.meta.url)), "utf8");
      expect(src, file).not.toMatch(/re-roll/i);
      expect(src, file).not.toMatch(/Java client|FUMBBL art/i);
    }
  });
});
