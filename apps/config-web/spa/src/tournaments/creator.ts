// Tournament Creator controller (/app/tournament-creator[/:packageId]): the organiser's ruleset-package editor. Holds the
// package being edited, the catalogs, and every edit the vanilla page (public/tournament-rules.js) offered, as typed
// methods; the views only render state and call these. Server I/O goes through the shared api() fetcher:
//   GET  /api/packages, /api/presets, /api/skills, /api/stars, /api/teams   catalogs (public reads)
//   GET  /api/packages/<name>        { raw (as authored), revision, problems, schemaProblems }
//   POST /api/packages               save the document AS SENT; If-Match: <revision> (409 when it changed since)
//   POST /api/packages/preview       organiser-only: how the Tournament Builder will read the unsaved package
//   POST /api/export                 printable rules sheet (HTML, not JSON: the one plain fetch here)

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import {
  applySevensDefaults, applyStandardDefaults, inducementDefs, isSevens, type PackageFormat,
  clone, deepEqual, fallbackRaw, freshView, inferView, isObj, kToGold, matrixForDisplay, MAX_TIERS, MEGA_STARS,
  normalizePackage, nullableNumber, numberOr, pairedStarNames, preflight, recordTouched, safeArray, serializePackage, setPath,
  starTierCosts, touchPath, getPath, pathKey,
  type Num, type Path, type Pkg, type PositionCatalog, type PresetInfo, type StatRuleDoc, type RawDoc, type SkillInfo, type SkillMode, type SkillPack, type StarInfo, type System,
  type TeamInfo, type Tier, type ViewState,
} from "./creatorCore";

export type CreatorTab = "overview" | "tiers" | "team-rules" | "skills" | "stars" | "inducements" | "advanced" | "preview";
export const CREATOR_TABS: Array<{ id: CreatorTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "tiers", label: "Tiers" },
  { id: "team-rules", label: "Team rules" },
  { id: "skills", label: "Skills" },
  { id: "stars", label: "Stars" },
  { id: "inducements", label: "Inducements" },
  { id: "advanced", label: "Advanced" },
  { id: "preview", label: "Preview" },
];
export const isCreatorTab = (v: unknown): v is CreatorTab => typeof v === "string" && CREATOR_TABS.some((t) => t.id === v);

/** Field kinds the bound controls convert with (as the vanilla data-kind / data-blank pairs). */
export type FieldKind = "num" | "int" | "gold" | "str" | "bool" | "tri";
export type BlankMode = "delete" | "null" | "zero" | "empty" | "false";
export type OverrideMode = "inherit" | "set" | "none";

function blankValue(blank: BlankMode): unknown {
  if (blank === "null") return null;
  if (blank === "zero") return 0;
  if (blank === "empty") return "";
  if (blank === "false") return false;
  return undefined;
}

/** The value a control's raw input stands for (undefined deletes the key). */
export function boundValue(kind: FieldKind, blank: BlankMode, raw: string | boolean): unknown {
  if (kind === "bool") return raw === true ? true : blankValue(blank);
  if (kind === "tri") return raw === "true" ? true : raw === "false" ? false : undefined;
  const text = String(raw);
  if (kind === "str") return text === "" ? blankValue(blank) : text;
  const n = kind === "gold" ? kToGold(text) : nullableNumber(text);
  if (n == null) return blankValue(blank);
  return kind === "int" ? Math.max(0, Math.round(n)) : n;
}

export interface PreviewState {
  key: string;
  data: PreviewData | null;
  overview: OverviewData | null;
  problems: string[];
  error: string;
  loading: boolean;
}

/** The parts of POST /api/packages/preview's `preview` the page renders. */
export interface PreviewTier {
  label: string; rosters: Array<{ name: string; gold: Num }>; secondaryText: string; eliteText: string; stacksText: string; stackTypeText: string;
  characteristicsText: string; maxStars: number | null; starPacks: unknown[]; starPacksText: string;
}
export interface PreviewData {
  system: "tiers" | "flat" | "matrix" | string;
  tiers: PreviewTier[];
  tierSummary?: Array<{ packs?: SkillPack[]; skillPointBudget?: Num }>;
  tierLimits?: Array<{ maxPrimary?: Num; maxSecondary?: Num; skillPointBudget?: Num }>;
  flat?: { gold: Num; packs: SkillPack[]; limits?: { maxPrimary?: Num; maxSecondary?: Num }; skillPointBudget?: Num; rules: { maxSecondary?: Num }; stars: { allowed: boolean; maxCount?: Num } };
  exceptions: Array<{ roster: string; label: string; gold: Num; packs: SkillPack[]; maxPrimary?: Num; maxSecondary?: Num; skillPointBudget?: Num; starsAllowed: boolean }>;
}
/** The coach page's packageOverview (what the Tournament Builder renders). */
export interface OverviewTeam { name: string; gold?: Num; goldMax?: Num; allotment?: string[]; [k: string]: unknown }
export interface OverviewData {
  summary?: Array<{ key: string; label: string; text: string; details?: { summary: string; items: string[] } }>;
  groups: Array<{ tier?: string; label?: string; teams: OverviewTeam[] }>;
}

export interface CreatorState {
  loaded: boolean;
  loadError: string;
  connected: boolean;
  catalogNotices: string[];
  packageNames: string[];
  presets: PresetInfo[];
  skills: SkillInfo[];
  stars: StarInfo[];
  teams: TeamInfo[];
  /** Every roster's positions (stat-increase rules picker); empty when the server has no /api/positions. */
  positions: PositionCatalog[];
  /** The saved package open in the editor ("" for a preset, blank or duplicate not saved yet). */
  selected: string;
  pkg: Pkg | null;
  /** The document as authored (what the edits diff against) and its filled editing baseline. */
  original: RawDoc;
  baseline: Pkg | null;
  injected: Set<string>;
  touched: Set<string>;
  view: ViewState;
  activeTier: number;
  problems: string[];
  saved: { file: string; count: number } | null;
  exported: boolean;
  busy: boolean;
  /** sha256 of the file as opened (If-Match on save); a 409 message; a read-only reason. */
  revision: string | null;
  conflict: string;
  readOnly: string;
  /** Set after a 401 from save / preview: the editor stays read-only (survives opening another package). */
  authBlocked: string;
  preview: PreviewState;
  /** One-line notice after the Format toggle applied a format's defaults ("" otherwise). */
  formatNotice: string;
}

export interface CreatorDeps {
  api: Fetcher;
  /** The export's plain fetch (HTML answer); tests swap it. */
  fetchText?: (path: string, body: unknown) => Promise<string>;
  /** Opens the printable sheet (a blob URL in a new tab in the browser). */
  openHtml?: (html: string) => void;
  /** After a 401 (the session ended): re-read the session. */
  onSignedOut?: () => void;
}

export const AUTH_BLOCKED = "This server needs the sign-in sidecar for the Creator; saving is unavailable here.";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
// Read off the error's shape (an ApiError from the shared fetcher, or any fetcher's equivalent), not its class.
const errorData = (error: unknown): Record<string, unknown> => {
  const data = error instanceof Error ? (error as Partial<ApiError>).data : undefined;
  return isObj(data) ? data : {};
};
const errorStatus = (error: unknown): number => {
  const status = error instanceof Error ? (error as Partial<ApiError>).status : undefined;
  return typeof status === "number" ? status : 0;
};
const packageName = (entry: unknown): string => (typeof entry === "string" ? entry : isObj(entry) && typeof entry.name === "string" ? entry.name : "");

async function defaultFetchText(path: string, body: unknown): Promise<string> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-cw-auth": "1" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let data: unknown = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    const msg = isObj(data) && typeof data.error === "string" ? data.error : `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg, data ?? undefined);
  }
  return res.text();
}

function defaultOpenHtml(html: string): void {
  if (typeof window === "undefined") return;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const opened = window.open(url, "_blank", "noopener");
  if (!opened) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function createTournamentCreator(deps: CreatorDeps) {
  const api = deps.api;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const openHtml = deps.openHtml ?? defaultOpenHtml;
  const state = reactive<CreatorState>({
    loaded: false, loadError: "", connected: false, catalogNotices: [],
    packageNames: [], presets: [], skills: [], stars: [], teams: [], positions: [],
    selected: "", pkg: null, original: {}, baseline: null, injected: new Set(), touched: new Set(),
    view: freshView("skillpoints", "pool"), activeTier: 0,
    problems: [], saved: null, exported: false, busy: false, revision: null, conflict: "", readOnly: "", authBlocked: "",
    preview: { key: "", data: null, overview: null, problems: [], error: "", loading: false },
    formatNotice: "",
  });

  // ---------- document bookkeeping ----------

  function adoptDocument(doc: unknown): void {
    state.original = isObj(doc) ? clone(doc) : {};
    state.baseline = normalizePackage(doc);
    const filled = new Set<string>();
    state.pkg = normalizePackage(doc, filled);
    state.injected = filled;
    state.touched = new Set();
  }

  function loadIntoEditor(doc: unknown, problems: unknown): void {
    adoptDocument(doc);
    state.view = inferView(state.pkg!);
    state.activeTier = 0;
    state.revision = null;
    state.readOnly = state.authBlocked;
    state.conflict = "";
    state.problems = safeArray<unknown>(problems).map(String);
    state.saved = null;
    state.exported = false;
    state.formatNotice = "";
  }

  function serialize(): RawDoc {
    if (!state.pkg || !state.baseline) return {};
    return serializePackage(state.pkg, { original: state.original, baseline: state.baseline, view: state.view, book: { touched: state.touched, injected: state.injected } });
  }

  /** Unsaved edits: the document a save would send differs from the one opened. */
  function dirty(): boolean {
    return Boolean(state.pkg) && !deepEqual(serialize(), state.original);
  }

  /** True while a field still holds the default normalizePackage() filled in (shown as a placeholder). */
  function isInherited(path: Path): boolean {
    const key = pathKey(path);
    return state.injected.has(key) && !state.touched.has(key);
  }
  function inheritedHint(display: unknown): string {
    return state.pkg?.extends ? `inherited from ${state.pkg.extends}` : `default ${display === "" || display == null ? "none" : display}`;
  }

  function markDirty(): void {
    state.saved = null;
    state.exported = false;
    state.problems = [];
  }

  /** Every edit goes through here: snapshot, mutate (return false for "nothing changed"), record what changed. */
  function edit(mutate: (pkg: Pkg) => void | false, path?: Path | null): void {
    const pkg = state.pkg;
    if (!pkg) return;
    const before = clone(pkg) as RawDoc;
    if (path) touchPath(path, state.touched);
    if (mutate(pkg) === false) return;
    recordTouched(before, pkg as RawDoc, state.touched);
    markDirty();
  }

  // ---------- generic bound fields ----------

  function setAt(path: Path, value: unknown): void {
    edit((pkg) => {
      if (path[0] === "matrix") pkg.matrix = matrixForDisplay(pkg);
      setPath(pkg, path, value);
    }, path);
  }
  function setBound(path: Path, kind: FieldKind, blank: BlankMode, raw: string | boolean): void {
    setAt(path, boundValue(kind, blank, raw));
  }
  function overrideMode(path: Path): OverrideMode {
    const value = state.pkg ? getPath(state.pkg, path) : undefined;
    return value === undefined || isInherited(path) ? "inherit" : value === null ? "none" : "set";
  }
  function setOverrideMode(path: Path, mode: OverrideMode): void {
    edit((pkg) => {
      if (path[0] === "matrix") pkg.matrix = matrixForDisplay(pkg);
      const current = getPath(pkg, path);
      if (mode === "inherit") setPath(pkg, path, undefined);
      else if (mode === "none") setPath(pkg, path, null);
      else if (current == null) setPath(pkg, path, 0);
    }, path);
  }
  function toggleMulti(path: Path, value: string, checked: boolean): void {
    edit((pkg) => {
      const list = [...safeArray<string>(getPath(pkg, path))];
      const has = list.includes(value);
      if (checked && !has) list.push(value);
      if (!checked && has) list.splice(list.indexOf(value), 1);
      setPath(pkg, path, list);
    }, path);
  }
  /** The "every / inherit" option of a multi-select: checked removes the key, unchecked starts an empty list. */
  function setMultiAll(path: Path, checked: boolean): void {
    edit((pkg) => setPath(pkg, path, checked ? undefined : []), path);
  }
  function setField(field: "name" | "date" | "description" | "extends" | "dataNote", value: string): void {
    edit((pkg) => { pkg[field] = value; }, [field]);
  }

  // ---------- races, gold, systems ----------

  const isAllRaces = (): boolean => safeArray(state.pkg?.eligibleRosters).includes("*");
  function toggleAllRaces(): void {
    edit((pkg) => {
      if (state.teams.length === 0 && isAllRaces()) return false;
      pkg.eligibleRosters = isAllRaces() ? state.teams.map((t) => t.name) : ["*"];
    });
  }
  function toggleRace(name: string): void {
    edit((pkg) => {
      const current = isAllRaces() ? state.teams.map((t) => t.name) : [...safeArray<string>(pkg.eligibleRosters)];
      pkg.eligibleRosters = current.includes(name) ? current.filter((r) => r !== name) : [...current, name];
    });
  }
  function setCapIncludesSkills(on: boolean): void {
    edit((pkg) => { pkg.goldCapIncludesAddedSkills = on; });
  }
  function setSystem(system: System): void {
    // Re-picking the active system is not a switch: a touched system drops the other systems' data on save.
    if (!state.pkg || system === state.view.system) return;
    edit((pkg) => {
      state.view.system = system;
      state.view.systemTouched = true;
      if (system === "tiers" && !Array.isArray(pkg.tiers)) pkg.tiers = [];
      if (system === "packages" && !Array.isArray(pkg.skillPackages)) pkg.skillPackages = [];
      if (system === "matrix") pkg.matrix = matrixForDisplay(pkg);
    });
  }
  function setSkillMode(mode: SkillMode): void {
    if (!state.pkg || state.view.skillMode === mode) return;
    edit((pkg) => {
      state.view.skillMode = mode;
      state.view.skillModeTouched = true;
      if (mode === "count") {
        // Only fill keys that are absent: an explicit null (no limit) stays null.
        if (pkg.skillAllotment.maxPrimary === undefined) pkg.skillAllotment.maxPrimary = 0;
        if (pkg.skillAllotment.maxSecondary === undefined) pkg.skillAllotment.maxSecondary = 0;
      }
    });
  }
  /** The Format toggle (Sevens spec 11-02): Sevens writes the Sevens defaults into the document (every one stays editable);
   *  Standard resets the package to a blank package's rules, keeping its details (the view asks for a confirm first). */
  function setFormat(format: PackageFormat): void {
    if (!state.pkg || state.readOnly || (format === "sevens") === isSevens(state.pkg)) return;
    edit((pkg) => {
      if (format === "sevens") applySevensDefaults(pkg);
      else applyStandardDefaults(pkg);
      state.view.system = format === "sevens" ? "tiers" : "skillpoints";
      state.view.systemTouched = true;
      state.view.skillMode = "pool";
      state.view.skillModeTouched = true;
      state.activeTier = 0;
    });
    state.formatNotice = format === "sevens" ? "Sevens defaults applied — edit any below." : "Standard defaults restored.";
  }
  function toggleSecondarySwap(): void {
    edit((pkg) => { pkg.skillAllotment.secondarySwap = !pkg.skillAllotment.secondarySwap; });
  }

  // ---------- skill cost overrides, banned skills ----------

  function addSpOverride(skill: string, cost: number): void {
    if (!skill) return;
    edit((pkg) => {
      pkg.skillAllotment.skillCostSP ??= {};
      pkg.skillAllotment.skillCostSP[skill] = numberOr(cost, 2);
    });
  }
  function removeSpOverride(skill: string): void {
    edit((pkg) => { if (pkg.skillAllotment.skillCostSP) delete pkg.skillAllotment.skillCostSP[skill]; });
  }
  function addGoldOverride(skill: string, costK: number): void {
    if (!skill) return;
    edit((pkg) => setPath(pkg, ["skillAllotment", "skillCostGold", skill], kToGold(costK) ?? 0));
  }
  function removeGoldOverride(skill: string): void {
    edit((pkg) => setPath(pkg, ["skillAllotment", "skillCostGold", skill], undefined));
  }
  function addBannedSkill(skill: string): void {
    edit((pkg) => {
      pkg.special.bannedSkills = safeArray<string>(pkg.special.bannedSkills);
      if (!skill || pkg.special.bannedSkills.includes(skill)) return false;
      pkg.special.bannedSkills.push(skill);
    });
  }
  function removeBannedSkill(skill: string): void {
    edit((pkg) => { pkg.special.bannedSkills = safeArray<string>(pkg.special.bannedSkills).filter((n) => n !== skill); });
  }

  // ---------- tiers ----------

  function selectTier(index: number): void { state.activeTier = index; }
  function addTier(): void {
    edit((pkg) => {
      if (pkg.tiers.length >= MAX_TIERS) return false;
      const tierNumber = pkg.tiers.length + 1;
      const assigned = new Set(pkg.tiers.flatMap((t) => safeArray<string>(t.rosters)));
      pkg.tiers.push({
        tier: tierNumber,
        label: `Tier ${tierNumber}`,
        rosters: state.teams.filter((t) => Number(t.defaultTier) === tierNumber && !assigned.has(t.name)).map((t) => t.name),
        gold: pkg.goldBudget,
        skillPointBudget: pkg.skillAllotment.skillPointBudget ?? null,
        starPlayersAllowed: pkg.starPlayers.allowed,
        bannedStars: [],
      });
      Object.keys(pkg.starPlayers.spCostByTier ?? {}).forEach((name) => {
        pkg.starPlayers.spCostByTier![name] = starTierCosts(pkg, name);
      });
      if (pkg.starPlayers.spCostByTier) state.view.starCostsTouched = true;
      if (pkg.tiers.length === 1) state.activeTier = 0;
    });
  }
  function removeTier(index: number): void {
    edit((pkg) => {
      pkg.tiers.splice(index, 1);
      if (state.activeTier > index) state.activeTier -= 1;
      else if (state.activeTier === index) state.activeTier = Math.min(index, pkg.tiers.length - 1);
      Object.keys(pkg.starPlayers.spCostByTier ?? {}).forEach((name) => {
        const costs = safeArray<Num>(pkg.starPlayers.spCostByTier![name]);
        costs.splice(index, 1);
        pkg.starPlayers.spCostByTier![name] = costs.slice(0, pkg.tiers.length);
      });
      state.view.starCostsTouched = true;
    });
  }
  function setTierField(index: number, field: "tier" | "label" | "gold" | "skillPointBudget", raw: string): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!tier) return false;
      if (field === "tier") tier.tier = numberOr(raw, tier.tier ?? 1);
      if (field === "label") tier.label = raw;
      if (field === "gold") tier.gold = kToGold(raw);
      if (field === "skillPointBudget") tier.skillPointBudget = nullableNumber(raw);
    });
  }
  function toggleTierStars(index: number): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!tier) return false;
      tier.starPlayersAllowed = tier.starPlayersAllowed === false;
    });
  }
  function assignTeamToTier(name: string, index: number): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!name || !tier) return false;
      pkg.tiers.forEach((t) => { t.rosters = safeArray<string>(t.rosters).filter((r) => r !== name); });
      tier.rosters.push(name);
      state.activeTier = index;
    });
  }
  function removeTeamFromTier(name: string, index: number): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!name || !tier) return false;
      tier.rosters = safeArray<string>(tier.rosters);
      if (!tier.rosters.includes(name)) return false;
      tier.rosters = tier.rosters.filter((r) => r !== name);
      state.activeTier = index;
    });
  }
  function tierPackAdd(index: number): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!tier) return false;
      tier.skillPackages ??= [];
      tier.skillPackages.push({
        label: `Pack ${tier.skillPackages.length + 1}`,
        gold: numberOr(tier.gold, pkg.goldBudget ?? 0),
        skillPointBudget: numberOr(tier.skillPointBudget, pkg.skillAllotment.skillPointBudget ?? 0),
      });
    });
  }
  function tierPackRemove(index: number, packIndex: number): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!tier) return false;
      tier.skillPackages = safeArray<SkillPack>(tier.skillPackages);
      tier.skillPackages.splice(packIndex, 1);
    });
  }
  function tierPackGenerate(index: number): void {
    edit((pkg) => {
      const tier = pkg.tiers[index];
      if (!tier) return false;
      const baseGold = numberOr(tier.gold, pkg.goldBudget ?? 0);
      const baseSp = numberOr(tier.skillPointBudget, pkg.skillAllotment.skillPointBudget ?? 0);
      tier.skillPackages = [
        { label: "Pack 1", gold: baseGold, skillPointBudget: baseSp },
        { label: "Pack 2", gold: baseGold - 30000, skillPointBudget: baseSp + 1 },
        { label: "Pack 3", gold: baseGold + 30000, skillPointBudget: baseSp - 1 },
      ];
    });
  }
  function setTierPackField(index: number, packIndex: number, field: "label" | "gold" | "skillPointBudget" | "maxPerPlayer", raw: string): void {
    edit((pkg) => {
      const item = safeArray<SkillPack>(pkg.tiers[index]?.skillPackages)[packIndex];
      if (!item) return false;
      if (field === "label") item.label = raw;
      if (field === "gold") item.gold = kToGold(raw) ?? 0;
      if (field === "skillPointBudget") item.skillPointBudget = numberOr(raw, 0);
      if (field === "maxPerPlayer") {
        const max = nullableNumber(raw);
        if (max == null) delete item.maxPerPlayer;
        else item.maxPerPlayer = max;
      }
    });
  }

  // ---------- skill packages (Spike!-style bundles) ----------

  function addPackage(): void {
    edit((pkg) => {
      pkg.skillPackages.push({
        label: `Bundle ${pkg.skillPackages.length + 1}`,
        gold: pkg.goldBudget ?? 1000000,
        skillPointBudget: pkg.skillAllotment.skillPointBudget ?? 0,
        maxPerPlayer: pkg.skillAllotment.maxPerPlayer ?? null,
        starPlayersAllowed: pkg.starPlayers.allowed,
      });
    });
  }
  function removePackage(index: number): void {
    edit((pkg) => { pkg.skillPackages.splice(index, 1); });
  }
  function togglePackageStars(index: number): void {
    edit((pkg) => {
      const item = pkg.skillPackages[index];
      if (!item) return false;
      item.starPlayersAllowed = item.starPlayersAllowed === false;
    });
  }
  function setPackageField(index: number, field: "label" | "gold" | "skillPointBudget" | "maxPerPlayer", raw: string): void {
    edit((pkg) => {
      const item = pkg.skillPackages[index];
      if (!item) return false;
      if (field === "label") item.label = raw;
      if (field === "gold") item.gold = kToGold(raw) ?? 0;
      if (field === "skillPointBudget") item.skillPointBudget = numberOr(raw, 0);
      if (field === "maxPerPlayer") item.maxPerPlayer = nullableNumber(raw);
    });
  }

  // ---------- matrix ----------

  function matrixEdit(mutate: (pkg: Pkg) => void | false): void {
    edit((pkg) => {
      pkg.matrix = matrixForDisplay(pkg);
      return mutate(pkg);
    });
  }
  function toggleMatrixCell(row: number, col: number): void {
    matrixEdit((pkg) => {
      const cells = pkg.matrix!.cells;
      const index = cells.findIndex((c) => c.row === row && c.col === col);
      if (index >= 0) cells.splice(index, 1);
      else cells.push({ col, row, teams: [] });
    });
  }
  function addMatrixColumn(): void {
    matrixEdit((pkg) => {
      const lastGold = pkg.matrix!.columns.at(-1)?.gold;
      pkg.matrix!.columns.push({ gold: numberOr(lastGold, 1100000) + 50000 });
    });
  }
  function removeMatrixColumn(col: number): void {
    matrixEdit((pkg) => {
      const m = pkg.matrix!;
      if (!Number.isInteger(col) || col < 0 || col >= m.columns.length || m.columns.length <= 1) return false;
      m.columns.splice(col, 1);
      m.cells = m.cells.filter((c) => c.col !== col).map((c) => (c.col > col ? { ...c, col: c.col - 1 } : c));
    });
  }
  function addMatrixRow(): void {
    matrixEdit((pkg) => { pkg.matrix!.rows.push({ primary: 6, secondary: 0, secondarySwap: false }); });
  }
  function removeMatrixRow(row: number): void {
    matrixEdit((pkg) => {
      const m = pkg.matrix!;
      if (!Number.isInteger(row) || row < 0 || row >= m.rows.length || m.rows.length <= 1) return false;
      m.rows.splice(row, 1);
      m.cells = m.cells.filter((c) => c.row !== row).map((c) => (c.row > row ? { ...c, row: c.row - 1 } : c));
    });
  }
  function setMatrixColumnGold(col: number, raw: string): void {
    matrixEdit((pkg) => {
      const value = numberOr(raw, Number.NaN);
      const column = pkg.matrix!.columns[col];
      if (Number.isNaN(value) || !column) return false;
      column.gold = kToGold(Math.max(0, Math.round(value)));
    });
  }
  function setMatrixRowCount(row: number, field: "primary" | "secondary", raw: string): void {
    matrixEdit((pkg) => {
      const value = numberOr(raw, Number.NaN);
      const r = pkg.matrix!.rows[row];
      if (Number.isNaN(value) || !r) return false;
      r[field] = Math.max(0, Math.round(value));
    });
  }
  function setMatrixRowSwap(row: number, on: boolean): void {
    matrixEdit((pkg) => {
      const r = pkg.matrix!.rows[row];
      if (!r) return false;
      r.secondarySwap = on;
    });
  }

  // ---------- team rules ----------

  function addTeamRule(team: string): void {
    const name = team || state.teams[0]?.name;
    if (!name) return;
    edit((pkg) => { pkg.teamRules.push({ team: name }); });
  }
  function removeTeamRule(index: number): void {
    edit((pkg) => { pkg.teamRules.splice(index, 1); });
  }

  // ---------- stars ----------

  function toggleStarsAllowed(): void {
    // Blood Bowl Sevens has no Star Players (owner Q4): the toggle is locked off.
    edit((pkg) => {
      if (isSevens(pkg)) return false;
      pkg.starPlayers.allowed = !pkg.starPlayers.allowed;
    });
  }
  function moveStar(name: string, destination: "banned" | "allowed"): void {
    edit((pkg) => {
      const banned = new Set(pkg.bannedStars);
      pairedStarNames(state.stars, name).forEach((n) => (destination === "banned" ? banned.add(n) : banned.delete(n)));
      pkg.bannedStars = [...banned];
    });
  }
  function toggleMegaStars(): void {
    edit((pkg) => {
      const banned = new Set(pkg.bannedStars);
      const allBanned = MEGA_STARS.every((n) => banned.has(n));
      MEGA_STARS.forEach((n) => (allBanned ? banned.delete(n) : banned.add(n)));
      pkg.bannedStars = [...banned];
    });
  }
  function setStarTierCost(name: string, tierIndex: number, raw: string): void {
    edit((pkg) => {
      if (!name || !Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex >= pkg.tiers.length) return false;
      pkg.starPlayers.spCostByTier ??= {};
      const costs = starTierCosts(pkg, name);
      costs[tierIndex] = nullableNumber(raw);
      pairedStarNames(state.stars, name).forEach((n) => { pkg.starPlayers.spCostByTier![n] = [...costs]; });
      state.view.starCostsTouched = true;
    });
  }
  function setStarsPaidInSp(on: boolean): void {
    edit((pkg) => {
      if (on) pkg.starPlayers.paidInSkillPoints = true;
      else delete pkg.starPlayers.paidInSkillPoints;
    });
  }
  function addStarPack(): void {
    edit((pkg) => {
      pkg.starPacks = safeArray(pkg.starPacks);
      const ids = new Set(pkg.starPacks.map((p) => p.id));
      let n = pkg.starPacks.length + 1;
      while (ids.has(`pack-${n}`)) n += 1;
      pkg.starPacks.push({ id: `pack-${n}`, label: `Pack ${n}`, fee: 0, max: 1, stars: [] });
    });
  }
  function removeStarPack(index: number): void {
    edit((pkg) => {
      if (Array.isArray(pkg.starPacks)) pkg.starPacks.splice(index, 1);
      if (Array.isArray(pkg.starPacks) && pkg.starPacks.length === 0 && state.original.starPacks === undefined) delete pkg.starPacks;
    });
  }

  // ---------- inducements, special rules ----------

  const inducementAllowed = (id: string): boolean => {
    const allowed = safeArray<string>(state.pkg?.inducements.allowed);
    return allowed.includes("*") || allowed.includes(id);
  };
  function toggleInducement(id: string): void {
    edit((pkg) => {
      const known = inducementDefs(pkg).map((i) => i.id);
      let allowed = safeArray<string>(pkg.inducements.allowed);
      if (allowed.includes("*")) allowed = known.filter((k) => k !== id);
      else if (allowed.includes(id)) allowed = allowed.filter((k) => k !== id);
      else allowed = [...allowed, id];
      pkg.inducements.allowed = allowed;
    });
  }
  function stepInducement(id: string, delta: number): void {
    edit((pkg) => {
      const item = inducementDefs(pkg).find((i) => i.id === id);
      pkg.inducements.caps ??= {};
      const current = pkg.inducements.caps[id] ?? item?.max ?? 1;
      pkg.inducements.caps[id] = Math.max(0, Math.min(9, current + delta));
    });
  }
  function toggleSpecial(key: "insignificantTraitConstraint" | "stalling" | "slannAllowed" | "statIncreasesAllowed" | "veteran"): void {
    edit((pkg) => { pkg.special[key] = !pkg.special[key]; });
  }
  // ---------- stat-increase rules (special.statIncreaseRules) ----------
  /** Edit the granular rules; the key is dropped again when nothing is left, so an untouched package serialises as authored. */
  function editStatRules(mutate: (r: StatRuleDoc) => void): void {
    edit((pkg) => {
      const r = (isObj(pkg.special.statIncreaseRules) ? pkg.special.statIncreaseRules : {}) as StatRuleDoc;
      mutate(r);
      for (const k of ["excludePositions", "excludeKeywords", "blockedStats"] as const) if (Array.isArray(r[k]) && r[k]!.length === 0) delete r[k];
      if (r.maxPerTeam == null) delete r.maxPerTeam;
      if (Object.keys(r).length) pkg.special.statIncreaseRules = r; else delete pkg.special.statIncreaseRules;
    });
  }
  const samePos = (a: { race?: string; position?: string }, race: string, position: string): boolean => (a.race ?? "*") === race && a.position === position;
  function addExcludePosition(race: string, position: string): void {
    editStatRules((r) => { r.excludePositions ??= []; if (!r.excludePositions.some((x) => samePos(x, race, position))) r.excludePositions.push({ race, position }); });
  }
  function removeExcludePosition(index: number): void { editStatRules((r) => { r.excludePositions?.splice(index, 1); }); }
  function toggleExcludeKeyword(keyword: string): void {
    editStatRules((r) => { const list = (r.excludeKeywords ??= []); const at = list.indexOf(keyword); if (at >= 0) list.splice(at, 1); else list.push(keyword); });
  }
  function addBlockedStat(stat: string): void { editStatRules((r) => { (r.blockedStats ??= []).push({ stat }); }); }
  function removeBlockedStat(index: number): void { editStatRules((r) => { r.blockedStats?.splice(index, 1); }); }
  function setBlockedStat(index: number, stat: string): void { editStatRules((r) => { const b = r.blockedStats?.[index]; if (b) b.stat = stat; }); }
  function addBlockedPosition(index: number, race: string, position: string): void {
    editStatRules((r) => { const b = r.blockedStats?.[index]; if (!b) return; b.positions ??= []; if (!b.positions.some((x) => samePos(x, race, position))) b.positions.push({ race, position }); });
  }
  function removeBlockedPosition(index: number, at: number): void {
    editStatRules((r) => { const b = r.blockedStats?.[index]; if (!b?.positions) return; b.positions.splice(at, 1); if (!b.positions.length) delete b.positions; });
  }
  function toggleBlockedKeyword(index: number, keyword: string): void {
    editStatRules((r) => {
      const b = r.blockedStats?.[index]; if (!b) return;
      const list = (b.keywords ??= []); const at = list.indexOf(keyword); if (at >= 0) list.splice(at, 1); else list.push(keyword);
      if (!list.length) delete b.keywords;
    });
  }
  function setMaxPerTeam(raw: string): void {
    const n = raw.trim() === "" ? null : Math.max(0, Math.floor(Number(raw)));
    editStatRules((r) => { if (n == null || !Number.isFinite(n)) delete r.maxPerTeam; else r.maxPerTeam = n; });
  }
  function toggleStarsEleventh(): void {
    edit((pkg) => { pkg.special.minPlayers = Number(pkg.special.minPlayers) <= 10 ? 11 : 10; });
  }

  // ---------- server I/O ----------

  async function init(): Promise<void> {
    const requests: Array<[string, Promise<unknown>]> = [
      ["packages", api<unknown>("/api/packages")],
      ["presets", api<unknown>("/api/presets")],
      ["skills", api<unknown>("/api/skills")],
      ["stars", api<unknown>("/api/stars")],
      ["teams", api<unknown>("/api/teams")],
    ];
    const results = await Promise.allSettled(requests.map(([, r]) => r));
    const values: Record<string, unknown> = {};
    state.catalogNotices = [];
    results.forEach((result, index) => {
      const label = requests[index]![0];
      if (result.status === "fulfilled") values[label] = result.value;
      else state.catalogNotices.push(`${label[0]!.toUpperCase() + label.slice(1)} catalog unavailable: ${message(result.reason)}`);
    });
    state.connected = results.some((r) => r.status === "fulfilled");
    if (!state.connected) state.loadError = "Can't reach the server. Check your connection.";
    state.packageNames = safeArray(values.packages).map(packageName).filter(Boolean).sort((a, b) => a.localeCompare(b));
    state.presets = safeArray<PresetInfo>(values.presets).filter((p) => isObj(p) && typeof p.id === "string" && isObj(p.pkg));
    const skills = isObj(values.skills) ? [...safeArray<SkillInfo>(values.skills.elite), ...safeArray<SkillInfo>(values.skills.general)] : [];
    state.skills = [...new Map(skills.filter((s) => isObj(s) && typeof s.name === "string").map((s) => [s.name, s])).values()].sort((a, b) => a.name.localeCompare(b.name));
    state.stars = safeArray<StarInfo>(values.stars).filter((s) => isObj(s) && typeof s.name === "string").sort((a, b) => a.name.localeCompare(b.name));
    state.teams = safeArray<TeamInfo>(values.teams).filter((t) => isObj(t) && typeof t.name === "string").sort((a, b) => a.name.localeCompare(b.name));
    state.positions = await api<unknown>("/api/positions").then((v) => safeArray<PositionCatalog>(v).filter((r) => isObj(r) && typeof r.race === "string" && Array.isArray(r.positions)), () => []);
    state.loaded = true;
  }

  /** Open a saved package AS AUTHORED (`raw`). Without `raw` (an older server) it opens read-only. */
  async function open(name: string): Promise<void> {
    if (!name) return;
    state.busy = true;
    state.selected = name;
    try {
      const result = await api<Record<string, unknown>>(`/api/packages/${encodeURIComponent(name)}`);
      if (result.raw) {
        loadIntoEditor(result.raw, result.problems);
        state.revision = typeof result.revision === "string" ? result.revision : null;
        applyPreflight(result.schemaProblems);
      } else {
        loadIntoEditor(result.pkg, result.problems);
        state.readOnly = "This server does not send the package file as authored, so saving would rewrite it with every default filled in. The package is read-only until the server is updated.";
      }
    } catch (error) {
      const data = errorData(error);
      if (data.raw) {
        // A file that no longer resolves still opens, so the organiser can fix it.
        loadIntoEditor(data.raw, [message(error)]);
        state.revision = typeof data.revision === "string" ? data.revision : null;
        applyPreflight(data.schemaProblems);
      } else state.problems = [message(error)];
    } finally {
      state.busy = false;
    }
  }
  function applyPreflight(schemaProblems: unknown): void {
    const checked = preflight(schemaProblems);
    if (checked.readOnly) state.readOnly = checked.readOnly;
    if (checked.problems.length) state.problems = [...state.problems, ...checked.problems];
  }

  function loadPreset(id: string): boolean {
    const preset = state.presets.find((p) => p.id === id);
    if (!preset) return false;
    state.selected = "";
    loadIntoEditor(preset.pkg, []);
    return true;
  }
  function newBlank(): void {
    state.selected = "";
    loadIntoEditor(fallbackRaw(), []);
  }
  /** A copy of the open package as a new, unsaved one ("<name> copy", no revision); saving writes a new file. */
  function duplicate(): void {
    if (!state.pkg) return;
    const doc = serialize();
    doc.name = `${String(doc.name ?? "").trim() || "Package"} copy`;
    const view = { system: state.view.system, skillMode: state.view.skillMode };
    state.selected = "";
    loadIntoEditor(doc, []);
    state.view = freshView(view.system, view.skillMode);
  }
  /** Throw away unsaved edits: back to the document as opened (or last saved). */
  function revert(): void {
    if (!state.pkg) return;
    const keep = { revision: state.revision, readOnly: state.readOnly, selected: state.selected };
    loadIntoEditor(state.original, []);
    Object.assign(state, keep);
  }

  /** A save that went out while edits continued: `sent` becomes the as-authored document, the live model stays. Filled
   *  defaults the save wrote out are the organiser's own from now on, so they stop counting as injected. */
  function rebaseOnto(sent: RawDoc): void {
    state.original = clone(sent);
    state.baseline = normalizePackage(sent);
    state.injected = new Set([...state.injected].filter((key) => getPath(sent, JSON.parse(key) as Path) === undefined));
  }

  /** A 401 on save / preview (the session is gone, or a server without the sign-in sidecar wants a bearer token the SPA
   *  never holds): say so and keep the editor read-only for the rest of the visit. */
  function blockAuth(): void {
    state.authBlocked = AUTH_BLOCKED;
    state.readOnly = AUTH_BLOCKED;
    deps.onSignedOut?.();
  }

  async function save(): Promise<void> {
    if (!state.pkg || state.busy || state.readOnly) return;
    state.busy = true;
    state.saved = null;
    state.exported = false;
    try {
      const sent = serialize();
      // Optimistic concurrency: the revision we opened. The server refuses (409) when the file changed since.
      const headers: Record<string, string> = state.revision ? { "If-Match": state.revision } : {};
      const result = await api<Record<string, unknown>>("/api/packages", { method: "POST", body: sent, headers });
      // The server wrote `sent` verbatim: it is the new "as authored" document later edits diff against. Edits made
      // while the save was in flight stay: the editing model is kept and only rebased onto `sent` (still dirty).
      if (deepEqual(serialize(), sent)) {
        adoptDocument(sent);
        state.view = freshView(state.view.system, state.view.skillMode);
      } else rebaseOnto(sent);
      state.revision = typeof result.revision === "string" ? result.revision : null;
      state.conflict = "";
      state.problems = safeArray<unknown>(result.problems).map(String);
      const fallbackName = `${String(result.name ?? state.pkg.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`;
      const savedFile = typeof result.savedAs === "string" ? result.savedAs.split(/[\\/]/).pop() : fallbackName;
      state.saved = state.problems.length === 0 ? { file: savedFile || fallbackName, count: 0 } : null;
      if (typeof result.name === "string" && result.name) {
        state.selected = result.name;
        if (!state.packageNames.includes(result.name)) state.packageNames.push(result.name);
        state.packageNames.sort((a, b) => a.localeCompare(b));
      }
    } catch (error) {
      const msg = message(error);
      state.problems = [msg, ...safeArray<unknown>(errorData(error).problems).map(String).filter((p) => p !== msg)];
      if (errorStatus(error) === 409) state.conflict = msg;
      if (errorStatus(error) === 401) blockAuth();
    } finally {
      state.busy = false;
    }
  }

  async function exportSheet(): Promise<void> {
    if (state.busy || !state.pkg) return;
    state.busy = true;
    state.saved = null;
    state.exported = false;
    try {
      openHtml(await fetchText("/api/export", serialize()));
      state.problems = [];
      state.exported = true;
    } catch (error) {
      state.problems = [message(error)];
    } finally {
      state.busy = false;
    }
  }

  /** Ask the server to resolve the package AS IT WILL BE SAVED (keyed by the serialised document). */
  async function requestPreview(): Promise<void> {
    if (!state.pkg) return;
    const doc = serialize();
    const key = JSON.stringify(doc);
    if (key === state.preview.key) return;
    state.preview = { key, data: null, overview: null, problems: [], error: "", loading: true };
    try {
      const result = await api<Record<string, unknown>>("/api/packages/preview", { method: "POST", body: doc });
      if (state.preview.key !== key) return;
      state.preview = {
        key, data: isObj(result.preview) ? (result.preview as unknown as PreviewData) : null, overview: isObj(result.overview) ? (result.overview as unknown as OverviewData) : null,
        problems: safeArray<unknown>(result.problems).map(String), error: "", loading: false,
      };
    } catch (error) {
      if (state.preview.key !== key) return;
      const status = errorStatus(error);
      if (status === 401) blockAuth();
      const msg = status === 401 ? AUTH_BLOCKED : status === 403 ? "Sign in as an organiser to see the preview." : message(error);
      state.preview = { key, data: null, overview: null, problems: safeArray<unknown>(errorData(error).problems).map(String), error: msg, loading: false };
    }
  }

  return {
    state,
    serialize, dirty, isInherited, inheritedHint, isAllRaces, inducementAllowed, overrideMode,
    edit, setAt, setBound, setOverrideMode, toggleMulti, setMultiAll, setField,
    toggleAllRaces, toggleRace, setCapIncludesSkills, setSystem, setSkillMode, toggleSecondarySwap, setFormat,
    addSpOverride, removeSpOverride, addGoldOverride, removeGoldOverride, addBannedSkill, removeBannedSkill,
    selectTier, addTier, removeTier, setTierField, toggleTierStars, assignTeamToTier, removeTeamFromTier,
    tierPackAdd, tierPackRemove, tierPackGenerate, setTierPackField,
    addPackage, removePackage, togglePackageStars, setPackageField,
    toggleMatrixCell, addMatrixColumn, removeMatrixColumn, addMatrixRow, removeMatrixRow, setMatrixColumnGold, setMatrixRowCount, setMatrixRowSwap,
    addTeamRule, removeTeamRule,
    toggleStarsAllowed, moveStar, toggleMegaStars, setStarTierCost, setStarsPaidInSp, addStarPack, removeStarPack,
    toggleInducement, stepInducement, toggleSpecial, toggleStarsEleventh,
    addExcludePosition, removeExcludePosition, toggleExcludeKeyword, addBlockedStat, removeBlockedStat, setBlockedStat, addBlockedPosition, removeBlockedPosition, toggleBlockedKeyword, setMaxPerTeam,
    init, open, loadPreset, newBlank, duplicate, revert, save, exportSheet, requestPreview,
  };
}

export type TournamentCreator = ReturnType<typeof createTournamentCreator>;
export const TOURNAMENT_CREATOR_KEY: InjectionKey<TournamentCreator> = Symbol("tournament-creator");

/** Who may use the Creator: the server's package-write gate (an organiser session; site admins are organisers). */
export function creatorAllowed(info: { authenticated?: boolean; organizer?: boolean; admin?: boolean } | null | undefined): boolean {
  return Boolean(info?.authenticated && (info.organizer === true || info.admin === true));
}

export type { Tier };

/** The package summary rows (Overview tab and the Preview tab), from the editing model. */
export function packageSummary(state: Pick<CreatorState, "pkg" | "view" | "teams">): Array<{ label: string; value: string }> {
  const pkg = state.pkg;
  if (!pkg) return [];
  const allRaces = safeArray(pkg.eligibleRosters).includes("*");
  const gold = pkg.goldBudget == null ? "none" : `${Number(pkg.goldBudget) / 1000}k${pkg.goldCapIncludesAddedSkills ? " (incl. skills)" : ""}`;
  const stars = pkg.starPlayers.allowed
    ? `max ${pkg.starPlayers.maxCount ?? "none"}${pkg.bannedStars.length ? ` · ${pkg.bannedStars.length} banned` : ""}`
    : "not allowed";
  const a = pkg.skillAllotment;
  const skills = pkg.goldCapIncludesAddedSkills ? "in gold budget"
    : state.view.system === "tiers" ? `${pkg.tiers.length} tiers`
      : state.view.system === "packages" ? `${pkg.skillPackages.length} packages`
        : state.view.system === "matrix" ? "matrix"
          : state.view.skillMode === "count" ? `${a.maxPrimary ?? 0} pri / ${a.maxSecondary ?? 0} sec${a.secondarySwap ? " (swap)" : ""}`
            : `${a.skillPointBudget ?? 0} SP pool`;
  const sevens = isSevens(pkg);
  const s = pkg.special;
  return [
    { label: "Format", value: sevens ? "Blood Bowl Sevens (tabletop only)" : "Standard" },
    ...(sevens
      ? [
        { label: "Players", value: `${s.minPlayers ?? 7}–${s.maxPlayers ?? 11}` },
        { label: "Non-Lineman", value: s.maxNonLineman == null ? "no cap" : `at most ${s.maxNonLineman}` },
        { label: "Veteran", value: s.veteran === true ? "required" : "off" },
      ]
      : []),
    { label: "Races", value: allRaces ? `all (${state.teams.length})` : String(safeArray(pkg.eligibleRosters).length) },
    { label: "Gold cap", value: gold },
    { label: "Skill model", value: skills },
    { label: "Team rules", value: pkg.teamRules.length ? String(pkg.teamRules.length) : "none" },
    { label: "Stars", value: stars },
    { label: "Star packs", value: safeArray(pkg.starPacks).length ? String(safeArray(pkg.starPacks).length) : "none" },
    { label: "Banned skills", value: safeArray(pkg.special.bannedSkills).length ? String(safeArray(pkg.special.bannedSkills).length) : "none" },
  ];
}

/** The document part of the Creator's query: ?package=<name> (a saved package) or ?new=1 (an unsaved document). */
export function creatorDocQuery(query: Record<string, unknown>): Record<string, string> {
  if (typeof query.package === "string" && query.package) return { package: query.package };
  if (query.new === "1") return { new: "1" };
  return {};
}

/**
 * Bring the controller in line with the URL. ?package=<name> opens that package (unless it is already open); ?new=1
 * keeps the unsaved document in the editor (a fresh visit gets a blank one); neither keeps what is open, or on a first
 * visit returns the first saved package for the caller to land on (else a preset, else a blank package opens).
 */
export async function syncCreatorToQuery(creator: TournamentCreator, query: Record<string, unknown>): Promise<string | undefined> {
  const { state } = creator;
  const doc = creatorDocQuery(query);
  if (doc.package) {
    if (doc.package !== state.selected || !state.pkg) await creator.open(doc.package);
    return undefined;
  }
  if (doc.new) {
    if (!state.pkg || state.selected) creator.newBlank();
    return undefined;
  }
  if (state.pkg) return undefined;
  if (state.packageNames.length) return state.packageNames[0];
  if (!state.presets.length || !creator.loadPreset(state.presets[0]!.id)) creator.newBlank();
  return undefined;
}
