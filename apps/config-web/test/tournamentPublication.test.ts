import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { seriesApi } from "../src/tournaments/series.js";
import { TournamentStore } from "../src/tournaments/store.js";
import {
  canSeeTournament, hiddenTournamentPath, isTournamentPublished, testSessionTournamentRefusal, TEST_SESSION_TOURNAMENT_REFUSAL,
} from "../src/tournaments/publication.js";
import type { TournamentRecord } from "../src/tournaments/types.js";

// Lane L3 (registration spec 2026-11-02 §6, Q1, Q3, Q13): the creation wizard's create body, publish / unpublish, draft
// visibility on every read path, legacy drafts counting as published, registration refused while unpublished or outside
// the window, who may create, and the test sign-in rule. Each test has its own state dir (laws §C14).

const roots: string[] = [];
const now = new Date("2026-11-02T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const otherOrganiser: TournamentApiIdentity = { coach: "Piett", organizer: true, admin: false };
const admin: TournamentApiIdentity = { coach: "Ada", organizer: true, admin: true };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });
const owners: Record<string, string> = { "team-alice": "Alice", "team-bob": "Bob" };

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-publication-"));
  roots.push(root);
  return new TournamentStore(root);
}

async function call(store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, query = "") {
  return tournamentApi(method, path, new URLSearchParams(query), auth, body, {
    store,
    teamBuild: (teamId) => (owners[teamId] ? { teamId, coach: owners[teamId] } : undefined),
    teamOwner: (teamId) => owners[teamId],
    validateSubmission: (c, ref, packageName, at) => ({
      saveId: ref, revision: "r1", submittedAt: at.toISOString(), teamName: `${c} Save`, race: "Orc", snapshot: { ref },
      validation: { ok: true, problems: [], checkedAt: at.toISOString(), packageName },
    }),
    packageExists: (name) => name === "Spike 2026",
    registeredCoach: (name) => name,
    now: () => now,
  });
}

const OLD_BODY = { name: "Veers Invitational", packageName: "Spike 2026", maxPlayers: 8, format: "swiss", primaryTiebreaker: "buchholz", roundCount: 4, nafSanctioned: true };
const WIZARD_EXTRAS = {
  startsAt: "2026-12-05T09:00:00.000Z",
  endsAt: "2026-12-06T18:00:00.000Z",
  pairingSystem: "monrad",
  seedingMode: "manual",
  playOnFork: false,
  turnTimer: { enforced: "required", seconds: 300 },
  location: { venue: "Example Hall", address: "1 Example Street" },
  startTime: "09:00",
  entryFee: "15 GBP",
  summary: "Two days of Blood Bowl.",
  deadlines: { registration: "2026-12-01T18:00:00.000Z", checkIn: "2026-12-05T08:30:00.000Z" },
  registration: { opensAt: "2026-11-03T09:00:00.000Z", approval: "auto", waitlist: false, rosterLater: true, rosterBy: "2026-12-03T18:00:00.000Z", checkIn: { self: true, opensAt: "2026-12-04T09:00:00.000Z" } },
};

async function createDraft(store: TournamentStore, extra: Record<string, unknown> = {}, who = owner): Promise<TournamentRecord> {
  const res = await call(store, "POST", "/api/tournaments", who, { name: "Hidden Cup", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: false, ...extra });
  expect(res?.status).toBe(201);
  return (res?.body as { tournament: TournamentRecord }).tournament;
}

const strip = (t: TournamentRecord) => {
  const { id: _id, createdAt: _c, updatedAt: _u, publishedAt: _p, unpublished: _x, registration: _r, startsAt: _s, endsAt: _e, pairingSystem: _ps, seedingMode: _sm, turnTimer: _tt, location: _l, startTime: _st, entryFee: _f, summary: _su, deadlines: _d, ...rest } = t;
  return rest;
};

describe("creation wizard: POST /api/tournaments with publish", () => {
  it("creates the same record as the old dialog plus the new fields", async () => {
    const store = newStore();
    const old = (await call(store, "POST", "/api/tournaments", owner, OLD_BODY))!.body as { tournament: TournamentRecord };
    const wiz = (await call(store, "POST", "/api/tournaments", owner, { ...OLD_BODY, ...WIZARD_EXTRAS, publish: true }))!.body as { tournament: TournamentRecord };
    expect(strip(wiz.tournament)).toEqual(strip(old.tournament));
    // The old dialog's record carries no publication marker (public, as before).
    expect(old.tournament).not.toHaveProperty("unpublished");
    expect(old.tournament).not.toHaveProperty("publishedAt");
    expect(wiz.tournament).toMatchObject({
      publishedAt: now.toISOString(),
      startsAt: WIZARD_EXTRAS.startsAt, endsAt: WIZARD_EXTRAS.endsAt, pairingSystem: "monrad", seedingMode: "manual",
      turnTimer: { enforced: "required", seconds: 300 }, location: WIZARD_EXTRAS.location, startTime: "09:00", entryFee: "15 GBP",
      summary: "Two days of Blood Bowl.", deadlines: WIZARD_EXTRAS.deadlines,
      registration: { opensAt: "2026-11-03T09:00:00.000Z", approval: "auto", waitlist: false, rosterLater: true, rosterBy: "2026-12-03T18:00:00.000Z", checkIn: { self: true, opensAt: "2026-12-04T09:00:00.000Z" } },
    });
    expect(wiz.tournament).not.toHaveProperty("unpublished");
    expect(wiz.tournament).not.toHaveProperty("playOnFork");
    // Stored as returned.
    expect(store.tournament(wiz.tournament.id)).toMatchObject({ registration: wiz.tournament.registration, publishedAt: now.toISOString() });
  });

  it("registration defaults: auto-accept, waitlist on, roster later on, self check-in on", async () => {
    const store = newStore();
    const t = await createDraft(store, { registration: {} });
    expect(t.registration).toEqual({ approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true } });
    expect(t.unpublished).toBe(true);
  });

  it("a bad wizard field refuses the whole create and writes nothing", async () => {
    const store = newStore();
    for (const extra of [
      { publish: "yes" },
      { registration: { approval: "maybe" } },
      { registration: { opensAt: "2026-12-02T00:00:00.000Z" }, deadlines: { registration: "2026-12-01T00:00:00.000Z" } },
      { startsAt: "2026-12-01T00:00:00.000Z", deadlines: { registration: "2026-12-02T00:00:00.000Z" }, registration: {} },
      { startsAt: "not a date" },
      { endsAt: "2026-11-01T00:00:00.000Z", startsAt: "2026-12-01T00:00:00.000Z" },
      { turnTimer: { enforced: "always" } },
      { location: { mapUrl: "javascript:alert(1)" } },
    ]) {
      const res = await call(store, "POST", "/api/tournaments", owner, { name: "Bad", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: false, ...extra });
      expect(res?.status, JSON.stringify(extra)).toBe(400);
    }
    expect(store.tournaments(["draft", "active", "completed", "cancelled"])).toHaveLength(0);
  });

  it("who may create (Q1): site organisers and admins; never a plain coach or anonymous", async () => {
    const store = newStore();
    const body = { name: "X", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: false };
    expect((await call(store, "POST", "/api/tournaments", coach("Alice"), body))?.status).toBe(403);
    expect((await call(store, "POST", "/api/tournaments", undefined, body))?.status).toBe(401);
    expect((await call(store, "POST", "/api/tournaments", { coach: "Ada", organizer: false, admin: true }, body))?.status).toBe(201);
    expect((await call(store, "POST", "/api/tournaments", owner, body))?.status).toBe(201);
  });
});

describe("draft visibility", () => {
  const READS = (id: string) => [`/api/tournaments/${id}`, `/api/fork/tournaments/${id}`, `/api/tournaments/${id}/standings`, `/api/tournaments/${id}/statistics`, `/api/tournaments/${id}/awards`];

  it("anonymous, a coach and another organiser get 404 on every by-id read; the owner, a co-organiser and admins see it", async () => {
    const store = newStore();
    const t = await createDraft(store);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/organizers/Mara`, owner))?.status).toBe(200);
    for (const viewer of [undefined, coach("Alice"), otherOrganiser]) {
      for (const path of READS(t.id)) expect((await call(store, "GET", path, viewer))?.status, `${viewer?.coach} ${path}`).toBe(404);
      // writes too: nobody outside learns it exists
      expect((await call(store, "POST", `/api/tournaments/${t.id}/entrants`, viewer, { teamRef: "save:alice" }))?.status).toBe(404);
      expect(hiddenTournamentPath(store, `/api/tournaments/${t.id}/banner`, viewer)).toBe(true);
      expect(hiddenTournamentPath(store, `/api/tournaments/${t.id}/fixtures/m1/lobby`, viewer)).toBe(true);
    }
    for (const viewer of [owner, coach("Mara"), admin]) {
      const res = await call(store, "GET", `/api/tournaments/${t.id}`, viewer);
      expect(res?.status, viewer.coach).toBe(200);
      expect((res?.body as { tournament: { unpublished?: boolean } }).tournament.unpublished).toBe(true);
      expect(hiddenTournamentPath(store, `/api/tournaments/${t.id}/banner`, viewer)).toBe(false);
    }
  });

  it("lists: hidden from everyone but managers and admins (future, draft, all, search, coach=me)", async () => {
    const store = newStore();
    const hidden = await createDraft(store);
    const ids = async (viewer: TournamentApiIdentity | undefined, query: string) =>
      ((await call(store, "GET", "/api/fork/tournaments", viewer, undefined, query))!.body as { tournaments: Array<{ id: string }> }).tournaments.map((t) => t.id);
    for (const query of ["category=future", "status=draft", "status=all", "status=all&q=hidden"]) {
      expect(await ids(undefined, query), query).not.toContain(hidden.id);
      expect(await ids(coach("Alice"), query), query).not.toContain(hidden.id);
      expect(await ids(otherOrganiser, query), query).not.toContain(hidden.id);
      expect(await ids(owner, query), query).toContain(hidden.id);
      expect(await ids(admin, query), query).toContain(hidden.id);
    }
  });

  it("series: the list, the detail and the standings leave a hidden draft out for non-managers", async () => {
    const store = newStore();
    const series = store.createSeries({ name: "Valley Series", description: "", organisers: ["Piett"], scoring: "sum", seeding: "dutch", createdBy: "Piett" }, now);
    const hidden = await createDraft(store, { seriesId: series.id }, admin);
    const visible = (await call(store, "POST", "/api/tournaments", admin, { name: "Open Leg", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", seriesId: series.id }))!.body as { tournament: TournamentRecord };
    const read = (path: string, viewer?: TournamentApiIdentity) => seriesApi("GET", path, viewer, undefined, { store })!;
    for (const viewer of [undefined, coach("Alice"), otherOrganiser]) {
      const detail = read(`/api/series/${series.id}`, viewer).body as { series: { tournaments: string[] }; standings: { events: Array<{ id: string }> } };
      expect(detail.series.tournaments).toEqual([visible.tournament.id]);
      expect(detail.standings.events.map((e) => e.id)).toEqual([visible.tournament.id]);
      const list = read("/api/series", viewer).body as { series: Array<{ tournaments: string[]; tournamentCount: number }> };
      expect(list.series[0]).toMatchObject({ tournaments: [visible.tournament.id], tournamentCount: 1 });
      const standings = read(`/api/series/${series.id}/standings`, viewer).body as { standings: { events: Array<{ id: string }> } };
      expect(standings.standings.events.map((e) => e.id)).not.toContain(hidden.id);
    }
    const asAdmin = read(`/api/series/${series.id}`, admin).body as { series: { tournaments: string[] } };
    expect(asAdmin.series.tournaments).toEqual([hidden.id, visible.tournament.id]);
  });

  it("legacy drafts (no publication marker, made before this release) count as published", async () => {
    const store = newStore();
    const legacy = (await call(store, "POST", "/api/tournaments", owner, { name: "Legacy Open", packageName: "Spike 2026", maxPlayers: 4, format: "swiss" }))!.body as { tournament: TournamentRecord };
    // a record as an older build wrote it: none of the new fields
    const data = store.snapshot();
    const raw = data.tournaments[legacy.tournament.id]!;
    delete raw.unpublished; delete raw.publishedAt; delete raw.registration;
    store.writeSnapshot(data);
    const t = store.tournament(legacy.tournament.id)!;
    expect(isTournamentPublished(t)).toBe(true);
    expect(canSeeTournament(t, undefined)).toBe(true);
    expect((await call(store, "GET", `/api/tournaments/${t.id}`, undefined))?.status).toBe(200);
    const future = (await call(store, "GET", "/api/fork/tournaments", undefined, undefined, "category=future"))!.body as { tournaments: Array<{ id: string }> };
    expect(future.tournaments.map((x) => x.id)).toContain(t.id);
    // and it stays open for registration with today's rules
    expect((await call(store, "POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { teamRef: "save:alice" }))?.status).toBe(201);
  });
});

describe("publish / unpublish", () => {
  it("managers publish and unpublish; others get 404 (hidden) or 403 (published)", async () => {
    const store = newStore();
    const t = await createDraft(store);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/publish`, otherOrganiser))?.status).toBe(404);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/publish`, coach("Alice")))?.status).toBe(404);
    const pub = await call(store, "POST", `/api/tournaments/${t.id}/publish`, owner);
    expect(pub?.status).toBe(200);
    expect((pub?.body as { tournament: TournamentRecord }).tournament).toMatchObject({ publishedAt: now.toISOString() });
    expect(store.tournament(t.id)!.unpublished).toBeUndefined();
    expect((await call(store, "GET", `/api/tournaments/${t.id}`, undefined))?.status).toBe(200);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/unpublish`, otherOrganiser))?.status).toBe(403);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/unpublish`, admin))?.status).toBe(200);
    expect(store.tournament(t.id)).toMatchObject({ unpublished: true });
    expect(store.tournament(t.id)!.publishedAt).toBeUndefined();
    expect((await call(store, "GET", `/api/tournaments/${t.id}`, undefined))?.status).toBe(404);
    // idempotent
    expect((await call(store, "POST", `/api/tournaments/${t.id}/unpublish`, owner))?.status).toBe(200);
  });

  it("unpublishing is refused while a coach is entered, and once the tournament is no longer a draft", async () => {
    const store = newStore();
    const t = await createDraft(store);
    await call(store, "POST", `/api/tournaments/${t.id}/publish`, owner);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { teamRef: "save:alice" }))?.status).toBe(201);
    const refused = await call(store, "POST", `/api/tournaments/${t.id}/unpublish`, owner);
    expect(refused?.status).toBe(409);
    expect(store.tournament(t.id)!.unpublished).toBeUndefined();
    const data = store.snapshot();
    data.tournaments[t.id]!.status = "active";
    for (const e of Object.values(data.entrants)) e.droppedAt = now.toISOString();
    store.writeSnapshot(data);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/unpublish`, owner))?.status).toBe(409);
  });
});

describe("registration and the publication / window", () => {
  it("refused while unpublished, for the coach and for an organiser adding them; open once published", async () => {
    const store = newStore();
    const t = await createDraft(store);
    // the manager sees it, but nobody can enter a hidden draft
    const added = await call(store, "POST", `/api/tournaments/${t.id}/entrants`, owner, { coach: "Alice" });
    expect(added?.status).toBe(409);
    expect((added?.body as { error: string }).error).toBe("Registration is not open yet.");
    expect(store.entrants(t.id)).toHaveLength(0);
    await call(store, "POST", `/api/tournaments/${t.id}/publish`, owner);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/entrants`, coach("Alice"), { teamRef: "save:alice" }))?.status).toBe(201);
  });

  it("a tournament with registration settings takes self-entries only inside its window; organisers still add", async () => {
    const store = newStore();
    const future = await createDraft(store, { publish: true, registration: { opensAt: "2026-11-10T00:00:00.000Z" } });
    const early = await call(store, "POST", `/api/tournaments/${future.id}/entrants`, coach("Alice"), { teamRef: "save:alice" });
    expect(early?.status).toBe(409);
    expect(early?.body).toMatchObject({ error: "Registration is not open yet.", code: "not-yet-open" });
    const closed = await createDraft(store, { publish: true, registration: {}, deadlines: { registration: "2026-11-01T00:00:00.000Z" } });
    const late = await call(store, "POST", `/api/tournaments/${closed.id}/entrants`, coach("Alice"), { teamRef: "save:alice" });
    expect(late?.status).toBe(409);
    expect(late?.body).toMatchObject({ error: "Registration is closed.", code: "closed" });
    expect((await call(store, "POST", `/api/tournaments/${closed.id}/entrants`, owner, { coach: "Bob" }))?.status).toBe(201);
    const open = await createDraft(store, { publish: true, registration: { opensAt: "2026-11-01T00:00:00.000Z" }, deadlines: { registration: "2026-11-20T00:00:00.000Z" } });
    expect((await call(store, "POST", `/api/tournaments/${open.id}/entrants`, coach("Alice"), { teamRef: "save:alice" }))?.status).toBe(201);
  });

  it("Manage PATCH edits the registration settings (validated against the deadlines) and null clears them", async () => {
    const store = newStore();
    const t = await createDraft(store, { registration: {}, deadlines: { registration: "2026-12-01T00:00:00.000Z" } });
    const ok = await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { registration: { approval: "auto", waitlist: false, rosterLater: false, checkIn: { self: false } } });
    expect(ok?.status).toBe(200);
    expect(store.tournament(t.id)!.registration).toEqual({ approval: "auto", waitlist: false, rosterLater: false, checkIn: { self: false } });
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { registration: { opensAt: "2026-12-02T00:00:00.000Z" } }))?.status).toBe(400);
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, otherOrganiser, { registration: {} }))?.status).toBe(404);
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { registration: null }))?.status).toBe(200);
    expect(store.tournament(t.id)!.registration).toBeUndefined();
  });

  it("organiser approval is accepted on create and on PATCH now that the approval flow ships (lane L4)", async () => {
    const store = newStore();
    const res = await call(store, "POST", "/api/tournaments", owner, { name: "Approve", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, registration: { approval: "organiser" } });
    expect(res?.status).toBe(201);
    expect((res?.body as { tournament: TournamentRecord }).tournament.registration?.approval).toBe("organiser");
    const t = await createDraft(store, { registration: {} });
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { registration: { approval: "organiser" } }))?.status).toBe(200);
    expect(store.tournament(t.id)!.registration?.approval).toBe("organiser");
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { registration: { approval: "maybe" } }))?.status).toBe(400);
  });

  it("a blank registration close falls back to the start: no self-entry once the tournament has started", async () => {
    const store = newStore();
    const started = await createDraft(store, { publish: true, registration: {}, startsAt: "2026-11-01T09:00:00.000Z" });
    const late = await call(store, "POST", `/api/tournaments/${started.id}/entrants`, coach("Alice"), { teamRef: "save:alice" });
    expect(late?.status).toBe(409);
    expect(late?.body).toMatchObject({ code: "closed" });
    const upcoming = await createDraft(store, { publish: true, registration: {}, startsAt: "2026-12-01T09:00:00.000Z" });
    expect((await call(store, "POST", `/api/tournaments/${upcoming.id}/entrants`, coach("Alice"), { teamRef: "save:alice" }))?.status).toBe(201);
  });

  it("a blank close is the start, and the window is checked against it (create and PATCH)", async () => {
    const store = newStore();
    const res = await call(store, "POST", "/api/tournaments", owner, { name: "Late", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, startsAt: "2026-12-01T00:00:00.000Z", registration: { opensAt: "2026-12-02T00:00:00.000Z" } });
    expect(res?.status).toBe(400);
    expect((res?.body as { error: string }).error).toBe("Registration must open before the tournament starts.");
    const ci = await call(store, "POST", "/api/tournaments", owner, { name: "Late", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: true, startsAt: "2026-12-01T00:00:00.000Z", registration: { checkIn: { self: true, opensAt: "2026-12-01T00:00:00.000Z" } } });
    expect((ci?.body as { error: string }).error).toBe("Check-in must open before the tournament starts.");
    expect(store.tournaments(["draft"])).toHaveLength(0);
    const t = await createDraft(store, { startsAt: "2026-12-01T00:00:00.000Z", registration: { opensAt: "2026-11-20T00:00:00.000Z" } });
    const moved = await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { registration: { opensAt: "2026-12-02T00:00:00.000Z" } });
    expect(moved?.status).toBe(400);
    expect((moved?.body as { error: string }).error).toBe("Registration must open before the tournament starts.");
    const earlier = await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { startsAt: "2026-11-15T00:00:00.000Z" });
    expect(earlier?.status).toBe(400);
    expect(store.tournament(t.id)!.registration?.opensAt).toBe("2026-11-20T00:00:00.000Z");
    expect(store.tournament(t.id)!.startsAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("an unpublished draft cannot be started", () => {
    const store = newStore();
    const t = store.createTournament({ name: "S", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", organizerCoachId: "Veers", publication: "draft" }, now);
    expect(() => store.startTournament(t.id, { force: true, checks: {} }, now)).toThrow("Publish the tournament before starting it.");
  });
});

describe("test sign-in sessions (Q13)", () => {
  it("may create (marked test) and write only in tournaments marked test", async () => {
    const store = newStore();
    const real = await createDraft(store, { publish: true });
    const test = await createDraft(store, { publish: true }, { ...owner, test: true });
    expect(test.test).toBe(true);
    expect(real.test).toBeUndefined();
    expect(testSessionTournamentRefusal(store, "POST", "/api/tournaments")).toBeUndefined();
    expect(testSessionTournamentRefusal(store, "POST", "/api/fork/tournaments")).toBeUndefined();
    expect(testSessionTournamentRefusal(store, "PATCH", `/api/tournaments/${test.id}`)).toBeUndefined();
    expect(testSessionTournamentRefusal(store, "POST", `/api/fork/tournaments/${test.id}/entrants`)).toBeUndefined();
    expect(testSessionTournamentRefusal(store, "PATCH", `/api/tournaments/${real.id}`)).toBe(TEST_SESSION_TOURNAMENT_REFUSAL);
    expect(testSessionTournamentRefusal(store, "POST", `/api/tournaments/${real.id}/publish`)).toBe(TEST_SESSION_TOURNAMENT_REFUSAL);
    expect(testSessionTournamentRefusal(store, "POST", "/api/tournaments/missing/entrants")).toBe(TEST_SESSION_TOURNAMENT_REFUSAL);
    expect(testSessionTournamentRefusal(store, "PATCH", "/api/scheduled-matches/m1/result")).toBe(TEST_SESSION_TOURNAMENT_REFUSAL);
    expect(testSessionTournamentRefusal(store, "DELETE", "/api/tournaments")).toBe(TEST_SESSION_TOURNAMENT_REFUSAL);
  });

  it("a test session cannot create inside a real series", async () => {
    const store = newStore();
    const series = store.createSeries({ name: "Real Series", description: "", organisers: ["Veers"], scoring: "sum", seeding: "dutch", createdBy: "Veers" }, now);
    const res = await call(store, "POST", "/api/tournaments", { ...owner, test: true }, { name: "T", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: false, seriesId: series.id });
    expect(res?.status).toBe(403);
    expect(store.seriesRecord(series.id)!.tournaments).toEqual([]);
    expect((await call(store, "POST", "/api/tournaments", owner, { name: "R", packageName: "Spike 2026", maxPlayers: 4, format: "swiss", publish: false, seriesId: series.id }))?.status).toBe(201);
  });
});
