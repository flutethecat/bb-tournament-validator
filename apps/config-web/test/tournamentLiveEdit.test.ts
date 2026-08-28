import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import type { TournamentRecord } from "../src/tournaments/types.js";

const roots: string[] = [];
const createdAt = new Date("2026-08-27T12:00:00.000Z");
const updatedAt = new Date("2026-08-27T18:00:00.000Z");
const organizer: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const coach: TournamentApiIdentity = { coach: "Alice", organizer: false, admin: false };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-live-edit-"));
  roots.push(root);
  return new TournamentStore(root);
}

function create(store: TournamentStore): TournamentRecord {
  return store.createTournament({
    name: "Live Cup",
    packageName: "Spike 2026",
    maxPlayers: 8,
    format: "swiss",
    organizerCoachId: organizer.coach,
  }, createdAt);
}

function call(
  store: TournamentStore,
  method: string,
  path: string,
  auth?: TournamentApiIdentity,
  body?: unknown,
  query = "",
) {
  return tournamentApi(method, path, new URLSearchParams(query), auth, body, {
    store,
    teamBuild: () => undefined,
    packageExists: (name) => name === "Spike 2026" || name === "Updated Rules",
    now: () => updatedAt,
  });
}

function addEntrant(store: TournamentStore, tournamentId: string, name: string): void {
  store.registerEntrant(tournamentId, {
    coachId: name,
    ffbCoachId: name,
    verifiedAt: createdAt.toISOString(),
  }, `team-${name.toLowerCase()}`, createdAt);
}

function addRound(store: TournamentStore, tournamentId: string): void {
  const snapshot = store.snapshot();
  const id = `${tournamentId}:round:1`;
  snapshot.rounds[id] = {
    id,
    tournamentId,
    number: 1,
    status: "pending",
    scheduledMatchIds: [],
    createdAt: createdAt.toISOString(),
  };
  store.writeSnapshot(snapshot);
}

describe("organizer tournament live-edit", () => {
  it("allows organizers and rejects coaches and unauthenticated callers", async () => {
    const store = newStore();
    const tournament = create(store);
    const path = `/api/fork/tournaments/${tournament.id}`;

    expect(await call(store, "PATCH", path, undefined, { maxPlayers: 10 })).toEqual({
      status: 401,
      body: { error: "Authentication required." },
    });
    expect(await call(store, "PATCH", path, coach, { maxPlayers: 10 })).toEqual({
      status: 403,
      body: { error: "You are not this tournament's organizer." },
    });
    expect(await call(store, "PATCH", path, organizer, { maxPlayers: 10 })).toMatchObject({
      status: 200,
      body: { tournament: { id: tournament.id, maxPlayers: 10, updatedAt: updatedAt.toISOString() } },
    });
  });

  it("names the non-dropped entrant floor", async () => {
    const store = newStore();
    const tournament = create(store);
    addEntrant(store, tournament.id, "Alice");
    addEntrant(store, tournament.id, "Bob");
    addEntrant(store, tournament.id, "Carol");
    const carol = store.entrants(tournament.id).find((entrant) => entrant.coach.ffbCoachId === "Carol")!;
    store.dropEntrant(tournament.id, carol.id, "Carol", false, createdAt);

    expect(await call(store, "PATCH", `/api/tournaments/${tournament.id}`, organizer, { maxPlayers: 1 })).toEqual({
      status: 400,
      body: { error: "maxPlayers cannot be below the current non-dropped entrant count of 2." },
    });
  });

  it("allows format and ruleset changes before rounds, then locks both", async () => {
    const store = newStore();
    const tournament = create(store);
    const path = `/api/tournaments/${tournament.id}`;

    expect(await call(store, "PATCH", path, organizer, {
      format: "roundRobin",
      packageName: "Updated Rules",
    })).toMatchObject({
      status: 200,
      body: { tournament: { format: "roundRobin", packageName: "Updated Rules", roundCount: 7 } },
    });

    addRound(store, tournament.id);
    expect(await call(store, "PATCH", path, organizer, { format: "swiss" })).toEqual({
      status: 400,
      body: { error: "Format is locked once rounds exist." },
    });
    expect(await call(store, "PATCH", path, organizer, { packageName: "Spike 2026" })).toEqual({
      status: 400,
      body: { error: "Ruleset is locked once rounds exist." },
    });
  });

  it("sets, emits, and clears startsAt and rejects bad dates", async () => {
    const store = newStore();
    const tournament = create(store);
    const path = `/api/fork/tournaments/${tournament.id}`;
    const startsAt = "2026-09-12T18:30:00.000Z";

    expect(await call(store, "PATCH", path, organizer, { startsAt })).toMatchObject({
      status: 200,
      body: { tournament: { startsAt } },
    });
    const list = await call(store, "GET", "/api/fork/tournaments", undefined, undefined, "status=draft");
    expect((list?.body as { tournaments: TournamentRecord[] }).tournaments[0]).toMatchObject({ startsAt });
    const detail = await call(store, "GET", path);
    expect((detail?.body as { tournament: TournamentRecord }).tournament).toMatchObject({ startsAt });

    expect(await call(store, "PATCH", path, organizer, { startsAt: "not-a-date" })).toEqual({
      status: 400,
      body: { error: "startsAt must be an ISO-8601 timestamp." },
    });
    const cleared = await call(store, "PATCH", path, organizer, { startsAt: "" });
    expect((cleared?.body as { tournament: TournamentRecord }).tournament).not.toHaveProperty("startsAt");
    const clearedList = await call(store, "GET", "/api/fork/tournaments", undefined, undefined, "status=draft");
    expect((clearedList?.body as { tournaments: TournamentRecord[] }).tournaments[0]).not.toHaveProperty("startsAt");
    const clearedDetail = await call(store, "GET", path);
    expect((clearedDetail?.body as { tournament: TournamentRecord }).tournament).not.toHaveProperty("startsAt");
  });

  it("keeps startsAt absent when another field is patched", async () => {
    const store = newStore();
    const tournament = create(store);
    expect(tournament).not.toHaveProperty("startsAt");

    const updated = store.updateTournament(tournament.id, { maxPlayers: 9 }, updatedAt);
    expect(updated).not.toHaveProperty("startsAt");
    expect(store.snapshot().tournaments[tournament.id]).not.toHaveProperty("startsAt");
  });

  it("rewrites only an explicitly patched primary tiebreaker and never adds seed", async () => {
    const store = newStore();
    const tournament = create(store);
    const snapshot = store.snapshot();
    snapshot.tournaments[tournament.id]!.tiebreakers = ["buchholz", "sonnebornBerger", "seed"];
    store.writeSnapshot(snapshot);
    const path = `/api/fork/tournaments/${tournament.id}`;

    await call(store, "PATCH", path, organizer, { maxPlayers: 9 });
    expect(store.tournament(tournament.id)?.tiebreakers).toEqual(["buchholz", "sonnebornBerger", "seed"]);

    const patched = await call(store, "PATCH", path, organizer, { primaryTiebreaker: "sonnebornBerger" });
    expect(patched).toMatchObject({
      status: 200,
      body: { tournament: { tiebreakers: ["sonnebornBerger", "touchdownDifferential", "casualtyDifferential"] } },
    });
    expect(store.tournament(tournament.id)?.tiebreakers).not.toContain("seed");
  });

  it("rejects invalid primary tiebreakers and locks ranking only at completion", async () => {
    const store = newStore();
    const tournament = create(store);
    const path = `/api/fork/tournaments/${tournament.id}`;

    expect(await call(store, "PATCH", path, organizer, { primaryTiebreaker: "seed" })).toEqual({
      status: 400,
      body: { error: "primaryTiebreaker must be buchholz or sonnebornBerger." },
    });

    addRound(store, tournament.id);
    expect(await call(store, "PATCH", path, organizer, { primaryTiebreaker: "sonnebornBerger" })).toMatchObject({
      status: 200,
      body: { tournament: { tiebreakers: ["sonnebornBerger", "touchdownDifferential", "casualtyDifferential"] } },
    });

    const snapshot = store.snapshot();
    snapshot.tournaments[tournament.id]!.status = "completed";
    store.writeSnapshot(snapshot);
    expect(await call(store, "PATCH", path, organizer, { primaryTiebreaker: "sonnebornBerger" })).toEqual({
      status: 400,
      body: { error: "Ranking is locked once the tournament is completed." },
    });
  });
});
