import { resolveTeamConfig, type StatKey, type TournamentPackage } from "@bb/validator";
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
): { name: string; description?: string; budget: number | null; rules: BuilderRaceRules } | undefined {
  if (!resolved.selected) return undefined;
  const cfg = resolveTeamConfig(resolved.pkg, raceName);
  return {
    name: resolved.selected.name,
    description: resolved.selected.description,
    budget: cfg.gold,
    rules: builderRaceRules(resolved.pkg, raceName),
  };
}

/** One star pack as the builder sees it (only packs OPEN to the race are listed). */
export interface BuilderStarPack {
  id: string;
  label: string;
  fee: number;
  feeMode: "once" | "each";
  max: number | null;
  stars: string[];
}

/**
 * The per-race rule block echoed to builder clients (`package.rules` on preview/build, and on
 * each /api/fork/team-builder/tiers race row). WIRE CONTRACT — field names are fixed. Every field
 * is derived from resolveTeamConfig (the same resolver validate() uses); null = not applicable.
 */
export interface BuilderRaceRules {
  tier: number | null;
  maxSecondary: number | null;
  eliteMaxTotal: number | null;
  eliteMaxSameSkill: number | null;
  maxStackedPlayers: number | null;
  stackedPlayer: { maxSkills: number | null; maxSecondary: number | null; maxElite: number | null };
  /** null when no characteristic increase is open to the race. */
  statIncreases: { allowed: StatKey[]; costGold: Partial<Record<StatKey, number>> } | null;
  /** Only the packs open to the race ([] when stars are not allowed or no packs are configured). */
  starPacks: BuilderStarPack[];
  /** Overall star cap (counts picks when packs are configured); 0 when stars are not allowed. */
  maxStars: number | null;
}

export function builderRaceRules(pkg: TournamentPackage, race: string): BuilderRaceRules {
  const cfg = resolveTeamConfig(pkg, race);
  const si = cfg.statIncreases;
  const starPacks: BuilderStarPack[] = cfg.starPlayersAllowed
    ? (pkg.starPacks ?? [])
        .filter((p) => cfg.starPacksAllowed == null || cfg.starPacksAllowed.includes(p.id))
        .map((p) => ({
          id: p.id,
          label: p.label ?? p.id,
          fee: p.fee,
          feeMode: p.feeMode ?? "each",
          max: p.max ?? null,
          stars: [...p.stars],
        }))
    : [];
  return {
    tier: cfg.tierNumber ?? null,
    maxSecondary: cfg.maxSecondary,
    eliteMaxTotal: cfg.eliteMaxTotal,
    eliteMaxSameSkill: cfg.eliteMaxSameSkill,
    maxStackedPlayers: cfg.maxStackedPlayers,
    stackedPlayer: { ...cfg.stackedPlayer },
    statIncreases: si && si.allowed.length ? { allowed: [...si.allowed], costGold: { ...si.costGold } } : null,
    starPacks,
    maxStars: cfg.starPlayersAllowed ? pkg.starPlayers.maxCount : 0,
  };
}

const fmtK = (n: number): string => `${Math.round(n / 1000)}k`;

/** One tier row for the builder's PDF-style tier table (GET /api/fork/team-builder/tiers `tiers`). */
export interface BuilderTierRow extends Omit<BuilderRaceRules, "tier"> {
  tier: number;
  label: string;
  rosters: Array<{ name: string; gold: number | null }>;
  /** Human summaries for the table cells. */
  secondaryText: string;
  eliteText: string;
  stacksText: string;
  stackTypeText: string;
  characteristicsText: string;
  starPacksText: string;
}

/** Tier table rows: the TIER-level rules (per-team exceptions show on the race rows instead). */
export function builderTierRows(pkg: TournamentPackage): BuilderTierRow[] {
  const tierOnly: TournamentPackage = { ...pkg, teamRules: [] };
  return (pkg.tiers ?? []).map((t) => {
    const rules = builderRaceRules(tierOnly, t.rosters[0] ?? "");
    const rosterGold = (name: string): number | null => {
      const hit = t.rosterGold && Object.entries(t.rosterGold).find(([r]) => r.toLowerCase() === name.toLowerCase());
      return hit ? hit[1] : (t.gold ?? pkg.goldBudget);
    };
    const sp = rules.stackedPlayer;
    const stackParts = [
      sp.maxSkills != null ? `up to ${sp.maxSkills} skills` : "",
      sp.maxSecondary === 0 ? "primary only" : sp.maxSecondary != null ? `max ${sp.maxSecondary} secondary` : "",
      sp.maxElite === 0 ? "no elite" : sp.maxElite != null ? `max ${sp.maxElite} elite` : "",
    ].filter(Boolean);
    const elite = [
      rules.eliteMaxTotal != null ? `max ${rules.eliteMaxTotal} total` : "",
      rules.eliteMaxSameSkill != null ? `max ${rules.eliteMaxSameSkill} of any one` : "",
    ].filter(Boolean);
    const si = rules.statIncreases;
    return {
      ...rules,
      tier: t.tier,
      label: t.label ?? `Tier ${t.tier}`,
      rosters: t.rosters.map((name) => ({ name, gold: rosterGold(name) })),
      secondaryText: rules.maxSecondary != null ? String(rules.maxSecondary) : "unlimited",
      eliteText: elite.length ? elite.join(", ") : "unlimited",
      stacksText: rules.maxStackedPlayers != null ? String(rules.maxStackedPlayers) : "unlimited",
      stackTypeText: stackParts.length ? stackParts.join(", ") : "any",
      characteristicsText: si
        ? si.allowed.map((k) => `+${k}${si.costGold[k] != null ? ` (${fmtK(si.costGold[k]!)})` : ""}`).join(" / ")
        : "none",
      starPacksText: rules.starPacks.length ? rules.starPacks.map((p) => p.label).join(", ") : "none",
    };
  });
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
  /** Owner 09-09: the pack's SP prices so the client's live tracker prices skills exactly as the validator does
   *  (primary/secondary base, +elite surcharge, +stack surcharge per added skill beyond a player's first). */
  skillCosts: { primary: number; secondary: number; eliteSurcharge: number; stackSurcharge: number; eliteSkills: string[] };
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
    skillCosts: {
      primary: pkg.skillAllotment.primaryCostSP,
      secondary: pkg.skillAllotment.secondaryCostSP ?? pkg.skillAllotment.primaryCostSP * pkg.skillAllotment.secondaryMultiplier,
      eliteSurcharge: pkg.skillAllotment.eliteSurchargeSP,
      stackSurcharge: pkg.skillAllotment.stackSurchargeSP ?? 0,
      eliteSkills: [...pkg.skillAllotment.eliteSkills],
    },
    maxPerPlayer: pkg.skillAllotment.maxPerPlayer,
    packs: packSummaries(cfg.skillPackages),
    stars: {
      allowed: cfg.starPlayersAllowed,
      maxCount: pkg.starPlayers.maxCount,
      paidInSkillPoints: pkg.starPlayers.paidInSkillPoints === true,
      ...(spCosts ? { spCosts } : {}),
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
  budget?: number | null;
  tierSummary: TierSummaryRow[];
  race?: RaceRulesInfo;
} {
  const race = roster ? packageRaceRules(pkg, roster) : undefined;
  return {
    name: pkg.name,
    ...(pkg.dataNote ? { dataNote: pkg.dataNote } : {}),
    tierSummary: packageTierSummary(pkg),
    ...(race ? { budget: race.gold, race } : {}),
  };
}
