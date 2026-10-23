/**
 * League standings over the results store: fork rows and PUBLISHED tabletop rows together (the store's list()
 * already drops unpublished tabletop rows). A game belongs to a league when its fork tournament-match metadata
 * names that package, or - for tabletop rows - when the match carried that `league` (defaulting to the fixture's
 * tournament package). Points default to 3/1/0; a league's own scheme from the tournaments store overrides it.
 */

import { aggregateStandings, type StandingsRow, type StoredTournamentResult } from "../tournamentResults.js";
import type { TournamentMatchMetadata } from "../tournamentMatch.js";

export interface LeaguePoints { win: number; draw: number; loss: number }
export const DEFAULT_LEAGUE_POINTS: LeaguePoints = { win: 3, draw: 1, loss: 0 };

export interface LeagueStandingsRow extends StandingsRow { points: number }

export function leagueStandings(
  results: readonly StoredTournamentResult[],
  league: string,
  forkMetadata: (gameId: string) => TournamentMatchMetadata | undefined,
  points: LeaguePoints = DEFAULT_LEAGUE_POINTS,
): LeagueStandingsRow[] {
  const byId = new Map(results.map((r) => [r.gameId, r] as const));
  const metadata = (gameId: string): TournamentMatchMetadata | undefined => {
    const row = byId.get(gameId);
    if (row?.source !== "tabletop") return forkMetadata(gameId);
    if (!row.league) return undefined;
    const side = (s: StoredTournamentResult["home"]) => ({ ffbCoachId: s.coach, teamId: s.teamId, instructions: { treasury: 0, inducements: [] } });
    return { gameId, packageName: row.league, home: side(row.home), away: side(row.away), createdAt: row.pulledAt };
  };
  return aggregateStandings(results, metadata, { packageName: league })
    .map((r) => ({ ...r, points: r.won * points.win + r.drawn * points.draw + r.lost * points.loss }))
    .sort((a, b) => b.points - a.points || b.tdDiff - a.tdDiff || b.casDiff - a.casDiff || a.coach.localeCompare(b.coach));
}
