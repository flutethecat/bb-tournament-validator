"use strict";

/*
  Tournament Creator — the organiser's tournament package editor (admin page; served as tournament-rules.html).

  Round-trip law (owner 10-27): loading a tournament package and serialising it back without edits must
  give JSON deep-equal to the input. normalizePackage() only FILLS absent keys (with the validator's
  defaults, so the controls show what the validator will apply) and never rewrites present values;
  serializePackage() drops every filled key the organiser left untouched (pruneInjected). Unknown and
  future fields ride along verbatim. The pure core is exposed as globalThis.TournamentRulesCore for the
  page tests; the UI only boots when the page markup (#editor) exists.
*/

const MEGA_STARS = [
  "Morg 'n' Thorg",
  "H'thark the Unstoppable",
  "Griff Oberwald",
  'Ivan "the Animal" Deathshroud',
  "Hakflem Skuttlespike",
];

// Ids match packages/bb-validator/src/dataset/bb2025/inducements.json.
const INDUCEMENTS = [
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

const CATEGORY_COLORS = {
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

// Mirrors the validator's DEFAULT_SKILL_ALLOTMENT (packages/bb-validator/src/package/types.ts), so an
// absent key shows the value the validator will actually apply.
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

// The validator's loadPackage() defaults for the other top-level blocks.
const DEFAULT_STAR_PLAYERS = { allowed: true, maxCount: null, maxCombinedCost: null };
const DEFAULT_INDUCEMENTS = { allowed: ["*"], caps: {} };
const DEFAULT_SIDELINE = { maxReRolls: 8, maxApothecary: 1, maxCheerleaders: null, maxAssistantCoaches: null, maxDedicatedFans: null };
const DEFAULT_SPECIAL = { insignificantTraitConstraint: true, stalling: true, slannAllowed: false, statIncreasesAllowed: false, bannedSkills: [], minPlayers: 11 };
const DEFAULT_GOLD_COSTS = { primaryCostGold: 20000, secondaryCostGold: 40000, eliteSurchargeGold: 10000 };

const STAT_KEYS = ["MA", "ST", "AG", "PA", "AV"];
/** Owner 10-27: a package has at most 10 tiers (schema maxItems; the server refuses an 11th). */
const MAX_TIERS = 10;
const OPTIONAL_STRINGS = ["description", "dataNote", "date", "extends"];
const NESTED_PRUNE = new Set(["skillAllotment", "starPlayers", "inducements", "sideline", "special"]);
// Containers the editor creates on demand; emptied ones are removed again.
const LAZY_OBJECTS = new Set(["rosterGold", "stackedPlayer", "statIncreases", "costGold", "skillCostGold", "rosterOnly"]);

const TABS = [
  ["package", "Package"],
  ["races", "Races & Tiers"],
  ["skills", "Skills"],
  ["stars", "Stars"],
  ["inducements", "Inducements"],
  ["special", "Special"],
  ["summary", "Summary"],
];

const state = {
  authed: false,
  token: null,
  account: "",
  loginUser: "",
  expiresAt: "",
  discordSsoEnabled: false,
  adminNav: false,
  packageNames: [],
  selectedPackage: "",
  presets: [],
  skills: [],
  stars: [],
  teams: [],
  pkg: null,
  original: null,
  baseline: null,
  problems: [],
  saved: null,
  exported: false,
  busy: false,
  connected: false,
  catalogNotices: [],
  overrideSkill: "",
  overrideCost: 2,
  goldOverrideSkill: "",
  goldOverrideCost: 30,
  bannedSkill: "",
  ruleTeam: "",
  dragStar: "",
  dragTeam: "",
  activeTier: 0,
  tab: "package",
  view: freshView("skillpoints", "pool"),
  preview: { key: "", data: null, overview: null, problems: [], error: "", loading: false },
  /** Paths (JSON) of fields normalizePackage() filled / the organiser has edited since load. */
  injected: new Set(),
  touched: new Set(),
  preEdit: null,
  /** sha256 of the file as opened (If-Match on save); a 409 message; a read-only reason. */
  revision: null,
  conflict: "",
  readOnly: "",
};

let toolbar = null;
let shelf = null;
let editor = null;
let rightRail = null;
let connectionState = null;

function freshView(system, skillMode) {
  return { system, skillMode, initialSystem: system, initialSkillMode: skillMode, systemTouched: false, skillModeTouched: false, starCostsTouched: false };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isObj(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a, b) {
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

function numberOr(value, fallback) {
  if (value === "" || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function goldToK(value) {
  return value == null || value === "" ? "" : Number(value) / 1000;
}

function kToGold(value) {
  const number = nullableNumber(value);
  return number == null ? null : Math.round(number * 1000);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function packageName(entry) {
  return typeof entry === "string" ? entry : typeof entry?.name === "string" ? entry.name : "";
}

function serverMessage(error) {
  if (typeof error?.serverError === "string") return error.serverError;
  if (typeof error?.message === "string") return error.message;
  return String(error);
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`);
    error.status = response.status;
    error.serverError = typeof data?.error === "string" ? data.error : undefined;
    error.data = data;
    throw error;
  }
  return data;
}

// ---------- package model ----------

const pathKey = (path) => JSON.stringify(path);

function fill(target, key, value, filled, prefix = []) {
  if (target[key] !== undefined) return;
  target[key] = clone(value);
  filled?.add(pathKey([...prefix, key]));
}

function objectAt(target, key) {
  if (!isObj(target[key])) target[key] = {};
  return target[key];
}

/** Editing model: a clone of the raw package with ABSENT keys filled (validator defaults). Present
 *  values are never rewritten, so serializePackage() can hand the file back unchanged. `filled`
 *  collects the path of every filled key, so the controls can show those values as defaults
 *  (placeholders) rather than as the organiser's own. */
function normalizePackage(raw, filled) {
  const pkg = isObj(raw) ? clone(raw) : {};
  fill(pkg, "name", "", filled);
  fill(pkg, "ruleset", "bb2025-default", filled);
  OPTIONAL_STRINGS.forEach((key) => fill(pkg, key, "", filled));
  fill(pkg, "eligibleRosters", ["*"], filled);
  fill(pkg, "goldBudget", null, filled);
  fill(pkg, "goldCapIncludesAddedSkills", false, filled);
  const allotment = objectAt(pkg, "skillAllotment");
  Object.entries(DEFAULT_SKILL_ALLOTMENT).forEach(([key, value]) => fill(allotment, key, value, filled, ["skillAllotment"]));
  ["skillPackages", "tiers", "teamRules", "bannedStars"].forEach((key) => {
    if (!Array.isArray(pkg[key])) pkg[key] = [];
  });
  const stars = objectAt(pkg, "starPlayers");
  Object.entries(DEFAULT_STAR_PLAYERS).forEach(([key, value]) => fill(stars, key, value, filled, ["starPlayers"]));
  const inducements = objectAt(pkg, "inducements");
  Object.entries(DEFAULT_INDUCEMENTS).forEach(([key, value]) => fill(inducements, key, value, filled, ["inducements"]));
  const sideline = objectAt(pkg, "sideline");
  Object.entries(DEFAULT_SIDELINE).forEach(([key, value]) => fill(sideline, key, value, filled, ["sideline"]));
  const special = objectAt(pkg, "special");
  Object.entries(DEFAULT_SPECIAL).forEach(([key, value]) => fill(special, key, value, filled, ["special"]));
  return pkg;
}

/**
 * Drop keys the organiser never touched that normalizePackage() filled in. A key the organiser
 * edited (state.touched) is always kept, even when its value equals the filled default: under
 * `extends` an explicit default still overrides the base package's value.
 */
function pruneInjected(output, original, baseline, nested = true, prefix = []) {
  Object.keys(output).forEach((key) => {
    const path = [...prefix, key];
    // Only filled defaults need protecting: everything else is pruned by value as before.
    if (state.touched?.has(pathKey(path)) && state.injected?.has(pathKey(path))) return;
    const present = isObj(original) && Object.prototype.hasOwnProperty.call(original, key);
    if (!present) {
      if (nested && NESTED_PRUNE.has(key) && isObj(output[key]) && isObj(baseline?.[key])) {
        pruneInjected(output[key], {}, baseline[key], false, path);
        if (Object.keys(output[key]).length === 0) delete output[key];
      } else if (output[key] === undefined || deepEqual(output[key], baseline?.[key])) delete output[key];
      return;
    }
    if (nested && NESTED_PRUNE.has(key) && isObj(output[key]) && isObj(original[key])) {
      pruneInjected(output[key], original[key], baseline?.[key], false, path);
    }
  });
  return output;
}

/** Record which top-level / nested-block fields an edit changed (compared with state.preEdit). */
function recordTouched() {
  const before = state.preEdit;
  state.preEdit = null;
  if (!before || !state.pkg) return;
  const keys = new Set([...Object.keys(before), ...Object.keys(state.pkg)]);
  keys.forEach((key) => {
    if (deepEqual(before[key], state.pkg[key])) return;
    state.touched.add(pathKey([key]));
    if (NESTED_PRUNE.has(key) && isObj(before[key]) && isObj(state.pkg[key])) {
      new Set([...Object.keys(before[key]), ...Object.keys(state.pkg[key])]).forEach((sub) => {
        if (!deepEqual(before[key][sub], state.pkg[key][sub])) state.touched.add(pathKey([key, sub]));
      });
    }
  });
}

/** True while a field still holds the default normalizePackage() filled in (shown as a placeholder). */
function isInherited(path) {
  const key = pathKey(path);
  return state.injected.has(key) && !state.touched.has(key);
}

function inheritedHint(display) {
  return state.pkg?.extends ? `inherited from ${state.pkg.extends}` : `default ${display === "" || display == null ? "none" : display}`;
}

function inferView(pkg) {
  const allotment = pkg.skillAllotment;
  const skillMode = allotment.maxPrimary != null || allotment.maxSecondary != null ? "count" : "pool";
  const system = pkg.matrix?.cells?.length
    ? "matrix"
    : pkg.tiers?.length
      ? "tiers"
      : pkg.skillPackages?.length
        ? "packages"
        : "skillpoints";
  return freshView(system, skillMode);
}

/** Make `doc` the document being edited: the "as authored" original, the filled editing model,
 *  and fresh touched / filled bookkeeping. */
function adoptDocument(doc) {
  state.original = isObj(doc) ? clone(doc) : {};
  state.baseline = normalizePackage(doc);
  const filled = new Set();
  state.pkg = normalizePackage(doc, filled);
  state.injected = filled;
  state.touched = new Set();
  state.preEdit = null;
}

function loadPackageIntoEditor(pkg, problems) {
  adoptDocument(pkg);
  state.view = inferView(state.pkg);
  state.activeTier = 0;
  state.revision = null;
  state.readOnly = "";
  state.conflict = "";
  state.problems = safeArray(problems).map(String);
  state.saved = null;
  state.exported = false;
  state.overrideSkill = state.skills[0]?.name ?? "";
  state.goldOverrideSkill = state.skills[0]?.name ?? "";
  state.bannedSkill = state.skills[0]?.name ?? "";
  render();
}

function fallbackRaw() {
  return {
    name: "",
    ruleset: "bb2025-default",
    eligibleRosters: ["*"],
    skillAllotment: { ...clone(DEFAULT_SKILL_ALLOTMENT) },
    goldBudget: null,
    starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: null },
    inducements: { allowed: ["*"], caps: {} },
    sideline: {},
    special: { insignificantTraitConstraint: true, stalling: true, slannAllowed: false, statIncreasesAllowed: false, bannedSkills: [], minPlayers: 11 },
  };
}

function fallbackPackage() {
  return normalizePackage(fallbackRaw());
}

function markDirty() {
  recordTouched();
  state.saved = null;
  state.exported = false;
  state.problems = [];
}

function skillColor(name) {
  const skill = state.skills.find((row) => row.name === name);
  return CATEGORY_COLORS[String(skill?.category ?? "").toLowerCase()] ?? "var(--text)";
}

function tierClass(tier) {
  const value = Math.max(1, Math.min(4, Number(tier) || 4));
  return `tier-${value}`;
}

function assignedTierFor(raceName) {
  const tier = safeArray(state.pkg?.tiers).find((entry) => safeArray(entry.rosters).includes(raceName));
  return tier?.tier ?? null;
}

function isAllRaces() {
  return safeArray(state.pkg.eligibleRosters).includes("*");
}

function inducementAllowedList() {
  return safeArray(state.pkg.inducements.allowed);
}

function isInducementAllowed(id) {
  const allowed = inducementAllowedList();
  return allowed.includes("*") || allowed.includes(id);
}

function matrixForDisplay() {
  const existing = state.pkg.matrix ?? { columns: [], rows: [], cells: [] };
  const columns = [...safeArray(existing.columns)];
  const rows = [...safeArray(existing.rows)];
  const defaults = [1150000, 1100000, 1050000];
  const rowDefaults = [[6, 0], [5, 1], [4, 2]];
  if (columns.length === 0) {
    while (columns.length < 3) columns.push({ gold: defaults[columns.length] });
  }
  if (rows.length === 0) {
    while (rows.length < 3) {
      const values = rowDefaults[rows.length];
      rows.push({ primary: values[0], secondary: values[1], secondarySwap: false });
    }
  }
  return { ...existing, columns, rows, cells: safeArray(existing.cells) };
}

function starTierCostsForDisplay(name) {
  const tierCount = state.pkg.tiers.length;
  const existing = safeArray(state.pkg.starPlayers.spCostByTier?.[name]);
  const costs = existing.slice(0, tierCount).map((value) => value == null ? null : numberOr(value, null));
  while (costs.length < tierCount) costs.push(null);
  return costs;
}

function pairedStarNames(name) {
  const star = state.stars.find((s) => s.name === name);
  const partner = star?.pairedWith;
  if (!partner) return [name];
  // Dataset-declared lead star first (pairPrimary — "Grak & Crumbleberry", "Dribl & Drull"); alphabetical fallback.
  const partnerStar = state.stars.find((s) => s.name === partner);
  return [ [name, star], [partner, partnerStar] ]
    .sort((a, b) => ((b[1]?.pairPrimary ? 1 : 0) - (a[1]?.pairPrimary ? 1 : 0)) || a[0].localeCompare(b[0]))
    .map((entry) => entry[0]);
}

function groupedStars(names) {
  const available = new Set(names);
  const seen = new Set();
  return names.flatMap((name) => {
    if (seen.has(name)) return [];
    const group = pairedStarNames(name).filter((member) => available.has(member));
    group.forEach((member) => seen.add(member));
    return [{ names: group, label: group.join(" & ") }];
  });
}

function serializePackage() {
  const output = clone(state.pkg);
  output.name = String(output.name ?? "").trim();
  output.ruleset = output.ruleset || "bb2025-default";

  // Switching the pricing mode / tournament system drops the other mode's data — only when the
  // organiser actually switched away from what the package loaded with. Coming back restores the
  // loaded document's own values (state.original is the deep snapshot taken at load), so a detour
  // never turns explicit nulls into 0 or leaves detour-created content behind.
  const original = state.original ?? {};
  const restore = (target, source, key) => {
    if (isObj(source) && Object.prototype.hasOwnProperty.call(source, key)) target[key] = clone(source[key]);
    else delete target[key];
  };
  if (state.view.skillModeTouched && state.view.skillMode === "pool") {
    ["maxPrimary", "maxSecondary", "secondarySwap", "secondarySwapRatio", "secondarySwapMax"].forEach((key) => {
      if (state.view.initialSkillMode === "pool") restore(output.skillAllotment, original.skillAllotment, key);
      else delete output.skillAllotment[key];
    });
  }
  if (state.view.systemTouched) {
    const keep = { skillpoints: [], tiers: ["tiers"], packages: ["skillPackages"], matrix: ["matrix"] }[state.view.system] ?? [];
    const switched = state.view.system !== state.view.initialSystem;
    ["tiers", "skillPackages", "matrix"].forEach((key) => {
      if (keep.includes(key)) return;
      if (switched) delete output[key];
      else restore(output, original, key);
    });
  }
  if (state.view.system === "matrix") output.matrix = clone(matrixForDisplay());

  if (state.view.starCostsTouched) {
    const tierCount = safeArray(output.tiers).length;
    const spCostByTier = {};
    Object.entries(output.starPlayers.spCostByTier ?? {}).forEach(([name, values]) => {
      const costs = safeArray(values).slice(0, tierCount).map((value) => value == null ? null : numberOr(value, null));
      while (costs.length < tierCount) costs.push(null);
      if (costs.some((value) => value != null)) spCostByTier[name] = costs;
    });
    if (Object.keys(spCostByTier).length) output.starPlayers.spCostByTier = spCostByTier;
    else delete output.starPlayers.spCostByTier;
  }

  OPTIONAL_STRINGS.forEach((key) => {
    if (output[key] === "" && state.original?.[key] !== "") delete output[key];
  });

  return pruneInjected(output, state.original ?? {}, state.baseline ?? {});
}

// ---------- generic bound controls ----------

function readPath(attribute) {
  try {
    const path = JSON.parse(attribute);
    return Array.isArray(path) && path.length ? path : null;
  } catch {
    return null;
  }
}

function getPath(root, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), root);
}

/** Set (or, with value === undefined, delete) the value at path; creates containers on the way and
 *  removes emptied on-demand containers (LAZY_OBJECTS) after a delete. */
function setPath(root, path, value) {
  let target = root;
  const parents = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (target[key] == null || typeof target[key] !== "object") {
      if (value === undefined) return;
      target[key] = typeof path[index + 1] === "number" ? [] : {};
    }
    parents.push([target, key]);
    target = target[key];
  }
  const last = path[path.length - 1];
  if (value !== undefined) {
    target[last] = value;
    return;
  }
  if (Array.isArray(target)) return;
  delete target[last];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index];
    if (LAZY_OBJECTS.has(key) && isObj(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
}

function blankValue(blank) {
  if (blank === "null") return null;
  if (blank === "zero") return 0;
  if (blank === "empty") return "";
  if (blank === "false") return false;
  return undefined;
}

function boundValue(target) {
  const kind = target.dataset.kind || "num";
  const blank = target.dataset.blank || "delete";
  if (kind === "bool") return target.checked ? true : blankValue(blank);
  if (kind === "tri") return target.value === "true" ? true : target.value === "false" ? false : undefined;
  if (kind === "str") return target.value === "" ? blankValue(blank) : target.value;
  const number = kind === "gold" ? kToGold(target.value) : nullableNumber(target.value);
  if (number == null) return blankValue(blank);
  return kind === "int" ? Math.max(0, Math.round(number)) : number;
}

function applyBinding(target) {
  const path = readPath(target.dataset.bind);
  if (!path) return false;
  if (path[0] === "matrix") state.pkg.matrix = matrixForDisplay();
  setPath(state.pkg, path, boundValue(target));
  return true;
}

function applyMulti(target) {
  if (target.dataset.multiAll != null) {
    const path = readPath(target.dataset.multiAll);
    if (!path) return false;
    setPath(state.pkg, path, target.checked ? undefined : []);
    return true;
  }
  const path = readPath(target.dataset.multi);
  if (!path) return false;
  const value = target.dataset.value;
  const list = [...safeArray(getPath(state.pkg, path))];
  const has = list.includes(value);
  if (target.checked && !has) list.push(value);
  if (!target.checked && has) list.splice(list.indexOf(value), 1);
  setPath(state.pkg, path, list);
  return true;
}

function bindAttr(path) {
  return `data-bind="${escapeHtml(JSON.stringify(path))}"`;
}

function numField(label, path, value, opts = {}) {
  const kind = opts.kind ?? "num";
  let display = kind === "gold" ? goldToK(value) : value ?? "";
  if (isInherited(path)) {
    // A filled default is shown as a placeholder, so it reads differently from an explicit value.
    opts = { ...opts, placeholder: inheritedHint(display) };
    display = "";
  }
  const suffix = opts.suffix ?? (kind === "gold" ? "k" : "");
  return `<label class="field${opts.wide ? " wide" : ""}"><span class="field-label">${escapeHtml(label)}</span>
    <span class="field-input"><input class="control" ${bindAttr(path)} data-kind="${kind}" data-blank="${opts.blank ?? "delete"}" type="number" min="${opts.min ?? 0}"${opts.step ? ` step="${opts.step}"` : ""} value="${escapeHtml(display)}" placeholder="${escapeHtml(opts.placeholder ?? "")}" aria-label="${escapeHtml(opts.aria ?? label)}">${suffix ? `<span class="hint">${escapeHtml(suffix)}</span>` : ""}</span></label>`;
}

function textField(label, path, value, opts = {}) {
  return `<label class="field${opts.wide ? " wide" : ""}"><span class="field-label">${escapeHtml(label)}</span><input class="control" ${bindAttr(path)} data-kind="str" data-blank="${opts.blank ?? "delete"}" value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(opts.placeholder ?? "")}" aria-label="${escapeHtml(opts.aria ?? label)}"></label>`;
}

function triField(label, path, value, labels = ["inherit", "yes", "no"]) {
  const current = value === true ? "true" : value === false ? "false" : "";
  return `<label class="field"><span class="field-label">${escapeHtml(label)}</span><select class="control" ${bindAttr(path)} data-kind="tri" aria-label="${escapeHtml(label)}">
    <option value=""${current === "" ? " selected" : ""}>${escapeHtml(labels[0])}</option>
    <option value="true"${current === "true" ? " selected" : ""}>${escapeHtml(labels[1])}</option>
    <option value="false"${current === "false" ? " selected" : ""}>${escapeHtml(labels[2])}</option>
  </select></label>`;
}

function checkField(label, path, value, blank = "delete") {
  return `<label class="check-field"><input type="checkbox" ${bindAttr(path)} data-kind="bool" data-blank="${blank}"${value === true ? " checked" : ""}> <span>${escapeHtml(label)}</span></label>`;
}

/** A checkbox list in a <details>. `allLabel` adds an option meaning "key absent" (inherit / every). */
function multiSelect({ key, path, label, items, selected, allLabel, emptyLabel = "none" }) {
  const list = Array.isArray(selected) ? selected : null;
  const known = new Set(items.map((item) => item.value));
  const extra = safeArray(list).filter((value) => !known.has(value)).map((value) => ({ value, label: value }));
  const all = allLabel && list == null;
  const summary = all ? allLabel : list && list.length ? `${list.length} selected` : emptyLabel;
  const pathAttr = escapeHtml(JSON.stringify(path));
  const options = [...items, ...extra].map((item) => `<label class="multi-option"><input type="checkbox" data-multi="${pathAttr}" data-value="${escapeHtml(item.value)}"${list?.includes(item.value) ? " checked" : ""}${all ? " disabled" : ""}> <span>${escapeHtml(item.label)}</span></label>`).join("");
  return `<details class="multi" data-preserve-open="${escapeHtml(key)}">
    <summary><span class="field-label">${escapeHtml(label)}</span> <span class="multi-summary">${escapeHtml(summary)}</span></summary>
    <div class="multi-list">
      ${allLabel ? `<label class="multi-option multi-all"><input type="checkbox" data-multi-all="${pathAttr}"${all ? " checked" : ""}> <span>${escapeHtml(allLabel)}</span></label>` : ""}
      ${options || '<span class="hint">Catalog unavailable.</span>'}
    </div>
  </details>`;
}

function rosterItems() {
  return state.teams.map((team) => ({ value: team.name, label: team.name }));
}

function starItems() {
  return state.stars.map((star) => ({ value: star.name, label: star.name }));
}

function skillItems() {
  return state.skills.map((skill) => ({ value: skill.name, label: skill.name }));
}

function starPackItems() {
  return safeArray(state.pkg.starPacks).map((pack, index) => ({ value: String(pack.id ?? ""), label: pack.label ? `${pack.label} (${pack.id})` : String(pack.id || `Pack ${index + 1}`) }));
}

// ---------- rendering ----------

function options(items, current, getValue = (item) => item, getLabel = (item) => item) {
  return items.map((item) => {
    const value = String(getValue(item));
    return `<option value="${escapeHtml(value)}"${value === String(current ?? "") ? " selected" : ""}>${escapeHtml(getLabel(item))}</option>`;
  }).join("");
}

function chip(label, action, active, extra = "") {
  return `<button type="button" class="chip${active ? " active" : ""}${extra ? ` ${extra}` : ""}" data-action="${action}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(label)}</button>`;
}

function title(words) {
  return words.split(" ").map((word) => word ? `<span>${escapeHtml(word[0])}</span>${escapeHtml(word.slice(1))}` : "").join(" ");
}

function renderToolbar() {
  if (!toolbar) return;
  toolbar.innerHTML = state.authed || state.token
    ? `<span class="login-status"><span class="session-dot" aria-hidden="true"></span> ${escapeHtml(state.account)}${state.expiresAt ? ` <small>· token expires ${escapeHtml(state.expiresAt)}</small>` : ""}</span>
       <button type="button" class="session-button secondary" data-action="logout">Log out</button>`
    : `<label class="visually-hidden" for="login-user">Username</label>
       <input id="login-user" class="control" autocomplete="username" placeholder="Username" value="${escapeHtml(state.loginUser)}">
       <label class="visually-hidden" for="login-password">Password</label>
       <input id="login-password" class="control" type="password" autocomplete="current-password" placeholder="Password">
       <button type="button" class="session-button" data-action="login">Log in</button>
       ${state.discordSsoEnabled ? '<button type="button" class="session-button discord-button" data-action="discord-login">Discord</button>' : ""}`;
}

function renderShelf() {
  if (!shelf) return;
  const cards = state.packageNames.map((name) => `<button type="button" class="package-card${name === state.selectedPackage ? " selected" : ""}" data-action="open-package" data-name="${escapeHtml(name)}" aria-pressed="${name === state.selectedPackage ? "true" : "false"}"><strong>${escapeHtml(name)}</strong></button>`).join("");
  const presetOptions = '<option value="">—</option>' + options(state.presets, "", (preset) => preset.id, (preset) => preset.label);
  shelf.innerHTML = `
    <div class="shelf-head">
      <div class="section-title">${title("Tournament Packages")}</div>
      <div class="shelf-actions">
        <label class="inline-controls"><span class="field-label">New from preset</span><select class="control" data-action="select-preset" aria-label="New from Preset">${presetOptions}</select></label>
        <button type="button" class="session-button secondary" data-action="new-package">New blank package</button>
      </div>
    </div>
    <div class="package-cards">${cards || '<span class="hint">No saved packages yet.</span>'}</div>`;
}

function renderPackageDetails() {
  const pkg = state.pkg;
  const extendsOptions = '<option value="">— none —</option>' + options(state.packageNames, pkg.extends);
  return `
    <section class="panel">
      <div class="section-title">${title("Package Details")}</div>
      <div class="form-grid">
        <label class="field"><span class="field-label">Name *</span><input class="control" data-field="name" value="${escapeHtml(pkg.name)}"></label>
        <label class="field"><span class="field-label">Date</span><input class="control" data-field="date" type="date" value="${escapeHtml(pkg.date)}"></label>
        <label class="field"><span class="field-label">Ruleset</span><input class="control" value="${escapeHtml(pkg.ruleset === "bb2025-default" ? "BB2025" : pkg.ruleset)}" readonly></label>
        <label class="field"><span class="field-label">Extends (inherit from)</span><select class="control" data-field="extends">${extendsOptions}</select></label>
      </div>
      <label class="field"><span class="field-label">Description</span><textarea class="control" data-field="description">${escapeHtml(pkg.description)}</textarea></label>
      <label class="field"><span class="field-label">Data note (small print shown with the rules)</span><textarea class="control" data-field="dataNote" rows="2">${escapeHtml(pkg.dataNote)}</textarea></label>
    </section>`;
}

function renderGold() {
  const includesSkills = state.pkg.goldCapIncludesAddedSkills === true;
  const note = includesSkills
    ? "The cap is a hard total: added-skill, stat-increase and star-pack-fee gold count inside it."
    : "The cap checks ONLY creation gold — players + sideline staff + inducements.";
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Gold / Team-Value Cap")}</div>
        ${overrideField("Creation gold cap", ["goldBudget"], state.pkg.goldBudget, { kind: "gold", none: true, noneLabel: "no cap", flat: true })}
        ${chip("Creation Gold", "cap-creation", !includesSkills)}
        ${chip("Skills as Part of the Gold Budget", "cap-includes", includesSkills)}
      </div>
      <div class="hint">${note}</div>
    </section>`;
}

function renderRaces() {
  const all = isAllRaces();
  const selected = new Set(safeArray(state.pkg.eligibleRosters));
  const chips = state.teams.map((team) => {
    const active = all || selected.has(team.name);
    const assignedTier = assignedTierFor(team.name);
    const displayedTier = assignedTier ?? team.defaultTier;
    return `<button type="button" class="chip race-chip${active ? " active" : ""}" data-action="toggle-race" data-name="${escapeHtml(team.name)}">
      ${escapeHtml(team.name)} <span class="tier-badge ${tierClass(displayedTier)}${assignedTier == null ? " tier-default" : ""}">T${escapeHtml(displayedTier ?? "?")}</span>
    </button>`;
  }).join("");
  const count = all ? `all ${state.teams.length} races eligible` : `${safeArray(state.pkg.eligibleRosters).length} of ${state.teams.length} selected`;
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Eligible Races")}</div>
        ${chip("All Races", "toggle-all-races", all)}
        <span class="hint">${escapeHtml(count)}</span>
      </div>
      ${!all ? `<div class="race-list">${chips || '<span class="hint">Race catalog unavailable. Existing eligibility will be preserved.</span>'}</div>` : ""}
    </section>`;
}

/**
 * A three-state override: inherit (key absent) / an explicit value / an explicit null ("none").
 * Only fields whose resolver treats null as "no limit" (an `!== undefined` merge in
 * bb-validator resolveConfig) get the none state; for `!= null` merges null would just inherit.
 */
function overrideField(label, path, value, opts = {}) {
  const kind = opts.kind ?? "num";
  // A value normalizePackage() filled in (and the organiser has not touched) reads as "inherit".
  const inherited = value === undefined || isInherited(path);
  const mode = inherited ? "inherit" : value === null ? "none" : "set";
  const display = mode !== "set" ? "" : kind === "gold" ? goldToK(value) : value;
  const filledHint = value === undefined ? null : inheritedHint(value === null ? "" : kind === "gold" ? `${goldToK(value)}k` : value);
  const placeholder = mode === "none" ? (opts.noneLabel ?? "no limit") : mode === "inherit" && filledHint ? filledHint : (opts.placeholder ?? (opts.flat ? "default" : "inherit"));
  const inheritLabel = opts.inheritLabel ?? (opts.flat ? (state.pkg?.extends ? "inherit" : "default") : "inherit");
  const pathAttr = escapeHtml(JSON.stringify(path));
  return `<label class="field override-field"><span class="field-label">${escapeHtml(label)}</span>
    <span class="field-input">
      <select class="control mode-select" data-override-mode="${pathAttr}" data-kind="${kind}" aria-label="${escapeHtml(label)} mode">
        <option value="inherit"${mode === "inherit" ? " selected" : ""}>${escapeHtml(inheritLabel)}</option>
        <option value="set"${mode === "set" ? " selected" : ""}>value</option>
        ${opts.none ? `<option value="none"${mode === "none" ? " selected" : ""}>${escapeHtml(opts.noneLabel ?? "no limit")}</option>` : ""}
      </select>
      <input class="control" ${bindAttr(path)} data-kind="${kind}" data-blank="delete" type="number" min="${opts.min ?? 0}" value="${escapeHtml(display)}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(label)}">${kind === "gold" ? '<span class="hint">k</span>' : ""}
    </span></label>`;
}

function applyOverrideMode(target) {
  const path = readPath(target.dataset.overrideMode);
  if (!path) return false;
  if (path[0] === "matrix") state.pkg.matrix = matrixForDisplay();
  const current = getPath(state.pkg, path);
  if (target.value === "inherit") setPath(state.pkg, path, undefined);
  else if (target.value === "none") setPath(state.pkg, path, null);
  else if (current == null) setPath(state.pkg, path, 0);
  return true;
}

function renderStatIncreases(path, rule, { key, inherit }) {
  const si = isObj(rule) ? rule : {};
  const costs = STAT_KEYS.map((stat) => inherit
    ? overrideField(`${stat} cost`, [...path, "costGold", stat], si.costGold?.[stat], { kind: "gold" })
    : numField(`${stat} cost`, [...path, "costGold", stat], si.costGold?.[stat], { kind: "gold", placeholder: "0" })).join("");
  return `
    <div class="inset-list stat-rule">
      <div class="subheading">Stat increases</div>
      <div class="knob-grid">
        ${multiSelect({ key: `${key}-allowed`, path: [...path, "allowed"], label: "Allowed stats", items: STAT_KEYS.map((stat) => ({ value: stat, label: stat })), selected: si.allowed, allLabel: inherit ? "Inherit" : "Not checked" })}
        ${overrideField("Max per player", [...path, "maxPerPlayer"], si.maxPerPlayer, { kind: "int", none: true, placeholder: inherit ? "inherit" : "1 (default)", inheritLabel: inherit ? "inherit" : "default" })}
        ${costs}
        ${inherit ? triField("No added skills with a stat increase", [...path, "exclusiveWithSkills"], si.exclusiveWithSkills) : ""}
      </div>
      ${inherit ? "" : checkField("A player with a stat increase may not take added skills", [...path, "exclusiveWithSkills"], si.exclusiveWithSkills)}
    </div>`;
}

/** Override knobs shared by tiers and team rules (ExtraSkillKnobs + count / swap / stacking). */
function renderKnobs(path, obj, { key, team = false }) {
  const o = isObj(obj) ? obj : {};
  const p = (...keys) => [...path, ...keys];
  const packs = starPackItems();
  // Team rules merge gold / maxPrimary / maxSecondary with `!== undefined` (null = no limit);
  // tiers merge them with `!= null` (null = inherit), so tiers get no "none" state there.
  return `
    <div class="knob-grid">
      ${team ? overrideField("Gold cap", p("gold"), o.gold, { kind: "gold", none: true, noneLabel: "no gold cap" }) : ""}
      ${team ? overrideField("SP budget", p("skillPointBudget"), o.skillPointBudget) : ""}
      ${overrideField("Max primary (count)", p("maxPrimary"), o.maxPrimary, { none: team })}
      ${overrideField("Max secondary (count)", p("maxSecondary"), o.maxSecondary, { none: team })}
      ${triField("Secondary swap", p("secondarySwap"), o.secondarySwap)}
      ${overrideField("Swap ratio (primary per secondary)", p("secondarySwapRatio"), o.secondarySwapRatio, { min: 1 })}
      ${overrideField("Max swaps", p("secondarySwapMax"), o.secondarySwapMax, { none: true, noneLabel: "unlimited" })}
      ${overrideField("Max stacked players", p("maxStackedPlayers"), o.maxStackedPlayers, { none: true })}
      ${overrideField("Elite skills cap", p("eliteMaxTotal"), o.eliteMaxTotal, { kind: "int", none: true })}
      ${overrideField("Same elite skill cap", p("eliteMaxSameSkill"), o.eliteMaxSameSkill, { kind: "int", none: true })}
      ${overrideField("Stacked player: max skills", p("stackedPlayer", "maxSkills"), o.stackedPlayer?.maxSkills, { kind: "int", none: true })}
      ${overrideField("Stacked player: max secondary", p("stackedPlayer", "maxSecondary"), o.stackedPlayer?.maxSecondary, { kind: "int", none: true })}
      ${overrideField("Stacked player: max elite", p("stackedPlayer", "maxElite"), o.stackedPlayer?.maxElite, { kind: "int", none: true })}
      ${team ? triField("Star players", p("starPlayersAllowed"), o.starPlayersAllowed) : ""}
    </div>
    ${renderStatIncreases(p("statIncreases"), o.statIncreases, { key: `${key}-stats`, inherit: true })}
    <div class="knob-grid">
      ${packs.length ? multiSelect({ key: `${key}-packs`, path: p("starPacksAllowed"), label: "Star packs open", items: packs, selected: o.starPacksAllowed, allLabel: "Inherit (every pack)" }) : ""}
      ${multiSelect({ key: `${key}-banned`, path: p("bannedStars"), label: "Banned stars", items: starItems(), selected: o.bannedStars ?? (team ? undefined : []), allLabel: team ? "Inherit" : undefined })}
    </div>`;
}

function renderTierPack(index, packIndex, skillPackage) {
  const base = ["tiers", index, "skillPackages", packIndex];
  return `
    <div class="inset-row tier-pack-row">
      <input class="control grow" data-action="tier-pack-label" data-tier="${index}" data-pack="${packIndex}" value="${escapeHtml(skillPackage.label ?? `Pack ${packIndex + 1}`)}" aria-label="Tier ${index + 1} pack label">
      <input class="control compact" data-action="tier-pack-gold" data-tier="${index}" data-pack="${packIndex}" type="number" min="0" value="${escapeHtml(goldToK(skillPackage.gold))}" aria-label="Tier ${index + 1} pack gold in thousands"><span class="hint">k</span>
      <input class="control tiny" data-action="tier-pack-sp" data-tier="${index}" data-pack="${packIndex}" type="number" min="0" value="${escapeHtml(skillPackage.skillPointBudget ?? 0)}" aria-label="Tier ${index + 1} pack SP"><span class="hint">SP</span>
      <input class="control tiny" data-action="tier-pack-maxper" data-tier="${index}" data-pack="${packIndex}" type="number" min="0" value="${escapeHtml(skillPackage.maxPerPlayer ?? "")}" placeholder="default" aria-label="Tier ${index + 1} pack max skills per player">
      <span class="hint">max/player</span>
      <input class="control tiny" ${bindAttr([...base, "maxSkills"])} data-kind="int" type="number" min="0" value="${escapeHtml(skillPackage.maxSkills ?? "")}" placeholder="—" aria-label="Tier ${index + 1} pack total skills (count mode)">
      <span class="hint">skills</span>
      <input class="control tiny" ${bindAttr([...base, "maxSecondary"])} data-kind="int" type="number" min="0" value="${escapeHtml(skillPackage.maxSecondary ?? "")}" placeholder="—" aria-label="Tier ${index + 1} pack secondary skills (count mode)">
      <span class="hint">sec</span>
      <select class="control tiny" ${bindAttr([...base, "starPlayersAllowed"])} data-kind="tri" aria-label="Tier ${index + 1} pack star players">
        <option value=""${skillPackage.starPlayersAllowed == null ? " selected" : ""}>★ default</option>
        <option value="true"${skillPackage.starPlayersAllowed === true ? " selected" : ""}>★ yes</option>
        <option value="false"${skillPackage.starPlayersAllowed === false ? " selected" : ""}>★ no</option>
      </select>
      <button type="button" class="remove" data-action="tier-pack-remove" data-tier="${index}" data-pack="${packIndex}" aria-label="Remove ${escapeHtml(skillPackage.label ?? `Pack ${packIndex + 1}`)}">✕</button>
    </div>`;
}

function renderTiers() {
  const activeTier = state.pkg.tiers.length
    ? Math.min(Math.max(state.activeTier, 0), state.pkg.tiers.length - 1)
    : -1;
  const assigned = new Set(state.pkg.tiers.flatMap((tier) => safeArray(tier.rosters)));
  const unassigned = state.teams.filter((team) => !assigned.has(team.name));
  const rows = state.pkg.tiers.map((tier, index) => {
    const rosterChips = safeArray(tier.rosters).map((name) => `
      <span class="chip race-chip active tier-team-chip" draggable="true" data-team="${escapeHtml(name)}" data-tier-source="${index}">
        <span>${escapeHtml(name)}</span>
        <button type="button" class="remove" data-action="remove-tier-team" data-team="${escapeHtml(name)}" data-tier="${index}" aria-label="Remove ${escapeHtml(name)} from tier">&times;</button>
      </span>`).join("");
    const packs = safeArray(tier.skillPackages).map((skillPackage, packIndex) => renderTierPack(index, packIndex, skillPackage)).join("");
    const rosterGold = isObj(tier.rosterGold) ? tier.rosterGold : {};
    const goldNames = [...new Set([...safeArray(tier.rosters), ...Object.keys(rosterGold)])];
    const overrideCount = Object.keys(tier).filter((key) => !["tier", "label", "rosters", "gold", "skillPointBudget", "skillPackages", "starPlayersAllowed", "bannedStars"].includes(key)).length
      + safeArray(tier.bannedStars).length;
    return `
      <div class="tier-block${index === activeTier ? " active" : ""}" data-tier-block="${index}" data-tier-drop="${index}">
        <div class="inset-row tier-main-row">
          <input class="control tiny" data-tier-index="${index}" data-tier-field="tier" type="number" min="1" value="${escapeHtml(tier.tier ?? index + 1)}" aria-label="Tier number">
          <input class="control" style="width:130px" data-tier-index="${index}" data-tier-field="label" value="${escapeHtml(tier.label ?? `Tier ${tier.tier ?? index + 1}`)}" aria-label="Tier label">
          <input class="control compact" data-tier-index="${index}" data-tier-field="gold" type="number" min="0" value="${escapeHtml(goldToK(tier.gold))}" aria-label="Tier gold in thousands">
          <span class="hint">k</span>
          <input class="control tiny" data-tier-index="${index}" data-tier-field="skillPointBudget" type="number" min="0" value="${escapeHtml(tier.skillPointBudget ?? "")}" aria-label="Tier SP">
          <span class="hint">SP</span>
          ${chip("Stars", `toggle-tier-stars:${index}`, tier.starPlayersAllowed !== false)}
          <button type="button" class="remove" data-action="remove-tier" data-index="${index}" aria-label="Remove tier">✕</button>
        </div>
        <div class="tier-team-list chip-list">${rosterChips || '<span class="hint">Drop teams here.</span>'}</div>
        <div class="tier-pack-list">
          <div class="subheading">Skill Packages</div>
          ${packs || '<div class="hint">No tier-specific packs; global packages apply if configured.</div>'}
          <div class="inline-controls">
            <button type="button" class="btn" data-action="tier-pack-add" data-tier="${index}">+ Add Pack</button>
            <button type="button" class="btn" data-action="tier-pack-generate" data-tier="${index}">Generate 3 Spike packs</button>
          </div>
        </div>
        <details class="tier-overrides" data-preserve-open="tier-overrides-${index}">
          <summary>Tier overrides${overrideCount ? ` <span class="multi-summary">${overrideCount} set</span>` : ""}</summary>
          <div class="inset-list">
            <div class="subheading">Per-roster gold caps (blank = tier gold)</div>
            <div class="knob-grid">${goldNames.map((name) => numField(name, ["tiers", index, "rosterGold", name], rosterGold[name], { kind: "gold", placeholder: String(goldToK(tier.gold)), aria: `${name} gold cap in thousands` })).join("") || '<span class="hint">Assign teams to set per-roster gold.</span>'}</div>
            ${renderKnobs(["tiers", index], tier, { key: `tier-${index}` })}
          </div>
        </details>
      </div>`;
  }).join("");
  const poolChips = unassigned.map((team) => {
    const assignedTier = assignedTierFor(team.name);
    const displayedTier = assignedTier ?? team.defaultTier;
    return `
      <button type="button" draggable="true" class="chip race-chip tier-pool-chip" data-action="assign-tier-team" data-team="${escapeHtml(team.name)}" data-tier-source="pool">
        ${escapeHtml(team.name)} <span class="tier-badge ${tierClass(displayedTier)}${assignedTier == null ? " tier-default" : ""}">T${escapeHtml(displayedTier ?? "?")}</span>
      </button>`;
  }).join("");
  return `
    <div class="inset-list">
      <div class="hint">Per-tier caps override the package caps. Races default to their live dataset tier. Click a tier to select it, then click or drag an unassigned team.</div>
      <div class="tiers-layout">
        <div class="inset-list tiers-list">
          ${rows || '<div class="hint">No tiers defined.</div>'}
          ${state.pkg.tiers.length < MAX_TIERS
            ? '<button type="button" class="btn" data-action="add-tier" style="align-self:flex-start">+ Add Tier</button>'
            : `<div class="hint">A package may have at most ${MAX_TIERS} tiers.</div>`}
        </div>
        <aside class="tier-team-pool" data-preserve-scroll="tier-team-pool">
          <div class="subheading">Unassigned teams (${unassigned.length})</div>
          <div class="tier-pool-list">${poolChips || '<span class="hint">All dataset teams are assigned.</span>'}</div>
        </aside>
      </div>
    </div>`;
}

function renderPackages() {
  const rows = state.pkg.skillPackages.map((skillPackage, index) => `
    <div class="inset-row">
      <input class="control grow" data-package-index="${index}" data-package-field="label" value="${escapeHtml(skillPackage.label ?? `Bundle ${index + 1}`)}" aria-label="Package label">
      <input class="control compact" data-package-index="${index}" data-package-field="gold" type="number" min="0" value="${escapeHtml(goldToK(skillPackage.gold))}" aria-label="Package gold in thousands"><span class="hint">k</span>
      <input class="control tiny" data-package-index="${index}" data-package-field="skillPointBudget" type="number" min="0" value="${escapeHtml(skillPackage.skillPointBudget ?? 0)}" aria-label="Package SP"><span class="hint">SP</span>
      <input class="control tiny" data-package-index="${index}" data-package-field="maxPerPlayer" type="number" min="0" value="${escapeHtml(skillPackage.maxPerPlayer ?? "")}" aria-label="Package max skills per player">
      <span class="hint">max/player</span>
      <input class="control tiny" ${bindAttr(["skillPackages", index, "maxSkills"])} data-kind="int" type="number" min="0" value="${escapeHtml(skillPackage.maxSkills ?? "")}" placeholder="—" aria-label="Package total skills (count mode)">
      <span class="hint">skills</span>
      <input class="control tiny" ${bindAttr(["skillPackages", index, "maxSecondary"])} data-kind="int" type="number" min="0" value="${escapeHtml(skillPackage.maxSecondary ?? "")}" placeholder="—" aria-label="Package secondary skills (count mode)">
      <span class="hint">sec</span>
      ${chip("Stars", `toggle-package-stars:${index}`, skillPackage.starPlayersAllowed !== false)}
      <button type="button" class="remove" data-action="remove-package" data-index="${index}" aria-label="Remove package">✕</button>
    </div>`).join("");
  return `
    <div class="inset-list">
      <div class="hint">Spike!-style “choose one of” bundles — a team is legal if it fits any. Set skills / sec for a count-mode pack (its SP is then ignored).</div>
      ${rows || '<div class="hint">No packages defined.</div>'}
      <button type="button" class="btn" data-action="add-package" style="align-self:flex-start">+ Add Package</button>
    </div>`;
}

function renderMatrix() {
  const matrix = matrixForDisplay();
  const cells = new Set(matrix.cells.map((cell) => `${cell.row}-${cell.col}`));
  let grid = '<div></div>';
  matrix.columns.forEach((column, colIndex) => {
    grid += `<div class="matrix-head matrix-col-head">
      <button type="button" class="remove matrix-remove" data-action="remove-matrix-column" data-col="${colIndex}" aria-label="Remove column ${colIndex + 1}"${matrix.columns.length <= 1 ? " disabled" : ""}>&times;</button>
      <span><input class="control" data-action="matrix-col-gold" data-col="${colIndex}" type="number" min="0" step="1" value="${escapeHtml(goldToK(column.gold))}" aria-label="Column gold in thousands"> K</span>
    </div>`;
  });
  matrix.rows.forEach((row, rowIndex) => {
    grid += `<div class="matrix-head row-head">
      <div class="matrix-row-fields"><input class="control" data-action="matrix-row-primary" data-row="${rowIndex}" type="number" min="0" step="1" value="${escapeHtml(row.primary)}" aria-label="Row primary skills"> pri / <input class="control" data-action="matrix-row-secondary" data-row="${rowIndex}" type="number" min="0" step="1" value="${escapeHtml(row.secondary)}" aria-label="Row secondary skills"> sec</div>
      <div class="matrix-row-actions"><label><input data-action="matrix-row-swap" data-row="${rowIndex}" type="checkbox"${row.secondarySwap === true ? " checked" : ""}> Swap</label><button type="button" class="remove matrix-remove" data-action="remove-matrix-row" data-row="${rowIndex}" aria-label="Remove row ${rowIndex + 1}"${matrix.rows.length <= 1 ? " disabled" : ""}>&times;</button></div>
    </div>`;
    matrix.columns.forEach((_column, colIndex) => {
      const active = cells.has(`${rowIndex}-${colIndex}`);
      const existing = matrix.cells.find((cell) => cell.row === rowIndex && cell.col === colIndex);
      const teamCount = safeArray(existing?.teams).length;
      grid += `<button type="button" class="matrix-cell${active ? " active" : ""}" data-action="toggle-matrix-cell" data-row="${rowIndex}" data-col="${colIndex}" title="${teamCount} assigned team(s)">${active ? `✓${teamCount ? ` ${teamCount}` : ""}` : "—"}</button>`;
    });
  });
  const rowDetails = matrix.rows.map((row, rowIndex) => `
    <div class="inset-row matrix-row-detail">
      <span class="subheading">Row ${rowIndex + 1}</span>
      ${textField("Label", ["matrix", "rows", rowIndex, "label"], row.label, { placeholder: `${row.primary} pri / ${row.secondary} sec` })}
      ${overrideField("Swap ratio", ["matrix", "rows", rowIndex, "secondarySwapRatio"], row.secondarySwapRatio, { min: 1 })}
      ${overrideField("Max swaps", ["matrix", "rows", rowIndex, "secondarySwapMax"], row.secondarySwapMax, { none: true, noneLabel: "unlimited" })}
      ${overrideField("Max stacked players", ["matrix", "rows", rowIndex, "maxStackedPlayers"], row.maxStackedPlayers, { none: true })}
    </div>`).join("");
  const cellDetails = matrix.cells.map((cell, cellIndex) => {
    const row = matrix.rows[cell.row];
    const column = matrix.columns[cell.col];
    const label = `${row?.label || `${row?.primary ?? "?"} pri / ${row?.secondary ?? "?"} sec`} @ ${goldToK(column?.gold)}k`;
    return `
      <div class="inset-row matrix-cell-detail">
        <span class="grow">${escapeHtml(label)}</span>
        ${multiSelect({ key: `matrix-cell-${cell.row}-${cell.col}-teams`, path: ["matrix", "cells", cellIndex, "teams"], label: "Teams", items: rosterItems(), selected: safeArray(cell.teams) })}
        ${triField("Star players", ["matrix", "cells", cellIndex, "starPlayersAllowed"], cell.starPlayersAllowed)}
        ${multiSelect({ key: `matrix-cell-${cell.row}-${cell.col}-banned`, path: ["matrix", "cells", cellIndex, "bannedStars"], label: "Banned stars", items: starItems(), selected: cell.bannedStars, allLabel: "Inherit" })}
      </div>`;
  }).join("");
  return `
    <div class="inset-list">
      <div class="hint">Cash × skills grid — click cells to allow / deny. Each allowed cell lists the teams placed in it.</div>
      <div class="matrix-wrap" data-preserve-scroll="matrix"><div class="matrix-grid" style="grid-template-columns: 142px repeat(${matrix.columns.length}, 92px)">${grid}</div></div>
      <div class="inline-controls"><button type="button" class="btn" data-action="add-matrix-column">+ Add Column</button><button type="button" class="btn" data-action="add-matrix-row">+ Add Row</button></div>
      <div class="subheading">Rows</div>
      ${rowDetails}
      <div class="subheading">Allowed cells</div>
      ${cellDetails || '<div class="hint">No cells allowed yet.</div>'}
    </div>`;
}

function renderTournamentSystem() {
  const suppressed = state.pkg.goldCapIncludesAddedSkills === true;
  let content = "";
  if (state.view.system === "skillpoints") content = '<div class="hint">One flat skill allotment for every team — set the pool or counts on the Skills tab.</div>';
  if (state.view.system === "tiers") content = renderTiers();
  if (state.view.system === "packages") content = renderPackages();
  if (state.view.system === "matrix") content = renderMatrix();
  return `
    <section class="panel">
      ${suppressed ? '<div class="notice">Skills are part of the Gold Budget: added skills are paid in gold, so SP budgets are not needed. Tier / roster gold caps and the other limits below still apply.</div>' : ""}
      <div class="system-body">
        <div class="section-head">
          <div class="section-title">${title("Tournament System")}</div>
          ${chip("Skill Points", "system-skillpoints", state.view.system === "skillpoints")}
          ${chip("Tiers", "system-tiers", state.view.system === "tiers")}
          ${chip("Packages", "system-packages", state.view.system === "packages")}
          ${chip("Matrix", "system-matrix", state.view.system === "matrix")}
        </div>
        ${content}
      </div>
    </section>`;
}

function renderTeamRules() {
  const teamNames = state.teams.map((team) => team.name);
  const rules = state.pkg.teamRules.map((rule, index) => {
    const teamOptions = options([...new Set([rule.team, ...teamNames].filter(Boolean))], rule.team);
    return `
      <div class="team-rule">
        <div class="inset-row tier-main-row">
          <select class="control grow" ${bindAttr(["teamRules", index, "team"])} data-kind="str" data-blank="empty" aria-label="Team rule ${index + 1} team">${teamOptions}</select>
          <button type="button" class="remove" data-action="remove-team-rule" data-index="${index}" aria-label="Remove ${escapeHtml(rule.team)} rule">✕</button>
        </div>
        ${renderKnobs(["teamRules", index], rule, { key: `team-rule-${index}`, team: true })}
      </div>`;
  }).join("");
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Team Rules")}</div>
        <span class="section-note">— per-team overrides, highest precedence; blank = inherit</span>
      </div>
      ${rules || '<div class="hint">No team-specific rules.</div>'}
      <div class="inline-controls">
        <select class="control" data-control="rule-team" aria-label="Team for a new rule">${options(teamNames, state.ruleTeam)}</select>
        <button type="button" class="btn primary" data-action="add-team-rule"${teamNames.length ? "" : " disabled"}>+ Add Team Rule</button>
      </div>
    </section>`;
}

function renderOverrides() {
  const costs = state.pkg.skillAllotment.skillCostSP ?? {};
  const rows = Object.entries(costs).sort(([a], [b]) => a.localeCompare(b)).map(([skill, cost]) => `
    <div class="inset-row">
      <span class="grow" style="color:${skillColor(skill)}">${escapeHtml(skill)}</span>
      <span class="cream">${escapeHtml(cost)} SP</span>
      <button type="button" class="remove" data-action="remove-override" data-name="${escapeHtml(skill)}" aria-label="Remove ${escapeHtml(skill)} override">✕</button>
    </div>`).join("");
  const goldCosts = state.pkg.skillAllotment.skillCostGold ?? {};
  const goldRows = Object.entries(goldCosts).sort(([a], [b]) => a.localeCompare(b)).map(([skill, cost]) => `
    <div class="inset-row">
      <span class="grow" style="color:${skillColor(skill)}">${escapeHtml(skill)}</span>
      <span class="cream">${escapeHtml(goldToK(cost))}k</span>
      <button type="button" class="remove" data-action="remove-gold-override" data-name="${escapeHtml(skill)}" aria-label="Remove ${escapeHtml(skill)} gold override">✕</button>
    </div>`).join("");
  return `
    <div class="form-grid">
      <div class="inset-list">
        <div class="subheading">Per-Skill SP Overrides</div>
        ${rows}
        <div class="inline-controls">
          <select class="control" data-control="override-skill" aria-label="Skill for an SP override">${options(state.skills, state.overrideSkill, (skill) => skill.name, (skill) => skill.name)}</select>
          <input class="control tiny" data-control="override-cost" type="number" min="0" value="${escapeHtml(state.overrideCost)}" aria-label="SP override cost">
          <span class="hint">SP</span>
          <button type="button" class="btn primary" data-action="add-override">Add</button>
        </div>
      </div>
      <div class="inset-list">
        <div class="subheading">Per-Skill Gold Overrides</div>
        ${goldRows}
        <div class="inline-controls">
          <select class="control" data-control="gold-override-skill" aria-label="Skill for a gold override">${options(state.skills, state.goldOverrideSkill, (skill) => skill.name, (skill) => skill.name)}</select>
          <input class="control compact" data-control="gold-override-cost" type="number" min="0" value="${escapeHtml(state.goldOverrideCost)}" aria-label="Gold override cost in thousands">
          <span class="hint">k</span>
          <button type="button" class="btn primary" data-action="add-gold-override">Add</button>
        </div>
      </div>
    </div>`;
}

function renderSkills() {
  const allotment = state.pkg.skillAllotment;
  const sa = (key) => ["skillAllotment", key];
  const count = state.view.skillMode === "count";
  const pricing = count
    ? `<div class="knob-grid">
        ${overrideField("Max primary", sa("maxPrimary"), allotment.maxPrimary, { kind: "int", none: true, flat: true })}
        ${overrideField("Max secondary", sa("maxSecondary"), allotment.maxSecondary, { kind: "int", none: true, flat: true })}
        ${overrideField("Swap ratio (primary per secondary)", sa("secondarySwapRatio"), allotment.secondarySwapRatio, { min: 1, flat: true, placeholder: "2" })}
        ${overrideField("Max swaps", sa("secondarySwapMax"), allotment.secondarySwapMax, { none: true, noneLabel: "unlimited", flat: true, placeholder: "unlimited" })}
      </div>
      <div class="inline-controls">${chip(`Secondary Swap — 1 secondary costs ${allotment.secondarySwapRatio ?? 2} primary`, "toggle-secondary-swap", allotment.secondarySwap === true)}</div>`
    : `<div class="knob-grid">
        ${numField("SP budget / team", sa("skillPointBudget"), allotment.skillPointBudget, { blank: "zero" })}
        ${numField("Primary cost (SP)", sa("primaryCostSP"), allotment.primaryCostSP, { blank: "null", step: "0.5" })}
        ${numField("Secondary ×mult", sa("secondaryMultiplier"), allotment.secondaryMultiplier, { blank: "null", step: "0.5" })}
        ${numField("Secondary cost (SP, overrides ×mult)", sa("secondaryCostSP"), allotment.secondaryCostSP, { blank: "null", step: "0.5", placeholder: "×mult" })}
        ${numField("Elite surcharge (SP)", sa("eliteSurchargeSP"), allotment.eliteSurchargeSP, { blank: "null", step: "0.5" })}
        ${numField("Stack surcharge (SP per extra skill)", sa("stackSurchargeSP"), allotment.stackSurchargeSP, { blank: "zero", step: "0.5" })}
      </div>`;
  const eliteItems = skillItems();
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Skill Allotment")}</div>
        <span class="field-label">Pricing</span>${chip("SP Pool", "mode-pool", !count)}${chip("Count Mode", "mode-count", count)}
      </div>
      <div class="hint">The flat allotment: tiers, matrix rows and team rules override it.</div>
      ${pricing}
      <div class="subheading">Gold cost of an added skill</div>
      <div class="knob-grid">
        ${numField("Primary", sa("primaryCostGold"), allotment.primaryCostGold, { kind: "gold", placeholder: String(goldToK(DEFAULT_GOLD_COSTS.primaryCostGold)) })}
        ${numField("Secondary", sa("secondaryCostGold"), allotment.secondaryCostGold, { kind: "gold", placeholder: String(goldToK(DEFAULT_GOLD_COSTS.secondaryCostGold)) })}
        ${numField("Elite surcharge", sa("eliteSurchargeGold"), allotment.eliteSurchargeGold, { kind: "gold", placeholder: String(goldToK(DEFAULT_GOLD_COSTS.eliteSurchargeGold)) })}
      </div>
      <div class="subheading">Caps</div>
      <div class="knob-grid">
        ${overrideField("Max skills / player", sa("maxPerPlayer"), allotment.maxPerPlayer, { kind: "int", none: true, flat: true })}
        ${overrideField("Max copies of one skill / team", sa("maxSameSkillTeamwide"), allotment.maxSameSkillTeamwide, { kind: "int", none: true, flat: true })}
        ${overrideField("Max stacked players", sa("maxStackedPlayers"), allotment.maxStackedPlayers, { kind: "int", none: true, flat: true })}
        ${overrideField("Elite skills cap", sa("eliteMaxTotal"), allotment.eliteMaxTotal, { kind: "int", none: true, flat: true })}
        ${overrideField("Same elite skill cap", sa("eliteMaxSameSkill"), allotment.eliteMaxSameSkill, { kind: "int", none: true, flat: true })}
        ${overrideField("Stacked player: max skills", ["skillAllotment", "stackedPlayer", "maxSkills"], allotment.stackedPlayer?.maxSkills, { kind: "int", none: true, flat: true })}
        ${overrideField("Stacked player: max secondary", ["skillAllotment", "stackedPlayer", "maxSecondary"], allotment.stackedPlayer?.maxSecondary, { kind: "int", none: true, flat: true })}
        ${overrideField("Stacked player: max elite", ["skillAllotment", "stackedPlayer", "maxElite"], allotment.stackedPlayer?.maxElite, { kind: "int", none: true, flat: true })}
      </div>
      <div class="knob-grid">
        ${multiSelect({ key: "elite-skills", path: ["skillAllotment", "eliteSkills"], label: "Elite skills", items: eliteItems, selected: safeArray(allotment.eliteSkills) })}
      </div>
      ${renderOverrides()}
    </section>
    <section class="panel">
      <div class="section-title">${title("Stat Increases")}</div>
      ${renderStatIncreases(["statIncreases"], state.pkg.statIncreases, { key: "flat-stats", inherit: false })}
    </section>
    ${renderBannedSkills()}`;
}

function renderBannedSkills() {
  const banned = safeArray(state.pkg.special.bannedSkills).map((name) => `<button type="button" class="chip active" style="color:${skillColor(name)}" data-action="remove-banned-skill" data-name="${escapeHtml(name)}">${escapeHtml(name)} ✕</button>`).join("");
  return `
    <section class="panel">
      <div class="section-title">${title("Banned Skills")}</div>
      <div class="chip-list">${banned || '<span class="hint">None.</span>'}</div>
      <div class="inline-controls">
        <select class="control" data-control="banned-skill" aria-label="Skill to ban">${options(state.skills, state.bannedSkill, (skill) => skill.name, (skill) => skill.name)}</select>
        <button type="button" class="btn primary" data-action="add-banned-skill">Ban</button>
      </div>
    </section>`;
}

function renderStarPacks() {
  const packs = safeArray(state.pkg.starPacks);
  const rows = packs.map((pack, index) => {
    const base = ["starPacks", index];
    return `
      <div class="star-pack">
        <div class="knob-grid">
          ${textField("Id", [...base, "id"], pack.id, { blank: "empty" })}
          ${textField("Label", [...base, "label"], pack.label)}
          ${numField("Fee", [...base, "fee"], pack.fee, { kind: "gold", blank: "zero" })}
          <label class="field"><span class="field-label">Fee mode</span><select class="control" ${bindAttr([...base, "feeMode"])} data-kind="str" aria-label="Pack ${index + 1} fee mode">
            <option value=""${pack.feeMode == null ? " selected" : ""}>each (default)</option>
            <option value="each"${pack.feeMode === "each" ? " selected" : ""}>each pick</option>
            <option value="once"${pack.feeMode === "once" ? " selected" : ""}>once per team</option>
          </select></label>
          ${numField("Max picks", [...base, "max"], pack.max, { kind: "int", blank: "null", placeholder: "no cap" })}
          ${multiSelect({ key: `star-pack-${index}-stars`, path: [...base, "stars"], label: "Stars", items: starItems(), selected: safeArray(pack.stars) })}
          <button type="button" class="remove" data-action="remove-star-pack" data-index="${index}" aria-label="Remove star pack ${escapeHtml(pack.label ?? pack.id)}">✕</button>
        </div>
      </div>`;
  }).join("");
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Star Packs")}</div>
        <span class="section-note">— when set, every hired star must come from a pack open to the team</span>
      </div>
      ${rows || '<div class="hint">No star packs.</div>'}
      <div class="inline-controls">
        <button type="button" class="btn" data-action="add-star-pack">+ Add Star Pack</button>
        ${packs.length ? multiSelect({ key: "flat-star-packs", path: ["starPacksAllowed"], label: "Packs open to every team", items: starPackItems(), selected: state.pkg.starPacksAllowed, allLabel: "Every pack" }) : ""}
      </div>
    </section>`;
}

function renderStars() {
  const banned = new Set(state.pkg.bannedStars);
  const starNames = state.stars.map((star) => star.name);
  const missingBans = state.pkg.bannedStars.filter((name) => !starNames.includes(name));
  const allNames = [...starNames, ...missingBans];
  const starRows = groupedStars(allNames);
  const allowedRows = starRows.filter((row) => row.names.every((name) => !banned.has(name)));
  const bannedRows = starRows.filter((row) => row.names.some((name) => banned.has(name)));
  const allowedChips = allowedRows.map((row) => `<button type="button" draggable="true" class="star-chip" data-action="move-star-banned" data-star="${escapeHtml(row.names[0])}">${escapeHtml(row.label)}</button>`).join("");
  const bannedChips = bannedRows.map((row) => `<button type="button" draggable="true" class="star-chip" data-action="move-star-allowed" data-star="${escapeHtml(row.names[0])}">${escapeHtml(row.label)}</button>`).join("");
  const allMegaBanned = MEGA_STARS.every((name) => banned.has(name));
  const tierCount = state.pkg.tiers.length;
  const spGrid = tierCount && allowedRows.length ? `
    <div class="star-sp-section">
      <div class="section-head">
        <div class="subheading grow">Star SP Cost by Tier</div>
        <label class="star-sp-paid"><input type="checkbox" data-action="stars-paid-sp"${state.pkg.starPlayers.paidInSkillPoints === true ? " checked" : ""}> Stars paid in SP, not gold</label>
      </div>
      <div class="star-sp-grid-wrap" data-preserve-scroll="star-sp-grid">
        <table class="star-sp-grid">
          <thead><tr><th>Star Player</th>${state.pkg.tiers.map((tier, index) => `<th title="${escapeHtml(tier.label ?? `Tier ${index + 1}`)}">Tier ${index + 1}</th>`).join("")}</tr></thead>
          <tbody>${allowedRows.map((row) => {
            const name = row.names[0];
            const costs = starTierCostsForDisplay(name);
            return `<tr><th>${escapeHtml(row.label)}</th>${costs.map((cost, tierIndex) => `<td><input class="control star-sp-input" data-action="star-tier-sp-cost" data-star="${escapeHtml(name)}" data-tier="${tierIndex}" type="number" min="0" value="${escapeHtml(cost ?? "")}" placeholder="✕" aria-label="${escapeHtml(row.label)} Tier ${tierIndex + 1} SP cost"></td>`).join("")}</tr>`;
          }).join("")}</tbody>
        </table>
      </div>
      <div class="hint">Blank means the Star Player is not available in that tier.</div>
    </div>` : "";
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Star Players")}</div>
        ${chip("Stars Allowed", "toggle-stars", state.pkg.starPlayers.allowed)}
        ${overrideField("Max count", ["starPlayers", "maxCount"], state.pkg.starPlayers.maxCount, { kind: "int", none: true, flat: true })}
        ${overrideField("Max combined cost", ["starPlayers", "maxCombinedCost"], state.pkg.starPlayers.maxCombinedCost, { kind: "gold", none: true, noneLabel: "no cap", flat: true })}
      </div>
      <div class="star-columns">
        <div class="star-column allowed" data-drop-zone="allowed">
          <div class="star-column-title">Allowed Stars (${allowedRows.reduce((total, row) => total + row.names.length, 0)})</div>
          <div class="chip-list grow">${allowedChips || '<span class="hint">None</span>'}</div>
        </div>
        <div class="star-column banned" data-drop-zone="banned">
          <div class="star-column-title">Banned Stars (${bannedRows.reduce((total, row) => total + row.names.length, 0)})</div>
          <div class="chip-list grow">${bannedChips || '<span class="hint">None</span>'}</div>
        </div>
      </div>
      <div class="inline-controls">
        <span class="hint grow">Drag a star between columns (clicking a chip also moves it across).</span>
        <button type="button" class="btn primary" data-action="toggle-mega-stars">⚑ ${allMegaBanned ? "Unban" : "Ban"} Mega-Stars</button>
      </div>
      ${spGrid}
    </section>
    ${renderStarPacks()}`;
}

function humanizeId(id) {
  return String(id).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderInducements() {
  const known = new Set(INDUCEMENTS.map((item) => item.id));
  const extraIds = [...new Set([
    ...inducementAllowedList(),
    ...Object.keys(state.pkg.inducements.caps ?? {}),
    ...Object.keys(state.pkg.inducements.rosterOnly ?? {}),
  ])].filter((id) => id !== "*" && !known.has(id));
  const items = [...INDUCEMENTS, ...extraIds.map((id) => ({ id, label: humanizeId(id), max: state.pkg.inducements.caps?.[id] ?? 1, fixed: false }))];
  const rows = items.map((item) => {
    const allowed = isInducementAllowed(item.id);
    const max = state.pkg.inducements.caps?.[item.id] ?? item.max;
    const rosterOnly = state.pkg.inducements.rosterOnly?.[item.id];
    return `
      <div class="inducement-row">
        <button type="button" class="check-box${allowed ? " active" : ""}" data-action="toggle-inducement" data-id="${escapeHtml(item.id)}" aria-pressed="${allowed ? "true" : "false"}" aria-label="Toggle ${escapeHtml(item.label)}">✓</button>
        <span class="grow${allowed ? "" : " disabled-label"}">${escapeHtml(item.label)}</span>
        <button type="button" class="btn step" data-action="step-inducement" data-id="${escapeHtml(item.id)}" data-delta="-1" aria-label="Lower ${escapeHtml(item.label)} cap">−</button>
        <span class="inducement-cap" title="${state.pkg.inducements.caps?.[item.id] != null ? "package cap" : "dataset maximum"}">0-${escapeHtml(max)}</span>
        <button type="button" class="btn primary step" data-action="step-inducement" data-id="${escapeHtml(item.id)}" data-delta="1" aria-label="Raise ${escapeHtml(item.label)} cap">+</button>
        ${multiSelect({ key: `roster-only-${item.id}`, path: ["inducements", "rosterOnly", item.id], label: "Rosters", items: rosterItems(), selected: rosterOnly, allLabel: "Any roster" })}
      </div>`;
  }).join("");
  return `
    <section class="panel">
      <div class="section-title">${title("Inducements")} <span class="section-note">— allowed, per-inducement caps, roster restrictions</span></div>
      <div class="inducement-grid">${rows}</div>
    </section>`;
}

function renderSpecialRules() {
  const special = state.pkg.special;
  const sideline = state.pkg.sideline;
  const toggles = [
    ["Insignificant-trait constraint", "toggle-insignificant", special.insignificantTraitConstraint],
    ["Stalling allowed", "toggle-stalling", special.stalling],
    ["Slann allowed", "toggle-slann", special.slannAllowed],
    ["Stat increases allowed", "toggle-stat-increases", special.statIncreasesAllowed],
    ["Stars are the 11th player", "toggle-stars-eleventh", Number(special.minPlayers) <= 10],
  ];
  return `
    <section class="panel">
      <div class="section-title">${title("Special Rules")}</div>
      <div class="chip-list">${toggles.map(([label, action, active]) => chip(label, action, active)).join("")}</div>
      <div class="knob-grid">${numField("Minimum players", ["special", "minPlayers"], special.minPlayers, { kind: "int", placeholder: "11 (default)" })}</div>
    </section>
    <section class="panel">
      <div class="section-title">${title("Sideline Staff")}</div>
      <div class="knob-grid">
        ${overrideField("Max team rerolls", ["sideline", "maxReRolls"], sideline.maxReRolls, { kind: "int", none: true, noneLabel: "no cap", flat: true })}
        ${overrideField("Max apothecary", ["sideline", "maxApothecary"], sideline.maxApothecary, { kind: "int", none: true, noneLabel: "no cap", flat: true })}
        ${overrideField("Max cheerleaders", ["sideline", "maxCheerleaders"], sideline.maxCheerleaders, { kind: "int", none: true, noneLabel: "no cap", flat: true })}
        ${overrideField("Max assistant coaches", ["sideline", "maxAssistantCoaches"], sideline.maxAssistantCoaches, { kind: "int", none: true, noneLabel: "no cap", flat: true })}
        ${overrideField("Max dedicated fans", ["sideline", "maxDedicatedFans"], sideline.maxDedicatedFans, { kind: "int", none: true, noneLabel: "no cap", flat: true })}
      </div>
    </section>`;
}

function skillSummary() {
  if (state.pkg.goldCapIncludesAddedSkills) return "in gold budget";
  if (state.view.system === "tiers") return `${state.pkg.tiers.length} tiers`;
  if (state.view.system === "packages") return `${state.pkg.skillPackages.length} packages`;
  if (state.view.system === "matrix") return "matrix";
  const allotment = state.pkg.skillAllotment;
  if (state.view.skillMode === "count") return `${allotment.maxPrimary ?? 0} pri / ${allotment.maxSecondary ?? 0} sec${allotment.secondarySwap ? " (swap)" : ""}`;
  return `${allotment.skillPointBudget ?? 0} SP pool`;
}

function goldLabel(value) {
  return value == null ? "—" : `${goldToK(value)}k`;
}

/** Ask the server to resolve the package AS IT WILL BE SAVED with the same derivations the
 *  Tournament Builder (coach page) reads (POST /api/packages/preview → packagePreview). Keyed by
 *  the serialised document, so re-renders never re-request an unchanged package. */
function requestPreview() {
  const key = JSON.stringify(serializePackage());
  if (key === state.preview.key) return;
  state.preview = { key, data: null, overview: null, problems: [], error: "", loading: true };
  if (typeof fetch !== "function") return;
  // Organiser-only route (it resolves an unsaved package): send the organiser token when we have one.
  const headers = { "Content-Type": "application/json", "X-CW-Auth": "1" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  requestJson("/api/packages/preview", { method: "POST", headers, body: key }).then((result) => {
    if (state.preview.key !== key) return;
    state.preview = { key, data: result?.preview ?? null, overview: result?.overview ?? null, problems: safeArray(result?.problems).map(String), error: "", loading: false };
    render();
  }).catch((error) => {
    if (state.preview.key !== key) return;
    const message = error.status === 401 || error.status === 403 ? "Log in as the organiser to see the preview." : serverMessage(error);
    state.preview = { key, data: null, overview: null, problems: safeArray(error.data?.problems).map(String), error: message, loading: false };
    render();
  });
}

function packsLabel(packs) {
  return safeArray(packs).map((pack) => pack.maxSkills != null || pack.maxSecondary != null
    ? `${goldLabel(pack.gold)} / ${pack.maxSkills ?? 0} skills${pack.maxSecondary ? ` (up to ${pack.maxSecondary} secondary)` : ""}${pack.starPlayersAllowed === false ? ", no stars" : ""}`
    : `${goldLabel(pack.gold)} / ${pack.skillPointBudget ?? 0} SP`).join(" · ");
}

/** Count mode reads "N primary + S secondary" (an unset side is "any"); otherwise the SP budget. */
function countsLabel(maxPrimary, maxSecondary, skillPointBudget) {
  if (maxPrimary != null || maxSecondary != null) return `${maxPrimary ?? "any"} primary + ${maxSecondary ?? "any"} secondary`;
  return `${skillPointBudget ?? 0} SP`;
}

const OVERVIEW_CELLS = [["secondary", "Secondary"], ["elite", "Elite"], ["stacks", "Stacks"], ["stackLimit", "Stack limit"], ["characteristics", "Characteristics"], ["stars", "Stars"]];

/**
 * The coach page's ruleset overview (server packageOverview, the same object GET /api/packages/<name>
 * hands the Tournament Builder): highlight lines plus the per-team tier table. Rendered plainly here —
 * one row per team, columns that are empty for every team dropped.
 */
function renderOverview(overview) {
  if (!overview || !Array.isArray(overview.groups) || !overview.groups.length) return "";
  const lines = safeArray(overview.summary).map((line) => {
    const more = safeArray(line.details?.items).length
      ? ` <details class="multi-inline"><summary>${escapeHtml(line.details.summary)}</summary><ul>${line.details.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`
      : "";
    return `<div class="overview-row" data-summary="${escapeHtml(line.key)}"><dt>${escapeHtml(line.label)}</dt><dd>${escapeHtml(line.text)}${more}</dd></div>`;
  }).join("");
  const teams = overview.groups.flatMap((group) => safeArray(group.teams));
  const showGold = teams.some((team) => team.gold != null);
  const cols = OVERVIEW_CELLS.filter(([key]) => teams.some((team) => team[key] != null && team[key] !== ""));
  const cell = (value) => value == null || value === "" ? "—" : String(value).split(" · ").map((part) => escapeHtml(part)).join("<br>");
  const body = overview.groups.map((group) => safeArray(group.teams).map((team, index) => `<tr>
      ${index === 0 ? `<th scope="rowgroup" rowspan="${group.teams.length}">${escapeHtml(group.tier ?? group.label ?? "All teams")}</th>` : ""}
      <th scope="row">${escapeHtml(team.name)}</th>
      ${showGold ? `<td>${team.gold == null ? "—" : `${escapeHtml(goldLabel(team.gold))}${team.goldMax != null ? `–${escapeHtml(goldLabel(team.goldMax))}` : ""}`}</td>` : ""}
      <td>${safeArray(team.allotment).map((line) => escapeHtml(line)).join("<br>") || "—"}</td>
      ${cols.map(([key]) => `<td>${cell(team[key])}</td>`).join("")}
    </tr>`).join("")).join("");
  return `<div class="subheading">What coaches will see (Tournament Builder)</div>
    ${lines ? `<dl class="overview-summary">${lines}</dl>` : ""}
    <div class="preview-wrap"><table class="preview-table overview-table">
      <thead><tr><th>Tier</th><th>Team</th>${showGold ? "<th>Gold cap</th>" : ""}<th>Skill allotment</th>${cols.map(([, head]) => `<th>${head}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

/** The Tournament Builder's ruleset table, rendered from the server's resolution of this package. */
function renderTierPreview() {
  requestPreview();
  const preview = state.preview;
  if (preview.loading) return '<div class="loading-banner">Resolving the package the way the Tournament Builder will…</div>';
  if (preview.error) return `<div class="validation"><div class="validation-title">Preview unavailable</div><div>${escapeHtml(preview.error)}</div>${preview.problems.filter((problem) => problem !== preview.error).map((problem) => `<div>• ${escapeHtml(problem)}</div>`).join("")}</div>`;
  const data = preview.data;
  if (!data) return '<div class="loading-banner">No preview yet.</div>';
  let main = "";
  if (data.system === "tiers") {
    const rows = data.tiers.map((tier, index) => {
      const summary = data.tierSummary?.[index];
      const rosters = tier.rosters.map((roster) => `${roster.name} ${goldLabel(roster.gold)}`).join(", ");
      const limits = data.tierLimits?.[index] ?? {};
      const skills = summary?.packs?.length ? packsLabel(summary.packs) : countsLabel(limits.maxPrimary, limits.maxSecondary, limits.skillPointBudget ?? summary?.skillPointBudget);
      return `<tr><th>${escapeHtml(tier.label)}</th><td>${escapeHtml(rosters || "—")}</td><td>${escapeHtml(skills)}</td>
        <td>${escapeHtml(tier.secondaryText)}</td><td>${escapeHtml(tier.eliteText)}</td><td>${escapeHtml(tier.stacksText)}</td>
        <td>${escapeHtml(tier.stackTypeText)}</td><td>${escapeHtml(tier.characteristicsText)}</td>
        <td>${escapeHtml(tier.maxStars === 0 ? "no" : tier.starPacks.length ? tier.starPacksText : `max ${tier.maxStars ?? "any"}`)}</td></tr>`;
    }).join("");
    main = `<div class="preview-wrap"><table class="preview-table">
      <thead><tr><th>Tier</th><th>Rosters · gold</th><th>Skills</th><th>Secondary</th><th>Elite</th><th>Stacks</th><th>Stack type</th><th>Characteristics</th><th>Stars</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  } else if (data.system === "flat" && data.flat) {
    const flat = data.flat;
    main = `<div class="preview-wrap"><table class="preview-table">
      <thead><tr><th>Teams</th><th>Gold</th><th>Skills</th><th>Secondary</th><th>Stars</th></tr></thead>
      <tbody><tr><th>${escapeHtml(isAllRaces() ? "Every eligible race" : safeArray(state.pkg.eligibleRosters).join(", "))}</th>
        <td>${escapeHtml(goldLabel(flat.gold))}</td><td>${escapeHtml(flat.packs.length ? packsLabel(flat.packs) : countsLabel(flat.limits?.maxPrimary, flat.limits?.maxSecondary, flat.skillPointBudget))}</td>
        <td>${escapeHtml(flat.rules.maxSecondary ?? "unlimited")}</td><td>${flat.stars.allowed ? `max ${escapeHtml(flat.stars.maxCount ?? "any")}` : "no"}</td></tr></tbody></table></div>`;
  } else {
    main = '<div class="hint">Matrix package: each team gets its gold and skills from its cell (below).</div>';
  }
  const exceptions = data.exceptions.length ? `
    <div class="subheading">Per-team rules (matrix cells and team rules)</div>
    <div class="preview-wrap"><table class="preview-table">
      <thead><tr><th>Team</th><th>From</th><th>Gold</th><th>Skills</th><th>Stars</th></tr></thead>
      <tbody>${data.exceptions.map((row) => `<tr><th>${escapeHtml(row.roster)}</th><td>${escapeHtml(row.label)}</td><td>${escapeHtml(goldLabel(row.gold))}</td>
        <td>${escapeHtml(row.packs.length ? packsLabel(row.packs) : countsLabel(row.maxPrimary, row.maxSecondary, row.skillPointBudget))}</td>
        <td>${row.starsAllowed ? "yes" : "no"}</td></tr>`).join("")}</tbody></table></div>` : "";
  const problems = preview.problems.length ? `<div class="notice">${preview.problems.map((problem) => escapeHtml(problem)).join("<br>")}</div>` : "";
  const overview = renderOverview(preview.overview);
  if (!overview) return problems + main + exceptions;
  return `${problems}${overview}
    <details class="tier-overrides" data-preserve-open="preview-details"><summary>Resolution details (tier rows and per-team exceptions)</summary><div class="inset-list">${main}${exceptions}</div></details>`;
}

function summaryRows() {
  const allRaces = isAllRaces();
  const gold = state.pkg.goldBudget == null ? "none" : `${goldToK(state.pkg.goldBudget)}k${state.pkg.goldCapIncludesAddedSkills ? " (incl. skills)" : ""}`;
  const stars = state.pkg.starPlayers.allowed
    ? `max ${state.pkg.starPlayers.maxCount ?? "none"}${state.pkg.bannedStars.length ? ` · ${state.pkg.bannedStars.length} banned` : ""}`
    : "not allowed";
  return `
    <div class="summary-row"><span>Races</span><span>${allRaces ? `all (${state.teams.length})` : safeArray(state.pkg.eligibleRosters).length}</span></div>
    <div class="summary-row"><span>Gold cap</span><span>${escapeHtml(gold)}</span></div>
    <div class="summary-row"><span>Skill model</span><span>${escapeHtml(skillSummary())}</span></div>
    <div class="summary-row"><span>Team rules</span><span>${state.pkg.teamRules.length || "none"}</span></div>
    <div class="summary-row"><span>Stars</span><span>${escapeHtml(stars)}</span></div>
    <div class="summary-row"><span>Star packs</span><span>${safeArray(state.pkg.starPacks).length || "none"}</span></div>
    <div class="summary-row"><span>Banned skills</span><span>${safeArray(state.pkg.special.bannedSkills).length || "none"}</span></div>`;
}

function renderSummaryTab() {
  return `
    <section class="panel">
      <div class="section-title">${title("Ruleset Table Preview")}</div>
      <div class="hint">Resolved by the server exactly as the Tournament Builder (coach page) will read this package once saved.</div>
      ${renderTierPreview()}
    </section>
    <section class="panel">
      <div class="section-title">${title("Package Summary")}</div>
      <div class="summary-card">${summaryRows()}</div>
    </section>
    <section class="panel">
      <div class="section-title">${title("Package JSON")}</div>
      <pre class="json-preview">${escapeHtml(JSON.stringify(serializePackage(), null, 2))}</pre>
    </section>`;
}

function renderRightRail() {
  if (!rightRail) return;
  if (!state.pkg) {
    rightRail.innerHTML = '<div class="loading-banner">Loading the tournament package editor…</div>';
    return;
  }
  const problems = state.problems.map((problem) => `<div>• ${escapeHtml(problem)}</div>`).join("");
  const validation = state.problems.length
    ? `<div class="validation"><div class="validation-title">Validation — ${state.problems.length} Problem(s)</div>${problems}</div>`
    : '<div class="loading-banner"><div class="validation-title">Validation — 0 Problems</div><div>No server problems are currently loaded.</div></div>';
  const saved = state.saved
    ? `<div class="saved-banner">✓ Saved ${escapeHtml(state.saved.file)} — ${state.saved.count} problem(s). Coaches’ teams will validate against this package.</div>`
    : "";
  const exported = state.exported
    ? '<div class="export-banner">Printable rules sheet generated (POST /api/export → HTML).</div>'
    : "";
  const notices = state.catalogNotices.length
    ? `<div class="loading-banner">${state.catalogNotices.map((notice) => `<div>${escapeHtml(notice)}</div>`).join("")}</div>`
    : "";
  rightRail.innerHTML = `
    ${state.readOnly ? `<div class="notice">${escapeHtml(state.readOnly)}</div>` : ""}
    ${state.conflict ? `<div class="validation"><div class="validation-title">Changed on the server</div><div>${escapeHtml(state.conflict)}</div><button type="button" class="session-button secondary rail-button" data-action="reload-package">Reload from the server</button></div>` : ""}
    <button type="button" class="create-button" data-action="save"${(state.authed || state.token) && !state.busy && !state.readOnly ? "" : " disabled"}>${state.busy ? "Working…" : "Save Package"}</button>
    <button type="button" class="session-button secondary rail-button" data-action="export"${state.busy ? " disabled" : ""}>Export Printable Rules Sheet</button>
    ${validation}${saved}${exported}${notices}
    <div class="summary-card">
      <div class="rail-title">${title("Package Summary")}</div>
      ${summaryRows()}
    </div>
    <div class="skill-key">
      <span class="skill-key-label">${title("Skill Key")}</span><span class="cat-general">General</span><span class="cat-agility">Agility</span><span class="cat-strength">Strength</span><span class="cat-devious">Devious</span><span class="cat-mutations">Mutations</span><span class="cat-traits">Traits</span>
    </div>
    <div class="boundary-note">Reads are open; saving needs the organizer token. The server is the source of truth — the problems panel renders its verdict verbatim.</div>`;
}

function renderTab(tab) {
  if (tab === "package") return renderPackageDetails() + renderGold();
  if (tab === "races") return renderRaces() + renderTournamentSystem() + renderTeamRules();
  if (tab === "skills") return renderSkills();
  if (tab === "stars") return renderStars();
  if (tab === "inducements") return renderInducements();
  if (tab === "special") return renderSpecialRules();
  return renderSummaryTab();
}

function editorHtml() {
  if (!state.pkg) return '<div class="loading-banner">Loading catalogs and a tournament package…</div>';
  const active = TABS.some(([id]) => id === state.tab) ? state.tab : "package";
  const tabs = TABS.map(([id, label], index) => `<button type="button" role="tab" id="rules-tab-${id}" class="${id === active ? "active" : ""}" data-action="tab:${id}" aria-selected="${id === active ? "true" : "false"}" aria-controls="rules-tab-panel"><b>${index + 1}</b><span>${escapeHtml(label)}</span></button>`).join("");
  return `
    <nav class="rules-tabs" role="tablist" aria-label="Package editor sections">${tabs}</nav>
    <div class="rules-tab-panel" id="rules-tab-panel" role="tabpanel" aria-labelledby="rules-tab-${active}" data-tab="${active}">${renderTab(active)}</div>`;
}

function renderEditor() {
  if (!editor) return;
  editor.innerHTML = editorHtml();
}

function syncAdminNav() {
  if (typeof document === "undefined") return;
  document.querySelectorAll("[data-admin-only]").forEach((element) => { element.hidden = !state.adminNav; });
}

function render() {
  if (typeof document === "undefined") return;
  const scroll = [...document.querySelectorAll("[data-preserve-scroll]")].map((element) => [element.dataset.preserveScroll, element.scrollTop, element.scrollLeft]);
  const open = new Set([...document.querySelectorAll("[data-preserve-open]")].filter((element) => element.open).map((element) => element.dataset.preserveOpen));
  const active = document.activeElement?.matches?.('[data-action="star-tier-sp-cost"]')
    ? [document.activeElement.dataset.star, document.activeElement.dataset.tier]
    : null;
  renderToolbar();
  renderShelf();
  renderEditor();
  scroll.forEach(([key, top, left]) => {
    const element = [...document.querySelectorAll("[data-preserve-scroll]")].find((candidate) => candidate.dataset.preserveScroll === key);
    if (element) { element.scrollTop = top; element.scrollLeft = left; }
  });
  [...document.querySelectorAll("[data-preserve-open]")].forEach((element) => {
    if (open.has(element.dataset.preserveOpen)) element.open = true;
  });
  if (active && editor) [...editor.querySelectorAll('[data-action="star-tier-sp-cost"]')].find((input) => input.dataset.star === active[0] && input.dataset.tier === active[1])?.focus();
  renderRightRail();
  syncAdminNav();
  if (connectionState) {
    connectionState.textContent = state.connected ? "● connected" : "● connection issue";
    connectionState.className = state.connected ? "connected" : "disconnected";
  }
  document.body?.classList?.toggle("busy", state.busy);
}

// ---------- editing actions ----------

function setSystem(system) {
  // Re-clicking the active system is not a switch: it must not mark the view touched (a touched
  // system drops the other systems' data on save).
  if (system === state.view.system) return;
  state.view.system = system;
  state.view.systemTouched = true;
  if (system === "tiers" && !Array.isArray(state.pkg.tiers)) state.pkg.tiers = [];
  if (system === "packages" && !Array.isArray(state.pkg.skillPackages)) state.pkg.skillPackages = [];
  if (system === "matrix") state.pkg.matrix = matrixForDisplay();
  markDirty();
  render();
}

function toggleRace(name) {
  const allNames = state.teams.map((team) => team.name);
  const current = isAllRaces() ? allNames : [...safeArray(state.pkg.eligibleRosters)];
  state.pkg.eligibleRosters = current.includes(name) ? current.filter((race) => race !== name) : [...current, name];
}

function moveStar(name, destination) {
  const banned = new Set(state.pkg.bannedStars);
  pairedStarNames(name).forEach((starName) => {
    if (destination === "banned") banned.add(starName);
    else banned.delete(starName);
  });
  state.pkg.bannedStars = [...banned];
  markDirty();
  render();
}

function assignTeamToTier(name, tierIndex) {
  const tier = state.pkg.tiers[tierIndex];
  if (!name || !tier) return;
  state.pkg.tiers.forEach((item) => {
    item.rosters = safeArray(item.rosters).filter((roster) => roster !== name);
  });
  tier.rosters.push(name);
  state.activeTier = tierIndex;
  markDirty();
  render();
}

function removeTeamFromTier(name, tierIndex) {
  const tier = state.pkg.tiers[tierIndex];
  if (!name || !tier) return;
  tier.rosters = safeArray(tier.rosters);
  if (!tier.rosters.includes(name)) return;
  tier.rosters = tier.rosters.filter((roster) => roster !== name);
  state.activeTier = tierIndex;
  markDirty();
  render();
}

function handleEditorAction(action, target) {
  if (!state.pkg) return;
  state.preEdit = clone(state.pkg);

  if (action.startsWith("tab:")) {
    state.tab = action.slice(4);
    render();
    return;
  }
  if (action.startsWith("toggle-tier-stars:")) {
    const index = Number(action.split(":")[1]);
    const tier = state.pkg.tiers[index];
    if (tier) tier.starPlayersAllowed = tier.starPlayersAllowed === false;
    markDirty(); render(); return;
  }
  if (action.startsWith("toggle-package-stars:")) {
    const index = Number(action.split(":")[1]);
    const item = state.pkg.skillPackages[index];
    if (item) item.starPlayersAllowed = item.starPlayersAllowed === false;
    markDirty(); render(); return;
  }

  switch (action) {
    case "toggle-all-races":
      if (state.teams.length === 0 && isAllRaces()) return;
      state.pkg.eligibleRosters = isAllRaces() ? state.teams.map((team) => team.name) : ["*"];
      break;
    case "toggle-race":
      toggleRace(target.dataset.name);
      break;
    case "cap-creation":
      state.pkg.goldCapIncludesAddedSkills = false;
      break;
    case "cap-includes":
      state.pkg.goldCapIncludesAddedSkills = true;
      break;
    case "system-skillpoints": setSystem("skillpoints"); return;
    case "system-tiers": setSystem("tiers"); return;
    case "system-packages": setSystem("packages"); return;
    case "system-matrix": setSystem("matrix"); return;
    case "mode-pool":
      if (state.view.skillMode === "pool") return;
      state.view.skillMode = "pool";
      state.view.skillModeTouched = true;
      break;
    case "mode-count":
      if (state.view.skillMode === "count") return;
      state.view.skillMode = "count";
      state.view.skillModeTouched = true;
      // Only fill keys that are absent: an explicit null (no limit) stays null.
      if (state.pkg.skillAllotment.maxPrimary === undefined) state.pkg.skillAllotment.maxPrimary = 0;
      if (state.pkg.skillAllotment.maxSecondary === undefined) state.pkg.skillAllotment.maxSecondary = 0;
      break;
    case "toggle-secondary-swap":
      state.pkg.skillAllotment.secondarySwap = !state.pkg.skillAllotment.secondarySwap;
      break;
    case "remove-override":
      delete state.pkg.skillAllotment.skillCostSP[target.dataset.name];
      break;
    case "add-override":
      if (state.overrideSkill) {
        state.pkg.skillAllotment.skillCostSP ??= {};
        state.pkg.skillAllotment.skillCostSP[state.overrideSkill] = numberOr(state.overrideCost, 2);
      }
      break;
    case "remove-gold-override":
      setPath(state.pkg, ["skillAllotment", "skillCostGold", target.dataset.name], undefined);
      break;
    case "add-gold-override":
      if (state.goldOverrideSkill) setPath(state.pkg, ["skillAllotment", "skillCostGold", state.goldOverrideSkill], kToGold(state.goldOverrideCost) ?? 0);
      break;
    case "remove-tier": {
      const removedIndex = Number(target.dataset.index);
      state.pkg.tiers.splice(removedIndex, 1);
      if (state.activeTier > removedIndex) state.activeTier -= 1;
      else if (state.activeTier === removedIndex) state.activeTier = Math.min(removedIndex, state.pkg.tiers.length - 1);
      Object.keys(state.pkg.starPlayers.spCostByTier ?? {}).forEach((name) => {
        const costs = safeArray(state.pkg.starPlayers.spCostByTier[name]);
        costs.splice(removedIndex, 1);
        state.pkg.starPlayers.spCostByTier[name] = costs.slice(0, state.pkg.tiers.length);
      });
      state.view.starCostsTouched = true;
      break;
    }
    case "add-tier": {
      if (state.pkg.tiers.length >= MAX_TIERS) return;
      const tierNumber = state.pkg.tiers.length + 1;
      const assigned = new Set(state.pkg.tiers.flatMap((tier) => safeArray(tier.rosters)));
      state.pkg.tiers.push({
        tier: tierNumber,
        label: `Tier ${tierNumber}`,
        rosters: state.teams.filter((team) => Number(team.defaultTier) === tierNumber && !assigned.has(team.name)).map((team) => team.name),
        gold: state.pkg.goldBudget,
        skillPointBudget: state.pkg.skillAllotment.skillPointBudget,
        starPlayersAllowed: state.pkg.starPlayers.allowed,
        bannedStars: [],
      });
      Object.keys(state.pkg.starPlayers.spCostByTier ?? {}).forEach((name) => {
        state.pkg.starPlayers.spCostByTier[name] = starTierCostsForDisplay(name);
      });
      if (state.pkg.starPlayers.spCostByTier) state.view.starCostsTouched = true;
      if (state.pkg.tiers.length === 1) state.activeTier = 0;
      break;
    }
    case "assign-tier-team":
      assignTeamToTier(target.dataset.team, state.activeTier); return;
    case "remove-tier-team":
      removeTeamFromTier(target.dataset.team, Number(target.dataset.tier)); return;
    case "tier-pack-add": {
      const tier = state.pkg.tiers[Number(target.dataset.tier)];
      if (!tier) return;
      tier.skillPackages ??= [];
      tier.skillPackages.push({
        label: `Pack ${tier.skillPackages.length + 1}`,
        gold: numberOr(tier.gold, state.pkg.goldBudget ?? 0),
        skillPointBudget: numberOr(tier.skillPointBudget, state.pkg.skillAllotment.skillPointBudget ?? 0),
      });
      break;
    }
    case "tier-pack-remove": {
      const tier = state.pkg.tiers[Number(target.dataset.tier)];
      if (!tier) return;
      tier.skillPackages = safeArray(tier.skillPackages);
      tier.skillPackages.splice(Number(target.dataset.pack), 1);
      break;
    }
    case "tier-pack-generate": {
      const tier = state.pkg.tiers[Number(target.dataset.tier)];
      if (!tier) return;
      const baseGold = numberOr(tier.gold, state.pkg.goldBudget ?? 0);
      const baseSp = numberOr(tier.skillPointBudget, state.pkg.skillAllotment.skillPointBudget ?? 0);
      tier.skillPackages = [
        { label: "Pack 1", gold: baseGold, skillPointBudget: baseSp },
        { label: "Pack 2", gold: baseGold - 30000, skillPointBudget: baseSp + 1 },
        { label: "Pack 3", gold: baseGold + 30000, skillPointBudget: baseSp - 1 },
      ];
      break;
    }
    case "remove-package":
      state.pkg.skillPackages.splice(Number(target.dataset.index), 1);
      break;
    case "add-package":
      state.pkg.skillPackages.push({
        label: `Bundle ${state.pkg.skillPackages.length + 1}`,
        gold: state.pkg.goldBudget ?? 1000000,
        skillPointBudget: state.pkg.skillAllotment.skillPointBudget ?? 0,
        maxPerPlayer: state.pkg.skillAllotment.maxPerPlayer,
        starPlayersAllowed: state.pkg.starPlayers.allowed,
      });
      break;
    case "add-team-rule": {
      const team = state.ruleTeam || state.teams[0]?.name;
      if (!team) return;
      state.pkg.teamRules.push({ team });
      break;
    }
    case "remove-team-rule":
      state.pkg.teamRules.splice(Number(target.dataset.index), 1);
      break;
    case "add-star-pack": {
      state.pkg.starPacks = safeArray(state.pkg.starPacks);
      const ids = new Set(state.pkg.starPacks.map((pack) => pack.id));
      let number = state.pkg.starPacks.length + 1;
      while (ids.has(`pack-${number}`)) number += 1;
      state.pkg.starPacks.push({ id: `pack-${number}`, label: `Pack ${number}`, fee: 0, max: 1, stars: [] });
      break;
    }
    case "remove-star-pack":
      if (Array.isArray(state.pkg.starPacks)) state.pkg.starPacks.splice(Number(target.dataset.index), 1);
      if (Array.isArray(state.pkg.starPacks) && state.pkg.starPacks.length === 0 && state.original?.starPacks === undefined) delete state.pkg.starPacks;
      break;
    case "toggle-matrix-cell": {
      state.pkg.matrix = matrixForDisplay();
      const row = Number(target.dataset.row);
      const col = Number(target.dataset.col);
      const index = state.pkg.matrix.cells.findIndex((cell) => cell.row === row && cell.col === col);
      if (index >= 0) state.pkg.matrix.cells.splice(index, 1);
      else state.pkg.matrix.cells.push({ col, row, teams: [] });
      break;
    }
    case "add-matrix-column": {
      state.pkg.matrix = matrixForDisplay();
      const lastGold = state.pkg.matrix.columns.at(-1)?.gold;
      state.pkg.matrix.columns.push({ gold: numberOr(lastGold, 1100000) + 50000 });
      break;
    }
    case "remove-matrix-column": {
      state.pkg.matrix = matrixForDisplay();
      const col = Number(target.dataset.col);
      if (!Number.isInteger(col) || col < 0 || col >= state.pkg.matrix.columns.length || state.pkg.matrix.columns.length <= 1) return;
      state.pkg.matrix.columns.splice(col, 1);
      state.pkg.matrix.cells = state.pkg.matrix.cells
        .filter((cell) => cell.col !== col)
        .map((cell) => cell.col > col ? { ...cell, col: cell.col - 1 } : cell);
      break;
    }
    case "add-matrix-row":
      state.pkg.matrix = matrixForDisplay();
      state.pkg.matrix.rows.push({ primary: 6, secondary: 0, secondarySwap: false });
      break;
    case "remove-matrix-row": {
      state.pkg.matrix = matrixForDisplay();
      const row = Number(target.dataset.row);
      if (!Number.isInteger(row) || row < 0 || row >= state.pkg.matrix.rows.length || state.pkg.matrix.rows.length <= 1) return;
      state.pkg.matrix.rows.splice(row, 1);
      state.pkg.matrix.cells = state.pkg.matrix.cells
        .filter((cell) => cell.row !== row)
        .map((cell) => cell.row > row ? { ...cell, row: cell.row - 1 } : cell);
      break;
    }
    case "toggle-stars":
      state.pkg.starPlayers.allowed = !state.pkg.starPlayers.allowed;
      break;
    case "move-star-banned": moveStar(target.dataset.star, "banned"); return;
    case "move-star-allowed": moveStar(target.dataset.star, "allowed"); return;
    case "toggle-mega-stars": {
      const banned = new Set(state.pkg.bannedStars);
      const allBanned = MEGA_STARS.every((name) => banned.has(name));
      MEGA_STARS.forEach((name) => allBanned ? banned.delete(name) : banned.add(name));
      state.pkg.bannedStars = [...banned];
      break;
    }
    case "toggle-inducement": {
      const id = target.dataset.id;
      const knownIds = INDUCEMENTS.map((item) => item.id);
      let allowed = inducementAllowedList();
      if (allowed.includes("*")) allowed = knownIds.filter((known) => known !== id);
      else if (allowed.includes(id)) allowed = allowed.filter((known) => known !== id);
      else allowed = [...allowed, id];
      state.pkg.inducements.allowed = allowed;
      break;
    }
    case "step-inducement": {
      const id = target.dataset.id;
      const item = INDUCEMENTS.find((row) => row.id === id);
      state.pkg.inducements.caps ??= {};
      const current = state.pkg.inducements.caps[id] ?? item?.max ?? 1;
      state.pkg.inducements.caps[id] = Math.max(0, Math.min(9, current + Number(target.dataset.delta)));
      break;
    }
    case "toggle-insignificant": state.pkg.special.insignificantTraitConstraint = !state.pkg.special.insignificantTraitConstraint; break;
    case "toggle-stalling": state.pkg.special.stalling = !state.pkg.special.stalling; break;
    case "toggle-slann": state.pkg.special.slannAllowed = !state.pkg.special.slannAllowed; break;
    case "toggle-stat-increases": state.pkg.special.statIncreasesAllowed = !state.pkg.special.statIncreasesAllowed; break;
    case "toggle-stars-eleventh": state.pkg.special.minPlayers = Number(state.pkg.special.minPlayers) <= 10 ? 11 : 10; break;
    case "remove-banned-skill":
      state.pkg.special.bannedSkills = safeArray(state.pkg.special.bannedSkills).filter((name) => name !== target.dataset.name);
      break;
    case "add-banned-skill":
      state.pkg.special.bannedSkills = safeArray(state.pkg.special.bannedSkills);
      if (state.bannedSkill && !state.pkg.special.bannedSkills.includes(state.bannedSkill)) state.pkg.special.bannedSkills.push(state.bannedSkill);
      break;
    default:
      return;
  }
  markDirty();
  render();
}

const FIELD_PATHS = {
  name: ["name"], date: ["date"], description: ["description"], extends: ["extends"], dataNote: ["dataNote"],
  goldBudgetK: ["goldBudget"], starMaxCount: ["starPlayers", "maxCount"], starMaxCostK: ["starPlayers", "maxCombinedCost"],
};

/** Record that the organiser interacted with the field at `path` — even when the value they entered
 *  equals the filled default, it is now theirs and must be saved (it may override an `extends` base). */
function touchPath(path) {
  if (!Array.isArray(path) || !path.length) return;
  state.touched.add(pathKey([path[0]]));
  if (path.length >= 2 && NESTED_PRUNE.has(path[0])) state.touched.add(pathKey([path[0], path[1]]));
}

function handleEditorChange(target) {
  if (!state.pkg) return;
  state.preEdit = clone(state.pkg);
  touchPath(readPath(target.dataset.bind ?? "null") ?? readPath(target.dataset.overrideMode ?? "null") ?? readPath(target.dataset.multi ?? "null")
    ?? readPath(target.dataset.multiAll ?? "null") ?? FIELD_PATHS[target.dataset.field]);

  if (target.dataset.overrideMode != null) {
    if (applyOverrideMode(target)) { markDirty(); render(); }
    return;
  }
  if (target.dataset.bind != null) {
    if (applyBinding(target)) { markDirty(); render(); }
    return;
  }
  if (target.dataset.multi != null || target.dataset.multiAll != null) {
    if (applyMulti(target)) { markDirty(); render(); }
    return;
  }

  switch (target.dataset.action) {
    case "tier-pack-label":
    case "tier-pack-gold":
    case "tier-pack-sp":
    case "tier-pack-maxper": {
      const tier = state.pkg.tiers[Number(target.dataset.tier)];
      const item = safeArray(tier?.skillPackages)[Number(target.dataset.pack)];
      if (!item) return;
      if (target.dataset.action === "tier-pack-label") item.label = target.value;
      if (target.dataset.action === "tier-pack-gold") item.gold = kToGold(target.value) ?? 0;
      if (target.dataset.action === "tier-pack-sp") item.skillPointBudget = numberOr(target.value, 0);
      if (target.dataset.action === "tier-pack-maxper") {
        const maxPerPlayer = nullableNumber(target.value);
        if (maxPerPlayer == null) delete item.maxPerPlayer;
        else item.maxPerPlayer = maxPerPlayer;
      }
      markDirty(); render(); return;
    }
    case "star-tier-sp-cost": {
      const name = target.dataset.star;
      const tierIndex = Number(target.dataset.tier);
      if (!name || !Number.isInteger(tierIndex) || tierIndex < 0 || tierIndex >= state.pkg.tiers.length) return;
      state.pkg.starPlayers.spCostByTier ??= {};
      const costs = starTierCostsForDisplay(name);
      costs[tierIndex] = nullableNumber(target.value);
      pairedStarNames(name).forEach((starName) => { state.pkg.starPlayers.spCostByTier[starName] = [...costs]; });
      state.view.starCostsTouched = true;
      markDirty(); render(); return;
    }
    case "stars-paid-sp":
      if (target.checked) state.pkg.starPlayers.paidInSkillPoints = true;
      else delete state.pkg.starPlayers.paidInSkillPoints;
      markDirty(); render(); return;
    case "matrix-col-gold": {
      state.pkg.matrix = matrixForDisplay();
      const col = Number(target.dataset.col);
      const value = numberOr(target.value, Number.NaN);
      if (!Number.isNaN(value)) state.pkg.matrix.columns[col].gold = kToGold(Math.max(0, Math.round(value)));
      markDirty(); render(); return;
    }
    case "matrix-row-primary": {
      state.pkg.matrix = matrixForDisplay();
      const row = Number(target.dataset.row);
      const value = numberOr(target.value, Number.NaN);
      if (!Number.isNaN(value)) state.pkg.matrix.rows[row].primary = Math.max(0, Math.round(value));
      markDirty(); render(); return;
    }
    case "matrix-row-secondary": {
      state.pkg.matrix = matrixForDisplay();
      const row = Number(target.dataset.row);
      const value = numberOr(target.value, Number.NaN);
      if (!Number.isNaN(value)) state.pkg.matrix.rows[row].secondary = Math.max(0, Math.round(value));
      markDirty(); render(); return;
    }
    case "matrix-row-swap": {
      state.pkg.matrix = matrixForDisplay();
      const row = Number(target.dataset.row);
      if (state.pkg.matrix.rows[row]) state.pkg.matrix.rows[row].secondarySwap = target.checked;
      markDirty(); render(); return;
    }
  }

  if (target.dataset.control === "override-skill") { state.overrideSkill = target.value; return; }
  if (target.dataset.control === "override-cost") { state.overrideCost = numberOr(target.value, 2); return; }
  if (target.dataset.control === "gold-override-skill") { state.goldOverrideSkill = target.value; return; }
  if (target.dataset.control === "gold-override-cost") { state.goldOverrideCost = numberOr(target.value, 30); return; }
  if (target.dataset.control === "banned-skill") { state.bannedSkill = target.value; return; }
  if (target.dataset.control === "rule-team") { state.ruleTeam = target.value; return; }

  if (target.dataset.tierIndex != null) {
    const tier = state.pkg.tiers[Number(target.dataset.tierIndex)];
    if (!tier) return;
    const field = target.dataset.tierField;
    if (field === "tier") tier.tier = numberOr(target.value, tier.tier ?? 1);
    if (field === "label") tier.label = target.value;
    if (field === "gold") tier.gold = kToGold(target.value);
    if (field === "skillPointBudget") tier.skillPointBudget = nullableNumber(target.value);
    markDirty(); render(); return;
  }

  if (target.dataset.packageIndex != null) {
    const item = state.pkg.skillPackages[Number(target.dataset.packageIndex)];
    if (!item) return;
    const field = target.dataset.packageField;
    if (field === "label") item.label = target.value;
    if (field === "gold") item.gold = kToGold(target.value) ?? 0;
    if (field === "skillPointBudget") item.skillPointBudget = numberOr(target.value, 0);
    if (field === "maxPerPlayer") item.maxPerPlayer = nullableNumber(target.value);
    markDirty(); render(); return;
  }

  const field = target.dataset.field;
  if (!field) return;
  if (field === "name" || field === "date" || field === "description" || field === "extends" || field === "dataNote") state.pkg[field] = target.value;
  else if (field === "goldBudgetK") state.pkg.goldBudget = kToGold(target.value);
  else if (field === "starMaxCount") state.pkg.starPlayers.maxCount = nullableNumber(target.value);
  else if (field === "starMaxCostK") state.pkg.starPlayers.maxCombinedCost = kToGold(target.value);
  markDirty();
  render();
}

// ---------- server I/O ----------

async function login() {
  const username = document.querySelector("#login-user")?.value.trim() ?? "";
  const password = document.querySelector("#login-password")?.value ?? "";
  if (!username || !password) {
    state.loginUser = username;
    state.problems = ["Enter your username and organizer password to log in."];
    render();
    return;
  }
  state.busy = true;
  state.loginUser = username;
  render();
  try {
    const result = await requestJson("/api/auth/login", {
      method: "POST",
      // Portal CSRF guard: cookie-less pages still must send X-CW-Auth; body needs the coach name too.
      headers: { "Content-Type": "application/json", "X-CW-Auth": "1" },
      body: JSON.stringify({ username, password }),
    });
    state.authed = true;
    state.token = result.token;
    state.account = username;
    state.loginUser = "";
    state.expiresAt = result.expiresAt;
    state.adminNav = true; // the organizer password unlocks the organizer console links
    state.problems = [];
  } catch (error) {
    state.authed = false;
    state.token = null;
    state.account = "";
    state.expiresAt = "";
    state.problems = [serverMessage(error)];
  } finally {
    state.busy = false;
    render();
  }
}

function logout() {
  state.loginUser = state.account;
  state.authed = false;
  state.token = null;
  state.account = "";
  state.expiresAt = "";
  state.adminNav = false;
  state.saved = null;
  render();
}

async function loadSavedPackage(name) {
  if (!name) return;
  state.busy = true;
  state.selectedPackage = name;
  render();
  try {
    const result = await requestJson(`/api/packages/${encodeURIComponent(name)}`);
    // Edit the file AS AUTHORED (`raw`). A server that does not send it (older build) only has the
    // resolved view, and saving that would bake defaults into the file: open it read-only instead.
    if (result.raw) {
      loadPackageIntoEditor(result.raw, result.problems);
      state.revision = typeof result.revision === "string" ? result.revision : null;
      preflight(result.schemaProblems);
    } else {
      loadPackageIntoEditor(result.pkg, result.problems);
      state.readOnly = "This server does not send the package file as authored, so saving would rewrite it with every default filled in. The package is read-only until the server is updated.";
    }
  } catch (error) {
    if (error.data?.raw) {
      // A file that no longer resolves still opens, so the organiser can fix it.
      loadPackageIntoEditor(error.data.raw, [serverMessage(error)]);
      state.revision = typeof error.data.revision === "string" ? error.data.revision : null;
      preflight(error.data.schemaProblems);
    } else state.problems = [serverMessage(error)];
  } finally {
    state.busy = false;
    render();
  }
}

/**
 * Schema preflight on open (the server checks the raw file): fields this Creator does not know make
 * the package read-only — the editor would carry them blindly and the save would be refused — and
 * any other schema problem is listed up front instead of surfacing only at save.
 */
function preflight(schemaProblems) {
  const problems = safeArray(schemaProblems).map(String);
  const unknown = problems.map((problem) => problem.match(/^(.*): unknown property (.+)$/)).filter(Boolean).map((match) => `${match[1] === "$" ? "" : `${match[1].replace(/^\$\.?/, "")}.`}${match[2]}`);
  if (unknown.length) state.readOnly = `This package uses fields this Creator does not know: ${unknown.join(", ")}. Update the Creator before editing.`;
  const other = problems.filter((problem) => !/: unknown property /.test(problem));
  if (other.length) state.problems = [...state.problems, ...other];
}

function loadPreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  state.selectedPackage = "";
  loadPackageIntoEditor(preset.pkg, []);
}

function newBlankPackage() {
  state.selectedPackage = "";
  state.tab = "package";
  loadPackageIntoEditor(fallbackRaw(), []);
}

async function savePackage() {
  if (!(state.authed || state.token) || state.busy || state.readOnly) return;
  state.busy = true;
  state.saved = null;
  state.exported = false;
  render();
  try {
    const headers = { "Content-Type": "application/json", "X-CW-Auth": "1" };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const sent = serializePackage();
    // Optimistic concurrency: the revision we opened. The server refuses (409) when the file changed
    // since, and never lets a new name overwrite another package's file.
    if (state.revision) headers["If-Match"] = state.revision;
    const result = await requestJson("/api/packages", {
      method: "POST",
      headers,
      body: JSON.stringify(sent),
    });
    // The server wrote `sent` verbatim: it is the new "as authored" document later edits diff against.
    adoptDocument(sent);
    state.view = freshView(state.view.system, state.view.skillMode);
    state.revision = typeof result.revision === "string" ? result.revision : null;
    state.conflict = "";
    state.problems = safeArray(result.problems).map(String);
    const fallbackName = String(result.name ?? state.pkg.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json";
    const savedFile = typeof result.savedAs === "string" ? result.savedAs.split(/[\\/]/).pop() : fallbackName;
    state.saved = state.problems.length === 0 ? { file: savedFile || fallbackName, count: 0 } : null;
    if (typeof result.name === "string" && result.name) {
      state.selectedPackage = result.name;
      if (!state.packageNames.includes(result.name)) state.packageNames.push(result.name);
      state.packageNames.sort((a, b) => a.localeCompare(b));
    }
  } catch (error) {
    state.problems = [serverMessage(error), ...safeArray(error.data?.problems).map(String).filter((problem) => problem !== serverMessage(error))];
    if (error.status === 409) state.conflict = serverMessage(error);
    if (error.status === 401) {
      state.authed = false;
      state.token = null;
      state.account = "";
      state.expiresAt = "";
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function exportPackage() {
  if (state.busy) return;
  state.busy = true;
  state.saved = null;
  state.exported = false;
  render();
  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CW-Auth": "1" },
      body: JSON.stringify(serializePackage()),
    });
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch { data = null; }
      const error = new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`);
      error.status = response.status;
      error.serverError = typeof data?.error === "string" ? data.error : undefined;
      throw error;
    }
    const html = await response.text();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    state.problems = [];
    state.exported = true;
  } catch (error) {
    state.problems = [serverMessage(error)];
  } finally {
    state.busy = false;
    render();
  }
}

function handleShellClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "login") login();
  if (action === "discord-login") location.assign("/api/auth/discord/start?next=/tournament-rules.html");
  if (action === "logout") logout();
  if (action === "open-package") loadSavedPackage(target.dataset.name);
  if (action === "new-package") newBlankPackage();
}

function handleShellChange(event) {
  const target = event.target;
  if (target.dataset.action === "select-preset") loadPreset(target.value);
}

function boot() {
  toolbar = document.querySelector("#toolbar");
  shelf = document.querySelector("#package-shelf");
  editor = document.querySelector("#editor");
  rightRail = document.querySelector("#right-rail");
  connectionState = document.querySelector("#connection-state");
  const forkAdmin = document.querySelector("#fork-admin-link");
  if (forkAdmin) forkAdmin.href = `http://${location.hostname || "127.0.0.1"}:22227/panel.html`;

  [toolbar, shelf].filter(Boolean).forEach((element) => {
    element.addEventListener("click", handleShellClick);
    element.addEventListener("change", handleShellChange);
  });
  toolbar?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !(state.authed || state.token)) login();
  });

  editor.addEventListener("click", (event) => {
    const tierBlock = event.target.closest("[data-tier-block]");
    if (tierBlock) {
      state.activeTier = Number(tierBlock.dataset.tierBlock);
      editor.querySelectorAll("[data-tier-block]").forEach((block) => block.classList.toggle("active", block === tierBlock));
    }
    const target = event.target.closest("[data-action]");
    if (target && target.tagName !== "INPUT" && target.tagName !== "SELECT") handleEditorAction(target.dataset.action, target);
  });

  editor.addEventListener("change", (event) => handleEditorChange(event.target));

  editor.addEventListener("dragstart", (event) => {
    const team = event.target.closest("[data-team]")?.dataset.team;
    if (team) {
      state.dragTeam = team;
      state.dragStar = "";
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-tier-team", team);
      event.dataTransfer.setData("text/plain", team);
      return;
    }
    const star = event.target.closest("[data-star]")?.dataset.star;
    if (!star) return;
    state.dragTeam = "";
    state.dragStar = star;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", star);
  });

  editor.addEventListener("dragover", (event) => {
    const zone = state.dragTeam
      ? event.target.closest("[data-tier-drop]")
      : state.dragStar
        ? event.target.closest("[data-drop-zone]")
        : null;
    if (!zone) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    zone.classList.add("drag-over");
  });

  editor.addEventListener("dragleave", (event) => {
    const zone = event.target.closest("[data-tier-drop], [data-drop-zone]");
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("drag-over");
  });

  editor.addEventListener("drop", (event) => {
    const zone = state.dragTeam
      ? event.target.closest("[data-tier-drop]")
      : state.dragStar
        ? event.target.closest("[data-drop-zone]")
        : null;
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove("drag-over");
    if (zone.dataset.tierDrop != null) {
      const name = event.dataTransfer.getData("application/x-tier-team") || state.dragTeam;
      state.dragTeam = "";
      if (name) assignTeamToTier(name, Number(zone.dataset.tierDrop));
      return;
    }
    const name = event.dataTransfer.getData("text/plain") || state.dragStar;
    state.dragStar = "";
    if (name) moveStar(name, zone.dataset.dropZone);
  });

  editor.addEventListener("dragend", () => {
    state.dragTeam = "";
    state.dragStar = "";
    editor.querySelectorAll(".drag-over").forEach((zone) => zone.classList.remove("drag-over"));
  });

  rightRail.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "save") savePackage();
    if (action === "export") exportPackage();
    if (action === "reload-package" && state.selectedPackage) loadSavedPackage(state.selectedPackage);
  });

  return initialize();
}

async function initialize() {
  render();
  try {
    const session = await requestJson("/api/auth/session");
    state.discordSsoEnabled = session?.discordSsoEnabled === true;
    if (session?.authenticated === true) {
      state.authed = true;
      state.account = String(session.coach ?? "");
      if (typeof session.token === "string" && session.token) state.token = session.token;
      state.loginUser = "";
      state.expiresAt = String(session.expiresAt ?? "");
      state.problems = [];
    }
    state.adminNav = session?.authenticated === true && (session.admin === true || session.organizer === true);
    render();
  } catch {
    // Stay signed out when the session probe is unavailable.
  }
  const requests = [
    ["packages", requestJson("/api/packages")],
    ["presets", requestJson("/api/presets")],
    ["skills", requestJson("/api/skills")],
    ["stars", requestJson("/api/stars")],
    ["teams", requestJson("/api/teams")],
  ];
  const results = await Promise.allSettled(requests.map(([, request]) => request));
  const values = {};
  results.forEach((result, index) => {
    const label = requests[index][0];
    if (result.status === "fulfilled") values[label] = result.value;
    else state.catalogNotices.push(`${label[0].toUpperCase() + label.slice(1)} catalog unavailable: ${serverMessage(result.reason)}`);
  });

  state.connected = results.some((result) => result.status === "fulfilled");
  state.packageNames = safeArray(values.packages).map(packageName).filter(Boolean).sort((a, b) => a.localeCompare(b));
  state.presets = safeArray(values.presets).filter((preset) => preset && typeof preset.id === "string" && preset.pkg);
  const skillGroups = values.skills && typeof values.skills === "object"
    ? [...safeArray(values.skills.elite), ...safeArray(values.skills.general)]
    : [];
  state.skills = [...new Map(skillGroups.filter((skill) => skill?.name).map((skill) => [skill.name, skill])).values()].sort((a, b) => a.name.localeCompare(b.name));
  state.stars = safeArray(values.stars).filter((star) => star?.name).sort((a, b) => a.name.localeCompare(b.name));
  state.teams = safeArray(values.teams).filter((team) => team?.name).sort((a, b) => a.name.localeCompare(b.name));
  state.overrideSkill = state.skills[0]?.name ?? "";
  state.goldOverrideSkill = state.skills[0]?.name ?? "";
  state.bannedSkill = state.skills[0]?.name ?? "";
  state.ruleTeam = state.teams[0]?.name ?? "";

  if (state.packageNames.length) {
    await loadSavedPackage(state.packageNames[0]);
  } else if (state.presets.length) {
    loadPreset(state.presets[0].id);
  } else {
    adoptDocument(fallbackRaw());
    state.view = inferView(state.pkg);
    render();
  }
}

globalThis.TournamentRulesCore = {
  state,
  INDUCEMENTS,
  TABS,
  normalizePackage,
  serializePackage,
  pruneInjected,
  loadPackageIntoEditor,
  handleEditorAction,
  handleEditorChange,
  loadSavedPackage,
  savePackage,
  editorHtml,
  render,
  setPath,
  getPath,
  boot,
  MAX_TIERS,
  ready: typeof document !== "undefined" && document.querySelector?.("#editor") ? boot() : Promise.resolve(),
};
