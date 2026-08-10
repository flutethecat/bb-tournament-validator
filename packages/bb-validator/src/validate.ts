/**
 * SKETCH (unbuilt). The core entry point: validate(roster, pkg, dataset).
 * Precomputes per-player resolution once, runs the rule registry, groups findings,
 * and recomputes the SP/gold summary the bot (and the T1 tournament service) render.
 */

import type { Finding, ValidationResult } from "./model/findings";
import type { Roster } from "./model/roster";
import type { Dataset } from "./dataset/types";
import { addedSkills, findPosition, findRoster, normName, skillAccess } from "./dataset/lookup";
import type { TournamentPackage } from "./package/types";
import { resolveTeamConfig } from "./package/resolveConfig";
import { costSP } from "./cost/costSP";
import { costGold, inducementsGold, staffGold } from "./cost/costGold";
import { ALL_RULES, recomputeGold } from "./rules/rules";
import type { ResolvedPlayer, Rule, RuleContext } from "./rules/types";
import { err } from "./rules/types";

export function validate(
  roster: Roster,
  pkg: TournamentPackage,
  data: Dataset,
  rules: Rule[] = ALL_RULES,
): ValidationResult {
  const findings: Finding[] = [];

  const datasetRoster = findRoster(data, roster.rosterName);
  if (!datasetRoster) {
    // Unknown races fail gracefully and loudly, never with a misleading "valid" result.
    findings.push(
      err(
        "dataset",
        `The ${roster.rosterName} roster is not in the BB2025 dataset.`,
        { suggestion: "Check the race name; the dataset covers the 30 BB2025 teams." },
      ),
    );
  }

  // Canonicalize the race name to the dataset spelling (e.g. a PDF's "Underworld" →
  // "Underworld Denizens") so eligibility, tiers, and resolveTeamConfig all match.
  if (datasetRoster && normName(datasetRoster.name) !== normName(roster.rosterName)) {
    roster = { ...roster, rosterName: datasetRoster.name };
  }

  // Resolve each player once: position, added skills, and each added skill's access.
  const players: ResolvedPlayer[] = roster.players.map((player) => {
    const position = datasetRoster ? findPosition(datasetRoster, player.positionName) : undefined;
    const added = position ? addedSkills(position, player.skills) : [];
    return {
      player,
      position,
      addedSkills: added,
      access: position ? added.map((s) => skillAccess(data, position, s)) : [],
    };
  });

  const ctx: RuleContext = { roster, pkg, data, datasetRoster, players };

  for (const rule of rules) {
    if (rule.needsDatasetRoster && !datasetRoster) continue;
    findings.push(...rule.check(ctx));
  }

  // Recomputed summary (rendered by the bot / client whatever the verdict).
  let sp = 0;
  let primary = 0;
  let secondary = 0;
  let skillsCost = 0;
  for (const rp of players)
    rp.addedSkills.forEach((skill, i) => {
      const access = rp.access[i];
      if (access === undefined || access === "illegal") return;
      sp += costSP(skill, access, pkg.skillAllotment);
      skillsCost += costGold(skill, access, pkg.skillAllotment);
      if (access === "primary") primary++;
      else secondary++;
    });
  // Owner 2026-08-10 cost buckets: Staff (players + sideline) · Inducements · Skills (added-skill gold).
  const staffCost = staffGold(roster);
  const inducementsCost = inducementsGold(roster);

  const errors = findings.filter((f) => f.severity === "error");
  const rc = resolveTeamConfig(pkg, roster.rosterName);
  // With choose-one packages, show the most generous SP as the headline budget.
  const spBudget = rc.skillPackages?.length
    ? Math.max(...rc.skillPackages.map((p) => p.skillPointBudget))
    : rc.skillPointBudget;
  return {
    valid: errors.length === 0,
    errors,
    warnings: findings.filter((f) => f.severity === "warning"),
    infos: findings.filter((f) => f.severity === "info"),
    recomputedSummary: {
      skillPointsUsed: sp,
      skillPointBudget: spBudget,
      goldUsed: recomputeGold(roster),
      goldBudget: pkg.goldBudget,
      playerCount: roster.players.length,
      primarySkillCount: primary,
      secondarySkillCount: secondary,
      staffCost,
      inducementsCost,
      skillsCost,
    },
  };
}
