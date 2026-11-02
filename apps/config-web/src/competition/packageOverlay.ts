/**
 * A competition's house rules in the Roster Builder validator (creation wizards v2, lane 1). The shared package file is
 * never changed, and a house rule only ever TIGHTENS what the package allows:
 *
 * - Prayers to Nuffle banned -> the inducement's cap becomes 0 on a COPY of the package
 *   (`inducements.caps.prayers_to_nuffle`); 0 is below any cap the package can set.
 * - Max stat increases per player / per team -> an extra validator rule (houseRuleStatRule) that counts the increases
 *   each player actually carries (the validator's own statIncreasesOf, against the dataset position) and refuses more
 *   than the cap. It runs alongside the package's own stat-increases rule, so it applies on top of whatever the package
 *   resolves (defaults, tiers, team rules) and can never loosen any of them.
 *
 * Display-only (no validator hook): a Prayers to Nuffle cost change, Brawling Brutes, progression, MVP, hire/fire.
 *
 * houseRulesStamp (src/competition/houseRules.ts) names exactly these enforced settings: a roster check carries it, and
 * a change to it makes earlier checks stale (src/tournaments/store.ts).
 */
import { ALL_RULES, isStarName, statIncreasesOf, type Rule } from "@bb/validator";
import type { HouseRules } from "./houseRules.js";

export const PRAYERS_INDUCEMENT_ID = "prayers_to_nuffle";
export const HOUSE_RULE_STAT_RULE_ID = "house-rule-stat-increases";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The package with the Prayers to Nuffle ban applied (a copy; the original is untouched). */
export function applyHouseRulesToPackage<T extends object>(pkg: T, rules: HouseRules | undefined): T {
  if (!rules || rules.prayers.mode !== "banned") return pkg;
  const out = structuredClone(pkg) as unknown as Json;
  const ind = isObj(out.inducements) ? out.inducements : (out.inducements = {});
  const caps = isObj((ind as Json).caps) ? (ind as Json).caps as Json : ((ind as Json).caps = {});
  (caps as Json)[PRAYERS_INDUCEMENT_ID] = 0;
  return out as unknown as T;
}

/** The validator rule for the stat caps, or undefined when neither cap is set. */
export function houseRuleStatRule(rules: HouseRules | undefined): Rule | undefined {
  const perPlayer = rules?.maxStatIncreasesPlayer ?? null;
  const perTeam = rules?.maxStatIncreasesTeam ?? null;
  if (perPlayer === null && perTeam === null) return undefined;
  return {
    id: HOUSE_RULE_STAT_RULE_ID,
    needsDatasetRoster: true,
    check: ({ players, data }) => {
      const findings: ReturnType<Rule["check"]> = [];
      let total = 0;
      for (const rp of players) {
        if (!rp.position || isStarName(data, rp.player.positionName)) continue;
        const n = statIncreasesOf(rp.player, rp.position).length;
        total += n;
        if (perPlayer !== null && n > perPlayer) {
          findings.push({
            ruleId: HOUSE_RULE_STAT_RULE_ID, severity: "error", playerRef: rp.player.number,
            message: `House rule: #${rp.player.number} ${rp.position.name} has ${n} stat increase${n === 1 ? "" : "s"}; the limit is ${perPlayer} per player.`,
            expected: `<= ${perPlayer}`, actual: n,
          });
        }
      }
      if (perTeam !== null && total > perTeam) {
        findings.push({
          ruleId: HOUSE_RULE_STAT_RULE_ID, severity: "error",
          message: `House rule: the team has ${total} stat increases; the limit is ${perTeam} per team.`,
          expected: `<= ${perTeam}`, actual: total,
        });
      }
      return findings;
    },
  };
}

/** The validator's rule list with the house-rule stat caps added (the package's own rules all still run). */
export function houseRuleValidatorRules(rules: HouseRules | undefined): Rule[] {
  const extra = houseRuleStatRule(rules);
  return extra ? [...ALL_RULES, extra] : ALL_RULES;
}
