import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";

const roots: string[] = [];
const now = new Date("2026-08-27T20:00:00.000Z");
const organizer: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const coach: TournamentApiIdentity = { coach: "Alice", organizer: false, admin: false };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-rounds-finish-export-"));
  roots.push(root);
  return new TournamentStore(root);
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
    packageExists: (name) => name === "Rules",
    teamBuild: (teamId) => ({ teamId, teamName: teamId === "team-alice" ? "Comma, \"Quoted\"\nTeam" : teamId }),
    now: () => now,
  });
}

function entrant(store: TournamentStore, tournamentId: string, name: string): void {
  store.registerEntrant(tournamentId, {
    coachId: name,
    ffbCoachId: name,
    verifiedAt: now.toISOString(),
  }, `team-${name.toLowerCase()}`, now);
}

describe("Swiss roundCount contract", () => {
  it("accepts an explicit create count and preserves it across unrelated patches", async () => {
    const store = newStore();
    const created = await call(store, "POST", "/api/fork/tournaments", organizer, {
      name: "Long Swiss",
      packageName: "Rules",
      maxPlayers: 8,
      format: "swiss",
      roundCount: 7,
    });
    const tournament = (created!.body as { tournament: { id: string } }).tournament;
    expect(created).toMatchObject({
      status: 201,
      body: { tournament: { roundCount: 7, roundCountExplicit: true } },
    });
    await call(store, "PATCH", `/api/fork/tournaments/${tournament.id}`, organizer, {
      maxPlayers: 16,
      startsAt: "2026-09-01T12:00:00.000Z",
    });
    expect(store.tournament(tournament.id)).toMatchObject({ roundCount: 7, roundCountExplicit: true, maxPlayers: 16 });
  });

  it("keeps the derived default when absent and enforces format, floor, and ceiling rules", async () => {
    const store = newStore();
    const base = { name: "Cup", packageName: "Rules", maxPlayers: 8 };
    const created = await call(store, "POST", "/api/fork/tournaments", organizer, { ...base, format: "swiss" });
    const tournament = (created!.body as { tournament: { id: string } }).tournament;
    expect(created).toMatchObject({ body: { tournament: { roundCount: 3, roundCountExplicit: false } } });
    for (const roundCount of [0, 51]) {
      expect((await call(store, "PATCH", `/api/tournaments/${tournament.id}`, organizer, { roundCount }))?.status).toBe(400);
    }
    const snapshot = store.snapshot();
    snapshot.tournaments[tournament.id]!.currentRound = 3;
    store.writeSnapshot(snapshot);
    expect(await call(store, "PATCH", `/api/tournaments/${tournament.id}`, organizer, { roundCount: 2 })).toEqual({
      status: 400,
      body: { error: "roundCount must be between 3 and 50." },
    });

    for (const format of ["roundRobin", "knockout"] as const) {
      expect((await call(store, "POST", "/api/fork/tournaments", organizer, {
        ...base, name: format, format, roundCount: 4,
      }))?.status).toBe(400);
      const derived = store.createTournament({ ...base, name: format, format, organizerCoachId: organizer.coach }, now);
      expect(await call(store, "PATCH", `/api/tournaments/${derived.id}`, organizer, { roundCount: 3 })).toEqual({
        status: 400,
        body: { error: "roundCount can be set only for Swiss tournaments." },
      });
    }
  });
});

describe("finish endpoint", () => {
  it("enforces auth tiers, completes active tournaments, cancels open matches, and clears leases/cache", async () => {
    const store = newStore();
    const tournament = store.createTournament({ name: "Finish Cup", packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: organizer.coach }, now);
    entrant(store, tournament.id, "Alice");
    entrant(store, tournament.id, "Bob");
    const snapshot = store.snapshot();
    snapshot.tournaments[tournament.id]!.status = "active";
    store.writeSnapshot(snapshot);
    const round = store.generateNextRound(tournament.id, now);
    const matchId = round.scheduledMatchIds[0]!;
    store.renewWaiting(matchId, "Alice", 45_000, now);
    store.standings(tournament.id);
    expect(store.snapshot().standings[tournament.id]).toBeDefined();

    const path = `/api/fork/tournaments/${tournament.id}/finish`;
    expect(await call(store, "POST", path)).toEqual({ status: 401, body: { error: "Authentication required." } });
    expect(await call(store, "POST", path, coach, {})).toEqual({ status: 403, body: { error: "You are not this tournament's organizer." } });
    expect(await call(store, "POST", path, organizer, {})).toMatchObject({
      status: 200,
      body: { tournament: { status: "completed", updatedAt: now.toISOString() } },
    });
    expect(store.match(matchId)).toMatchObject({ status: "cancelled", revision: 2 });
    expect(store.activeLeases(matchId, now)).toEqual([]);
    expect(store.snapshot().standings[tournament.id]).toBeUndefined();
    expect(() => store.recordResult(matchId, { expectedRevision: 2, homeScore: 1, awayScore: 0 }, now))
      .toThrow("This scheduled match is closed.");
    expect((await call(store, "POST", path, organizer, {}))?.status).toBe(400);
  });

  it("rejects finishing a draft", async () => {
    const store = newStore();
    const tournament = store.createTournament({ name: "Draft", packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: organizer.coach }, now);
    expect(await call(store, "POST", `/api/tournaments/${tournament.id}/finish`, organizer, {})).toEqual({
      status: 400,
      body: { error: "Only an active tournament can be finished." },
    });
  });
});

describe("organizer-only tournament export", () => {
  it("defaults to the exact JSON dump shape for the tournament owner", async () => {
    const store = newStore();
    const tournament = store.createTournament({ name: "Export Cup", packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: organizer.coach }, now);
    entrant(store, tournament.id, "Alice");
    const result = await call(store, "GET", `/api/fork/tournaments/${tournament.id}/export`, organizer);
    expect(result?.status).toBe(200);
    expect(Object.keys(result!.body as object)).toEqual(["tournament", "entrants", "rounds", "standings", "matches"]);
    expect(result?.headers?.["content-disposition"]).toBe('attachment; filename="Export-Cup.json"');
  });

  it("escapes CSV fields and rejects unknown formats", async () => {
    const store = newStore();
    const tournament = store.createTournament({ name: 'Cup: "Final"', packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: organizer.coach }, now);
    entrant(store, tournament.id, "Alice");
    const path = `/api/fork/tournaments/${tournament.id}/export`;
    const csv = await call(store, "GET", path, organizer, undefined, "format=csv");
    expect(csv).toMatchObject({
      status: 200,
      contentType: "text/csv; charset=utf-8",
      headers: { "content-disposition": 'attachment; filename="Cup-Final.csv"' },
    });
    expect(csv?.body).toBe('rank,coach,team,played,W,D,L,points,tdDiff,casDiff\r\n1,Alice,"Comma, ""Quoted""\nTeam",0,0,0,0,0,0,0\r\n');
    expect((await call(store, "GET", path, organizer, undefined, "format=xml"))?.status).toBe(400);
  });
});
