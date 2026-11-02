import type { Dataset, DatasetInducement } from "./types";
import { normName } from "./lookup";
import { SEVENS_INDUCEMENTS } from "./bb2025/sevens";

/** Does a package draw from the Sevens inducement list? `inducements.set: "sevens"`, and ALWAYS for a Sevens package
 *  (owner Q4: Sevens never re-opens Star Players or Mercenaries through the core list). */
export function usesSevensInducements(pkg: { format?: string; inducements?: { set?: string } }): boolean {
  return pkg.inducements?.set === "sevens" || pkg.format === "sevens";
}

/** The inducement list a package draws from: the Sevens list (see usesSevensInducements), else the dataset's core list. */
export function inducementCatalog(
  pkg: { format?: string; inducements?: { set?: string } },
  data: Dataset,
): Readonly<Record<string, DatasetInducement>> {
  return usesSevensInducements(pkg) ? SEVENS_INDUCEMENTS : data.inducements;
}

/** The id of a stored inducement name in one catalog (current name, former alias, or the id spelled out); undefined when absent. */
export function inducementIdInCatalog(catalog: Readonly<Record<string, DatasetInducement>>, name: string): string | undefined {
  const want = normName(name);
  return Object.entries(catalog).find(
    ([id, row]) => normName(row.name) === want || (row.aliases ?? []).some((a) => normName(a) === want) || normName(id.replace(/_/g, " ")) === want,
  )?.[0];
}

/** Commissioner opt-ins: an `optIn` inducement is offered only when the competition's `inducementOptIns` names its
 *  wireName or id. Everything else is on by default. */
export function inducementEnabled(
  catalog: Dataset["inducements"][string] | undefined,
  id: string,
  optIns: readonly string[] = [],
): boolean {
  if (!catalog) return false;
  if (!catalog.optIn) return true;
  return optIns.includes(id) || (catalog.wireName !== undefined && optIns.includes(catalog.wireName));
}

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
