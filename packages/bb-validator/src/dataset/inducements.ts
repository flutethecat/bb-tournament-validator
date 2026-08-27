import type { Dataset } from "./types";
import { normName } from "./lookup";

/** Resolve the fixed fork wire-gold price for a predefined inducement. */
export function inducementWireGold(
  data: Dataset,
  key: string,
  specialRules: readonly string[] = [],
): number {
  const catalog = data.inducements[key];
  if (!catalog) throw new Error(`Cannot resolve inducement price for catalog key "${key}".`);
  const normalizedRules = new Set(specialRules.map(normName));
  const reduced = catalog.reducedSpecialRule && normalizedRules.has(normName(catalog.reducedSpecialRule));
  const price = reduced ? catalog.reducedCost : catalog.cost;
  if (price == null || !Number.isSafeInteger(price) || price < 0)
    throw new Error(`Cannot resolve a fixed wire-gold price for inducement "${key}".`);
  return price;
}
