// Club stats (creation wizards v2 Q15 + round 3; spec-league-ladder Q9): club Results, Stats and Members computed from the
// site's own games only, attributing each game to the club the coach represented IN THAT COMPETITION (the club pick at
// join: a tournament entrant's clubId, a league season / ladder registration row's clubId; none = no club).
//
// What counts:
//   - authorised competitions only (league.authorised / tournament.authorised; absent = authorised, owner round 3);
//   - never a draft (an unpublished tournament, a draft league, a ladder still in setup) and never test data (a test
//     tournament or league, a test fixture);
//   - league ladder games only for a club whose `ladderGamesCount` setting is on (default off);
//   - league games follow the coach who played them (identity.ts gameCoach: the playedBy stamp), never the team's current
//     coach, so a takeover never moves a game to another club;
//   - history stays: a coach who left the club keeps the games they played for it (the competitions hold the pick).
//
// Pure reads over the stores' snapshots (no writes): server.ts calls it for the club page and the club observer.

import { fixtureOutcome, gameCoach, playedTime } from "../leagues/identity.js";
import { isDraftLeague } from "../leagues/lifecycle.js";
import { ladderState } from "../leagues/ladder.js";
import type { LeagueStore } from "../leagues/store.js";
import type { FixtureSide, LeagueFixture, LeagueRecord, SeasonRecord } from "../leagues/types.js";
import { calculateStandings } from "../tournaments/pairing.js";
import type { TournamentStore } from "../tournaments/store.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "../tournaments/types.js";
import { everAccepted } from "./pick.js";
import { clubCoachKey, type ClubRecord } from "./types.js";

export type ClubGameKind = "tournament" | "league" | "ladder";
export type ClubOutcome = "win" | "draw" | "loss";

export interface ClubGameSide {
  coach: string;
  team: string;
  race?: string;
  clubId?: string;
}

/** One game a member played for a club (one row per member side: a game between two clubmates is two rows). */
export interface ClubGame {
  /** Stable id: "t:<tournamentId>:<matchId>:<side>" or "l:<leagueId>:<seasonId>:<fixtureId>:<side>". */
  id: string;
  clubId: string;
  kind: ClubGameKind;
  competitionId: string;
  competitionName: string;
  /** League season or ladder name. */
  seasonName?: string;
  /** SPA path (without /app). */
  link: string;
  round?: string;
  /** When it was played (ISO), when known. */
  at?: string;
  member: ClubGameSide;
  opponent: ClubGameSide;
  score: { for: number; against: number };
  cas: { for: number; against: number };
  result: ClubOutcome;
  /** False for an organiser-entered or -edited result (never announced, owner round 3; still a record). */
  recorded: boolean;
  /** The competition is a test or the game was played in a test session (never counted; kept off the list). */
}

/** A podium place (tournaments) or a league title. */
export interface ClubHonour {
  id: string;
  clubId: string;
  kind: "podium" | "title";
  competitionId: string;
  competitionName: string;
  seasonName?: string;
  link: string;
  coach: string;
  team?: string;
  place: 1 | 2 | 3;
  at?: string;
}

export interface ClubRecordLine {
  coach: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
}

export interface ClubStats {
  totals: ClubRecordLine & { competitions: number; titles: number; podiums: number; coaches: number };
  members: Array<ClubRecordLine & { role: "admin" | "member"; joinedAt: string }>;
  former: Array<ClubRecordLine & { leftAt?: string }>;
  leaders: Array<{ key: "wins" | "touchdowns" | "casualties" | "winRate" | "games"; label: string; coach: string; value: number; display: string }>;
  results: ClubGame[];
  honours: ClubHonour[];
  /** Ladder games are left out (the club setting is off) - so the page can say so. */
  ladderExcluded: boolean;
}

export interface ClubStatsSources {
  tournaments: Pick<TournamentStore, "snapshot">;
  leagues: Pick<LeagueStore, "list" | "competitions">;
}

/** Everything every club has, from one pass over the competitions. */
export interface ClubLedger {
  games: Map<string, ClubGame[]>;
  honours: Map<string, ClubHonour[]>;
  /** Clubs any competition entry names (history: a club with picks is archived, never deleted). */
  picked: Set<string>;
}

const authorised = (c: { authorised?: boolean }): boolean => c.authorised !== false;

function outcomeOf(a: number, b: number): ClubOutcome {
  return a > b ? "win" : a < b ? "loss" : "draw";
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

// ---- tournaments --------------------------------------------------------------------------------------------------------

function tournamentPass(t: TournamentRecord, field: TournamentEntrantRecord[], held: TournamentEntrantRecord[], matches: ScheduledMatchRecord[], out: ClubLedger): void {
  const entrants = [...field, ...held];
  for (const e of entrants) if (e.clubId) out.picked.add(e.clubId);
  if (t.unpublished === true || t.test === true || !authorised(t)) return;
  const byId = new Map(entrants.map((e) => [e.id, e]));
  const side = (id: string): ClubGameSide | undefined => {
    const e = byId.get(id);
    if (!e) return undefined;
    return {
      coach: e.coach.ffbCoachId,
      team: e.submission?.teamName || e.teamId || "Team",
      ...(e.submission?.race ? { race: e.submission.race } : {}),
      ...(e.clubId ? { clubId: e.clubId } : {}),
    };
  };
  const link = `/tournaments/${encodeURIComponent(t.id)}`;
  for (const m of matches) {
    if (!m.away || !m.result) continue;
    const home = side(m.home.entrantId);
    const away = side(m.away.entrantId);
    if (!home || !away) continue;
    const r = m.result;
    const recorded = r.manual !== true && m.edited?.kind !== "result";
    const at = r.reportedAt;
    for (const [me, them, f, a, cf, ca, tag] of [
      [home, away, r.homeScore, r.awayScore, r.homeCasualties ?? 0, r.awayCasualties ?? 0, "home"],
      [away, home, r.awayScore, r.homeScore, r.awayCasualties ?? 0, r.homeCasualties ?? 0, "away"],
    ] as const) {
      if (!me.clubId) continue;
      pushTo(out.games, me.clubId, {
        id: `t:${t.id}:${m.id}:${tag}`, clubId: me.clubId, kind: "tournament", competitionId: t.id, competitionName: t.name, link,
        round: `Round ${m.roundNumber}`, ...(at ? { at } : {}), member: me, opponent: them,
        score: { for: f, against: a }, cas: { for: cf, against: ca }, result: outcomeOf(f, a), recorded,
      });
    }
  }
  // Podiums: a finished tournament's top three (its own standings engine), for entrants who represented a club.
  if (t.status !== "completed") return;
  let table: ReturnType<typeof calculateStandings> = [];
  try { table = calculateStandings(field.filter((e) => e.droppedAt === undefined), matches, t.points, t.tiebreakers); } catch { table = []; }
  for (const row of table) {
    if (row.rank < 1 || row.rank > 3) continue;
    const e = byId.get(row.entrantId);
    if (!e?.clubId) continue;
    pushTo(out.honours, e.clubId, {
      id: `podium:${t.id}:${e.id}`, clubId: e.clubId, kind: "podium", competitionId: t.id, competitionName: t.name, link,
      coach: e.coach.ffbCoachId, ...(e.submission?.teamName ? { team: e.submission.teamName } : {}), place: row.rank as 1 | 2 | 3,
      ...(t.endsAt || t.updatedAt ? { at: t.endsAt ?? t.updatedAt } : {}),
    });
  }
}

// ---- leagues ------------------------------------------------------------------------------------------------------------

/** The coach keys and their club picks in one season or ladder (rows that were ever accepted and carry a club). */
function seasonPicks(season: SeasonRecord): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of season.registrations ?? []) {
    if (!r.clubId || !everAccepted(r.state, r.registrationLog)) continue;
    out.set(clubCoachKey(r.coach), r.clubId);
  }
  return out;
}

const sideCoachKey = (s: ReturnType<typeof gameCoach>): string => clubCoachKey(s.coachId || s.coach || "");

function leaguePass(league: LeagueRecord, seasons: SeasonRecord[], out: ClubLedger): void {
  for (const s of seasons) for (const r of s.registrations ?? []) if (r.clubId) out.picked.add(r.clubId);
  if (isDraftLeague(league) || league.test === true || !authorised(league)) return;
  for (const season of seasons) {
    const ladder = season.competition === "ladder";
    if (ladder && ladderState(season) === "setup") continue;
    const picks = seasonPicks(season);
    if (!picks.size) continue;
    const link = ladder
      ? `/leagues/${encodeURIComponent(league.id)}?tab=ladder&ladder=${encodeURIComponent(season.id)}`
      : `/leagues/${encodeURIComponent(league.id)}?season=${encodeURIComponent(season.id)}`;
    for (const f of season.fixtures) gamePass(league, season, f, picks, link, ladder || Boolean(f.ladder), out);
    // League title: a finished season's crowned champion, for a coach who represented a club in it.
    if (ladder || season.status !== "completed") continue;
    const ref = season.podium?.final?.champion;
    if (!ref) continue;
    const team = ref.startsWith("name:")
      ? season.teams.find((t) => t.name === ref.slice(5))
      : season.teams.find((t) => t.id === ref);
    if (!team) continue;
    const clubId = picks.get(clubCoachKey(team.coachId || team.coach));
    if (!clubId) continue;
    pushTo(out.honours, clubId, {
      id: `title:${league.id}:${season.id}`, clubId, kind: "title", competitionId: league.id, competitionName: league.name, seasonName: season.name,
      link, coach: team.coachId || team.coach, team: team.name, place: 1, ...(season.endedAt ? { at: season.endedAt } : {}),
    });
  }
}

function gamePass(league: LeagueRecord, season: SeasonRecord, f: LeagueFixture, picks: Map<string, string>, link: string, ladderGame: boolean, out: ClubLedger): void {
  if (f.test) return;
  const outcome = fixtureOutcome(f);
  if (!outcome) return;
  const home = gameCoach(f.home);
  const away = gameCoach(f.away);
  const homeClub = picks.get(sideCoachKey(home));
  const awayClub = picks.get(sideCoachKey(away));
  if (!homeClub && !awayClub) return;
  const at = playedTime(f);
  const view = (s: ReturnType<typeof gameCoach>, raw: FixtureSide, clubId: string | undefined): ClubGameSide => ({
    coach: s.coachAssigned && s.coachId ? s.coachId : s.coachId || s.coach, team: raw.team, ...(raw.race ? { race: raw.race } : {}), ...(clubId ? { clubId } : {}),
  });
  const hv = view(home, f.home, homeClub);
  const av = view(away, f.away, awayClub);
  const recorded = !f.resultEdit;
  const round = [f.phase && f.phase !== "Regular" ? f.phase : "", `Round ${f.round}`].filter(Boolean).join(", ");
  for (const [me, them, sideOutcome, mine, theirs, tag] of [
    [hv, av, outcome.home, f.home, f.away, "home"],
    [av, hv, outcome.away, f.away, f.home, "away"],
  ] as const) {
    if (!me.clubId) continue;
    pushTo(out.games, me.clubId, {
      id: `l:${league.id}:${season.id}:${f.id}:${tag}`, clubId: me.clubId, kind: ladderGame ? "ladder" : "league",
      competitionId: league.id, competitionName: league.name, seasonName: season.name, link, round, ...(at ? { at } : {}),
      member: me, opponent: them, score: { for: mine.score ?? 0, against: theirs.score ?? 0 }, cas: { for: mine.cas ?? 0, against: theirs.cas ?? 0 },
      result: sideOutcome, recorded,
    });
  }
}

/** One pass over every competition. Unreadable sources count as empty (the page shows what it can). */
export function clubLedger(src: ClubStatsSources, log?: (line: string) => void): ClubLedger {
  const out: ClubLedger = { games: new Map(), honours: new Map(), picked: new Set() };
  try {
    const data = src.tournaments.snapshot();
    const entrantsBy = new Map<string, TournamentEntrantRecord[]>();
    for (const e of Object.values(data.entrants ?? {})) pushTo(entrantsBy, e.tournamentId, e);
    const heldBy = new Map<string, TournamentEntrantRecord[]>();
    for (const e of Object.values(data.heldEntrants ?? {})) pushTo(heldBy, e.tournamentId, e);
    const matchesBy = new Map<string, ScheduledMatchRecord[]>();
    for (const m of Object.values(data.scheduledMatches ?? {})) pushTo(matchesBy, m.tournamentId, m);
    for (const t of Object.values(data.tournaments ?? {})) {
      const field = (entrantsBy.get(t.id) ?? []).sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
      const matches = (matchesBy.get(t.id) ?? []).sort((a, b) => a.roundNumber - b.roundNumber || a.id.localeCompare(b.id));
      tournamentPass(t, field, heldBy.get(t.id) ?? [], matches, out);
    }
  } catch (e) { log?.(`[clubs] tournaments unreadable: ${(e as Error).message}`); }
  try {
    for (const league of src.leagues.list()) {
      try { leaguePass(league, src.leagues.competitions(league.id), out); } catch (e) { log?.(`[clubs] league unreadable: ${(e as Error).message}`); }
    }
  } catch (e) { log?.(`[clubs] leagues unreadable: ${(e as Error).message}`); }
  return out;
}

/** The games that count for this club under its settings (ladder games only when ladderGamesCount is on), newest first. */
export function countedGames(club: Pick<ClubRecord, "id" | "settings">, ledger: ClubLedger): ClubGame[] {
  const all = ledger.games.get(club.id) ?? [];
  return all
    .filter((g) => g.kind !== "ladder" || club.settings.ladderGamesCount)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
}

const blank = (coach: string): ClubRecordLine => ({ coach, games: 0, wins: 0, draws: 0, losses: 0, tdFor: 0, tdAgainst: 0, casFor: 0, casAgainst: 0 });

function add(line: ClubRecordLine, g: ClubGame): void {
  line.games += 1;
  if (g.result === "win") line.wins += 1; else if (g.result === "draw") line.draws += 1; else line.losses += 1;
  line.tdFor += g.score.for;
  line.tdAgainst += g.score.against;
  line.casFor += g.cas.for;
  line.casAgainst += g.cas.against;
}

export const RESULTS_LIMIT = 300;
export const WIN_RATE_MIN_GAMES = 3;

/** The club page's Members / Results / Stats tabs. */
export function clubStats(club: ClubRecord, ledger: ClubLedger): ClubStats {
  const games = countedGames(club, ledger);
  const ladderExcluded = !club.settings.ladderGamesCount && (ledger.games.get(club.id) ?? []).some((g) => g.kind === "ladder");
  const lines = new Map<string, ClubRecordLine>();
  const totals = blank("");
  const competitions = new Set<string>();
  for (const g of games) {
    const k = clubCoachKey(g.member.coach);
    let line = lines.get(k);
    if (!line) { line = blank(g.member.coach); lines.set(k, line); }
    add(line, g);
    add(totals, g);
    competitions.add(`${g.kind === "tournament" ? "t" : "l"}:${g.competitionId}:${g.seasonName ?? ""}`);
  }
  const honours = [...(ledger.honours.get(club.id) ?? [])].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
  const memberKeys = new Set(club.members.map((m) => clubCoachKey(m.coach)));
  const members = club.members.map((m) => ({ ...(lines.get(clubCoachKey(m.coach)) ?? blank(m.coach)), coach: m.coach, role: m.role, joinedAt: m.joinedAt }));
  // Former members: every listed leaver, and anyone else with games for the club who is not a member now.
  const formerRows = new Map<string, ClubRecordLine & { leftAt?: string }>();
  for (const f of club.former) {
    const k = clubCoachKey(f.coach);
    if (memberKeys.has(k)) continue;
    const prev = formerRows.get(k);
    if (!prev || (prev.leftAt ?? "") < f.leftAt) formerRows.set(k, { ...(lines.get(k) ?? blank(f.coach)), coach: f.coach, leftAt: f.leftAt });
  }
  for (const [k, line] of lines) if (!memberKeys.has(k) && !formerRows.has(k)) formerRows.set(k, { ...line });
  const pool = [...lines.values()];
  const leaders: ClubStats["leaders"] = [];
  const top = (key: ClubStats["leaders"][number]["key"], label: string, value: (l: ClubRecordLine) => number, display: (v: number) => string, eligible: (l: ClubRecordLine) => boolean = () => true) => {
    const best = pool.filter((l) => eligible(l) && value(l) > 0).sort((a, b) => value(b) - value(a) || b.games - a.games || a.coach.localeCompare(b.coach))[0];
    if (best) leaders.push({ key, label, coach: best.coach, value: value(best), display: display(value(best)) });
  };
  top("wins", "Most wins", (l) => l.wins, (v) => String(v));
  top("winRate", "Best win rate", (l) => (l.games ? Math.round(((l.wins + l.draws / 2) / l.games) * 1000) / 10 : 0), (v) => `${v}%`, (l) => l.games >= WIN_RATE_MIN_GAMES);
  top("touchdowns", "Most touchdowns", (l) => l.tdFor, (v) => String(v));
  top("casualties", "Most casualties", (l) => l.casFor, (v) => String(v));
  top("games", "Most games", (l) => l.games, (v) => String(v));
  return {
    totals: {
      ...totals, coach: "", competitions: competitions.size, coaches: lines.size,
      titles: honours.filter((h) => h.kind === "title").length, podiums: honours.filter((h) => h.kind === "podium").length,
    },
    members: members.sort((a, b) => b.games - a.games || b.wins - a.wins || a.coach.localeCompare(b.coach)),
    former: [...formerRows.values()].sort((a, b) => b.games - a.games || a.coach.localeCompare(b.coach)),
    leaders,
    results: games.slice(0, RESULTS_LIMIT),
    honours,
    ladderExcluded,
  };
}

/** The club's latest results for the Overview tab. */
export function latestResults(club: ClubRecord, ledger: ClubLedger, n = 6): ClubGame[] {
  return countedGames(club, ledger).slice(0, n);
}
