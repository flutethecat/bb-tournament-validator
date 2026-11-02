/**
 * Roster Builder "Free Create" (owner 10-31): build any BB2025 roster with no tournament rules and no site validation.
 * A Free Create save is an ordinary builder save whose body.packageName is FREE_CREATE_PACKAGE (and, when the coach
 * ticked "Ignore in-game limits", body.ignoreLimits === true). The server maps the marker to its own build
 * package (teamBuilderPackage.ts FREE_CREATE_BUILD_PACKAGE: no gold cap, no SP budget, characteristic increases allowed),
 * so Create team on Fork runs only the core roster checks. No
 * Node imports, so the SPA shares it.
 */
import { CHARACTERISTIC_VALUE } from "./characteristicValue.js";
export const FREE_CREATE_PACKAGE = "free-create";
export const FREE_CREATE_LABEL = "Free Create";
export const FREE_CREATE_DESCRIPTION = "Build any roster. No tournament rules, no validation.";
export const isFreeCreatePackage = (name: unknown): boolean => name === FREE_CREATE_PACKAGE;

/** Roster Builder "Sevens Free Create" (Sevens spec 11-02, owner Q1 (c)): build any Sevens team under the League draft
 *  rules (the Sevens profile, Dedicated Fans starting at 1, no tiers or added skills). Like Free Create it is a marker,
 *  not a saved package: the server maps it to SEVENS_FREE_CREATE_BUILD_PACKAGE (teamBuilderPackage.ts). Unlike Free Create
 *  the Sevens limits ARE checked (players, non-Linemen, the Veteran, staff, inducements), and it is tabletop-only. */
export const SEVENS_FREE_CREATE_PACKAGE = "sevens-free-create";
export const SEVENS_FREE_CREATE_LABEL = "Sevens Free Create";
export const SEVENS_FREE_CREATE_DESCRIPTION = "Build any Blood Bowl Sevens team: 600k, 7 to 11 players, one Veteran. Tabletop only.";
export const isSevensFreeCreatePackage = (name: unknown): boolean => name === SEVENS_FREE_CREATE_PACKAGE;

/** Free Create gold, ONE implementation for the Roster Builder's value display and the public share view: an added skill
 *  costs 20k primary / 40k secondary (+10k elite), the flat model the validator (DEFAULT_SKILL_GOLD) and the builder core
 *  (SKILL_GOLD) use; a skill outside the position's access (Ignore in-game limits) prices as a secondary; a characteristic
 *  increase costs the league table's CHARACTERISTIC_VALUE. */
export const FREE_CREATE_SKILL_GOLD = { primary: 20_000, secondary: 40_000, eliteSurcharge: 10_000 } as const;
export function freeCreateSkillGold(access: "primary" | "secondary", elite: boolean): number {
  return (access === "secondary" ? FREE_CREATE_SKILL_GOLD.secondary : FREE_CREATE_SKILL_GOLD.primary) + (elite ? FREE_CREATE_SKILL_GOLD.eliteSurcharge : 0);
}
export function freeCreateStatGold(stat: string): number {
  return (CHARACTERISTIC_VALUE as Record<string, number>)[stat] ?? 0;
}

/** BB2025 characteristic caps (the composer's: MA 9, ST 8, AG / PA 1+, AV 11+): why one +`stat` on this position would
 *  break one ("" = fine). Stats are the roster's printed values (numbers or "3+" targets). */
export function statCapReason(position: { MA: unknown; ST: unknown; AG: unknown; PA: unknown; AV: unknown }, stat: string): string {
  const n = (v: unknown): number | null => { const m = /^(\d+)/.exec(String(v ?? "")); return m ? Number(m[1]) : null; };
  const v = n((position as Record<string, unknown>)[stat]);
  if (v === null) return "";
  if (stat === "MA" && v + 1 > 9) return "MA can't go above 9.";
  if (stat === "ST" && v + 1 > 8) return "ST can't go above 8.";
  if (stat === "AV" && v + 1 > 11) return "AV can't go above 11+.";
  if ((stat === "AG" || stat === "PA") && v - 1 < 1) return `${stat} can't improve beyond 1+.`;
  return "";
}
