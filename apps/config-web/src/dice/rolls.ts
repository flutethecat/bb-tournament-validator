/**
 * The recorder dice roller's rolls (spec-forfeit-and-dice-2026-11-02): one function per surface, each a pure function of
 * the site roller, so a test replays it exactly. The caller writes the returned roll to the dice log before showing it.
 *   d6        1 or 2 dice
 *   block     -3 / -2 / 1 / 2 / 3 dice (negative = the opponent chooses; 2 or 3 = the rolling coach chooses)
 *   d8        one D8
 *   d16       the casualty die (CAS)
 *   deviate   kick-off scatter: D6 distance + D8 direction
 *   kickoff   kick-off event: 2D6 total -> the ruleset's table
 */
import { rollDice, type Roller } from "./roller.js";
import type { DiceKind, DiceRoll, DiceSide } from "./log.js";
import { BLOCK_FACE_LABEL, blockFace, kickoffEvent, scatterDirection, type DiceRuleset } from "./tables.js";

export const BLOCK_COUNTS = [-3, -2, 1, 2, 3] as const;
export const ROLLABLE_KINDS: readonly DiceKind[] = ["d6", "block", "d8", "d16", "deviate", "kickoff"];

export interface RollSpec { kind: DiceKind; count?: number }
export type RollCore = Pick<DiceRoll, "kind" | "purpose" | "dice" | "result" | "block">;

/** Shape-check a roll request: `{kind, count?}`. Returns the spec or an error message. */
export function parseRollSpec(body: unknown): RollSpec | { error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== "string" || !ROLLABLE_KINDS.includes(kind as DiceKind)) return { error: `kind must be one of ${ROLLABLE_KINDS.join(", ")}.` };
  if (kind === "d6") {
    const count = b.count ?? 1;
    if (count !== 1 && count !== 2) return { error: "A D6 roll is 1 or 2 dice." };
    return { kind, count };
  }
  if (kind === "block") {
    if (!(BLOCK_COUNTS as readonly unknown[]).includes(b.count)) return { error: "A block roll is -3, -2, 1, 2 or 3 dice." };
    return { kind, count: b.count as number };
  }
  if (b.count !== undefined) return { error: `A ${kind} roll takes no count.` };
  return { kind: kind as DiceKind };
}

/** Roll a spec with the site roller. */
export function rollSpec(roller: Roller, spec: RollSpec, ruleset: DiceRuleset): RollCore {
  switch (spec.kind) {
    case "d6": {
      const dice = rollDice(roller, 6, spec.count ?? 1);
      return { kind: "d6", purpose: dice.length === 2 ? "2D6" : "D6", dice, result: { total: dice.reduce((a, b) => a + b, 0) } };
    }
    case "block": {
      const count = spec.count ?? 1;
      const dice = rollDice(roller, 6, Math.abs(count));
      const faces = dice.map(blockFace);
      const chooser = Math.abs(count) === 1 ? "none" : count < 0 ? "opponent" : "roller";
      const purpose = Math.abs(count) === 1 ? "Block, 1 die" : `Block, ${Math.abs(count)} dice, ${count < 0 ? "the opponent chooses" : "the rolling coach chooses"}`;
      return { kind: "block", purpose, dice, result: { faces, labels: faces.map((f) => BLOCK_FACE_LABEL[f]) }, block: { count, chooser } };
    }
    case "d8": {
      const dice = rollDice(roller, 8, 1);
      return { kind: "d8", purpose: "D8", dice, result: { total: dice[0] } };
    }
    case "d16": {
      const dice = rollDice(roller, 16, 1);
      return { kind: "d16", purpose: "Casualty (D16)", dice, result: { total: dice[0] } };
    }
    case "deviate": {
      const [distance, d8] = [rollDice(roller, 6, 1)[0]!, rollDice(roller, 8, 1)[0]!];
      const dir = scatterDirection(d8);
      return { kind: "deviate", purpose: "Kick-off deviate (D6 + D8)", dice: [distance, d8], result: { distance, direction: dir.id, directionLabel: dir.label, arrow: dir.arrow } };
    }
    case "kickoff": {
      const dice = rollDice(roller, 6, 2);
      const total = dice[0]! + dice[1]!;
      const ev = kickoffEvent(total, ruleset);
      return { kind: "kickoff", purpose: "Kick-off event (2D6)", dice, result: { total, event: ev.id, eventName: ev.name, summary: ev.summary, ruleset } };
    }
    default:
      throw new Error(`rollSpec: ${spec.kind} is not a roller surface`);
  }
}

/**
 * May `chooserSide` (the side of the coach submitting) pick a face of this block roll? `roller` is the rolling side.
 * Negative counts: the opponent picks, and the rolling coach may submit it for them (in-person play), so either seat.
 * Positive counts above 1: the rolling side only. One die: nothing to choose.
 */
export function mayChooseBlock(roll: Pick<DiceRoll, "block" | "side">, chooserSide: DiceSide | null, manage: boolean): boolean {
  if (!roll.block || roll.block.chooser === "none") return false;
  if (manage) return true;
  if (!chooserSide) return false;
  if (roll.block.chooser === "opponent") return true; // either seat (the opponent, or the roller submitting for them)
  return chooserSide === roll.side;
}
