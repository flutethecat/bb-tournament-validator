// Tournament Builder controller (/app/tournament-team-builder, owner 10-30): the coach-facing team builder against a
// tournament ruleset, migrated from public/tournament-team-builder.html. No DOM: the view renders `state` and calls the
// methods. The rules gates, pick wire, tier tables and sheet model come from the shared pure core (builderCore.ts, the
// same code the vanilla page runs); the server preview (POST /api/fork/team-builder/preview) is the authority on legality.
//
// Endpoints: GET /api/fork/rosters, /api/packages, /api/packages/<name>?roster=, /api/fork/team-builder/tiers,
// /inducements, /legal-skills, /limits (Blood Bowl Sevens only), /api/skills, the art manifests; POST /preview, /build;
// saves (GET/POST/PUT /api/fork/team-builder/saves[/<id>]) and share links (POST/DELETE /saves/<id>/share).
//
// Blood Bowl Sevens (spec 11-02, Roster Builder lane): a Sevens ruleset (the "Sevens Free Create" marker, or any package
// whose resolved format is "sevens") reads its limits from GET /api/fork/team-builder/limits (effectiveRosterLimits, the
// validator's own resolution): player count, budget, the non-Lineman cap, the Veteran, staff prices and caps, the skill
// knobs. Nothing Sevens is hard-coded here; standard packages never fetch limits and keep the standard behaviour.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { shortPositionName } from "../../../src/positionNames";
import {
  core,
  type Access, type BuilderPosition, type BuilderRoster, type CrestManifest, type GateContext, type IconManifest, type InducementItem,
  type InducementTeam, type LeagueSelection, type LegalSet, type Overview, type RaceRules, type SheetModel, type SkillCosts, type SkillPack,
  type Slot, type SpriteManifest, type Staff, type Stat, type StarChoice, type StarContext, type StatRules, type TierRules,
} from "./builderCore";
import { sanitizeSkillSystem, sheetRulesetRows, type PrintSheetModel, type SheetSkillSystem } from "./sheetRuleset";
import { CHARACTERISTIC_VALUE } from "../../../src/characteristicValue";
import {
  FREE_CREATE_DESCRIPTION, FREE_CREATE_LABEL, FREE_CREATE_PACKAGE, freeCreateSkillGold, freeCreateStatGold, statCapReason,
  SEVENS_FREE_CREATE_DESCRIPTION, SEVENS_FREE_CREATE_LABEL, SEVENS_FREE_CREATE_PACKAGE,
} from "../../../src/freeCreate";
import { TEAM_BUILDER_BODY_BOUNDS } from "../../../src/teamBuilderWire";
import { cleanStatIncreaseRules, statRuleBlock, teamCapBlock, type StatIncreaseRules } from "../../../../../packages/bb-validator/src/cost/statRules";
import { cleanPlayerName, PLAYER_NAME_MAX, randomPlayerName } from "../../../src/playerNames";
export { PLAYER_NAME_MAX };

// ── wire shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PackageRow { name: string; description: string; format?: "sevens" }
export interface PackageDoc { description: string; dataNote: string; eligibleRosters: string[] }
export interface TierSummaryRow { tier: number | null; label: string; rosters: string[]; gold: number | null; skillPointBudget: number | null; packs: SkillPack[] }
export interface PackageRules {
  name: string;
  dataNote?: string;
  budget: number | null;
  overview: Overview | null;
  tierSummary: TierSummaryRow[];
  race?: RaceRules;
}
/** A /tiers row (one per race): name, tier, gold cap and the tier knobs (read only through core.normalizeTierRules). */
export interface TierRow { name: string; tier: number | null; gold: number | null; raw: Record<string, unknown> }
export interface PreviewResult {
  rosterId: string;
  /** docKey() of the document this verdict was computed for: a verdict only counts for that exact document. */
  doc: string;
  valid: boolean;
  failed?: boolean;
  errors: unknown[];
  warnings: unknown[];
  summary: Record<string, number> | null;
  package: { name: string; description?: string; budget: number | null; rules?: Record<string, unknown> } | null;
}
export interface SkillMeta { category: string; elite: boolean }
export interface CurrentSave { id: string; name: string; shareToken?: string }
export interface BuildResult { ok: boolean; title: string; lines: string[] }
export interface ArtState { sprites: SpriteManifest | null; crests: CrestManifest | null; icons: IconManifest | null; skillIcons: IconManifest | null; uiIcons: IconManifest | null }

/** One staff line of the package's limits (GET /api/fork/team-builder/limits): gold per unit and the cap (null = none). */
export interface LimitsStaffRow { price: number; max: number | null }
/** The race's effective limits under a Sevens package (bb-validator effectiveRosterLimits, field-by-field copy). */
export interface BuilderLimits {
  format: "standard" | "sevens";
  budget: number | null;
  minPlayers: number;
  maxPlayers: number;
  maxNonLineman: number | null;
  nonLinemanPositions: string[];
  veteran: { eligiblePositions: string[]; maDelta: number } | null;
  staffPriced: boolean;
  staff: {
    reRolls: LimitsStaffRow; assistantCoaches: LimitsStaffRow; cheerleaders: LimitsStaffRow; apothecary: LimitsStaffRow;
    dedicatedFans: LimitsStaffRow & { start: number; min: number };
  };
  starPlayersAllowed: boolean;
  inducementSet: "core" | "sevens";
  skills: {
    tier: number | null; maxPrimary: number | null; maxSecondary: number | null; secondarySwap: boolean; secondarySwapRatio: number;
    secondarySwapMax: number | null; skillPointBudget: number; maxPerPlayer: number | null; eliteMaxTotal: number | null;
    gold: { primary: number; secondary: number; elitePrimary: number; eliteSecondary: number };
  };
}
/** Sevens copy (spec 11-02): the hire cap, the missing-Veteran notice, the fork refusal and the star bar. */
export const nonLinemanReason = (max: number): string => `Sevens: at most ${max} players without the Lineman keyword.`;
export const VETERAN_MISSING = "Pick one Lineman as your Veteran (MA −1, one reroll a game).";
export const SEVENS_TABLETOP_NOTE = "Sevens teams are tabletop only.";
export const SEVENS_NO_STARS = "Sevens has no Star Players or Mercenaries.";
export { SEVENS_FREE_CREATE_PACKAGE, SEVENS_FREE_CREATE_LABEL, SEVENS_FREE_CREATE_DESCRIPTION };

/** The builder request body (TeamBuilderBody) the preview, build and saves take. */
export interface BuilderBody {
  teamId?: string;
  rosterId: string;
  coach: string;
  teamName: string;
  picks: ReturnType<typeof core.buildPicks>;
  reRolls: number;
  apothecary: boolean;
  assistantCoaches: number;
  cheerleaders: number;
  dedicatedFans: number;
  packageName?: string;
  skillPack?: string;
  specialRule?: string;
  rosteredInducements?: Array<{ key: string; count: number }>;
  /** Free Create only: "Ignore in-game limits" is ticked (stored with the save; the server never validates by it). */
  ignoreLimits?: boolean;
}

export type BuilderTab = "ruleset" | "roster" | "sheet";
export const BUILDER_TABS: ReadonlyArray<{ id: BuilderTab; label: string }> = [
  { id: "ruleset", label: "Ruleset" },
  { id: "roster", label: "Roster" },
  { id: "sheet", label: "Sheet" },
];
export const isBuilderTab = (v: unknown): v is BuilderTab => BUILDER_TABS.some((t) => t.id === v);
/** Deep links from before the one working pane (owner 10-30): the old Skills, Staff, Stars and Inducements tabs are all on Roster now. */
const OLD_ROSTER_TABS = new Set(["skills", "staff", "stars", "inducements"]);
export function toBuilderTab(v: unknown): BuilderTab | null {
  return typeof v === "string" && OLD_ROSTER_TABS.has(v) ? "roster" : isBuilderTab(v) ? v : null;
}

/** The Roster pane's left accordion (owner 10-31): four panels in this fixed order, one open at a time (null = Hireable players).
 *  The open panel lives on the controller, so it survives the page's own address moves for the page session. */
export type LeftPanel = "hire" | "staff" | "inducements" | "stars";
export const LEFT_PANELS: ReadonlyArray<LeftPanel> = ["hire", "staff", "inducements", "stars"];

/** Sideline staff (BB2025 costs; rerolls priced per roster). */
export interface StaffRow { key: keyof Staff; label: string; min: number; max: number; cost: number; free: number }
export function staffRows(roster: BuilderRoster | null, limits: BuilderLimits | null = null): StaffRow[] {
  // A package that prices staff (Blood Bowl Sevens): every price, cap and the free Dedicated Fans from its limits. The
  // fallbacks only cover a cap the package leaves open (null) and are the standard UI ranges.
  if (limits?.staffPriced) {
    const s = limits.staff;
    return [
      { key: "reRolls", label: "Rerolls", min: 0, max: s.reRolls.max ?? roster?.maxReRolls ?? 8, cost: s.reRolls.price, free: 0 },
      { key: "assistantCoaches", label: "Assistant Coaches", min: 0, max: s.assistantCoaches.max ?? 6, cost: s.assistantCoaches.price, free: 0 },
      { key: "cheerleaders", label: "Cheerleaders", min: 0, max: s.cheerleaders.max ?? 12, cost: s.cheerleaders.price, free: 0 },
      { key: "dedicatedFans", label: "Dedicated Fans", min: s.dedicatedFans.min, max: s.dedicatedFans.max ?? 7, cost: s.dedicatedFans.price, free: s.dedicatedFans.start },
      { key: "apothecary", label: "Apothecary", min: 0, max: s.apothecary.max ?? 1, cost: s.apothecary.price, free: 0 },
    ];
  }
  return [
    { key: "reRolls", label: "Rerolls", min: 0, max: roster?.maxReRolls ?? 8, cost: roster?.reRollCost ?? 0, free: 0 },
    { key: "assistantCoaches", label: "Assistant Coaches", min: 0, max: 6, cost: 10_000, free: 0 },
    { key: "cheerleaders", label: "Cheerleaders", min: 0, max: 12, cost: 10_000, free: 0 },
    { key: "dedicatedFans", label: "Dedicated Fans", min: 1, max: 7, cost: 10_000, free: 1 },
    { key: "apothecary", label: "Apothecary", min: 0, max: 1, cost: 50_000, free: 0 },
  ];
}
/** Staff icons: the UI glyph set, else the matching inducement art (same mapping as the vanilla page). */
export const STAFF_ICONS: Record<keyof Staff, ["ui" | "inducements", string]> = {
  reRolls: ["ui", "re_roll"],
  assistantCoaches: ["inducements", "part_time_assistant_coaches"],
  cheerleaders: ["inducements", "temp_agency_cheerleaders"],
  dedicatedFans: ["ui", "dedicated_fans"],
  apothecary: ["ui", "apothecary"],
};

const freshStaff = (): Staff => ({ reRolls: 0, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, apothecary: 0 });
const PREVIEW_COACH = "Guest"; // preview-only stand-in while signed out (preview is non-mutating)
/** Sample packages shipped for tests/docs are never offered to coaches. */
export const isExamplePackage = (name: unknown): boolean => /\((example|sample)\)\s*$/i.test(String(name ?? ""));
export const SAVE_ID_RE = /^[\w-]{1,64}$/;

// ── Free Create (owner 10-31) ─────────────────────────────────────────────────────────────────────────────────────
// Not a package: the marker FREE_CREATE_PACKAGE (src/freeCreate.ts) in state.packageName. Any base BB2025 race, the race's
// own roster limits (position maxes, 16 players, star pairing, league star eligibility) and nothing else: no budget, tier,
// skill points, packs, caps or bans, and no preview (no site validation at all). Skills from the position's primary or
// secondary access at the core's flat gold (core.SKILL_GOLD: 20k / 40k / elite +10k, the site's league fallback pricing),
// stat increases at CHARACTERISTIC_VALUE (src/characteristicValue.ts, the league table). "Ignore in-game limits" (Free
// Create only) lifts position maxes, skill access and the stat limit and offers every star the fork lists; 16 players
// stays the limit (owner 10-31).
export { FREE_CREATE_PACKAGE, FREE_CREATE_LABEL, FREE_CREATE_DESCRIPTION };
/** Packages the Roster Builder no longer offers as cards (owner 10-31: Free Create replaces BB2025 Default). Deep links
 *  and saves that name them keep working; the Tournament Creator's presets still use the package. */
/** Added skills one player may carry: the server's save and build bound (teamBuilderWire.ts skillsPerPick), which Free
 *  Create's open gates would otherwise run past. */
export const MAX_SKILLS_PER_PLAYER = TEAM_BUILDER_BODY_BOUNDS.skillsPerPick;
/** The elite-skill diamond (owner-supplied pixel art from the Super FUMBBL client; tools/art/elite-diamond/PROVENANCE.md). */
export const ELITE_ICON = "/icons/builder/elite-diamond.png";
export const HIDDEN_RULESET_CARDS: ReadonlySet<string> = new Set(["BB2025 Default"]);
/** `free`: a marker card (Free Create / Sevens Free Create) with its one-line description; `sevens`: a Sevens ruleset. */
export interface RulesetCard { name: string; label: string; description: string; free: boolean; sevens: boolean }
/** Free Create stat increases: one per player (each characteristic once while limits are ignored); skills and stats combine. */
const freeStatRules = (ignore: boolean): StatRules => ({
  allowed: true, stats: [...core.STATS], costGold: { ...CHARACTERISTIC_VALUE }, maxPerPlayer: ignore ? core.STATS.length : 1, exclusiveWithSkills: false,
});

// ── ingestion (field-by-field copies; never spread a server object) ───────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const sv = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const n0 = (v: unknown, fallback: number | null = null): number | null => core.num(v) ?? fallback;
const nn = (v: unknown, fallback: number): number => core.num(v) ?? fallback;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(sv) : []);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cell = (v: unknown): number | string => core.num(v) ?? sv(v);

export function sanitizeRoster(raw: unknown): BuilderRoster {
  const r = isRec(raw) ? raw : {};
  return {
    rosterId: sv(r.rosterId),
    raceName: sv(r.raceName),
    reRollCost: nn(r.reRollCost, 0),
    maxReRolls: nn(r.maxReRolls, 8),
    apothecaryAllowed: r.apothecaryAllowed !== false,
    leagueOptions: strList(r.leagueOptions),
    ...(Array.isArray(r.specialRules) ? { specialRules: strList(r.specialRules) } : {}),
    ...(Array.isArray(r.alwaysOnRules) ? { alwaysOnRules: strList(r.alwaysOnRules) } : {}),
    positions: arr(r.positions).map((p): BuilderPosition => {
      const q = isRec(p) ? p : {};
      return {
        positionId: sv(q.positionId), name: sv(q.name), type: sv(q.type), cost: nn(q.cost, 0), max: nn(q.max, 0),
        MA: cell(q.MA), ST: cell(q.ST), AG: sv(q.AG), PA: sv(q.PA), AV: sv(q.AV), skills: strList(q.skills),
        ...(Array.isArray(q.skillsDisplay) ? { skillsDisplay: strList(q.skillsDisplay) } : {}),
        ...(Array.isArray(q.keywords) ? { keywords: strList(q.keywords) } : {}),
        isStar: q.isStar === true, playsFor: strList(q.playsFor),
        ...(q.teamWithPositionId ? { teamWithPositionId: sv(q.teamWithPositionId) } : {}),
      };
    }),
    ...(Array.isArray(r.positionGroups)
      ? { positionGroups: r.positionGroups.map((g) => { const q = isRec(g) ? g : {}; return { positions: strList(q.positions), max: nn(q.max, 0), label: sv(q.label) }; }) }
      : {}),
  };
}
function sanitizePack(raw: unknown): SkillPack {
  const p = isRec(raw) ? raw : {};
  return {
    label: sv(p.label), gold: n0(p.gold), skillPointBudget: nn(p.skillPointBudget, 0), maxPerPlayer: n0(p.maxPerPlayer),
    maxSkills: n0(p.maxSkills), maxSecondary: n0(p.maxSecondary), ...(p.starPlayersAllowed === false ? { starPlayersAllowed: false as const } : {}),
  };
}
function sanitizeSkillCosts(raw: unknown): SkillCosts | undefined {
  if (!isRec(raw)) return undefined;
  const d = core.DEFAULT_SKILL_COSTS;
  return {
    primary: nn(raw.primary, d.primary), secondary: nn(raw.secondary, d.secondary), eliteSurcharge: nn(raw.eliteSurcharge, 0),
    stackSurcharge: nn(raw.stackSurcharge, 0), eliteSkills: strList(raw.eliteSkills),
  };
}
export function sanitizePackageRules(raw: unknown): PackageRules | null {
  if (!isRec(raw) || !Array.isArray(raw.tierSummary)) return null;
  const race = isRec(raw.race) ? raw.race : null;
  const stars = race && isRec(race.stars) ? race.stars : null;
  return {
    name: sv(raw.name),
    ...(raw.dataNote ? { dataNote: sv(raw.dataNote) } : {}),
    budget: n0(raw.budget),
    overview: core.normalizeOverview(raw.overview),
    tierSummary: raw.tierSummary.map((t) => {
      const q = isRec(t) ? t : {};
      return { tier: n0(q.tier), label: sv(q.label), rosters: strList(q.rosters), gold: n0(q.gold), skillPointBudget: n0(q.skillPointBudget), packs: arr(q.packs).map(sanitizePack) };
    }),
    ...(race ? {
      race: {
        roster: sv(race.roster), source: sv(race.source), tierNumber: n0(race.tierNumber), ...(race.tierLabel ? { tierLabel: sv(race.tierLabel) } : {}),
        gold: n0(race.gold), skillPointBudget: nn(race.skillPointBudget, 0), ...(sanitizeSkillCosts(race.skillCosts) ? { skillCosts: sanitizeSkillCosts(race.skillCosts) } : {}),
        maxPerPlayer: n0(race.maxPerPlayer), packs: arr(race.packs).map(sanitizePack), bannedStars: strList(race.bannedStars),
        ...sanitizeSkillSystem(race.skillSystem), // the team sheet's ruleset box (sheetRuleset.ts)
        ...(stars ? {
          stars: {
            allowed: stars.allowed !== false, maxCount: n0(stars.maxCount), paidInSkillPoints: stars.paidInSkillPoints === true,
            ...(Array.isArray(stars.spCosts) ? { spCosts: stars.spCosts.map((s) => { const q = isRec(s) ? s : {}; return { name: sv(q.name), sp: nn(q.sp, 0) }; }) } : {}),
          },
        } : {}),
      },
    } : {}),
  };
}
export function sanitizeLimits(raw: unknown): BuilderLimits | null {
  if (!isRec(raw)) return null;
  const st = isRec(raw.staff) ? raw.staff : {};
  const row = (v: unknown): LimitsStaffRow => { const q = isRec(v) ? v : {}; return { price: nn(q.price, 0), max: n0(q.max) }; };
  const fans = isRec(st.dedicatedFans) ? st.dedicatedFans : {};
  const vet = isRec(raw.veteran) ? raw.veteran : null;
  const sk = isRec(raw.skills) ? raw.skills : {};
  const g = isRec(sk.gold) ? sk.gold : {};
  return {
    format: raw.format === "sevens" ? "sevens" : "standard",
    budget: n0(raw.budget),
    minPlayers: nn(raw.minPlayers, 11),
    maxPlayers: nn(raw.maxPlayers, core.MAX_PLAYERS),
    maxNonLineman: n0(raw.maxNonLineman),
    nonLinemanPositions: strList(raw.nonLinemanPositions),
    veteran: vet ? { eligiblePositions: strList(vet.eligiblePositions), maDelta: nn(vet.maDelta, -1) } : null,
    staffPriced: raw.staffPriced === true,
    staff: {
      reRolls: row(st.reRolls), assistantCoaches: row(st.assistantCoaches), cheerleaders: row(st.cheerleaders), apothecary: row(st.apothecary),
      dedicatedFans: { ...row(fans), start: nn(fans.start, 1), min: nn(fans.min, 0) },
    },
    starPlayersAllowed: raw.starPlayersAllowed === true,
    inducementSet: raw.inducementSet === "sevens" ? "sevens" : "core",
    skills: {
      tier: n0(sk.tier), maxPrimary: n0(sk.maxPrimary), maxSecondary: n0(sk.maxSecondary), secondarySwap: sk.secondarySwap === true,
      secondarySwapRatio: nn(sk.secondarySwapRatio, 2), secondarySwapMax: n0(sk.secondarySwapMax), skillPointBudget: nn(sk.skillPointBudget, 0),
      maxPerPlayer: n0(sk.maxPerPlayer), eliteMaxTotal: n0(sk.eliteMaxTotal),
      gold: { primary: nn(g.primary, 0), secondary: nn(g.secondary, 0), elitePrimary: nn(g.elitePrimary, 0), eliteSecondary: nn(g.eliteSecondary, 0) },
    },
  };
}
function sanitizeTierRow(raw: unknown): TierRow | null {
  if (!isRec(raw)) return null;
  return { name: sv(raw.name), tier: n0(raw.tier), gold: n0(raw.gold ?? raw.goldCap ?? raw.budget), raw };
}
function sanitizeInducement(raw: unknown): InducementItem {
  const i = isRec(raw) ? raw : {};
  return {
    key: sv(i.key), label: sv(i.label ?? i.key), price: nn(i.price, 0), max: n0(i.max), allowed: i.allowed === true,
    reducedPrice: n0(i.reducedPrice), reducedMax: n0(i.reducedMax),
    reducedSpecialRule: typeof i.reducedSpecialRule === "string" ? i.reducedSpecialRule : null,
    reducedRoster: typeof i.reducedRoster === "string" ? i.reducedRoster : null,
    rosterOnly: Array.isArray(i.rosterOnly) ? i.rosterOnly.map(String) : null,
  };
}
function sanitizeSummary(raw: unknown): Record<string, number> | null {
  if (!isRec(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) { const n = core.num(v); if (n !== null) out[k] = n; }
  return out;
}
function sanitizeEcho(raw: unknown): PreviewResult["package"] {
  if (!isRec(raw)) return null;
  return { name: sv(raw.name), ...(raw.description ? { description: sv(raw.description) } : {}), budget: n0(raw.budget), ...(isRec(raw.rules) ? { rules: raw.rules } : {}) };
}
const legalList = (v: unknown) => arr(v).filter(isRec).map((e) => ({ skill: sv(e.skill), ...(e.category ? { category: sv(e.category) } : {}), ...(e.elite === true ? { elite: true } : {}) }));

/** A validator finding as text (string, or { message|text, suggestion }). */
export function findingText(finding: unknown): string {
  if (typeof finding === "string") return finding;
  if (isRec(finding)) {
    const text = sv(finding.message || finding.text || JSON.stringify(finding));
    return finding.suggestion ? `${text} — ${sv(finding.suggestion)}` : text;
  }
  return String(finding);
}

/** Skill Key colour class for a dataset category (same mapping as the vanilla page and team-view.js). */
export function categoryClass(category: unknown): string {
  const k = String(category || "").toLowerCase();
  if (k.startsWith("gen")) return "skill-general";
  if (k.startsWith("agi")) return "skill-agility";
  if (k.startsWith("str")) return "skill-strength";
  if (k.startsWith("pass") || k.startsWith("dev")) return "skill-passing";
  if (k.startsWith("mut")) return "skill-mutation";
  return "skill-trait";
}
const CATEGORY_ORDER = ["str", "gen", "agi", "pass", "dev", "mut"];
const categoryRank = (c: string): number => { const k = c.toLowerCase(); const i = CATEGORY_ORDER.findIndex((p) => k.startsWith(p)); return i < 0 ? CATEGORY_ORDER.length : i; };
export interface PickerSkill { skill: string; category: string; elite: boolean; innate?: boolean }
export interface PickerGroup { category: string; skills: PickerSkill[] }
export function groupByCategory(skills: PickerSkill[]): PickerGroup[] {
  const map = new Map<string, PickerSkill[]>();
  for (const s of skills) { const c = s.category || "Trait"; if (!map.has(c)) map.set(c, []); map.get(c)!.push(s); }
  return [...map.entries()]
    .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, list]) => ({ category, skills: list.sort((x, y) => x.skill.localeCompare(y.skill)) }));
}
const bare = (skill: string): string => String(skill).replace(/\s*\(.*\)\s*$/, "").replace(/\*+$/, "").trim();

/** The vendored PDF builder (public/sheet-pdf.js, window.SheetPdf). */
export interface SheetPdfApi {
  loadPdfMake(): Promise<{ createPdf(doc: unknown): { getBlob(): Promise<Blob> } }>;
  abandonPdfMakeLoad?(): void;
  buildSheetDocDefinition(model: SheetModel, opts: { gold: (v: unknown) => string; generatedOn: Date }): unknown;
  sheetPdfFileName(htmlFileName: string): string;
}

export interface BuilderDeps {
  api: Fetcher;
  /** The Discord-signed-in coach ("" signed out). */
  coach: () => string;
  /** Session organizer flag (a built save edits its fork team only for organizers, as the vanilla page). */
  organizer?: () => boolean;
  onSignedOut?: () => void;
  /** Debounce for the live preview (ms); tests pass 0 and call flushPreview(). */
  previewDelay?: number;
  /** Random source for generated player names (tests pass a seeded one). */
  random?: () => number;
  /** Lazy loader for /sheet-pdf.js (+ pdfmake); the browser default inserts the script once. */
  loadSheetPdf?: () => Promise<SheetPdfApi>;
  saveBlob?: (blob: Blob, fileName: string) => void;
  /** Print fallback when the PDF cannot be built (the view prints the sheet host). */
  print?: () => void;
  origin?: () => string;
  clipboard?: (text: string) => Promise<void>;
}

export interface BuilderState {
  booted: boolean;
  bootError: string;
  packages: PackageRow[];
  rosters: BuilderRoster[];
  packageName: string;
  packageDoc: PackageDoc | null;
  packageRules: PackageRules | null;
  tierRows: TierRow[];
  roster: BuilderRoster | null;
  teamName: string;
  league: LeagueSelection;
  leagueNotice: string;
  slots: Slot[];
  staff: Staff;
  skillPack: string | null;
  inducementCatalog: InducementItem[];
  inducementCounts: Record<string, number>;
  inducementStatus: string;
  preview: PreviewResult | null;
  previewPending: boolean;
  skillCatalog: Record<string, SkillMeta> | null;
  legal: Record<string, LegalSet>;
  art: ArtState;
  status: string;
  statusError: boolean;
  currentSave: CurrentSave | null;
  savesStatus: string;
  saveBusy: boolean;
  shareBusy: boolean;
  shareUrl: string;
  editingTeamId: string | null;
  buildBusy: boolean;
  buildResult: BuildResult | null;
  pdfBusy: boolean;
  /** The sheet the print fallback shows (rosterSheetHtml markup). */
  printHtml: string;
  /** The left accordion's open panel (null = the default, Hireable players). */
  leftPanel: LeftPanel | null;
  /** Free Create only: "Ignore in-game limits". */
  ignoreLimits: boolean;
  /** The ruleset's resolved format ("sevens" for the Sevens Free Create marker and any Sevens package). */
  packageFormat: "standard" | "sevens";
  /** Blood Bowl Sevens: the chosen race's effective limits (null until a race is picked, and for standard rulesets). */
  limits: BuilderLimits | null;
  /** Blood Bowl Sevens: the rosters the ruleset admits (the /limits route's eligibleRosters). */
  sevensEligible: string[];
}

function blankState(): BuilderState {
  return {
    booted: false, bootError: "", packages: [], rosters: [], packageName: "", packageDoc: null, packageRules: null, tierRows: [],
    roster: null, teamName: "", league: { selectedLeague: "", explicit: false }, leagueNotice: "", slots: [], staff: freshStaff(), skillPack: null,
    inducementCatalog: [], inducementCounts: {}, inducementStatus: "", preview: null, previewPending: false, skillCatalog: null, legal: {},
    art: { sprites: null, crests: null, icons: null, skillIcons: null, uiIcons: null }, status: "", statusError: false,
    currentSave: null, savesStatus: "", saveBusy: false, shareBusy: false, shareUrl: "", editingTeamId: null, buildBusy: false, buildResult: null,
    pdfBusy: false, printHtml: "", leftPanel: "hire", ignoreLimits: false, packageFormat: "standard", limits: null, sevensEligible: [],
  };
}

const SHEET_PDF_TIMEOUT_MS = 20_000;
let sheetPdfScript: Promise<SheetPdfApi> | null = null;
/** Browser default: insert /sheet-pdf.js once (it then loads the vendored pdfmake + Roboto on first export). */
function browserLoadSheetPdf(): Promise<SheetPdfApi> {
  const ready = (): SheetPdfApi | undefined => (globalThis as unknown as { SheetPdf?: SheetPdfApi }).SheetPdf;
  if (ready()) return Promise.resolve(ready()!);
  if (!sheetPdfScript) {
    sheetPdfScript = new Promise<SheetPdfApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/sheet-pdf.js";
      script.onload = () => (ready() ? resolve(ready()!) : reject(new Error("sheet-pdf.js did not load")));
      script.onerror = () => { script.remove(); sheetPdfScript = null; reject(new Error("Could not load /sheet-pdf.js")); };
      document.head.appendChild(script);
    });
  }
  return sheetPdfScript;
}
function browserSaveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STAT_KEYS = ["MA", "ST", "AG", "PA", "AV"] as const;
export const STATS_OFF_REASON = "This ruleset doesn't allow stat increases.";
export function createTournamentBuilder(deps: BuilderDeps) {
  const api = deps.api;
  const state = reactive<BuilderState>(blankState());
  const delay = deps.previewDelay ?? 300;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewSequence = 0;
  let rulesSequence = 0;
  let inducementSequence = 0;
  /** Every restore and every setup choice bumps this; a restore that finds it changed after an await abandons itself. */
  let generation = 0;

  // ── derived ───────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Free Create is the open ruleset (no package). */
  const free = (): boolean => state.packageName === FREE_CREATE_PACKAGE;
  /** Free Create with "Ignore in-game limits" ticked. */
  const ignoring = (): boolean => free() && state.ignoreLimits;
  /** Sevens Free Create (spec 11-02, owner Q1 (c)): a marker like Free Create, but the Sevens limits are validated. */
  const sevensFree = (): boolean => state.packageName === SEVENS_FREE_CREATE_PACKAGE;
  /** Any Blood Bowl Sevens ruleset (the marker, or a package whose resolved format is "sevens"). */
  const sevens = (): boolean => sevensFree() || state.packageFormat === "sevens";
  /** The chosen race's Sevens limits (null for standard rulesets and before a race is picked). */
  const limits = (): BuilderLimits | null => (sevens() && state.roster ? state.limits : null);
  /** The roster's player cap: the package's (Sevens 11), else the standard 16. */
  const maxPlayers = (): number => limits()?.maxPlayers ?? core.MAX_PLAYERS;
  /** Every star player the fork's base rosters list (one entry per positionId): the Ignore in-game limits star pool. */
  const allStars = (): BuilderPosition[] => {
    const seen = new Map<string, BuilderPosition>();
    for (const r of state.rosters) for (const p of r.positions) if (p.isStar && !seen.has(p.positionId)) seen.set(p.positionId, p);
    return [...seen.values()];
  };
  const positionById = (id: string): BuilderPosition | null =>
    state.roster?.positions.find((p) => p.positionId === id) ?? (ignoring() && state.roster ? allStars().find((p) => p.positionId === id) ?? null : null);
  /** The positions stars are paired / added from: the race's own, plus every other star while limits are ignored. */
  const starPool = (): BuilderPosition[] => {
    const own = state.roster?.positions ?? [];
    if (!ignoring()) return own;
    const ids = new Set(own.map((p) => p.positionId));
    return [...own, ...allStars().filter((p) => !ids.has(p.positionId))];
  };
  const captainRules = (): string[] => (state.roster ? [...(state.roster.specialRules ?? []), ...(state.roster.alwaysOnRules ?? [])] : []);
  const captainAvailable = (): boolean => core.rosterHasCaptain(captainRules());
  const slotCanCaptain = (slot: Slot | undefined): boolean => Boolean(slot) && core.canCaptain(positionById(slot!.positionId), captainRules());
  const leagueOptions = (): string[] => core.normalizeLeagueOptions(state.roster?.leagueOptions);
  const leaguePresentation = () => core.leagueFieldPresentation(leagueOptions(), state.league);
  const activeLeague = (): string => (leaguePresentation().selectedValid ? state.league.selectedLeague : "");
  const selectedSpecialRule = (): string | undefined => core.explicitLeagueSpecialRule(leagueOptions(), state.league);
  const raceRules = (): RaceRules | null => (state.roster ? state.packageRules?.race ?? null : null);
  const ownTierRow = (): TierRow | undefined => (state.roster ? state.tierRows.find((r) => core.norm(r.name) === core.norm(state.roster!.raceName)) : undefined);
  /** Tier knobs for the current race: the authoritative preview echo first, then the /tiers row. */
  const tierRules = (): TierRules | null => (free() ? null : core.normalizeTierRules(state.preview?.package?.rules) ?? core.normalizeTierRules(ownTierRow()?.raw));
  const statRules = (): StatRules | null => (free() ? freeStatRules(state.ignoreLimits) : statsRuleAllowed() ? tierRules()?.statIncreases ?? null : null);
  const allowedStats = (): string[] => core.allowedStatList(statRules());
  /** The package's master switch for stat increases ("Allow stat increases" in the Tournament Creator; Free Create is always on).
   *  Only an explicit false from the server counts as off, so a server that doesn't send it keeps the knob-driven behaviour. */
  /** The package's granular rules (who may not, blocked stats, per-team cap), as the server cleaned them; null for none / Free Create. */
  const statRuleSet = (): StatIncreaseRules | null => {
    if (free()) return null;
    const raw = (state.preview?.package?.rules as { statIncreaseRules?: unknown } | undefined)?.statIncreaseRules
      ?? (ownTierRow()?.raw as { statIncreaseRules?: unknown } | undefined)?.statIncreaseRules;
    return cleanStatIncreaseRules(raw);
  };
  /** The stat increases a player carries: all of them, whatever the rules now say. A saved roster whose package has since
   *  turned them off keeps showing them (removable) and keeps them on save; the validator reports them as rule violations. */
  const heldStats = (slot: Slot): string[] => slot.chosenStatIncreases.filter((k) => (STAT_KEYS as readonly string[]).includes(k));
  /** The dataset's name for this race, from the server (race-scoped rules are canonical, like the validator's findRoster). */
  const statRulesRace = (): string => {
    const raw = (state.preview?.package?.rules as { statRulesRace?: unknown } | undefined)?.statRulesRace ?? (ownTierRow()?.raw as { statRulesRace?: unknown } | undefined)?.statRulesRace;
    return typeof raw === "string" && raw ? raw : state.roster?.raceName ?? "";
  };
  const teamStatIncreases = (): number => state.slots.filter((sl) => !isStarSlot(sl)).reduce((n, sl) => n + heldStats(sl).length, 0);
  const statsRuleAllowed = (): boolean => {
    if (free()) return true;
    const flag = (state.preview?.package?.rules as { statIncreasesAllowed?: unknown } | undefined)?.statIncreasesAllowed
      ?? (ownTierRow()?.raw as { statIncreasesAllowed?: unknown } | undefined)?.statIncreasesAllowed;
    return flag !== false;
  };
  const packSummary = (): SkillPack | null => {
    const race = raceRules();
    return race && state.skillPack ? race.packs.find((p) => p.label === state.skillPack) ?? null : null;
  };
  /** The team's added-skill allowance where the ruleset fixes one, in order: the chosen pack's caps; the race's count limits
   *  (skillSystem count mode: tier / team rule / matrix maxPrimary / maxSecondary); the tier's secondary cap; null = no fixed
   *  allowance (e.g. pure skill points). */
  const skillAllowance = (): { primary: number | null; secondary: number | null } => {
    const pack = packSummary();
    const tierSecondary = tierRules()?.maxSecondary ?? null;
    if (pack) return { primary: pack.maxSkills ?? null, secondary: pack.maxSecondary ?? tierSecondary };
    const system = (raceRules() as { skillSystem?: SheetSkillSystem } | null)?.skillSystem;
    if (system?.mode === "count") return { primary: system.maxPrimary, secondary: system.maxSecondary ?? tierSecondary };
    return { primary: null, secondary: tierSecondary };
  };
  const skillMeta = (skill: string): SkillMeta | null => state.skillCatalog?.[skill] ?? null;
  const isElite = (skill: string): boolean => core.isEliteSkill(skill, raceRules()?.skillCosts?.eliteSkills, skillMeta(skill));
  const legalKey = (positionId: string): string => `${state.roster?.rosterId}:${positionId}`;
  const legalSet = (positionId: string): LegalSet | null => state.legal[legalKey(positionId)] ?? null;
  function accessOf(positionId: string, skill: string): Access {
    const set = legalSet(positionId);
    if (set?.primary.some((e) => e.skill === skill)) return "primary";
    if (set?.secondary.some((e) => e.skill === skill)) return "secondary";
    // Ignore in-game limits: a skill outside the position's access prices (and reads) as a secondary.
    if (set && ignoring()) return "secondary";
    return "primary";
  }
  const gateCtx = (): GateContext => ({
    // Ignore in-game limits runs the core's open ("custom") gates: any skill, no per-player or stacking caps.
    mode: ignoring() ? "custom" : "tournament", slots: state.slots, positionById, tierRules: tierRules(), raceRules: raceRules(), packSummary: packSummary(),
    legal: legalSet, isElite, accessOf, statRules: statRules(), allowedStats: allowedStats(), captainRules: captainRules(),
  });
  const starCtx = (): StarContext => ({
    mode: "tournament", positions: state.roster?.positions ?? [], leagueOptions: leagueOptions(), activeLeague: activeLeague(),
    raceRules: raceRules(), tierRules: tierRules(), slots: state.slots, positionGroups: state.roster?.positionGroups,
  });
  const inducementTeam = (): InducementTeam | null =>
    state.roster ? { raceName: state.roster.raceName, specialRules: state.roster.specialRules, specialRule: selectedSpecialRule() } : null;
  const inducementTerms = (item: InducementItem | undefined) => core.inducementTerms(item, inducementTeam());
  const shortName = (p: BuilderPosition | null): string => (p ? shortPositionName(p, { name: state.roster?.raceName ?? "" }) : "");

  // ── Blood Bowl Sevens: the Lineman keyword decides (owner Q2). The limits' position lists are the validator's own (dataset
  // names); a position they don't name falls back to its keywords. ──
  const listed = (names: string[] | undefined, p: BuilderPosition): boolean => Boolean(names?.some((n) => core.norm(n) === core.norm(p.name)));
  function isLinemanPosition(p: BuilderPosition): boolean {
    const l = limits();
    if (l && listed(l.nonLinemanPositions, p)) return false;
    if (l && listed(l.veteran?.eligiblePositions, p)) return true;
    return (p.keywords ?? []).some((k) => core.norm(k) === "lineman");
  }
  const nonLinemanCap = (): number | null => limits()?.maxNonLineman ?? null;
  const countsAsNonLineman = (p: BuilderPosition | null): boolean => Boolean(p && !p.isStar && nonLinemanCap() != null && !isLinemanPosition(p));
  const nonLinemanCount = (): number => state.slots.filter((s) => countsAsNonLineman(positionById(s.positionId))).length;
  /** "Non-Linemen 3 / 4" (null when the ruleset has no such cap). */
  const nonLineman = (): { count: number; max: number } | null => {
    const max = nonLinemanCap();
    return max == null ? null : { count: nonLinemanCount(), max };
  };
  const veteranRule = (): BuilderLimits["veteran"] => limits()?.veteran ?? null;
  /** Whether this row may be the Veteran (a Lineman-keyword, non-star player under a ruleset with a Veteran). */
  const canVeteran = (slot: Slot | undefined): boolean => {
    if (!slot || !veteranRule()) return false;
    const p = positionById(slot.positionId);
    return Boolean(p && !p.isStar && isLinemanPosition(p));
  };
  /** A slot's Veteran flag as the save and preview carry it. While a Sevens race's limits are still unknown the flag is
   *  kept as stored (never dropped by a slow or failed limits load). */
  const veteranOn = (slot: Slot): boolean => slot.veteran === true && (limits() ? canVeteran(slot) : sevens());
  const veteranIndex = (): number => state.slots.findIndex((s) => s.veteran === true && canVeteran(s));
  /** A Veteran's position as printed: MA moved by the package's delta (-1; never below 1). Others: the position itself. */
  function displayPosition(slot: Slot): BuilderPosition | null {
    const p = positionById(slot.positionId);
    const rule = veteranRule();
    if (!p || !rule || !veteranOn(slot)) return p;
    const ma = core.num(p.MA);
    return ma === null ? p : { ...p, MA: Math.max(1, ma + rule.maDelta) };
  }
  /** One Veteran at most, only on eligible rows (dropped when the ruleset has none); unknown limits keep the stored flags. */
  function reconcileVeteran(list: Slot[]): Slot[] {
    if (sevens() && !limits()) return list;
    let kept = false;
    let touched = false;
    const out = list.map((s) => {
      if (s.veteran !== true) return s;
      if (!kept && canVeteran(s)) { kept = true; return s; }
      touched = true;
      const { veteran: _v, ...rest } = s;
      return rest;
    });
    return touched ? out : list;
  }
  const positionCount = (id: string): number => state.slots.filter((s) => s.positionId === id).length;
  const positionCounts = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const s of state.slots) m.set(s.positionId, (m.get(s.positionId) ?? 0) + 1);
    return m;
  };

  /** Players by position for the Roster summary (owner 11-01): one row per position held, in the hire list's order (cost,
   *  then name), stars after (in the order they were hired). Empty roster: no rows. */
  function positionBreakdown(): Array<{ positionId: string; name: string; count: number; star: boolean }> {
    const counts = positionCounts();
    const out: Array<{ positionId: string; name: string; count: number; star: boolean }> = [];
    for (const c of positionCards()) {
      const count = counts.get(c.position.positionId) ?? 0;
      if (count) out.push({ positionId: c.position.positionId, name: c.name, count, star: false });
    }
    for (const sl of state.slots) {
      const p = positionById(sl.positionId);
      if (p?.isStar && !out.some((o) => o.positionId === p.positionId)) out.push({ positionId: p.positionId, name: shortName(p), count: counts.get(p.positionId) ?? 0, star: true });
    }
    return out;
  }

  // ── money ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const isStarSlot = (s: Slot): boolean => positionById(s.positionId)?.isStar === true;
  const rawPlayerCost = (): number => state.slots.filter((s) => !isStarSlot(s)).reduce((n, s) => n + (positionById(s.positionId)?.cost ?? 0), 0);
  const rawStarCost = (): number => state.slots.filter(isStarSlot).reduce((n, s) => n + (positionById(s.positionId)?.cost ?? 0), 0);
  const staffCost = (): number => staffRows(state.roster, limits()).reduce((n, r) => n + Math.max(0, state.staff[r.key] - r.free) * r.cost, 0);
  const inducementPicks = (): Array<{ key: string; count: number }> =>
    Object.entries(state.inducementCounts).filter(([, c]) => c > 0).map(([key, count]) => ({ key, count }));
  const inducementGold = (): number =>
    inducementPicks().reduce((n, p) => n + p.count * inducementTerms(state.inducementCatalog.find((i) => i.key === p.key)).price, 0);
  /** Free Create prices with src/freeCreate.ts, the same functions the share view uses (one implementation). */
  const freeSlotSkillGold = (s: Slot): number => (isStarSlot(s) ? 0
    : s.chosenSkills.reduce((n, k) => n + freeCreateSkillGold(accessOf(s.positionId, k) === "secondary" ? "secondary" : "primary", isElite(k)), 0));
  /** A Sevens package prices added skills from its limits (Sevens: 0 gold, bought skills add no value). */
  const limitsSlotSkillGold = (s: Slot, g: BuilderLimits["skills"]["gold"]): number => (isStarSlot(s) ? 0
    : s.chosenSkills.reduce((n, k) => n + (accessOf(s.positionId, k) === "secondary" ? (isElite(k) ? g.eliteSecondary : g.secondary) : (isElite(k) ? g.elitePrimary : g.primary)), 0));
  const addedSkillGold = (): number => {
    const l = limits();
    return state.slots.reduce((n, s) => n + (free() ? freeSlotSkillGold(s) : l ? limitsSlotSkillGold(s, l.skills.gold) : core.slotSkillGold(gateCtx(), s)), 0);
  };
  const statGold = (): number => {
    if (free()) return state.slots.filter((s) => !isStarSlot(s)).reduce((n, s) => n + s.chosenStatIncreases.reduce((m, k) => m + freeCreateStatGold(k), 0), 0);
    const rules = statRules();
    const allowed = allowedStats();
    return state.slots.filter((s) => !isStarSlot(s))
      .reduce((n, s) => n + heldStats(s).filter((k) => allowed.includes(k)).reduce((m, k) => m + (core.statIncreaseCost(rules, k) ?? 0), 0), 0);
  };
  const budget = (): number => packSummary()?.gold ?? limits()?.budget ?? state.preview?.package?.budget ?? state.packageRules?.budget ?? 1_000_000;
  /** Whether the ruleset has a TV cap at all (Free Create has none). */
  const capped = (): boolean => !free();
  const skillCounts = () => {
    let primary = 0;
    let secondary = 0;
    for (const s of state.slots) for (const k of s.chosenSkills) { if (accessOf(s.positionId, k) === "secondary") secondary++; else primary++; }
    return { primary, secondary };
  };
  const pick = (server: number | undefined, client: number): number => (typeof server === "number" && Number.isFinite(server) ? server : client);
  /** The team value bar: server summary when a preview is in, client estimates otherwise. */
  function totals() {
    const s = state.preview?.summary ?? null;
    // Choose-one packs pay for skills with the pack (SP or a skill count), not gold (server skill-packages rule).
    const skillGoldInBudget = raceRules()?.packs.length ? 0 : addedSkillGold();
    const estimate = rawPlayerCost() + rawStarCost() + staffCost() + inducementGold() + skillGoldInBudget + statGold();
    const counts = skillCounts();
    const used = s && typeof s.goldUsed === "number" ? s.goldUsed : estimate;
    return {
      players: state.slots.length,
      playersCost: rawPlayerCost(),
      starsCost: pick(s?.starsCost, rawStarCost()),
      skillsCost: pick(s?.skillsCost, addedSkillGold()),
      statCost: pick(s?.statIncreasesCost, statGold()),
      starFees: s?.starFeesCost ?? 0,
      inducementsCost: pick(s?.inducementsCost, inducementGold()),
      sidelineCost: staffCost(),
      primary: pick(s?.primarySkillCount, counts.primary),
      secondary: pick(s?.secondarySkillCount, counts.secondary),
      used,
      budget: budget(),
      capped: capped(),
      over: capped() && used > budget(),
      estimated: !s,
    };
  }
  /** One player's SP for added skills, as the server counts it: choose-one skill packs charge no stacking surcharge
   *  (bb-validator validate.ts / the skill-packages rule), other rulesets add stackSurcharge per skill beyond the first. */
  function slotSkillSp(sl: Slot): number {
    const base = raceRules()?.skillCosts ?? core.DEFAULT_SKILL_COSTS;
    const costs = raceRules()?.packs.length ? { ...base, stackSurcharge: 0 } : base;
    return core.playerSkillSp(sl.chosenSkills, (k) => accessOf(sl.positionId, k) === "secondary", costs);
  }
  /** Skill points (the vanilla page's tournament box, now the validator box): used / budget (the server's count once a
   *  preview is in) and each player's SP for added skills. Null when the ruleset has no SP budget. */
  function skillPoints(): { used: number; budget: number; over: boolean; players: Array<{ index: number; name: string; sp: number }> } | null {
    const sevensSp = countSkillPoints();
    if (sevensSp) return sevensSp;
    const s = state.preview?.summary ?? null;
    const budget = packSummary()?.skillPointBudget || s?.skillPointBudget || raceRules()?.skillPointBudget || 0;
    if (!budget) return null;
    const players = state.slots.map((sl, index) => ({ index, name: shortName(positionById(sl.positionId)), sp: slotSkillSp(sl) }));
    // The client total is the sum of the per-player figures (one implementation); the server's count wins once in.
    const used = s?.skillPointsUsed ?? players.reduce((n, p) => n + p.sp, 0);
    return { used, budget, over: used > budget, players: players.filter((p) => p.sp > 0) };
  }
  /** Sevens Skill Points on the count knobs (SJ22: Tier N = N SP, a Primary costs 1, the team's swapped Secondary costs the
   *  swap ratio, 2): used / the tier's SP and each player's SP. Null when the ruleset has no count allowance in its limits. */
  function countSkillPoints(): { used: number; budget: number; over: boolean; players: Array<{ index: number; name: string; sp: number }> } | null {
    const k = limits()?.skills;
    if (!k || k.maxPrimary == null) return null;
    const ratio = k.secondarySwap ? k.secondarySwapRatio : 0;
    const counts = skillCounts();
    const over = k.maxSecondary == null ? 0 : Math.max(0, counts.secondary - k.maxSecondary);
    const used = counts.primary + over * ratio;
    const players = state.slots.map((sl, index) => ({
      index, name: shortName(positionById(sl.positionId)),
      sp: sl.chosenSkills.reduce((n, sk) => n + (accessOf(sl.positionId, sk) === "secondary" ? ratio : 1), 0),
    }));
    return { used, budget: k.maxPrimary, over: used > k.maxPrimary, players: players.filter((p) => p.sp > 0) };
  }
  /** Why a Sevens package's skill limits refuse this skill now ("" = allowed): no added skills at all (Sevens Free Create),
   *  one per player, the team's Elite cap, the tier's Skill Points and the one Secondary. Only Sevens rulesets have limits. */
  function packageSkillBlock(slot: Slot, skill: string): string {
    const k = limits()?.skills;
    if (!k) return "";
    const more = packageMoreReason(slot);
    if (more) return more;
    if (k.eliteMaxTotal != null && isElite(skill)) {
      const elite = state.slots.reduce((n, s) => n + s.chosenSkills.filter((x) => isElite(x)).length, 0);
      if (elite >= k.eliteMaxTotal) return `At most ${k.eliteMaxTotal} Elite skills per team.`;
    }
    if (k.maxPrimary == null) return "";
    const secondary = accessOf(slot.positionId, skill) === "secondary";
    const counts = skillCounts();
    const primary = counts.primary + (secondary ? 0 : 1);
    const second = counts.secondary + (secondary ? 1 : 0);
    const over = k.maxSecondary == null ? 0 : Math.max(0, second - k.maxSecondary);
    if (over > 0 && (!k.secondarySwap || (k.secondarySwapMax != null && over > k.secondarySwapMax))) {
      return k.secondarySwap && k.secondarySwapMax != null ? `Only ${k.secondarySwapMax} Secondary skill${k.secondarySwapMax === 1 ? "" : "s"} per team.` : "No Secondary skills in this tier.";
    }
    const used = primary + (k.secondarySwap ? over * k.secondarySwapRatio : 0);
    if (used > k.maxPrimary) {
      const tier = k.tier != null ? `Tier ${k.tier} has ${k.maxPrimary}` : `the ruleset gives ${k.maxPrimary}`;
      return secondary ? `Not enough Skill Points: a Secondary costs ${k.secondarySwapRatio} (${tier}).` : `No Skill Points left (${tier}).`;
    }
    return "";
  }
  /** Why this player can't take any more added skills under the package's limits ("" = may). */
  function packageMoreReason(slot: Slot): string {
    const k = limits()?.skills;
    if (!k) return "";
    if (k.maxPrimary == null && k.skillPointBudget <= 0) return sevensFree() ? "Sevens Free Create has no added skills." : "This ruleset has no added skills.";
    if (k.maxPerPlayer != null && slot.chosenSkills.length >= k.maxPerPlayer) {
      return k.maxPerPlayer === 1 ? "One added skill per player in Sevens." : `Max ${k.maxPerPlayer} added skills per player.`;
    }
    return "";
  }
  /** The value breakdown lines (the vanilla page's Team Value card). */
  function valueLines(): Array<{ label: string; value: string; tone?: "over" | "hint" }> {
    const t = totals();
    const s = state.preview?.summary ?? null;
    const lines: Array<{ label: string; value: string; tone?: "over" | "hint" }> = [];
    lines.push({ label: "Players", value: `${t.players} · ${core.gold(t.playersCost)}` });
    if (state.slots.some(isStarSlot)) lines.push({ label: "Star players", value: core.gold(t.starsCost) });
    lines.push({ label: "Sideline staff", value: core.gold(t.sidelineCost) });
    lines.push({ label: "Inducements", value: core.gold(t.inducementsCost) });
    lines.push({ label: "Skills", value: core.gold(t.skillsCost) });
    if (statRules() || (s?.statIncreasesCost ?? 0) > 0) lines.push({ label: "Stat increases", value: core.gold(t.statCost) });
    if (t.starFees > 0) lines.push({ label: "Star fees", value: core.gold(t.starFees) });
    if (captainAvailable()) {
      const at = state.slots.findIndex((sl) => sl.captain === true && slotCanCaptain(sl));
      const p = at >= 0 ? positionById(state.slots[at]!.positionId) : null;
      lines.push(p ? { label: "Team Captain", value: `#${at + 1} ${shortName(p)}` } : { label: "Team Captain", value: "not nominated", tone: "hint" });
    }
    const nl = nonLineman();
    if (nl) lines.push({ label: "Non-Linemen", value: `${nl.count} / ${nl.max}`, ...(nl.count > nl.max ? { tone: "over" as const } : {}) });
    if (veteranRule()) {
      const at = veteranIndex();
      const p = at >= 0 ? positionById(state.slots[at]!.positionId) : null;
      lines.push(p ? { label: "Veteran", value: `#${at + 1} ${shortName(p)}` } : { label: "Veteran", value: "not picked", tone: "over" });
    }
    lines.push({ label: "Primary skills", value: String(t.primary) });
    lines.push({ label: "Secondary skills", value: String(t.secondary) });
    const pack = packSummary();
    if (pack && (pack.maxSkills != null || pack.maxSecondary != null)) {
      const total = t.primary + t.secondary;
      const over = (pack.maxSkills != null && total > pack.maxSkills) || (pack.maxSecondary != null && t.secondary > pack.maxSecondary);
      lines.push({ label: "Pack skills", value: `${total} / ${pack.maxSkills ?? "∞"}${pack.maxSecondary != null ? ` (${t.secondary} / ${pack.maxSecondary} secondary)` : ""}`, ...(over ? { tone: "over" as const } : {}) });
    }
    const sp = skillPoints();
    if (sp) lines.push({ label: "Skill points", value: `${sp.used} / ${sp.budget}`, ...(sp.over ? { tone: "over" as const } : {}) });
    if (!t.capped) lines.push({ label: "Total", value: core.gold(t.used) });
    else lines.push({ label: t.estimated ? (state.previewPending ? "Calculating team value..." : "Estimate") : "Total", value: `${core.gold(t.used)} / ${core.gold(t.budget)}`, ...(t.over ? { tone: "over" as const } : {}) });
    return lines;
  }

  // ── validity ──────────────────────────────────────────────────────────────────────────────────────────────────────
  function notices(): string[] {
    const out: string[] = [];
    if (!deps.coach()) out.push("You must sign in with Discord to save or create the team.");
    if (!state.roster) out.push("Choose a ruleset and a race to start.");
    else {
      if (!state.teamName.trim()) out.push("Name your team.");
      if (!state.slots.length) out.push("Add players from Hireable players.");
      if (state.slots.length && veteranRule() && veteranIndex() < 0) out.push(VETERAN_MISSING);
      const nl = nonLineman();
      if (nl && nl.count > nl.max) out.push(nonLinemanReason(nl.max));
    }
    return out;
  }
  const checkable = (): boolean => Boolean(state.roster && state.slots.length && state.teamName.trim());
  /** The document the verdict is about: everything the coach edits (not the session coach, not server echoes). */
  const docKey = (): string => JSON.stringify([
    state.packageName, state.roster?.rosterId ?? "", state.teamName.trim(), state.slots, state.staff, state.inducementCounts,
    state.skillPack, state.league, state.editingTeamId, state.ignoreLimits,
  ]);
  /** The preview's verdict, only while it describes the current document (any edit makes it pending again). */
  const currentVerdict = (): PreviewResult | null => (state.preview && !state.previewPending && state.preview.doc === docKey() ? state.preview : null);
  function validity(): { tone: "pending" | "checking" | "valid" | "invalid"; headline: string; errors: string[]; warnings: string[]; notices: string[] } {
    const ok = checkable();
    const p = currentVerdict();
    const errors = ok ? (p?.errors ?? []).map(findingText) : [];
    const warnings = ok ? (p?.warnings ?? []).map(findingText) : [];
    let tone: "pending" | "checking" | "valid" | "invalid" = "checking";
    let headline = "Checking team...";
    if (!ok) { tone = "pending"; headline = "Not ready yet"; }
    else if (p?.failed) { tone = "invalid"; headline = "Couldn't check the team"; }
    else if (p) {
      tone = p.valid ? "valid" : "invalid";
      headline = p.valid ? "Team is valid" : `Team is invalid${errors.length ? `: ${errors.length} ${errors.length === 1 ? "issue" : "issues"}` : ""}`;
    }
    return { tone, headline, errors, warnings, notices: notices() };
  }
  // Free Create has no verdict: a named team with a player can always export, share and go to the Fork (which checks it).
  const sheetValid = (): boolean => checkable() && (free() || currentVerdict()?.valid === true);
  const canExport = (): boolean => Boolean(state.roster && state.slots.length) && sheetValid() && !state.pdfBusy;
  /** Why this team can't go to the fork ("" = it can): Blood Bowl Sevens is tabletop only (owner Q12). */
  const forkBlocked = (): string => (sevens() ? SEVENS_TABLETOP_NOTE : "");
  const canBuild = (): boolean => Boolean(deps.coach()) && sheetValid() && !state.buildBusy && !forkBlocked();
  const canSave = (): boolean => Boolean(deps.coach() && state.roster) && !state.saveBusy;
  /** Share link: a saved team whose sheet could be exported (valid, or Free Create with a name and a player). */
  const canShare = (): boolean => Boolean(deps.coach() && state.currentSave) && sheetValid() && !state.shareBusy;

  // ── roster model (positions, stars, inducements) ────────────────────────────────────────────────────────────────
  function positionCards() {
    const roster = state.roster;
    if (!roster) return [];
    const counts = positionCounts();
    const cap = nonLinemanCap();
    const nlFull = cap != null && nonLinemanCount() >= cap;
    const full = state.slots.length >= maxPlayers();
    return roster.positions.filter((p) => !p.isStar).slice().sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)).map((position) => {
      const count = counts.get(position.positionId) ?? 0;
      const group = core.positionGroupCapped(position.positionId, roster.positionGroups, counts);
      const name = shortName(position);
      const nonLinemanCapped = nlFull && countsAsNonLineman(position);
      return {
        position, name, count, left: Math.max(0, position.max - count), group,
        exhausted: (!ignoring() && (count >= position.max || Boolean(group))) || nonLinemanCapped || full,
        /** Why the card is disabled ("" while it isn't, or for the ordinary position / group limits). */
        reason: nonLinemanCapped ? nonLinemanReason(cap!) : full ? `The roster is full (${maxPlayers()} players).` : "",
        nonLineman: countsAsNonLineman(position),
        role: core.cardRoleTag(position, roster.positions, name),
      };
    });
  }
  const starChoices = (): StarChoice[] => {
    if (!state.roster) return [];
    // Ignore in-game limits: every star the fork lists, whatever the race or league (pairs still come as one choice).
    if (ignoring()) return core.buildStarChoices(starPool()).sort((a, b) => a.label.localeCompare(b.label));
    return core.offeredStarChoices(starCtx());
  };
  /** Whether a star choice can be added now: the core's gate, or (limits ignored) only "not already in" and 16 players. */
  function canAddStar(choice: StarChoice): boolean {
    if (!ignoring()) return core.canAddStarChoice(starCtx(), choice);
    const missing = choice.members.filter((m) => positionCount(m.positionId) === 0);
    return missing.length > 0 && state.slots.length + missing.length <= maxPlayers();
  }
  const starChoiceOf = (positionId: string): StarChoice | undefined =>
    core.buildStarChoices(starPool()).find((c) => c.members.some((m) => m.positionId === positionId));
  const starCap = (): number | null => core.starCap(raceRules(), tierRules());
  const starPickCount = (): number => core.buildStarChoices(starPool()).filter((c) => c.members.some((m) => positionCount(m.positionId) > 0)).length;
  // Blood Bowl Sevens has no Star Players or Mercenaries (owner Q4): the panel stays shut whatever the package says.
  const starsAllowed = (): boolean => Boolean(state.roster) && !sevens() && (ignoring() || (raceRules()?.stars?.allowed ?? true));
  /** Why the star bar is shut (its tooltip): Sevens, else the race has no star access. */
  const starsOffReason = (): string => (sevens() ? SEVENS_NO_STARS : "This race has no access to star players under this ruleset.");
  function starSp(choice: StarChoice): number | null {
    const costs = raceRules()?.stars?.spCosts;
    if (!costs?.length) return null;
    const byName = new Map(costs.map((s) => [core.norm(s.name), s.sp]));
    return choice.members.reduce((n, m) => n + (byName.get(core.norm(m.name)) ?? 0), 0);
  }
  function starRow(choice: StarChoice) {
    const present = choice.members.filter((m) => positionCount(m.positionId) > 0).length;
    const status = choice.paired
      ? (present === 0 ? "0 / 1" : present === choice.members.length ? "1 / 1" : `${present} of ${choice.members.length} present`)
      : `${present} / ${choice.members[0]?.max ?? 1}`;
    const cap = starCap();
    const packs = tierRules()?.starPacks ?? [];
    const memberPacks = [...new Set(choice.members.flatMap((m) => core.starPacksFor(m.name, packs)))];
    const sp = starSp(choice);
    return {
      choice, present, status, price: sp != null ? `${sp} SP` : core.gold(choice.cost),
      packs: memberPacks.map((p) => core.starPackLabel(p)).join(" · "),
      canAdd: canAddStar(choice) && !(cap != null && starPickCount() >= cap && present === 0),
      capReached: cap != null && starPickCount() >= cap && present === 0,
    };
  }
  /** Star SP table rows (SP-priced stars offered here) and the banned list. */
  function starSpTable(): { rows: Array<{ name: string; sp: number }>; banned: string[] } {
    const race = raceRules();
    const offered = new Set(starChoices().flatMap((c) => c.members.map((m) => core.norm(m.name))));
    return { rows: (race?.stars?.spCosts ?? []).filter((s) => offered.has(core.norm(s.name))), banned: race?.bannedStars ?? [] };
  }
  function inducementRows() {
    const team = inducementTeam();
    const items = state.inducementCatalog.filter((i) => i.allowed && core.inducementOpenToRoster(i, team));
    return items.map((item) => {
      const count = state.inducementCounts[item.key] ?? 0;
      const terms = inducementTerms(item);
      const note = [core.gold(terms.price), terms.max != null ? `max ${terms.max}` : "", terms.reduced ? (item.reducedRoster ? `${item.reducedRoster} teams` : item.reducedSpecialRule ?? "") : "", item.rosterOnly?.length ? `${item.rosterOnly.join(" / ")} only` : ""].filter(Boolean).join(" · ");
      return { item, count, terms, note, atMax: terms.max != null && count >= terms.max, icon: iconPath(state.art.icons, item.key) };
    });
  }
  /** The ruleset lines for the chosen race (budget, pack, per-player cap, stars, tier limits, data note). */
  function rulesetLines(): string[] {
    const race = raceRules();
    const lines: string[] = [];
    const l = limits();
    if (l) {
      lines.push([`Blood Bowl Sevens: ${l.minPlayers}–${l.maxPlayers} players`, l.maxNonLineman != null ? `at most ${l.maxNonLineman} non-Linemen` : "",
        l.veteran ? "one Veteran (MA −1)" : ""].filter(Boolean).join(" · "));
      if (sevensFree() && l.budget != null) lines.push(`Budget ${core.gold(l.budget)} · no added skills`);
      lines.push(SEVENS_NO_STARS, `${SEVENS_TABLETOP_NOTE} No fork team.`);
    }
    if (race) {
      const pack = packSummary();
      lines.push([`Budget ${core.gold(pack?.gold ?? race.gold)}`,
        !race.packs.length ? (race.skillPointBudget ? `${race.skillPointBudget} SP` : "") : pack ? `${core.packSkillText(pack)} (${pack.label})` : "",
        race.maxPerPlayer != null ? `${race.maxPerPlayer} skill${race.maxPerPlayer === 1 ? "" : "s"}/player` : ""].filter(Boolean).join(" · "));
      if (race.stars && !l) lines.push(race.stars.allowed ? `Stars${race.stars.maxCount != null ? ` (max ${race.stars.maxCount})` : ""}${race.stars.paidInSkillPoints ? ", paid in SP" : ""}` : "No star players");
    }
    lines.push(...core.tierLimitLines(tierRules()));
    return lines;
  }
  const tierLabel = (): string => raceRules()?.tierLabel ?? (raceRules()?.tierNumber != null ? `Tier ${raceRules()!.tierNumber}` : "");

  // ── the race table (Ruleset tab) ────────────────────────────────────────────────────────────────────────────────
  const rosterForRace = (race: string): BuilderRoster | null => {
    const key = core.norm(race);
    return state.rosters.find((r) => core.norm(r.raceName) === key || core.norm(r.rosterId) === key) ?? null;
  };
  /** Roster ids this package admits (and the fork has). */
  function eligibleRosters(): Map<string, BuilderRoster> {
    // Free Create: every base BB2025 roster the fork has.
    if (free()) return new Map(state.rosters.map((r) => [r.rosterId, r]));
    // Sevens Free Create: every roster the Sevens profile admits (the SJ22 tier list; no Slann).
    if (sevensFree()) {
      const admitted = new Set(state.sevensEligible.map((n) => core.norm(n)));
      return new Map(state.rosters.filter((r) => admitted.has(core.norm(r.raceName))).map((r) => [r.rosterId, r]));
    }
    const listed = state.packageDoc?.eligibleRosters ?? [];
    const all = !listed.length || listed.includes("*");
    const admitted = (name: string) => all || listed.some((e) => core.norm(e) === core.norm(name));
    const out = new Map<string, BuilderRoster>();
    if (state.tierRows.length) {
      for (const row of state.tierRows) {
        const roster = rosterForRace(row.name);
        if (roster && admitted(row.name)) out.set(roster.rosterId, roster);
      }
    } else for (const roster of state.rosters) if (admitted(roster.raceName)) out.set(roster.rosterId, roster);
    return out;
  }
  /** Free Create's race picker: every base roster, by name, with its crest. */
  function freeRaces(): Array<{ rosterId: string; raceName: string; crest: string; selected: boolean }> {
    const pool = sevensFree() ? [...eligibleRosters().values()] : state.rosters;
    return pool.slice().sort((a, b) => a.raceName.localeCompare(b.raceName))
      .map((r) => ({ rosterId: r.rosterId, raceName: r.raceName, crest: crestPath(r.raceName), selected: state.roster?.rosterId === r.rosterId }));
  }
  /** The Ruleset tab's cards: Free Create first, then the tournament packages (minus the ones it replaces). */
  function rulesetCards(): RulesetCard[] {
    return [
      { name: FREE_CREATE_PACKAGE, label: FREE_CREATE_LABEL, description: FREE_CREATE_DESCRIPTION, free: true, sevens: false },
      // Sevens Free Create (owner Q1 (c)): next to Free Create, same card style.
      { name: SEVENS_FREE_CREATE_PACKAGE, label: SEVENS_FREE_CREATE_LABEL, description: SEVENS_FREE_CREATE_DESCRIPTION, free: true, sevens: true },
      ...state.packages.filter((p) => !HIDDEN_RULESET_CARDS.has(p.name))
        .map((p) => ({ name: p.name, label: p.name, description: p.description, free: false, sevens: p.format === "sevens" })),
    ];
  }
  /** The ruleset's display name (the Free Create markers read "Free Create" / "Sevens Free Create"). */
  const rulesetLabel = (): string => (free() ? FREE_CREATE_LABEL : sevensFree() ? SEVENS_FREE_CREATE_LABEL : state.packageName);
  /** The sheet's format title line: "Blood Bowl Sevens · Matched Play" ("" for standard rulesets). */
  function formatTitle(): string {
    if (!sevens()) return "";
    const short = sevensFree() ? "Free Create" : state.packageName.replace(/^blood\s*bowl\s*sevens\s*/i, "").replace(/^\((.*)\)$/, "$1").trim();
    return ["Blood Bowl Sevens", short].filter(Boolean).join(" · ");
  }
  /** The race table markup (core.overviewTableHtml / legacy tierTableHtml); team cells are pick buttons (data-tt-race). */
  function raceTable(): { html: string; legacy: boolean; selectable: boolean } {
    const eligible = eligibleRosters();
    const pickFn = (teamName: string) => {
      const roster = rosterForRace(teamName);
      if (!roster || !eligible.has(roster.rosterId)) return null;
      const crest = crestPath(roster.raceName);
      return {
        id: roster.rosterId,
        crest: crest ? `<img class="crest-image tt-team-crest" src="${crest}" alt="" aria-hidden="true" loading="lazy" decoding="async">` : "",
        selected: state.roster?.rosterId === roster.rosterId,
      };
    };
    const names = [...eligible.values()].map((r) => r.raceName).sort((a, b) => a.localeCompare(b));
    const overview = state.packageRules?.overview ?? null;
    if (!overview && state.tierRows.length) {
      return { legacy: true, selectable: eligible.size > 0, html: core.tierTableHtml(core.tierTable(state.tierRows.map((r) => r.raw), state.packageRules?.tierSummary), { pick: pickFn }) };
    }
    const model = core.raceTableOverview(overview, names, (n) => Boolean(rosterForRace(n)));
    return { legacy: false, selectable: eligible.size > 0, html: model ? core.overviewTableHtml(model, { pick: pickFn }) : "" };
  }

  // ── art ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** Only relative paths inside the generated art folders are used (same rule as team-view.js). */
  const artSrc = (path: string | null | undefined): string => (typeof path === "string" && /^(?:sprites|crests|icons)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(path) ? `/${path}` : "");
  const iconPath = (m: IconManifest | null, key: string): string => artSrc(m?.icons?.[key]);
  const crestPath = (race: string): string => artSrc(core.resolveCrest(state.art.crests, race));
  const spritePath = (positionName: string): string => artSrc(core.resolveSprite(state.art.sprites, state.roster?.raceName ?? "", positionName));
  const skillIcon = (skill: string): string => iconPath(state.art.skillIcons, core.skillIconKey(skill, state.art.skillIcons?.aliases));
  function staffIcon(key: keyof Staff): string {
    const [set, name] = STAFF_ICONS[key];
    return iconPath(set === "ui" ? state.art.uiIcons : state.art.icons, name);
  }
  /** Whether a skill chip wears the elite diamond (owner 11-01): the package's elite list, else the dataset's flag. */
  const eliteMark = (skill: string): boolean => isElite(bare(skill));
  function skillClass(skill: string): string {
    const meta = skillMeta(bare(skill));
    return `skill ${categoryClass(meta?.category)}`;
  }

  // ── loading ───────────────────────────────────────────────────────────────────────────────────────────────────────
  function setStatus(text: string, error = false): void { state.status = text; state.statusError = error; }
  async function boot(): Promise<void> {
    try {
      const [rosterRes, packageRes] = await Promise.all([
        api<{ rosters?: unknown }>("/api/fork/rosters"),
        api<unknown>("/api/packages").catch(() => []),
      ]);
      state.rosters = arr(rosterRes?.rosters).map(sanitizeRoster);
      const list = Array.isArray(packageRes) ? packageRes : isRec(packageRes) ? arr(packageRes.packages) : [];
      state.packages = list.filter(isRec).filter((r) => typeof r.name === "string" && !isExamplePackage(r.name))
        .map((r) => ({ name: sv(r.name), description: sv(r.description), ...(r.format === "sevens" ? { format: "sevens" as const } : {}) }));
      if (!state.rosters.length) setStatus("No BB2025 roster data is available.");
    } catch (e) {
      state.bootError = `Couldn't load rosters: ${(e as Error).message}`;
    }
    state.booted = true;
    void ensureSkillCatalog();
    void loadArt();
  }
  async function loadArt(): Promise<void> {
    const get = async <T>(path: string, ok: (v: unknown) => boolean): Promise<T | null> => {
      try { const v = await api<unknown>(path); return ok(v) ? (v as T) : null; } catch { return null; }
    };
    const icons = (v: unknown) => isRec(v) && isRec(v.icons);
    const [sprites, crests, ind, skills, ui] = await Promise.all([
      get<SpriteManifest>("/sprites/manifest.json", (v) => isRec(v) && isRec(v.races)),
      get<CrestManifest>("/crests/manifest.json", (v) => isRec(v) && isRec(v.crests)),
      get<IconManifest>("/icons/inducements/manifest.json", icons),
      get<IconManifest>("/icons/skills/manifest.json", icons),
      get<IconManifest>("/icons/ui/manifest.json", icons),
    ]);
    state.art = { sprites, crests, icons: ind, skillIcons: skills, uiIcons: ui };
  }
  async function ensureSkillCatalog(): Promise<void> {
    if (state.skillCatalog) return;
    try {
      const data = await api<unknown>("/api/skills");
      const map: Record<string, SkillMeta> = {};
      for (const group of Object.values(isRec(data) ? data : {})) {
        for (const row of arr(group)) {
          if (!isRec(row)) continue;
          const name = typeof row.name === "string" ? row.name.trim() : "";
          if (name && !map[name]) map[name] = { category: sv(row.category), elite: row.elite === true };
        }
      }
      state.skillCatalog = map;
    } catch {
      state.skillCatalog = {};
    }
  }
  async function ensureLegal(positionId: string): Promise<LegalSet | null> {
    const key = legalKey(positionId);
    if (state.legal[key]) return state.legal[key]!;
    if (!state.roster) return null;
    const data = await api<Rec>(`/api/fork/team-builder/legal-skills?rosterId=${encodeURIComponent(state.roster.rosterId)}&positionId=${encodeURIComponent(positionId)}`);
    const set: LegalSet = { primary: legalList(data?.primary), secondary: legalList(data?.secondary), alreadyPrinted: strList(data?.alreadyPrinted) };
    state.legal[key] = set;
    return set;
  }
  async function loadPackageRules(): Promise<void> {
    const seq = ++rulesSequence;
    const name = state.packageName;
    if (!name || free()) { state.packageRules = null; state.packageDoc = null; state.tierRows = []; state.packageFormat = "standard"; state.limits = null; return; }
    if (sevensFree()) {
      // Not a saved package: no rules document or tier table, only the Sevens profile's limits and eligible rosters.
      state.packageRules = null;
      state.tierRows = [];
      state.packageFormat = "sevens";
      await loadLimits(seq);
      if (seq !== rulesSequence) return;
      state.packageDoc = { description: SEVENS_FREE_CREATE_DESCRIPTION, dataNote: "", eligibleRosters: [...state.sevensEligible] };
      return;
    }
    const race = state.roster?.raceName;
    const [rules, tiers] = await Promise.allSettled([
      api<Rec>(`/api/packages/${encodeURIComponent(name)}${race ? `?roster=${encodeURIComponent(race)}` : ""}`),
      api<Rec>(`/api/fork/team-builder/tiers?packageName=${encodeURIComponent(name)}`),
    ]);
    if (seq !== rulesSequence) return;
    const pkg = rules.status === "fulfilled" && isRec(rules.value?.pkg) ? rules.value.pkg : null;
    state.packageDoc = pkg ? { description: sv(pkg.description), dataNote: sv(pkg.dataNote), eligibleRosters: strList(pkg.eligibleRosters) } : null;
    state.packageRules = rules.status === "fulfilled" ? sanitizePackageRules(rules.value?.rules) : null;
    state.tierRows = tiers.status === "fulfilled" ? arr(tiers.value?.races).map(sanitizeTierRow).filter((r): r is TierRow => r !== null) : [];
    if (rules.status === "rejected") setStatus(`Couldn't load the ruleset: ${(rules.reason as Error).message}`, true);
    // The resolved package's format (the server resolves it along the extends chain), else the list row's.
    state.packageFormat = pkg?.format === "sevens" || state.packages.find((p) => p.name === name)?.format === "sevens" ? "sevens" : "standard";
    if (state.packageFormat === "sevens") await loadLimits(seq);
    else state.limits = null;
  }
  /** Blood Bowl Sevens: the ruleset's eligible rosters and (with a race) that race's limits. A failure leaves no limits
   *  (the server preview still validates; the builder falls back to the standard controls). */
  async function loadLimits(seq: number): Promise<void> {
    const name = state.packageName;
    const race = state.roster?.raceName;
    try {
      const data = await api<Rec>(`/api/fork/team-builder/limits?packageName=${encodeURIComponent(name)}${race ? `&roster=${encodeURIComponent(race)}` : ""}`);
      if (seq !== rulesSequence) return;
      state.sevensEligible = strList(data?.eligibleRosters);
      state.limits = race ? sanitizeLimits(data?.limits) : null;
    } catch {
      if (seq !== rulesSequence) return;
      state.limits = null;
    }
  }
  /** Staff follow the limits: each line into its range; `fresh` (a new roster) also starts Dedicated Fans at the package's
   *  free start (Sevens Matched Play 0, Sevens Free Create 1). Standard rulesets are left as they are. */
  function fitStaff(fresh: boolean): void {
    const l = limits();
    if (!l?.staffPriced) return;
    const next = { ...state.staff };
    if (fresh) next.dedicatedFans = l.staff.dedicatedFans.start;
    for (const r of staffRows(state.roster, l)) next[r.key] = Math.max(r.min, Math.min(r.max, next[r.key]));
    state.staff = next;
  }
  async function loadInducements(): Promise<void> {
    const seq = ++inducementSequence;
    // Free Create asks for the base BB2025 list (the server's baseline: every inducement at its standard price).
    const name = free() ? "" : state.packageName;
    try {
      const data = await api<Rec>(`/api/fork/team-builder/inducements${name ? `?packageName=${encodeURIComponent(name)}` : ""}`);
      if (seq !== inducementSequence) return;
      state.inducementCatalog = arr(data?.inducements).map(sanitizeInducement);
      clampInducements();
      state.inducementStatus = state.inducementCatalog.length ? "" : "No inducements are available for this package.";
    } catch (e) {
      if (seq !== inducementSequence) return;
      state.inducementCatalog = [];
      state.inducementCounts = {};
      state.inducementStatus = `Couldn't load inducements (${(e as Error).message}).`;
    }
  }
  /** Counts follow the catalog: unavailable / roster-only items drop to 0, counts over a (reduced) max clamp. */
  function clampInducements(): void {
    const team = inducementTeam();
    const next: Record<string, number> = {};
    for (const item of state.inducementCatalog) {
      let count = item.allowed && core.inducementOpenToRoster(item, team) ? Math.max(0, Math.floor(state.inducementCounts[item.key] ?? 0)) : 0;
      const max = inducementTerms(item).max;
      if (max != null) count = Math.min(count, Math.max(0, max));
      if (count) next[item.key] = count;
    }
    state.inducementCounts = next;
  }

  // ── preview ───────────────────────────────────────────────────────────────────────────────────────────────────────
  /** `forSave`: a draft keeps its stat increases while the tier rules are unknown, so a save never drops them. */
  function requestBody(opts: { forSave?: boolean } = {}): BuilderBody {
    void opts;
    const picks = core.buildPicks(state.slots.map((s) => ({ ...s, isStar: isStarSlot(s), captain: s.captain === true && slotCanCaptain(s), veteran: veteranOn(s) })), {
      skills: true, captain: captainAvailable(), stats: true, allowedStats: null, // never strip a stored increase: the validator reports it
    });
    const specialRule = selectedSpecialRule();
    const inducements = inducementPicks();
    return {
      ...(state.editingTeamId ? { teamId: state.editingTeamId } : {}),
      rosterId: state.roster?.rosterId ?? "",
      coach: deps.coach() || PREVIEW_COACH,
      teamName: state.teamName.trim(),
      picks,
      reRolls: state.staff.reRolls,
      apothecary: state.roster?.apothecaryAllowed !== false && state.staff.apothecary === 1,
      assistantCoaches: state.staff.assistantCoaches,
      cheerleaders: state.staff.cheerleaders,
      dedicatedFans: state.staff.dedicatedFans,
      ...(state.packageName ? { packageName: state.packageName } : {}),
      ...(state.skillPack ? { skillPack: state.skillPack } : {}),
      ...(specialRule ? { specialRule } : {}),
      ...(inducements.length ? { rosteredInducements: inducements } : {}),
      ...(ignoring() ? { ignoreLimits: true } : {}),
    };
  }
  function schedulePreview(): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    previewSequence++;
    if (state.preview && state.preview.rosterId !== state.roster?.rosterId) state.preview = null;
    // Free Create never goes to the validator (owner 10-31).
    if (free()) { state.preview = null; state.previewPending = false; return; }
    if (!checkable()) { state.previewPending = false; return; }
    state.previewPending = true;
    const seq = previewSequence;
    previewTimer = setTimeout(() => { previewTimer = null; void runPreview(seq); }, delay);
  }
  async function runPreview(seq: number): Promise<void> {
    const rosterId = state.roster?.rosterId ?? "";
    const doc = docKey();
    try {
      const result = await api<Rec>("/api/fork/team-builder/preview", { method: "POST", body: requestBody() });
      if (seq !== previewSequence) return;
      state.preview = {
        rosterId, doc, valid: result?.valid === true, errors: arr(result?.errors), warnings: arr(result?.warnings),
        summary: sanitizeSummary(result?.summary), package: sanitizeEcho(result?.package),
      };
    } catch (e) {
      if (seq !== previewSequence) return;
      state.preview = { rosterId, doc, failed: true, valid: false, errors: [(e as Error).message], warnings: [], summary: state.preview?.summary ?? null, package: state.preview?.package ?? null };
    }
    state.previewPending = false;
  }
  /** Run a scheduled preview now (tests, and before a build). */
  async function flushPreview(): Promise<void> {
    if (!previewTimer) return;
    clearTimeout(previewTimer);
    previewTimer = null;
    await runPreview(previewSequence);
  }

  // ── mutations ─────────────────────────────────────────────────────────────────────────────────────────────────────
  function changed(): void {
    state.buildResult = null;
    state.slots = reconcileVeteran(core.reconcileCaptain(state.slots, positionById, captainRules()));
    schedulePreview();
  }
  const named = (): boolean => Boolean(state.teamName.trim());
  function resetBuild(): void {
    state.slots = [];
    state.staff = freshStaff();
    state.skillPack = null;
    state.preview = null;
    state.leagueNotice = "";
    state.buildResult = null;
  }
  async function choosePackage(name: string): Promise<void> {
    generation++;
    if (name !== state.packageName) {
      state.roster = null;
      resetBuild();
      state.currentSave = null;
      state.shareUrl = "";
      state.editingTeamId = null;
      state.inducementCounts = {};
      state.ignoreLimits = false;
    }
    state.packageName = name;
    await Promise.all([loadPackageRules(), loadInducements()]);
  }
  /** Pick (or re-pick) the race; a different race starts a fresh roster. */
  async function chooseRace(rosterId: string): Promise<boolean> {
    if (state.roster?.rosterId === rosterId) return true;
    if (!eligibleRosters().has(rosterId)) return false;
    generation++;
    state.roster = state.rosters.find((r) => r.rosterId === rosterId) ?? null;
    resetBuild();
    state.currentSave = null;
    state.shareUrl = "";
    state.editingTeamId = null;
    state.league = core.reconcileLeagueSelection(leagueOptions(), { selectedLeague: "", explicit: false });
    clampInducements();
    await loadPackageRules();
    fitStaff(true);
    schedulePreview();
    return true;
  }
  function setTeamName(name: string): void {
    state.teamName = name;
    schedulePreview();
  }
  function selectLeague(league: string): void {
    state.league = core.reconcileLeagueSelection(leagueOptions(), { selectedLeague: league, explicit: true });
    // Ignore in-game limits offers every star whatever the league: a league change keeps every pick.
    if (ignoring()) { state.leagueNotice = ""; clampInducements(); changed(); return; }
    // Stars no longer eligible for the chosen league leave (pairs atomically).
    const before = state.slots.length;
    const choiceOf = new Map<string, StarChoice>();
    for (const c of core.buildStarChoices(state.roster?.positions ?? [])) for (const m of c.members) choiceOf.set(m.positionId, c);
    const remove = new Set<string>();
    for (const s of state.slots) {
      const p = positionById(s.positionId);
      if (!p?.isStar || core.starEligibleForLeague(p.playsFor, leagueOptions(), activeLeague())) continue;
      for (const m of choiceOf.get(p.positionId)?.members ?? [p]) remove.add(m.positionId);
    }
    state.slots = state.slots.filter((s) => !remove.has(s.positionId));
    const removed = before - state.slots.length;
    state.leagueNotice = removed ? `${removed} ineligible star player${removed === 1 ? "" : "s"} removed.` : "";
    clampInducements();
    changed();
  }
  function setSkillPack(label: string | null): void {
    state.skillPack = state.skillPack === label ? null : label;
    schedulePreview();
  }
  /** Add a player; false when the team is unnamed (the view shows the name prompt) or the position is full. */
  // ── player names (owner 11-01): generated on hire from the race's name style (src/nameGenerate.ts, local, offline),
  // editable, never on stars (a star already has a name); they ride the picks as names[i] ──
  /** A generated name no other player on the roster has (when the pool allows), never `avoid`. */
  function freshName(avoid = "", roster: Slot[] = state.slots): string {
    const race = state.roster?.raceName ?? "";
    const taken = new Set(roster.map((s) => s.name ?? "").filter(Boolean));
    let name = randomPlayerName(race, avoid, deps.random);
    for (let i = 0; i < 12 && (taken.has(name) || name === avoid); i++) name = randomPlayerName(race, avoid, deps.random);
    return name || "Rookie";
  }
  /** Rename a player: plain text, trimmed, at most PLAYER_NAME_MAX characters. An empty name keeps the old one (false). */
  function renameSlot(index: number, raw: string): boolean {
    const slot = state.slots[index];
    const name = cleanPlayerName(raw);
    if (!slot || isStarSlot(slot) || !name) return false;
    if (name === slot.name) return true;
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, name } : s));
    changed();
    return true;
  }
  /** The reroll button beside the name: another generated name. */
  function rerollName(index: number): string {
    const slot = state.slots[index];
    if (!slot || isStarSlot(slot)) return "";
    const name = freshName(slot.name ?? "");
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, name } : s));
    changed();
    return name;
  }
  /** Saves from before names: unnamed non-star players get one (shown, and kept on the next save). */
  function nameUnnamed(slots: Slot[]): Slot[] {
    const out = slots.slice();
    out.forEach((s, i) => { if (!s.name && !positionById(s.positionId)?.isStar) out[i] = { ...s, name: freshName("", out) }; });
    return out;
  }

  function addPosition(positionId: string): boolean {
    if (!named()) return false;
    const p = positionById(positionId);
    if (!p || p.isStar || state.slots.length >= maxPlayers()) return false;
    if (!ignoring() && (positionCount(positionId) >= p.max || core.positionGroupCapped(positionId, state.roster?.positionGroups, positionCounts()))) return false;
    const cap = nonLinemanCap();
    if (cap != null && countsAsNonLineman(p) && nonLinemanCount() >= cap) return false;
    state.slots = [...state.slots, { positionId, name: freshName(), chosenSkills: [], chosenStatIncreases: [] }];
    changed();
    return true;
  }
  function removeSlot(index: number): void {
    const slot = state.slots[index];
    if (!slot) return;
    const pair = starChoiceOf(slot.positionId);
    if (pair?.paired) { removeStar(pair.key); return; }
    state.slots = state.slots.filter((_, i) => i !== index);
    changed();
  }
  function addStar(key: string): boolean {
    if (!named()) return false;
    const choice = starChoices().find((c) => c.key === key);
    if (!choice || !canAddStar(choice)) return false;
    const cap = starCap();
    if (cap != null && starPickCount() >= cap) return false;
    const add = choice.members.filter((m) => positionCount(m.positionId) === 0).map((m): Slot => ({ positionId: m.positionId, chosenSkills: [], chosenStatIncreases: [] }));
    state.slots = [...state.slots, ...add];
    changed();
    return true;
  }
  function removeStar(key: string): void {
    const choice = core.buildStarChoices(starPool()).find((c) => c.key === key);
    if (!choice) return;
    let next = state.slots.slice();
    for (const m of choice.members) {
      const i = next.map((s) => s.positionId).lastIndexOf(m.positionId);
      if (i >= 0) next = next.filter((_, j) => j !== i);
    }
    state.slots = next;
    changed();
  }
  /** Presentation order only (player numbers follow it; the saved picks keep it). */
  function moveSlot(from: number, to: number): boolean {
    const next = core.moveSlot(state.slots, from, to);
    if (next === state.slots) return false;
    state.slots = next;
    changed();
    return true;
  }
  /** The Team Captain's row, or -1 while none is nominated. */
  const captainIndex = (): number => state.slots.findIndex((sl) => sl.captain === true && slotCanCaptain(sl));
  /** Nominate (or clear) the Team Captain: one per team; the captain's chosen Pro goes (it gains Pro for free). No direct
   *  reassignment (owner 10-31): while a captain is set, only clearing that captain works; then any eligible row can take it. */
  function toggleCaptain(index: number): void {
    const slot = state.slots[index];
    if (!slotCanCaptain(slot)) return;
    const on = slot!.captain !== true;
    const current = captainIndex();
    if (on && current >= 0 && current !== index) return;
    state.slots = state.slots.map((s, i) => {
      const { captain: _c, ...rest } = s;
      if (i !== index || !on) return rest;
      return { ...rest, captain: true, chosenSkills: rest.chosenSkills.filter((k) => k !== "Pro") };
    });
    changed();
  }
  /** Blood Bowl Sevens Veteran (a captain-style toggle): one per team, only on Lineman-keyword rows. While a Veteran is set
   *  only clearing it works; then any eligible row can take it. */
  function toggleVeteran(index: number): void {
    const slot = state.slots[index];
    if (!canVeteran(slot)) return;
    const on = slot!.veteran !== true;
    const current = veteranIndex();
    if (on && current >= 0 && current !== index) return;
    state.slots = state.slots.map((s, i) => {
      const { veteran: _v, ...rest } = s;
      return i === index && on ? { ...rest, veteran: true } : rest;
    });
    changed();
  }
  /** The skill gate: the package's Sevens limits first (their reasons are the Advance dialog's), then the shared core's,
   *  plus (Free Create) the server's per-player bound. */
  function skillBlock(slot: Slot | null, skill: string): string {
    const block = core.skillPickBlock(gateCtx(), slot, skill);
    // The core's own refusals that aren't limits (already added, printed, not legal) keep their wording.
    if (slot && (!block || block === "This player can't take another skill.")) {
      const own = packageSkillBlock(slot, skill);
      if (own) return own;
    }
    if (block || !slot || !free()) return block;
    return slot.chosenSkills.length >= MAX_SKILLS_PER_PLAYER ? `Max ${MAX_SKILLS_PER_PLAYER} added skills per player.` : "";
  }
  /** Whether the player may take another added skill (the core's caps, the package's per-player limit, and the per-player
   *  bound in Free Create). */
  const moreSkills = (slot: Slot): boolean => core.moreSkillsAllowed(gateCtx(), slot) && !packageMoreReason(slot) && !(free() && slot.chosenSkills.length >= MAX_SKILLS_PER_PLAYER);
  /** The stat gate: the shared core's, plus the BB2025 characteristic caps (MA 9, ST 8, AG / PA 1+, AV 11+), which hold
   *  even with Ignore in-game limits (the box lifts how many increases, never the game's caps). */
  function statBlock(slot: Slot | null, position: BuilderPosition | null, stat: string): string {
    return core.statOptionState(gateCtx(), slot, position, stat) || (position && free() ? statCapReason(position, stat) : "");
  }
  /** Add a skill after the shared gate re-checks it; resolves the gate's reason when refused ("" = added). */
  function addSkill(index: number, skill: string): string {
    const slot = state.slots[index];
    const block = skillBlock(slot ?? null, skill);
    if (block || !slot) return block || "This player can't take added skills.";
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, chosenSkills: [...s.chosenSkills, skill] } : s));
    changed();
    return "";
  }
  function removeSkill(index: number, skill: string): void {
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, chosenSkills: s.chosenSkills.filter((k) => k !== skill) } : s));
    changed();
  }
  function addStat(index: number, stat: string): string {
    const slot = state.slots[index];
    const block = statBlock(slot ?? null, slot ? positionById(slot.positionId) : null, stat);
    if (block || !slot) return block || "This player can't take a stat increase.";
    const live = heldStats(slot);
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, chosenStatIncreases: [...live, stat] } : s));
    changed();
    return "";
  }
  function removeStat(index: number, stat: string): void {
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, chosenStatIncreases: s.chosenStatIncreases.filter((k) => k !== stat) } : s));
    changed();
  }
  /** What a reset would remove from this player: added skills and stat increases (printed skills and the captain's free Pro
   *  are not advancements and never count). */
  function resetSummary(index: number): { skills: number; stats: number } {
    const slot = state.slots[index];
    if (!slot || isStarSlot(slot)) return { skills: 0, stats: 0 };
    return { skills: slot.chosenSkills.length, stats: slot.chosenStatIncreases.length + Object.keys(slot.chosenStats ?? {}).length };
  }
  /** The Advance dialog's Reset (owner 11-01): back to the position's base profile. Drops every added skill and stat
   *  increase; the name, row number and Team Captain flag stay (the captain's free Pro is granted by the flag, not stored). */
  function resetPlayer(index: number): { skills: number; stats: number } {
    const was = resetSummary(index);
    if (!was.skills && !was.stats) return was;
    state.slots = state.slots.map((s, i) => {
      if (i !== index) return s;
      const { chosenStats: _cs, ...rest } = s;
      return { ...rest, chosenSkills: [], chosenStatIncreases: [] };
    });
    changed();
    return was;
  }
  function stepStaff(key: keyof Staff, delta: number): void {
    const row = staffRows(state.roster, limits()).find((r) => r.key === key);
    if (!row || (key === "apothecary" && state.roster && !state.roster.apothecaryAllowed)) return;
    state.staff = { ...state.staff, [key]: Math.max(row.min, Math.min(row.max, state.staff[key] + delta)) };
    schedulePreview();
  }
  function stepInducement(key: string, delta: number): void {
    const item = state.inducementCatalog.find((i) => i.key === key);
    if (!item?.allowed) return;
    const max = inducementTerms(item).max;
    const next = Math.max(0, Math.min(max == null ? Number.MAX_SAFE_INTEGER : Math.max(0, max), (state.inducementCounts[key] ?? 0) + delta));
    const counts = { ...state.inducementCounts };
    if (next) counts[key] = next; else delete counts[key];
    state.inducementCounts = counts;
    schedulePreview();
  }

  /** Free Create's "Ignore in-game limits". Turning it off puts the race's roster limits back: stars from other races
   *  (or the wrong league) leave (pairs together), positions over their max or group cap drop their latest rows, skills
   *  outside the position's access and stat increases past one per player go; the notice says how many changes. */
  async function setIgnoreLimits(on: boolean): Promise<void> {
    if (!free() || state.ignoreLimits === on) return;
    if (on) { state.ignoreLimits = true; changed(); return; }
    const gen = generation;
    await Promise.allSettled([...new Set(state.slots.filter((s) => s.chosenSkills.length).map((s) => s.positionId))].map((id) => ensureLegal(id)));
    if (gen !== generation) return;
    // The offered stars and every position lookup below are the race's own once the box is off.
    state.ignoreLimits = false;
    let undone = 0;
    const offered = new Set(starChoices().flatMap((c) => c.members.map((m) => m.positionId)));
    const counts = new Map<string, number>();
    const kept: Slot[] = [];
    for (const s of state.slots) {
      const p = positionById(s.positionId);
      const n = counts.get(s.positionId) ?? 0;
      const over = !p || (p.isStar ? !offered.has(p.positionId) : n >= p.max || Boolean(core.positionGroupCapped(s.positionId, state.roster?.positionGroups, counts)));
      if (over) { undone++; continue; }
      counts.set(s.positionId, n + 1);
      const set = legalSet(s.positionId);
      const skills = set ? s.chosenSkills.filter((k) => [...set.primary, ...set.secondary].some((e) => e.skill === k)) : s.chosenSkills;
      const stats = s.chosenStatIncreases.filter((k) => !statCapReason(p, k)).slice(0, 1);
      undone += s.chosenSkills.length - skills.length + s.chosenStatIncreases.length - stats.length;
      kept.push({ ...s, chosenSkills: skills, chosenStatIncreases: stats });
    }
    // A pair loses both halves when one went.
    const present = new Set(kept.map((s) => s.positionId));
    const whole = kept.filter((s) => {
      const c = positionById(s.positionId)?.isStar ? starChoiceOf(s.positionId) : undefined;
      return !c || c.members.every((m) => present.has(m.positionId));
    });
    undone += kept.length - whole.length;
    state.slots = whole;
    state.leagueNotice = undone ? `In-game limits back on: ${undone} change${undone === 1 ? "" : "s"} undone.` : "";
    changed();
  }

  // ── skill / stat pickers (model only; the view owns the dialog) ────────────────────────────────────────────────
  /** The Add skill picker: Primary / Secondary sections of category groups, innate printed skills shown owned. */
  function pickerSections(index: number): Array<{ label: string; access: "primary" | "secondary"; groups: PickerGroup[] }> | null {
    const slot = state.slots[index];
    const position = slot ? positionById(slot.positionId) : null;
    const set = slot ? legalSet(slot.positionId) : null;
    if (!slot || !position || !set) return null;
    const meta = (name: string) => skillMeta(name);
    const listed = new Set([...set.primary, ...set.secondary].map((s) => s.skill));
    const printed: PickerSkill[] = position.skills.map(bare).filter((n) => meta(n)?.category && !listed.has(n))
      .map((n) => ({ skill: n, category: meta(n)!.category, elite: meta(n)!.elite, innate: true }));
    const primaryCats = new Set(set.primary.map((s) => s.category));
    const secondaryCats = new Set(set.secondary.map((s) => s.category));
    const innateSecondary = (p: PickerSkill) => secondaryCats.has(p.category) && !primaryCats.has(p.category);
    const asPicker = (l: LegalSet["primary"]): PickerSkill[] => l.map((s) => ({ skill: s.skill, category: s.category ?? meta(s.skill)?.category ?? "", elite: s.elite === true || meta(s.skill)?.elite === true }));
    const printedNames = new Set(position.skills.map(bare));
    // Ignore in-game limits: every other skill in the dataset, priced as a secondary (Team Captain is never picked).
    const other: PickerSkill[] = ignoring()
      ? Object.entries(state.skillCatalog ?? {}).filter(([name, m]) => m.category && !listed.has(name) && !printedNames.has(name) && name !== core.TEAM_CAPTAIN)
        .map(([name, m]) => ({ skill: name, category: m.category, elite: m.elite }))
      : [];
    return [
      { label: "Primary", access: "primary" as const, groups: groupByCategory([...asPicker(set.primary), ...printed.filter((p) => !innateSecondary(p))]) },
      { label: "Secondary", access: "secondary" as const, groups: groupByCategory([...asPicker(set.secondary), ...printed.filter(innateSecondary)]) },
      { label: "Other skills", access: "secondary" as const, groups: groupByCategory(other) },
    ].filter((s) => s.groups.length);
  }
  async function openSkills(index: number): Promise<string> {
    const slot = state.slots[index];
    if (!slot || isStarSlot(slot)) return "Stars never take added skills.";
    try {
      await Promise.all([ensureSkillCatalog(), ensureLegal(slot.positionId)]);
      return "";
    } catch (e) {
      return `Couldn't load legal skills (${(e as Error).message}).`;
    }
  }
  /** A skill chip's price: Sevens count rulesets price in Skill Points (a Primary 1, the swapped Secondary 2; plus any gold
   *  the package charges), every other ruleset in the core's gold estimate. */
  function skillPrice(access: "primary" | "secondary", elite: boolean): string {
    const k = limits()?.skills;
    if (k && k.maxPrimary != null) {
      const g = access === "secondary" ? (elite ? k.gold.eliteSecondary : k.gold.secondary) : (elite ? k.gold.elitePrimary : k.gold.primary);
      const sp = access === "secondary" ? (k.secondarySwap ? k.secondarySwapRatio : 0) : 1;
      return [`${sp} SP`, g ? `+${core.gold(g)}` : ""].filter(Boolean).join(" · ");
    }
    return `+${core.gold((access === "secondary" ? core.SKILL_GOLD.secondary : core.SKILL_GOLD.primary) + (elite ? core.SKILL_GOLD.elite : 0))}`;
  }
  /** The Advance dialog's stat bar (owner 11-01): per allowed characteristic, the current value and the "+" / "−" steps.
   *  "+" runs the same gate as before (statBlock: the core's per-player and tier limits plus the BB2025 caps); "−" removes
   *  an increase this player has (never below the printed value). AG / PA / AV improve as targets: 3+ → 2+. */
  function statSteps(index: number) {
    const slot = state.slots[index];
    const position = slot ? positionById(slot.positionId) : null;
    if (!slot || !position) return [];
    const chosen = heldStats(slot);
    // The Veteran's tiles read from its printed profile (MA one lower), as the validator measures it.
    const shown = displayPosition(slot) ?? position;
    const now = core.improvedStats(shown, chosen);
    const ruleOff = !statsRuleAllowed();
    const rules = statRuleSet();
    const taken = teamStatIncreases();
    const who = { race: statRulesRace(), position: position.name, keywords: position.keywords, type: position.type };
    // Always the five tiles. A ruleset that disallows increases (or a race with none set up) shows them greyed out, each
    // "+" carrying the reason; "−" still works on increases the player already has, so a stale one can be removed.
    return STAT_KEYS.map((stat) => {
      const has = chosen.includes(stat);
      const offered = !ruleOff && allowedStats().includes(stat);
      const rule = offered && !has ? statRuleBlock(rules, who, stat) || teamCapBlock(rules, taken) : "";
      const block = rule || (offered ? statBlock(slot, position, stat) : ruleOff ? STATS_OFF_REASON : `${stat} increases aren't available here.`);
      const reason = has && block === "Already taken." ? `${stat} already has its increase.` : block;
      const next = core.improvedStats(shown, [...chosen, stat]);
      const cost = offered ? core.statIncreaseCost(statRules(), stat) : null;
      return {
        stat, reason, has, value: String(now[stat as Stat].value), up: now[stat as Stat].improved,
        to: String(reason ? now[stat as Stat].value : next[stat as Stat].value), cost: cost != null ? `+${core.gold(cost)}` : "",
        removeReason: has ? "" : ruleOff ? STATS_OFF_REASON : `No ${stat} increase to remove.`,
      };
    });
  }
  /** Row-level locks for the Skills tab buttons. */
  function slotLocks(index: number) {
    const slot = state.slots[index]!;
    const exclusive = statRules()?.exclusiveWithSkills !== false;
    const liveStats = heldStats(slot);
    const maxStats = Number(statRules()?.maxPerPlayer ?? 1) || 1;
    return {
      liveStats,
      skillLocked: Boolean(statRules()) && exclusive && liveStats.length > 0,
      canMoreSkills: moreSkills(slot),
      statOffered: Boolean(statRules()) && allowedStats().length > 0,
      statLocked: exclusive && slot.chosenSkills.length > 0,
      statFull: liveStats.length >= maxStats,
      maxStats,
    };
  }
  /** The roster row's single "+" (owner 11-01: replaces + Skill / + Stat). Shown on every non-star row; open while the
   *  player may take a skill, or stat increases are offered at all (the dialog's "−" can then free the player). */
  function advanceLock(index: number): { offered: boolean; stats: boolean; reason: string } {
    const slot = state.slots[index];
    if (!slot || isStarSlot(slot)) return { offered: false, stats: false, reason: "Stars never take added skills or stat increases." };
    const l = slotLocks(index);
    const skillOpen = !l.skillLocked && l.canMoreSkills;
    const hasAdded = slot.chosenSkills.length > 0 || heldStats(slot).length > 0; // Reset and the removals need the dialog open
    const reason = skillOpen || l.statOffered || hasAdded ? "" : l.skillLocked ? "A player with a stat increase can't also have an added skill."
      : packageMoreReason(slot) || "This player can't take another skill.";
    return { offered: true, stats: l.statOffered, reason };
  }

  // ── restore / saves ───────────────────────────────────────────────────────────────────────────────────────────
  /** Restore the builder from a saved TeamBuilderBody; false when superseded mid-way or not restorable. */
  async function applyBody(body: Rec, gen: number): Promise<boolean> {
    const stale = () => gen !== generation;
    const packageName = sv(body.packageName);
    state.packageName = packageName;
    state.teamName = sv(body.teamName);
    state.editingTeamId = typeof body.teamId === "string" && body.teamId.trim() ? body.teamId : null;
    state.roster = state.rosters.find((r) => r.rosterId === body.rosterId) ?? null;
    if (!state.roster) {
      setStatus(`The saved roster "${sv(body.rosterId)}" isn't available on this server.`, true);
      state.slots = [];
      return false;
    }
    state.ignoreLimits = packageName === FREE_CREATE_PACKAGE && body.ignoreLimits === true;
    state.league = core.reconcileLeagueSelection(leagueOptions(),
      typeof body.specialRule === "string" && body.specialRule ? { selectedLeague: body.specialRule, explicit: true } : { selectedLeague: "", explicit: false });
    state.slots = nameUnnamed(core.reconcileCaptain(core.slotsFromPicks(body.picks, positionById), positionById, captainRules()));
    // Sevens Matched Play starts Dedicated Fans at 0, so a saved 0 is kept for a Sevens ruleset (fitStaff clamps it below).
    const sevensBody = packageName === SEVENS_FREE_CREATE_PACKAGE || state.packages.some((p) => p.name === packageName && p.format === "sevens");
    const fans = Number(body.dedicatedFans);
    state.staff = {
      reRolls: Number(body.reRolls) || 0, assistantCoaches: Number(body.assistantCoaches) || 0, cheerleaders: Number(body.cheerleaders) || 0,
      dedicatedFans: sevensBody && fans === 0 ? 0 : fans || 1, apothecary: body.apothecary ? 1 : 0,
    };
    state.skillPack = typeof body.skillPack === "string" ? body.skillPack : null;
    const induced = arr(body.rosteredInducements ?? body.inducements).filter(isRec);
    state.inducementCounts = Object.fromEntries(induced.map((p) => [sv(p.key), Number(p.count) || 0]));
    state.preview = null;
    await Promise.all([loadPackageRules(), loadInducements(), ensureSkillCatalog()]);
    if (stale()) return false;
    fitStaff(false);
    state.slots = reconcileVeteran(state.slots);
    for (const p of induced) {
      const item = state.inducementCatalog.find((i) => i.key === p.key && i.allowed);
      if (item) state.inducementCounts = { ...state.inducementCounts, [item.key]: Number(p.count) || 0 };
    }
    clampInducements();
    // Exact primary/secondary colouring needs every skilled position's access lists.
    await Promise.allSettled([...new Set(state.slots.filter((s) => s.chosenSkills.length).map((s) => s.positionId))].map((id) => ensureLegal(id)));
    if (stale()) return false;
    schedulePreview();
    return true;
  }
  /** A 401 keeps everything (the open save too, so the page stays at its address and no edit is lost): sign in again
   *  and save. */
  function sessionExpired(message: string): void {
    state.savesStatus = message;
    deps.onSignedOut?.();
  }
  function savesError(e: unknown, action: string): void {
    if (e instanceof ApiError && e.status === 401) { sessionExpired("Your session expired. Sign in again to use saved teams."); return; }
    state.savesStatus = `Couldn't ${action} (${(e as Error).message}).`;
  }
  /** Load a save; `silent` (a deep link) drops errors so a stale link just leaves the builder as it is. */
  async function loadSave(id: string, opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!SAVE_ID_RE.test(id) || !deps.coach()) return false;
    const gen = ++generation;
    try {
      const data = await api<Rec>(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`);
      if (gen !== generation) return false;
      const save = isRec(data?.save) ? data.save : null;
      if (!save || !isRec(save.body)) throw new Error("Saved team has no builder state.");
      const body = save.body;
      if (!body.packageName) {
        if (!opts.silent) state.savesStatus = `“${sv(save.name)}” isn't a tournament team; open it in the Team Builder.`;
        return false;
      }
      // A save whose ruleset is gone is not loaded: saving it again would drop its packageName.
      if (body.packageName !== FREE_CREATE_PACKAGE && body.packageName !== SEVENS_FREE_CREATE_PACKAGE && !state.packages.some((p) => p.name === body.packageName)) {
        state.savesStatus = "This team's ruleset is no longer available.";
        return false;
      }
      state.currentSave = { id: sv(save.id) || id, name: sv(save.name), ...(typeof save.shareToken === "string" && /^[0-9a-f]{32}$/.test(save.shareToken) ? { shareToken: save.shareToken } : {}) };
      state.shareUrl = state.currentSave.shareToken ? shareLink(state.currentSave.shareToken) : "";
      // A save that was already built edits its fork team instead of minting a second one (organizers, as the vanilla page).
      const restored = deps.organizer?.() && typeof save.teamId === "string" && save.teamId && !body.teamId ? { ...body, teamId: save.teamId } : body;
      const applied = await applyBody(restored, gen);
      if (!applied) return false;
      state.savesStatus = `Loaded “${state.currentSave?.name ?? sv(save.name)}”.`;
      return true;
    } catch (e) {
      if (opts.silent && !(e instanceof ApiError && e.status === 401)) return false;
      if (gen !== generation && !(e instanceof ApiError && e.status === 401)) return false;
      savesError(e, "load the team");
      return false;
    }
  }
  /** Save Team: a new save is named after the team; an open save keeps its name (PUT). */
  async function saveTeam(): Promise<boolean> {
    if (!deps.coach() || !state.roster || state.saveBusy) return false;
    const name = state.currentSave?.name || state.teamName.trim() || `${state.roster.raceName} team`;
    const body = requestBody({ forSave: true });
    const gen = generation;
    state.saveBusy = true;
    try {
      const data = state.currentSave
        ? await api<Rec>(`/api/fork/team-builder/saves/${encodeURIComponent(state.currentSave.id)}`, { method: "PUT", body: { name, body } })
        : await api<Rec>("/api/fork/team-builder/saves", { method: "POST", body: { name, body } });
      const save = isRec(data?.save) ? data.save : null;
      const savedName = sv(save?.name) || name;
      if (gen !== generation) state.savesStatus = `Saved “${savedName}” (earlier roster).`;
      else {
        if (save && typeof save.id === "string") state.currentSave = { ...state.currentSave, id: save.id, name: savedName };
        state.savesStatus = `Saved “${savedName}”. It is in My teams.`;
      }
      return true;
    } catch (e) {
      savesError(e, "save the team");
      return false;
    } finally {
      state.saveBusy = false;
    }
  }
  const origin = (): string => deps.origin?.() ?? (typeof location !== "undefined" ? location.origin : "");
  const shareLink = (token: string): string => `${origin()}/t/${token}`;
  async function copy(text: string): Promise<boolean> {
    try {
      if (deps.clipboard) await deps.clipboard(text);
      else await navigator.clipboard.writeText(text);
      return true;
    } catch { return false; }
  }
  /** Share the open save: POST .../share (idempotent) -> the public /t/<token> link, copied when the browser allows. */
  async function share(): Promise<boolean> {
    const save = state.currentSave;
    if (!deps.coach() || !save || state.shareBusy) return false;
    state.shareBusy = true;
    try {
      const data = await api<Rec>(`/api/fork/team-builder/saves/${encodeURIComponent(save.id)}/share`, { method: "POST" });
      const token = sv(data?.shareToken);
      if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("No share link returned.");
      if (state.currentSave?.id === save.id) state.currentSave = { ...state.currentSave, shareToken: token };
      state.shareUrl = shareLink(token);
      state.savesStatus = (await copy(state.shareUrl)) ? `Link copied: anyone with it can view “${save.name}”.` : `Share link ready for “${save.name}”.`;
      return true;
    } catch (e) {
      savesError(e, "share the team");
      return false;
    } finally {
      state.shareBusy = false;
    }
  }
  /** Revoke the open save's share link (DELETE .../share): the old /t/<token> stops working. */
  async function unshare(): Promise<boolean> {
    const save = state.currentSave;
    if (!deps.coach() || !save || state.shareBusy) return false;
    state.shareBusy = true;
    try {
      await api(`/api/fork/team-builder/saves/${encodeURIComponent(save.id)}/share`, { method: "DELETE" });
      if (state.currentSave?.id === save.id) state.currentSave = { id: save.id, name: save.name };
      state.shareUrl = "";
      state.savesStatus = `“${save.name}” is no longer shared.`;
      return true;
    } catch (e) {
      savesError(e, "stop sharing the team");
      return false;
    } finally {
      state.shareBusy = false;
    }
  }
  async function copyShare(): Promise<void> {
    if (state.shareUrl) state.savesStatus = (await copy(state.shareUrl)) ? "Link copied." : "Couldn't copy; select the link and copy it.";
  }
  /** Create team on Fork (or save the linked fork team): POST /build with the open save id. */
  async function build(): Promise<boolean> {
    if (!deps.coach()) { state.buildResult = { ok: false, title: "Sign in to create on Fork", lines: ["Sign in with Discord to create this team."] }; return false; }
    if (forkBlocked()) { state.buildResult = { ok: false, title: "Tabletop only", lines: [forkBlocked()] }; return false; }
    if (!canBuild()) return false;
    state.buildBusy = true;
    state.buildResult = null;
    try {
      const result = await api<Rec>("/api/fork/team-builder/build", { method: "POST", body: { ...requestBody(), ...(state.currentSave ? { saveId: state.currentSave.id } : {}) } });
      state.buildResult = { ok: true, title: state.editingTeamId ? "Team saved" : "Team created", lines: [`Installed ${sv(result?.teamId)}: ready in Create Game.`] };
      if (state.currentSave && typeof result?.teamId === "string" && result.teamId && deps.organizer?.()) state.editingTeamId = result.teamId;
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) sessionExpired("Your session expired. Sign in again to create the team.");
      const data = e instanceof ApiError && isRec(e.data) ? e.data : null;
      state.buildResult = { ok: false, title: "Build failed", lines: [(e as Error).message, ...arr(data?.errors).map(findingText)] };
      return false;
    } finally {
      state.buildBusy = false;
    }
  }

  // ── sheet + PDF ───────────────────────────────────────────────────────────────────────────────────────────────
  function sheetModel(): PrintSheetModel {
    const roster = state.roster;
    const l = limits();
    const vet = veteranRule();
    const staffLines = l?.staffPriced
      ? Object.fromEntries(staffRows(roster, l).map((r) => [r.key, { price: r.cost, free: r.free }]))
      : null;
    return { ...core.rosterSheetModel({
      raceName: roster?.raceName ?? "",
      coach: deps.coach(),
      teamName: state.teamName.trim(),
      rulesetName: [rulesetLabel(), raceRules()?.tierLabel].filter(Boolean).join(" — "),
      players: state.slots.map((s) => {
        const star = isStarSlot(s);
        return {
          position: positionById(s.positionId),
          name: star ? "" : s.name ?? "",
          chosenSkills: star ? [] : s.chosenSkills,
          chosenStatIncreases: star ? [] : heldStats(s),
          chosenStats: null,
          captain: s.captain === true && slotCanCaptain(s),
          veteran: !star && veteranOn(s),
          accessOf: (k: string) => (accessOf(s.positionId, k) === "secondary" ? "secondary" : "primary"),
        };
      }),
      staff: state.staff,
      apothecaryAllowed: roster?.apothecaryAllowed !== false,
      inducements: inducementPicks().map((p) => ({ label: state.inducementCatalog.find((i) => i.key === p.key)?.label ?? p.key, count: p.count })),
      specialRules: [...(roster?.specialRules ?? []), ...(roster?.alwaysOnRules ?? []), ...(activeLeague() ? [activeLeague()] : [])],
      captainAvailable: captainAvailable(),
      // Free Create has no preview: the sheet's Total row is the client total (no cap).
      summary: free() ? { goldUsed: totals().used } : state.preview?.summary ?? null,
      costs: { players: rawPlayerCost(), stars: rawStarCost(), sideline: staffCost(), skills: addedSkillGold(), inducements: inducementGold() },
      ...(capped() ? { budget: budget() } : {}),
      ...(sevens() ? { formatTitle: formatTitle() } : {}),
      ...(vet ? { veteranMaDelta: vet.maDelta } : {}),
      ...(nonLineman() ? { nonLineman: nonLineman()! } : {}),
      ...(staffLines ? { staffPrices: staffLines } : {}),
    }), ruleset: sheetRulesetRows({
      packageName: state.packageName, tierLabel: tierLabel(), raceRules: raceRules(), pack: packSummary(), tierRules: tierRules(), league: activeLeague(),
      budget: l?.budget ?? state.packageRules?.budget ?? null, ignoreLimits: ignoring(),
      sevens: l ? { label: rulesetLabel(), minPlayers: l.minPlayers, maxPlayers: l.maxPlayers, maxNonLineman: l.maxNonLineman, veteran: Boolean(l.veteran) } : null,
    }) };
  }
  /** The shared team view model (public/team-view.js viewHtml) for the Sheet tab: the share page's look, from this build. */
  function teamViewModel() {
    const model = sheetModel();
    const t = totals();
    const cat = (name: string) => skillMeta(bare(name))?.category ?? "";
    return {
      teamName: model.teamName || "Unnamed team",
      coach: model.coach,
      raceName: model.raceName,
      crest: core.resolveCrest(state.art.crests, model.raceName),
      ruleset: state.packageName ? { name: rulesetLabel(), tierLabel: raceRules()?.tierLabel ?? null } : null,
      specialRules: model.specialRules,
      players: model.rows.map((r) => ({
        ...(r.name ? { name: r.name } : {}),
        number: r.number, position: r.position, positionFull: r.positionFull, isStar: r.isStar, captain: r.captain,
        stats: Object.fromEntries(core.STATS.map((k) => [k, r.stats[k].value])),
        printed: r.printed.map((name) => ({ name, category: cat(name) })),
        free: r.free.map((name) => ({ name, category: cat(name) })),
        added: r.added.map((s) => ({ name: s.name, category: cat(s.name), access: s.access })),
        statIncreases: r.statIncreases, cost: r.cost,
        sprite: core.resolveSprite(state.art.sprites, model.raceName, r.positionFull),
      })),
      sideline: { reRolls: state.staff.reRolls, apothecary: state.staff.apothecary === 1, assistantCoaches: state.staff.assistantCoaches, cheerleaders: state.staff.cheerleaders, dedicatedFans: state.staff.dedicatedFans },
      inducements: inducementPicks().map((p) => ({
        name: state.inducementCatalog.find((i) => i.key === p.key)?.label ?? p.key, count: p.count, icon: state.art.icons?.icons?.[p.key] ?? null,
      })),
      summary: {
        players: t.players, playersCost: t.playersCost, starsCost: t.starsCost, skillsCost: t.skillsCost, inducementsCost: t.inducementsCost,
        sidelineCost: t.sidelineCost, primarySkills: t.primary, secondarySkills: t.secondary, total: t.used, cap: t.capped ? t.budget : null,
      },
    };
  }
  /** Export PDF: built in the browser (sheet-pdf.js + the vendored pdfmake, loaded on first use). One deadline bounds
   *  the asynchronous phases; any failure falls back to the print dialog with a short notice. */
  async function exportPdf(): Promise<"pdf" | "print" | "skipped"> {
    if (!canExport()) return "skipped";
    state.pdfBusy = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Export timed out")), SHEET_PDF_TIMEOUT_MS); });
    expired.catch(() => undefined);
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]);
    let model: SheetModel | null = null;
    let pdf: SheetPdfApi | null = null;
    try {
      await bounded(Promise.allSettled([...new Set(state.slots.filter((s) => s.chosenSkills.length).map((s) => s.positionId))].map((id) => ensureLegal(id))));
      model = sheetModel();
      pdf = await bounded((deps.loadSheetPdf ?? browserLoadSheetPdf)());
      const pdfMake = await bounded(pdf.loadPdfMake());
      await bounded(new Promise((r) => setTimeout(r, 0)));
      const doc = pdf.buildSheetDocDefinition(model, { gold: core.gold, generatedOn: new Date() });
      const blob = await bounded(pdfMake.createPdf(doc).getBlob());
      (deps.saveBlob ?? browserSaveBlob)(blob, pdf.sheetPdfFileName(core.sheetFileName(model)));
      return "pdf";
    } catch {
      pdf?.abandonPdfMakeLoad?.();
      state.buildResult = { ok: false, title: "Export PDF", lines: ["PDF service unavailable, opened the print dialog instead."] };
      // The sheet's own stylesheet rides with it (table rules, print colours, A4 landscape), as on the vanilla page.
      state.printHtml = `<style>${core.SHEET_CSS}</style>${core.rosterSheetHtml(model ?? sheetModel())}`;
      deps.print?.();
      return "print";
    } finally {
      if (timer) clearTimeout(timer);
      state.pdfBusy = false;
    }
  }

  /** Boot, then follow the deep link: a save id (path or ?save=), else ?package=[&race=]. Resolves the tab to open. */
  async function init(link: { saveId?: string; packageName?: string; race?: string }): Promise<BuilderTab> {
    if (!state.booted) await boot();
    if (link.saveId && deps.coach() && (await loadSave(link.saveId, { silent: true }))) return "roster";
    if (link.packageName && (link.packageName === FREE_CREATE_PACKAGE || link.packageName === SEVENS_FREE_CREATE_PACKAGE || state.packages.some((p) => p.name === link.packageName))) {
      await choosePackage(link.packageName);
      if (link.race && state.rosters.some((r) => r.rosterId === link.race) && (await chooseRace(link.race))) return "roster";
    }
    return "ruleset";
  }

  return {
    state,
    // derived
    positionById, shortName, raceRules, tierRules, statRules, allowedStats, packSummary, captainAvailable, slotCanCaptain, leagueOptions,
    leaguePresentation, activeLeague, selectedSpecialRule, accessOf, isElite, eliteMark, skillClass, totals, valueLines, validity, canExport, canBuild, canSave,
    skillPoints, positionCards, positionBreakdown, starChoices, starRow, starCap, starPickCount, starsAllowed, starSpTable, inducementRows, rulesetLines, tierLabel, raceTable,
    eligibleRosters, staffRows: () => staffRows(state.roster, limits()), staffIcon, skillIcon, spritePath, crestPath, pickerSections, skillPrice, statSteps, advanceLock,
    captainIndex, skillAllowance, slotLocks, legalSet, requestBody, sheetModel, teamViewModel, gateCtx, named, signedIn: (): boolean => Boolean(deps.coach()),
    free, ignoring, capped, canShare, skillBlock, moreSkills, rulesetCards, rulesetLabel, freeRaces, canAddStar,
    sevens, sevensFree, limits, maxPlayers, nonLineman, canVeteran, veteranIndex, displayPosition, forkBlocked, starsOffReason, formatTitle,
    // actions
    init, boot, choosePackage, chooseRace, setTeamName, selectLeague, setSkillPack, addPosition, removeSlot, addStar, removeStar, moveSlot,
    toggleCaptain, toggleVeteran, openSkills, addSkill, removeSkill, addStat, removeStat, resetSummary, resetPlayer, renameSlot, rerollName, stepStaff, stepInducement, setIgnoreLimits, schedulePreview, flushPreview,
    loadSave, saveTeam, share, unshare, copyShare, build, exportPdf,
  };
}

export type TournamentBuilder = ReturnType<typeof createTournamentBuilder>;
export const TOURNAMENT_BUILDER_KEY: InjectionKey<TournamentBuilder> = Symbol("tournament-builder");

/** The working pane's shared UI (the view provides it): the "name your team first" gate. Adding a player or a star to an
 *  unnamed team sets `nameGate` (the save-line box lists the message until the team is named) and focuses the team
 *  name field in the Team controls. */
export interface TournamentBuilderUi {
  nameGate: boolean;
  requireName: () => boolean;
  /** Bumped each time a hire (position card or star) adds rows: the roster scrolls its newest row into view. Never bumped
   *  by reorder, fire, a load, a deep link or a remount. */
  added: number;
  noteAdded: () => void;
  /** Pack rulesets: true while the coach re-opened the skill-pack list ("Change skill pack"). Transient: a remount with a pack
   *  chosen opens on the save line. */
  packPicking: boolean;
  /** The Team panel shows the pack list (save line and the Validator's rule bullets hidden): a pack ruleset with no pack
   *  chosen yet, or re-opened. */
  pickingPack: () => boolean;
}
export const TOURNAMENT_BUILDER_UI_KEY: InjectionKey<TournamentBuilderUi> = Symbol("tournament-builder-ui");
