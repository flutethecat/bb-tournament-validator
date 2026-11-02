import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { contactLines, createLeagueParticipants, flagCount, keepRow, type ParticipantRow } from "../spa/src/leagues/participants";

// League participant flags (SPA): the controller (single / bulk writes carry the season revision, a stale write re-reads),
// the helpers, and the pages server-rendered: the flags table lives in the management sub-panel (League settings ›
// Participants) for organisers and admins; the league page's Participants tab is public (public fields only, coaches
// inert for everyone but the organisers, who get a profile button).

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

const F = (o: Partial<ParticipantRow["flags"]> = {}): ParticipantRow["flags"] => ({ paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true, ...o });
const ROWS: ParticipantRow[] = [
  { teamId: "elves", team: "Elves", race: "Wood Elf", coach: "Bob", coachId: "Bob", flags: F({ paid: true }), contact: { email: "bob@example.com", phones: [{ number: "+15555550100", label: "mobile" }] } },
  { teamId: "orcs", team: "Orcs", race: "Orc", coach: "Dee Display", coachId: "Dee", flags: F({ active: false }) },
];
const P = "/api/leagues/tabbl/seasons/season-6/participants";

describe("participants helpers + controller", () => {
  it("filters, counts and shared-contact lines", () => {
    expect(ROWS.filter((r) => keepRow(r, "unpaid")).map((r) => r.teamId)).toEqual(["orcs"]);
    expect(ROWS.filter((r) => keepRow(r, "standby")).map((r) => r.teamId)).toEqual(["orcs"]);
    expect(flagCount(ROWS, "paid")).toBe(1);
    expect(contactLines(ROWS[0]!)).toEqual(["bob@example.com", "+15555550100 (mobile)"]);
    expect(contactLines(ROWS[1]!)).toEqual([]);
  });

  it("writes send the newer revision (page or ours), apply the rows and report the new revision", async () => {
    const f = mockFetcher({
      [P]: { participants: ROWS, revision: 4 },
      [`PATCH ${P}/orcs`]: { ok: true, changed: 1, participants: ROWS, revision: 8 },
      [`POST ${P}`]: { ok: true, changed: 2, participants: ROWS.map((r) => ({ ...r, flags: { ...r.flags, rosterVerified: true } })), revision: 9 },
    });
    let page = 7;
    const told: number[] = [];
    const ctl = createLeagueParticipants({ api: f, revision: () => page, onRevision: (r) => { told.push(r); page = r; } });
    await ctl.load("tabbl", "season-6");
    expect(ctl.state.rows).toHaveLength(2);
    expect(await ctl.setFlag("orcs", "paid", true)).toBe(true);
    expect(f.calls[1]).toEqual({ path: `${P}/orcs`, method: "PATCH", body: { revision: 7, paid: true } });
    expect(await ctl.bulk("rosterVerified", true)).toBe(true);
    expect(f.calls[2]).toEqual({ path: P, method: "POST", body: { revision: 8, set: { rosterVerified: true } } });
    expect(ctl.state.notice).toBe("Verified: 2 teams updated.");
    expect(told).toEqual([8, 9]);
    await ctl.bulk("paid", false, ["orcs"]);
    expect(f.calls[3]!.body).toEqual({ revision: 9, teamIds: ["orcs"], set: { paid: false } });
  });

  it("a stale write shows the error and re-reads the rows", async () => {
    const f = mockFetcher({ [P]: { participants: ROWS, revision: 4 }, [`PATCH ${P}/orcs`]: new ApiError(409, "This season changed since you opened it.") });
    const ctl = createLeagueParticipants({ api: f });
    await ctl.load("tabbl", "season-6");
    expect(await ctl.setFlag("orcs", "paid", true)).toBe(false);
    expect(ctl.state.writeError).toContain("changed since");
    expect(f.calls.filter((c) => c.path === P && !c.method)).toHaveLength(2);
  });
});

describe("participants controller: season switch during a save", () => {
  it("a switch resets busy and errors; the old season's answer is ignored", async () => {
    let release!: (v: unknown) => void;
    const f = mockFetcher({
      [P]: { participants: ROWS, revision: 4 },
      "/api/leagues/tabbl/seasons/season-5/participants": { participants: [], revision: 1 },
      [`POST ${P}`]: () => new Promise((r) => { release = r; }),
    });
    const ctl = createLeagueParticipants({ api: f });
    await ctl.load("tabbl", "season-6");
    const saving = ctl.bulk("paid", true);
    expect(ctl.state.busy).toBe("bulk:paid");
    await ctl.load("tabbl", "season-5");
    expect(ctl.state.busy).toBe("");
    release({ ok: true, changed: 2, participants: ROWS, revision: 9 });
    expect(await saving).toBe(false);
    expect(ctl.state.rows).toEqual([]);
    expect(ctl.state.revision).toBe(1);
    expect(ctl.state.notice).toBe("");
  });
});

describe("participants tab (server-rendered league page)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    league: typeof import("../spa/src/leagues/league");
    parts: typeof import("../spa/src/leagues/participants");
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, parts, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/leagues/participants.ts"),
      vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, league: league as never, parts: parts as never };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const s6 = { id: "season-6", number: 6, name: "Season 6", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 0, playedCount: 0 };
  const leagueSummary = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], playOnFork: false, createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1, currentSeason: s6 };
  const team = (id: string, name: string, race: string, coach: string, coachId: string) => ({
    id, name, race, coach, coachId, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [],
  });
  const season = {
    ...s6, leagueId: "tabbl", sourceSlug: "s6", phases: [], fixtures: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "", source: "manual", revision: 3,
    teams: [team("elves", "Elves", "Wood Elf", "Bob", "Bob"), team("orcs", "Orcs", "Orc", "Dee Display", "Dee")],
  };
  const SETTINGS = { settings: { id: "tabbl", revision: 1 } };
  const API: Routes = {
    "/api/leagues/tabbl": { league: leagueSummary, seasons: [s6] },
    "/api/leagues/tabbl/seasons/season-6": { league: leagueSummary, season },
    "/crests/manifest.json": { crests: {} },
    [P]: { participants: ROWS, revision: 3 },
  };
  const session = (coach?: string, admin = false): Routes => ({
    "/api/auth/session": coach ? { authenticated: true, coach, authMethod: "discord", discordSsoEnabled: true, ...(admin ? { admin: true } : {}) } : { authenticated: false, discordSsoEnabled: true },
  });
  async function renderManage(who: Routes): Promise<string> {
    const settingsMod = await vite.ssrLoadModule("/src/leagues/settings.ts");
    const f = mockFetcher({ ...API, "/api/leagues/tabbl/settings": SETTINGS, ...who });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const s = settingsMod.createLeagueSettings({ api: f });
    await s.load("tabbl");
    spa.app.provide(settingsMod.LEAGUE_SETTINGS_KEY, s);
    const p = mods.parts.createLeagueParticipants({ api: f });
    await p.load("tabbl", "season-6");
    spa.app.provide(mods.parts.LEAGUE_PARTICIPANTS_KEY, p);
    await spa.router.push("/leagues/tabbl/settings?tab=participants");
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }
  async function render(path: string, who: Routes): Promise<string> {
    const f = mockFetcher({ ...API, ...who });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-6");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    const p = mods.parts.createLeagueParticipants({ api: f });
    await p.load("tabbl", "season-6");
    spa.app.provide(mods.parts.LEAGUE_PARTICIPANTS_KEY, p);
    await spa.router.push(path);
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }

  it("management › Participants: organisers see the bulk bar, the five flags and only shared contact", async () => {
    const html = await renderManage(session("Jay"));
    expect(html.match(/<a[^>]*data-group="participants"[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
    expect(html).toContain('id="lg-part-h"');
    for (const t of ["Mark all paid", "Mark all verified", "Check in all", "Mark all active", "Clear...", "All 2 teams"]) expect(html).toContain(t);
    for (const t of [">Paid<", ">Verified<", ">Frozen<", ">Checked in<", ">Active<"]) expect(html).toContain(t);
    expect(html).toContain("bob@example.com");
    expect(html).toContain("Not shared"); // Dee shared nothing
    expect(html).toContain('aria-label="Paid: Elves"');
  });

  it("the public Participants tab: everyone sees public fields only; coaches are inert except for organisers (old ?tab=participants lands here)", async () => {
    for (const who of [session(), session("Bob")]) {
      const html = await render("/leagues/tabbl?tab=participants", who);
      expect(html).toContain('id="lg-plist-h"');
      expect(html.match(/<a[^>]*data-tab="participants"[^>]*>/)?.[0] ?? "").toContain('aria-current="page"');
      for (const t of ["Elves", "Wood Elf", "Bob", "Orcs", "Dee Display"]) expect(html).toContain(t);
      expect(html).not.toContain('id="lg-part-h"'); // no flags table
      expect(html).not.toContain("bob@example.com"); // no private field, ever
      expect(html).not.toContain("+15555550100");
      expect(html).not.toContain("data-coach-profile"); // inert text
      expect(html).not.toContain("data-manage-participants");
      expect(html).not.toContain("data-cog");
    }
    const org = await render("/leagues/tabbl?tab=participants", session("Jay"));
    expect(org.match(/data-coach-profile/g)).toHaveLength(2); // organisers open each coach's profile
    expect(org).toContain("data-manage-participants");
    expect(org).not.toContain("bob@example.com"); // contact only inside the profile, fetched for that coach and scope
  });

  it("management › Participants refuses members (the server's 403) and never shows contact", async () => {
    const html = await renderManage({ ...session("Bob"), "/api/leagues/tabbl/settings": new ApiError(403, "Not yours."), [P]: new ApiError(403, "Not yours.") });
    expect(html).toContain("Not one of yours");
    expect(html).not.toContain("bob@example.com");
    expect(html).not.toContain('id="lg-part-h"');
  });
});
