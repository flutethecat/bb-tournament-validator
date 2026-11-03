import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  createLeagueJoin, createLeagueRegistrations, entryChip, joinBody, joinChoices, joinOutcome, leaguePlacesLine, leagueRegistrationsCaption, raceLine,
  type LeagueJoinStatus, type LeagueRegistrationsView,
} from "../spa/src/leagues/registration";

// Lane L6 in the SPA: the join sheet's helpers and the two controllers (coach join block, organisers' Registrations tab),
// and the views server-rendered against a mocked API (the SPA's own Vite config, no port): the Registration block on the
// league Overview with the Pay block's reference code and "I've paid", the join sheet's team step, and League management
// › Registrations.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
type Call = { path: string; method?: string; body?: unknown };
function mockFetcher(routes: Routes): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    const key = init?.method && init.method !== "GET" ? `${init.method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${key}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}

const MARKER = "league:tabbl:season-7";
const STATUS: LeagueJoinStatus = {
  open: true, approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false, cap: 8, perRace: 2, entryFee: "$10 a team",
  stage: "registration", midSeason: false, accepted: 3, placesLeft: 5, raceCounts: { Orc: 2, Human: 1 }, regions: [], packageName: MARKER,
  shareText: "You are joining TABBL. Its organisers can see your coach name and your teams. Choose below what else they can see.",
};
const J = "/api/leagues/tabbl/seasons/season-7";
const SAVES = [
  { id: "s1", name: "Grudge Rollers", raceName: "Dwarf", packageName: MARKER, teamId: null, updatedAt: "x" },
  { id: "s2", name: "Old Orcs", raceName: "Orc", packageName: "Spike 2026", teamId: null, updatedAt: "x" },
  { id: "s3", name: "Linked", raceName: "Human", packageName: "Spike 2026", teamId: "tm9", updatedAt: "x" },
];
const LIB = [{ teamId: "tm9", teamName: "Linked team", race: "Human", teamValue: 1 }, { teamId: "tm4", teamName: "Spare Elves", race: "Wood Elf", teamValue: 1 }];
const PANEL: LeagueRegistrationsView = {
  counts: { accepted: 3, pending: 1, waitlisted: 1, cap: 8, placesLeft: 5 },
  settings: { approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: true, cap: 8, perRace: 2, entryFee: "$10", stage: "active", open: true, test: false },
  raceCounts: { Orc: 2, Dwarf: 1 },
  entries: [
    { id: "lr-1", coachId: "Bob", state: "pending", teamName: "Bob Dwarfs", race: "Dwarf", enteredAt: "2026-11-10T12:00:00.000Z", kind: "new", players: 12, cost: 960000, validation: { ok: true, problems: [] }, shared: { coach: "Bob", email: "bob@example.test" }, refCode: "SF-AAAA", coachSaysPaid: { at: "2026-11-10T13:00:00.000Z" } },
    { id: "lr-2", coachId: "Carol", state: "waitlisted", teamName: "Carol Elves", race: "Wood Elf", enteredAt: "2026-11-10T12:01:00.000Z", position: 1, nextInLine: true },
    { id: "lr-3", coachId: "Dee", state: "accepted", teamName: "Dee Orcs", race: "Orc", enteredAt: "2026-11-10T12:02:00.000Z", midSeason: true, paid: false, refCode: "SF-BBBB", decided: { by: "Jay", at: "2026-11-11T10:00:00.000Z" } },
    { id: "lr-4", coachId: "Eve", state: "declined", teamName: "Eve Humans", race: "Human", enteredAt: "2026-11-10T12:03:00.000Z", decided: { by: "Jay", at: "2026-11-11T10:00:00.000Z", reason: "Duplicate" } },
  ],
};

describe("league registration helpers (pure)", () => {
  it("team choices: saves built for this season, then (existing teams allowed) other saves and library teams", () => {
    expect(joinChoices(SAVES, LIB as never, MARKER, false).map((c) => [c.ref, c.kind])).toEqual([["save:s1", "new"]]);
    expect(joinChoices(SAVES, LIB as never, MARKER, true).map((c) => [c.ref, c.kind])).toEqual([
      ["save:s1", "new"], ["save:s2", "existing"], ["save:s3", "existing"], ["library:tm4", "existing"],
    ]);
    expect(joinBody({ teamRef: "save:s1", region: "North", share: ["email"], acknowledged: true }, true)).toEqual({ teamRef: "save:s1", share: ["email"], acknowledged: true, region: "North" });
    expect(joinBody({ teamRef: "save:s1", region: "North", share: [], acknowledged: true }, false)).toEqual({ teamRef: "save:s1", share: [], acknowledged: true });
    expect(JSON.stringify(joinBody({ teamRef: "save:s1", region: "", share: [], acknowledged: true }, false))).not.toMatch(/naf/i);
  });

  it("chips, places, outcome, per-race words and the band caption", () => {
    expect(entryChip({ state: "waitlisted", position: 2 })).toBe("Waitlist #2");
    expect(entryChip({ state: "accepted" })).toBe("Accepted");
    expect(leaguePlacesLine(STATUS)).toBe("5 of 8 places left");
    expect(leaguePlacesLine({ ...STATUS, placesLeft: 0 })).toBe("Full: new teams join the waitlist");
    expect(leaguePlacesLine({ ...STATUS, cap: null, placesLeft: null })).toBe("No team limit");
    expect(joinOutcome(STATUS, "Orc")).toBe("pending");
    expect(joinOutcome({ ...STATUS, approval: "auto" }, "Orc")).toBe("waitlisted");
    expect(joinOutcome({ ...STATUS, approval: "auto", waitlist: false }, "Orc")).toBe("full");
    expect(joinOutcome({ ...STATUS, approval: "auto" }, "Dwarf")).toBe("accepted");
    expect(raceLine(STATUS, "Orc")).toBe("Orc: 2 / 2, full");
    expect(raceLine(STATUS, "Human")).toBe("Human: 1 / 2");
    expect(raceLine({ ...STATUS, perRace: null }, "Orc")).toBe("");
    expect(leagueRegistrationsCaption(PANEL.counts)).toBe("3 / 8 teams · 1 pending · 1 waiting");
  });
});

describe("league registration controllers", () => {
  it("join, withdraw, I've paid; decisions reload the tab and say what happened", async () => {
    const mine = { id: "lr-9", state: "pending", teamName: "Grudge Rollers", race: "Dwarf", kind: "new", enteredAt: "x", refCode: "SF-7Q2K", paid: false };
    const f = mockFetcher({
      [`${J}/join`]: { status: STATUS, mine },
      [`POST ${J}/registrations`]: { registration: mine },
      [`POST ${J}/registrations/lr-9/withdraw`]: { entry: { id: "lr-9", state: "withdrawn" }, changed: true },
      [`POST ${J}/registrations/lr-9/paid-claim`]: { registration: { ...mine, coachSaysPaid: { at: "y" } } },
      [`${J}/registrations`]: PANEL,
      [`POST ${J}/registrations/lr-3/accept`]: { midSeason: true, changed: true },
      [`POST ${J}/registrations/lr-1/decline`]: new ApiError(409, "That race is full.", { code: "race-full" }),
    });
    const j = createLeagueJoin({ api: f });
    await j.load("tabbl", "season-7");
    expect(j.state.mine?.refCode).toBe("SF-7Q2K");
    expect(await j.join(joinBody({ teamRef: "save:s1", region: "", share: ["email"], acknowledged: true }, false))).toBe(true);
    expect(f.calls.find((c) => c.method === "POST")!.body).toEqual({ teamRef: "save:s1", share: ["email"], acknowledged: true });
    expect(j.state.notice).toBe("Registration received. The organisers review every team.");
    await j.claimPaid(true);
    expect(j.state.mine?.coachSaysPaid).toEqual({ at: "y" });
    await j.withdraw();
    expect(j.state.notice).toBe("Your registration was withdrawn.");
    const r = createLeagueRegistrations({ api: f });
    await r.load("tabbl", "season-7");
    expect(r.state.data?.entries).toHaveLength(4);
    expect(await r.decide("lr-3", "accept")).toBe(true);
    expect(r.state.notice).toContain("no fixtures were made");
    expect(await r.decide("lr-1", "decline", { reason: " dup " })).toBe(false);
    expect(f.calls.at(-1)!.body).toEqual({ reason: "dup" });
    expect(r.state.actionError).toBe("That race is full.");
  });

  it("a refused join shows the server's words and the season-rule problems", async () => {
    const f = mockFetcher({
      [`${J}/join`]: { status: STATUS },
      [`POST ${J}/registrations`]: new ApiError(400, "This team doesn't meet the season's rules.", { code: "invalid-team", problems: ["Too many big guys."] }),
    });
    const j = createLeagueJoin({ api: f });
    await j.load("tabbl", "season-7");
    expect(await j.join(joinBody({ teamRef: "save:s1", region: "", share: [], acknowledged: true }, false))).toBe(false);
    expect(j.state.error).toBe("This team doesn't meet the season's rules. Too many big guys.");
  });
});

describe("league registration views (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, reg, settings, vueRouter, renderer, vue, dialog, session] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/leagues/registration.ts"),
      vite.ssrLoadModule("/src/leagues/settings.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), import("vue"),
      vite.ssrLoadModule("/src/components/LeagueRegisterDialog.vue"), vite.ssrLoadModule("/src/session.ts"),
    ]);
    mods = { app, league, reg, settings, vueRouter, renderer, vue, dialog, session };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const s7 = { id: "season-7", number: 7, name: "Season 7", ruleset: "BB2025", status: "active", stage: "registration", teamCount: 3, fixtureCount: 0, playedCount: 0 };
  const leagueSummary = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], playOnFork: false, createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1, currentSeason: s7, houseRules: {}, authorised: true, timeZone: "UTC" };
  const season = { ...s7, leagueId: "tabbl", sourceSlug: "s7", phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: "", source: "manual", revision: 3 };
  const API: Routes = {
    "/api/leagues/tabbl": { league: leagueSummary, seasons: [s7] },
    [J]: { league: leagueSummary, season },
    "/crests/manifest.json": { crests: {} },
  };
  const AS = (coach?: string): Routes => ({
    "/api/auth/session": coach ? { authenticated: true, coach, authMethod: "discord", discordSsoEnabled: true } : { authenticated: false, discordSsoEnabled: true },
  });

  async function renderLeague(who: Routes, join: { status: LeagueJoinStatus; mine?: Record<string, unknown> }) {
    const f = mockFetcher({ ...API, ...who, [`${J}/join`]: join });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-7");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const j = mods.reg.createLeagueJoin({ api: f });
    await j.load("tabbl", "season-7");
    spa.app.provide(mods.reg.LEAGUE_JOIN_KEY, j);
    await spa.router.push("/leagues/tabbl");
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("Overview: Register a team while open; a pending coach sees their entry, Withdraw, and the Pay block's reference + I've paid", async () => {
    const open = await renderLeague(AS("Bob"), { status: STATUS });
    expect(open).toContain("data-league-join");
    expect(open).toMatch(/data-register[^>]*>Register a team<\/button>/);
    expect(open).toContain("Build a team for this season");
    expect(open).toContain("5 of 8 places left");
    const mine = { id: "lr-9", state: "pending", teamName: "Grudge Rollers", race: "Dwarf", kind: "new", enteredAt: "x", refCode: "SF-7Q2K", paid: false };
    const pending = await renderLeague(AS("Bob"), { status: STATUS, mine });
    expect(pending).toContain('data-state="pending"');
    expect(pending).toContain("Grudge Rollers");
    expect(pending).toMatch(/data-withdraw[^>]*>\s*Withdraw\s*<\/button>/);
    expect(pending).not.toMatch(/data-register/);
    expect(pending).toContain('data-ref-code="true"');
    expect(pending).toContain("SF-7Q2K");
    expect(pending).toContain("I&#39;ve paid");
    expect(pending).toContain("$10 a team");
    // a declined coach sees the reason and no reference code; nobody signed out sees the block
    const declined = await renderLeague(AS("Bob"), { status: STATUS, mine: { ...mine, state: "declined", refCode: undefined, reason: "Duplicate" } });
    expect(declined).toContain("The organisers said: Duplicate");
    expect(declined).not.toContain("SF-7Q2K");
    expect(declined).not.toMatch(/data-register/);
    const anon = await renderLeague(AS(), { status: STATUS });
    expect(anon).not.toContain("data-league-join");
  });

  it("the join sheet's team step: season-built save cards with the per-race count, Build a team, the region pick", async () => {
    const f = mockFetcher({
      ...AS("Bob"),
      [`${J}/join`]: { status: { ...STATUS, regions: ["North", "South"] } },
      "/api/fork/library?coach=Bob": { teams: LIB },
      "/api/fork/team-builder/saves": { saves: SAVES },
    });
    const j = mods.reg.createLeagueJoin({ api: f });
    await j.load("tabbl", "season-7");
    await j.loadOptions("Bob");
    const session = mods.session.createSessionStore(f);
    await session.load();
    const app = mods.vue.createSSRApp(mods.dialog.default, { leagueName: "TABBL", seasonName: "Season 7" });
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: { render: () => null } }, { path: "/account", name: "account", component: { render: () => null } }] });
    app.use(router);
    app.provide(mods.reg.LEAGUE_JOIN_KEY, j);
    app.provide(mods.session.SESSION_KEY, session);
    const html = (await mods.renderer.renderToString(app)) as string;
    expect(html).toContain("Register: TABBL");
    expect(html).toContain("Step 1 of 3");
    expect(html).toContain('data-ref="save:s1"');
    expect(html).not.toContain('data-ref="save:s2"'); // existing teams are off
    expect(html).toContain("Dwarf · built for this season");
    expect(html).toContain("Dwarf: 0 / 2");
    expect(html).toContain("/app/tournament-team-builder?league=tabbl&amp;season=season-7");
    expect(html).toContain("Pick your region");
    expect(html).not.toMatch(/naf/i);
  });

  it("League management › Registrations: pending with shared fields and the reference, waitlist next in line, accepted mid-season, decided folded", async () => {
    const f = mockFetcher({ ...API, ...AS("Jay"), "/api/leagues/tabbl/settings": { settings: { id: "tabbl", revision: 1 } }, [`${J}/registrations`]: PANEL });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const s = mods.settings.createLeagueSettings({ api: f });
    await s.load("tabbl");
    spa.app.provide(mods.settings.LEAGUE_SETTINGS_KEY, s);
    const r = mods.reg.createLeagueRegistrations({ api: f });
    await r.load("tabbl", "season-7");
    spa.app.provide(mods.reg.LEAGUE_REGISTRATIONS_KEY, r);
    await spa.router.push("/leagues/tabbl/settings?tab=entries");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html.match(/<a[^>]*data-group="entries"[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
    expect(html).toContain(">Registrations</a>");
    expect(html).toContain(">Registration settings</a>");
    expect(html).toContain("data-league-registrations");
    expect(html).toContain("3 / 8 teams · 1 pending · 1 waiting");
    expect(html).toContain("bob@example.test");
    expect(html).toContain("SF-AAAA");
    expect(html).toContain("Coach says paid");
    expect(html).toContain(">Accept</button>");
    expect(html).toContain('data-next-in-line="true"');
    expect(html).toContain(">Promote</button>");
    expect(html).toContain("Joined mid-season: add fixtures");
    expect(html).toContain("Decided (1)");
    expect(html).toContain("Duplicate");
  });

  it("design rules: the new stylesheet uses tokens only, no named font family", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/leagues/registration.css", import.meta.url)), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/font-family|Nuffle|Silkscreen/);
  });
});
