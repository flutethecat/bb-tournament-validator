/**
 * The eleven M1 rules from the approved plan, one exported Rule each.
 * All pure functions over the precomputed RuleContext.
 */

import { costSP, isElite } from "../cost/costSP";
import { canonicalizeStatRuleRaces, cleanStatIncreaseRules, playerStatRuleBlock, statRuleBlock, teamCapBlock } from "../cost/statRules";
import { MAX_STAT_STEPS, starPackPicks, statIncreasesGold, statIncreasesOf, statIncreasesOverLimit } from "../cost/extras";
import { skillsGold } from "../cost/costGold";
import { inducementCatalog, inducementIdForName, inducementIdInCatalog, inducementReducedFor, usesSevensInducements } from "../dataset/inducements";
import { hasLinemanKeyword, SEVENS_VETERAN_MA_DELTA } from "../dataset/bb2025/sevens";
import { effectiveStaffPrices, priceStaff } from "../cost/staff";
import type { Dataset } from "../dataset/types";
import { customStarStats, customStarsOf, findCustomStar } from "../package/customStars";
import { canonSkill, decodeEntities, findRoster, findSkill, findStar, isStarName, normName, rosterHasTeamCaptain, starEligibleForTeam, TEAM_CAPTAIN, TEAM_CAPTAIN_FREE_SKILL } from "../dataset/lookup";
import type { Finding } from "../model/findings";
import { isCountPack, type SkillPackage, type TournamentPackage } from "../package/types";
import { eligibleTeamNames, fitsSkillCounts, isEligible, resolveTeamConfig, sourceLabel, usesCountMode } from "../package/resolveConfig";
import type { ResolvedPlayer, Rule } from "./types";
import { err, warn } from "./types";

/** 1. Roster eligibility — across flat / tiers / matrix bucketing. */
export const rosterEligibility: Rule = {
  id: "roster-eligibility",
  check: ({ roster, pkg }) => {
    if (isEligible(pkg, roster.rosterName)) return [];
    const eligible = eligibleTeamNames(pkg);
    return [
      err("roster-eligibility", `${roster.rosterName} is not an eligible roster for "${pkg.name}".`, {
        expected: eligible.join(", "),
        actual: roster.rosterName,
        suggestion: `Eligible teams: ${eligible.join(", ") || "none configured"}.`,
      }),
    ];
  },
};

/** 2. Squad size — minPlayers..maxPlayers (special.maxPlayers, default 16; Sevens 11). */
export const squadSize: Rule = {
  id: "squad-size",
  check: ({ roster, pkg }) => {
    const n = roster.players.length;
    const min = pkg.special.minPlayers;
    const max = pkg.special.maxPlayers ?? 16;
    if (n < min)
      return [
        err("squad-size", `Team has ${n} players; the tournament requires at least ${min}.`, {
          expected: `>= ${min}`,
          actual: n,
          suggestion: `Add ${min - n} more player${min - n === 1 ? "" : "s"}.`,
        }),
      ];
    if (n > max)
      return [
        err("squad-size", `Team has ${n} players; ${pkg.format === "sevens" ? "Sevens allows at most" : "the maximum roster size is"} ${max}.`, {
          expected: `<= ${max}`,
          actual: n,
          suggestion: `Remove ${n - max} player${n - max === 1 ? "" : "s"}.`,
        }),
      ];
    return [];
  },
};

/** 3. Positional limits — per-position max + maxBigGuys; also unknown positions. */
export const positionalLimits: Rule = {
  id: "positional-limits",
  needsDatasetRoster: true,
  check: ({ players, datasetRoster, data, pkg }) => {
    const findings: Finding[] = [];
    const counts = new Map<string, number>();
    let bigGuys = 0;
    for (const rp of players) {
      if (!rp.position) {
        // Star Players aren't in positions[]; the star-players rule handles them.
        if (isStarName(data, rp.player.positionName)) continue;
        findings.push(
          err(
            "positional-limits",
            `#${rp.player.number} "${rp.player.positionName}" is not a position on the ${datasetRoster!.name} roster.`,
            { playerRef: rp.player.number, suggestion: "Check the position name / roster race." },
          ),
        );
        continue;
      }
      counts.set(rp.position.id, (counts.get(rp.position.id) ?? 0) + 1);
      if (rp.position.type === "bigguy") bigGuys++;
    }
    for (const [posId, count] of counts) {
      const pos = datasetRoster!.positions.find((p) => p.id === posId);
      if (!pos) continue;
      if (count > pos.max)
        findings.push(
          err("positional-limits", `${count}× ${pos.name} exceeds the 0-${pos.max} limit.`, {
            expected: `<= ${pos.max}`,
            actual: count,
            suggestion: `Remove ${count - pos.max}× ${pos.name}.`,
          }),
        );
    }
    if (bigGuys > datasetRoster!.maxBigGuys)
      findings.push(
        err(
          "positional-limits",
          `${bigGuys} Big Guys exceeds the roster's limit of ${datasetRoster!.maxBigGuys}.`,
          { expected: `<= ${datasetRoster!.maxBigGuys}`, actual: bigGuys },
        ),
      );
    // Sevens (special.maxNonLineman): at most N players WITHOUT the Lineman keyword. The keyword decides (owner Q2), and
    // each position's own limit above still applies. Stars are left to the star rules.
    const nonLinemanCap = pkg.special.maxNonLineman;
    if (nonLinemanCap != null) {
      const non = players.filter((rp) => rp.position && !hasLinemanKeyword(rp.position));
      if (non.length > nonLinemanCap) {
        const names = [...new Set(non.map((rp) => rp.position!.name))];
        findings.push(
          err(
            "positional-limits",
            `${non.length} players without the Lineman keyword; ${pkg.format === "sevens" ? "Sevens allows" : "this ruleset allows"} at most ${nonLinemanCap}.`,
            {
              expected: `<= ${nonLinemanCap} non-Lineman players`,
              actual: non.length,
              suggestion: `Swap ${non.length - nonLinemanCap} of them (${names.join(", ")}) for Lineman-keyword players.`,
            },
          ),
        );
      }
    }
    return findings;
  },
};

/**
 * 3b. Sevens Veteran (SJ22 #veterans): with `special.veteran` exactly one player is the Veteran (`RosterPlayer.veteran`),
 * a Lineman-keyword player, printed with MA one lower (owner Q11: no other builder effect). A package without the rule
 * refuses a Veteran mark, since the Veteran's once-a-game reroll is a Sevens benefit.
 */
export const sevensVeteran: Rule = {
  id: "sevens-veteran",
  check: ({ players, pkg }) => {
    const vets = players.filter((rp) => rp.player.veteran === true);
    const label = (rp: ResolvedPlayer) => `#${rp.player.number} ${rp.position?.name ?? rp.player.positionName}`;
    if (pkg.special.veteran !== true)
      return vets.map((rp) =>
        err("sevens-veteran", `${label(rp)} is marked as the Veteran, but this ruleset has no Veteran (a Blood Bowl Sevens rule).`, {
          playerRef: rp.player.number,
          suggestion: "Remove the Veteran mark.",
        }),
      );
    if (vets.length === 0)
      return [err("sevens-veteran", "Pick one Lineman as the Veteran.", { expected: "1 Veteran", actual: 0, suggestion: "Mark one Lineman-keyword player as the Veteran (MA -1, one reroll a game)." })];
    const findings: Finding[] = [];
    if (vets.length > 1)
      findings.push(err("sevens-veteran", `${vets.length} Veterans; only one is allowed.`, { expected: "1 Veteran", actual: vets.length, suggestion: "Keep one Veteran." }));
    for (const rp of vets) {
      if (!rp.position || !hasLinemanKeyword(rp.position)) {
        findings.push(
          err("sevens-veteran", `${label(rp)} can't be the Veteran: only Linemen can.`, {
            playerRef: rp.player.number,
            suggestion: "Pick a player with the Lineman keyword as the Veteran.",
          }),
        );
        continue;
      }
      // Printed MA: one lower than the position (skipped when stat increases are on, where the base MA may have moved).
      // validate() already hands a Veteran its Veteran base (the position's MA minus one).
      const want = rp.position.MA;
      const full = want - SEVENS_VETERAN_MA_DELTA;
      if (pkg.special.statIncreasesAllowed !== true && rp.player.MA !== want)
        findings.push(
          err("sevens-veteran", `${label(rp)} is the Veteran, so MA should read ${want} (one lower than ${full}); the sheet shows ${rp.player.MA}.`, {
            playerRef: rp.player.number,
            expected: `MA ${want}`,
            actual: `MA ${rp.player.MA}`,
          }),
        );
    }
    return findings;
  },
};

/** 4. Gold budget (optional) — recomputed team gold <= the effective (resolved) gold cap. */
export const goldBudget: Rule = {
  id: "gold-budget",
  check: ({ roster, pkg, data, players }) => {
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    if (cfg.skillPackages?.length) return []; // gold is checked jointly with SP by skill-packages
    if (cfg.gold == null) return [];
    // Default: skills add TV but don't eat the cap (owner 2026-08-10). A HARD gold limit
    // (goldCapIncludesAddedSkills) counts them — Meero option (c): strip whatever recomputeGold
    // already counted for skills (0 for a built team, the sheet value for a submitted one) and add
    // the flat-model skillsGold. No double-count; SP-paid Star gold is then excluded in either mode.
    const { starGold } = starCosts(players, pkg, data, cfg.tierNumber);
    const spPaidStarGold = pkg.starPlayers.paidInSkillPoints ? starGold : 0;
    const gold = (pkg.goldCapIncludesAddedSkills
      ? recomputeGold(roster) - (roster.summary?.skillsCost ?? 0) + skillsGold(roster, data, pkg) + extrasGold(players, pkg, data, cfg)
      : recomputeGold(roster)) - spPaidStarGold;
    const where = sourceLabel(cfg);
    return gold > cfg.gold
      ? [
          err("gold-budget", `Team costs ${fmtGold(gold)}, over the ${fmtGold(cfg.gold)} budget${where}.`, {
            expected: `<= ${fmtGold(cfg.gold)}`,
            actual: fmtGold(gold),
            suggestion: `Trim ${fmtGold(gold - cfg.gold)}.`,
          }),
        ]
      : [];
  },
};

/** 5. Skill access — every added skill must be primary or secondary for its position. */
export const skillAccessRule: Rule = {
  id: "skill-access",
  needsDatasetRoster: true,
  check: ({ players, data }) => {
    const findings: Finding[] = [];
    for (const rp of players) {
      if (!rp.position) continue; // positional-limits already flagged it
      rp.addedSkills.forEach((skill, i) => {
        if (rp.access[i] !== "illegal") return;
        const meta = findSkill(data, skill);
        const why = !meta
          ? "is not a known BB2025 skill"
          : meta.trait
            ? "is a Trait and cannot be taken as an added skill"
            : `(${meta.category}) is neither primary nor secondary for ${rp.position!.name}`;
        findings.push(
          err("skill-access", `#${rp.player.number} ${rp.position!.name}: ${skill} ${why}.`, {
            playerRef: rp.player.number,
            suggestion: `Replace ${skill} with a skill from: primary ${rp.position!.primaryCategories.join("/")}, secondary ${rp.position!.secondaryCategories.join("/")}.`,
          }),
        );
      });
    }
    return findings;
  },
};

/** 6. Skill-point allotment — Σ costSP ≤ budget; maxPerPlayer; maxSameSkillTeamwide; no dupes. */
export const skillPoints: Rule = {
  id: "skill-points",
  needsDatasetRoster: true,
  check: ({ players, pkg, roster }) => {
    const cfg = pkg.skillAllotment;
    const resolved = resolveTeamConfig(pkg, roster.rosterName);
    const where = sourceLabel(resolved);
    const findings: Finding[] = [];
    let total = 0;
    let stackSurcharge = 0; // owner 09-09: NAF per-player stacking surcharge, reported separately when it bites
    let primaryCount = 0;
    let secondaryCount = 0;
    let stackedPlayers = 0;
    const teamwide = new Map<string, number>();

    for (const rp of players) {
      if (!rp.position) continue;
      if (rp.addedSkills.length > 1) stackedPlayers++;
      const seen = new Set<string>();
      for (const s of rp.player.skills.map(normName)) {
        if (seen.has(s))
          findings.push(
            err("skill-points", `#${rp.player.number} has the same skill twice (${s}).`, {
              playerRef: rp.player.number,
            }),
          );
        seen.add(s);
      }
      if (!resolved.skillPackages?.length && cfg.maxPerPlayer != null && rp.addedSkills.length > cfg.maxPerPlayer)
        findings.push(
          err(
            "skill-points",
            `#${rp.player.number} has ${rp.addedSkills.length} added skills; the limit is ${cfg.maxPerPlayer} per player.`,
            {
              playerRef: rp.player.number,
              expected: `<= ${cfg.maxPerPlayer}`,
              actual: rp.addedSkills.length,
            },
          ),
        );
      rp.addedSkills.forEach((skill, i) => {
        const access = rp.access[i];
        if (access === undefined || access === "illegal") return; // only count legal picks
        total += costSP(skill, access, cfg);
        if (access === "primary") primaryCount++;
        else secondaryCount++;
        teamwide.set(normName(skill), (teamwide.get(normName(skill)) ?? 0) + 1);
      });
      // Owner 09-09 (NAF World Cup V2.1 p.3): every legal added skill beyond a player's first costs +stackSurchargeSP.
      const legalPicks = rp.addedSkills.filter((_, i) => rp.access[i] !== undefined && rp.access[i] !== "illegal").length;
      const extra = Math.max(0, legalPicks - 1);
      if (extra > 0 && (cfg.stackSurchargeSP ?? 0) > 0) {
        total += extra * cfg.stackSurchargeSP;
        stackSurcharge += extra * cfg.stackSurchargeSP;
      }
    }

    if (cfg.maxSameSkillTeamwide != null)
      for (const [skill, count] of teamwide)
        if (count > cfg.maxSameSkillTeamwide)
          findings.push(
            err(
              "skill-points",
              `${count}× ${skill} across the team; the limit is ${cfg.maxSameSkillTeamwide}.`,
              { expected: `<= ${cfg.maxSameSkillTeamwide}`, actual: count },
            ),
          );

    // Skill stacking: at most N players may carry more than one added skill.
    if (resolved.maxStackedPlayers != null && stackedPlayers > resolved.maxStackedPlayers)
      findings.push(
        err(
          "skill-points",
          `${stackedPlayers} players have more than one added skill; skill stacking allows at most ${resolved.maxStackedPlayers}${where}.`,
          {
            expected: `<= ${resolved.maxStackedPlayers} stacked players`,
            actual: stackedPlayers,
            suggestion: `Reduce ${stackedPlayers - resolved.maxStackedPlayers} player(s) to a single added skill.`,
          },
        ),
      );

    if (resolved.skillPackages?.length) {
      // Gold+SP legality is owned by the skill-packages rule (joint disjunction).
    } else if (usesCountMode(resolved)) {
      // COUNT mode: separate primary/secondary limits (with optional Secondary Swap).
      if (
        !fitsSkillCounts(
          primaryCount,
          secondaryCount,
          resolved.maxPrimary,
          resolved.maxSecondary,
          resolved.secondarySwap,
          resolved.secondarySwapRatio,
          resolved.secondarySwapMax,
        )
      ) {
        const swapTerms = resolved.secondarySwap
          ? ` (secondary swap allowed: ${resolved.secondarySwapRatio} primary -> 1 secondary${
              resolved.secondarySwapMax != null ? `, max ${resolved.secondarySwapMax}` : ""
            })`
          : "";
        const allot =
          `${resolved.maxPrimary ?? "∞"} primary` +
          (resolved.maxSecondary != null ? ` + ${resolved.maxSecondary} secondary` : "") +
          swapTerms;
        findings.push(
          err(
            "skill-points",
            `Team took ${primaryCount} primary + ${secondaryCount} secondary skills; the allotment is ${allot}${where}.`,
            {
              expected: allot,
              actual: `${primaryCount} primary + ${secondaryCount} secondary`,
              suggestion: "Drop or re-allocate added skills to fit the primary/secondary allotment.",
            },
          ),
        );
      }
    } else if (total > resolved.skillPointBudget) {
      const over = total - resolved.skillPointBudget;
      const breakdown = stackSurcharge > 0 ? ` (${total - stackSurcharge} in skills + ${stackSurcharge} stacking surcharge)` : "";
      findings.push(
        err(
          "skill-points",
          `Team spends ${total} Skill Points${breakdown}; the budget is ${resolved.skillPointBudget}${where} (${over} over).`,
          {
            expected: `<= ${resolved.skillPointBudget}`,
            actual: stackSurcharge > 0 ? `${total}${breakdown}` : total,
            suggestion: `Drop ${over} SP worth of added skills, or ask the TO to raise the budget to ${total}.`,
          },
        ),
      );
    }
    return findings;
  },
};

/**
 * 6b. Skill packages (Spike!-style) — when a tier offers choose-one gold+SP packages,
 * the roster is legal if it fits ANY: gold spend ≤ pack.gold AND SP spend ≤ pack.SP
 * AND (per-player skills ≤ pack.maxPerPlayer). SP spend = added-skill SP + per-tier
 * star SP; when stars are paid in SP, their gold is excluded from the gold spend.
 * Unavailable stars for the team's tier are flagged here.
 */
export const skillPackages: Rule = {
  id: "skill-packages",
  check: ({ roster, pkg, players, data }) => {
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    const packs = cfg.skillPackages;
    if (!packs?.length) return [];
    const findings: Finding[] = [];

    let skillSP = 0;
    let primaryCount = 0;
    let secondaryCount = 0;
    // A package may price stacking (Destination Blood Bowl: two primaries on one player cost 3 SP): every legal
    // added skill beyond a player's first costs +stackSurchargeSP, as in the skill-points rule. 0/absent = none.
    const stackSurchargeSP = pkg.skillAllotment.stackSurchargeSP ?? 0;
    for (const rp of players) {
      let legal = 0;
      rp.addedSkills.forEach((s, i) => {
        const a = rp.access[i];
        if (a === undefined || a === "illegal") return; // only legal picks cost SP / count
        legal++;
        skillSP += costSP(s, a, pkg.skillAllotment);
        if (a === "primary") primaryCount++;
        else secondaryCount++;
      });
      if (stackSurchargeSP > 0) skillSP += Math.max(0, legal - 1) * stackSurchargeSP;
    }

    // Stars: per-tier SP cost + availability; optionally exclude their gold.
    const { starGold, starSP } = starCosts(players, pkg, data, cfg.tierNumber);
    const tierIdx = (cfg.tierNumber ?? 1) - 1;
    const spTable = pkg.starPlayers.spCostByTier;
    let hasStars = false;
    for (const rp of players) {
      if (!isStarName(data, rp.player.positionName)) continue;
      hasStars = true;
      if (!spTable) continue;
      const star = findStar(data, rp.player.positionName);
      const key = Object.keys(spTable).find(
        (k) => normName(k) === normName(star?.name ?? rp.player.positionName),
      );
      const cost = key ? spTable[key]?.[tierIdx] : undefined;
      if (cost == null)
        findings.push(
          err("skill-packages", `${rp.player.positionName} is not available in Tier ${cfg.tierNumber ?? "?"}.`, {
            playerRef: rp.player.number,
            suggestion: `Remove ${rp.player.positionName} — no Tier ${cfg.tierNumber ?? "?"} SP price.`,
          }),
        );
    }

    const spUsed = skillSP + starSP;
    // Gold budget is the team BUILD cost: skills are paid in SP (not gold), and stars
    // too when paidInSkillPoints — exclude both so they aren't double-counted.
    const skillsGold = roster.summary?.skillsCost ?? 0;
    const goldUsed =
      recomputeGold(roster) - skillsGold - (pkg.starPlayers.paidInSkillPoints ? starGold : 0);
    const maxOnAPlayer = players.reduce((m, rp) => Math.max(m, rp.addedSkills.length), 0);

    // Count-mode packs (maxSkills / maxSecondary) limit added skills by COUNT instead of SP.
    const fitsSkills = (p: SkillPackage): boolean => {
      if (!isCountPack(p)) return spUsed <= p.skillPointBudget;
      const { primarySlots, secondarySlots } = countPackSlots(p);
      return fitsSkillCounts(primaryCount, secondaryCount, primarySlots, secondarySlots, false);
    };
    // Star picks (a dataset pair is one pick) for a pack's own star cap.
    const starPicks = (): number => {
      const seen = new Set<string>();
      for (const rp of players) {
        if (!isStarName(data, rp.player.positionName)) continue;
        const s = findStar(data, rp.player.positionName);
        seen.add(normName(s?.pairedWith && !s.pairPrimary ? s.pairedWith : s?.name ?? rp.player.positionName));
      }
      return seen.size;
    };
    const fits = packs.some(
      (p) =>
        goldUsed <= p.gold &&
        fitsSkills(p) &&
        (p.maxPerPlayer == null || maxOnAPlayer <= p.maxPerPlayer) &&
        (p.maxSecondarySkills == null || secondaryCount <= p.maxSecondarySkills) &&
        (p.maxStars == null || starPicks() <= p.maxStars) &&
        (!hasStars || p.starPlayersAllowed !== false),
    );
    if (!fits) {
      const anyCount = packs.some(isCountPack);
      const anySP = packs.some((p) => !isCountPack(p));
      const opts = packs
        .map(
          (p) =>
            `${p.label ? `${p.label}: ` : ""}${isCountPack(p) ? countPackText(p) : `${p.skillPointBudget} SP`} @ ${fmtGold(p.gold)}` +
            (p.maxPerPlayer != null ? ` (≤${p.maxPerPlayer}/player)` : "") +
            (p.maxSecondarySkills != null ? ` (≤${p.maxSecondarySkills} secondary)` : "") +
            (p.maxStars != null ? ` (≤${p.maxStars} star${p.maxStars === 1 ? "" : "s"})` : "") +
            (p.starPlayersAllowed === false ? " (no stars)" : ""),
        )
        .join("; ");
      const used = [
        anySP ? `${spUsed} SP` : "",
        anyCount || packs.some((p) => p.maxSecondarySkills != null) ? `${primaryCount + secondaryCount} skill${primaryCount + secondaryCount === 1 ? "" : "s"} (${secondaryCount} secondary)` : "",
        fmtGold(goldUsed),
      ].filter(Boolean).join(" + ");
      const actual =
        used +
        (maxOnAPlayer > 1 ? `, ${maxOnAPlayer} skills on one player` : "") +
        (hasStars && anyCount ? ", a Star Player" : "");
      findings.push(
        err(
          "skill-packages",
          `Team uses ${used}${hasStars && anyCount ? " with a Star Player" : ""}${sourceLabel(cfg)}; no skill package fits.`,
          {
            expected: opts,
            actual,
            suggestion: `Fit a package: ${opts}.`,
          },
        ),
      );
    }
    return findings;
  },
};

/** Primary/secondary slots of a count-mode pack (a secondary slot may hold a primary). */
export function countPackSlots(p: SkillPackage): { primarySlots: number | null; secondarySlots: number | null } {
  const total = p.maxSkills ?? null;
  const sec = p.maxSecondary ?? null;
  if (total == null) return { primarySlots: null, secondarySlots: sec };
  if (sec == null) return { primarySlots: 0, secondarySlots: total }; // any mix up to the total
  const s = Math.min(sec, total);
  return { primarySlots: total - s, secondarySlots: s };
}

/** "6 skills (≤1 secondary)" / "4 skills (primary only)" for a count-mode pack. */
export function countPackText(p: SkillPackage): string {
  const total = p.maxSkills;
  const sec = p.maxSecondary;
  const head = total != null ? `${total} skill${total === 1 ? "" : "s"}` : "skills";
  const tail = sec == null ? "" : sec === 0 ? " (primary only)" : ` (≤${sec} secondary)`;
  return head + tail;
}

/** Legal added skills of a resolved player, with their access. */
const legalAdded = (rp: ResolvedPlayer): { skill: string; access: "primary" | "secondary" }[] =>
  rp.addedSkills.flatMap((skill, i) => {
    const a = rp.access[i];
    return a === "primary" || a === "secondary" ? [{ skill, access: a }] : [];
  });

/**
 * 6c. Elite caps — team total of elite added skills (`eliteMaxTotal`) and copies of any ONE
 * elite skill (`eliteMaxSameSkill`). Flat / per tier / per team rule; null = no cap.
 */
export const eliteSkillCaps: Rule = {
  id: "elite-skills",
  needsDatasetRoster: true,
  check: ({ players, pkg, roster }) => {
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    if (cfg.eliteMaxTotal == null && cfg.eliteMaxSameSkill == null) return [];
    const where = sourceLabel(cfg);
    const bySkill = new Map<string, { name: string; n: number }>();
    let total = 0;
    for (const rp of players)
      for (const { skill } of legalAdded(rp)) {
        if (!isElite(skill, pkg.skillAllotment)) continue;
        total++;
        const k = normName(skill);
        const e = bySkill.get(k) ?? { name: skill, n: 0 };
        e.n++;
        bySkill.set(k, e);
      }
    const findings: Finding[] = [];
    if (cfg.eliteMaxTotal != null && total > cfg.eliteMaxTotal)
      findings.push(
        err("elite-skills", `Team took ${total} elite skills; the limit is ${cfg.eliteMaxTotal}${where}.`, {
          expected: `<= ${cfg.eliteMaxTotal} elite skills`,
          actual: total,
          suggestion: `Swap ${total - cfg.eliteMaxTotal} elite skill(s) (${pkg.skillAllotment.eliteSkills.join(", ")}) for non-elite ones.`,
        }),
      );
    if (cfg.eliteMaxSameSkill != null)
      for (const { name, n } of bySkill.values())
        if (n > cfg.eliteMaxSameSkill)
          findings.push(
            err("elite-skills", `${n}× ${name} across the team; at most ${cfg.eliteMaxSameSkill} of any one elite skill${where}.`, {
              expected: `<= ${cfg.eliteMaxSameSkill}× ${name}`,
              actual: n,
              suggestion: `Drop ${n - cfg.eliteMaxSameSkill}× ${name}.`,
            }),
          );
    return findings;
  },
};

/**
 * 6d. Stacked-player caps — a player with MORE than one added skill may carry at most
 * `stackedPlayer.maxSkills` added skills, `maxSecondary` of them secondary, `maxElite` elite.
 */
export const stackedPlayerCaps: Rule = {
  id: "stacked-player",
  needsDatasetRoster: true,
  check: ({ players, pkg, roster }) => {
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    const { maxSkills, maxSecondary, maxElite } = cfg.stackedPlayer;
    if (maxSkills == null && maxSecondary == null && maxElite == null) return [];
    const where = sourceLabel(cfg);
    const findings: Finding[] = [];
    for (const rp of players) {
      if (!rp.position || rp.addedSkills.length <= 1) continue;
      const label = `#${rp.player.number} ${rp.position.name}`;
      const legal = legalAdded(rp);
      const sec = legal.filter((l) => l.access === "secondary");
      const elite = legal.filter((l) => isElite(l.skill, pkg.skillAllotment));
      if (maxSkills != null && rp.addedSkills.length > maxSkills)
        findings.push(
          err("stacked-player", `${label} has ${rp.addedSkills.length} added skills; a stacked player may have at most ${maxSkills}${where}.`, {
            playerRef: rp.player.number,
            expected: `<= ${maxSkills}`,
            actual: rp.addedSkills.length,
            suggestion: `Drop ${rp.addedSkills.length - maxSkills} skill(s) from ${label}.`,
          }),
        );
      if (maxSecondary != null && sec.length > maxSecondary)
        findings.push(
          err(
            "stacked-player",
            maxSecondary === 0
              ? `${label} is stacked with a secondary skill (${sec.map((l) => l.skill).join(", ")}); stacked players may only take primary skills${where}.`
              : `${label} is stacked with ${sec.length} secondary skills; at most ${maxSecondary} on a stacked player${where}.`,
            {
              playerRef: rp.player.number,
              expected: `<= ${maxSecondary} secondary`,
              actual: sec.length,
              suggestion: `Replace ${sec.length - maxSecondary} secondary skill(s) on ${label} with primary ones, or un-stack the player.`,
            },
          ),
        );
      if (maxElite != null && elite.length > maxElite)
        findings.push(
          err("stacked-player", `${label} is stacked with ${elite.length} elite skills; at most ${maxElite} on a stacked player${where}.`, {
            playerRef: rp.player.number,
            expected: `<= ${maxElite} elite`,
            actual: elite.length,
            suggestion: `Replace ${elite.length - maxElite} elite skill(s) on ${label}.`,
          }),
        );
    }
    return findings;
  },
};

/**
 * 6e. Characteristic increases — detected by diffing printed stats vs the dataset position.
 * Only enforced when `statIncreases` is configured at some level.
 */
export const statIncreasesRule: Rule = {
  id: "stat-increases",
  needsDatasetRoster: true,
  check: ({ players, pkg, roster, data }) => {
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    // `special.statIncreasesAllowed` ("Allow stat increases" in the Tournament Creator) is the package's master switch: unless it
    // is true, ANY increase is illegal, whatever `statIncreases` knobs say (the builder applies chosenStatIncreases
    // regardless of package, so this must fail closed). With it on and no knob anywhere, increases stay unchecked.
    const allowed = pkg.special.statIncreasesAllowed === true;
    const si = allowed ? cfg.statIncreases : undefined;
    const canonRace = (name: string): string => findRoster(data, name)?.name ?? name;
    const granular = allowed ? canonicalizeStatRuleRaces(cleanStatIncreaseRules(pkg.special.statIncreaseRules), canonRace) : null;
    if (!si && allowed && !granular) return [];
    let teamTotal = 0;
    const where = sourceLabel(cfg);
    const findings: Finding[] = [];
    for (const rp of players) {
      if (!rp.position || isStarName(data, rp.player.positionName)) continue;
      // A characteristic more than MAX_STAT_STEPS (or non-finitely) above its position is never
      // legal — error instead of silently pricing the bounded steps.
      const over = statIncreasesOverLimit(rp.player, rp.position);
      if (over.length) {
        findings.push(
          err("stat-increases", `#${rp.player.number} ${rp.position.name}: ${over.join(", ")} is more than ${MAX_STAT_STEPS} steps above the position — over the characteristic limit.`, {
            playerRef: rp.player.number,
            suggestion: `Restore ${over.join(", ")} on #${rp.player.number} to a legal value.`,
          }),
        );
        continue;
      }
      const incs = statIncreasesOf(rp.player, rp.position);
      if (incs.length === 0) continue;
      const label = `#${rp.player.number} ${rp.position.name}`;
      const shown = incs.map((k) => `+${k}`).join(", ");
      const who = { race: canonRace(roster.rosterName), position: rp.position.name, aliases: rp.position.aliases, keywords: rp.position.keywords, type: rp.position.type };
      const whole = allowed ? playerStatRuleBlock(granular, who) : "";
      if (whole) {
        findings.push(err("stat-increases", `${label} has a characteristic increase (${shown}). ${whole}`, { playerRef: rp.player.number, suggestion: `Remove the increase from ${label}.` }));
        continue;
      }
      const blocked = allowed ? [...new Set(incs.filter((k) => statRuleBlock(granular, who, k)))] : [];
      if (blocked.length) {
        findings.push(err("stat-increases", `${label}: ${blocked.map((k) => `+${k}`).join(", ")} is not allowed. ${statRuleBlock(granular, who, blocked[0]!)}`, {
          playerRef: rp.player.number, suggestion: `Remove ${blocked.map((k) => `+${k}`).join(", ")} from ${label}.`,
        }));
        continue;
      }
      teamTotal += incs.length;
      if (!si && allowed) continue; // allowed with no per-race knob: only the granular rules above apply
      if (!si) {
        findings.push(
          err("stat-increases", `${label} has a characteristic increase (${shown}); this ruleset doesn't allow stat increases.`, {
            playerRef: rp.player.number,
            suggestion: `Remove the increase from ${label}.`,
          }),
        );
        continue;
      }
      if (si.allowed.length === 0) {
        findings.push(
          err("stat-increases", `${label} has a characteristic increase (${shown}); stat increases are not allowed${where}.`, {
            playerRef: rp.player.number,
            suggestion: `Remove the increase from ${label}.`,
          }),
        );
        continue;
      }
      const allowedText = si.allowed.map((k) => `+${k}`);
      const bad = [...new Set(incs.filter((k) => !si.allowed.includes(k)))];
      if (bad.length)
        findings.push(
          err("stat-increases", `${label}: ${bad.map((k) => `+${k}`).join(", ")} is not allowed${where} (allowed: ${allowedText.join(", ")}).`, {
            playerRef: rp.player.number,
            expected: allowedText.join(" / "),
            actual: shown,
            suggestion: `Use ${allowedText.join(" or ")} instead.`,
          }),
        );
      if (si.maxPerPlayer != null && incs.length > si.maxPerPlayer)
        findings.push(
          err("stat-increases", `${label} has ${incs.length} characteristic increases (${shown}); the limit is ${si.maxPerPlayer} per player${where}.`, {
            playerRef: rp.player.number,
            expected: `<= ${si.maxPerPlayer}`,
            actual: incs.length,
            suggestion: `Keep at most ${si.maxPerPlayer} increase(s) on ${label}.`,
          }),
        );
      if (si.exclusiveWithSkills && rp.addedSkills.length > 0)
        findings.push(
          err("stat-increases", `${label} has a characteristic increase (${shown}) and added skills (${rp.addedSkills.join(", ")}); a player with a stat increase may not take skills${where}.`, {
            playerRef: rp.player.number,
            suggestion: `Remove either the stat increase or the added skill(s) from ${label}.`,
          }),
        );
    }
    const cap = granular?.maxPerTeam;
    if (allowed && cap != null && teamTotal > cap)
      findings.push(err("stat-increases", `The team has ${teamTotal} stat increases. ${teamCapBlock(granular, cap)}`, { suggestion: `Remove ${teamTotal - cap} stat increase${teamTotal - cap === 1 ? "" : "s"}.` }));
    return findings;
  },
};

/**
 * 8b. Star packs — every hired star must sit in a pack open to the team; per-pack pick caps.
 * Only enforced when the package defines `starPacks`. Fees are priced in starPackPicks.
 */
export const starPacksRule: Rule = {
  id: "star-packs",
  check: ({ players, pkg, roster, data }) => {
    if (!pkg.starPacks?.length) return [];
    const { picks } = starPackPicks(players, pkg, data);
    if (!picks.length) return [];
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    if (!cfg.starPlayersAllowed) return []; // star-players already rejects every star
    const where = sourceLabel(cfg);
    const open = pkg.starPacks.filter((p) => cfg.starPacksAllowed == null || cfg.starPacksAllowed.includes(p.id));
    const openText = open.map((p) => p.label ?? p.id).join(", ") || "none";
    const findings: Finding[] = [];
    for (const pick of picks) {
      const who = pick.names.join(" & ");
      if (!pick.pack)
        findings.push(
          err("star-packs", `${who} is not in any star pack for "${pkg.name}".`, {
            playerRef: pick.playerRefs[0],
            suggestion: `Remove ${who}.`,
          }),
        );
      else if (!open.includes(pick.pack))
        findings.push(
          err("star-packs", `${who} is in the ${pick.pack.label ?? pick.pack.id} pack, which is not open to this team${where} (open: ${openText}).`, {
            playerRef: pick.playerRefs[0],
            expected: openText,
            actual: pick.pack.label ?? pick.pack.id,
            suggestion: `Remove ${who}, or pick a star from: ${openText}.`,
          }),
        );
    }
    for (const pack of pkg.starPacks) {
      const n = picks.filter((p) => p.pack === pack).length;
      if (pack.max != null && n > pack.max)
        findings.push(
          err("star-packs", `${n} picks from the ${pack.label ?? pack.id} pack; the limit is ${pack.max}.`, {
            expected: `<= ${pack.max}`,
            actual: n,
            suggestion: `Remove ${n - pack.max} ${pack.label ?? pack.id} star(s).`,
          }),
        );
    }
    return findings;
  },
};

/** 7. Cost reconciliation — recompute gold independently; mismatches are warnings. */
export const costReconciliation: Rule = {
  id: "cost-reconciliation",
  check: ({ roster }) => {
    if (!roster.summary) return [];
    const gold = recomputeGold(roster);
    return gold !== roster.summary.total
      ? [
          warn(
            "cost-reconciliation",
            `The sheet says the team costs ${fmtGold(roster.summary.total)}, but the line items add to ${fmtGold(gold)}.`,
            { expected: fmtGold(gold), actual: fmtGold(roster.summary.total) },
          ),
        ]
      : [];
  },
};

/**
 * 8. Star players — generic star detection (all teams). Honors tier star access +
 * per-tier banned stars when tiers are set, else the package-level starPlayers.
 */
export const starPlayers: Rule = {
  id: "star-players",
  check: ({ players, pkg, data, roster }) => {
    const stars = players.filter((rp) => isStarName(data, rp.player.positionName));
    const findings: Finding[] = [];
    if (stars.length === 0) return findings;

    const resolved = resolveTeamConfig(pkg, roster.rosterName);
    const allowed = resolved.starPlayersAllowed;
    const where = sourceLabel(resolved);

    if (!allowed) {
      findings.push(
        err("star-players", `Star Players are not allowed${where} in "${pkg.name}".`, {
          actual: stars.map((s) => s.player.positionName).join(", "),
          suggestion: "Remove the Star Player(s).",
        }),
      );
    }
    // One of each Star Player per team (dataset and custom stars alike).
    const copies = new Map<string, number>();
    for (const s of stars) {
      const k = normName(findStar(data, s.player.positionName)?.name ?? s.player.positionName);
      copies.set(k, (copies.get(k) ?? 0) + 1);
    }
    for (const [k, n] of copies)
      if (n > 1) {
        const name = stars.find((s) => normName(findStar(data, s.player.positionName)?.name ?? s.player.positionName) === k)!.player.positionName;
        findings.push(err("star-players", `${name} is hired ${n} times; a team may hire each Star Player once.`, { expected: "1", actual: n, suggestion: `Remove ${n - 1} copy of ${name}.` }));
      }
    if (!allowed) {
      /* reported above */
    } else if (pkg.starPlayers.maxCount != null) {
      // With star packs a dataset pair (Grak & Crumbleberry) is ONE pick; otherwise count players.
      const n = pkg.starPacks?.length ? starPackPicks(players, pkg, data).picks.length : stars.length;
      if (n > pkg.starPlayers.maxCount)
        findings.push(
          err("star-players", `${n} Star Players; the limit is ${pkg.starPlayers.maxCount}.`, {
            expected: `<= ${pkg.starPlayers.maxCount}`,
            actual: n,
            ...(pkg.starPacks?.length
              ? { suggestion: `Remove ${n - pkg.starPlayers.maxCount} Star Player pick(s) (a pair counts as one).` }
              : {}),
          }),
        );
    }

    const banned = new Set(resolved.bannedStars.map(normName));
    for (const s of stars)
      if (banned.has(normName(s.player.positionName)))
        findings.push(
          err("star-players", `${s.player.positionName} is banned in "${pkg.name}".`, {
            playerRef: s.player.number,
            suggestion: `Remove ${s.player.positionName}.`,
          }),
        );

    // Eligibility: BB2025 gates each star to teams sharing its "plays for" special
    // rules (baked into star.teams). Only meaningful when stars are allowed; a
    // banned star is already reported above; stars with no eligibility data pass.
    if (allowed) {
      const teamName = findRoster(data, roster.rosterName)?.name ?? roster.rosterName;
      for (const s of stars) {
        if (banned.has(normName(s.player.positionName))) continue;
        const star = findStar(data, s.player.positionName);
        if (star && !starEligibleForTeam(star, teamName))
          findings.push(
            err("star-players", `${s.player.positionName} cannot play for ${teamName}.`, {
              playerRef: s.player.number,
              expected: `a team from: ${star.teams.join(", ")}`,
              actual: teamName,
              suggestion: `Remove ${s.player.positionName} — not eligible for ${teamName}.`,
            }),
          );
      }
    }

    if (allowed && pkg.starPlayers.maxCombinedCost != null) {
      const combined = stars.reduce((a, s) => a + s.player.cost, 0);
      if (combined > pkg.starPlayers.maxCombinedCost)
        findings.push(
          err(
            "star-players",
            `Star Players cost ${fmtGold(combined)} combined; the limit is ${fmtGold(pkg.starPlayers.maxCombinedCost)}.`,
            { expected: `<= ${fmtGold(pkg.starPlayers.maxCombinedCost)}`, actual: fmtGold(combined) },
          ),
        );
    }
    return findings;
  },
};

/**
 * 8c. Star added skills — BB2025 stars take no added skills. A star's printed skills are diffed
 * against its dataset skill list (`DatasetStar.skills`); a source-supplied `addedSkills` list on a
 * star also counts. Unconditional (owner ruling 10-27): no package may let a star take added skills.
 * Stars with no dataset skill list are only caught via explicit `addedSkills`.
 */
export const starAddedSkills: Rule = {
  id: "star-skills",
  check: ({ players, pkg, data }) => {
    // FAIL-SAFE: only a printed entry that canonicalises to a known, selectable (non-trait) dataset
    // skill absent from the star's own list is an added skill. Anything unmatched (formatting, labels,
    // traits/special rules, comma-split fragments) produces no finding rather than a false rejection.
    const selectable = new Map<string, string>();
    for (const [name, meta] of Object.entries(data.skills)) if (!meta.trait) selectable.set(canonSkill(name), name);
    const findings: Finding[] = [];
    for (const rp of players) {
      if (!isStarName(data, rp.player.positionName)) continue;
      const star = findStar(data, rp.player.positionName);
      const base = new Set((star?.skills ?? []).map(canonSkill));
      const extra = new Map<string, string>();
      const consider = (s: string) => {
        const key = canonSkill(s);
        const name = selectable.get(key);
        if (name && !base.has(key)) extra.set(key, name);
      };
      if (star?.skills) rp.player.skills.forEach(consider);
      // A source's explicit addedSkills list is authoritative: every non-empty entry is a finding
      // (known or unknown, trait or not) - the fail-safe applies to printed skills only.
      for (const s of rp.player.addedSkills ?? []) {
        const name = decodeEntities(s).trim();
        if (!name) continue;
        const key = canonSkill(name) || name;
        if (!extra.has(key)) extra.set(key, selectable.get(key) ?? name);
      }
      if (!extra.size) continue;
      const list = [...extra.values()];
      findings.push(
        err("star-skills", `${rp.player.positionName} has added skill${list.length === 1 ? "" : "s"} (${list.join(", ")}); Star Players take no added skills.`, {
          playerRef: rp.player.number,
          expected: star?.skills ? star.skills.join(", ") : "no added skills",
          actual: rp.player.skills.join(", "),
          suggestion: `Remove ${list.join(", ")} from ${rp.player.positionName}.`,
        }),
      );
    }
    return findings;
  },
};

/**
 * 9. Inducements — types allowed + caps. Dataset caps use the BB2025 rulebook
 * maxima; a reduced-cap special rule (e.g. Bribery and Corruption → 6 Bribes)
 * raises the cap when the team carries that rule.
 */
export const inducements: Rule = {
  id: "inducements",
  check: (ctx) => {
    const { roster, pkg, data } = ctx;
    if (usesSevensInducements(pkg)) return sevensInducements(ctx);
    const findings: Finding[] = [];
    const teamRules = new Set(roster.specialRules.map(normName));
    const totals = new Map<string, { name: string; count: number; cap: number | null }>();
    for (const ind of roster.inducements) {
      const id = ind.id ?? inducementIdForName(data, ind.name) ?? normName(ind.name).replace(/ /g, "_");
      const meta = data.inducements[id];
      const allowed =
        pkg.inducements.allowed.includes("*") || pkg.inducements.allowed.includes(id);
      if (!allowed)
        findings.push(
          err("inducements", `Inducement "${ind.name}" is not allowed in "${pkg.name}".`, {
            suggestion: "Remove it.",
          }),
        );
      // Roster restriction (package knob): only the listed rosters may buy this inducement.
      const onlyFor = Object.entries(pkg.inducements.rosterOnly ?? {}).find(([k]) => k === id)?.[1];
      if (onlyFor && !onlyFor.some((r) => normName(r) === normName(roster.rosterName)))
        findings.push(
          err("inducements", `${meta?.name ?? ind.name} is only available to ${onlyFor.join(" / ")} teams in "${pkg.name}".`, {
            expected: onlyFor.join(", "),
            actual: roster.rosterName,
            suggestion: "Remove it.",
          }),
        );
      // Reduced cap applies only when the team has the unlocking special rule.
      const hasReduced = inducementReducedFor(meta, roster.specialRules, roster.rosterName);
      if (meta?.requiresSpecialRule && !teamRules.has(normName(meta.requiresSpecialRule)))
        findings.push(
          err("inducements", `${meta.name} is only available to teams with the ${meta.requiresSpecialRule} special rule.`, {
            suggestion: "Remove it.",
          }),
        );
      const datasetCap = hasReduced ? meta?.reducedMax ?? meta?.max : meta?.max;
      const cap = pkg.inducements.caps[id] ?? datasetCap ?? null;
      const prior = totals.get(id);
      if (prior) prior.count += ind.count ?? 1;
      else totals.set(id, { name: ind.name, count: ind.count ?? 1, cap });
    }
    // Caps apply to the TOTAL per inducement, so the same item split over several rows can't dodge them.
    for (const { name, count, cap } of totals.values())
      if (cap != null && count > cap)
        findings.push(
          err("inducements", `${count}× ${name} exceeds the limit of ${cap}.`, {
            expected: `<= ${cap}`,
            actual: count,
          }),
        );
    return findings;
  },
};

/**
 * 9b. Inducements from the Sevens list (`inducements.set: "sevens"`, SJ22 #list-of-inducements): only the Sevens items
 * (Desperate Measures included), at the Sevens caps unless the package caps them; no Star Players or Mercenaries. A sheet
 * price that differs from the Sevens price is a warning: the gold is recomputed at the Sevens price either way.
 */
function sevensInducements({ roster, pkg, data, datasetRoster, sheetRoster }: Parameters<Rule["check"]>[0]): Finding[] {
  const findings: Finding[] = [];
  const catalog = inducementCatalog(pkg, data);
  const teamRules = new Set(roster.specialRules.map(normName));
  const limitText = pkg.format === "sevens" ? "the Sevens limit" : "the limit";
  const totals = new Map<string, { name: string; count: number; cap: number | null }>();
  roster.inducements.forEach((ind, index) => {
    const id = ind.id && catalog[ind.id] ? ind.id : inducementIdInCatalog(catalog, ind.name);
    const meta = id ? catalog[id] : undefined;
    if (!id || !meta) {
      const coreId = ind.id ?? inducementIdForName(data, ind.name);
      const what =
        isStarName(data, ind.name) || /\bstar\b/i.test(ind.name)
          ? "Star Players aren't available in Sevens."
          : coreId === "mercenaries" || /mercenar/i.test(ind.name)
            ? "Mercenaries aren't available in Sevens."
            : `${(coreId && data.inducements[coreId]?.name) || ind.name} isn't a Sevens inducement.`;
      findings.push(err("inducements", what, { suggestion: "Remove it." }));
      return;
    }
    if (!pkg.inducements.allowed.includes("*") && !pkg.inducements.allowed.includes(id))
      findings.push(err("inducements", `${meta.name} is not allowed in "${pkg.name}".`, { suggestion: "Remove it." }));
    const onlyFor = pkg.inducements.rosterOnly?.[id];
    if (onlyFor && !onlyFor.some((r) => normName(r) === normName(roster.rosterName)))
      findings.push(
        err("inducements", `${meta.name} is only available to ${onlyFor.join(" / ")} teams in "${pkg.name}".`, {
          expected: onlyFor.join(", "),
          actual: roster.rosterName,
          suggestion: "Remove it.",
        }),
      );
    if (meta.requiresSpecialRule && !teamRules.has(normName(meta.requiresSpecialRule)))
      findings.push(err("inducements", `${meta.name} is only available to teams with the ${meta.requiresSpecialRule} special rule.`, { suggestion: "Remove it." }));
    if (meta.requiresApothecary && datasetRoster && !datasetRoster.apothecaryAllowed)
      findings.push(err("inducements", `${meta.name} is only available to teams that can hire an Apothecary.`, { suggestion: "Remove it." }));
    const reduced = inducementReducedFor(meta, roster.specialRules, roster.rosterName);
    const cap = pkg.inducements.caps[id] ?? (reduced ? meta.reducedMax ?? meta.max : meta.max) ?? null;
    const prior = totals.get(id);
    if (prior) prior.count += ind.count ?? 1;
    else totals.set(id, { name: meta.name, count: ind.count ?? 1, cap });
    const sheetCost = sheetRoster?.inducements[index]?.cost;
    const each = ind.cost;
    if (sheetCost != null && each != null && sheetCost !== each)
      findings.push(
        warn("inducements", `${meta.name} costs ${fmtGold(each)} each in ${pkg.format === "sevens" ? "Sevens" : "this ruleset"}; the sheet shows ${fmtGold(sheetCost)}.`, {
          expected: fmtGold(each),
          actual: fmtGold(sheetCost),
        }),
      );
  });
  // Caps apply to the TOTAL per inducement, so the same item split over several rows can't dodge them.
  for (const { name, count, cap } of totals.values())
    if (cap != null && count > cap)
      findings.push(
        err("inducements", `${count}× ${name}; ${limitText} is ${cap}.`, {
          expected: `<= ${cap}`,
          actual: count,
          suggestion: `Remove ${count - cap}× ${name}.`,
        }),
      );
  return findings;
}

/** 10. Sideline — staff within caps; re-roll count also vs the roster's own max. With `staffPrices` the staff gold is
 *  recomputed from the counts; a sheet total that differs is a warning naming the priced lines. */
export const sideline: Rule = {
  id: "sideline",
  check: ({ roster, pkg, datasetRoster, sheetRoster }) => {
    const findings: Finding[] = [];
    const prices = effectiveStaffPrices(pkg);
    const sheetStaff = sheetRoster?.summary?.sidelineCost;
    // A package that prices staff starts every team at dedicatedFansStart (Sevens Free Create 1, Matched Play 0): fewer
    // isn't a legal roster.
    const minFans = prices ? (pkg.sideline.dedicatedFansStart ?? 1) : 0;
    if (roster.sideline.dedicatedFans < minFans)
      findings.push(
        err("sideline", `${roster.sideline.dedicatedFans} dedicated fans; this ruleset starts every team on ${minFans} (free).`, {
          expected: `>= ${minFans}`,
          actual: roster.sideline.dedicatedFans,
          suggestion: `Set Dedicated Fans to at least ${minFans}.`,
        }),
      );
    if (prices && sheetStaff != null) {
      const priced = priceStaff(roster.sideline, prices, datasetRoster?.reRollCost ?? 0, pkg.sideline.dedicatedFansStart ?? 1);
      if (priced.total !== sheetStaff) {
        const lines = priced.lines.filter((l) => l.gold > 0).map((l) => `${l.paid} ${l.label} × ${fmtGold(l.each)}`);
        const where = pkg.format === "sevens" ? "Sevens prices" : "this ruleset's prices";
        findings.push(
          warn("sideline", `Sideline staff costs ${fmtGold(priced.total)} at ${where}${lines.length ? ` (${lines.join(", ")})` : ""}; the sheet shows ${fmtGold(sheetStaff)}.`, {
            expected: fmtGold(priced.total),
            actual: fmtGold(sheetStaff),
            suggestion: `The team is checked at ${fmtGold(priced.total)}.`,
          }),
        );
      }
    }
    const s = roster.sideline;
    const caps: [string, number, number | null][] = [
      ["re-rolls", s.reRolls, pkg.sideline.maxReRolls],
      ["apothecary", s.apothecary ? 1 : 0, pkg.sideline.maxApothecary],
      ["cheerleaders", s.cheerleaders, pkg.sideline.maxCheerleaders],
      ["assistant coaches", s.assistantCoaches, pkg.sideline.maxAssistantCoaches],
      ["dedicated fans", s.dedicatedFans, pkg.sideline.maxDedicatedFans],
    ];
    for (const [what, actual, cap] of caps)
      if (cap != null && actual > cap)
        findings.push(
          err("sideline", `${actual} ${what} exceeds the tournament limit of ${cap}.`, {
            expected: `<= ${cap}`,
            actual,
          }),
        );
    if (datasetRoster && s.reRolls > datasetRoster.maxReRolls)
      findings.push(
        err(
          "sideline",
          `${s.reRolls} re-rolls exceeds the ${datasetRoster.name} roster maximum of ${datasetRoster.maxReRolls}.`,
        ),
      );
    if (datasetRoster && s.apothecary && !datasetRoster.apothecaryAllowed)
      findings.push(err("sideline", `The ${datasetRoster.name} roster cannot take an Apothecary.`));
    return findings;
  },
};

/** 11. Special rules — banned skills; Insignificant-trait constraint. */
export const specialRules: Rule = {
  id: "special-rules",
  check: ({ players, pkg }) => {
    const findings: Finding[] = [];
    const banned = new Set(pkg.special.bannedSkills.map(normName));
    for (const rp of players)
      for (const skill of rp.addedSkills)
        if (banned.has(normName(skill)))
          findings.push(
            err("special-rules", `#${rp.player.number}: ${skill} is banned in "${pkg.name}".`, {
              playerRef: rp.player.number,
              suggestion: `Replace ${skill}.`,
            }),
          );
    if (pkg.special.insignificantTraitConstraint) {
      const insig = players.filter((rp) =>
        rp.player.skills.some((s) => normName(s) === "insignificant"),
      ).length;
      const rest = players.length - insig;
      if (insig > rest)
        findings.push(
          err(
            "special-rules",
            `${insig} players with the Insignificant trait vs ${rest} without — Insignificant players may not outnumber the rest.`,
          ),
        );
    }
    return findings;
  },
};

// ---- shared helpers ----

/** Return Star Player gold value and per-tier SP charge; missing tier prices cost 0 SP. */
export function starCosts(
  players: readonly Pick<ResolvedPlayer, "player">[],
  pkg: TournamentPackage,
  data: Dataset,
  tierNumber?: number,
): { starGold: number; starSP: number } {
  const tierIdx = (tierNumber ?? 1) - 1;
  const spTable = pkg.starPlayers.spCostByTier;
  let starGold = 0;
  let starSP = 0;
  for (const rp of players) {
    if (!isStarName(data, rp.player.positionName)) continue;
    starGold += rp.player.cost;
    if (!spTable) continue;
    const star = findStar(data, rp.player.positionName);
    const key = Object.keys(spTable).find(
      (k) => normName(k) === normName(star?.name ?? rp.player.positionName),
    );
    const cost = key ? spTable[key]?.[tierIdx] : undefined;
    if (cost != null) starSP += cost;
  }
  return { starGold, starSP };
}

/** Gold the generic extra knobs add on top of added skills: stat increases + star-pack fees. */
export function extrasGold(
  players: readonly ResolvedPlayer[],
  pkg: TournamentPackage,
  data: Dataset,
  cfg: ReturnType<typeof resolveTeamConfig>,
): number {
  return statIncreasesGold(players, cfg.statIncreases) + (pkg.starPacks?.length ? starPackPicks(players, pkg, data).feesGold : 0);
}

/** Recompute team gold from line items. */
export function recomputeGold(roster: {
  players: { cost: number }[];
  inducements: { cost?: number; count?: number }[];
  summary?: { skillsCost: number; sidelineCost: number; inducementCost?: number } | undefined;
}): number {
  const players = roster.players.reduce((a, p) => a + p.cost, 0);
  // Prefer the array's own costs; many sources (bbtc.pl PDFs) list inducement NAMES
  // without per-item costs, so fall back to the sheet's inducement total.
  const inducementArr = roster.inducements.reduce((a, i) => a + (i.cost ?? 0) * (i.count ?? 1), 0);
  const inducements = inducementArr > 0 ? inducementArr : roster.summary?.inducementCost ?? 0;
  const skills = roster.summary?.skillsCost ?? 0;
  const sidelineGold = roster.summary?.sidelineCost ?? 0;
  return players + skills + inducements + sidelineGold;
}

export const fmtGold = (n: number): string => `${Math.round(n / 1000)}k`;

/**
 * Custom-mode gate (owner SR-258) — a team composed in CUSTOM mode bypassed legality + budget
 * (free skills AND free characteristic edits). Its output is marked `roster.custom` (teamComposer);
 * gated tournament validation must REJECT it. The team-builder's own custom PREVIEW collapses this
 * (like every finding) to a warning, so the experimental flow is unaffected — the error only bites
 * when a custom-built team is validated against a real package.
 */
export const customTeamGate: Rule = {
  id: "custom-team",
  check: ({ roster }) =>
    roster.custom
      ? [
          err("custom-team", "Team was built in custom mode (free skills/characteristics) — not tournament-legal.", {
            expected: "a legally-composed team",
            actual: "custom-mode team",
            suggestion: "Rebuild without custom mode to enter a tournament.",
          }),
        ]
      : [],
};

/**
 * BB2025 Team Captain (https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain): a roster with the
 * Team Captain special rule may nominate ONE player, never a Big Guy or a Star, who gains Pro for free.
 * addedSkills() treats the trait and one Pro as free grants, so this rule is what stops a forged nomination
 * (wrong roster, Big Guy, Star, a second captain, a captain without its Pro) from riding free skills.
 */
export const teamCaptainRule: Rule = {
  id: "team-captain",
  check: ({ roster, players, datasetRoster, data }) => {
    const isCaptain = (rp: ResolvedPlayer) => rp.player.skills.some((s) => normName(s) === normName(TEAM_CAPTAIN));
    const captains = players.filter(isCaptain);
    if (captains.length === 0) return [];
    const findings: Finding[] = [];
    const eligible = rosterHasTeamCaptain(datasetRoster?.specialRules ?? roster.specialRules);
    if (!eligible)
      findings.push(err("team-captain", `${roster.rosterName} teams cannot nominate a Team Captain.`, {
        suggestion: "Remove the Team Captain nomination.",
      }));
    if (captains.length > 1)
      findings.push(err("team-captain", `${captains.length} players are nominated as Team Captain; only one may be.`, {
        expected: "1",
        actual: String(captains.length),
        suggestion: "Keep one Team Captain.",
      }));
    for (const rp of captains) {
      const label = `#${rp.player.number} ${rp.player.positionName}`;
      if (rp.position?.type === "bigguy")
        findings.push(err("team-captain", `${label} is a Big Guy and cannot be Team Captain.`, { playerRef: rp.player.number }));
      if (isStarName(data, rp.player.positionName))
        findings.push(err("team-captain", `${label} is a Star Player and cannot be Team Captain.`, { playerRef: rp.player.number }));
      if (!rp.player.skills.some((s) => normName(s) === normName(TEAM_CAPTAIN_FREE_SKILL)))
        findings.push(err("team-captain", `${label} is Team Captain but is missing the free Pro skill.`, { playerRef: rp.player.number }));
    }
    return findings;
  },
};

/** The M1 registry, in plan order. */
/**
 * 8d. Custom stars (package/customStars.ts) - a hired custom star is the organiser's star: its price, characteristics and
 * printed skills must be the package's. Coaches never edit a star; a sheet that differs is refused (an added skill is
 * also caught by star-skills).
 */
export const customStarTerms: Rule = {
  id: "custom-stars",
  check: ({ players, pkg }) => {
    const findings: Finding[] = [];
    if (!customStarsOf(pkg).length) return findings;
    for (const rp of players) {
      const star = findCustomStar(pkg, rp.player.positionName);
      if (!star) continue;
      const who = `#${rp.player.number} ${star.name}`;
      if (rp.player.cost !== star.cost)
        findings.push(err("custom-stars", `${who} costs ${fmtGold(rp.player.cost)} on the sheet; this ruleset prices the star at ${fmtGold(star.cost)}.`, {
          playerRef: rp.player.number, expected: fmtGold(star.cost), actual: fmtGold(rp.player.cost), suggestion: `Hire ${star.name} again from the Stars list.`,
        }));
      const want = customStarStats(star);
      // Printed skills and traits exactly as the package defines them (parameters included: Loner (4+) is not Loner (2+)).
      const key = (s: string): string => decodeEntities(s).normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
      const have = rp.player.skills.map(key).sort();
      const defined = star.skills.map(key).sort();
      const missing = star.skills.filter((s) => !have.includes(key(s)));
      const extra = rp.player.skills.filter((s) => !defined.includes(key(s)));
      if (missing.length || extra.length || have.length !== defined.length)
        findings.push(err("custom-stars", `${who} does not carry the ruleset's skills${missing.length ? ` (missing ${missing.join(", ")})` : ""}${extra.length ? ` (extra ${extra.join(", ")})` : ""}; Star Players can't be changed.`, {
          playerRef: rp.player.number, expected: star.skills.join(", "), actual: rp.player.skills.join(", "),
        }));
      const diff = (["MA", "ST", "AG", "PA", "AV"] as const).filter((k) => String(rp.player[k]) !== String(want[k]));
      if (diff.length)
        findings.push(err("custom-stars", `${who} has changed characteristics (${diff.join(", ")}); Star Players can't be changed.`, {
          playerRef: rp.player.number, expected: diff.map((k) => `${k} ${want[k]}`).join(", "), actual: diff.map((k) => `${k} ${rp.player[k]}`).join(", "),
        }));
    }
    return findings;
  },
};

export const ALL_RULES: Rule[] = [
  customTeamGate,
  rosterEligibility,
  squadSize,
  positionalLimits,
  goldBudget,
  skillAccessRule,
  skillPoints,
  skillPackages,
  eliteSkillCaps,
  stackedPlayerCaps,
  statIncreasesRule,
  costReconciliation,
  starPlayers,
  starAddedSkills,
  customStarTerms,
  starPacksRule,
  inducements,
  sideline,
  specialRules,
  teamCaptainRule,
  sevensVeteran,
];
