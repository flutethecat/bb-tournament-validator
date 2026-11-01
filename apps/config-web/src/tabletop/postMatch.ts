/**
 * Tabletop post-match: ONE pure function from (team file, match events, options) to the next team-file
 * revision plus a summary. No I/O, no clock, no randomness - the same inputs always give the same output.
 *
 * CONTRACT (shared with the fork results reader, which must call this same function):
 *   applyPostMatch(teamFile, events, { team, postMatch, ruleset, matchId? })
 *     - `events` is the RAW append-only list; undo resolution happens inside (effectiveEvents), so a
 *       caller never filters first.
 *     - `team` is which side of the match this team file is ("home" | "away").
 *     - `postMatch`: "none"      -> returns the team file UNCHANGED (summary still describes the match);
 *                    "spp-only"  -> SPP + injuries (MNG, niggling, stat loss, death);
 *                    "full"      -> spp-only plus winnings -> treasury and the dedicated-fans change.
 *     The dedicated-fans dice are ROLLED AT THE TABLE and ENTERED by the coach as a `fanChange` {delta} event;
 *     this function never rolls anything.
 *     - `ruleset`: only "bb2025" exists. Anything else throws.
 *     - Input is never mutated; the result team file is a new object.
 *   BB2025 values used (exported as constants so a ruleset change is one edit): TD 3, CAS 2 (block-caused
 *   only, not fouls or other causes), completion 1, interception 2 (rules site), deflection 1, MVP 4; winnings 10,000 gp
 *   per touchdown scored (owner ruling: no win/draw bonus); dedicated fans change comes from the coach's
 *   recorded `fanChange` event, clamped to 1..6.
 *   A player who started the match already MNG sat it out: the flag is cleared; a new MNG may then be set.
 *   Hiring, journeymen and advancement picks are OUT of scope. `casualty.apothecaryUsed` is recorded in the
 *   summary only: `result` is the FINAL result after any apothecary reroll.
 */

import { effectiveEvents, LASTING_INJURY_RESULTS, otherSide, type Side, type StatName, type TabletopEvent } from "./events.js";
import { nextCaptainVacancy } from "../captain.js";

export type PostMatchOption = "none" | "spp-only" | "full";
export type Ruleset = "bb2025";

export const WINNINGS_PER_TOUCHDOWN = 10_000;
export const SPP_VALUES = { touchdown: 3, casualty: 2, completion: 1, throwTeamMate: 1, landing: 1, interception: 2, deflection: 1, mvp: 4 } as const;

/**
 * Who earns SPP (bloodbowlbase.ru league_play, #earning-star-player-points, paraphrased): regular players earn it, Journeymen earn it
 * (and keep it if hired later), Star Players earn none. Mercenary Players are not mentioned on that page; the owner ruled they earn none
 * either. An excluded player can still be CREDITED with a touchdown or casualty (the score and the log record it); it just earns 0 SPP.
 */
export type PlayerKind = "rostered" | "star" | "mercenary" | "journeyman";
export const SPP_EXCLUDED_KINDS: ReadonlySet<string> = new Set(["star", "mercenary"]);
export type KindOf = (side: Side, id: string) => string | undefined;
export const FANS_MIN = 1;
export const FANS_MAX = 6;

export interface TabletopPlayer {
  id: string;
  name: string;
  number?: number;
  positionId?: string;
  /** Lifetime earned star player points. */
  spp: number;
  skills: string[];
  mng: boolean;
  niggles: number;
  statLoss: Partial<Record<StatName, number>>;
  dead: boolean;
  /** Library teams: the stored lasting-injury names, preserved verbatim. */
  injuries?: string[];
  /** Added for one match by the pre-game journeymen step; never part of a stored team revision. */
  journeyman?: boolean;
  /** rostered (default), star, mercenary or journeyman; stars and mercenaries earn no SPP. */
  kind?: PlayerKind;
  /** Position name and CURRENT characteristics (ag / pa / av are target numbers: 3 means 3+; pa null = no passing). */
  positionName?: string;
  ma?: number;
  st?: number;
  ag?: number;
  pa?: number | null;
  av?: number;
}

export interface TabletopTeamFile {
  schema: 1;
  /** Added by the match GET when the team has an uploaded avatar (public read URL); never stored. */
  avatarUrl?: string;
  name: string;
  rosterId?: string;
  treasury: number;
  dedicatedFans: number;
  /** Carried through unchanged from a library team (post-match never edits them). */
  race?: string;
  rerolls?: number;
  apothecary?: boolean;
  assistantCoaches?: number;
  cheerleaders?: number;
  /** Current team value in gold, when known (inducement petty cash needs it). */
  teamValue?: number;
  specialRules?: string[];
  players: TabletopPlayer[];
  /** Id of the match that produced this revision (absent on the baseline). */
  lastMatchId?: string;
  /** The Team Captain died and no living player carries the trait (owner 10-30; ../captain.ts). Set by applyPostMatch. */
  captainVacant?: true;
}

/** Is this team file waiting for a new Team Captain? The flag, confirmed against the living players. Pre-game reminder. */
export function teamFileCaptainVacant(file: Pick<TabletopTeamFile, "players" | "captainVacant"> | undefined): boolean {
  if (!file) return false;
  const living = file.players.filter((p) => !p.dead && !p.journeyman);
  return nextCaptainVacancy(undefined, living, file.captainVacant === true);
}

export interface PostMatchOptions {
  team: Side;
  postMatch: PostMatchOption;
  ruleset: Ruleset;
  matchId?: string;
}

export interface SppCredit { team: Side; player: string; spp: number }

/**
 * Who an effective event credits with SPP, and how much (the single table; tallies and the per-event feed both use it).
 * Throw Team-mate (bloodbowlbase.ru league_play, #throw-team-mate; skills_and_traits #throw-team-mate-active, #right-stuff-passive;
 * the_game_of_blood_bowl #throw-team-mate-actions, #superb-throw, #landing): a Superb Throw whose thrown player lands on their feet
 * is 1 SPP to the thrower; a thrown player who lands safely, whatever the throw type, earns 1 SPP. Nothing else is granted.
 */
export function sppCredits(e: TabletopEvent, kindOf?: KindOf): SppCredit[] {
  const raw: SppCredit[] = [];
  const give = (player: string | undefined, spp: number) => { if (player) raw.push({ team: e.team, player, spp }); };
  switch (e.type) {
    case "touchdown": give(e.player, SPP_VALUES.touchdown); break;
    case "completion": give(e.player, SPP_VALUES.completion); break;
    case "interception": give(e.player, SPP_VALUES.interception); break;
    case "deflection": give(e.player, SPP_VALUES.deflection); break;
    case "mvp": give(e.player, SPP_VALUES.mvp); break;
    case "casualty": if (e.payload.cause === "block") give(e.player, SPP_VALUES.casualty); break;
    case "throwTeamMate":
      if (e.payload.landed === true) {
        if (e.payload.superb === true) give(e.payload.thrower as string | undefined, SPP_VALUES.throwTeamMate);
        give(e.payload.thrown as string | undefined, SPP_VALUES.landing);
      }
      break;
    default: break;
  }
  return raw.map((cr) => (kindOf && SPP_EXCLUDED_KINDS.has(kindOf(cr.team, cr.player) ?? "") ? { ...cr, spp: 0 } : cr));
}

/** SPP one effective event earns in total. */
export const sppForEvent = (e: TabletopEvent, kindOf?: KindOf): number => sppCredits(e, kindOf).reduce((n, cr) => n + cr.spp, 0);

export interface PlayerLine {
  id: string;
  name: string;
  touchdowns: number;
  casualtiesCaused: number;
  completions: number;
  throwTeamMateCompletions: number;
  /** Times this player, thrown by a team-mate, landed safely. */
  landings: number;
  catches: number;
  fouls: number;
  interceptions: number;
  deflections: number;
  mvp: number;
  sentOff: boolean;
  sppEarned: number;
  injury?: { result: string; stat?: StatName; apothecaryUsed: boolean };
}

export interface PostMatchSummary {
  ruleset: Ruleset;
  postMatch: PostMatchOption;
  team: Side;
  applied: boolean;
  score: { for: number; against: number };
  outcome: "won" | "drawn" | "lost";
  players: PlayerLine[];
  deaths: string[];
  winnings: number;
  treasuryBefore: number;
  treasuryAfter: number;
  fansBefore: number;
  fansAfter: number;
  /** Casualties this team SUFFERED, bucketed like the fork result (bh / si = MNG, NI, stat loss / rip). */
  casualtiesSuffered: { bh: number; si: number; rip: number };
}

export interface MatchTally {
  score: Record<Side, number>;
  /** Per side, per player id (only players with at least one recorded line). */
  lines: Record<Side, Map<string, PlayerLine>>;
  fanDelta: Record<Side, number>;
  /** Gold each side paid from its treasury for inducements (server-validated pre-game events). */
  treasurySpent: Record<Side, number>;
  conceded: Record<Side, boolean>;
  /** The latest half/turn any effective event carried (for the scoreboard). */
  clock: { half?: string | number; turn?: number };
  casualtiesSuffered: Record<Side, { bh: number; si: number; rip: number }>;
}

const emptyLine = (id: string, name: string): PlayerLine => ({
  id, name, touchdowns: 0, casualtiesCaused: 0, completions: 0, throwTeamMateCompletions: 0, landings: 0, catches: 0, fouls: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, sppEarned: 0,
});

/** Count the effective events. The single tally used by the post-match function AND the results row. */
export function tallyMatch(
  events: readonly TabletopEvent[],
  names: Record<Side, ReadonlyMap<string, string>> = { home: new Map(), away: new Map() },
  kindOf?: KindOf,
): MatchTally {
  const t: MatchTally = {
    score: { home: 0, away: 0 },
    lines: { home: new Map(), away: new Map() },
    fanDelta: { home: 0, away: 0 },
    treasurySpent: { home: 0, away: 0 },
    conceded: { home: false, away: false },
    clock: {},
    casualtiesSuffered: { home: { bh: 0, si: 0, rip: 0 }, away: { bh: 0, si: 0, rip: 0 } },
  };
  const line = (side: Side, id: string): PlayerLine => {
    let l = t.lines[side].get(id);
    if (!l) { l = emptyLine(id, names[side].get(id) ?? id); t.lines[side].set(id, l); }
    return l;
  };
  const treasuryBySide: Record<Side, number> = { home: 0, away: 0 };
  for (const e of effectiveEvents(events)) {
    const side = e.team;
    if (e.half !== undefined) t.clock.half = e.half;
    if (e.turn !== undefined) t.clock.turn = e.turn;
    switch (e.type) {
      case "catch": line(side, e.player!).catches += 1; break;
      case "foul": line(side, e.player!).fouls += 1; break;
      case "throwTeamMate":
        if (e.payload.landed === true) {
          if (e.payload.superb === true && typeof e.payload.thrower === "string") line(side, e.payload.thrower).throwTeamMateCompletions += 1;
          if (typeof e.payload.thrown === "string") line(side, e.payload.thrown).landings += 1;
        }
        break;
      case "concede": t.conceded[side] = true; break;
      case "inducement": treasuryBySide[side] = typeof e.payload.treasury === "number" ? e.payload.treasury : 0; break; // the latest submission replaces earlier ones
      case "touchdown": t.score[side] += 1; line(side, e.player!).touchdowns += 1; break;
      case "completion": line(side, e.player!).completions += 1; break;
      case "interception": line(side, e.player!).interceptions += 1; break;
      case "deflection": line(side, e.player!).deflections += 1; break;
      case "mvp": line(side, e.player!).mvp += 1; break;
      case "sendOff": line(side, e.player!).sentOff = true; break;
      case "fanChange": t.fanDelta[side] += e.payload.delta as number; break;
      case "injury": {
        // A lasting injury with no one to credit: applied to the hurt player like a casualty result, no SPP to anyone.
        const result = e.payload.result as string;
        if (!(LASTING_INJURY_RESULTS as readonly string[]).includes(result) || !e.player) break;
        const bucket = t.casualtiesSuffered[side];
        if (result === "BH") bucket.bh += 1; else if (result === "DEAD") bucket.rip += 1; else bucket.si += 1;
        line(side, e.player).injury = {
          result,
          ...(result === "stat loss" ? { stat: e.payload.stat as StatName } : {}),
          apothecaryUsed: e.payload.apothecaryUsed === true,
        };
        break;
      }
      case "casualty": {
        const victimSide = (e.payload.victimTeam as Side | undefined) ?? otherSide(side);
        const result = e.payload.result as string;
        const bucket = t.casualtiesSuffered[victimSide];
        if (result === "BH") bucket.bh += 1; else if (result === "DEAD") bucket.rip += 1; else bucket.si += 1;
        if (e.player && e.payload.cause === "block") line(side, e.player).casualtiesCaused += 1;
        const v = line(victimSide, e.payload.victim as string);
        v.injury = {
          result,
          ...(result === "stat loss" ? { stat: e.payload.stat as StatName } : {}),
          apothecaryUsed: e.payload.apothecaryUsed === true,
        };
        break;
      }
    }
  }
  t.treasurySpent = treasuryBySide;
  for (const side of ["home", "away"] as const)
    for (const l of t.lines[side].values())
      l.sppEarned =
        l.touchdowns * SPP_VALUES.touchdown + l.casualtiesCaused * SPP_VALUES.casualty + l.completions * SPP_VALUES.completion +
        l.throwTeamMateCompletions * SPP_VALUES.throwTeamMate + l.landings * SPP_VALUES.landing +
        l.interceptions * SPP_VALUES.interception + l.deflections * SPP_VALUES.deflection + l.mvp * SPP_VALUES.mvp;
  if (kindOf)
    for (const side of ["home", "away"] as const)
      for (const l of t.lines[side].values()) if (SPP_EXCLUDED_KINDS.has(kindOf(side, l.id) ?? "")) l.sppEarned = 0;
  return t;
}

export function applyPostMatch(
  teamFile: TabletopTeamFile,
  events: readonly TabletopEvent[],
  options: PostMatchOptions,
): { teamFile: TabletopTeamFile; summary: PostMatchSummary } {
  if (options.ruleset !== "bb2025") throw new Error(`Unsupported ruleset: ${String(options.ruleset)}`);
  if (!["none", "spp-only", "full"].includes(options.postMatch)) throw new Error(`Unsupported postMatch option: ${String(options.postMatch)}`);
  const side = options.team;
  const names = new Map(teamFile.players.map((p) => [p.id, p.name] as const));
  const kinds = new Map(teamFile.players.map((p) => [p.id, p.kind] as const));
  const tally = tallyMatch(events, { home: side === "home" ? names : new Map(), away: side === "away" ? names : new Map() },
    (sd, id) => (sd === side ? kinds.get(id) : undefined));
  // Opponent lines are not needed here; only this side's lines and the opposing score.
  const forScore = tally.score[side];
  const againstScore = tally.score[otherSide(side)];
  const lines = [...tally.lines[side].values()];
  const full = options.postMatch === "full";
  const winnings = full ? forScore * WINNINGS_PER_TOUCHDOWN : 0;
  const spent = full ? Math.min(tally.treasurySpent[side], teamFile.treasury + winnings) : 0;
  const fansBefore = teamFile.dedicatedFans;
  const fansAfter = full ? Math.min(FANS_MAX, Math.max(FANS_MIN, fansBefore + tally.fanDelta[side])) : fansBefore;

  const summary: PostMatchSummary = {
    ruleset: options.ruleset,
    postMatch: options.postMatch,
    team: side,
    applied: options.postMatch !== "none",
    score: { for: forScore, against: againstScore },
    outcome: forScore > againstScore ? "won" : forScore < againstScore ? "lost" : "drawn",
    players: lines,
    deaths: lines.filter((l) => l.injury?.result === "DEAD").map((l) => l.id),
    winnings,
    treasuryBefore: teamFile.treasury,
    treasuryAfter: teamFile.treasury + winnings - spent,
    fansBefore,
    fansAfter,
    casualtiesSuffered: tally.casualtiesSuffered[side],
  };

  if (options.postMatch === "none") return { teamFile: structuredClone(teamFile), summary };

  const byId = new Map(lines.map((l) => [l.id, l] as const));
  const players = teamFile.players.map((p): TabletopPlayer => {
    const next: TabletopPlayer = { ...p, skills: [...p.skills], statLoss: { ...p.statLoss }, ...(p.injuries ? { injuries: [...p.injuries] } : {}) };
    next.mng = false; // anyone MNG at the start sat this match out; serving it clears the flag
    const l = byId.get(p.id);
    if (!l) return next;
    next.spp += l.sppEarned;
    const inj = l.injury;
    if (inj) {
      if (inj.result === "DEAD") next.dead = true;
      else if (inj.result !== "BH") {
        next.mng = true;
        if (inj.result === "NI") next.niggles += 1;
        if (inj.result === "stat loss" && inj.stat) next.statLoss[inj.stat] = (next.statLoss[inj.stat] ?? 0) + 1;
      }
    }
    return next;
  });
  const { captainVacant: _wasVacant, ...rest } = teamFile;
  // A Team Captain killed in this match leaves the captaincy vacant (../captain.ts); the dead player keeps the trait + Pro.
  const vacant = nextCaptainVacancy(teamFile.players.filter((p) => !p.dead), players.filter((p) => !p.dead), teamFile.captainVacant === true);
  const out: TabletopTeamFile = {
    ...rest,
    treasury: summary.treasuryAfter,
    dedicatedFans: fansAfter,
    players,
    ...(options.matchId ? { lastMatchId: options.matchId } : {}),
    ...(vacant ? { captainVacant: true as const } : {}),
  };
  return { teamFile: out, summary };
}
