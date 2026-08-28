import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableTieFlip } from "../src/tournaments/pairing.js";
import { TournamentStore } from "../src/tournaments/store.js";

const roots: string[] = [];
const now = new Date("2026-08-27T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(format: "swiss" | "knockout" = "swiss"): { store: TournamentStore; tournamentId: string } {
  const root = mkdtempSync(join(tmpdir(), "bbtv-elo-seeding-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const tournament = store.createTournament({
    name: "Seed Cup",
    packageName: "Rules",
    maxPlayers: 4,
    format,
    organizerCoachId: "Veers",
  }, now);
  for (const coach of ["Alice", "Bob", "Carol", "Dave"]) {
    store.registerEntrant(tournament.id, {
      coachId: coach,
      ffbCoachId: coach,
      verifiedAt: now.toISOString(),
    }, `team-${coach.toLowerCase()}`, now);
  }
  const snapshot = store.snapshot();
  snapshot.tournaments[tournament.id]!.status = "active";
  store.writeSnapshot(snapshot);
  return { store, tournamentId: tournament.id };
}

function seededCoaches(store: TournamentStore, tournamentId: string): string[] {
  return store.entrants(tournamentId)
    .filter((entrant) => !entrant.droppedAt)
    .map((entrant) => entrant.coach.ffbCoachId);
}

describe("Elo seed snapshot", () => {
  it("persists Elo order at round one and ignores later rating drift", () => {
    const setup = store();
    const firstRatings: Record<string, number> = { Alice: 1500, Bob: 1800, Carol: 1400, Dave: 1600 };
    const round = setup.store.generateNextRound(setup.tournamentId, now, (coach) => firstRatings[coach]);
    expect(seededCoaches(setup.store, setup.tournamentId)).toEqual(["Bob", "Dave", "Alice", "Carol"]);
    expect(JSON.stringify(setup.store.snapshot())).not.toContain('"elo"');
    expect(setup.store.matches(setup.tournamentId).map((match) => [match.home.coach.ffbCoachId, match.away?.coach.ffbCoachId]))
      .toEqual([["Bob", "Alice"], ["Dave", "Carol"]]);

    for (const matchId of round.scheduledMatchIds) {
      setup.store.recordResult(matchId, { expectedRevision: 1, homeScore: 1, awayScore: 0 }, now);
    }
    const inverted: Record<string, number> = { Alice: 2000, Bob: 1000, Carol: 1900, Dave: 1100 };
    setup.store.generateNextRound(setup.tournamentId, new Date(now.getTime() + 60_000), (coach) => inverted[coach]);
    expect(seededCoaches(setup.store, setup.tournamentId)).toEqual(["Bob", "Dave", "Alice", "Carol"]);
  });

  it("uses the tournament stable flip for tied Elo ratings", () => {
    const setup = store();
    const before = setup.store.entrants(setup.tournamentId);
    const expected = [...before]
      .sort((left, right) => stableTieFlip(setup.tournamentId, left.id, right.id))
      .map((entrant) => entrant.coach.ffbCoachId);
    setup.store.generateNextRound(setup.tournamentId, now, () => 1500);
    expect(seededCoaches(setup.store, setup.tournamentId)).toEqual(expected);
  });

  it("feeds the persisted Elo seeds into the knockout bracket", () => {
    const setup = store("knockout");
    const ratings: Record<string, number> = { Alice: 1300, Bob: 1800, Carol: 1600, Dave: 1400 };
    setup.store.generateNextRound(setup.tournamentId, now, (coach) => ratings[coach]);
    expect(seededCoaches(setup.store, setup.tournamentId)).toEqual(["Bob", "Carol", "Dave", "Alice"]);
    expect(setup.store.matches(setup.tournamentId).map((match) => [match.home.coach.ffbCoachId, match.away?.coach.ffbCoachId]))
      .toEqual([["Bob", "Alice"], ["Carol", "Dave"]]);
  });
});
