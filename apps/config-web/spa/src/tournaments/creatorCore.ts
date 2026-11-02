// Tournament Creator, pure core (ported from the vanilla page public/tournament-rules.js, which keeps serving at
// /tournament-rules.html). Round-trip law (owner 10-27): loading a package and serialising it back without edits gives
// JSON deep-equal to the input. normalizePackage() only FILLS absent keys (with the validator's defaults, so the
// controls show what the validator will apply) and never rewrites present values; serializePackage() drops every
// filled key the organiser left untouched (pruneInjected). Unknown and future fields ride along verbatim.

export const MEGA_STARS = [
  "Morg 'n' Thorg",
  "H'thark the Unstoppable",
  "Griff Oberwald",
  'Ivan "the Animal" Deathshroud',
  "Hakflem Skuttlespike",
];

export interface InducementDef { id: string; label: string; max: number; fixed: boolean }

// Ids match packages/bb-validator/src/dataset/bb2025/inducements.json.
export const INDUCEMENTS: InducementDef[] = [
  { id: "biased_referee", label: "Biased Referee", max: 1, fixed: true },
  { id: "bloodweiser_kegs", label: "Blitzer's Best Kegs", max: 2, fixed: false },
  { id: "bribes", label: "Bribe", max: 3, fixed: false },
  { id: "extra_team_training", label: "Extra Team Training", max: 8, fixed: false },
  { id: "halfling_master_chef", label: "Halfling Master Chef", max: 1, fixed: true },
  { id: "infamous_coaching_staff", label: "Infamous Coaching Staff: Josef Bugman", max: 1, fixed: true },
  { id: "mercenaries", label: "Mercenary Players", max: 3, fixed: false },
  { id: "mortuary_assistant", label: "Mortuary Assistant", max: 1, fixed: true },
  { id: "part_time_assistant_coaches", label: "Part-time Assistant Coach", max: 5, fixed: false },
  { id: "plague_doctor", label: "Plague Doctor", max: 1, fixed: true },
  { id: "prayers_to_nuffle", label: "Prayers to Nuffle", max: 3, fixed: false },
  { id: "riotous_rookies", label: "Riotous Rookies", max: 1, fixed: true },
  { id: "team_mascot", label: "Team Mascot", max: 1, fixed: true },
  { id: "temp_agency_cheerleaders", label: "Temp Agency Cheerleader", max: 5, fixed: false },
  { id: "wandering_apothecaries", label: "Wandering Apothecary", max: 2, fixed: false },
  { id: "weather_mage", label: "Weather Mage", max: 1, fixed: true },
  { id: "hireling_sports_wizard", label: "Sports Wizard", max: 1, fixed: true },
  { id: "bretonnian_pastries", label: "Bretonnian Pastries", max: 1, fixed: true },
  { id: "bretonnian_damsel", label: "Bretonnian Damsel", max: 1, fixed: true },
  { id: "canopic_jar", label: "Canopic Jar", max: 1, fixed: true },
];

// ---------- Blood Bowl Sevens (spec-sevens-rules-2026-11-02; mirrors packages/bb-validator/src/dataset/bb2025/sevens.ts,
// held equal by test/sevensCreator.test.ts) ----------

export type PackageFormat = "standard" | "sevens";

/** The Sevens inducement list (SJ22): replaces INDUCEMENTS when a package uses `inducements.set: "sevens"`. */
export const SEVENS_INDUCEMENTS: InducementDef[] = [
  { id: "temp_agency_cheerleaders", label: "Temp Agency Cheerleaders", max: 2, fixed: false },
  { id: "part_time_assistant_coaches", label: "Part-time Assistant Coaches", max: 2, fixed: false },
  { id: "bloodweiser_kegs", label: "Blitzer's Best Kegs", max: 2, fixed: false },
  { id: "prayers_to_nuffle", label: "Prayers to Nuffle", max: 2, fixed: false },
  { id: "extra_team_training", label: "Extra Team Training", max: 6, fixed: false },
  { id: "bribes", label: "Bribes", max: 2, fixed: false },
  { id: "wandering_apothecaries", label: "Wandering Apothecary", max: 1, fixed: true },
  { id: "mortuary_assistant", label: "Mortuary Assistant", max: 1, fixed: true },
  { id: "plague_doctor", label: "Plague Doctor", max: 1, fixed: true },
  { id: "halfling_master_chef", label: "Halfling Master Chef", max: 1, fixed: true },
  { id: "desperate_measures", label: "Desperate Measures", max: 5, fixed: false },
];

/** The SJ22 Sevens tier table. Slann is not on it (an organiser may add it to a tier). */
export const SEVENS_TIER_TABLE: Array<{ tier: number; rosters: string[] }> = [
  { tier: 1, rosters: ["Amazon", "Chaos Dwarf", "Dark Elf", "Elven Union", "Human", "High Elf", "Necromantic Horror", "Norse", "Old World Alliance", "Skaven", "Wood Elf"] },
  { tier: 2, rosters: ["Bretonnian", "Dwarf", "Imperial Nobility", "Lizardmen", "Nurgle", "Orc", "Shambling Undead", "Tomb Kings", "Vampire"] },
  { tier: 3, rosters: ["Black Orc", "Chaos Chosen", "Chaos Renegade", "Halfling", "Khorne", "Underworld Denizens"] },
  { tier: 4, rosters: ["Gnome", "Goblin", "Ogre", "Snotling"] },
];
export const SEVENS_TEAMS: string[] = SEVENS_TIER_TABLE.flatMap((t) => t.rosters);

/** Matched Play skills on the count knobs: tier N = N primaries; two may be swapped for the team's one secondary. */
export function sevensTier(tier: number, rosters: string[]): Tier {
  return {
    tier, label: `Tier ${tier}`, rosters: [...rosters], gold: null, maxPrimary: tier, maxSecondary: 0,
    secondarySwap: true, secondarySwapRatio: 2, secondarySwapMax: 1, starPlayersAllowed: false, bannedStars: [],
  };
}

export const SEVENS_STAFF_PRICES = { reRoll: 100000, assistantCoach: 20000, cheerleader: 20000, apothecary: 80000, dedicatedFan: 20000 };
/** The validator's Sevens profile (SEVENS_PROFILE), block by block: what a format: "sevens" package starts from. */
export const SEVENS_DEFAULTS = {
  goldBudget: 600000,
  staffPrices: SEVENS_STAFF_PRICES,
  skillAllotment: { skillPointBudget: 0, maxPerPlayer: 1, eliteMaxTotal: 2, primaryCostGold: 0, secondaryCostGold: 0, eliteSurchargeGold: 0 },
  starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null },
  inducements: { set: "sevens" as const, allowed: ["*"], caps: {} as Record<string, number> },
  sideline: { maxReRolls: 6, maxApothecary: 1, maxCheerleaders: 3, maxAssistantCoaches: 3, maxDedicatedFans: 5, dedicatedFansStart: 0 },
  special: { minPlayers: 7, maxPlayers: 11, maxNonLineman: 4, veteran: true },
};

export const isSevens = (pkg: { format?: unknown } | null | undefined): boolean => pkg?.format === "sevens";
/** The inducement list the editor offers for this package. */
export const inducementDefs = (pkg: { inducements?: { set?: unknown } } | null | undefined): InducementDef[] =>
  pkg?.inducements?.set === "sevens" ? SEVENS_INDUCEMENTS : INDUCEMENTS;

/** Write the Sevens defaults INTO the document (the Format toggle): budget, players, the non-Lineman cap, the Veteran,
 *  staff prices and caps, Dedicated Fans, the Sevens inducement list, stars off, skill gold 0, and the SJ22 tier table on
 *  the count knobs. Name, date, description, data note and extends are kept. */
export function applySevensDefaults(pkg: Pkg): void {
  const d = clone(SEVENS_DEFAULTS);
  // Per-race budgets and skill allotments from the 11s rules (team rules) would override the Sevens 600k: dropped.
  pkg.teamRules = [];
  pkg.format = "sevens";
  pkg.goldBudget = d.goldBudget;
  pkg.goldCapIncludesAddedSkills = false;
  pkg.staffPrices = d.staffPrices;
  pkg.eligibleRosters = [...SEVENS_TEAMS];
  pkg.skillAllotment = { ...pkg.skillAllotment, ...d.skillAllotment };
  for (const key of ["maxPrimary", "maxSecondary", "secondarySwap", "secondarySwapRatio", "secondarySwapMax"]) delete pkg.skillAllotment[key];
  pkg.starPlayers = { ...pkg.starPlayers, ...d.starPlayers };
  pkg.bannedStars = [];
  delete pkg.starPacks;
  delete pkg.starPacksAllowed;
  delete pkg.matrix;
  pkg.skillPackages = [];
  pkg.inducements = { ...d.inducements };
  pkg.sideline = { ...pkg.sideline, ...d.sideline };
  pkg.special = { ...pkg.special, ...d.special };
  pkg.tiers = SEVENS_TIER_TABLE.map((t) => sevensTier(t.tier, t.rosters));
}

/** What applying the Sevens defaults will throw away (the Format toggle lists it before it applies). */
export function sevensDrops(pkg: Pkg): string[] {
  const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const out: string[] = [];
  if (safeArray(pkg.teamRules).length) out.push(`${n(pkg.teamRules.length, "team rule", "team rules")} (per-race budgets and skills)`);
  if (safeArray(pkg.tiers).length) out.push(`the current ${n(pkg.tiers.length, "tier", "tiers")} (replaced by the Sevens tier list)`);
  if (safeArray(pkg.skillPackages).length) out.push(n(pkg.skillPackages.length, "skill package", "skill packages"));
  if (pkg.matrix?.cells?.length) out.push("the cash x skills matrix");
  if (safeArray(pkg.starPacks).length) out.push(n(safeArray(pkg.starPacks).length, "star pack", "star packs"));
  if (safeArray(pkg.bannedStars).length) out.push(n(pkg.bannedStars.length, "banned star", "banned stars"));
  if (pkg.goldBudget != null && pkg.goldBudget !== SEVENS_DEFAULTS.goldBudget) out.push(`the ${overviewGold(pkg.goldBudget)} gold cap (now 600k)`);
  return out;
}

/** Back to the standard defaults (the Format toggle's Standard, after a confirm): everything but the package details is
 *  reset to a blank package's values. `extends` is cleared too: the base may be a Sevens package, which would make the
 *  package Sevens again (and bring its Sevens-only fields back). */
export function applyStandardDefaults(pkg: Pkg): void {
  const keep = { name: pkg.name, date: pkg.date, description: pkg.description, dataNote: pkg.dataNote, extends: "", ruleset: pkg.ruleset };
  for (const key of Object.keys(pkg)) delete pkg[key];
  Object.assign(pkg, normalizePackage(fallbackRaw()), keep);
}

export const CATEGORY_COLORS: Record<string, string> = {
  general: "var(--ui-skill-general, #6ea8ff)",
  agility: "var(--ui-skill-agility, #ffd23d)",
  strength: "var(--ui-skill-strength, #ff6b6b)",
  passing: "var(--ui-skill-passing, #ffffff)",
  devious: "var(--ui-skill-passing, #ffffff)",
  mutations: "var(--ui-skill-mutation, #6fcf6f)",
  mutation: "var(--ui-skill-mutation, #6fcf6f)",
  traits: "var(--ui-skill-trait, #b08b5a)",
  trait: "var(--ui-skill-trait, #b08b5a)",
};

export const STAT_KEYS = ["MA", "ST", "AG", "PA", "AV"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
/** Owner 10-27: a package has at most 10 tiers (schema maxItems; the server refuses an 11th). */
export const MAX_TIERS = 10;
export const DEFAULT_GOLD_COSTS = { primaryCostGold: 20000, secondaryCostGold: 40000, eliteSurchargeGold: 10000 };

// Mirrors the validator's DEFAULT_SKILL_ALLOTMENT (packages/bb-validator/src/package/types.ts), so an absent key shows
// the value the validator will actually apply.
const DEFAULT_SKILL_ALLOTMENT = {
  skillPointBudget: 0,
  primaryCostSP: 1,
  secondaryMultiplier: 2,
  secondaryCostSP: null,
  eliteSurchargeSP: 0.5,
  stackSurchargeSP: 0,
  eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"],
  skillCostSP: {},
  maxPerPlayer: 2,
  maxSameSkillTeamwide: null,
  maxStackedPlayers: null,
};
const DEFAULT_STAR_PLAYERS = { allowed: true, maxCount: null, maxCombinedCost: null };
const DEFAULT_INDUCEMENTS = { allowed: ["*"], caps: {} };
const DEFAULT_SIDELINE = { maxReRolls: 8, maxApothecary: 1, maxCheerleaders: null, maxAssistantCoaches: null, maxDedicatedFans: null };
const DEFAULT_SPECIAL = { insignificantTraitConstraint: true, stalling: true, slannAllowed: false, statIncreasesAllowed: false, bannedSkills: [], minPlayers: 11 };

const OPTIONAL_STRINGS = ["description", "dataNote", "date", "extends"] as const;
export const NESTED_PRUNE = new Set(["skillAllotment", "starPlayers", "inducements", "sideline", "special", "staffPrices"]);
// Containers the editor creates on demand; emptied ones are removed again.
const LAZY_OBJECTS = new Set(["rosterGold", "stackedPlayer", "statIncreases", "costGold", "skillCostGold", "rosterOnly"]);

// ---------- package shape (what the editor reads; every block also carries unknown fields verbatim) ----------

export type Num = number | null;
export interface StackedPlayer { maxSkills?: Num; maxSecondary?: Num; maxElite?: Num; [k: string]: unknown }
export interface StatIncreases { allowed?: string[]; maxPerPlayer?: Num; costGold?: Partial<Record<StatKey, Num>>; exclusiveWithSkills?: boolean; [k: string]: unknown }
export interface Knobs {
  gold?: Num; skillPointBudget?: Num; maxPrimary?: Num; maxSecondary?: Num; secondarySwap?: boolean; secondarySwapRatio?: Num; secondarySwapMax?: Num;
  maxStackedPlayers?: Num; eliteMaxTotal?: Num; eliteMaxSameSkill?: Num; stackedPlayer?: StackedPlayer; starPlayersAllowed?: boolean;
  statIncreases?: StatIncreases; starPacksAllowed?: string[]; bannedStars?: string[];
  [k: string]: unknown;
}
export interface SkillPack { label?: string; gold?: Num; skillPointBudget?: Num; maxPerPlayer?: Num; maxSkills?: Num; maxSecondary?: Num; starPlayersAllowed?: boolean; [k: string]: unknown }
export interface Tier extends Knobs { tier?: number; label?: string; rosters: string[]; rosterGold?: Record<string, Num>; skillPackages?: SkillPack[] }
export interface TeamRule extends Knobs { team: string }
export interface MatrixColumn { gold: Num; [k: string]: unknown }
export interface MatrixRow { primary: number; secondary: number; secondarySwap?: boolean; label?: string; secondarySwapRatio?: Num; secondarySwapMax?: Num; maxStackedPlayers?: Num; [k: string]: unknown }
export interface MatrixCell { row: number; col: number; teams: string[]; starPlayersAllowed?: boolean; bannedStars?: string[]; [k: string]: unknown }
export interface Matrix { columns: MatrixColumn[]; rows: MatrixRow[]; cells: MatrixCell[]; [k: string]: unknown }
export interface StarPack { id: string; label?: string; fee?: Num; feeMode?: "each" | "once"; max?: Num; stars: string[]; [k: string]: unknown }
export interface SkillAllotment {
  skillPointBudget?: Num; primaryCostSP?: Num; secondaryMultiplier?: Num; secondaryCostSP?: Num; eliteSurchargeSP?: Num; stackSurchargeSP?: Num;
  eliteSkills?: string[]; skillCostSP?: Record<string, number>; skillCostGold?: Record<string, number>; maxPerPlayer?: Num; maxSameSkillTeamwide?: Num;
  maxStackedPlayers?: Num; maxPrimary?: Num; maxSecondary?: Num; secondarySwap?: boolean; secondarySwapRatio?: Num; secondarySwapMax?: Num;
  eliteMaxTotal?: Num; eliteMaxSameSkill?: Num; stackedPlayer?: StackedPlayer; primaryCostGold?: Num; secondaryCostGold?: Num; eliteSurchargeGold?: Num;
  [k: string]: unknown;
}
export interface StarPlayers { allowed?: boolean; maxCount?: Num; maxCombinedCost?: Num; paidInSkillPoints?: boolean; spCostByTier?: Record<string, Num[]>; [k: string]: unknown }
export interface Inducements { set?: "core" | "sevens"; allowed?: string[]; caps?: Record<string, number>; rosterOnly?: Record<string, string[]>; [k: string]: unknown }
export interface Sideline { maxReRolls?: Num; maxApothecary?: Num; maxCheerleaders?: Num; maxAssistantCoaches?: Num; maxDedicatedFans?: Num; dedicatedFansStart?: Num; [k: string]: unknown }
export interface Special {
  insignificantTraitConstraint?: boolean; stalling?: boolean; slannAllowed?: boolean; statIncreasesAllowed?: boolean; bannedSkills?: string[]; minPlayers?: Num;
  maxPlayers?: Num; maxNonLineman?: Num; veteran?: boolean; [k: string]: unknown;
}
export interface StaffPrices { reRoll?: Num; assistantCoach?: Num; cheerleader?: Num; apothecary?: Num; dedicatedFan?: Num; [k: string]: unknown }

/** The editing model: absent keys filled by normalizePackage(). */
export interface Pkg {
  name: string; ruleset: string; description: string; dataNote: string; date: string; extends: string;
  eligibleRosters: string[]; goldBudget: Num; goldCapIncludesAddedSkills: boolean;
  skillAllotment: SkillAllotment; skillPackages: SkillPack[]; tiers: Tier[]; teamRules: TeamRule[]; bannedStars: string[];
  starPlayers: StarPlayers; inducements: Inducements; sideline: Sideline; special: Special;
  statIncreases?: StatIncreases; starPacks?: StarPack[]; starPacksAllowed?: string[]; matrix?: Matrix;
  format?: PackageFormat; staffPrices?: StaffPrices;
  [k: string]: unknown;
}
export type RawDoc = Record<string, unknown>;
export type Path = Array<string | number>;

export type System = "skillpoints" | "tiers" | "packages" | "matrix";
export type SkillMode = "pool" | "count";
export interface ViewState {
  system: System; skillMode: SkillMode; initialSystem: System; initialSkillMode: SkillMode;
  systemTouched: boolean; skillModeTouched: boolean; starCostsTouched: boolean;
}

export function freshView(system: System, skillMode: SkillMode): ViewState {
  return { system, skillMode, initialSystem: system, initialSkillMode: skillMode, systemTouched: false, skillModeTouched: false, starCostsTouched: false };
}

// ---------- helpers ----------

export function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}
export function isObj(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}
export function numberOr(value: unknown, fallback: number): number;
export function numberOr(value: unknown, fallback: number | null): number | null;
export function numberOr(value: unknown, fallback: number | null): number | null {
  if (value === "" || value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export function nullableNumber(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
/** Gold in thousands for display ("" when unset). */
export function goldToK(value: unknown): number | "" {
  return value == null || value === "" ? "" : Number(value) / 1000;
}
export function kToGold(value: unknown): number | null {
  const n = nullableNumber(value);
  return n == null ? null : Math.round(n * 1000);
}
export function safeArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
export function goldLabel(value: unknown): string {
  return value == null ? "—" : `${goldToK(value)}k`;
}
export const pathKey = (path: Path): string => JSON.stringify(path);

// ---------- package model ----------

function fill(target: Record<string, unknown>, key: string, value: unknown, filled: Set<string> | undefined, prefix: Path = []): void {
  if (target[key] !== undefined) return;
  target[key] = clone(value);
  filled?.add(pathKey([...prefix, key]));
}
function objectAt(target: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isObj(target[key])) target[key] = {};
  return target[key] as Record<string, unknown>;
}

/** Editing model: a clone of the raw package with ABSENT keys filled (validator defaults); `filled` collects the path
 *  of every filled key, so the controls can show those values as defaults (placeholders). */
export function normalizePackage(raw: unknown, filled?: Set<string>): Pkg {
  const pkg: Record<string, unknown> = isObj(raw) ? clone(raw) : {};
  // A Sevens document fills its absent keys with the Sevens profile (what the validator applies), not the 11s defaults.
  const sevens = pkg.format === "sevens";
  fill(pkg, "name", "", filled);
  fill(pkg, "ruleset", "bb2025-default", filled);
  OPTIONAL_STRINGS.forEach((key) => fill(pkg, key, "", filled));
  fill(pkg, "eligibleRosters", sevens ? SEVENS_TEAMS : ["*"], filled);
  fill(pkg, "goldBudget", sevens ? SEVENS_DEFAULTS.goldBudget : null, filled);
  fill(pkg, "goldCapIncludesAddedSkills", false, filled);
  if (sevens) {
    const prices = objectAt(pkg, "staffPrices");
    Object.entries(SEVENS_STAFF_PRICES).forEach(([key, value]) => fill(prices, key, value, filled, ["staffPrices"]));
  }
  const allotment = objectAt(pkg, "skillAllotment");
  Object.entries({ ...DEFAULT_SKILL_ALLOTMENT, ...(sevens ? SEVENS_DEFAULTS.skillAllotment : {}) }).forEach(([key, value]) => fill(allotment, key, value, filled, ["skillAllotment"]));
  ["skillPackages", "tiers", "teamRules", "bannedStars"].forEach((key) => {
    if (!Array.isArray(pkg[key])) pkg[key] = [];
  });
  const blocks: Array<[string, Record<string, unknown>]> = sevens
    ? [
      ["starPlayers", SEVENS_DEFAULTS.starPlayers], ["inducements", SEVENS_DEFAULTS.inducements],
      ["sideline", { ...DEFAULT_SIDELINE, ...SEVENS_DEFAULTS.sideline }], ["special", { ...DEFAULT_SPECIAL, ...SEVENS_DEFAULTS.special }],
    ]
    : [["starPlayers", DEFAULT_STAR_PLAYERS], ["inducements", DEFAULT_INDUCEMENTS], ["sideline", DEFAULT_SIDELINE], ["special", DEFAULT_SPECIAL]];
  for (const [block, defaults] of blocks) {
    const target = objectAt(pkg, block);
    Object.entries(defaults).forEach(([key, value]) => fill(target, key, value, filled, [block]));
  }
  return pkg as Pkg;
}

export interface Bookkeeping { touched: Set<string>; injected: Set<string> }

/** Drop keys the organiser never touched that normalizePackage() filled in. An edited filled default is always kept,
 *  even when it equals the default: under `extends` an explicit default still overrides the base package's value. */
export function pruneInjected(output: Record<string, unknown>, original: unknown, baseline: unknown, book: Bookkeeping, nested = true, prefix: Path = []): Record<string, unknown> {
  Object.keys(output).forEach((key) => {
    const path = [...prefix, key];
    if (book.touched.has(pathKey(path)) && book.injected.has(pathKey(path))) return;
    const base = isObj(baseline) ? baseline[key] : undefined;
    const present = isObj(original) && Object.prototype.hasOwnProperty.call(original, key);
    const value = output[key];
    if (!present) {
      if (nested && NESTED_PRUNE.has(key) && isObj(value) && isObj(base)) {
        pruneInjected(value, {}, base, book, false, path);
        if (Object.keys(value).length === 0) delete output[key];
      } else if (value === undefined || deepEqual(value, base)) delete output[key];
      return;
    }
    const orig = (original as Record<string, unknown>)[key];
    if (nested && NESTED_PRUNE.has(key) && isObj(value) && isObj(orig)) pruneInjected(value, orig, base, book, false, path);
  });
  return output;
}

/** Record which top-level / nested-block fields an edit changed (compared with the pre-edit snapshot). */
export function recordTouched(before: RawDoc, after: RawDoc, touched: Set<string>): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.forEach((key) => {
    if (deepEqual(before[key], after[key])) return;
    touched.add(pathKey([key]));
    const b = before[key];
    const a = after[key];
    if (NESTED_PRUNE.has(key) && isObj(b) && isObj(a)) {
      new Set([...Object.keys(b), ...Object.keys(a)]).forEach((sub) => {
        if (!deepEqual(b[sub], a[sub])) touched.add(pathKey([key, sub]));
      });
    }
  });
}

/** The organiser interacted with the field at `path`: even when the value equals the filled default it is now theirs. */
export function touchPath(path: Path | null | undefined, touched: Set<string>): void {
  if (!Array.isArray(path) || !path.length) return;
  touched.add(pathKey([path[0]!]));
  if (path.length >= 2 && NESTED_PRUNE.has(String(path[0]))) touched.add(pathKey([path[0]!, path[1]!]));
}

export function inferView(pkg: Pkg): ViewState {
  const allotment = pkg.skillAllotment;
  const skillMode: SkillMode = allotment.maxPrimary != null || allotment.maxSecondary != null ? "count" : "pool";
  const system: System = pkg.matrix?.cells?.length ? "matrix" : pkg.tiers?.length ? "tiers" : pkg.skillPackages?.length ? "packages" : "skillpoints";
  return freshView(system, skillMode);
}

export function fallbackRaw(): RawDoc {
  return {
    name: "",
    ruleset: "bb2025-default",
    eligibleRosters: ["*"],
    skillAllotment: clone(DEFAULT_SKILL_ALLOTMENT),
    goldBudget: null,
    starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: null },
    inducements: { allowed: ["*"], caps: {} },
    sideline: {},
    special: clone(DEFAULT_SPECIAL),
  };
}

export function matrixForDisplay(pkg: Pkg): Matrix {
  const existing: Matrix = pkg.matrix ?? { columns: [], rows: [], cells: [] };
  const columns = [...safeArray<MatrixColumn>(existing.columns)];
  const rows = [...safeArray<MatrixRow>(existing.rows)];
  const defaults = [1150000, 1100000, 1050000];
  const rowDefaults: Array<[number, number]> = [[6, 0], [5, 1], [4, 2]];
  if (columns.length === 0) while (columns.length < 3) columns.push({ gold: defaults[columns.length]! });
  if (rows.length === 0) {
    while (rows.length < 3) {
      const [primary, secondary] = rowDefaults[rows.length]!;
      rows.push({ primary, secondary, secondarySwap: false });
    }
  }
  return { ...existing, columns, rows, cells: safeArray<MatrixCell>(existing.cells) };
}

export function starTierCosts(pkg: Pkg, name: string): Num[] {
  const tierCount = pkg.tiers.length;
  const existing = safeArray<unknown>(pkg.starPlayers.spCostByTier?.[name]);
  const costs: Num[] = existing.slice(0, tierCount).map((value) => (value == null ? null : numberOr(value, null)));
  while (costs.length < tierCount) costs.push(null);
  return costs;
}

export interface SerializeContext { original: RawDoc; baseline: Pkg; view: ViewState; book: Bookkeeping }

export function serializePackage(pkg: Pkg, ctx: SerializeContext): RawDoc {
  const output = clone(pkg);
  output.name = String(output.name ?? "").trim();
  output.ruleset = output.ruleset || "bb2025-default";
  const original = ctx.original;
  const view = ctx.view;
  // Switching the pricing mode / tournament system drops the other mode's data, only when the organiser actually
  // switched away from what the package loaded with; coming back restores the loaded document's own values.
  const restore = (target: Record<string, unknown>, source: unknown, key: string): void => {
    if (isObj(source) && Object.prototype.hasOwnProperty.call(source, key)) target[key] = clone(source[key]);
    else delete target[key];
  };
  if (view.skillModeTouched && view.skillMode === "pool") {
    ["maxPrimary", "maxSecondary", "secondarySwap", "secondarySwapRatio", "secondarySwapMax"].forEach((key) => {
      if (view.initialSkillMode === "pool") restore(output.skillAllotment, original.skillAllotment, key);
      else delete output.skillAllotment[key];
    });
  }
  if (view.systemTouched) {
    const keep = ({ skillpoints: [], tiers: ["tiers"], packages: ["skillPackages"], matrix: ["matrix"] } as Record<System, string[]>)[view.system] ?? [];
    const switched = view.system !== view.initialSystem;
    ["tiers", "skillPackages", "matrix"].forEach((key) => {
      if (keep.includes(key)) return;
      if (switched) delete output[key];
      else restore(output, original, key);
    });
  }
  if (view.system === "matrix") output.matrix = clone(matrixForDisplay(pkg));
  if (view.starCostsTouched) {
    const tierCount = safeArray(output.tiers).length;
    const spCostByTier: Record<string, Num[]> = {};
    Object.entries(output.starPlayers.spCostByTier ?? {}).forEach(([name, values]) => {
      const costs: Num[] = safeArray<unknown>(values).slice(0, tierCount).map((value) => (value == null ? null : numberOr(value, null)));
      while (costs.length < tierCount) costs.push(null);
      if (costs.some((value) => value != null)) spCostByTier[name] = costs;
    });
    if (Object.keys(spCostByTier).length) output.starPlayers.spCostByTier = spCostByTier;
    else delete output.starPlayers.spCostByTier;
  }
  const out = output as Record<string, unknown>;
  OPTIONAL_STRINGS.forEach((key) => {
    if (out[key] === "" && original[key] !== "") delete out[key];
  });
  return pruneInjected(out, original, ctx.baseline, ctx.book);
}

// ---------- generic path access ----------

export function getPath(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((value, key) => (value == null || typeof value !== "object" ? undefined : (value as Record<string | number, unknown>)[key]), root);
}

/** Set (or, with value === undefined, delete) the value at path; creates containers on the way and removes emptied
 *  on-demand containers (LAZY_OBJECTS) after a delete. */
export function setPath(root: object, path: Path, value: unknown): void {
  let target = root as Record<string | number, unknown>;
  const parents: Array<[Record<string | number, unknown>, string | number]> = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    if (target[key] == null || typeof target[key] !== "object") {
      if (value === undefined) return;
      target[key] = typeof path[index + 1] === "number" ? [] : {};
    }
    parents.push([target, key]);
    target = target[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value !== undefined) {
    target[last] = value;
    return;
  }
  if (Array.isArray(target)) return;
  delete target[last];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index]!;
    const child = parent[key];
    if (LAZY_OBJECTS.has(String(key)) && isObj(child) && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
}

// ---------- catalogs ----------

export interface SkillInfo { name: string; category?: string }
export interface StarInfo { name: string; pairedWith?: string; pairPrimary?: boolean }
export interface TeamInfo { name: string; defaultTier?: number | null }
export interface PositionCatalog { race: string; positions: Array<{ name: string; type?: string; keywords?: string[] }> }
export interface StatRuleDoc {
  excludePositions?: Array<{ race?: string; position: string }>; excludeKeywords?: string[];
  blockedStats?: Array<{ stat: string; positions?: Array<{ race?: string; position: string }>; keywords?: string[] }>; maxPerTeam?: number;
}
export interface PresetInfo { id: string; label: string; pkg: RawDoc }

export function pairedStarNames(stars: StarInfo[], name: string): string[] {
  const star = stars.find((s) => s.name === name);
  const partner = star?.pairedWith;
  if (!partner) return [name];
  // Dataset-declared lead star first (pairPrimary), alphabetical fallback.
  const partnerStar = stars.find((s) => s.name === partner);
  return ([[name, star], [partner, partnerStar]] as Array<[string, StarInfo | undefined]>)
    .sort((a, b) => ((b[1]?.pairPrimary ? 1 : 0) - (a[1]?.pairPrimary ? 1 : 0)) || a[0].localeCompare(b[0]))
    .map((entry) => entry[0]);
}

export function groupedStars(stars: StarInfo[], names: string[]): Array<{ names: string[]; label: string }> {
  const available = new Set(names);
  const seen = new Set<string>();
  return names.flatMap((name) => {
    if (seen.has(name)) return [];
    const group = pairedStarNames(stars, name).filter((member) => available.has(member));
    group.forEach((member) => seen.add(member));
    return [{ names: group, label: group.join(" & ") }];
  });
}

export function humanizeId(id: string): string {
  return String(id).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function tierClass(tier: unknown): string {
  return `tier-${Math.max(1, Math.min(4, Number(tier) || 4))}`;
}

/** Schema preflight on open: unknown fields make the package read-only; other schema problems are listed up front. */
export function preflight(schemaProblems: unknown): { readOnly: string; problems: string[] } {
  const problems = safeArray<unknown>(schemaProblems).map(String);
  const unknown = problems
    .map((problem) => problem.match(/^(.*): unknown property (.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => `${m[1] === "$" ? "" : `${m[1]!.replace(/^\$\.?/, "")}.`}${m[2]}`);
  const readOnly = unknown.length ? `This package uses fields this Creator does not know: ${unknown.join(", ")}. Update the Creator before editing.` : "";
  return { readOnly, problems: problems.filter((problem) => !/: unknown property /.test(problem)) };
}

/** Count mode reads "N primary + S secondary" (an unset side is "any"); otherwise the SP budget. */
export function countsLabel(maxPrimary: unknown, maxSecondary: unknown, skillPointBudget: unknown): string {
  if (maxPrimary != null || maxSecondary != null) return `${maxPrimary ?? "any"} primary + ${maxSecondary ?? "any"} secondary`;
  return `${skillPointBudget ?? 0} SP`;
}

export function packsLabel(packs: unknown): string {
  return safeArray<SkillPack>(packs).map((pack) => (pack.maxSkills != null || pack.maxSecondary != null
    ? `${goldLabel(pack.gold)} / ${pack.maxSkills ?? 0} skills${pack.maxSecondary ? ` (up to ${pack.maxSecondary} secondary)` : ""}${pack.starPlayersAllowed === false ? ", no stars" : ""}`
    : `${goldLabel(pack.gold)} / ${pack.skillPointBudget ?? 0} SP`)).join(" · ");
}

/** Gold the way the coach page and the overview text write it: "1,225k". */
export const overviewGold = (gold: unknown): string => `${Math.round(Number(gold) / 1000).toLocaleString("en-US")}k`;
