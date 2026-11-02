/**
 * Roster Builder league mode (registration spec 11-02, lane L7): a team built for a league season under that season's
 * team-building rules. Like Free Create, the ruleset is a marker in body.packageName, not a saved package:
 * "league:<leagueId>:<seasonId>". The server derives the package from the season's rules on every read
 * (src/leagues/leagueBuilder.ts leagueSeasonPackage), so the preview, a save and a later registration all judge the team by
 * the rules as they are now. No Node imports, so the SPA shares it.
 */
export const LEAGUE_PACKAGE_PREFIX = "league:";
/** League and season ids (src/leagues/store.ts LEAGUE_ID / SEASON_ID). */
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface LeagueBuilderRef { leagueId: string; seasonId: string }

/** The marker for a league season ("" when either id is not a valid league / season id). */
export function leaguePackageName(leagueId: string, seasonId: string): string {
  return ID.test(leagueId) && ID.test(seasonId) ? `${LEAGUE_PACKAGE_PREFIX}${leagueId}:${seasonId}` : "";
}

/** The league season a marker names, or null for anything else (tournament packages, Free Create, junk). */
export function parseLeaguePackageName(name: unknown): LeagueBuilderRef | null {
  if (typeof name !== "string" || !name.startsWith(LEAGUE_PACKAGE_PREFIX)) return null;
  const [leagueId, seasonId, ...rest] = name.slice(LEAGUE_PACKAGE_PREFIX.length).split(":");
  if (rest.length || !leagueId || !seasonId || !ID.test(leagueId) || !ID.test(seasonId)) return null;
  return { leagueId, seasonId };
}

export const isLeaguePackageName = (name: unknown): boolean => parseLeaguePackageName(name) !== null;

/** Create team on Fork is not offered in league mode: the league team is made when the organisers accept the registration. */
export const LEAGUE_FORK_NOTE = "League teams are created when the organisers accept your registration.";
