/**
 * Ruleset export (creation wizards v2, owner grill 2026-11-02 Q3): a read-only summary of a ruleset package laid out for
 * reviewers, served publicly at GET /api/ruleset-summary?package=<name>[&tournament=<id>|&league=<id>] and printed as a PDF
 * by the SPA page /app/ruleset-summary. Every value is GENERATED from the resolved package (and, with a competition, that
 * competition's house rules): budget and roster limits, the tier table (packageOverview, the Roster Builder's own), the
 * skill-access matrix (positions x skill categories), bans, inducements with house-rule costs, house rules, progression
 * and the custom stars with their special rules. No coach data, no contact details.
 *
 * Visibility (law 14b + spec): a package whose own `visibility` is "draft" is hidden (404) from everyone but organisers and
 * site admins; a competition overlay is offered only for a published tournament / league whose ruleset is this package.
 */
import { customStarsOf, eligibleTeamNames, findRoster, type Dataset, type TournamentPackage } from "@bb/validator";
import { packageOverview, type RulesetOverview } from "./teamBuilderPackage.js";
import { teamBuilderInducementCatalog } from "./teamBuilderInducements.js";
import { defaultHouseRules, houseRulesRows, type CompetitionKind, type HouseRules } from "./competition/houseRules.js";
import { applyHouseRulesToPackage, PRAYERS_INDUCEMENT_ID } from "./competition/packageOverlay.js";

export const SKILL_CATEGORIES = ["General", "Agility", "Strength", "Passing", "Mutation", "Devious"] as const;

export interface RulesetSummary {
  name: string;
  description: string;
  dataNote: string;
  draft: boolean;
  format: "standard" | "sevens";
  competition: { kind: CompetitionKind; id: string; name: string } | null;
  limits: Array<{ k: string; v: string }>;
  overview: RulesetOverview;
  skillAccess: {
    categories: string[];
    rows: Array<{ race: string; position: string; cells: Array<"P" | "S" | ""> }>;
  };
  bans: { stars: string[]; skills: string[] };
  inducements: Array<{ name: string; price: number; max: number | null; note: string; houseRule: boolean }>;
  houseRules: Array<{ k: string; v: string }> | null;
  progression: { k: string; v: string } | null;
  customStars: Array<{
    name: string; sprite: string | null; cost: number; MA: number; ST: number; AG: string; PA: string; AV: string;
    skills: string[]; specialRules: Array<{ kind: "trait" | "rule"; name: string; description: string }>;
  }>;
}

const gold = (n: number | null | undefined): string => (n == null ? "No cap" : `${Math.round(n / 1000).toLocaleString("en-US")}k`);
const cap = (n: number | null | undefined, none = "No cap"): string => (n == null ? none : String(n));
const target = (n: number | null): string => (n == null ? "-" : `${n}+`);

export interface SummaryOptions {
  draft?: boolean;
  competition?: { kind: CompetitionKind; id: string; name: string; houseRules: HouseRules; optIns?: readonly string[] };
}

export function rulesetSummary(pkg: TournamentPackage, data: Dataset, opts: SummaryOptions = {}): RulesetSummary {
  const comp = opts.competition;
  const rules = comp?.houseRules;
  const effective = applyHouseRulesToPackage(pkg, rules);
  const sevens = pkg.format === "sevens";
  const sl = pkg.sideline;
  const tiers = pkg.tiers ?? [];
  const limits: Array<{ k: string; v: string }> = [
    { k: "Team budget", v: tiers.some((t) => t.gold != null) ? `${gold(pkg.goldBudget)} (tiers may differ, see the tier table)` : gold(pkg.goldBudget) },
    { k: "Players", v: `${pkg.special.minPlayers} to ${pkg.special.maxPlayers ?? 16}` },
    { k: "Rerolls", v: cap(sl.maxReRolls, "Roster limit") },
    { k: "Apothecary", v: cap(sl.maxApothecary, "Roster limit") },
    { k: "Assistant coaches", v: cap(sl.maxAssistantCoaches) },
    { k: "Cheerleaders", v: cap(sl.maxCheerleaders) },
    { k: "Dedicated Fans", v: cap(sl.maxDedicatedFans) },
    { k: "Star Players", v: pkg.starPlayers.allowed ? `Allowed${pkg.starPlayers.maxCount != null ? `, at most ${pkg.starPlayers.maxCount}` : ""}${pkg.starPlayers.maxCombinedCost != null ? `, ${gold(pkg.starPlayers.maxCombinedCost)} combined` : ""}` : "Not allowed" },
    { k: "Added skills per player", v: cap(pkg.skillAllotment.maxPerPlayer) },
    { k: "Stat increases", v: pkg.special.statIncreasesAllowed || pkg.statIncreases ? "Allowed (see the tier table)" : "Not allowed" },
  ];
  if (pkg.special.maxNonLineman != null) limits.push({ k: "Players without the Lineman keyword", v: `At most ${pkg.special.maxNonLineman}` });

  // Skill access: every eligible dataset roster's positions, P (primary) / S (secondary) per category.
  const rows: RulesetSummary["skillAccess"]["rows"] = [];
  const listed = eligibleTeamNames(pkg);
  const races = (listed.includes("*") ? data.teams.map((t) => t.name) : listed).filter((r) => findRoster(data, r)).sort((a, b) => a.localeCompare(b));
  for (const race of races) {
    const roster = findRoster(data, race)!;
    for (const p of roster.positions) {
      rows.push({
        race: roster.name,
        position: p.name,
        cells: SKILL_CATEGORIES.map((c) => (p.primaryCategories.includes(c) ? "P" : p.secondaryCategories.includes(c) ? "S" : "")),
      });
    }
  }

  const banned = new Set<string>(pkg.bannedStars ?? []);
  for (const t of tiers) for (const s of t.bannedStars ?? []) banned.add(`${s} (Tier ${t.tier})`);
  for (const r of pkg.teamRules ?? []) for (const s of r.bannedStars ?? []) banned.add(`${s} (${r.team})`);

  const catalog = teamBuilderInducementCatalog(effective, data, comp?.optIns ?? []);
  const prayersCost = rules?.prayers.mode === "cost" ? (rules.prayers.costK ?? 0) * 1000 : null;
  const inducements = catalog.filter((row) => row.allowed && row.max !== 0).map((row) => {
    const notes: string[] = [];
    if (row.reducedPrice != null && (row.reducedSpecialRule || row.reducedRoster)) notes.push(`${gold(row.reducedPrice)} for ${row.reducedSpecialRule ?? `${row.reducedRoster} teams`}`);
    if (row.requiresSpecialRule) notes.push(`${row.requiresSpecialRule} only`);
    if (row.rosterOnly?.length) notes.push(`${row.rosterOnly.join(", ")} only`);
    const houseRule = row.key === PRAYERS_INDUCEMENT_ID && prayersCost != null;
    if (houseRule) notes.push("House rule price");
    return { name: row.label, price: houseRule ? prayersCost! : row.price, max: row.max, note: notes.join("; "), houseRule };
  });

  let houseRules: RulesetSummary["houseRules"] = null;
  let progression: RulesetSummary["progression"] = null;
  if (comp) {
    const all = houseRulesRows(rules ?? defaultHouseRules(comp.kind), comp.kind);
    progression = all.find((r) => r.k === "Progression") ?? null;
    houseRules = all.filter((r) => r.k !== "Progression");
  }

  return {
    name: pkg.name,
    description: pkg.description ?? "",
    dataNote: pkg.dataNote ?? "",
    draft: opts.draft === true,
    format: sevens ? "sevens" : "standard",
    competition: comp ? { kind: comp.kind, id: comp.id, name: comp.name } : null,
    limits,
    overview: packageOverview(effective, data),
    skillAccess: { categories: [...SKILL_CATEGORIES], rows },
    bans: { stars: [...banned], skills: [...(pkg.special.bannedSkills ?? [])] },
    inducements,
    houseRules,
    progression,
    customStars: customStarsOf(pkg).map((s) => ({
      name: s.name, sprite: s.sprite ?? null, cost: s.cost, MA: s.MA, ST: s.ST, AG: target(s.AG), PA: target(s.PA), AV: target(s.AV),
      skills: [...s.skills], specialRules: (s.specialRules ?? []).map((r) => ({ kind: r.kind, name: r.name, description: r.description })),
    })),
  };
}
