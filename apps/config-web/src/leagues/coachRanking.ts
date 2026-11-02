/**
 * Best coach records (shared by the server's Statistics "Best coach record" card, src/leagues/stats.ts, and the SPA's
 * Honours Coach view): the best win % (draw = half a win) among coaches with at least half the games of the busiest coach
 * (one lucky game does not top the list), then more games, then more points, then name. Pure; no imports.
 */
export interface RankableCoach { coach: string; games: number; points: number; winPct: number }

export function rankCoachRecords<T extends RankableCoach>(coaches: readonly T[]): { min: number; ranked: T[] } {
  const most = coaches.reduce((m, c) => Math.max(m, c.games), 0);
  if (!most) return { min: 0, ranked: [] };
  const min = Math.max(1, Math.ceil(most / 2));
  const ranked = coaches.filter((c) => c.games >= min)
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games || b.points - a.points || a.coach.localeCompare(b.coach));
  return { min, ranked };
}
