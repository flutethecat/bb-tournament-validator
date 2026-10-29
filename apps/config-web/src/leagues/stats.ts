/**
 * League statistics across seasons, filtered by rules edition (BB2020 / BB2025 / all time).
 *
 * Results (coach / team / race records, biggest wins, most games) come from the fixtures: every played fixture
 * counts (fixturePlayed: a suspended 0-0 with no concession is "not played"), 3 points a win, 1 a draw. Player
 * leaders come from the per-player season stats (the TourPlay player honours), summed per player career (same team
 * + same name across seasons) and including players no longer on a roster.
 */
import { fixturePlayed, nameKey } from "./tourplay.js";
import type { LeagueFixture, LeagueRuleset, PlayerSeasonStats, SeasonRecord } from "./types.js";

export type StatsScope = "bb2020" | "bb2025" | "all";
export const STATS_SCOPES: readonly StatsScope[] = ["bb2020", "bb2025", "all"];
export const isStatsScope = (v: unknown): v is StatsScope => typeof v === "string" && (STATS_SCOPES as readonly string[]).includes(v);
const SCOPE_RULESET: Record<StatsScope, LeagueRuleset | undefined> = { bb2020: "BB2020", bb2025: "BB2025", all: undefined };

export const LEADER_STATS = ["td", "cas", "mvp", "int", "completions", "fouls", "spp"] as const;
export type LeaderStat = (typeof LEADER_STATS)[number];

export interface PlayerLeader {
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

function add(line: RecordLine, mine: number, theirs: number, casFor: number, casAgainst: number): void {
  line.games += 1;
  if (mine > theirs) { line.wins += 1; line.points += 3; } else if (mine === theirs) { line.draws += 1; line.points += 1; } else line.losses += 1;
  line.tdFor += mine;
  line.tdAgainst += theirs;
  line.casFor += casFor;
  line.casAgainst += casAgainst;
}

const finish = <T extends RecordLine>(line: T): T => ({ ...line, winPct: line.games ? Math.round(((line.wins + line.draws / 2) / line.games) * 1000) / 1000 : 0 });

/** The coach key that merges a coach across seasons: the NAF name when known, else the display name. */
export const coachKeyOf = (coach: string, nafUser?: string, coachId?: string): string =>
  coachId ? `id:${coachId.trim().toLowerCase()}` : nafUser ? `naf:${nafUser.trim().toLowerCase()}` : `name:${nameKey(coach)}`;

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

  // A display name seen with a NAF name maps to that NAF key in later rows that lack it (same season or another).
  const nafByName = new Map<string, string>();
  for (const s of seasons) {
    for (const f of s.fixtures) for (const side of [f.home, f.away]) if (side.nafUser) nafByName.set(nameKey(side.coach), side.nafUser);
    for (const p of s.participants) if (p.nafUser) nafByName.set(nameKey(p.coach), p.nafUser);
  }
  const keyFor = (coach: string, nafUser?: string, coachId?: string): string =>
    coachKeyOf(coach, nafUser ?? nafByName.get(nameKey(coach)), coachId);

  for (const s of seasons) {
    for (const f of s.fixtures) {
      if (!fixturePlayed(f)) continue;
      const hs = f.home.score!;
      const as = f.away.score!;
      const hc = f.home.cas ?? 0;
      const ac = f.away.cas ?? 0;
      games += 1;
      touchdowns += hs + as;
      casualties += hc + ac;
      for (const [side, mine, theirs, cf, ca] of [[f.home, hs, as, hc, ac], [f.away, as, hs, ac, hc]] as const) {
        const ck = keyFor(side.coach, side.nafUser, side.coachId);
        let c = coaches.get(ck);
        if (!c) { c = { ...blank(), coach: side.coach, seasons: [], teams: 0, titles: 0, teamKeys: new Set(), lastSeen: -1 }; coaches.set(ck, c); }
        if (s.number >= c.lastSeen) { c.coach = side.coach; c.lastSeen = s.number; }
        if (side.coachId) c.coachId = side.coachId;
        add(c, mine, theirs, cf, ca);
        pushSeason(c.seasons, s.number);
        const tk = nameKey(side.team);
        c.teamKeys.add(tk);
        let t = teams.get(tk);
        if (!t) { t = { ...blank(), team: side.team, race: side.race, coach: side.coach, seasons: [] }; teams.set(tk, t); }
        add(t, mine, theirs, cf, ca);
        pushSeason(t.seasons, s.number);
        const rk = side.race || "Unknown";
        let r = races.get(rk);
        if (!r) { r = { ...blank(), race: rk, teams: 0, teamKeys: new Set() }; races.set(rk, r); }
        add(r, mine, theirs, cf, ca);
        r.teamKeys.add(`${s.number}\0${tk}`);
      }
      if (hs !== as) wins.push(bigWin(s, f, hs > as));
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

function playerLeaders(seasons: SeasonRecord[]): { leaders: Record<LeaderStat, PlayerLeader[]>; players: number } {
  const careers = new Map<string, { name: string; position: string; team: string; race: string; coach: string; seasons: number[]; stats: PlayerSeasonStats }>();
  for (const s of seasons) {
    for (const team of s.teams) {
      const all = [
        ...team.players.map((p) => ({ name: p.name, position: p.position, stats: p.stats })),
        ...team.formerPlayers.map((p) => ({ name: p.name, position: p.position, stats: p.stats })),
      ];
      for (const p of all) {
        const key = `${nameKey(team.name)}\0${nameKey(p.name)}`;
        let c = careers.get(key);
        if (!c) {
          c = { name: p.name, position: p.position, team: team.name, race: team.race, coach: team.coach, seasons: [], stats: { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 } };
          careers.set(key, c);
        }
        const scored = Object.values(p.stats).some((v) => v > 0);
        if (scored) pushSeason(c.seasons, s.number);
        for (const k of Object.keys(c.stats) as Array<keyof PlayerSeasonStats>) c.stats[k] += p.stats[k] ?? 0;
        c.position = p.position || c.position;
        c.coach = team.coach;
      }
    }
  }
  const list = [...careers.values()];
  const leaders = Object.fromEntries(LEADER_STATS.map((stat) => [stat, list
    .filter((c) => c.stats[stat] > 0)
    .sort((a, b) => b.stats[stat] - a.stats[stat] || a.name.localeCompare(b.name))
    .slice(0, LEADER_LIMIT)
    .map((c) => ({ name: c.name, position: c.position, team: c.team, race: c.race, coach: c.coach, seasons: c.seasons, value: c.stats[stat] }))])) as Record<LeaderStat, PlayerLeader[]>;
  return { leaders, players: list.length };
}
