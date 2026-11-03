import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { REF_CODE, referenceCodes, registrationCommitGuard, sweepTournamentRegistrations, toRegistrationEntry, tournamentRegistrationService } from "../src/tournaments/registration.js";
import { inShareScope } from "../src/auth/contactFor.js";
import { sharingView } from "../src/auth/sharing.js";
import { registrationContactFor } from "../src/registration/index.js";
import { parseShareScope } from "../src/auth/contactFor.js";
import { isTournamentMember } from "../src/auth/contactFor.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { onboardingGateApplies } from "../src/auth/onboarding.js";
import { STORE_COLLECTORS } from "../src/privacy/collectors.js";
import { createTournamentNotifier, type NotificationInput } from "../src/notifications.js";
import type { CoachIdentityRecord } from "../src/auth/identitiesStore.js";
import type { TournamentRecord, TournamentSubmission } from "../src/tournaments/types.js";

// Lane L4 (registration spec 2026-11-02 §7, wizards v2 check-in / "I've paid"): the coach registration flow (a Roster
// Builder save, roster later and its deadline, region, share grants, NAF), approval and the waitlist (auto vs organiser,
// promotion exactly once, the cap race), organisers notified on every registration and withdrawal (law 24), check-in
// (notices, self, one click, no-shows, remove + promote), "I've paid" and the reference code, and the Sol hunt list.
// Each test has its own state dir (laws §C14); no transport is real (the notifier is a stub).

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const OWNER: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const CO: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
const OTHER_ORG: TournamentApiIdentity = { coach: "Ozzel", organizer: true, admin: false };
const coach = (name: string, extra: Partial<TournamentApiIdentity> = {}): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false, ...extra });
const owners: Record<string, string> = { "team-alice": "Alice", "team-bob": "Bob", "team-carol": "Carol", "team-dee": "Dee", "team-eve": "Eve" };

interface Sent { coach: string; input: NotificationInput; to: "coach" | "managers"; except?: string }

function harness(start = "2026-11-10T12:00:00.000Z") {
  const root = mkdtempSync(join(tmpdir(), "bbtv-treg-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const clock = { now: new Date(start) };
  /** The coaches' live saves turned bad after submission (lock / start must not read them). */
  const live = { bad: false };
  const sent: Sent[] = [];
  const grants: Array<{ coach: string; scope: string; fields: string[]; at: string }> = [];
  const naf: Record<string, { nafName: string; nafId: string }> = {};
  const identities: Record<string, CoachIdentityRecord> = {};
  const notifier = createTournamentNotifier({ add: (c, input) => { sent.push({ coach: c, input, to: "coach" }); return undefined as never; } }, store);
  const deps = (): TournamentApiDeps => ({
    store,
    now: () => clock.now,
    teamBuild: (teamId) => (owners[teamId] ? { teamId, teamName: `${owners[teamId]} Orcs`, race: "Orc" } : undefined),
    teamOwner: (teamId) => owners[teamId],
    packageExists: (name) => name === "Spike 2026",
    registeredCoach: (name) => name,
    identityRecord: (c) => (naf[c.toLowerCase()] ? { ffbCoachId: c, identities: naf[c.toLowerCase()]! } : undefined),
    validateSubmission: (c, ref, packageName, at) => {
      if (ref === "save:missing") return { error: "Save not found.", status: 404 };
      const ok = ref !== "save:bad" && !live.bad;
      const s: TournamentSubmission = {
        saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${c} Save`, race: "Orc", snapshot: { ref },
        validation: { ok, problems: ok ? [] : ["Too many big guys."], checkedAt: at.toISOString(), packageName },
      };
      return s;
    },
    notify: notifier,
    sharing: {
      grant: (c, scope, fields, at) => {
        grants.push({ coach: c, scope, fields, at: at.toISOString() });
        const rec = identities[c.toLowerCase()] ?? ({ ffbCoachId: c, contact: { email: `${c.toLowerCase()}@example.test`, emailSource: "user", emailVerified: true, phones: [] }, profile: { preferredName: `${c} P` }, consent: {} } as unknown as CoachIdentityRecord);
        rec.consent = { ...(rec.consent ?? {}), sharing: { ...(rec.consent?.sharing ?? {}), [scope]: { fields, at: at.toISOString(), version: "v1" } } } as CoachIdentityRecord["consent"];
        identities[c.toLowerCase()] = rec;
      },
      contact: () => undefined,
      registrationContacts: (viewer, entries, managers) => entries.map((e) => registrationContactFor(viewer, identities[e.coach.toLowerCase()], parseShareScope(`tournament:${e.competitionId}`)!, e, managers)),
    },
  });
  const call = (method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) =>
    tournamentApi(method, path, new URLSearchParams(), auth, body, deps());
  const create = async (extra: Record<string, unknown> = {}): Promise<TournamentRecord> => {
    const res = await call("POST", "/api/tournaments", OWNER, {
      name: "Spike Open", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true,
      startsAt: "2026-12-05T09:00:00.000Z", registration: { approval: "auto", waitlist: true, rosterLater: true }, ...extra,
    });
    expect(res?.status).toBe(201);
    const t = (res!.body as { tournament: TournamentRecord }).tournament;
    await call("POST", `/api/tournaments/${t.id}/organizers/Piett`, OWNER);
    sent.length = 0;
    return store.tournament(t.id)!;
  };
  const register = (t: TournamentRecord, who: string, body: Record<string, unknown> = {}) =>
    call("POST", `/api/tournaments/${t.id}/entrants`, coach(who), { teamId: `team-${who.toLowerCase()}`, ...body });
  const detail = async (t: TournamentRecord, who?: TournamentApiIdentity) => (await call("GET", `/api/tournaments/${t.id}`, who))!.body as Record<string, unknown> & {
    entrants: Array<Record<string, unknown>>; tournament: Record<string, unknown>; myRegistration?: Record<string, unknown>; registrationStatus: Record<string, unknown>;
  };
  const panel = async (t: TournamentRecord, who: TournamentApiIdentity = OWNER) => (await call("GET", `/api/tournaments/${t.id}/registrations`, who))!;
  const stateOf = (t: TournamentRecord, who: string) => store.registrationEntries(t.id).find((r) => r.coach.ffbCoachId === who)?.entryState ?? (store.registrationEntries(t.id).some((r) => r.coach.ffbCoachId === who) ? "accepted" : undefined);
  return { live, store, clock, sent, grants, naf, identities, call, create, register, detail, panel, stateOf, deps };
}

describe("coach registration flow", () => {
  it("registers with a Roster Builder save: validated, stored as the submission, accepted, a reference code", async () => {
    const h = harness();
    const t = await h.create();
    const res = await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { teamRef: "save:good", share: [] });
    expect(res?.status).toBe(201);
    expect(res?.body).toMatchObject({ registration: { state: "accepted" }, entrant: { teamId: "", submission: { saveId: "save:good", validation: { ok: true } } } });
    const row = h.store.entrants(t.id)[0]!;
    expect(row.refCode).toMatch(/^SF-[23456789A-HJ-NP-Z]{4}$/);
    expect(row.flags?.rosterVerified).toBe(true);
    // an invalid save is still an entry (the coach sees the problems); a missing save is refused
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Bob"), { teamRef: "save:bad" }))?.status).toBe(201);
    expect(h.store.entrants(t.id)[1]!.submission?.validation.problems).toEqual(["Too many big guys."]);
    expect(await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Carol"), { teamRef: "save:missing" })).toMatchObject({ status: 404 });
    // an organiser cannot register a coach with that coach's save
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, OWNER, { coach: "Carol", teamRef: "save:good" }))?.status).toBe(400);
    // the coach is told (confirmation), the organisers too (law 24), never the actor as an organiser
    expect(h.sent.filter((s) => s.coach === "Alice").map((s) => s.input.type)).toEqual(["registration-outcome"]);
  });

  it("roster later: allowed when the organiser lets it, no team stored, a held entry may submit; refused when off", async () => {
    const h = harness();
    const t = await h.create({ registration: { approval: "auto", waitlist: true, rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z" } });
    const res = await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { rosterLater: true });
    expect(res?.status).toBe(201);
    expect(h.store.entrants(t.id)[0]).toMatchObject({ teamId: "" });
    expect(h.store.entrants(t.id)[0]!.submission).toBeUndefined();
    expect((await h.call("POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:good" }))?.status).toBe(201);
    const strict = await h.create({ name: "Strict", registration: { approval: "auto", waitlist: true, rosterLater: false } });
    expect(await h.call("POST", `/api/tournaments/${strict.id}/entrants`, coach("Alice"), { rosterLater: true })).toMatchObject({ status: 400, body: { code: "roster-required" } });
    // a tournament written before registration settings needs a team (absent = today's behaviour)
    const legacy = await h.call("POST", "/api/tournaments", OWNER, { name: "Old", packageName: "Spike 2026", maxPlayers: 4, format: "swiss" });
    const old = (legacy!.body as { tournament: TournamentRecord }).tournament;
    expect((await h.call("POST", `/api/tournaments/${old.id}/entrants`, coach("Bob"), { rosterLater: true }))?.status).toBe(400);
  });

  it("the roster deadline: after it no roster-later entry and no roster changes (409); before it a reminder once", async () => {
    const h = harness("2026-11-28T20:00:00.000Z");
    const t = await h.create({ registration: { approval: "auto", waitlist: true, rosterLater: true, rosterBy: "2026-12-01T18:00:00.000Z" } });
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { rosterLater: true });
    await h.register(t, "Bob");
    h.sent.length = 0;
    const service = tournamentRegistrationService(h.store, { now: () => h.clock.now });
    const sink = (c: string, input: NotificationInput) => h.sent.push({ coach: c, input, to: "coach" });
    expect(await sweepTournamentRegistrations(h.store, service, sink, h.clock.now)).toEqual({ checkIn: 0, rosterDue: 0 });
    h.clock.now = new Date("2026-11-30T19:00:00.000Z"); // within 48 h
    expect((await sweepTournamentRegistrations(h.store, service, sink, h.clock.now)).rosterDue).toBe(1);
    expect(h.sent).toEqual([{ coach: "Alice", to: "coach", input: expect.objectContaining({ type: "roster-problems", action: true, title: "Spike Open: your roster is due" }) }]);
    expect((await sweepTournamentRegistrations(h.store, service, sink, h.clock.now)).rosterDue).toBe(0);
    h.clock.now = new Date("2026-12-01T18:00:00.000Z");
    expect(await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Carol"), { rosterLater: true })).toMatchObject({ status: 409, body: { code: "roster-deadline" } });
    expect((await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Carol"), {}))?.status).toBe(400);
    expect((await h.register(t, "Carol"))?.status).toBe(201);
    expect(await h.call("POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:good" })).toMatchObject({ status: 409, body: { code: "roster-deadline" } });
  });

  it("registration closes at deadlines.registration, also on a tournament without registration settings", async () => {
    const h = harness();
    const legacy = await h.call("POST", "/api/tournaments", OWNER, { name: "Old", packageName: "Spike 2026", maxPlayers: 4, format: "swiss" });
    const old = (legacy!.body as { tournament: TournamentRecord }).tournament;
    expect((await h.call("PATCH", `/api/tournaments/${old.id}`, OWNER, { deadlines: { registration: "2026-11-10T11:00:00.000Z" } }))?.status).toBe(200);
    expect(await h.register(old, "Alice")).toMatchObject({ status: 409, body: { code: "closed" } });
    // organisers may still add a coach
    expect((await h.call("POST", `/api/tournaments/${old.id}/entrants`, OWNER, { coach: "Alice", teamId: "team-alice" }))?.status).toBe(201);
  });

  it("region: required from the organisers' list, stored, shown to the coach and managers only", async () => {
    const h = harness();
    const t = await h.create({ regions: ["North", "South"] });
    expect(await h.register(t, "Alice")).toMatchObject({ status: 400, body: { error: "Pick your region." } });
    expect(await h.register(t, "Alice", { region: "Mars" })).toMatchObject({ status: 400, body: { code: "region" } });
    expect((await h.register(t, "Alice", { region: "North" }))?.status).toBe(201);
    expect(h.store.entrants(t.id)[0]!.region).toBe("North");
    expect(JSON.stringify((await h.detail(t, coach("Zed"))).entrants)).not.toContain("North");
    expect(JSON.stringify((await h.detail(t)).entrants)).not.toContain("North");
    expect((await h.detail(t, coach("Alice"))).entrants[0]).toMatchObject({ region: "North" });
    expect((await h.detail(t, CO)).entrants[0]).toMatchObject({ region: "North" });
    // no regions: a region value is refused
    const plain = await h.create({ name: "Plain" });
    expect((await h.register(plain, "Alice", { region: "North" }))?.status).toBe(400);
  });

  it("share grants: written after the entry so they count; shown while pending; never after a decline or withdrawal", async () => {
    const h = harness();
    const t = await h.create({ registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    expect((await h.register(t, "Alice", { share: ["email"] }))?.status).toBe(201);
    expect(h.grants).toEqual([{ coach: "Alice", scope: `tournament:${t.id}`, fields: ["email"], at: h.clock.now.toISOString() }]);
    const row = () => ((h.panel(t)).then((r) => (r.body as { entries: Array<{ coachId: string; shared?: unknown; state: string }> }).entries.find((e) => e.coachId === "Alice")));
    expect(await row()).toMatchObject({ state: "pending", shared: { coach: "Alice", email: "alice@example.test" } });
    const id = h.store.registrationEntries(t.id)[0]!.id;
    expect((await h.call("POST", `/api/tournaments/${t.id}/registrations/${encodeURIComponent(id)}/decline`, OWNER, { reason: "Wrong league" }))?.status).toBe(200);
    const declined = await row();
    expect(declined).toMatchObject({ state: "declined" });
    expect(declined).not.toHaveProperty("shared");
    expect(JSON.stringify(declined)).not.toContain("alice@example.test");
    // withdrawn: same
    await h.register(t, "Bob", { share: ["email"] });
    const bob = h.store.registrationEntries(t.id).find((r) => r.coach.ffbCoachId === "Bob")!;
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(bob.id)}`, coach("Bob"));
    expect(JSON.stringify((await h.panel(t)).body)).not.toContain("bob@example.test");
    // the coach sees the reason (they were told it), never who decided
    const mine = (await h.detail(t, coach("Alice"))).myRegistration!;
    expect(mine).toMatchObject({ state: "declined", reason: "Wrong league" });
    expect(JSON.stringify(mine)).not.toContain("Veers");
  });
});

describe("NAF on a sanctioned tournament", () => {
  it("required from the profile; 'not a NAF member' is accepted and flagged to the organisers (not the coach)", async () => {
    const h = harness();
    const t = await h.create({ nafSanctioned: true });
    expect(await h.register(t, "Alice")).toMatchObject({ status: 400 });
    expect((await h.register(t, "Alice", { notNafMember: true }))?.status).toBe(201);
    const orgs = h.sent.filter((s) => s.input.type === "registration").map((s) => [s.coach, s.input.title]);
    expect(orgs).toEqual([["Veers", "Alice registered for Spike Open — not a NAF member"], ["Piett", "Alice registered for Spike Open — not a NAF member"]]);
    h.naf.bob = { nafName: "Bob Fake", nafId: "42" };
    expect((await h.register(t, "Bob"))?.status).toBe(201);
    const manager = (await h.detail(t, OWNER)).entrants;
    expect(manager.find((e) => e.coachId === "Bob")).toMatchObject({ nafNumber: "42", nafName: "Bob Fake" });
    expect(JSON.stringify((await h.detail(t, coach("Zed"))).entrants)).not.toContain("Bob Fake");
  });
});

describe("approval and the waitlist", () => {
  it("auto: accepted while there is room, then the waitlist in order; a freed place promotes the first once", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2 });
    for (const c of ["Alice", "Bob"]) expect((await h.register(t, c))?.body).toMatchObject({ registration: { state: "accepted" } });
    expect((await h.register(t, "Carol"))?.body).toMatchObject({ registration: { state: "waitlisted", position: 1 } });
    expect((await h.register(t, "Dee"))?.body).toMatchObject({ registration: { state: "waitlisted", position: 2 } });
    // pending / waitlisted never reach the field or the public counts
    expect(h.store.entrants(t.id).map((e) => e.coach.ffbCoachId)).toEqual(["Alice", "Bob"]);
    const pub = await h.detail(t);
    expect(pub.tournament.entrantCount).toBe(2);
    expect(pub.registrationStatus).toMatchObject({ placesLeft: 0, cap: 2 });
    expect(JSON.stringify(pub)).not.toContain("Carol");
    h.sent.length = 0;
    const alice = h.store.entrants(t.id)[0]!;
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(alice.id)}`, coach("Alice"));
    expect(h.store.entrants(t.id).filter((e) => !e.droppedAt).map((e) => e.coach.ffbCoachId)).toEqual(["Bob", "Carol"]);
    expect(h.sent.filter((s) => s.coach === "Carol").map((s) => s.input.title)).toEqual(["You're in: Spike Open"]);
    // promoting again (cap unchanged) promotes nobody
    expect(await tournamentRegistrationService(h.store).promoteWaitlist(t.id, { coach: "Veers" })).toEqual([]);
    expect(h.stateOf(t, "Dee")).toBe("waitlisted");
    // raising the cap promotes Dee, exactly once
    h.sent.length = 0;
    expect((await h.call("PATCH", `/api/tournaments/${t.id}`, OWNER, { maxPlayers: 3 }))?.status).toBe(200);
    expect(h.stateOf(t, "Dee")).toBe("accepted");
    expect(h.sent.filter((s) => s.coach === "Dee" && s.input.type === "registration-outcome")).toHaveLength(1);
  });

  it("organiser mode: every self-entry is pending; accept / waitlist / decline / promote; full refuses accept", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2, registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    for (const c of ["Alice", "Bob", "Carol"]) expect((await h.register(t, c))?.body).toMatchObject({ registration: { state: "pending" } });
    // organisers get an actionable notice (DM) for a pending entry
    expect(h.sent.find((s) => s.coach === "Veers" && s.input.type === "registration")?.input.action).toBe(true);
    expect(h.store.entrants(t.id)).toHaveLength(0);
    const id = (who: string) => encodeURIComponent(h.store.registrationEntries(t.id).find((r) => r.coach.ffbCoachId === who)!.id);
    const act = (who: string, verb: string, by = OWNER) => h.call("POST", `/api/tournaments/${t.id}/registrations/${id(who)}/${verb}`, by, {});
    expect((await act("Alice", "accept"))?.body).toMatchObject({ entry: { state: "accepted" } });
    expect((await act("Bob", "accept", CO))?.body).toMatchObject({ entry: { state: "accepted" } });
    expect(await act("Carol", "accept")).toMatchObject({ status: 409, body: { code: "full" } });
    expect((await act("Carol", "waitlist"))?.body).toMatchObject({ entry: { state: "waitlisted" } });
    const panel = (await h.panel(t)).body as { counts: Record<string, number>; entries: Array<{ coachId: string; nextInLine?: boolean; position?: number }> };
    expect(panel.counts).toMatchObject({ accepted: 2, pending: 0, waitlisted: 1 });
    expect(panel.entries.find((e) => e.coachId === "Carol")).toMatchObject({ nextInLine: true, position: 1 });
    // a freed place in organiser mode tells the organisers; nobody is promoted automatically
    h.sent.length = 0;
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${id("Bob")}`, coach("Bob"));
    expect(h.stateOf(t, "Carol")).toBe("waitlisted");
    expect(h.sent.some((s) => s.coach === "Veers" && s.input.title === "A place opened in Spike Open")).toBe(true);
    expect((await act("Carol", "promote"))?.body).toMatchObject({ entry: { state: "accepted" } });
    // a plain coach cannot decide
    expect((await act("Alice", "decline", coach("Alice")))?.status).toBe(403);
  });

  it("the cap race: two simultaneous registrations at the last place never both get it", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2 });
    await h.register(t, "Carol");
    const [a, b] = await Promise.all([h.register(t, "Alice"), h.register(t, "Bob")]);
    const states = [a, b].map((r) => (r!.body as { registration: { state: string } }).registration.state).sort();
    expect(states).toEqual(["accepted", "waitlisted"]);
    expect(h.store.entrants(t.id)).toHaveLength(2);
    // without a waitlist the loser is refused
    const strict = await h.create({ name: "Strict", maxPlayers: 2, registration: { approval: "auto", waitlist: false, rosterLater: true } });
    await h.register(strict, "Carol");
    const both = await Promise.all([h.register(strict, "Alice"), h.register(strict, "Bob")]);
    expect(both.map((r) => r!.status).sort()).toEqual([201, 400]);
    expect(h.store.entrants(strict.id)).toHaveLength(2);
  });

  it("promotion runs exactly once: two simultaneous withdrawals with one waiting coach, and repeated promote calls", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2 });
    for (const c of ["Alice", "Bob", "Carol"]) await h.register(t, c);
    h.sent.length = 0;
    const [alice, bob] = h.store.entrants(t.id);
    await Promise.all([
      h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(alice!.id)}`, coach("Alice")),
      h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(bob!.id)}`, coach("Bob")),
    ]);
    expect(h.stateOf(t, "Carol")).toBe("accepted");
    expect(h.sent.filter((s) => s.coach === "Carol" && s.input.type === "registration-outcome")).toHaveLength(1);
    const promoted = await Promise.all([1, 2, 3].map(() => tournamentRegistrationService(h.store).promoteWaitlist(t.id, { coach: "Veers" })));
    expect(promoted.flat()).toEqual([]);
  });

  it("re-entry: a withdrawn coach registers again on the same row (back of the waitlist when full); declined cannot", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2 });
    await h.register(t, "Dee");
    await h.register(t, "Alice");
    const first = h.store.entrants(t.id)[1]!;
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(first.id)}`, coach("Alice"));
    await h.register(t, "Bob");
    const again = await h.register(t, "Alice");
    expect(again?.body).toMatchObject({ registration: { state: "waitlisted", position: 1 }, entrant: { id: first.id, refCode: first.refCode } });
    expect(h.store.heldEntrants(t.id).map((r) => r.id)).toEqual([first.id]);
    const strict = await h.create({ name: "Strict", registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(strict, "Carol");
    const carol = h.store.registrationEntries(strict.id)[0]!;
    await h.call("POST", `/api/tournaments/${strict.id}/registrations/${encodeURIComponent(carol.id)}/decline`, OWNER, {});
    expect(await h.register(strict, "Carol")).toMatchObject({ status: 409, body: { code: "declined" } });
  });
});

describe("organisers are notified on every registration and withdrawal (law 24), never the actor", () => {
  it("self-registration and self-withdrawal: both managers; an organiser's own entry: only the other", async () => {
    const h = harness();
    const t = await h.create();
    await h.register(t, "Alice");
    expect(h.sent.filter((s) => s.input.type === "registration").map((s) => s.coach)).toEqual(["Veers", "Piett"]);
    h.sent.length = 0;
    const e = h.store.entrants(t.id)[0]!;
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(e.id)}`, coach("Alice"));
    expect(h.sent.filter((s) => s.input.type === "withdrawal").map((s) => s.coach)).toEqual(["Veers", "Piett"]);
    h.sent.length = 0;
    owners["team-piett"] = "Piett";
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, CO, { teamId: "team-piett" });
    expect(h.sent.filter((s) => s.input.type === "registration").map((s) => s.coach)).toEqual(["Veers"]);
    delete owners["team-piett"];
    // a pending withdrawal tells them too
    const held = await h.create({ name: "Held", registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(held, "Bob");
    h.sent.length = 0;
    const bob = h.store.registrationEntries(held.id)[0]!;
    await h.call("DELETE", `/api/tournaments/${held.id}/entrants/${encodeURIComponent(bob.id)}`, coach("Bob"));
    expect(h.sent.filter((s) => s.input.type === "withdrawal").map((s) => s.coach)).toEqual(["Veers", "Piett"]);
  });
});

describe("check-in", () => {
  const startsAt = "2026-12-05T09:00:00.000Z";

  it("at open: each accepted coach gets an inbox note + DM once per window; the Check in works only while open", async () => {
    const h = harness("2026-12-03T12:00:00.000Z");
    const t = await h.create({ startsAt, maxPlayers: 2 });
    for (const c of ["Alice", "Bob", "Carol"]) await h.register(t, c);
    h.sent.length = 0;
    const service = tournamentRegistrationService(h.store, { now: () => h.clock.now, notify: (c, input) => h.sent.push({ coach: c, input, to: "coach" }) });
    expect((await sweepTournamentRegistrations(h.store, service, undefined, h.clock.now)).checkIn).toBe(0);
    expect(await h.call("POST", `/api/tournaments/${t.id}/check-in`, coach("Alice"))).toMatchObject({ status: 409, body: { code: "check-in-closed" } });
    h.clock.now = new Date("2026-12-04T10:00:00.000Z"); // 24 h before the start: open
    expect((await sweepTournamentRegistrations(h.store, service, undefined, h.clock.now)).checkIn).toBe(2);
    expect(h.sent.map((s) => [s.coach, s.input.type, s.input.action])).toEqual([["Alice", "check-in", true], ["Bob", "check-in", true]]);
    expect((await sweepTournamentRegistrations(h.store, service, undefined, h.clock.now)).checkIn).toBe(0);
    const pub = await h.detail(t, coach("Alice"));
    expect(pub.checkIn).toMatchObject({ open: true, self: true, closesAt: startsAt });
    expect((await h.call("POST", `/api/tournaments/${t.id}/check-in`, coach("Alice")))?.status).toBe(200);
    expect(h.store.entrants(t.id)[0]).toMatchObject({ flags: { checkedIn: true }, checkedInBy: { by: "Alice" } });
    // waitlisted Carol is not in the field: no check-in
    expect((await h.call("POST", `/api/tournaments/${t.id}/check-in`, coach("Carol")))?.status).toBe(403);
    // self check-in off: organisers check coaches in
    const off = await h.create({ name: "Off", startsAt, registration: { approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: false } } });
    await h.register(off, "Dee");
    expect(await h.call("POST", `/api/tournaments/${off.id}/check-in`, coach("Dee"))).toMatchObject({ status: 409, body: { code: "organiser-check-in" } });
    h.sent.length = 0;
    await sweepTournamentRegistrations(h.store, service, undefined, h.clock.now);
    expect(h.sent.some((s) => s.coach === "Dee")).toBe(false);
  });

  it("organisers check a coach in with one click; at close the no-show list; Remove and promote waitlist (organiser mode)", async () => {
    const h = harness("2026-12-04T10:00:00.000Z");
    const t = await h.create({ startsAt, maxPlayers: 2, registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    for (const c of ["Alice", "Bob", "Carol"]) await h.register(t, c);
    const id = (who: string) => encodeURIComponent(h.store.registrationEntries(t.id).find((r) => r.coach.ffbCoachId === who)!.id);
    await h.call("POST", `/api/tournaments/${t.id}/registrations/${id("Alice")}/accept`, OWNER, {});
    await h.call("POST", `/api/tournaments/${t.id}/registrations/${id("Bob")}/accept`, OWNER, {});
    await h.call("POST", `/api/tournaments/${t.id}/registrations/${id("Carol")}/waitlist`, OWNER, {});
    expect((await h.call("PATCH", `/api/tournaments/${t.id}/entrants/${id("Alice")}`, CO, { flags: { checkedIn: true } }))?.status).toBe(200);
    expect(h.store.entrants(t.id).find((e) => e.coach.ffbCoachId === "Alice")).toMatchObject({ checkedInBy: { by: "Piett" } });
    let panel = (await h.panel(t)).body as { noShows: Array<{ coachId: string }>; checkIn: Record<string, unknown> };
    expect(panel.noShows).toEqual([]);
    expect(panel.checkIn).toMatchObject({ open: true, checkedIn: 1, total: 2 });
    h.clock.now = new Date(startsAt);
    panel = (await h.panel(t)).body as { noShows: Array<{ coachId: string }>; checkIn: Record<string, unknown> };
    expect(panel.checkIn).toMatchObject({ closed: true });
    expect(panel.noShows.map((n) => n.coachId)).toEqual(["Bob"]);
    // nothing automatic: Bob is still in until the organiser acts
    expect(h.stateOf(t, "Bob")).toBe("accepted");
    const res = await h.call("POST", `/api/tournaments/${t.id}/registrations/${id("Bob")}/remove`, OWNER, { promote: true });
    expect(res?.body).toMatchObject({ entry: { state: "dropped" }, promoted: [{ coachId: "Carol", state: "accepted" }] });
    expect(h.store.entrants(t.id).filter((e) => !e.droppedAt).map((e) => e.coach.ffbCoachId).sort()).toEqual(["Alice", "Carol"]);
  });
});

describe("I've paid and the reference code", () => {
  it("only the coach and the organisers ever see the code or 'Coach says paid'; organisers are told", async () => {
    const h = harness();
    const t = await h.create({ entryFee: "15 GBP", payPal: "https://paypal.me/ExampleOrg" });
    await h.register(t, "Alice");
    await h.register(t, "Bob");
    const alice = h.store.entrants(t.id)[0]!;
    const code = referenceCodes(h.store.registrationEntries(t.id)).get(alice.id)!;
    expect(code).toBe(alice.refCode);
    const path = `/api/tournaments/${t.id}/entrants/${encodeURIComponent(alice.id)}/paid-claim`;
    expect((await h.call("POST", path, coach("Bob"), { paid: true }))?.status).toBe(403);
    expect((await h.call("POST", path, OWNER, { paid: true }))?.status).toBe(403);
    expect((await h.call("POST", path, coach("Alice"), { paid: "yes" }))?.status).toBe(400);
    h.sent.length = 0;
    expect((await h.call("POST", path, coach("Alice"), { paid: true }))?.body).toMatchObject({ entrant: { refCode: code, coachSaysPaid: { at: h.clock.now.toISOString() } } });
    expect(h.sent.map((s) => [s.coach, s.input.title])).toEqual([["Veers", "Alice says they paid: Spike Open"], ["Piett", "Alice says they paid: Spike Open"]]);
    expect(h.sent[0]!.input.body).toContain(code);
    // a second "I've paid" tells nobody again
    h.sent.length = 0;
    await h.call("POST", path, coach("Alice"), { paid: true });
    expect(h.sent).toEqual([]);
    for (const viewer of [undefined, coach("Bob")]) {
      const text = JSON.stringify(await h.detail(t, viewer));
      expect(text).not.toContain(code);
      expect(text).not.toContain("coachSaysPaid");
      if (viewer) expect(JSON.stringify((await h.detail(t, viewer)).entrants.find((e) => e.coachId === "Bob"))).toContain("refCode");
    }
    const own = await h.detail(t, coach("Alice"));
    expect(own.entrants.find((e) => e.coachId === "Alice")).toMatchObject({ refCode: code, coachSaysPaid: expect.any(Object) });
    expect(own.myRegistration).toMatchObject({ refCode: code, state: "accepted" });
    expect((await h.detail(t, OWNER)).entrants.find((e) => e.coachId === "Alice")).toMatchObject({ refCode: code, coachSaysPaid: expect.any(Object) });
    // a pending coach's code reaches only them and the organisers too
    const held = await h.create({ name: "Held", registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(held, "Carol");
    const carol = h.store.registrationEntries(held.id)[0]!;
    expect((await h.detail(held, coach("Carol"))).myRegistration).toMatchObject({ state: "pending", refCode: carol.refCode });
    expect(JSON.stringify(await h.detail(held, coach("Dee")))).not.toContain(carol.refCode!);
    expect(JSON.stringify((await h.panel(held)).body)).toContain(carol.refCode!);
  });
});

describe("Sol hunt list", () => {
  it("an organiser of A can never act on B", async () => {
    const h = harness();
    const a = await h.create({ registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    const resB = await h.call("POST", "/api/tournaments", OTHER_ORG, { name: "Other Cup", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    const b = (resB!.body as { tournament: TournamentRecord }).tournament;
    await h.register(b, "Alice");
    const bEntry = h.store.registrationEntries(b.id)[0]!;
    // B's entry through A's path: not in A (404); B's panel / decisions as A's organiser: 403
    expect((await h.call("POST", `/api/tournaments/${a.id}/registrations/${encodeURIComponent(bEntry.id)}/accept`, OWNER, {}))?.status).toBe(404);
    expect((await h.panel(b, OWNER)).status).toBe(403);
    expect((await h.call("POST", `/api/tournaments/${b.id}/registrations/${encodeURIComponent(bEntry.id)}/accept`, OWNER, {}))?.status).toBe(403);
    expect((await h.call("DELETE", `/api/tournaments/${b.id}/entrants/${encodeURIComponent(bEntry.id)}`, OWNER))?.status).toBe(403);
    // a global organiser flag is not a licence either (Ozzel organises only B)
    expect((await h.panel(a, OTHER_ORG)).status).toBe(403);
    expect(h.stateOf(b, "Alice")).toBe("pending");
  });

  it("pending and waitlisted entries never leak on public routes, counts, lists or membership", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2, registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(t, "Alice");
    for (const viewer of [undefined, coach("Zed"), coach("Alice")]) {
      const d = await h.detail(t, viewer);
      expect(d.entrants).toEqual([]);
      expect(d.tournament.entrantCount).toBe(0);
      expect(d.registrationStatus).toMatchObject({ placesLeft: 2 });
    }
    const list = await h.call("GET", "/api/tournaments", undefined);
    expect(JSON.stringify(list?.body)).not.toContain("Alice");
    const anon = await h.call("GET", `/api/tournaments/${t.id}/standings`, undefined);
    expect(JSON.stringify(anon?.body ?? "")).not.toContain("Alice");
    expect(h.store.entrants(t.id)).toEqual([]);
    expect(isTournamentMember("Alice", t.id, { tournaments: h.store, leagues: { league: () => undefined, list: () => [], seasons: () => [] } })).toBe(false);
    // the anonymous panel read is refused
    expect((await h.call("GET", `/api/tournaments/${t.id}/registrations`, undefined))?.status).toBe(401);
    // ?coach=me shows the coach their own pending entry
    const mine = await tournamentApi("GET", "/api/tournaments", new URLSearchParams("status=all&coach=me"), coach("Alice"), undefined, h.deps());
    expect((mine!.body as { tournaments: Array<{ id: string }> }).tournaments.map((x) => x.id)).toEqual([t.id]);
  });

  it("GETs never change state: the detail and the panel leave the data file as it was", async () => {
    const h = harness("2026-12-04T10:00:00.000Z");
    const t = await h.create({ startsAt: "2026-12-05T09:00:00.000Z" });
    await h.register(t, "Alice");
    const file = join(roots[roots.length - 1]!, "tournaments.json");
    await h.detail(t); // the standings cache (an existing read-through cache) settles first
    const before = readFileSync(file, "utf8");
    await h.detail(t, coach("Alice"));
    await h.detail(t);
    await h.panel(t);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("every new write is covered by the CSRF guard and the 428 onboarding gate; the reads are not writes", () => {
    const writes: Array<[string, string]> = [
      ["POST", "/api/tournaments/t1/entrants"], ["DELETE", "/api/tournaments/t1/entrants/e1"], ["POST", "/api/tournaments/t1/entrants/e1/paid-claim"],
      ["POST", "/api/tournaments/t1/check-in"], ["POST", "/api/tournaments/t1/registrations/e1/accept"], ["POST", "/api/tournaments/t1/registrations/e1/remove"],
      ["PATCH", "/api/tournaments/t1/entrants/e1"],
    ];
    for (const [m, p] of writes) {
      expect(isStateChangingApiRequest(m, p), `${m} ${p}`).toBe(true);
      expect(onboardingGateApplies(m, p), `${m} ${p}`).toBe(true);
    }
    expect(isStateChangingApiRequest("GET", "/api/tournaments/t1/registrations")).toBe(false);
    expect(isStateChangingApiRequest("GET", "/api/tournaments/t1")).toBe(false);
  });

  it("test sign-in sessions register only in tournaments marked test", async () => {
    const h = harness();
    const real = await h.create();
    expect(await h.call("POST", `/api/tournaments/${real.id}/entrants`, coach("Tess", { test: true }), { rosterLater: true })).toMatchObject({ status: 403, body: { code: "test-session" } });
    const created = await h.call("POST", "/api/tournaments", { coach: "Tess", organizer: true, admin: false, test: true }, { name: "Test Cup", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, registration: {} });
    const tt = (created!.body as { tournament: TournamentRecord }).tournament;
    expect(tt.test).toBe(true);
    expect((await h.call("POST", `/api/tournaments/${tt.id}/entrants`, coach("Tom", { test: true }), { rosterLater: true }))?.status).toBe(201);
  });

  it("held entries are covered by the export and the delete anonymiser", async () => {
    const h = harness();
    const t = await h.create({ registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(t, "Alice");
    const collector = STORE_COLLECTORS.find((c) => c.id === "tournaments")!;
    const root = roots[roots.length - 1]!;
    const files = (collector.export as (ctx: unknown) => Array<{ name: string; content: string }>)({ deps: { tournamentsDir: root, stateDir: root }, coach: "Alice", keys: new Set(["alice"]) });
    const entries = JSON.parse(files[0]!.content).entries as Array<{ coach: { ffbCoachId: string }; entryState: string }>;
    expect(entries).toEqual([expect.objectContaining({ coach: expect.objectContaining({ ffbCoachId: "Alice" }), entryState: "pending" })]);
    expect(readFileSync(new URL("../src/privacy/collectors.ts", import.meta.url), "utf8")).toContain("...vals(data.heldEntrants)");
  });
});

// Sol review round 1 (lane L4): one test per finding.
describe("review round 1", () => {
  it("P2-1: a commit re-checks lifecycle, window and cap against the stored data (rosters locked, cap lowered, window closed)", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 3, registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    for (const c of ["Alice", "Bob", "Carol"]) await h.register(t, c);
    const entries = () => h.store.registrationEntries(t.id).map(toRegistrationEntry);
    const accept = (who: string) => {
      const before = entries().find((e) => e.coach === who)!;
      const after = { ...before, state: "accepted" as const, log: [...before.log] };
      return [{ before, after, transition: { action: "accept" as const, from: "pending" as const, to: "accepted" as const, by: "Veers", at: h.clock.now.toISOString() } }];
    };
    const write = (who: string) => ({ id: entries().find((e) => e.coach === who)!.id, reg: { entryState: "accepted" as const, registeredAt: h.clock.now.toISOString() } });
    // the cap was lowered to 1 after Alice was accepted: accepting Bob is refused inside the write
    await h.call("POST", `/api/tournaments/${t.id}/registrations/${encodeURIComponent(write("Alice").id)}/accept`, OWNER, {});
    h.store.updateTournament(t.id, { maxPlayers: 2 });
    await h.call("POST", `/api/tournaments/${t.id}/registrations/${encodeURIComponent(write("Bob").id)}/accept`, OWNER, {});
    expect(() => h.store.commitRegistration(t.id, [write("Carol")], h.clock.now, registrationCommitGuard(t.id, accept("Carol"), h.clock.now))).toThrow(/Full/);
    // rosters locked meanwhile: refused as closed
    h.store.updateTournament(t.id, { maxPlayers: 8 });
    h.store.lockRosters(t.id, {}, h.clock.now);
    expect(() => h.store.commitRegistration(t.id, [write("Carol")], h.clock.now, registrationCommitGuard(t.id, accept("Carol"), h.clock.now))).toThrow(/locked/);
    expect(h.stateOf(t, "Carol")).toBe("pending");
    // a self-entry when the window closed in between
    const open = await h.create({ name: "Open" });
    const fresh = { id: `${open.id}:entrant:9`, competitionId: open.id, coach: "Dee", state: "accepted" as const, submittedAt: "x", enteredAt: "x", log: [] };
    h.store.updatePage(open.id, { deadlines: { registration: "2026-11-10T11:00:00.000Z" } });
    expect(() => registrationCommitGuard(open.id, [{ after: fresh, transition: { action: "submit", from: null, to: "accepted", by: "Dee", at: "x" } }], h.clock.now)(h.store.snapshot())).toThrow(/closed/);
    // leaving is never refused
    const alice = entries().find((e) => e.coach === "Alice")!;
    expect(() => registrationCommitGuard(t.id, [{ before: alice, after: { ...alice, state: "withdrawn" }, transition: { action: "withdraw", from: "accepted", to: "withdrawn", by: "Alice", at: "x" } }], h.clock.now)(h.store.snapshot())).not.toThrow();
  });

  it("P2-2: lock and start judge the stored snapshot, never the live save edited after the roster deadline", async () => {
    const h = harness();
    const t = await h.create();
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { teamRef: "save:good" });
    const snapshot = structuredClone(h.store.entrants(t.id)[0]!.submission);
    h.live.bad = true; // the coach changed the live save afterwards
    expect((await h.call("POST", `/api/tournaments/${t.id}/lock-rosters`, OWNER))?.status).toBe(200);
    const after = h.store.entrants(t.id)[0]!.submission!;
    expect(after.snapshot).toEqual(snapshot!.snapshot);
    expect(after.validation.ok).toBe(true);
  });

  it("P2-3: two concurrent 'remove and promote' calls fill both freed places, never the same waiting entry", async () => {
    const h = harness();
    const t = await h.create({ maxPlayers: 2, registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    for (const c of ["Alice", "Bob", "Carol", "Dee"]) await h.register(t, c);
    const id = (who: string) => encodeURIComponent(h.store.registrationEntries(t.id).find((r) => r.coach.ffbCoachId === who)!.id);
    for (const c of ["Alice", "Bob"]) await h.call("POST", `/api/tournaments/${t.id}/registrations/${id(c)}/accept`, OWNER, {});
    for (const c of ["Carol", "Dee"]) await h.call("POST", `/api/tournaments/${t.id}/registrations/${id(c)}/waitlist`, OWNER, {});
    const [a, b] = await Promise.all(["Alice", "Bob"].map((c) => h.call("POST", `/api/tournaments/${t.id}/registrations/${id(c)}/remove`, OWNER, { promote: true })));
    const promoted = [a, b].flatMap((r) => (r!.body as { promoted: Array<{ coachId: string }> }).promoted.map((p) => p.coachId)).sort();
    expect(promoted).toEqual(["Carol", "Dee"]);
    expect(h.store.entrants(t.id).filter((e) => !e.droppedAt).map((e) => e.coach.ffbCoachId).sort()).toEqual(["Carol", "Dee"]);
  });

  it("P2-4: a pending or waitlisted coach has the tournament in Account Sharing (change or revoke); not after withdrawing", async () => {
    const h = harness();
    const t = await h.create({ registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(t, "Alice", { share: ["email"] });
    const record = { ...h.identities.alice!, identities: h.identities.alice!.identities ?? {} } as CoachIdentityRecord;
    const sources = { tournaments: h.store, leagues: { league: () => undefined, list: () => [], seasons: () => [] } };
    const scope = parseShareScope(`tournament:${t.id}`)!;
    expect(inShareScope(record, scope, sources)).toBe(true);
    expect(sharingView(record, sources).scopes.map((s) => [s.scope, s.fields])).toEqual([[`tournament:${t.id}`, ["email"]]]);
    const e = h.store.registrationEntries(t.id)[0]!;
    await h.call("DELETE", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(e.id)}`, coach("Alice"));
    expect(inShareScope(record, scope, sources)).toBe(false);
  });

  it("P2-5: sanctioning with held entries tells those coaches first; the panel shows profile NAF only once they were told", async () => {
    const h = harness();
    h.naf.bob = { nafName: "Bob Fake", nafId: "42" };
    const t = await h.create({ registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(t, "Bob");
    await h.register(t, "Carol");
    const panelText = async () => JSON.stringify((await h.panel(t)).body);
    // sanctioned without the notice path (another writer): Bob's profile NAF stays out of the panel
    h.store.updateTournament(t.id, { nafSanctioned: true });
    expect(await panelText()).not.toContain("Bob Fake");
    h.store.updateTournament(t.id, { nafSanctioned: false });
    h.sent.length = 0;
    expect((await h.call("PATCH", `/api/tournaments/${t.id}`, OWNER, { nafSanctioned: true }))?.status).toBe(200);
    expect(h.sent.filter((s) => s.input.type === "naf-request").map((s) => s.coach).sort()).toEqual(["Bob", "Carol"]);
    expect(h.store.heldEntrants(t.id).every((r) => r.nafToldAt)).toBe(true);
    expect(h.store.heldEntrants(t.id).find((r) => r.coach.ffbCoachId === "Carol")?.nafPending).toBe(true);
    expect(await panelText()).toContain("Bob Fake");
  });

  it("P2-6: a held coach answers the NAF question (route and My entry)", async () => {
    const h = harness();
    const t = await h.create({ registration: { approval: "organiser", waitlist: true, rosterLater: true } });
    await h.register(t, "Carol");
    await h.call("PATCH", `/api/tournaments/${t.id}`, OWNER, { nafSanctioned: true });
    const carol = h.store.heldEntrants(t.id)[0]!;
    expect((await h.detail(t, coach("Carol"))).myRegistration).toMatchObject({ state: "pending", nafPending: true });
    h.sent.length = 0;
    const res = await h.call("POST", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(carol.id)}/naf`, coach("Carol"), { notNafMember: true });
    expect(res?.status).toBe(200);
    expect(h.store.heldEntrants(t.id)[0]).toMatchObject({ notNafMember: true });
    expect(h.store.heldEntrants(t.id)[0]!.nafPending).toBeUndefined();
    expect(h.sent.filter((s) => s.input.type === "registration").map((s) => s.coach)).toEqual(["Veers", "Piett"]);
    expect(readFileSync(new URL("../spa/src/components/TournamentMyEntry.vue", import.meta.url), "utf8")).toContain("current.value?.nafPending && sanctioned.value");
  });

  it("P2-7: notice guards (held entry ids) never reach a tournament payload; the serializer is an allow-list", async () => {
    const h = harness("2026-11-30T19:00:00.000Z");
    const t = await h.create({ startsAt: "2026-12-01T09:00:00.000Z", registration: { approval: "organiser", waitlist: true, rosterLater: true, rosterBy: "2026-12-01T08:00:00.000Z" } });
    await h.call("POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { rosterLater: true });
    const heldId = h.store.heldEntrants(t.id)[0]!.id;
    await sweepTournamentRegistrations(h.store, tournamentRegistrationService(h.store, { now: () => h.clock.now }), () => undefined, h.clock.now);
    expect(h.store.tournament(t.id)!.rosterDueNotice?.entryIds).toEqual([heldId]);
    h.store.setCheckInNotice(t.id, { window: "w", entryIds: [heldId], at: "x" });
    for (const res of [await h.call("GET", `/api/tournaments/${t.id}`, undefined), await h.call("GET", "/api/tournaments", undefined, undefined), await h.call("GET", `/api/tournaments/${t.id}`, OWNER)]) {
      const text = JSON.stringify(res?.body);
      expect(text).not.toContain("rosterDueNotice");
      expect(text).not.toContain("checkInNotice");
      expect(text).not.toContain(heldId);
    }
    expect(readFileSync(new URL("../src/tournaments/api.ts", import.meta.url), "utf8")).toContain("const record = pickPublicTournament(tournament);");
  });

  it("P2-8: reference codes are random, given in a write to rows without one, never derived or written on a read", async () => {
    const h = harness();
    const t = await h.create();
    const legacy = h.store.registerEntrant(t.id, { coachId: "Alice", ffbCoachId: "Alice", verifiedAt: h.clock.now.toISOString() }, "team-alice", h.clock.now);
    expect(legacy.refCode).toBeUndefined();
    const own = await h.detail(t, coach("Alice"));
    expect(own.entrants[0]).not.toHaveProperty("refCode");
    expect(h.store.entrants(t.id)[0]!.refCode).toBeUndefined();
    await sweepTournamentRegistrations(h.store, tournamentRegistrationService(h.store), undefined, h.clock.now);
    const code = h.store.entrants(t.id)[0]!.refCode!;
    expect(code).toMatch(REF_CODE);
    // the same row in another store gets another code: nothing is derived from the entry's fields
    const h2 = harness();
    h2.store.writeSnapshot({ ...h.store.snapshot(), entrants: Object.fromEntries(Object.entries(h.store.snapshot().entrants).map(([k, v]) => [k, { ...v, refCode: undefined }])) });
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      h2.store.writeSnapshot({ ...h2.store.snapshot(), entrants: Object.fromEntries(Object.entries(h2.store.snapshot().entrants).map(([k, v]) => [k, { ...v, refCode: undefined }])) });
      await sweepTournamentRegistrations(h2.store, tournamentRegistrationService(h2.store), undefined, h.clock.now);
      codes.add(h2.store.entrants(t.id)[0]!.refCode!);
    }
    expect(codes.size).toBeGreaterThan(1);
    expect(readFileSync(new URL("../src/tournaments/registration.ts", import.meta.url), "utf8")).not.toContain("createHash");
  });

  it("P2-9: toggling I've paid tells the organisers once per 24 hours", async () => {
    const h = harness();
    const t = await h.create({ entryFee: "15 GBP" });
    await h.register(t, "Alice");
    const path = `/api/tournaments/${t.id}/entrants/${encodeURIComponent(h.store.entrants(t.id)[0]!.id)}/paid-claim`;
    h.sent.length = 0;
    for (const paid of [true, false, true, false, true]) await h.call("POST", path, coach("Alice"), { paid });
    expect(h.sent.filter((s) => s.input.title.includes("says they paid")).map((s) => s.coach)).toEqual(["Veers", "Piett"]);
    h.clock.now = new Date(h.clock.now.getTime() + 25 * 60 * 60 * 1000);
    await h.call("POST", path, coach("Alice"), { paid: false });
    await h.call("POST", path, coach("Alice"), { paid: true });
    expect(h.sent.filter((s) => s.input.title.includes("says they paid"))).toHaveLength(4);
    expect(JSON.stringify((await h.detail(t, coach("Alice"))).entrants)).not.toContain("paidClaimNotifiedAt");
  });
});
