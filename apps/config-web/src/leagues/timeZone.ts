/**
 * League time zone (owner 11-02): an IANA zone name ("America/New_York") set in League settings → General and in the
 * league wizard's General step, defaulted to the organiser's browser zone when the league is created. A league without
 * one reads UTC (organisers see a "Set your league's time zone" note). Every league schedule reads it through
 * leagueTimeZone: the Weekly Digest today; the redraft Opens-at, gates and League Events can adopt it later.
 */
import type { LeagueRecord } from "./types.js";

export const DEFAULT_LEAGUE_TIME_ZONE = "UTC";

/** A zone name the runtime knows (Intl), at most 64 characters. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** The league's zone, or UTC when it has none (or a stored one the runtime no longer knows). */
export function leagueTimeZone(league: Pick<LeagueRecord, "timeZone"> | undefined): string {
  return league?.timeZone && isTimeZone(league.timeZone) ? league.timeZone : DEFAULT_LEAGUE_TIME_ZONE;
}

/** Has the organiser set a zone (false = the UTC fallback, show the note)? */
export const leagueTimeZoneSet = (league: Pick<LeagueRecord, "timeZone">): boolean => Boolean(league.timeZone && isTimeZone(league.timeZone));
