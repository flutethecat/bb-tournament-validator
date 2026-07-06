/**
 * SKETCH (unbuilt). Public API of @bb/validator — the ONLY module the Discord bot,
 * the T1 tournament service, and the FUMBBL40k PixiJS client import.
 *
 * PORTABILITY CONTRACT: nothing in this package imports Node built-ins
 * (fs/path/Buffer/process) or platform SDKs. Enforced in the real build by an
 * ESLint no-restricted-imports rule + a browser-target CI build.
 */

export type { Roster, RosterPlayer, RosterInducement, RosterSummary, Target } from "./model/roster";
export type { Finding, Severity, ValidationResult, RecomputedSummary } from "./model/findings";
export type {
  Dataset,
  DatasetRoster,
  DatasetPosition,
  DatasetStarPlayer,
  DatasetInducement,
  DatasetTeam,
  DatasetStar,
  SkillMeta,
  SkillCategory,
} from "./dataset/types";
export {
  findRoster,
  findPosition,
  findSkill,
  skillAccess,
  addedSkills,
  normName,
  isStarName,
  starNameSet,
} from "./dataset/lookup";
export type { Access } from "./dataset/lookup";
export type { TournamentPackage, SkillAllotment, TierDef } from "./package/types";
export { DEFAULT_SKILL_ALLOTMENT } from "./package/types";
export { resolveTier, hasTiers } from "./package/tiers";
export { loadPackage, mergePackages, parseSkillCostCsv, applyCsvOverrides } from "./package/resolve";
export type { CsvSkillCostRow, DeepPartial } from "./package/resolve";
export { costSP, isElite } from "./cost/costSP";
export { ALL_RULES } from "./rules/rules";
export type { Rule, RuleContext, ResolvedPlayer } from "./rules/types";
export { validate } from "./validate";
