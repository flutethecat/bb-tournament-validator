/**
 * SKETCH (unbuilt). The configurable Skill-Point cost function — the owner's core
 * requirement. Pure; all knobs come from the package's SkillAllotment.
 *
 * costSP(skill, access) =
 *     skillCostSP[skill]                                          if defined
 *   else (secondary ? secondaryCostSP ?? primary*secondaryMultiplier : primary)
 *        + (skill in eliteSkills ? eliteSurchargeSP : 0)
 */

import type { Access } from "../dataset/lookup";
import { normName } from "../dataset/lookup";
import type { SkillAllotment } from "../package/types";

export function isElite(skill: string, cfg: SkillAllotment): boolean {
  const want = normName(skill);
  return cfg.eliteSkills.some((s) => normName(s) === want);
}

export function costSP(skill: string, access: Exclude<Access, "illegal">, cfg: SkillAllotment): number {
  // Explicit per-skill override wins outright (no elite surcharge on top).
  const want = normName(skill);
  for (const [name, cost] of Object.entries(cfg.skillCostSP)) {
    if (normName(name) === want) return cost;
  }
  const base =
    access === "secondary"
      ? (cfg.secondaryCostSP ?? cfg.primaryCostSP * cfg.secondaryMultiplier)
      : cfg.primaryCostSP;
  return base + (isElite(skill, cfg) ? cfg.eliteSurchargeSP : 0);
}
