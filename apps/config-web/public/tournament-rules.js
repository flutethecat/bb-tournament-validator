"use strict";

const MEGA_STARS = [
  "Morg 'n' Thorg",
  "H'thark the Unstoppable",
  "Griff Oberwald",
  'Ivan "the Animal" Deathshroud',
  "Hakflem Skuttlespike",
];

const INDUCEMENTS = [
  { id: "biased_referee", label: "Biased Referee", max: 1, fixed: true },
  { id: "bloodweiser_kegs", label: "Blitzer's Best Kegs", max: 2, fixed: false },
  { id: "bribes", label: "Bribe", max: 3, fixed: false },
  { id: "halfling_master_chef", label: "Halfling Master Chef", max: 1, fixed: true },
  { id: "infamous_coaching_staff", label: "Infamous Coaching Staff: Josef Bugman", max: 1, fixed: true },
  { id: "part_time_assistant_coaches", label: "Part-time Assistant Coach", max: 5, fixed: false },
  { id: "prayers_to_nuffle", label: "Prayers to Nuffle", max: 3, fixed: false },
  { id: "team_mascot", label: "Team Mascot", max: 1, fixed: true },
  { id: "temp_agency_cheerleaders", label: "Temp Agency Cheerleader", max: 5, fixed: false },
  { id: "wandering_apothecaries", label: "Wandering Apothecary", max: 2, fixed: false },
  { id: "weather_mage", label: "Weather Mage", max: 1, fixed: true },
  { id: "hireling_sports_wizard", label: "Sports Wizard", max: 1, fixed: true },
];

const CATEGORY_COLORS = {
  general: "#6ea8ff",
  agility: "#ffd23d",
  strength: "#ff6b6b",
  passing: "#ffffff",
  devious: "#ffffff",
  mutations: "#6fcf6f",
  mutation: "#6fcf6f",
  traits: "#b08b5a",
  trait: "#b08b5a",
};

const DEFAULT_SKILL_ALLOTMENT = {
  skillPointBudget: 0,
  primaryCostSP: 1,
  secondaryMultiplier: 2,
  secondaryCostSP: null,
  eliteSurchargeSP: 1,
  eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"],
  skillCostSP: {},
  maxPerPlayer: 2,
  maxSameSkillTeamwide: null,
  maxStackedPlayers: null,
};

const state = {
  token: null,
  account: "",
  loginUser: "",
  expiresAt: "",
  packageNames: [],
  selectedPackage: "",
  presets: [],
  skills: [],
  stars: [],
  teams: [],
  pkg: null,
  problems: [],
  saved: null,
  exported: false,
  busy: false,
  connected: false,
  catalogNotices: [],
  overrideSkill: "",
  overrideCost: 2,
  bannedSkill: "",
  dragStar: "",
  view: { system: "skillpoints", skillMode: "pool", swapRate: 2 },
};

const toolbar = document.querySelector("#toolbar");
const editor = document.querySelector("#editor");
const rightRail = document.querySelector("#right-rail");
const connectionState = document.querySelector("#connection-state");

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
  return value == null ? "" : Number(value) / 1000;
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
    throw error;
  }
  return data;
}

function normalizePackage(raw) {
  const input = raw && typeof raw === "object" ? clone(raw) : {};
  return {
    ...input,
    name: typeof input.name === "string" ? input.name : "",
    ruleset: typeof input.ruleset === "string" ? input.ruleset : "bb2025-default",
    description: typeof input.description === "string" ? input.description : "",
    date: typeof input.date === "string" ? input.date : "",
    extends: typeof input.extends === "string" ? input.extends : "",
    eligibleRosters: safeArray(input.eligibleRosters).length ? safeArray(input.eligibleRosters) : ["*"],
    goldBudget: input.goldBudget == null ? null : numberOr(input.goldBudget, null),
    goldCapIncludesAddedSkills: input.goldCapIncludesAddedSkills === true,
    skillAllotment: {
      ...DEFAULT_SKILL_ALLOTMENT,
      ...(input.skillAllotment ?? {}),
      eliteSkills: safeArray(input.skillAllotment?.eliteSkills).length
        ? safeArray(input.skillAllotment.eliteSkills)
        : [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
      skillCostSP: input.skillAllotment?.skillCostSP && typeof input.skillAllotment.skillCostSP === "object"
        ? { ...input.skillAllotment.skillCostSP }
        : {},
    },
    skillPackages: safeArray(input.skillPackages),
    tiers: safeArray(input.tiers),
    teamRules: safeArray(input.teamRules),
    matrix: input.matrix && typeof input.matrix === "object" ? input.matrix : undefined,
    bannedStars: safeArray(input.bannedStars),
    starPlayers: {
      allowed: input.starPlayers?.allowed !== false,
      maxCount: input.starPlayers?.maxCount ?? 2,
      maxCombinedCost: input.starPlayers?.maxCombinedCost ?? null,
      ...(input.starPlayers ?? {}),
    },
    inducements: {
      allowed: safeArray(input.inducements?.allowed).length ? safeArray(input.inducements.allowed) : [],
      caps: input.inducements?.caps && typeof input.inducements.caps === "object" ? { ...input.inducements.caps } : {},
    },
    sideline: {
      maxReRolls: null,
      maxApothecary: null,
      maxCheerleaders: null,
      maxAssistantCoaches: null,
      maxDedicatedFans: null,
      ...(input.sideline ?? {}),
    },
    special: {
      insignificantTraitConstraint: true,
      stalling: true,
      slannAllowed: false,
      statIncreasesAllowed: false,
      bannedSkills: [],
      minPlayers: 11,
      ...(input.special ?? {}),
      bannedSkills: safeArray(input.special?.bannedSkills),
    },
  };
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
  return { system, skillMode, swapRate: 2 };
}

function loadPackageIntoEditor(pkg, problems) {
  state.pkg = normalizePackage(pkg);
  state.view = inferView(state.pkg);
  state.problems = safeArray(problems).map(String);
  state.saved = null;
  state.exported = false;
  state.overrideSkill = state.skills[0]?.name ?? "";
  state.bannedSkill = state.skills[0]?.name ?? "";
  render();
}

function fallbackPackage() {
  return normalizePackage({
    name: "",
    ruleset: "bb2025-default",
    eligibleRosters: ["*"],
    skillAllotment: DEFAULT_SKILL_ALLOTMENT,
    goldBudget: null,
    starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: null },
    inducements: { allowed: ["*"], caps: {} },
    sideline: {},
    special: { insignificantTraitConstraint: true, stalling: true, slannAllowed: false, statIncreasesAllowed: false, bannedSkills: [], minPlayers: 11 },
  });
}

function markDirty() {
  state.saved = null;
  state.exported = false;
  state.problems = [];
}

function skillColor(name) {
  const skill = state.skills.find((row) => row.name === name);
  return CATEGORY_COLORS[String(skill?.category ?? "").toLowerCase()] ?? "#cfd4cf";
}

function tierClass(tier) {
  const value = Math.max(1, Math.min(4, Number(tier) || 4));
  return `tier-${value}`;
}

function isAllRaces() {
  return state.pkg.eligibleRosters.includes("*");
}

function isInducementAllowed(id) {
  const allowed = state.pkg.inducements.allowed;
  return allowed.includes("*") || allowed.includes(id);
}

function matrixForDisplay() {
  const existing = state.pkg.matrix ?? { columns: [], rows: [], cells: [] };
  const columns = [...safeArray(existing.columns)];
  const rows = [...safeArray(existing.rows)];
  const defaults = [1150000, 1100000, 1050000];
  const rowDefaults = [[6, 0], [5, 1], [4, 2]];
  while (columns.length < 3) columns.push({ gold: defaults[columns.length] });
  while (rows.length < 3) {
    const values = rowDefaults[rows.length];
    rows.push({ primary: values[0], secondary: values[1], secondarySwap: false });
  }
  return { ...existing, columns, rows, cells: safeArray(existing.cells) };
}

function serializePackage() {
  const output = clone(state.pkg);
  output.name = String(output.name ?? "").trim();
  output.ruleset = output.ruleset || "bb2025-default";
  output.eligibleRosters = safeArray(output.eligibleRosters);
  output.skillAllotment = { ...DEFAULT_SKILL_ALLOTMENT, ...output.skillAllotment };

  if (state.view.skillMode === "pool") {
    delete output.skillAllotment.maxPrimary;
    delete output.skillAllotment.maxSecondary;
    delete output.skillAllotment.secondarySwap;
  }

  if (state.view.system === "skillpoints") {
    delete output.skillPackages;
    delete output.tiers;
    delete output.matrix;
  } else if (state.view.system === "tiers") {
    delete output.skillPackages;
    delete output.matrix;
  } else if (state.view.system === "packages") {
    delete output.tiers;
    delete output.matrix;
  } else if (state.view.system === "matrix") {
    delete output.skillPackages;
    delete output.tiers;
    output.matrix = matrixForDisplay();
  }

  return output;
}

function options(items, current, getValue = (item) => item, getLabel = (item) => item) {
  return items.map((item) => {
    const value = String(getValue(item));
    return `<option value="${escapeHtml(value)}"${value === String(current ?? "") ? " selected" : ""}>${escapeHtml(getLabel(item))}</option>`;
  }).join("");
}

function chip(label, action, active, extra = "") {
  return `<button type="button" class="chip${active ? " active" : ""}${extra ? ` ${extra}` : ""}" data-action="${action}">${escapeHtml(label)}</button>`;
}

function title(words) {
  return words.split(" ").map((word) => word ? `<span>${escapeHtml(word[0])}</span>${escapeHtml(word.slice(1))}` : "").join(" ");
}

function renderToolbar() {
  const packageOptions = state.packageNames.length
    ? '<option value="">— open saved package —</option>' + options(state.packageNames, state.selectedPackage)
    : '<option value="">— no saved packages —</option>';
  const presetOptions = '<option value="">—</option>' + options(state.presets, "", (preset) => preset.id, (preset) => preset.label);
  const login = state.token
    ? `<span class="login-status">● ${escapeHtml(state.account)} · token expires ${escapeHtml(state.expiresAt)}</span>
       <button type="button" class="btn" data-action="logout">Log Out</button>`
    : `<label class="visually-hidden" for="login-user">Username</label>
       <input id="login-user" class="control" style="width:130px" autocomplete="username" placeholder="Username" value="${escapeHtml(state.loginUser)}">
       <label class="visually-hidden" for="login-password">Password</label>
       <input id="login-password" class="control" style="width:140px" type="password" autocomplete="current-password" placeholder="Password">
       <button type="button" class="btn primary" data-action="login">Log In</button>`;

  toolbar.innerHTML = `
    <span class="toolbar-label">Package</span>
    <select class="control" data-action="select-package" aria-label="Package">${packageOptions}</select>
    <span class="toolbar-label">New from Preset</span>
    <select class="control" data-action="select-preset" aria-label="New from Preset">${presetOptions}</select>
    <span class="toolbar-spacer"></span>
    ${login}`;
}

function renderSummary() {
  const pkg = state.pkg;
  const extendsOptions = '<option value="">— none —</option>' + options(state.packageNames, pkg.extends);
  return `
    <section class="panel">
      <div class="section-title">${title("Summary")}</div>
      <div class="form-grid">
        <label class="field"><span class="field-label">Name *</span><input class="control" data-field="name" value="${escapeHtml(pkg.name)}"></label>
        <label class="field"><span class="field-label">Date</span><input class="control" data-field="date" type="date" value="${escapeHtml(pkg.date)}"></label>
        <label class="field"><span class="field-label">Ruleset</span><input class="control" value="BB2025" readonly></label>
        <label class="field"><span class="field-label">Extends (inherit from)</span><select class="control" data-field="extends">${extendsOptions}</select></label>
      </div>
      <label class="field"><span class="field-label">Description</span><textarea class="control" data-field="description">${escapeHtml(pkg.description)}</textarea></label>
    </section>`;
}

function renderRaces() {
  const all = isAllRaces();
  const selected = new Set(state.pkg.eligibleRosters);
  const chips = state.teams.map((team) => {
    const active = all || selected.has(team.name);
    return `<button type="button" class="chip race-chip${active ? " active" : ""}" data-action="toggle-race" data-name="${escapeHtml(team.name)}">
      ${escapeHtml(team.name)} <span class="tier-badge ${tierClass(team.defaultTier)}">T${escapeHtml(team.defaultTier ?? "?")}</span>
    </button>`;
  }).join("");
  const count = all ? `all ${state.teams.length} races eligible` : `${state.pkg.eligibleRosters.length} of ${state.teams.length} selected`;
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

function renderGold() {
  const includesSkills = state.pkg.goldCapIncludesAddedSkills === true;
  const note = includesSkills
    ? "The cap checks creation gold (players + sideline staff + inducements). Added-skill gold TV is added to this budget."
    : "The cap checks ONLY creation gold — players + sideline staff + inducements.";
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Gold / Team-Value Cap")}</div>
        <span class="field-label">Creation Gold Cap</span>
        <input class="control compact" data-field="goldBudgetK" type="number" min="0" step="10" value="${escapeHtml(goldToK(state.pkg.goldBudget))}">
        <span class="hint">k gold</span>
        ${chip("Creation Gold", "cap-creation", !includesSkills)}
        ${chip("Skills as Part of the Gold Budget", "cap-includes", includesSkills)}
      </div>
      <div class="hint">${note}</div>
    </section>`;
}

function renderOverrides() {
  const costs = state.pkg.skillAllotment.skillCostSP;
  const rows = Object.entries(costs).sort(([a], [b]) => a.localeCompare(b)).map(([skill, cost]) => `
    <div class="inset-row">
      <span class="grow" style="color:${skillColor(skill)}">${escapeHtml(skill)}</span>
      <span style="color:#e7ddc7">${escapeHtml(cost)} SP</span>
      <button type="button" class="remove" data-action="remove-override" data-name="${escapeHtml(skill)}" aria-label="Remove ${escapeHtml(skill)} override">✕</button>
    </div>`).join("");
  return `
    <div class="inset-list">
      <div class="subheading">Per-Skill SP Overrides</div>
      ${rows}
      <div class="inline-controls">
        <select class="control" data-control="override-skill">${options(state.skills, state.overrideSkill, (skill) => skill.name, (skill) => skill.name)}</select>
        <input class="control tiny" data-control="override-cost" type="number" min="0" value="${escapeHtml(state.overrideCost)}">
        <span class="hint">SP</span>
        <button type="button" class="btn primary" data-action="add-override">Add</button>
      </div>
    </div>`;
}

function renderSkillPoints() {
  const allotment = state.pkg.skillAllotment;
  if (state.view.skillMode === "count") {
    return `
      <div class="inline-controls">
        <label class="field"><span class="field-label">Max Primary</span><input class="control tiny" data-field="maxPrimary" type="number" min="0" value="${escapeHtml(allotment.maxPrimary ?? 0)}"></label>
        <label class="field"><span class="field-label">Max Secondary</span><input class="control tiny" data-field="maxSecondary" type="number" min="0" value="${escapeHtml(allotment.maxSecondary ?? 0)}"></label>
        ${chip(`Secondary Swap — 1 secondary counts as ${state.view.swapRate} primary`, "toggle-secondary-swap", allotment.secondarySwap === true)}
        <label class="field"><span class="field-label">Swap Rate</span><input class="control tiny" data-field="swapRate" type="number" min="1" value="${escapeHtml(state.view.swapRate)}"></label>
      </div>`;
  }

  const fields = [
    ["SP Budget / Team", "skillPointBudget", allotment.skillPointBudget],
    ["Primary Cost (SP)", "primaryCostSP", allotment.primaryCostSP],
    ["Secondary ×Mult", "secondaryMultiplier", allotment.secondaryMultiplier],
    ["Elite Surcharge (SP)", "eliteSurchargeSP", allotment.eliteSurchargeSP],
    ["Max Skills / Player", "maxPerPlayer", allotment.maxPerPlayer],
    ["Team SP Cap (0=none)", "maxSameSkillTeamwide", allotment.maxSameSkillTeamwide ?? 0],
  ];
  return `
    <div class="form-grid three">
      ${fields.map(([label, field, value]) => `<label class="field"><span class="field-label">${label}</span><input class="control" data-field="${field}" type="number" min="0" value="${escapeHtml(value ?? "")}"></label>`).join("")}
    </div>
    ${renderOverrides()}`;
}

function renderTiers() {
  const rows = state.pkg.tiers.map((tier, index) => `
    <div class="inset-row">
      <input class="control tiny" data-tier-index="${index}" data-tier-field="tier" type="number" min="1" value="${escapeHtml(tier.tier ?? index + 1)}" aria-label="Tier number">
      <input class="control" style="width:130px" data-tier-index="${index}" data-tier-field="label" value="${escapeHtml(tier.label ?? `Tier ${tier.tier ?? index + 1}`)}" aria-label="Tier label">
      <input class="control grow" data-tier-index="${index}" data-tier-field="rosters" value="${escapeHtml(safeArray(tier.rosters).join(", "))}" aria-label="Tier races, comma separated">
      <input class="control compact" data-tier-index="${index}" data-tier-field="gold" type="number" min="0" value="${escapeHtml(goldToK(tier.gold))}" aria-label="Tier gold in thousands">
      <span class="hint">k</span>
      <input class="control tiny" data-tier-index="${index}" data-tier-field="skillPointBudget" type="number" min="0" value="${escapeHtml(tier.skillPointBudget ?? "")}" aria-label="Tier SP">
      <span class="hint">SP</span>
      ${chip("Stars", `toggle-tier-stars:${index}`, tier.starPlayersAllowed !== false)}
      <button type="button" class="remove" data-action="remove-tier" data-index="${index}" aria-label="Remove tier">✕</button>
    </div>`).join("");
  return `
    <div class="inset-list">
      <div class="hint">Per-tier caps override the package caps. Races default to their live dataset tier.</div>
      ${rows || '<div class="hint">No tiers defined.</div>'}
      <button type="button" class="btn" data-action="add-tier" style="align-self:flex-start">+ Add Tier</button>
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
      ${chip("Stars", `toggle-package-stars:${index}`, skillPackage.starPlayersAllowed !== false)}
      <button type="button" class="remove" data-action="remove-package" data-index="${index}" aria-label="Remove package">✕</button>
    </div>`).join("");
  return `
    <div class="inset-list">
      <div class="hint">Spike!-style “choose one of” bundles — a team is legal if it fits any.</div>
      ${rows || '<div class="hint">No packages defined.</div>'}
      <button type="button" class="btn" data-action="add-package" style="align-self:flex-start">+ Add Package</button>
    </div>`;
}

function renderMatrix() {
  const matrix = matrixForDisplay();
  const cells = new Set(matrix.cells.map((cell) => `${cell.row}-${cell.col}`));
  let grid = '<div></div>';
  matrix.columns.slice(0, 3).forEach((column) => { grid += `<div class="matrix-head">${escapeHtml(goldToK(column.gold))}k</div>`; });
  matrix.rows.slice(0, 3).forEach((row, rowIndex) => {
    grid += `<div class="matrix-head row-head">${escapeHtml(row.primary)} pri / ${escapeHtml(row.secondary)} sec</div>`;
    matrix.columns.slice(0, 3).forEach((_column, colIndex) => {
      const active = cells.has(`${rowIndex}-${colIndex}`);
      const existing = matrix.cells.find((cell) => cell.row === rowIndex && cell.col === colIndex);
      const teamCount = safeArray(existing?.teams).length;
      grid += `<button type="button" class="matrix-cell${active ? " active" : ""}" data-action="toggle-matrix-cell" data-row="${rowIndex}" data-col="${colIndex}" title="${teamCount} assigned team(s)">${active ? "✓" : "—"}</button>`;
    });
  });
  return `
    <div class="inset-list">
      <div class="hint">Cash × skills grid — click cells to allow / deny. Loaded team assignments are preserved in their cells.</div>
      <div class="matrix-wrap"><div class="matrix-grid">${grid}</div></div>
    </div>`;
}

function renderTournamentSystem() {
  const suppressed = state.pkg.goldCapIncludesAddedSkills === true;
  let content = "";
  if (state.view.system === "skillpoints") content = renderSkillPoints();
  if (state.view.system === "tiers") content = renderTiers();
  if (state.view.system === "packages") content = renderPackages();
  if (state.view.system === "matrix") content = renderMatrix();
  return `
    <section class="panel">
      ${suppressed ? '<div class="notice">Skills are part of the Gold Budget, no configuration necessary.</div>' : ""}
      <div class="system-body${suppressed ? " suppressed" : ""}">
        <div class="section-head">
          <div class="section-title">${title("Tournament System")}</div>
          ${chip("Skill Points", "system-skillpoints", state.view.system === "skillpoints")}
          ${chip("Tiers", "system-tiers", state.view.system === "tiers")}
          ${chip("Packages", "system-packages", state.view.system === "packages")}
          ${chip("Matrix", "system-matrix", state.view.system === "matrix")}
        </div>
        ${state.view.system === "skillpoints" ? `<div class="inline-controls"><span class="field-label">Pricing</span>${chip("SP Pool", "mode-pool", state.view.skillMode === "pool")}${chip("Count Mode", "mode-count", state.view.skillMode === "count")}</div>` : ""}
        ${content}
      </div>
    </section>`;
}

function renderStars() {
  const banned = new Set(state.pkg.bannedStars);
  const starNames = state.stars.map((star) => star.name);
  const missingBans = state.pkg.bannedStars.filter((name) => !starNames.includes(name));
  const allNames = [...starNames, ...missingBans];
  const allowedChips = allNames.filter((name) => !banned.has(name)).map((name) => `<button type="button" draggable="true" class="star-chip" data-action="move-star-banned" data-star="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  const bannedChips = allNames.filter((name) => banned.has(name)).map((name) => `<button type="button" draggable="true" class="star-chip" data-action="move-star-allowed" data-star="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  const allMegaBanned = MEGA_STARS.every((name) => banned.has(name));
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Star Players")}</div>
        ${chip("Stars Allowed", "toggle-stars", state.pkg.starPlayers.allowed)}
        <span class="field-label">Max Count</span>
        <input class="control tiny" data-field="starMaxCount" type="number" min="0" value="${escapeHtml(state.pkg.starPlayers.maxCount ?? "")}">
        <span class="field-label">Max Combined Cost</span>
        <input class="control compact" data-field="starMaxCostK" type="number" min="0" value="${escapeHtml(goldToK(state.pkg.starPlayers.maxCombinedCost))}">
        <span class="hint">k (blank = no cap)</span>
      </div>
      <div class="star-columns">
        <div class="star-column allowed" data-drop-zone="allowed">
          <div class="star-column-title">Allowed Stars (${allNames.length - banned.size})</div>
          <div class="chip-list grow">${allowedChips || '<span class="hint">None</span>'}</div>
        </div>
        <div class="star-column banned" data-drop-zone="banned">
          <div class="star-column-title">Banned Stars (${banned.size})</div>
          <div class="chip-list grow">${bannedChips || '<span class="hint">None</span>'}</div>
        </div>
      </div>
      <div class="inline-controls">
        <span class="hint grow">Drag a star between columns (clicking a chip also moves it across).</span>
        <button type="button" class="btn primary" data-action="toggle-mega-stars">⚑ ${allMegaBanned ? "Unban" : "Ban"} Mega-Stars</button>
      </div>
    </section>`;
}

function renderInducements() {
  const rows = INDUCEMENTS.map((item) => {
    const allowed = isInducementAllowed(item.id);
    const max = state.pkg.inducements.caps[item.id] ?? item.max;
    return `
      <div class="inducement-row">
        <button type="button" class="check-box${allowed ? " active" : ""}" data-action="toggle-inducement" data-id="${item.id}" aria-label="Toggle ${escapeHtml(item.label)}">✓</button>
        <span class="grow${allowed ? "" : " disabled-label"}">${escapeHtml(item.label)}</span>
        ${item.fixed ? "" : `<button type="button" class="btn step" data-action="step-inducement" data-id="${item.id}" data-delta="-1">−</button>`}
        <span style="width:30px;text-align:center">0-${escapeHtml(item.fixed ? item.max : max)}</span>
        ${item.fixed ? "" : `<button type="button" class="btn primary step" data-action="step-inducement" data-id="${item.id}" data-delta="1">+</button>`}
      </div>`;
  }).join("");
  return `
    <section class="panel">
      <div class="section-title">${title("Inducements")} <span class="section-note">— allowed + per-inducement caps</span></div>
      <div class="inducement-grid">${rows}</div>
    </section>`;
}

function renderSpecialRules() {
  const special = state.pkg.special;
  const toggles = [
    ["Insignificant-trait constraint", "toggle-insignificant", special.insignificantTraitConstraint],
    ["Stalling allowed", "toggle-stalling", special.stalling],
    ["Slann allowed", "toggle-slann", special.slannAllowed],
    ["Stat increases allowed", "toggle-stat-increases", special.statIncreasesAllowed],
    ["Stars are the 11th player", "toggle-stars-eleventh", Number(special.minPlayers) <= 10],
  ];
  const banned = special.bannedSkills.map((name) => `<button type="button" class="chip active" style="color:${skillColor(name)}" data-action="remove-banned-skill" data-name="${escapeHtml(name)}">${escapeHtml(name)} ✕</button>`).join("");
  return `
    <section class="panel">
      <div class="section-title">${title("Special Rules")}</div>
      <div class="chip-list">${toggles.map(([label, action, active]) => chip(label, action, active)).join("")}</div>
      <div class="inset-list">
        <div class="subheading">Banned Skills</div>
        <div class="chip-list">${banned}</div>
        <div class="inline-controls">
          <select class="control" data-control="banned-skill">${options(state.skills, state.bannedSkill, (skill) => skill.name, (skill) => skill.name)}</select>
          <button type="button" class="btn primary" data-action="add-banned-skill">Ban</button>
        </div>
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

function renderRightRail() {
  if (!state.pkg) {
    rightRail.innerHTML = '<div class="loading-banner">Loading the tournament package editor…</div>';
    return;
  }
  const allRaces = isAllRaces();
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
  const gold = state.pkg.goldBudget == null ? "none" : `${goldToK(state.pkg.goldBudget)}k${state.pkg.goldCapIncludesAddedSkills ? " (incl. skills)" : ""}`;
  const stars = state.pkg.starPlayers.allowed
    ? `max ${state.pkg.starPlayers.maxCount ?? "none"}${state.pkg.bannedStars.length ? ` · ${state.pkg.bannedStars.length} banned` : ""}`
    : "not allowed";
  rightRail.innerHTML = `
    <div class="skill-key">
      <span class="skill-key-label">${title("Skill Key")}</span><span class="cat-general">General</span><span class="cat-agility">Agility</span><span class="cat-strength">Strength</span><span class="cat-devious">Devious</span><span class="cat-mutations">Mutations</span><span class="cat-traits">Traits</span>
    </div>
    <button type="button" class="btn primary big" data-action="save"${state.token && !state.busy ? "" : " disabled"}>${state.busy ? "Working…" : "Save Package"}</button>
    <button type="button" class="btn big" data-action="export"${state.busy ? " disabled" : ""}>Export Printable Rules Sheet</button>
    ${validation}${saved}${exported}${notices}
    <div class="summary-card">
      <div class="rail-title">${title("Package Summary")}</div>
      <div class="summary-row"><span>Races</span><span>${allRaces ? `all (${state.teams.length})` : state.pkg.eligibleRosters.length}</span></div>
      <div class="summary-row"><span>Gold cap</span><span>${escapeHtml(gold)}</span></div>
      <div class="summary-row"><span>Skill model</span><span>${escapeHtml(skillSummary())}</span></div>
      <div class="summary-row"><span>Stars</span><span>${escapeHtml(stars)}</span></div>
      <div class="summary-row"><span>Banned skills</span><span>${state.pkg.special.bannedSkills.length || "none"}</span></div>
    </div>
    <div class="boundary-note">Reads are open; saving needs the organizer token. The server is the source of truth — the problems panel renders its verdict verbatim.</div>`;
}

function renderEditor() {
  if (!state.pkg) {
    editor.innerHTML = '<div class="loading-banner">Loading catalogs and a tournament package…</div>';
    return;
  }
  editor.innerHTML = [
    renderSummary(),
    renderRaces(),
    renderGold(),
    renderTournamentSystem(),
    renderStars(),
    renderInducements(),
    renderSpecialRules(),
  ].join("");
}

function render() {
  renderToolbar();
  renderEditor();
  renderRightRail();
  connectionState.textContent = state.connected ? "● connected" : "● connection issue";
  connectionState.className = state.connected ? "connected" : "disconnected";
  document.body.classList.toggle("busy", state.busy);
}

function setSystem(system) {
  state.view.system = system;
  if (system === "tiers" && !Array.isArray(state.pkg.tiers)) state.pkg.tiers = [];
  if (system === "packages" && !Array.isArray(state.pkg.skillPackages)) state.pkg.skillPackages = [];
  if (system === "matrix") state.pkg.matrix = matrixForDisplay();
  markDirty();
  render();
}

function toggleRace(name) {
  const allNames = state.teams.map((team) => team.name);
  const current = isAllRaces() ? allNames : [...state.pkg.eligibleRosters];
  state.pkg.eligibleRosters = current.includes(name) ? current.filter((race) => race !== name) : [...current, name];
}

function moveStar(name, destination) {
  const banned = new Set(state.pkg.bannedStars);
  if (destination === "banned") banned.add(name);
  else banned.delete(name);
  state.pkg.bannedStars = [...banned];
  markDirty();
  render();
}

function handleEditorAction(action, target) {
  if (!state.pkg) return;

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
      state.view.skillMode = "pool";
      break;
    case "mode-count":
      state.view.skillMode = "count";
      state.pkg.skillAllotment.maxPrimary ??= 0;
      state.pkg.skillAllotment.maxSecondary ??= 0;
      break;
    case "toggle-secondary-swap":
      state.pkg.skillAllotment.secondarySwap = !state.pkg.skillAllotment.secondarySwap;
      break;
    case "remove-override":
      delete state.pkg.skillAllotment.skillCostSP[target.dataset.name];
      break;
    case "add-override":
      if (state.overrideSkill) state.pkg.skillAllotment.skillCostSP[state.overrideSkill] = numberOr(state.overrideCost, 2);
      break;
    case "remove-tier":
      state.pkg.tiers.splice(Number(target.dataset.index), 1);
      break;
    case "add-tier": {
      const tierNumber = state.pkg.tiers.length + 1;
      state.pkg.tiers.push({
        tier: tierNumber,
        label: `Tier ${tierNumber}`,
        rosters: state.teams.filter((team) => Number(team.defaultTier) === tierNumber).map((team) => team.name),
        gold: state.pkg.goldBudget,
        skillPointBudget: state.pkg.skillAllotment.skillPointBudget,
        starPlayersAllowed: state.pkg.starPlayers.allowed,
        bannedStars: [],
      });
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
    case "toggle-matrix-cell": {
      state.pkg.matrix = matrixForDisplay();
      const row = Number(target.dataset.row);
      const col = Number(target.dataset.col);
      const index = state.pkg.matrix.cells.findIndex((cell) => cell.row === row && cell.col === col);
      if (index >= 0) state.pkg.matrix.cells.splice(index, 1);
      else state.pkg.matrix.cells.push({ col, row, teams: [] });
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
      let allowed = state.pkg.inducements.allowed;
      if (allowed.includes("*")) allowed = knownIds.filter((known) => known !== id);
      else if (allowed.includes(id)) allowed = allowed.filter((known) => known !== id);
      else allowed = [...allowed, id];
      state.pkg.inducements.allowed = allowed;
      break;
    }
    case "step-inducement": {
      const id = target.dataset.id;
      const item = INDUCEMENTS.find((row) => row.id === id);
      const current = state.pkg.inducements.caps[id] ?? item?.max ?? 0;
      state.pkg.inducements.caps[id] = Math.max(0, Math.min(9, current + Number(target.dataset.delta)));
      break;
    }
    case "toggle-insignificant": state.pkg.special.insignificantTraitConstraint = !state.pkg.special.insignificantTraitConstraint; break;
    case "toggle-stalling": state.pkg.special.stalling = !state.pkg.special.stalling; break;
    case "toggle-slann": state.pkg.special.slannAllowed = !state.pkg.special.slannAllowed; break;
    case "toggle-stat-increases": state.pkg.special.statIncreasesAllowed = !state.pkg.special.statIncreasesAllowed; break;
    case "toggle-stars-eleventh": state.pkg.special.minPlayers = Number(state.pkg.special.minPlayers) <= 10 ? 11 : 10; break;
    case "remove-banned-skill":
      state.pkg.special.bannedSkills = state.pkg.special.bannedSkills.filter((name) => name !== target.dataset.name);
      break;
    case "add-banned-skill":
      if (state.bannedSkill && !state.pkg.special.bannedSkills.includes(state.bannedSkill)) state.pkg.special.bannedSkills.push(state.bannedSkill);
      break;
    default:
      return;
  }
  markDirty();
  render();
}

function handleEditorChange(target) {
  if (!state.pkg) return;

  if (target.dataset.control === "override-skill") {
    state.overrideSkill = target.value;
    return;
  }
  if (target.dataset.control === "override-cost") {
    state.overrideCost = numberOr(target.value, 2);
    return;
  }
  if (target.dataset.control === "banned-skill") {
    state.bannedSkill = target.value;
    return;
  }

  if (target.dataset.tierIndex != null) {
    const tier = state.pkg.tiers[Number(target.dataset.tierIndex)];
    if (!tier) return;
    const field = target.dataset.tierField;
    if (field === "tier") tier.tier = numberOr(target.value, tier.tier ?? 1);
    if (field === "label") tier.label = target.value;
    if (field === "rosters") tier.rosters = target.value.split(",").map((value) => value.trim()).filter(Boolean);
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
  const allotmentFields = new Set(["skillPointBudget", "primaryCostSP", "secondaryMultiplier", "eliteSurchargeSP", "maxPerPlayer"]);
  if (field === "name" || field === "date" || field === "description" || field === "extends") state.pkg[field] = target.value;
  else if (field === "goldBudgetK") state.pkg.goldBudget = kToGold(target.value);
  else if (allotmentFields.has(field)) state.pkg.skillAllotment[field] = nullableNumber(target.value);
  else if (field === "maxSameSkillTeamwide") state.pkg.skillAllotment.maxSameSkillTeamwide = numberOr(target.value, 0) === 0 ? null : numberOr(target.value, null);
  else if (field === "maxPrimary" || field === "maxSecondary") state.pkg.skillAllotment[field] = numberOr(target.value, 0);
  else if (field === "swapRate") state.view.swapRate = Math.max(1, numberOr(target.value, 2));
  else if (field === "starMaxCount") state.pkg.starPlayers.maxCount = nullableNumber(target.value);
  else if (field === "starMaxCostK") state.pkg.starPlayers.maxCombinedCost = kToGold(target.value);
  markDirty();
  render();
}

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    state.token = result.token;
    state.account = username;
    state.loginUser = "";
    state.expiresAt = result.expiresAt;
    state.problems = [];
  } catch (error) {
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
  state.token = null;
  state.account = "";
  state.expiresAt = "";
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
    loadPackageIntoEditor(result.pkg, result.problems);
  } catch (error) {
    state.problems = [serverMessage(error)];
  } finally {
    state.busy = false;
    render();
  }
}

function loadPreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  state.selectedPackage = "";
  loadPackageIntoEditor(preset.pkg, []);
}

async function savePackage() {
  if (!state.token || state.busy) return;
  state.busy = true;
  state.saved = null;
  state.exported = false;
  render();
  try {
    const result = await requestJson("/api/packages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.token}`,
      },
      body: JSON.stringify(serializePackage()),
    });
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
    state.problems = [serverMessage(error)];
    if (error.status === 401) {
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
      headers: { "Content-Type": "application/json" },
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

toolbar.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "login") login();
  if (target.dataset.action === "logout") logout();
});

toolbar.addEventListener("change", (event) => {
  const target = event.target;
  if (target.dataset.action === "select-package") loadSavedPackage(target.value);
  if (target.dataset.action === "select-preset") loadPreset(target.value);
});

toolbar.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !state.token) login();
});

editor.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (target) handleEditorAction(target.dataset.action, target);
});

editor.addEventListener("change", (event) => handleEditorChange(event.target));

editor.addEventListener("dragstart", (event) => {
  const star = event.target.closest("[data-star]")?.dataset.star;
  if (!star) return;
  state.dragStar = star;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", star);
});

editor.addEventListener("dragover", (event) => {
  const zone = event.target.closest("[data-drop-zone]");
  if (!zone) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  zone.classList.add("drag-over");
});

editor.addEventListener("dragleave", (event) => {
  const zone = event.target.closest("[data-drop-zone]");
  if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("drag-over");
});

editor.addEventListener("drop", (event) => {
  const zone = event.target.closest("[data-drop-zone]");
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove("drag-over");
  const name = event.dataTransfer.getData("text/plain") || state.dragStar;
  state.dragStar = "";
  if (name) moveStar(name, zone.dataset.dropZone);
});

rightRail.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "save") savePackage();
  if (action === "export") exportPackage();
});

async function initialize() {
  render();
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
  state.bannedSkill = state.skills[0]?.name ?? "";

  if (state.packageNames.length) {
    await loadSavedPackage(state.packageNames[0]);
  } else if (state.presets.length) {
    loadPreset(state.presets[0].id);
  } else {
    state.pkg = fallbackPackage();
    state.view = inferView(state.pkg);
    render();
  }
}

initialize();
