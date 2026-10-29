import { describe, expect, it } from "vitest";
import {
  deadlineChip, deriveDeadlines, matchEndedAt, MAX_SCHEDULE_BLOCKS, parseBuildLog, parseSchedulingInput, REPORT_WINDOW_HOURS,
  schedulingView, toStoredScheduling, type DeadlineSources,
} from "../src/coachHome";
import type { MatchRecord } from "../src/tabletop/store";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "../src/tournaments/types";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const H = 3_600_000;
const iso = (hours: number) => new Date(NOW.getTime() + hours * H).toISOString();

const tournament = (id: string, extra: Record<string, unknown> = {}): TournamentRecord => ({
  id, name: `Cup ${id}`, status: "active", format: "swiss", packageName: "P", maxPlayers: 8, roundCount: 3, currentRound: 1,
  tiebreakers: [], points: { win: 3, draw: 1, loss: 0, bye: 3 }, createdAt: iso(-100), updatedAt: iso(-100), ...extra,
} as TournamentRecord);
const coachId = (c: string) => ({ coachId: c, ffbCoachId: c, verifiedAt: iso(-100) });
const entrant = (id: string, tid: string, coach: string, extra: Partial<TournamentEntrantRecord> = {}): TournamentEntrantRecord => ({
  id, tournamentId: tid, seed: 1, coach: coachId(coach), teamId: `team-${id}`, registeredAt: iso(-90), ...extra,
});
const fixture = (id: string, tid: string, home: string, away: string, extra: Record<string, unknown> = {}): ScheduledMatchRecord => ({
  id, tournamentId: tid, roundId: "r1", roundNumber: 2,
  home: { entrantId: home, coach: coachId(home === "e1" ? "Alice" : "Bob"), teamId: "x" },
  away: { entrantId: away, coach: coachId(away === "e1" ? "Alice" : "Bob"), teamId: "y" },
  status: "scheduled", revision: 1, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
  createdAt: iso(-10), updatedAt: iso(-10), ...extra,
} as ScheduledMatchRecord);
const tabletop = (id: string, extra: Partial<MatchRecord>): MatchRecord => ({
  id, state: "recording", home: { coach: "Alice", teamSaveId: "save:1", teamName: "Orcs" }, away: { coach: "Bob", teamSaveId: "save:2", teamName: "Elves" },
  postMatch: "full", createdBy: "Alice", createdAt: iso(-5), updatedAt: iso(-5), confirmations: {}, baseRevision: { home: 0, away: 0 }, ...extra,
} as MatchRecord);

function sources(over: Partial<DeadlineSources> = {}): DeadlineSources {
  const ts = [
    tournament("t1", { status: "draft", deadlines: { registration: iso(100), checkIn: iso(30) } }),
    tournament("t2", { deadlines: { checkIn: iso(-1) } }),
    tournament("t3", { deadlines: { registration: iso(5) } }), // the coach is not in it
  ];
  const ents: Record<string, TournamentEntrantRecord[]> = {
    t1: [entrant("e1", "t1", "Alice")],
    t2: [entrant("e1", "t2", "alice"), entrant("e2", "t2", "Bob")],
    t3: [entrant("e9", "t3", "Carol")],
  };
  const fx: Record<string, ScheduledMatchRecord[]> = {
    t2: [
      fixture("m1", "t2", "e1", "e2", { deadline: iso(10) }),
      fixture("m2", "t2", "e2", "e1"),
      fixture("m3", "t2", "e1", "e2", { deadline: iso(1), status: "completed" }),
    ],
  };
  return {
    coach: "Alice", tournaments: ts, entrants: (id) => ents[id] ?? [], matches: (id) => fx[id] ?? [],
    tabletop: [
      tabletop("tt1", { clock: { half: 2, turn: 8, activeTeam: null, turnStartedAt: null } }),
      tabletop("tt2", { clock: { half: 2, turn: 5, activeTeam: "home", turnStartedAt: iso(-1) } }),
      tabletop("tt3", { state: "submitted", updatedAt: iso(-1) }),
      tabletop("tt4", { state: "submitted", confirmations: { Alice: iso(-1) } }),
      tabletop("tt5", { state: "recording", test: true, clock: { half: 2, turn: 8, activeTeam: null, turnStartedAt: null } }),
    ],
    // tt1 ran out of turns 5 h ago; tt3 was submitted 60 h ago (its updatedAt is recent: someone confirmed since)
    endedAt: (id) => ({ tt1: iso(-5), tt3: iso(-60) } as Record<string, string>)[id],
    now: NOW, ...over,
  };
}

describe("deadline chips", () => {
  it("green over 72 h, amber under 72 h, scarlet under 24 h, grey once passed", () => {
    expect(deadlineChip(iso(73), NOW)).toBe("ok");
    expect(deadlineChip(iso(72), NOW)).toBe("ok");
    expect(deadlineChip(iso(71.9), NOW)).toBe("soon");
    expect(deadlineChip(iso(24), NOW)).toBe("soon");
    expect(deadlineChip(iso(23.9), NOW)).toBe("urgent");
    expect(deadlineChip(iso(0), NOW)).toBe("urgent");
    expect(deadlineChip(iso(-0.01), NOW)).toBe("overdue");
    expect(deadlineChip("not a date", NOW)).toBe("overdue");
  });
});

describe("deadline derivation", () => {
  it("collects registration, check-in, round and report-by deadlines for the coach only, nearest first", () => {
    const rows = deriveDeadlines(sources());
    expect(rows.map((r) => r.id)).toEqual(["confirm:tt3", "checkin:t2", "round:m1", "checkin:t1", "report:tt1", "reg:t1"]);
    expect(rows.map((r) => r.chip)).toEqual(["overdue", "overdue", "urgent", "soon", "soon", "ok"]);
    expect(rows.find((r) => r.id === "round:m1")).toMatchObject({ title: "Round 2 vs Bob", detail: "Cup t2", link: "/tournaments/t2?tab=rounds" });
    expect(rows.find((r) => r.id === "report:tt1")).toMatchObject({ at: iso(-5 + REPORT_WINDOW_HOURS), link: "/tabletop/tt1", title: "Report the result vs Bob" });
  });

  it("skips checked-in coaches, dropped entries, finished tournaments and matches the coach already confirmed", () => {
    const s = sources();
    const checkedIn = { paid: true, rosterVerified: true, frozen: false, checkedIn: true, active: true };
    const rows = deriveDeadlines({
      ...s,
      tournaments: [...s.tournaments, tournament("t4", { status: "completed", deadlines: { checkIn: iso(5) } })],
      entrants: (id) => id === "t1" ? [entrant("e1", "t1", "Alice", { flags: checkedIn })]
        : id === "t2" ? [entrant("e1", "t2", "Alice", { droppedAt: iso(-2) })]
          : id === "t4" ? [entrant("e1", "t4", "Alice")] : s.entrants(id),
    });
    expect(rows.map((r) => r.id)).toEqual(["confirm:tt3", "report:tt1", "reg:t1"]);
  });

  it("report-by counts from the immutable end of the match: a later confirmation or edit never extends it", () => {
    const s = sources();
    const before = deriveDeadlines(s).find((r) => r.id === "confirm:tt3")!;
    expect(before).toMatchObject({ at: iso(-60 + REPORT_WINDOW_HOURS), chip: "overdue" });
    // Bob confirms now (updatedAt moves to now): Alice's row stays overdue, same instant
    const bumped = s.tabletop.map((m) => (m.id === "tt3" ? { ...m, updatedAt: NOW.toISOString(), confirmations: { Bob: NOW.toISOString() } } : m));
    expect(deriveDeadlines({ ...s, tabletop: bumped }).find((r) => r.id === "confirm:tt3")).toEqual(before);
    // with no end in the log the window counts from creation, never from updatedAt
    expect(deriveDeadlines({ ...s, endedAt: () => undefined }).find((r) => r.id === "confirm:tt3")!.at).toBe(iso(-5 + REPORT_WINDOW_HOURS));
  });

  it("matchEndedAt: the latest endOfMatch, else the turn end that ran the clock out", () => {
    expect(matchEndedAt([])).toBeUndefined();
    expect(matchEndedAt([{ type: "touchdown", ts: iso(-9) }])).toBeUndefined();
    expect(matchEndedAt([{ type: "turnEnd", ts: iso(-3) }, { type: "turnEnd", ts: iso(-2) }, { type: "turnEnd", ts: "bad" }])).toBe(iso(-2));
    expect(matchEndedAt([{ type: "endOfMatch", ts: iso(-4) }, { type: "turnEnd", ts: iso(-1) }, { type: "endOfMatch", ts: iso(-3) }])).toBe(iso(-3));
  });

  it("a coach with nothing on gets an empty list", () => {
    expect(deriveDeadlines(sources({ coach: "Nobody" }))).toEqual([]);
  });
});

describe("scheduling validation", () => {
  const block = (i: number) => ({ day: i % 7, start: `${String(i).padStart(2, "0")}:00`, end: `${String(i).padStart(2, "0")}:30` });

  it("accepts day 0-6, HH:MM, start < end, an IANA zone, and sorts the blocks", () => {
    const v = parseSchedulingInput({ timezone: " America/New_York ", availability: [{ day: 5, start: "10:00", end: "12:30" }, { day: 0, start: "18:00", end: "23:59" }] });
    expect(v).toEqual({ timezone: "America/New_York", availability: [{ day: 0, start: "18:00", end: "23:59" }, { day: 5, start: "10:00", end: "12:30" }] });
    expect(parseSchedulingInput({})).toEqual({ timezone: "", availability: [] });
    // touching blocks and the same hours on different days are fine
    expect(parseSchedulingInput({ availability: [{ day: 0, start: "19:00", end: "21:00" }, { day: 0, start: "18:00", end: "19:00" }, { day: 1, start: "18:30", end: "20:00" }] }).availability)
      .toEqual([{ day: 0, start: "18:00", end: "19:00" }, { day: 0, start: "19:00", end: "21:00" }, { day: 1, start: "18:30", end: "20:00" }]);
    expect(() => parseSchedulingInput({ availability: [{ day: 0, start: "18:00", end: "21:00" }, { day: 0, start: "19:00", end: "20:00" }] })).toThrow(/Monday 19:00-20:00 overlaps 18:00-21:00/);
    expect(parseSchedulingInput({ availability: Array.from({ length: MAX_SCHEDULE_BLOCKS }, (_, i) => block(i)) }).availability).toHaveLength(MAX_SCHEDULE_BLOCKS);
  });

  it("refuses bad days, times, order, duplicates, zones and too many blocks", () => {
    const bad: unknown[] = [
      { availability: [{ day: -1, start: "10:00", end: "11:00" }] },
      { availability: [{ day: 7, start: "10:00", end: "11:00" }] },
      { availability: [{ day: 1.5, start: "10:00", end: "11:00" }] },
      { availability: [{ day: "mon", start: "10:00", end: "11:00" }] },
      { availability: [{ day: 1, start: "24:00", end: "11:00" }] },
      { availability: [{ day: 1, start: "9:00", end: "11:00" }] },
      { availability: [{ day: 1, start: "11:00", end: "11:00" }] },
      { availability: [{ day: 1, start: "12:00", end: "11:00" }] },
      { availability: [{ day: 1, start: "10:00", end: "11:00" }, { day: 1, start: "10:00", end: "11:00" }] },
      { availability: [{ day: 0, start: "18:00", end: "21:00" }, { day: 0, start: "19:00", end: "20:00" }] },
      { availability: [{ day: 3, start: "20:00", end: "22:00" }, { day: 3, start: "18:00", end: "20:30" }] },
      { timezone: "Not/AZone" },
      { timezone: 5 },
      { availability: "all week" },
      { availability: Array.from({ length: MAX_SCHEDULE_BLOCKS + 1 }, (_, i) => block(i)) },
      [],
      null,
    ];
    for (const body of bad) expect(() => parseSchedulingInput(body), JSON.stringify(body)).toThrow();
  });

  it("maps to and from the identity store's day codes (0 = Monday)", () => {
    const view = { timezone: "Europe/Paris", availability: [{ day: 0, start: "18:00", end: "20:00" }, { day: 6, start: "10:00", end: "12:00" }] };
    const stored = toStoredScheduling(view);
    expect(stored).toEqual({ timezone: "Europe/Paris", availability: [{ day: "mon", start: "18:00", end: "20:00" }, { day: "sun", start: "10:00", end: "12:00" }] });
    expect(schedulingView(stored)).toEqual(view);
    expect(schedulingView(undefined)).toEqual({ timezone: "", availability: [] });
  });
});

describe("build log parsing", () => {
  it("keeps valid entries, newest date first, file order (prepended = newest) within a date", () => {
    const entries = parseBuildLog(JSON.stringify([
      { date: "2026-10-29", title: "A", body: "a", links: [] },
      { date: "2026-10-29", title: "B", body: "b", version: "1.2", links: [{ label: "x", href: "//evil.test" }, { label: "y", href: "https://ok.test/p" }] },
      { date: "2026-10-30", title: "C", body: "c" },
      { date: "2026-10-31", title: "", body: "no title" },
    ]));
    expect(entries.map((e) => e.title)).toEqual(["C", "A", "B"]);
    expect(entries[2]).toEqual({ date: "2026-10-29", version: "1.2", title: "B", body: "b", links: [{ label: "y", href: "https://ok.test/p" }] });
    expect(parseBuildLog("not json")).toEqual([]);
    expect(parseBuildLog("{}")).toEqual([]);
  });

  it("the shipped build log parses whole", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../docs/build-log.json", import.meta.url), "utf8");
    const raw = JSON.parse(text) as unknown[];
    expect(parseBuildLog(text)).toHaveLength(raw.length);
    expect(text).not.toMatch(/re-roll/i);
  });
});
