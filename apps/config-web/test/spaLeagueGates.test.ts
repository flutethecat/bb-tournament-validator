import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  calendarGates, countdownText, gateForm, gateFormError, gatePayload, gatesApi, gateWhen, offsetText, upcomingGates, wallOf, type GateView,
} from "../spa/src/leagues/gates";
import { gateItems } from "../spa/src/leagues/leagueEvents";

// SPA gates (lane 8c): the countdown and form helpers, the API calls, the calendar source, and the gate editor / coach banner /
// Schedule list / live Redraft rolls page server-rendered (fake data only).

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
  }) as Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> };
  f.calls = calls;
  return f;
}

const gate = (over: Partial<GateView> = {}): GateView => ({
  id: "registration:season-7", kind: "registration", target: "season-7", targetName: "Season 7", label: "Registration", title: "Season 7: Registration opens",
  state: "shut", opensAt: "2026-11-05T19:00:00.000Z", secondsLeft: 3600, mode: "time", wall: "2026-11-05T19:00", revision: 1, ...over,
});

describe("gate helpers", () => {
  it("countdowns, league-zone times, the banner list and the calendar source", () => {
    expect(countdownText(0)).toBe("now");
    expect(countdownText(65_000)).toBe("1m 05s");
    expect(countdownText(3 * 3600_000 + 125_000)).toBe("3h 02m 05s");
    expect(countdownText(2 * 86_400_000 + 4 * 3600_000 + 13 * 60_000)).toBe("2d 4h 13m");
    expect(gateWhen("2026-11-05T19:00:00.000Z", "America/New_York")).toBe("Thu 5 Nov 2026, 14:00");
    expect(wallOf("2026-11-05T19:00:00.000Z", "Europe/Berlin")).toBe("2026-11-05T20:00");
    const now = Date.parse("2026-11-05T18:00:00.000Z");
    const list = [gate(), gate({ id: "a", kind: "ladder-challenges", target: "ladder-1", opensAt: "2026-11-05T18:30:00.000Z" }), gate({ id: "b", state: "open" }), gate({ id: "c", opensAt: null }), gate({ id: "d", opensAt: "2026-11-05T17:00:00.000Z" })];
    expect(upcomingGates(list, now).map((g) => g.id)).toEqual(["a", "registration:season-7"]);
    expect(upcomingGates(list, now, ["registration"]).map((g) => g.id)).toEqual(["registration:season-7"]);
    expect(upcomingGates(list, now, undefined, "ladder-1").map((g) => g.id)).toEqual(["a"]);
    const items = gateItems(calendarGates(list))({ leagueId: "tabbl", seasonId: "", zone: "UTC" });
    expect(items.map((i) => i.key)).toEqual(["gate:registration:season-7", "gate:a", "gate:d"]);
    expect(items[0]).toMatchObject({ type: "gate", day: "2026-11-05", time: "19:00", target: "dialog", title: "Season 7: Registration opens" });
  });

  it("the editor form: off / at a time / with a League Event, season start's auto-start, inline checks", () => {
    const blank = gateForm(undefined, Date.parse("2026-11-05T12:00:00.000Z"), "UTC");
    expect(blank).toEqual({ mode: "off", wall: "2026-11-06T19:00", eventId: "", offset: 0, autoStart: false });
    expect(gatePayload(blank, "registration")).toEqual({ mode: "off" });
    expect(gatePayload({ ...blank, mode: "time" }, "registration")).toEqual({ mode: "time", opensAt: "2026-11-06T19:00" });
    expect(gatePayload({ ...blank, mode: "time", autoStart: true }, "season-start")).toEqual({ mode: "time", opensAt: "2026-11-06T19:00", autoStart: true });
    expect(gatePayload({ ...blank, mode: "event", eventId: "e1", offset: 60 }, "redraft-rest")).toEqual({ mode: "event", eventId: "e1", offsetMinutes: 60 });
    expect(gateFormError({ ...blank, mode: "event" })).toBe("Pick a League Event.");
    expect(gateFormError({ ...blank, mode: "time", wall: "" })).toBe("Pick the date and time it opens.");
    expect(gateFormError({ ...blank, mode: "event", eventId: "e", offset: 20_000 })).toMatch(/at most 7 days/);
    expect(gateForm(gate({ mode: "event", eventId: "e1", offsetMinutes: -60, wall: undefined }), 0, "UTC")).toMatchObject({ mode: "event", eventId: "e1", offset: -60 });
    expect(offsetText(120, "League night")).toBe("Opens 2 h after League night starts");
    expect(offsetText(-1440, "League night")).toBe("Opens 1 d before League night starts");
    expect(offsetText(0, "League night")).toBe("Opens when League night starts");
  });

  it("API calls: PUT with the gate's revision, POST open, GET read", async () => {
    const f = mockFetcher({
      "/api/leagues/tabbl/gates": { timeZone: "UTC", now: "", manage: true, gates: [] },
      "PUT /api/leagues/tabbl/gates/registration/season-7": { gate: gate() },
      "POST /api/leagues/tabbl/gates/registration/season-7/open": { gate: gate({ state: "open" }) },
    });
    await gatesApi.list(f, "tabbl");
    await gatesApi.save(f, "tabbl", "registration", "season-7", 0, { mode: "time", opensAt: "2026-11-05T19:00" });
    await gatesApi.open(f, "tabbl", "registration", "season-7", 1);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/leagues/tabbl/gates", "PUT /api/leagues/tabbl/gates/registration/season-7", "POST /api/leagues/tabbl/gates/registration/season-7/open"]);
    expect(f.calls[1]!.body).toEqual({ mode: "time", opensAt: "2026-11-05T19:00", revision: 0 });
    expect(f.calls[2]!.body).toEqual({ revision: 1 });
  });

  it("styles use tokens only", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/leagues/gates.css", import.meta.url)), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/Nuffle|Silkscreen/);
  });
});

describe("gate surfaces (server-rendered)", () => {
  let vite: ViteDevServer | undefined;
  let mods: {
    createSpa: (o: unknown) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    gates: typeof import("../spa/src/leagues/gates");
    settings: typeof import("../spa/src/leagues/settings");
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, gates, settings, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/gates.ts"), vite.ssrLoadModule("/src/leagues/settings.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString,
      gates: gates as typeof import("../spa/src/leagues/gates"), settings: settings as typeof import("../spa/src/leagues/settings"),
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const ORGANISER = { "/api/auth/session": { authenticated: true, coach: "Jay", authMethod: "discord", discordSsoEnabled: true } };
  const soon = new Date(Date.now() + 2 * 86_400_000 + 3 * 3600_000).toISOString();
  const read = (gates: GateView[], manage = true) => ({ timeZone: "Europe/London", now: new Date().toISOString(), manage, gates, ...(manage ? { events: [{ id: "e1", title: "League night", next: soon }] } : {}) });
  const LEAGUE = { league: { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1, timeZone: "Europe/London" }, seasons: [] };

  async function render(path: string, gates: GateView[], routes: Routes = {}, manage = true) {
    mods.gates.resetGateStores();
    const f = mockFetcher({ ...ORGANISER, "/api/leagues/tabbl": LEAGUE, ...routes });
    const store = mods.gates.useLeagueGates(f, "tabbl");
    store.state.read = read(gates, manage);
    store.state.loaded = true;
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await spa.router.push(path);
    await spa.router.isReady();
    return mods.renderToString(spa.app);
  }

  it("the editor beside the redraft board: three gates, the modes, the countdown chip, Open now, the event picker", async () => {
    const SETTINGS = {
      id: "tabbl", revision: 3, information: { name: "TABBL", fullName: "TABBL", description: "", ruleset: "BB2025", mode: "individual", address: null },
      permissions: { owner: "Jay", organisers: [], admins: [], canEditOrganisers: true, canChangeOwner: false },
      registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null },
      connections: { playOnFork: false, discord: { configured: false, maskedUrl: "", events: {} }, naf: { available: false, note: "" } }, teamBuilding: null, regions: { US: [], CA: [] }, rulesets: ["BB2025"], eliteSkills: [],
    };
    const f = mockFetcher({ ...ORGANISER, "/api/leagues/tabbl/settings": { settings: SETTINGS }, "/api/leagues/tabbl": LEAGUE });
    const settings = mods.settings.createLeagueSettings({ api: f });
    await settings.load("tabbl");
    mods.gates.resetGateStores();
    const store = mods.gates.useLeagueGates(f, "tabbl");
    store.state.read = read([
      gate({ id: "redraft-rest:league", kind: "redraft-rest", target: "league", targetName: "League", title: "Rest & Relaxation rolls open", mode: "event", eventId: "e1", eventTitle: "League night", offsetMinutes: 60, wall: undefined, opensAt: soon }),
      gate({ id: "redraft-submit:league", kind: "redraft-submit", target: "league", targetName: "League", state: "open", openedAt: "2026-11-01T10:00:00.000Z", openedBy: "organiser" }),
    ]);
    store.state.loaded = true;
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.settings.LEAGUE_SETTINGS_KEY, settings);
    await spa.router.push("/leagues/tabbl/settings?tab=redraft");
    await spa.router.isReady();
    const html = await mods.renderToString(spa.app);
    expect(html).toContain("Redraft gates");
    for (const l of ["Redraft window", "Rest rolls", "Submissions"]) expect(html).toContain(`>${l}</p>`);
    expect(html).toMatch(/data-kind="redraft-window" data-state="off"/);
    expect(html).toMatch(/data-kind="redraft-rest" data-state="shut"/);
    expect(html).toMatch(/data-kind="redraft-submit" data-state="open"/);
    expect(html).toMatch(/data-gate-status[^>]*>Opens in 2d [23]h/);
    expect(html).toContain("data-gate-open=\"redraft-rest\"");
    expect(html).not.toContain("data-gate-open=\"redraft-submit\"");
    for (const m of ["Off", "At a time", "With a League Event"]) expect(html).toContain(`>${m}</button>`);
    expect(html).toContain("Opens 1 h after League night starts, and moves with it.");
    expect(html).toContain("Open the Redraft rolls page");
  });

  it("the coach banner counts down (league zone named); open and untimed gates stay off it", async () => {
    mods.gates.resetGateStores();
    const f = mockFetcher({});
    const store = mods.gates.useLeagueGates(f, "tabbl");
    store.state.read = read([gate({ opensAt: soon }), gate({ id: "x", kind: "season-start", state: "open" }), gate({ id: "y", kind: "honours-reveal", opensAt: null })], false);
    store.state.loaded = true;
    const Banner = (await vite!.ssrLoadModule("/src/components/LeagueGateBanner.vue")).default;
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: mockFetcher(ORGANISER) }) as unknown as {
      app: unknown; router: { addRoute: (r: unknown) => void; push: (p: string) => Promise<unknown>; isReady: () => Promise<void> };
    };
    spa.router.addRoute({ path: "/__gate-banner", component: Banner, props: { leagueId: "tabbl", now: Date.parse(soon) - (2 * 86_400_000 + 3 * 3600_000 + 5 * 60_000) } });
    await spa.router.push("/__gate-banner");
    await spa.router.isReady();
    const html = await mods.renderToString(spa.app);
    expect(html).toContain("data-gate-banner");
    expect(html).toContain("Season 7: registration opens");
    expect(html).toContain("in <b>2d 3h 05m</b>");
    expect(html.slice(html.indexOf("gt-banner-when"), html.indexOf("gt-banner-when") + 120)).toContain("(Europe/London)");
    expect(html.match(/gt-banner-row/g)).toHaveLength(1);
  });

  it("the live Redraft rolls page: its route, organisers' and the shared link's", async () => {
    const shared = await render("/leagues/tabbl/redraft-rolls/AbCdEfGhIjKlMnOpQrStUvWxYz012345", []);
    expect(shared).toContain("Loading the rolls...");
    const own = await render("/leagues/tabbl/redraft-rolls", []);
    expect(own).toContain("Loading the rolls...");
  });
});
