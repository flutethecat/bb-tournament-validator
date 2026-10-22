/**
 * Generic cost/count helpers for the package knobs added for tiered "stack / elite / stat /
 * star-pack" rulesets (first user: Small Gods). Pure; no package special-casing.
 *   - statIncreasesOf / statIncreasesGold — characteristic increases detected by diffing a
 *     player's printed stats against its dataset position.
 *   - starPackPicks — groups hired stars into PICKS (a dataset pair = one pick), maps each pick
 *     to its star pack, and prices the pack fees.
 */

import { findStar, isStarName, normName } from "../dataset/lookup";
import type { Dataset, DatasetPosition } from "../dataset/types";
import type { RosterPlayer } from "../model/roster";
import type { ResolvedStatIncreases } from "../package/resolveConfig";
import type { StarPack, StatKey, TournamentPackage } from "../package/types";

const target = (t: string | undefined): number | null => {
  const m = /^(\d+)\+$/.exec((t ?? "").trim());
  return m ? Number(m[1]) : null;
};

/** Cap on detected steps per characteristic: no legal BB2025 player is more than a few steps off
 *  its position, and an unbounded diff (e.g. a crafted MA of 1e309 → Infinity) must never drive
 *  an unbounded loop. Anything non-finite counts as the cap. */
export const MAX_STAT_STEPS = 10;

/** Characteristics whose diff vs the position exceeds MAX_STAT_STEPS (or is non-finite). Such a
 *  player is ILLEGAL (the stat-increases rule errors); statIncreasesOf only lists the bounded steps. */
export function statIncreasesOverLimit(player: RosterPlayer, position: DatasetPosition): StatKey[] {
  const over: StatKey[] = [];
  const check = (k: StatKey, n: number | null) => {
    if (n != null && (!Number.isFinite(n) ? n > 0 || Number.isNaN(n) : n > MAX_STAT_STEPS)) over.push(k);
  };
  check("MA", player.MA - position.MA);
  check("ST", player.ST - position.ST);
  const d = (a: number | null, b: number | null) => (a != null && b != null ? a - b : null);
  check("AG", d(target(position.AG), target(player.AG)));
  check("PA", d(target(position.PA), target(player.PA)));
  check("AV", d(target(player.AV), target(position.AV)));
  return over;
}

/** The characteristic increases a player carries vs its dataset position (repeats = multiple steps).
 *  Bounded at MAX_STAT_STEPS per characteristic; see statIncreasesOverLimit for the excess. */
export function statIncreasesOf(player: RosterPlayer, position: DatasetPosition): StatKey[] {
  const out: StatKey[] = [];
  const push = (k: StatKey, n: number) => {
    const steps = Number.isFinite(n) ? Math.min(MAX_STAT_STEPS, Math.max(0, Math.floor(n))) : n > 0 ? MAX_STAT_STEPS : 0;
    for (let i = 0; i < steps; i++) out.push(k);
  };
  push("MA", Math.max(0, player.MA - position.MA));
  push("ST", Math.max(0, player.ST - position.ST));
  const ag = [target(position.AG), target(player.AG)] as const;
  if (ag[0] != null && ag[1] != null) push("AG", Math.max(0, ag[0] - ag[1]));
  const pa = [target(position.PA), target(player.PA)] as const;
  if (pa[0] != null && pa[1] != null) push("PA", Math.max(0, pa[0] - pa[1]));
  const av = [target(position.AV), target(player.AV)] as const;
  if (av[0] != null && av[1] != null) push("AV", Math.max(0, av[1] - av[0]));
  return out;
}

/** Gold for a list of increases under the resolved costs (unpriced stats cost 0). */
export function statIncreaseGold(incs: readonly StatKey[], cfg: ResolvedStatIncreases | undefined): number {
  if (!cfg) return 0;
  return incs.reduce((sum, k) => sum + (cfg.costGold[k] ?? 0), 0);
}

/** Team-wide stat-increase gold for resolved players (non-stars with a dataset position). */
export function statIncreasesGold(
  players: readonly { player: RosterPlayer; position?: DatasetPosition }[],
  cfg: ResolvedStatIncreases | undefined,
): number {
  if (!cfg) return 0;
  return players.reduce(
    (sum, rp) => sum + (rp.position ? statIncreaseGold(statIncreasesOf(rp.player, rp.position), cfg) : 0),
    0,
  );
}

/** One star hire: a single star, or a dataset pair hired together. */
export interface StarPick {
  /** Canonical names of the star(s) in this pick. */
  names: string[];
  playerRefs: number[];
  /** The pack the pick belongs to (first matching pack), if any. */
  pack?: StarPack;
}

const packHas = (pack: StarPack, names: readonly string[]): boolean =>
  pack.stars.some((s) => names.some((n) => normName(n) === normName(s)));

/**
 * Group the roster's stars into picks and price pack fees. Fees: feeMode "once" charges the
 * pack fee once if the pack has any pick; "each" (default) charges it per pick.
 * Without `pkg.starPacks`, every star is its own pick and fees are 0.
 */
export function starPackPicks(
  players: readonly { player: RosterPlayer }[],
  pkg: TournamentPackage,
  data: Dataset,
): { picks: StarPick[]; feesGold: number } {
  const stars = players.filter((rp) => isStarName(data, rp.player.positionName));
  const picks: StarPick[] = [];
  const used = new Set<number>();
  stars.forEach((rp, i) => {
    if (used.has(i)) return;
    used.add(i);
    const star = findStar(data, rp.player.positionName);
    const name = star?.name ?? rp.player.positionName;
    const pick: StarPick = { names: [name], playerRefs: [rp.player.number] };
    const partner = star?.pairedWith;
    if (partner) {
      const j = stars.findIndex((o, k) => !used.has(k) && normName(o.player.positionName) === normName(partner));
      if (j >= 0) {
        used.add(j);
        pick.names.push(findStar(data, stars[j]!.player.positionName)?.name ?? stars[j]!.player.positionName);
        pick.playerRefs.push(stars[j]!.player.number);
      }
    }
    // A lone half of a pair still matches a pack that lists only its partner.
    const lookup = partner ? [...pick.names, partner] : pick.names;
    const pack = pkg.starPacks?.find((p) => packHas(p, lookup));
    if (pack) pick.pack = pack;
    picks.push(pick);
  });
  let feesGold = 0;
  for (const pack of pkg.starPacks ?? []) {
    const n = picks.filter((p) => p.pack === pack).length;
    if (n === 0) continue;
    feesGold += pack.feeMode === "once" ? pack.fee : pack.fee * n;
  }
  return { picks, feesGold };
}
