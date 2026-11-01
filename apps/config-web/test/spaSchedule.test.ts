import { describe, expect, it } from "vitest";
import {
  calendarEvents, dayBox, dayKeyIn, inAvailability, listGroups, myBusy, refFromLobbyPath, slotState, socialSlot, toggleSlot, warningsFor, weekOf, zonedInstant,
  createScheduleStore, type ScheduleView,
} from "../spa/src/schedule/schedule";
import { proposedTimesFrom, loadProposals } from "../spa/src/account/calendar";
import { treeLeagues } from "../spa/src/home/tree";

// The Schedule page's data layer (spa/src/schedule/schedule.ts): zone maths for the month / week / day calendars, the
// propose dialog's slot checks (mirror of the server's), the list view's three groups and the calendar events.

const H = 3_600_000;
const view = (): ScheduleView => ({
  coach: "Ann", timezone: "Europe/London", availability: [],
  fixtures: [
    { ref: "league:tabbl:s1:f1", kind: "league", title: "Round 1 vs Elves", competition: "TABBL · Season 1", round: 1, myTeam: "Orcs", opponentTeam: "Elves", opponent: { coach: "Bob", timezone: "Asia/Tokyo", availability: [], busy: [] }, link: "/leagues/tabbl/seasons/s1/fixtures/f1/lobby", canPropose: true, pendingProposal: "p1" },
    { ref: "league:tabbl:s1:f3", kind: "league", title: "Round 2 vs Rats", competition: "TABBL · Season 1", round: 2, myTeam: "Orcs", opponentTeam: "Rats", opponent: { coach: "Cat", timezone: null, availability: [], busy: [] }, scheduled: { start: "2026-11-12T18:00:00.000Z", end: "2026-11-12T20:00:00.000Z", agreedAt: "2026-11-10T12:00:00.000Z" }, link: "/leagues/tabbl/seasons/s1/fixtures/f3/lobby", canPropose: true },
    { ref: "tournament:m1", kind: "tournament", title: "Round 1 vs Eve's Elves", competition: "Autumn Open", round: 1, myTeam: "", opponentTeam: "Eve's Elves", opponent: { coach: "Eve" }, link: "/tournaments/t1?tab=rounds", canPropose: false, reason: "blocked" },
  ],
  proposals: [
    { id: "p1", fixture: "league:tabbl:s1:f1", from: "Bob", to: "Ann", mine: false, slots: [{ start: "2026-11-13T18:00:00.000Z", end: "2026-11-13T20:00:00.000Z" }, { start: "2026-11-14T18:00:00.000Z", end: "2026-11-14T20:00:00.000Z" }], status: "pending", createdAt: "2026-11-10T12:00:00.000Z" },
    { id: "p0", fixture: "league:tabbl:s1:f1", from: "Ann", to: "Bob", mine: true, slots: [{ start: "2026-11-11T18:00:00.000Z", end: "2026-11-11T20:00:00.000Z" }], status: "countered", createdAt: "2026-11-09T12:00:00.000Z" },
  ],
  counts: { toAnswer: 1, waiting: 0, needToSchedule: 2, scheduled: 1 },
});

describe("zone maths", () => {
  it("local wall time -> instant, across a DST change", () => {
    expect(new Date(zonedInstant("2026-11-12", 19 * 60, "Europe/London")).toISOString()).toBe("2026-11-12T19:00:00.000Z");
    expect(new Date(zonedInstant("2026-07-12", 19 * 60, "Europe/London")).toISOString()).toBe("2026-07-12T18:00:00.000Z");
    expect(new Date(zonedInstant("2026-11-12", 9 * 60, "Asia/Tokyo")).toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(dayKeyIn(Date.parse("2026-11-12T23:30:00Z"), "Asia/Tokyo")).toBe("2026-11-13");
  });
  it("Monday-first weeks", () => {
    expect(weekOf("2026-11-12")).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  });
  it("an event's box inside a day column", () => {
    expect(dayBox({ start: Date.parse("2026-11-12T18:00:00Z"), end: Date.parse("2026-11-12T20:00:00Z") }, "2026-11-12", "UTC")).toEqual({ top: 18 / 24, height: 2 / 24 });
    expect(dayBox({ start: Date.parse("2026-11-12T23:00:00Z"), end: Date.parse("2026-11-13T01:00:00Z") }, "2026-11-13", "UTC")).toEqual({ top: 0, height: 1 / 24 });
    expect(dayBox({ start: Date.parse("2026-11-12T18:00:00Z"), end: Date.parse("2026-11-12T20:00:00Z") }, "2026-11-13", "UTC")).toBeUndefined();
  });
});

describe("slot checks (mirror the server)", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  it("conflict suppression: past and clashing hours are not offered", () => {
    const busy = myBusy(view());
    expect(busy).toEqual([{ start: "2026-11-12T18:00:00.000Z", end: "2026-11-12T20:00:00.000Z" }]);
    expect(slotState(Date.parse("2026-11-12T19:00:00Z"), busy, now)).toBe("clash");
    expect(slotState(Date.parse("2026-11-12T20:00:00Z"), busy, now)).toBe("ok");
    expect(slotState(now - H, busy, now)).toBe("past");
    expect(myBusy(view(), "league:tabbl:s1:f3")).toEqual([]); // rescheduling a fixture never clashes with itself
  });
  it("unsocial hours and the no-timezone notice", () => {
    expect(socialSlot(Date.parse("2026-11-12T18:00:00Z"), "Asia/Tokyo")).toBe(false);
    expect(socialSlot(Date.parse("2026-11-12T01:00:00Z"), "Asia/Tokyo")).toBe(true); // 10:00-12:00
    expect(warningsFor([Date.parse("2026-11-12T18:00:00Z")], "Asia/Tokyo").map((w) => w.code)).toEqual(["unsocial"]);
    expect(warningsFor([Date.parse("2026-11-12T18:00:00Z")], null).map((w) => w.code)).toEqual(["no-timezone"]);
    expect(warningsFor([Date.parse("2026-11-12T18:00:00Z")], "Europe/London", "2026-11-12T19:00:00Z").map((w) => w.code)).toEqual(["after-deadline"]);
  });
  it("up to three candidates, never overlapping", () => {
    const t = (h: number) => Date.parse("2026-11-12T00:00:00Z") + h * H;
    let s = toggleSlot([], t(18));
    s = toggleSlot(s, t(19)); // overlaps 18-20: ignored
    expect(s).toEqual([t(18)]);
    s = toggleSlot(toggleSlot(toggleSlot(s, t(10)), t(14)), t(22));
    expect(s).toEqual([t(10), t(14), t(18)]);
    expect(toggleSlot(s, t(14))).toEqual([t(10), t(18)]);
  });
  it("the opponent's usual availability (their zone)", () => {
    // Thursday 12 Nov 19:00-21:00 London; block Thu 18:00-23:00
    expect(inAvailability(Date.parse("2026-11-12T19:00:00Z"), [{ day: 3, start: "18:00", end: "23:00" }], "Europe/London")).toBe(true);
    expect(inAvailability(Date.parse("2026-11-12T22:00:00Z"), [{ day: 3, start: "18:00", end: "23:00" }], "Europe/London")).toBe(false);
    expect(inAvailability(Date.parse("2026-11-12T19:00:00Z"), [{ day: 3, start: "18:00", end: "23:00" }], null)).toBe(false);
  });
});

describe("calendar and list", () => {
  it("confirmed games are solid events with their fixture link; pending slots are proposal events", () => {
    const ev = calendarEvents(view());
    expect(ev.map((e) => [e.kind, e.id])).toEqual([["confirmed", "c:league:tabbl:s1:f3"], ["proposal", "p:p1:0"], ["proposal", "p:p1:1"]]);
    expect(ev[0]!.link).toBe("/leagues/tabbl/seasons/s1/fixtures/f3/lobby");
    expect(ev[1]).toMatchObject({ proposalId: "p1", detail: "From Bob", mine: false });
  });
  it("Scheduled · Proposed · Need to schedule", () => {
    const g = listGroups(view());
    expect(g.scheduled.map((f) => f.ref)).toEqual(["league:tabbl:s1:f3"]);
    expect(g.proposed.map((x) => x.proposal.id)).toEqual(["p1"]);
    expect(g.need.map((f) => f.ref)).toEqual(["tournament:m1"]);
  });
  it("the Account calendar plots agreed times and pending slots from the same read", async () => {
    const rows = proposedTimesFrom(view());
    expect(rows.map((r) => [r.state, r.at, r.link])).toEqual([
      ["accepted", "2026-11-12T18:00:00.000Z", "/leagues/tabbl/seasons/s1/fixtures/f3/lobby"],
      ["pending", "2026-11-13T18:00:00.000Z", "/schedule?proposal=p1"],
      ["pending", "2026-11-14T18:00:00.000Z", "/schedule?proposal=p1"],
    ]);
    expect(await loadProposals()).toEqual([]);
    expect(await loadProposals((async () => { throw new Error("down"); }) as never)).toEqual([]);
  });
});

describe("links into Propose a time", () => {
  it("a lobby path maps to its fixture ref; the sidebar's next fixture carries the Schedule link", () => {
    expect(refFromLobbyPath("/leagues/tabbl/seasons/s1/fixtures/f%201/lobby")).toBe("league:tabbl:s1:f 1");
    expect(refFromLobbyPath("/leagues/tabbl")).toBeUndefined();
    const rows = treeLeagues([{ id: "tabbl", name: "TABBL", to: "/leagues/tabbl", teams: [{ id: "orcs", name: "Orcs", race: "Orc", record: { wins: 0, draws: 0, losses: 0 }, to: "/leagues/tabbl?tab=teams", next: { id: "f1", round: 1, opponent: "Elves", home: true, to: "/leagues/tabbl/seasons/s1/fixtures/f1/lobby" } }] }], {});
    expect(rows[0]!.teams[0]!.fixture!.propose).toBe("/schedule?propose=league%3Atabbl%3As1%3Af1");
  });
  it("the page store keeps a write's error after its reload", async () => {
    let calls = 0;
    const f = (async (path: string) => {
      calls++;
      if (path === "/api/schedule/mine") return view();
      throw new Error("One of the times clashes with a confirmed game.");
    }) as never;
    const s = createScheduleStore(f);
    const out = await s.run("x", () => (f as (p: string) => Promise<unknown>)("/api/schedule/propose"));
    expect(out).toBeUndefined();
    expect(s.state.error).toMatch(/clashes/);
    expect(s.state.view?.coach).toBe("Ann");
    expect(calls).toBe(2);
  });
});
