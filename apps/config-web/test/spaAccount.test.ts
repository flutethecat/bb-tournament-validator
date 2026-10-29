import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import type { DeadlineView } from "../spa/src/home/deadlines";
import {
  agenda, availabilityByWeekday, calendarEvents, chipTone, dayKey, eventsByDay, loadProposals, monthGrid, monthLabel, monthOf, shiftMonth, timeOf,
  type ProposedTime,
} from "../spa/src/account/calendar";
import { createProfileEditor, profileProblems, type ProfileView } from "../spa/src/account/profile";

// Account page controllers: the calendar helpers (Monday-first month grid, chip tones, events on the coach's day) and the
// Identity panel's editor (local checks, PATCH only the changed fields, linked FUMBBL name never sent).

const H = 3_600_000;

describe("calendar helpers", () => {
  it("month grid is Monday-first, whole weeks, padded with the neighbouring months", () => {
    // October 2026 starts on a Thursday: Mon 28 Sep .. Sun 1 Nov, 5 rows
    const oct = monthGrid({ year: 2026, month: 9 });
    expect(oct).toHaveLength(5);
    expect(oct.every((w) => w.length === 7)).toBe(true);
    expect(oct[0]![0]).toEqual({ key: "2026-09-28", date: 28, weekday: 0, inMonth: false });
    expect(oct[0]![3]).toEqual({ key: "2026-10-01", date: 1, weekday: 3, inMonth: true });
    expect(oct[4]![6]).toEqual({ key: "2026-11-01", date: 1, weekday: 6, inMonth: false });
    // February 2027 starts on a Monday and has 28 days: exactly 4 rows, nothing padded
    const feb = monthGrid({ year: 2027, month: 1 });
    expect(feb).toHaveLength(4);
    expect(feb.flat().every((d) => d.inMonth)).toBe(true);
    // a month starting on a Sunday needs 6 rows (August 2027: Sun 1st, 31 days)
    expect(monthGrid({ year: 2027, month: 7 })).toHaveLength(6);
  });

  it("month navigation and labels", () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth({ year: 2026, month: 5 }, -18)).toEqual({ year: 2024, month: 11 });
    expect(monthLabel({ year: 2026, month: 9 })).toBe("October 2026");
  });

  it("days and months are the coach's, not UTC's", () => {
    const lateUtc = "2026-10-31T23:30:00Z"; // Sat 31 Oct in London (GMT), Sun 1 Nov in Tokyo, Sat 31 Oct 19:30 in New York
    expect(dayKey(lateUtc, "Europe/London")).toBe("2026-10-31");
    expect(dayKey(lateUtc, "Asia/Tokyo")).toBe("2026-11-01");
    expect(dayKey(lateUtc, "America/New_York")).toBe("2026-10-31");
    expect(dayKey(lateUtc, "Not/AZone")).toBe("2026-10-31");
    expect(dayKey("nonsense", "UTC")).toBe("");
    expect(monthOf(new Date(lateUtc), "Asia/Tokyo")).toEqual({ year: 2026, month: 10 });
    expect(monthOf(new Date(lateUtc), "Europe/London")).toEqual({ year: 2026, month: 9 });
    expect(timeOf(lateUtc, "America/New_York")).toBe("19:30");
  });

  it("chip tones follow the Deadlines panel horizons", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const at = (h: number) => new Date(now.getTime() + h * H).toISOString();
    expect(chipTone(at(80), now)).toBe("ok");
    expect(chipTone(at(48), now)).toBe("soon");
    expect(chipTone(at(3), now)).toBe("urgent");
    expect(chipTone(at(-1), now)).toBe("overdue");
  });

  it("deadlines and proposals land on the right day in the coach's timezone, recoloured against now", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const deadlines: DeadlineView[] = [
      { id: "round:m1", kind: "round", title: "Round 2 vs Bob", detail: "Spring Cup", at: "2026-10-31T23:30:00Z", chip: "ok", link: "/tournaments/t1?tab=rounds" },
      { id: "reg:t2", kind: "registration", title: "Registration closes", detail: "Autumn Open", at: "2026-11-20T10:00:00Z", chip: "ok", link: "/tournaments/t2" },
      { id: "report:x", kind: "report", title: "Report the result vs Cy", detail: "A v B", at: "2026-10-30T09:00:00Z", chip: "ok", link: "/tabletop/x" },
    ];
    const proposals: ProposedTime[] = [
      { id: "p1", at: "2026-10-31T18:00:00Z", opponent: "Bob", detail: "Spring Cup round 2", link: "/tournaments/t1?tab=rounds", state: "pending", mine: true },
      { id: "p2", at: "2026-10-31T19:00:00Z", opponent: "Bob", detail: "Spring Cup round 2", link: "/tournaments/t1?tab=rounds", state: "declined", mine: false },
    ];
    const events = calendarEvents(deadlines, proposals, now);
    expect(events.map((e) => e.id)).toEqual(["report:x", "proposal:p1", "round:m1", "reg:t2"]); // time order, declined dropped
    expect(events.find((e) => e.id === "round:m1")!.chip).toBe("soon"); // 35.5 h away: recomputed, not the stale "ok"
    expect(events.find((e) => e.id === "report:x")!.chip).toBe("overdue");
    expect(events.find((e) => e.id === "proposal:p1")).toMatchObject({ source: "proposal", title: "Proposed vs Bob" });

    const tokyo = eventsByDay(events, "Asia/Tokyo");
    // 18:00Z and 23:30Z on 31 Oct are both Sunday 1 Nov in Tokyo
    expect(tokyo.get("2026-11-01")!.map((e) => e.id)).toEqual(["proposal:p1", "round:m1"]);
    expect(tokyo.get("2026-10-31")).toBeUndefined();
    const ny = eventsByDay(events, "America/New_York");
    expect(ny.get("2026-10-31")!.map((e) => e.id)).toEqual(["proposal:p1", "round:m1"]);
    // the phone agenda: the month's events only, in the coach's zone
    expect(agenda(events, { year: 2026, month: 9 }, "America/New_York").map((e) => e.id)).toEqual(["report:x", "proposal:p1", "round:m1"]);
    expect(agenda(events, { year: 2026, month: 9 }, "Asia/Tokyo").map((e) => e.id)).toEqual(["report:x"]);
  });

  it("availability per Monday-first weekday column; proposals are an empty source for now", async () => {
    const cols = availabilityByWeekday([{ day: 5, start: "14:00", end: "16:00" }, { day: 0, start: "19:00", end: "22:00" }, { day: 5, start: "10:00", end: "12:00" }]);
    expect(cols).toHaveLength(7);
    expect(cols[0]!.map((b) => b.start)).toEqual(["19:00"]);
    expect(cols[5]!.map((b) => b.start)).toEqual(["10:00", "14:00"]);
    expect(await loadProposals()).toEqual([]);
  });
});

describe("identity editor", () => {
  const view = (extra: Partial<ProfileView> = {}): ProfileView => ({
    coach: "Alice", displayName: "", fumbblName: "", fumbblLinked: false, nafName: "", nafId: "", avatar: null, avatarSource: "none",
    discord: { linked: true, username: "alice_dc" }, ...extra,
  });
  function fetcher(get: ProfileView, patch: (body: unknown) => unknown) {
    const calls: Array<{ method: string; body: unknown }> = [];
    const f = (async (_path: string, init: { method?: string; body?: unknown } = {}) => {
      calls.push({ method: init.method ?? "GET", body: init.body });
      if ((init.method ?? "GET") === "GET") return get;
      const out = patch(init.body);
      if (out instanceof Error) throw out;
      return out;
    }) as Fetcher;
    return { f, calls };
  }

  it("checks fields like the server", () => {
    const ok = { displayName: "Grim Gutrot", fumbblName: "grim_99", nafName: "Ólafur O'Neil", nafId: "123" };
    expect(Object.values(profileProblems(ok)).every((p) => p === "")).toBe(true);
    const bad = profileProblems({ displayName: "A", fumbblName: "x'y", nafName: "<b>", nafId: "12a" });
    expect(bad.displayName).toMatch(/At least 2/);
    expect(bad.fumbblName).toMatch(/Letters/);
    expect(bad.nafName).toMatch(/Letters/);
    expect(bad.nafId).toMatch(/1 to 10 digits/);
    expect(profileProblems({ displayName: "", fumbblName: "", nafName: "", nafId: "" }).displayName).toBe("");
  });

  it("refuses locally, PATCHes only the changed fields, and shows the saved notice", async () => {
    const { f, calls } = fetcher(view({ nafId: "9" }), (body) => ({ ...view({ nafId: "9" }), ...(body as object) }));
    const ed = createProfileEditor({ api: f });
    await ed.load();
    expect(ed.state.loaded).toBe(true);
    ed.edit("nafId", "x");
    expect(await ed.save()).toBe(false);
    expect(ed.state.problems.nafId).toMatch(/digits/);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    ed.edit("nafId", "9");
    ed.edit("displayName", "  Grim   Gutrot ");
    expect(ed.dirty()).toBe(true);
    expect(await ed.save()).toBe(true);
    expect(calls.at(-1)).toEqual({ method: "PATCH", body: { displayName: "Grim Gutrot" } });
    expect(ed.state.notice).toBe("Profile saved.");
    expect(ed.state.form.displayName).toBe("Grim Gutrot");
    expect(ed.dirty()).toBe(false);
  });

  it("never sends a linked FUMBBL name, and shows the server's refusal", async () => {
    const { f, calls } = fetcher(view({ fumbblName: "LinkedF", fumbblLinked: true }), () => new ApiError(400, "Display name can use letters."));
    const ed = createProfileEditor({ api: f });
    await ed.load();
    ed.edit("fumbblName", "Other");
    ed.edit("nafName", "Alice N");
    expect(await ed.save()).toBe(false);
    expect(calls.at(-1)).toEqual({ method: "PATCH", body: { nafName: "Alice N" } });
    expect(ed.state.error).toBe("Display name can use letters.");
  });

  it("a failed read keeps Save off and offers Retry", async () => {
    let fail = true;
    const f = (async () => { if (fail) throw new ApiError(500, "down"); return view(); }) as Fetcher;
    const ed = createProfileEditor({ api: f });
    await ed.load();
    expect(ed.state.loadFailed).toBe(true);
    expect(await ed.save()).toBe(false);
    fail = false;
    await ed.load();
    expect(ed.state.loaded).toBe(true);
  });
});
