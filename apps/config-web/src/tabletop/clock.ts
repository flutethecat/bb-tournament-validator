/**
 * Match clock (lane R3): half, turn, whose turn it is, and the turn timer settings. Pure helpers.
 *
 * Turn counter `1Ht3`: half 1, turn 3; turn 0 is the setup before the kick-off. Each team takes its own turn 1..8 in a
 * half, so the sequence of End Turn presses in a half is: receiver t1, kicker t1, receiver t2, kicker t2, ... kicker t8.
 * The receiving team of half 1 comes from the coin phase (the winner's choice); at half-time the teams swap, so the team
 * that kicked in half 1 receives in half 2. If no coin phase ran, home receives first.
 */

import type { Side, TabletopEvent } from "./events.js";
import { otherSide } from "./events.js";

export type ClockHalf = 1 | 2 | "OT";
export type TimerEnforcement = "off" | "optional" | "required";

export interface ClockState {
  half: ClockHalf;
  /** 0 = setup before the kick-off of the half; 1-8 = the team-turn number. */
  turn: number;
  /** Whose turn it is; null once the match has run out of turns (post endOfMatch). */
  activeTeam: Side | null;
  turnStartedAt: string | null;
}

export interface TurnTimerPolicy { enforced: TimerEnforcement; seconds: number }
export const DEFAULT_TURN_TIMER_POLICY: TurnTimerPolicy = { enforced: "optional", seconds: 240 };

export interface MatchTimers { mode: "off" | "on"; seconds: number; enforced: TimerEnforcement }

/** The team that receives the opening kick of half 1: the coin winner if they chose to receive, else the other team. */
export function firstHalfReceiver(events: readonly TabletopEvent[]): Side {
  const flip = events.find((e) => e.id === "pg-coinflip");
  if (!flip) return "home";
  const choice = (events.find((e) => e.id === "pg-coinchoice")?.payload.choice ?? flip.payload.choice) as string | undefined;
  if (!choice) return "home";
  return choice === "receive" ? flip.team : otherSide(flip.team);
}

/** Who receives the kick in a half: half 1 the coin's receiver, half 2 the other team, overtime restarts with the first. */
export const receiverOf = (half: ClockHalf, first: Side): Side => (half === 2 ? otherSide(first) : first);

export const initialClock = (events: readonly TabletopEvent[]): ClockState => ({
  half: 1, turn: 0, activeTeam: firstHalfReceiver(events), turnStartedAt: null,
});

/** 1Ht0 -> 1Ht1 (the kick-off is done) and likewise 2Ht0 -> 2Ht1. */
export function startTurn(clock: ClockState, now: string): ClockState | { error: string } {
  if (clock.activeTeam === null) return { error: "The match has no turns left." };
  if (clock.turn !== 0) return { error: "The half is already under way." };
  return { ...clock, turn: 1, turnStartedAt: now };
}

export function endTurn(clock: ClockState, first: Side, allowOvertime: boolean, now: string): ClockState | { error: string } {
  if (clock.activeTeam === null) return { error: "The match has no turns left: post the end of the match." };
  if (clock.turn === 0) return { error: "Start the half first (the kick-off is not done)." };
  const receiver = receiverOf(clock.half, first);
  if (clock.activeTeam === receiver) return { ...clock, activeTeam: otherSide(receiver), turnStartedAt: now };
  if (clock.turn < 8) return { ...clock, turn: clock.turn + 1, activeTeam: receiver, turnStartedAt: now };
  if (clock.half === 1) return { half: 2, turn: 0, activeTeam: receiverOf(2, first), turnStartedAt: null };
  if (clock.half === 2 && allowOvertime) return { half: "OT", turn: 0, activeTeam: receiverOf("OT", first), turnStartedAt: null };
  return { half: clock.half, turn: 8, activeTeam: null, turnStartedAt: null };
}

export const clockLabel = (c: Pick<ClockState, "half" | "turn">): string => `${c.half}Ht${c.turn}`;
