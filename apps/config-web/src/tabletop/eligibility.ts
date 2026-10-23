/**
 * Who can be credited with what, computed by the server so the page filters without re-implementing rules.
 *
 * `available`: on this match's roster and fit to take part this game: not missing the game (MNG at match start), not dead, not killed in
 * this match, not sent off in it. Anything credited to an unavailable player is refused with 422 by the event validation.
 * `eligible.<action>`: available AND able to do the action from their characteristics and skills: Throw Team-mate needs that trait and
 * Right Stuff is what makes a player throwable (skills_and_traits #throw-team-mate-active / #right-stuff-passive); a player with no
 * Passing Ability ("-") cannot pass or throw; No Hands means no catching or intercepting. Everything else (touchdown, casualty by block,
 * foul, MVP, ...) is open to any available player. `kind` star/mercenary players can be credited but earn no SPP.
 */

import { effectiveEvents, otherSide, type Side, type TabletopEvent } from "./events.js";
import type { PlayerKind, TabletopPlayer, TabletopTeamFile } from "./postMatch.js";

export const ELIGIBLE_ACTIONS = ["touchdown", "casualty", "completion", "pass", "catch", "intercept", "deflect", "foul", "throwTeamMate", "rightStuff", "mvp"] as const;
export type EligibleAction = (typeof ELIGIBLE_ACTIONS)[number];

const key = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");
export const hasSkill = (p: Pick<TabletopPlayer, "skills">, name: string): boolean => p.skills.some((s) => key(s) === key(name));

export function availabilityOf(
  side: Side, player: Pick<TabletopPlayer, "id" | "mng" | "dead">, events: readonly TabletopEvent[],
): { available: boolean; unavailableReason?: string } {
  if (player.dead) return { available: false, unavailableReason: "Dead" };
  if (player.mng) return { available: false, unavailableReason: "Missing this game (injured last match)" };
  for (const e of effectiveEvents(events)) {
    if (e.type === "casualty" && e.payload.victim === player.id && (e.payload.victimTeam ?? otherSide(e.team)) === side && e.payload.result === "DEAD")
      return { available: false, unavailableReason: "Killed in this match" };
    if (e.type === "sendOff" && e.player === player.id && e.team === side) return { available: false, unavailableReason: "Sent off" };
  }
  return { available: true };
}

export function eligibleOf(player: TabletopPlayer, available: boolean): Record<EligibleAction, boolean> {
  const canPass = available && player.pa !== null;
  const hands = available && !hasSkill(player, "No Hands");
  return {
    touchdown: available,
    casualty: available,
    completion: canPass,
    pass: canPass,
    catch: hands,
    intercept: hands,
    deflect: hands,
    foul: available,
    throwTeamMate: canPass && hasSkill(player, "Throw Team-mate"),
    rightStuff: available && hasSkill(player, "Right Stuff"),
    mvp: available,
  };
}

/** A team file's players as the match GET shows them: kind, availability and the eligibility flags added. */
export function decorateRoster(side: Side, file: TabletopTeamFile | undefined, events: readonly TabletopEvent[]): TabletopTeamFile | undefined {
  if (!file) return file;
  return {
    ...file,
    players: file.players.map((p) => {
      const a = availabilityOf(side, p, events);
      return { ...p, kind: p.kind ?? (p.journeyman ? "journeyman" : "rostered"), ...a, eligible: eligibleOf(p, a.available) } as TabletopPlayer & {
        kind: PlayerKind; available: boolean; unavailableReason?: string; eligible: Record<EligibleAction, boolean>;
      };
    }),
  };
}
