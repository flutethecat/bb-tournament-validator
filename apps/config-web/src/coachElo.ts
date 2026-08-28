import { createHash } from "node:crypto";
import { deriveTeamResult, type StoredTournamentResult } from "./tournamentResults.js";

export interface CoachEloRating {
  rating: number;
  games: number;
  provisional: boolean;
}

const START_RATING = 1500;
const K_FACTOR = 32;
interface EloMemo {
  key: string;
  fingerprint: string;
  ratings: Map<string, CoachEloRating>;
}

const memo = new WeakMap<StoredTournamentResult[], EloMemo>();
let sharedMemo: EloMemo | undefined;

const coachKey = (coach: string): string => coach.trim().toLowerCase();

function gameOrder(left: StoredTournamentResult, right: StoredTournamentResult): number {
  const leftId = Number(left.gameId);
  const rightId = Number(right.gameId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
  return left.gameId.localeCompare(right.gameId);
}

function historyFingerprint(results: readonly StoredTournamentResult[]): string {
  const hash = createHash("sha256");
  for (const result of results) {
    hash.update(result.gameId).update("\0")
      .update(result.home.coach).update("\0").update(result.home.teamId).update("\0")
      .update(result.away.coach).update("\0").update(result.away.teamId).update("\0");
    for (const team of result.teams) {
      hash.update(team.teamId).update("\0").update(String(team.score)).update("\0")
        .update(String(team.penaltyScore)).update("\0");
    }
  }
  return hash.digest("hex");
}

/**
 * Classic Elo over all retained games. Stored results have no finished timestamp, so numeric
 * gameId is the deterministic play-order proxy; pulledAt is pull-order, not play-order.
 */
export function computeElo(results: StoredTournamentResult[]): Map<string, CoachEloRating> {
  const key = `${results.length}\0${results.at(-1)?.gameId ?? ""}`;
  const fingerprint = historyFingerprint(results);
  const cached = memo.get(results);
  if (cached?.key === key && cached.fingerprint === fingerprint) return cached.ratings;
  if (sharedMemo?.key === key && sharedMemo.fingerprint === fingerprint) {
    memo.set(results, sharedMemo);
    return sharedMemo.ratings;
  }

  const ratings = new Map<string, CoachEloRating>();
  const current = (coach: string): CoachEloRating => ratings.get(coach) ?? {
    rating: START_RATING,
    games: 0,
    provisional: true,
  };

  for (const result of [...results].sort(gameOrder)) {
    const homeCoach = coachKey(result.home.coach);
    const awayCoach = coachKey(result.away.coach);
    const homeTeam = result.teams.find((team) => team.teamId === result.home.teamId);
    const awayTeam = result.teams.find((team) => team.teamId === result.away.teamId);
    if (!homeTeam || !awayTeam) throw new Error(`Game ${result.gameId} result does not match its stored participants.`);

    const home = current(homeCoach);
    const away = current(awayCoach);
    const homeOutcome = deriveTeamResult(homeTeam, awayTeam).outcome;
    const actualHome = homeOutcome === "won" ? 1 : homeOutcome === "drawn" ? 0.5 : 0;
    const expectedHome = 1 / (1 + 10 ** ((away.rating - home.rating) / 400));
    const delta = K_FACTOR * (actualHome - expectedHome);
    const homeGames = home.games + 1;
    const awayGames = away.games + 1;
    ratings.set(homeCoach, { rating: home.rating + delta, games: homeGames, provisional: homeGames < 10 });
    ratings.set(awayCoach, { rating: away.rating - delta, games: awayGames, provisional: awayGames < 10 });
  }

  sharedMemo = { key, fingerprint, ratings };
  memo.set(results, sharedMemo);
  return ratings;
}
