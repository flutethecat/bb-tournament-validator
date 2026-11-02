import { inducementEnabled, inducementReducedFor, inducementWireGold, SEVENS_INDUCEMENTS, type Dataset, type TournamentPackage } from "@bb/validator";

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
  /** Price/max reduction for one roster's teams rather than a rule (Halfling Master Chef: Halfling teams). */
  reducedRoster?: string;
  /** Only teams with this special rule may buy it. */
  requiresSpecialRule?: string;
  requiresApothecary?: boolean;
  /** Package knob `inducements.rosterOnly`: only these rosters may buy it. */
  rosterOnly?: string[];
}

/** Public builder catalog: only fixed-price inducements the fork can roster in team XML. */
export function teamBuilderInducementCatalog(
  pkg: TournamentPackage,
  data: Dataset,
  /** The competition's `inducementOptIns`: commissioner opt-in entries (e.g. canopicJar) appear only when named here. */
  optIns: readonly string[] = [],
): TeamBuilderInducementCatalogRow[] {
  const allAllowed = pkg.inducements.allowed.includes("*");
  if (pkg.inducements.set === "sevens") return sevensCatalog(pkg, allAllowed);
  return Object.entries(data.inducements)
    .filter(([, inducement]) => typeof inducement.wireName === "string" && inducement.wireName.trim() !== "")
    .filter(([key, inducement]) => inducementEnabled(inducement, key, optIns))
    .map(([key, inducement]) => {
      const row: TeamBuilderInducementCatalogRow = {
        key,
        label: inducement.name,
        price: inducementWireGold(data, key),
        max: pkg.inducements.caps[key] ?? inducement.max ?? null,
        allowed: allAllowed || pkg.inducements.allowed.includes(key),
      };
      if (inducement.requiresSpecialRule) row.requiresSpecialRule = inducement.requiresSpecialRule;
      if (inducement.requiresApothecary) row.requiresApothecary = true;
      const onlyFor = pkg.inducements.rosterOnly?.[key];
      if (onlyFor?.length) row.rosterOnly = [...onlyFor];
      if (inducement.reducedRoster) {
        row.reducedRoster = inducement.reducedRoster;
        row.reducedPrice = inducementWireGold(data, key, [], inducement.reducedRoster);
        row.reducedMax = pkg.inducements.caps[key] ?? inducement.reducedMax ?? inducement.max ?? null;
      }
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

/** Blood Bowl Sevens: the Sevens list (SJ22, Desperate Measures included) at Sevens prices and caps. These items have no
 *  fork wire name, which is fine: Sevens teams are tabletop-only and never go to the fork. */
function sevensCatalog(pkg: TournamentPackage, allAllowed: boolean): TeamBuilderInducementCatalogRow[] {
  return Object.entries(SEVENS_INDUCEMENTS)
    .filter(([, row]) => row.cost != null)
    .map(([key, row]) => {
      const out: TeamBuilderInducementCatalogRow = {
        key,
        label: row.name,
        price: row.cost!,
        max: pkg.inducements.caps[key] ?? row.max ?? null,
        allowed: allAllowed || pkg.inducements.allowed.includes(key),
      };
      if (row.requiresSpecialRule) out.requiresSpecialRule = row.requiresSpecialRule;
      if (row.requiresApothecary) out.requiresApothecary = true;
      const onlyFor = pkg.inducements.rosterOnly?.[key];
      if (onlyFor?.length) out.rosterOnly = [...onlyFor];
      const unlock = row.reducedRoster ? { roster: row.reducedRoster } : row.reducedSpecialRule ? { rule: row.reducedSpecialRule } : null;
      if (unlock && row.reducedCost != null && inducementReducedFor(row, unlock.rule ? [unlock.rule] : [], unlock.roster)) {
        if (unlock.roster) out.reducedRoster = unlock.roster;
        if (unlock.rule) out.reducedSpecialRule = unlock.rule;
        out.reducedPrice = row.reducedCost;
        out.reducedMax = pkg.inducements.caps[key] ?? row.reducedMax ?? row.max ?? null;
      }
      return out;
    })
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}
