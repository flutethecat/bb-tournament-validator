/** Tier resolution helpers (pure). */

import { normName } from "../dataset/lookup";
import type { TierDef, TournamentPackage } from "./types";

/** roster (normalised) → first tier listing it, per tiers array (built once per package). The entry
 *  remembers each tier's identity, rosters array and length (O(tiers), at most 10) so an in-place
 *  edit of the tiers rebuilds the index instead of serving a stale answer. */
const tierIndexCache = new WeakMap<TierDef[], { shape: unknown[]; index: Map<string, TierDef> }>();

function tierShape(tiers: TierDef[]): unknown[] {
  return tiers.flatMap((t) => [t, t.rosters, t.rosters?.length]);
}

/** The tier a race belongs to (first tier listing it), or undefined if the package has no tiers /
 *  the race is unassigned. A Map lookup after a per-package index — no scan of every roster. */
export function resolveTier(pkg: TournamentPackage, race: string): TierDef | undefined {
  if (!pkg.tiers?.length) return undefined;
  const tiers = pkg.tiers;
  const shape = tierShape(tiers);
  let cached = tierIndexCache.get(tiers);
  if (!cached || cached.shape.length !== shape.length || cached.shape.some((item, i) => item !== shape[i])) {
    const index = new Map<string, TierDef>();
    for (const tier of tiers) {
      for (const roster of tier.rosters ?? []) {
        const key = normName(roster);
        if (!index.has(key)) index.set(key, tier);
      }
    }
    cached = { shape, index };
    tierIndexCache.set(tiers, cached);
  }
  return cached.index.get(normName(race));
}

/** True when the package uses tier-based configuration. */
export function hasTiers(pkg: TournamentPackage): boolean {
  return !!pkg.tiers && pkg.tiers.length > 0;
}
