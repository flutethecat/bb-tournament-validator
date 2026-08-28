import { describe, expect, it } from "vitest";
import type { GamestateTeamResult } from "@bb/fork-ops";
import { computeElo } from "../src/coachElo.js";
import type { StoredTournamentResult } from "../src/tournamentResults.js";

function team(teamId: string, score: number): GamestateTeamResult {
  return {
    teamId,
    score,
    winnings: 0,
    penaltyScore: -1,
    conceded: false,
    casualtiesSuffered: { bh: 0, si: 0, rip: 0 },
    players: [],
  };
}

function game(gameId: string, homeScore: number, awayScore: number): StoredTournamentResult {
  return {
    gameId,
    pulledAt: `2026-08-27T00:00:${gameId.padStart(2, "0")}.000Z`,
    home: { teamId: `home-${gameId}`, teamName: "Home", coach: "Alice" },
    away: { teamId: `away-${gameId}`, teamName: "Away", coach: "BOB" },
    teams: [team(`home-${gameId}`, homeScore), team(`away-${gameId}`, awayScore)],
  };
}

describe("computeElo", () => {
  it("applies the classic equal-rating win and expected-score draw updates", () => {
    const ratings = computeElo([game("1", 1, 0), game("2", 1, 1)]);
    const expectedAfterWin = 1 / (1 + 10 ** ((1484 - 1516) / 400));
    expect(ratings.get("alice")?.rating).toBeCloseTo(1516 + 32 * (0.5 - expectedAfterWin), 10);
    expect(ratings.get("bob")?.rating).toBeCloseTo(1484 - 32 * (0.5 - expectedAfterWin), 10);
    expect(ratings.get("alice")).toMatchObject({ games: 2, provisional: true });
  });

  it("uses numeric gameId order rather than pull order and is order-dependent", () => {
    const winThenLoss = computeElo([game("2", 0, 1), game("1", 1, 0)]).get("alice")!.rating;
    const lossThenWin = computeElo([game("2", 1, 0), game("1", 0, 1)]).get("alice")!.rating;
    expect(winThenLoss).toBeLessThan(1500);
    expect(lossThenWin).toBeGreaterThan(1500);
  });

  it("clears provisional at ten games and refreshes its per-array memo when the key changes", () => {
    const results = Array.from({ length: 9 }, (_, index) => game(String(index + 1), 1, 1));
    const first = computeElo(results);
    expect(first.get("alice")).toMatchObject({ games: 9, provisional: true });
    expect(computeElo(results)).toBe(first);
    expect(computeElo([...results])).toBe(first);
    results.push(game("10", 1, 1));
    const tenth = computeElo(results);
    expect(tenth).not.toBe(first);
    expect(tenth.get("alice")).toMatchObject({ rating: 1500, games: 10, provisional: false });
  });
});
