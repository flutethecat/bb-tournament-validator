import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { migrateTournamentData, TournamentStore } from "../src/tournaments/store.js";
import type { TournamentRecord } from "../src/tournaments/types.js";

const roots: string[] = [];
const now = new Date("2026-08-27T12:00:00.000Z");
const organizer: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const coach = (name: string): TournamentApiIdentity => ({ coach: name, organizer: false, admin: false });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-entry-contract-"));
  roots.push(root);
  return new TournamentStore(root);
}

const owners: Record<string, string> = {
  "team-alice": "Alice",
  "team-bob": "Bob",
  "team-carol": "Carol",
};

async function call(
  store: TournamentStore,
  method: string,
  path: string,
  auth?: TournamentApiIdentity,
  body?: unknown,
) {
  return tournamentApi(method, path, new URLSearchParams(), auth, body, {
    store,
    teamBuild: (teamId) => owners[teamId] ? { teamId, coach: owners[teamId] } : undefined,
    teamOwner: (teamId) => owners[teamId],
    packageExists: (name) => name === "Spike 2026",
    now: () => now,
  });
}

async function create(store: TournamentStore, maxPlayers = 4): Promise<TournamentRecord> {
  const result = await call(store, "POST", "/api/fork/tournaments", organizer, {
    name: "Veers Invitational",
    packageName: "Spike 2026",
    maxPlayers,
    format: "swiss",
  });
  expect(result?.status).toBe(201);
  return (result?.body as { tournament: TournamentRecord }).tournament;
}

describe("tournament creation contract", () => {
  it("creates an organizer-owned draft and rejects a plain coach", async () => {
    const store = newStore();
    const created = await create(store, 8);
    expect(created).toMatchObject({
      name: "Veers Invitational",
      status: "draft",
      packageName: "Spike 2026",
      maxPlayers: 8,
      format: "swiss",
      currentRound: 0,
    });
    expect((await call(store, "POST", "/api/fork/tournaments", coach("Alice"), {
      name: "Nope", packageName: "Spike 2026", maxPlayers: 4, format: "swiss",
    }))?.status).toBe(403);
  });

  it("rejects unknown packages and invalid formats", async () => {
    const store = newStore();
    expect((await call(store, "POST", "/api/fork/tournaments", organizer, {
      name: "Unknown", packageName: "Missing", maxPlayers: 4, format: "swiss",
    }))?.status).toBe(400);
    expect((await call(store, "POST", "/api/fork/tournaments", organizer, {
      name: "Bad format", packageName: "Spike 2026", maxPlayers: 4, format: "ladder",
    }))?.status).toBe(400);
  });
});

describe("entrant registration contract", () => {
  it("registers a coach's own team and rejects a duplicate coach", async () => {
    const store = newStore();
    const tournament = await create(store);
    const path = `/api/fork/tournaments/${tournament.id}/entrants`;
    const first = await call(store, "POST", path, coach("Alice"), { teamId: "team-alice" });
    expect(first).toMatchObject({ status: 201, body: { entrant: { seed: 1, teamId: "team-alice", coach: { ffbCoachId: "Alice" } } } });
    const duplicate = await call(store, "POST", path, coach("Alice"), { teamId: "team-alice" });
    expect(duplicate).toMatchObject({ status: 400, body: { error: "Coach is already entered in this tournament." } });
  });

  it("enforces maxPlayers at registration", async () => {
    const store = newStore();
    const tournament = await create(store, 2);
    const path = `/api/fork/tournaments/${tournament.id}/entrants`;
    await call(store, "POST", path, coach("Alice"), { teamId: "team-alice" });
    await call(store, "POST", path, coach("Bob"), { teamId: "team-bob" });
    const full = await call(store, "POST", path, coach("Carol"), { teamId: "team-carol" });
    expect(full).toEqual({ status: 400, body: { error: "Tournament is full." } });
  });

  it("rejects a team not owned by the target coach", async () => {
    const store = newStore();
    const tournament = await create(store);
    const result = await call(store, "POST", `/api/fork/tournaments/${tournament.id}/entrants`, coach("Alice"), { teamId: "team-bob" });
    expect(result).toMatchObject({ status: 400, body: { error: "Team is not owned by the target coach." } });
  });

  it("allows organizer manual seeding and forbids a plain coach doing it", async () => {
    const store = newStore();
    const tournament = await create(store);
    const path = `/api/fork/tournaments/${tournament.id}/entrants`;
    const manual = await call(store, "POST", path, organizer, { teamId: "team-bob", coach: "Bob" });
    expect(manual).toMatchObject({ status: 201, body: { entrant: { seed: 1, coach: { ffbCoachId: "Bob" } } } });
    const forbidden = await call(store, "POST", path, coach("Alice"), { teamId: "team-carol", coach: "Carol" });
    expect(forbidden).toMatchObject({ status: 403, body: { error: "Only an organizer may register another coach." } });
  });

  it("soft-drops an entrant for self or organizer and never removes the row", async () => {
    const store = newStore();
    const tournament = await create(store);
    const collection = `/api/fork/tournaments/${tournament.id}/entrants`;
    const registered = await call(store, "POST", collection, coach("Alice"), { teamId: "team-alice" });
    const entrantId = (registered?.body as { entrant: { id: string } }).entrant.id;
    const dropped = await call(store, "DELETE", `${collection}/${encodeURIComponent(entrantId)}`, coach("Alice"));
    expect(dropped).toMatchObject({ status: 200, body: { entrant: { id: entrantId, droppedAt: now.toISOString() } } });
    expect(store.entrants(tournament.id)).toHaveLength(1);
    expect(store.entrants(tournament.id)[0]?.droppedAt).toBe(now.toISOString());
  });
});

describe("legacy tournament migration defaults", () => {
  const legacyTournament = {
    id: "legacy", name: "Legacy Cup", status: "active", roundCount: 3, currentRound: 0,
    tiebreakers: ["seed"], points: { win: 3, draw: 1, loss: 0, bye: 3 },
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };

  it.each([1, 2])("normalizes real version %i tournament rows", (version) => {
    const migrated = migrateTournamentData({
      version,
      tournaments: version === 1 ? [legacyTournament] : { legacy: legacyTournament },
      entrants: version === 1 ? [] : {}, rounds: version === 1 ? [] : {}, standings: {},
      scheduledMatches: version === 1 ? [] : {}, waitingPresence: {},
    });
    expect(migrated.tournaments.legacy).toMatchObject({ format: "swiss", packageName: "", maxPlayers: 0 });
  });
});
