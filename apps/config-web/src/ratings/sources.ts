// The games the site ratings count (owner round 2, 11-04): league seasons, ladders, tournaments and Super FUMBBL games.
// Read from the stores as they stand, every time: a corrected, cleared or deleted result is simply what the store says
// now, so the ratings follow it (computeSiteRatings replays everything; nothing is applied incrementally).
//
// Idempotency: each game has ONE stable key, the record it lives in (league:<league>:<season>:<fixture>,
// tournament:<tournament>:<match>, fork:<gameId>). Editing a fixture, a TourPlay re-import (the merge keeps fixture ids)
// or a re-sync rewrites the same record, never a second one. A Super FUMBBL game played for a league or tournament fixture
// counts through that fixture only: every fork game id a fixture claims (in ANY league or tournament, also drafts and
// tests, so a draft's games never leak through the results store) is left out of the fork source.
//
// Never counted: forfeits, deadline decisions, organiser/admin overrides, unbacked concessions (rules.ts); test rows;
// draft, test or demo-seeded leagues; unpublished or test tournaments; casual match-recorder games (they are not one of
// the four sources); NAF games; a league side without a linked coach account (law 23b: only test or imported data).

import { normalizeFfbCoachId } from "../auth/identitiesStore.js";
import { gameCoach, playedTime } from "../leagues/identity.js";
import { resultTime } from "../leagues/ladder.js";
import type { LeagueRecord, SeasonRecord } from "../leagues/types.js";
import { deriveTeamResult, type StoredTournamentResult } from "../tournamentResults.js";
import type { ScheduledMatchRecord, TournamentDataFileV4 } from "../tournaments/types.js";
import type { RatedGame } from "./glicko.js";
import { leagueFixtureVerdict, tournamentMatchVerdict } from "./rules.js";

export interface LeagueSource { league: LeagueRecord; competitions: readonly SeasonRecord[] }

const key = (coach: string | undefined): string => (coach ? normalizeFfbCoachId(coach) : "");
const ms = (v: string | undefined): number => (v ? Date.parse(v) : Number.NaN);
const firstTime = (...values: Array<string | undefined>): number => {
  for (const v of values) { const t = ms(v); if (Number.isFinite(t)) return t; }
  return Number.NaN;
};

/** A league whose games may count: published, not a test, not demo data. */
export const leagueRated = (l: LeagueRecord): boolean => l.visibility !== "draft" && !l.test && !l.seededBy;

/** Fork game ids a league fixture claims (scheduled, played or held), whatever the league, plus every id the season ever
 *  claimed (SeasonRecord.forkClaims: a TourPlay correction detaching the fork state, a reset or a deleted fixture never
 *  frees a game to count a second time). */
export function leagueClaims(sources: readonly LeagueSource[], into = new Set<string>()): Set<string> {
  for (const { competitions } of sources) for (const s of competitions) {
    for (const id of s.forkClaims ?? []) into.add(id);
    for (const f of s.fixtures ?? []) {
      for (const id of [f.fork?.result?.gameId, f.fork?.gameId, f.fork?.redraftHold?.gameId]) if (id) into.add(id);
    }
  }
  return into;
}

export function leagueGames(sources: readonly LeagueSource[]): RatedGame[] {
  const out: RatedGame[] = [];
  for (const { league, competitions } of sources) {
    if (!leagueRated(league)) continue;
    for (const s of competitions) {
      const ladder = s.competition === "ladder";
      for (const f of s.fixtures ?? []) {
        const v = leagueFixtureVerdict(f);
        if (!v.counts) continue;
        const home = gameCoach(f.home);
        const away = gameCoach(f.away);
        if (!home.coachId || !away.coachId) continue;
        const at = ladder ? resultTime(s, f) : firstTime(playedTime(f), s.startedAt, s.importedAt);
        out.push({
          key: `league:${league.id}:${s.id}:${f.id}`, source: ladder ? "ladder" : "league", at,
          home: { coach: key(home.coachId), ...(f.home.race ? { race: f.home.race } : {}) },
          away: { coach: key(away.coachId), ...(f.away.race ? { race: f.away.race } : {}) },
          homeScore: v.homeScore,
        });
      }
    }
  }
  return out;
}

/** Fork game ids a tournament fixture launched. */
export function tournamentClaims(data: TournamentDataFileV4, into = new Set<string>()): Set<string> {
  for (const m of Object.values(data.scheduledMatches ?? {})) if (m.launch?.gameId) into.add(m.launch.gameId);
  return into;
}

/** When a tournament fixture was played, for the ratings: its agreed time, else when its result was FIRST reported
 *  (firstReportedAt, kept across clears and re-reports), else (legacy rows with neither) when it was drawn. */
export const tournamentGameTime = (m: Pick<ScheduledMatchRecord, "scheduledTime" | "firstReportedAt" | "createdAt" | "result">): number =>
  firstTime(m.scheduledTime?.start, m.firstReportedAt, m.createdAt, m.result?.reportedAt);

export function tournamentGames(data: TournamentDataFileV4): RatedGame[] {
  const out: RatedGame[] = [];
  const entrants = { ...(data.heldEntrants ?? {}), ...data.entrants };
  for (const m of Object.values(data.scheduledMatches ?? {})) {
    const t = data.tournaments[m.tournamentId];
    if (!t || t.test || t.unpublished || t.status === "draft") continue;
    const v = tournamentMatchVerdict(m);
    if (!v.counts || !m.away) continue;
    const coachOf = (s: NonNullable<typeof m.away>): string => key(s.coach?.ffbCoachId || s.coach?.coachId);
    const raceOf = (s: NonNullable<typeof m.away>): string | undefined => entrants[s.entrantId]?.submission?.race || undefined;
    const homeRace = raceOf(m.home);
    const awayRace = raceOf(m.away);
    out.push({
      // A stable game time that a clear and re-report never moves (reportedAt does): the agreed time, else the first report.
      // The reset cutoff and the rating period stay put however often a manager corrects the result.
      key: `tournament:${m.tournamentId}:${m.id}`, source: "tournament", at: tournamentGameTime(m),
      home: { coach: coachOf(m.home), ...(homeRace ? { race: homeRace } : {}) },
      away: { coach: coachOf(m.away), ...(awayRace ? { race: awayRace } : {}) },
      homeScore: v.homeScore,
    });
  }
  return out;
}

/**
 * Super FUMBBL games from the results store (its list(): test rows already left out) that no fixture claims. Match
 * recorder and NAF rows are not fork games. `raceOf` names a fork team's race (the team library), when known.
 */
export function forkGames(results: readonly StoredTournamentResult[], claimed: ReadonlySet<string>, raceOf: (teamId: string) => string | undefined = () => undefined): RatedGame[] {
  const out: RatedGame[] = [];
  for (const r of results) {
    if ((r.source !== undefined && r.source !== "fork") || r.test === true || claimed.has(r.gameId)) continue;
    const homeTeam = r.teams.find((t) => t.teamId === r.home.teamId);
    const awayTeam = r.teams.find((t) => t.teamId === r.away.teamId);
    if (!homeTeam || !awayTeam) continue;
    const outcome = deriveTeamResult(homeTeam, awayTeam).outcome;
    const homeRace = raceOf(r.home.teamId);
    const awayRace = raceOf(r.away.teamId);
    out.push({
      key: `fork:${r.gameId}`, source: "fork", at: firstTime(r.playedAt, r.pulledAt),
      home: { coach: key(r.home.coach), ...(homeRace ? { race: homeRace } : {}) },
      away: { coach: key(r.away.coach), ...(awayRace ? { race: awayRace } : {}) },
      homeScore: outcome === "won" ? 1 : outcome === "drawn" ? 0.5 : 0,
    });
  }
  return out;
}

/** Every rated game from the four sources. */
export function collectRatedGames(input: {
  leagues: readonly LeagueSource[];
  tournaments: TournamentDataFileV4;
  results: readonly StoredTournamentResult[];
  forkRace?: (teamId: string) => string | undefined;
}): RatedGame[] {
  const claimed = tournamentClaims(input.tournaments, leagueClaims(input.leagues));
  return [...leagueGames(input.leagues), ...tournamentGames(input.tournaments), ...forkGames(input.results, claimed, input.forkRace)];
}
