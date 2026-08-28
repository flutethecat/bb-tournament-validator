import { describe, expect, it } from "vitest";
import { calculateStandings, generateSwissPairings } from "../src/tournaments/pairing.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "../src/tournaments/types.js";

const points = { win: 3, draw: 1, loss: 0, bye: 3 };
const tiebreakers = ["sonnebornBerger", "buchholz", "touchdownDifferential", "casualtyDifferential", "seed"] as const;

function entrant(index: number): TournamentEntrantRecord {
  return {
    id: `e${index}`,
    tournamentId: "cup",
    seed: index,
    coach: { coachId: `coach-${index}`, ffbCoachId: `Coach${index}`, verifiedAt: "2026-08-26T00:00:00.000Z" },
    teamId: `team-${index}`,
    registeredAt: "2026-08-26T00:00:00.000Z",
  };
}

function completedMatch(id: string, home: number, away: number | undefined, homeScore: number, awayScore: number): ScheduledMatchRecord {
  return {
    id,
    tournamentId: "cup",
    roundId: "r1",
    roundNumber: 1,
    home: { entrantId: `e${home}`, coach: entrant(home).coach, teamId: `team-${home}` },
    ...(away === undefined ? {} : { away: { entrantId: `e${away}`, coach: entrant(away).coach, teamId: `team-${away}` } }),
    status: "completed",
    revision: 2,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
    result: { homeScore, awayScore, reportedAt: "2026-08-26T01:00:00.000Z" },
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T01:00:00.000Z",
  };
}

describe("Swiss pairing", () => {
  it("folds the seeded top half against the bottom half in an even opening round", () => {
    const entrants = [1, 2, 3, 4].map(entrant);
    expect(generateSwissPairings(entrants, [], points, tiebreakers)).toEqual([
      { homeEntrantId: "e1", awayEntrantId: "e3" },
      { homeEntrantId: "e2", awayEntrantId: "e4" },
    ]);
    expect(generateSwissPairings(entrants, [], points, tiebreakers))
      .toEqual(generateSwissPairings(entrants, [], points, tiebreakers));
  });

  it("avoids rematches even when an adjacent pairing would be cheaper", () => {
    const entrants = [1, 2, 3, 4].map(entrant);
    const prior = [completedMatch("m1", 1, 2, 1, 1), completedMatch("m2", 3, 4, 1, 1)];
    const pairs = generateSwissPairings(entrants, prior, points, tiebreakers);
    expect(pairs).toEqual([
      { homeEntrantId: "e1", awayEntrantId: "e3" },
      { homeEntrantId: "e2", awayEntrantId: "e4" },
    ]);
  });

  it("rotates a bye away from a previous recipient", () => {
    const entrants = [1, 2, 3].map(entrant);
    const first = generateSwissPairings(entrants, [], points, tiebreakers);
    expect(first[0]).toEqual({ homeEntrantId: "e3" });
    const second = generateSwissPairings(entrants, [completedMatch("bye", 3, undefined, 0, 0)], points, tiebreakers);
    expect(second.find((pair) => pair.awayEntrantId === undefined)?.homeEntrantId).toBe("e2");
  });

  it("gives the lowest seed the bye before folding an odd opening field", () => {
    expect(generateSwissPairings([1, 2, 3, 4, 5].map(entrant), [], points, tiebreakers)).toEqual([
      { homeEntrantId: "e5" },
      { homeEntrantId: "e1", awayEntrantId: "e3" },
      { homeEntrantId: "e2", awayEntrantId: "e4" },
    ]);
  });
});

describe("standings", () => {
  it("calculates points, Buchholz, score differential, and configured ordering", () => {
    const entrants = [1, 2, 3, 4].map(entrant);
    const matches = [
      completedMatch("m1", 1, 2, 2, 0),
      completedMatch("m2", 3, 4, 1, 0),
      { ...completedMatch("m3", 1, 3, 0, 1), roundNumber: 2 },
      { ...completedMatch("m4", 2, 4, 2, 0), roundNumber: 2 },
    ];
    matches[0]!.result!.homeCasualties = 3;
    matches[0]!.result!.awayCasualties = 1;
    const standings = calculateStandings(entrants, matches, points, tiebreakers);
    expect(standings.map((row) => row.entrantId)).toEqual(["e3", "e1", "e2", "e4"]);
    expect(standings.find((row) => row.entrantId === "e3")).toMatchObject({ points: 6, buchholz: 3, sonnebornBerger: 3, touchdownDifferential: 2 });
    expect(standings.find((row) => row.entrantId === "e1")).toMatchObject({
      points: 3,
      buchholz: 9,
      sonnebornBerger: 3,
      wins: 1,
      losses: 1,
      casualtiesFor: 3,
      casualtiesAgainst: 1,
      casualtyDifferential: 2,
    });
  });

  it("uses a stable pair-symmetric flip when two entrants remain fully tied", () => {
    const entrants = [entrant(1), entrant(2)];
    const ladder = ["buchholz", "touchdownDifferential", "casualtyDifferential"] as const;
    const expected = calculateStandings(entrants, [], points, ladder).map((row) => row.entrantId);

    expect(calculateStandings(entrants, [], points, ladder).map((row) => row.entrantId)).toEqual(expected);
    expect(calculateStandings([...entrants].reverse(), [], points, ladder).map((row) => row.entrantId)).toEqual(expected);
  });
});
