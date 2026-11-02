// Custom stars (creation wizards v2, owner grill 2026-11-02): the SPA side of TournamentPackage.customStars
// (packages/bb-validator/src/package/customStars.ts). The Tournament Creator's "Create a star" dialog edits them; the Roster
// Builder offers them like any star (position id cs-<id>), and every builder step, the PDF and the ruleset summary print
// their custom traits and rules under a "Special rules" subheader. Coaches never edit them.

import type { BuilderPosition } from "../teams/builderCore";

export interface CustomStarRuleDoc { kind: "trait" | "rule"; name: string; description: string }
export interface CustomStarDoc {
  id: string;
  name: string;
  sprite?: string;
  cost: number;
  MA: number;
  ST: number;
  AG: number;
  PA: number | null;
  AV: number;
  skills: string[];
  specialRules?: CustomStarRuleDoc[];
}

/** Mirrors CUSTOM_STAR_LIMITS (bb-validator). */
export const CUSTOM_STAR = {
  stars: 32, nameChars: 60, skills: 24, specialRules: 12, ruleNameChars: 60, ruleDescriptionChars: 600, statMax: 20, costMax: 2_000_000,
} as const;

export const SPECIAL_RULES_HEADING = "Special rules";
export const SPECIAL_RULES_HINT = "Custom traits and rules the organiser gave this star.";
export const RULE_KIND_LABEL: Record<CustomStarRuleDoc["kind"], string> = { trait: "Custom trait", rule: "Custom rule" };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);

/** Field-by-field copy of a server list (never spread a server object). Bad rows are dropped. */
export function sanitizeCustomStars(raw: unknown): CustomStarDoc[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRec).filter((s) => str(s.id) && str(s.name).trim()).slice(0, CUSTOM_STAR.stars).map((s) => ({
    id: str(s.id),
    name: str(s.name).trim(),
    ...(str(s.sprite) ? { sprite: str(s.sprite) } : {}),
    cost: int(s.cost, 0),
    MA: int(s.MA, 6), ST: int(s.ST, 3), AG: int(s.AG, 3), PA: s.PA === null ? null : int(s.PA, 4), AV: int(s.AV, 9),
    skills: Array.isArray(s.skills) ? s.skills.map(str).filter(Boolean) : [],
    specialRules: Array.isArray(s.specialRules)
      ? s.specialRules.filter(isRec).map((r) => ({ kind: r.kind === "trait" ? "trait" as const : "rule" as const, name: str(r.name), description: str(r.description) }))
        .filter((r) => r.name.trim())
      : [],
  }));
}

/** A slug id for a new star, unique within `taken`. */
export function customStarId(name: string, taken: readonly string[]): string {
  const base = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "star";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`.slice(0, 40);
  return id;
}

export function blankCustomStar(): CustomStarDoc {
  return { id: "", name: "", cost: 100_000, MA: 6, ST: 3, AG: 3, PA: 4, AV: 9, skills: ["Loner (4+)"], specialRules: [] };
}

/** Target characteristics print as "3+"; PA null prints "-". */
export const targetText = (n: number | null): string => (n == null ? "-" : `${n}+`);

/** The star's position for the Roster Builder: a star on every roster, one copy, the package's price, stats and skills. */
export function customStarPosition(s: CustomStarDoc): BuilderPosition & { specialRules: CustomStarRuleDoc[]; customStar: true; sprite?: string } {
  return {
    positionId: `cs-${s.id}`, name: s.name, type: "Star", cost: s.cost, max: 1,
    MA: s.MA, ST: s.ST, AG: targetText(s.AG), PA: targetText(s.PA), AV: targetText(s.AV),
    skills: [...s.skills], keywords: [], isStar: true, playsFor: [],
    specialRules: (s.specialRules ?? []).map((r) => ({ ...r })), customStar: true,
    ...(s.sprite ? { sprite: s.sprite } : {}),
  };
}

/** What a save would refuse, in the dialog's words ("" = fine). */
export function customStarError(s: CustomStarDoc, others: readonly CustomStarDoc[], datasetStars: readonly string[] = []): string {
  const name = s.name.trim();
  if (!name) return "Give the star a name.";
  if (name.length > CUSTOM_STAR.nameChars) return `Keep the name to ${CUSTOM_STAR.nameChars} characters.`;
  const key = name.toLowerCase();
  if (others.some((o) => o.id !== s.id && o.name.trim().toLowerCase() === key)) return "Another custom star already has that name.";
  if (datasetStars.some((d) => d.trim().toLowerCase() === key)) return "That is the name of a BB2025 Star Player. Pick another name.";
  if (!Number.isInteger(s.cost) || s.cost < 0 || s.cost > CUSTOM_STAR.costMax || s.cost % 1000 !== 0) return "The cost must be a whole number of thousands of gold.";
  if (s.skills.length > CUSTOM_STAR.skills) return `A star prints at most ${CUSTOM_STAR.skills} skills.`;
  for (const r of s.specialRules ?? []) {
    if (!r.name.trim() || !r.description.trim()) return `Each ${RULE_KIND_LABEL[r.kind].toLowerCase()} needs a name and a description.`;
  }
  return "";
}

/** The characteristic steps the dialog's +/- buttons take. MA/ST rise, AG/PA improve downwards (3+ -> 2+), AV rises. */
export type StarStat = "MA" | "ST" | "AG" | "PA" | "AV";
export const STAR_STATS: StarStat[] = ["MA", "ST", "AG", "PA", "AV"];
export function stepStat(s: CustomStarDoc, stat: StarStat, dir: 1 | -1): CustomStarDoc {
  const next = { ...s };
  if (stat === "MA" || stat === "ST") next[stat] = Math.max(0, Math.min(CUSTOM_STAR.statMax, s[stat] + dir));
  else if (stat === "AV") next.AV = Math.max(2, Math.min(12, s.AV + dir));
  else if (stat === "AG") next.AG = Math.max(1, Math.min(6, s.AG - dir));
  else {
    // PA: "+" improves (4+ -> 3+ ... 1+), "-" worsens down to 6+ then "-" (no passing); "+" from "-" gives 6+.
    if (s.PA == null) next.PA = dir > 0 ? 6 : null;
    else if (dir < 0 && s.PA >= 6) next.PA = null;
    else next.PA = Math.max(1, Math.min(6, s.PA - dir));
  }
  return next;
}
export const statValue = (s: CustomStarDoc, stat: StarStat): string => (stat === "MA" || stat === "ST" ? String(s[stat]) : targetText(s[stat]));

/** The site's own sprites by race (manifest.json), for the sprite picker. Paths are stored with a leading slash. */
export interface SpriteOption { race: string; role: string; path: string }
export function spriteOptions(manifest: unknown): SpriteOption[] {
  const races = isRec(manifest) && isRec(manifest.races) ? manifest.races : {};
  const out: SpriteOption[] = [];
  for (const [race, roles] of Object.entries(races)) {
    if (!isRec(roles)) continue;
    for (const [role, path] of Object.entries(roles)) {
      const p = str(path);
      if (/^\/?sprites\/[A-Za-z0-9_./-]+\.(png|webp)$/.test(p) && !p.includes("..")) out.push({ race, role, path: p.startsWith("/") ? p : `/${p}` });
    }
  }
  return out;
}

/** The skill catalogue for the dialog's blades: /api/skills?traits=1 grouped by category, traits last. */
export interface SkillGroup { category: string; skills: Array<{ name: string; elite: boolean }> }
export function skillGroups(raw: unknown): SkillGroup[] {
  const r = isRec(raw) ? raw : {};
  const map = new Map<string, Array<{ name: string; elite: boolean }>>();
  for (const key of ["general", "elite"]) {
    for (const row of Array.isArray(r[key]) ? (r[key] as unknown[]) : []) {
      if (!isRec(row) || !str(row.name)) continue;
      const cat = str(row.category) || "General";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push({ name: str(row.name), elite: row.elite === true });
    }
  }
  const order = ["General", "Agility", "Strength", "Passing", "Devious", "Mutation"];
  const rank = (c: string): number => (order.includes(c) ? order.indexOf(c) : order.length);
  const groups = [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, skills]) => ({ category, skills: skills.sort((x, y) => x.name.localeCompare(y.name)) }));
  const traits = (Array.isArray(r.traits) ? (r.traits as unknown[]) : []).filter(isRec).map((t) => ({ name: str(t.name), elite: false })).filter((t) => t.name);
  if (traits.length) groups.push({ category: "Traits", skills: traits });
  return groups;
}
