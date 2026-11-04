/**
 * The badge ledger (badges lane, 11-04): ONE pass over the site's history that every evaluator reads. Pure reads over the
 * stores' snapshots; never writes. Recomputed from scratch each time, so a corrected or deleted result simply drops out
 * and the engine revokes what no longer holds (src/badges/engine.ts).
 *
 * What counts (the club ledger's rules, src/clubs/stats.ts): authorised competitions only, never a draft (an unpublished
 * tournament, a draft league, a ladder still in setup) and never test data. Every game is listed with two flags:
 *   forfeit  an administrative forfeit, a concession (either side, including a recorder `concede` event or a Super
 *            FUMBBL concession), or an organiser's deadline decision
 *   admin    an organiser or admin edited or overrode an EXISTING result (league resultEdit, tournament result edit). A
 *            manager's first-time typed result counts (tabletop events are run that way; the Glicko lane's rule)
 * Evaluators count only games with neither flag (src/badges/evaluators.ts `counted`); "Unbeaten season" also looks at a
 * forfeit LOSS, which breaks it.
 *
 * Coach badges follow the coach who played each side (identity.ts gameCoach) and only an account-linked side (coachId) earns
 * one. Milestones (belt reigns, Rumbles, ladder #1) go to the coach of record AT THE TIME (the team's own game at or before
 * it, else the entry holder then), never the team's current coach. Teams are keyed by their lineage (teamUid), else by the
 * season entry. Titles and ladder ranks are replayed from counted fixtures only.
 *
 * Fail closed: the sources must be CHECKED readers (src/badges/sources.ts); any read failure throws and the pass aborts.
 *
 * Recorder detail (hat-trick, completions, fouls, half-time, weather dice) comes from the tabletop recorder's event log of
 * the match that published the result (matched by fixture ref and op id) and, for Super FUMBBL games, from the server's
 * per-player result lines. A game without detail never earns a detail achievement (and never wrongly).
 */
import { fixtureOutcome, gameCoach, playedTime } from "../leagues/identity.js";
import { isDraftLeague } from "../leagues/lifecycle.js";
import { ladderState, membersAt, rankRows, replayLadder } from "../leagues/ladder.js";
import { beltOn, titleReplay } from "../leagues/ladderTitles.js";
import type { FixtureSide, LeagueFixture, LeagueRecord, LeagueTeam, SeasonRecord } from "../leagues/types.js";
import { isReservedCoachName } from "../privacy/reservedNames.js";
import { calculateStandings } from "../tournaments/pairing.js";
import type { TournamentStore } from "../tournaments/store.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "../tournaments/types.js";
import type { ClubRecord } from "../clubs/types.js";
import { noPace, type Pacer } from "./pace.js";

export type Outcome = "win" | "draw" | "loss";

/** The coach key every badge store and route uses: NFC, trimmed, lower case (the identity store's fold). */
export const badgeCoachKey = (name: string): string => name.normalize("NFC").trim().toLowerCase();
/** A coach that may earn: a real account name (never a deleted coach's pseudonym). */
export const earningCoach = (name: string | undefined): string | undefined => {
  const n = (name ?? "").normalize("NFC").trim();
  return n && n.length <= 120 && !isReservedCoachName(n) ? n : undefined;
};

/** What the recorder (or the Super FUMBBL result) knew about one side of a game. Absent field = unknown. */
export interface GameDetail {
  /** Most touchdowns by one player. */
  maxPlayerTd?: number;
  /** Most completions by one player. */
  maxPlayerCompletions?: number;
  /** Fouls that caused a casualty. */
  successfulFouls?: number;
  /** The score at half-time (this side first). */
  halfTime?: { for: number; against: number };
  /** The kick-off weather dice. */
  weatherDice?: number[];
  /** Casualties this side suffered, as the server or the recorder counted them. */
  casSuffered?: number;
  /** The recorder (or the server) logged a concession by this side. */
  conceded?: boolean;
}

export interface LedgerSide {
  coachKey?: string;
  coach?: string;
  teamKey?: string;
  team: string;
  race?: string;
  score: number;
  cas: number | null;
  outcome: Outcome;
  detail?: GameDetail;
}

export interface LedgerGame {
  /** "l:<leagueId>:<seasonId>:<fixtureId>" or "t:<tournamentId>:<matchId>". */
  id: string;
  kind: "league" | "ladder" | "tournament";
  leagueId?: string;
  seasonId?: string;
  tournamentId?: string;
  competitionName: string;
  link: string;
  at: string;
  forfeit: boolean;
  admin: boolean;
  sides: [LedgerSide, LedgerSide];
}

export interface LedgerSeasonTeam { teamId: string; teamKey: string; team: string; fixtures: number }
export interface LedgerSeason {
  leagueId: string;
  seasonId: string;
  number: number;
  name: string;
  completed: boolean;
  endedAt?: string;
  link: string;
  teams: LedgerSeasonTeam[];
}

/** A belt reign, a Rumble win, or a team's first time at number 1 on a ladder. */
export interface LedgerLadderEvent {
  kind: "reign" | "rumble" | "top";
  leagueId: string;
  ladderId: string;
  teamKey: string;
  team: string;
  coachKey?: string;
  coach?: string;
  at: string;
  /** Reigns: when it ended (absent = still held). */
  until?: string;
  interim?: boolean;
  link: string;
}

export interface LedgerTournamentWin { tournamentId: string; name: string; coachKey: string; coach: string; at: string; link: string }
export interface LedgerClubSpan { clubId: string; club: string; coachKey: string; coach: string; joinedAt: string; leftAt?: string }

export interface BadgeLedger {
  games: LedgerGame[];
  seasons: LedgerSeason[];
  ladder: LedgerLadderEvent[];
  tournamentWins: LedgerTournamentWin[];
  clubSpans: LedgerClubSpan[];
  /** league id -> the id of its first season (lowest number; ladders left out). */
  firstSeason: Map<string, string>;
}

/** One recorder match that published a result: its op id and each coach's detail. */
export interface RecorderResult { opId?: string; byCoach: Map<string, GameDetail> }

export interface BadgeLedgerSources {
  /** A CHECKED reader (src/badges/sources.ts CheckedLeagueReader): throws on any unreadable league or season. */
  leagues: { list(): LeagueRecord[]; competitions(leagueId: string): SeasonRecord[] };
  tournaments: Pick<TournamentStore, "snapshot">;
  clubs?: { list(): ClubRecord[] };
  /** Super FUMBBL tournament results by fork game id (a concession there is a forfeit for earning). */
  tournamentResults?: { get(gameId: string): { teams?: Array<{ conceded?: boolean }> } | undefined };
  /** fixture ref ("league:<l>:<s>:<f>" or a tournament match id) -> the recorder match that published it. */
  recorder?: ReadonlyMap<string, RecorderResult>;
}

const authorised = (c: { authorised?: boolean }): boolean => c.authorised !== false;
const iso = (v: string | undefined, fallback: string): string => {
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
};

// ---- recorder detail ------------------------------------------------------------------------------------------------

interface EventLike { type: string; team?: string; player?: string; half?: unknown; payload?: Record<string, unknown> }

/** Each side's detail from a recorder match's EFFECTIVE events (undo already resolved). */
export function recorderDetail(events: readonly EventLike[]): { home: GameDetail; away: GameDetail } {
  const tally = (type: string, side: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of events) if (e.type === type && e.team === side && e.player) m.set(e.player, (m.get(e.player) ?? 0) + 1);
    return m;
  };
  const max = (m: Map<string, number>): number => Math.max(0, ...m.values());
  const tds = events.filter((e) => e.type === "touchdown");
  const halfKnown = tds.every((e) => e.half === 1 || e.half === 2 || e.half === "OT");
  const firstHalf = (side: string) => tds.filter((e) => e.team === side && e.half === 1).length;
  const weather = events.find((e) => e.type === "weather" && e.payload?.pregame === true)?.payload?.dice;
  const dice = Array.isArray(weather) && weather.every((d) => Number.isInteger(d)) ? (weather as number[]) : undefined;
  const fouls = (side: string) => events.filter((e) => e.type === "casualty" && e.team === side && e.payload?.cause === "foul").length;
  const suffered = (side: string) => events.filter((e) => e.type === "casualty" && ((e.payload?.victimTeam as string | undefined) ?? (e.team === "home" ? "away" : "home")) === side).length;
  const conceded = (side: string) => events.some((e) => e.type === "concede" && e.team === side);
  const side = (s: "home" | "away"): GameDetail => {
    const o = s === "home" ? "away" : "home";
    return {
      maxPlayerTd: max(tally("touchdown", s)), maxPlayerCompletions: max(tally("completion", s)), successfulFouls: fouls(s), casSuffered: suffered(s),
      ...(halfKnown ? { halfTime: { for: firstHalf(s), against: firstHalf(o) } } : {}),
      ...(dice ? { weatherDice: dice } : {}),
      ...(conceded(s) ? { conceded: true } : {}),
    };
  };
  return { home: side("home"), away: side("away") };
}

/** A Super FUMBBL result's per-player lines (td, completions) and the casualties the server counted as suffered. */
function forkDetail(f: LeagueFixture, side: "home" | "away"): GameDetail | undefined {
  const r = f.fork?.status === "finished" ? f.fork.result : undefined;
  const s = r?.[side];
  if (!s) return undefined;
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const cs = s.casualtiesSuffered;
  return {
    maxPlayerTd: Math.max(0, ...lines.map((l) => Number(l.td) || 0)),
    maxPlayerCompletions: Math.max(0, ...lines.map((l) => Number(l.completions) || 0)),
    casSuffered: cs ? (cs.badlyHurt || 0) + (cs.seriousInjury || 0) + (cs.rip || 0) : 0,
    ...(s.conceded ? { conceded: true } : {}),
  };
}

// ---- what counts --------------------------------------------------------------------------------------------------------

/** A league fixture the rules treat as a forfeit for earning (administrative forfeit, concession, deadline or inactive-team decision). */
export const fixtureForfeit = (f: LeagueFixture): boolean =>
  Boolean(f.forfeit) || f.home.conceded || f.away.conceded || Boolean(f.deadlineOutcome) || f.inactiveDecision?.decision === "forfeit";
/** An edit or override of an existing result (a first-time typed result is never stamped, so it counts). */
export const fixtureAdmin = (f: LeagueFixture): boolean => Boolean(f.resultEdit);

/** The recorder match that published THIS fixture's current result (same op id), else undefined. */
const recordedFor = (rec: RecorderResult | undefined, opId: string | undefined): RecorderResult | undefined => (rec && rec.opId && opId === rec.opId ? rec : undefined);
const recorderConceded = (rec: RecorderResult | undefined): boolean => Boolean(rec && [...rec.byCoach.values()].some((d) => d.conceded));

// ---- leagues ------------------------------------------------------------------------------------------------------------

const teamKeyOf = (leagueId: string, seasonId: string, team: Pick<LeagueTeam, "id" | "teamUid"> | undefined, teamId: string | undefined): string | undefined =>
  team?.teamUid ? `u:${team.teamUid}` : teamId ? `s:${leagueId}/${seasonId}/${teamId}` : undefined;

function leagueSide(league: LeagueRecord, season: SeasonRecord, f: LeagueFixture, which: "home" | "away", outcome: Outcome, rec: RecorderResult | undefined): LedgerSide {
  const raw: FixtureSide = f[which];
  const other: FixtureSide = f[which === "home" ? "away" : "home"];
  const played = gameCoach(raw);
  const coach = earningCoach(played.coachId);
  const team = season.teams.find((t) => t.id === raw.teamId);
  const teamKey = teamKeyOf(league.id, season.id, team, raw.teamId);
  const recorded = coach && rec ? rec.byCoach.get(badgeCoachKey(coach)) : undefined;
  const detail = recorded ?? forkDetail(f, which);
  const casSuffered = detail?.casSuffered ?? (typeof other.cas === "number" ? other.cas : undefined);
  return {
    ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}),
    ...(teamKey ? { teamKey } : {}),
    team: raw.team, ...(raw.race ? { race: raw.race } : {}), score: raw.score ?? 0, cas: raw.cas, outcome,
    ...(detail || casSuffered !== undefined ? { detail: { ...(detail ?? {}), ...(casSuffered !== undefined ? { casSuffered } : {}) } } : {}),
  };
}

/**
 * The coach of record for a team at time `t` (ms): the coach who played the team's latest game at or before t (records
 * follow the coach of each game), else the entry holder then (entryHistory), else the team's coach only while the entry
 * never changed hands. Never the current coach of a team that has since been taken over.
 */
export function coachOfRecord(season: SeasonRecord, teamId: string, t: number): string | undefined {
  let best: { at: number; coach?: string } | undefined;
  for (const f of season.fixtures) {
    if (f.test || !fixtureOutcome(f)) continue;
    const side = f.home.teamId === teamId ? f.home : f.away.teamId === teamId ? f.away : undefined;
    const at = Date.parse(playedTime(f) ?? "");
    if (!side || !Number.isFinite(at) || at > t) continue;
    if (!best || at >= best.at) best = { at, coach: gameCoach(side).coachId };
  }
  if (best) return earningCoach(best.coach);
  const team = season.teams.find((x) => x.id === teamId);
  if (!team) return undefined;
  const spans = (team.entryHistory ?? []) as Array<{ at?: string; coachId?: string }>;
  if (spans.length > 1) {
    let holder = spans[0];
    for (const s of spans.slice(1)) { const at = Date.parse(s.at ?? ""); if (Number.isFinite(at) && at <= t) holder = s; }
    return earningCoach(holder?.coachId);
  }
  return earningCoach(team.coachAssigned?.cleared ? undefined : team.coachId);
}

async function leaguePass(league: LeagueRecord, competitions: SeasonRecord[], src: BadgeLedgerSources, out: BadgeLedger, now: Date, pace: Pacer): Promise<void> {
  if (isDraftLeague(league) || league.test === true || !authorised(league)) return;
  const seasons = competitions.filter((s) => s.competition !== "ladder");
  const first = [...seasons].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))[0];
  if (first) out.firstSeason.set(league.id, first.id);
  for (const season of competitions) {
    await pace.tick();
    const ladder = season.competition === "ladder";
    if (ladder && ladderState(season) === "setup") continue;
    const link = ladder
      ? `/leagues/${encodeURIComponent(league.id)}?tab=ladder&ladder=${encodeURIComponent(season.id)}`
      : `/leagues/${encodeURIComponent(league.id)}?season=${encodeURIComponent(season.id)}`;
    const fixtureCount = new Map<string, number>();
    const uncounted = new Set<string>();
    for (const f of season.fixtures) {
      if (f.test) { uncounted.add(f.id); continue; }
      if (!f.suspended) for (const s of [f.home, f.away]) if (s.teamId) fixtureCount.set(s.teamId, (fixtureCount.get(s.teamId) ?? 0) + 1);
      const outcome = fixtureOutcome(f);
      if (!outcome) continue;
      const rec = recordedFor(src.recorder?.get(`league:${league.id}:${season.id}:${f.id}`), f.tabletop?.opId);
      const forfeit = fixtureForfeit(f) || recorderConceded(rec);
      const admin = fixtureAdmin(f);
      if (forfeit || admin) uncounted.add(f.id);
      out.games.push({
        id: `l:${league.id}:${season.id}:${f.id}`, kind: ladder || f.ladder ? "ladder" : "league", leagueId: league.id, seasonId: season.id,
        competitionName: league.name, link, at: iso(playedTime(f), iso(season.importedAt, "1970-01-01T00:00:00.000Z")),
        forfeit, admin,
        sides: [leagueSide(league, season, f, "home", outcome.home, rec), leagueSide(league, season, f, "away", outcome.away, rec)],
      });
    }
    if (!ladder) {
      out.seasons.push({
        leagueId: league.id, seasonId: season.id, number: season.number, name: season.name, completed: season.status === "completed",
        ...(season.endedAt ? { endedAt: iso(season.endedAt, season.endedAt) } : {}), link,
        teams: season.teams.flatMap((t) => {
          const key = teamKeyOf(league.id, season.id, t, t.id);
          return key ? [{ teamId: t.id, teamKey: key, team: t.name, fixtures: fixtureCount.get(t.id) ?? 0 }] : [];
        }),
      });
      continue;
    }
    // Titles and ranks replay from COUNTED fixtures only (no test, forfeit, concession or overridden result).
    const counted: SeasonRecord = { ...season, fixtures: season.fixtures.filter((f) => !uncounted.has(f.id)) };
    ladderPass(league, counted, competitions.map((c) => (c.id === season.id ? counted : c)), link, out, now);
  }
}

function ladderPass(league: LeagueRecord, ladder: SeasonRecord, competitions: SeasonRecord[], link: string, out: BadgeLedger, now: Date): void {
  const push = (kind: LedgerLadderEvent["kind"], teamId: string | undefined, atMs: number, coach: string | undefined, extra: Partial<LedgerLadderEvent> = {}) => {
    const team = teamId ? ladder.teams.find((t) => t.id === teamId) : undefined;
    const key = teamKeyOf(league.id, ladder.id, team, teamId);
    if (!team || !key || !Number.isFinite(atMs)) return;
    out.ladder.push({ kind, leagueId: league.id, ladderId: ladder.id, teamKey: key, team: team.name, ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}), at: new Date(atMs).toISOString(), link, ...extra });
  };
  if (beltOn(ladder.ladder)) {
    for (const r of titleReplay(ladder, now).reigns) {
      const since = Date.parse(r.since);
      push("reign", r.teamId, since, coachOfRecord(ladder, r.teamId, since), { ...(r.until ? { until: iso(r.until, r.until) } : {}), interim: r.interim });
    }
  }
  for (const r of ladder.ladder?.rumbles ?? []) {
    if (r.state !== "finished" || !r.winnerTeamId) continue;
    // The Rumble must be won on the pitch: the final's counted fixture (a bye, walkover or seed fallback never earns it).
    const final = [...(r.rounds ?? [])].reverse().flatMap((round) => round.matches).find((m) => m.winnerTeamId === r.winnerTeamId);
    const f = final?.fixtureId ? ladder.fixtures.find((x) => x.id === final.fixtureId) : undefined;
    if (!f || final?.how !== "result") continue;
    const at = Date.parse(playedTime(f) ?? r.finishedAt ?? r.date);
    push("rumble", r.winnerTeamId, at, coachOfRecord(ladder, r.winnerTeamId, at));
  }
  // First time each team stood at number 1 after a counted result (it must have played by then); the coach who played it.
  const seen = new Set<string>();
  replayLadder(ladder, now, {
    competitions,
    onEvent: (e, after) => {
      if (e.kind !== "result") return;
      const top = rankRows(ladder, after, membersAt(ladder, e.at, competitions))[0];
      if (!top || seen.has(top.teamId) || (after.stats.get(top.teamId)?.played ?? 0) < 1) return;
      seen.add(top.teamId);
      const f = e.fixtureId ? ladder.fixtures.find((x) => x.id === e.fixtureId) : undefined;
      const side = f ? (f.home.teamId === top.teamId ? f.home : f.away.teamId === top.teamId ? f.away : undefined) : undefined;
      push("top", top.teamId, e.at, side ? earningCoach(gameCoach(side).coachId) : coachOfRecord(ladder, top.teamId, e.at));
    },
  });
}

// ---- tournaments --------------------------------------------------------------------------------------------------------

function tournamentPass(t: TournamentRecord, field: TournamentEntrantRecord[], matches: ScheduledMatchRecord[], src: BadgeLedgerSources, out: BadgeLedger): void {
  if (t.unpublished === true || t.test === true || !authorised(t)) return;
  const byId = new Map(field.map((e) => [e.id, e]));
  const link = `/tournaments/${encodeURIComponent(t.id)}`;
  const uncounted = new Set<string>();
  for (const m of matches) {
    if (!m.away || !m.result) continue;
    const home = byId.get(m.home.entrantId);
    const away = byId.get(m.away.entrantId);
    if (!home || !away) continue;
    const r = m.result;
    const rec = recordedFor(src.recorder?.get(m.id), r.opId);
    const fork = m.launch?.gameId ? src.tournamentResults?.get(m.launch.gameId) : undefined;
    const forfeit = recorderConceded(rec) || Boolean(fork?.teams?.some((x) => x.conceded));
    // A manager's first-time typed result counts; an edit of an existing result does not.
    const admin = m.edited?.kind === "result";
    if (forfeit || admin) uncounted.add(m.id);
    const ho: Outcome = r.homeScore > r.awayScore ? "win" : r.homeScore < r.awayScore ? "loss" : "draw";
    const side = (e: TournamentEntrantRecord, score: number, cas: number | undefined, otherCas: number | undefined, outcome: Outcome): LedgerSide => {
      const coach = earningCoach(e.coach.ffbCoachId);
      const recorded = coach && rec ? rec.byCoach.get(badgeCoachKey(coach)) : undefined;
      const casSuffered = recorded?.casSuffered ?? otherCas;
      return {
        ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}), team: e.submission?.teamName || "Team", ...(e.submission?.race ? { race: e.submission.race } : {}),
        score, cas: typeof cas === "number" ? cas : null, outcome,
        ...(recorded || casSuffered !== undefined ? { detail: { ...(recorded ?? {}), ...(casSuffered !== undefined ? { casSuffered } : {}) } } : {}),
      };
    };
    out.games.push({
      id: `t:${t.id}:${m.id}`, kind: "tournament", tournamentId: t.id, competitionName: t.name, link, at: iso(r.reportedAt, iso(m.updatedAt, "1970-01-01T00:00:00.000Z")),
      forfeit, admin,
      sides: [
        side(home, r.homeScore, r.homeCasualties, r.awayCasualties, ho),
        side(away, r.awayScore, r.awayCasualties, r.homeCasualties, ho === "win" ? "loss" : ho === "loss" ? "win" : "draw"),
      ],
    });
  }
  if (t.status !== "completed") return;
  // The winner by the tournament's own standings over COUNTED results only (no forfeit, concession or edited result).
  let table: ReturnType<typeof calculateStandings> = [];
  try { table = calculateStandings(field.filter((e) => e.droppedAt === undefined), matches.filter((m) => !uncounted.has(m.id)), t.points, t.tiebreakers); } catch { table = []; }
  const winner = table.find((row) => row.rank === 1 && row.played - (row.byes ?? 0) >= 1); // never a winner who played no counted game
  const e = winner ? byId.get(winner.entrantId) : undefined;
  const coach = earningCoach(e?.coach.ffbCoachId);
  if (e && coach) out.tournamentWins.push({ tournamentId: t.id, name: t.name, coachKey: badgeCoachKey(coach), coach, at: iso(t.endsAt ?? t.updatedAt, t.updatedAt), link });
}

// ---- the pass -----------------------------------------------------------------------------------------------------------

/**
 * One pass over every competition, yielding to the event loop between slices (`pace`). STRICT: an unreadable store throws,
 * so the engine never revokes awards from a partial picture (fail closed).
 */
export async function buildBadgeLedger(src: BadgeLedgerSources, now: Date = new Date(), pace: Pacer = noPace): Promise<BadgeLedger> {
  const out: BadgeLedger = { games: [], seasons: [], ladder: [], tournamentWins: [], clubSpans: [], firstSeason: new Map() };
  const data = src.tournaments.snapshot();
  const entrantsBy = new Map<string, TournamentEntrantRecord[]>();
  for (const e of Object.values(data.entrants ?? {})) entrantsBy.set(e.tournamentId, [...(entrantsBy.get(e.tournamentId) ?? []), e]);
  const matchesBy = new Map<string, ScheduledMatchRecord[]>();
  for (const m of Object.values(data.scheduledMatches ?? {})) matchesBy.set(m.tournamentId, [...(matchesBy.get(m.tournamentId) ?? []), m]);
  for (const t of Object.values(data.tournaments ?? {})) {
    await pace.tick();
    const field = (entrantsBy.get(t.id) ?? []).sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
    const matches = (matchesBy.get(t.id) ?? []).sort((a, b) => a.roundNumber - b.roundNumber || a.id.localeCompare(b.id));
    tournamentPass(t, field, matches, src, out);
  }
  for (const league of src.leagues.list()) await leaguePass(league, src.leagues.competitions(league.id), src, out, now, pace);
  for (const club of src.clubs?.list() ?? []) {
    for (const m of club.members) {
      const coach = earningCoach(m.coach);
      if (coach) out.clubSpans.push({ clubId: club.id, club: club.name, coachKey: badgeCoachKey(coach), coach, joinedAt: m.joinedAt });
    }
    for (const f of club.former) {
      const coach = earningCoach(f.coach);
      if (coach && f.joinedAt) out.clubSpans.push({ clubId: club.id, club: club.name, coachKey: badgeCoachKey(coach), coach, joinedAt: f.joinedAt, ...(f.leftAt ? { leftAt: f.leftAt } : {}) });
    }
  }
  await pace.tick();
  // Deterministic order: by time, then id.
  out.games.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  out.ladder.sort((a, b) => a.at.localeCompare(b.at) || a.teamKey.localeCompare(b.teamKey));
  out.tournamentWins.sort((a, b) => a.at.localeCompare(b.at) || a.tournamentId.localeCompare(b.tournamentId));
  return out;
}
