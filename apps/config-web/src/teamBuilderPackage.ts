import { resolveTeamConfig, type TournamentPackage } from "@bb/validator";
import type { PackageFiles } from "./data.js";

/** What preview/build validate against, plus (when a tournament package was
 *  explicitly selected) the info the client needs to render the ruleset note
 *  and auto-populate the budget field. */
export interface ResolvedBuilderPackage {
  pkg: TournamentPackage;
  /** Set only when `packageName` was supplied and resolved — omitted for the baseline. */
  selected?: { name: string; description?: string };
}

/**
 * Resolve the package a team-builder request validates against.
 *   - `packageName` omitted → the standalone baseline (byte-identical to pre-tournament-mode
 *     callers; `selected` is absent so the response carries no `package` echo).
 *   - `packageName` set but unknown → `{ error }` (never silently falls back to baseline —
 *     a tournament-mode caller asking for a specific ruleset must get a clear 4xx, not a
 *     roster validated against the wrong rules).
 *   - `packageName` set and found → that package, `selected` populated for the response.
 */
export function resolveBuilderPackage(
  packages: PackageFiles,
  baseline: TournamentPackage,
  packageName: string | undefined,
): ResolvedBuilderPackage | { error: string } {
  if (!packageName) return { pkg: baseline };
  const found = packages.get(packageName);
  if (!found) return { error: `Unknown tournament package "${packageName}".` };
  return { pkg: found.pkg, selected: { name: found.pkg.name, description: found.pkg.description } };
}

/** The `package` field to echo on a preview/build response — the resolved package's
 *  display name/note plus the per-roster budget for THIS composed team's race (tier/matrix/
 *  team-rule aware via resolveTeamConfig). Undefined when no package was selected, so
 *  existing (non-tournament) callers see no shape change. */
export function packageResponseInfo(
  resolved: ResolvedBuilderPackage,
  raceName: string,
): { name: string; description?: string; budget: number | null } | undefined {
  if (!resolved.selected) return undefined;
  const cfg = resolveTeamConfig(resolved.pkg, raceName);
  return { name: resolved.selected.name, description: resolved.selected.description, budget: cfg.gold };
}

/** One choose-one gold+SP pack, normalized for display. */
export interface PackSummary {
  label: string;
  gold: number;
  skillPointBudget: number;
  maxPerPlayer: number | null;
}

/** One tier row of the derived ruleset summary (Slot Builder default view). */
export interface TierSummaryRow {
  tier: number;
  label: string;
  rosters: string[];
  gold: number | null;
  skillPointBudget: number | null;
  packs: PackSummary[];
}

const packSummaries = (packs: TournamentPackage["skillPackages"]): PackSummary[] =>
  (packs ?? []).map((p, i) => ({
    label: p.label ?? `Pack ${i + 1}`,
    gold: p.gold,
    skillPointBudget: p.skillPointBudget,
    maxPerPlayer: p.maxPerPlayer ?? null,
  }));

/** Derived tier summary — the compact tournament overview the Slot Builder shows by
 *  default (owner 08-18). Pure data from the package config: no prose. Tiers without
 *  their own packs inherit the global skillPackages (same rule resolveTeamConfig uses).
 *  Empty for a non-tiered package. */
export function packageTierSummary(pkg: TournamentPackage): TierSummaryRow[] {
  return (pkg.tiers ?? []).map((t) => ({
    tier: t.tier,
    label: t.label ?? `Tier ${t.tier}`,
    rosters: [...t.rosters],
    gold: t.gold ?? pkg.goldBudget,
    skillPointBudget: t.skillPointBudget ?? pkg.skillAllotment.skillPointBudget,
    packs: packSummaries(t.skillPackages?.length ? t.skillPackages : pkg.skillPackages),
  }));
}

/** The rules that apply to ONE race under this package (Slot Builder race view). */
export interface RaceRulesInfo {
  roster: string;
  /** Which config layer set the limits — "flat" | "tier" | "matrix" | "team". */
  source: string;
  tierNumber?: number;
  tierLabel?: string;
  gold: number | null;
  skillPointBudget: number;
  maxPerPlayer: number | null;
  /** Choose-one packs in force for this race (tier's own, else global). */
  packs: PackSummary[];
  stars: {
    allowed: boolean;
    maxCount: number | null;
    paidInSkillPoints: boolean;
    /** Star SP price list for THIS race's tier (spCostByTier packages only);
     *  stars with no price in the tier are omitted. Sorted cheap-first. */
    spCosts?: { name: string; sp: number }[];
    spTax?: TournamentPackage["starPlayers"]["spTaxByCombinedCost"];
  };
  bannedStars: string[];
}

/** Derive one race's effective rules from the package config (resolveTeamConfig is the
 *  same resolver preview/build validate with, so what this reports is what gets enforced). */
export function packageRaceRules(pkg: TournamentPackage, race: string): RaceRulesInfo {
  const cfg = resolveTeamConfig(pkg, race);
  const tierDef = cfg.tierNumber != null ? pkg.tiers?.find((t) => t.tier === cfg.tierNumber) : undefined;
  const spTable = pkg.starPlayers.spCostByTier;
  let spCosts: { name: string; sp: number }[] | undefined;
  if (spTable && cfg.tierNumber != null) {
    spCosts = Object.entries(spTable)
      .flatMap(([name, byTier]) => {
        const sp = byTier[(cfg.tierNumber as number) - 1];
        return sp == null ? [] : [{ name, sp }];
      })
      .sort((a, b) => a.sp - b.sp || a.name.localeCompare(b.name));
  }
  return {
    roster: race,
    source: cfg.source,
    ...(cfg.tierNumber != null ? { tierNumber: cfg.tierNumber } : {}),
    ...(tierDef ? { tierLabel: tierDef.label ?? `Tier ${tierDef.tier}` } : {}),
    gold: cfg.gold,
    skillPointBudget: cfg.skillPointBudget,
    maxPerPlayer: pkg.skillAllotment.maxPerPlayer,
    packs: packSummaries(cfg.skillPackages),
    stars: {
      allowed: cfg.starPlayersAllowed,
      maxCount: pkg.starPlayers.maxCount,
      paidInSkillPoints: pkg.starPlayers.paidInSkillPoints === true,
      ...(spCosts ? { spCosts } : {}),
      ...(pkg.starPlayers.spTaxByCombinedCost ? { spTax: pkg.starPlayers.spTaxByCombinedCost } : {}),
    },
    bannedStars: cfg.bannedStars,
  };
}

/** The `rules` block for GET /api/packages/<name> — everything the Tournament Slot
 *  Builder needs WITHOUT a preview round-trip (a preview 400s until the sheet has
 *  picks + coach + team name, which is exactly when the coach most needs the budget
 *  and rules on screen — the 08-18 empty-budget bug). `roster` optional: without it
 *  the client gets the tier summary; with it, also that race's rules + budget. */
export function packageRulesInfo(
  pkg: TournamentPackage,
  roster?: string | null,
): {
  name: string;
  dataNote?: string;
  stackSurchargeSP: number;
  budget?: number | null;
  tierSummary: TierSummaryRow[];
  race?: RaceRulesInfo;
} {
  const race = roster ? packageRaceRules(pkg, roster) : undefined;
  return {
    name: pkg.name,
    ...(pkg.dataNote ? { dataNote: pkg.dataNote } : {}),
    stackSurchargeSP: pkg.skillAllotment.stackSurchargeSP ?? 0,
    tierSummary: packageTierSummary(pkg),
    ...(race ? { budget: race.gold, race } : {}),
  };
}
