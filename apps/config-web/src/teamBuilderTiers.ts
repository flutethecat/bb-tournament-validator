import { resolveTeamConfig, resolveTier, type Dataset, type TournamentPackage } from "@bb/validator";
import { builderRaceRules, type BuilderRaceRules } from "./teamBuilderPackage.js";

export interface TeamBuilderTierCatalogRow {
  name: string;
  tier: number;
  source: "package" | "default";
  /** Present only with `withRules` (a selected tournament package) for package-assigned races. */
  gold?: number | null;
  rules?: BuilderRaceRules;
}

/** Public builder catalog: package tier assignments with dataset suggestions as fallback. */
export function teamBuilderTierCatalog(
  pkg: TournamentPackage,
  data: Dataset,
  withRules = false,
): TeamBuilderTierCatalogRow[] {
  return data.teams.map((team) => {
    const assignedTier = resolveTier(pkg, team.name);
    if (!assignedTier) return { name: team.name, tier: team.defaultTier, source: "default" };
    const row: TeamBuilderTierCatalogRow = { name: team.name, tier: assignedTier.tier, source: "package" };
    if (withRules) {
      row.gold = resolveTeamConfig(pkg, team.name).gold;
      row.rules = builderRaceRules(pkg, team.name);
    }
    return row;
  });
}
