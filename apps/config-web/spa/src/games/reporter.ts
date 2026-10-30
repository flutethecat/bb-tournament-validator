// Game page (owner 10-30: "Clicking a game should open the Match reporter view that we currently have but with a completed
// state"): GameDetail -> the recorder's own shapes (MatchView, TeamView, ServerTally, RecordedEvent, feed rows), so the
// read-only page drives the recorder's scoreboard, timeline, Match log, summaries and Rosters popout unchanged.
//
// SERVER-DERIVED: every row comes from something the server sent. A tabletop match's key moments carry their half and
// turn (the log is in match order); an online (fork) game's result has no order at all, so its log is built from the
// result's counters with no half or turn, under a heading that says so. Nothing is invented: no turn, no SPP total, no
// casualty victim the result did not name.

import type { FinalBoard, MatchSummaryView, SummaryPlayerLine } from "../tabletop/finished";
import { feedRows, type FeedRow } from "../tabletop/feed";
import type { MatchView, PlayerLineView, RecordedEvent, RosterPlayerView, ServerTally, Side, TeamView } from "../tabletop/recorder";
import type { GameDetail, GamePlayerLine, GameTeamSummary } from "./detail";

export const ORDERED_LOG_TITLE = "Match log";
export const RESULT_LOG_TITLE = "Match log (from the game result; order not recorded)";
export const NO_LOG_NOTE = "No match log for this fixture";

export interface ReporterModel {
  match: MatchView;
  teams: Record<Side, TeamView>;
  tally: ServerTally;
  events: RecordedEvent[];
  /** Newest first, as the recorder's feed shows them. */
  rows: FeedRow[];
  /** The log carries half and turn (tabletop moments); false for a result-only log. */
  ordered: boolean;
  /** False when the game has no player events to log (a tournament fixture reported without player data); a concession still shows as a row. */
  hasLog: boolean;
  logTitle: string;
  summaries: Array<{ side: Side; heading: string; summary: MatchSummaryView }>;
  final: FinalBoard;
  /** The final-result line of the log ("Final: Reavers 2-1 Grinders"). */
  finalLine: string;
}

const SIDES: Side[] = ["home", "away"];
const DEAD = /\b(dead|rip|death)\b/i;
const other = (s: Side): Side => (s === "home" ? "away" : "home");

/**
 * Players of one side. A player is found by the server's squad index first; by name only when no index came, and then
 * only when exactly one player wears that name. Two or more same-named players with no index: the row gets a name-only
 * stand-in (no position, sprite or line), never a guess at which of them it was.
 */
class Squad {
  readonly players: RosterPlayerView[] = [];
  private byIndex = new Map<number, string>();
  private byName = new Map<string, string[]>();
  private nameOnly = new Map<string, string>();
  constructor(private readonly side: Side) {}
  private push(name: string, extra: Partial<RosterPlayerView>): string {
    const id = `${this.side}-${this.players.length + 1}`;
    this.players.push({ id, name, spp: 0, mng: false, dead: false, ...extra });
    return id;
  }
  /** A listed player (the squad, or the lines the server kept), keyed by its squad index when it has one. */
  add(name: string, extra: Partial<RosterPlayerView> = {}, index?: number): string {
    const id = this.push(name, extra);
    if (typeof index === "number") this.byIndex.set(index, id);
    this.byName.set(name, [...(this.byName.get(name) ?? []), id]);
    return id;
  }
  idOf(name: string | undefined, index?: number): string | undefined {
    if (typeof index === "number" && this.byIndex.has(index)) return this.byIndex.get(index);
    if (!name) return undefined;
    const ids = this.byName.get(name) ?? [];
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) return this.add(name);
    // ambiguous: a name-only stand-in, kept out of the roster list
    let id = this.nameOnly.get(name);
    if (!id) {
      id = `${this.side}-n${this.nameOnly.size + 1}`;
      this.nameOnly.set(name, id);
      this.ghosts.push({ id, name, spp: 0, mng: false, dead: false });
    }
    return id;
  }
  /** Name-only stand-ins (feed lookups only; never listed in the Rosters popout). */
  readonly ghosts: RosterPlayerView[] = [];
}

const rosterExtra = (p: GamePlayerLine): Partial<RosterPlayerView> => ({
  ...(p.position ? { position: p.position } : {}),
  ...(p.injury ? { injuries: [p.injury], dead: DEAD.test(p.injury) } : {}),
  ...(p.missNextGame ? { mng: true } : {}),
});

const playerLine = (id: string, p: GamePlayerLine): PlayerLineView => ({
  id, name: p.name, touchdowns: p.touchdowns, casualtiesCaused: p.casualtiesCaused, completions: p.completions, interceptions: p.interceptions,
  deflections: p.deflections, mvp: p.mvp, sentOff: p.sentOff === true, sppEarned: p.sppEarned ?? 0, ...(typeof p.fouls === "number" ? { fouls: p.fouls } : {}),
});

const summaryLine = (id: string, p: GamePlayerLine): SummaryPlayerLine => ({
  id, name: p.name, touchdowns: p.touchdowns, casualtiesCaused: p.casualtiesCaused, completions: p.completions, interceptions: p.interceptions,
  deflections: p.deflections, mvp: p.mvp, sentOff: p.sentOff === true,
  ...(p.sppEarned !== undefined ? { sppEarned: p.sppEarned } : {}),
  ...(p.position ? { position: p.position } : {}),
  ...(p.injury ? { injury: { result: p.injury, apothecaryUsed: false } } : {}),
});

const outcome = (f: number, a: number): "won" | "drawn" | "lost" => (f > a ? "won" : f < a ? "lost" : "drawn");

/** The game page's GameDetail as the recorder's shapes (read-only, finished). */
export function reporterModel(game: GameDetail): ReporterModel {
  const { card, summary, reporter } = game;
  const squads: Record<Side, Squad> = { home: new Squad("home"), away: new Squad("away") };
  const lines: Record<Side, PlayerLineView[]> = { home: [], away: [] };
  const teamOf = (s: Side): GameTeamSummary | null => summary[s];
  // every listed player: the squad (all of them), else the lines the server kept
  for (const s of SIDES) {
    const t = teamOf(s);
    for (const p of t?.squad ?? t?.players ?? []) {
      const id = squads[s].add(p.name, rosterExtra(p), p.index);
      lines[s].push(playerLine(id, p));
    }
  }

  let seq = 0;
  const ev = (type: string, team: Side, extra: Partial<RecordedEvent> & { half?: number | string; turn?: number } = {}): RecordedEvent =>
    ({ id: `r${++seq}`, type, team, payload: {}, ...extra }) as RecordedEvent;
  /** In reading order (top first); the recorder's feed wants oldest first, so ordered logs keep it and the result log is flipped. */
  const events: RecordedEvent[] = [];
  const ordered = !!reporter;

  if (reporter) {
    // Tabletop: the recorder's key moments in match order, each with its half and turn.
    for (const m of reporter.moments) {
      const at = { ...(m.half !== null ? { half: m.half } : {}), ...(m.turn !== null ? { turn: m.turn } : {}) };
      const player = squads[m.side].idOf(m.player, m.playerIndex);
      const by = player ? { player } : {};
      if (m.kind === "touchdown") events.push(ev("touchdown", m.side, { ...at, ...by }));
      else if (m.kind === "sendOff") events.push(ev("sendOff", m.side, { ...at, ...by }));
      else {
        const vs = m.victimSide ?? other(m.side);
        const victim = squads[vs].idOf(m.victim, m.victimIndex);
        events.push(ev("casualty", m.side, { ...at, ...by, payload: { ...(victim ? { victim } : {}), victimTeam: vs, ...(m.result ? { result: m.result } : {}) } }));
      }
    }
  } else if (summary.perPlayer) {
    // Online (fork result): counters only, grouped; no half or turn.
    const result: RecordedEvent[] = [];
    for (const s of SIDES) for (const p of teamOf(s)?.squad ?? teamOf(s)?.players ?? []) {
      const id = squads[s].idOf(p.name, p.index)!;
      for (let i = 0; i < p.touchdowns; i++) result.push(ev("touchdown", s, { player: id }));
    }
    for (const s of SIDES) for (const p of teamOf(s)?.squad ?? teamOf(s)?.players ?? []) {
      const id = squads[s].idOf(p.name, p.index)!;
      for (let i = 0; i < p.casualtiesCaused; i++) result.push(ev("casualty", s, { player: id }));
    }
    for (const s of SIDES) {
      for (const p of teamOf(s)?.squad ?? teamOf(s)?.players ?? []) {
        if (p.injury) result.push(ev("injury", s, { player: squads[s].idOf(p.name, p.index)!, payload: { result: p.injury } }));
      }
      const c = teamOf(s)?.casualtiesSuffered;
      if (c && c.bh + c.si + c.rip > 0) result.push(ev("casualtiesSuffered", s, { payload: { ...c } }));
    }
    events.push(...result);
  }
  // Both: MVPs (no turn: the award is made after the game), then the concession, money and fans.
  if (summary.perPlayer) {
    for (const s of SIDES) for (const p of teamOf(s)?.squad ?? teamOf(s)?.players ?? []) {
      if (p.mvp > 0) events.push(ev("mvp", s, { player: squads[s].idOf(p.name, p.index)!, payload: { count: p.mvp } }));
    }
  } else {
    // player lines withheld: the MVP names the server still sends
    for (const s of SIDES) for (const name of teamOf(s)?.mvps ?? []) events.push(ev("mvp", s, { player: squads[s].idOf(name)! }));
  }
  const playerEvents = events.length;
  if (summary.concede) {
    events.push(ev("concede", summary.concede, { payload: summary.concededLegally !== undefined ? { legal: summary.concededLegally } : {} }));
  }
  if (!reporter) {
    for (const s of SIDES) {
      const t = teamOf(s);
      if (t?.winnings) events.push(ev("winnings", s, { payload: { amount: t.winnings } }));
      if (t?.dedicatedFansModifier) events.push(ev("fanChange", s, { payload: { delta: t.dedicatedFansModifier } }));
    }
  }
  // the feed reverses its input (newest first): an ordered log goes in as recorded; the result log goes in flipped so it reads top-down
  const input = ordered ? events : [...events].reverse();

  const match: MatchView = {
    id: `${game.source}:${game.id}`, state: "published", postMatch: "none", createdBy: "", confirmations: {},
    home: { coach: card.home.coach, teamSaveId: "", teamName: card.home.name },
    away: { coach: card.away.coach, teamSaveId: "", teamName: card.away.name },
  };
  const crest = (url: string | null): Partial<TeamView> => (url && /^\/(?!\/)[\w./-]+$/.test(url) ? { avatarUrl: url } : {});
  const teams: Record<Side, TeamView> = {
    home: { name: card.home.name, race: card.home.race || undefined, players: squads.home.players, ...crest(card.home.crestUrl) },
    away: { name: card.away.name, race: card.away.race || undefined, players: squads.away.players, ...crest(card.away.crestUrl) },
  };
  const tally: ServerTally = {
    score: { home: card.home.score ?? 0, away: card.away.score ?? 0 }, fanDelta: { home: 0, away: 0 },
    casualtiesSuffered: { home: teamOf("home")?.casualtiesSuffered ?? { bh: 0, si: 0, rip: 0 }, away: teamOf("away")?.casualtiesSuffered ?? { bh: 0, si: 0, rip: 0 } },
    players: lines,
  };
  const anyFouls = SIDES.some((s) => lines[s].some((l) => typeof l.fouls === "number"));
  const final: FinalBoard = {
    score: { home: card.home.score, away: card.away.score },
    cas: { home: card.home.cas, away: card.away.cas },
    fouls: anyFouls ? { home: lines.home.reduce((n, l) => n + (l.fouls ?? 0), 0), away: lines.away.reduce((n, l) => n + (l.fouls ?? 0), 0) } : null,
    concede: summary.concede ?? card.concede ?? null,
  };
  // the feed also resolves name-only stand-ins (ambiguous names); the Rosters popout lists only the real players
  const feedTeams: Record<Side, TeamView> = {
    home: { ...teams.home, players: [...squads.home.players, ...squads.home.ghosts] },
    away: { ...teams.away, players: [...squads.away.players, ...squads.away.ghosts] },
  };

  const heading = (s: Side): string => `${s === "home" ? "Home" : "Away"}: ${card[s].name}${card[s].coach ? ` (${card[s].coach})` : ""}`;
  let summaries: ReporterModel["summaries"] = [];
  if (reporter?.summaries) {
    summaries = SIDES.map((s) => ({ side: s, heading: heading(s), summary: reporter.summaries![s] }));
  } else if (summary.perPlayer && card.home.score !== null && card.away.score !== null) {
    summaries = SIDES.map((s) => {
      const t = teamOf(s);
      const f = card[s].score as number, a = card[other(s)].score as number;
      const players = (t?.players ?? []).map((p) => summaryLine(squads[s].idOf(p.name, p.index)!, p));
      return {
        side: s, heading: heading(s),
        summary: {
          outcome: outcome(f, a), score: { for: f, against: a }, players,
          deaths: (t?.players ?? []).filter((p) => p.injury && DEAD.test(p.injury)).map((p) => p.name),
          ...(typeof t?.winnings === "number" ? { winnings: t.winnings } : {}),
          ...(typeof t?.fanFactor === "number" ? { fanFactor: t.fanFactor } : {}),
          ...(typeof t?.dedicatedFansModifier === "number" ? { fansChange: t.dedicatedFansModifier } : {}),
        },
      };
    });
  }

  const scoreText = card.home.score !== null && card.away.score !== null ? ` ${card.home.score}-${card.away.score} ` : " vs ";
  return {
    match, teams, tally, events: input,
    rows: feedRows(input, input.map((e) => e.id), feedTeams, {}, match, null),
    ordered,
    hasLog: playerEvents > 0 || !!reporter || summary.perPlayer,
    logTitle: ordered ? ORDERED_LOG_TITLE : RESULT_LOG_TITLE,
    summaries,
    final,
    finalLine: `Final: ${card.home.name}${scoreText}${card.away.name}${final.concede ? ` · ${card[final.concede].name} conceded` : ""}`,
  };
}
