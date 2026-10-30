// Game pages (owner 10-30: "Clicking on a recent game should pop the match reporter view for that game and a summary"):
// GET /api/games/:source/:id (public) answers one played game, normalised the same way for every source. Pure: server.ts
// reads the stores and hands the rows in.
//
//   tournament  a fixture with a reported result (id = the fixture id); per-player lines come from the fork game the
//               fixture launched or the tabletop match recorded for it, when the site holds either.
//   tabletop    a tabletop match played out (submitted onwards, never a test match); the match reporter's finished-game
//               summary rides along as `reporter`.
//   online      a fork game in the results store (never a test or tabletop row).
//
// The hero card is built by the Past Games normaliser itself (recentResults over just this game), so the page and the
// card never disagree. Anything not public (draft tournaments, test or unfinished tabletop matches) is a 404.

import type { GamestateTeamResult } from "@bb/fork-ops";
import { recentResults, TABLETOP_LISTED, type GameSource, type RecentInputs, type RecentResult, type RecentSide } from "./recentResults.js";
import type { StoredTournamentResult } from "./tournamentResults.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "./tournaments/types.js";
import type { MatchRecord, MatchState } from "./tabletop/store.js";
import { effectiveEvents, type Side, type TabletopEvent } from "./tabletop/events.js";
import { tallyMatch, type PlayerLine, type PostMatchSummary } from "./tabletop/postMatch.js";
import type { LeagueGameDigest, LeagueGameSide } from "./leagues/store.js";
import type { ReplayEntry } from "./replay/store.js";

export const PER_PLAYER_NOTE = "Per-player stats are recorded for games played through the site.";

/** ResultCard's props (spa/src/components/ResultCard.vue). */
export interface GameCard {
  context: string;
  home: RecentSide;
  away: RecentSide;
  playedAt: string | null;
  href: null;
  concede: "home" | "away" | null;
  suspended: boolean;
}

export interface GamePlayerLine {
  name: string;
  touchdowns: number;
  casualtiesCaused: number;
  completions: number;
  interceptions: number;
  deflections: number;
  mvp: number;
  /** Tabletop, and a league fork game whose full result the league banked (the SPP it applied); the results store carries none. */
  sppEarned?: number;
  sentOff?: boolean;
  /** Tabletop: "SI", "BH", "stat loss MA", ...; a banked league fork game: the server's injury names, e.g. "Seriously Hurt (MNG)". */
  injury?: string;
  /** The player's roster position, when the league season roster names it. */
  position?: string;
  /** Fouls the server counted (fork games and tabletop tallies). */
  fouls?: number;
  /** The server's own injury text marks a missed next game ("(MNG)"). Never derived from a rule. */
  missNextGame?: true;
  /** The player's place in the team's `squad` (the result's own order): tells same-named players apart. */
  index?: number;
}

export interface Tally { name: string; count: number }

export interface GameTeamSummary {
  mvps: string[];
  scorers: Tally[];
  casualtyMakers: Tally[];
  /** Players with at least one line, most SPP-worthy first. */
  players: GamePlayerLine[];
  /** Every player the result lists, in its own order (the reporter's Rosters popout). */
  squad?: GamePlayerLine[];
  casualtiesSuffered: { bh: number; si: number; rip: number } | null;
  /** Fork games: the winnings the server paid (gold). */
  winnings?: number;
  /** A banked league fork game, when its result carried them: the server's fan factor and dedicated-fans change. */
  fanFactor?: number;
  dedicatedFansModifier?: number;
}

export interface GameSummary {
  playedAt: string | null;
  competition: string;
  round: number | null;
  /** The tournament the game counted in, with a link to its Rounds tab. */
  tournament: { id: string; name: string; href: string } | null;
  casualties: { home: number | null; away: number | null };
  concede: "home" | "away" | null;
  /**
   * The server's legal-concession verdict for the conceding side, when a league fixture banked this game's full result
   * (FumbblResult concededLegally). Absent when unknown: never guessed.
   */
  concededLegally?: boolean;
  perPlayer: boolean;
  /** Shown when the game has no per-player lines. */
  note: string | null;
  home: GameTeamSummary | null;
  away: GameTeamSummary | null;
}

/** The match reporter's finished-game summary for one team, public subset (no treasury). */
export interface ReporterSummary {
  postMatch: PostMatchSummary["postMatch"];
  applied: boolean;
  score: { for: number; against: number };
  outcome: "won" | "drawn" | "lost";
  players: Array<Pick<PlayerLine, "id" | "name" | "touchdowns" | "casualtiesCaused" | "completions" | "interceptions" | "deflections" | "mvp" | "sentOff" | "sppEarned" | "injury">>;
  deaths: string[];
  winnings: number;
  fansBefore: number;
  fansAfter: number;
}

/** Tabletop moments are touchdowns, casualties and send-offs; an online game's replay (src/replay) adds the rest. */
export type ReporterMomentKind =
  | "touchdown" | "casualty" | "sendOff"
  | "injury" | "completion" | "interception" | "deflection" | "kickoff" | "weather" | "halfStart" | "concession";

export interface ReporterMoment {
  /** null side: a moment of the whole game (kick-off, weather, half start; replay moments only). */
  half: string | number | null; turn: number | null; side: Side | null; kind: ReporterMomentKind; text: string;
  /** The acting player's name (scorer, casualty-maker, sent-off player), when the recorder names one. */
  player?: string;
  /** A casualty's victim: name and side, and the result as recorded ("SI", "stat loss MA"). */
  victim?: string;
  victimSide?: Side;
  result?: string;
  /** The actor's and the victim's place in their team's `squad` (same-named players stay apart). */
  playerIndex?: number;
  victimIndex?: number;
  /** Replay moments: the apothecary outcome on a casualty, a touchdown awarded on a concession, the concession verdict. */
  apothecary?: string;
  awarded?: true;
  legal?: boolean;
}

export interface GameReporter {
  matchId: string;
  /** The recorder (participants and organisers). */
  href: string;
  state: MatchState;
  summaries: { home: ReporterSummary; away: ReporterSummary } | null;
  moments: ReporterMoment[];
  /** "replay": an online game's moments read from the fork's replay (no recorder behind it; href is the game page). */
  source?: "replay";
}

/** An online game's ordered log: read from the fork's replay ("ready"), still to be read ("pending"), or not readable. */
export type ReplayState = "pending" | "unavailable" | "ready";

export interface GameDetail {
  source: GameSource;
  id: string;
  card: GameCard;
  summary: GameSummary;
  reporter?: GameReporter;
  /** Online games only: the state of the turn-ordered log. */
  replay?: ReplayState;
}

export interface GameTournament {
  id: string;
  name: string;
  matches: readonly ScheduledMatchRecord[];
  entrants: readonly TournamentEntrantRecord[];
}

export interface GameInputs {
  /** Public tournaments only (active / completed / cancelled). */
  tournaments: readonly GameTournament[];
  /** Every retained results-store row. */
  results: readonly StoredTournamentResult[];
  /** The tabletop match(es) this game may involve: the match itself, or those recorded for the fixture. */
  tabletop: RecentInputs["tabletop"];
  forkMeta?: RecentInputs["forkMeta"];
  teamInfo?: RecentInputs["teamInfo"];
  /** Legal-concession verdicts a league fixture banked for this fork game, by fork team id (src/leagues/forkResult.ts). */
  concededLegally?: Readonly<Record<string, boolean>>;
  /** The league fixture's digest of this fork game (positions; SPP, injuries, winnings and fans of a banked full result). */
  leagueGame?: LeagueGameDigest;
  /** Online games: the replay cache's entry for this game (src/replay/store.ts) and the job's state for it. */
  replay?: { state: ReplayState; entry?: ReplayEntry };
}

/** /api/games/<source>/<id> -> its parts, or undefined (the id is URL-decoded and kept to a safe alphabet). */
export function parseGamePath(path: string): { source: GameSource; id: string } | undefined {
  const m = /^\/api\/games\/(tournament|tabletop|online)\/([^/]{1,240})$/.exec(path);
  if (!m) return undefined;
  let id: string;
  try { id = decodeURIComponent(m[2]!); } catch { return undefined; }
  return /^[\w.:-]{1,160}$/.test(id) ? { source: m[1] as GameSource, id } : undefined;
}

const isForkRow = (row: StoredTournamentResult): boolean => row.test !== true && (row.source === undefined || row.source === "fork");
const listedTabletop = (m: MatchRecord): boolean => !m.test && TABLETOP_LISTED.has(m.state);
const roundsHref = (tournamentId: string): string => `/app/tournaments/${encodeURIComponent(tournamentId)}?tab=rounds`;

function findFixture(tournaments: readonly GameTournament[], pred: (m: ScheduledMatchRecord) => boolean): { t: GameTournament; m: ScheduledMatchRecord } | undefined {
  for (const t of tournaments) for (const m of t.matches) if (m.away && m.result && pred(m)) return { t, m };
  return undefined;
}

const toCard = (r: RecentResult): GameCard => ({
  context: r.context, home: r.home, away: r.away, playedAt: r.playedAt, href: null, concede: r.concede, suspended: r.suspended,
});

const byCount = (a: Tally, b: Tally) => b.count - a.count || a.name.localeCompare(b.name);
const tallies = (lines: readonly GamePlayerLine[], key: "touchdowns" | "casualtiesCaused"): Tally[] =>
  lines.filter((l) => l[key] > 0).map((l) => ({ name: l.name, count: l[key] })).sort(byCount);
const weight = (l: GamePlayerLine) => l.sppEarned ?? l.touchdowns * 3 + l.casualtiesCaused * 2 + l.completions + l.interceptions * 2 + l.deflections + l.mvp * 4;

function teamSummary(input: GamePlayerLine[], suffered: GameTeamSummary["casualtiesSuffered"], extra: Partial<GameTeamSummary> = {}): GameTeamSummary {
  const lines = input.map((l, index) => ({ ...l, index }));
  const players = lines
    .filter((l) => l.touchdowns || l.casualtiesCaused || l.completions || l.interceptions || l.deflections || l.mvp || l.sentOff || l.injury)
    .sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
  return {
    mvps: lines.filter((l) => l.mvp > 0).map((l) => l.name),
    scorers: tallies(lines, "touchdowns"),
    casualtyMakers: tallies(lines, "casualtiesCaused"),
    players,
    squad: lines,
    casualtiesSuffered: suffered,
    ...extra,
  };
}

const MNG_TEXT = /\bMNG\b/i;
const forkLines = (team: GamestateTeamResult | undefined, league?: LeagueGameSide): GamePlayerLine[] =>
  (Array.isArray(team?.players) ? team!.players : []).map((p) => {
    const extra = p.playerId ? league?.players[p.playerId] : undefined;
    const injuries = extra?.injuries ?? [];
    return {
      name: p.name || "Unnamed player",
      touchdowns: p.touchdowns || 0, casualtiesCaused: p.casualtiesCaused || 0, completions: p.completions || 0,
      interceptions: p.interceptions || 0, deflections: p.deflections || 0, mvp: p.mvp || 0,
      ...(typeof p.fouls === "number" ? { fouls: p.fouls } : {}),
      ...(extra?.position ? { position: extra.position } : {}),
      ...(typeof extra?.spp === "number" ? { sppEarned: extra.spp } : {}),
      ...(injuries.length ? { injury: injuries.join(", ") } : {}),
      ...(injuries.some((i) => MNG_TEXT.test(i)) ? { missNextGame: true as const } : {}),
    };
  });
/** A fork side's team-level extras: the results store's winnings, a banked league result's fan factor and dedicated-fans change. */
const forkExtras = (team: GamestateTeamResult | undefined, league?: LeagueGameSide): Partial<GameTeamSummary> => ({
  ...(typeof team?.winnings === "number" ? { winnings: team.winnings } : {}),
  ...(typeof league?.fanFactor === "number" ? { fanFactor: league.fanFactor } : {}),
  ...(typeof league?.dedicatedFansModifier === "number" ? { dedicatedFansModifier: league.dedicatedFansModifier } : {}),
});

const injuryText = (i: PlayerLine["injury"]): string | undefined => (i ? `${i.result}${i.stat ? ` ${i.stat}` : ""}` : undefined);
const tabletopLines = (players: readonly PlayerLine[]): GamePlayerLine[] =>
  players.map((l) => ({
    name: l.name, touchdowns: l.touchdowns, casualtiesCaused: l.casualtiesCaused, completions: l.completions,
    interceptions: l.interceptions, deflections: l.deflections, mvp: l.mvp, sppEarned: l.sppEarned,
    ...(typeof l.fouls === "number" ? { fouls: l.fouls } : {}),
    ...(l.sentOff ? { sentOff: true } : {}), ...(l.injury ? { injury: injuryText(l.injury) } : {}),
  }));

const publicSummary = (s: PostMatchSummary): ReporterSummary => ({
  postMatch: s.postMatch, applied: s.applied, score: { ...s.score }, outcome: s.outcome,
  players: s.players.map((l) => ({
    id: l.id, name: l.name, touchdowns: l.touchdowns, casualtiesCaused: l.casualtiesCaused, completions: l.completions,
    interceptions: l.interceptions, deflections: l.deflections, mvp: l.mvp, sentOff: l.sentOff, sppEarned: l.sppEarned,
    ...(l.injury ? { injury: { ...l.injury } } : {}),
  })),
  deaths: [...s.deaths], winnings: s.winnings, fansBefore: s.fansBefore, fansAfter: s.fansAfter,
});

/** The tabletop match's per-side player lines: the confirmed preview's (named), else the raw tally's. */
function tabletopPlayers(match: MatchRecord, events: readonly TabletopEvent[]): Record<Side, PlayerLine[]> {
  if (match.preview) return { home: match.preview.home.players, away: match.preview.away.players };
  const t = tallyMatch(events);
  return { home: [...t.lines.home.values()], away: [...t.lines.away.values()] };
}

/** Touchdowns, casualties and send-offs in match order, worded with the reporter's player names. */
function moments(events: readonly TabletopEvent[], players: Record<Side, PlayerLine[]>, teamName: Record<Side, string>): ReporterMoment[] {
  const names: Record<Side, Map<string, string>> = { home: new Map(players.home.map((l) => [l.id, l.name])), away: new Map(players.away.map((l) => [l.id, l.name])) };
  const named = (side: Side, id: unknown): string | undefined => (typeof id === "string" && names[side].get(id)) || undefined;
  const indexOf = (side: Side, id: unknown): number => (typeof id === "string" ? players[side].findIndex((l) => l.id === id) : -1);
  const who = (side: Side, id: unknown) => named(side, id) ?? `a ${teamName[side]} player`;
  const out: ReporterMoment[] = [];
  for (const e of effectiveEvents(events)) {
    const at = { half: e.half ?? null, turn: typeof e.turn === "number" ? e.turn : null, side: e.team };
    const actor = named(e.team, e.player);
    const ai = indexOf(e.team, e.player);
    const by = actor ? { player: actor, ...(ai >= 0 ? { playerIndex: ai } : {}) } : {};
    if (e.type === "touchdown") out.push({ ...at, kind: "touchdown", text: `Touchdown: ${who(e.team, e.player)}`, ...by });
    else if (e.type === "sendOff") out.push({ ...at, kind: "sendOff", text: `Sent off: ${who(e.team, e.player)}`, ...by });
    else if (e.type === "casualty") {
      const victimSide = (e.payload.victimTeam as Side | undefined) ?? (e.team === "home" ? "away" : "home");
      const result = `${String(e.payload.result ?? "")}${e.payload.stat ? ` ${String(e.payload.stat)}` : ""}`.trim();
      const byText = e.player ? `${who(e.team, e.player)} on ` : "";
      const victim = named(victimSide, e.payload.victim);
      const vi = indexOf(victimSide, e.payload.victim);
      out.push({
        ...at, kind: "casualty", text: `Casualty: ${byText}${who(victimSide, e.payload.victim)}${result ? ` (${result})` : ""}`, ...by,
        victimSide, ...(victim ? { victim, ...(vi >= 0 ? { victimIndex: vi } : {}) } : {}), ...(result ? { result } : {}),
      });
    }
  }
  return out;
}

function reporterFor(match: MatchRecord, events: readonly TabletopEvent[]): GameReporter {
  const players = tabletopPlayers(match, events);
  return {
    matchId: match.id,
    href: `/app/tabletop/${encodeURIComponent(match.id)}`,
    state: match.state,
    summaries: match.preview ? { home: publicSummary(match.preview.home), away: publicSummary(match.preview.away) } : null,
    moments: moments(events, players, { home: match.home.teamName || "home", away: match.away.teamName || "away" }),
  };
}

const flip = <S extends Side | null>(side: S): S => (side === null ? side : side === "home" ? "away" : "home") as S;
/** A recorder-ordered reporter read in the opposite home/away order (a fixture that lists the coaches swapped). */
const swapReporter = (r: GameReporter): GameReporter => ({
  ...r,
  summaries: r.summaries ? { home: r.summaries.away, away: r.summaries.home } : null,
  moments: r.moments.map((m) => ({ ...m, side: flip(m.side), ...(m.victimSide ? { victimSide: flip(m.victimSide) } : {}) })),
});

function baseSummary(card: GameCard, round: number | null, tournament: GameSummary["tournament"]): GameSummary {
  return {
    playedAt: card.playedAt, competition: card.context, round, tournament,
    casualties: { home: card.home.cas, away: card.away.cas }, concede: card.concede,
    perPlayer: false, note: PER_PLAYER_NOTE, home: null, away: null,
  };
}

function withLines(s: GameSummary, home: GameTeamSummary, away: GameTeamSummary): GameSummary {
  const any = home.players.length > 0 || away.players.length > 0;
  return { ...s, perPlayer: true, note: any ? null : "No player recorded a touchdown, casualty or award in this game.", home, away };
}

function withTabletop(s: GameSummary, row: RecentInputs["tabletop"][number]): GameSummary {
  const players = tabletopPlayers(row.match, row.events);
  const suffered = row.match.preview
    ? { home: row.match.preview.home.casualtiesSuffered ?? null, away: row.match.preview.away.casualtiesSuffered ?? null }
    : (() => { const t = tallyMatch(row.events); return { home: t.casualtiesSuffered.home, away: t.casualtiesSuffered.away }; })();
  return withLines(s, teamSummary(tabletopLines(players.home), suffered.home), teamSummary(tabletopLines(players.away), suffered.away));
}

function withFork(s: GameSummary, row: StoredTournamentResult, swap = false, league?: LeagueGameDigest): GameSummary {
  const teams = Array.isArray(row.teams) ? row.teams : [];
  let h = teams.find((t) => t.teamId === row.home.teamId);
  let a = teams.find((t) => t.teamId === row.away.teamId);
  if (swap) [h, a] = [a, h];
  const lg = (t: GamestateTeamResult | undefined) => (t ? league?.teams[t.teamId] : undefined);
  return withLines(
    s,
    teamSummary(forkLines(h, lg(h)), h?.casualtiesSuffered ?? null, forkExtras(h, lg(h))),
    teamSummary(forkLines(a, lg(a)), a?.casualtiesSuffered ?? null, forkExtras(a, lg(a))),
  );
}

/**
 * An online game's replay moments as the game page's reporter: sides follow the result row (the replay's home team is
 * the row's home team, else the sides are read swapped; a replay naming neither pairing is not used), names and squad
 * indexes come from the result's own player list by player id, the replay's name only for a player the result does
 * not list. Undefined when the cache holds no ready replay for this row.
 */
export function replayReporter(row: StoredTournamentResult, entry: ReplayEntry | undefined): GameReporter | undefined {
  if (!entry || entry.status !== "ready") return undefined;
  const ids = { home: row.home.teamId, away: row.away.teamId };
  const swap = entry.teams.home.teamId === ids.away && entry.teams.away.teamId === ids.home;
  if (!swap && (entry.teams.home.teamId !== ids.home || entry.teams.away.teamId !== ids.away)) return undefined;
  const side = <S extends Side | null>(s: S): S => (swap ? flip(s) : s);
  const teams = Array.isArray(row.teams) ? row.teams : [];
  const squads: Record<Side, ReadonlyArray<{ playerId?: string; name: string }>> = {
    home: teams.find((t) => t.teamId === ids.home)?.players ?? [],
    away: teams.find((t) => t.teamId === ids.away)?.players ?? [],
  };
  const resolve = (s: Side | null | undefined, id: string | undefined, fallback: string | undefined): { name?: string; index?: number } => {
    const index = s && id ? squads[s].findIndex((p) => p.playerId === id) : -1;
    if (index >= 0) return { name: squads[s!][index]!.name || fallback, index };
    return fallback ? { name: fallback } : {};
  };
  const moments: ReporterMoment[] = entry.moments.map((m) => {
    const s = side(m.side);
    const actor = resolve(s, m.playerId, m.player);
    const vs = m.victimSide ? side(m.victimSide) : undefined;
    const victim = resolve(vs, m.victimId, m.victim);
    // the reader's text; a name the result spells differently replaces the replay's
    let text = m.text;
    if (actor.name && m.player && actor.name !== m.player) text = text.replace(m.player, actor.name);
    if (victim.name && m.victim && victim.name !== m.victim) text = text.replace(m.victim, victim.name);
    return {
      half: m.half, turn: m.turn, side: s, kind: m.kind, text,
      ...(actor.name ? { player: actor.name } : {}), ...(actor.index !== undefined ? { playerIndex: actor.index } : {}),
      ...(vs ? { victimSide: vs } : {}), ...(victim.name ? { victim: victim.name } : {}), ...(victim.index !== undefined ? { victimIndex: victim.index } : {}),
      ...(m.result && (m.kind === "casualty" || m.kind === "injury") ? { result: m.result } : {}),
      ...(m.apothecary ? { apothecary: m.apothecary } : {}), ...(m.awarded ? { awarded: true as const } : {}),
      ...(typeof m.legal === "boolean" ? { legal: m.legal } : {}),
    };
  });
  return { matchId: row.gameId, href: `/app/games/online/${encodeURIComponent(row.gameId)}`, state: "published", summaries: null, moments, source: "replay" };
}

/** One played game, or undefined (unknown, not public, or not played). */
export function gameDetail(source: GameSource, id: string, inputs: GameInputs): GameDetail | undefined {
  const common = { forkMeta: inputs.forkMeta, teamInfo: inputs.teamInfo };
  if (source === "tournament") {
    const hit = findFixture(inputs.tournaments, (m) => m.id === id);
    if (!hit) return undefined;
    const { t, m } = hit;
    const forkRow = m.launch?.gameId ? inputs.results.find((r) => r.gameId === m.launch.gameId && isForkRow(r)) : undefined;
    const [card] = recentResults({ ...common, results: forkRow ? [forkRow] : [], tournaments: [{ ...t, matches: [m] }], tabletop: [] }, 1);
    if (!card) return undefined;
    const gameCard = toCard(card);
    let summary = baseSummary(gameCard, m.roundNumber, { id: t.id, name: t.name, href: roundsHref(t.id) });
    const recorded = inputs.tabletop.find((r) => r.match.fixtureRef === m.id && listedTabletop(r.match));
    let reporter: GameReporter | undefined;
    if (recorded) {
      // A tabletop match recorded for this fixture: its sides follow the match, which may list the coaches swapped.
      const swapped = recorded.match.fixtureSwap === true;
      summary = withTabletop(summary, recorded);
      reporter = reporterFor(recorded.match, recorded.events);
      if (swapped) {
        // The page reads in fixture order: the summary, the reporter's two summaries and each moment's side all flip.
        summary = { ...summary, home: summary.away, away: summary.home };
        reporter = swapReporter(reporter);
      }
    } else if (forkRow) {
      summary = withFork(summary, forkRow, forkRow.home.coach.trim().toLowerCase() !== m.home.coach.ffbCoachId.trim().toLowerCase() &&
        forkRow.away.coach.trim().toLowerCase() === m.home.coach.ffbCoachId.trim().toLowerCase(), inputs.leagueGame);
    }
    return { source, id, card: gameCard, summary, ...(reporter ? { reporter } : {}) };
  }

  if (source === "tabletop") {
    const row = inputs.tabletop.find((r) => r.match.id === id);
    if (!row || !listedTabletop(row.match)) return undefined;
    const fixture = row.match.fixtureRef ? findFixture(inputs.tournaments, (m) => m.id === row.match.fixtureRef) : undefined;
    const [card] = recentResults({ ...common, results: [], tabletop: [row], tournaments: fixture ? [{ ...fixture.t, matches: [fixture.m] }] : [] }, 1);
    if (!card) return undefined;
    const gameCard = toCard(card);
    const summary = withTabletop(
      baseSummary(gameCard, fixture?.m.roundNumber ?? null, fixture ? { id: fixture.t.id, name: fixture.t.name, href: roundsHref(fixture.t.id) } : null),
      row,
    );
    return { source, id, card: gameCard, summary, reporter: reporterFor(row.match, row.events) };
  }

  const row = inputs.results.find((r) => r.gameId === id && isForkRow(r));
  if (!row) return undefined;
  const [card] = recentResults({ ...common, results: [row], tournaments: [], tabletop: [] }, 1);
  if (!card) return undefined;
  const gameCard = toCard(card);
  const fixture = findFixture(inputs.tournaments, (m) => m.launch?.gameId === id);
  const summary = withFork(
    baseSummary(gameCard, fixture?.m.roundNumber ?? null, fixture ? { id: fixture.t.id, name: fixture.t.name, href: roundsHref(fixture.t.id) } : null),
    row,
    false,
    inputs.leagueGame,
  );
  const conceder = summary.concede ? row[summary.concede]?.teamId : undefined;
  const verdict = conceder ? inputs.concededLegally?.[conceder] : undefined;
  if (typeof verdict === "boolean") summary.concededLegally = verdict;
  const reporter = replayReporter(row, inputs.replay?.entry);
  const replay: ReplayState = reporter ? "ready" : inputs.replay?.state === "pending" ? "pending" : "unavailable";
  return { source, id, card: gameCard, summary, ...(reporter ? { reporter } : {}), replay };
}

