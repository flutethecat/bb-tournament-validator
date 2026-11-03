import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { requireSession } from "../src/auth/requireSession";
import { defaultEvents, eventKeysFor } from "../src/discord/catalogue";
import { WORDS_ROT13 } from "../src/discord/profanityList";
import { leagueApi, leaguePath, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import {
  gateScheduleSource, leagueCoaches, LeagueEventNoticeCoalescer, occurrences, parseLeagueEvent, runLeagueEventReminders, scheduleEntries, LeagueEventError, SCHEDULE_SOURCES,
} from "../src/leagues/leagueEvents";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueCalendarEvent, LeagueTeam, SeasonRecord } from "../src/leagues/types";

// League Events (src/leagues/leagueEvents.ts): organiser CRUD with revisions, recurrence in the league zone across daylight
// saving, public visibility (drafts hidden), access control, CSRF / session gate coverage, coach notices, the 24-hour
// reminder (once), and the "New league event" webhook post through the cleaned sender. No network: posters are stubbed.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
/** A listed word, decoded at run time so the test source never carries it. */
const LISTED = rot13(WORDS_ROT13[1]!);
/** Monday 26 Oct 2026, 12:00 UTC (08:00 in New York, daylight time until Sunday 1 Nov). */
const NOW = new Date("2026-10-26T12:00:00.000Z");

const team = (id: string, name: string, coachId?: string): LeagueTeam => ({
  id, name, race: "Orc", coach: coachId ?? "", ...(coachId ? { coachId } : {}), teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0,
  cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [],
});
const season = (leagueId: string, n: number, status: SeasonRecord["status"] = "active", coaches: string[] = ["Ann", "Bob"]): SeasonRecord => ({
  id: `season-${n}`, leagueId, number: n, name: `Season ${n}`, sourceSlug: `season-${n}`, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [], teams: coaches.map((c, i) => team(`t${i}`, `Team ${c}`, c)), participants: [], honours: [], awards: [], unattributedStats: [],
  importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
});

const NIGHT = {
  title: "Thursday league night", type: "league-night", start: "2026-10-29T19:00", end: "2026-10-29T22:00",
  location: { kind: "venue", text: "Example Games Club" }, description: "Bring your team.",
};

describe("League Events: recurrence in the league zone", () => {
  it("weekly across the autumn change (New York, 1 Nov 2026): the wall clock stays at 19:00, the UTC instant moves", () => {
    const occ = occurrences({ start: "2026-10-29T19:00", end: "2026-10-29T22:00", recurrence: { everyWeeks: 1, until: "2026-11-12" } }, "America/New_York");
    expect(occ.map((o) => o.key)).toEqual(["2026-10-29T19:00", "2026-11-05T19:00", "2026-11-12T19:00"]);
    expect(occ.map((o) => new Date(o.start).toISOString())).toEqual(["2026-10-29T23:00:00.000Z", "2026-11-06T00:00:00.000Z", "2026-11-13T00:00:00.000Z"]);
    expect(occ.every((o) => o.end - o.start === 3 * 3_600_000)).toBe(true);
  });

  it("every 2 weeks across the spring change (London, 28 Mar 2027); `until` is inclusive; an overnight event keeps its end day", () => {
    const occ = occurrences({ start: "2027-03-21T10:00", end: "2027-03-21T12:00", recurrence: { everyWeeks: 2, until: "2027-04-04" } }, "Europe/London");
    expect(occ.map((o) => new Date(o.start).toISOString())).toEqual(["2027-03-21T10:00:00.000Z", "2027-04-04T09:00:00.000Z"]);
    const overnight = occurrences({ start: "2026-10-31T22:00", end: "2026-11-01T02:00", recurrence: { everyWeeks: 1, until: "2026-11-07" } }, "America/New_York");
    // every occurrence lasts the first one's real duration (22:00 EDT -> 02:00 EST is 5 real hours)
    expect(overnight.map((o) => (o.end - o.start) / 3_600_000)).toEqual([5, 5]);
  });

  it("#2 a repeating start the clocks skip moves forward and still ends after it starts (start + the real duration)", () => {
    // 02:30-03:00 every week: on 14 Mar 2027 (New York) 02:30 does not exist and moves to 03:30, which used to end at 03:00
    const occ = occurrences({ start: "2027-03-07T02:30", end: "2027-03-07T03:00", recurrence: { everyWeeks: 1, until: "2027-03-21" } }, "America/New_York");
    expect(occ.map((o) => new Date(o.start).toISOString())).toEqual(["2027-03-07T07:30:00.000Z", "2027-03-14T07:30:00.000Z", "2027-03-21T06:30:00.000Z"]);
    expect(occ.every((o) => o.end - o.start === 30 * 60_000)).toBe(true);
    // the editor accepts it (every occurrence checked)
    expect(() => parseLeagueEvent({ ...NIGHT, start: "2027-03-07T02:30", end: "2027-03-07T03:00", recurrence: { everyWeeks: 1, until: "2027-03-21" } }, { zone: "America/New_York", seasons: [] })).not.toThrow();
  });

  it("a single event is one occurrence; a time the clocks skip moves forward", () => {
    expect(occurrences({ start: "2026-11-05T19:00", end: "2026-11-05T20:00" }, "UTC")).toHaveLength(1);
    const gap = occurrences({ start: "2027-03-14T02:30", end: "2027-03-14T04:00" }, "America/New_York")[0]!;
    expect(new Date(gap.start).toISOString()).toBe("2027-03-14T07:30:00.000Z"); // 03:30 EDT
  });

  it("validation: title, type, end after start, length, location link, recurrence bounds, ladder link refused", () => {
    const ctx = { zone: "America/New_York", seasons: [{ id: "season-1" }] };
    const ok = parseLeagueEvent({ ...NIGHT }, ctx);
    expect(ok).toMatchObject({ type: "league-night", remind: true, announce: true, location: { kind: "venue", text: "Example Games Club" } });
    expect(parseLeagueEvent({ ...NIGHT, type: "social" }, ctx).announce).toBe(false); // on by default for league nights only
    const bad = (over: Record<string, unknown>, field: string) => {
      try { parseLeagueEvent({ ...NIGHT, ...over }, ctx); } catch (e) { expect(e).toBeInstanceOf(LeagueEventError); expect((e as LeagueEventError).field).toBe(field); return; }
      throw new Error(`accepted ${JSON.stringify(over)}`);
    };
    bad({ title: "  " }, "title");
    bad({ type: "party" }, "type");
    bad({ end: "2026-10-29T18:00" }, "end");
    bad({ end: "2026-11-06T19:01" }, "end");
    bad({ start: "2026-02-30T19:00" }, "start");
    bad({ location: { kind: "online", text: "javascript:alert(1)" } }, "location.text");
    bad({ recurrence: { everyWeeks: 13, until: "2026-12-01" } }, "recurrence.everyWeeks");
    bad({ recurrence: { everyWeeks: 1, until: "2026-10-01" } }, "recurrence.until");
    bad({ recurrence: { everyWeeks: 1, until: "2029-01-01" } }, "recurrence.until");
    bad({ link: { kind: "ladder", id: "l1" } }, "link");
    bad({ link: { kind: "season", id: "season-9" } }, "link");
    expect(parseLeagueEvent({ ...NIGHT, location: { kind: "online", text: "https://example.com/room" } }, ctx).location.text).toBe("https://example.com/room");
  });
});

describe("League Events: routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let ifMatch: string | undefined;
  let now: Date;
  let posts: DiscordPayload[];
  let notes: Array<{ coach: string; title: string; body: string; link: string }>;
  let kicks: number;
  let held: Array<() => void>;
  let clockMs: number;
  let notices: LeagueEventNoticeCoalescer;
  const deps = (): LeagueApiDeps => ({
    store,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    ifMatch,
    now: () => now,
    notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body, link: input.link }); },
    postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
    identities: () => [{ coach: "Root", level: "admin" }],
    leagueEvents: { kick: () => { kicks += 1; }, notices },
  });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const JAY = { coach: "Jay" };
  const create = async (over: Record<string, unknown> = {}, league = "tabbl", who = JAY) => {
    const r = await call("POST", `/api/leagues/${league}/events`, who, { ...NIGHT, ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as { event: { id: string; revision: number } }).event;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-cal-events-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], timeZone: "America/New_York" });
    store.upsertLeague({ id: "other", name: "Other League", fullName: "Other League", slug: "other", organisers: ["Olga"] });
    store.setSecrets("tabbl", { discordWebhookUrl: HOOK });
    store.putSeason(season("tabbl", 1, "completed", ["Old"]));
    store.putSeason(season("tabbl", 2, "active", ["Ann", "Bob", "Jay"]));
    store.putSeason(season("other", 1, "active", ["Zed"]));
    posts = []; notes = []; kicks = 0; ifMatch = undefined; now = NOW;
    held = []; clockMs = NOW.getTime();
    notices = new LeagueEventNoticeCoalescer(10 * 60_000, (fn) => { held.push(fn); }, () => clockMs);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("CRUD with revisions: create, list (public), PATCH needs the revision (428 / 409 / If-Match), DELETE needs it too", async () => {
    const ev = await create();
    expect(ev.revision).toBe(1);
    const list = await call("GET", "/api/leagues/tabbl/events");
    expect(list.status).toBe(200);
    const pub = (list.body as { timeZone: string; manage: boolean; events: Array<Record<string, unknown>> });
    expect(pub.timeZone).toBe("America/New_York");
    expect(pub.manage).toBe(false);
    expect(pub.events[0]).toMatchObject({ id: ev.id, title: "Thursday league night", typeLabel: "League night", occurrences: [{ start: "2026-10-29T23:00:00.000Z" }] });
    // public read: no organiser or Discord fields
    expect(pub.events[0]).not.toHaveProperty("remind");
    expect(pub.events[0]).not.toHaveProperty("discord");
    expect(JSON.stringify(pub)).not.toMatch(/discordSync|reminded|guildId/);

    expect((await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { title: "Moved night" })).status).toBe(428);
    expect((await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: "x", title: "Moved night" })).status).toBe(400);
    const stale = await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 7, title: "Moved night" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ revision: 1 });
    const ok = await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 1, title: "Moved night", start: "2026-10-30T19:00", end: "2026-10-30T23:00" });
    expect(ok.status).toBe(200);
    expect((ok.body as { event: { revision: number; title: string; start: string } }).event).toMatchObject({ revision: 2, title: "Moved night", start: "2026-10-30T19:00" });
    ifMatch = "W/\"2\"";
    const viaHeader = await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { description: "" });
    expect(viaHeader.status).toBe(200);
    ifMatch = undefined;
    expect((await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, JAY, {})).status).toBe(428);
    expect((await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 2 })).status).toBe(409);
    expect((await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 3 })).status).toBe(200);
    expect((await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 3 })).status).toBe(404);
    expect(store.leagueEvents("tabbl").events).toEqual([]);
    expect(kicks).toBeGreaterThanOrEqual(4); // every write kicks the Discord sync (never awaited)
  });

  it("an unreadable events file fails closed: reads and writes answer 500, nothing is overwritten", async () => {
    writeFileSync(join(store.leagueDir("tabbl"), "events.json"), "{ not json");
    expect((await call("GET", "/api/leagues/tabbl/events")).status).toBe(500);
    expect((await call("POST", "/api/leagues/tabbl/events", JAY, NIGHT)).status).toBe(500);
  });

  it("access control: anonymous 401, a coach 403, organiser of league A cannot touch league B, a site admin can", async () => {
    const ev = await create();
    expect((await call("POST", "/api/leagues/tabbl/events", undefined, NIGHT)).status).toBe(401);
    expect((await call("POST", "/api/leagues/tabbl/events", { coach: "Ann" }, NIGHT)).status).toBe(403);
    // Olga organises "other" only
    expect((await call("POST", "/api/leagues/tabbl/events", { coach: "Olga" }, NIGHT)).status).toBe(403);
    expect((await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, { coach: "Olga" }, { revision: 1, title: "Hijack" })).status).toBe(403);
    expect((await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, { coach: "Olga" }, { revision: 1 })).status).toBe(403);
    // the event id does not exist in league B: Olga's own league answers 404 for it
    expect((await call("PATCH", `/api/leagues/other/events/${ev.id}`, { coach: "Olga" }, { revision: 1, title: "Hijack" })).status).toBe(404);
    expect(store.leagueEvents("tabbl").events[0]!.title).toBe("Thursday league night");
    expect((await call("GET", "/api/leagues/tabbl/schedule", { coach: "Olga" })).status).toBe(403);
    expect((await call("GET", "/api/leagues/tabbl/events/discord", { coach: "Ann" })).status).toBe(403);
    // a site admin
    expect((await call("POST", "/api/leagues/tabbl/events", { coach: "Root", admin: true }, { ...NIGHT, title: "Admin night" })).status).toBe(201);
    // the organiser read carries the organiser fields and stays private
    const mine = await call("GET", "/api/leagues/tabbl/events", JAY);
    expect(mine.headers?.["cache-control"]).toContain("no-store");
    expect((mine.body as { manage: boolean; events: Array<Record<string, unknown>> }).events[0]).toMatchObject({ remind: true, announce: true, discord: { state: "off" } });
  });

  it("public visibility: a draft league's events are hidden from everyone but its organisers; drafts tell and post nothing", async () => {
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    const ev = await create();
    expect(notes).toEqual([]);
    expect(posts).toEqual([]);
    expect((await call("GET", "/api/leagues/tabbl/events")).status).toBe(404);
    expect((await call("GET", "/api/leagues/tabbl/events", { coach: "Ann" })).status).toBe(404);
    expect((await call("GET", "/api/leagues/tabbl/events", JAY)).status).toBe(200);
    // the reminder job skips drafts
    now = new Date("2026-10-29T00:00:00.000Z");
    expect(runLeagueEventReminders({ store, notify: () => { throw new Error("no reminders for drafts"); }, now: () => now }).reminded).toEqual([]);
    // published: visible to all
    store.updateLeague("tabbl", (l) => { l.visibility = "published"; });
    const pub = await call("GET", "/api/leagues/tabbl/events");
    expect((pub.body as { events: Array<{ id: string }> }).events.map((e) => e.id)).toEqual([ev.id]);
  });

  it("CSRF: every write to the events routes is state-changing; GETs are not and stay public through the session gate", () => {
    for (const [m, p] of [["POST", "/api/leagues/tabbl/events"], ["PATCH", "/api/leagues/tabbl/events/abc"], ["DELETE", "/api/leagues/tabbl/events/abc"], ["PATCH", "/api/leagues/tabbl/events/discord"]] as const) {
      expect(isStateChangingApiRequest(m, p), `${m} ${p}`).toBe(true);
    }
    for (const p of ["/api/leagues/tabbl/events", "/api/leagues/tabbl/schedule", "/api/leagues/tabbl/events/discord"]) expect(isStateChangingApiRequest("GET", p), p).toBe(false);
    const req = (method: string) => ({ method, headers: {} }) as IncomingMessage;
    expect(requireSession(req("GET"), "/api/leagues/tabbl/events", "").kind).toBe("allow");
    expect(requireSession(req("POST"), "/api/leagues/tabbl/events", "").kind).toBe("unauthorized");
    expect(requireSession(req("PATCH"), "/api/leagues/tabbl/events/abc", "").kind).toBe("unauthorized");
    // the sidecar-off gate (authorized()) lets every /api/leagues path through to the in-handler checks
    expect(leaguePath("/api/leagues/tabbl/events")).toEqual({ id: "tabbl", rest: ["events"] });
  });

  it("a GET never writes: reading events, the schedule and the Discord settings leaves the store untouched", async () => {
    await create();
    const before = store.version();
    await call("GET", "/api/leagues/tabbl/events");
    await call("GET", "/api/leagues/tabbl/events", JAY);
    await call("GET", "/api/leagues/tabbl/schedule", JAY);
    await call("GET", "/api/leagues/tabbl/events/discord", JAY);
    expect(store.version()).toBe(before);
  });

  it("notices: coaches of the unfinished seasons (actor excluded) on create and on a visible change; toggles alone tell nobody; delete says cancelled", async () => {
    const ev = await create();
    expect(notes.map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]); // Jay is the actor; Old's season is finished
    expect(notes[0]).toMatchObject({ title: "New league event: Thursday league night", link: `/app/leagues/tabbl?tab=calendar&event=${ev.id}` });
    expect(notes[0]!.body).toContain("Thu 29 Oct 2026, 19:00 to 22:00 (America/New York)");
    notes = [];
    clockMs += 11 * 60_000; // past the create's window
    await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 1, remind: false, announce: false });
    expect(notes).toEqual([]);
    await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 2, start: "2026-10-29T20:00", location: { kind: "online", text: "https://example.com/room" } });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ title: "League event changed: Thursday league night" });
    expect(notes[0]!.body).toContain("Time and location changed.");
    notes = [];
    await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 3 });
    expect(notes.map((n) => n.title)).toEqual(["League event cancelled: Thursday league night", "League event cancelled: Thursday league night"]);
    // a past event tells nobody
    notes = [];
    await create({ start: "2026-10-01T19:00", end: "2026-10-01T22:00" });
    expect(notes).toEqual([]);
    expect(leagueCoaches(store.seasons("tabbl"), "ann")).toEqual(["Bob", "Jay"]);
  });

  it("#9 rapid edits are coalesced: one combined 'updated' note per event per 10 minutes, the event as it ends up", async () => {
    const ev = await create();
    notes = [];
    for (const [rev, over] of [[1, { title: "Night A" }], [2, { description: "New text" }], [3, { start: "2026-10-29T20:00" }], [4, { title: "Night B" }]] as const) {
      await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: rev, ...over });
    }
    expect(notes).toEqual([]); // inside the create's window: held
    clockMs += 10 * 60_000;
    for (const fn of held.splice(0)) fn();
    expect(notes).toHaveLength(2); // one per coach
    expect(notes[0]!.title).toBe("League event updated: Night B");
    expect(notes[0]!.body).toContain("Title, description and time changed.");
    // a cancel drops anything held
    notes = [];
    clockMs += 11 * 60_000;
    await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 5, title: "Night C" }); // sent now, opens a window
    await call("PATCH", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 6, title: "Night D" }); // held
    await call("DELETE", `/api/leagues/tabbl/events/${ev.id}`, JAY, { revision: 7 });
    for (const fn of held.splice(0)) fn();
    expect(notes.map((n) => n.title)).toEqual(["League event changed: Night C", "League event changed: Night C", "League event cancelled: Night D", "League event cancelled: Night D"]);
  });

  it("#8 a draft never marks a reminder delivered; Publish sends one 'upcoming events' note for the next 7 days", async () => {
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; l.wizard = { step: 5, createdBy: "Jay" }; });
    now = new Date("2026-10-29T12:00:00.000Z"); // 11 hours before the night
    const ev = await create();
    await create({ title: "Far away", start: "2026-12-10T19:00", end: "2026-12-10T22:00" });
    expect(store.leagueEvents("tabbl").events.find((e) => e.id === ev.id)!.reminded).toBeUndefined();
    expect(notes).toEqual([]);
    const pub = await call("POST", "/api/leagues/tabbl/publish", JAY, {});
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const upcoming = notes.filter((n) => n.title === "TABBL: upcoming league events");
    expect(upcoming.map((n) => n.coach).sort()).toEqual(["Ann", "Bob", "Jay"]);
    expect(upcoming[0]!.body).toContain("Thursday league night: Thu 29 Oct 2026, 19:00 to 22:00");
    expect(upcoming[0]!.body).not.toContain("Far away");
    // the publish note covered the night inside 24 hours: no reminder on top
    expect(runLeagueEventReminders({ store, notify: () => { throw new Error("covered"); }, now: () => now }).reminded).toEqual([]);
  });

  it("reminder 24 hours before each occurrence, once (a second tick or a restart never repeats it); inside the window at creation = covered", async () => {
    const ev = await create({ recurrence: { everyWeeks: 1, until: "2026-11-05" } });
    const tick = (iso: string) => { now = new Date(iso); notes = []; return runLeagueEventReminders({ store, notify: (c, i) => notes.push({ coach: c, title: i.title, body: i.body, link: i.link }), now: () => now }); };
    expect(tick("2026-10-28T22:00:00.000Z").reminded).toEqual([]); // 25 h before the 29 Oct 23:00Z start
    expect(tick("2026-10-28T23:30:00.000Z").reminded).toEqual([`tabbl/${ev.id}/2026-10-29T19:00`]);
    expect(notes.map((n) => n.coach).sort()).toEqual(["Ann", "Bob", "Jay"]); // a reminder goes to every coach of the league
    expect(notes[0]).toMatchObject({ title: "Tomorrow: Thursday league night", link: `/app/leagues/tabbl?tab=calendar&event=${ev.id}` });
    expect(tick("2026-10-29T10:00:00.000Z").reminded).toEqual([]);
    store = new LeagueStore(dir); // a restart
    expect(tick("2026-10-29T12:00:00.000Z").reminded).toEqual([]);
    // the next week (after the clocks went back): 5 Nov 19:00 EST = 6 Nov 00:00Z
    expect(tick("2026-11-04T23:00:00.000Z").reminded).toEqual([]);
    expect(tick("2026-11-05T00:30:00.000Z").reminded).toEqual([`tabbl/${ev.id}/2026-11-05T19:00`]);
    // reminders off: nothing
    const quiet = await create({ title: "Quiet", start: "2026-11-20T19:00", end: "2026-11-20T21:00", remind: false });
    expect(tick("2026-11-20T00:00:00.000Z").reminded.filter((r) => r.includes(quiet.id))).toEqual([]);
    // created 3 hours before it starts: the creation notice covers it, no reminder on top
    now = new Date("2026-11-25T21:00:00.000Z");
    const soon = await create({ title: "Pop-up", start: "2026-11-25T19:00", end: "2026-11-25T21:00" });
    expect(tick("2026-11-25T21:05:00.000Z").reminded.filter((r) => r.includes(soon.id))).toEqual([]);
  });

  it("webhook: 'New league event' through the cleaned sender (starred), on by default for league nights, off for others, never for drafts or a toggle off", async () => {
    expect(defaultEvents("league").leagueEvent).toBe(true);
    expect(eventKeysFor("league")).toContain("leagueEvent");
    expect(eventKeysFor("tournament")).not.toContain("leagueEvent");
    await create({ title: `Night of ${LISTED}`, description: `A ${LISTED} good time.` });
    expect(posts).toHaveLength(1);
    const e = posts[0]!.embeds[0]!;
    expect(e.title).toBe("TABBL: New league event");
    expect(JSON.stringify(posts[0])).not.toContain(LISTED);
    expect(e.description).toContain("\\*\\*\\*");
    expect(e.fields?.find((f) => f.name === "When")?.value).toBe("Thu 29 Oct 2026, 19:00 to 22:00 (America/New York)");
    expect(e.fields?.find((f) => f.name === "Where")?.value).toBe("Example Games Club");
    expect(posts[0]!.allowed_mentions).toEqual({ parse: [] });
    // a social is not posted unless ticked; ticked it is
    posts = [];
    await create({ type: "social" });
    expect(posts).toEqual([]);
    await create({ type: "social", announce: true });
    expect(posts).toHaveLength(1);
    // the league switched the event off
    posts = [];
    store.updateLeague("tabbl", (l) => { l.discordEvents = { ...defaultEvents("league"), leagueEvent: false }; });
    await create();
    expect(posts).toEqual([]);
    // a linked season with its own webhook: the season's target (its toggle defaults from the league)
    store.updateLeague("tabbl", (l) => { delete l.discordEvents; });
    const urls: string[] = [];
    const SEASON_HOOK = "https://discord.com/api/webhooks/923456789012345678/zyxwvutsrqponmlkjihgfedcba_FEDCBA-999";
    store.setSecrets("tabbl", { discordWebhookUrl: HOOK, competitionWebhooks: { "season:season-2": SEASON_HOOK } });
    const r = await leagueApi("POST", "/api/leagues/tabbl/events", new URLSearchParams(), { coach: "Jay", admin: false }, {
      ...deps(), readBody: async () => Buffer.from(JSON.stringify({ ...NIGHT, link: { kind: "season", id: "season-2" } })),
      postWebhook: async (url) => { urls.push(url); return { ok: true, status: 204 }; },
    });
    expect(r?.status).toBe(201);
    expect(urls).toEqual([SEASON_HOOK]);
  });

  it("schedule: upcoming League Event dates on one timeline; the gates source is typed and empty", async () => {
    const ev = await create({ recurrence: { everyWeeks: 1, until: "2026-11-12" } });
    await create({ title: "Past", start: "2026-10-01T19:00", end: "2026-10-01T20:00" });
    const r = await call("GET", "/api/leagues/tabbl/schedule", JAY);
    expect(r.status).toBe(200);
    const entries = (r.body as { entries: Array<{ kind: string; eventId: string; start: string }> }).entries;
    expect(entries.map((e) => [e.kind, e.eventId, e.start])).toEqual([
      ["league-event", ev.id, "2026-10-29T23:00:00.000Z"], ["league-event", ev.id, "2026-11-06T00:00:00.000Z"], ["league-event", ev.id, "2026-11-13T00:00:00.000Z"],
    ]);
    expect(SCHEDULE_SOURCES).toContain(gateScheduleSource);
    const league = store.league("tabbl")!;
    expect(gateScheduleSource({ league, seasons: [], events: [], zone: "UTC", now: NOW.getTime() })).toEqual([]);
    // a gate source plugs in beside it and sorts into the same timeline
    const gate = () => [{ kind: "gate" as const, key: "gate:redraft", start: "2026-11-01T12:00:00.000Z", title: "Redraft opens", detail: "Redraft", gateId: "redraft", step: "redraft" }];
    const evs: LeagueCalendarEvent[] = store.leagueEvents("tabbl").events;
    const merged = scheduleEntries({ league, seasons: [], events: evs, zone: "America/New_York", now: NOW.getTime() }, [...SCHEDULE_SOURCES, gate]);
    expect(merged.map((e) => e.kind)).toEqual(["league-event", "gate", "league-event", "league-event"]);
  });
});
