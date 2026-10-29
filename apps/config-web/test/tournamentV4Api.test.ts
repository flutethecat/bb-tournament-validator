import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { migrateTournamentData, TournamentStore } from "../src/tournaments/store.js";
import type { TournamentRecord, TournamentSubmission } from "../src/tournaments/types.js";

// Phase 2 + 3 of the SPA tournaments (spec-spa-tournaments §6.2-6.5): store v4, submissions, roles, roster lock,
// one-click start, participant flags, pairing system / seeding on round generation, widened opponent build read.

const roots: string[] = [];
const now = new Date("2026-10-29T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const helper: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
const admin: TournamentApiIdentity = { coach: "Root", organizer: true, admin: true };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-v4-"));
  roots.push(root);
  return new TournamentStore(root);
}

const TEAMS: Record<string, string> = { "team-alice": "Alice", "team-bob": "Bob", "team-cy": "Cy", "team-dee": "Dee" };
const REGISTERED = ["Veers", "Piett", "Alice", "Bob", "Cy", "Dee", "Root"];
/** The validator stub: `save:bad` fails, `library:` refs pass for teams whose coach matches, everything else passes. */
function validateSubmission(coachName: string, ref: string, packageName: string, at: Date): TournamentSubmission | { error: string; status?: 404 } {
  if (ref === "save:missing") return { error: "Team Builder save not found.", status: 404 };
  const ok = ref !== "save:bad" && !ref.endsWith("team-dee");
  return {
    saveId: ref,
    revision: "r1",
    submittedAt: at.toISOString(),
    teamName: `${coachName} XI`,
    race: "Orc",
    snapshot: { picks: [{ position: "Lineman", count: 11 }], coach: coachName },
    validation: { ok, problems: ok ? [] : ["Team costs 1,010k; the budget is 1,000k."], checkedAt: at.toISOString(), packageName },
  };
}

function deps(store: TournamentStore, over: Partial<TournamentApiDeps> = {}): TournamentApiDeps {
  return {
    store,
    packageExists: (name) => name === "Rules",
    teamOwner: (teamId) => TEAMS[teamId],
    teamBuild: (teamId) => (TEAMS[teamId] ? { teamName: `${TEAMS[teamId]} Live`, race: "Orc" } : undefined),
    validateSubmission,
    registeredCoach: (id) => REGISTERED.find((name) => name.toLowerCase() === id.trim().toLowerCase()),
    coachRating: (name) => ({ Alice: 1500, Bob: 1700, Cy: 1600, Dee: 1400 })[name],
    submissionTeamView: (_coach, submission) => ({ teamName: submission.teamName }),
    now: () => now,
    ...over,
  };
}

function call(store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, query = "", over: Partial<TournamentApiDeps> = {}) {
  return tournamentApi(method, path, new URLSearchParams(query), auth, body, deps(store, over));
}

function draft(store: TournamentStore, coaches: string[] = ["Alice", "Bob"]): TournamentRecord {
  const t = store.createTournament({ name: "Spike Open", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3 }, now);
  for (const name of coaches) {
    store.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: now.toISOString() }, `team-${name.toLowerCase()}`, now);
  }
  return store.tournament(t.id)!;
}

const entrantOf = (store: TournamentStore, id: string, name: string) => store.entrants(id).find((e) => e.coach.ffbCoachId === name)!;

describe("store v3 -> v4 migration", () => {
  it("loads a v3 file unchanged and materialises the v4 defaults", () => {
    const v3 = {
      version: 3,
      tournaments: {
        old: {
          id: "old", name: "Old Cup", status: "active", format: "swiss", packageName: "Rules", maxPlayers: 8, roundCount: 3, currentRound: 1,
          tiebreakers: ["buchholz"], points: { win: 3, draw: 1, loss: 0, bye: 3 }, organizerCoachId: "Veers", startsAt: "2026-11-01T10:00:00Z",
          createdAt: now.toISOString(), updatedAt: now.toISOString(),
        },
      },
      entrants: {
        "old:entrant:1": { id: "old:entrant:1", tournamentId: "old", seed: 1, coach: { coachId: "Alice", ffbCoachId: "Alice", verifiedAt: now.toISOString() }, teamId: "team-alice", registeredAt: now.toISOString() },
      },
      rounds: {}, standings: {}, scheduledMatches: {}, waitingPresence: {},
    };
    const migrated = migrateTournamentData(v3);
    expect(migrated.version).toBe(4);
    const t = migrated.tournaments.old!;
    expect(t).toMatchObject({ name: "Old Cup", status: "active", currentRound: 1, startsAt: "2026-11-01T10:00:00Z", organizerCoachId: "Veers" });
    expect(t.ownerCoachId).toBe("Veers");
    expect(t.organizerCoachIds).toEqual([]);
    expect(t.pairingSystem).toBe("eloSeeded");
    expect(t.seedingMode).toBe("elo");
    expect(t.rostersLockedAt).toBeUndefined();
    expect(migrated.entrants["old:entrant:1"]!.flags).toEqual({ paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true });
    expect(migrated.entrants["old:entrant:1"]!.teamId).toBe("team-alice");
    // Idempotent: a v4 file round-trips.
    expect(migrateTournamentData(migrated)).toEqual(migrated);
  });

  it("a new tournament defaults to Dutch pairing, Elo seeding, the creator as owner", () => {
    const store = newStore();
    const t = draft(store, []);
    expect(t).toMatchObject({ pairingSystem: "dutch", seedingMode: "elo", ownerCoachId: "Veers", organizerCoachId: "Veers", organizerCoachIds: [] });
  });
});

describe("submissions", () => {
  it("validates against the package, stores the result, shows problems only to the coach and managers", async () => {
    const store = newStore();
    const t = draft(store);
    const path = `/api/tournaments/${t.id}/submissions`;
    expect((await call(store, "POST", path, undefined, { saveId: "save:abc" }))?.status).toBe(401);
    expect(await call(store, "POST", path, coach("Zed"), { saveId: "save:abc" })).toMatchObject({ status: 403 });
    expect(await call(store, "POST", path, coach("Alice"), { saveId: "../etc" })).toMatchObject({ status: 400 });
    expect(await call(store, "POST", path, coach("Alice"), { saveId: "save:missing" })).toMatchObject({ status: 404 });
    const bad = await call(store, "POST", path, coach("Alice"), { saveId: "save:bad" });
    expect(bad).toMatchObject({ status: 201, body: { submission: { valid: false, problems: ["Team costs 1,010k; the budget is 1,000k."] } } });
    expect(entrantOf(store, t.id, "Alice").flags?.rosterVerified).toBe(false);
    const good = await call(store, "POST", path, coach("Alice"), { saveId: "save:good" });
    expect(good).toMatchObject({ status: 201, body: { submission: { valid: true, problemCount: 0 } } });
    expect(entrantOf(store, t.id, "Alice").flags?.rosterVerified).toBe(true);

    const anon = (await call(store, "GET", `/api/tournaments/${t.id}`))!.body as { entrants: Array<Record<string, unknown>> };
    const aliceAnon = anon.entrants.find((e) => e.coachId === "Alice")!;
    expect(aliceAnon.submission).toMatchObject({ valid: true });
    expect(aliceAnon.submission).not.toHaveProperty("problems");
    expect(aliceAnon).not.toHaveProperty("flags");
    expect(JSON.stringify(anon)).not.toContain("Lineman");
    const mine = (await call(store, "GET", `/api/tournaments/${t.id}`, coach("Alice")))!.body as { entrants: Array<Record<string, unknown>> };
    expect(mine.entrants.find((e) => e.coachId === "Alice")).toHaveProperty("flags");
    expect(mine.entrants.find((e) => e.coachId === "Bob")).not.toHaveProperty("flags");
  });

  it("is refused (409) while rosters are locked, and accepted again after unlock", async () => {
    const store = newStore();
    const t = draft(store);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/lock-rosters`, owner))?.status).toBe(200);
    expect(await call(store, "POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:x" })).toMatchObject({ status: 409 });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/entrants`, coach("Cy"), { teamId: "team-cy" })).toMatchObject({ status: 409 });
    expect((await call(store, "POST", `/api/tournaments/${t.id}/unlock-rosters`, owner))?.status).toBe(200);
    expect((await call(store, "POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:x" }))?.status).toBe(201);
  });

  it("answers 503 when the host has no validator", async () => {
    const store = newStore();
    const t = draft(store);
    expect(await call(store, "POST", `/api/tournaments/${t.id}/submissions`, coach("Alice"), { saveId: "save:x" }, "", { validateSubmission: undefined }))
      .toMatchObject({ status: 503 });
  });
});

describe("owner and organisers", () => {
  it("owner or admin assigns roles to registered coaches; organisers then manage", async () => {
    const store = newStore();
    const t = draft(store);
    const orgPath = `/api/tournaments/${t.id}/organizers/Piett`;
    expect(await call(store, "PATCH", `/api/tournaments/${t.id}`, helper, { maxPlayers: 10 })).toMatchObject({ status: 403 });
    expect(await call(store, "POST", orgPath, helper)).toMatchObject({ status: 403 });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/organizers/Nobody`, owner)).toMatchObject({ status: 400 });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/organizers/piett`, owner))
      .toMatchObject({ status: 200, body: { tournament: { organizerCoachIds: ["Piett"] } } });
    expect(await call(store, "PATCH", `/api/tournaments/${t.id}`, helper, { maxPlayers: 10 })).toMatchObject({ status: 200 });
    // An organiser manages but cannot assign roles.
    expect(await call(store, "POST", `/api/tournaments/${t.id}/owner`, helper, { coachId: "Piett" })).toMatchObject({ status: 403 });
    const detail = await call(store, "GET", `/api/tournaments/${t.id}`, helper);
    expect(detail).toMatchObject({ body: { capabilities: { manage: true, assignRoles: false } } });
    expect(await call(store, "DELETE", orgPath, owner)).toMatchObject({ status: 200, body: { tournament: { organizerCoachIds: [] } } });
    expect(await call(store, "DELETE", orgPath, owner)).toMatchObject({ status: 404 });
  });

  it("owner reassignment: registered users only; the old owner loses control, organizerCoachId follows", async () => {
    const store = newStore();
    const t = draft(store);
    const path = `/api/tournaments/${t.id}/owner`;
    expect(await call(store, "POST", path, owner, { coachId: "Ghost" })).toMatchObject({ status: 400 });
    expect(await call(store, "POST", path, owner, { coachId: "bob" }))
      .toMatchObject({ status: 200, body: { tournament: { ownerCoachId: "Bob", organizerCoachId: "Bob" } } });
    expect(await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { maxPlayers: 10 })).toMatchObject({ status: 403 });
    expect(await call(store, "POST", path, admin, { coachId: "Veers" })).toMatchObject({ status: 200 });
    expect((await call(store, "GET", `/api/tournaments/${t.id}`, admin))?.body).toMatchObject({ capabilities: { manage: true, assignRoles: true } });
  });
});

describe("dates and settings", () => {
  it("PATCH accepts endsAt, pairingSystem and seedingMode with validation", async () => {
    const store = newStore();
    const t = draft(store);
    const path = `/api/tournaments/${t.id}`;
    expect(await call(store, "PATCH", path, owner, { startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-02T18:00:00Z", pairingSystem: "monrad", seedingMode: "manual" }))
      .toMatchObject({ status: 200, body: { tournament: { endsAt: "2026-11-02T18:00:00Z", pairingSystem: "monrad", seedingMode: "manual" } } });
    expect(await call(store, "PATCH", path, owner, { endsAt: "2026-10-01T10:00:00Z" })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { endsAt: "tomorrow" })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { pairingSystem: "accelerated" })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { seedingMode: "random" })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { endsAt: "" })).toMatchObject({ status: 200 });
    expect(store.tournament(t.id)!.endsAt).toBeUndefined();
  });

  it("the list answers status=all (every state) for the admin page", async () => {
    const store = newStore();
    draft(store);
    const all = await call(store, "GET", "/api/fork/tournaments", undefined, undefined, "status=all");
    expect((all!.body as { tournaments: unknown[] }).tournaments).toHaveLength(1);
    expect((all!.body as { tournaments: Array<{ remainingRounds: number }> }).tournaments[0]!.remainingRounds).toBe(3);
  });
});

describe("start tournament (one click: lock + validate + start)", () => {
  it("refuses with per-entrant problems when a roster is invalid, keeps the lock, starts with force", async () => {
    const store = newStore();
    const t = draft(store, ["Alice", "Bob", "Dee"]);
    const path = `/api/tournaments/${t.id}/start`;
    expect(await call(store, "POST", path, coach("Alice"))).toMatchObject({ status: 403 });
    const refused = await call(store, "POST", path, owner, {});
    expect(refused?.status).toBe(409);
    const body = refused!.body as { problems: Array<{ coachId: string; problems: string[] }>; validation: unknown[] };
    expect(body.problems.map((p) => p.coachId)).toEqual(["Dee"]);
    expect(body.problems[0]!.problems).toEqual(["Team costs 1,010k; the budget is 1,000k."]);
    expect(body.validation).toHaveLength(3);
    expect(store.tournament(t.id)).toMatchObject({ status: "draft" });
    expect(store.tournament(t.id)!.rostersLockedAt).toBe(now.toISOString());
    expect(entrantOf(store, t.id, "Alice").flags).toMatchObject({ frozen: true, rosterVerified: true });
    expect(entrantOf(store, t.id, "Alice").submission?.snapshot).toMatchObject({ coach: "Alice" });

    const started = await call(store, "POST", path, owner, { force: true });
    expect(started).toMatchObject({ status: 200, body: { tournament: { status: "active", startedAt: now.toISOString() } } });
    expect(await call(store, "POST", path, owner, {})).toMatchObject({ status: 409 });
  });

  it("an organiser override of rosterVerified lets the start through without force", async () => {
    const store = newStore();
    const t = draft(store, ["Alice", "Dee"]);
    await call(store, "POST", `/api/tournaments/${t.id}/lock-rosters`, owner);
    const dee = entrantOf(store, t.id, "Dee");
    expect(dee.flags?.rosterVerified).toBe(false);
    expect(await call(store, "PATCH", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(dee.id)}`, owner, { flags: { rosterVerified: true }, paid: true }))
      .toMatchObject({ status: 200, body: { entrant: { flags: { rosterVerified: true, paid: true }, rosterVerifiedOverride: true } } });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {})).toMatchObject({ status: 200 });
  });

  it("needs two undropped entrants", async () => {
    const store = newStore();
    const t = draft(store, ["Alice"]);
    expect(await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, {})).toMatchObject({ status: 409, body: { error: "A tournament needs at least two entrants to start." } });
  });
});

describe("participants", () => {
  it("PATCH entrant sets flags and manual seed; rejects unknown flags and bad seeds", async () => {
    const store = newStore();
    const t = draft(store);
    const alice = entrantOf(store, t.id, "Alice");
    const path = `/api/tournaments/${t.id}/entrants/${encodeURIComponent(alice.id)}`;
    expect(await call(store, "PATCH", path, coach("Alice"), { paid: true })).toMatchObject({ status: 403 });
    expect(await call(store, "PATCH", path, owner, { flags: { checkedIn: true, active: false }, manualSeed: 4 }))
      .toMatchObject({ status: 200, body: { entrant: { flags: { checkedIn: true, active: false, paid: false }, manualSeed: 4 } } });
    expect(await call(store, "PATCH", path, owner, { flags: { vip: true } })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { flags: { paid: "yes" } })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { manualSeed: 0 })).toMatchObject({ status: 400 });
    expect(await call(store, "PATCH", path, owner, { manualSeed: null })).toMatchObject({ status: 200 });
    expect(entrantOf(store, t.id, "Alice").manualSeed).toBeUndefined();
  });
});

describe("rounds: pairing system, seeding mode, preview", () => {
  async function started(store: TournamentStore, names: string[]) {
    const t = draft(store, names);
    await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, { force: true });
    return t;
  }

  it("preview writes nothing; manual seeding orders round 1 by the organiser's seeds", async () => {
    const store = newStore();
    const t = await started(store, ["Alice", "Bob", "Cy", "Dee"]);
    const seeds: Record<string, number> = { Alice: 1, Dee: 2, Cy: 3, Bob: 4 };
    for (const e of store.entrants(t.id)) await call(store, "PATCH", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(e.id)}`, owner, { manualSeed: seeds[e.coach.ffbCoachId] });
    const before = JSON.stringify(store.snapshot());
    const preview = await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, { preview: true, pairingSystem: "monrad", seedingMode: "manual" });
    expect(preview).toMatchObject({ status: 200, body: { preview: true, roundNumber: 1, pairingSystem: "monrad", seedingMode: "manual" } });
    expect(JSON.stringify(store.snapshot())).toBe(before);
    const byId = (id: string) => store.entrants(t.id).find((e) => e.id === id)!.coach.ffbCoachId;
    const pairs = (preview!.body as { pairings: Array<{ homeEntrantId: string; awayEntrantId: string }> }).pairings.map((p) => `${byId(p.homeEntrantId)}-${byId(p.awayEntrantId)}`);
    expect(pairs).toEqual(["Alice-Dee", "Cy-Bob"]);

    const generated = await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, { pairingSystem: "monrad", seedingMode: "manual" });
    expect(generated?.status).toBe(200);
    expect(store.tournament(t.id)).toMatchObject({ pairingSystem: "monrad", seedingMode: "manual", currentRound: 1 });
    expect(store.matches(t.id).map((m) => `${m.home.coach.ffbCoachId}-${m.away?.coach.ffbCoachId}`)).toEqual(["Alice-Dee", "Cy-Bob"]);
  });

  it("Elo seeding with Dutch: top half v bottom half by rating", async () => {
    const store = newStore();
    const t = await started(store, ["Alice", "Bob", "Cy", "Dee"]);
    await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, {});
    // Ratings Bob 1700, Cy 1600, Alice 1500, Dee 1400 -> seeds 1..4 -> 1 v 3, 2 v 4.
    expect(store.matches(t.id).map((m) => `${m.home.coach.ffbCoachId}-${m.away?.coach.ffbCoachId}`)).toEqual(["Bob-Alice", "Cy-Dee"]);
  });

  it("standby entrants are not drawn", async () => {
    const store = newStore();
    const t = await started(store, ["Alice", "Bob", "Cy", "Dee"]);
    const cy = entrantOf(store, t.id, "Cy");
    await call(store, "PATCH", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(cy.id)}`, owner, { flags: { active: false } });
    await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, {});
    const drawn = store.matches(t.id).flatMap((m) => [m.home.coach.ffbCoachId, m.away?.coach.ffbCoachId]).filter(Boolean);
    expect(drawn).not.toContain("Cy");
    expect(drawn).toHaveLength(3);
  });

  it("rejects an unknown system and a non-manager", async () => {
    const store = newStore();
    const t = await started(store, ["Alice", "Bob"]);
    expect(await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, { pairingSystem: "x" })).toMatchObject({ status: 400 });
    expect(await call(store, "POST", `/api/tournaments/${t.id}/rounds`, coach("Alice"), { preview: true })).toMatchObject({ status: 403 });
  });
});

describe("fixtures and the opponent's team", () => {
  it("entrants see every fixture of their event; the current opponent (and only they) may read the snapshot", async () => {
    const store = newStore();
    const t = draft(store, ["Alice", "Bob", "Cy", "Dee"]);
    await call(store, "POST", `/api/tournaments/${t.id}/start`, owner, { force: true });
    await call(store, "POST", `/api/tournaments/${t.id}/rounds`, owner, {});
    const asAlice = (await call(store, "GET", `/api/tournaments/${t.id}`, coach("Alice")))!.body as { scheduledMatches: unknown[] };
    expect(asAlice.scheduledMatches).toHaveLength(2);
    const outsider = (await call(store, "GET", `/api/tournaments/${t.id}`, coach("Zed")))!.body as { scheduledMatches: unknown[] };
    expect(outsider.scheduledMatches).toHaveLength(0);

    // Bob-Alice and Cy-Dee (Elo seeding): Alice may read Bob, not Cy.
    const bob = entrantOf(store, t.id, "Bob");
    const cy = entrantOf(store, t.id, "Cy");
    const read = await call(store, "GET", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(bob.id)}/build`, coach("Alice"));
    expect(read).toMatchObject({ status: 200, body: { coachId: "Bob", submission: { valid: true, view: { teamName: "Bob XI" } }, inert: true } });
    expect(read!.body).not.toHaveProperty("submission.problems");
    expect(JSON.stringify(read!.body)).not.toContain("Lineman");
    expect(await call(store, "GET", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(cy.id)}/build`, coach("Alice"))).toMatchObject({ status: 403 });
    expect(await call(store, "GET", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(cy.id)}/build`, helper)).toMatchObject({ status: 403 });
    await call(store, "POST", `/api/tournaments/${t.id}/organizers/Piett`, owner);
    expect(await call(store, "GET", `/api/tournaments/${t.id}/entrants/${encodeURIComponent(cy.id)}/build`, helper)).toMatchObject({ status: 200 });
  });
});
