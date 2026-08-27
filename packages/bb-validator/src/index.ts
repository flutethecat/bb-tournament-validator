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
  findStar,
  starEligibleForTeam,
  starEligibleBySpecialRule,
  starEligibleForLeagueSelection,
  eligibleStarsFor,
} from "./dataset/lookup";
export type { Access } from "./dataset/lookup";
export { inducementWireGold } from "./dataset/inducements";
export type {
  TournamentPackage,
  SkillAllotment,
  SkillPackage,
  TierDef,
  TeamRule,
  Matrix,
  MatrixColumn,
  MatrixRow,
  MatrixCell,
} from "./package/types";
export { DEFAULT_SKILL_ALLOTMENT } from "./package/types";
export { resolveTier, hasTiers } from "./package/tiers";
export {
  resolveTeamConfig,
  resolveMatrixCell,
  isEligible,
  eligibleTeamNames,
  usesCountMode,
  fitsSkillCounts,
  parseGold,
} from "./package/resolveConfig";
export type { ResolvedTeamConfig } from "./package/resolveConfig";
export { loadPackage, mergePackages, parseSkillCostCsv, applyCsvOverrides } from "./package/resolve";
export type { CsvSkillCostRow, DeepPartial } from "./package/resolve";
export { costSP, isElite } from "./cost/costSP";
export { costGold, staffGold, inducementsGold, skillsGold, DEFAULT_SKILL_GOLD } from "./cost/costGold";
export { ALL_RULES } from "./rules/rules";
export type { Rule, RuleContext, ResolvedPlayer } from "./rules/types";
export { validate } from "./validate";
export {
  composeTeam,
  composeTeamIntrinsic,
  parseForkRoster,
  teamCustomFromXml,
  withRosteredInducementSet,
  mintTeamId,
  rosterOptions,
  rosterOptionsIntrinsic,
} from "./compose/teamComposer";
export type {
  ForkRoster,
  ForkRosterPosition,
  TeamPick,
  ComposeInput,
  ComposeResult,
  ComposeIntrinsicInput,
  ComposeIntrinsicResult,
  ComposeIssue,
  RosterOption,
  RosterOptions,
} from "./compose/teamComposer";
export { renderPackageHtml } from "./render/packageHtml";
export { renderArtPrompt } from "./render/artPrompt";
