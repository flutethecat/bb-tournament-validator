import { inducementWireGold, type Dataset, type TournamentPackage } from "@bb/validator";

export interface TeamBuilderInducementCatalogRow {
  key: string;
  label: string;
  price: number;
  max: number | null;
  allowed: boolean;
}

/** Public builder catalog: only fixed-price inducements the fork can roster in team XML. */
export function teamBuilderInducementCatalog(
  pkg: TournamentPackage,
  data: Dataset,
): TeamBuilderInducementCatalogRow[] {
  const allAllowed = pkg.inducements.allowed.includes("*");
  return Object.entries(data.inducements)
    .filter(([, inducement]) => typeof inducement.wireName === "string" && inducement.wireName.trim() !== "")
    .map(([key, inducement]) => ({
      key,
      label: inducement.name,
      price: inducementWireGold(data, key),
      max: pkg.inducements.caps[key] ?? inducement.max ?? null,
      allowed: allAllowed || pkg.inducements.allowed.includes(key),
    }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
