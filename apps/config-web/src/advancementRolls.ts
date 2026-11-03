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
 * The category tables are the BB2025 Skill Table as printed (https://bloodbowlbase.ru/bb2025/core_rules/skills_and_traits/,
 * section "Skill Table"): the first D6 picks the column (1-3 or 4-6), the second D6 the row. Skill names only; the names
 * resolve to the validator dataset's spelling (canonSkill), and a test checks every cell.
 *
 * Taking restrictions (same page, each skill's entry; summarised, names only): some skills need a trait or rule the player
 * already has, and some pairs exclude each other. SKILL_RESTRICTIONS holds them; skillTakeBlock applies them. A random
 * result the player may not take is rolled again, like an owned one.
 */
import { bb2025 } from "@bb/validator/dataset";
import { canonSkill, type SkillCategory } from "@bb/validator";
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

/**
 * The BB2025 Skill Table as printed, per category: [column 1-3, column 4-6], each listing rows 1..6 (the second D6).
 * Printed spellings; skillTable() maps them to the dataset's names.
 */
export const PRINTED_SKILL_TABLE: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  General: [["Block", "Dauntless", "Fend", "Frenzy", "Kick", "Pro"], ["Steady Footing", "Strip Ball", "Sure Hands", "Tackle", "Taunt", "Wrestle"]],
  Agility: [["Catch", "Diving Catch", "Diving Tackle", "Dodge", "Defensive", "Hit and Run"], ["Jump Up", "Leap", "Safe Pair of Hands", "Sidestep", "Sprint", "Sure Feet"]],
  Strength: [["Arm Bar", "Brawler", "Break Tackle", "Bullseye", "Grab", "Guard"], ["Juggernaut", "Mighty Blow", "Multiple Block", "Stand Firm", "Strong Arm", "Thick Skull"]],
  Passing: [["Accurate", "Cannoneer", "Cloud Burster", "Dump-off", "Give and Go", "Hail Mary Pass"], ["Leader", "Nerves of Steel", "On the Ball", "Pass", "Punt", "Safe Pass"]],
  Mutation: [["Big Hand", "Claws", "Disturbing Presence", "Extra Arms", "Foul Appearance", "Horns"], ["Iron Hard Skin", "Monstrous Mouth", "Prehensile Tail", "Tentacles", "Two Heads", "Very Long Legs"]],
  Devious: [["Dirty Player", "Eye Gouge", "Fumblerooski", "Lethal Flight", "Lone Fouler", "Pile Driver"], ["Put the Boot In", "Quick Foul", "Saboteur", "Shadowing", "Sneaky Git", "Violent Innovator"]],
};

const DATASET_NAME = new Map(Object.keys(bb2025.skills).map((name) => [canonSkill(name), name] as const));
/** A skill name in the dataset's spelling (printed "Hit and Run" -> "Hit And Run"); unknown names are kept. */
export const datasetSkillName = (name: string): string => DATASET_NAME.get(canonSkill(name)) ?? name;

/** The category's skill table in table order (entries 1-6 = column 1-3, entries 7-12 = column 4-6), dataset spellings. */
export function skillTable(category: SkillCategory | string): string[] {
  const t = PRINTED_SKILL_TABLE[category];
  return t ? [...t[0], ...t[1]].map(datasetSkillName) : [];
}

/** BB2025 taking restrictions (skills_and_traits, each skill's entry): what the player must already have, and what the
 *  skill can't be combined with (both directions are listed on each side). */
export const SKILL_RESTRICTIONS: Readonly<Record<string, { needsAny?: readonly string[]; excludes?: readonly string[] }>> = {
  "Lethal Flight": { needsAny: ["Right Stuff"] },
  Saboteur: { needsAny: ["Secret Weapon"] },
  Bullseye: { needsAny: ["Throw Team-mate"] },
  "Strong Arm": { needsAny: ["Throw Team-mate"] },
  // a TRAIT that grants a Special Action (the eight Traits whose text names one; Monstrous Mouth's Chomp and Punt are
  // Skills, Throw Team-mate grants an Action, not a Special Action)
  "Violent Innovator": { needsAny: ["Ball & Chain", "Bombardier", "Breathe Fire", "Chainsaw", "Hypnotic Gaze", "Kick Team-mate", "Projectile Vomit", "Stab"] },
  Frenzy: { excludes: ["Grab", "Hit and Run", "Multiple Block", "Ball & Chain"] },
  Grab: { excludes: ["Frenzy", "Ball & Chain"] },
  "Multiple Block": { excludes: ["Frenzy", "Ball & Chain"] },
  "Hit and Run": { excludes: ["Frenzy", "Ball & Chain"] },
  Leap: { excludes: ["Pogo", "Ball & Chain"] },
  // Ball & Chain's own list of skills its holder can't have
  "Diving Tackle": { excludes: ["Ball & Chain"] },
  "Eye Gouge": { excludes: ["Ball & Chain"] },
  "On the Ball": { excludes: ["Ball & Chain"] },
  Shadowing: { excludes: ["Ball & Chain"] },
  "Steady Footing": { excludes: ["Ball & Chain"] },
};
const RESTRICTION = new Map(Object.entries(SKILL_RESTRICTIONS).map(([k, v]) => [canonSkill(k), v] as const));
/** "Hatred (Troll)", "Loner (4+)", "Ball & Chain*": the bare name, keyed like the dataset. */
const bareKey = (s: string): string => canonSkill(s.replace(/\s*\(.*\)\s*$/, "").replace(/\*+$/, ""));

/** Why the player may not take `skill` given what they own ("" = may). Ownership is checked by the callers' own lists. */
export function skillTakeBlock(skill: string, owned: readonly string[]): string {
  const r = RESTRICTION.get(bareKey(skill));
  if (!r) return "";
  const have = new Set(owned.map(bareKey));
  if (r.needsAny && !r.needsAny.some((x) => have.has(bareKey(x)))) return `${datasetSkillName(skill)} needs ${r.needsAny.join(" or ")}.`;
  const clash = r.excludes?.find((x) => have.has(bareKey(x)));
  return clash ? `${datasetSkillName(skill)} can't be combined with ${clash}.` : "";
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
