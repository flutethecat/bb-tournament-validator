/**
 * Advancement rolls (spec-forfeit-and-dice-2026-11-02, Q7): the BB2025 random-skill and characteristic-improvement rules
 * as pure functions of the site roller (src/dice/roller.ts), so the league team page and the fork's team advancement
 * (src/teamAdvancement.ts) roll the same tables the same way and a test can replay a roll exactly.
 *
 * Rules (BB2025 League Play, "Player Advancement"; https://bloodbowlbase.ru/bb2025/core_rules/league_play/):
 *  - Random Primary skill: the coach picks a Primary category; two D6 pick the skill on that category's table (the first
 *    die the half, the second the entry). This is done twice and the coach keeps one of the two. A skill the player
 *    already has, or cannot take, is rolled again. If both rolls give the same skill, the coach must take it.
 *    BB2025 has no random Secondary row: Secondary skills are chosen only (the ADVANCEMENT_ROWS costs have no such column).
 *  - Characteristic improvement: a D8 on the table below; the coach picks one of the characteristics the result allows,
 *    or a Primary or Secondary skill instead (the SPP stays spent). A characteristic never improves more than twice, nor
 *    past its maximum.
 *
 * The category table: the dataset's 12 selectable skills of a category in alphabetical order (the printed tables list
 * them alphabetically): D6 1-3 = entries 1-6, D6 4-6 = entries 7-12, the second D6 the entry within the half.
 */
import { bb2025 } from "@bb/validator/dataset";
import type { SkillCategory } from "@bb/validator";
import { rollDie, type Roller } from "./dice/roller.js";

export type CharacteristicStat = "MA" | "ST" | "AG" | "PA" | "AV";
export const CHARACTERISTIC_STATS: readonly CharacteristicStat[] = ["MA", "ST", "AG", "PA", "AV"];

/** BB2025 characteristic improvement table (D8 result -> the characteristics the coach may improve). */
export const CHARACTERISTIC_TABLE: Readonly<Record<number, readonly CharacteristicStat[]>> = {
  1: ["AV"], 2: ["AV", "PA"], 3: ["AV", "MA", "PA"], 4: ["AV", "MA", "PA"],
  5: ["MA", "PA"], 6: ["AG", "MA"], 7: ["AG", "ST"], 8: ["MA", "ST", "AG", "PA", "AV"],
};

/** The best value a characteristic may reach (MA / ST / AV rise to it; the AG / PA targets fall to it). */
export const CHARACTERISTIC_BEST: Readonly<Record<CharacteristicStat, number>> = { MA: 9, ST: 8, AG: 1, PA: 1, AV: 11 };
/** A characteristic improves at most this many times. */
export const CHARACTERISTIC_MAX_STEPS = 2;

/** The category's skill table: its selectable dataset skills, alphabetical (12 in every BB2025 category). */
export function skillTable(category: SkillCategory | string): string[] {
  return Object.entries(bb2025.skills)
    .filter(([, meta]) => meta.category === category && !meta.trait)
    .map(([name]) => name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** The table entry two D6 select (first die: 1-3 the first half, 4-6 the second; second die: the entry). */
export function tableEntry(table: readonly string[], first: number, second: number): string | undefined {
  if (!Number.isInteger(first) || !Number.isInteger(second) || first < 1 || first > 6 || second < 1 || second > 6) return undefined;
  const half = Math.ceil(table.length / 2);
  return table[(first <= 3 ? 0 : half) + second - 1];
}

export interface SkillTableRoll { dice: [number, number]; skill: string; /** true = owned or not allowed: rolled again */ rerolled?: true }

export interface RandomSkillResult {
  category: string;
  /** Every 2D6 roll in order, rerolls included. */
  rolls: SkillTableRoll[];
  /** The two kept results, in roll order. */
  picks: [string, string];
  /** Both rolls gave the same skill: the coach must take it. */
  forced: boolean;
}

/** The most table rolls one random skill may take before giving up (unreachable while a legal entry exists). */
const MAX_TABLE_ROLLS = 400;

/**
 * Rolls a random skill on a category table with the site roller: two legal results, rerolling owned or illegal entries.
 * `legal(skill)` says whether the player may take the skill. Throws when no entry of the table is legal (check first).
 */
export function rollRandomSkill(roller: Roller, category: string, legal: (skill: string) => boolean): RandomSkillResult {
  const table = skillTable(category);
  if (!table.some(legal)) throw new Error("rollRandomSkill: no legal skill in the category");
  const rolls: SkillTableRoll[] = [];
  const picks: string[] = [];
  while (picks.length < 2) {
    if (rolls.length >= MAX_TABLE_ROLLS) throw new Error("rollRandomSkill: too many rerolls");
    const dice: [number, number] = [rollDie(roller, 6), rollDie(roller, 6)];
    const skill = tableEntry(table, dice[0], dice[1]);
    if (!skill || !legal(skill)) { rolls.push({ dice, skill: skill ?? "", rerolled: true }); continue; }
    rolls.push({ dice, skill });
    picks.push(skill);
  }
  return { category, rolls, picks: [picks[0]!, picks[1]!], forced: picks[0] === picks[1] };
}

/** One D8 on the characteristic table. */
export function rollCharacteristic(roller: Roller): { roll: number; allowed: readonly CharacteristicStat[] } {
  const roll = rollDie(roller, 8);
  return { roll, allowed: CHARACTERISTIC_TABLE[roll]! };
}
