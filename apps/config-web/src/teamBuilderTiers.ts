import { resolveTier, type Dataset, type TournamentPackage } from "@bb/validator";

export interface TeamBuilderTierCatalogRow {
  name: string;
  tier: number;
  source: "package" | "default";
}

/** Public builder catalog: package tier assignments with dataset suggestions as fallback. */
export function teamBuilderTierCatalog(
  pkg: TournamentPackage,
  data: Dataset,
): TeamBuilderTierCatalogRow[] {
  return data.teams.map((team) => {
    const assignedTier = resolveTier(pkg, team.name);
    return assignedTier
      ? { name: team.name, tier: assignedTier.tier, source: "package" }
      : { name: team.name, tier: team.defaultTier, source: "default" };
  });
}
