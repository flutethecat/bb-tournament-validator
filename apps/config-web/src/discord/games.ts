/**
 * A finished game as the Discord posts see it, built ONLY from a recorded game (laws 15, owner round 3: "in-game events
 * only from recorded games"):
 *
 *   tabletopGame   the tabletop recorder's effective event log (undo already resolved) + the two rosters for names
 *   forkGame       a Super FUMBBL result banked on a league fixture (FixtureForkResult: per-player counters and the
 *                  serious injuries the server recorded)
 *
 * Nothing here reads a hand-entered score: an organiser's result entry has no game record, so it has no digest (and is not
 * announced at all). Data each source carries today:
 *
 *   event       tabletop recorder                      Super FUMBBL result
 *   touchdown   touchdown events                       per-player td
 *   casualty    casualty events (causer + victim)      per-player cas (count; no victim)
 *   injury      injury / casualty lasting results      serious injuries the server recorded (not deaths)
 *   death       casualty / injury result DEAD          serious injury "Dead (RIP)"
 *   foul        foul events                            per-player fouls
 *   sentOff     sendOff events                         - (the result carries none)
 *   mvp         mvp events                             per-player mvp
 *   hireFire    -                                      - (no source records hiring or firing yet)
 */
import { effectiveEvents, otherSide, type Side, type TabletopEvent } from "../tabletop/events.js";
import type { FixtureForkResult, LeagueFixture } from "../leagues/types.js";
import type { InGameKey } from "./catalogue.js";

export type GameSide = Side;

/** One in-game line: a player (by name, or by number when names are not public), a count, and detail. */
export interface GameLine {
  side: GameSide;
  player: string;
  count: number;
  /** casualty / injury result ("BH", "MNG", "Seriously Hurt (MNG)"...). */
  detail?: string;
  /** casualty: the player hurt. */
  victim?: { side: GameSide; player: string };
}

export interface GameComment { side: GameSide; coach: string; text: string }

export interface GameRecord {
  /** "tabletop:<matchId>" or "fork:<gameId>". */
  id: string;
  source: "tabletop" | "superfumbbl";
  home: { team: string; coach: string; score: number; conceded: boolean };
  away: { team: string; coach: string; score: number; conceded: boolean };
  lines: Record<InGameKey, GameLine[]>;
  comments: GameComment[];
  test?: boolean;
}

export const emptyLines = (): Record<InGameKey, GameLine[]> => ({ touchdown: [], casualty: [], injury: [], death: [], foul: [], sentOff: [], mvp: [], hireFire: [] });

/** A player's label: their name when player names are public, else "#<number>" (or "a player"). */
export type PlayerLabel = (side: GameSide, playerId: string | undefined) => string;

/** The in-game key a single tabletop event stands for (a DEAD casualty / injury is a death), or undefined. */
export function tabletopEventKey(e: Pick<TabletopEvent, "type" | "payload">): InGameKey | undefined {
  switch (e.type) {
    case "touchdown": return "touchdown";
    case "casualty": return e.payload.result === "DEAD" ? "death" : "casualty";
    case "injury": return e.payload.result === "DEAD" ? "death" : e.payload.result === "stunned" ? undefined : "injury";
    case "foul": return "foul";
    case "sendOff": return "sentOff";
    case "mvp": return "mvp";
    default: return undefined;
  }
}

/** The line one tabletop event contributes (team = causer for a casualty, the hurt player's side for an injury). */
export function tabletopLine(e: TabletopEvent, label: PlayerLabel): { key: InGameKey; line: GameLine } | undefined {
  const key = tabletopEventKey(e);
  if (!key) return undefined;
  const result = typeof e.payload.result === "string" ? e.payload.result : undefined;
  if (e.type === "casualty") {
    const victimSide = (e.payload.victimTeam === "home" || e.payload.victimTeam === "away" ? e.payload.victimTeam : otherSide(e.team)) as GameSide;
    const victim = { side: victimSide, player: label(victimSide, typeof e.payload.victim === "string" ? e.payload.victim : undefined) };
    // A death is the VICTIM's line (who died); the causer is kept as the victim field's counterpart.
    if (key === "death") return { key, line: { side: victimSide, player: victim.player, count: 1, detail: "killed", victim: { side: e.team, player: label(e.team, e.player) } } };
    return { key, line: { side: e.team, player: label(e.team, e.player), count: 1, ...(result ? { detail: result } : {}), victim } };
  }
  return { key, line: { side: e.team, player: label(e.team, e.player), count: 1, ...(result && key === "injury" ? { detail: result } : {}) } };
}

/** Same player + same key + same detail lines merged into counts. */
function merge(lines: GameLine[]): GameLine[] {
  const out: GameLine[] = [];
  for (const l of lines) {
    const same = !l.victim ? out.find((o) => !o.victim && o.side === l.side && o.player === l.player && o.detail === l.detail) : undefined;
    if (same) same.count += l.count; else out.push({ ...l });
  }
  return out;
}

export interface TabletopGameInput {
  matchId: string;
  home: { team: string; coach: string };
  away: { team: string; coach: string };
  events: readonly TabletopEvent[];
  label: PlayerLabel;
  comments?: GameComment[];
  test?: boolean;
}

/** The game record of a tabletop recorder match (score from touchdowns; concession from the concede event). */
export function tabletopGame(input: TabletopGameInput): GameRecord {
  const lines = emptyLines();
  const score: Record<GameSide, number> = { home: 0, away: 0 };
  const conceded: Record<GameSide, boolean> = { home: false, away: false };
  for (const e of effectiveEvents(input.events)) {
    if (e.type === "touchdown") score[e.team] += 1;
    if (e.type === "concede") conceded[e.team] = true;
    const got = tabletopLine(e, input.label);
    if (got) lines[got.key].push(got.line);
  }
  for (const k of Object.keys(lines) as InGameKey[]) lines[k] = merge(lines[k]);
  return {
    id: `tabletop:${input.matchId}`, source: "tabletop",
    home: { ...input.home, score: score.home, conceded: conceded.home },
    away: { ...input.away, score: score.away, conceded: conceded.away },
    lines, comments: input.comments ?? [], ...(input.test ? { test: true } : {}),
  };
}

const DEAD = /\b(dead|rip|killed)\b/i;

/** GAME_PAGES_PUBLIC_PLAYER_LINES for every Discord post (server.ts sets it at start): false = players by number only. */
let publicPlayerNames = true;
export function setPublicPlayerNames(on: boolean): void { publicPlayerNames = on; }
export const publicNamesDefault = (): boolean => publicPlayerNames;

/** The game record of a Super FUMBBL result banked on a league fixture, or undefined when the fixture has none. */
export function forkGame(fixture: Pick<LeagueFixture, "home" | "away" | "test"> & { fork?: { result?: FixtureForkResult } }, publicNames = publicPlayerNames): GameRecord | undefined {
  const r = fixture.fork?.result;
  if (!r) return undefined;
  const lines = emptyLines();
  for (const side of ["home", "away"] as const) {
    r[side].lines.forEach((p, i) => {
      const player = publicNames ? p.name : `Player ${i + 1}`;
      if (p.td > 0) lines.touchdown.push({ side, player, count: p.td });
      if (p.cas > 0) lines.casualty.push({ side, player, count: p.cas });
      if (p.fouls > 0) lines.foul.push({ side, player, count: p.fouls });
      if (p.mvp > 0) lines.mvp.push({ side, player, count: p.mvp });
      for (const inj of p.injuries ?? []) {
        if (DEAD.test(inj)) lines.death.push({ side, player, count: 1, detail: "killed" });
        else lines.injury.push({ side, player, count: 1, detail: inj });
      }
    });
  }
  return {
    id: `fork:${r.gameId}`, source: "superfumbbl",
    home: { team: fixture.home.team, coach: fixture.home.coach, score: r.home.score, conceded: r.home.conceded },
    away: { team: fixture.away.team, coach: fixture.away.coach, score: r.away.score, conceded: r.away.conceded },
    lines, comments: [], ...(fixture.test ? { test: true } : {}),
  };
}
