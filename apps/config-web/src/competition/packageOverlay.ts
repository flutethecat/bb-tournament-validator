/**
 * A competition's house rules applied to a COPY of its ruleset package before a roster is validated (creation wizards v2,
 * lane 1). The shared package file is never changed. Only what the validator already has hooks for is enforced:
 *
 * - Prayers to Nuffle banned  -> the inducement's cap becomes 0 (`inducements.caps.prayers_to_nuffle`).
 * - Max stat increases per player -> `statIncreases.maxPerPlayer` (the lower of the package's and the house rule's), at
 *   the flat level and on every tier / team rule that sets its own (those merge over the flat value).
 * - Max stat increases per team   -> `special.statIncreaseRules.maxPerTeam` (the lower of the two).
 *
 * Display-only (no validator hook): a Prayers to Nuffle cost change, Brawling Brutes, progression, MVP, hire/fire. A stat
 * cap on a package that does not check stat increases at all changes nothing (the package decides whether they are allowed).
 */
import type { HouseRules } from "./houseRules.js";

export const PRAYERS_INDUCEMENT_ID = "prayers_to_nuffle";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const lower = (current: unknown, cap: number): number => (typeof current === "number" && current < cap ? current : cap);

function capStatLevel(level: unknown, cap: number): void {
  if (!isObj(level) || !isObj(level.statIncreases)) return;
  level.statIncreases.maxPerPlayer = lower(level.statIncreases.maxPerPlayer, cap);
}

export function applyHouseRulesToPackage<T extends object>(pkg: T, rules: HouseRules | undefined): T {
  if (!rules) return pkg;
  const out = structuredClone(pkg) as unknown as Json;
  if (rules.prayers.mode === "banned") {
    const ind = isObj(out.inducements) ? out.inducements : (out.inducements = {});
    const caps = isObj((ind as Json).caps) ? (ind as Json).caps as Json : ((ind as Json).caps = {});
    (caps as Json)[PRAYERS_INDUCEMENT_ID] = 0;
  }
  const perPlayer = rules.maxStatIncreasesPlayer;
  if (perPlayer !== null) {
    capStatLevel(out, perPlayer);
    for (const tier of Array.isArray(out.tiers) ? out.tiers : []) capStatLevel(tier, perPlayer);
    for (const rule of Array.isArray(out.teamRules) ? out.teamRules : []) capStatLevel(rule, perPlayer);
  }
  const perTeam = rules.maxStatIncreasesTeam;
  if (perTeam !== null && isObj(out.special)) {
    const r = isObj(out.special.statIncreaseRules) ? out.special.statIncreaseRules : (out.special.statIncreaseRules = {});
    (r as Json).maxPerTeam = lower((r as Json).maxPerTeam, perTeam);
  }
  return out as unknown as T;
}
