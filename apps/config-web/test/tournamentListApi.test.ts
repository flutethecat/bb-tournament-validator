import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tournamentApi } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";
import type { TournamentDataFileV2, TournamentEntrantRecord, TournamentRecord } from "../src/tournaments/types.js";

const roots: string[] = [];
const timestamp = "2026-08-27T12:00:00.000Z";

function tournament(
  id: string,
  name: string,
  status: TournamentRecord["status"] = "active",
  format: TournamentRecord["format"] = "swiss",
): TournamentRecord {
  return {
    id,
    name,
    status,
    format,
    packageName: "Spike 2026",
    maxPlayers: 32,
    roundCount: 5,
    currentRound: 1,
    tiebreakers: ["buchholz", "sonnebornBerger", "seed"],
    points: { win: 3, draw: 1, loss: 0, bye: 3 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function entrant(id: string, tournamentId: string, dropped = false): TournamentEntrantRecord {
  return {
    id,
    tournamentId,
    seed: id === "active-entrant" ? 1 : 2,
    coach: { coachId: id, ffbCoachId: id, verifiedAt: timestamp },
    teamId: `team-${id}`,
    registeredAt: timestamp,
    ...(dropped ? { droppedAt: timestamp } : {}),
  };
}

function store(
  tournaments: TournamentDataFileV2["tournaments"] = {},
  entrants: TournamentDataFileV2["entrants"] = {},
): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-list-"));
  roots.push(root);
  const result = new TournamentStore(root);
  result.writeSnapshot({
    version: 2,
    tournaments,
    entrants,
    rounds: {},
    standings: {},
    scheduledMatches: {},
    waitingPresence: {},
  });
  return result;
}

async function get(tournamentStore: TournamentStore, path: string, query = "") {
  return tournamentApi("GET", path, new URLSearchParams(query), undefined, undefined, {
    store: tournamentStore,
    teamBuild: () => undefined,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tournament list client contract", () => {
  it("always returns the paged shape for an empty store", async () => {
    expect(await get(store(), "/api/tournaments")).toEqual({
      status: 200,
      body: { tournaments: [], page: 1, pageSize: 20, total: 0, hasMore: false },
    });
    expect((await get(store(), "/api/tournaments", "page=not-a-page"))?.body).toMatchObject({ page: 1 });
  });

  it("maps portal categories and excludes cancelled tournaments", async () => {
    const tournamentStore = store({
      active: tournament("active", "Active Cup", "active"),
      future: tournament("future", "Future Cup", "draft"),
      finished: tournament("finished", "Finished Cup", "completed"),
      cancelled: tournament("cancelled", "Cancelled Cup", "cancelled"),
    });

    for (const [category, id] of [["active", "active"], ["future", "future"], ["finished", "finished"]]) {
      const result = await get(tournamentStore, "/api/tournaments", `category=${category}`);
      expect((result?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id)).toEqual([id]);
    }
    const legacyDraft = await get(tournamentStore, "/api/fork/tournaments", "status=draft");
    expect((legacyDraft?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id)).toEqual(["future"]);
  });

  it("filters q by a case-insensitive name substring", async () => {
    const tournamentStore = store({
      spike: tournament("spike", "Autumn SPIKE Cup"),
      chaos: tournament("chaos", "Chaos Invitational"),
    });
    const result = await get(tournamentStore, "/api/tournaments", "category=active&q=spike");
    expect((result?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id)).toEqual(["spike"]);
  });

  it("paginates the filtered and sorted set", async () => {
    const tournaments = Object.fromEntries(Array.from({ length: 22 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return [`cup-${number}`, tournament(`cup-${number}`, `Cup ${number}`)];
    }));
    const tournamentStore = store(tournaments);

    const first = await get(tournamentStore, "/api/tournaments", "category=active&page=1");
    expect(first?.body).toMatchObject({ page: 1, pageSize: 20, total: 22, hasMore: true });
    expect((first?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id))
      .toEqual(Array.from({ length: 20 }, (_, index) => `cup-${String(index + 1).padStart(2, "0")}`));

    const second = await get(tournamentStore, "/api/tournaments", "category=active&page=2");
    expect(second?.body).toMatchObject({ page: 2, pageSize: 20, total: 22, hasMore: false });
    expect((second?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id))
      .toEqual(["cup-21", "cup-22"]);
  });

  it("filters non-Swiss items only on the portal alias before pagination", async () => {
    const tournamentStore = store({
      swiss: tournament("swiss", "Swiss Cup"),
      knockout: tournament("knockout", "Knockout Cup", "active", "knockout"),
    });

    const portal = await get(tournamentStore, "/api/tournaments", "category=active");
    expect(portal?.body).toMatchObject({ total: 1, hasMore: false });
    expect((portal?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id)).toEqual(["swiss"]);

    // The REAL portal hits the fork spelling (forkChallenge.ts builds /api/fork/<path>) with
    // category= — the filter keys on that dialect, not the path.
    const forkPortal = await get(tournamentStore, "/api/fork/tournaments", "category=active");
    expect(forkPortal?.body).toMatchObject({ total: 1, hasMore: false });
    expect((forkPortal?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id)).toEqual(["swiss"]);

    // The web tournaments.js dialect (status=/bare, no category) keeps seeing every format.
    const forkWeb = await get(tournamentStore, "/api/fork/tournaments", "");
    expect(forkWeb?.body).toMatchObject({ total: 2, hasMore: false });
    expect((forkWeb?.body as { tournaments: TournamentRecord[] }).tournaments.map((item) => item.id)).toEqual(["knockout", "swiss"]);
  });

  it("enriches list and detail items with rulesetPackName and non-dropped entrantCount", async () => {
    const cup = tournament("cup", "Cup");
    const active = entrant("active-entrant", cup.id);
    const dropped = entrant("dropped-entrant", cup.id, true);
    const tournamentStore = store({ [cup.id]: cup }, { [active.id]: active, [dropped.id]: dropped });

    const list = await get(tournamentStore, "/api/tournaments", "category=active");
    expect((list?.body as { tournaments: unknown[] }).tournaments[0]).toMatchObject({
      id: "cup",
      rulesetPackName: "Spike 2026",
      entrantCount: 1,
      roundCount: 5,
      currentRound: 1,
      points: { win: 3, draw: 1, loss: 0, bye: 3 },
    });

    const detail = await get(tournamentStore, "/api/tournaments/cup");
    expect((detail?.body as { tournament: unknown }).tournament).toMatchObject({
      id: "cup",
      rulesetPackName: "Spike 2026",
      entrantCount: 1,
    });
  });
});
