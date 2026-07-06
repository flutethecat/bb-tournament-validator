"use strict";

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json());

// ---- in-memory config state ----
const state = {
  skills: { elite: [], general: [] }, // catalog from dataset (default grouping)
  eliteSet: [], // effective elite membership (skill names)
  skillCostSP: {}, // per-skill overrides
  filter: "",
  // tiers
  teams: [], // [{name, defaultTier}]
  stars: [], // [{name, teams, cost}]
  tiersEnabled: false,
  tierCount: 3,
  assign: {}, // team name -> tier number (0/undefined = pool)
  tierData: {}, // tier number -> { label, gold, starsAllowed, banned: [] }
  // global bans / team rules / matrix
  bannedGlobal: [],
  teamRules: {}, // team -> { gold, primary, secondary, swap, stars: 'inherit'|'yes'|'no', banned: [] }
  matrix: { enabled: false, columns: [], rows: [], assign: {} }, // assign: team -> "row,col"
  trFilter: "",
  // exactly one advanced config mode is active at a time
  mode: "flat", // 'flat' | 'tiers' | 'matrix' | 'teamrules'
};

function parseGoldClient(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/,/g, "");
  if (s === "") return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*m$/); if (m) return Math.round(parseFloat(m[1]) * 1e6);
  m = s.match(/^(\d+(?:\.\d+)?)\s*k$/); if (m) return Math.round(parseFloat(m[1]) * 1e3);
  m = s.match(/^(\d+(?:\.\d+)?)$/); if (!m) return null;
  const n = parseFloat(m[1]);
  if (s.includes(".")) return Math.round(n * 1e6);
  if (n >= 100000) return Math.round(n);
  return Math.round(n * 1e3);
}
const emptyTR = () => ({ gold: "", primary: "", secondary: "", swap: false, stars: "inherit", banned: [] });

// ---- tabs ----
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "coaches") loadCoaches();
    if (btn.dataset.view === "tiers") renderTiers();
    if (btn.dataset.view === "matrix") renderMatrix();
    if (btn.dataset.view === "teamrules") renderTeamRules();
  });
});

// ---- SP cost helper (mirrors @bb/validator costSP for a primary-access skill) ----
function eliteOn() {
  return $("f-elite-on").checked;
}
function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}
function costFor(skill, isElite) {
  if (skill in state.skillCostSP) return state.skillCostSP[skill];
  const primary = num("f-sp-primary", 1);
  const surcharge = isElite && eliteOn() ? num("f-sp-elite", 1) : 0;
  return primary + surcharge;
}

// ---- render skill lists ----
function renderSkills() {
  const filter = state.filter.toLowerCase();
  const eliteNames = new Set(state.eliteSet.map((s) => s.toLowerCase()));
  const all = [...state.skills.elite, ...state.skills.general];
  const elite = [];
  const general = [];
  for (const s of all) {
    if (filter && !s.name.toLowerCase().includes(filter)) continue;
    (eliteNames.has(s.name.toLowerCase()) ? elite : general).push(s);
  }
  $("skills-elite").innerHTML = elite.map((s) => skillRow(s, true)).join("");
  $("skills-general").innerHTML = general.map((s) => skillRow(s, false)).join("");
  $("elite-count").textContent = `${elite.length}`;
  $("general-count").textContent = `${general.length}`;
  wireSkillRows();
}

function skillRow(s, isElite) {
  const overridden = s.name in state.skillCostSP;
  const cost = costFor(s.name, isElite);
  return `<div class="skill-row ${overridden ? "overridden" : ""}" data-skill="${esc(s.name)}">
    <div><div class="sk-name">${esc(s.name)}</div><div class="sk-cat">${esc(s.category)}</div></div>
    <label class="sk-elite"><input type="checkbox" class="sk-elite-cb" ${isElite ? "checked" : ""} /> Elite</label>
    <input type="number" min="0" class="sk-override" placeholder="${cost}" value="${overridden ? s.name in state.skillCostSP ? state.skillCostSP[s.name] : "" : ""}" title="Custom SP cost (blank = default ${cost})" />
    <div class="sk-cost">${cost} SP</div>
  </div>`;
}

function wireSkillRows() {
  document.querySelectorAll(".skill-row").forEach((row) => {
    const skill = row.dataset.skill;
    row.querySelector(".sk-elite-cb").addEventListener("change", (e) => {
      const set = new Set(state.eliteSet);
      if (e.target.checked) set.add(skill);
      else set.delete(skill);
      state.eliteSet = [...set];
      renderSkills();
    });
    row.querySelector(".sk-override").addEventListener("change", (e) => {
      const v = e.target.value.trim();
      if (v === "") delete state.skillCostSP[skill];
      else state.skillCostSP[skill] = parseFloat(v);
      renderSkills();
    });
  });
}

// recompute displayed costs when SP knobs change
["f-sp-primary", "f-sp-elite", "f-elite-on"].forEach((id) =>
  document.addEventListener("change", (e) => { if (e.target.id === id) { toggleEliteWrap(); renderSkills(); } }),
);
$("skill-filter").addEventListener("input", (e) => { state.filter = e.target.value; renderSkills(); });

function toggleEliteWrap() {
  $("f-elite-wrap").style.display = eliteOn() ? "" : "none";
}

// ---- form <-> package object ----
function optNum(id) {
  const v = $(id).value.trim();
  return v === "" ? null : parseFloat(v);
}
function formToPackage() {
  const rosters = $("f-rosters").value.trim();
  return {
    name: $("f-name").value.trim(),
    date: $("f-date").value || undefined,
    description: $("f-desc").value.trim() || undefined,
    eligibleRosters: rosters === "" || rosters === "*" ? ["*"] : rosters.split(",").map((s) => s.trim()).filter(Boolean),
    skillAllotment: {
      skillPointBudget: num("f-sp-budget", 0),
      primaryCostSP: num("f-sp-primary", 1),
      secondaryMultiplier: num("f-sp-secmult", 2),
      eliteSurchargeSP: eliteOn() ? num("f-sp-elite", 1) : 0,
      eliteSkills: state.eliteSet,
      skillCostSP: state.skillCostSP,
      maxPerPlayer: optNum("f-sp-maxplayer"),
      maxSameSkillTeamwide: optNum("f-sp-maxstack"),
    },
    goldBudget: $("f-gold").value.trim() === "" ? null : num("f-gold", 0) * 1000,
    starPlayers: {
      allowed: $("f-stars").checked,
      maxCount: optNum("f-star-max"),
      maxCombinedCost: $("f-star-cost").value.trim() === "" ? null : num("f-star-cost", 0) * 1000,
    },
    inducements: { allowed: ["*"], caps: {} },
    sideline: {
      maxReRolls: optNum("f-max-rr"),
      maxApothecary: optNum("f-max-apo"),
      maxCheerleaders: optNum("f-max-chr"),
      maxAssistantCoaches: optNum("f-max-coach"),
      maxDedicatedFans: optNum("f-max-fans"),
    },
    special: {
      insignificantTraitConstraint: $("f-insig").checked,
      stalling: true,
      slannAllowed: $("f-slann").checked,
      statIncreasesAllowed: $("f-stat").checked,
      bannedSkills: [],
      minPlayers: num("f-minplayers", 11),
    },
    ...(state.mode === "tiers" ? { tiers: buildTiers() } : {}),
    ...(state.mode === "matrix" ? { matrix: buildMatrix() } : {}),
    ...(state.mode === "teamrules" && buildTeamRules().length ? { teamRules: buildTeamRules() } : {}),
    ...(state.bannedGlobal.length ? { bannedStars: state.bannedGlobal } : {}),
  };
}

function buildTeamRules() {
  const rules = [];
  for (const [team, d] of Object.entries(state.teamRules)) {
    const rule = { team };
    const gold = parseGoldClient(d.gold);
    if (gold != null) rule.gold = gold;
    if (d.primary !== "" && d.primary != null) rule.maxPrimary = Number(d.primary);
    if (d.secondary !== "" && d.secondary != null) rule.maxSecondary = Number(d.secondary);
    if (d.swap) rule.secondarySwap = true;
    if (d.stars === "yes") rule.starPlayersAllowed = true;
    if (d.stars === "no") rule.starPlayersAllowed = false;
    if (d.banned && d.banned.length) rule.bannedStars = d.banned;
    if (Object.keys(rule).length > 1) rules.push(rule); // more than just {team}
  }
  return rules;
}

function buildMatrix() {
  const columns = state.matrix.columns.map((c) => ({ gold: parseGoldClient(c.gold) || 0 }));
  const rows = state.matrix.rows.map((r) => ({
    ...(r.label ? { label: r.label } : {}),
    primary: Number(r.primary) || 0,
    secondary: Number(r.secondary) || 0,
    secondarySwap: !!r.swap,
  }));
  const byCell = {};
  for (const [team, rc] of Object.entries(state.matrix.assign)) {
    const [row, col] = rc.split(",").map(Number);
    if (row >= rows.length || col >= columns.length) continue;
    (byCell[rc] ??= { row, col, teams: [] }).teams.push(team);
  }
  return { columns, rows, cells: Object.values(byCell) };
}

function buildTiers() {
  const tiers = [];
  for (let t = 1; t <= state.tierCount; t++) {
    const d = state.tierData[t] || {};
    tiers.push({
      tier: t,
      ...(d.label ? { label: d.label } : {}),
      rosters: state.teams.filter((tm) => (state.assign[tm.name] || 0) === t).map((tm) => tm.name),
      gold: d.gold != null && d.gold !== "" ? Number(d.gold) * 1000 : null,
      skillPointBudget: d.sp != null && d.sp !== "" ? Number(d.sp) : null,
      starPlayersAllowed: d.starsAllowed !== false,
      bannedStars: d.banned || [],
    });
  }
  return tiers;
}

function packageToForm(p) {
  const sa = p.skillAllotment || {};
  $("f-name").value = p.name || "";
  $("f-date").value = p.date || "";
  $("f-desc").value = p.description || "";
  $("f-rosters").value = (p.eligibleRosters || ["*"]).join(", ");
  $("f-sp-budget").value = sa.skillPointBudget ?? 0;
  $("f-sp-primary").value = sa.primaryCostSP ?? 1;
  $("f-sp-secmult").value = sa.secondaryMultiplier ?? 2;
  $("f-sp-maxplayer").value = sa.maxPerPlayer ?? "";
  $("f-sp-maxstack").value = sa.maxSameSkillTeamwide ?? "";
  const surcharge = sa.eliteSurchargeSP ?? 1;
  $("f-elite-on").checked = surcharge > 0;
  $("f-sp-elite").value = surcharge > 0 ? surcharge : 1;
  state.eliteSet = [...(sa.eliteSkills || [])];
  state.skillCostSP = { ...(sa.skillCostSP || {}) };
  $("f-gold").value = p.goldBudget != null ? p.goldBudget / 1000 : "";
  $("f-stars").checked = !!(p.starPlayers && p.starPlayers.allowed);
  $("f-star-max").value = p.starPlayers?.maxCount ?? 0;
  $("f-star-cost").value = p.starPlayers?.maxCombinedCost != null ? p.starPlayers.maxCombinedCost / 1000 : "";
  $("f-max-rr").value = p.sideline?.maxReRolls ?? "";
  $("f-max-apo").value = p.sideline?.maxApothecary ?? "";
  $("f-max-chr").value = p.sideline?.maxCheerleaders ?? "";
  $("f-max-coach").value = p.sideline?.maxAssistantCoaches ?? "";
  $("f-max-fans").value = p.sideline?.maxDedicatedFans ?? "";
  $("f-minplayers").value = p.special?.minPlayers ?? 11;
  $("f-insig").checked = p.special?.insignificantTraitConstraint !== false;
  $("f-stat").checked = !!p.special?.statIncreasesAllowed;
  $("f-slann").checked = !!p.special?.slannAllowed;
  toggleEliteWrap();
  renderSkills();
  applyTiers(p.tiers);
  // global bans
  state.bannedGlobal = [...(p.bannedStars || [])];
  renderGlobalBans();
  // team rules
  state.teamRules = {};
  for (const tr of p.teamRules || []) {
    state.teamRules[tr.team] = {
      gold: tr.gold != null ? tr.gold / 1000 : "",
      primary: tr.maxPrimary ?? "",
      secondary: tr.maxSecondary ?? "",
      swap: !!tr.secondarySwap,
      stars: tr.starPlayersAllowed === true ? "yes" : tr.starPlayersAllowed === false ? "no" : "inherit",
      banned: [...(tr.bannedStars || [])],
    };
  }
  // matrix
  applyMatrix(p.matrix);
  // exclusive mode: pick one by precedence (legacy packages may carry several)
  state.mode = p.matrix ? "matrix" : (p.tiers && p.tiers.length) ? "tiers" : (p.teamRules && p.teamRules.length) ? "teamrules" : "flat";
  state.tiersEnabled = state.mode === "tiers";
  state.matrix.enabled = state.mode === "matrix";
  syncModeUI();
  renderTiers();
  renderMatrix();
  renderTeamRules();
}

// ---- global bans ----
function renderGlobalBans() {
  $("g-banned").innerHTML = state.bannedGlobal.map((s) => bannedTagG(s)).join("");
  document.querySelectorAll("#g-banned .banned-tag button").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      state.bannedGlobal = state.bannedGlobal.filter((s) => s !== e.target.dataset.star);
      renderGlobalBans();
      renderTeamRules();
    }),
  );
}
const bannedTagG = (s) => `<span class="banned-tag">${esc(s)}<button data-star="${esc(s)}" title="remove">×</button></span>`;
$("g-banadd").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const v = e.target.value.trim();
  if (v && !state.bannedGlobal.includes(v)) state.bannedGlobal.push(v);
  e.target.value = "";
  renderGlobalBans();
  renderTeamRules();
});

// ---- team rules ----
function renderTeamRules() {
  const active = state.mode === "teamrules";
  if ($("teamrules-wrap")) $("teamrules-wrap").hidden = !active;
  if ($("teamrules-disabled-note")) $("teamrules-disabled-note").hidden = active;
  if (!active) return;
  const tbody = document.querySelector("#teamrules-table tbody");
  const filter = state.trFilter.toLowerCase();
  tbody.innerHTML = state.teams
    .filter((tm) => !filter || tm.name.toLowerCase().includes(filter))
    .map((tm) => {
      const d = state.teamRules[tm.name] || emptyTR();
      const inherited = state.bannedGlobal;
      return `<tr data-team="${esc(tm.name)}">
        <td>${esc(tm.name)}</td>
        <td><input class="tr-gold" data-f="gold" type="text" value="${esc(d.gold)}" placeholder="inherit" /></td>
        <td><input data-f="primary" type="number" min="0" value="${esc(d.primary)}" placeholder="—" /></td>
        <td><input data-f="secondary" type="number" min="0" value="${esc(d.secondary)}" placeholder="—" /></td>
        <td style="text-align:center"><input data-f="swap" type="checkbox" ${d.swap ? "checked" : ""} /></td>
        <td><select data-f="stars"><option value="inherit"${d.stars === "inherit" ? " selected" : ""}>inherit</option><option value="yes"${d.stars === "yes" ? " selected" : ""}>allow</option><option value="no"${d.stars === "no" ? " selected" : ""}>ban</option></select></td>
        <td class="tr-bans-cell">
          <input class="tr-baninput star-ac" data-f="banadd" type="text" placeholder="ban a star + Enter" />
          <div class="banned-tags">${d.banned.map((s) => `<span class="banned-tag">${esc(s)}<button data-f="banrm" data-star="${esc(s)}">×</button></span>`).join("")}</div>
          ${inherited.length ? `<div class="tr-inherited">+ global: ${inherited.map(esc).join(", ")}</div>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  wireTeamRules();
}

function trOf(team) {
  return (state.teamRules[team] ??= emptyTR());
}
function wireTeamRules() {
  document.querySelectorAll("#teamrules-table tbody tr").forEach((tr) => {
    const team = tr.dataset.team;
    tr.querySelectorAll("input, select").forEach((el) => {
      const f = el.dataset.f;
      if (f === "banadd") {
        el.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const v = e.target.value.trim();
          const d = trOf(team);
          if (v && !d.banned.includes(v)) d.banned.push(v);
          e.target.value = "";
          renderTeamRules();
        });
      } else if (f === "banrm") {
        el.addEventListener("click", (e) => {
          const d = trOf(team);
          d.banned = d.banned.filter((s) => s !== e.target.dataset.star);
          renderTeamRules();
        });
      } else if (f === "swap") {
        el.addEventListener("change", (e) => { trOf(team).swap = e.target.checked; });
      } else {
        el.addEventListener("input", (e) => { trOf(team)[f] = e.target.value; });
        el.addEventListener("change", (e) => { trOf(team)[f] = e.target.value; });
      }
    });
  });
}
$("tr-filter").addEventListener("input", (e) => { state.trFilter = e.target.value; renderTeamRules(); });

// ---- matrix ----
function applyMatrix(m) {
  state.matrix = { enabled: false, columns: [], rows: [], assign: {} };
  if (m && (m.columns?.length || m.rows?.length)) {
    state.matrix.enabled = true;
    state.matrix.columns = (m.columns || []).map((c) => ({ gold: c.gold != null ? String(c.gold / 1000) : "" }));
    state.matrix.rows = (m.rows || []).map((r) => ({ label: r.label || "", primary: r.primary, secondary: r.secondary, swap: !!r.secondarySwap }));
    for (const cell of m.cells || []) for (const t of cell.teams) state.matrix.assign[t] = `${cell.row},${cell.col}`;
  } else {
    state.matrix.columns = [{ gold: "" }];
    state.matrix.rows = [{ label: "", primary: 6, secondary: 0, swap: false }];
  }
  $("m-enabled").checked = state.matrix.enabled;
  renderMatrix();
}

function renderMatrix() {
  $("matrix-area").hidden = !state.matrix.enabled;
  $("matrix-disabled-note").hidden = state.matrix.enabled;
  if (!state.matrix.enabled) return;
  const { columns: cols, rows } = state.matrix;
  const valid = (rc) => { const [r, c] = rc.split(",").map(Number); return r < rows.length && c < cols.length; };
  const assigned = new Set(Object.keys(state.matrix.assign).filter((t) => valid(state.matrix.assign[t])));
  const pool = state.teams.filter((tm) => !assigned.has(tm.name));
  $("m-pool").innerHTML = pool.map((tm) => teamChip(tm.name)).join("");
  $("m-pool-count").textContent = String(pool.length);

  const teamsIn = (r, c) => state.teams.filter((tm) => state.matrix.assign[tm.name] === `${r},${c}`).map((tm) => teamChip(tm.name)).join("");
  let html = "<tr><th class='mx-corner'></th>";
  cols.forEach((col, c) => {
    html += `<th class="mx-colhead"><button class="mx-del" data-delcol="${c}" title="remove column">✕</button><input class="mx-gold" data-c="${c}" type="text" value="${esc(col.gold)}" placeholder="cash e.g. 1150" /></th>`;
  });
  html += "</tr>";
  rows.forEach((row, r) => {
    html += `<tr><th class="mx-rowhead"><button class="mx-del" data-delrow="${r}" title="remove row">✕</button>
      <input class="mx-label" data-r="${r}" type="text" value="${esc(row.label)}" placeholder="row label" />
      <div class="mx-row-nums">
        <label class="mx-num"><span>Primary</span><input class="mx-prim" data-r="${r}" type="number" min="0" value="${esc(row.primary)}" /></label>
        <label class="mx-num"><span>Secondary</span><input class="mx-sec" data-r="${r}" type="number" min="0" value="${esc(row.secondary)}" /></label>
      </div>
      <label class="mx-swap"><input class="mx-swapcb" data-r="${r}" type="checkbox" ${row.swap ? "checked" : ""} /> secondary swap</label></th>`;
    cols.forEach((_, c) => {
      html += `<td class="mx-cell"><div class="team-drop mx-drop" data-cell="${r},${c}">${teamsIn(r, c)}</div></td>`;
    });
    html += "</tr>";
  });
  $("matrix-table").innerHTML = html;
  wireMatrix();
}

function wireMatrix() {
  document.querySelectorAll(".mx-gold").forEach((el) => el.addEventListener("input", (e) => { state.matrix.columns[+e.target.dataset.c].gold = e.target.value; }));
  document.querySelectorAll(".mx-label").forEach((el) => el.addEventListener("input", (e) => { state.matrix.rows[+e.target.dataset.r].label = e.target.value; }));
  document.querySelectorAll(".mx-prim").forEach((el) => el.addEventListener("input", (e) => { state.matrix.rows[+e.target.dataset.r].primary = e.target.value; }));
  document.querySelectorAll(".mx-sec").forEach((el) => el.addEventListener("input", (e) => { state.matrix.rows[+e.target.dataset.r].secondary = e.target.value; }));
  document.querySelectorAll(".mx-swapcb").forEach((el) => el.addEventListener("change", (e) => { state.matrix.rows[+e.target.dataset.r].swap = e.target.checked; }));
  document.querySelectorAll("[data-delcol]").forEach((el) => el.addEventListener("click", (e) => removeMatrixCol(+e.target.dataset.delcol)));
  document.querySelectorAll("[data-delrow]").forEach((el) => el.addEventListener("click", (e) => removeMatrixRow(+e.target.dataset.delrow)));
  wireMatrixDnD();
}

function wireMatrixDnD() {
  let dragged = null;
  document.querySelectorAll("#view-matrix .team-chip").forEach((chip) => {
    chip.addEventListener("dragstart", () => { dragged = chip.dataset.team; chip.classList.add("dragging"); });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  });
  document.querySelectorAll("#view-matrix .team-drop").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("dragover");
      if (!dragged) return;
      if (zone.dataset.cell === "pool") delete state.matrix.assign[dragged];
      else state.matrix.assign[dragged] = zone.dataset.cell;
      dragged = null;
      renderMatrix();
    });
  });
}

function removeMatrixCol(c) {
  state.matrix.columns.splice(c, 1);
  const next = {};
  for (const [t, rc] of Object.entries(state.matrix.assign)) {
    let [r, cc] = rc.split(",").map(Number);
    if (cc === c) continue; // team's column removed -> back to pool
    if (cc > c) cc--;
    next[t] = `${r},${cc}`;
  }
  state.matrix.assign = next;
  renderMatrix();
}
function removeMatrixRow(r) {
  state.matrix.rows.splice(r, 1);
  const next = {};
  for (const [t, rc] of Object.entries(state.matrix.assign)) {
    let [rr, c] = rc.split(",").map(Number);
    if (rr === r) continue;
    if (rr > r) rr--;
    next[t] = `${rr},${c}`;
  }
  state.matrix.assign = next;
  renderMatrix();
}

$("m-enabled").addEventListener("change", (e) => setMode(e.target.checked ? "matrix" : "flat"));
$("m-addcol").addEventListener("click", () => { state.matrix.columns.push({ gold: "" }); renderMatrix(); });
$("m-addrow").addEventListener("click", () => { state.matrix.rows.push({ label: "", primary: 6, secondary: 0, swap: false }); renderMatrix(); });
$("btn-save-matrix").addEventListener("click", () => savePackage($("matrix-save-status")));
$("btn-save-teamrules").addEventListener("click", () => savePackage($("tr-save-status")));

// ---- exclusive mode switching (Tiers / Matrix / Team Rules) ----
// Read the effective per-team config from whatever mode is currently active.
function deriveCurrent() {
  const out = {};
  if (state.mode === "tiers") {
    for (let t = 1; t <= state.tierCount; t++) {
      const d = state.tierData[t] || {};
      for (const tm of state.teams)
        if ((state.assign[tm.name] || 0) === t)
          out[tm.name] = { gold: d.gold, sp: d.sp, stars: d.starsAllowed === false ? "no" : "inherit", banned: [...(d.banned || [])] };
    }
  } else if (state.mode === "matrix") {
    for (const [team, rc] of Object.entries(state.matrix.assign)) {
      const [r, c] = rc.split(",").map(Number);
      const row = state.matrix.rows[r], col = state.matrix.columns[c];
      if (!row || !col) continue;
      out[team] = { gold: col.gold, primary: row.primary, secondary: row.secondary, swap: !!row.swap, banned: [] };
    }
  } else if (state.mode === "teamrules") {
    for (const [team, d] of Object.entries(state.teamRules))
      out[team] = { gold: d.gold, primary: d.primary, secondary: d.secondary, swap: d.swap, stars: d.stars, banned: [...(d.banned || [])] };
  }
  return out;
}

function buildTeamRulesFrom(d) {
  state.teamRules = {};
  for (const [team, v] of Object.entries(d)) {
    const tr = emptyTR();
    if (v.gold != null && v.gold !== "") tr.gold = String(v.gold);
    if (v.primary != null && v.primary !== "") tr.primary = String(v.primary);
    if (v.secondary != null && v.secondary !== "") tr.secondary = String(v.secondary);
    if (v.swap) tr.swap = true;
    tr.stars = v.stars === "yes" ? "yes" : v.stars === "no" ? "no" : "inherit";
    if (v.banned) tr.banned = [...v.banned];
    state.teamRules[team] = tr;
  }
}

function buildMatrixFrom(d) {
  const entries = Object.entries(d);
  const golds = [...new Set(entries.map(([, v]) => String(v.gold ?? "")).filter((g) => g !== ""))];
  const rowKeys = [...new Set(entries.map(([, v]) => `${v.primary ?? 0}|${v.secondary ?? 0}|${v.swap ? 1 : 0}`))];
  state.matrix.columns = (golds.length ? golds : [""]).map((g) => ({ gold: g }));
  state.matrix.rows = (rowKeys.length ? rowKeys : ["0|0|0"]).map((k) => { const [p, s, sw] = k.split("|"); return { label: "", primary: Number(p), secondary: Number(s), swap: sw === "1" }; });
  state.matrix.assign = {};
  for (const [team, v] of entries) {
    const c = golds.indexOf(String(v.gold ?? ""));
    const r = rowKeys.indexOf(`${v.primary ?? 0}|${v.secondary ?? 0}|${v.swap ? 1 : 0}`);
    if (c >= 0 && r >= 0) state.matrix.assign[team] = `${r},${c}`;
  }
}

function buildTiersFrom(d) {
  const entries = Object.entries(d);
  if (entries.length === 0) {
    // from flat: seed suggested default tiers
    state.tierCount = 3;
    ensureTierData();
    state.assign = {};
    for (const tm of state.teams) state.assign[tm.name] = Math.min(tm.defaultTier, state.tierCount);
    return;
  }
  const groups = new Map();
  for (const [team, v] of entries) {
    const key = `${v.gold ?? ""}|${v.sp ?? ""}|${v.stars ?? ""}|${(v.banned || []).join(",")}`;
    if (!groups.has(key)) groups.set(key, { v, teams: [] });
    groups.get(key).teams.push(team);
  }
  state.tierCount = Math.max(1, groups.size);
  state.tierData = {};
  ensureTierData();
  state.assign = {};
  let t = 1;
  for (const { v, teams } of groups.values()) {
    state.tierData[t] = { label: "", gold: v.gold ?? "", sp: v.sp ?? "", starsAllowed: v.stars !== "no", banned: [...(v.banned || [])] };
    for (const tm of teams) state.assign[tm] = t;
    t++;
  }
}

function setMode(newMode) {
  if (newMode === state.mode) return;
  const derived = deriveCurrent();
  // clear every advanced mode
  state.tiersEnabled = false;
  state.matrix.enabled = false;
  state.matrix.assign = {};
  state.teamRules = {};
  state.mode = newMode;
  if (newMode === "tiers") { state.tiersEnabled = true; buildTiersFrom(derived); }
  else if (newMode === "matrix") { state.matrix.enabled = true; buildMatrixFrom(derived); if (!state.matrix.columns.length) state.matrix.columns = [{ gold: "" }]; if (!state.matrix.rows.length) state.matrix.rows = [{ label: "", primary: 6, secondary: 0, swap: false }]; }
  else if (newMode === "teamrules") buildTeamRulesFrom(derived);
  syncModeUI();
  renderTiers();
  renderMatrix();
  renderTeamRules();
}

function syncModeUI() {
  $("t-enabled").checked = state.mode === "tiers";
  $("m-enabled").checked = state.mode === "matrix";
  if ($("tr-enabled")) $("tr-enabled").checked = state.mode === "teamrules";
}
$("tr-enabled").addEventListener("change", (e) => setMode(e.target.checked ? "teamrules" : "flat"));

// ---- tiers: state application + rendering ----
function applyTiers(tiers) {
  state.assign = {};
  state.tierData = {};
  if (tiers && tiers.length) {
    state.tiersEnabled = true;
    state.tierCount = Math.max(...tiers.map((t) => t.tier));
    for (const t of tiers) {
      state.tierData[t.tier] = {
        label: t.label || "",
        gold: t.gold != null ? t.gold / 1000 : "",
        sp: t.skillPointBudget != null ? t.skillPointBudget : "",
        starsAllowed: t.starPlayersAllowed !== false,
        banned: [...(t.bannedStars || [])],
      };
      for (const r of t.rosters) state.assign[r] = t.tier;
    }
  } else {
    state.tiersEnabled = false;
    state.tierCount = 3;
    // seed assignment from suggested default tiers (clamped)
    for (const tm of state.teams) state.assign[tm.name] = Math.min(tm.defaultTier, state.tierCount);
  }
  $("t-enabled").checked = state.tiersEnabled;
  ensureTierData();
  renderTiers();
}

function ensureTierData() {
  for (let t = 1; t <= state.tierCount; t++) {
    if (!state.tierData[t]) state.tierData[t] = { label: "", gold: "", sp: "", starsAllowed: true, banned: [] };
  }
}

function renderTiers() {
  $("tiers-area").hidden = !state.tiersEnabled;
  $("tiers-disabled-note").hidden = state.tiersEnabled;
  $("tier-count-val").textContent = String(state.tierCount);
  if (!state.tiersEnabled) return;

  // pool
  const pool = state.teams.filter((tm) => !((state.assign[tm.name] || 0) >= 1 && state.assign[tm.name] <= state.tierCount));
  $("team-pool").innerHTML = pool.map((tm) => teamChip(tm.name)).join("");
  $("pool-count").textContent = String(pool.length);

  // tier columns
  $("tier-columns").innerHTML = "";
  for (let t = 1; t <= state.tierCount; t++) {
    const d = state.tierData[t];
    const members = state.teams.filter((tm) => (state.assign[tm.name] || 0) === t);
    const col = document.createElement("div");
    col.className = "card tier-card";
    col.innerHTML = `
      <h2><span>Tier ${t}</span><span class="tier-badge">${members.length} teams</span></h2>
      <label>Label<input class="t-label" data-t="${t}" type="text" value="${esc(d.label)}" placeholder="e.g. Tier ${t}" /></label>
      <label>Gold budget (k)<input class="t-gold" data-t="${t}" type="number" min="0" value="${esc(d.gold)}" placeholder="none" /></label>
      <label>Skill-Point budget<input class="t-sp" data-t="${t}" type="number" min="0" value="${esc(d.sp)}" placeholder="package default" /></label>
      <label class="switch"><input class="t-stars" data-t="${t}" type="checkbox" ${d.starsAllowed ? "checked" : ""} /><span>Allow Star Players</span></label>
      <label>Ban a star (type + Enter)<input class="t-banadd star-ac" data-t="${t}" type="text" placeholder="Star name…" /></label>
      <div class="banned-tags" data-t="${t}">${d.banned.map((s) => bannedTag(t, s)).join("")}</div>
      <div class="team-drop" data-tier="${t}">${members.map((tm) => teamChip(tm.name)).join("")}</div>`;
    $("tier-columns").appendChild(col);
  }
  wireTierControls();
  wireDnD();
}

const teamChip = (name) => `<div class="team-chip" draggable="true" data-team="${esc(name)}">${esc(name)}</div>`;
const bannedTag = (t, s) => `<span class="banned-tag">${esc(s)}<button data-t="${t}" data-star="${esc(s)}" title="remove">×</button></span>`;

function wireTierControls() {
  document.querySelectorAll(".t-label").forEach((el) =>
    el.addEventListener("input", (e) => { state.tierData[+e.target.dataset.t].label = e.target.value; }),
  );
  document.querySelectorAll(".t-gold").forEach((el) =>
    el.addEventListener("input", (e) => { state.tierData[+e.target.dataset.t].gold = e.target.value; }),
  );
  document.querySelectorAll(".t-sp").forEach((el) =>
    el.addEventListener("input", (e) => { state.tierData[+e.target.dataset.t].sp = e.target.value; }),
  );
  document.querySelectorAll(".t-stars").forEach((el) =>
    el.addEventListener("change", (e) => { state.tierData[+e.target.dataset.t].starsAllowed = e.target.checked; }),
  );
  document.querySelectorAll(".t-banadd").forEach((el) =>
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const t = +e.target.dataset.t;
      const v = e.target.value.trim();
      if (v && !state.tierData[t].banned.includes(v)) state.tierData[t].banned.push(v);
      e.target.value = "";
      renderTiers();
    }),
  );
  document.querySelectorAll(".banned-tag button").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const t = +e.target.dataset.t;
      state.tierData[t].banned = state.tierData[t].banned.filter((s) => s !== e.target.dataset.star);
      renderTiers();
    }),
  );
}

function wireDnD() {
  let dragged = null;
  document.querySelectorAll(".team-chip").forEach((chip) => {
    chip.addEventListener("dragstart", (e) => {
      dragged = chip.dataset.team;
      chip.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  });
  document.querySelectorAll(".team-drop").forEach((zone) => {
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (!dragged) return;
      state.assign[dragged] = Number(zone.dataset.tier); // 0 = pool
      dragged = null;
      renderTiers();
    });
  });
}

$("t-enabled").addEventListener("change", (e) => setMode(e.target.checked ? "tiers" : "flat"));
$("tier-plus").addEventListener("click", () => { if (state.tierCount < 8) { state.tierCount++; ensureTierData(); renderTiers(); } });
$("tier-minus").addEventListener("click", () => {
  if (state.tierCount <= 1) return;
  // teams in the removed tier fall back to the pool
  for (const [team, t] of Object.entries(state.assign)) if (t === state.tierCount) state.assign[team] = 0;
  state.tierCount--;
  renderTiers();
});

// ---- save (shared by the Configure and Tiers tabs) ----
async function savePackage(status) {
  const pkg = formToPackage();
  if (!pkg.name) {
    status.className = "status err";
    status.textContent = "Set a tournament name on the Configure tab first.";
    return;
  }
  status.className = "status"; status.textContent = "Saving…";
  try {
    const res = await api("/api/packages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pkg),
    });
    if (res.error) { status.className = "status err"; status.textContent = res.error; return; }
    status.className = "status ok";
    status.textContent = `Saved "${res.name}" ✓${res.problems && res.problems.length ? ` (${res.problems.length} note)` : ""}`;
    await loadPackages();
  } catch (e) {
    status.className = "status err"; status.textContent = String(e);
  }
}
$("btn-save").addEventListener("click", () => savePackage($("save-status")));
$("btn-save-tiers").addEventListener("click", () => savePackage($("tier-save-status")));

// ---- presets & existing ----
async function loadPresets() {
  const presets = await api("/api/presets");
  $("f-preset").innerHTML = '<option value="">— choose —</option>' +
    presets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
  $("f-preset").addEventListener("change", (e) => {
    const p = presets.find((x) => x.id === e.target.value);
    if (p) packageToForm(p.pkg);
  });
}
async function loadPackages() {
  const pkgs = await api("/api/packages");
  $("f-existing").innerHTML = '<option value="">— new package —</option>' +
    pkgs.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.date ? " · " + esc(p.date) : ""}</option>`).join("");
  $("coach-filter").innerHTML = '<option value="">All packages</option>' +
    pkgs.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
}
$("f-existing").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  const res = await api(`/api/packages/${encodeURIComponent(e.target.value)}`);
  if (res.pkg) packageToForm(res.pkg);
});

// ---- coaches dashboard ----
async function loadCoaches() {
  const pkg = $("coach-filter").value;
  const rows = await api(`/api/coaches${pkg ? `?package=${encodeURIComponent(pkg)}` : ""}`);
  const tbody = document.querySelector("#coaches-table tbody");
  $("coaches-empty").hidden = rows.length > 0;
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.coachName)}</td>
        <td>${esc(r.teamName)}</td>
        <td>${esc(r.rosterRace)}</td>
        <td>${esc(r.packageName)}</td>
        <td>${esc((r.validatedAt || "").slice(0, 10))}</td>
        <td>${r.messageLink ? `<a href="${esc(r.messageLink)}" target="_blank" rel="noopener">open ↗</a>` : "—"}</td>
      </tr>`,
    )
    .join("");
}
$("coach-refresh").addEventListener("click", loadCoaches);
$("coach-filter").addEventListener("change", loadCoaches);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Attach the (large) star datalist only to the focused input. Binding one shared
// datalist to many inputs at once hangs Chrome's renderer, so we bind on demand.
document.addEventListener("focusin", (e) => {
  if (e.target.classList && e.target.classList.contains("star-ac")) e.target.setAttribute("list", "stars-list");
});
document.addEventListener("focusout", (e) => {
  if (e.target.classList && e.target.classList.contains("star-ac")) e.target.removeAttribute("list");
});

// ---- boot ----
(async function boot() {
  state.skills = await api("/api/skills");
  state.eliteSet = state.skills.elite.map((s) => s.name); // dataset default elite membership
  toggleEliteWrap();
  renderSkills();
  [state.teams, state.stars] = await Promise.all([api("/api/teams"), api("/api/stars")]);
  $("stars-list").innerHTML = state.stars.map((s) => `<option value="${esc(s.name)}"></option>`).join("");
  applyTiers(null); // seed pool/default assignment, tiers off
  applyMatrix(null);
  state.mode = "flat";
  syncModeUI();
  renderGlobalBans();
  renderTeamRules();
  await loadPresets();
  await loadPackages();
})();
