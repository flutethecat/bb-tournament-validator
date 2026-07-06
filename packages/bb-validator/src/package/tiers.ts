/** Tier resolution helpers (pure). */

import { normName } from "../dataset/lookup";
import type { TierDef, TournamentPackage } from "./types";

/** The tier a race belongs to, or undefined if the package has no tiers / the race is unassigned. */
export function resolveTier(pkg: TournamentPackage, race: string): TierDef | undefined {
  if (!pkg.tiers?.length) return undefined;
  const want = normName(race);
  return pkg.tiers.find((t) => t.rosters.some((r) => normName(r) === want));
}

/** True when the package uses tier-based configuration. */
export function hasTiers(pkg: TournamentPackage): boolean {
  return !!pkg.tiers && pkg.tiers.length > 0;
}
