/**
 * League statistics across seasons, filtered by rules edition (BB2020 / BB2025 / all time).
 *
 * Results (coach / team / race records, biggest wins, most games) come from the fixtures: every played fixture
 * counts with the shared outcome rule (identity.ts fixtureOutcome: a concession decides, then the score), 3 points
 * a win, 1 a draw. Coaches aggregate by the canonical alias key (account id <-> NAF name <-> unambiguous display
 * name, built over every season so it does not change with the scope); a team is canonical coach + team name +
 * race, so two coaches' teams of the same name stay apart. Player leaders come from the per-player season stats
 * (the TourPlay player honours), summed per career: players link across seasons by the career key the importer
 * records on each player (playerIds, never names); totals the export could not split are never credited.
 */
import { buildCoachAliases, fixtureOutcome, seasonCoachFacets, type CoachAliases, type SideOutcome } from "./identity.js";
import { nameKey } from "./tourplay.js";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeagueRuleset, type PlayerSeasonStats, type SeasonRecord } from "./types.js";

export type StatsScope = "bb2020" | "bb2025" | "all";
export const STATS_SCOPES: readonly StatsScope[] = ["bb2020", "bb2025", "all"];
export const isStatsScope = (v: unknown): v is StatsScope => typeof v === "string" && (STATS_SCOPES as readonly string[]).includes(v);
const SCOPE_RULESET: Record<StatsScope, LeagueRuleset | undefined> = { bb2020: "BB2020", bb2025: "BB2025", all: undefined };

export const LEADER_STATS = ["td", "cas", "mvp", "int", "completions", "fouls", "spp"] as const;
export type LeaderStat = (typeof LEADER_STATS)[number];

export interface PlayerLeader {
  /** The career's newest player id (open it with ?player= in `seasonId`). */
  playerId: string;
  seasonId: string;
  name: string;
  position: string;
  team: string;
  race: string;
  coach: string;
  /** Season numbers the player scored in (ascending). */
  seasons: number[];
  value: number;
}

export interface RecordLine {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
  /** (wins + draws / 2) / games, 0..1, rounded to 3 places. */
  winPct: number;
}

export interface CoachRecord extends RecordLine {
  coach: string;
  coachId?: string;
  seasons: number[];
  teams: number;
  titles: number;
}

export interface TeamRecord extends RecordLine {
  team: string;
  race: string;
  coach: string;
  seasons: number[];
}

export interface RaceRecord extends RecordLine {
  race: string;
  teams: number;
}

export interface BigWin {
  seasonId: string;
  season: number;
  phase: string;
  round: number;
  winner: { team: string; coach: string; race: string; score: number };
  loser: { team: string; coach: string; race: string; score: number };
  margin: number;
  playedAt?: string;
}

export interface Champion {
  seasonId: string;
  season: number;
  ruleset: LeagueRuleset;
  coach: string;
  team: string;
  race: string;
}

export interface LeagueStats {
  scope: StatsScope;
  seasons: Array<{ id: string; number: number; name: string; ruleset: LeagueRuleset; status: string }>;
  totals: { seasons: number; games: number; touchdowns: number; casualties: number; teams: number; coaches: number; players: number };
  leaders: Record<LeaderStat, PlayerLeader[]>;
  coaches: CoachRecord[];
  teams: TeamRecord[];
  races: RaceRecord[];
  biggestWins: BigWin[];
  mostGames: CoachRecord[];
  champions: Champion[];
}

const LEADER_LIMIT = 10;

const blank = (): RecordLine => ({ games: 0, wins: 0, draws: 0, losses: 0, points: 0, tdFor: 0, tdAgainst: 0, casFor: 0, casAgainst: 0, winPct: 0 });

function add(line: RecordLine, result: SideOutcome, mine: number, theirs: number, casFor: number, casAgainst: number): void {
  line.games += 1;
  if (result === "win") { line.wins += 1; line.points += 3; } else if (result === "draw") { line.draws += 1; line.points += 1; } else line.losses += 1;
  line.tdFor += mine;
  line.tdAgainst += theirs;
  line.casFor += casFor;
  line.casAgainst += casAgainst;
}

const finish = <T extends RecordLine>(line: T): T => ({ ...line, winPct: line.games ? Math.round(((line.wins + line.draws / 2) / line.games) * 1000) / 1000 : 0 });

/** The alias table over every season (fixtures, participants, rosters, standings, awards). */
export function leagueCoachAliases(seasons: SeasonRecord[]): CoachAliases {
  return buildCoachAliases((function* () { for (const s of seasons) yield* seasonCoachFacets(s); })());
}

/** A team across seasons: canonical coach + team name + race. */
export const teamKeyOf = (coachKey: string, team: string, race: string): string => `${coachKey}\0${nameKey(team)}\0${nameKey(race)}`;

const pushSeason = (list: number[], n: number): void => { if (!list.includes(n)) { list.push(n); list.sort((a, b) => a - b); } };

export function seasonsInScope(seasons: SeasonRecord[], scope: StatsScope): SeasonRecord[] {
  const ruleset = SCOPE_RULESET[scope];
  return seasons.filter((s) => !ruleset || s.ruleset === ruleset).sort((a, b) => a.number - b.number);
}

export function leagueStats(allSeasons: SeasonRecord[], scope: StatsScope): LeagueStats {
  const seasons = seasonsInScope(allSeasons, scope);
  const coaches = new Map<string, CoachRecord & { teamKeys: Set<string>; lastSeen: number }>();
  const teams = new Map<string, TeamRecord>();
  const races = new Map<string, RaceRecord & { teamKeys: Set<string> }>();
  const wins: BigWin[] = [];
  let games = 0;
  let touchdowns = 0;
  let casualties = 0;

  const aliases = leagueCoachAliases(allSeasons);
  const keyFor = (coach: string, nafUser?: string, coachId?: string): string => aliases.key({ coach, nafUser, coachId });

  for (const s of seasons) {
    for (const f of s.fixtures) {
      const outcome = fixtureOutcome(f);
      if (!outcome) continue;
      const hs = f.home.score!;
      const as = f.away.score!;
      const hc = f.home.cas ?? 0;
      const ac = f.away.cas ?? 0;
      games += 1;
      touchdowns += hs + as;
      casualties += hc + ac;
      for (const [side, result, mine, theirs, cf, ca] of [[f.home, outcome.home, hs, as, hc, ac], [f.away, outcome.away, as, hs, ac, hc]] as const) {
        const ck = keyFor(side.coach, side.nafUser, side.coachId);
        // An organiser-assigned account names the side (the imported display name belongs to someone else).
        const shown = side.coachAssigned && side.coachId ? side.coachId : side.coach;
        let c = coaches.get(ck);
        if (!c) { c = { ...blank(), coach: shown, seasons: [], teams: 0, titles: 0, teamKeys: new Set(), lastSeen: -1 }; coaches.set(ck, c); }
        if (s.number >= c.lastSeen) { c.coach = shown; c.lastSeen = s.number; }
        if (side.coachId) c.coachId = side.coachId;
        add(c, result, mine, theirs, cf, ca);
        pushSeason(c.seasons, s.number);
        const tk = teamKeyOf(ck, side.team, side.race);
        c.teamKeys.add(tk);
        let t = teams.get(tk);
        if (!t) { t = { ...blank(), team: side.team, race: side.race, coach: shown, seasons: [] }; teams.set(tk, t); }
        t.coach = shown;
        add(t, result, mine, theirs, cf, ca);
        pushSeason(t.seasons, s.number);
        const rk = side.race || "Unknown";
        let r = races.get(rk);
        if (!r) { r = { ...blank(), race: rk, teams: 0, teamKeys: new Set() }; races.set(rk, r); }
        add(r, result, mine, theirs, cf, ca);
        r.teamKeys.add(`${s.number}\0${tk}`);
      }
      if (outcome.home !== outcome.away && (outcome.home === "win" || outcome.away === "win")) {
        const homeWon = outcome.home === "win";
        const margin = homeWon ? hs - as : as - hs;
        if (margin > 0) wins.push(bigWin(s, f, homeWon));
      }
    }
  }

  const champions: Champion[] = [];
  for (const s of seasons) {
    const champ = s.awards.find((a) => a.type === "Overall Champion");
    if (!champ) continue;
    champions.push({ seasonId: s.id, season: s.number, ruleset: s.ruleset, coach: champ.coach, team: champ.team, race: champ.race });
    const c = coaches.get(keyFor(champ.coach, undefined, champ.coachId));
    if (c) c.titles += 1;
  }

  const coachList = [...coaches.values()].map(({ teamKeys, lastSeen: _l, ...c }) => finish({ ...c, teams: teamKeys.size }));
  coachList.sort((a, b) => b.points - a.points || b.winPct - a.winPct || b.games - a.games || a.coach.localeCompare(b.coach));
  const teamList = [...teams.values()].map(finish).sort((a, b) => b.points - a.points || b.winPct - a.winPct || a.team.localeCompare(b.team));
  const raceList = [...races.values()].map(({ teamKeys, ...r }) => finish({ ...r, teams: teamKeys.size }))
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games || a.race.localeCompare(b.race));
  wins.sort((a, b) => b.margin - a.margin || b.winner.score - a.winner.score || a.season - b.season || a.round - b.round);
  const mostGames = [...coachList].sort((a, b) => b.games - a.games || b.wins - a.wins || a.coach.localeCompare(b.coach)).slice(0, LEADER_LIMIT);

  const { leaders, players } = playerLeaders(seasons);
  return {
    scope,
    seasons: [...seasons].sort((a, b) => b.number - a.number).map((s) => ({ id: s.id, number: s.number, name: s.name, ruleset: s.ruleset, status: s.status })),
    totals: { seasons: seasons.length, games, touchdowns, casualties, teams: teams.size, coaches: coaches.size, players },
    leaders,
    coaches: coachList,
    teams: teamList,
    races: raceList,
    biggestWins: wins.slice(0, LEADER_LIMIT),
    mostGames,
    champions: champions.sort((a, b) => b.season - a.season),
  };
}

function bigWin(s: SeasonRecord, f: LeagueFixture, homeWon: boolean): BigWin {
  const w = homeWon ? f.home : f.away;
  const l = homeWon ? f.away : f.home;
  return {
    seasonId: s.id,
    season: s.number,
    phase: f.phase,
    round: f.round,
    winner: { team: w.team, coach: w.coach, race: w.race, score: w.score! },
    loser: { team: l.team, coach: l.coach, race: l.race, score: l.score! },
    margin: w.score! - l.score!,
    ...(f.finishedAt ?? f.startedAt ? { playedAt: f.finishedAt ?? f.startedAt } : {}),
  };
}

/**
 * Player careers, keyed by the importer's career key (the player's ids across seasons are linked on the record:
 * careerKey / previousIds), never by name. A player without a career key (an older stored season) is its own career.
 */
function playerLeaders(seasons: SeasonRecord[]): { leaders: Record<LeaderStat, PlayerLeader[]>; players: number } {
  const careers = new Map<string, { playerId: string; seasonId: string; name: string; position: string; team: string; race: string; coach: string; seasons: number[]; stats: PlayerSeasonStats }>();
  for (const s of seasons) {
    for (const team of s.teams) {
      for (const p of [...team.players, ...team.formerPlayers]) {
        const key = p.careerKey ?? p.playerId;
        let c = careers.get(key);
        if (!c) {
          c = { playerId: p.playerId, seasonId: s.id, name: p.name, position: p.position, team: team.name, race: team.race, coach: team.coach, seasons: [], stats: { ...EMPTY_PLAYER_STATS } };
          careers.set(key, c);
        }
        c.playerId = p.playerId; // seasons ascend: the newest appearance names the career
        c.seasonId = s.id;
        if (Object.values(p.stats).some((v) => v > 0)) pushSeason(c.seasons, s.number);
        for (const k of Object.keys(c.stats) as Array<keyof PlayerSeasonStats>) c.stats[k] += p.stats[k] ?? 0;
        c.coach = team.coach;
      }
    }
  }
  const list = [...careers.values()];
  const leaders = Object.fromEntries(LEADER_STATS.map((stat) => [stat, list
    .filter((c) => c.stats[stat] > 0)
    .sort((a, b) => b.stats[stat] - a.stats[stat] || a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId))
    .slice(0, LEADER_LIMIT)
    .map((c) => ({ playerId: c.playerId, seasonId: c.seasonId, name: c.name, position: c.position, team: c.team, race: c.race, coach: c.coach, seasons: c.seasons, value: c.stats[stat] }))])) as Record<LeaderStat, PlayerLeader[]>;
  return { leaders, players: list.length };
}
