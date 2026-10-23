// The match clock as the server reports it: counter format, who may press End Turn, and the turn timer derived from
// SERVER time (a server offset measured at every sync), never a free-running local count.

import type { Side } from "./recorder";

export interface TurnTimerView {
  mode?: string;
  seconds?: number;
  agreed?: Partial<Record<Side, boolean | null>>;
  enforced?: boolean | string | null;
}

export interface ClockView {
  half?: number | string;
  turn?: number;
  activeTeam?: Side | null;
  turnStartedAt?: string | number | null;
  turnTimer?: TurnTimerView;
  serverNow?: string | number;
}

const ms = (v: string | number | null | undefined): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; }
  return undefined;
};

/** "1Ht0": the half, then "Ht", then the turn (turn 0 = setup / kick-off). Overtime reads "OTt3". */
export function turnLabel(half: number | string | undefined, turn: number | undefined): string {
  const h = half === "OT" || (typeof half === "number" && half >= 3) ? "OT" : String(half ?? 1);
  return `${h}${h === "OT" ? "" : "H"}t${turn ?? 0}`;
}

/** serverNow - local now at the moment of a sync (re-measured on every poll and push). */
export function serverOffset(clock: ClockView | undefined, localNowMs: number): number {
  const s = ms(clock?.serverNow);
  return s === undefined ? 0 : s - localNowMs;
}

export const timerOn = (clock: ClockView | undefined): boolean => clock?.turnTimer?.mode === "on";

/** Whole seconds left in the turn, from the server's turn start and the offset (negative once past zero). */
export function timerRemaining(clock: ClockView | undefined, offsetMs: number, localNowMs: number): number | undefined {
  const seconds = clock?.turnTimer?.seconds;
  const started = ms(clock?.turnStartedAt);
  if (!timerOn(clock) || typeof seconds !== "number" || started === undefined) return undefined;
  const elapsedMs = localNowMs + offsetMs - started;
  return Math.ceil(seconds - elapsedMs / 1000);
}

/** m:ss; below zero shows 0:00. */
export function formatTimer(remaining: number): string {
  const r = Math.max(0, remaining);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}

export type CentreMode = "none" | "kickoff" | "end" | "wait";

/**
 * What the centre panel shows. `localSide` is the session coach's side (null for an organiser who plays in neither):
 * the active coach gets End Turn, an organiser gets it for the active team, everyone else sees who is to play.
 */
export function centreMode(clock: ClockView | undefined, localSide: Side | null, organiser: boolean, canAct: boolean): CentreMode {
  if (!clock || clock.turn === undefined) return "none";
  // Turn 0: the team about to play (the receiver) confirms the kick-off; an organiser may for them.
  if (clock.turn === 0) return canAct && (organiser || !clock.activeTeam || localSide === clock.activeTeam) ? "kickoff" : "wait";
  if (!clock.activeTeam) return "none";
  if (organiser || localSide === clock.activeTeam) return "end";
  return "wait";
}

// ---- timer cues: the Super FUMBBL client's cadence ----------------------------------------------------------------
// The minute sound once at 1:00; then, once on each remaining second 10 .. 1, the warning tone (the minute sound) on
// 10 .. 6 and the last-seconds countdown sound on 5 .. 1 (uiSoundCues.ts turnClockCue).

export type TimerCue = "minute" | "warning" | "countdown";
export const CUE_MINUTE_S = 60;
export const CUE_WARNING_FROM_S = 10;
export const CUE_COUNTDOWN_FROM_S = 5;

/** Every whole second at which a cue sounds: {60} and {10 .. 1}. */
export const CUE_SECONDS: readonly number[] = [CUE_MINUTE_S, ...Array.from({ length: CUE_WARNING_FROM_S }, (_, i) => CUE_WARNING_FROM_S - i)];

export interface CueReading { cue: TimerCue; seconds: number }

/**
 * Each mark sounds once per turn (a new turn key starts over). The first reading of a turn only initialises: marks it
 * already passed are consumed silently (a reconnect at 0:08 does not replay 1:00 or 0:10 .. 0:09). A skipped tick still
 * sounds the second it lands on, once.
 */
export function createCueTracker() {
  let key = "";
  let prev: number | undefined;
  let minuteDone = false;
  const done = new Set<number>();
  return {
    reading(turnKey: string, remaining: number | undefined): CueReading | null {
      if (remaining === undefined) { prev = undefined; return null; }
      if (turnKey !== key) { key = turnKey; prev = undefined; }
      if (prev === undefined) {
        prev = remaining;
        done.clear();
        minuteDone = remaining <= CUE_MINUTE_S;
        for (let sec = Math.max(1, Math.ceil(remaining)); sec <= CUE_WARNING_FROM_S; sec++) done.add(sec);
        return null;
      }
      const before = prev;
      prev = remaining;
      if (remaining >= before) return null; // a new reading that did not fall: silent
      let out: CueReading | null = null;
      if (remaining >= 1 && remaining <= CUE_WARNING_FROM_S && !done.has(remaining)) {
        for (let sec = remaining; sec <= CUE_WARNING_FROM_S; sec++) done.add(sec);
        out = { cue: remaining <= CUE_COUNTDOWN_FROM_S ? "countdown" : "warning", seconds: remaining };
      } else if (!minuteDone && before > CUE_MINUTE_S && remaining <= CUE_MINUTE_S) {
        out = { cue: "minute", seconds: remaining };
      }
      if (remaining <= CUE_MINUTE_S) minuteDone = true;
      return out;
    },
  };
}
