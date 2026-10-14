/**
 * SKETCH (unbuilt). Package resolution — merges the layered config sources in
 * precedence order: package.skillCostSP (inline) → CSV overrides → category
 * defaults in the package → built-in BB2025 defaults (DEFAULT_SKILL_ALLOTMENT).
 *
 * PURE: takes already-loaded objects/strings. File reads (and YAML parsing)
 * happen in bb-ingest / the bot / the tournament service.
 */

import { DEFAULT_SKILL_ALLOTMENT, type SkillAllotment, type TournamentPackage } from "./types";

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
  return {
    ...base,
    ...override,
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
  if (raw.extends) {
    const base = opts?.resolveExtends?.(raw.extends);
    if (base) pkg = mergePackages(pkg, base);
    else problems.push(`extends "${raw.extends}" could not be resolved; using defaults`);
  }
  pkg = mergePackages(pkg, raw);

  if (opts?.csvText !== undefined) {
    const { rows, problems: csvProblems } = parseSkillCostCsv(opts.csvText);
    problems.push(...csvProblems);
    pkg = { ...pkg, skillAllotment: applyCsvOverrides(pkg.skillAllotment, rows) };
  }
  return { pkg, problems };
}
