/**
 * League fixtures as tabletop recorder fixtures (fixture lobby START, spec §8): a recorder match for a league fixture
 * carries fixtureRef `league:<leagueId>:<seasonId>:<fixtureId>`. The recorder's fixture gateway (server.ts) resolves it
 * here, so createMatch checks the coaches and that the fixture is open, and an organiser's publish writes the score and
 * casualties into the league fixture (standings recompute from results). Undo retracts exactly what was recorded.
 *
 * Revision: fixture.tabletop.revision, bumped by each record / retract here (an organiser's own result entry makes the
 * fixture "played", which the recorder treats as reported by someone else).
 */
import type { FixtureView } from "../tabletop/api.js";
import { fixtureOpenForDeadline } from "./deadlines.js";
import { fixtureRedraftBlock } from "./redraftWindow.js";
import type { LeagueStore } from "./store.js";
import { fixturePlayed } from "./tourplay.js";
import type { LeagueFixture, SeasonRecord } from "./types.js";

export const LEAGUE_FIXTURE_REF = /^league:([a-z0-9][a-z0-9-]{0,63}):([a-z0-9][a-z0-9-]{0,63}):([^:\s]{1,80})$/;
export const leagueFixtureRef = (leagueId: string, seasonId: string, fixtureId: string): string => `league:${leagueId}:${seasonId}:${fixtureId}`;

function locate(store: LeagueStore, ref: string): { season: SeasonRecord; fixture: LeagueFixture; leagueName: string } | undefined {
  const m = LEAGUE_FIXTURE_REF.exec(ref);
  if (!m) return undefined;
  const league = store.league(m[1]!);
  const season = league ? store.season(league.id, m[2]!) : undefined;
  const fixture = season?.fixtures.find((f) => f.id === m[3]);
  return league && season && fixture ? { season, fixture, leagueName: league.name } : undefined;
}

export function leagueFixtureView(store: LeagueStore, ref: string, now: Date = new Date()): FixtureView | undefined {
  const at = locate(store, ref);
  if (!at) return undefined;
  const { season, fixture: f } = at;
  const played = fixturePlayed(f);
  return {
    id: ref,
    open: season.status === "active" && fixtureOpenForDeadline(f) && Boolean(f.home.coachId && f.away.coachId) && !fixtureRedraftBlock(store.seasons(season.leagueId), f, now),
    status: played ? "completed" : f.suspended ? "cancelled" : "scheduled",
    revision: f.tabletop?.revision ?? 0,
    home: { coach: f.home.coachId ?? "" },
    away: { coach: f.away.coachId ?? "" },
    round: f.round,
    ...(played ? { resultReportedAt: f.tabletop?.reportedAt ?? f.finishedAt ?? "recorded" } : {}),
    ...(f.tabletop?.opId ? { resultOpId: f.tabletop.opId } : {}),
  };
}

/** The recorder's publish: score + casualties into the league fixture. Throws on a stale revision or a played fixture. */
export function recordLeagueFixture(
  store: LeagueStore, ref: string,
  input: { opId?: string; expectedRevision: number; homeScore: number; awayScore: number; homeCasualties: number; awayCasualties: number }, at: Date,
): void {
  const found = locate(store, ref);
  if (!found) throw new Error("The league fixture no longer exists.");
  const { season, fixture: f } = found;
  if ((f.tabletop?.revision ?? 0) !== input.expectedRevision) throw new Error("The league fixture changed since the match started.");
  if (fixturePlayed(f)) throw new Error("The league fixture already has a result.");
  const blocked = fixtureRedraftBlock(store.seasons(season.leagueId), f, at);
  if (blocked) throw new Error(blocked);
  f.home.score = input.homeScore;
  f.away.score = input.awayScore;
  f.home.cas = input.homeCasualties;
  f.away.cas = input.awayCasualties;
  f.home.conceded = f.away.conceded = false;
  f.finishedAt = at.toISOString();
  delete f.deadlineOutcome;
  f.tabletop = { revision: input.expectedRevision + 1, ...(input.opId ? { opId: input.opId } : {}), reportedAt: at.toISOString() };
  season.resultsChangedAt = at.toISOString();
  store.putSeason(season);
}

/** The recorder's undo: clears the result it recorded (only that one). */
export function retractLeagueFixture(store: LeagueStore, ref: string, input: { expectedRevision: number }, at: Date): void {
  const found = locate(store, ref);
  if (!found) throw new Error("The league fixture no longer exists.");
  const { season, fixture: f } = found;
  if (!f.tabletop?.opId || f.tabletop.revision !== input.expectedRevision) throw new Error("The league fixture result was changed by someone else.");
  f.home.score = f.away.score = null;
  f.home.cas = f.away.cas = null;
  delete f.finishedAt;
  f.tabletop = { revision: f.tabletop.revision + 1 };
  season.resultsChangedAt = at.toISOString();
  store.putSeason(season);
}
