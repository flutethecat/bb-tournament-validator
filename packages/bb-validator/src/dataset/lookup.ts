/**
 * SKETCH (unbuilt). Pure lookup helpers over the injected Dataset.
 * Name matching is deliberately forgiving (case/whitespace/aliases) because names
 * arrive from PDFs and, later, OCR.
 */

import type { Dataset, DatasetPosition, DatasetRoster, DatasetStar, SkillMeta } from "./types";

export type Access = "primary" | "secondary" | "illegal";

/** Lowercase, collapse whitespace, strip punctuation-ish variance ("Jump up" == "Jump Up"). */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, " ").replace(/['’.]/g, "").trim();
}

export function findRoster(data: Dataset, raceName: string): DatasetRoster | undefined {
  const want = normName(raceName);
  for (const r of Object.values(data.rosters)) {
    if (normName(r.name) === want || normName(r.id) === want) return r;
  }
  return undefined;
}

export function findPosition(roster: DatasetRoster, positionName: string): DatasetPosition | undefined {
  const want = normName(positionName);
  for (const p of roster.positions) {
    if (normName(p.name) === want) return p;
    if (p.aliases?.some((a) => normName(a) === want)) return p;
  }
  // Fallback: tolerate role-suffix variance within a roster, e.g. a sheet's
  // "Jaguar Warrior" vs the dataset's "Jaguar Warrior Blocker". Scoped to one
  // roster's positions, so collisions are unlikely; require a substantial match.
  if (want.length >= 4) {
    for (const p of roster.positions) {
      const n = normName(p.name);
      if (n.includes(want) || want.includes(n)) return p;
    }
  }
  return undefined;
}

export function findSkill(data: Dataset, skillName: string): SkillMeta | undefined {
  const want = normName(skillName);
  for (const [name, meta] of Object.entries(data.skills)) {
    if (normName(name) === want) return meta;
  }
  return undefined;
}

/**
 * Is `skill` primary, secondary, or illegal for `position`?
 * Unknown skills and traits are "illegal" — the rule that calls this turns unknowns
 * into their own explicit finding so data gaps are loud, not silent.
 */
export function skillAccess(data: Dataset, position: DatasetPosition, skill: string): Access {
  const meta = findSkill(data, skill);
  if (!meta?.category || meta.trait) return "illegal";
  if (position.primaryCategories.includes(meta.category)) return "primary";
  if (position.secondaryCategories.includes(meta.category)) return "secondary";
  return "illegal";
}

/** Diff a player's printed skills against the position's base skills → added skills. */
export function addedSkills(position: DatasetPosition, printedSkills: string[]): string[] {
  const base = new Set(position.skills.map(normName));
  return printedSkills.filter((s) => !base.has(normName(s)));
}

/** Normalized set of all known star-player names (generic, all teams). */
export function starNameSet(data: Dataset): Set<string> {
  return new Set(data.stars.map((s) => normName(s.name)));
}

/** Is this position name a known Star Player? */
export function isStarName(data: Dataset, positionName: string): boolean {
  return starNameSet(data).has(normName(positionName));
}

/** Look up a star's dataset entry by (forgiving) name. */
export function findStar(data: Dataset, starName: string): DatasetStar | undefined {
  const want = normName(starName);
  return data.stars.find((s) => normName(s.name) === want);
}

/**
 * May `teamName` hire star `star`? BB2025 gates stars by "plays for" special
 * rules (baked into `star.teams` at dataset-gen time). Returns true when the star
 * has no eligibility data (empty `teams`) so data gaps never wrongly reject a roster.
 */
export function starEligibleForTeam(star: DatasetStar, teamName: string): boolean {
  if (!star.teams || star.teams.length === 0) return true;
  const want = normName(teamName);
  return star.teams.some((t) => normName(t) === want);
}
