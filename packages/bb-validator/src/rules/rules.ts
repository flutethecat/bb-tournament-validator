/**
 * The eleven M1 rules from the approved plan, one exported Rule each.
 * All pure functions over the precomputed RuleContext.
 */

import { costSP } from "../cost/costSP";
import { findRoster, findSkill, findStar, isStarName, normName, starEligibleForTeam } from "../dataset/lookup";
import type { Finding } from "../model/findings";
import { eligibleTeamNames, fitsSkillCounts, isEligible, resolveTeamConfig, sourceLabel, usesCountMode } from "../package/resolveConfig";
import type { Rule } from "./types";
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

/** 2. Squad size — minPlayers..16. */
export const squadSize: Rule = {
  id: "squad-size",
  check: ({ roster, pkg }) => {
    const n = roster.players.length;
    const min = pkg.special.minPlayers;
    if (n < min)
      return [
        err("squad-size", `Team has ${n} players; the tournament requires at least ${min}.`, {
          expected: `>= ${min}`,
          actual: n,
          suggestion: `Add ${min - n} more player${min - n === 1 ? "" : "s"}.`,
        }),
      ];
    if (n > 16)
      return [
        err("squad-size", `Team has ${n} players; the maximum roster size is 16.`, {
          expected: "<= 16",
          actual: n,
          suggestion: `Remove ${n - 16} player${n - 16 === 1 ? "" : "s"}.`,
        }),
      ];
    return [];
  },
};

/** 3. Positional limits — per-position max + maxBigGuys; also unknown positions. */
export const positionalLimits: Rule = {
  id: "positional-limits",
  needsDatasetRoster: true,
  check: ({ players, datasetRoster, data }) => {
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
    return findings;
  },
};

/** 4. Gold budget (optional) — recomputed team gold <= the effective (resolved) gold cap. */
export const goldBudget: Rule = {
  id: "gold-budget",
  check: ({ roster, pkg }) => {
    const cfg = resolveTeamConfig(pkg, roster.rosterName);
    if (cfg.skillPackages?.length) return []; // gold is checked jointly with SP by skill-packages
    if (cfg.gold == null) return [];
    const gold = recomputeGold(roster);
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
      if (!fitsSkillCounts(primaryCount, secondaryCount, resolved.maxPrimary, resolved.maxSecondary, resolved.secondarySwap)) {
        const allot =
          `${resolved.maxPrimary ?? "∞"} primary` +
          (resolved.maxSecondary != null ? ` + ${resolved.maxSecondary} secondary` : "") +
          (resolved.secondarySwap ? " (secondary swap allowed)" : "");
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
      findings.push(
        err(
          "skill-points",
          `Team spends ${total} Skill Points; the budget is ${resolved.skillPointBudget}${where} (${over} over).`,
          {
            expected: `<= ${resolved.skillPointBudget}`,
            actual: total,
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
    for (const rp of players)
      rp.addedSkills.forEach((s, i) => {
        const a = rp.access[i];
        if (a === undefined || a === "illegal") return; // only legal picks cost SP
        skillSP += costSP(s, a, pkg.skillAllotment);
      });

    // Stars: per-tier SP cost + availability; optionally exclude their gold.
    const tierIdx = (cfg.tierNumber ?? 1) - 1;
    const spTable = pkg.starPlayers.spCostByTier;
    let starSP = 0;
    let starGold = 0;
    for (const rp of players) {
      if (!isStarName(data, rp.player.positionName)) continue;
      starGold += rp.player.cost;
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
      else starSP += cost;
    }

    const spUsed = skillSP + starSP;
    // Gold budget is the team BUILD cost: skills are paid in SP (not gold), and stars
    // too when paidInSkillPoints — exclude both so they aren't double-counted.
    const skillsGold = roster.summary?.skillsCost ?? 0;
    const goldUsed =
      recomputeGold(roster) - skillsGold - (pkg.starPlayers.paidInSkillPoints ? starGold : 0);
    const maxOnAPlayer = players.reduce((m, rp) => Math.max(m, rp.addedSkills.length), 0);

    const fits = packs.some(
      (p) =>
        goldUsed <= p.gold &&
        spUsed <= p.skillPointBudget &&
        (p.maxPerPlayer == null || maxOnAPlayer <= p.maxPerPlayer),
    );
    if (!fits) {
      const opts = packs
        .map(
          (p) =>
            `${p.label ? `${p.label}: ` : ""}${p.skillPointBudget} SP @ ${fmtGold(p.gold)}` +
            (p.maxPerPlayer != null ? ` (≤${p.maxPerPlayer}/player)` : ""),
        )
        .join("; ");
      findings.push(
        err(
          "skill-packages",
          `Team uses ${spUsed} SP + ${fmtGold(goldUsed)}${sourceLabel(cfg)}; no skill package fits.`,
          {
            expected: opts,
            actual: `${spUsed} SP + ${fmtGold(goldUsed)}` + (maxOnAPlayer > 1 ? `, ${maxOnAPlayer} skills on one player` : ""),
            suggestion: `Fit a package: ${opts}.`,
          },
        ),
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
    } else if (pkg.starPlayers.maxCount != null && stars.length > pkg.starPlayers.maxCount) {
      findings.push(
        err("star-players", `${stars.length} Star Players; the limit is ${pkg.starPlayers.maxCount}.`, {
          expected: `<= ${pkg.starPlayers.maxCount}`,
          actual: stars.length,
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
 * 9. Inducements — types allowed + caps. Dataset caps use the BB2025 rulebook
 * maxima; a reduced-cap special rule (e.g. Bribery and Corruption → 6 Bribes)
 * raises the cap when the team carries that rule.
 */
export const inducements: Rule = {
  id: "inducements",
  check: ({ roster, pkg, data }) => {
    const findings: Finding[] = [];
    const teamRules = new Set(roster.specialRules.map(normName));
    for (const ind of roster.inducements) {
      const id = ind.id ?? normName(ind.name).replace(/ /g, "_");
      const meta = data.inducements[id];
      const allowed =
        pkg.inducements.allowed.includes("*") || pkg.inducements.allowed.includes(id);
      if (!allowed)
        findings.push(
          err("inducements", `Inducement "${ind.name}" is not allowed in "${pkg.name}".`, {
            suggestion: "Remove it.",
          }),
        );
      // Reduced cap applies only when the team has the unlocking special rule.
      const hasReduced = meta?.reducedSpecialRule != null && teamRules.has(normName(meta.reducedSpecialRule));
      const datasetCap = hasReduced ? meta?.reducedMax ?? meta?.max : meta?.max;
      const cap = pkg.inducements.caps[id] ?? datasetCap ?? null;
      if (cap != null && (ind.count ?? 1) > cap)
        findings.push(
          err("inducements", `${ind.count ?? 1}× ${ind.name} exceeds the limit of ${cap}.`, {
            expected: `<= ${cap}`,
            actual: ind.count ?? 1,
          }),
        );
    }
    return findings;
  },
};

/** 10. Sideline — staff within caps; re-roll count also vs the roster's own max. */
export const sideline: Rule = {
  id: "sideline",
  check: ({ roster, pkg, datasetRoster }) => {
    const findings: Finding[] = [];
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

/** The M1 registry, in plan order. */
export const ALL_RULES: Rule[] = [
  rosterEligibility,
  squadSize,
  positionalLimits,
  goldBudget,
  skillAccessRule,
  skillPoints,
  skillPackages,
  costReconciliation,
  starPlayers,
  inducements,
  sideline,
  specialRules,
];
