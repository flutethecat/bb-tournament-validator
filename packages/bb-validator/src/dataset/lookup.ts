/**
 * SKETCH (unbuilt). Pure lookup helpers over the injected Dataset.
 * Name matching is deliberately forgiving (case/whitespace/aliases) because names
 * arrive from PDFs and, later, OCR.
 */

import type { Dataset, DatasetPosition, DatasetRoster, DatasetStar, SkillMeta } from "./types";

export type Access = "primary" | "secondary" | "illegal";

/**
 * Lowercase, collapse whitespace, strip punctuation-ish variance ("Jump up" == "Jump Up").
 * Also drops FUMBBL roster annotations so a printed skill matches the dataset name:
 *   - a trailing `*` (trait/innate marker): "Frenzy*" == "Frenzy"
 *   - parenthetical values: "Loner (4+)" / "Animosity (Goblin)" == "Loner" / "Animosity"
 */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "(4+)", "(goblin)", "(+1)"
    .replace(/\*/g, " ")
    .replace(/[\s_-]+/g, " ")
    .replace(/['’.]/g, "")
    .trim();
}

/** Non-substring race abbreviations seen on roster sheets (substring variants are handled below). */
const RACE_ALIASES: Record<string, string> = {
  owa: "Old World Alliance",
};

export function findRoster(data: Dataset, raceName: string): DatasetRoster | undefined {
  const want = normName(raceName);
  const rosters = Object.values(data.rosters);
  for (const r of rosters) {
    if (normName(r.name) === want || normName(r.id) === want) return r;
  }
  // Explicit abbreviations that aren't substrings (e.g. "OWA").
  const alias = RACE_ALIASES[want];
  if (alias) {
    const hit = rosters.find((r) => normName(r.name) === normName(alias));
    if (hit) return hit;
  }
  // Unique-containment fallback: forgives short/variant race names on PDFs, e.g.
  // "Underworld" → "Underworld Denizens", "Undead" → "Shambling Undead", plurals
  // like "Chaos Renegades". Requires a UNIQUE match so ambiguous names (e.g. "Chaos"
  // → Chosen/Dwarf/Renegade) fail loudly rather than resolving wrongly.
  if (want.length >= 4) {
    const hits = rosters.filter((r) => {
      const n = normName(r.name);
      return n.includes(want) || want.includes(n);
    });
    if (hits.length === 1) return hits[0];
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

/** May a team carrying `specialRule` hire `star`? */
export function starEligibleBySpecialRule(star: DatasetStar, specialRule: string): boolean {
  if (!star.playsFor || star.playsFor.length === 0) return true;
  const want = normName(specialRule);
  if (!want) return false;
  // Check the universal sentinel before normName strips parenthetical text.
  if (star.playsFor.some((rule) => rule.trim().toLowerCase() === "(any)")) return true;
  return star.playsFor.some((rule) => normName(rule) === want);
}

/**
 * Validate a star against one selected league affiliation while retaining
 * roster-intrinsic affiliations such as Chaos Clash. Morg uses upstream's
 * inverse `(Negate Availability)` form and is available unless the selected
 * affiliation is one of the following exclusions.
 */
export function starEligibleForLeagueSelection(
  star: DatasetStar,
  leagueOptions: readonly string[],
  selectedRule: string,
): boolean {
  const selected = normName(selectedRule);
  if (!selected) return false;
  const playsFor = star.playsFor ?? [];
  if (playsFor.length === 0) return true;
  if (playsFor.some((rule) => rule.trim().toLowerCase() === "(any)")) return true;

  const negated = playsFor.some((rule) => rule.trim().toLowerCase() === "(negate availability)");
  if (negated) {
    return !playsFor.some(
      (rule) => rule.trim().toLowerCase() !== "(negate availability)" && normName(rule) === selected,
    );
  }
  if (playsFor.some((rule) => normName(rule) === selected)) return true;

  const selectable = new Set(leagueOptions.map(normName));
  return !playsFor.some((rule) => selectable.has(normName(rule)));
}

/**
 * The stars a team may hire, DERIVED from eligibility (owner 2026-08-10: "stars should be derived
 * from their eligibility" — never offered from an off-roster pool or injected as positions). The
 * star pool filtered to those that play for `teamName`, optionally narrowed to a chosen
 * `specialRule` value. e.g. a Gnome team that picks "Woodland League" derives Jordell Freshbreeze;
 * a "Halfling Thimble Cup" Gnome team does not.
 */
export function eligibleStarsFor(data: Dataset, teamName: string, specialRule?: string): DatasetStar[] {
  const rule = specialRule?.trim();
  return data.stars.filter(
    (s) => starEligibleForTeam(s, teamName) && (rule ? starEligibleBySpecialRule(s, rule) : true),
  );
}
