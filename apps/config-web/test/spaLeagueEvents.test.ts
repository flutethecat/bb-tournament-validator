import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { calendarItems, dayBlocks, fixtureItems, hourRange, itemsByDay, listMonths, type CalendarContext } from "../spa/src/leagues/seasonCalendar";
import {
  blankForm, formError, formOf, gateItems, leagueEventItems, payloadOf, timelineDays, whenText, type LeagueEventView, type ScheduleEntry,
} from "../spa/src/leagues/leagueEvents";
import { leagueFacts } from "../spa/src/shell/sectionNav";
import type { LeagueFixture, LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";

// League Events in the SPA: the calendar source (every view, the league zone, a distinct type that opens a dialog), the
// typed gates source (empty), the Calendar tab showing for events alone, the event dialog, the editor's form rules, the
// Schedule timeline and the Connections "Create Discord events" option (with and without the bot).

const NY: CalendarContext = { leagueId: "tabbl", seasonId: "season-7", zone: "America/New_York" };

const ev = (over: Partial<LeagueEventView> = {}): LeagueEventView => ({
  id: "e1", revision: 1, title: "Thursday league night", type: "league-night", typeLabel: "League night",
  start: "2026-10-29T19:00", end: "2026-10-29T22:00", location: { kind: "venue", text: "Example Games Club" }, description: "Bring your **team**.",
  recurrence: { everyWeeks: 1, until: "2026-11-05" }, repeatText: "Every week until 5 Nov 2026",
  occurrences: [
    { key: "2026-10-29T19:00", start: "2026-10-29T23:00:00.000Z", end: "2026-10-30T02:00:00.000Z" },
    { key: "2026-11-05T19:00", start: "2026-11-06T00:00:00.000Z", end: "2026-11-06T03:00:00.000Z" },
  ],
  ...over,
});

const fx = (over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 2, table: 1,
  home: { team: "Grudge Rollers", teamId: "grudge", coach: "Ann", coachId: "Ann", race: "Human", score: null, cas: null, conceded: false },
  away: { team: "Lances", teamId: "lances", coach: "Bob", coachId: "Bob", race: "Bretonnian", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});

describe("League Events: calendar source", () => {
  it("each occurrence is an item of type league-event on its day and wall-clock time in the LEAGUE zone (across the clock change)", () => {
    const items = leagueEventItems([ev()], NY);
    expect(items.map((i) => [i.type, i.day, i.time, i.target, i.to, i.eventId, i.occurrence])).toEqual([
      ["league-event", "2026-10-29", "19:00", "dialog", "", "e1", "2026-10-29T19:00"],
      ["league-event", "2026-11-05", "19:00", "dialog", "", "e1", "2026-11-05T19:00"],
    ]);
    expect(items[0]!.key).toBe("league-event:e1:2026-10-29T19:00");
    expect(items[0]!.detail).toBe("League night · Example Games Club");
    expect(items[0]!.label).toBe("League night: Thursday league night, 19:00. Open the event");
    // the same instant read in UTC falls on the next day: the zone decides
    expect(leagueEventItems([ev()], { ...NY, zone: "UTC" })[0]!.day).toBe("2026-10-29");
    expect(leagueEventItems([ev()], { ...NY, zone: "Asia/Tokyo" })[0]!.day).toBe("2026-10-30");
  });

  it("merges with fixtures in every view: List months, Month days, Week blocks; gates are a typed source that is empty", () => {
    const fixtures = [fx({ id: "f1", date: "2026-10-29" }), fx({ id: "f2", scheduledTime: { start: "2026-11-05T22:00:00.000Z", end: "2026-11-06T00:00:00.000Z", agreedAt: "2026-11-01T00:00:00.000Z" } })];
    const items = calendarItems([(c) => fixtureItems(fixtures, c), (c) => leagueEventItems([ev()], c), gateItems()], NY);
    expect(items.map((i) => `${i.day} ${i.type}`)).toEqual(["2026-10-29 fixture", "2026-10-29 league-event", "2026-11-05 fixture", "2026-11-05 league-event"]);
    expect(itemsByDay(items).get("2026-10-29")!.map((i) => i.type)).toEqual(["fixture", "league-event"]); // all-day first
    expect(listMonths(items).map((m) => [m.label, m.count])).toEqual([["October 2026", 2], ["November 2026", 2]]);
    const week = items.filter((i) => i.day >= "2026-11-02" && i.day <= "2026-11-08");
    const hours = hourRange(week, NY.zone);
    const blocks = dayBlocks(week, "2026-11-05", NY.zone, hours);
    expect(blocks.map((b) => [b.item.type, b.lane, b.lanes])).toEqual([["fixture", 0, 1], ["league-event", 0, 1]]); // 17:00-19:00 then 19:00-22:00: no overlap
    expect(gateItems()(NY)).toEqual([]);
    const g = gateItems([{ id: "g1", title: "Redraft opens", opensAt: "2026-11-01T14:00:00.000Z", step: "Redraft" }])(NY);
    expect(g).toMatchObject([{ key: "gate:g1", type: "gate", day: "2026-11-01", time: "09:00", target: "dialog" }]);
  });

  it("the Calendar tab shows for League Events alone (no dated fixture)", () => {
    const base = { seasons: [{ playedCount: 0 }], current: { teamCount: 0, fixtureCount: 0 }, season: { teams: [], fixtures: [] } };
    expect(leagueFacts(base).calendar).toBe(false);
    expect(leagueFacts({ ...base, events: 1 }).calendar).toBe(true);
  });
});

describe("League Events: dialog text, editor rules, Schedule timeline", () => {
  it("when text in the league zone; spans days spelled out", () => {
    expect(whenText(ev().occurrences[1]!, "America/New_York")).toBe("Thu 5 Nov 2026, 19:00 to 22:00");
    expect(whenText({ start: "2026-11-07T15:00:00.000Z", end: "2026-11-08T23:00:00.000Z" }, "America/New_York")).toBe("Sat 7 Nov 2026, 10:00 to Sun 8 Nov 2026, 18:00");
  });

  it("a new event starts next Thursday 19:00-22:00; the payload sends wall-clock times; inline errors mirror the server", () => {
    const f = blankForm(Date.parse("2026-10-26T12:00:00.000Z"), "America/New_York"); // a Monday
    expect(f).toMatchObject({ start: "2026-10-29T19:00", end: "2026-10-29T22:00", type: "league-night", remind: true, announce: true, repeat: false });
    expect(formError(f)).toEqual({ field: "title", text: "Give the event a title." });
    f.title = "Night";
    expect(formError(f)).toBeUndefined();
    expect(formError({ ...f, end: "2026-10-29T18:00" })?.field).toBe("end");
    expect(formError({ ...f, locationKind: "online", locationText: "ftp://x" })?.field).toBe("location");
    expect(formError({ ...f, repeat: true, everyWeeks: 0 })?.field).toBe("everyWeeks");
    expect(formError({ ...f, repeat: true, until: "2026-10-01" })?.field).toBe("until");
    expect(payloadOf({ ...f, link: "season:season-7", repeat: true, everyWeeks: 2, until: "2026-12-31" })).toEqual({
      title: "Night", type: "league-night", start: "2026-10-29T19:00", end: "2026-10-29T22:00", location: { kind: "venue", text: "" }, description: "",
      link: { kind: "season", id: "season-7" }, recurrence: { everyWeeks: 2, until: "2026-12-31" }, remind: true, announce: true,
    });
    expect(formOf(ev({ remind: false, announce: false }))).toMatchObject({ repeat: true, everyWeeks: 1, until: "2026-11-05", remind: false, announce: false });
  });

  it("the timeline groups entries by day in the league zone, gates beside League Events", () => {
    const entries: ScheduleEntry[] = [
      { kind: "league-event", key: "league-event:e1:2026-11-05T19:00", start: "2026-11-06T00:00:00.000Z", end: "2026-11-06T03:00:00.000Z", title: "Night", detail: "League night", eventId: "e1", type: "league-night" },
      { kind: "gate", key: "gate:g1", start: "2026-11-05T15:00:00.000Z", title: "Redraft opens", detail: "Redraft", gateId: "g1", step: "redraft" },
    ];
    expect(timelineDays(entries, "America/New_York").map((d) => [d.label, d.entries.map((e) => `${e.time} ${e.kind}`)])).toEqual([
      ["Thursday 5 November 2026", ["10:00 gate", "19:00 league-event"]],
    ]);
  });
});

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
function mockFetcher(routes: Record<string, unknown>): Fetcher {
  return (async (path: string, init?: { method?: string }) => {
    const hit = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    return typeof hit === "function" ? (hit as () => unknown)() : hit;
  }) as Fetcher;
}

describe("League Events: server-rendered", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, league, vueRouter, renderer, dialog, editor, discord] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/LeagueEventDialog.vue"), vite.ssrLoadModule("/src/components/LeagueEventEditor.vue"),
      vite.ssrLoadModule("/src/components/LeagueSettingsDiscordEvents.vue"),
    ]);
    mods = { app, league, vueRouter, renderer, Dialog: dialog.default, Editor: editor.default, Discord: discord.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const s7: SeasonSummary = { id: "season-7", number: 7, name: "Season 7", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 0, playedCount: 0 };
  const league: LeagueSummary = {
    id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], playOnFork: false,
    createdAt: "2026-10-01T00:00:00.000Z", seasonCount: 1, currentSeason: s7, timeZone: "America/New_York",
  };
  const season: SeasonRecord = {
    id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active", importedAt: "2026-10-01T00:00:00.000Z",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }], fixtures: [], participants: [], teams: [], honours: [], awards: [],
  };

  async function renderPage(path: string): Promise<string> {
    const f = mockFetcher({
      "/api/auth/session": { authenticated: false },
      "/api/leagues/tabbl": { league, seasons: [s7] },
      "/api/leagues/tabbl/seasons/season-7": { league, season },
      "/api/leagues/tabbl/events": { timeZone: "America/New_York", manage: false, events: [ev()] },
      "/crests/manifest.json": { crests: {} },
    });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-7");
    expect(d.state.events.map((e: LeagueEventView) => e.id)).toEqual(["e1"]);
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("Month view: League Event chips are buttons with their own type, on their days, with the time; the tab shows without dated fixtures", async () => {
    const html = await renderPage("/leagues/tabbl?tab=calendar");
    expect(html).toContain('data-view="month"');
    expect(html).toMatch(/data-day="2026-10-29"[\s\S]*?<button type="button" class="lgc-chip"[^>]*data-type="league-event"[^>]*data-target="dialog"[^>]*><span class="lgc-chip-t">19:00 Thursday league n…<\/span>/);
    expect(html).toContain('aria-label="League night: Thursday league night, 19:00. Open the event"');
    expect(html).not.toContain("No fixture of Season 7 has a date yet");
  });

  it("?event=<id> opens the event dialog: type, when in the league zone, where, repeat, the description", async () => {
    const html = await renderPage("/leagues/tabbl?tab=calendar&event=e1");
    expect(html).toContain('aria-labelledby="lev-dialog-h"');
    expect(html).toContain("Thursday league night");
    expect(html).toMatch(/data-when>(Thu 29 Oct 2026|Thu 5 Nov 2026), 19:00 to 22:00/);
    expect(html).toContain("Every week until 5 Nov 2026");
    expect(html).toContain("Example Games Club");
    expect(html).toMatch(/<strong>[\s\S]*?team[\s\S]*?<\/strong>/);
    expect(html).not.toContain("data-edit-event"); // a visitor cannot edit
  });

  async function renderComponent(component: unknown, props: Record<string, unknown>): Promise<string> {
    const blank = { render: () => null };
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [
      { path: "/leagues/:id", name: "league-detail", component: blank }, { path: "/leagues/:id/settings", name: "league-settings", component: blank }, { path: "/:p(.*)*", component: blank },
    ] });
    await router.push("/x");
    await router.isReady();
    const app = createSSRApp(component as never, props);
    app.use(router);
    return (await mods.renderer.renderToString(app)) as string;
  }

  it("the dialog for an organiser carries Edit; an online https location is a safe link", async () => {
    const html = await renderComponent(mods.Dialog, { event: ev({ location: { kind: "online", text: "https://example.com/room" } }), zone: "America/New_York", leagueId: "tabbl", manage: true, now: Date.parse("2026-10-26T12:00:00.000Z") });
    expect(html).toContain("data-edit-event");
    expect(html).toContain('href="https://example.com/room" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).toContain("Next dates");
  });

  it("the editor: What / When / Where / Coaches and Discord groups, times named in the league zone, Delete only when editing", async () => {
    const html = await renderComponent(mods.Editor, { leagueId: "tabbl", zone: "America/New_York", seasons: [{ id: "season-7", name: "Season 7" }], now: Date.parse("2026-10-26T12:00:00.000Z") });
    for (const t of ["New league event", "Times in America/New York", ">What<", ">When<", ">Where<", "Coaches and Discord", "Remind coaches 24 hours before", "League night", "Tournament day", "Season 7"]) expect(html).toContain(t);
    expect(html).toContain('value="2026-10-29T19:00"');
    expect(html).not.toContain("data-delete");
    const edit = await renderComponent(mods.Editor, { leagueId: "tabbl", zone: "America/New_York", seasons: [], event: ev({ remind: true, announce: true }) });
    expect(edit).toContain("Edit league event");
    expect(edit).toContain("data-delete");
  });

  it("Connections: without the bot the option says to add it; without a linked Discord it says to link one; with both, only the organiser's servers", async () => {
    const base = { enabled: false, guilds: [], channels: [], boundToOther: false, linked: true, cleanup: [] };
    const without = await renderComponent(mods.Discord, { leagueId: "tabbl", initial: {
      ...base, available: false, inviteUrl: "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=8589954048",
      notice: "Add the Super FUMBBL bot to your server to create Discord events",
    } });
    expect(without).toContain("Add the Super FUMBBL bot to your server to create Discord events.");
    expect(without).toMatch(/<input type="checkbox" disabled/);
    expect(without).toContain("permissions=8589954048");
    const unlinked = await renderComponent(mods.Discord, { leagueId: "tabbl", initial: {
      ...base, available: true, linked: false, notice: "Link your Discord account (Account page) to pick a server you manage",
    } });
    expect(unlinked).toContain("Link your Discord account (Account page) to pick a server you manage.");
    expect(unlinked).toContain('href="/app/account"');
    expect(unlinked).not.toContain("data-enable");
    const withBot = await renderComponent(mods.Discord, { leagueId: "tabbl", initial: {
      ...base, available: true, enabled: true, guildId: "111111111111111111", guilds: [{ id: "111111111111111111", name: "Example League Server" }],
      channels: [{ id: "333333333333333333", name: "League voice", type: "voice" }, { id: "444444444444444444", name: "Stage", type: "stage" }], notice: "",
    } });
    expect(withBot).toContain("data-enable");
    expect(withBot).toContain("Example League Server");
    expect(withBot).toContain("Stage (stage)");
    expect(withBot).toContain("servers where you can manage events");
    expect(withBot).not.toContain("data-add-bot");
  });

  it("Connections: a stopped sync says why, and dead-lettered cleanups carry 'Retry cleanup'", async () => {
    const html = await renderComponent(mods.Discord, { leagueId: "tabbl", initial: {
      available: true, linked: true, enabled: true, boundToOther: true, guilds: [], channels: [], notice: "",
      blocked: "Discord events stopped: no organiser of this league can manage events in that Discord server any more (Manage Events or Administrator).",
      cleanup: [{ eventId: "900000000000000001", title: "Thursday league night", error: "Discord is having trouble right now.", at: "2026-10-30T00:00:00.000Z" }],
    } });
    expect(html).toContain("data-blocked");
    expect(html).toContain("Discord events stopped: no organiser of this league can manage events");
    expect(html).toContain("Another organiser picked this league");
    expect(html).toContain("Turn Discord events off");
    expect(html).toContain("data-retry-cleanup");
    expect(html).toContain("Thursday league night");
    expect(html).not.toContain("900000000000000001");
  });

  it("#11 a league with no season: the Calendar shows its events and ?event= opens the dialog", async () => {
    const empty = { ...league, seasonCount: 0, currentSeason: undefined };
    const f = mockFetcher({
      "/api/auth/session": { authenticated: false },
      "/api/leagues/tabbl": { league: empty, seasons: [] },
      "/api/leagues/tabbl/events": { timeZone: "America/New_York", manage: false, events: [ev()] },
      "/crests/manifest.json": { crests: {} },
    });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    await spa.router.push("/leagues/tabbl?tab=calendar&event=e1");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html).toContain('class="lg-stack lgc"');
    expect(html).toContain('data-type="league-event"');
    expect(html).toContain('aria-labelledby="lev-dialog-h"');
  });
});
