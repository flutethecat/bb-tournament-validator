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
 *
 * Spotlight cards (cards[], the row on top of each scope): one card per headline (top scorer, casualty leader, most
 * valuable, best coach record, best team, biggest win, playmaker, interceptor, dirtiest, iron man), each with its big
 * number, who, team + race, season numbers, the names tied with it, and a link target. A card with no data is left out
 * (an empty scope has no cards). Add a card by adding a builder to CARD_BUILDERS.
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
  /** The newest team's id in `seasonId` (?team=). */
  teamId: string;
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
  /** The team the coach played their newest game with (link target). */
  latest?: { seasonId: string; teamId?: string; team: string; race: string };
}

export interface TeamRecord extends RecordLine {
  team: string;
  race: string;
  coach: string;
  seasons: number[];
  /** The newest season the team played in, and its season team id there when the fixture resolved one. */
  seasonId: string;
  teamId?: string;
}

export interface RaceRecord extends RecordLine {
  race: string;
  teams: number;
}

export interface BigWin {
  seasonId: string;
  fixtureId: string;
  season: number;
  phase: string;
  round: number;
  winner: { team: string; teamId?: string; coach: string; race: string; score: number };
  loser: { team: string; teamId?: string; coach: string; race: string; score: number };
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
  /** Spotlight cards, in display order. */
  cards: StatsCard[];
}

export type StatsCardId =
  | "top-scorer" | "casualties" | "mvp" | "playmaker" | "interceptor" | "dirtiest" | "iron-man" | "best-coach" | "best-team" | "biggest-win";

/** Where a card opens: a player (season + team + player), a team (season + team id or name) or a fixture. */
export type StatsCardLink =
  | { kind: "player"; seasonId: string; teamId: string; playerId: string }
  | { kind: "team"; seasonId: string; teamId: string }
  | { kind: "fixture"; seasonId: string; fixtureId: string };

export interface StatsCard {
  id: StatsCardId;
  /** "Top scorer". */
  title: string;
  /** The big number as shown ("12", "75%", "6-0"). */
  value: string;
  /** What the number counts ("TD", "Win %"). */
  unit: string;
  /** Player, coach, team or the winning team. */
  name: string;
  team: string;
  race: string;
  coach: string;
  /** One more line ("Blitzer", "8-2-1 in 11 games", "beat Elves · Round 3"). */
  detail: string;
  seasons: number[];
  /** Others level with the card's leader (same headline value and tie-break), in order. */
  tied: string[];
  /** A pixel sprite under /icons/panel ("" = none). */
  icon: string;
  link: StatsCardLink;
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
  /** Played fixtures per season team ("<seasonId>\0<teamId>"): the iron man's games. */
  const teamGames = new Map<string, number>();
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
      for (const side of [f.home, f.away]) if (side.teamId) teamGames.set(`${s.id}\0${side.teamId}`, (teamGames.get(`${s.id}\0${side.teamId}`) ?? 0) + 1);
      touchdowns += hs + as;
      casualties += hc + ac;
      for (const [side, result, mine, theirs, cf, ca] of [[f.home, outcome.home, hs, as, hc, ac], [f.away, outcome.away, as, hs, ac, hc]] as const) {
        const ck = keyFor(side.coach, side.nafUser, side.coachId);
        // An organiser-assigned account names the side (the imported display name belongs to someone else).
        const shown = side.coachAssigned && side.coachId ? side.coachId : side.coach;
        let c = coaches.get(ck);
        if (!c) { c = { ...blank(), coach: shown, seasons: [], teams: 0, titles: 0, teamKeys: new Set(), lastSeen: -1 }; coaches.set(ck, c); }
        if (s.number >= c.lastSeen) {
          c.coach = shown;
          c.lastSeen = s.number;
          c.latest = { seasonId: s.id, ...(side.teamId ? { teamId: side.teamId } : {}), team: side.team, race: side.race };
        }
        if (side.coachId) c.coachId = side.coachId;
        add(c, result, mine, theirs, cf, ca);
        pushSeason(c.seasons, s.number);
        const tk = teamKeyOf(ck, side.team, side.race);
        c.teamKeys.add(tk);
        let t = teams.get(tk);
        if (!t) { t = { ...blank(), team: side.team, race: side.race, coach: shown, seasons: [], seasonId: s.id }; teams.set(tk, t); }
        t.coach = shown;
        t.seasonId = s.id;
        if (side.teamId) t.teamId = side.teamId; else delete t.teamId;
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

  const { leaders, careers } = playerLeaders(seasons);
  const players = careers.length;
  const cards = statsCards({ careers, coaches: coachList, teams: teamList, wins, teamGames });
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
    cards,
  };
}

function bigWin(s: SeasonRecord, f: LeagueFixture, homeWon: boolean): BigWin {
  const w = homeWon ? f.home : f.away;
  const l = homeWon ? f.away : f.home;
  const who = (x: typeof w) => ({ team: x.team, ...(x.teamId ? { teamId: x.teamId } : {}), coach: x.coachAssigned && x.coachId ? x.coachId : x.coach, race: x.race, score: x.score! });
  return {
    seasonId: s.id,
    fixtureId: f.id,
    season: s.number,
    phase: f.phase,
    round: f.round,
    winner: who(w),
    loser: who(l),
    margin: w.score! - l.score!,
    ...(f.finishedAt ?? f.startedAt ? { playedAt: f.finishedAt ?? f.startedAt } : {}),
  };
}

/** A player career across the scope (see playerLeaders). */
export interface Career {
  playerId: string;
  seasonId: string;
  teamId: string;
  name: string;
  position: string;
  team: string;
  race: string;
  coach: string;
  /** Season numbers the player scored in (ascending). */
  seasons: number[];
  /** Every season the player was on a roster (ascending), with the season team: the iron man. */
  rostered: Array<{ season: number; seasonId: string; teamId: string }>;
  stats: PlayerSeasonStats;
}

/**
 * Player careers, keyed by the importer's career key (the player's ids across seasons are linked on the record:
 * careerKey / previousIds), never by name. A player without a career key (an older stored season) is its own career.
 */
function playerLeaders(seasons: SeasonRecord[]): { leaders: Record<LeaderStat, PlayerLeader[]>; careers: Career[] } {
  const careers = new Map<string, Career>();
  for (const s of seasons) {
    for (const team of s.teams) {
      for (const p of [...team.players, ...team.formerPlayers]) {
        const key = p.careerKey ?? p.playerId;
        let c = careers.get(key);
        if (!c) {
          c = { playerId: p.playerId, seasonId: s.id, teamId: team.id, name: p.name, position: p.position, team: team.name, race: team.race, coach: team.coach, seasons: [], rostered: [], stats: { ...EMPTY_PLAYER_STATS } };
          careers.set(key, c);
        }
        c.playerId = p.playerId; // seasons ascend: the newest appearance names the career
        c.seasonId = s.id;
        c.teamId = team.id;
        c.team = team.name;
        c.race = team.race;
        if (!c.rostered.some((r) => r.seasonId === s.id)) c.rostered.push({ season: s.number, seasonId: s.id, teamId: team.id });
        if (Object.values(p.stats).some((v) => v > 0)) pushSeason(c.seasons, s.number);
        for (const k of Object.keys(c.stats) as Array<keyof PlayerSeasonStats>) c.stats[k] += p.stats[k] ?? 0;
        c.coach = team.coachAssigned && team.coachId ? team.coachId : team.coach;
      }
    }
  }
  const list = [...careers.values()];
  const leaders = Object.fromEntries(LEADER_STATS.map((stat) => [stat, rankBy(list, stat)
    .slice(0, LEADER_LIMIT)
    .map((c) => ({ playerId: c.playerId, seasonId: c.seasonId, teamId: c.teamId, name: c.name, position: c.position, team: c.team, race: c.race, coach: c.coach, seasons: c.seasons, value: c.stats[stat] }))])) as Record<LeaderStat, PlayerLeader[]>;
  return { leaders, careers: list };
}

/** Careers with a positive total for the stat, highest first (name, then id, break ties). */
const rankBy = (list: Career[], stat: keyof PlayerSeasonStats): Career[] => list
  .filter((c) => c.stats[stat] > 0)
  .sort((a, b) => b.stats[stat] - a.stats[stat] || a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId));

// ---- spotlight cards ------------------------------------------------------------------------------------------------

export interface CardInputs {
  careers: Career[];
  /** Sorted as LeagueStats.coaches. */
  coaches: CoachRecord[];
  /** Sorted as LeagueStats.teams. */
  teams: TeamRecord[];
  /** Sorted as LeagueStats.biggestWins (all of them). */
  wins: BigWin[];
  /** Played fixtures per "<seasonId>\0<teamId>". */
  teamGames: Map<string, number>;
}

const pctText = (x: number): string => `${Math.round(x * 100)}%`;
const wdlText = (r: RecordLine): string => `${r.wins}-${r.draws}-${r.losses}`;
const playerName = (c: Pick<Career, "name">): string => c.name || "Unnamed player";

/** The names after the first that share its key, in order. */
function tiedWith<T>(sorted: T[], key: (x: T) => string, name: (x: T) => string): string[] {
  if (!sorted.length) return [];
  const top = key(sorted[0]!);
  const out: string[] = [];
  for (let i = 1; i < sorted.length && key(sorted[i]!) === top; i++) out.push(name(sorted[i]!));
  return out;
}

interface PlayerCardDef { id: StatsCardId; title: string; stat: keyof PlayerSeasonStats; unit: string; icon: string }
const PLAYER_CARDS: Record<"td" | "cas" | "mvp" | "completions" | "int" | "fouls", PlayerCardDef> = {
  td: { id: "top-scorer", title: "Top scorer", stat: "td", unit: "TD", icon: "/icons/panel/games.png" },
  cas: { id: "casualties", title: "Casualty leader", stat: "cas", unit: "CAS", icon: "/icons/panel/fixtures.png" },
  mvp: { id: "mvp", title: "Most valuable", stat: "mvp", unit: "MVP", icon: "/icons/panel/honours.png" },
  completions: { id: "playmaker", title: "Playmaker", stat: "completions", unit: "Completions", icon: "/icons/panel/stats.png" },
  int: { id: "interceptor", title: "Interceptor", stat: "int", unit: "Interceptions", icon: "/icons/panel/teams-roster.png" },
  fouls: { id: "dirtiest", title: "Dirtiest", stat: "fouls", unit: "Fouls", icon: "" },
};

function playerCard(def: PlayerCardDef, careers: Career[]): StatsCard | undefined {
  const ranked = rankBy(careers, def.stat);
  const top = ranked[0];
  if (!top) return undefined;
  return {
    id: def.id, title: def.title, value: String(top.stats[def.stat]), unit: def.unit,
    name: playerName(top), team: top.team, race: top.race, coach: top.coach, detail: top.position,
    seasons: top.seasons, tied: tiedWith(ranked, (c) => String(c.stats[def.stat]), playerName), icon: def.icon,
    link: { kind: "player", seasonId: top.seasonId, teamId: top.teamId, playerId: top.playerId },
  };
}

/** Iron man: most seasons on a roster (career key), then most games their teams played in those seasons. */
function ironManCard(careers: Career[], teamGames: Map<string, number>): StatsCard | undefined {
  const rows = careers
    .map((c) => ({ c, seasons: c.rostered.length, games: c.rostered.reduce((n, r) => n + (teamGames.get(`${r.seasonId}\0${r.teamId}`) ?? 0), 0) }))
    .filter((r) => r.seasons > 0 && r.games > 0)
    .sort((a, b) => b.seasons - a.seasons || b.games - a.games || a.c.name.localeCompare(b.c.name) || a.c.playerId.localeCompare(b.c.playerId));
  const top = rows[0];
  if (!top) return undefined;
  return {
    id: "iron-man", title: "Iron man", value: String(top.seasons), unit: top.seasons === 1 ? "Season" : "Seasons",
    name: playerName(top.c), team: top.c.team, race: top.c.race, coach: top.c.coach,
    detail: `${top.c.position} · ${top.games} team ${top.games === 1 ? "game" : "games"}`,
    seasons: top.c.rostered.map((r) => r.season), tied: tiedWith(rows, (r) => `${r.seasons}/${r.games}`, (r) => playerName(r.c)),
    icon: "/icons/panel/schedule.png",
    link: { kind: "player", seasonId: top.c.seasonId, teamId: top.c.teamId, playerId: top.c.playerId },
  };
}

/**
 * Best coach record: the best win % (draw = half a win) among coaches with at least half the games of the busiest
 * coach (one lucky game does not top the card), then more games, then more points.
 */
function bestCoachCard(coaches: CoachRecord[]): StatsCard | undefined {
  const most = coaches.reduce((m, c) => Math.max(m, c.games), 0);
  if (!most) return undefined;
  const min = Math.max(1, Math.ceil(most / 2));
  const ranked = coaches.filter((c) => c.games >= min)
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games || b.points - a.points || a.coach.localeCompare(b.coach));
  const top = ranked[0];
  if (!top || !top.latest) return undefined;
  return {
    id: "best-coach", title: "Best coach record", value: pctText(top.winPct), unit: "Win %",
    name: top.coach, team: top.latest.team, race: top.latest.race, coach: top.coach,
    detail: `${wdlText(top)} in ${top.games} ${top.games === 1 ? "game" : "games"}${min > 1 ? ` · min. ${min} games` : ""}`,
    seasons: top.seasons, tied: tiedWith(ranked, (c) => `${c.winPct}/${c.games}/${c.points}`, (c) => c.coach), icon: "/icons/panel/account.png",
    link: { kind: "team", seasonId: top.latest.seasonId, teamId: top.latest.teamId ?? top.latest.team },
  };
}

/** Best team: most points (3 / 1 / 0), then win %, then wins. */
function bestTeamCard(teams: TeamRecord[]): StatsCard | undefined {
  const ranked = [...teams].sort((a, b) => b.points - a.points || b.winPct - a.winPct || b.wins - a.wins || a.team.localeCompare(b.team));
  const top = ranked[0];
  if (!top || !top.games) return undefined;
  return {
    id: "best-team", title: "Best team", value: String(top.points), unit: top.points === 1 ? "Point" : "Points",
    name: top.team, team: top.team, race: top.race, coach: top.coach, detail: `${wdlText(top)} · ${pctText(top.winPct)} wins`,
    seasons: top.seasons, tied: tiedWith(ranked, (t) => `${t.points}/${t.winPct}/${t.wins}`, (t) => t.team), icon: "/icons/panel/teams.png",
    link: { kind: "team", seasonId: top.seasonId, teamId: top.teamId ?? top.team },
  };
}

/** Biggest win: the widest margin, then the most touchdowns scored, then the earliest (the biggestWins order). */
function biggestWinCard(wins: BigWin[]): StatsCard | undefined {
  const top = wins[0];
  if (!top) return undefined;
  return {
    id: "biggest-win", title: "Biggest win", value: `${top.winner.score}-${top.loser.score}`, unit: `+${top.margin}`,
    name: top.winner.team, team: top.winner.team, race: top.winner.race, coach: top.winner.coach,
    detail: `beat ${top.loser.team} · Round ${top.round}`,
    seasons: [top.season], tied: tiedWith(wins, (w) => `${w.margin}/${w.winner.score}`, (w) => `${w.winner.team} ${w.winner.score}-${w.loser.score} ${w.loser.team}`),
    icon: "/icons/panel/tournaments.png",
    link: { kind: "fixture", seasonId: top.seasonId, fixtureId: top.fixtureId },
  };
}

/** Card builders in display order; each returns undefined when the scope has nothing for it. */
const CARD_BUILDERS: ReadonlyArray<(x: CardInputs) => StatsCard | undefined> = [
  (x) => playerCard(PLAYER_CARDS.td, x.careers),
  (x) => playerCard(PLAYER_CARDS.cas, x.careers),
  (x) => playerCard(PLAYER_CARDS.mvp, x.careers),
  (x) => bestCoachCard(x.coaches),
  (x) => bestTeamCard(x.teams),
  (x) => biggestWinCard(x.wins),
  (x) => playerCard(PLAYER_CARDS.completions, x.careers),
  (x) => playerCard(PLAYER_CARDS.int, x.careers),
  (x) => playerCard(PLAYER_CARDS.fouls, x.careers),
  (x) => ironManCard(x.careers, x.teamGames),
];

/** The spotlight cards for one scope (pure). */
export function statsCards(x: CardInputs): StatsCard[] {
  return CARD_BUILDERS.map((b) => b(x)).filter((c): c is StatsCard => c !== undefined);
}
