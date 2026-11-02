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
  rosterHasTeamCaptain,
  splitCaptainGrants,
  withoutCaptainGrants,
  TEAM_CAPTAIN,
  TEAM_CAPTAIN_FREE_SKILL,
  normName,
  canonSkill,
  decodeEntities,
  isStarName,
  starNameSet,
  findStar,
  starEligibleForTeam,
  starEligibleBySpecialRule,
  starEligibleForLeagueSelection,
  eligibleStarsFor,
} from "./dataset/lookup";
export type { Access } from "./dataset/lookup";
export { inducementCatalog, inducementEnabled, inducementIdForName, inducementIdInCatalog, inducementReducedFor, inducementWireGold } from "./dataset/inducements";
export {
  SEVENS_PROFILE,
  SEVENS_TEAM_TIERS,
  SEVENS_TEAMS,
  SEVENS_STAFF_PRICES,
  SEVENS_INDUCEMENTS,
  SEVENS_LINEMAN_KEYWORD,
  SEVENS_VETERAN_MA_DELTA,
  hasLinemanKeyword,
  sevensTierDef,
  sevensTiers,
} from "./dataset/bb2025/sevens";
export { effectiveRosterLimits } from "./package/limits";
export type { RosterLimits, RosterLimitsInducement, RosterLimitsStaffRow } from "./package/limits";
export { STANDARD_STAFF_PRICES, effectiveStaffPrices, priceStaff } from "./cost/staff";
export type { StaffKey, StaffLine } from "./cost/staff";
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
  StatKey,
  StatIncreaseRule,
  StackedPlayerCaps,
  StarPack,
  ExtraSkillKnobs,
  PackageFormat,
  StaffPrices,
  InducementSet,
} from "./package/types";
export { DEFAULT_SKILL_ALLOTMENT, isCountPack } from "./package/types";
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
export type { ResolvedTeamConfig, ResolvedStatIncreases } from "./package/resolveConfig";
export { MAX_STAT_STEPS, statIncreasesOf, statIncreasesOverLimit, statIncreaseGold, statIncreasesGold, starPackPicks } from "./cost/extras";
export type { StarPick } from "./cost/extras";
export { canonicalizeStatRuleRaces, cleanStatIncreaseRules, playerStatRuleBlock, statRuleBlock, teamCapBlock } from "./cost/statRules";
export type { StatIncreaseRules, BlockedStat, RulePosition, RulePlayer } from "./cost/statRules";
export { loadPackage, mergePackages, parseSkillCostCsv, applyCsvOverrides } from "./package/resolve";
export {
  CUSTOM_STAR_LIMITS,
  customStarPositionId,
  customStarProblems,
  customStarStats,
  customStarsOf,
  findCustomStar,
  isCustomStarPositionId,
  withCustomStars,
} from "./package/customStars";
export type { CustomStar, CustomStarRule } from "./package/customStars";
export type { CsvSkillCostRow, DeepPartial } from "./package/resolve";
export { costSP, isElite } from "./cost/costSP";
export { costGold, staffGold, inducementsGold, skillsGold, DEFAULT_SKILL_GOLD } from "./cost/costGold";
export { ALL_RULES } from "./rules/rules";
export type { Rule, RuleContext, ResolvedPlayer } from "./rules/types";
export { validate, priceRoster } from "./validate";
export {
  composeTeam,
  composeTeamIntrinsic,
  customStarPositions,
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
