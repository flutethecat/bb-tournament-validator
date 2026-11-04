// The QR check-in scan page's URL handling (Sol P3): once the page holds the token in memory, the address bar and the
// browser history entry are replaced with the token-free /app/tournaments/<id>/check-in (a refresh there asks for a new scan).

export const tokenFreeCheckInPath = (tournamentId: string): string => `/tournaments/${encodeURIComponent(tournamentId)}/check-in`;

interface HistoryLike { state: unknown; replaceState(state: unknown, unused: string, url: string): void }

/** Replace the current history entry's URL (and the router's own record of it) with the token-free path. */
export function scrubCheckInToken(history: HistoryLike, tournamentId: string, base = "/app"): void {
  const clean = tokenFreeCheckInPath(tournamentId);
  const st = history.state;
  const next = st && typeof st === "object" ? { ...(st as Record<string, unknown>), current: clean } : st;
  try { history.replaceState(next, "", `${base}${clean}`); } catch { /* best effort */ }
}
