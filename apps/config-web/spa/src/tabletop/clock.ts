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
  if (clock.turn === 0) return canAct ? "kickoff" : "wait";
  if (!clock.activeTeam) return "none";
  if (organiser || localSide === clock.activeTeam) return "end";
  return "wait";
}

// ---- timer cues: 1:00, 0:10 and 0:03, each once per turn -------------------------------------------------------

export type TimerCue = "minute" | "ten" | "three";
export const CUE_SECONDS: ReadonlyArray<[TimerCue, number]> = [["minute", 60], ["ten", 10], ["three", 3]];

/**
 * Each mark sounds once per turn (a new turn key starts over). The first reading of a turn only initialises: marks it
 * already passed are consumed silently (a reconnect at 0:08 does not replay 1:00). A tick that skips a mark still
 * sounds it once (the latest crossed mark).
 */
export function createCueTracker() {
  let key = "";
  let prev: number | undefined;
  const done = new Set<TimerCue>();
  return {
    reading(turnKey: string, remaining: number | undefined): TimerCue | null {
      if (remaining === undefined) { prev = undefined; return null; }
      if (turnKey !== key) { key = turnKey; prev = undefined; done.clear(); }
      if (prev === undefined) {
        prev = remaining;
        for (const [cue, s] of CUE_SECONDS) if (remaining <= s) done.add(cue);
        return null;
      }
      let out: TimerCue | null = null;
      for (const [cue, s] of CUE_SECONDS) {
        if (!done.has(cue) && prev > s && remaining <= s) { done.add(cue); out = cue; }
      }
      prev = remaining;
      return out;
    },
  };
}
