import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseShareScope } from "../src/auth/contactFor";
import type { CoachIdentityRecord } from "../src/auth/identitiesStore";
import { ACTION_DM_WHEN_FLAGGED, actionDmText } from "../src/mail/actionMessages";
import { createMailService } from "../src/mail/service";
import { MemoryTransport } from "../src/mail/transport";
import { NOTIFICATION_TYPES, NotificationStore, type NotificationInput } from "../src/notifications";
import { createAnonymiser, createTextReplacer } from "../src/privacy/anonymise";
import { clearFences } from "../src/privacy/fence";
import {
  anonymiseLeagueRegistration, anonymiseRegistrationTrail, assertTestSessionMayWrite, checkInWindow, createRegistrationService,
  defaultRegistrationWindow, isCheckInOpen, KeyedLock, legacyEntryState, MemoryRegistrationAdapter, ownLeagueRegistrations,
  registrationContactFor, registrationCounts, REGISTRATION_LOG_FIELD, RegistrationError, resolveRegistrationWindow, roomFor,
  testSessionMayWrite, waitlistPosition, windowStatus, type CompetitionKind, type CompetitionSnapshot, type RegistrationActor,
  type RegistrationEntry, type RegistrationWindow,
} from "../src/registration";
import { NOTIFICATION_ICONS } from "../spa/src/home/notifications";

// Registration core (registration spec 2026-11-02 §2, §8; lane L0): window, state machine, caps, waitlist promotion,
// notifications + DM rows, the test-session rule (Q13), shared-contact visibility (Q15) and privacy coverage. Everything
// runs on the in-memory adapter and temp dirs; transports are in-memory. Fake names and example.test only.

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ORG: RegistrationActor = { coach: "Olga" };
const ADMIN: RegistrationActor = { coach: "Root", admin: true };
const me = (coach: string): RegistrationActor => ({ coach });

function snapshot(kind: CompetitionKind, over: Partial<CompetitionSnapshot> = {}, window: Partial<RegistrationWindow> = {}): CompetitionSnapshot {
  return {
    kind, id: "c1", name: "Autumn Open", published: true, finished: false, started: false, locked: false, test: false,
    managers: ["Olga", "Pat"], ...over,
    window: { ...defaultRegistrationWindow(kind, 2), ...window },
  };
}

interface Sent { coach: string; input: NotificationInput }

function setup(kind: CompetitionKind = "tournament", over: Partial<CompetitionSnapshot> = {}, window: Partial<RegistrationWindow> = {}, opts: { yieldEveryRead?: boolean } = {}) {
  const adapter = new MemoryRegistrationAdapter(kind, opts.yieldEveryRead ? { beforeCommit: () => new Promise((r) => setTimeout(r, 1)) } : {});
  adapter.put(snapshot(kind, over, window));
  const sent: Sent[] = [];
  const clock = { t: NOW.getTime() };
  const svc = createRegistrationService({
    adapter, notify: (coach, input) => sent.push({ coach, input }), now: () => new Date(clock.t), lock: new KeyedLock(), log: () => {},
  });
  const entries = () => adapter.store.get("c1") ?? [];
  const byCoach = (coach: string) => entries().find((e) => e.coach === coach)!;
  return { adapter, svc, sent, clock, entries, byCoach, tick: (ms = 1000) => { clock.t += ms; } };
}

const err = async (p: Promise<unknown>): Promise<RegistrationError> => {
  try { await p; } catch (e) { if (e instanceof RegistrationError) return e; throw e; }
  throw new Error("expected a RegistrationError");
};

describe("registration window", () => {
  it("defaults: tournaments auto-accept with waitlist, roster-later and self check-in; leagues need approval", () => {
    expect(defaultRegistrationWindow("tournament", 16)).toEqual({ cap: 16, approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true } });
    expect(defaultRegistrationWindow("league")).toEqual({ cap: null, perRace: null, approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false });
    // a stored window over the defaults; the competition's cap (maxPlayers) wins; 0 = no cap
    expect(resolveRegistrationWindow("tournament", { waitlist: false, cap: 4 }, 0)).toMatchObject({ cap: null, waitlist: false, approval: "auto" });
    expect(resolveRegistrationWindow("league", { approval: "bogus" as never }, 8)).toMatchObject({ cap: 8, approval: "organiser" });
  });

  it("is open only when published, unfinished, not started/locked, and now is in [opensAt, closesAt)", () => {
    const at = (iso: string) => new Date(iso);
    const c = snapshot("tournament", {}, { opensAt: "2026-11-05T00:00:00.000Z", closesAt: "2026-11-20T00:00:00.000Z" });
    expect(windowStatus(c, NOW)).toEqual({ open: true });
    expect(windowStatus(c, at("2026-11-04T23:59:59.000Z"))).toMatchObject({ open: false, reason: "not-yet-open" });
    expect(windowStatus(c, at("2026-11-20T00:00:00.000Z"))).toMatchObject({ open: false, reason: "closed", message: "Registration is closed." });
    expect(windowStatus({ ...c, published: false }, NOW)).toMatchObject({ open: false, reason: "unpublished" });
    expect(windowStatus({ ...c, finished: true }, NOW)).toMatchObject({ open: false, reason: "finished" });
    expect(windowStatus({ ...c, locked: true }, NOW)).toMatchObject({ open: false, reason: "locked" });
    expect(windowStatus({ ...c, started: true }, NOW)).toMatchObject({ open: false, reason: "started" });
    // a league season may stay open while active with mid-season joining on
    const league = snapshot("league", { started: true }, { allowMidSeason: true });
    expect(windowStatus(league, NOW)).toEqual({ open: true });
  });

  it("cap, per-race room, counts and waitlist position", () => {
    const e = (id: string, state: RegistrationEntry["state"], race?: string, waitlistAt?: string): RegistrationEntry =>
      ({ id, competitionId: "c1", coach: id, state, submittedAt: "x", enteredAt: "x", log: [], ...(race ? { race } : {}), ...(waitlistAt ? { waitlistAt } : {}) });
    const rows = [e("a", "accepted", "Orc"), e("b", "accepted", "orc"), e("c", "waitlisted", "Elf", "2026-11-02T00:00:00Z"), e("d", "waitlisted", "Orc", "2026-11-01T00:00:00Z"), e("p", "pending")];
    const w: RegistrationWindow = { cap: 3, perRace: 2, approval: "auto", waitlist: true };
    expect(roomFor(w, rows, { id: "x", race: "Elf" })).toEqual({ ok: true });
    expect(roomFor(w, rows, { id: "x", race: "ORC" })).toEqual({ ok: false, code: "race-full" });
    expect(roomFor({ ...w, cap: 2 }, rows, { id: "x" })).toEqual({ ok: false, code: "full" });
    expect(roomFor({ ...w, cap: 2 }, rows, { id: "a" })).toEqual({ ok: true }); // never counts against itself
    expect(roomFor({ ...w, cap: null, perRace: null }, rows, { id: "x", race: "Orc" })).toEqual({ ok: true });
    expect(waitlistPosition(rows, "d")).toBe(1);
    expect(waitlistPosition(rows, "c")).toBe(2);
    expect(waitlistPosition(rows, "a")).toBeUndefined();
    expect(registrationCounts(w, rows)).toEqual({ accepted: 2, pending: 1, waitlisted: 2, cap: 3, placesLeft: 1 });
  });

  it("check-in opens 24 h before the start and closes at the start unless set", () => {
    const c = snapshot("tournament", { startAt: "2026-11-11T10:00:00.000Z" });
    expect(checkInWindow(c.window, c.startAt)).toEqual({ opensAt: "2026-11-10T10:00:00.000Z", closesAt: "2026-11-11T10:00:00.000Z", self: true });
    expect(isCheckInOpen(c, NOW)).toBe(true);
    expect(isCheckInOpen(c, new Date("2026-11-10T09:59:59.000Z"))).toBe(false);
    expect(isCheckInOpen(c, new Date("2026-11-11T10:00:00.000Z"))).toBe(false);
    expect(isCheckInOpen({ ...c, finished: true }, NOW)).toBe(false);
    expect(checkInWindow({ ...c.window, checkIn: { self: false, closesAt: "2026-11-11T09:00:00.000Z" } }, c.startAt))
      .toEqual({ opensAt: "2026-11-10T10:00:00.000Z", closesAt: "2026-11-11T09:00:00.000Z", self: false });
    expect(checkInWindow(c.window, undefined)).toBeUndefined();
  });

  it("legacy records: absent entryState = accepted, a dropped one = withdrawn", () => {
    expect(legacyEntryState({})).toBe("accepted");
    expect(legacyEntryState({ droppedAt: "2026-11-01T00:00:00Z" })).toBe("withdrawn");
    expect(legacyEntryState({ entryState: "pending" })).toBe("pending");
  });
});

describe("self registration", () => {
  it("auto mode: accepted while there is room, then waitlisted; waitlist off -> Full", async () => {
    const h = setup("tournament");
    expect((await h.svc.submit("c1", "Ann", me("Ann"))).entry.state).toBe("accepted");
    expect((await h.svc.submit("c1", "Bob", me("Bob"))).entry.state).toBe("accepted");
    const third = await h.svc.submit("c1", "Cy", me("Cy"));
    expect(third.entry).toMatchObject({ state: "waitlisted", waitlistAt: NOW.toISOString() });
    expect(await h.svc.position("c1", third.entry.id)).toBe(1);

    const off = setup("tournament", {}, { waitlist: false, cap: 1 });
    await off.svc.submit("c1", "Ann", me("Ann"));
    const full = await err(off.svc.submit("c1", "Bob", me("Bob")));
    expect([full.status, full.code, full.message]).toEqual([409, "full", "Full."]);
    expect(off.entries()).toHaveLength(1);
  });

  it("organiser mode: every self-entry is pending, whatever the room", async () => {
    const h = setup("league");
    const r = await h.svc.submit("c1", "Ann", me("Ann"), { race: "Orc", data: { teamRef: "save:1" } });
    expect(r.entry).toMatchObject({ state: "pending", race: "Orc", data: { teamRef: "save:1" } });
    expect(r.entry.log).toEqual([{ action: "submit", from: null, to: "pending", by: "Ann", at: NOW.toISOString() }]);
  });

  it("refuses outside the window, and organisers may still add a coach after it closed", async () => {
    const h = setup("tournament", {}, { closesAt: "2026-11-09T00:00:00.000Z" });
    const closed = await err(h.svc.submit("c1", "Ann", me("Ann")));
    expect([closed.status, closed.code]).toEqual([409, "closed"]);
    const added = await h.svc.submit("c1", "Ann", ORG);
    expect(added.entry).toMatchObject({ state: "accepted", decided: { by: "Olga" } });
    // ...but not once play started, and never for a non-organiser adding someone else
    h.adapter.update("c1", { started: true });
    expect((await err(h.svc.submit("c1", "Bob", ORG))).code).toBe("closed");
    h.adapter.update("c1", { started: false });
    expect((await err(h.svc.submit("c1", "Bob", me("Eve")))).status).toBe(403);
    expect((await err(h.svc.submit("nope", "Bob", ORG))).status).toBe(404);
  });

  it("an organiser adding a coach when it's full is refused unless they ask for the waitlist", async () => {
    const h = setup("tournament", {}, { cap: 1 });
    await h.svc.submit("c1", "Ann", me("Ann"));
    expect((await err(h.svc.submit("c1", "Bob", ORG))).code).toBe("full");
    expect((await h.svc.submit("c1", "Bob", ORG, { waitlistIfFull: true })).entry.state).toBe("waitlisted");
  });

  it("re-submitting a live entry changes nothing and notifies nobody (idempotent)", async () => {
    const h = setup("tournament");
    const first = await h.svc.submit("c1", "Ann", me("Ann"));
    const sent = h.sent.length;
    const again = await h.svc.submit("c1", "ann", me("ANN"));
    expect(again).toMatchObject({ changed: false, entry: { id: first.entry.id, state: "accepted" } });
    expect(h.sent.length).toBe(sent);
    expect(h.entries()).toHaveLength(1);
    expect(h.adapter.commits).toHaveLength(1);
  });
});

describe("transitions", () => {
  it("every organiser transition is audited, and repeating it is a no-op", async () => {
    const h = setup("league", {}, { cap: 1 });
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    const b = (await h.svc.submit("c1", "Bob", me("Bob"))).entry;
    const c = (await h.svc.submit("c1", "Cy", me("Cy"))).entry;
    h.tick();
    const accepted = await h.svc.accept("c1", a.id, ORG, "Welcome");
    expect(accepted.entry).toMatchObject({ state: "accepted", decided: { by: "Olga", reason: "Welcome" } });
    expect((await h.svc.accept("c1", a.id, ORG)).changed).toBe(false);
    // full: accepting Bob asks to raise the cap or waitlist
    const full = await err(h.svc.accept("c1", b.id, ORG));
    expect([full.status, full.code]).toEqual([409, "full"]);
    expect((await h.svc.waitlist("c1", b.id, ORG)).entry.state).toBe("waitlisted");
    expect((await h.svc.waitlist("c1", b.id, ORG)).changed).toBe(false);
    expect((await h.svc.decline("c1", c.id, { coach: "Pat" }, "Wrong roster")).entry).toMatchObject({ state: "declined", decided: { by: "Pat", reason: "Wrong roster" } });
    expect((await h.svc.decline("c1", c.id, ORG)).changed).toBe(false);
    expect(h.byCoach("Ann").log.map((t) => `${t.action}:${t.from}->${t.to}:${t.by}`)).toEqual(["submit:null->pending:Ann", "accept:pending->accepted:Olga"]);
    expect(h.byCoach("Cy").log.at(-1)).toEqual({ action: "decline", from: "pending", to: "declined", by: "Pat", at: new Date(NOW.getTime() + 1000).toISOString(), reason: "Wrong roster" });
    // invalid moves
    expect((await err(h.svc.decline("c1", a.id, ORG))).code).toBe("invalid-transition"); // accepted -> use drop
    expect((await err(h.svc.waitlist("c1", a.id, ORG))).code).toBe("invalid-transition");
    expect((await err(h.svc.accept("c1", c.id, ORG))).code).toBe("invalid-transition"); // declined
    expect((await err(h.svc.drop("c1", b.id, ORG))).code).toBe("invalid-transition"); // only accepted entries drop
    expect((await err(h.svc.accept("c1", "nope", ORG))).status).toBe(404);
  });

  it("only managers (or an admin) decide; a coach acts only on their own entry", async () => {
    const h = setup("league");
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    expect((await err(h.svc.accept("c1", a.id, me("Ann")))).status).toBe(403);
    expect((await err(h.svc.decline("c1", a.id, me("Eve")))).status).toBe(403);
    expect((await err(h.svc.withdraw("c1", a.id, me("Eve")))).status).toBe(403);
    expect((await h.svc.accept("c1", a.id, ADMIN)).entry.state).toBe("accepted");
  });

  it("withdraw: pending / waitlisted any time; accepted tournament entry until play starts; accepted league team = organiser only", async () => {
    const t = setup("tournament");
    const a = (await t.svc.submit("c1", "Ann", me("Ann"))).entry;
    const w = await t.svc.withdraw("c1", a.id, me("Ann"), "Can't make it");
    expect(w.entry).toMatchObject({ state: "withdrawn" });
    expect(w.entry.decided).toBeUndefined();
    expect((await t.svc.withdraw("c1", a.id, me("Ann"))).changed).toBe(false);
    const b = (await t.svc.submit("c1", "Bob", me("Bob"))).entry;
    t.adapter.update("c1", { started: true });
    expect((await err(t.svc.withdraw("c1", b.id, me("Bob")))).code).toBe("closed");
    expect((await t.svc.withdraw("c1", b.id, ORG)).entry.state).toBe("withdrawn");

    const l = setup("league");
    const x = (await l.svc.submit("c1", "Ann", me("Ann"))).entry;
    await l.svc.accept("c1", x.id, ORG);
    expect((await err(l.svc.withdraw("c1", x.id, me("Ann")))).code).toBe("organiser-only");
    expect((await l.svc.drop("c1", x.id, ORG, "Standby")).entry).toMatchObject({ state: "dropped", decided: { by: "Olga", reason: "Standby" } });
    expect((await l.svc.drop("c1", x.id, ORG)).changed).toBe(false);
    const y = (await l.svc.submit("c1", "Bob", me("Bob"))).entry;
    expect((await l.svc.withdraw("c1", y.id, me("Bob"))).entry.state).toBe("withdrawn"); // before a decision
  });

  it("re-entry: a withdrawn coach registers again with the same id, at the back of the waitlist when full", async () => {
    const h = setup("tournament");
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    await h.svc.submit("c1", "Bob", me("Bob"));
    await h.svc.withdraw("c1", a.id, me("Ann"));
    h.tick();
    await h.svc.submit("c1", "Cy", me("Cy")); // takes Ann's place
    h.tick();
    await h.svc.submit("c1", "Dee", me("Dee")); // full: waitlist #1
    h.tick();
    const back = await h.svc.submit("c1", "Ann", me("Ann"));
    expect(back.entry).toMatchObject({ id: a.id, state: "waitlisted", submittedAt: NOW.toISOString(), enteredAt: new Date(NOW.getTime() + 3000).toISOString() });
    expect(await h.svc.position("c1", a.id)).toBe(2);
    expect(back.entry.log.map((t) => t.action)).toEqual(["submit", "withdraw", "reenter"]);
    expect(h.entries()).toHaveLength(4);
    // with room, re-entry is accepted again
    const r = setup("tournament");
    const x = (await r.svc.submit("c1", "Ann", me("Ann"))).entry;
    await r.svc.withdraw("c1", x.id, me("Ann"));
    expect((await r.svc.submit("c1", "Ann", me("Ann"))).entry).toMatchObject({ id: x.id, state: "accepted" });
  });

  it("a declined or removed coach can't re-enter themselves; an organiser can renew them", async () => {
    const h = setup("league", {}, { cap: 4 });
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    await h.svc.decline("c1", a.id, ORG);
    expect((await err(h.svc.submit("c1", "Ann", me("Ann")))).code).toBe("declined");
    const b = (await h.svc.submit("c1", "Bob", me("Bob"))).entry;
    await h.svc.accept("c1", b.id, ORG);
    await h.svc.drop("c1", b.id, ORG);
    expect((await err(h.svc.submit("c1", "Bob", me("Bob")))).code).toBe("removed");
    expect((await h.svc.submit("c1", "Ann", ORG)).entry).toMatchObject({ id: a.id, state: "accepted" });
  });
});

describe("waitlist promotion", () => {
  it("auto mode: a freed place promotes the first in line (once), notified as promoted", async () => {
    const h = setup("tournament");
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    await h.svc.submit("c1", "Bob", me("Bob"));
    h.tick();
    await h.svc.submit("c1", "Cy", me("Cy"));
    h.tick();
    await h.svc.submit("c1", "Dee", me("Dee"));
    h.sent.length = 0;
    const w = await h.svc.withdraw("c1", a.id, me("Ann"));
    expect(w.promoted.map((e) => e.coach)).toEqual(["Cy"]);
    expect(h.byCoach("Cy")).toMatchObject({ state: "accepted", decided: { by: "system" } });
    expect(h.byCoach("Cy").waitlistAt).toBeUndefined();
    expect(h.byCoach("Cy").log.at(-1)).toMatchObject({ action: "promote", from: "waitlisted", to: "accepted", by: "system" });
    expect(h.byCoach("Dee").state).toBe("waitlisted");
    expect(await h.svc.position("c1", h.byCoach("Dee").id)).toBe(1);
    expect(h.sent.filter((s) => s.coach === "Cy").map((s) => [s.input.type, s.input.title, s.input.action])).toEqual([["registration-outcome", "You're in: Autumn Open", true]]);
    // nothing more to promote: a second pass changes nothing
    expect(await h.svc.promoteWaitlist("c1", ORG)).toEqual([]);
  });

  it("auto mode: raising the cap and running the promotion fills the places in order; repeating promotes nobody", async () => {
    const h = setup("tournament");
    for (const [i, c] of ["Ann", "Bob", "Cy", "Dee", "Eve"].entries()) { h.clock.t = NOW.getTime() + i; await h.svc.submit("c1", c, me(c)); }
    h.adapter.update("c1", { window: { ...defaultRegistrationWindow("tournament", 4) } });
    expect((await h.svc.promoteWaitlist("c1", ORG)).map((e) => e.coach)).toEqual(["Cy", "Dee"]);
    expect(await h.svc.promoteWaitlist("c1", ORG)).toEqual([]);
    expect(h.byCoach("Eve").state).toBe("waitlisted");
    expect((await err(h.svc.promoteWaitlist("c1", me("Ann")))).status).toBe(403);
  });

  it("auto mode: a per-race limit skips a waitlisted team whose race is full", async () => {
    const h = setup("league", {}, { approval: "auto", cap: 3, perRace: 1 });
    const a = (await h.svc.submit("c1", "Ann", me("Ann"), { race: "Orc" })).entry;
    await h.svc.submit("c1", "Bob", me("Bob"), { race: "Elf" });
    h.tick();
    expect((await h.svc.submit("c1", "Cy", me("Cy"), { race: "Elf" })).entry.state).toBe("waitlisted"); // race full
    h.tick();
    expect((await h.svc.submit("c1", "Dee", me("Dee"), { race: "Orc" })).entry.state).toBe("waitlisted");
    // Ann (Orc) leaves via the organiser: Cy (Elf, first in line) still doesn't fit, Dee (Orc) does
    await h.svc.drop("c1", a.id, ORG);
    expect(h.byCoach("Cy").state).toBe("waitlisted");
    expect(h.byCoach("Dee").state).toBe("accepted");
  });

  it("organiser mode: nobody is promoted automatically; the organisers hear a place opened (actionable)", async () => {
    const h = setup("league", {}, { cap: 1 });
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    const b = (await h.svc.submit("c1", "Bob", me("Bob"))).entry;
    await h.svc.accept("c1", a.id, ORG);
    await h.svc.waitlist("c1", b.id, ORG);
    h.sent.length = 0;
    const d = await h.svc.drop("c1", a.id, ORG);
    expect(d.promoted).toEqual([]);
    expect(h.byCoach("Bob").state).toBe("waitlisted");
    expect(await h.svc.promoteWaitlist("c1", ORG)).toEqual([]);
    const freed = h.sent.filter((s) => s.input.title === "A place opened in Autumn Open");
    expect(freed.map((s) => s.coach)).toEqual(["Pat"]); // the acting organiser is skipped (law 24)
    expect(freed[0]!.input).toMatchObject({ type: "registration", action: true, link: "/app/leagues/c1?tab=registrations" });
    // the organiser promotes: "promoted" outcome to the coach
    h.sent.length = 0;
    const p = await h.svc.accept("c1", b.id, ORG);
    expect(p.entry.log.at(-1)).toMatchObject({ action: "promote", by: "Olga" });
    expect(h.sent).toEqual([{ coach: "Bob", input: expect.objectContaining({ type: "registration-outcome", body: "A place opened and your entry moved off the waitlist.", action: true }) }]);
  });
});

describe("concurrency", () => {
  it("parallel registrations at the cap: exactly cap accepted, the rest waitlisted, ids unique", async () => {
    const h = setup("tournament", {}, { cap: 3 }, { yieldEveryRead: true });
    const coaches = Array.from({ length: 12 }, (_, i) => `Coach${i}`);
    const results = await Promise.all(coaches.map((c) => h.svc.submit("c1", c, me(c))));
    expect(results.filter((r) => r.entry.state === "accepted")).toHaveLength(3);
    expect(results.filter((r) => r.entry.state === "waitlisted")).toHaveLength(9);
    expect(h.entries().filter((e) => e.state === "accepted")).toHaveLength(3);
    expect(new Set(h.entries().map((e) => e.id)).size).toBe(12);
    const positions = await Promise.all(h.entries().filter((e) => e.state === "waitlisted").map((e) => h.svc.position("c1", e.id)));
    expect(positions.sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("parallel registrations with the waitlist off: never more than the cap", async () => {
    const h = setup("tournament", {}, { cap: 2, waitlist: false }, { yieldEveryRead: true });
    const settled = await Promise.allSettled(["A1", "A2", "A3", "A4", "A5"].map((c) => h.svc.submit("c1", c, me(c))));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(settled.filter((s) => s.status === "rejected").map((s) => ((s as PromiseRejectedResult).reason as RegistrationError).code)).toEqual(["full", "full", "full"]);
    expect(h.entries()).toHaveLength(2);
  });

  it("the same coach submitting twice at once gets one entry; two withdrawals at once promote once", async () => {
    const h = setup("tournament", {}, { cap: 2 }, { yieldEveryRead: true });
    const [x, y] = await Promise.all([h.svc.submit("c1", "Ann", me("Ann")), h.svc.submit("c1", "Ann", me("Ann"))]);
    expect([x.changed, y.changed].sort()).toEqual([false, true]);
    expect(h.entries()).toHaveLength(1);
    await h.svc.submit("c1", "Bob", me("Bob"));
    await h.svc.submit("c1", "Cy", me("Cy"));
    await h.svc.submit("c1", "Dee", me("Dee"));
    const ann = h.byCoach("Ann");
    const both = await Promise.all([h.svc.withdraw("c1", ann.id, me("Ann")), h.svc.withdraw("c1", ann.id, ORG)]);
    expect(both.flatMap((r) => r.promoted).map((e) => e.coach)).toEqual(["Cy"]);
    expect(h.entries().filter((e) => e.state === "accepted").map((e) => e.coach).sort()).toEqual(["Bob", "Cy"]);
    expect(h.byCoach("Ann").log.filter((t) => t.action === "withdraw")).toHaveLength(1);
  });

  it("KeyedLock serialises one key and leaves other keys free; a failing holder releases it", async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const slow = lock.run("a", async () => { await new Promise((r) => setTimeout(r, 5)); order.push("a1"); });
    const failing = lock.run("a", async () => { order.push("a2"); throw new Error("boom"); });
    const other = lock.run("b", () => { order.push("b1"); });
    const after = lock.run("a", () => { order.push("a3"); });
    await Promise.allSettled([slow, failing, other, after]);
    expect(order).toEqual(["b1", "a1", "a2", "a3"]);
    expect(lock.size).toBe(0);
  });
});

describe("test-session rule (Q13)", () => {
  it("a test sign-in writes only in a competition marked test; real sessions are unaffected", async () => {
    expect(testSessionMayWrite({ test: true }, { test: true })).toBe(true);
    expect(testSessionMayWrite({ test: true }, {})).toBe(false);
    expect(testSessionMayWrite({ test: true }, undefined)).toBe(false);
    expect(testSessionMayWrite({}, {})).toBe(true);
    expect(testSessionMayWrite(undefined, undefined)).toBe(true);
    expect(() => assertTestSessionMayWrite({ test: true }, { test: undefined })).toThrow(RegistrationError);

    const real = setup("tournament");
    const refused = await err(real.svc.submit("c1", "Tess", { coach: "Tess", test: true }));
    expect([refused.status, refused.code]).toEqual([403, "test-session"]);
    expect(real.entries()).toHaveLength(0);
    const a = (await real.svc.submit("c1", "Ann", me("Ann"))).entry;
    expect((await err(real.svc.withdraw("c1", a.id, { coach: "Olga", test: true }))).code).toBe("test-session");

    const test = setup("tournament", { test: true });
    expect((await test.svc.submit("c1", "Tess", { coach: "Tess", test: true })).entry.state).toBe("accepted");
  });
});

describe("notifications", () => {
  it("coach confirmation + organisers except the actor (law 24); DM flag only on actionable rows", async () => {
    const h = setup("tournament", {}, { cap: 1 });
    await h.svc.submit("c1", "Ann", me("Ann"));
    await h.svc.submit("c1", "Bob", me("Bob"));
    const rows = h.sent.map((s) => ({ to: s.coach, type: s.input.type, title: s.input.title, action: s.input.action ?? false }));
    expect(rows).toEqual([
      { to: "Ann", type: "registration-outcome", title: "You're in: Autumn Open", action: true },
      { to: "Olga", type: "registration", title: "Ann registered for Autumn Open", action: false },
      { to: "Pat", type: "registration", title: "Ann registered for Autumn Open", action: false },
      { to: "Bob", type: "registration-outcome", title: "On the waitlist: Autumn Open", action: false },
      { to: "Olga", type: "registration", title: "Bob registered for Autumn Open", action: false },
      { to: "Pat", type: "registration", title: "Bob registered for Autumn Open", action: false },
    ]);
    expect(h.sent[3]!.input.body).toBe("It's full, so you're #1 on the waitlist. You'll hear if a place opens.");
    expect(h.sent[0]!.input.link).toBe("/app/tournaments/c1");
    expect(h.sent[1]!.input.link).toBe("/app/tournaments/c1?tab=registrations");

    // approval mode: the organisers' row is actionable; an organiser adding a coach is not notified themselves
    const l = setup("league");
    await l.svc.submit("c1", "Ann", me("Ann"));
    expect(l.sent.filter((s) => s.input.type === "registration").every((s) => s.input.action === true)).toBe(true);
    expect(l.sent.find((s) => s.coach === "Ann")!.input).toMatchObject({ title: "Entry received: Autumn Open" });
    expect(l.sent.find((s) => s.coach === "Ann")!.input.action).toBeUndefined();
    l.sent.length = 0;
    await l.svc.submit("c1", "Bob", ORG);
    expect(l.sent.map((s) => s.coach)).toEqual(["Bob", "Pat"]);
    expect(l.sent[1]!.input.body).toBe("Olga entered Bob. They're in.");
  });

  it("decline, removal and withdrawal texts; withdrawal goes to the organisers, never a DM", async () => {
    const h = setup("league", {}, { cap: 3 });
    const a = (await h.svc.submit("c1", "Ann", me("Ann"))).entry;
    const b = (await h.svc.submit("c1", "Bob", me("Bob"))).entry;
    h.sent.length = 0;
    await h.svc.decline("c1", a.id, ORG, "Roster not legal");
    expect(h.sent).toEqual([{ coach: "Ann", input: expect.objectContaining({ type: "registration-outcome", title: "Entry declined: Autumn Open", body: "The organisers declined your entry: Roster not legal", action: true }) }]);
    h.sent.length = 0;
    await h.svc.withdraw("c1", b.id, me("Bob"));
    expect(h.sent.map((s) => [s.coach, s.input.type, s.input.action ?? false])).toEqual([["Olga", "withdrawal", false], ["Pat", "withdrawal", false]]);
    // a notify sink that throws never changes the result
    const boom = createRegistrationService({ adapter: h.adapter, notify: () => { throw new Error("down"); }, now: () => NOW, lock: new KeyedLock(), log: () => {} });
    expect((await boom.submit("c1", "Cy", me("Cy"))).entry.state).toBe("pending");
  });

  it("check-in notice: once, to accepted entrants, only while the window is open", async () => {
    const h = setup("tournament", { startAt: "2026-11-12T10:00:00.000Z" }, { cap: 2 });
    await h.svc.submit("c1", "Ann", me("Ann"));
    await h.svc.submit("c1", "Bob", me("Bob"));
    await h.svc.submit("c1", "Cy", me("Cy")); // waitlisted
    h.sent.length = 0;
    expect(await h.svc.sendCheckInNotices("c1")).toBe(0); // opens 2026-11-11T10:00
    h.clock.t = Date.parse("2026-11-11T10:00:00.000Z");
    expect(await h.svc.sendCheckInNotices("c1")).toBe(2);
    expect(await h.svc.sendCheckInNotices("c1")).toBe(0);
    expect(h.sent.map((s) => [s.coach, s.input.type, s.input.body])).toEqual([
      ["Ann", "check-in", "Check in before 2026-11-12 10:00 UTC."], ["Bob", "check-in", "Check in before 2026-11-12 10:00 UTC."],
    ]);
    expect(h.adapter.competition("c1")!.checkInNoticeAt).toBe("2026-11-11T10:00:00.000Z");
  });
});

describe("notification types and Discord DM rows (Q18)", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); clearFences(); });
  beforeEach(() => clearFences());

  it("the new types are known to the store and the SPA", () => {
    for (const t of ["registration-outcome", "check-in", "organiser-request"] as const) {
      expect(NOTIFICATION_TYPES).toContain(t);
      expect(NOTIFICATION_ICONS[t]).toMatch(/^\/icons\//);
    }
  });

  it("registration rows DM only when flagged: outcomes accepted/declined/promoted and approval-needed organiser rows", () => {
    expect([...ACTION_DM_WHEN_FLAGGED].sort()).toEqual(["registration", "registration-outcome"]);
    const url = "https://site.example.test/app/tournaments/c1";
    const outcome = { type: "registration-outcome" as const, from: "", title: "You're in: Autumn Open", link: "/app/tournaments/c1" };
    expect(actionDmText({ record: outcome, url })).toBeUndefined();
    expect(actionDmText({ record: outcome, url, action: true })).toEqual({
      text: String.raw`You're in\: Autumn Open. See your entry: ${url}`, plain: `You're in: Autumn Open. See your entry: ${url}`,
    });
    // today's tournament registration notice (no flag) stays bell-only
    const reg = { type: "registration" as const, from: "Ann", title: "Ann registered for Autumn Open", link: "/app/tournaments/c1?tab=entrants" };
    expect(actionDmText({ record: reg, url })).toBeUndefined();
    expect(actionDmText({ record: reg, url, action: true })!.plain).toBe(`Ann registered for Autumn Open. Review registrations: ${url}`);
    // names in the title can't inject links
    const evil = actionDmText({ record: { ...outcome, title: "You're in: [x](https://evil.example)" }, url, action: true })!;
    expect(evil.text.match(/https?:\/\//g)).toHaveLength(1);
    // check-in and organiser-request have no DM row in this lane
    expect(actionDmText({ record: { ...outcome, type: "check-in" }, url, action: true })).toBeUndefined();
    expect(actionDmText({ record: { ...outcome, type: "organiser-request" }, url, action: true })).toBeUndefined();
  });

  it("end to end through the notification store and the mail service (memory transport): one DM per actionable row, opt-out respected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "regcore-")); roots.push(dir);
    const ids: Record<string, string> = { ann: "900000000000000101", bob: "900000000000000202", olga: "900000000000000303", pat: "900000000000000404" };
    const dm = new MemoryTransport();
    const svcMail = createMailService(dir, { MAIL_LINK_SECRET: "x".repeat(40), MAIL_LINK_BASE_URL: "https://site.example.test", MAIL_FROM: "noreply@site.example.test" }, {
      identity: (coach: string) => {
        const key = coach.trim().toLowerCase();
        return ids[key] ? { ffbCoachId: key, identities: { discordUserId: ids[key] }, consent: {} } : undefined;
      },
      transport: new MemoryTransport(), discordTransport: dm, discordSleep: async () => {}, now: () => NOW.getTime(), log: () => {},
    });
    const store = new NotificationStore(dir, { now: () => NOW, onAdded: (coach, record, _u, input) => { svcMail.notifyAction(coach, record, input); } });
    // Pat opts out of DMs
    expect(svcMail.meRoute("POST", "/api/me/notification-settings", { coach: "Pat" }, { discordDm: false })!.status).toBe(200);
    const adapter = new MemoryRegistrationAdapter("league").put(snapshot("league", {}, { cap: 1 }));
    const reg = createRegistrationService({ adapter, notify: (coach, input) => store.add(coach, input), now: () => NOW, lock: new KeyedLock(), log: () => {} });
    const a = (await reg.submit("c1", "Ann", me("Ann"))).entry; // pending: organisers DM'd (Olga; Pat opted out), Ann not
    await reg.accept("c1", a.id, ORG); // Ann DM'd
    const b = (await reg.submit("c1", "Bob", me("Bob"))).entry;
    await reg.waitlist("c1", b.id, ORG); // waitlisted: bell only
    const rows = svcMail.outbox.list().filter((e) => e.channel === "discord").map((e) => [e.recipient?.coach, e.message?.text]); // recipients by identity key
    expect(rows).toEqual([
      ["olga", String.raw`Ann registered for Autumn Open. Review registrations: https://site.example.test/app/leagues/c1?tab=registrations`],
      ["ann", String.raw`You're in\: Autumn Open. See your entry: https://site.example.test/app/leagues/c1`],
      ["olga", String.raw`Bob registered for Autumn Open. Review registrations: https://site.example.test/app/leagues/c1?tab=registrations`],
    ]);
    // every row is on the bell
    expect(store.list("Bob").notifications.map((n) => n.type)).toEqual(["registration-outcome", "registration-outcome"]);
    expect(store.list("Pat").notifications).toHaveLength(2);
    expect(JSON.stringify(svcMail.outbox.list())).not.toContain(ids.ann);
  });
});

describe("shared-contact visibility (Q15)", () => {
  const scope = parseShareScope("tournament:c1")!;
  const leagueScope = parseShareScope("league:c1")!;
  const coach = (over: Partial<CoachIdentityRecord["consent"]> = {}): CoachIdentityRecord => ({
    ffbCoachId: "ann",
    contact: { email: "ann@example.test", emailSource: "user", emailVerified: true, phones: [{ country: "GB", number: "+447700900123" }] },
    profile: { preferredName: "Annie" },
    consent: { sharing: { "tournament:c1": { fields: ["preferredName", "email"], at: "2026-11-10T12:00:00.000Z", version: "v1" } }, ...over },
  } as unknown as CoachIdentityRecord);
  const entry = (state: RegistrationEntry["state"], enteredAt = "2026-11-10T12:00:00.000Z") => ({ competitionId: "c1", coach: "Ann", state, enteredAt });

  it("organisers see the granted fields while pending, waitlisted or accepted; nothing on decline, withdrawal or removal", () => {
    for (const s of ["pending", "waitlisted", "accepted"] as const) {
      expect(registrationContactFor(ORG, coach(), scope, entry(s), ["Olga"])).toEqual({ coach: "ann", preferredName: "Annie", email: "ann@example.test" });
    }
    for (const s of ["declined", "withdrawn", "dropped"] as const) expect(registrationContactFor(ORG, coach(), scope, entry(s), ["Olga"])).toBeUndefined();
  });

  it("only managers or admins; the entry must be this coach's, in this competition; a grant older than the entry shows nothing", () => {
    expect(registrationContactFor(me("Eve"), coach(), scope, entry("pending"), ["Olga"])).toBeUndefined();
    expect(registrationContactFor({ coach: "Eve", admin: true }, coach(), scope, entry("pending"), ["Olga"])).toMatchObject({ email: "ann@example.test" });
    expect(registrationContactFor(ORG, coach(), scope, { ...entry("pending"), coach: "Bob" }, ["Olga"])).toBeUndefined();
    expect(registrationContactFor(ORG, coach(), scope, { ...entry("pending"), competitionId: "c2" }, ["Olga"])).toBeUndefined();
    expect(registrationContactFor(ORG, undefined, scope, entry("pending"), ["Olga"])).toBeUndefined();
    // a re-entry after the grant: the old grant does not carry over (the sheet asks again)
    expect(registrationContactFor(ORG, coach(), scope, entry("pending", "2026-11-11T00:00:00.000Z"), ["Olga"])).toEqual({ coach: "ann" });
    // no grant at all: the coach name only
    expect(registrationContactFor(ORG, coach({ sharing: {} }), scope, entry("pending"), ["Olga"])).toEqual({ coach: "ann" });
  });

  it("a league grant counts only with the league notice acknowledgement", () => {
    const grant = { "league:c1": { fields: ["phone"], at: "2026-11-10T12:00:00.000Z", version: "v1" } };
    expect(registrationContactFor(ORG, coach({ sharing: grant } as never), leagueScope, entry("pending"), ["Olga"])).toEqual({ coach: "ann" });
    const acked = coach({ sharing: grant, leagues: { c1: { at: "2026-11-10T12:00:00.000Z", version: "v1" } } } as never);
    expect(registrationContactFor(ORG, acked, leagueScope, entry("waitlisted"), ["Olga"])).toEqual({ coach: "ann", phones: [{ country: "GB", number: "+447700900123" }] });
  });
});

describe("privacy coverage", () => {
  it("delete anonymises the decision and audit trail on entrants and league registration rows; export finds the coach's rows", () => {
    const an = createAnonymiser(["Olga"], "Deleted coach #7");
    const tx = createTextReplacer(["Olga"], "Deleted coach #7");
    const entrant: Record<string, unknown> = {
      id: "t1:entrant:1", coach: { ffbCoachId: "Ann" }, entryState: "declined",
      decided: { by: "Olga", at: "x", reason: "Olga says no" },
      [REGISTRATION_LOG_FIELD]: [{ action: "submit", by: "Ann", at: "x" }, { action: "decline", by: "olga", at: "x", reason: "Asked Olga" }],
    };
    expect(anonymiseRegistrationTrail(an, tx, entrant)).toBe(true);
    expect(entrant.decided).toEqual({ by: "Deleted coach #7", at: "x", reason: "Deleted coach #7 says no" });
    expect(entrant[REGISTRATION_LOG_FIELD]).toEqual([{ action: "submit", by: "Ann", at: "x" }, { action: "decline", by: "deleted coach #7", at: "x", reason: "Asked Deleted coach #7" }]);
    expect(anonymiseRegistrationTrail(an, tx, entrant)).toBe(false); // idempotent

    const self = createAnonymiser(["Ann"], "Deleted coach #8");
    const selfTx = createTextReplacer(["Ann"], "Deleted coach #8");
    const row: Record<string, unknown> = { id: "r1", coach: "Ann", discordUserId: "900000000000000101", state: "pending", decidedBy: "Olga", [REGISTRATION_LOG_FIELD]: [{ by: "Ann" }] };
    expect(anonymiseLeagueRegistration(self, selfTx, row)).toBe(true);
    expect(row).toEqual({ id: "r1", coach: "Deleted coach #8", state: "pending", decidedBy: "Olga", [REGISTRATION_LOG_FIELD]: [{ by: "Deleted coach #8" }] });

    const season = { registrations: [{ coach: "Ann" }, { coach: "Bob" }, { coachId: "ann" }, "junk"] };
    expect(ownLeagueRegistrations(season, (v) => typeof v === "string" && v.toLowerCase() === "ann")).toEqual([{ coach: "Ann" }, { coachId: "ann" }]);
    expect(ownLeagueRegistrations(undefined, () => true)).toEqual([]);
  });
});
