/**
 * What a die shows, per ruleset (spec-forfeit-and-dice-2026-11-02, Q5): block-die faces, the kick-off scatter direction
 * (D8) and the kick-off event table (2D6). Event names are the tables' short titles; the one-line summaries are our own
 * words, never copied rule text. BB2025 is the default; BB2020 differs on 10 and 11.
 */

export type DiceRuleset = "BB2020" | "BB2025";
export const DEFAULT_DICE_RULESET: DiceRuleset = "BB2025";
export const diceRulesetOf = (v: unknown): DiceRuleset => (v === "BB2020" ? "BB2020" : "BB2025");

/** Block die faces by D6 result (1..6): two Push faces. Ids match the face art (public/assets/dice/block/128). */
export const BLOCK_FACES = ["skull", "both-down", "push", "push", "stumble", "pow"] as const;
export type BlockFace = (typeof BLOCK_FACES)[number];
export const BLOCK_FACE_LABEL: Record<BlockFace, string> = {
  skull: "Attacker down", "both-down": "Both down", push: "Push", stumble: "Stumble", pow: "Defender down",
};
export const blockFace = (d6: number): BlockFace => {
  if (!Number.isInteger(d6) || d6 < 1 || d6 > 6) throw new RangeError("blockFace: d6 1-6");
  return BLOCK_FACES[d6 - 1]!;
};

/** Kick-off scatter (D8), on the usual template seen from above: 1-3 the row ahead, 4/5 the sides, 6-8 the row behind. */
export const SCATTER_DIRECTIONS = [
  { roll: 1, id: "nw", label: "Up and left", arrow: "↖" },
  { roll: 2, id: "n", label: "Up", arrow: "↑" },
  { roll: 3, id: "ne", label: "Up and right", arrow: "↗" },
  { roll: 4, id: "w", label: "Left", arrow: "←" },
  { roll: 5, id: "e", label: "Right", arrow: "→" },
  { roll: 6, id: "sw", label: "Down and left", arrow: "↙" },
  { roll: 7, id: "s", label: "Down", arrow: "↓" },
  { roll: 8, id: "se", label: "Down and right", arrow: "↘" },
] as const;
export type ScatterDirection = (typeof SCATTER_DIRECTIONS)[number];
export const scatterDirection = (d8: number): ScatterDirection => {
  const d = SCATTER_DIRECTIONS.find((x) => x.roll === d8);
  if (!d) throw new RangeError("scatterDirection: d8 1-8");
  return d;
};

export interface KickoffEvent { total: number; id: string; name: string; summary: string }

const COMMON: Record<number, Omit<KickoffEvent, "total">> = {
  2: { id: "get-the-ref", name: "Get the Ref", summary: "Both coaches gain a free bribe for this game." },
  3: { id: "time-out", name: "Time-out", summary: "The turn markers move: back one if the kicking team is late in the half, otherwise forward one." },
  4: { id: "solid-defence", name: "Solid Defence", summary: "The kicking team may set some of its players up again." },
  5: { id: "high-kick", name: "High Kick", summary: "One open receiving player may move under the ball before it lands." },
  6: { id: "cheering-fans", name: "Cheering Fans", summary: "Each side rolls and adds its cheerleaders; the higher side gains a reroll for the half." },
  7: { id: "brilliant-coaching", name: "Brilliant Coaching", summary: "Each side rolls and adds its assistant coaches; the higher side gains a reroll for the half." },
  8: { id: "changing-weather", name: "Changing Weather", summary: "Roll the weather again; on Perfect Conditions the ball scatters." },
  9: { id: "quick-snap", name: "Quick Snap", summary: "The receiving team may move some open players one square." },
  12: { id: "pitch-invasion", name: "Pitch Invasion", summary: "Fans storm the pitch; some players on both sides may be knocked over." },
};
const BB2025_ONLY: Record<number, Omit<KickoffEvent, "total">> = {
  10: { id: "charge", name: "Charge!", summary: "The kicking team takes a short free turn before the ball lands." },
  11: { id: "dodgy-snack", name: "Dodgy Snack", summary: "A random player feels unwell: weaker for the drive, or off to the reserves." },
};
const BB2020_ONLY: Record<number, Omit<KickoffEvent, "total">> = {
  10: { id: "blitz", name: "Blitz", summary: "The kicking team takes a short free turn before the ball lands." },
  11: { id: "officious-ref", name: "Officious Ref", summary: "A random player argues with the referee and may be sent off." },
};

/** The kick-off table of a ruleset, 2..12. */
export function kickoffTable(ruleset: DiceRuleset = DEFAULT_DICE_RULESET): KickoffEvent[] {
  const own = ruleset === "BB2020" ? BB2020_ONLY : BB2025_ONLY;
  return Array.from({ length: 11 }, (_, i) => i + 2).map((total) => ({ total, ...(COMMON[total] ?? own[total])! }));
}

/** The kick-off event for a 2D6 total (2..12). */
export function kickoffEvent(total: number, ruleset: DiceRuleset = DEFAULT_DICE_RULESET): KickoffEvent {
  const e = kickoffTable(ruleset).find((x) => x.total === total);
  if (!e) throw new RangeError("kickoffEvent: total 2-12");
  return e;
}
