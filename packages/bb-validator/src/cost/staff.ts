/**
 * Sideline staff pricing from COUNTS (generic; the Sevens profile turns it on). A package with `staffPrices` has its staff
 * gold recomputed here instead of trusting a sheet's `summary.sidelineCost` (spec-sevens-rules-2026-11-02 section 5: a
 * 50k reroll must not slip through). Pure, browser-safe.
 */

import type { Roster } from "../model/roster";
import type { StaffPrices, TournamentPackage } from "../package/types";

/** Standard BB2025 staff prices (the composer's): reroll = roster price, apothecary 50k, coach / cheerleader / fan 10k. */
export const STANDARD_STAFF_PRICES: Readonly<Required<StaffPrices>> = {
  reRoll: null,
  assistantCoach: 10_000,
  cheerleader: 10_000,
  apothecary: 50_000,
  dedicatedFan: 10_000,
};

/** Effective prices: the package block over the standard prices; null when the package doesn't set `staffPrices`. */
export function effectiveStaffPrices(pkg: Pick<TournamentPackage, "staffPrices">): Required<StaffPrices> | null {
  if (!pkg.staffPrices) return null;
  return { ...STANDARD_STAFF_PRICES, ...pkg.staffPrices };
}

export type StaffKey = "reRolls" | "apothecary" | "assistantCoaches" | "cheerleaders" | "dedicatedFans";

export interface StaffLine {
  key: StaffKey;
  /** Plain label for messages ("rerolls", "assistant coaches"). */
  label: string;
  count: number;
  /** Units priced (count minus the free Dedicated Fans). */
  paid: number;
  each: number;
  gold: number;
}

/**
 * Price a sideline from its counts. `rosterReRollCost` is used when the reroll price is null (roster price); `freeFans` is
 * `sideline.dedicatedFansStart` (default 1, the BB2025 free fan).
 */
export function priceStaff(
  sideline: Roster["sideline"],
  prices: Required<StaffPrices>,
  rosterReRollCost: number,
  freeFans = 1,
): { lines: StaffLine[]; total: number } {
  const reRoll = prices.reRoll ?? rosterReRollCost;
  const line = (key: StaffKey, label: string, count: number, each: number, free = 0): StaffLine => {
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const paid = Math.max(0, n - free);
    return { key, label, count: n, paid, each, gold: paid * each };
  };
  const lines = [
    line("reRolls", "rerolls", sideline.reRolls, reRoll),
    line("apothecary", "apothecary", sideline.apothecary ? 1 : 0, prices.apothecary),
    line("assistantCoaches", "assistant coaches", sideline.assistantCoaches, prices.assistantCoach),
    line("cheerleaders", "cheerleaders", sideline.cheerleaders, prices.cheerleader),
    line("dedicatedFans", "dedicated fans", sideline.dedicatedFans, prices.dedicatedFan, Math.max(0, freeFans)),
  ];
  return { lines, total: lines.reduce((sum, l) => sum + l.gold, 0) };
}
