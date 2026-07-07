/**
 * Unified per-team rule resolution (pure). Every configuration method — flat
 * package, tiers, matrix, and per-team rules — resolves here into one effective
 * rule for a given race. Precedence (most specific wins):
 *   team rules  >  matrix cell  >  tier  >  flat package
 * Global banned stars union into the result from every level.
 */

import { normName } from "../dataset/lookup";
import type { MatrixCell, TournamentPackage } from "./types";
import { resolveTier } from "./tiers";

export interface ResolvedTeamConfig {
  gold: number | null;
  skillPointBudget: number;
  /** COUNT mode limits (null = not enforced; SP budget applies instead). */
  maxPrimary: number | null;
  maxSecondary: number | null;
  secondarySwap: boolean;
  /** Skill stacking cap: max players with >1 added skill (null = no cap). */
  maxStackedPlayers: number | null;
  starPlayersAllowed: boolean;
  bannedStars: string[];
  /** Which source set the skill/gold limits — for messaging. */
  source: "flat" | "tier" | "matrix" | "team";
  /** Tier number, when a tier applies. */
  tierNumber?: number;
}

/** Human label of where a team's rules came from, e.g. " (Tier 1)". */
export function sourceLabel(cfg: ResolvedTeamConfig): string {
  if (cfg.source === "tier") return ` (Tier ${cfg.tierNumber})`;
  if (cfg.source === "matrix") return " (matrix)";
  if (cfg.source === "team") return " (team rule)";
  return "";
}

/** The matrix cell a race sits in (with its column gold + row skill counts), if any. */
export function resolveMatrixCell(
  pkg: TournamentPackage,
  race: string,
):
  | (MatrixCell & {
      gold: number;
      primary: number;
      secondary: number;
      secondarySwap: boolean;
      maxStackedPlayers?: number | null;
    })
  | undefined {
  const m = pkg.matrix;
  if (!m) return undefined;
  const want = normName(race);
  const cell = m.cells.find((c) => c.teams.some((t) => normName(t) === want));
  if (!cell) return undefined;
  const col = m.columns[cell.col];
  const row = m.rows[cell.row];
  if (!col || !row) return undefined;
  return {
    ...cell,
    gold: col.gold,
    primary: row.primary,
    secondary: row.secondary,
    secondarySwap: row.secondarySwap,
    maxStackedPlayers: row.maxStackedPlayers,
  };
}

export function resolveTeamConfig(pkg: TournamentPackage, race: string): ResolvedTeamConfig {
  const sa = pkg.skillAllotment;
  const cfg: ResolvedTeamConfig = {
    gold: pkg.goldBudget,
    skillPointBudget: sa.skillPointBudget,
    maxPrimary: sa.maxPrimary ?? null,
    maxSecondary: sa.maxSecondary ?? null,
    secondarySwap: sa.secondarySwap ?? false,
    maxStackedPlayers: sa.maxStackedPlayers ?? null,
    starPlayersAllowed: pkg.starPlayers.allowed,
    bannedStars: [...(pkg.bannedStars ?? [])],
    source: "flat",
  };
  const addBans = (names?: string[]) => {
    for (const n of names ?? []) if (!cfg.bannedStars.some((b) => normName(b) === normName(n))) cfg.bannedStars.push(n);
  };

  const tier = resolveTier(pkg, race);
  if (tier) {
    if (tier.gold != null) cfg.gold = tier.gold;
    if (tier.skillPointBudget != null) cfg.skillPointBudget = tier.skillPointBudget;
    if (tier.maxPrimary != null) cfg.maxPrimary = tier.maxPrimary;
    if (tier.maxSecondary != null) cfg.maxSecondary = tier.maxSecondary;
    if (tier.secondarySwap !== undefined) cfg.secondarySwap = tier.secondarySwap;
    if (tier.maxStackedPlayers !== undefined) cfg.maxStackedPlayers = tier.maxStackedPlayers;
    cfg.starPlayersAllowed = tier.starPlayersAllowed;
    addBans(tier.bannedStars);
    cfg.source = "tier";
    cfg.tierNumber = tier.tier;
  }

  const cell = resolveMatrixCell(pkg, race);
  if (cell) {
    cfg.gold = cell.gold;
    cfg.maxPrimary = cell.primary;
    cfg.maxSecondary = cell.secondary;
    cfg.secondarySwap = cell.secondarySwap;
    if (cell.maxStackedPlayers !== undefined) cfg.maxStackedPlayers = cell.maxStackedPlayers;
    if (cell.starPlayersAllowed != null) cfg.starPlayersAllowed = cell.starPlayersAllowed;
    addBans(cell.bannedStars);
    cfg.source = "matrix";
  }

  const tr = pkg.teamRules?.find((t) => normName(t.team) === normName(race));
  if (tr) {
    if (tr.gold !== undefined) cfg.gold = tr.gold;
    if (tr.skillPointBudget != null) cfg.skillPointBudget = tr.skillPointBudget;
    if (tr.maxPrimary !== undefined) cfg.maxPrimary = tr.maxPrimary;
    if (tr.maxSecondary !== undefined) cfg.maxSecondary = tr.maxSecondary;
    if (tr.secondarySwap !== undefined) cfg.secondarySwap = tr.secondarySwap;
    if (tr.maxStackedPlayers !== undefined) cfg.maxStackedPlayers = tr.maxStackedPlayers;
    if (tr.starPlayersAllowed !== undefined) cfg.starPlayersAllowed = tr.starPlayersAllowed;
    addBans(tr.bannedStars);
    cfg.source = "team";
  }

  return cfg;
}

/** Does the package use COUNT-mode skill limits for this race? */
export function usesCountMode(cfg: ResolvedTeamConfig): boolean {
  return cfg.maxPrimary != null || cfg.maxSecondary != null;
}

/** Eligibility across all bucketing methods (matrix > tiers > eligibleRosters). */
export function isEligible(pkg: TournamentPackage, race: string): boolean {
  const want = normName(race);
  if (pkg.matrix?.cells.length) return pkg.matrix.cells.some((c) => c.teams.some((t) => normName(t) === want));
  if (pkg.tiers?.length) return pkg.tiers.some((t) => t.rosters.some((r) => normName(r) === want));
  if (pkg.eligibleRosters.includes("*")) return true;
  return pkg.eligibleRosters.some((r) => normName(r) === want);
}

/** The set of eligible team names (for a helpful "not eligible" message). */
export function eligibleTeamNames(pkg: TournamentPackage): string[] {
  if (pkg.matrix?.cells.length) return [...new Set(pkg.matrix.cells.flatMap((c) => c.teams))];
  if (pkg.tiers?.length) return [...new Set(pkg.tiers.flatMap((t) => t.rosters))];
  return pkg.eligibleRosters;
}

/**
 * Can a team that used `p` primary-access and `s` secondary-access added skills
 * fit within `P` primary + `S` secondary slots?
 * General rule (always): a secondary slot may hold a primary skill (downgrade).
 * Secondary Swap (when allowed): two primary slots may be traded for one secondary.
 */
export function fitsSkillCounts(
  p: number,
  s: number,
  P: number | null,
  S: number | null,
  secondarySwap: boolean,
): boolean {
  const primaryCap = P ?? Infinity;
  const secondaryCap = S ?? Infinity;
  const maxSwap = secondarySwap && Number.isFinite(primaryCap) ? Math.floor(primaryCap / 2) : 0;
  // k = secondary skills satisfied by trading 2 primary slots.
  for (let k = 0; k <= Math.min(s, maxSwap); k++) {
    const primaryLeft = primaryCap - 2 * k;
    const secondaryForSecondary = s - k;
    if (primaryLeft < 0) break;
    if (secondaryForSecondary > secondaryCap) continue;
    const secondaryLeft = secondaryCap - secondaryForSecondary;
    // primary skills may use leftover primary OR secondary slots (downgrade).
    if (p <= primaryLeft + secondaryLeft) return true;
  }
  return false;
}

/**
 * Parse a Blood Bowl gold value the way tournament packs write it:
 *   "1150" -> 1_150_000   (bare integer = thousands, bbtc convention)
 *   "1.15M" / "1.15m" -> 1_150_000
 *   "1150k" / "1150K" -> 1_150_000
 *   "1150000" -> 1_150_000 (already full gold, >= 100000 passes through)
 * Returns null for blank/invalid.
 */
export function parseGold(input: string | number | null | undefined): number | null {
  if (input == null || input === "") return null;
  if (typeof input === "number") return input;
  const s = input.trim().toLowerCase().replace(/,/g, "");
  let m = s.match(/^(\d+(?:\.\d+)?)\s*m$/);
  if (m) return Math.round(parseFloat(m[1]!) * 1_000_000);
  m = s.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (m) return Math.round(parseFloat(m[1]!) * 1_000);
  m = s.match(/^(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (s.includes(".")) return Math.round(n * 1_000_000); // "1.15" -> 1.15M
  if (n >= 100_000) return Math.round(n); // already full gold
  return Math.round(n * 1_000); // "1150" -> 1,150k
}
