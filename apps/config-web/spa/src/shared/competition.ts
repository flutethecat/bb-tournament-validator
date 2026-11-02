// Creation wizards v2 (lane 1): the SPA side of the shared competition settings. The rules themselves live in the server's
// pure modules (src/competition/houseRules.ts, format.ts), imported here so the wizards, settings forms and summaries say
// exactly what the server will accept. This file adds the ruleset cards (Featured row first, BB2025 preselected).

export * from "../../../src/competition/houseRules";
export * from "../../../src/competition/format";

export interface RulesetCard {
  /** The saved package name the card picks ("" = the plain base ruleset, league only). */
  packageName: string;
  /** League only: the base ruleset a plain card picks. */
  ruleset?: "BB2025" | "BB2020";
  label: string;
  line?: string;
  featured?: boolean;
  sevens?: boolean;
}

/** The Featured row (owner 11-02): BB2025 (the default), BB2025 matched play (Q11), EuroBowl 2026, Small Gods, World Cup 3.0 (the Malta pack). */
export const FEATURED_RULESETS: ReadonlyArray<{ packageName: string; label: string; line: string }> = [
  { packageName: "BB2025 Default", label: "BB2025", line: "The 2025 edition, standard rules." },
  { packageName: "BB2025 Matched Play", label: "BB2025 matched play", line: "Matched play: 1,150k draft, four tiers of Skill Points." },
  { packageName: "EuroBowl 2026", label: "EuroBowl 2026", line: "The EuroBowl 2026 rules pack." },
  { packageName: "Small Gods", label: "Small Gods", line: "The Small Gods tournament rules." },
  { packageName: "NAF World Cup 2027 (Malta) - Rules Pack V3.0", label: "World Cup 3.0", line: "NAF World Cup 2027, Malta (rules pack V3.0)." },
];
export const DEFAULT_RULESET_PACKAGE = FEATURED_RULESETS[0]!.packageName;

export interface PackageListItem { name: string; description?: string; format?: string }

/**
 * The cards for a picker: the Featured row (only packages this server has), then every other package. For a league the
 * BB2025 card is always the plain base ruleset (leagues build from the BB2025 dataset and their own team building table).
 * `extra` cards (the league's BB2020) join the "All rulesets" list.
 */
export function rulesetCards(packages: readonly PackageListItem[], kind: "league" | "tournament", extra: RulesetCard[] = []): { featured: RulesetCard[]; others: RulesetCard[] } {
  const have = new Set(packages.map((p) => p.name));
  const featured: RulesetCard[] = FEATURED_RULESETS.flatMap((f, i) => {
    if (kind === "league" && i === 0) return [{ packageName: "", ruleset: "BB2025" as const, label: f.label, line: f.line, featured: true }];
    if (have.has(f.packageName)) return [{ packageName: f.packageName, label: f.label, line: f.line, featured: true }];
    return [];
  });
  const taken = new Set([...featured.map((c) => c.packageName), ...(kind === "league" ? [DEFAULT_RULESET_PACKAGE] : [])]);
  const others: RulesetCard[] = [
    ...extra,
    ...packages.filter((p) => !taken.has(p.name)).map((p) => ({ packageName: p.name, label: p.name, ...(p.description ? { line: p.description } : {}), ...(p.format === "sevens" ? { sevens: true } : {}) })),
  ];
  return { featured, others };
}

/** Cards whose label, package name or line contain the search text. */
export function filterCards(cards: readonly RulesetCard[], query: string): RulesetCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...cards];
  return cards.filter((c) => [c.label, c.packageName, c.line ?? ""].some((v) => v.toLowerCase().includes(q)));
}

/** A key for a card ("" packages are told apart by their base ruleset). */
export const cardKey = (c: Pick<RulesetCard, "packageName" | "ruleset">): string => c.packageName || `base:${c.ruleset ?? "BB2025"}`;

/** The label a stored choice shows (a featured package's short label, else the package name, else the base ruleset). */
export function rulesetLabel(packageName: string | null | undefined, base = "BB2025"): string {
  if (!packageName) return base;
  return FEATURED_RULESETS.find((f) => f.packageName === packageName)?.label ?? packageName;
}
