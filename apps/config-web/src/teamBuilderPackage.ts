import {
  eligibleTeamNames,
  isCountPack,
  loadPackage,
  resolveMatrixCell,
  resolveTeamConfig,
  usesCountMode,
  type Dataset,
  type ResolvedTeamConfig,
  type SkillPackage,
  type StatKey,
  type TournamentPackage,
} from "@bb/validator";
import { canonicalizeStatRuleRaces, cleanStatIncreaseRules, findRoster, type StatIncreaseRules } from "@bb/validator";
import { effectiveRosterLimits, effectiveStaffPrices, inducementCatalog, STANDARD_STAFF_PRICES, type RosterLimits } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import type { PackageFiles } from "./data.js";
import { isFreeCreatePackage, isSevensFreeCreatePackage, SEVENS_FREE_CREATE_DESCRIPTION, SEVENS_FREE_CREATE_LABEL } from "./freeCreate.js";

/**
 * Free Create's build profile (owner 10-31): only the core roster checks the fork needs (roster eligibility, squad size,
 * the race's position limits, legal skill access, star rules, sideline). No gold cap, no Skill Point budget or per-player
 * skill count, characteristic increases allowed, no Insignificant ratio. With "Ignore in-game limits" the composer and
 * these checks refuse what the fork would refuse.
 */
export const FREE_CREATE_BUILD_PACKAGE: TournamentPackage = loadPackage({
  name: "Free Create",
  goldBudget: null,
  eligibleRosters: ["*"],
  skillAllotment: { skillPointBudget: Number.MAX_SAFE_INTEGER, maxPerPlayer: null, maxSameSkillTeamwide: null, maxStackedPlayers: null },
  // Explicit unlimited knob: Free Create bounds stat increases in the builder, not the validator (no standard defaults here).
  statIncreases: { allowed: ["MA", "ST", "AG", "PA", "AV"], costGold: {}, maxPerPlayer: null },
  special: { insignificantTraitConstraint: false, statIncreasesAllowed: true },
}).pkg;

/**
 * Sevens Free Create's build profile (Sevens spec 11-02, owner Q1 (c) and Q6): the Sevens profile under League-draft rules:
 * 600k, 7-11 players, at most 4 non-Linemen, one Veteran, Sevens staff prices and inducements, no stars, Dedicated Fans
 * starting at 1 free, no tiers and no added skills. Tabletop-only like every Sevens package (the fork build refuses it).
 */
export const SEVENS_FREE_CREATE_BUILD_PACKAGE: TournamentPackage = loadPackage({
  name: SEVENS_FREE_CREATE_LABEL,
  format: "sevens",
  description: SEVENS_FREE_CREATE_DESCRIPTION,
  skillAllotment: { skillPointBudget: 0 },
  sideline: { dedicatedFansStart: 1 },
}).pkg;

/** Is this a Blood Bowl Sevens package (tabletop-only: no fork team)? */
export const isSevensPackage = (pkg: Pick<TournamentPackage, "format">): boolean => pkg.format === "sevens";
export const SEVENS_TABLETOP_ONLY = "Sevens teams are tabletop only: they can't be created on the fork.";
export const CUSTOM_STAR_TABLETOP_ONLY = "Teams with a custom star are tabletop only: they can't be created on the fork. Save the roster and submit it to the competition.";

/** What preview/build validate against, plus (when a tournament package was
 *  explicitly selected) the info the client needs to render the ruleset note
 *  and auto-populate the budget field. */
export interface ResolvedBuilderPackage {
  pkg: TournamentPackage;
  /** Set only when `packageName` was supplied and resolved — omitted for the baseline. */
  selected?: { name: string; description?: string };
  /** Roster Builder Free Create (freeCreate.ts): FREE_CREATE_BUILD_PACKAGE, asked for by its marker. */
  free?: true;
  /** Roster Builder league mode (leagueBuilderMarker.ts): the season's rules, plus the league's own team problems
   *  (allowed roster classes, max per race) for the preview to add to the validator's. */
  league?: { leagueId: string; seasonId: string; raceProblems: (race: string) => string[] };
}

/**
 * Resolve the package a team-builder request validates against.
 *   - `packageName` omitted → the standalone baseline (byte-identical to pre-tournament-mode
 *     callers; `selected` is absent so the response carries no `package` echo).
 *   - `packageName` set but unknown → `{ error }` (never silently falls back to baseline —
 *     a tournament-mode caller asking for a specific ruleset must get a clear 4xx, not a
 *     roster validated against the wrong rules).
 *   - `packageName` set and found → that package, `selected` populated for the response.
 *   - `packageName` = the Free Create marker → FREE_CREATE_BUILD_PACKAGE, `free` set (no `selected`, no echo).
 */
export function resolveBuilderPackage(
  packages: PackageFiles,
  baseline: TournamentPackage,
  packageName: string | undefined,
  league?: (name: string) => ResolvedBuilderPackage | { error: string } | undefined,
  /** drafts: false = a package whose own visibility is "draft" answers as unknown (creation wizards v2). Absent = server
   *  internal callers (a competition's own roster checks), which may read it. */
  opts: { drafts?: boolean } = {},
): ResolvedBuilderPackage | { error: string } {
  if (!packageName) return { pkg: baseline };
  // League mode (lane L7): "league:<leagueId>:<seasonId>" resolves to the package derived from that season's rules.
  const leagueHit = league?.(packageName);
  if (leagueHit) return leagueHit;
  // Free Create (owner 10-31) is not a saved package: its marker resolves to its own build profile (core roster legality
  // only), so a Free Create roster built on the Fork meets the fork's own checks and nothing else.
  if (isFreeCreatePackage(packageName)) return { pkg: FREE_CREATE_BUILD_PACKAGE, free: true };
  if (isSevensFreeCreatePackage(packageName))
    return { pkg: SEVENS_FREE_CREATE_BUILD_PACKAGE, selected: { name: SEVENS_FREE_CREATE_LABEL, description: SEVENS_FREE_CREATE_DESCRIPTION } };
  const found = packages.get(packageName);
  if (!found) return { error: `Unknown tournament package "${packageName}".` };
  if (opts.drafts === false && found.pkg.visibility === "draft") return { error: `Unknown tournament package "${packageName}".` };
  return { pkg: found.pkg, selected: { name: found.pkg.name, description: found.pkg.description } };
}

/** The `package` field to echo on a preview/build response — the resolved package's
 *  display name/note plus the per-roster budget for THIS composed team's race (tier/matrix/
 *  team-rule aware via resolveTeamConfig). Undefined when no package was selected, so
 *  existing (non-tournament) callers see no shape change. */
export function packageResponseInfo(
  resolved: ResolvedBuilderPackage,
  raceName: string,
): { name: string; description?: string; budget: number | null; rules: BuilderRaceRules; limits?: RosterLimits } | undefined {
  if (!resolved.selected) return undefined;
  const cfg = resolveTeamConfig(resolved.pkg, raceName);
  // Blood Bowl Sevens only (additive): the race's effective limits (players, non-Linemen, Veteran, staff, inducements).
  const limits = isSevensPackage(resolved.pkg) ? effectiveRosterLimits(resolved.pkg, raceName, bb2025) : undefined;
  return {
    name: resolved.selected.name,
    description: resolved.selected.description,
    budget: cfg.gold,
    rules: builderRaceRules(resolved.pkg, raceName),
    ...(limits ? { limits } : {}),
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
  /** The package's master switch (special.statIncreasesAllowed, "Allow stat increases" in the Tournament Creator). When false
   *  the Advance dialog shows the stat bar greyed out and the validator refuses any increase. */
  statIncreasesAllowed: boolean;
  /** special.statIncreaseRules cleaned (who may not, blocked stats, per-team cap); null when none are set or the switch is off. */
  statIncreaseRules: StatIncreaseRules | null;
  statRulesRace: string;
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
    statIncreasesAllowed: pkg.special.statIncreasesAllowed === true,
    statIncreaseRules: pkg.special.statIncreasesAllowed === true
      ? canonicalizeStatRuleRaces(cleanStatIncreaseRules(pkg.special.statIncreaseRules), (n) => findRoster(bb2025, n)?.name ?? n) : null,
    /** The dataset's name for this race: the rules' race fields are canonical, so the dialog compares against this. */
    statRulesRace: findRoster(bb2025, race)?.name ?? race,
    statIncreases: pkg.special.statIncreasesAllowed === true && si && si.allowed.length ? { allowed: [...si.allowed], costGold: { ...si.costGold } } : null,
    starPacks,
    maxStars: cfg.starPlayersAllowed ? tierStarCap(pkg.starPlayers.maxCount, cfg.skillPackages) : 0,
  };
}

/** Most Star Player picks a team may take: the package cap, tightened by the most generous star-allowing skill
 *  package when every such package sets its own `maxStars` (Destination Blood Bowl: Tiers 3-4 one star, Tier 5 two). */
function tierStarCap(maxCount: number | null, packs: readonly SkillPackage[] | undefined): number | null {
  const open = (packs ?? []).filter((p) => p.starPlayersAllowed !== false);
  if (!open.length || open.some((p) => p.maxStars == null)) return maxCount;
  const packCap = Math.max(...open.map((p) => p.maxStars!));
  return maxCount == null ? packCap : Math.min(maxCount, packCap);
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
  /** COUNT-mode packs only (omitted for SP packs): total added skills / how many may be secondary. */
  maxSkills?: number | null;
  maxSecondary?: number | null;
  /** COUNT-mode packs only: present (false) when the pack forbids Star Players. */
  starPlayersAllowed?: false;
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
    // Count-pack fields only, so SP-pack responses (EuroBowl, Spike!) stay byte-identical.
    ...(isCountPack(p)
      ? {
          maxSkills: p.maxSkills ?? null,
          maxSecondary: p.maxSecondary ?? null,
          ...(p.starPlayersAllowed === false ? { starPlayersAllowed: false as const } : {}),
        }
      : {}),
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
  /** How validation limits this race's added skills (owner 10-30, the team sheet's ruleset box): the SAME branch order
   *  as the skill-points rule (choose-one packs > count mode > SP budget), with the resolved counts. `matrixCell`
   *  names the cash x skills cell ("2 pri / 1 sec @ 1150k") when a matrix set them. */
  skillSystem: RaceSkillSystem;
}
export interface RaceSkillSystem {
  mode: "packs" | "count" | "points";
  maxPrimary: number | null;
  maxSecondary: number | null;
  secondarySwap: boolean;
  secondarySwapRatio: number;
  secondarySwapMax: number | null;
  matrixCell?: string;
}

function raceSkillSystem(pkg: TournamentPackage, race: string, cfg: ResolvedTeamConfig): RaceSkillSystem {
  const cell = cfg.source === "matrix" ? resolveMatrixCell(pkg, race) : undefined;
  const row = cell ? pkg.matrix?.rows[cell.row] : undefined;
  return {
    mode: cfg.skillPackages?.length ? "packs" : usesCountMode(cfg) ? "count" : "points",
    maxPrimary: cfg.maxPrimary,
    maxSecondary: cfg.maxSecondary,
    secondarySwap: cfg.secondarySwap,
    secondarySwapRatio: cfg.secondarySwapRatio,
    secondarySwapMax: cfg.secondarySwapMax,
    ...(cell ? { matrixCell: `${row?.label ?? `${cell.primary} pri / ${cell.secondary} sec`} @ ${fmtK(cell.gold)}` } : {}),
  };
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
    skillSystem: raceSkillSystem(pkg, race, cfg),
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
  data: Dataset = bb2025,
): {
  name: string;
  dataNote?: string;
  budget?: number | null;
  /** The package's base budget below the cap (baseGoldBudget), when it sets one. */
  baseBudget?: number;
  tierSummary: TierSummaryRow[];
  race?: RaceRulesInfo;
  overview: RulesetOverview;
} {
  const race = roster ? packageRaceRules(pkg, roster) : undefined;
  return {
    name: pkg.name,
    ...(pkg.dataNote ? { dataNote: pkg.dataNote } : {}),
    tierSummary: packageTierSummary(pkg),
    ...(race ? { budget: race.gold, race } : {}),
    ...(typeof pkg.baseGoldBudget === "number" && Number.isFinite(pkg.baseGoldBudget) && pkg.baseGoldBudget > 0 ? { baseBudget: pkg.baseGoldBudget } : {}),
    overview: packageOverview(pkg, data),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Ruleset overview (owner 10-27): the Tournament Team Builder's step-1 highlights + per-team tier table.
// Every line and cell below is GENERATED FROM PACKAGE VALUES through resolveTeamConfig (the resolver
// validate() uses) — never parsed from the organiser's description, labels or dataNote.
// ════════════════════════════════════════════════════════════════════════════

/** One labelled highlight line; `details` renders as a closed disclosure (e.g. the banned-star names). */
export interface OverviewLine {
  key: "format" | "structure" | "skills" | "elite" | "stars" | "inducements" | "sideline" | "minPlayers";
  label: string;
  text: string;
  details?: { summary: string; items: string[] };
}

/** The tier-level table cells for one team; null = not applicable (a column hides when null for every team). */
export interface OverviewCells {
  secondary: string | null;
  elite: string | null;
  stacks: string | null;
  stackLimit: string | null;
  characteristics: string | null;
  stars: string | null;
}

export interface OverviewTeamRow extends OverviewCells {
  name: string;
  /** Gold cap; with choose-one packages, the cheapest pack's gold and `goldMax` the dearest. */
  gold: number | null;
  goldMax: number | null;
  /** The team's skill allotment, one line per choose-one package. */
  allotment: string[];
}

export interface OverviewGroup {
  /** Tier number; null for the single "All teams" group of a non-tiered package. */
  tier: number | null;
  label: string;
  teams: OverviewTeamRow[];
}

export interface RulesetOverview {
  summary: OverviewLine[];
  groups: OverviewGroup[];
}

const fmtGold = (n: number): string => `${Math.round(n / 1000).toLocaleString("en-US")}k`;
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const plural = (n: number, word: string): string => `${fmtNum(n)} ${word}${n === 1 ? "" : "s"}`;
const range = (values: number[], fmt: (n: number) => string): string => {
  if (!values.length) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
};
const uniq = <T>(values: T[]): T[] => [...new Set(values)];
const sameKey = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** "Tier 5" / "Tiers 4–6" / "Tiers 2, 4 and 6". */
function tierPhrase(tiers: number[]): string {
  const sorted = uniq(tiers).sort((a, b) => a - b);
  if (sorted.length === 1) return `Tier ${sorted[0]}`;
  const consecutive = sorted.every((t, i) => i === 0 || t === sorted[i - 1]! + 1);
  if (consecutive) return `Tiers ${sorted[0]}–${sorted[sorted.length - 1]}`;
  return `Tiers ${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

interface TeamEntry {
  name: string;
  tier: number | null;
  cfg: ResolvedTeamConfig;
}

/** The package's teams in its own order: tier rosters, else matrix cells, else eligibleRosters ("*" = every dataset team). */
function overviewTeams(pkg: TournamentPackage, data: Dataset): TeamEntry[] {
  if (pkg.tiers?.length && !pkg.matrix?.cells.length) {
    return pkg.tiers.flatMap((t) => t.rosters.map((name) => ({ name, tier: t.tier, cfg: resolveTeamConfig(pkg, name) })));
  }
  const names =
    pkg.matrix?.cells.length || !pkg.eligibleRosters.includes("*")
      ? eligibleTeamNames(pkg)
      : data.teams.map((team) => team.name).sort((a, b) => a.localeCompare(b));
  return uniq(names).map((name) => ({ name, tier: null, cfg: resolveTeamConfig(pkg, name) }));
}

/** Gold-priced skills: added skills are bought with gold inside the team-value cap. */
const goldPriced = (pkg: TournamentPackage): boolean => pkg.goldCapIncludesAddedSkills === true;
/** Same fallbacks as the validator's costGold (owner 08-04 flat defaults). */
const goldCosts = (pkg: TournamentPackage) => ({
  primary: pkg.skillAllotment.primaryCostGold ?? 20_000,
  secondary: pkg.skillAllotment.secondaryCostGold ?? 40_000,
  elite: pkg.skillAllotment.eliteSurchargeGold ?? 10_000,
});
const spCosts = (pkg: TournamentPackage) => ({
  primary: pkg.skillAllotment.primaryCostSP,
  secondary: pkg.skillAllotment.secondaryCostSP ?? pkg.skillAllotment.primaryCostSP * pkg.skillAllotment.secondaryMultiplier,
  elite: pkg.skillAllotment.eliteSurchargeSP,
  stack: pkg.skillAllotment.stackSurchargeSP ?? 0,
});

/** Can this team add any skill at all? */
function canAddSkills(pkg: TournamentPackage, cfg: ResolvedTeamConfig): boolean {
  if (cfg.skillPackages?.length)
    return cfg.skillPackages.some((p) => (isCountPack(p) ? (p.maxSkills ?? 1) > 0 : p.skillPointBudget > 0));
  if (goldPriced(pkg)) return true;
  if (usesCountMode(cfg)) return (cfg.maxPrimary ?? 1) + (cfg.maxSecondary ?? 1) > 0;
  return cfg.skillPointBudget > 0;
}

/** Most added skills one player may carry (the most generous choose-one pack's cap, else the allotment's). */
function perPlayerMax(pkg: TournamentPackage, cfg: ResolvedTeamConfig): number | null {
  const base = pkg.skillAllotment.maxPerPlayer;
  const packs = cfg.skillPackages ?? [];
  const caps = packs.length ? packs.map((p) => p.maxPerPlayer ?? base) : [base];
  const stackCap = cfg.stackedPlayer.maxSkills;
  if (caps.some((c) => c == null)) return stackCap;
  const max = Math.max(...(caps as number[]));
  return stackCap != null ? Math.min(max, stackCap) : max;
}

const canStack = (pkg: TournamentPackage, cfg: ResolvedTeamConfig): boolean => {
  if (!canAddSkills(pkg, cfg)) return false;
  const per = perPlayerMax(pkg, cfg);
  return (per == null || per > 1) && cfg.maxStackedPlayers !== 0;
};

function packLine(pkg: TournamentPackage, cfg: ResolvedTeamConfig, p: SkillPackage, packs: SkillPackage[]): string {
  const parts = [fmtGold(p.gold)];
  if (isCountPack(p)) {
    parts.push(p.maxSkills != null ? plural(p.maxSkills, "skill") : "any skills");
    if (p.maxSecondary != null && p.maxSecondary !== cfg.maxSecondary)
      parts.push(p.maxSecondary === 0 ? "primary only" : `≤${p.maxSecondary} secondary`);
  } else {
    parts.push(`${fmtNum(p.skillPointBudget)} SP`);
  }
  const per = p.maxPerPlayer ?? pkg.skillAllotment.maxPerPlayer;
  const perValues = uniq(packs.map((q) => q.maxPerPlayer ?? pkg.skillAllotment.maxPerPlayer));
  if (perValues.length > 1 && per != null) parts.push(`${plural(per, "skill")} per player`);
  const starValues = uniq(packs.map((q) => q.starPlayersAllowed !== false));
  if (starValues.length > 1 && p.starPlayersAllowed !== false) parts.push("Star allowed");
  return parts.join(" · ");
}

/** The team's skill allotment: choose-one packs / gold prices / skill counts / SP budget. */
function teamAllotment(pkg: TournamentPackage, cfg: ResolvedTeamConfig): string[] {
  const packs = cfg.skillPackages ?? [];
  if (packs.length) return packs.map((p) => packLine(pkg, cfg, p, packs));
  if (!canAddSkills(pkg, cfg)) return ["no added skills"];
  if (goldPriced(pkg)) {
    const g = goldCosts(pkg);
    return [`primary ${fmtGold(g.primary)} · secondary ${fmtGold(g.secondary)}`];
  }
  if (usesCountMode(cfg)) {
    const swap = cfg.secondarySwap
      ? ` · swap ${cfg.secondarySwapRatio} primary → 1 secondary${cfg.secondarySwapMax != null ? ` (max ${cfg.secondarySwapMax})` : ""}`
      : "";
    if (cfg.maxPrimary == null) return [`any primary · ≤${cfg.maxSecondary} secondary${swap}`];
    if (cfg.maxSecondary == null) return [`${plural(cfg.maxPrimary, "primary skill")}${swap}`];
    return [`${plural(cfg.maxPrimary + cfg.maxSecondary, "skill")} (${cfg.maxSecondary === 0 && !cfg.secondarySwap ? "primary only" : `≤${cfg.maxSecondary} secondary`})${swap}`];
  }
  return [`${fmtNum(cfg.skillPointBudget)} SP`];
}

/** A stacked player's limit as a value: "3 skills · ≤2 secondary · no elite". */
function stackLimitValue(pkg: TournamentPackage, cfg: ResolvedTeamConfig): string {
  const sp = cfg.stackedPlayer;
  const per = perPlayerMax(pkg, cfg);
  // A team that may take no secondary at all can't stack one either.
  const sec = cfg.maxSecondary === 0 ? 0 : sp.maxSecondary;
  return [
    per != null ? plural(per, "skill") : "any skills",
    sec === 0 ? "primary only" : sec != null ? `≤${sec} secondary` : "",
    sp.maxElite === 0 ? "no elite" : sp.maxElite != null ? `≤${sp.maxElite} elite` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function eliteCaps(cfg: ResolvedTeamConfig): string | null {
  const parts = [
    cfg.eliteMaxTotal != null ? `≤${cfg.eliteMaxTotal} total` : "",
    cfg.eliteMaxSameSkill != null ? `≤${cfg.eliteMaxSameSkill} of one skill` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function statValue(cfg: ResolvedTeamConfig): string | null {
  const si = cfg.statIncreases;
  if (!si?.allowed.length) return null;
  return si.allowed.map((k) => `+${k}${si.costGold[k] != null ? ` ${fmtGold(si.costGold[k]!)}` : ""}`).join(" · ");
}

/** Star packs open to this team (pkg.starPacks filtered by the resolved starPacksAllowed). */
const openPacks = (pkg: TournamentPackage, cfg: ResolvedTeamConfig) =>
  (pkg.starPacks ?? []).filter((p) => cfg.starPacksAllowed == null || cfg.starPacksAllowed.includes(p.id));

function starsValue(pkg: TournamentPackage, cfg: ResolvedTeamConfig): string | null {
  if (!cfg.starPlayersAllowed) return null;
  if (pkg.starPacks?.length) {
    const packs = openPacks(pkg, cfg);
    if (!packs.length) return null;
    return packs.map((p) => `${p.label ?? p.id}${p.max != null ? ` (max ${p.max})` : ""}`).join(" · ");
  }
  return pkg.starPlayers.maxCount != null ? `max ${pkg.starPlayers.maxCount}` : "allowed";
}

/**
 * The tier table's Stack limit cell (owner 10-27), " · "-joined lines (the page stacks one per line):
 * no secondary → "N Primary Skills"; some secondary → "N Primary" / "OR" / "(N−S) Primary + S Secondary";
 * secondary up to the full stack (or uncapped) → "N Primary" / "OR" / "N Secondary"; then the elite cap.
 * The secondary cap is the tighter of the stack's and the team's (a team with no secondary can't stack one).
 */
export function stackSkillLines(per: number | null, sec: number | null, elite: number | null): string[] {
  const lines: string[] = [];
  // Owner 10-27: a package that sets no stacked-secondary cap reads as PRIMARY ONLY (packages that allow stacked
  // secondaries state the cap explicitly).
  if (per == null) lines.push(sec == null || sec === 0 ? "Any Primary Skills" : `Any Skills (≤${fmtNum(sec)} Secondary)`);
  else if (sec == null || sec === 0) lines.push(plural(per, "Primary Skill"));
  else if (sec >= per) lines.push(`${fmtNum(per)} Primary`, "OR", `${fmtNum(per)} Secondary`);
  else lines.push(`${fmtNum(per)} Primary`, "OR", `${fmtNum(per - sec)} Primary + ${fmtNum(sec)} Secondary`);
  if (elite === 0) lines.push("no elite");
  else if (elite != null) lines.push(`≤${fmtNum(elite)} elite`);
  return lines;
}
function stackLimitCell(pkg: TournamentPackage, cfg: ResolvedTeamConfig): string {
  const caps = [cfg.stackedPlayer.maxSecondary, cfg.maxSecondary].filter((v): v is number => v != null);
  return stackSkillLines(perPlayerMax(pkg, cfg), caps.length ? Math.min(...caps) : null, cfg.stackedPlayer.maxElite).join(" · ");
}

function teamRow(pkg: TournamentPackage, entry: TeamEntry): OverviewTeamRow {
  const { cfg } = entry;
  const packs = cfg.skillPackages ?? [];
  const golds = packs.length ? packs.map((p) => p.gold) : cfg.gold != null ? [cfg.gold] : [];
  const skills = canAddSkills(pkg, cfg);
  return {
    name: entry.name,
    gold: golds.length ? Math.min(...golds) : null,
    goldMax: golds.length && Math.max(...golds) !== Math.min(...golds) ? Math.max(...golds) : null,
    allotment: teamAllotment(pkg, cfg),
    secondary: skills && cfg.maxSecondary != null ? String(cfg.maxSecondary) : null,
    elite: skills ? eliteCaps(cfg) : null,
    stacks: !skills || (perPlayerMax(pkg, cfg) ?? 2) <= 1 ? null : cfg.maxStackedPlayers != null ? String(cfg.maxStackedPlayers) : "any",
    stackLimit: canStack(pkg, cfg) ? stackLimitCell(pkg, cfg) : null,
    characteristics: statValue(cfg),
    stars: starsValue(pkg, cfg),
  };
}

type Variance = "none" | "tier" | "tier+" | "team";
/** Does a value vary — not at all, only between tiers (uniform inside each tier), between tiers with a
 *  few per-roster exceptions ("tier+": a minority of teams carry their own team rule), or between teams? */
function variesBy(teams: TeamEntry[], value: (t: TeamEntry) => string): Variance {
  if (uniq(teams.map(value)).length <= 1) return "none";
  const tiers = uniq(teams.map((t) => t.tier));
  if (tiers.includes(null)) return "team";
  const uniformPerTier = (list: TeamEntry[]) =>
    tiers.every((tier) => uniq(list.filter((t) => t.tier === tier).map(value)).length <= 1);
  if (uniformPerTier(teams)) return "tier";
  const ruled = teams.filter((t) => t.cfg.source === "team");
  if (ruled.length && ruled.length * 2 < teams.length && uniformPerTier(teams.filter((t) => t.cfg.source !== "team"))) return "tier+";
  return "team";
}
const tableRef = (by: Exclude<Variance, "none">): string =>
  by === "tier+" ? "per tier, some rosters differ (table)" : `per ${by} (table)`;

function structureLine(pkg: TournamentPackage, teams: TeamEntry[]): string {
  const packTeams = teams.filter((t) => t.cfg.skillPackages?.length);
  const allGold = teams.flatMap((t) =>
    t.cfg.skillPackages?.length ? t.cfg.skillPackages.map((p) => p.gold) : t.cfg.gold != null ? [t.cfg.gold] : [],
  );
  const tierCount = pkg.matrix?.cells.length ? 0 : (pkg.tiers?.length ?? 0);
  if (packTeams.length) {
    const groups = tierCount
      ? pkg.tiers!.map((t) => resolveTeamConfig(pkg, t.rosters[0] ?? "").skillPackages ?? [])
      : [packTeams[0]!.cfg.skillPackages!];
    const counts = groups.map((g) => g.length).filter((n) => n > 0);
    const allPacks = packTeams.flatMap((t) => t.cfg.skillPackages!);
    const against = allPacks.every(isCountPack)
      ? `a skill count (${range(allPacks.map((p) => p.maxSkills ?? 0), fmtNum)} skills)`
      : `skill points (${range(allPacks.map((p) => p.skillPointBudget), fmtNum)} SP)`;
    const scope = tierCount
      ? `${plural(tierCount, "tier")}, each offering ${range(counts, fmtNum)} packages`
      : plural(counts[0] ?? 0, "package");
    return `Choose-one skill packages: ${scope} that trade the gold cap (${range(allGold, fmtGold)}) against ${against}.`;
  }
  const skillTeams = teams.filter((t) => canAddSkills(pkg, t.cfg));
  let clause: string;
  if (!skillTeams.length) clause = "no added skills";
  else if (goldPriced(pkg)) clause = "added skills cost gold inside the team-value cap";
  else if (skillTeams.every((t) => usesCountMode(t.cfg))) {
    const by = variesBy(skillTeams, (t) => teamAllotment(pkg, t.cfg)[0] ?? "");
    clause = by === "none" ? `a skill-count allotment of ${teamAllotment(pkg, skillTeams[0]!.cfg)[0]}` : `a skill-count allotment ${tableRef(by)}`;
  } else {
    const by = variesBy(skillTeams, (t) => String(t.cfg.skillPointBudget));
    const sp = range(skillTeams.map((t) => t.cfg.skillPointBudget), fmtNum);
    clause = by === "none" ? `a skill-point budget of ${sp} SP` : `a skill-point budget ${by === "tier" ? "per tier" : "per team"} (${sp} SP)`;
  }
  if (pkg.matrix?.cells.length) {
    const m = pkg.matrix;
    return `Cash × skills matrix: ${plural(m.columns.length, "gold column")} (${range(m.columns.map((c) => c.gold), fmtGold)}) × ${plural(m.rows.length, "skill row")}; each team's cell sets its gold cap and skill counts.`;
  }
  if (tierCount) {
    const perRoster =
      pkg.tiers!.some((t) => t.rosterGold && uniq(Object.values(t.rosterGold)).length > 1) ||
      variesBy(teams, (t) => String(t.cfg.gold)) === "team";
    const gold = allGold.length ? `, gold caps ${range(allGold, fmtGold)}${perRoster ? " (set per roster)" : ""}` : "";
    return `Tiered: ${plural(tierCount, "tier")}${gold}; ${clause}.`;
  }
  const flatGold = uniq(allGold);
  const gold =
    flatGold.length === 1
      ? `every team gets ${fmtGold(flatGold[0]!)}`
      : flatGold.length
        ? `gold caps ${range(flatGold, fmtGold)}`
        : "no team-value cap set";
  return `${flatGold.length ? "Flat budget" : "Standard team creation"}: ${gold}; ${clause}.`;
}

/** The stat-increase clause of the Skills line (null when no team may raise a characteristic). One clause per
 *  distinct allowed set — never unioned, a tier may only raise its own characteristics — scoped to its tiers; the
 *  per-player terms follow once when every team shares them, else per tier / team. */
function statIncreasesClause(teams: TeamEntry[]): string | null {
  const statTeams = teams.filter((t) => t.cfg.statIncreases?.allowed.length);
  if (!statTeams.length) return null;
  const order: StatKey[] = ["MA", "ST", "AG", "PA", "AV"];
  const orList = (items: string[]): string =>
    items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}` : (items[0] ?? "");
  const setText = (t: TeamEntry): string => {
    const si = t.cfg.statIncreases!;
    return orList(order.filter((k) => si.allowed.includes(k)).map((k) => `+${k}${si.costGold[k] != null ? ` ${fmtGold(si.costGold[k]!)}` : ""}`));
  };
  const termsText = (t: TeamEntry): string => {
    const si = t.cfg.statIncreases!;
    const per = si.maxPerPlayer == null ? "no per-player cap" : si.maxPerPlayer === 1 ? "one increase per player" : `up to ${si.maxPerPlayer} increases per player`;
    return `${per}${si.exclusiveWithSkills ? ", instead of skills" : ""}`;
  };
  // Who gets what: a tier label only when EVERY team of each named tier is in the clause; otherwise name the teams.
  const scopeOf = (members: TeamEntry[]): string => {
    const tiers = uniq(members.map((t) => t.tier));
    const memberSet = new Set(members); // Set membership: no per-team scan of `members`
    const wholeTiers = tiers.every((tier) => tier != null && teams.filter((t) => t.tier === tier).every((t) => memberSet.has(t)));
    return wholeTiers ? tierPhrase(tiers as number[]) : members.map((t) => t.name).join(", ");
  };
  const sets = uniq(statTeams.map(setText));
  const terms = uniq(statTeams.map(termsText));
  const everyone = statTeams.length === teams.length;
  const setClauses = sets.length === 1 && everyone
    ? [sets[0]!]
    : sets.map((set) => `${scopeOf(statTeams.filter((t) => setText(t) === set))}: ${set}`);
  const termClauses = terms.length === 1
    ? [terms[0]!]
    : terms.map((term) => `${scopeOf(statTeams.filter((t) => termsText(t) === term))}: ${term}`);
  return `stat increases (${[...setClauses, ...termClauses].join("; ")})`;
}

function skillsLine(pkg: TournamentPackage, teams: TeamEntry[]): string | null {
  const skillTeams = teams.filter((t) => canAddSkills(pkg, t.cfg));
  if (!skillTeams.length) {
    // No added skills, but characteristic increases may still be on offer.
    const stat = statIncreasesClause(teams);
    return stat ? sentence(`no added skills; ${stat}`) : null;
  }
  const parts: string[] = [];
  const packs = skillTeams.flatMap((t) => t.cfg.skillPackages ?? []);
  const sp = spCosts(pkg);
  const spPrices =
    `primary ${fmtNum(sp.primary)} / secondary ${fmtNum(sp.secondary)} SP` +
    (sp.stack > 0 ? ` (+${fmtNum(sp.stack)} SP for each extra skill on the same player)` : "");
  const countOnly = !packs.length && !goldPriced(pkg) && skillTeams.every((t) => usesCountMode(t.cfg));
  if (packs.length) {
    parts.push(packs.every(isCountPack) ? "skill count set by the chosen package" : `${spPrices}, budget set by the chosen package`);
  } else if (goldPriced(pkg)) {
    const g = goldCosts(pkg);
    parts.push(`primary ${fmtGold(g.primary)}, secondary ${fmtGold(g.secondary)}, counted inside the cap`);
  } else if (countOnly) {
    const by = variesBy(skillTeams, (t) => teamAllotment(pkg, t.cfg)[0] ?? "");
    parts.push(by === "none" ? teamAllotment(pkg, skillTeams[0]!.cfg)[0]! : `skill counts ${tableRef(by)}`);
  } else {
    const by = variesBy(skillTeams, (t) => String(t.cfg.skillPointBudget));
    const budget = range(skillTeams.map((t) => t.cfg.skillPointBudget), fmtNum);
    parts.push(`SP budget ${by === "none" ? `${budget} SP` : `${by === "tier" ? "per tier" : "per team"} (${budget})`}, ${spPrices}`);
  }
  // Secondary-count limits (count mode / count packs / gold-priced count caps).
  const secTeams = skillTeams.filter((t) => t.cfg.maxSecondary != null);
  if (secTeams.length && !countOnly) {
    const by = variesBy(secTeams, (t) => String(t.cfg.maxSecondary));
    const first = secTeams[0]!.cfg.maxSecondary;
    parts.push(by === "none" ? (first === 0 ? "primary skills only" : `≤${first} secondary`) : `secondaries limited ${tableRef(by)}`);
  }
  // Stacking.
  const packPer = uniq(packs.map((p) => p.maxPerPlayer ?? pkg.skillAllotment.maxPerPlayer));
  const stackTeams = skillTeams.filter((t) => canStack(pkg, t.cfg));
  if (!stackTeams.length) {
    parts.push(skillTeams.every((t) => (perPlayerMax(pkg, t.cfg) ?? 2) <= 1) ? "one skill per player" : "no stacking");
  } else if (packPer.length > 1 && packPer.every((v) => v != null)) {
    const lo = Math.min(...(packPer as number[]));
    const hi = Math.max(...(packPer as number[]));
    parts.push(`${lo === 1 ? "one skill" : plural(lo, "skill")} per player (${hi} on some packages)`);
  } else {
    const by = variesBy(skillTeams, (t) => String(canStack(pkg, t.cfg) ? t.cfg.maxStackedPlayers : 0));
    const limit = stackLimitValue(pkg, stackTeams[0]!.cfg);
    const [skills, ...caps] = limit.split(" · ");
    const limitBy = variesBy(stackTeams, (t) => stackLimitValue(pkg, t.cfg));
    const skillsBy = variesBy(stackTeams, (t) => stackLimitValue(pkg, t.cfg).split(" · ")[0]!);
    const most = skillsBy === "none" ? skills : `${Math.max(...stackTeams.map((t) => perPlayerMax(pkg, t.cfg) ?? 0))} skills`;
    if (by === "none") {
      const n = stackTeams[0]!.cfg.maxStackedPlayers;
      const who = n == null ? "any player" : n === 1 ? "one player" : `up to ${n} players`;
      parts.push(limitBy === "none" ? `${who} may stack ${skills}${caps.length ? ` (${caps.join(", ")})` : ""}` : `${who} may stack up to ${most}; stack limits ${tableRef(limitBy)}`);
    } else {
      parts.push(`stacking up to ${most} on a player; stacked players${limitBy === "none" ? "" : " and stack limits"} ${tableRef(by)}`);
    }
  }
  const stat = statIncreasesClause(teams);
  if (stat) parts.push(stat);
  return sentence(parts.join("; "));
}

function eliteLine(pkg: TournamentPackage, teams: TeamEntry[]): string | null {
  const skillTeams = teams.filter((t) => canAddSkills(pkg, t.cfg));
  if (!skillTeams.length) return null;
  const packs = skillTeams.flatMap((t) => t.cfg.skillPackages ?? []);
  // A skill-COUNT allotment has no price to surcharge; only caps can apply there.
  const countOnly = packs.length ? packs.every(isCountPack) : !goldPriced(pkg) && skillTeams.every((t) => usesCountMode(t.cfg));
  const surcharge = goldPriced(pkg)
    ? goldCosts(pkg).elite > 0
      ? `+${fmtGold(goldCosts(pkg).elite)} each`
      : ""
    : !countOnly && spCosts(pkg).elite > 0
      ? `+${fmtNum(spCosts(pkg).elite)} SP each`
      : "";
  const capTeams = skillTeams.filter((t) => eliteCaps(t.cfg) != null);
  if (!surcharge && !capTeams.length) return null;
  const parts = [`${pkg.skillAllotment.eliteSkills.join(", ")}${surcharge ? ` ${surcharge}` : ""}`];
  if (capTeams.length) {
    const by = variesBy(skillTeams, (t) => eliteCaps(t.cfg) ?? "");
    parts.push(by === "none" ? `team limit ${eliteCaps(capTeams[0]!.cfg)}` : `limits ${tableRef(by)}`);
  }
  return `${parts.join("; ")}.`;
}

function starsLine(pkg: TournamentPackage, teams: TeamEntry[]): Pick<OverviewLine, "text" | "details"> {
  const allowed = teams.filter((t) => starsValue(pkg, t.cfg) != null);
  if (!allowed.length) return { text: "No star players." };
  const allowedSet = new Set(allowed); // Set membership: keeps this linear in the number of teams
  const parts: string[] = [];
  if (allowed.length < teams.length) {
    const access = variesBy(teams, (t) => String(allowedSet.has(t)));
    const tiers = uniq(allowed.map((t) => t.tier));
    parts.push(access === "tier" ? `${tierPhrase(tiers as number[])} only` : `${allowed.length} of ${teams.length} teams (table)`);
  }
  const max = pkg.starPlayers.maxCount;
  if (pkg.starPacks?.length) {
    const used = pkg.starPacks.filter((p) => allowed.some((t) => openPacks(pkg, t.cfg).includes(p)));
    const packText = used
      .map((p) => `${p.label ?? p.id} (${p.fee > 0 ? `+${fmtGold(p.fee)} ${p.feeMode === "once" ? "once" : "each"}` : "no fee"}${p.max != null ? `, max ${p.max}` : ""})`)
      .join(" · ");
    parts.push(`${max != null ? `max ${max} picks` : "picks"} from packs: ${packText}`);
    const packBy = variesBy(allowed, (t) => openPacks(pkg, t.cfg).map((p) => p.id).join(","));
    if (packBy !== "none") parts.push(`packs open ${tableRef(packBy)}`);
  } else {
    parts.push(max != null ? `max ${max}` : "no cap on the number");
  }
  if (pkg.starPlayers.spCostByTier)
    parts.push(pkg.starPlayers.paidInSkillPoints ? "paid in SP (price by tier) instead of gold" : "each also costs SP (price by tier)");
  if (allowed.some((t) => (t.cfg.skillPackages ?? []).some((p) => p.starPlayersAllowed === false)))
    parts.push("only on a package that allows a Star");
  if (pkg.starPlayers.maxCombinedCost != null) parts.push(`combined cost ≤${fmtGold(pkg.starPlayers.maxCombinedCost)}`);
  // Banned names: global bans, then tier/team-only bans (named with their tier/team) where stars may be hired.
  const global = pkg.bannedStars ?? [];
  const items = [...global];
  for (const t of pkg.tiers ?? []) {
    if (!allowed.some((a) => a.tier === t.tier)) continue;
    for (const name of t.bannedStars) if (!global.some((g) => sameKey(g, name))) items.push(`${name} (Tier ${t.tier})`);
  }
  for (const r of pkg.teamRules ?? []) {
    for (const name of r.bannedStars ?? []) if (!global.some((g) => sameKey(g, name))) items.push(`${name} (${r.team})`);
  }
  const text = `${parts.join("; ")}.`;
  return items.length ? { text, details: { summary: plural(items.length, "banned star"), items } } : { text };
}

function inducementsLine(pkg: TournamentPackage, data: Dataset): string {
  const ind = pkg.inducements;
  const catalog = inducementCatalog(pkg, data);
  const label = (id: string): string =>
    catalog[id]?.name ?? id.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const terms = (id: string): string => {
    const only = ind.rosterOnly?.[id];
    const bits = [ind.caps[id] != null ? `max ${ind.caps[id]}` : "", only?.length ? `${only.join(", ")} only` : ""].filter(Boolean);
    return bits.length ? ` (${bits.join(", ")})` : "";
  };
  if (ind.allowed.includes("*")) {
    const limited = uniq([...Object.keys(ind.caps), ...Object.keys(ind.rosterOnly ?? {})]);
    return `All ${ind.set === "sevens" ? "Sevens inducements (incl. Desperate Measures) at Sevens prices" : "inducements at book cost"}${limited.length ? `; ${limited.map((id) => `${label(id)}${terms(id)}`).join(", ")}` : ""}.`;
  }
  if (!ind.allowed.length) return "No inducements.";
  return `${ind.allowed.map((id) => `${label(id)}${terms(id)}`).join(", ")}.`;
}

/** Sideline limits that differ from the package defaults (8 rerolls, 1 apothecary, the rest uncapped). */
function sidelineLine(pkg: TournamentPackage): string | null {
  const s = pkg.sideline;
  const parts = [
    s.maxReRolls != null && s.maxReRolls !== 8 ? `max ${plural(s.maxReRolls, "reroll")}` : "",
    s.maxApothecary === 0 ? "no apothecary" : "",
    s.maxAssistantCoaches != null ? `max ${s.maxAssistantCoaches} assistant coach${s.maxAssistantCoaches === 1 ? "" : "es"}` : "",
    s.maxCheerleaders != null ? `max ${plural(s.maxCheerleaders, "cheerleader")}` : "",
    s.maxDedicatedFans != null ? `max ${s.maxDedicatedFans} dedicated fans` : "",
  ].filter(Boolean);
  return parts.length ? sentence(parts.join(", ")) : null;
}

/** Blood Bowl Sevens: the team-building limits a coach needs first (players, non-Linemen, Veteran, staff prices). */
function sevensLine(pkg: TournamentPackage): string {
  const s = pkg.special;
  const prices = effectiveStaffPrices(pkg) ?? STANDARD_STAFF_PRICES;
  const players = `${s.minPlayers}–${s.maxPlayers ?? 16} players`;
  const nonLineman = s.maxNonLineman != null ? `, at most ${s.maxNonLineman} without the Lineman keyword` : "";
  const veteran = s.veteran === true ? ", one Lineman as the Veteran (MA −1)" : "";
  const reroll = prices.reRoll == null ? "rerolls at roster price" : `rerolls ${fmtGold(prices.reRoll)}`;
  const fans = `Dedicated Fans ${fmtGold(prices.dedicatedFan)} each from ${pkg.sideline.dedicatedFansStart ?? 1}`;
  return `Blood Bowl Sevens, tabletop only: ${players}${nonLineman}${veteran}. Staff: ${reroll}, assistant coaches ${fmtGold(prices.assistantCoach)}, cheerleaders ${fmtGold(prices.cheerleader)}, apothecary ${fmtGold(prices.apothecary)}, ${fans}.`;
}

/** The step-1 ruleset overview: highlight lines + per-team tier table, all keyed to package values. */
export function packageOverview(pkg: TournamentPackage, data: Dataset = bb2025): RulesetOverview {
  const teams = overviewTeams(pkg, data);
  const sevens = isSevensPackage(pkg);
  const summary: OverviewLine[] = sevens ? [{ key: "format", label: "Format", text: sevensLine(pkg) }] : [];
  summary.push({ key: "structure", label: "Structure", text: structureLine(pkg, teams) });
  summary.push({ key: "skills", label: "Skills", text: skillsLine(pkg, teams) ?? "No added skills." });
  const elite = eliteLine(pkg, teams);
  if (elite) summary.push({ key: "elite", label: "Elite skill tax", text: elite });
  summary.push({ key: "stars", label: "Star players", ...starsLine(pkg, teams) });
  summary.push({ key: "inducements", label: "Inducements", text: inducementsLine(pkg, data) });
  const sideline = sidelineLine(pkg);
  if (sideline) summary.push({ key: "sideline", label: "Sideline", text: sideline });
  if (pkg.special.minPlayers !== 11 && !sevens)
    summary.push({ key: "minPlayers", label: "Minimum players", text: `${pkg.special.minPlayers} players.` });

  const rows = teams.map((t) => ({ tier: t.tier, row: teamRow(pkg, t), cfg: t.cfg }));
  let groups: OverviewGroup[] = uniq(rows.map((r) => r.tier)).map((tier) => ({
    tier,
    label: tier == null ? "All teams" : `Tier ${tier}`,
    teams: rows.filter((r) => r.tier === tier).map((r) => r.row),
  }));
  // A non-tiered package whose teams all share one rule collapses to a single "every eligible roster" row.
  const only = groups.length === 1 ? groups[0]! : null;
  if (only && only.tier == null && only.teams.length > 1) {
    // Compare the RESOLVED rules (incl. stat-increase terms, banned stars, packs) — not just the formatted cells.
    const key = (cfg: ResolvedTeamConfig): string => JSON.stringify({ ...cfg, source: undefined, tierNumber: undefined });
    if (uniq(rows.map((r) => key(r.cfg))).length === 1) {
      groups = [{ tier: null, label: only.label, teams: [{ ...only.teams[0]!, name: `Every eligible roster (${only.teams.length})` }] }];
    }
  }
  return { summary, groups };
}

/** One race whose rules differ from its tier row (a team rule or a matrix cell). */
export interface PreviewException {
  roster: string;
  source: "matrix" | "team";
  label: string;
  gold: number | null;
  skillPointBudget: number;
  maxPrimary: number | null;
  maxSecondary: number | null;
  packs: PackSummary[];
  starsAllowed: boolean;
  bannedStars: string[];
  rules: BuilderRaceRules;
}

/** What the organiser's Summary tab shows: the SAME derivations the Tournament Builder (coach page)
 *  reads — builderTierRows for the tier table, resolveTeamConfig for the flat allotment and for
 *  every team-rule / matrix-cell exception — computed from the package exactly as it will be saved. */
export interface PackagePreview {
  name: string;
  system: "tiers" | "matrix" | "flat";
  tiers: BuilderTierRow[];
  /** Gold / SP / packs per tier (the Slot Builder summary) — row-aligned with `tiers`. */
  tierSummary: TierSummaryRow[];
  /** Count / SP limits per tier (row-aligned with `tiers`), merged like resolveTeamConfig does
   *  (`!= null` tier values over the flat allotment). */
  tierLimits: SkillLimits[];
  flat: (RaceRulesInfo & { rules: BuilderRaceRules; limits: SkillLimits }) | null;
  exceptions: PreviewException[];
}

export interface SkillLimits {
  maxPrimary: number | null;
  maxSecondary: number | null;
  skillPointBudget: number | null;
}

export function packagePreview(pkg: TournamentPackage): PackagePreview {
  const sa = pkg.skillAllotment;
  const tiers = builderTierRows(pkg);
  const hasMatrix = (pkg.matrix?.cells?.length ?? 0) > 0;
  const exceptionRace = (roster: string, source: "matrix" | "team", label: string): PreviewException => {
    const cfg = resolveTeamConfig(pkg, roster);
    return {
      roster,
      source,
      label,
      gold: cfg.gold,
      skillPointBudget: cfg.skillPointBudget,
      maxPrimary: cfg.maxPrimary,
      maxSecondary: cfg.maxSecondary,
      packs: packSummaries(cfg.skillPackages),
      starsAllowed: cfg.starPlayersAllowed,
      bannedStars: [...cfg.bannedStars],
      rules: builderRaceRules(pkg, roster),
    };
  };
  const exceptions: PreviewException[] = [];
  const seen = new Set<string>();
  for (const cell of pkg.matrix?.cells ?? []) {
    const row = pkg.matrix?.rows[cell.row];
    const column = pkg.matrix?.columns[cell.col];
    const label = `${row?.label ?? `${row?.primary ?? 0} pri / ${row?.secondary ?? 0} sec`} @ ${column ? fmtK(column.gold) : "?"}`;
    for (const team of cell.teams) {
      if (seen.has(team.toLowerCase())) continue;
      seen.add(team.toLowerCase());
      exceptions.push(exceptionRace(team, "matrix", label));
    }
  }
  for (const rule of pkg.teamRules ?? []) {
    const key = rule.team.toLowerCase();
    const index = exceptions.findIndex((e) => e.roster.toLowerCase() === key);
    const entry = exceptionRace(rule.team, "team", "team rule");
    if (index >= 0) exceptions[index] = entry;
    else exceptions.push(entry);
  }
  return {
    name: pkg.name,
    system: tiers.length ? "tiers" : hasMatrix ? "matrix" : "flat",
    tiers,
    tierSummary: packageTierSummary(pkg),
    tierLimits: (pkg.tiers ?? []).map((t) => ({
      maxPrimary: t.maxPrimary ?? sa.maxPrimary ?? null,
      maxSecondary: t.maxSecondary ?? sa.maxSecondary ?? null,
      skillPointBudget: t.skillPointBudget ?? sa.skillPointBudget,
    })),
    flat: tiers.length || hasMatrix
      ? null
      : {
          ...packageRaceRules(pkg, ""),
          rules: builderRaceRules(pkg, ""),
          limits: { maxPrimary: sa.maxPrimary ?? null, maxSecondary: sa.maxSecondary ?? null, skillPointBudget: sa.skillPointBudget },
        },
    exceptions,
  };
}
