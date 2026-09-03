/**
 * The gold cost model for ADDED skills, plus the three team-cost "bucket" formulas
 * the Team Builder and validation share (owner 2026-08-10): a team's gold splits into
 *   Staff Cost      = players + sideline staff
 *   Inducements Cost
 *   Skills Cost      = added-skill gold (this module's costGold)
 * Each is an exported pure formula so rules and the builder summary compute them the
 * same way. The skill pricing is package-configurable (SkillAllotment gold knobs),
 * defaulting to the owner's 2026-08-04 flat model: +20k primary / +40k secondary /
 * +10k elite surcharge (⇒ elite-primary 30k, elite-secondary 50k).
 */

import type { Access } from "../dataset/lookup";
import { addedSkills, findPosition, findRoster, normName, skillAccess } from "../dataset/lookup";
import type { Dataset } from "../dataset/types";
import type { Roster } from "../model/roster";
import type { SkillAllotment, TournamentPackage } from "../package/types";
import { isElite } from "./costSP";

/** Owner 2026-08-04 flat defaults, in gold, used when the package leaves the knobs unset. */
export const DEFAULT_SKILL_GOLD = { primary: 20000, secondary: 40000, eliteSurcharge: 10000 } as const;

/**
 * Gold TV a single ADDED skill contributes, by its per-position access. Mirrors costSP:
 * a per-skill override wins outright (no elite surcharge on top); otherwise the per-access
 * base plus the elite surcharge when the skill is in the effective Elite set.
 */
export function costGold(skill: string, access: Exclude<Access, "illegal">, cfg: SkillAllotment): number {
  const want = normName(skill);
  if (cfg.skillCostGold) {
    for (const [name, cost] of Object.entries(cfg.skillCostGold)) {
      if (normName(name) === want) return cost;
    }
  }
  const base =
    access === "secondary"
      ? (cfg.secondaryCostGold ?? DEFAULT_SKILL_GOLD.secondary)
      : (cfg.primaryCostGold ?? DEFAULT_SKILL_GOLD.primary);
  return base + (isElite(skill, cfg) ? (cfg.eliteSurchargeGold ?? DEFAULT_SKILL_GOLD.eliteSurcharge) : 0);
}

/** STAFF COST = every player's printed cost + the sideline staff total (rerolls, apothecary,
 *  cheerleaders, assistant coaches, dedicated fans). */
export function staffGold(roster: {
  players: { cost: number }[];
  summary?: { sidelineCost?: number } | undefined;
}): number {
  const players = roster.players.reduce((a, p) => a + p.cost, 0);
  return players + (roster.summary?.sidelineCost ?? 0);
}

/** INDUCEMENTS COST. Prefer the array's own per-item costs; fall back to the sheet total
 *  (many sources list inducement names without per-item gold). */
export function inducementsGold(roster: {
  inducements: { cost?: number; count?: number }[];
  summary?: { inducementCost?: number } | undefined;
}): number {
  const arr = roster.inducements.reduce((a, i) => a + (i.cost ?? 0) * (i.count ?? 1), 0);
  return arr > 0 ? arr : (roster.summary?.inducementCost ?? 0);
}

/** SKILLS COST = added-skill gold across the team, priced by costGold. Resolves each player's
 *  added skills against the dataset; illegal/unknown skills contribute nothing (the skill-access
 *  rule reports those separately). Returns 0 for an off-dataset (Secret League) race. */
export function skillsGold(roster: Roster, data: Dataset, pkg: TournamentPackage): number {
  const dsRoster = findRoster(data, roster.rosterName);
  if (!dsRoster) return 0;
  let gold = 0;
  for (const player of roster.players) {
    const position = findPosition(dsRoster, player.positionName);
    if (!position) continue;
    const skills = addedSkills(position, player.skills);
    let legalPicks = 0;
    for (const skill of skills) {
      const access = skillAccess(data, position, skill);
      if (access === "illegal") continue;
      gold += costGold(skill, access, pkg.skillAllotment);
      legalPicks++;
    }
    gold += Math.max(0, legalPicks - 1) * (pkg.skillAllotment.stackSurchargeGold ?? 0);
  }
  return gold;
}
