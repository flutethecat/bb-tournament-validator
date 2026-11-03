/**
 * Custom stars (creation wizards v2, owner grill 2026-11-02): an organiser creates a Star Player inside a ruleset
 * package (`TournamentPackage.customStars`). Every competition on that package offers it in the Stars list, coaches hire
 * it like any star and can never change it, and "stars never add skills" (owner 10-27) still holds.
 *
 * The validator treats a custom star exactly like a dataset star: validate() appends the package's custom stars to the
 * dataset's star list (withCustomStars), so star detection, the package's star limits, packs, bans, the star-skills rule
 * and the star gold all apply unchanged. One extra rule (customStarTerms) checks the hired copy against the package: the
 * price, the characteristics and the printed skills are the organiser's, never the sheet's.
 *
 * Custom traits and rules (name + description) are display text for the Roster Builder rows, the PDF and the ruleset
 * summary. They are never skills.
 */

import type { Dataset, DatasetStar } from "../dataset/types";
import { normName } from "../dataset/lookup";
import type { TournamentPackage } from "./types";

export interface CustomStarRule {
  /** "trait" (a custom trait) or "rule" (a custom rule): both print under the star's "Special rules" subheader. */
  kind: "trait" | "rule";
  name: string;
  description: string;
}

export interface CustomStar {
  /** Stable id (lower-case letters, digits, hyphens). The Roster Builder position id is `cs-<id>`. */
  id: string;
  name: string;
  /** A sprite from the site's own provenance-clean set (a path under /sprites/), or absent for the initials badge. */
  sprite?: string;
  /** Gold. */
  cost: number;
  MA: number;
  ST: number;
  /** Target numbers: AG 3 = "3+". PA null = no passing ("-"). */
  AG: number;
  PA: number | null;
  AV: number;
  /** The star's printed skills and traits (dataset names). */
  skills: string[];
  specialRules?: CustomStarRule[];
}

export const CUSTOM_STAR_LIMITS = {
  stars: 32,
  nameChars: 60,
  idChars: 40,
  skills: 24,
  specialRules: 12,
  ruleNameChars: 60,
  ruleDescriptionChars: 600,
  statMax: 20,
  costMax: 2_000_000,
} as const;

/** The Roster Builder / composer position id of a custom star. */
export const customStarPositionId = (star: Pick<CustomStar, "id">): string => `cs-${star.id}`;
export const isCustomStarPositionId = (id: string): boolean => /^cs-[a-z0-9-]{1,40}$/.test(id);

/** The SAME normaliser star detection uses (isStarName / findStar: dataset/lookup normName), so any name that resolves as
 *  a star resolves to the same custom star here. */
const norm = (s: string): string => normName(s.normalize("NFC"));

/** The package's custom stars (an empty list when it has none or the field is malformed). */
export function customStarsOf(pkg: Pick<TournamentPackage, "customStars"> | undefined): CustomStar[] {
  const list = pkg?.customStars;
  return Array.isArray(list) ? list.filter((s): s is CustomStar => Boolean(s) && typeof s === "object" && typeof s.name === "string" && typeof s.id === "string") : [];
}

/** Find a custom star by (forgiving) name. */
export function findCustomStar(pkg: Pick<TournamentPackage, "customStars"> | undefined, name: string): CustomStar | undefined {
  const want = norm(name);
  return customStarsOf(pkg).find((s) => norm(s.name) === want);
}

const cache = new WeakMap<object, { data: Dataset; out: Dataset }>();

/**
 * The dataset with the package's custom stars added to `stars` (eligible for every team, priced and skilled as the
 * organiser set them). Returns `data` itself when the package has none. A custom star whose name is already a dataset
 * star is skipped (the save path refuses such a package; this keeps an old file from shadowing a real star).
 */
export function withCustomStars(data: Dataset, pkg: Pick<TournamentPackage, "customStars">): Dataset {
  const stars = customStarsOf(pkg);
  if (!stars.length) return data;
  const hit = cache.get(pkg as object);
  if (hit && hit.data === data) return hit.out;
  const taken = new Set(data.stars.map((s) => norm(s.name)));
  const extra: DatasetStar[] = [];
  for (const s of stars) {
    const key = norm(s.name);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    extra.push({ name: s.name.trim(), teams: [], cost: s.cost, playsFor: ["(Any)"], skills: [...(s.skills ?? [])] });
  }
  const out: Dataset = { ...data, stars: [...data.stars, ...extra] };
  cache.set(pkg as object, { data, out });
  return out;
}

const target = (n: number | null | undefined): string => (n == null ? "-" : `${n}+`);
/** A custom star's characteristics as a roster prints them. */
export function customStarStats(s: CustomStar): { MA: number; ST: number; AG: string; PA: string; AV: string } {
  return { MA: s.MA, ST: s.ST, AG: target(s.AG), PA: target(s.PA), AV: target(s.AV) };
}

/** Structural problems of a package's customStars (the save path adds the dataset checks: names and skills). */
export function customStarProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return ["customStars must be a list."];
  const L = CUSTOM_STAR_LIMITS;
  const out: string[] = [];
  if (raw.length > L.stars) out.push(`A package may have at most ${L.stars} custom stars.`);
  const ids = new Set<string>();
  const names = new Set<string>();
  raw.slice(0, L.stars).forEach((s: Record<string, unknown>, i) => {
    const at = `customStars[${i}]`;
    if (!s || typeof s !== "object") { out.push(`${at} must be an object.`); return; }
    const id = typeof s.id === "string" ? s.id : "";
    if (!/^[a-z0-9-]{1,40}$/.test(id)) out.push(`${at}.id must be 1-${L.idChars} lower-case letters, digits or hyphens.`);
    else if (ids.has(id)) out.push(`${at}.id "${id}" is used twice.`);
    ids.add(id);
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!name || name.length > L.nameChars || !norm(name)) out.push(`${at}.name must be 1-${L.nameChars} characters, with letters or digits.`);
    else if (names.has(norm(name))) out.push(`Two custom stars are called "${name}".`);
    names.add(norm(name));
    const int = (k: string, min: number, max: number, nullable = false) => {
      const v = s[k];
      if (nullable && v === null) return;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) out.push(`${at}.${k} must be a whole number from ${min} to ${max}${nullable ? " or null" : ""}.`);
    };
    int("cost", 0, L.costMax);
    if (typeof s.cost === "number" && s.cost % 1000 !== 0) out.push(`${at}.cost must be a whole number of thousands.`);
    int("MA", 0, L.statMax);
    int("ST", 0, L.statMax);
    int("AG", 1, 6);
    int("PA", 1, 6, true);
    int("AV", 2, 12);
    if (s.sprite !== undefined && (typeof s.sprite !== "string" || !/^\/sprites\/[A-Za-z0-9_./-]{1,200}\.(png|webp)$/.test(s.sprite) || s.sprite.includes("..")))
      out.push(`${at}.sprite must be one of the site's sprites (/sprites/...).`);
    if (!Array.isArray(s.skills) || s.skills.some((k) => typeof k !== "string" || !k.trim() || k.length > 60)) out.push(`${at}.skills must be a list of skill names.`);
    else if (s.skills.length > L.skills) out.push(`${at} may print at most ${L.skills} skills.`);
    if (s.specialRules !== undefined) {
      if (!Array.isArray(s.specialRules)) out.push(`${at}.specialRules must be a list.`);
      else {
        if (s.specialRules.length > L.specialRules) out.push(`${at} may have at most ${L.specialRules} special rules.`);
        s.specialRules.slice(0, L.specialRules).forEach((r: Record<string, unknown>, j) => {
          const where = `${at}.specialRules[${j}]`;
          if (!r || typeof r !== "object") { out.push(`${where} must be an object.`); return; }
          if (r.kind !== "trait" && r.kind !== "rule") out.push(`${where}.kind must be trait or rule.`);
          const rn = typeof r.name === "string" ? r.name.trim() : "";
          if (!rn || rn.length > L.ruleNameChars) out.push(`${where}.name must be 1-${L.ruleNameChars} characters.`);
          const rd = typeof r.description === "string" ? r.description.trim() : "";
          if (!rd || rd.length > L.ruleDescriptionChars) out.push(`${where}.description must be 1-${L.ruleDescriptionChars} characters.`);
        });
      }
    }
  });
  return out;
}
