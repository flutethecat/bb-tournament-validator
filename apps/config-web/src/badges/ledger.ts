/**
 * The badge ledger (badges lane, 11-04): ONE pass over the site's history that every evaluator reads. Pure reads over the
 * stores' snapshots; never writes. Recomputed from scratch each time, so a corrected or deleted result simply drops out
 * and the engine revokes what no longer holds (src/badges/engine.ts).
 *
 * What counts (the club ledger's rules, src/clubs/stats.ts): authorised competitions only, never a draft (an unpublished
 * tournament, a draft league, a ladder still in setup) and never test data. Every game is listed with two flags:
 *   forfeit  an administrative forfeit, a concession (either side), or an organiser's deadline decision
 *   admin    an organiser or admin typed or overrode the result (league resultEdit, tournament manual / result edit)
 * Evaluators count only games with neither flag (src/badges/evaluators.ts `counted`); "Unbeaten season" also looks at a
 * forfeit LOSS, which breaks it.
 *
 * Coach badges follow the coach who played each side (identity.ts gameCoach) and only an account-linked side (coachId) earns
 * one. Teams are keyed by their lineage (teamUid, the same across seasons), else by the season entry.
 *
 * Recorder detail (hat-trick, completions, fouls, half-time, weather dice) comes from the tabletop recorder's event log of
 * the match that published the result (matched by fixture ref and op id) and, for Super FUMBBL games, from the server's
 * per-player result lines. A game without detail never earns a detail achievement (and never wrongly).
 */
import { fixtureOutcome, gameCoach, playedTime } from "../leagues/identity.js";
import { isDraftLeague } from "../leagues/lifecycle.js";
import { ladderState, membersAt, rankRows, replayLadder } from "../leagues/ladder.js";
import { beltOn, titleReplay } from "../leagues/ladderTitles.js";
import type { LeagueStore } from "../leagues/store.js";
import type { FixtureSide, LeagueFixture, LeagueRecord, LeagueTeam, SeasonRecord } from "../leagues/types.js";
import { isReservedCoachName } from "../privacy/reservedNames.js";
import { calculateStandings } from "../tournaments/pairing.js";
import type { TournamentStore } from "../tournaments/store.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "../tournaments/types.js";
import type { ClubRecord } from "../clubs/types.js";

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

export interface LedgerSeasonTeam { teamId: string; teamKey: string; team: string; coachKey?: string; coach?: string; fixtures: number }
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
  leagues: Pick<LeagueStore, "list" | "competitions">;
  tournaments: Pick<TournamentStore, "snapshot">;
  clubs?: { list(): ClubRecord[] };
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
  const side = (s: "home" | "away"): GameDetail => {
    const o = s === "home" ? "away" : "home";
    return {
      maxPlayerTd: max(tally("touchdown", s)), maxPlayerCompletions: max(tally("completion", s)), successfulFouls: fouls(s), casSuffered: suffered(s),
      ...(halfKnown ? { halfTime: { for: firstHalf(s), against: firstHalf(o) } } : {}),
      ...(dice ? { weatherDice: dice } : {}),
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
  };
}

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
  const recorded = coach && rec && rec.opId && f.tabletop?.opId === rec.opId ? rec.byCoach.get(badgeCoachKey(coach)) : undefined;
  const detail = recorded ?? forkDetail(f, which);
  const casSuffered = detail?.casSuffered ?? (typeof other.cas === "number" ? other.cas : undefined);
  return {
    ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}),
    ...(teamKey ? { teamKey } : {}),
    team: raw.team, ...(raw.race ? { race: raw.race } : {}), score: raw.score ?? 0, cas: raw.cas, outcome,
    ...(detail || casSuffered !== undefined ? { detail: { ...(detail ?? {}), ...(casSuffered !== undefined ? { casSuffered } : {}) } } : {}),
  };
}

function leaguePass(league: LeagueRecord, competitions: SeasonRecord[], src: BadgeLedgerSources, out: BadgeLedger, now: Date): void {
  if (isDraftLeague(league) || league.test === true || !authorised(league)) return;
  const seasons = competitions.filter((s) => s.competition !== "ladder");
  const first = [...seasons].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))[0];
  if (first) out.firstSeason.set(league.id, first.id);
  for (const season of competitions) {
    const ladder = season.competition === "ladder";
    if (ladder && ladderState(season) === "setup") continue;
    const link = ladder
      ? `/leagues/${encodeURIComponent(league.id)}?tab=ladder&ladder=${encodeURIComponent(season.id)}`
      : `/leagues/${encodeURIComponent(league.id)}?season=${encodeURIComponent(season.id)}`;
    const fixtureCount = new Map<string, number>();
    for (const f of season.fixtures) {
      if (f.test) continue;
      if (!f.suspended) for (const s of [f.home, f.away]) if (s.teamId) fixtureCount.set(s.teamId, (fixtureCount.get(s.teamId) ?? 0) + 1);
      const outcome = fixtureOutcome(f);
      if (!outcome) continue;
      const rec = src.recorder?.get(`league:${league.id}:${season.id}:${f.id}`);
      const forfeit = Boolean(f.forfeit) || f.home.conceded || f.away.conceded || Boolean(f.deadlineOutcome) || Boolean(f.inactiveDecision && f.inactiveDecision.decision === "forfeit");
      out.games.push({
        id: `l:${league.id}:${season.id}:${f.id}`, kind: ladder || f.ladder ? "ladder" : "league", leagueId: league.id, seasonId: season.id,
        competitionName: league.name, link, at: iso(playedTime(f), iso(season.importedAt, "1970-01-01T00:00:00.000Z")),
        forfeit, admin: Boolean(f.resultEdit),
        sides: [leagueSide(league, season, f, "home", outcome.home, rec), leagueSide(league, season, f, "away", outcome.away, rec)],
      });
    }
    if (!ladder) {
      out.seasons.push({
        leagueId: league.id, seasonId: season.id, number: season.number, name: season.name, completed: season.status === "completed",
        ...(season.endedAt ? { endedAt: iso(season.endedAt, season.endedAt) } : {}), link,
        teams: season.teams.flatMap((t) => {
          const key = teamKeyOf(league.id, season.id, t, t.id);
          const coach = earningCoach(t.coachAssigned?.cleared ? undefined : t.coachId);
          return key ? [{ teamId: t.id, teamKey: key, team: t.name, ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}), fixtures: fixtureCount.get(t.id) ?? 0 }] : [];
        }),
      });
      continue;
    }
    ladderPass(league, season, competitions, link, out, now);
  }
}

function ladderPass(league: LeagueRecord, ladder: SeasonRecord, competitions: SeasonRecord[], link: string, out: BadgeLedger, now: Date): void {
  const teamOf = (id: string | undefined) => (id ? ladder.teams.find((t) => t.id === id) : undefined);
  const push = (kind: LedgerLadderEvent["kind"], teamId: string | undefined, at: string, extra: Partial<LedgerLadderEvent> = {}) => {
    const team = teamOf(teamId);
    const key = teamKeyOf(league.id, ladder.id, team, teamId);
    if (!team || !key) return;
    const coach = earningCoach(team.coachAssigned?.cleared ? undefined : team.coachId);
    out.ladder.push({ kind, leagueId: league.id, ladderId: ladder.id, teamKey: key, team: team.name, ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}), at, link, ...extra });
  };
  if (beltOn(ladder.ladder)) {
    for (const r of titleReplay(ladder, now).reigns) push("reign", r.teamId, iso(r.since, r.since), { ...(r.until ? { until: iso(r.until, r.until) } : {}), interim: r.interim });
  }
  for (const r of ladder.ladder?.rumbles ?? []) if (r.state === "finished" && r.winnerTeamId) push("rumble", r.winnerTeamId, iso(r.finishedAt ?? r.date, r.date));
  // First time each team stood at number 1 after a counted result (it must have played by then).
  const seen = new Set<string>();
  replayLadder(ladder, now, {
    competitions,
    onEvent: (e, after) => {
      if (e.kind !== "result") return;
      const top = rankRows(ladder, after, membersAt(ladder, e.at, competitions))[0];
      if (!top || seen.has(top.teamId) || (after.stats.get(top.teamId)?.played ?? 0) < 1) return;
      seen.add(top.teamId);
      push("top", top.teamId, new Date(e.at).toISOString());
    },
  });
}

// ---- tournaments --------------------------------------------------------------------------------------------------------

function tournamentPass(t: TournamentRecord, field: TournamentEntrantRecord[], matches: ScheduledMatchRecord[], src: BadgeLedgerSources, out: BadgeLedger): void {
  if (t.unpublished === true || t.test === true || !authorised(t)) return;
  const byId = new Map(field.map((e) => [e.id, e]));
  const link = `/tournaments/${encodeURIComponent(t.id)}`;
  for (const m of matches) {
    if (!m.away || !m.result) continue;
    const home = byId.get(m.home.entrantId);
    const away = byId.get(m.away.entrantId);
    if (!home || !away) continue;
    const r = m.result;
    const rec = src.recorder?.get(m.id);
    const ho: Outcome = r.homeScore > r.awayScore ? "win" : r.homeScore < r.awayScore ? "loss" : "draw";
    const side = (e: TournamentEntrantRecord, score: number, cas: number | undefined, otherCas: number | undefined, outcome: Outcome): LedgerSide => {
      const coach = earningCoach(e.coach.ffbCoachId);
      const recorded = coach && rec && rec.opId && r.opId === rec.opId ? rec.byCoach.get(badgeCoachKey(coach)) : undefined;
      const casSuffered = recorded?.casSuffered ?? otherCas;
      return {
        ...(coach ? { coachKey: badgeCoachKey(coach), coach } : {}), team: e.submission?.teamName || "Team", ...(e.submission?.race ? { race: e.submission.race } : {}),
        score, cas: typeof cas === "number" ? cas : null, outcome,
        ...(recorded || casSuffered !== undefined ? { detail: { ...(recorded ?? {}), ...(casSuffered !== undefined ? { casSuffered } : {}) } } : {}),
      };
    };
    out.games.push({
      id: `t:${t.id}:${m.id}`, kind: "tournament", tournamentId: t.id, competitionName: t.name, link, at: iso(r.reportedAt, iso(m.updatedAt, "1970-01-01T00:00:00.000Z")),
      forfeit: false, admin: r.manual === true || m.edited?.kind === "result",
      sides: [
        side(home, r.homeScore, r.homeCasualties, r.awayCasualties, ho),
        side(away, r.awayScore, r.awayCasualties, r.homeCasualties, ho === "win" ? "loss" : ho === "loss" ? "win" : "draw"),
      ],
    });
  }
  if (t.status !== "completed") return;
  let table: ReturnType<typeof calculateStandings> = [];
  try { table = calculateStandings(field.filter((e) => e.droppedAt === undefined), matches, t.points, t.tiebreakers); } catch { table = []; }
  const winner = table.find((row) => row.rank === 1);
  const e = winner ? byId.get(winner.entrantId) : undefined;
  const coach = earningCoach(e?.coach.ffbCoachId);
  if (e && coach) out.tournamentWins.push({ tournamentId: t.id, name: t.name, coachKey: badgeCoachKey(coach), coach, at: iso(t.endsAt ?? t.updatedAt, t.updatedAt), link });
}

// ---- the pass -----------------------------------------------------------------------------------------------------------

/**
 * One pass over every competition. STRICT: an unreadable store throws, so the engine never revokes awards from a partial
 * picture (fail closed).
 */
export function buildBadgeLedger(src: BadgeLedgerSources, now: Date = new Date()): BadgeLedger {
  const out: BadgeLedger = { games: [], seasons: [], ladder: [], tournamentWins: [], clubSpans: [], firstSeason: new Map() };
  const data = src.tournaments.snapshot();
  const entrantsBy = new Map<string, TournamentEntrantRecord[]>();
  for (const e of Object.values(data.entrants ?? {})) entrantsBy.set(e.tournamentId, [...(entrantsBy.get(e.tournamentId) ?? []), e]);
  const matchesBy = new Map<string, ScheduledMatchRecord[]>();
  for (const m of Object.values(data.scheduledMatches ?? {})) matchesBy.set(m.tournamentId, [...(matchesBy.get(m.tournamentId) ?? []), m]);
  for (const t of Object.values(data.tournaments ?? {})) {
    const field = (entrantsBy.get(t.id) ?? []).sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
    const matches = (matchesBy.get(t.id) ?? []).sort((a, b) => a.roundNumber - b.roundNumber || a.id.localeCompare(b.id));
    tournamentPass(t, field, matches, src, out);
  }
  for (const league of src.leagues.list()) leaguePass(league, src.leagues.competitions(league.id), src, out, now);
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
  // Deterministic order: by time, then id.
  out.games.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  out.ladder.sort((a, b) => a.at.localeCompare(b.at) || a.teamKey.localeCompare(b.teamKey));
  out.tournamentWins.sort((a, b) => a.at.localeCompare(b.at) || a.tournamentId.localeCompare(b.tournamentId));
  return out;
}
