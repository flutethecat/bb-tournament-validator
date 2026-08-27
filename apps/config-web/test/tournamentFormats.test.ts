import { describe, expect, it } from "vitest";
import { generateKnockoutPairings, generateRoundRobinPairings } from "../src/tournaments/pairing.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "../src/tournaments/types.js";

const points = { win: 3, draw: 1, loss: 0, bye: 3 };
const tiebreakers = ["seed"] as const;

function entrant(seed: number): TournamentEntrantRecord {
  return {
    id: `e${seed}`, tournamentId: "cup", seed,
    coach: { coachId: `coach-${seed}`, ffbCoachId: `Coach${seed}`, verifiedAt: "2026-08-27T00:00:00.000Z" },
    teamId: `team-${seed}`, registeredAt: "2026-08-27T00:00:00.000Z",
  };
}

function resultMatch(id: string, roundNumber: number, home: number, away: number | undefined, homeScore = 1, awayScore = 0): ScheduledMatchRecord {
  return {
    id, tournamentId: "cup", roundId: `r${roundNumber}`, roundNumber,
    home: { entrantId: `e${home}`, coach: entrant(home).coach, teamId: `team-${home}` },
    ...(away === undefined ? {} : { away: { entrantId: `e${away}`, coach: entrant(away).coach, teamId: `team-${away}` } }),
    status: "completed", revision: 2,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
    result: { homeScore, awayScore, reportedAt: "2026-08-27T01:00:00.000Z" },
    createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T01:00:00.000Z",
  };
}

function playedPairs(rounds: ReturnType<typeof generateRoundRobinPairings>[]): string[] {
  return rounds.flatMap((round) => round.flatMap((pair) => pair.awayEntrantId
    ? [[pair.homeEntrantId, pair.awayEntrantId].sort().join("-")]
    : []));
}

describe("round-robin pairing", () => {
  it("schedules every pair exactly once for an even field", () => {
    const entrants = [1, 2, 3, 4].map(entrant);
    const rounds = [1, 2, 3].map((round) => generateRoundRobinPairings(entrants, round));
    expect(rounds.every((round) => round.length === 2 && round.every((pair) => pair.awayEntrantId))).toBe(true);
    const pairs = playedPairs(rounds);
    expect(pairs).toHaveLength(6);
    expect(new Set(pairs).size).toBe(6);
  });

  it("schedules every pair once and one rotating bye per round for an odd field", () => {
    const entrants = [1, 2, 3, 4, 5].map(entrant);
    const rounds = [1, 2, 3, 4, 5].map((round) => generateRoundRobinPairings(entrants, round));
    expect(rounds.every((round) => round.length === 3 && round.filter((pair) => !pair.awayEntrantId).length === 1)).toBe(true);
    const pairs = playedPairs(rounds);
    expect(pairs).toHaveLength(10);
    expect(new Set(pairs).size).toBe(10);
    const byes = rounds.map((round) => round.find((pair) => !pair.awayEntrantId)?.homeEntrantId);
    expect(new Set(byes).size).toBe(5);
  });
});

describe("knockout pairing", () => {
  it("seeds a power-of-two bracket and advances prior-round winners", () => {
    const entrants = [1, 2, 3, 4].map(entrant);
    expect(generateKnockoutPairings(entrants, [], 1, points, tiebreakers)).toEqual([
      { homeEntrantId: "e1", awayEntrantId: "e4" },
      { homeEntrantId: "e2", awayEntrantId: "e3" },
    ]);
    const prior = [resultMatch("m1", 1, 1, 4), resultMatch("m2", 1, 2, 3, 0, 2)];
    expect(generateKnockoutPairings(entrants, prior, 2, points, tiebreakers)).toEqual([
      { homeEntrantId: "e1", awayEntrantId: "e3" },
    ]);
  });

  it("gives first-round byes to the top seeds for a non-power-of-two field", () => {
    const entrants = [1, 2, 3, 4, 5, 6].map(entrant);
    const first = generateKnockoutPairings(entrants, [], 1, points, tiebreakers);
    expect(first).toEqual([
      { homeEntrantId: "e1" },
      { homeEntrantId: "e4", awayEntrantId: "e5" },
      { homeEntrantId: "e2" },
      { homeEntrantId: "e3", awayEntrantId: "e6" },
    ]);
    expect(first.filter((pair) => !pair.awayEntrantId).map((pair) => pair.homeEntrantId).sort()).toEqual(["e1", "e2"]);
  });
});
