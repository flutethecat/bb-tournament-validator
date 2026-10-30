// Tournament Builder controller (/app/tournament-team-builder, owner 10-30): the coach-facing team builder against a
// tournament ruleset, migrated from public/tournament-team-builder.html. No DOM: the view renders `state` and calls the
// methods. The rules gates, pick wire, tier tables and sheet model come from the shared pure core (builderCore.ts, the
// same code the vanilla page runs); the server preview (POST /api/fork/team-builder/preview) is the authority on legality.
//
// Endpoints: GET /api/fork/rosters, /api/packages, /api/packages/<name>?roster=, /api/fork/team-builder/tiers,
// /inducements, /legal-skills, /api/skills, the art manifests; POST /preview, /build; saves (GET/POST/PUT
// /api/fork/team-builder/saves[/<id>]) and share links (POST/DELETE /saves/<id>/share).

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

// ── wire shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PackageRow { name: string; description: string }
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
}

export type BuilderTab = "ruleset" | "roster" | "skills" | "staff" | "sheet";
export const BUILDER_TABS: ReadonlyArray<{ id: BuilderTab; label: string }> = [
  { id: "ruleset", label: "Ruleset" },
  { id: "roster", label: "Roster" },
  { id: "skills", label: "Skills" },
  { id: "staff", label: "Staff & Inducements" },
  { id: "sheet", label: "Sheet" },
];
export const isBuilderTab = (v: unknown): v is BuilderTab => BUILDER_TABS.some((t) => t.id === v);

/** Sideline staff (BB2025 costs; rerolls priced per roster). */
export interface StaffRow { key: keyof Staff; label: string; min: number; max: number; cost: number; free: number }
export function staffRows(roster: BuilderRoster | null): StaffRow[] {
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
}

function blankState(): BuilderState {
  return {
    booted: false, bootError: "", packages: [], rosters: [], packageName: "", packageDoc: null, packageRules: null, tierRows: [],
    roster: null, teamName: "", league: { selectedLeague: "", explicit: false }, leagueNotice: "", slots: [], staff: freshStaff(), skillPack: null,
    inducementCatalog: [], inducementCounts: {}, inducementStatus: "", preview: null, previewPending: false, skillCatalog: null, legal: {},
    art: { sprites: null, crests: null, icons: null, skillIcons: null, uiIcons: null }, status: "", statusError: false,
    currentSave: null, savesStatus: "", saveBusy: false, shareBusy: false, shareUrl: "", editingTeamId: null, buildBusy: false, buildResult: null,
    pdfBusy: false, printHtml: "",
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
  const positionById = (id: string): BuilderPosition | null => state.roster?.positions.find((p) => p.positionId === id) ?? null;
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
  const tierRules = (): TierRules | null => core.normalizeTierRules(state.preview?.package?.rules) ?? core.normalizeTierRules(ownTierRow()?.raw);
  const statRules = (): StatRules | null => tierRules()?.statIncreases ?? null;
  const allowedStats = (): string[] => core.allowedStatList(statRules());
  const packSummary = (): SkillPack | null => {
    const race = raceRules();
    return race && state.skillPack ? race.packs.find((p) => p.label === state.skillPack) ?? null : null;
  };
  const skillMeta = (skill: string): SkillMeta | null => state.skillCatalog?.[skill] ?? null;
  const isElite = (skill: string): boolean => core.isEliteSkill(skill, raceRules()?.skillCosts?.eliteSkills, skillMeta(skill));
  const legalKey = (positionId: string): string => `${state.roster?.rosterId}:${positionId}`;
  const legalSet = (positionId: string): LegalSet | null => state.legal[legalKey(positionId)] ?? null;
  function accessOf(positionId: string, skill: string): Access {
    const set = legalSet(positionId);
    if (set?.primary.some((e) => e.skill === skill)) return "primary";
    if (set?.secondary.some((e) => e.skill === skill)) return "secondary";
    return "primary";
  }
  const gateCtx = (): GateContext => ({
    mode: "tournament", slots: state.slots, positionById, tierRules: tierRules(), raceRules: raceRules(), packSummary: packSummary(),
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
  const positionCount = (id: string): number => state.slots.filter((s) => s.positionId === id).length;
  const positionCounts = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const s of state.slots) m.set(s.positionId, (m.get(s.positionId) ?? 0) + 1);
    return m;
  };

  // ── money ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const isStarSlot = (s: Slot): boolean => positionById(s.positionId)?.isStar === true;
  const rawPlayerCost = (): number => state.slots.filter((s) => !isStarSlot(s)).reduce((n, s) => n + (positionById(s.positionId)?.cost ?? 0), 0);
  const rawStarCost = (): number => state.slots.filter(isStarSlot).reduce((n, s) => n + (positionById(s.positionId)?.cost ?? 0), 0);
  const staffCost = (): number => staffRows(state.roster).reduce((n, r) => n + Math.max(0, state.staff[r.key] - r.free) * r.cost, 0);
  const inducementPicks = (): Array<{ key: string; count: number }> =>
    Object.entries(state.inducementCounts).filter(([, c]) => c > 0).map(([key, count]) => ({ key, count }));
  const inducementGold = (): number =>
    inducementPicks().reduce((n, p) => n + p.count * inducementTerms(state.inducementCatalog.find((i) => i.key === p.key)).price, 0);
  const addedSkillGold = (): number => state.slots.reduce((n, s) => n + core.slotSkillGold(gateCtx(), s), 0);
  const statGold = (): number => {
    const rules = statRules();
    const allowed = allowedStats();
    return state.slots.filter((s) => !isStarSlot(s))
      .reduce((n, s) => n + s.chosenStatIncreases.filter((k) => allowed.includes(k)).reduce((m, k) => m + (core.statIncreaseCost(rules, k) ?? 0), 0), 0);
  };
  const budget = (): number => packSummary()?.gold ?? state.preview?.package?.budget ?? state.packageRules?.budget ?? 1_000_000;
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
      over: used > budget(),
      estimated: !s,
    };
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
    lines.push({ label: "Primary skills", value: String(t.primary) });
    lines.push({ label: "Secondary skills", value: String(t.secondary) });
    const pack = packSummary();
    if (pack && (pack.maxSkills != null || pack.maxSecondary != null)) {
      const total = t.primary + t.secondary;
      const over = (pack.maxSkills != null && total > pack.maxSkills) || (pack.maxSecondary != null && t.secondary > pack.maxSecondary);
      lines.push({ label: "Pack skills", value: `${total} / ${pack.maxSkills ?? "∞"}${pack.maxSecondary != null ? ` (${t.secondary} / ${pack.maxSecondary} secondary)` : ""}`, ...(over ? { tone: "over" as const } : {}) });
    }
    const spBudget = pack?.skillPointBudget || s?.skillPointBudget || raceRules()?.skillPointBudget || 0;
    if (spBudget) {
      const used = s?.skillPointsUsed ?? state.slots.reduce((n, sl) => n + core.playerSkillSp(sl.chosenSkills, (k) => accessOf(sl.positionId, k) === "secondary", raceRules()?.skillCosts ?? core.DEFAULT_SKILL_COSTS), 0);
      lines.push({ label: "Skill points", value: `${used} / ${spBudget}`, ...(used > spBudget ? { tone: "over" as const } : {}) });
    }
    lines.push({ label: t.estimated ? (state.previewPending ? "Calculating team value..." : "Estimate") : "Total", value: `${core.gold(t.used)} / ${core.gold(t.budget)}`, ...(t.over ? { tone: "over" as const } : {}) });
    return lines;
  }

  // ── validity ──────────────────────────────────────────────────────────────────────────────────────────────────────
  function notices(): string[] {
    const out: string[] = [];
    if (!deps.coach()) out.push("You must sign in with Discord to save or create the team.");
    if (!state.roster) out.push("Choose a ruleset and a race to start.");
    else {
      if (!state.teamName.trim()) out.push("Name your team.");
      if (!state.slots.length) out.push("Add players from the position cards.");
    }
    return out;
  }
  const checkable = (): boolean => Boolean(state.roster && state.slots.length && state.teamName.trim());
  function validity(): { tone: "pending" | "checking" | "valid" | "invalid"; headline: string; errors: string[]; warnings: string[]; notices: string[] } {
    const ok = checkable();
    const p = state.preview;
    const errors = ok ? (p?.errors ?? []).map(findingText) : [];
    const warnings = ok ? (p?.warnings ?? []).map(findingText) : [];
    let tone: "pending" | "checking" | "valid" | "invalid" = "checking";
    let headline = "Checking team...";
    if (!ok) { tone = "pending"; headline = "Not ready yet"; }
    else if (p?.failed) { tone = "invalid"; headline = "Couldn't check the team"; }
    else if (p) {
      tone = p.valid ? "valid" : "invalid";
      headline = p.valid ? "Team is valid" : `Team is invalid${errors.length && !state.previewPending ? `: ${errors.length} ${errors.length === 1 ? "issue" : "issues"} to fix` : ""}`;
    }
    return { tone, headline, errors, warnings, notices: notices() };
  }
  const sheetValid = (): boolean => state.preview?.valid === true && !state.previewPending;
  const canExport = (): boolean => Boolean(state.roster && state.slots.length) && sheetValid() && !state.pdfBusy;
  const canBuild = (): boolean => Boolean(deps.coach()) && sheetValid() && !state.buildBusy;
  const canSave = (): boolean => Boolean(deps.coach() && state.roster) && !state.saveBusy;

  // ── roster model (positions, stars, inducements) ────────────────────────────────────────────────────────────────
  function positionCards() {
    const roster = state.roster;
    if (!roster) return [];
    const counts = positionCounts();
    return roster.positions.filter((p) => !p.isStar).slice().sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)).map((position) => {
      const count = counts.get(position.positionId) ?? 0;
      const group = core.positionGroupCapped(position.positionId, roster.positionGroups, counts);
      const name = shortName(position);
      return {
        position, name, count, left: Math.max(0, position.max - count), group,
        exhausted: count >= position.max || Boolean(group) || state.slots.length >= core.MAX_PLAYERS,
        role: core.cardRoleTag(position, roster.positions, name),
      };
    });
  }
  const starChoices = (): StarChoice[] => (state.roster ? core.offeredStarChoices(starCtx()) : []);
  const starCap = (): number | null => core.starCap(raceRules(), tierRules());
  const starPickCount = (): number => core.buildStarChoices(state.roster?.positions ?? []).filter((c) => c.members.some((m) => positionCount(m.positionId) > 0)).length;
  const starsAllowed = (): boolean => Boolean(state.roster) && (raceRules()?.stars?.allowed ?? true);
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
      canAdd: core.canAddStarChoice(starCtx(), choice) && !(cap != null && starPickCount() >= cap && present === 0),
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
    if (race) {
      const pack = packSummary();
      lines.push([`Budget ${core.gold(pack?.gold ?? race.gold)}`,
        !race.packs.length ? (race.skillPointBudget ? `${race.skillPointBudget} SP` : "") : pack ? `${core.packSkillText(pack)} (${pack.label})` : "",
        race.maxPerPlayer != null ? `${race.maxPerPlayer} skill${race.maxPerPlayer === 1 ? "" : "s"}/player` : ""].filter(Boolean).join(" · "));
      if (race.stars) lines.push(race.stars.allowed ? `Stars${race.stars.maxCount != null ? ` (max ${race.stars.maxCount})` : ""}${race.stars.paidInSkillPoints ? ", paid in SP" : ""}` : "No star players");
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
        .map((r) => ({ name: sv(r.name), description: sv(r.description) }));
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
    if (!name) { state.packageRules = null; state.packageDoc = null; state.tierRows = []; return; }
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
  }
  async function loadInducements(): Promise<void> {
    const seq = ++inducementSequence;
    const name = state.packageName;
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
    const rulesUnknown = !tierRules();
    const keepAll = Boolean(opts.forSave) && rulesUnknown;
    const picks = core.buildPicks(state.slots.map((s) => ({ ...s, isStar: isStarSlot(s), captain: s.captain === true && slotCanCaptain(s) })), {
      skills: true, captain: captainAvailable(), stats: keepAll || Boolean(statRules()), allowedStats: keepAll ? null : allowedStats(),
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
    };
  }
  function schedulePreview(): void {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    previewSequence++;
    if (state.preview && state.preview.rosterId !== state.roster?.rosterId) state.preview = null;
    if (!checkable()) { state.previewPending = false; return; }
    state.previewPending = true;
    const seq = previewSequence;
    previewTimer = setTimeout(() => { previewTimer = null; void runPreview(seq); }, delay);
  }
  async function runPreview(seq: number): Promise<void> {
    const rosterId = state.roster?.rosterId ?? "";
    try {
      const result = await api<Rec>("/api/fork/team-builder/preview", { method: "POST", body: requestBody() });
      if (seq !== previewSequence) return;
      state.preview = {
        rosterId, valid: result?.valid === true, errors: arr(result?.errors), warnings: arr(result?.warnings),
        summary: sanitizeSummary(result?.summary), package: sanitizeEcho(result?.package),
      };
    } catch (e) {
      if (seq !== previewSequence) return;
      state.preview = { rosterId, failed: true, valid: false, errors: [(e as Error).message], warnings: [], summary: state.preview?.summary ?? null, package: state.preview?.package ?? null };
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
    state.slots = core.reconcileCaptain(state.slots, positionById, captainRules());
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
    schedulePreview();
    return true;
  }
  function setTeamName(name: string): void {
    state.teamName = name;
    schedulePreview();
  }
  function selectLeague(league: string): void {
    state.league = core.reconcileLeagueSelection(leagueOptions(), { selectedLeague: league, explicit: true });
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
  function addPosition(positionId: string): boolean {
    if (!named()) return false;
    const p = positionById(positionId);
    if (!p || p.isStar || positionCount(positionId) >= p.max || state.slots.length >= core.MAX_PLAYERS) return false;
    if (core.positionGroupCapped(positionId, state.roster?.positionGroups, positionCounts())) return false;
    state.slots = [...state.slots, { positionId, chosenSkills: [], chosenStatIncreases: [] }];
    changed();
    return true;
  }
  function removeSlot(index: number): void {
    const slot = state.slots[index];
    if (!slot) return;
    const pair = core.buildStarChoices(state.roster?.positions ?? []).find((c) => c.paired && c.members.some((m) => m.positionId === slot.positionId));
    if (pair) { removeStar(pair.key); return; }
    state.slots = state.slots.filter((_, i) => i !== index);
    changed();
  }
  function addStar(key: string): boolean {
    if (!named()) return false;
    const choice = starChoices().find((c) => c.key === key);
    if (!choice || !core.canAddStarChoice(starCtx(), choice)) return false;
    const cap = starCap();
    if (cap != null && starPickCount() >= cap) return false;
    const add = choice.members.filter((m) => positionCount(m.positionId) === 0).map((m): Slot => ({ positionId: m.positionId, chosenSkills: [], chosenStatIncreases: [] }));
    state.slots = [...state.slots, ...add];
    changed();
    return true;
  }
  function removeStar(key: string): void {
    const choice = core.buildStarChoices(state.roster?.positions ?? []).find((c) => c.key === key);
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
  /** Nominate (or clear) the Team Captain: one per team; the captain's chosen Pro goes (it gains Pro for free). */
  function toggleCaptain(index: number): void {
    const slot = state.slots[index];
    if (!slotCanCaptain(slot)) return;
    const on = slot!.captain !== true;
    state.slots = state.slots.map((s, i) => {
      const { captain: _c, ...rest } = s;
      if (i !== index || !on) return rest;
      return { ...rest, captain: true, chosenSkills: rest.chosenSkills.filter((k) => k !== "Pro") };
    });
    changed();
  }
  /** Add a skill after the shared gate re-checks it; resolves the gate's reason when refused ("" = added). */
  function addSkill(index: number, skill: string): string {
    const slot = state.slots[index];
    const block = core.skillPickBlock(gateCtx(), slot ?? null, skill);
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
    const block = core.statOptionState(gateCtx(), slot ?? null, slot ? positionById(slot.positionId) : null, stat);
    if (block || !slot) return block || "This player can't take a stat increase.";
    const live = slot.chosenStatIncreases.filter((k) => allowedStats().includes(k));
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, chosenStatIncreases: [...live, stat] } : s));
    changed();
    return "";
  }
  function removeStat(index: number, stat: string): void {
    state.slots = state.slots.map((s, i) => (i === index ? { ...s, chosenStatIncreases: s.chosenStatIncreases.filter((k) => k !== stat) } : s));
    changed();
  }
  function stepStaff(key: keyof Staff, delta: number): void {
    const row = staffRows(state.roster).find((r) => r.key === key);
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
    return [
      { label: "Primary", access: "primary" as const, groups: groupByCategory([...asPicker(set.primary), ...printed.filter((p) => !innateSecondary(p))]) },
      { label: "Secondary", access: "secondary" as const, groups: groupByCategory([...asPicker(set.secondary), ...printed.filter(innateSecondary)]) },
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
  const skillPrice = (access: "primary" | "secondary", elite: boolean): string =>
    `+${core.gold((access === "secondary" ? core.SKILL_GOLD.secondary : core.SKILL_GOLD.primary) + (elite ? core.SKILL_GOLD.elite : 0))}`;
  function statOptions(index: number) {
    const slot = state.slots[index];
    const position = slot ? positionById(slot.positionId) : null;
    if (!slot || !position) return [];
    const chosen = slot.chosenStatIncreases.filter((k) => allowedStats().includes(k));
    const now = core.improvedStats(position, chosen);
    return allowedStats().map((stat) => {
      const reason = core.statOptionState(gateCtx(), slot, position, stat);
      const next = core.improvedStats(position, [...chosen, stat]);
      const cost = core.statIncreaseCost(statRules(), stat);
      return { stat, reason, from: String(now[stat as Stat].value), to: String(reason && /no /.test(reason) ? now[stat as Stat].value : next[stat as Stat].value), cost: cost != null ? `+${core.gold(cost)}` : "" };
    });
  }
  /** Row-level locks for the Skills tab buttons. */
  function slotLocks(index: number) {
    const slot = state.slots[index]!;
    const exclusive = statRules()?.exclusiveWithSkills !== false;
    const liveStats = slot.chosenStatIncreases.filter((k) => allowedStats().includes(k));
    const maxStats = Number(statRules()?.maxPerPlayer ?? 1) || 1;
    return {
      liveStats,
      skillLocked: Boolean(statRules()) && exclusive && liveStats.length > 0,
      canMoreSkills: core.moreSkillsAllowed(gateCtx(), slot),
      statOffered: Boolean(statRules()) && allowedStats().length > 0,
      statLocked: exclusive && slot.chosenSkills.length > 0,
      statFull: liveStats.length >= maxStats,
      maxStats,
    };
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
    state.league = core.reconcileLeagueSelection(leagueOptions(),
      typeof body.specialRule === "string" && body.specialRule ? { selectedLeague: body.specialRule, explicit: true } : { selectedLeague: "", explicit: false });
    state.slots = core.reconcileCaptain(core.slotsFromPicks(body.picks, positionById), positionById, captainRules());
    state.staff = {
      reRolls: Number(body.reRolls) || 0, assistantCoaches: Number(body.assistantCoaches) || 0, cheerleaders: Number(body.cheerleaders) || 0,
      dedicatedFans: Number(body.dedicatedFans) || 1, apothecary: body.apothecary ? 1 : 0,
    };
    state.skillPack = typeof body.skillPack === "string" ? body.skillPack : null;
    const induced = arr(body.rosteredInducements ?? body.inducements).filter(isRec);
    state.inducementCounts = Object.fromEntries(induced.map((p) => [sv(p.key), Number(p.count) || 0]));
    state.preview = null;
    await Promise.all([loadPackageRules(), loadInducements(), ensureSkillCatalog()]);
    if (stale()) return false;
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
  function sessionExpired(message: string): void {
    state.currentSave = null;
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
      if (!state.packages.some((p) => p.name === body.packageName)) {
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
  function sheetModel(): SheetModel {
    const roster = state.roster;
    return core.rosterSheetModel({
      raceName: roster?.raceName ?? "",
      coach: deps.coach(),
      teamName: state.teamName.trim(),
      rulesetName: [state.packageName, raceRules()?.tierLabel].filter(Boolean).join(" — "),
      players: state.slots.map((s) => {
        const star = isStarSlot(s);
        return {
          position: positionById(s.positionId),
          chosenSkills: star ? [] : s.chosenSkills,
          chosenStatIncreases: statRules() && !star ? s.chosenStatIncreases.filter((k) => allowedStats().includes(k)) : [],
          chosenStats: null,
          captain: s.captain === true && slotCanCaptain(s),
          accessOf: (k: string) => (accessOf(s.positionId, k) === "secondary" ? "secondary" : "primary"),
        };
      }),
      staff: state.staff,
      apothecaryAllowed: roster?.apothecaryAllowed !== false,
      inducements: inducementPicks().map((p) => ({ label: state.inducementCatalog.find((i) => i.key === p.key)?.label ?? p.key, count: p.count })),
      specialRules: [...(roster?.specialRules ?? []), ...(roster?.alwaysOnRules ?? []), ...(activeLeague() ? [activeLeague()] : [])],
      captainAvailable: captainAvailable(),
      summary: state.preview?.summary ?? null,
      costs: { players: rawPlayerCost(), stars: rawStarCost(), sideline: staffCost(), skills: addedSkillGold(), inducements: inducementGold() },
      budget: budget(),
    });
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
      ruleset: state.packageName ? { name: state.packageName, tierLabel: raceRules()?.tierLabel ?? null } : null,
      specialRules: model.specialRules,
      players: model.rows.map((r) => ({
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
        sidelineCost: t.sidelineCost, primarySkills: t.primary, secondarySkills: t.secondary, total: t.used, cap: t.budget,
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
      state.printHtml = core.rosterSheetHtml(model ?? sheetModel());
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
    if (link.packageName && state.packages.some((p) => p.name === link.packageName)) {
      await choosePackage(link.packageName);
      if (link.race && state.rosters.some((r) => r.rosterId === link.race) && (await chooseRace(link.race))) return "roster";
    }
    return "ruleset";
  }

  return {
    state,
    // derived
    positionById, shortName, raceRules, tierRules, statRules, allowedStats, packSummary, captainAvailable, slotCanCaptain, leagueOptions,
    leaguePresentation, activeLeague, selectedSpecialRule, accessOf, isElite, skillClass, totals, valueLines, validity, canExport, canBuild, canSave,
    positionCards, starChoices, starRow, starCap, starPickCount, starsAllowed, starSpTable, inducementRows, rulesetLines, tierLabel, raceTable,
    eligibleRosters, staffRows: () => staffRows(state.roster), staffIcon, skillIcon, spritePath, crestPath, pickerSections, skillPrice, statOptions,
    slotLocks, legalSet, requestBody, sheetModel, teamViewModel, gateCtx, named, signedIn: (): boolean => Boolean(deps.coach()),
    // actions
    init, boot, choosePackage, chooseRace, setTeamName, selectLeague, setSkillPack, addPosition, removeSlot, addStar, removeStar, moveSlot,
    toggleCaptain, openSkills, addSkill, removeSkill, addStat, removeStat, stepStaff, stepInducement, schedulePreview, flushPreview,
    loadSave, saveTeam, share, unshare, copyShare, build, exportPdf,
  };
}

export type TournamentBuilder = ReturnType<typeof createTournamentBuilder>;
export const TOURNAMENT_BUILDER_KEY: InjectionKey<TournamentBuilder> = Symbol("tournament-builder");
