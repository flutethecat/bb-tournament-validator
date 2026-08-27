import type {
  ScheduledMatchRecord,
  TournamentEntrantRecord,
  TournamentPoints,
  TournamentStandingRow,
  TournamentTiebreaker,
} from "./types.js";

export type StandingRow = TournamentStandingRow;

export interface SwissPairing {
  homeEntrantId: string;
  awayEntrantId?: string;
}

const activeEntrants = (entrants: readonly TournamentEntrantRecord[]): TournamentEntrantRecord[] =>
  entrants.filter((entrant) => entrant.droppedAt === undefined);

const completed = (matches: readonly ScheduledMatchRecord[]): ScheduledMatchRecord[] =>
  matches.filter((match) => match.status === "completed" && match.result !== undefined);

function compareValue(left: StandingRow, right: StandingRow, key: TournamentTiebreaker): number {
  if (key === "headToHead") return 0;
  if (key === "seed") return left.seed - right.seed;
  return right[key] - left[key];
}

function headToHead(left: StandingRow, right: StandingRow, matches: readonly ScheduledMatchRecord[]): number {
  const game = completed(matches).find((match) =>
    match.away &&
    ((match.home.entrantId === left.entrantId && match.away.entrantId === right.entrantId) ||
      (match.home.entrantId === right.entrantId && match.away.entrantId === left.entrantId)),
  );
  if (!game?.result) return 0;
  const leftScore = game.home.entrantId === left.entrantId ? game.result.homeScore : game.result.awayScore;
  const rightScore = game.home.entrantId === right.entrantId ? game.result.homeScore : game.result.awayScore;
  return rightScore - leftScore;
}

export function calculateStandings(
  entrants: readonly TournamentEntrantRecord[],
  matches: readonly ScheduledMatchRecord[],
  points: TournamentPoints,
  tiebreakers: readonly TournamentTiebreaker[],
): StandingRow[] {
  const rows = new Map<string, Omit<StandingRow, "rank">>();
  for (const entrant of activeEntrants(entrants)) {
    rows.set(entrant.id, {
      entrantId: entrant.id,
      coachId: entrant.coach.ffbCoachId,
      teamId: entrant.teamId,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      byes: 0,
      points: 0,
      touchdownsFor: 0,
      touchdownsAgainst: 0,
      touchdownDifferential: 0,
      casualtiesFor: 0,
      casualtiesAgainst: 0,
      casualtyDifferential: 0,
      buchholz: 0,
      sonnebornBerger: 0,
      opponentWinPercentage: 0,
      seed: entrant.seed,
    });
  }

  const opponents = new Map<string, string[]>();
  for (const match of completed(matches)) {
    const home = rows.get(match.home.entrantId);
    if (!home || !match.result) continue;
    if (!match.away) {
      home.played += 1;
      home.wins += 1;
      home.byes += 1;
      home.points += points.bye;
      continue;
    }
    const away = rows.get(match.away.entrantId);
    if (!away) continue;
    home.played += 1;
    away.played += 1;
    home.touchdownsFor += match.result.homeScore;
    home.touchdownsAgainst += match.result.awayScore;
    away.touchdownsFor += match.result.awayScore;
    away.touchdownsAgainst += match.result.homeScore;
    home.casualtiesFor += match.result.homeCasualties ?? 0;
    away.casualtiesFor += match.result.awayCasualties ?? 0;
    home.casualtiesAgainst += match.result.awayCasualties ?? 0;
    away.casualtiesAgainst += match.result.homeCasualties ?? 0;
    opponents.set(home.entrantId, [...(opponents.get(home.entrantId) ?? []), away.entrantId]);
    opponents.set(away.entrantId, [...(opponents.get(away.entrantId) ?? []), home.entrantId]);
    if (match.result.homeScore > match.result.awayScore) {
      home.wins += 1;
      away.losses += 1;
      home.points += points.win;
      away.points += points.loss;
    } else if (match.result.homeScore < match.result.awayScore) {
      away.wins += 1;
      home.losses += 1;
      away.points += points.win;
      home.points += points.loss;
    } else {
      home.draws += 1;
      away.draws += 1;
      home.points += points.draw;
      away.points += points.draw;
    }
  }

  for (const row of rows.values()) {
    row.touchdownDifferential = row.touchdownsFor - row.touchdownsAgainst;
    row.casualtyDifferential = row.casualtiesFor - row.casualtiesAgainst;
  }
  for (const row of rows.values()) {
    const opponentRows = (opponents.get(row.entrantId) ?? []).flatMap((id) => {
      const opponent = rows.get(id);
      return opponent ? [opponent] : [];
    });
    row.buchholz = opponentRows.reduce((sum, opponent) => sum + opponent.points, 0);
    row.opponentWinPercentage = opponentRows.length === 0
      ? 0
      : opponentRows.reduce((sum, opponent) => sum + opponent.wins / Math.max(1, opponent.played), 0) / opponentRows.length;
  }
  for (const match of completed(matches)) {
    if (!match.away || !match.result) continue;
    const home = rows.get(match.home.entrantId);
    const away = rows.get(match.away.entrantId);
    if (!home || !away) continue;
    if (match.result.homeScore > match.result.awayScore) home.sonnebornBerger += away.points;
    else if (match.result.homeScore < match.result.awayScore) away.sonnebornBerger += home.points;
    else {
      home.sonnebornBerger += away.points / 2;
      away.sonnebornBerger += home.points / 2;
    }
  }

  const ranked = [...rows.values()].sort((left, right) => {
    if (right.points !== left.points) return right.points - left.points;
    for (const key of tiebreakers) {
      const difference = key === "headToHead"
        ? headToHead(left as StandingRow, right as StandingRow, matches)
        : compareValue(left as StandingRow, right as StandingRow, key);
      if (difference !== 0) return difference;
    }
    return left.seed - right.seed || left.entrantId.localeCompare(right.entrantId);
  });
  return ranked.map((row, index) => ({ rank: index + 1, ...row }));
}

const playedKey = (left: string, right: string): string => [left, right].sort().join("\0");

/**
 * Deterministic Swiss pairing. It searches the small tournament field for the lowest total
 * score-gap/rematch cost; seed and entrant id are the stable final tie-breaks.
 */
export function generateSwissPairings(
  entrants: readonly TournamentEntrantRecord[],
  matches: readonly ScheduledMatchRecord[],
  points: TournamentPoints,
  tiebreakers: readonly TournamentTiebreaker[],
): SwissPairing[] {
  const standings = calculateStandings(entrants, matches, points, tiebreakers);
  const played = new Set<string>();
  const byeRecipients = new Set<string>();
  for (const match of completed(matches)) {
    if (match.away) played.add(playedKey(match.home.entrantId, match.away.entrantId));
    else byeRecipients.add(match.home.entrantId);
  }

  const pairings: SwissPairing[] = [];
  if (standings.length % 2 === 1) {
    const bye = [...standings].reverse().find((row) => !byeRecipients.has(row.entrantId)) ?? standings.at(-1)!;
    pairings.push({ homeEntrantId: bye.entrantId });
  }
  const byeId = pairings[0]?.awayEntrantId === undefined ? pairings[0]?.homeEntrantId : undefined;
  const pool = standings.filter((row) => row.entrantId !== byeId);

  interface SearchResult { cost: number; key: string; pairs: SwissPairing[] }
  const pairCost = (home: StandingRow, away: StandingRow): number => {
    const rematchCost = played.has(playedKey(home.entrantId, away.entrantId)) ? 1_000_000 : 0;
    const scoreCost = Math.abs(home.points - away.points) * 10_000;
    const rankCost = Math.abs(home.rank - away.rank) * 100;
    return rematchCost + scoreCost + rankCost;
  };
  if (pool.length > 16) {
    const remaining = [...pool];
    const pairs: SwissPairing[] = [];
    while (remaining.length > 0) {
      const home = remaining.shift()!;
      const candidates = remaining.map((away, index) => ({ away, index, cost: pairCost(home, away) }))
        .sort((left, right) => left.cost - right.cost || left.away.entrantId.localeCompare(right.away.entrantId));
      const selected = candidates[0]!;
      remaining.splice(selected.index, 1);
      pairs.push({ homeEntrantId: home.entrantId, awayEntrantId: selected.away.entrantId });
    }
    return [...pairings, ...pairs];
  }
  const memo = new Map<string, SearchResult>();
  const search = (remaining: StandingRow[]): SearchResult => {
    if (remaining.length === 0) return { cost: 0, key: "", pairs: [] };
    const memoKey = remaining.map((row) => row.entrantId).join("\0");
    const cached = memo.get(memoKey);
    if (cached) return cached;
    const home = remaining[0]!;
    let best: SearchResult | undefined;
    for (let index = 1; index < remaining.length; index += 1) {
      const away = remaining[index]!;
      const rest = remaining.filter((_row, candidate) => candidate !== 0 && candidate !== index);
      const tail = search(rest);
      const pair = { homeEntrantId: home.entrantId, awayEntrantId: away.entrantId };
      const key = `${home.entrantId}:${away.entrantId}|${tail.key}`;
      const candidate = { cost: pairCost(home, away) + tail.cost, key, pairs: [pair, ...tail.pairs] };
      if (!best || candidate.cost < best.cost || (candidate.cost === best.cost && candidate.key < best.key)) best = candidate;
    }
    memo.set(memoKey, best!);
    return best!;
  };

  return [...pairings, ...search(pool).pairs];
}
