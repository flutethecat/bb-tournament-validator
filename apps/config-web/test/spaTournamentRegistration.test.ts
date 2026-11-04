import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentEntrant, type TournamentRegistrationsResponse, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentDetail } from "../spa/src/tournaments/detail";
import {
  changedSettings, checkInDue, coachSaysPaidLine, expectedOutcome, noRosterLate, placesLine, registerBody, registerChoices,
  registrationsCaption, rosterDueLine, stateChip,
} from "../spa/src/tournaments/registration";

// Lane L4 in the SPA: the register sheet's helpers and controller calls, and the views server-rendered against a mocked
// API (the SPA's own Vite config, no port): My entry states, the Check in bar, the Pay block's reference code and
// "I've paid", the organisers' Registrations panel and no-show list, and the Participants one-click check-in.

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

const FLAGS = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
const tournament = (over: Partial<TournamentSummary> = {}): TournamentSummary => ({
  id: "t1", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 4, roundCount: 3,
  currentRound: 0, tiebreakers: ["buchholz"], startsAt: "2026-12-05T09:00:00.000Z", entrantCount: 1, ownerCoachId: "Veers", organizerCoachIds: ["Piett"],
  remainingRounds: 3, entryFee: "15 GBP", paymentLinks: { payPal: "https://paypal.me/ExampleOrg" },
  registration: { approval: "organiser", waitlist: true, rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z", checkIn: { self: true } }, ...over,
});
const entrant = (over: Partial<TournamentEntrant> = {}): TournamentEntrant => ({
  id: "t1:entrant:1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc", flags: { ...FLAGS }, refCode: "SF-7Q2K", ...over,
});
const STATUS = { open: true, approval: "organiser" as const, waitlist: true, rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z", cap: 4, placesLeft: 3 };
const body = (over: Partial<TournamentDetailResponse> = {}): TournamentDetailResponse => ({
  tournament: tournament(), entrants: [entrant()], rounds: [], scheduledMatches: [], capabilities: { manage: false, assignRoles: false },
  registrationStatus: STATUS, ...over,
});
const PANEL: TournamentRegistrationsResponse = {
  counts: { accepted: 1, pending: 1, waitlisted: 2, cap: 4, placesLeft: 3 },
  settings: { approval: "organiser", waitlist: true, rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z", selfCheckIn: true },
  entries: [
    { id: "t1:entrant:2", coachId: "Bob", state: "pending", enteredAt: "2026-11-10T12:00:00.000Z", teamId: "", shared: { coach: "Bob", email: "bob@example.test" }, refCode: "SF-AAAA", flags: { ...FLAGS } },
    { id: "t1:entrant:3", coachId: "Carol", state: "waitlisted", position: 1, nextInLine: true, enteredAt: "2026-11-10T12:01:00.000Z", teamName: "Carol Elves" },
    { id: "t1:entrant:4", coachId: "Dee", state: "waitlisted", position: 2, enteredAt: "2026-11-10T12:02:00.000Z", teamName: "Dee Dwarfs" },
    { id: "t1:entrant:5", coachId: "Eve", state: "declined", enteredAt: "2026-11-10T12:03:00.000Z", decided: { by: "Veers", at: "2026-11-11T10:00:00.000Z", reason: "Duplicate" } },
  ],
  checkIn: { opensAt: "2026-12-04T09:00:00.000Z", closesAt: "2026-12-05T09:00:00.000Z", self: true, open: false, closed: true, checkedIn: 1, total: 2 },
  noShows: [{ id: "t1:entrant:1", coachId: "Alice", teamName: "Alice Orcs" }],
};

describe("registration helpers (pure)", () => {
  it("team choices: saved teams for this ruleset, then Roster later when allowed (never a library team)", () => {
    const saves = [
      { id: "s1", name: "Orc sheet", raceName: "Orc", packageName: "nut-cup", teamId: null, updatedAt: "x" },
      { id: "s2", name: "Other sheet", raceName: "Elf", packageName: "other", teamId: null, updatedAt: "x" },
    ];
    expect(registerChoices(saves, "nut-cup", { rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z" }).map((c) => c.ref)).toEqual(["save:s1", "later"]);
    expect(registerChoices(saves, "nut-cup", { rosterLater: false }).map((c) => c.ref)).toEqual(["save:s1"]);
    expect(registerChoices(saves, "nut-cup", { rosterLater: false })[0]).toMatchObject({ kind: "save", sub: "Orc · Saved team" });
    expect(registerBody({ teamRef: "later", region: "North", share: ["email"], notNafMember: false }, true)).toEqual({ rosterLater: true, share: ["email"], region: "North" });
    expect(registerBody({ teamRef: "save:s1", region: "North", share: [], notNafMember: true }, false)).toEqual({ teamRef: "save:s1", share: [], notNafMember: true });
  });

  it("owner 11-03: a save linked to a fork team is offered as a saved team only; no library: ref is ever a choice", () => {
    const saves = [
      { id: "s1", name: "Orc sheet", raceName: "Orc", packageName: "nut-cup", teamId: "tm1", updatedAt: "x" },
      { id: "s2", name: "Elf sheet", raceName: "Elf", packageName: "other-cup", teamId: "tm2", updatedAt: "x" },
    ];
    const refs = registerChoices(saves, "nut-cup", { rosterLater: true }).map((c) => c.ref);
    expect(refs).toEqual(["save:s1", "later"]);
    expect(refs.some((r) => r.startsWith("library:"))).toBe(false);
  });

  it("state, places, outcome, check-in and roster words", () => {
    expect(stateChip({ state: "waitlisted", position: 2 })).toBe("Waitlist #2");
    expect(stateChip({ state: "pending" })).toBe("Pending");
    expect(placesLine({ ...STATUS, placesLeft: 0 })).toBe("Full: new entries join the waitlist");
    expect(placesLine({ ...STATUS, cap: null, placesLeft: null })).toBe("No place limit");
    expect(expectedOutcome({ ...STATUS, approval: "auto", placesLeft: 0, waitlist: false })).toBe("full");
    expect(expectedOutcome(STATUS)).toBe("pending");
    const ci = { opensAt: "a", closesAt: "2026-12-05T09:00:00.000Z", self: true, open: true, closed: false };
    expect(checkInDue(ci, { flags: FLAGS }, true)).toBe(true);
    expect(checkInDue(ci, { flags: { ...FLAGS, checkedIn: true } }, true)).toBe(false);
    expect(checkInDue({ ...ci, self: false }, { flags: FLAGS }, true)).toBe(false);
    const t = { registration: { rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z" } };
    expect(rosterDueLine(t, { teamId: "" }, Date.parse("2026-11-20T00:00:00Z"))).toBe("Roster due by 01 Dec 2026, 18:00 UTC");
    expect(noRosterLate(t, { teamId: "" }, Date.parse("2026-12-02T00:00:00Z"))).toBe(true);
    expect(noRosterLate(t, { teamId: "tm1" }, Date.parse("2026-12-02T00:00:00Z"))).toBe(false);
    expect(coachSaysPaidLine({ coachSaysPaid: { at: "2026-11-10T12:00:00.000Z" }, flags: FLAGS })).toBe("Coach says paid 10 Nov 2026, 12:00 UTC");
    expect(coachSaysPaidLine({ coachSaysPaid: { at: "x" }, flags: { ...FLAGS, paid: true } })).toBe("");
    expect(registrationsCaption({ accepted: 3, pending: 1, waitlisted: 0, cap: 8 })).toBe("3 / 8 places · 1 pending");
  });

  it("settings changes keep the rest (the server replaces the object as a whole); a legacy tournament starts from today's rules", () => {
    expect(changedSettings({}, { approval: "organiser" })).toEqual({ approval: "organiser", waitlist: false, rosterLater: false, checkIn: { self: false } });
    expect(changedSettings({ registration: tournament().registration }, { selfCheckIn: false })).toEqual({ approval: "organiser", waitlist: true, rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z", checkIn: { self: false } });
  });
});

describe("registration controller", () => {
  it("register, withdraw a held entry, check in, I've paid, decide, and the panel only for managers", async () => {
    const f = mockFetcher({
      "GET /api/tournaments/t1": () => body({ capabilities: { manage: true, assignRoles: false } }),
      "POST /api/tournaments/t1/entrants": { registration: { state: "waitlisted", position: 3 } },
      "DELETE /api/tournaments/t1/entrants/t1%3Aentrant%3A2": { entrant: {} },
      "POST /api/tournaments/t1/check-in": { entrant: {} },
      "POST /api/tournaments/t1/entrants/t1%3Aentrant%3A1/paid-claim": { entrant: {} },
      "POST /api/tournaments/t1/registrations/t1%3Aentrant%3A2/decline": { entry: {} },
      "GET /api/tournaments/t1/registrations": PANEL,
    });
    const d = createTournamentDetail({ api: f });
    await d.load("t1");
    expect(d.state.registrationStatus).toEqual(STATUS);
    expect(await d.registerEntry({ rosterLater: true, share: [] })).toBe(true);
    expect(d.state.notice).toBe("It's full, so you're on the waitlist (#3).");
    await d.withdrawEntry("t1:entrant:2");
    await d.checkIn();
    expect(d.state.notice).toBe("You are checked in.");
    await d.claimPaid("t1:entrant:1", true);
    expect(f.calls.find((c) => c.path.endsWith("/paid-claim"))?.body).toEqual({ paid: true });
    await d.loadRegistrations();
    expect(d.state.registrations.status).toBe("ok");
    await d.decide("t1:entrant:2", "decline", { reason: " Duplicate " });
    expect(f.calls.find((c) => c.path.endsWith("/decline"))?.body).toEqual({ reason: "Duplicate" });
    expect(d.state.notice).toBe("Entry declined.");
    // not a manager: the panel is never asked for
    const g = mockFetcher({ "GET /api/tournaments/t1": () => body() });
    const e = createTournamentDetail({ api: g });
    await e.load("t1");
    await e.loadRegistrations();
    expect(g.calls.some((c) => c.path.endsWith("/registrations"))).toBe(false);
  });
});

describe("registration views (server-rendered)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, detail, vueRouter, renderer, vue, dialog, session] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/tournaments/detail.ts"), vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"), import("vue"), vite.ssrLoadModule("/src/components/TournamentRegisterDialog.vue"),
      vite.ssrLoadModule("/src/session.ts"),
    ]);
    mods = { app, detail, vueRouter, renderer, vue, dialog, session };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const AS = (coach: string) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord" } });
  async function render(path: string, routes: Routes, manage = false) {
    const f = mockFetcher(routes);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    if (manage) await d.loadRegistrations();
    spa.app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("a pending coach: My entry and the front block say Pending, roster due, withdraw; no Register", async () => {
    const mine = { ...entrant({ id: "t1:entrant:2", coachId: "Bob", teamId: "", teamName: undefined }), state: "pending" as const };
    const html = await render("/tournaments/t1", { ...AS("Bob"), "/api/tournaments/t1": body({ myRegistration: mine }) });
    expect(html).toContain('data-entry-state="pending"');
    expect(html).toContain("Your entry is waiting for the organisers.");
    expect(html).toContain("Roster due by 01 Dec 2026, 18:00 UTC");
    expect(html).toContain(">Withdraw</button>");
    expect(html).not.toMatch(/data-register[^>]*>Register<\/button>/);
    // the Pay block carries the coach's own reference and "I've paid"
    expect(html).toContain('data-ref-code="true"');
    expect(html).toContain("SF-7Q2K");
    expect(html).toContain("I&#39;ve paid");
  });

  it("a declined coach sees the reason; a withdrawn one may register again", async () => {
    const declined = await render("/tournaments/t1", { ...AS("Eve"), "/api/tournaments/t1": body({ myRegistration: { ...entrant({ coachId: "Eve" }), state: "declined", reason: "Duplicate" } }) });
    expect(declined).toContain("The organisers declined your entry: Duplicate");
    expect(declined).not.toContain("I&#39;ve paid");
    const withdrawn = await render("/tournaments/t1", { ...AS("Eve"), "/api/tournaments/t1": body({ myRegistration: { ...entrant({ coachId: "Eve" }), state: "withdrawn" } }) });
    expect(withdrawn).toMatch(/data-register[^>]*>Register again<\/button>/);
  });

  it("the Check in bar shows for a coach in the field while self check-in is open", async () => {
    const ci = { opensAt: "2026-12-04T09:00:00.000Z", closesAt: "2026-12-05T09:00:00.000Z", self: true, open: true, closed: false };
    const t = tournament({ myEntrantId: "t1:entrant:1" });
    const html = await render("/tournaments/t1?tab=standings", { ...AS("Alice"), "/api/tournaments/t1": body({ tournament: t, checkIn: ci, myRegistration: { ...entrant(), state: "accepted" } }), "/api/tournaments/t1/standings": { standings: [] } });
    expect(html).toContain("data-check-in-bar");
    expect(html).toContain("data-check-in>Check in</button>");
    expect(html).toContain("Check-in closes 05 Dec 2026, 09:00 UTC");
    const anon = await render("/tournaments/t1", { "/api/auth/session": { authenticated: false }, "/api/tournaments/t1": body({ checkIn: ci }) });
    expect(anon).not.toContain("data-check-in-bar");
  });

  it("Manage: the Registrations panel (pending, waitlist with next in line, decided folded, no-shows with Remove and promote)", async () => {
    const html = await render("/tournaments/t1/manage", {
      ...AS("Veers"), "/api/tournaments/t1": body({ capabilities: { manage: true, assignRoles: true } }), "/api/tournaments/t1/registrations": PANEL,
    }, true);
    expect(html).toContain("data-registrations-panel");
    expect(html).toContain("1 / 4 places · 1 pending · 2 waiting");
    expect(html).toContain(">Accept</button>");
    expect(html).toContain(">Waitlist</button>");
    expect(html).toContain("bob@example.test");
    expect(html).toContain('data-next-in-line="true"');
    expect(html).toContain(">Promote</button>");
    expect(html).toContain("Decided (1)");
    expect(html).toContain('data-no-show="true"');
    expect(html).toContain(">Remove and promote waitlist</button>");
    expect(html).toContain(">Registrations</a>");
    expect(html).not.toContain("coming with registration approvals");
  });

  it("Participants: organisers check a coach in with one click; others see no button; Coach says paid by the Paid toggle", async () => {
    const rows = [entrant(), entrant({ id: "t1:entrant:6", coachId: "Fay", flags: { ...FLAGS, checkedIn: true }, coachSaysPaid: { at: "2026-11-10T12:00:00.000Z" } })];
    const org = await render("/tournaments/t1?tab=entrants", { ...AS("Veers"), "/api/tournaments/t1": body({ entrants: rows, capabilities: { manage: true, assignRoles: true } }) });
    expect(org).toMatch(/data-check-in-coach[^>]*aria-label="Check in Alice"[^>]*>Check in<\/button>/);
    expect(org).toContain('data-checked-in="true"');
    const pub = await render("/tournaments/t1?tab=entrants", { ...AS("Zed"), "/api/tournaments/t1": body({ entrants: [entrant({ flags: undefined, refCode: undefined })] }) });
    expect(pub).not.toContain("data-check-in-coach");
    const manage = await render("/tournaments/t1/manage", { ...AS("Veers"), "/api/tournaments/t1": body({ entrants: rows, capabilities: { manage: true, assignRoles: true } }), "/api/tournaments/t1/registrations": PANEL }, true);
    expect(manage).toContain('data-coach-says-paid="true"');
    expect(manage).toContain("Ref SF-7Q2K");
  });

  it("the register sheet's team step: save cards, Roster later, Build one now, the region pick", async () => {
    const f = mockFetcher({
      ...AS("Bob"),
      "/api/tournaments/t1": body({ tournament: tournament({ regions: ["North", "South"] }) }),
      "/api/fork/library?coach=Bob": { teams: [{ teamId: "tm9", teamName: "Fork Orcs", race: "Orc", teamValue: 1 }] },
      "/api/fork/team-builder/saves": { saves: [{ id: "s1", name: "Orc sheet", raceName: "Orc", packageName: "nut-cup", teamId: null, updatedAt: "x" }] },
    });
    const d = mods.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    await d.loadTeamOptions("Bob");
    const session = mods.session.createSessionStore(f);
    await session.load();
    const app = mods.vue.createSSRApp(mods.dialog.default);
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: { render: () => null } }, { path: "/account", name: "account", component: { render: () => null } }] });
    app.use(router);
    app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    app.provide(mods.session.SESSION_KEY, session);
    const html = (await mods.renderer.renderToString(app)) as string;
    expect(html).toContain("Register: Spike Open");
    expect(html).toContain("Step 1 of 3");
    expect(html).toContain('data-ref="save:s1"');
    expect(html).toContain("Saved team");
    // Owner 11-03: the fork library is never read or offered, even when the coach has library teams.
    expect(html).not.toContain("library:");
    expect(html).not.toContain("Fork Orcs");
    expect(html).not.toContain("Library team");
    expect(f.calls.some((c) => c.path.includes("/api/fork/library"))).toBe(false);
    expect(html).toContain('data-kind="later"');
    expect(html).toContain("Submit your roster by 01 Dec 2026, 18:00 UTC");
    expect(html).toContain('href="/tournament-team-builder?package=nut-cup&amp;tournament=t1"');
    expect(html).toContain("Pick your region");
    expect(html).toContain(">Next");
  });
});
