/**
 * BB2025 value of one characteristic improvement (gold). ONE table for the site: the league team value fallback and result
 * banking (via teamAdvancement.ts, which re-exports it) and the Roster Builder's Free Create value display
 * (spa/src/teams/builder.ts). Pure, no imports, so the SPA can load it.
 */
export type CharacteristicKey = "MA" | "ST" | "AG" | "PA" | "AV";
export const CHARACTERISTIC_VALUE: Readonly<Record<CharacteristicKey, number>> = { AV: 10_000, MA: 20_000, PA: 20_000, AG: 30_000, ST: 60_000 };
