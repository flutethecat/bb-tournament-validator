// The Team Builder's pure core (public/team-builder.js, globalThis.TeamBuilderCore), typed for the SPA Tournament Builder.
// ONE implementation (owner 10-30): the vanilla /tournament-team-builder.html page and this SPA view run the same gates,
// pick/slot wire, tier tables, sheet model and portraits. The file is loaded for its side effect (as TeamManageView loads
// team-view.js); its UI half only boots on the vanilla page (it needs #team-builder-title, which the SPA never renders).
import "../../../public/team-builder.js";

export type Stat = "MA" | "ST" | "AG" | "PA" | "AV";
export type BuilderMode = "create" | "custom" | "tournament";

/** A roster position as /api/fork/rosters sends it (field-by-field copy, see sanitizeRoster in builder.ts). */
export interface BuilderPosition {
  positionId: string;
  name: string;
  type: string;
  cost: number;
  max: number;
  MA: number | string;
  ST: number | string;
  AG: string;
  PA: string;
  AV: string;
  skills: string[];
  skillsDisplay?: string[];
  keywords?: string[];
  isStar: boolean;
  playsFor: string[];
  teamWithPositionId?: string;
}

export interface PositionGroup { positions: string[]; max: number; label: string }

export interface BuilderRoster {
  rosterId: string;
  raceName: string;
  reRollCost: number;
  maxReRolls: number;
  apothecaryAllowed: boolean;
  leagueOptions: string[];
  specialRules?: string[];
  alwaysOnRules?: string[];
  positions: BuilderPosition[];
  positionGroups?: PositionGroup[];
}

/** One roster slot (a player) in builder order. */
export interface Slot {
  positionId: string;
  /** The player's name (owner 11-01: generated on hire, editable; never on stars). Rides the pick as names[i]. */
  name?: string;
  isStar?: boolean;
  captain?: boolean;
  chosenSkills: string[];
  chosenStatIncreases: string[];
  chosenStats?: Partial<Record<Stat, number>>;
}

/** TeamPick: the wire form of slots (consecutive identical players merged). */
export interface TeamPick {
  positionId: string;
  count: number;
  chosenSkills?: string[];
  chosenStatIncreases?: string[];
  chosenStats?: Partial<Record<Stat, number>>;
  captain?: boolean;
  /** One player name per player of the pick ("" = unnamed). */
  names?: string[];
}

export interface StatRules {
  allowed?: boolean | string[];
  stats?: string[];
  costGold: number | Partial<Record<Stat, number>> | null;
  maxPerPlayer: number | null;
  exclusiveWithSkills?: false;
}
export interface StackedPlayer { maxSkills: number | null; maxSecondary: number | null; maxElite: number | null }
export interface StarPack { id: string; label: string; fee: number | null; feeMode: "each" | "once"; max: number | null; stars: string[] }
export interface TierRules {
  tier: number | null;
  maxSecondary: number | null;
  eliteMaxTotal: number | null;
  eliteMaxSameSkill: number | null;
  maxStackedPlayers: number | null;
  stackedPlayer: StackedPlayer | null;
  statIncreases: StatRules | null;
  starPacks: StarPack[];
  maxStars: number | null;
}

/** A choose-one skill pack (WHBB Nut Cup style). */
export interface SkillPack {
  label: string;
  gold: number | null;
  skillPointBudget: number;
  maxPerPlayer: number | null;
  maxSkills: number | null;
  maxSecondary: number | null;
  starPlayersAllowed?: false;
}
export interface SkillCosts { primary: number; secondary: number; eliteSurcharge: number; stackSurcharge: number; eliteSkills: string[] }
/** The package's block for the chosen race (GET /api/packages/<name>?roster=). */
export interface RaceRules {
  roster: string;
  source: string;
  tierNumber: number | null;
  tierLabel?: string;
  gold: number | null;
  skillPointBudget: number;
  skillCosts?: SkillCosts;
  maxPerPlayer: number | null;
  packs: SkillPack[];
  bannedStars: string[];
  stars?: { allowed: boolean; maxCount: number | null; paidInSkillPoints: boolean; spCosts?: Array<{ name: string; sp: number }> };
}

export interface OverviewTeam {
  name: string;
  gold: number | null;
  goldMax: number | null;
  allotment: string[];
  secondary: string | null;
  elite: string | null;
  stacks: string | null;
  stackLimit: string | null;
  characteristics: string | null;
  stars: string | null;
}
export interface Overview {
  summary: Array<{ key: string; label: string; text: string; details: { summary: string; items: string[] } | null }>;
  groups: Array<{ tier: number | null; label: string; teams: OverviewTeam[] }>;
}

export interface LegalSkill { skill: string; category?: string; elite?: boolean }
export interface LegalSet { primary: LegalSkill[]; secondary: LegalSkill[]; alreadyPrinted: string[] }
export type Access = "primary" | "secondary" | "custom";

/** The shared gates' context (Core.skillPickBlock & co.). */
export interface GateContext {
  mode: BuilderMode;
  slots: Slot[];
  positionById: (positionId: string) => BuilderPosition | null;
  tierRules: TierRules | null;
  raceRules: RaceRules | null;
  packSummary: SkillPack | null;
  legal: (positionId: string) => LegalSet | null;
  isElite: (skill: string) => boolean;
  accessOf: (positionId: string, skill: string) => Access;
  statRules: StatRules | null;
  allowedStats: string[];
  captainRules: string[];
}
export interface StarContext {
  mode: BuilderMode;
  positions: BuilderPosition[];
  leagueOptions: string[];
  activeLeague: string;
  raceRules: RaceRules | null;
  tierRules: TierRules | null;
  slots: Slot[];
  positionGroups?: PositionGroup[];
}
export interface StarChoice { key: string; label: string; members: BuilderPosition[]; cost: number; paired: boolean }

export interface InducementItem {
  key: string;
  label: string;
  price: number;
  max: number | null;
  allowed: boolean;
  reducedPrice: number | null;
  reducedMax: number | null;
  reducedSpecialRule: string | null;
  reducedRoster: string | null;
  rosterOnly: string[] | null;
}
export interface InducementTeam { raceName: string; specialRules?: string[]; specialRule?: string }

export interface LeagueSelection { selectedLeague: string; explicit: boolean }
export interface LeaguePresentation { visible: boolean; interactive: boolean; selectionRequired: boolean; selectedValid: boolean }

export interface StatCell { value: string | number; improved: boolean }

export interface SheetPlayerInput {
  position: BuilderPosition | null;
  name?: string;
  chosenSkills: string[];
  chosenStatIncreases: string[];
  chosenStats: Partial<Record<Stat, number>> | null;
  captain: boolean;
  accessOf: (skill: string) => "primary" | "secondary";
}
export interface SheetInput {
  raceName: string;
  coach: string;
  teamName: string;
  rulesetName: string;
  players: SheetPlayerInput[];
  staff: Staff;
  apothecaryAllowed: boolean;
  inducements: Array<{ label: string; count: number }>;
  specialRules: string[];
  captainAvailable: boolean;
  summary: Record<string, number> | null;
  costs: { players: number; stars: number; sideline: number; skills: number; inducements: number };
  budget?: number;
}
export interface SheetRow {
  number: number;
  /** The player name ("" when none); the position is its subheader. */
  name: string;
  position: string;
  positionFull: string;
  stats: Record<Stat, StatCell>;
  printed: string[];
  added: Array<{ name: string; access: string }>;
  captain: boolean;
  free: string[];
  statIncreases: string[];
  cost: number | null;
  keywords: string[] | null;
  isStar: boolean;
}
export interface SheetModel {
  raceName: string;
  coach: string;
  teamName: string;
  rulesetName: string;
  sideline: Array<[string, string]>;
  inducements: Array<{ label: string; count: number }>;
  specialRules: string[];
  summary: Array<[string, string]>;
  rows: SheetRow[];
  keywords: Array<{ position: string; keywords: string[] }>;
}

export interface Staff { reRolls: number; assistantCoaches: number; cheerleaders: number; dedicatedFans: number; apothecary: number }

/** Art manifests (/sprites, /crests, /icons/*). Only the shapes the core reads. */
export interface SpriteManifest { races: Record<string, Record<string, string>>; starRace?: string; roleAliases?: Record<string, Record<string, string>> }
export interface CrestManifest { crests: Record<string, string> }
export interface IconManifest { icons: Record<string, string>; aliases?: Record<string, string> }

export interface TeamBuilderCoreApi {
  STATS: Stat[];
  MAX_PLAYERS: number;
  SKILL_GOLD: { primary: number; secondary: number; elite: number };
  TEAM_CAPTAIN: string;
  DEFAULT_SKILL_COSTS: SkillCosts;
  SHEET_CSS: string;
  gold(value: unknown): string;
  num(value: unknown): number | null;
  norm(value: unknown): string;
  packSkillText(pack: SkillPack | null): string;
  packTermsText(pack: SkillPack | null): string;
  resolveSprite(manifest: SpriteManifest | null, race: string, positionName: string): string | null;
  resolveCrest(manifest: CrestManifest | null, race: string): string | null;
  skillIconKey(skill: string, aliases?: Record<string, string>): string;
  cardRoleTag(position: BuilderPosition, rosterPositions: BuilderPosition[], displayName: string): string;
  normalizeLeagueOptions(options: unknown): string[];
  leagueFieldPresentation(options: string[], selection: LeagueSelection): LeaguePresentation;
  reconcileLeagueSelection(options: string[], current: LeagueSelection): LeagueSelection;
  explicitLeagueSpecialRule(options: string[], selection: LeagueSelection): string | undefined;
  starEligibleForLeague(playsFor: string[], options: string[], selectedLeague: string): boolean;
  buildStarChoices(positions: BuilderPosition[]): StarChoice[];
  positionGroupCapped(positionId: string, groups: PositionGroup[] | undefined, counts: Map<string, number>): PositionGroup | null;
  buildPicks(slots: Slot[], options?: { skills?: boolean; stats?: boolean; allowedStats?: string[] | null; customStats?: boolean; captain?: boolean }): TeamPick[];
  slotsFromPicks(picks: unknown, positionById: (id: string) => BuilderPosition | null): Slot[];
  moveSlot(list: Slot[], from: number, to: number): Slot[];
  rosterHasCaptain(rules: string[]): boolean;
  canCaptain(position: BuilderPosition | null, rules: string[]): boolean;
  reconcileCaptain(list: Slot[], positionById: (id: string) => BuilderPosition | null, rules: string[]): Slot[];
  improvedStats(position: BuilderPosition | null, increases?: string[], overrides?: Partial<Record<Stat, number>> | null): Record<Stat, StatCell>;
  statIncreaseCost(statRules: StatRules | null, stat: string): number | null;
  normalizeTierRules(raw: unknown): TierRules | null;
  tierLimitLines(rules: TierRules | null): string[];
  starPacksFor(starName: string, starPacks: StarPack[]): StarPack[];
  starPackLabel(pack: StarPack): string;
  normalizeOverview(raw: unknown): Overview | null;
  overviewSummaryHtml(overview: Overview | null): string;
  overviewTableHtml(overview: Overview | null, opts?: { pick?: (name: string) => { id: string; crest?: string; selected?: boolean } | null }): string;
  raceTableOverview(overview: Overview | null, names: string[], isTeam?: (name: string) => boolean): Overview | null;
  tierTable(rows: unknown[], tierSummary?: unknown): unknown[];
  tierTableHtml(table: unknown[], opts?: { pick?: (name: string) => { id: string; crest?: string; selected?: boolean } | null }): string;
  playerSkillSp(names: string[], secondaryOf: (skill: string) => boolean, costs?: SkillCosts): number;
  rosterSheetModel(input: SheetInput): SheetModel;
  rosterSheetHtml(model: SheetModel): string;
  sheetFileName(model: SheetModel): string;
  isEliteSkill(skill: string, packageElite: string[] | undefined, meta: { elite?: boolean } | null): boolean;
  moreSkillsAllowed(ctx: GateContext, slot: Slot): boolean;
  stackedTypeBlock(ctx: GateContext, slot: Slot, skill: string): string;
  skillPickBlock(ctx: GateContext, slot: Slot | null, skill: string): string;
  statOptionState(ctx: GateContext, slot: Slot | null, position: BuilderPosition | null, stat: string): string;
  allowedStatList(statRules: StatRules | null): string[];
  slotSkillGold(ctx: GateContext, slot: Slot): number;
  inducementTerms(item: InducementItem | undefined, team: InducementTeam | null): { price: number; max: number | null; reduced: boolean };
  inducementOpenToRoster(item: InducementItem, team: InducementTeam | null): boolean;
  starCap(raceRules: RaceRules | null, tierRules: TierRules | null): number | null;
  offeredStarChoices(ctx: StarContext): StarChoice[];
  canAddStarChoice(ctx: StarContext, choice: StarChoice): boolean;
}

const loaded = (globalThis as unknown as { TeamBuilderCore?: TeamBuilderCoreApi }).TeamBuilderCore;
if (!loaded) throw new Error("public/team-builder.js did not register TeamBuilderCore");
export const core: TeamBuilderCoreApi = loaded;
