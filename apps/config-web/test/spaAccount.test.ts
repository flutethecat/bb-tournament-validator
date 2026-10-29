import { nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import type { DeadlineView } from "../spa/src/home/deadlines";
import {
  agenda, availabilityByWeekday, calendarEvents, calendarZone, chipTone, dayKey, eventsByDay, loadProposals, monthGrid, monthLabel, monthOf, shiftMonth, timeOf,
  type ProposedTime,
} from "../spa/src/account/calendar";
import { createProfileEditor, profileProblems, type ProfileView } from "../spa/src/account/profile";
import { createAccountEditors } from "../spa/src/account/editors";
import { createScheduleDialog } from "../spa/src/account/scheduleDialog";
import { dialogKey } from "../spa/src/teams/manage";

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

// ---------------------------------------------------------------- review fixes (Sol 6.1, 10-30)

describe("account page review fixes", () => {
  const view = (coach: string, extra: Partial<ProfileView> = {}): ProfileView => ({
    coach, displayName: "", fumbblName: "", fumbblLinked: false, nafName: "", nafId: "", avatar: null, avatarSource: "none",
    discord: { linked: true, username: `${coach.toLowerCase()}_dc` }, ...extra,
  });
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it("a coach switch recreates the editors; the previous coach's late answers never reach the new ones", async () => {
    const coach = ref("Alice");
    const pending: Array<{ path: string; method: string; d: ReturnType<typeof deferred<unknown>> }> = [];
    const api = ((path: string, init: { method?: string } = {}) => {
      const d = deferred<unknown>();
      pending.push({ path, method: init.method ?? "GET", d });
      return d.promise;
    }) as Fetcher;
    const eds = createAccountEditors({ api, currentCoach: () => coach.value, loadProposals: async () => [] });
    const alice = eds.profile.value;
    const aliceSchedule = eds.schedule.value;
    const aliceLoad = alice.load();
    coach.value = "Bob"; // Test sign-in as Bob while Alice's read is in flight
    await nextTick();
    expect(eds.coach.value).toBe("Bob");
    expect(eds.profile.value).not.toBe(alice);
    expect(eds.schedule.value).not.toBe(aliceSchedule);
    expect(eds.profile.value.state.view).toBeNull();
    // Alice's answer lands after the switch: dropped, even on her own (discarded) editor
    pending[0]!.d.resolve(view("Alice", { fumbblName: "AliceF", fumbblLinked: true }));
    await aliceLoad;
    expect(alice.state.view).toBeNull();
    expect(eds.profile.value.state.view).toBeNull();
    // Bob's editor loads Bob
    const bobLoad = eds.profile.value.load();
    pending[1]!.d.resolve(view("Bob"));
    await bobLoad;
    expect(eds.profile.value.state.view?.coach).toBe("Bob");
    expect(eds.profile.value.state.form.fumbblName).toBe("");
    eds.stop();
  });

  it("an editor refuses to save once the session is another coach, and drops an answer for a different coach", async () => {
    let session = "Alice";
    const calls: string[] = [];
    const api = (async (_p: string, init: { method?: string } = {}) => { calls.push(init.method ?? "GET"); return view(session === "Alice" ? "Alice" : "Bob"); }) as Fetcher;
    const ed = createProfileEditor({ api, coach: "Alice", currentCoach: () => session });
    await ed.load();
    expect(ed.state.view?.coach).toBe("Alice");
    ed.edit("displayName", "Ally");
    session = "Bob";
    expect(await ed.save()).toBe(false);
    expect(calls).toEqual(["GET"]);
    expect(ed.state.error).toMatch(/another coach/);
    // a read answered for someone else is never shown
    const other = createProfileEditor({ api: (async () => view("Bob")) as Fetcher, coach: "Alice", currentCoach: () => "Alice" });
    await other.load();
    expect(other.state.view).toBeNull();
  });

  it("an edit made while a save is in flight survives the response and stays dirty", async () => {
    const patch = deferred<ProfileView>();
    const api = ((_p: string, init: { method?: string; body?: unknown } = {}) =>
      (init.method === "PATCH" ? patch.promise : Promise.resolve(view("Alice")))) as Fetcher;
    const ed = createProfileEditor({ api, coach: "Alice", currentCoach: () => "Alice" });
    await ed.load();
    ed.edit("displayName", "Ally");
    const saving = ed.save();
    expect(ed.state.saving).toBe(true);
    ed.edit("nafId", "4242"); // typed during the request
    patch.resolve(view("Alice", { displayName: "Ally" }));
    expect(await saving).toBe(true);
    expect(ed.state.form.displayName).toBe("Ally");
    expect(ed.state.form.nafId).toBe("4242");
    expect(ed.dirty()).toBe(true);
    expect(ed.changes()).toEqual({ nafId: "4242" });
    expect(ed.state.notice).toMatch(/Newer changes are not saved yet/);
  });

  it("the loaded scheduling zone places events, not the tree's cached zone (cached only while loading)", () => {
    const at = "2026-10-31T23:30:00Z";
    const cachedNy = { treeZone: "America/New_York", browserZone: "UTC" };
    const loaded = calendarZone({ scheduleLoaded: true, scheduleZone: "Asia/Tokyo", ...cachedNy });
    expect(loaded).toBe("Asia/Tokyo");
    expect(dayKey(at, loaded)).toBe("2026-11-01");
    const loading = calendarZone({ scheduleLoaded: false, scheduleZone: "", ...cachedNy });
    expect(loading).toBe("America/New_York");
    expect(dayKey(at, loading)).toBe("2026-10-31");
    expect(calendarZone({ scheduleLoaded: false, scheduleZone: "", treeZone: "", browserZone: "Europe/Paris" })).toBe("Europe/Paris");
  });
});

describe("Set schedule dialog controller", () => {
  function make(open = false) {
    const state = { dirty: false, focused: 0 };
    const ctl = createScheduleDialog({ isDirty: () => state.dirty, focusOpener: () => { state.focused++; } }, open);
    return { state, ctl };
  }

  it("opens, and the Close button / Escape close it and return focus to the opener once", () => {
    const { state, ctl } = make();
    expect(ctl.open.value).toBe(false);
    ctl.show();
    expect(ctl.open.value).toBe(true);
    // Escape is the shared dialog rule: close (never blocked here, there is no request in flight)
    expect(dialogKey({ key: "Escape", shiftKey: false }, [], null, false)).toEqual({ type: "close" });
    ctl.close();
    expect(ctl.open.value).toBe(false);
    expect(state.focused).toBe(1);
    ctl.close(); // already closed: no second focus move
    expect(state.focused).toBe(1);
  });

  it("an overlay press closes only while the editor is clean; dirty keeps it open", () => {
    const { state, ctl } = make(true);
    state.dirty = true;
    ctl.pressOverlay();
    expect(ctl.open.value).toBe(true);
    expect(state.focused).toBe(0);
    state.dirty = false;
    ctl.pressOverlay();
    expect(ctl.open.value).toBe(false);
    expect(state.focused).toBe(1);
  });

  it("closing with unsaved changes keeps the edits and the dirty hint in the shared editor; reopening shows them", async () => {
    const api = (async () => ({ timezone: "Europe/London", blocks: [] })) as unknown as Fetcher;
    const eds = createAccountEditors({ api, currentCoach: () => "Alice", loadProposals: async () => [] });
    const ed = eds.schedule.value;
    await ed.load();
    ed.addBlock(0);
    expect(ed.state.dirty).toBe(true);
    const ctl = createScheduleDialog({ isDirty: () => eds.schedule.value.state.dirty, focusOpener: () => {} }, true);
    ctl.close();
    ctl.show();
    expect(eds.schedule.value).toBe(ed);
    expect(ed.state.blocks).toHaveLength(1);
    expect(ed.state.dirty).toBe(true);
    eds.stop();
  });

  it("starts open when asked to (the #schedule landing)", () => {
    expect(make(true).ctl.open.value).toBe(true);
  });
});
