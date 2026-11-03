/**
 * SKETCH (unbuilt). Package resolution — merges the layered config sources in
 * precedence order: package.skillCostSP (inline) → CSV overrides → category
 * defaults in the package → built-in BB2025 defaults (DEFAULT_SKILL_ALLOTMENT).
 *
 * PURE: takes already-loaded objects/strings. File reads (and YAML parsing)
 * happen in bb-ingest / the bot / the tournament service.
 */

import {
  DEFAULT_SKILL_ALLOTMENT,
  type ExtraSkillKnobs,
  type SkillAllotment,
  type StaffPrices,
  type StatIncreaseRule,
  type TournamentPackage,
} from "./types";
import { SEVENS_PROFILE, SEVENS_STAFF_PRICES } from "../dataset/bb2025/sevens";
import { STANDARD_STAFF_PRICES } from "../cost/staff";
import { customStarProblems } from "./customStars";

const isMoney = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isCap = (v: unknown): boolean => v === null || v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);

/**
 * Load-time checks for the generic elite / stack / stat-increase / star-pack knobs. Every bad value
 * is reported in `problems`; bad GOLD values (negative / non-finite costs and fees, which could
 * only ever LOWER a team's cost) are also dropped so they price as 0. Bad caps are reported only —
 * a negative cap already fails closed.
 */
export function checkExtraKnobs(pkg: TournamentPackage): { pkg: TournamentPackage; problems: string[] } {
  const problems: string[] = [];
  const cleanStat = (where: string, si: StatIncreaseRule | null | undefined): StatIncreaseRule | null | undefined => {
    if (!si) return si;
    const costGold: Record<string, number> = {};
    for (const [k, v] of Object.entries(si.costGold ?? {})) {
      if (isMoney(v)) costGold[k] = v as number;
      else problems.push(`${where}.statIncreases.costGold.${k} must be a non-negative number (ignored).`);
    }
    if (!isCap(si.maxPerPlayer)) problems.push(`${where}.statIncreases.maxPerPlayer must be a non-negative integer or null.`);
    return si.costGold ? { ...si, costGold } : si;
  };
  const checkCaps = (where: string, k: ExtraSkillKnobs & { maxStackedPlayers?: number | null }) => {
    for (const f of ["eliteMaxTotal", "eliteMaxSameSkill", "maxStackedPlayers"] as const)
      if (!isCap(k[f])) problems.push(`${where}.${f} must be a non-negative integer or null.`);
    for (const f of ["maxSkills", "maxSecondary", "maxElite"] as const)
      if (k.stackedPlayer && !isCap(k.stackedPlayer[f])) problems.push(`${where}.stackedPlayer.${f} must be a non-negative integer or null.`);
  };
  checkCaps("skillAllotment", pkg.skillAllotment);
  // Count-mode skill packs: totals must be non-negative integers.
  const checkPacks = (where: string, packs: TournamentPackage["skillPackages"]) =>
    (packs ?? []).forEach((p, i) => {
      for (const f of ["maxSkills", "maxSecondary"] as const)
        if (!isCap(p[f])) problems.push(`${where}.skillPackages[${i}].${f} must be a non-negative integer or null.`);
    });
  checkPacks("package", pkg.skillPackages);
  for (const t of pkg.tiers ?? []) checkPacks(`tiers[${t.tier}]`, t.skillPackages);
  // Owner ruling 10-27: stars never take added skills in any package - there is no switch for it.
  if (pkg.starPlayers && "addedSkillsAllowed" in (pkg.starPlayers as object))
    problems.push("starPlayers.addedSkillsAllowed is not supported: Star Players never take added skills (ignored).");
  for (const [id, rosters] of Object.entries(pkg.inducements?.rosterOnly ?? {}))
    if (!Array.isArray(rosters) || rosters.some((r) => typeof r !== "string"))
      problems.push(`inducements.rosterOnly.${id} must be an array of roster names.`);
  const teamCap = (pkg.special?.statIncreaseRules as { maxPerTeam?: unknown } | undefined)?.maxPerTeam;
  if (!isCap(teamCap)) problems.push("special.statIncreaseRules.maxPerTeam must be a non-negative integer or null (ignored).");
  const out: TournamentPackage = { ...pkg };
  checkFormatKnobs(pkg, out, problems);
  problems.push(...customStarProblems((pkg as { customStars?: unknown }).customStars));
  if ((pkg as { visibility?: unknown }).visibility !== undefined && !["draft", "published"].includes(String((pkg as { visibility?: unknown }).visibility)))
    problems.push("visibility must be draft or published.");
  if (pkg.statIncreases !== undefined) out.statIncreases = cleanStat("package", pkg.statIncreases);
  if (pkg.tiers)
    out.tiers = pkg.tiers.map((t) => {
      const where = `tiers[${t.tier}]`;
      checkCaps(where, t);
      for (const [r, g] of Object.entries(t.rosterGold ?? {}))
        if (!isMoney(g)) problems.push(`${where}.rosterGold.${r} must be a non-negative number.`);
      return t.statIncreases !== undefined ? { ...t, statIncreases: cleanStat(where, t.statIncreases) } : t;
    });
  if (pkg.teamRules)
    out.teamRules = pkg.teamRules.map((r) => {
      const where = `teamRules[${r.team}]`;
      checkCaps(where, r);
      return r.statIncreases !== undefined ? { ...r, statIncreases: cleanStat(where, r.statIncreases) } : r;
    });
  if (pkg.starPacks)
    out.starPacks = pkg.starPacks.map((p) => {
      const where = `starPacks[${p.id}]`;
      if (!isCap(p.max)) problems.push(`${where}.max must be a non-negative integer or null.`);
      if (p.feeMode !== undefined && p.feeMode !== "once" && p.feeMode !== "each")
        problems.push(`${where}.feeMode must be "once" or "each".`);
      if (isMoney(p.fee)) return p;
      problems.push(`${where}.fee must be a non-negative number (treated as 0).`);
      return { ...p, fee: 0 };
    });
  return { pkg: out, problems };
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const STAFF_KEYS = ["reRoll", "assistantCoach", "cheerleader", "apothecary", "dedicatedFan"] as const;

/**
 * Load-time checks for the format switch and the Sevens knobs (format, staffPrices, special.maxPlayers / maxNonLineman /
 * veteran, sideline.dedicatedFansStart, inducements.set). Values that could LOWER a team's cost or open a closed door are
 * replaced with the format's default (a bad staff price, a bad free-fan count, a bad inducement set); caps are reported only,
 * since a bad cap already fails closed. Sevens never allows Star Players (owner Q4): an explicit allow is ignored.
 */
function checkFormatKnobs(pkg: TournamentPackage, out: TournamentPackage, problems: string[]): void {
  const raw = pkg as unknown as Record<string, unknown>;
  if (raw.format !== undefined && raw.format !== "standard" && raw.format !== "sevens") {
    problems.push(`format must be "standard" or "sevens" (got ${JSON.stringify(raw.format)}; treated as standard).`);
    delete (out as { format?: unknown }).format;
  }
  const sevens = out.format === "sevens";
  if (pkg.staffPrices !== undefined) {
    if (pkg.staffPrices === null || typeof pkg.staffPrices !== "object" || Array.isArray(pkg.staffPrices)) {
      problems.push("staffPrices must be an object of gold prices (ignored).");
      if (sevens) out.staffPrices = { ...SEVENS_STAFF_PRICES };
      else delete out.staffPrices;
    } else {
      const fallback: Required<StaffPrices> = sevens ? SEVENS_STAFF_PRICES : STANDARD_STAFF_PRICES;
      const prices: StaffPrices = { ...pkg.staffPrices };
      for (const key of STAFF_KEYS) {
        const v = prices[key];
        if (v === undefined || isCount(v) || (key === "reRoll" && v === null)) continue;
        problems.push(`staffPrices.${key} must be a non-negative whole number of gold${key === "reRoll" ? " or null (roster price)" : ""} (using ${fallback[key] ?? "the roster price"}).`);
        prices[key] = fallback[key] as number;
      }
      out.staffPrices = prices;
    }
  }
  const special = pkg.special ?? ({} as TournamentPackage["special"]);
  if (special.maxPlayers !== undefined) {
    if (!isCount(special.maxPlayers) || special.maxPlayers < 1) problems.push("special.maxPlayers must be a whole number of at least 1.");
    else if (typeof special.minPlayers === "number" && special.maxPlayers < special.minPlayers)
      problems.push(`special.maxPlayers (${special.maxPlayers}) is below special.minPlayers (${special.minPlayers}): no roster can be legal.`);
  }
  if (special.maxNonLineman !== undefined && special.maxNonLineman !== null && !isCount(special.maxNonLineman))
    problems.push("special.maxNonLineman must be a non-negative whole number or null.");
  if (special.veteran !== undefined && typeof special.veteran !== "boolean") {
    problems.push(`special.veteran must be true or false (using ${sevens}).`);
    out.special = { ...out.special, veteran: sevens };
  }
  const start = pkg.sideline?.dedicatedFansStart;
  if (start !== undefined) {
    if (!isCount(start)) {
      const fallback = sevens ? 0 : 1;
      problems.push(`sideline.dedicatedFansStart must be a non-negative whole number (using ${fallback}).`);
      out.sideline = { ...out.sideline, dedicatedFansStart: fallback };
    } else if (isCount(pkg.sideline.maxDedicatedFans) && start > pkg.sideline.maxDedicatedFans)
      problems.push(`sideline.dedicatedFansStart (${start}) is above sideline.maxDedicatedFans (${pkg.sideline.maxDedicatedFans}).`);
  }
  const set = (pkg.inducements as { set?: unknown } | undefined)?.set;
  if (set !== undefined && set !== "core" && set !== "sevens") {
    problems.push(`inducements.set must be "core" or "sevens" (got ${JSON.stringify(set)}; using ${sevens ? "sevens" : "core"}).`);
    out.inducements = { ...out.inducements, set: sevens ? "sevens" : "core" };
  } else if (sevens && set === "core") {
    // Owner Q4: Sevens never re-opens Star Players or Mercenaries, so a Sevens package can't pick the core list.
    problems.push('inducements.set "core" isn\'t available in Sevens (it would allow Star Players and Mercenaries); using the Sevens list.');
    out.inducements = { ...out.inducements, set: "sevens" };
  }
  if (sevens) {
    if (pkg.starPlayers?.allowed === true) {
      problems.push("Star Players aren't available in Sevens: starPlayers.allowed is ignored.");
      out.starPlayers = { ...out.starPlayers, allowed: false };
    }
    if ((pkg.tiers ?? []).some((t) => t.starPlayersAllowed === true))
      problems.push("Star Players aren't available in Sevens: a tier's starPlayersAllowed is ignored.");
  }
}

/** The nearest `format` along a package's extends chain (cycle-safe, at most 32 hops); undefined = none set. */
export function chainFormat(
  raw: DeepPartial<TournamentPackage>,
  resolveExtends?: (name: string) => DeepPartial<TournamentPackage> | undefined,
): unknown {
  const seen = new Set<string>();
  let cur: DeepPartial<TournamentPackage> | undefined = raw;
  for (let hop = 0; cur && hop < 32; hop++) {
    if (cur.format !== undefined) return cur.format;
    const next: string | undefined = cur.extends;
    if (!next || seen.has(next)) return undefined;
    seen.add(next);
    cur = resolveExtends?.(next);
  }
  return undefined;
}

/** Recursively-optional view of T (arrays keep their element type). */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface CsvSkillCostRow {
  skill: string;
  costSP?: number;
  elite?: boolean;
}

/**
 * Parse a skill-cost override CSV (columns: skill,costSP,elite).
 * Pure string→rows; '#' lines and blanks are comments. Bad rows are returned in
 * `problems` rather than thrown, so the bot can surface them to the TO.
 */
export function parseSkillCostCsv(text: string): { rows: CsvSkillCostRow[]; problems: string[] } {
  const rows: CsvSkillCostRow[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    if (i === 0 && /^skill\s*,/i.test(line)) continue; // header
    const [skill, costRaw, eliteRaw] = line.split(",").map((c) => c.trim());
    if (!skill) continue;
    const row: CsvSkillCostRow = { skill };
    if (costRaw !== undefined && costRaw !== "") {
      const n = Number(costRaw);
      if (Number.isFinite(n) && n >= 0) row.costSP = n;
      else {
        problems.push(`line ${i + 1}: costSP "${costRaw}" is not a non-negative number`);
        continue;
      }
    }
    if (eliteRaw !== undefined && eliteRaw !== "") {
      if (/^(true|false)$/i.test(eliteRaw)) row.elite = /^true$/i.test(eliteRaw);
      else {
        problems.push(`line ${i + 1}: elite "${eliteRaw}" must be true/false`);
        continue;
      }
    }
    rows.push(row);
  }
  return { rows, problems };
}

/** Apply CSV rows onto an allotment. Inline package.skillCostSP still wins over CSV. */
export function applyCsvOverrides(allotment: SkillAllotment, rows: CsvSkillCostRow[]): SkillAllotment {
  const out: SkillAllotment = {
    ...allotment,
    eliteSkills: [...allotment.eliteSkills],
    skillCostSP: { ...allotment.skillCostSP },
  };
  for (const row of rows) {
    // CSV cost fills in only where the package has no inline override.
    if (row.costSP !== undefined && !(row.skill in allotment.skillCostSP)) {
      out.skillCostSP[row.skill] = row.costSP;
    }
    if (row.elite === true && !out.eliteSkills.includes(row.skill)) out.eliteSkills.push(row.skill);
    if (row.elite === false) out.eliteSkills = out.eliteSkills.filter((s) => s !== row.skill);
  }
  return out;
}

/** Deep-merge a partial package over a base (arrays/scalars replace; objects merge). */
export function mergePackages(
  base: TournamentPackage,
  override: DeepPartial<TournamentPackage>,
): TournamentPackage {
  // `base` is always a fully-populated package, so each nested spread yields a
  // complete sub-object; the assertions keep the DeepPartial override from
  // widening the result types.
  const staffPrices = base.staffPrices || override.staffPrices
    ? { staffPrices: { ...(base.staffPrices ?? {}), ...((override.staffPrices ?? {}) as StaffPrices) } }
    : {};
  return {
    ...base,
    ...override,
    ...staffPrices,
    skillAllotment: { ...base.skillAllotment, ...(override.skillAllotment ?? {}) } as SkillAllotment,
    starPlayers: { ...base.starPlayers, ...(override.starPlayers ?? {}) } as TournamentPackage["starPlayers"],
    inducements: { ...base.inducements, ...(override.inducements ?? {}) } as TournamentPackage["inducements"],
    sideline: { ...base.sideline, ...(override.sideline ?? {}) } as TournamentPackage["sideline"],
    special: { ...base.special, ...(override.special ?? {}) } as TournamentPackage["special"],
  } as TournamentPackage;
}

/**
 * Resolve a raw (parsed JSON/YAML) package into a complete TournamentPackage:
 * defaults ← optional `extends` base ← the package ← optional CSV.
 * `resolveExtends` maps an `extends` name to its raw package (the caller loads it).
 */
export function loadPackage(
  raw: DeepPartial<TournamentPackage>,
  opts?: {
    resolveExtends?: (name: string) => DeepPartial<TournamentPackage> | undefined;
    csvText?: string;
  },
): { pkg: TournamentPackage; problems: string[] } {
  const problems: string[] = [];

  const defaults: TournamentPackage = {
    name: raw.name ?? "(unnamed package)",
    ruleset: "bb2025-default",
    eligibleRosters: ["*"],
    skillAllotment: { ...DEFAULT_SKILL_ALLOTMENT },
    goldBudget: null,
    starPlayers: { allowed: true, maxCount: null, maxCombinedCost: null },
    inducements: { allowed: ["*"], caps: {} },
    sideline: {
      maxReRolls: 8,
      maxApothecary: 1,
      maxCheerleaders: null,
      maxAssistantCoaches: null,
      maxDedicatedFans: null,
    },
    special: {
      insignificantTraitConstraint: true,
      stalling: true,
      slannAllowed: false,
      statIncreasesAllowed: false,
      bannedSkills: [],
      minPlayers: 11,
    },
  };

  let pkg = defaults;
  const base = raw.extends ? opts?.resolveExtends?.(raw.extends) : undefined;
  if (raw.extends && !base) problems.push(`extends "${raw.extends}" could not be resolved; using defaults`);
  // Blood Bowl Sevens: the profile sits right above the built-in defaults, so the `extends` base and the package itself
  // still override every field. The format is the nearest one set along the WHOLE extends chain (a layer over a layer
  // over the shipped Sevens package is Sevens too, and the fork guard sees it).
  if (chainFormat(raw, opts?.resolveExtends) === "sevens") pkg = mergePackages(pkg, JSON.parse(JSON.stringify(SEVENS_PROFILE)) as DeepPartial<TournamentPackage>);
  if (base) pkg = mergePackages(pkg, base);
  pkg = mergePackages(pkg, raw);
  // Visibility is the package's OWN field, never inherited: a published child of a draft base is published (its resolved
  // rules include the base's, which the organiser chose to publish through it); the draft base itself stays hidden.
  if (raw.visibility === undefined) { const { visibility: _v, ...rest } = pkg; pkg = rest as TournamentPackage; }
  const knobs = checkExtraKnobs(pkg);
  pkg = knobs.pkg;
  problems.push(...knobs.problems);

  if (opts?.csvText !== undefined) {
    const { rows, problems: csvProblems } = parseSkillCostCsv(opts.csvText);
    problems.push(...csvProblems);
    pkg = { ...pkg, skillAllotment: applyCsvOverrides(pkg.skillAllotment, rows) };
  }
  return { pkg, problems };
}
