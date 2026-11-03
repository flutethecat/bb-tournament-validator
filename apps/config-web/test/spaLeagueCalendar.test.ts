import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  agendaDays, CALENDAR_VIEW_KEY, calendarItems, dayBlocks, fixtureItems, fixtureLink, heatLevel, hourRange, initialAnchor, listMonths,
  loadCalendarView, monthWeeks, rangeLabel, saveCalendarView, shiftAnchor, shortTeam, splitOverflow, todayIn, yearMonths,
  type CalendarContext, type CalendarItem,
} from "../spa/src/leagues/seasonCalendar";
import type { LeagueFixture, LeagueSummary, SeasonRecord, SeasonSummary } from "../spa/src/leagues/types";
import { publicForkState } from "../src/leagues/forkPlay";
import { leagueSummary } from "../src/leagues/api";
import { onlineGamePageServes } from "../src/gameDetail";
import type { LeagueFixture as StoredFixture, LeagueRecord } from "../src/leagues/types";

// League Calendar tab (UX-C, owner 11-02): List / Week / Month / Year views of the season's dated fixtures in the league's
// time zone, the remembered view, the month overflow, each item's link by fixture state, and the two public fields the
// views read (the league's zone on the summary, a finished game's id on the season read).

const fx = (over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 2, table: 1,
  home: { team: "Grudge Rollers", teamId: "grudge", coach: "Ann", coachId: "Ann", race: "Human", score: null, cas: null, conceded: false },
  away: { team: "The Lady's Prized Lances", teamId: "lances", coach: "Bob", coachId: "Bob", race: "Bretonnian", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const played = (over: Partial<LeagueFixture> = {}, h = 2, a = 1): LeagueFixture => {
  const f = fx(over);
  return { ...f, home: { ...f.home, score: h, cas: 0 }, away: { ...f.away, score: a, cas: 0 } };
};
const UTC: CalendarContext = { leagueId: "tabbl", seasonId: "season-7", zone: "UTC" };
const NY: CalendarContext = { ...UTC, zone: "America/New_York" };

describe("calendar view: switching and persistence", () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } };
  };

  it("defaults to Month; remembers the viewer's pick; ignores an unknown stored value", () => {
    const s = store();
    expect(loadCalendarView(() => s)).toBe("month");
    for (const v of ["list", "week", "year", "month"] as const) {
      saveCalendarView(() => s, v);
      expect(s.data[CALENDAR_VIEW_KEY]).toBe(v);
      expect(loadCalendarView(() => s)).toBe(v);
    }
    expect(loadCalendarView(() => store({ [CALENDAR_VIEW_KEY]: "decade" }))).toBe("month");
    expect(loadCalendarView(() => undefined)).toBe("month");
  });

  it("blocked storage (throws on access, read or write) never breaks the page", () => {
    const boom = () => { throw new Error("SecurityError"); };
    expect(loadCalendarView(boom)).toBe("month");
    expect(() => saveCalendarView(boom, "week")).not.toThrow();
    const throwing = { getItem: boom, setItem: boom };
    expect(loadCalendarView(() => throwing)).toBe("month");
    expect(() => saveCalendarView(() => throwing, "year")).not.toThrow();
  });
});

describe("calendar date math", () => {
  it("steps months and years keeping the day, clamped to the month, across year boundaries", () => {
    expect(shiftAnchor("month", "2026-12-31", 1)).toBe("2027-01-31");
    expect(shiftAnchor("month", "2027-01-31", 1)).toBe("2027-02-28");
    expect(shiftAnchor("month", "2027-01-15", -1)).toBe("2026-12-15");
    expect(shiftAnchor("month", "2028-03-31", -1)).toBe("2028-02-29"); // leap year
    expect(shiftAnchor("year", "2028-02-29", 1)).toBe("2029-02-28");
    expect(shiftAnchor("year", "2026-06-10", -1)).toBe("2025-06-10");
    expect(shiftAnchor("week", "2026-12-29", 1)).toBe("2027-01-05");
    expect(shiftAnchor("week", "2027-01-02", -1)).toBe("2026-12-26");
  });

  it("labels a week across months and years, a month and a year", () => {
    // the range dash is an en dash (U+2013), written as an escape so a reader cannot mistake it for "-"
    expect(rangeLabel("week", "2026-11-04")).toBe("2 \u2013 8 Nov 2026");
    expect(rangeLabel("week", "2026-09-30")).toBe("28 Sep \u2013 4 Oct 2026");
    expect(rangeLabel("week", "2026-12-30")).toBe("28 Dec 2026 \u2013 3 Jan 2027");
    expect(rangeLabel("month", "2026-11-04")).toBe("November 2026");
    expect(rangeLabel("year", "2026-11-04")).toBe("2026");
    expect(rangeLabel("list", "2026-11-04")).toBe("");
  });

  it("month grids are Monday-first, cover the whole month and mark days outside it", () => {
    const feb = monthWeeks("2027-02-10"); // 1 Feb 2027 is a Monday, 28 days: exactly 4 rows
    expect(feb).toHaveLength(4);
    expect(feb[0]![0]).toEqual({ key: "2027-02-01", day: 1, inMonth: true });
    const nov = monthWeeks("2026-11-20"); // 1 Nov 2026 is a Sunday: 6 rows
    expect(nov).toHaveLength(6);
    expect(nov[0]![0]).toEqual({ key: "2026-10-26", day: 26, inMonth: false });
    expect(nov[0]![6]).toEqual({ key: "2026-11-01", day: 1, inMonth: true });
    expect(nov[5]![6]).toEqual({ key: "2026-12-06", day: 6, inMonth: false });
    expect(yearMonths("2026-07-01").map((m) => m.anchor)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`));
  });

  it("puts each fixture on its day and time in the LEAGUE zone (not UTC, not the viewer's)", () => {
    const late = played({ id: "late", finishedAt: "2026-11-01T03:30:00.000Z", startedAt: "2026-11-01T01:30:00.000Z" });
    expect(fixtureItems([late], UTC)[0]).toMatchObject({ day: "2026-11-01", time: "01:30" });
    expect(fixtureItems([late], NY)[0]).toMatchObject({ day: "2026-10-31", time: "21:30" });
    // a New Year's Eve game in New Zealand is already 2027 there
    const nye = fx({ id: "nye", scheduledTime: { start: "2026-12-31T12:00:00.000Z", end: "2026-12-31T14:00:00.000Z", agreedAt: "" } });
    expect(fixtureItems([nye], { ...UTC, zone: "Pacific/Auckland" })[0]).toMatchObject({ day: "2027-01-01", time: "01:00", state: "agreed" });
    // a date-only fixture is that calendar day in every zone
    expect(fixtureItems([fx({ id: "d", date: "2026-11-09" })], NY)[0]).toMatchObject({ day: "2026-11-09", allDay: true, time: "" });
    // a zone the runtime does not know reads UTC
    expect(fixtureItems([late], { ...UTC, zone: "Mars/Olympus" })[0]).toMatchObject({ day: "2026-11-01" });
    expect(todayIn(Date.parse("2026-11-01T03:30:00.000Z"), "America/New_York")).toBe("2026-10-31");
  });

  it("DST: the spring-forward and fall-back days keep wall-clock times and lay out by them", () => {
    // 8 Mar 2026, New York: 02:00 EST jumps to 03:00 EDT
    const a = fx({ id: "a", scheduledTime: { start: "2026-03-08T06:30:00.000Z", end: "2026-03-08T08:30:00.000Z", agreedAt: "" } }); // 01:30 EST
    const b = fx({ id: "b", scheduledTime: { start: "2026-03-08T19:00:00.000Z", end: "2026-03-08T21:00:00.000Z", agreedAt: "" } }); // 15:00 EDT
    const items = fixtureItems([a, b], NY);
    expect(items.map((i) => [i.day, i.time])).toEqual([["2026-03-08", "01:30"], ["2026-03-08", "15:00"]]);
    const hours = hourRange(items, NY.zone);
    expect(hours).toEqual([0, 18]); // an hour either side of the games
    const blocks = dayBlocks(items, "2026-03-08", NY.zone, hours);
    const span = 18 * 60;
    expect(blocks[0]!.top).toBeCloseTo(90 / span); // 01:30
    expect(blocks[0]!.height).toBeCloseTo(180 / span); // 01:30 -> 04:30 on the wall clock (two real hours across the gap)
    expect(blocks[1]!.top).toBeCloseTo((15 * 60) / span);
    // 1 Nov 2026: 02:00 EDT falls back to 01:00 EST; a 23:00 game is still that evening
    const c = fx({ id: "c", scheduledTime: { start: "2026-11-02T04:00:00.000Z", end: "2026-11-02T06:00:00.000Z", agreedAt: "" } });
    expect(fixtureItems([c], NY)[0]).toMatchObject({ day: "2026-11-01", time: "23:00" });
    // a game running past midnight is clipped to its day and widens the hours to 24
    const cBlocks = dayBlocks(fixtureItems([c], NY), "2026-11-01", NY.zone, hourRange(fixtureItems([c], NY), NY.zone));
    expect(hourRange(fixtureItems([c], NY), NY.zone)).toEqual([16, 24]); // at least 8 hours, never past midnight
    expect(hourRange([], NY.zone)).toEqual([8, 23]);
    expect(cBlocks[0]!.top + cBlocks[0]!.height).toBeCloseTo(1);
  });

  it("DST fall-back (New York, 1 Nov 2026): games that share the repeated hour's rows are never drawn on top of each other", () => {
    const g = (id: string, start: string, end: string) => fx({ id, scheduledTime: { start, end, agreedAt: "" } });
    // A 01:00-01:20 EDT, B 01:40-01:50 EDT, C 01:05-01:35 EST: in real time none of them meet, but A and C share rows
    const items = fixtureItems([
      g("A", "2026-11-01T05:00:00.000Z", "2026-11-01T05:20:00.000Z"),
      g("B", "2026-11-01T05:40:00.000Z", "2026-11-01T05:50:00.000Z"),
      g("C", "2026-11-01T06:05:00.000Z", "2026-11-01T06:35:00.000Z"),
    ], NY);
    expect(items.map((i) => [i.key, i.day, i.time])).toEqual([["fixture:A", "2026-11-01", "01:00"], ["fixture:B", "2026-11-01", "01:40"], ["fixture:C", "2026-11-01", "01:05"]]);
    const blocks = dayBlocks(items, "2026-11-01", NY.zone, hourRange(items, NY.zone));
    expect(blocks).toHaveLength(3);
    type B = (typeof blocks)[number];
    const overlaps = (x: B, y: B) =>
      x.top < y.top + y.height - 1e-9 && y.top < x.top + x.height - 1e-9 && x.lane / x.lanes < (y.lane + 1) / y.lanes - 1e-9 && y.lane / y.lanes < (x.lane + 1) / x.lanes - 1e-9;
    for (const x of blocks) for (const y of blocks) if (x !== y) expect(overlaps(x, y), `${x.item.key} / ${y.item.key}`).toBe(false);
    const by = Object.fromEntries(blocks.map((b) => [b.item.key, b]));
    expect([by["fixture:A"]!.lanes, by["fixture:C"]!.lanes, by["fixture:B"]!.lanes]).toEqual([2, 2, 1]);
    // a game across the repeated hour keeps its real length on the wall clock (01:30 EDT -> 01:30 EST = 60 minutes)
    const long = fixtureItems([g("L", "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z")], NY);
    const [lb] = dayBlocks(long, "2026-11-01", NY.zone, [0, 8]);
    expect(lb!.height).toBeCloseTo(60 / (8 * 60));
  });

  it("overlapping games share the column in lanes; a point-in-time result is at least 30 minutes tall", () => {
    const one = fx({ id: "1", scheduledTime: { start: "2026-11-04T18:00:00.000Z", end: "2026-11-04T20:00:00.000Z", agreedAt: "" } });
    const two = fx({ id: "2", scheduledTime: { start: "2026-11-04T19:00:00.000Z", end: "2026-11-04T21:00:00.000Z", agreedAt: "" } });
    const three = played({ id: "3", finishedAt: "2026-11-04T22:00:00.000Z" });
    const blocks = dayBlocks(fixtureItems([one, two, three], UTC), "2026-11-04", "UTC", [8, 23]);
    expect(blocks.map((b) => [b.item.key, b.lane, b.lanes])).toEqual([["fixture:1", 0, 2], ["fixture:2", 1, 2], ["fixture:3", 0, 1]]);
    expect(blocks[2]!.height).toBeCloseTo(30 / (15 * 60));
  });

  it("opens on today when the season has items this month, else on the item day nearest today", () => {
    const items = fixtureItems([fx({ id: "x", date: "2026-06-12" }), fx({ id: "y", date: "2026-09-02" })], UTC);
    expect(initialAnchor(items, "2026-06-30")).toBe("2026-06-30");
    expect(initialAnchor(items, "2026-11-03")).toBe("2026-09-02");
    expect(initialAnchor(items, "2026-01-01")).toBe("2026-06-12");
    expect(initialAnchor([], "2026-11-03")).toBe("2026-11-03");
  });
});

describe("month overflow, year heat and the phone agenda", () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => i);
  it("shows every item that fits; otherwise as many chips as the cell holds and '+N more' for the rest", () => {
    expect(splitOverflow(n(3), 3)).toEqual({ shown: [0, 1, 2], more: 0 });
    expect(splitOverflow(n(4), 3)).toEqual({ shown: [0, 1, 2], more: 1 });
    expect(splitOverflow(n(9), 3)).toEqual({ shown: [0, 1, 2], more: 6 });
    expect(splitOverflow(n(2), 1)).toEqual({ shown: [0], more: 1 });
    expect(splitOverflow(n(2), 0)).toEqual({ shown: [0], more: 1 }); // at least one chip
    expect(splitOverflow([], 3)).toEqual({ shown: [], more: 0 });
  });

  it("year heat by the day's fixture count", () => {
    expect([0, 1, 2, 3, 4, 12].map(heatLevel)).toEqual([0, 1, 2, 2, 3, 3]);
  });

  it("the agenda lists the month's days with items (today included), in time order", () => {
    const items = fixtureItems([
      fx({ id: "b", scheduledTime: { start: "2026-11-04T20:00:00.000Z", end: "2026-11-04T22:00:00.000Z", agreedAt: "" } }),
      fx({ id: "a", date: "2026-11-04" }),
      fx({ id: "c", date: "2026-12-01" }),
    ], UTC);
    const days = agendaDays(items, "2026-11-20", "2026-11-03");
    expect(days.map((d) => [d.key, d.items.map((i) => i.key)])).toEqual([["2026-11-03", []], ["2026-11-04", ["fixture:a", "fixture:b"]]]);
  });

  it("sources merge and sort (the extension point for League Events, deadlines and gates)", () => {
    const deadline = (ctx: CalendarContext): CalendarItem[] => [{
      key: "deadline:r3", type: "deadline", day: "2026-11-04", allDay: true, time: "", title: "Round 3 deadline", short: "Round 3",
      result: "", state: "scheduled", detail: "", to: `/leagues/${ctx.leagueId}?tab=fixtures`, target: "summary", label: "Round 3 deadline",
    }];
    const items = calendarItems([(c) => fixtureItems([fx({ id: "z", date: "2026-11-05" })], c), deadline], UTC);
    expect(items.map((i) => [i.type, i.day])).toEqual([["deadline", "2026-11-04"], ["fixture", "2026-11-05"]]);
    expect(listMonths(items)[0]!.count).toBe(2);
  });

  it("chip names are short: no leading 'The', whole words", () => {
    // the cut is marked with an ellipsis character (U+2026), not three dots
    expect(shortTeam("The Lady's Prized Lances")).toBe("Lady's Prized\u2026");
    expect(shortTeam("Sandy Bones")).toBe("Sandy Bones");
    expect(shortTeam("Supercalifragilisticexpialidocious")).toBe("Supercalifra\u2026");
  });
});

describe("calendar links by fixture state", () => {
  const LOBBY = "/leagues/tabbl/seasons/season-7/fixtures/f1/lobby";
  it("unplayed opens the fixture summary; played opens its game page when the site holds one, else the summary", () => {
    expect(fixtureLink(fx(), UTC)).toEqual({ to: LOBBY, target: "summary" });
    expect(fixtureLink(fx({ fork: { status: "scheduled", gameId: "g9" } }), UTC)).toEqual({ to: LOBBY, target: "summary" });
    expect(fixtureLink(played(), UTC)).toEqual({ to: LOBBY, target: "summary" });
    expect(fixtureLink(played({ fork: { status: "finished" } }), UTC)).toEqual({ to: LOBBY, target: "summary" });
    expect(fixtureLink(played({ fork: { status: "finished", gameId: "g42" } }), UTC)).toEqual({ to: "/games/online/g42", target: "game" });
    // a suspended 0-0 row is not played: its summary, even with a game id
    const suspended = { ...played({ suspended: true, fork: { status: "finished", gameId: "g1" } }, 0, 0) };
    expect(fixtureLink(suspended, UTC).target).toBe("summary");
    expect(fixtureLink(fx({ id: "a b/c" }), UTC).to).toBe("/leagues/tabbl/seasons/season-7/fixtures/a%20b%2Fc/lobby");
  });

  it("each item's accessible name says where it goes", () => {
    const [game] = fixtureItems([played({ finishedAt: "2026-11-04T20:00:00.000Z", fork: { status: "finished", gameId: "g42" } })], UTC);
    expect(game!.label).toBe("Match report: Grudge Rollers 2\u20131 The Lady's Prized Lances"); // en dash, like the fixtures list's score label
    const [open] = fixtureItems([fx({ date: "2026-11-04" })], UTC);
    expect(open!.label).toBe("Fixture summary: Grudge Rollers against The Lady's Prized Lances");
  });
});

describe("calendar public data (server)", () => {
  const stored = (fork: StoredFixture["fork"]): StoredFixture => ({ ...(fx() as unknown as StoredFixture), fork });
  it("a season read carries a finished game's id only when its game page can serve it, never a live game's", () => {
    const base = { teams: { home: { teamId: "t1", coach: "Ann", builtAt: "x" } }, log: [{ at: "", by: "Ann", text: "x" }] } as never;
    const result = { gameId: "g42", source: "full", appliedAt: "2026-10-20T00:00:00Z" } as never;
    const finished = stored({ ...(base as object), status: "finished", gameId: "g42", result } as never);
    expect(publicForkState(finished, () => true).fork).toEqual({ status: "finished", gameId: "g42", teams: {}, log: [] });
    // the game page cannot serve it yet (not imported into the results store), or no check is wired: no id, no dead link
    expect(publicForkState(finished, (id) => id !== "g42").fork).toEqual({ status: "finished", teams: {}, log: [] });
    expect(publicForkState(finished).fork).toEqual({ status: "finished", teams: {}, log: [] });
    expect(publicForkState(stored({ ...(base as object), status: "scheduled", gameId: "g42" } as never), () => true).fork).toEqual({ status: "scheduled", teams: {}, log: [] });
    expect(publicForkState(stored({ ...(base as object), status: "finished", gameId: "g42" } as never), () => true).fork).toEqual({ status: "finished", teams: {}, log: [] });
  });

  it("the game page check: a public fork row for that id in the results store, the page's safe id alphabet", () => {
    expect(onlineGamePageServes("g42", { gameId: "g42", source: "fork" } as never)).toBe(true);
    expect(onlineGamePageServes("g42", undefined)).toBe(false); // not imported yet: the Calendar links the summary
    expect(onlineGamePageServes("g42", { gameId: "g42", source: "fork", test: true } as never)).toBe(false);
    expect(onlineGamePageServes("g42", { gameId: "g42", source: "tabletop" } as never)).toBe(false);
    expect(onlineGamePageServes("g 42", { gameId: "g 42" } as never)).toBe(false);
  });

  it("the public league summary names the league's time zone (UTC when unset)", () => {
    const league = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", owner: "Jay", organisers: [], createdAt: "2026-01-01T00:00:00Z" } as unknown as LeagueRecord;
    expect(leagueSummary(league, []).timeZone).toBe("UTC");
    expect(leagueSummary({ ...league, timeZone: "America/New_York" }, []).timeZone).toBe("America/New_York");
  });
});

// ---- the tab server-rendered: real links, the zone, the view toggle ----

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
function mockFetcher(routes: Record<string, unknown>): Fetcher {
  return (async (path: string, init?: { method?: string }) => {
    const hit = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    return typeof hit === "function" ? (hit as () => unknown)() : hit;
  }) as Fetcher;
}

describe("Calendar tab, server-rendered", () => {
  let vite: ViteDevServer | undefined;
  let mods: {
    createSpa: (o: { history: unknown; ssr: boolean; fetcher: Fetcher }) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    league: typeof import("../spa/src/leagues/league");
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, leagueMod, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, league: leagueMod as typeof import("../spa/src/leagues/league") };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const s7: SeasonSummary = { id: "season-7", number: 7, name: "Season 7", ruleset: "BB2025", status: "active", teamCount: 2, fixtureCount: 3, playedCount: 1 };
  const league: LeagueSummary = {
    id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], playOnFork: true,
    createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1, currentSeason: s7, timeZone: "America/New_York",
  };
  const season = (fixtures: LeagueFixture[]): SeasonRecord => ({
    id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active", importedAt: "2026-10-30T00:00:00.000Z",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures, participants: [], teams: [], honours: [], awards: [],
  });

  it("Month by default: chips link the game page (played on Super FUMBBL), the summary otherwise; the zone is named", async () => {
    const fixtures = [
      played({ id: "f1", finishedAt: "2026-06-06T02:00:00.000Z", fork: { status: "finished", gameId: "g42" } }),
      played({ id: "f2", finishedAt: "2026-06-06T20:00:00.000Z" }, 1, 1),
      fx({ id: "f3", date: "2026-06-19" }),
      fx({ id: "f4" }),
    ];
    const f = mockFetcher({
      "/api/auth/session": { authenticated: false },
      "/api/leagues/tabbl": { league, seasons: [s7] },
      "/api/leagues/tabbl/seasons/season-7": () => ({ league, season: season(fixtures) }),
      "/crests/manifest.json": { crests: {} },
    });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.league.createLeagueDetail({ api: f });
    await d.load("tabbl");
    await d.ensureSeason("season-7");
    spa.app.provide(mods.league.LEAGUE_DETAIL_KEY, d);
    await spa.router.push("/leagues/tabbl?tab=calendar");
    await spa.router.isReady();
    const html = await mods.renderToString(spa.app);
    expect(html).toContain('data-view="month"');
    expect(html).toMatch(/data-view-btn="month"[^>]*aria-pressed="true"/);
    for (const v of ["list", "week", "year"]) expect(html).toMatch(new RegExp(`data-view-btn="${v}"[^>]*aria-pressed="false"`));
    expect(html).toContain("Times in America/New York");
    expect(html).toContain("June 2026");
    expect(html).toContain('href="/app/games/online/g42"');
    expect(html).toContain('href="/app/leagues/tabbl/seasons/season-7/fixtures/f2/lobby"');
    expect(html).toContain('href="/app/leagues/tabbl/seasons/season-7/fixtures/f3/lobby"');
    expect(html).toContain("1 fixture has no date yet.");
    // the game that finished at 02:00 UTC on 6 June is on the 5th in New York; chips are real links (keyboard reachable)
    expect(html).toMatch(/data-day="2026-06-05"><span class="lgc-cell-top"><span class="lgc-date"[^>]*>5<\/span><!---->(?:<\/span>)<!--\[--><a href="\/app\/games\/online\/g42" class="lgc-chip"/);
  });
});
