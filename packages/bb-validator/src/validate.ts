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
import { costGold, inducementsGold, skillsGold, staffGold } from "./cost/costGold";
import { effectiveStaffPrices, priceStaff } from "./cost/staff";
import { inducementCatalog, inducementIdInCatalog, inducementReducedFor, usesSevensInducements } from "./dataset/inducements";
import { SEVENS_VETERAN_MA_DELTA } from "./dataset/bb2025/sevens";
import type { DatasetRoster } from "./dataset/types";
import { starPackPicks, statIncreasesGold } from "./cost/extras";
import { ALL_RULES, recomputeGold, starCosts } from "./rules/rules";
import type { ResolvedPlayer, Rule, RuleContext } from "./rules/types";
import { err } from "./rules/types";

/**
 * Re-price a roster for a package with `staffPrices` and/or the Sevens inducement list (undefined = nothing to re-price, so
 * every other package keeps today's figures byte-for-byte). Staff gold = counts x prices (free Dedicated Fans =
 * sideline.dedicatedFansStart, default 1); a Sevens inducement costs its Sevens price (reduced for the unlocking rule or
 * roster); an item the list doesn't carry keeps the sheet's cost (the inducements rule refuses it). In Sevens added skills
 * are priced by the package's skill-gold knobs (0 by default: bought skills don't add to Current Value).
 */
export function priceRoster(roster: Roster, pkg: TournamentPackage, data: Dataset, datasetRoster?: DatasetRoster): Roster | undefined {
  const prices = effectiveStaffPrices(pkg);
  const sevensList = usesSevensInducements(pkg);
  if (!prices && !sevensList) return undefined;
  const catalog = inducementCatalog(pkg, data);
  const rules = roster.specialRules;
  const inducements = sevensList
    ? roster.inducements.map((ind) => {
        const id = ind.id && catalog[ind.id] ? ind.id : inducementIdInCatalog(catalog, ind.name);
        const meta = id ? catalog[id] : undefined;
        if (!meta || meta.cost == null) return ind;
        const each = inducementReducedFor(meta, rules, roster.rosterName) && meta.reducedCost != null ? meta.reducedCost : meta.cost;
        return { ...ind, cost: each };
      })
    : roster.inducements;
  const sidelineCost = prices
    ? priceStaff(roster.sideline, prices, datasetRoster?.reRollCost ?? 0, pkg.sideline.dedicatedFansStart ?? 1).total
    : (roster.summary?.sidelineCost ?? 0);
  const playersCost = roster.players.reduce((a, p) => a + p.cost, 0);
  const inducementCost = inducementsGold({ inducements, summary: roster.summary });
  const skillsCost = pkg.format === "sevens" ? skillsGold(roster, data, pkg) : (roster.summary?.skillsCost ?? 0);
  return {
    ...roster,
    inducements,
    summary: {
      ...(roster.summary ?? {}),
      playersCost,
      skillsCost,
      inducementCost,
      sidelineCost,
      total: playersCost + skillsCost + inducementCost + sidelineCost,
    },
  };
}

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
    const found = datasetRoster ? findPosition(datasetRoster, player.positionName) : undefined;
    // Sevens Veteran: its printed base is the position's MA minus one, so stat increases are diffed (priced, capped)
    // against that, and a +MA printed back up to the position's MA still counts as an increase.
    const position = found && pkg.special.veteran === true && player.veteran === true
      ? { ...found, MA: found.MA + SEVENS_VETERAN_MA_DELTA }
      : found;
    const added = position ? addedSkills(position, player.skills) : [];
    return {
      player,
      position,
      addedSkills: added,
      access: position ? added.map((s) => skillAccess(data, position, s)) : [],
    };
  });

  // Staff prices / the Sevens inducement list: the gold comes from the counts at the package's prices, never from the
  // sheet (the sheet keeps its own figures for the price checks in ctx.sheetRoster).
  const priced = priceRoster(roster, pkg, data, datasetRoster);
  const sheetRoster = priced ? roster : undefined;
  if (priced) roster = priced;

  const ctx: RuleContext = { roster, pkg, data, datasetRoster, players, ...(sheetRoster ? { sheetRoster } : {}) };

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
  // NAF stacking surcharge: same per-player calc as the skill-points rule, so the summary matches its message.
  // Choose-one skill packages are checked by the skill-packages rule, which charges no surcharge: skip it there.
  const stackSurchargeSP = resolveTeamConfig(pkg, roster.rosterName).skillPackages?.length ? 0 : (pkg.skillAllotment.stackSurchargeSP ?? 0);
  if (stackSurchargeSP > 0)
    for (const rp of players) {
      const legal = rp.addedSkills.filter((_, i) => rp.access[i] !== undefined && rp.access[i] !== "illegal").length;
      sp += Math.max(0, legal - 1) * stackSurchargeSP;
    }
  // Owner 2026-08-10 cost buckets: Staff (players + sideline) · Inducements · Skills (added-skill gold).
  const staffCost = staffGold(roster);
  const inducementsCost = inducementsGold(roster);

  const errors = findings.filter((f) => f.severity === "error");
  const rc = resolveTeamConfig(pkg, roster.rosterName);
  const { starGold, starSP } = starCosts(players, pkg, data, rc.tierNumber);
  // Generic extra knobs (0 for packages that don't configure them).
  const statIncreasesCost = statIncreasesGold(players, rc.statIncreases);
  const starFeesCost = pkg.starPacks?.length ? starPackPicks(players, pkg, data).feesGold : 0;
  const spPaidStarGold = pkg.starPlayers.paidInSkillPoints ? starGold : 0;
  // HARD gold cap: report the same total the gold-budget rule checks (skills + extras inside).
  // Choose-one packages pay for skills with the pack (SP / skill count), never gold: report the same
  // build cost the skill-packages rule checks (sheet skill gold excluded).
  const goldUsed = rc.skillPackages?.length
    ? recomputeGold(roster) - (roster.summary?.skillsCost ?? 0) - spPaidStarGold
    : pkg.goldCapIncludesAddedSkills
      ? recomputeGold(roster) - (roster.summary?.skillsCost ?? 0) + skillsCost + statIncreasesCost + starFeesCost - spPaidStarGold
      : recomputeGold(roster) - spPaidStarGold;
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
      skillPointsUsed: sp + starSP,
      skillPointBudget: spBudget,
      goldUsed,
      goldBudget: pkg.goldBudget,
      playerCount: roster.players.length,
      primarySkillCount: primary,
      secondarySkillCount: secondary,
      staffCost,
      inducementsCost,
      skillsCost,
      starsCost: starGold,
      // Only for packages that use these knobs (legacy responses stay byte-identical).
      ...(rc.statIncreases || pkg.starPacks?.length || statIncreasesCost || starFeesCost
        ? { statIncreasesCost, starFeesCost }
        : {}),
    },
  };
}
