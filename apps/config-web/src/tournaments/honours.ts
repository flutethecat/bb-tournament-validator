/**
 * Tournament Statistics, Honours and Awards (spec-main-landing-nav-2026-10-29 §3 item 6; ruling §6(c)).
 *
 * Statistics and honours are derived from the tournament's counted results, never stored:
 *   - every completed, non-bye fixture counts with its recorded score (match.result: manual, fork or tabletop);
 *   - the fixture's stored result row adds what it carries: a fork game (match.launch.gameId) or a published tabletop
 *     match (row.fixtureRef = the fixture id) brings per-player touchdowns, casualties, completions, interceptions,
 *     fouls and MVPs plus the casualties each side suffered (badly hurt / serious injury / dead); only fork games
 *     record blocks. A manual result carries the score, and the casualties when the organiser typed them.
 *   A stat shows only when the results record it (coverage per group of stats), and a counter stat only when someone
 *   scored in it: "hide stats with no data".
 *
 * Awards: the podium (Champion, Runner-up, Consolation) fills in once the tournament is finished, from the final
 * standings (a knockout's last game decides Champion and Runner-up), and organisers of the tournament and site admins
 * give custom awards (same icon set and dialog as league awards) stored on the tournament record as awards[] with
 * `tournamentId`. The recipient's account is notified once when the award is given.
 *
 *   GET    /api/tournaments/:id/statistics          public: teams, coaches, races, players, honour boards, cards
 *   GET    /api/tournaments/:id/awards              public: { revision, finished, podium, awards, recipients? (managers) }
 *   POST   /api/tournaments/:id/awards              { revision, title, icon, recipient, note? } organisers + admins
 *          recipient = { kind: "team", teamId: <entrant id> } | { kind: "coach", coachId: <account> }
 *   DELETE /api/tournaments/:id/awards/:awardId     revision as If-Match (or ?revision=)
 *   GET    /api/tournaments?awards=mine             the signed-in coach's tournament awards (coach page Honours)
 *
 * Writes name tournament.awardsRevision as last read: 428 missing, 409 stale. CSRF and onboarding run in front of every
 * /api write (server.ts).
 */
import { randomBytes } from "node:crypto";
import { AWARD_NOTE_MAX, AWARD_TITLE_MAX, AWARDS_MAX, HonoursError, isAwardIcon, seasonAwardIcon, text } from "../leagues/awards.js";
import { requestRevision } from "../leagues/http.js";
import { PODIUM_AWARD, PODIUM_SLOTS } from "../leagues/standings.js";
import type { PodiumSlot } from "../leagues/types.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import type { TournamentNotify } from "../notifications.js";
import { calculateStandings } from "./pairing.js";
import { isTournamentManager, type TournamentStore } from "./store.js";
import type { ScheduledMatchRecord, TournamentAward, TournamentDataFileV4, TournamentEntrantRecord, TournamentRecord, TournamentStandingRow } from "./types.js";

const key = (s: string | undefined): string => (s ?? "").trim().toLowerCase();
const NO_STORE = { "cache-control": "private, no-store" };
export const BOARD_ROWS_MAX = 50;

// ---- statistics -----------------------------------------------------------------------------------------------------

/** The per-side counters (team / coach lines). */
export const TEAM_STATS = [
  "td", "tdAgainst", "cas", "casAgainst", "completions", "interceptions", "fouls", "blocks", "mvp",
  "injuriesFor", "injuriesAgainst", "deathsFor", "deathsAgainst",
] as const;
export type TeamStat = (typeof TEAM_STATS)[number];
export const PLAYER_STATS = ["td", "cas", "mvp", "completions", "interceptions", "fouls", "blocks"] as const;
export type PlayerStat = (typeof PLAYER_STATS)[number];

/** Which results record a stat: every counted game (score), a game with casualties, a game with player rows, fork only. */
type Coverage = "games" | "casualties" | "players" | "blocks";
const STAT_COVERAGE: Record<TeamStat, Coverage> = {
  td: "games", tdAgainst: "games", cas: "casualties", casAgainst: "casualties",
  completions: "players", interceptions: "players", fouls: "players", mvp: "players", blocks: "blocks",
  injuriesFor: "players", injuriesAgainst: "players", deathsFor: "players", deathsAgainst: "players",
};
/** Shown whenever recorded (a zero is an answer); every other counter needs someone to have scored in it. */
const ALWAYS_SHOWN: ReadonlySet<TeamStat> = new Set(["td", "tdAgainst", "cas", "casAgainst"]);

export interface StatLine extends Record<TeamStat, number> {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
}

export interface TeamStatRow extends StatLine { entrantId: string; team: string; coach: string; race: string; logoUrl?: string }
export interface CoachStatRow extends StatLine { coach: string; teams: number }
export interface RaceStatRow { race: string; teams: number; games: number; wins: number; draws: number; losses: number; winPct: number }
export interface PlayerStatRow extends Record<PlayerStat, number> { entrantId: string; playerId: string; name: string; team: string; coach: string; race: string }

export type BoardKind = "team" | "player" | "coach";
export interface HonourBoardRow { rank: number; name: string; team: string; coach: string; value: number }
export interface HonourBoard { key: string; kind: BoardKind; stat: string; title: string; rows: HonourBoardRow[] }

export interface SpotCard {
  id: string;
  title: string;
  value: string;
  unit: string;
  name: string;
  team: string;
  race: string;
  coach: string;
  detail: string;
  tied: string[];
  icon: string;
}

export interface TournamentStatistics {
  tournamentId: string;
  status: TournamentRecord["status"];
  totals: { games: number; touchdowns: number; casualties: number | null; teams: number; coaches: number; players: number };
  /** Counted games, and how many of them record each group of stats. */
  coverage: Record<Coverage, number>;
  /** Team / coach stat columns that have data, in display order. */
  stats: TeamStat[];
  /** Player stats that have data. */
  playerStats: PlayerStat[];
  teams: TeamStatRow[];
  coaches: CoachStatRow[];
  races: RaceStatRow[];
  players: PlayerStatRow[];
  honours: HonourBoard[];
  cards: SpotCard[];
}

/** How the page names an entrant: the library team (teamBuild), else the submitted roster, else the team id. */
export interface EntrantLabel { team: string; race: string; coach: string; logoUrl?: string }
export type TeamInfo = (teamId: string) => unknown | undefined;

const str = (v: unknown, field: string): string | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const c = (v as Record<string, unknown>)[field];
  return typeof c === "string" && c.trim() ? c : undefined;
};

export function entrantLabel(e: TournamentEntrantRecord, teamInfo: TeamInfo): EntrantLabel {
  let team: unknown;
  try { team = teamInfo(e.teamId); } catch { team = undefined; }
  const logoUrl = str(team, "logoUrl");
  return {
    team: str(team, "teamName") ?? e.submission?.teamName ?? e.teamId,
    race: str(team, "race") ?? e.submission?.race ?? "",
    coach: e.coach.ffbCoachId,
    ...(logoUrl ? { logoUrl } : {}),
  };
}

const blankLine = (): StatLine => ({
  games: 0, wins: 0, draws: 0, losses: 0, points: 0,
  ...(Object.fromEntries(TEAM_STATS.map((s) => [s, 0])) as Record<TeamStat, number>),
});

const isForkRow = (r: StoredTournamentResult): boolean => r.source === undefined || r.source === "fork";

/** The result row a fixture's stats come from: its published tabletop match, else its fork game. */
export function resultRowFor(match: ScheduledMatchRecord, rows: readonly StoredTournamentResult[]): StoredTournamentResult | undefined {
  const tabletop = rows.find((r) => r.source === "tabletop" && r.fixtureRef === match.id);
  if (tabletop) return tabletop;
  const gameId = match.launch?.gameId;
  return gameId ? rows.find((r) => r.gameId === gameId && isForkRow(r)) : undefined;
}

/** Counted fixtures: completed, two sides, a recorded score. */
export const countedMatches = (matches: readonly ScheduledMatchRecord[]): ScheduledMatchRecord[] =>
  matches.filter((m) => m.status === "completed" && m.away !== undefined && m.result !== undefined);

/** The row's team blocks in fixture order (home, away): a row whose coaches read the other way round is swapped. */
function sidesOf(match: ScheduledMatchRecord, row: StoredTournamentResult) {
  const home = key(match.home.coach.ffbCoachId);
  const away = key(match.away?.coach.ffbCoachId);
  const swapped = key(row.home?.coach) === away && key(row.away?.coach) === home && home !== away;
  const byId = (teamId: string | undefined, i: number) => row.teams.find((t) => teamId !== undefined && t.teamId === teamId) ?? row.teams[i];
  const rh = byId(row.home?.teamId, 0);
  const ra = byId(row.away?.teamId, 1);
  return swapped ? { home: ra, away: rh } : { home: rh, away: ra };
}

export interface StatisticsInputs {
  tournament: TournamentRecord;
  entrants: readonly TournamentEntrantRecord[];
  matches: readonly ScheduledMatchRecord[];
  rows: readonly StoredTournamentResult[];
  teamInfo: TeamInfo;
}

const pct = (r: { games: number; wins: number; draws: number }): number => (r.games ? Math.round(((r.wins + r.draws / 2) / r.games) * 1000) / 1000 : 0);

/** The tournament's statistics (pure). */
export function tournamentStatistics(x: StatisticsInputs): TournamentStatistics {
  const { tournament } = x;
  const labels = new Map(x.entrants.map((e) => [e.id, entrantLabel(e, x.teamInfo)]));
  const teams = new Map<string, TeamStatRow>();
  const players = new Map<string, PlayerStatRow>();
  const coverage: Record<Coverage, number> = { games: 0, casualties: 0, players: 0, blocks: 0 };
  const pts = tournament.points;

  const teamRow = (entrantId: string, fallbackCoach: string, teamId: string): TeamStatRow => {
    let t = teams.get(entrantId);
    if (!t) {
      const l = labels.get(entrantId) ?? { team: teamId, race: "", coach: fallbackCoach };
      t = { entrantId, team: l.team, coach: l.coach, race: l.race, ...(l.logoUrl ? { logoUrl: l.logoUrl } : {}), ...blankLine() };
      teams.set(entrantId, t);
    }
    return t;
  };

  for (const m of countedMatches(x.matches)) {
    const r = m.result!;
    const away = m.away!;
    const row = resultRowFor(m, x.rows);
    const blocks = row ? sidesOf(m, row) : undefined;
    const withPlayers = Boolean(blocks?.home && blocks?.away);
    const fork = Boolean(row && isForkRow(row));
    const casFromRow = withPlayers ? { home: sum(blocks!.home!.players, "casualtiesCaused"), away: sum(blocks!.away!.players, "casualtiesCaused") } : undefined;
    const cas = casFromRow ?? (r.homeCasualties !== undefined && r.awayCasualties !== undefined ? { home: r.homeCasualties, away: r.awayCasualties } : undefined);
    coverage.games += 1;
    if (cas) coverage.casualties += 1;
    if (withPlayers) coverage.players += 1;
    if (withPlayers && fork) coverage.blocks += 1;

    const sides = [
      { side: m.home, mine: r.homeScore, theirs: r.awayScore, block: blocks?.home, opp: blocks?.away, casFor: cas?.home, casAgainst: cas?.away },
      { side: away, mine: r.awayScore, theirs: r.homeScore, block: blocks?.away, opp: blocks?.home, casFor: cas?.away, casAgainst: cas?.home },
    ];
    for (const s of sides) {
      const t = teamRow(s.side.entrantId, s.side.coach.ffbCoachId, s.side.teamId);
      t.games += 1;
      if (s.mine > s.theirs) { t.wins += 1; t.points += pts.win; } else if (s.mine === s.theirs) { t.draws += 1; t.points += pts.draw; } else { t.losses += 1; t.points += pts.loss; }
      t.td += s.mine;
      t.tdAgainst += s.theirs;
      if (s.casFor !== undefined) { t.cas += s.casFor; t.casAgainst += s.casAgainst ?? 0; }
      if (withPlayers && s.block && s.opp) {
        t.completions += sum(s.block.players, "completions");
        t.interceptions += sum(s.block.players, "interceptions");
        t.fouls += sum(s.block.players, "fouls");
        t.mvp += sum(s.block.players, "mvp");
        if (fork) t.blocks += sum(s.block.players, "blocks");
        t.injuriesAgainst += s.block.casualtiesSuffered?.si ?? 0;
        t.deathsAgainst += s.block.casualtiesSuffered?.rip ?? 0;
        t.injuriesFor += s.opp.casualtiesSuffered?.si ?? 0;
        t.deathsFor += s.opp.casualtiesSuffered?.rip ?? 0;
        for (const p of s.block.players) {
          const pk = `${s.side.entrantId}\0${p.playerId}`;
          let pl = players.get(pk);
          if (!pl) {
            pl = { entrantId: s.side.entrantId, playerId: p.playerId, name: p.name || "Unnamed player", team: t.team, coach: t.coach, race: t.race, td: 0, cas: 0, mvp: 0, completions: 0, interceptions: 0, fouls: 0, blocks: 0 };
            players.set(pk, pl);
          }
          if (p.name) pl.name = p.name;
          pl.td += num(p.touchdowns);
          pl.cas += num(p.casualtiesCaused);
          pl.mvp += num(p.mvp);
          pl.completions += num(p.completions);
          pl.interceptions += num(p.interceptions);
          pl.fouls += num(p.fouls);
          if (fork) pl.blocks += num(p.blocks);
        }
      }
    }
  }

  const teamList = [...teams.values()].sort((a, b) => b.points - a.points || (b.td - b.tdAgainst) - (a.td - a.tdAgainst) || a.team.localeCompare(b.team));
  const total = (s: TeamStat): number => teamList.reduce((n, t) => n + t[s], 0);
  const stats = TEAM_STATS.filter((s) => coverage[STAT_COVERAGE[s]] > 0 && (ALWAYS_SHOWN.has(s) || total(s) > 0));
  const playerList = [...players.values()].filter((p) => PLAYER_STATS.some((s) => p[s] > 0));
  const playerStats = PLAYER_STATS.filter((s) => playerList.some((p) => p[s] > 0));

  const coaches = new Map<string, CoachStatRow & { keys: Set<string> }>();
  for (const t of teamList) {
    const k = key(t.coach);
    let c = coaches.get(k);
    if (!c) { c = { coach: t.coach, teams: 0, keys: new Set(), ...blankLine() }; coaches.set(k, c); }
    c.keys.add(t.entrantId);
    for (const f of ["games", "wins", "draws", "losses", "points", ...TEAM_STATS] as const) c[f] += t[f];
  }
  const coachList: CoachStatRow[] = [...coaches.values()].map(({ keys, ...c }) => ({ ...c, teams: keys.size }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.coach.localeCompare(b.coach));

  const races = new Map<string, RaceStatRow>();
  for (const t of teamList) {
    const rk = t.race || "Unknown";
    const r = races.get(rk) ?? { race: rk, teams: 0, games: 0, wins: 0, draws: 0, losses: 0, winPct: 0 };
    r.teams += 1; r.games += t.games; r.wins += t.wins; r.draws += t.draws; r.losses += t.losses;
    races.set(rk, r);
  }
  const raceList = [...races.values()].map((r) => ({ ...r, winPct: pct(r) })).sort((a, b) => b.winPct - a.winPct || b.games - a.games || a.race.localeCompare(b.race));

  return {
    tournamentId: tournament.id,
    status: tournament.status,
    totals: {
      games: coverage.games, touchdowns: total("td"), casualties: coverage.casualties ? total("cas") : null,
      teams: teamList.length, coaches: coachList.length, players: playerList.length,
    },
    coverage,
    stats,
    playerStats,
    teams: teamList,
    coaches: coachList,
    races: raceList,
    players: playerList,
    honours: honourBoards(teamList, coachList, playerList, stats, playerStats),
    cards: spotCards(teamList, playerList, stats, playerStats),
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
function sum<T extends object>(list: readonly T[] | undefined, field: keyof T): number {
  return (list ?? []).reduce((n, p) => n + num(p[field]), 0);
}

// ---- honour boards and spotlight cards ------------------------------------------------------------------------------

interface BoardDef<T> { stat: string; title: string; value: (r: T) => number; needs?: TeamStat | PlayerStat; ascending?: true }

const TEAM_BOARDS: ReadonlyArray<BoardDef<TeamStatRow>> = [
  { stat: "td", title: "Most touchdowns", value: (t) => t.td, needs: "td" },
  { stat: "cas", title: "Most casualties caused", value: (t) => t.cas, needs: "cas" },
  { stat: "tdAgainst", title: "Best defence", value: (t) => t.tdAgainst, needs: "tdAgainst", ascending: true },
  { stat: "completions", title: "Most completions", value: (t) => t.completions, needs: "completions" },
  { stat: "interceptions", title: "Most interceptions", value: (t) => t.interceptions, needs: "interceptions" },
  { stat: "fouls", title: "Most fouls", value: (t) => t.fouls, needs: "fouls" },
  { stat: "blocks", title: "Most blocks", value: (t) => t.blocks, needs: "blocks" },
  { stat: "deathsFor", title: "Most kills", value: (t) => t.deathsFor, needs: "deathsFor" },
  { stat: "casAgainst", title: "Most casualties suffered", value: (t) => t.casAgainst, needs: "casAgainst" },
  { stat: "injuriesAgainst", title: "Most injuries suffered", value: (t) => t.injuriesAgainst, needs: "injuriesAgainst" },
  { stat: "deathsAgainst", title: "Most deaths suffered", value: (t) => t.deathsAgainst, needs: "deathsAgainst" },
];
const COACH_BOARDS: ReadonlyArray<BoardDef<CoachStatRow>> = [
  { stat: "points", title: "Most points", value: (c) => c.points },
  { stat: "wins", title: "Most wins", value: (c) => c.wins },
  { stat: "td", title: "Most touchdowns", value: (c) => c.td, needs: "td" },
  { stat: "cas", title: "Most casualties caused", value: (c) => c.cas, needs: "cas" },
  { stat: "tdAgainst", title: "Best defence", value: (c) => c.tdAgainst, needs: "tdAgainst", ascending: true },
  { stat: "completions", title: "Most completions", value: (c) => c.completions, needs: "completions" },
  { stat: "interceptions", title: "Most interceptions", value: (c) => c.interceptions, needs: "interceptions" },
  { stat: "fouls", title: "Most fouls", value: (c) => c.fouls, needs: "fouls" },
];
const PLAYER_BOARDS: ReadonlyArray<BoardDef<PlayerStatRow>> = [
  { stat: "td", title: "Most touchdowns", value: (p) => p.td, needs: "td" },
  { stat: "cas", title: "Most casualties", value: (p) => p.cas, needs: "cas" },
  { stat: "mvp", title: "Most MVPs", value: (p) => p.mvp, needs: "mvp" },
  { stat: "completions", title: "Most completions", value: (p) => p.completions, needs: "completions" },
  { stat: "interceptions", title: "Most interceptions", value: (p) => p.interceptions, needs: "interceptions" },
  { stat: "fouls", title: "Most fouls", value: (p) => p.fouls, needs: "fouls" },
  { stat: "blocks", title: "Most blocks", value: (p) => p.blocks, needs: "blocks" },
];

/** Rows ranked by the stat (competition ranking: 1, 1, 3); counters keep scorers only, Best defence teams that played. */
function ranked<T>(list: readonly T[], def: BoardDef<T>, name: (r: T) => string, eligible: (r: T) => boolean): Array<{ r: T; rank: number }> {
  const rows = list.filter((r) => eligible(r) && (def.ascending || def.value(r) > 0))
    .sort((a, b) => (def.ascending ? def.value(a) - def.value(b) : def.value(b) - def.value(a)) || name(a).localeCompare(name(b)));
  let rank = 0;
  return rows.map((r, i) => {
    if (i === 0 || def.value(r) !== def.value(rows[i - 1]!)) rank = i + 1;
    return { r, rank };
  });
}

export function honourBoards(teams: TeamStatRow[], coaches: CoachStatRow[], players: PlayerStatRow[], stats: readonly TeamStat[], playerStats: readonly PlayerStat[]): HonourBoard[] {
  const out: HonourBoard[] = [];
  const has = (s: TeamStat | undefined) => s === undefined || stats.includes(s as TeamStat);
  for (const d of TEAM_BOARDS) {
    if (!has(d.needs as TeamStat)) continue;
    const rows = ranked(teams, d, (t) => t.team, (t) => t.games > 0).slice(0, BOARD_ROWS_MAX);
    if (rows.length) out.push({ key: `team-${d.stat}`, kind: "team", stat: d.stat, title: d.title, rows: rows.map(({ r, rank }) => ({ rank, name: r.team, team: r.team, coach: r.coach, value: d.value(r) })) });
  }
  for (const d of PLAYER_BOARDS) {
    if (!playerStats.includes(d.needs as PlayerStat)) continue;
    const rows = ranked(players, d, (p) => p.name, () => true).slice(0, BOARD_ROWS_MAX);
    if (rows.length) out.push({ key: `player-${d.stat}`, kind: "player", stat: d.stat, title: d.title, rows: rows.map(({ r, rank }) => ({ rank, name: r.name, team: r.team, coach: r.coach, value: d.value(r) })) });
  }
  for (const d of COACH_BOARDS) {
    if (!has(d.needs as TeamStat)) continue;
    const rows = ranked(coaches, d, (c) => c.coach, (c) => c.games > 0).slice(0, BOARD_ROWS_MAX);
    if (rows.length) out.push({ key: `coach-${d.stat}`, kind: "coach", stat: d.stat, title: d.title, rows: rows.map(({ r, rank }) => ({ rank, name: r.coach, team: "", coach: r.coach, value: d.value(r) })) });
  }
  return out;
}

const PLAYER_CARDS: ReadonlyArray<{ id: string; title: string; stat: PlayerStat; unit: string; icon: string }> = [
  { id: "top-scorer", title: "Top scorer", stat: "td", unit: "TD", icon: "/icons/panel/games.png" },
  { id: "casualties", title: "Casualty leader", stat: "cas", unit: "CAS", icon: "/icons/panel/fixtures.png" },
  { id: "mvp", title: "Most valuable", stat: "mvp", unit: "MVP", icon: "/icons/panel/honours.png" },
  { id: "playmaker", title: "Playmaker", stat: "completions", unit: "Completions", icon: "/icons/panel/stats.png" },
  { id: "interceptor", title: "Interceptor", stat: "interceptions", unit: "Interceptions", icon: "/icons/panel/teams-roster.png" },
  { id: "dirtiest", title: "Dirtiest", stat: "fouls", unit: "Fouls", icon: "" },
];

function spotCards(teams: TeamStatRow[], players: PlayerStatRow[], stats: readonly TeamStat[], playerStats: readonly PlayerStat[]): SpotCard[] {
  const cards: SpotCard[] = [];
  const tiedNames = <T>(rows: Array<{ r: T; rank: number }>, name: (r: T) => string): string[] => rows.slice(1).filter((x) => x.rank === 1).map((x) => name(x.r));
  const teamCard = (id: string, title: string, d: BoardDef<TeamStatRow>, unit: string, icon: string): void => {
    if (!stats.includes(d.needs as TeamStat)) return;
    const rows = ranked(teams, d, (t) => t.team, (t) => t.games > 0);
    const top = rows[0]?.r;
    if (!top) return;
    cards.push({ id, title, value: String(d.value(top)), unit, name: top.team, team: top.team, race: top.race, coach: top.coach, detail: `${top.wins}-${top.draws}-${top.losses} in ${top.games} ${top.games === 1 ? "game" : "games"}`, tied: tiedNames(rows, (t) => t.team), icon });
  };
  for (const c of PLAYER_CARDS.slice(0, 3)) playerCard(c);
  teamCard("best-attack", "Best attack", TEAM_BOARDS[0]!, "TD", "/icons/panel/teams.png");
  teamCard("best-defence", "Best defence", TEAM_BOARDS[2]!, "TD against", "/icons/panel/account.png");
  for (const c of PLAYER_CARDS.slice(3)) playerCard(c);
  return cards;

  function playerCard(c: (typeof PLAYER_CARDS)[number]): void {
    if (!playerStats.includes(c.stat)) return;
    const rows = ranked(players, { stat: c.stat, title: c.title, value: (p) => p[c.stat] }, (p) => p.name, () => true);
    const top = rows[0]?.r;
    if (!top) return;
    cards.push({ id: c.id, title: c.title, value: String(top[c.stat]), unit: c.unit, name: top.name, team: top.team, race: top.race, coach: top.coach, detail: "", tied: tiedNames(rows, (p) => p.name), icon: c.icon });
  }
}

// ---- podium and awards ----------------------------------------------------------------------------------------------

export interface PodiumPlaceView { slot: PodiumSlot; entrantId: string; team: string; coach: string; race: string }

/** Standings without touching the stored cache (reads never write). */
export function finalStandings(data: TournamentDataFileV4, tournamentId: string): TournamentStandingRow[] {
  const t = data.tournaments[tournamentId];
  if (!t) return [];
  const entrants = Object.values(data.entrants).filter((e) => e.tournamentId === tournamentId);
  const matches = Object.values(data.scheduledMatches).filter((m) => m.tournamentId === tournamentId).sort((a, b) => a.id.localeCompare(b.id));
  return calculateStandings(entrants, matches, t.points, t.tiebreakers) as TournamentStandingRow[];
}

/**
 * The podium of a finished tournament (empty before): Champion = 1st in the final standings, Runner-up 2nd, Consolation
 * 3rd. A knockout's last decided game names Champion (winner) and Runner-up (loser); Consolation is then the best-placed
 * remaining team. Only entrants who played count.
 */
export function tournamentPodium(t: TournamentRecord, standings: readonly TournamentStandingRow[], matches: readonly ScheduledMatchRecord[], label: (entrantId: string) => EntrantLabel | undefined): PodiumPlaceView[] {
  if (t.status !== "completed") return [];
  let order = standings.filter((r) => r.played > 0).sort((a, b) => a.rank - b.rank).map((r) => r.entrantId);
  if (t.format === "knockout") {
    const played = countedMatches(matches);
    const last = played.reduce((n, m) => Math.max(n, m.roundNumber), 0);
    const finals = played.filter((m) => m.roundNumber === last);
    const f = finals.length === 1 ? finals[0]! : undefined;
    if (f && f.result!.homeScore !== f.result!.awayScore) {
      const [w, l] = f.result!.homeScore > f.result!.awayScore ? [f.home.entrantId, f.away!.entrantId] : [f.away!.entrantId, f.home.entrantId];
      order = [w, l, ...order.filter((id) => id !== w && id !== l)];
    }
  }
  return PODIUM_SLOTS.flatMap((slot, i) => {
    const id = order[i];
    const l = id ? label(id) : undefined;
    return id && l ? [{ slot, entrantId: id, team: l.team, coach: l.coach, race: l.race }] : [];
  });
}

export interface TournamentAwardView {
  id: string;
  source: "podium" | "custom";
  tournamentId: string;
  title: string;
  icon: string;
  toCoach?: string;
  toTeam?: string;
  entrantId?: string;
  race?: string;
  note: string;
  by?: string;
  at?: string;
  star: boolean;
}

export interface TournamentAwardRecipients {
  teams: Array<{ id: string; name: string; race: string; coach: string }>;
  coaches: Array<{ id: string; name: string }>;
}

export interface TournamentAwardsView {
  revision: number;
  finished: boolean;
  podium: TournamentAwardView[];
  awards: TournamentAwardView[];
  recipients?: TournamentAwardRecipients;
}

const podiumAt = (t: TournamentRecord): string => t.endsAt ?? t.updatedAt;

export function podiumViews(t: TournamentRecord, places: readonly PodiumPlaceView[]): TournamentAwardView[] {
  return places.map((p) => ({
    id: `podium-${p.slot}`, source: "podium", tournamentId: t.id, title: PODIUM_AWARD[p.slot], icon: seasonAwardIcon({ type: PODIUM_AWARD[p.slot] }),
    toCoach: p.coach, toTeam: p.team, entrantId: p.entrantId, ...(p.race ? { race: p.race } : {}),
    note: t.format === "knockout" && p.slot !== "consolation" ? "Final" : "Final standings", at: podiumAt(t), star: p.slot === "champion",
  }));
}

export const customViews = (t: TournamentRecord): TournamentAwardView[] => (t.awards ?? []).map((a) => ({
  id: a.id, source: "custom" as const, tournamentId: t.id, title: a.title, icon: isAwardIcon(a.icon) ? a.icon : "star",
  toCoach: a.toCoach, ...(a.toTeam ? { toTeam: a.toTeam } : {}), ...(a.entrantId ? { entrantId: a.entrantId } : {}), ...(a.race ? { race: a.race } : {}),
  note: a.note, by: a.by, at: a.at, star: false,
})).sort((x, y) => y.at!.localeCompare(x.at!) || x.title.localeCompare(y.title));

export interface TournamentIdentity { coach: string; organizer: boolean; admin: boolean }
const isManager = (t: TournamentRecord, auth: TournamentIdentity | undefined): boolean => Boolean(auth && (auth.admin || isTournamentManager(t, auth.coach)));

export function awardRecipients(entrants: readonly TournamentEntrantRecord[], teamInfo: TeamInfo): TournamentAwardRecipients {
  const coaches = new Map<string, { id: string; name: string }>();
  const teams = entrants.map((e) => {
    const l = entrantLabel(e, teamInfo);
    coaches.set(key(e.coach.ffbCoachId), { id: e.coach.ffbCoachId, name: e.coach.ffbCoachId });
    return { id: e.id, name: l.team, race: l.race, coach: l.coach };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { teams, coaches: [...coaches.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function awardsView(data: TournamentDataFileV4, t: TournamentRecord, teamInfo: TeamInfo, auth: TournamentIdentity | undefined): TournamentAwardsView {
  const entrants = Object.values(data.entrants).filter((e) => e.tournamentId === t.id).sort((a, b) => a.seed - b.seed || a.id.localeCompare(b.id));
  const byId = new Map(entrants.map((e) => [e.id, e]));
  const matches = Object.values(data.scheduledMatches).filter((m) => m.tournamentId === t.id);
  const places = tournamentPodium(t, finalStandings(data, t.id), matches, (id) => { const e = byId.get(id); return e ? entrantLabel(e, teamInfo) : undefined; });
  return {
    revision: t.awardsRevision ?? 0,
    finished: t.status === "completed",
    podium: podiumViews(t, places),
    awards: customViews(t),
    ...(isManager(t, auth) ? { recipients: awardRecipients(entrants, teamInfo) } : {}),
  };
}

/** The signed-in coach's tournament awards (podium places in finished tournaments, custom awards to them), newest first. */
export function myTournamentAwards(store: Pick<TournamentStore, "snapshot">, coach: string, teamInfo: TeamInfo): Array<TournamentAwardView & { tournamentName: string }> {
  const me = key(coach);
  if (!me) return [];
  const data = store.snapshot();
  const out: Array<TournamentAwardView & { tournamentName: string }> = [];
  for (const t of Object.values(data.tournaments)) {
    if (t.status === "cancelled") continue;
    const custom = (t.awards ?? []).some((a) => key(a.toCoach) === me);
    const entered = t.status === "completed" && Object.values(data.entrants).some((e) => e.tournamentId === t.id && key(e.coach.ffbCoachId) === me);
    if (!custom && !entered) continue;
    const view = awardsView(data, t, teamInfo, undefined);
    for (const a of [...view.podium, ...view.awards]) if (key(a.toCoach) === me) out.push({ ...a, tournamentName: t.name });
  }
  out.sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
  return out.slice(0, 50);
}

// ---- routes ---------------------------------------------------------------------------------------------------------

export interface TournamentHonoursDeps {
  store: TournamentStore;
  teamBuild(teamId: string): unknown | undefined;
  /** Counted result rows (TournamentResultStore.list()); absent = scores only. */
  results?(): StoredTournamentResult[];
  notify?: TournamentNotify;
  /** The request's If-Match header (DELETE carries its revision there). */
  ifMatch?: string;
  now?: () => Date;
}

export interface HonoursResult { status: number; body: unknown; headers?: Record<string, string> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): HonoursResult => ({ status, headers: NO_STORE, body: { error, ...extra } });
const ok = (status: number, body: unknown): HonoursResult => ({ status, headers: NO_STORE, body });
const decoded = (v: string): string | undefined => { try { return decodeURIComponent(v); } catch { return undefined; } };
export const awardsLink = (tournamentId: string): string => `/app/tournaments/${encodeURIComponent(tournamentId)}?tab=awards`;

export const TOURNAMENT_HONOURS_PATH = /^\/api\/tournaments\/([^/]+)\/(statistics|awards)(?:\/([^/]+))?$/;

/** The routes this module owns (undefined = not one of them). `path` is already the /api/tournaments spelling. */
export function tournamentHonoursRoutes(method: string, path: string, query: URLSearchParams, auth: TournamentIdentity | undefined, body: unknown, deps: TournamentHonoursDeps): HonoursResult | undefined {
  const m = TOURNAMENT_HONOURS_PATH.exec(path);
  if (!m) return undefined;
  const id = decoded(m[1]!);
  const awardId = m[3] === undefined ? undefined : decoded(m[3]);
  if (!id || (m[3] !== undefined && !awardId)) return fail(400, "Invalid tournament id.");
  const read = method === "GET" || method === "HEAD";
  if (m[2] === "statistics") {
    if (m[3] !== undefined) return undefined;
    if (!read) return fail(405, "Use GET.");
    const data = deps.store.snapshot();
    const t = data.tournaments[id];
    if (!t) return fail(404, "Tournament not found.");
    let rows: StoredTournamentResult[] = [];
    try { rows = deps.results?.() ?? []; } catch { rows = []; }
    return ok(200, tournamentStatistics({
      tournament: t,
      entrants: Object.values(data.entrants).filter((e) => e.tournamentId === id),
      matches: Object.values(data.scheduledMatches).filter((x) => x.tournamentId === id),
      rows,
      teamInfo: deps.teamBuild,
    }));
  }
  if (awardId === undefined && read) {
    const data = deps.store.snapshot();
    const t = data.tournaments[id];
    if (!t) return fail(404, "Tournament not found.");
    return ok(200, awardsView(data, t, deps.teamBuild, auth));
  }
  if (awardId === undefined && method !== "POST") return fail(405, "POST to /awards to give an award.");
  if (awardId !== undefined && method !== "DELETE") return fail(405, "Use DELETE.");
  if (!auth) return fail(401, "Sign in to manage this tournament's awards.");
  const t = deps.store.tournament(id);
  if (!t) return fail(404, "Tournament not found.");
  if (!isManager(t, auth)) return fail(403, "Only this tournament's organisers and site admins can give or remove its awards.");
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const revisionInput = input.revision !== undefined ? input : query.has("revision") ? { revision: /^\d{1,15}$/.test(query.get("revision")!) ? Number(query.get("revision")) : query.get("revision") } : {};
  const current = t.awardsRevision ?? 0;
  const asked = requestRevision(revisionInput, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the awards revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "The awards changed since you opened them. Reload to see the latest.", { revision: current });
  const now = deps.now?.() ?? new Date();
  const view = () => { const data = deps.store.snapshot(); return awardsView(data, data.tournaments[id]!, deps.teamBuild, auth); };
  try {
    if (awardId !== undefined) {
      if (!(t.awards ?? []).some((a) => a.id === awardId)) {
        if (/^podium-/.test(awardId)) return fail(409, "Podium awards follow the final standings and cannot be removed.");
        return fail(404, "Award not found.");
      }
      deps.store.updateAwards(id, asked, (list) => list.filter((a) => a.id !== awardId), now);
      return ok(200, { awards: view() });
    }
    if ((t.awards ?? []).length >= AWARDS_MAX) return fail(409, `A tournament can hold at most ${AWARDS_MAX} awards; remove an old one first.`);
    const title = text(input.title, "title", AWARD_TITLE_MAX, true, "Title");
    if (!isAwardIcon(input.icon)) throw new HonoursError(400, "Pick an icon.", "icon");
    const recipient = parseRecipient(input.recipient, deps.store.entrants(id), deps.teamBuild);
    const note = text(input.note, "note", AWARD_NOTE_MAX, false, "Note");
    const award: TournamentAward = { id: `a-${randomBytes(6).toString("hex")}`, tournamentId: id, title, icon: input.icon, ...recipient, note, by: auth.coach, at: now.toISOString() };
    deps.store.updateAwards(id, asked, (list) => [...list, award], now);
    // The recipient hears about it once, on the write that stored it (never the giver themself).
    if (key(award.toCoach) !== key(auth.coach)) {
      try {
        deps.notify?.coach(award.toCoach, {
          type: "award", title: `${t.name}: ${title}`.slice(0, 120),
          body: `${auth.coach} gave ${award.toTeam ?? "you"} the award "${title}".${note ? ` ${note}` : ""}`.slice(0, 400),
          link: awardsLink(id), from: auth.coach,
        });
      } catch { /* fire-and-forget */ }
    }
    const next = view();
    return ok(201, { award: next.awards.find((a) => a.id === award.id), awards: next });
  } catch (e) {
    if (e instanceof HonoursError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    const status = (e as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 500) return fail(status, (e as Error).message, status === 409 ? { revision: deps.store.tournament(id)?.awardsRevision ?? 0 } : {});
    return fail(500, "Could not save that right now.");
  }
}

/** { kind: "team", teamId: entrantId } | { kind: "coach", coachId: account } against the tournament's entrants. */
export function parseRecipient(input: unknown, entrants: readonly TournamentEntrantRecord[], teamInfo: TeamInfo): Pick<TournamentAward, "toCoach" | "entrantId" | "teamId" | "toTeam" | "race"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HonoursError(400, "Pick who receives the award.", "recipient");
  const r = input as Record<string, unknown>;
  if (r.kind === "team") {
    const e = entrants.find((x) => x.id === r.teamId);
    if (!e) throw new HonoursError(400, "Pick a team of this tournament.", "recipient");
    const l = entrantLabel(e, teamInfo);
    return { toCoach: e.coach.ffbCoachId, entrantId: e.id, teamId: e.teamId, toTeam: l.team, ...(l.race ? { race: l.race } : {}) };
  }
  if (r.kind === "coach") {
    const want = typeof r.coachId === "string" ? key(r.coachId) : "";
    const e = want ? entrants.find((x) => key(x.coach.ffbCoachId) === want) : undefined;
    if (!e) throw new HonoursError(400, "Pick a coach of this tournament.", "recipient");
    return { toCoach: e.coach.ffbCoachId };
  }
  throw new HonoursError(400, "Pick a team or a coach.", "recipient");
}
