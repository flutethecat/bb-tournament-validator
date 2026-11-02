import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import { createSessionStore, SESSION_REVALIDATE_MS, type Fetcher } from "../spa/src/session";
import { notificationAge } from "../spa/src/home/notifications";
import { browserTimeZone, CHIP_CLASS, chipFor, formatWhen, timeLeft } from "../spa/src/home/deadlines";
import { blocksProblem, byDay, createScheduleEditor, MAX_BLOCKS, timeZoneOptions } from "../spa/src/home/schedule";
import { createCoachTree, MAX_FINISHED_TOURNAMENTS, openFixture, pickActive, TREE_REFRESH_MS, tournamentStatus, validityChip } from "../spa/src/home/tree";
import { CLOCK_TICK_MS, createClock, logDate, routerPathOf, trapTarget, typingTarget } from "../spa/src/home/shell";
import { NAV_OPEN_STORAGE_KEY, railIntercepts, readNavOpen, rememberNavOpen } from "../spa/src/home/nav";

// Shell nav trees + coach page (/app/home) + What's new (/app/whats-new). Controllers are tested directly; the views are
// server-rendered through the SPA's own Vite config (as spaShell.test.ts does), so the HTML is what build:spa compiles.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const H = 3_600_000;

type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;

// The Connections table rows GET /api/me/profile carries (src/auth/connections.ts), in each state the page draws.
const nafFields = (nafName: string, nafId: string) => [
  { name: "nafName", label: "NAF coach name", inputmode: "text", maxlength: 60, value: nafName },
  { name: "nafId", label: "NAF number", inputmode: "numeric", maxlength: 10, value: nafId },
];
const connDiscord = { id: "discord", label: "Discord", kind: "oauth", icon: "/icons/ui/action-pass.png", status: "linked", identity: "alice_dc", note: "You sign in with this Discord account. It can't be changed here.", actions: [] };
const connNafVerified = {
  id: "naf", label: "NAF", kind: "lookup", icon: "/icons/ui/dedicated_fans.png", status: "verified", identity: "Alice N · #1234", verifiedAt: "2026-10-30T09:00:00.000Z",
  note: "Checked against the public NAF coach page: the record exists and matches. The NAF has no sign-in, so this does not prove the record is yours. Editing your NAF name or number clears the check.",
  actions: ["reverify", "unlink"], linkVia: { mode: "form", endpoint: "/api/me/connections/naf", fields: nafFields("Alice N", "1234") },
};
const connNafEmpty = {
  id: "naf", label: "NAF", kind: "lookup", icon: "/icons/ui/dedicated_fans.png", status: "not_linked", identity: "", note: "Link your NAF record: we check your name and number against the public NAF coach page.",
  actions: ["link"], linkVia: { mode: "form", endpoint: "/api/me/connections/naf", fields: nafFields("", "") },
};
const connFumbblEmpty = { id: "fumbbl", label: "FUMBBL", kind: "claim", icon: "/icons/ui/football-helmet.png", status: "not_linked", identity: "", note: "Add your fumbbl.com account name in the FUMBBL name field above.", actions: ["link"], linkVia: { mode: "field", field: "fumbblName" } };
const connFumbblLocked = { ...connFumbblEmpty, status: "linked", identity: "LinkedF", locked: true, note: "Locked by the bot registry (tournament registration); an organiser can change it.", actions: [] };
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body: unknown }> } {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = routes[`${method} ${path}`] !== undefined ? `${method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const summary = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, name, status, format: "swiss", packageName: "P", maxPlayers: 8, roundCount: 3, currentRound: 1, ...extra,
});
const side = (entrantId: string, coach: string) => ({ entrantId, teamId: `team-${entrantId}`, coach: { ffbCoachId: coach } });
const deadlinesBody = () => ({
  timezone: "America/New_York",
  deadlines: [
    { id: "round:m1", kind: "round", title: "Round 2 vs Bob", detail: "Spring Cup", at: new Date(Date.now() + 5 * H).toISOString(), chip: "urgent", link: "/tournaments/t1?tab=rounds" },
    { id: "reg:t2", kind: "registration", title: "Registration closes", detail: "Autumn Open", at: new Date(Date.now() + 200 * H).toISOString(), chip: "ok", link: "/tournaments/t2" },
  ],
});

function signedInRoutes(): Routes {
  return {
    "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
    // ?coach=me is filtered on the server; the client still drops anything without a live entry of its own
    "/api/fork/tournaments?coach=me&limit=12": {
      tournaments: [summary("t1", "Spring Cup", "active", { myEntrantId: "e1" }), summary("t9", "Not mine", "active"), summary("t3", "Dropped Cup", "active", { myEntrantId: "e7", myDroppedAt: "2026-10-01T00:00:00Z" })],
      hasMore: false,
    },
    "/api/fork/tournaments?status=draft&coach=me&limit=12": { tournaments: [summary("t2", "Autumn Open", "draft", { myEntrantId: "e5" })], hasMore: false },
    "/api/tournaments/t1": {
      tournament: summary("t1", "Spring Cup", "active"),
      entrants: [
        { id: "e1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc", submission: { submittedAt: "x", valid: true, problemCount: 0 } },
        { id: "e2", seed: 2, coachId: "Bob", teamId: "tm2", teamName: "Bob Elves", race: "Wood Elf" },
      ],
      rounds: [],
      scheduledMatches: [
        { id: "m0", roundNumber: 1, status: "completed", home: side("e1", "Alice"), away: side("e2", "Bob"), result: { homeScore: 1, awayScore: 0 } },
        { id: "m1", roundNumber: 2, status: "scheduled", home: side("e2", "Bob"), away: side("e1", "Alice") },
      ],
    },
    "/api/tournaments/t2": {
      tournament: summary("t2", "Autumn Open", "draft"),
      entrants: [{ id: "e5", seed: 1, coachId: "Alice", teamId: "tm5", teamName: "Alice Dwarfs", race: "Dwarf", submission: { submittedAt: "x", valid: false, problemCount: 2 } }],
      rounds: [],
    },
    "/api/tabletop/fixtures": { fixtures: [] },
    "/api/me/deadlines": deadlinesBody(),
    "/crests/manifest.json": { crests: { orc: "crests/orc.png", dwarf: "crests/dwarf.png" } },
    "/api/account": { ffbCoachId: "Alice" },
    "/api/me/profile": {
      coach: "Alice", displayName: "Ally", fumbblName: "", fumbblLinked: false, nafName: "Alice N", nafId: "1234", avatar: "https://cdn.example.test/a.png",
      avatarSource: "discord", discord: { linked: true, username: "alice_dc" }, connections: [connDiscord, connNafVerified, connFumbblEmpty],
    },
    "/api/tabletop/saves?coach=Alice": { coach: "Alice", saves: [], teams: [{ ref: "library:1", name: "Alice Orcs", race: "Orc", tv: 1100000, registered: [{ id: "t1", name: "Spring Cup" }], actions: { count: 2, items: ["#2 P2: finish the advancement roll", "Spring Cup: 1 roster problem"] } }, { ref: "save:2", name: "Nameless", race: "", tv: null, registered: [], actions: { count: 0, items: [] } }] },
    "/api/me/scheduling": { timezone: "Europe/London", availability: [{ day: 0, start: "19:00", end: "22:00" }, { day: 5, start: "10:00", end: "14:00" }] },
    "/api/build-log": {
      entries: Array.from({ length: 6 }, (_, i) => ({ date: `2026-10-${String(30 - i).padStart(2, "0")}`, title: `Entry ${i + 1}`, body: `Body ${i + 1}`, links: i === 0 ? [{ label: "Tournaments", href: "/app/tournaments" }, { label: "Elsewhere", href: "https://example.test/x" }] : [] })),
    },
  };
}

// ---------------------------------------------------------------- controllers

describe("deadline helpers", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() + h * H).toISOString();
  it("chip classes by horizon: green > 72 h, amber < 72 h, scarlet < 24 h, grey overdue", () => {
    expect(CHIP_CLASS[chipFor(at(80), now)]).toBe("hm-chip-ok");
    expect(CHIP_CLASS[chipFor(at(48), now)]).toBe("hm-chip-soon");
    expect(CHIP_CLASS[chipFor(at(3), now)]).toBe("hm-chip-urgent");
    expect(CHIP_CLASS[chipFor(at(-1), now)]).toBe("hm-chip-overdue");
  });
  it("time left and the time in the coach's timezone", () => {
    expect(timeLeft(at(100), now)).toBe("in 4 d");
    expect(timeLeft(at(5), now)).toBe("in 5 h");
    expect(timeLeft(at(0.25), now)).toBe("in 15 min");
    expect(timeLeft(at(-3), now)).toBe("3 h ago");
    // 12:00 UTC on Fri 30 Oct 2026 = 08:00 in New York (EDT), 21:00 in Tokyo
    expect(formatWhen(now.toISOString(), "America/New_York")).toBe("Fri 30 Oct, 08:00");
    expect(formatWhen(now.toISOString(), "Asia/Tokyo")).toBe("Fri 30 Oct, 21:00");
    expect(formatWhen(now.toISOString(), "Not/AZone")).toBe("Fri 30 Oct, 12:00");
    expect(browserTimeZone()).toBeTruthy();
  });
});

describe("availability editor", () => {
  it("validates blocks like the server: HH:MM, start < end, no repeats, at most 21", () => {
    expect(blocksProblem([{ day: 0, start: "18:00", end: "21:00" }])).toBe("");
    expect(blocksProblem([{ day: 2, start: "21:00", end: "18:00" }])).toMatch(/start must be before the end/);
    expect(blocksProblem([{ day: 2, start: "9:00", end: "18:00" }])).toMatch(/HH:MM/);
    expect(blocksProblem([{ day: 9, start: "09:00", end: "18:00" }])).toMatch(/Pick a day/);
    expect(blocksProblem([{ day: 1, start: "09:00", end: "10:00" }, { day: 1, start: "09:00", end: "10:00" }])).toMatch(/overlaps/);
    // intersecting blocks on one day are refused (like the server); touching ones and other days are fine
    expect(blocksProblem([{ day: 0, start: "18:00", end: "21:00" }, { day: 0, start: "19:00", end: "20:00" }])).toBe("Mon 19:00-20:00 overlaps 18:00-21:00.");
    expect(blocksProblem([{ day: 0, start: "19:00", end: "21:00" }, { day: 0, start: "18:00", end: "19:00" }, { day: 1, start: "18:30", end: "20:00" }])).toBe("");
    expect(blocksProblem(Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ day: i % 7, start: "09:00", end: `1${i % 10}:00` })))).toMatch(/At most 21/);
    expect(byDay([{ day: 6, start: "12:00", end: "13:00" }, { day: 6, start: "09:00", end: "10:00" }])[6]!.map((b) => b.start)).toEqual(["09:00", "12:00"]);
    expect(byDay([{ day: 6, start: "12:00", end: "13:00" }, { day: 6, start: "09:00", end: "10:00" }], { sort: false })[6]!.map((b) => b.start)).toEqual(["12:00", "09:00"]);
    expect(timeZoneOptions("Odd/Zone")[0]).toBe("Odd/Zone");
  });

  it("detects the timezone until one is saved, refuses a bad block locally, and PUTs the week", async () => {
    const f = mockFetcher({
      "GET /api/me/scheduling": { timezone: "", availability: [] },
      "PUT /api/me/scheduling": (body: unknown) => body,
    });
    const ed = createScheduleEditor({ api: f, detect: () => "Europe/Berlin" });
    await ed.load();
    expect(ed.state).toMatchObject({ timezone: "Europe/Berlin", detected: true, blocks: [] });
    ed.addBlock(4, "21:00", "19:00");
    expect(await ed.save()).toBe(false);
    expect(ed.state.error).toMatch(/start must be before the end/);
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
    ed.updateBlock(ed.state.blocks[0]!, { start: "18:00" });
    expect(await ed.save()).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ method: "PUT", path: "/api/me/scheduling", body: { timezone: "Europe/Berlin", availability: [{ day: 4, start: "18:00", end: "19:00" }] } });
    expect(ed.state).toMatchObject({ detected: false, dirty: false, notice: "Availability saved." });
  });

  it("concurrent load() calls share one GET so a late response cannot erase an edit (Sol 10-30)", async () => {
    let release: (v: unknown) => void = () => {};
    let gets = 0;
    const f = mockFetcher({
      "GET /api/me/scheduling": () => { gets++; return new Promise((r) => { release = r; }); },
    });
    const ed = createScheduleEditor({ api: f, detect: () => "UTC" });
    const a = ed.load();
    const b = ed.load();
    expect(gets).toBe(1);
    release({ timezone: "Europe/London", availability: [] });
    await Promise.all([a, b]);
    expect(ed.state.loaded).toBe(true);
    ed.addBlock(0, "18:00", "20:00");
    expect(ed.state.blocks).toHaveLength(1);
    expect(ed.state.dirty).toBe(true);
    // a later explicit reload is a new request (the shared promise is released after settling)
    void ed.load();
    expect(gets).toBe(2);
  });

  it("a failed read keeps Save off (never PUTs an empty week), shows the error, and Retry recovers", async () => {
    let fail = true;
    const f = mockFetcher({
      "GET /api/me/scheduling": () => (fail ? new ApiError(503, "Busy.") : { timezone: "Europe/London", availability: [{ day: 2, start: "18:00", end: "20:00" }] }),
      "PUT /api/me/scheduling": (body: unknown) => body,
    });
    const ed = createScheduleEditor({ api: f, detect: () => "UTC" });
    await ed.load();
    expect(ed.state).toMatchObject({ loaded: false, loadFailed: true, blocks: [] });
    expect(ed.state.error).toContain("Busy.");
    expect(ed.addBlock(0)).toBe(false);
    expect(await ed.save()).toBe(false);
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
    fail = false;
    await ed.load();
    expect(ed.state).toMatchObject({ loaded: true, loadFailed: false, error: "", blocks: [{ day: 2, start: "18:00", end: "20:00" }] });
  });

  it("a successful save tells the shell (the nav trees refetch)", async () => {
    let saved = 0;
    const ed = createScheduleEditor({
      api: mockFetcher({ "GET /api/me/scheduling": { timezone: "UTC", availability: [] }, "PUT /api/me/scheduling": (b: unknown) => b }),
      onSaved: () => { saved++; },
    });
    await ed.load();
    await ed.save();
    expect(saved).toBe(1);
  });

  it("shows the server's refusal", async () => {
    const f = mockFetcher({ "GET /api/me/scheduling": { timezone: "UTC", availability: [] }, "PUT /api/me/scheduling": new ApiError(400, "availability can hold at most 21 blocks.") });
    const ed = createScheduleEditor({ api: f });
    await ed.load();
    expect(await ed.save()).toBe(false);
    expect(ed.state.error).toBe("availability can hold at most 21 blocks.");
  });
});

describe("nav tree controller", () => {
  it("lists the coach's live and upcoming entries (dropped and others skipped) with team, validity and fixture", async () => {
    const f = mockFetcher(signedInRoutes());
    const tree = createCoachTree({ api: f });
    await tree.load("Alice");
    expect(tree.state.tournaments.map((t) => t.id)).toEqual(["t1", "t2"]);
    const [t1, t2] = tree.state.tournaments;
    expect(t1).toMatchObject({ name: "Spring Cup", status: { label: "Live" }, to: "/tournaments/t1", fixture: { label: "Round 2 · vs Bob", to: "/tournaments/t1/fixtures/m1/lobby" } });
    expect(t1!.team).toMatchObject({ name: "Alice Orcs", race: "Orc", crest: "/crests/orc.png", validity: { label: "Valid", tone: "ok" }, to: "/tournaments/t1/team/e1" });
    expect(t2).toMatchObject({ status: { label: "Pending" }, fixture: null, team: { validity: { label: "2 problems", tone: "urgent" } } });
    expect(tree.state.deadlines).toHaveLength(2);
    expect(tree.state.timezone).toBe("America/New_York");
    expect(tree.nearestChip()).toBe("urgent");
    expect(f.calls.some((c) => c.path === "/api/tournaments/t3" || c.path === "/api/tournaments/t9")).toBe(false);
    // a second load for the same coach is cached; signing out clears the trees
    const before = f.calls.length;
    await tree.load("Alice");
    expect(f.calls.length).toBe(before);
    await tree.load("");
    expect(tree.state.tournaments).toEqual([]);
  });

  it("keeps the coach's most recent finished entries (at most 5) with the Finished chip", async () => {
    const finished = Array.from({ length: 7 }, (_, i) => summary(`f${i}`, `Old Cup ${i}`, "completed", { myEntrantId: `x${i}`, endsAt: `2026-0${i + 1}-15T00:00:00Z` }));
    const tree = createCoachTree({
      api: mockFetcher({ ...signedInRoutes(), "/api/fork/tournaments?status=completed&coach=me&limit=5": { tournaments: [...finished, summary("f9", "Theirs", "completed")], hasMore: false } }),
    });
    await tree.load("Alice");
    const done = tree.state.tournaments.filter((t) => t.status.label === "Finished");
    expect(done).toHaveLength(MAX_FINISHED_TOURNAMENTS);
    expect(done.map((t) => t.id)).toEqual(["f6", "f5", "f4", "f3", "f2"]);
    expect(tree.state.tournaments.slice(0, 2).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("refreshes at most once a minute on its own, and at once when invalidated", async () => {
    let t = 1_000_000;
    const f = mockFetcher(signedInRoutes());
    const tree = createCoachTree({ api: f, now: () => t });
    await tree.load("Alice");
    const reads = () => f.calls.filter((c) => c.path === "/api/me/deadlines").length;
    expect(reads()).toBe(1);
    t += TREE_REFRESH_MS - 1;
    await tree.refresh();
    expect(reads()).toBe(1);
    t += 1;
    await tree.refresh();
    expect(reads()).toBe(2);
    await tree.invalidate();
    expect(reads()).toBe(3);
    // invalidated mid-fetch: exactly one more fetch once the running one lands
    const running = tree.invalidate();
    void tree.invalidate();
    await running;
    for (let i = 0; i < 20 && tree.state.loading; i++) await new Promise((r) => setTimeout(r, 0));
    expect(reads()).toBe(5);
  });

  it("one shared clock ticks every 60 s while something on screen uses it", () => {
    let now = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const clock = createClock({ now: () => now, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: (h) => { cleared.push(h); } });
    const a = clock.acquire();
    const b = clock.acquire();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(CLOCK_TICK_MS);
    now = 60_000;
    timers[0]!.fn();
    expect(clock.state.now).toBe(60_000);
    a(); a();
    expect(cleared).toHaveLength(0);
    b();
    expect(cleared).toEqual([1]);
  });

  it("drawer focus trap: Tab wraps at the ends and pulls stray focus back inside", () => {
    const list = ["a", "b", "c"];
    expect(trapTarget(list, "c", false)).toBe("a");
    expect(trapTarget(list, "a", true)).toBe("c");
    expect(trapTarget(list, "b", false)).toBeUndefined();
    expect(trapTarget(list, "outside", false)).toBe("a");
    expect(trapTarget(list, null, true)).toBe("c");
    expect(trapTarget([], null, false)).toBeUndefined();
  });

  it("the recorder tells the shell when an events batch submits the match (endOfMatch), retries included, not on plain events", async () => {
    const { createRecorder } = await import("../spa/src/tabletop/recorder");
    const { memoryStorage } = await import("../spa/src/tabletop/queue");
    const base = "/api/tabletop/matches/tm_1";
    const matchView = { id: "tm_1", state: "recording", home: { coach: "Alice", teamName: "A" }, away: { coach: "Bob", teamName: "B" } };
    let down = false;
    const f = mockFetcher({
      [base]: { match: matchView, events: [] },
      [`POST ${base}/events`]: (body: unknown) => {
        if (down) return new ApiError(0, "offline");
        const events = (body as { events: Array<{ id: string; type: string }> }).events;
        const ended = events.some((e) => e.type === "endOfMatch");
        return { accepted: events.map((e) => e.id), duplicates: [], total: events.length, ...(ended ? { submitted: true, match: { ...matchView, state: "submitted" } } : {}) };
      },
      [`POST ${base}/submit`]: new ApiError(409, "This match is already submitted."),
    });
    let changed = 0;
    const timers: Array<() => void> = [];
    const rec = createRecorder("tm_1", {
      api: f, onSignedOut: () => undefined, storage: memoryStorage(), onChanged: () => { changed++; },
      setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined, setInterval: () => 0, clearInterval: () => undefined,
    });
    await rec.record({ type: "touchdown", team: "home", player: "p1" });
    expect(changed).toBe(0);
    // End and submit: the endOfMatch batch submits on the server; the follow-up /submit 409s, the shell still heard about it
    await rec.record({ type: "endOfMatch", team: "home" });
    await rec.submit();
    expect(changed).toBe(1);
    // offline: the endOfMatch waits in the queue and the retry's success notifies
    down = true;
    await rec.record({ type: "endOfMatch", team: "home" });
    expect(changed).toBe(1);
    down = false;
    timers.at(-1)!();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(changed).toBe(2);
  });

  it("a failing source leaves an empty tree, never an error", async () => {
    const tree = createCoachTree({ api: mockFetcher({}) });
    await tree.load("Alice");
    expect(tree.state).toMatchObject({ tournaments: [], deadlines: [], loaded: true });
  });

  it("status and validity chips, open fixture and the active row", () => {
    expect(tournamentStatus({ status: "draft" }, undefined).label).toBe("Pending");
    expect(tournamentStatus({ status: "draft" }, { id: "e", seed: 1, teamId: "t", submission: { submittedAt: "", valid: true, problemCount: 0 } }).label).toBe("Open");
    expect(tournamentStatus({ status: "completed" }, undefined).label).toBe("Finished");
    expect(validityChip(undefined).label).toBe("No team");
    expect(validityChip({ id: "e", seed: 1, teamId: "t", submission: { submittedAt: "", valid: false, problemCount: 1 } }).label).toBe("1 problem");
    // organiser decisions win, as on the tournament page (rosterState)
    const flags = (rosterVerified: boolean) => ({ paid: false, rosterVerified, frozen: false, checkedIn: false, active: true });
    const verified = { id: "e", seed: 1, teamId: "t", flags: flags(true), rosterVerifiedOverride: true, submission: { submittedAt: "", valid: false, problemCount: 2 } };
    const rejected = { id: "e", seed: 1, teamId: "t", flags: flags(false), rosterVerifiedOverride: false, submission: { submittedAt: "", valid: true, problemCount: 0 } };
    const validatorSaysNo = { id: "e", seed: 1, teamId: "t", flags: flags(false), submission: { submittedAt: "", valid: false, problemCount: 2 } };
    expect(validityChip(verified)).toEqual({ label: "Valid", tone: "ok" });
    expect(validityChip(rejected)).toEqual({ label: "Invalid", tone: "urgent" });
    expect(validityChip(validatorSaysNo).label).toBe("2 problems");
    expect(tournamentStatus({ status: "draft" }, verified).label).toBe("Open");
    expect(tournamentStatus({ status: "draft" }, rejected).label).toBe("Pending");
    expect(openFixture([], "e1")).toBeUndefined();
    const rows = ["/home#deadlines", "/tournaments/t1", "/tournaments/t1?tab=rounds", "/home", "/account"];
    expect(pickActive(rows, "/home#deadlines")).toBe("/home#deadlines");
    expect(pickActive(rows, "/tournaments/t1?tab=rounds")).toBe("/tournaments/t1?tab=rounds");
    expect(pickActive(rows, "/tournaments/t1?tab=standings")).toBe("/tournaments/t1");
    expect(pickActive(rows, "/home#nowhere")).toBe("/home");
    expect(pickActive(rows, "/lobby")).toBeUndefined();
  });

  it("shell helpers: build-log dates and links, typing targets", () => {
    expect(logDate("2026-10-29")).toBe("29 Oct 2026");
    expect(routerPathOf("/app/tournaments")).toBe("/tournaments");
    expect(routerPathOf("/tournaments.html")).toBeUndefined();
    expect(routerPathOf("https://example.test")).toBeUndefined();
    expect(typingTarget({ tagName: "input" } as unknown as EventTarget)).toBe(true);
    expect(typingTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
  });
});

// ---------------------------------------------------------------- server-rendered views

describe("shell nav + coach page (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => {
      app: unknown; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown } } };
      ui: { collapsed: boolean; drawerOpen: boolean; narrow: boolean };
    };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    bell: unknown; ctl: { createBell: (d: never, open?: boolean) => any }; shell: { CLOCK_KEY: symbol; createClock: typeof createClock }; notif: { useNotifications: (f: Fetcher) => { load(): Promise<void> }; NOTIFICATIONS_KEY: symbol; homeBadgeCount: (p: { unread: number; messages?: number; proposals?: number }) => number }; sess: { SESSION_KEY: symbol };
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, bell, notif, sess, ctl, shell] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/BellPopover.vue"), vite.ssrLoadModule("/src/home/notifications.ts"), vite.ssrLoadModule("/src/session.ts"),
      vite.ssrLoadModule("/src/home/bell.ts"), vite.ssrLoadModule("/src/home/shell.ts"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, bell: bell.default, notif: notif as never, sess: sess as never, ctl: ctl as never, shell: shell as never };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes, setup?: (spa: ReturnType<typeof mods.createSpa>) => void) {
    const f = mockFetcher(routes);
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    setup?.(spa);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa, f };
  }
  const navOf = (html: string) => html.slice(html.indexOf('<nav class="sf-nav"'), html.indexOf("</nav>", html.indexOf('<nav class="sf-nav"')));
  const rowFor = (html: string, href: string) => html.match(new RegExp(`<a href="${href.replace(/[?]/g, "\\?")}" class="sf-row"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? "";
  // Home is a top-level item (owner 10-30): its own anchor class, not a child row.
  const homeLink = (html: string) => navOf(html).match(/<a href="\/app\/home" class="sf-top-link"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
  const topLabels = (html: string) => [...navOf(html).matchAll(/class="sf-(?:top|head)-label">([^<]+)</g)].map((m) => m[1]);

  it("wordmark home link, bell at 0, avatar menu, and the sidebar: Home then the categories in order, each with its icon", async () => {
    const { html } = await render("/home", signedInRoutes());
    expect(html).toMatch(/<a [^>]*href="\/app\/home" class="[^"]*brand sf-wordmark"/);
    expect(html).toMatch(/class="sf-bell"[^>]*aria-label="Notifications: 0"/);
    expect(html).not.toContain('class="sf-bell-count"'); // the badge is hidden at 0
    expect(html).toContain('aria-haspopup="menu"');
    const nav = navOf(html);
    expect(nav).toContain('<nav class="sf-nav" data-collapsed="false" aria-label="Site"');
    // owner 10-30: Home, Leagues, Tournaments, Leaderboards, Help, Resources (Testing only for admins)
    expect(topLabels(html)).toEqual(["Home", "Leagues", "Tournaments", "Leaderboards", "Help", "Resources"]);
    for (const icon of ["home", "leagues", "tournaments", "leaderboards", "help", "resources"]) {
      expect(nav).toMatch(new RegExp(`<img class="sf-icon" src="/icons/nav/${icon}\.png" alt(="")? width="26" height="26">`));
    }
    expect(homeLink(html)).toBeTruthy();
    expect(nav).toMatch(/<a href="\/app\/leagues" class="sf-head-link"/);
    expect(nav).toMatch(/<a href="\/app\/leaderboards" class="sf-head-link"/);
    expect(nav).toMatch(/<a href="\/app\/help" class="sf-head-link"/);
    expect(nav).not.toContain("Coach page");
    // only categories with children carry a caret (Leagues, Tournaments, Resources), at the right end of the header;
    // Leaderboards and Help are plain header links. Resources is a toggle button, not a link
    expect((nav.match(/class="sf-caret"/g) ?? []).length).toBe(3);
    for (const id of ["leagues", "tournaments", "resources"]) expect(nav).toContain(`aria-controls="sf-tree-${id}"`);
    for (const id of ["leaderboards", "help"]) { expect(nav).not.toContain(`sf-tree-${id}`); expect(nav).not.toContain(`Expand ${id[0]!.toUpperCase()}${id.slice(1)}`); }
    expect(nav).not.toContain("Tabletop standings");
    expect(nav).not.toContain('class="sf-label">What');
    for (const head of nav.match(/<div class="sf-tree-head">[\s\S]*?<\/div>/g) ?? []) {
      if (head.includes("sf-caret")) expect(head.indexOf("sf-caret")).toBeGreaterThan(head.indexOf("sf-head-label"));
    }
    expect(nav).toMatch(/<button class="sf-head-link sf-head-toggle" type="button" aria-expanded="false" aria-controls="sf-tree-resources"/);
    // Account left the sidebar (top-bar menu); the old Pages rows are admin-only Testing
    expect(nav).not.toContain('href="/app/account"');
    for (const gone of ["/app/lobby", "/app/tabletop", "/app/team-builder"]) expect(nav).not.toContain(`href="${gone}"`);
    // Owner 10-31: action buttons under the rows: Browse Leagues; Build a team (Roster Builder) + Browse Tournaments.
    const leagues = nav.slice(nav.indexOf('data-tree="leagues"'), nav.indexOf('data-tree="tournaments"'));
    expect(leagues).toMatch(/No active leagues[\s\S]*<li class="sf-actions"><!--\[--><a href="\/app\/leagues" class="sf-nav-btn" data-action="a:leagues">Browse Leagues<\/a>/);
    const tourns = nav.slice(nav.indexOf('data-tree="tournaments"'), nav.indexOf('data-tree="leaderboards"'));
    expect(tourns).toMatch(/<li class="sf-actions"><!--\[--><a href="\/app\/tournament-team-builder" class="sf-nav-btn" data-action="a:build">Build a team<\/a><a href="\/app\/tournaments" class="sf-nav-btn" data-action="a:tournaments">Browse Tournaments<\/a>/);
    expect(nav).not.toContain("Testing");
    expect(html).not.toContain("Login with Discord");
  });

  it("resources: four outside sites, each in a new tab with noopener and a hidden note; collapsed by default", async () => {
    const nav = navOf((await render("/home", signedInRoutes())).html);
    const links = nav.match(/<a href="https:[^"]+"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links.map((l) => l.match(/href="([^"]+)"/)![1])).toEqual(["https://bloodbowlbase.ru", "https://bloodbowldave.com", "https://tabbl.org", "https://fumbbl.com"]);
    for (const l of links) {
      expect(l).toContain('target="_blank"');
      expect(l).toMatch(/rel="noopener[^"]*"/);
      expect(l).toContain('<span class="sf-sr"> (opens in a new tab)</span>');
      expect(l).toMatch(/<img class="sf-icon" src="\/icons\/nav\/[a-z]+\.png"/);
    }
    expect(nav).toMatch(/<ul id="sf-tree-resources" class="sf-rows" style="display:none;?">/);
    expect(nav).toMatch(/<ul id="sf-tree-tournaments" class="sf-rows" style="">/);
  });

  it("testing tools: site admins only, collapsed by default, with Lobby / Tabletop / Team Builder / Roster Builder / Organiser requests", async () => {
    const admin = await render("/home", { ...signedInRoutes(), "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord", admin: true } });
    expect(topLabels(admin.html).at(-1)).toBe("Testing");
    const nav = navOf(admin.html);
    expect(nav).toContain('<img class="sf-icon" src="/icons/nav/tools.png"');
    const tools = nav.slice(nav.indexOf('id="sf-tree-testing" class="sf-rows"'));
    expect(tools).toMatch(/^id="sf-tree-testing" class="sf-rows" style="display:none;?"/);
    const labels = [...tools.matchAll(/class="sf-label">([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Lobby", "Tabletop", "Team Builder", "Roster Builder", "Organiser requests"]);
    expect(nav).not.toContain('href="/app/account"');
  });

  it("category open state: a localStorage getter that throws (blocked site data) never escapes", () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    try {
      expect(() => readNavOpen()).not.toThrow();
      expect(readNavOpen()).toEqual({ leagues: true, tournaments: true, leaderboards: true, help: true, resources: false, testing: false });
      expect(() => rememberNavOpen(readNavOpen())).not.toThrow();
    } finally {
      if (had) Object.defineProperty(globalThis, "localStorage", had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("rail icons intercept only an unmodified primary click on the collapsed desktop rail", () => {
    const click = (over: Partial<MouseEvent> = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over });
    const rail = { collapsed: true, narrow: false };
    expect(railIntercepts(click(), rail)).toBe(true);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      expect(railIntercepts(click(mod), rail)).toBe(false);
    }
    expect(railIntercepts(click(), { collapsed: false, narrow: false })).toBe(false); // open bar: plain navigation
    expect(railIntercepts(click(), { collapsed: true, narrow: true })).toBe(false); // phone drawer never acts as a rail
  });

  it("session: a revoked admin flag reaches the shell on the next (throttled) revalidation; a failed read fails closed", async () => {
    let t = 1_000_000;
    let reply: unknown = { authenticated: true, coach: "Alice", authMethod: "discord", admin: true };
    const f = mockFetcher({ "/api/auth/session": () => reply });
    const s = createSessionStore(f, { now: () => t });
    await s.load();
    expect(s.admin()).toBe(true);
    reply = { authenticated: true, coach: "Alice", authMethod: "discord", admin: false };
    await s.revalidate(); // inside the floor: no read
    expect(f.calls.filter((c) => c.path === "/api/auth/session")).toHaveLength(1);
    expect(s.admin()).toBe(true);
    t += SESSION_REVALIDATE_MS;
    await s.revalidate();
    expect(f.calls.filter((c) => c.path === "/api/auth/session")).toHaveLength(2);
    expect(s.admin()).toBe(false);
    // while a later re-read is pending after a "not admin" answer, admin stays off even if the cached info said admin
    t += SESSION_REVALIDATE_MS;
    reply = new ApiError(401, "Sign in");
    const pending = s.revalidate();
    s.state.info = { authenticated: true, coach: "Alice", authMethod: "discord", admin: true };
    expect(s.state.status).toBe("loading");
    expect(s.admin()).toBe(false);
    await pending;
    expect(s.state.status).toBe("error");
    expect(s.admin()).toBe(false); // a 401 drops admin
  });

  it("Testing: the rendered sidebar follows session.admin(), so a revalidated non-admin session hides it", async () => {
    let reply: unknown = { authenticated: true, coach: "Alice", authMethod: "discord", admin: true };
    const { html, spa } = await render("/home", { ...signedInRoutes(), "/api/auth/session": () => reply });
    expect(navOf(html)).toContain("Testing");
    reply = { authenticated: true, coach: "Alice", authMethod: "discord", admin: false };
    await spa.session.load(true);
    expect(navOf(await mods.renderToString(spa.app))).not.toContain("Testing");
  });

  it("collapsed rail: every icon keeps an accessible name (visually hidden label, title tooltip)", async () => {
    const { html } = await render("/home", signedInRoutes(), (spa) => { spa.ui.collapsed = true; });
    const nav = navOf(html);
    expect(nav).toMatch(/<a href="\/app\/home" class="sf-top-link"[^>]*title="Home"[^>]*><img [^>]*><span class="sf-top-label">Home<\/span>/);
    for (const label of ["Leagues", "Tournaments", "Leaderboards", "Help", "Resources"]) {
      expect(nav).toMatch(new RegExp(`class="sf-head-link[^"]*"[^>]*title="${label}"[^>]*><img [^>]*><span class="sf-head-label">${label}</span>`));
    }
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    const rail = css.slice(css.indexOf("@media (min-width: 1024px)"), css.indexOf("/* under 1024"));
    expect(rail).not.toMatch(/\.sf-(?:head|top)-label[^{]*\{ display: none/);
    expect(rail).toMatch(/\.sf-nav\[data-collapsed="true"\] \.sf-top-label \{ position: absolute; width: 1px; height: 1px;[^}]*clip: rect\(0 0 0 0\)/);
    // the open bar carries no tooltip (the label is visible)
    expect(navOf((await render("/home", signedInRoutes())).html)).not.toContain('title="Home"');
  });

  it("category open state: defaults, remembered per category, bad storage falls back", () => {
    const store: Record<string, string> = {};
    const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    expect(readNavOpen(storage)).toEqual({ leagues: true, tournaments: true, leaderboards: true, help: true, resources: false, testing: false });
    rememberNavOpen({ ...readNavOpen(storage), help: false, resources: true }, storage);
    expect(readNavOpen(storage)).toMatchObject({ help: false, resources: true, leagues: true });
    store[NAV_OPEN_STORAGE_KEY] = "{not json";
    expect(readNavOpen(storage).resources).toBe(false);
    expect(readNavOpen({ getItem: () => { throw new Error("blocked"); } }).help).toBe(true);
    expect(() => rememberNavOpen(readNavOpen(storage), { setItem: () => { throw new Error("full"); } })).not.toThrow();
  });

  it("the bell is a button (aria-expanded false) and the popover stays closed until clicked", async () => {
    const { html } = await render("/home", signedInRoutes());
    expect(html).toMatch(/<button class="sf-bell" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Notifications: 0"/);
    expect(html).not.toContain("sf-bell-pop");
  });

  async function renderBell(rows: unknown[], unread: number, routes: Routes = {}) {
    const f = mockFetcher({ ...signedInRoutes(), "/api/me/notifications?limit=50": { notifications: rows, unread }, ...routes });
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await spa.router.push("/home");
    await spa.router.isReady();
    await spa.session.load?.();
    const store = mods.notif.useNotifications(f);
    await store.load();
    const app = createSSRApp(mods.bell as never, { initialOpen: true, now: Date.parse("2026-10-29T12:00:00Z") });
    app.use(spa.router as never);
    app.provide(mods.notif.NOTIFICATIONS_KEY, store);
    app.provide(mods.sess.SESSION_KEY, spa.session);
    app.provide(mods.shell.CLOCK_KEY, spa.clock);
    return { html: await mods.renderToString(app), f };
  }
  const nrow = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `n${n}`, type: "organiser-message", title: `Title ${n}`, body: `Body ${n}`, link: "/app/home", at: new Date(Date.parse("2026-10-29T12:00:00Z") - n * 60_000).toISOString(), from: "Veers", ...extra,
  });

  it("bell popover: nothing to read when empty; caption, no Mark all read, All notifications link", async () => {
    const { html } = await renderBell([], 0);
    expect(html).toContain('role="dialog" aria-label="Notifications"');
    expect(html).toContain("Nothing to read!");
    expect(html).toContain("All read");
    expect(html).not.toContain("Mark all read");
    expect(html).not.toContain('class="nf-row"');
    expect(html).toMatch(/href="\/app\/home#notifications"[^>]*>All notifications</);
  });

  it("bell popover: the 8 most recent of 10 rows, newest first, with the unread caption and Mark all read", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => nrow(i + 1));
    const { html } = await renderBell(rows, 10);
    const titles = html.match(/Title \d+/g) ?? [];
    expect(titles).toEqual(Array.from({ length: 8 }, (_, i) => `Title ${i + 1}`));
    expect(html).not.toContain("Title 9");
    expect(html).toContain("10 unread");
    expect(html).toContain("Mark all read");
    expect(html).not.toContain("Nothing to read!");
  });

  // The popover's handlers are the controller's (home/bell.ts); the markup binds them directly, so these drive the
  // controller with the same store the component renders. (The suite has no DOM; the markup itself is covered above.)
  async function bellFor(rows: unknown[], unread: number, opts: { writable?: boolean; open?: boolean; now?: () => number | undefined } = {}) {
    const f = mockFetcher({
      "/api/me/notifications?limit=50": { notifications: rows, unread },
      "POST /api/me/notifications/read": (body: unknown) => ({ marked: unread, unread: (body as { all?: boolean }).all ? 0 : unread - 1 }),
    });
    const store = mods.notif.useNotifications(f) as unknown as { load(): Promise<void>; loaded: { value: boolean }; unread: { value: number } };
    await store.load();
    let t = Date.parse("2026-10-29T12:00:00Z");
    const ticks: Array<() => void> = [];
    const clock = mods.shell.createClock({ now: () => t, setInterval: (fn) => { ticks.push(fn); return 1; }, clearInterval: () => undefined });
    clock.acquire(); // the mounted bell holds the tick (useNow)
    const events: string[] = [];
    const pushed: string[] = [];
    const bell = mods.ctl.createBell({
      store, writable: () => opts.writable ?? true, push: (path: string) => pushed.push(path), focusBell: () => events.push("focus-bell"), clock, now: opts.now,
    } as never, opts.open ?? true);
    return { bell, store, f, events, pushed, clock, advance: (ms: number) => { t += ms; ticks.forEach((fn) => fn()); } };
  }
  const click = (over: Record<string, unknown> = {}) => ({ defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() { this.defaultPrevented = true; }, ...over });

  it("bell popover: the Mark all read handler posts all:true and the unread count drops to 0", async () => {
    const { html } = await renderBell([nrow(1), nrow(2)], 2);
    expect(html).toMatch(/<button type="button" class="nf-btn">Mark all read<\/button>/);
    const { bell, store, f } = await bellFor([nrow(1), nrow(2)], 2);
    expect(store.unread.value).toBe(2);
    await bell.markAll();
    expect(f.calls.at(-1)).toMatchObject({ path: "/api/me/notifications/read", method: "POST", body: { all: true } });
    expect(store.unread.value).toBe(0);
  });

  it("bell popover: every close returns focus to the bell, except an outside press on another focusable control", async () => {
    const row = nrow(1);
    // choosing a row (the focused row is removed with the popover)
    let c = await bellFor([row], 1);
    c.bell.choose(row, click());
    expect(c.bell.open.value).toBe(false);
    expect(c.events).toEqual(["focus-bell"]);
    expect(c.pushed).toEqual(["/home"]);
    // Escape / All notifications / route change all call close()
    c = await bellFor([row], 1);
    c.bell.close();
    expect(c.events).toEqual(["focus-bell"]);
    // outside press on plain page: back to the bell; on another focusable control: that control keeps focus
    c = await bellFor([row], 1);
    c.bell.pressOutside(false);
    expect(c.events).toEqual(["focus-bell"]);
    c = await bellFor([row], 1);
    c.bell.pressOutside(true);
    expect(c.bell.open.value).toBe(false);
    expect(c.events).toEqual([]);
    // the bell button toggling shut also returns focus; an already-closed popover does nothing
    c = await bellFor([row], 1);
    c.bell.toggle();
    c.bell.close();
    expect(c.events).toEqual(["focus-bell"]);
  });

  it("bell popover: ages follow the shared clock instead of freezing, and the override still pins them", async () => {
    const at = new Date(Date.parse("2026-10-29T12:00:00Z") - 2 * 60_000).toISOString();
    const c = await bellFor([nrow(1, { at })], 1);
    const age = () => notificationAge(at, c.bell.nowMs());
    expect(age()).toBe("2 min");
    c.advance(3_600_000);
    expect(age()).toBe("1 h");
    const pinned = await bellFor([nrow(1, { at })], 1, { now: () => Date.parse("2026-10-29T12:05:00Z") });
    pinned.advance(3_600_000);
    expect(pinned.bell.nowMs()).toBe(Date.parse("2026-10-29T12:05:00Z"));
  });

  it("every tree row is a real link; the coach's tournaments nest under Tournaments with status, team, validity and fixture", async () => {
    const { html } = await render("/home", signedInRoutes());
    const nav = navOf(html);
    const rowTags = nav.match(/<[a-z]+ [^>]*class="sf-row"/g) ?? [];
    expect(rowTags.length).toBeGreaterThan(10);
    for (const tag of rowTags) expect(tag.startsWith("<a href=\"/app/") || tag.startsWith("<a href=\"https://")).toBe(true);
    // the coach's tournament rows sit inside the Tournaments category
    const tournaments = nav.slice(nav.indexOf('data-tree="tournaments"'), nav.indexOf('data-tree="leaderboards"'));
    for (const href of ["/app/tournaments/t1", "/app/tournaments/t1/team/e1", "/app/tournaments/t2"]) expect(tournaments).toContain(`href="${href}"`);
    expect(rowFor(nav, "/app/tournaments/t1")).toMatch(/Spring Cup[\s\S]*data-tone="ok">Live</);
    expect(rowFor(nav, "/app/tournaments/t1/team/e1")).toMatch(/src="\/crests\/orc.png"[\s\S]*Alice Orcs[\s\S]*Orc[\s\S]*>Valid</);
    expect(rowFor(nav, "/app/tournaments/t1/team/e1")).toContain('data-level="2"');
    expect(rowFor(nav, "/app/tournaments/t1/fixtures/m1/lobby")).toMatch(/data-level="3"[\s\S]*Round 2 · vs Bob/);
    expect(rowFor(nav, "/app/tournaments/t2")).toMatch(/Autumn Open[\s\S]*>Pending</);
    expect(nav).toMatch(/href="\/app\/tournaments\/t2\?tab=rounds" class="sf-row"[^>]*data-muted="true"[^>]*>[\s\S]*No fixture yet/);
    expect(nav).toContain(">2 problems<");
    expect(nav).not.toContain("Dropped Cup");
    expect(nav).not.toContain("Not mine");
    expect(nav).toMatch(/>Tournaments<\/span><\/a><span class="sf-count"[^>]*>2</);
    for (const gone of ["#deadlines", "#friends", "#messages", "#schedule", "#notifications"]) expect(nav).not.toContain(`/app/home${gone}`);
    expect(homeLink(html)).not.toContain("sf-count"); // 0 unread: no badge on Home
    // owner 10-30: no Browse rows; the headers open the lists. Leagues have no store yet: a muted note under Leagues.
    expect(nav.slice(nav.indexOf('data-tree="leagues"'), nav.indexOf('data-tree="tournaments"'))).toContain("No active leagues");
    expect(nav).not.toContain("Browse tournaments");
    expect(nav).not.toContain("No active tournaments"); // this coach has tournaments
    // the indent is 14 px per level from the row's level
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(css).toContain("calc(10px + (var(--sf-level, 1) - 1) * 14px)");
  });

  it("the shell header (and its rail collapser) stacks below the match recorder takeover", () => {
    const home = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    const tt = readFileSync(new URL("../spa/src/tabletop/tabletop.css", import.meta.url), "utf8");
    const header = Number(/\.shell-header\.sf-top \{[^}]*?z-index: (\d+)/.exec(home)?.[1]);
    const recorder = Number(/\.tt-rec \{[^}]*?z-index: (\d+)/.exec(tt)?.[1]);
    expect(header).toBeGreaterThan(0);
    expect(recorder).toBeGreaterThan(header);
  });

  it("exactly one active row (seat blue, 3 px bar) follows the route", async () => {
    const at = async (path: string) => navOf((await render(path, signedInRoutes())).html);
    const active = (nav: string) => (nav.match(/<a href="([^"]+)" class="sf-(?:row|top-link|head-link)"[^>]*data-active="true"[^>]*>/g) ?? []);
    const home = await at("/home#deadlines");
    expect(active(home)).toHaveLength(1);
    expect(active(home)[0]).toContain('href="/app/home" class="sf-top-link"');
    expect(active(home)[0]).toContain('aria-current="page"');
    const fixture = await at("/tournaments/t1/fixtures/m1/lobby");
    expect(active(fixture)).toHaveLength(1);
    expect(active(fixture)[0]).toContain('href="/app/tournaments/t1/fixtures/m1/lobby"');
    // the tournaments list: the Tournaments header is the one highlighted (the "No active ..." notes never are)
    const list = await at("/tournaments");
    expect(active(list)).toHaveLength(1);
    expect(active(list)[0]).toMatch(/href="\/app\/tournaments" class="sf-head-link" data-active="true" aria-current="page"/);
    for (const [path, href] of [["/leaderboards", "/app/leaderboards"], ["/help", "/app/help"], ["/whats-new", "/app/help"], ["/standings", "/app/leaderboards"]] as const) {
      const nav = await at(path);
      expect(active(nav)).toHaveLength(1);
      expect(active(nav)[0]).toContain(`href="${href}"`);
    }
    const leagues = await at("/leagues");
    expect(active(leagues)).toHaveLength(1);
    expect(active(leagues)[0]).toContain('href="/app/leagues"');
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sf-row\[data-active="true"\] \{[^}]*color: var\(--sf-seat-home\)[^}]*border-left-color: var\(--sf-seat-home\)/);
    expect(css).toMatch(/\.sf-row \{[^}]*border-left: 3px solid transparent/);
  });

  it("collapsed rail: the bar narrows to 56 px and shows only the top-level icons", async () => {
    const { html } = await render("/home", signedInRoutes(), (spa) => { spa.ui.collapsed = true; });
    expect(html).toContain('<nav class="sf-nav" data-collapsed="true"');
    expect(html).toContain('<div class="sf-body" data-rail="true"');
    expect(html).toContain('aria-label="Expand navigation ([)"');
    expect(navOf(html)).toContain('href="/app/tournaments/t1"');
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(css).toContain("--sf-rail-w: 56px;");
    expect(css).toContain("--sf-nav-w: 260px;");
    expect(css).toMatch(/\.sf-body\[data-rail="true"\] \{ grid-template-columns: var\(--sf-rail-w\)/);
    expect(navOf(html)).not.toContain("data-glyph"); // icons replace the letter glyphs
    expect(css).toMatch(/\.sf-nav\[data-collapsed="true"\] \.sf-count,\s*\.sf-nav\[data-collapsed="true"\] \.sf-rows \{ display: none; \}/);
    expect(css).toMatch(/\.sf-nav\[data-collapsed="true"\] \.sf-icon \{ width: 30px; height: 30px; \}/);
    expect(css).toMatch(/\.sf-icon \{ width: 26px; height: 26px;[^}]*image-rendering: pixelated/);
    expect(css).toMatch(/\.sf-rail-toggle\[data-rail="true"\] \{ left: calc\(var\(--sf-rail-w\) - 2px\); border-left: 0; border-radius: 0 4px 4px 0;/);
  });

  it("rail collapser: a tag on the sidebar's right edge at the bottom of the screen (owner 10-31), not in the header or the aside; hidden in the drawer layout", async () => {
    const open = (await render("/home", signedInRoutes())).html;
    const header = open.slice(open.indexOf("<header"), open.indexOf("</header>"));
    const aside = open.slice(open.indexOf("<aside"), open.indexOf("</aside>"));
    const afterAside = open.slice(open.indexOf("</aside>"), open.indexOf("<main"));
    expect(afterAside).toMatch(/<button class="sf-rail-toggle" type="button" data-rail="false" aria-label="Collapse navigation \(\[\)"/);
    expect(header).not.toContain("sf-rail-toggle");
    expect(aside).not.toContain("sf-rail-toggle");
    const rail = (await render("/home", signedInRoutes(), (spa) => { spa.ui.collapsed = true; })).html;
    expect(rail).toMatch(/<header class="shell-header sf-top" data-rail="true" data-title="red">/);
    expect(rail).toMatch(/<button class="sf-rail-toggle" type="button" data-rail="true" aria-label="Expand navigation \(\[\)"/);
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.sf-rail-toggle \{ position: fixed; bottom: 4px; left: calc\(var\(--sf-nav-w\) - 32px\);/);
    expect(css).toMatch(/@media \(max-width: 1023\.98px\) \{[\s\S]*?\.sf-rail-toggle \{ display: none; \}/);
    expect(css).not.toMatch(/\.sf-nav > \.sf-top-link \{ margin-right/); // Home no longer reserves room for it
  });

  it("phone drawer: inert and hidden while closed, a modal dialog while open; the desktop bar is never inert", async () => {
    const closed = (await render("/home", signedInRoutes(), (spa) => { spa.ui.narrow = true; })).html.match(/<aside [^>]*>/)![0];
    expect(closed).toMatch(/\binert\b/);
    expect(closed).toContain('aria-hidden="true"');
    const open = (await render("/home", signedInRoutes(), (spa) => { spa.ui.narrow = true; spa.ui.drawerOpen = true; })).html.match(/<aside [^>]*>/)![0];
    expect(open).not.toMatch(/\binert\b|aria-hidden/);
    expect(open).toContain('role="dialog"');
    expect(open).toContain('aria-modal="true"');
    const desktop = (await render("/home", signedInRoutes())).html.match(/<aside [^>]*>/)![0];
    expect(desktop).not.toMatch(/\binert\b|aria-hidden|role=/);
  });

  it("Home badge: the unread count on the Home item, hidden at 0, capped at 99+", async () => {
    const { html } = await render("/home", signedInRoutes(), (spa) => {
      const shared = (spa.app._context.provides as Record<symbol, { unread: { value: number } }>)[mods.notif.NOTIFICATIONS_KEY];
      shared.unread.value = 3;
    });
    expect(homeLink(html)).toMatch(/<span class="sf-top-label">Home<\/span><span class="sf-count" aria-label="3 unread">3<\/span><\/a>$/);
    expect((navOf(html).match(/aria-label="\d+ unread"/g) ?? []).length).toBe(1);
    expect(mods.notif.homeBadgeCount({ unread: 2, messages: 1, proposals: 4 })).toBe(7);
    expect(mods.notif.homeBadgeCount({ unread: 0 })).toBe(0);
    expect(mods.notif.homeBadgeCount({ unread: -2, messages: 1.9 })).toBe(1);
  });

  it("Home badge: signed out shows none even when the store still holds a count; the Home anchor is one element with or without the badge", async () => {
    const setUnread = (n: number) => (spa: { app: { _context: { provides: object } } }) => {
      (spa.app._context.provides as Record<symbol, { unread: { value: number } }>)[mods.notif.NOTIFICATIONS_KEY].unread.value = n;
    };
    const out = await render("/home", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } }, setUnread(3));
    expect(homeLink(out.html)).not.toContain("sf-count");
    const open = (html: string) => (homeLink(html).match(/^<a [^>]*>/) ?? [""])[0];
    const zero = (await render("/home", signedInRoutes(), setUnread(0))).html;
    const three = (await render("/home", signedInRoutes(), setUnread(3))).html;
    // one anchor either way (same opening tag), the badge is only a child: no anchor swap, so focus stays on it
    expect(open(zero)).toBe(open(three));
    expect((navOf(zero).match(/href="\/app\/home"/g) ?? []).length).toBe(1);
    expect((navOf(three).match(/href="\/app\/home"/g) ?? []).length).toBe(1);
    expect(homeLink(zero)).toMatch(/>Home<\/span><!--v-if--><\/a>$/);
    expect(homeLink(three)).toContain('aria-label="3 unread"');
  });

  it("notifications store: the last unsubscribe clears rows and unread so the bell agrees after sign-out", async () => {
    const f = mockFetcher({ "/api/me/notifications?limit=50": { notifications: [], unread: 4 } });
    const store = mods.notif.useNotifications(f) as unknown as { load(): Promise<void>; subscribe(): void; unsubscribe(): void; unread: { value: number }; loaded: { value: boolean } };
    await store.load();
    store.subscribe();
    expect(store.unread.value).toBe(4);
    store.unsubscribe();
    expect(store.unread.value).toBe(0);
    expect(store.loaded.value).toBe(false);
  });

  it("signed out /home is the landing: banner, welcome heading, login button, Past games; no Sign in card or test sign-in", async () => {
    const { html } = await render("/home", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
    expect(html).not.toContain("motherboard-header");
    expect(html).not.toContain("landing-banner");
    expect(html).toContain('<p class="lw-lead">Tell your league&#39;s story</p>');
    expect(html).not.toContain("using your manager");
    // order: lead, then the logo h2, then the body, then the buttons
    expect(html.indexOf("lw-lead")).toBeLessThan(html.indexOf('id="lw-welcome"'));
    expect(html.indexOf('id="lw-welcome"')).toBeLessThan(html.indexOf("lw-sub"));
    expect(html.indexOf("lw-sub")).toBeLessThan(html.indexOf("lw-cta"));
    expect(html).toContain("Run your tabletop leagues and tournaments, build rosters for your favorite tournaments, contact your players, integrate with Discord, and have detailed league stats across multiple seasons.</p>");
    expect(html).not.toContain("flat rate");
    // button row: Browse tournaments (left), Login (centre, label "Login", aria-label stays), Browse leagues (right)
    const row = html.slice(html.indexOf('class="lw-cta"'));
    const at = (needle: string) => row.indexOf(needle);
    expect(at("Browse tournaments")).toBeGreaterThan(0);
    expect(at("Browse tournaments")).toBeLessThan(at('aria-label="Login with Discord"'));
    expect(at('aria-label="Login with Discord"')).toBeLessThan(at("Browse leagues"));
    expect(row).toContain("<span>Login</span>");
    expect(row).toContain('href="/app/tournaments" class="lw-btn lw-btn-left"');
    expect(row).toContain('href="/app/leagues" class="lw-btn lw-btn-right"');
    expect(html).not.toContain("Welcome to Super FUMBBL League Manager!");
    expect(html).toContain('<h2 id="lw-welcome" class="lw-logo"><img class="lw-logo-img" src="/assets/league-manager-logo.png" alt="Super FUMBBL League Manager"');
    expect(html).toContain("Login with Discord");
    expect(html).toContain('href="/api/auth/discord/start?next=');
    expect(html).toContain('href="/app/tournaments"');
    expect(html).toContain('href="/app/leagues"');
    expect(html).toContain("rc-landing");
    expect(html).not.toContain("<h2>Sign in</h2>");
    expect(html).not.toContain("Sign in to use this page");
    expect(html.toLowerCase()).not.toContain("test sign-in");
  });

  it("a password session on /home keeps the Sign in explanation, not the welcome splash", async () => {
    const { html } = await render("/home", { "/api/auth/session": { authenticated: true, coach: "PwCoach", authMethod: "password", discordSsoEnabled: true } });
    expect(html).toContain("This page needs a Discord sign-in.");
    expect(html).toContain("<h2>Sign in</h2>");
    expect(html).not.toContain("Welcome to Super FUMBBL League Manager!");
  });

  it("signed out /account keeps the Sign in card (the test sign-in card loads client-side only when the server enables it)", async () => {
    const { html } = await render("/account", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
    expect(html).toContain("<h2>Sign in</h2>");
    expect(html).not.toContain("Welcome to Super FUMBBL League Manager!");
  });

  it("signed out /messages (list or a thread) is the Sign in card, never a crash; signed in it renders the page", async () => {
    for (const path of ["/messages", "/messages/t0123456789abcdef", "/messages?to=Bob"]) {
      const { html } = await render(path, { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
      expect(html, path).toContain("<h2>Sign in</h2>");
      expect(html, path).not.toContain("so-page");
    }
    const { html } = await render("/messages", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord", discordSsoEnabled: true } });
    expect(html).toContain('class="so-page"');
    expect(html).toContain('id="so-threads-h"');
    expect(html).toContain('id="so-blocked-h"');
  });

  it("signed out: the Coach page tree is gone, /home shows the prompt, and the trees still link", async () => {
    const { html } = await render("/home", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
    expect(html).toContain("Login with Discord");
    expect(html).not.toContain("Sign in to see your page.");
    expect(html).not.toContain("hm-grid");
    expect(navOf(html)).toContain('href="/app/tournaments"');
  });

  it("account page: no standalone Schedule panel; the Calendar band carries the Deadlines cap and a Set schedule button; the dialog is closed", async () => {
    const { html } = await render("/account", signedInRoutes());
    expect(html).not.toContain('id="schedule"');
    expect(html).not.toContain('class="hm-day-head"');
    expect(html).not.toContain('role="dialog"');
    const band = html.match(/<header class="hm-band"><h2 id="ac-calendar-h">Calendar<\/h2>[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(band).toContain(">Deadlines</a>");
    expect(band).toMatch(/<button[^>]*class="ob-btn small ac-set-schedule"[^>]*aria-haspopup="dialog"[^>]*>Set schedule<\/button>/);
    expect(html).not.toContain("inert");
  });

  it("account page: dialog open (injected controller) shows the editor with the saved zone, seven day columns, blocks, Save and Close; the page behind is inert", async () => {
    const dlg = await vite.ssrLoadModule("/src/account/scheduleDialog.ts") as { createScheduleDialog: (d: { isDirty: () => boolean; focusOpener: () => void }, open?: boolean) => unknown; SCHEDULE_DIALOG_KEY: symbol };
    const ctl = dlg.createScheduleDialog({ isDirty: () => false, focusOpener: () => {} }, true);
    const { html } = await render("/account", signedInRoutes(), (spa) => { (spa.app as { provide: (k: symbol, v: unknown) => void }).provide(dlg.SCHEDULE_DIALOG_KEY, ctl); });
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="ac-sched-h"/);
    expect(html).toMatch(/id="ac-sched-h"[^>]*>\s*Set schedule/);
    const pageTag = html.match(/<div class="hm-page ac-page"[^>]*>/)?.[0] ?? "";
    expect(pageTag).toContain("inert");
    expect(pageTag).toContain('aria-hidden="true"');
    const d = html.slice(html.indexOf('role="dialog"'));
    expect(d).toMatch(/<option value="Europe\/London" selected>/);
    expect((d.match(/class="hm-day-head"/g) ?? []).length).toBe(7);
    expect(d).toMatch(/data-day="0"[\s\S]*?value="19:00"[\s\S]*?value="22:00"/);
    expect(d).toMatch(/data-day="5"[\s\S]*?value="10:00"/);
    expect(d).toContain("2 / 21 blocks");
    expect(d).toContain("Opponents see this when they propose a time.");
    expect(d).toContain("Save availability");
    expect(d).toMatch(/<button type="button" class="sf-btn">Close<\/button>/);
  });

  it("account page: landing on #schedule opens the dialog", async () => {
    const { html } = await render("/account#schedule", signedInRoutes());
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Save availability");
  });

  it("account page: title + LED name; Identity and Calendar in the main column; Session and Teams beside", async () => {
    const { html } = await render("/account", signedInRoutes());
    expect(html).toContain(`<h1 class="sf-page-title" aria-live="polite">Account</h1>`); // the header's h1; the page itself has none
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
    const main = html.slice(html.indexOf('class="hm-col hm-col-main"'), html.indexOf('class="hm-col hm-col-side"'));
    const side = html.slice(html.indexOf('class="hm-col hm-col-side"'));
    const order = ["identity", "calendar"].map((id) => main.indexOf(`id="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const id of ["session", "teams"]) expect(side).toContain(`id="${id}"`);
    // identity: the saved fields, the avatar, Discord read-only
    expect(main).toMatch(/id="ac-display"[^>]*value="Ally"/);
    expect(main).toMatch(/id="ac-naf-name"[^>]*value="Alice N"/);
    expect(main).toMatch(/id="ac-naf-id"[^>]*value="1234"/);
    expect(main).toContain('src="https://cdn.example.test/a.png"');
    expect(main).toContain("Your avatar. Falls back to your Discord avatar."); // owner 10-31: upload control, Discord fallback
    expect(main).toContain("alice_dc");
    expect(side).toContain("Sign out");
    expect(side).toContain('href="/app/my-teams#avatars"');
    // calendar: Monday-first header, a whole-weeks grid, today marked, availability shaded on Mondays and Saturdays
    const cal = main.slice(main.indexOf('id="calendar"'));
    expect(cal.match(/class="ac-wd"[^>]*>(\w+)</g)?.map((m) => m.replace(/.*>/, "").replace("<", ""))).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect((cal.match(/role="gridcell"/g) ?? []).length % 7).toBe(0);
    expect(cal).toContain('aria-current="date"');
    const cells = cal.match(/<div class="ac-cell"[^>]*>/g) ?? [];
    for (let i = 0; i < cells.length; i++) {
      const weekday = i % 7;
      expect(cells[i]!.includes('data-avail="true"'), `cell ${i}`).toBe(weekday === 0 || weekday === 5);
    }
    // the loaded scheduling zone (London) is the calendar's authority, not the nav tree's cached one (New York)
    expect(cal).toContain("times in Europe/London");
    // the round deadline (in 5 h) sits on its London day as a scarlet chip linking to the fixture
    const at = Date.now() + 5 * H;
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
    // (a Sunday-night month end can push it past the grid's last week: then there is no cell to check)
    const cell = cal.match(new RegExp(`data-day="${key}"[\\s\\S]*?</ul>`))?.[0] ?? "";
    if (cal.includes(`data-day="${key}"`)) expect(cell).toMatch(/<a href="\/app\/tournaments\/t1\?tab=rounds" class="hm-chip ac-chip hm-chip-urgent"/);
    expect(cal).toContain('id="ac-agenda-h"');
  });

  it("account page: the Connections table replaces the Discord field: Discord read-only, NAF Verified with Re-verify / Unlink, FUMBBL via the name field", async () => {
    const { html } = await render("/account", signedInRoutes());
    const conn = html.slice(html.indexOf('class="ac-conn"'), html.indexOf("</section>", html.indexOf('class="ac-conn"')));
    expect(conn).toMatch(/<h3 id="ac-conn-h"[^>]*>Connections<\/h3>/);
    expect(html).not.toContain('<span class="ac-label">Discord</span>');
    const rowOf = (id: string) => conn.match(new RegExp(`<tr class="ac-conn-row" data-conn="${id}">[\\s\\S]*?</tr>`))?.[0] ?? "";
    expect(conn.match(/data-conn="(\w+)"/g)).toEqual(['data-conn="discord"', 'data-conn="naf"', 'data-conn="fumbbl"']);
    const discord = rowOf("discord");
    expect(discord).toContain('src="/icons/ui/action-pass.png"');
    expect(discord).toMatch(/class="[^"]*hm-chip-ok[^"]*">Linked</);
    expect(discord).toContain("alice_dc");
    expect(discord).toContain("You sign in with this Discord account.");
    expect(discord).not.toContain("<button");
    const naf = rowOf("naf");
    expect(naf).toMatch(/>Verified</);
    expect(naf).toContain("Alice N · #1234");
    expect(naf).toContain("Checked 2026-10-30");
    expect(naf).toContain("does not prove the record is yours");
    expect(naf.match(/<button[^>]*>([^<]+)<\/button>/g)?.map((b) => b.replace(/<[^>]+>/g, ""))).toEqual(["Re-verify", "Unlink"]);
    const fumbbl = rowOf("fumbbl");
    expect(fumbbl).toMatch(/>Not linked</);
    expect(fumbbl).toMatch(/<button[^>]*>Link<\/button>/);
    expect(conn).not.toContain("ac-conn-form");
    // nothing edited yet: no "saving clears the check" warning
    expect(html).not.toContain("clears the Verified check");
  });

  it("account page: NAF not linked offers Link NAF account; a registry-owned FUMBBL name is locked", async () => {
    const routes = signedInRoutes();
    routes["/api/me/profile"] = { ...(routes["/api/me/profile"] as object), nafName: "", nafId: "", fumbblName: "LinkedF", fumbblLinked: true, connections: [connDiscord, connNafEmpty, connFumbblLocked] };
    const { html } = await render("/account", routes);
    const conn = html.slice(html.indexOf('class="ac-conn"'));
    const naf = conn.match(/data-conn="naf">[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(naf).toMatch(/>Not linked</);
    expect(naf).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Link NAF account<\/button>/);
    const fumbbl = conn.match(/data-conn="fumbbl">[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(fumbbl).toMatch(/>Linked</);
    expect(fumbbl).toContain("LinkedF");
    expect(fumbbl).toContain("Locked by the bot registry");
    expect(fumbbl).not.toContain("<button");
  });

  it("account identity: the NAF link form, open, with the no-sign-in copy, both fields, Check and link and Cancel", async () => {
    const [profileMod, comp] = await Promise.all([vite.ssrLoadModule("/src/account/profile.ts"), vite.ssrLoadModule("/src/components/AccountIdentity.vue")]);
    const view = { ...(signedInRoutes()["/api/me/profile"] as object), connections: [connDiscord, connNafEmpty, connFumbblEmpty] };
    const ed = profileMod.createProfileEditor({ api: mockFetcher({ "/api/me/profile": view }) });
    await ed.load();
    ed.connections.link(connNafEmpty);
    const html = await mods.renderToString(createSSRApp(comp.default as never, { editor: ed, coach: "Alice" }));
    const form = html.slice(html.indexOf('class="ac-conn-form-row"'));
    expect(form).toMatch(/<form class="ac-conn-form" novalidate aria-label="Link NAF account">/);
    expect(form).toContain("The NAF has no sign-in, so this confirms the record exists and matches what you entered; it does not prove it is yours.");
    expect(form).toMatch(/<label for="ac-conn-naf-nafName">NAF coach name<\/label>/);
    expect(form).toMatch(/id="ac-conn-naf-nafId"[^>]*inputmode="numeric"/);
    expect(form).toMatch(/<button class="ob-btn primary small" type="submit"[^>]*>Check and link<\/button>/);
    expect(form).toContain(">Cancel</button>");
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-expanded="true"[^>]*>Link NAF account<\/button>/);

  });

  it("coach page: two-column panels, empty states, deadlines with chips in the coach's timezone, schedule grid, teams, what's new (latest 5)", async () => {
    const { html, f } = await render("/home", signedInRoutes());
    expect(html).toContain('<div class="hm-grid">');
    const main = html.slice(html.indexOf('class="hm-col hm-col-main"'), html.indexOf('class="hm-col hm-col-side"'));
    const side = html.slice(html.indexOf('class="hm-col hm-col-side"'));
    for (const id of ["whats-new", "notifications", "deadlines"]) expect(main).toContain(`id="${id}"`);
    expect(main).not.toContain('id="schedule"'); // owner 10-30: the availability editor lives on the Account page
    for (const id of ["friends", "messages", "mini-calendar", "my-teams"]) expect(side).toContain(`id="${id}"`);
    expect(side).not.toContain('id="account"'); // owner 10-30: the Account box became the Mini calendar
    // owner 10-30: Friends, Messages, Mini calendar, then My teams
    const at = (id: string) => side.indexOf(`id="${id}"`);
    const order = [at("friends"), at("messages"), at("mini-calendar"), at("my-teams")];
    expect(order.every((n) => n >= 0) && order.every((n, i) => i === 0 || n > order[i - 1]!)).toBe(true);
    const mini = side.slice(at("mini-calendar"), at("my-teams"));
    expect(mini).toContain("<h2 id=\"hm-minical-h\">Mini calendar</h2>");
    expect(mini).toMatch(/<a href="\/app\/account#calendar" class="hm-cap">Full calendar<\/a>/);
    expect(mini).toContain('aria-label="Previous month"');
    expect(mini).toContain('aria-label="Next month"');
    expect(mini).toContain('role="presentation"'); // the grid is not a tab stop farm
    expect((mini.match(/<a /g) ?? []).length).toBe(1 + 2); // Full calendar + the two upcoming events; no link per day
    const up = mini.match(/<a href="\/app\/[^"]*" class="hm-deadline"[\s\S]*?<\/a>/g) ?? [];
    expect(up).toHaveLength(2);
    expect(up[0]).toContain("Round 2 vs Bob");
    expect(up[1]).toContain("Registration closes");
    expect(mini).not.toContain("Nothing coming up.");
    expect(mini).toContain("mc-dot");
    // team tiles: registered competition + TV, red badge only when actions are outstanding
    const teamsHtml = side.slice(at("my-teams"));
    const tiles = teamsHtml.match(/<a href="\/app\/teams\/[^"]*" class="hm-team"[\s\S]*?<\/a>/g) ?? [];
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toContain('<small class="hm-team-comp">Spring Cup</small>');
    expect(tiles[0]).toContain('<small class="hm-team-tv">TV 1,100k</small>');
    expect(tiles[0]).toMatch(/<span class="sf-count hm-team-badge" role="img" aria-label="2 actions needed"[^>]*>2<\/span>/);
    expect(tiles[1]).toContain('<small class="hm-team-comp">Not registered</small>');
    expect(tiles[1]).toContain('<small class="hm-team-tv">TV —</small>');
    expect(tiles[1]).not.toContain("hm-team-badge");
    // owner 10-30: What's new sits above Notifications
    expect(main.indexOf('id="whats-new"')).toBeLessThan(main.indexOf('id="notifications"'));
    expect(main.indexOf('id="notifications"')).toBeLessThan(main.indexOf('id="deadlines"'));
    expect(html).toMatch(/id="notifications"[\s\S]*?<span>Notifications<\/span>[\s\S]*?<p class="nf-empty">Nothing yet<\/p>/);
    // deadlines: nearest first, chip class by horizon, the zone named in the band caption and used for the times
    expect(html).toContain('<span class="hm-cap">America/New_York</span>');
    const rows = html.match(/<a href="\/app\/[^"]*" class="hm-deadline">[\s\S]*?<\/a>/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('href="/app/tournaments/t1?tab=rounds"');
    expect(rows[0]).toContain("hm-chip-urgent");
    expect(rows[0]).toContain("Round 2 vs Bob");
    expect(rows[1]).toContain("hm-chip-ok");
    const firstAt = deadlinesBody().deadlines[0]!.at;
    expect(rows[0]).toContain(formatWhen(firstAt, "America/New_York").split(", ")[0]!);
    // my teams strip: crest card, blank card for a race without a crest
    // Owner 10-30: every team tile opens the team management page.
    expect(html).toMatch(/<a href="\/app\/teams\/library%3A1" class="hm-team" title="Manage Alice Orcs"><img class="hm-team-crest" src="\/crests\/orc.png"/);
    expect(html).toContain('<a href="/app/teams/save%3A2" class="hm-team" title="Manage Nameless">');
    expect(html).toContain("hm-team-blank");
    // what's new: latest 5 of 6, link to the full page
    expect((main.match(/class="hm-log-title"/g) ?? []).length).toBe(5);
    expect(main).toContain("Entry 1");
    expect(main).not.toContain("Entry 6");
    expect(main).toContain('href="/app/whats-new"');
    expect(f.calls.some((c) => c.path === "/api/build-log")).toBe(true);
    expect(html).not.toMatch(/re-roll/i);
    expect(html).not.toMatch(/\bjava\b/i);
  });

  it("coach page: the Mini calendar says so when nothing is coming up, and the grid still renders", async () => {
    const { html } = await render("/home", { ...signedInRoutes(), "/api/me/deadlines": { timezone: "America/New_York", deadlines: [] } });
    const mini = html.slice(html.indexOf('id="mini-calendar"'), html.indexOf('id="my-teams"'));
    expect(mini).toContain('<p class="hm-empty">Nothing coming up.</p>');
    expect(mini).not.toContain("mc-dot");
    expect(mini).toContain('data-today="true"');
  });

  it("what's new page: every entry, in-app links stay in the SPA, outside links open a new tab", async () => {
    const { html } = await render("/whats-new", { ...signedInRoutes(), "/api/auth/session": { authenticated: false } });
    expect((html.match(/<h3 class="hm-log-title">/g) ?? []).length).toBe(6);
    expect(html).toContain('<a href="/app/tournaments" class="">Tournaments</a>');
    expect(html).toContain('<a href="https://example.test/x" target="_blank" rel="noopener noreferrer">Elsewhere</a>');
    expect(html).toContain("30 Oct 2026");
  });

  it("layout at 375 / 1024 / 1600: drawer under 1024, one column on a phone, two columns (fluid / 380) from 1280, tokens only", () => {
    const css = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    // < 1024 (375 and 1023): the nav is an off-canvas drawer opened by the Menu button
    expect(css).toMatch(/@media \(max-width: 1023\.98px\) \{[\s\S]*?\.sf-menu \{ display: inline-flex; \}[\s\S]*?\.sf-aside \{ position: fixed;[^}]*transform: translateX\(-100%\)/);
    expect(css).toMatch(/\.sf-aside\[data-open="true"\] \{ transform: none;/);
    // >= 1024: the bar sits in the grid; 1600: the content may grow to 1600 px
    expect(css).toMatch(/\.sf-body \{ display: grid; grid-template-columns: var\(--sf-nav-w\) minmax\(0, 1fr\)/);
    expect(css).toContain("max-width: 1600px");
    // the coach page: one column by default (375), two from 1280 (1600)
    expect(css).toMatch(/\.hm-grid \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(min-width: 1280px\) \{\s*\.hm-grid \{ grid-template-columns: minmax\(0, 1fr\) 380px; \}/);
    // the week grid: 7 columns, a list of days on a phone
    expect(css).toMatch(/\.hm-week \{ display: grid; grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{\s*\.hm-week \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    // tokens only: raw colours appear only in the two token blocks (dark default, derived light preset)
    const tokenBlocks = css.match(/:root(\[data-theme="light"\])? \{[^}]*\}/g) ?? [];
    expect(tokenBlocks).toHaveLength(2);
    const rest = tokenBlocks.reduce((s, b) => s.replace(b, ""), css);
    expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
