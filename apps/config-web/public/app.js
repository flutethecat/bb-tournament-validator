"use strict";

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json());

// ---- in-memory config state ----
const state = {
  skills: { elite: [], general: [] }, // catalog from dataset (default grouping)
  eliteSet: [], // effective elite membership (skill names)
  skillCostSP: {}, // per-skill overrides
  filter: "",
};

// ---- tabs ----
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "coaches") loadCoaches();
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
  };
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
}

// ---- save ----
$("btn-save").addEventListener("click", async () => {
  const status = $("save-status");
  const pkg = formToPackage();
  if (!pkg.name) { status.className = "status err"; status.textContent = "Name is required."; return; }
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
});

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

// ---- boot ----
(async function boot() {
  state.skills = await api("/api/skills");
  state.eliteSet = state.skills.elite.map((s) => s.name); // dataset default elite membership
  toggleEliteWrap();
  renderSkills();
  await loadPresets();
  await loadPackages();
})();
