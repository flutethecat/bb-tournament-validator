import { inducementWireGold, type Dataset, type TournamentPackage } from "@bb/validator";

export interface TeamBuilderInducementCatalogRow {
  key: string;
  label: string;
  price: number;
  max: number | null;
  allowed: boolean;
  /** Price/max for teams with `reducedSpecialRule` (e.g. Bribery and Corruption); omitted when none. */
  reducedPrice?: number;
  reducedMax?: number | null;
  reducedSpecialRule?: string;
}

/** Public builder catalog: only fixed-price inducements the fork can roster in team XML. */
export function teamBuilderInducementCatalog(
  pkg: TournamentPackage,
  data: Dataset,
): TeamBuilderInducementCatalogRow[] {
  const allAllowed = pkg.inducements.allowed.includes("*");
  return Object.entries(data.inducements)
    .filter(([, inducement]) => typeof inducement.wireName === "string" && inducement.wireName.trim() !== "")
    .map(([key, inducement]) => {
      const row: TeamBuilderInducementCatalogRow = {
        key,
        label: inducement.name,
        price: inducementWireGold(data, key),
        max: pkg.inducements.caps[key] ?? inducement.max ?? null,
        allowed: allAllowed || pkg.inducements.allowed.includes(key),
      };
      const rule = inducement.reducedSpecialRule;
      if (rule) {
        row.reducedSpecialRule = rule;
        row.reducedPrice = inducementWireGold(data, key, [rule]);
        // A package cap still wins over the dataset's reduced max (same precedence as the validator).
        row.reducedMax = pkg.inducements.caps[key] ?? inducement.reducedMax ?? inducement.max ?? null;
      }
      return row;
    })
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
