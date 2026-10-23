import type { Dataset } from "./types";
import { normName } from "./lookup";

/** Does a team get the inducement's reduced price / cap: it has the unlocking special rule, or it is the unlocking roster. */
export function inducementReducedFor(
  catalog: Dataset["inducements"][string] | undefined,
  specialRules: readonly string[],
  rosterName?: string,
): boolean {
  if (!catalog) return false;
  const rules = new Set(specialRules.map(normName));
  return Boolean(
    (catalog.reducedSpecialRule && rules.has(normName(catalog.reducedSpecialRule))) ||
    (catalog.reducedRoster && rosterName && normName(rosterName) === normName(catalog.reducedRoster)),
  );
}

/** The catalog id for a stored inducement name, current or former (an alias); undefined when unknown. */
export function inducementIdForName(data: Dataset, name: string): string | undefined {
  const want = normName(name);
  return Object.entries(data.inducements).find(
    ([id, row]) => normName(row.name) === want || (row.aliases ?? []).some((a) => normName(a) === want) || normName(id.replace(/_/g, " ")) === want,
  )?.[0];
}

/** Resolve the fixed fork wire-gold price for a predefined inducement. */
export function inducementWireGold(
  data: Dataset,
  key: string,
  specialRules: readonly string[] = [],
  rosterName?: string,
): number {
  const catalog = data.inducements[key];
  if (!catalog) throw new Error(`Cannot resolve inducement price for catalog key "${key}".`);
  const reduced = inducementReducedFor(catalog, specialRules, rosterName);
  const price = reduced ? catalog.reducedCost : catalog.cost;
  if (price == null || !Number.isSafeInteger(price) || price < 0)
    throw new Error(`Cannot resolve a fixed wire-gold price for inducement "${key}".`);
  return price;
}
