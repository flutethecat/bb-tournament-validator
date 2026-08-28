"use strict";

const state = {
  token: null,
  coach: "",
  organizer: false,
  admin: false,
  loginUser: "",
  tournaments: [],
  packages: [],
  selectedId: "",
  detail: null,
  ownTeams: [],
  registeringId: "",
  creating: false,
  busy: false,
  message: "",
  error: false,
};

const toolbar = document.querySelector("#toolbar");
const listRoot = document.querySelector("#tournament-list");
const sidePanel = document.querySelector("#side-panel");
const messageRoot = document.querySelector("#message");
const connectionState = document.querySelector("#connection-state");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function serverMessage(error) {
  if (typeof error?.serverError === "string") return error.serverError;
  if (typeof error?.message === "string") return error.message;
  return String(error);
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 204) return undefined;
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`);
    error.serverError = typeof data?.error === "string" ? data.error : undefined;
    throw error;
  }
  return data;
}

function authOptions(method = "GET", body) {
  const headers = { "X-CW-Auth": "1" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const options = { method, headers };
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body ?? {});
  }
  return options;
}

function formatLabel(format) {
  return format === "roundRobin" ? "Round-Robin" : format === "knockout" ? "Knockout" : "Swiss";
}

function canManageTournament(tournament) {
  if (state.admin) return true;
  return Boolean(state.coach && tournament?.organizerCoachId &&
    state.coach.trim().toLowerCase() === String(tournament.organizerCoachId).trim().toLowerCase());
}

// UTC wall time keeps datetime-local stable across browser time zones.
function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : "";
}

function fromDateTimeLocal(value) {
  return value ? `${value}:00.000Z` : "";
}

function packageOptions(selected) {
  const names = state.packages.map((entry) => String(entry.name ?? ""));
  const current = selected !== undefined && !names.includes(selected)
    ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected || "Legacy ruleset")}</option>`
    : "";
  return current + state.packages.map((entry) => {
    const name = String(entry.name ?? "");
    return `<option value="${escapeHtml(name)}"${name === selected ? " selected" : ""}>${escapeHtml(name)}</option>`;
  }).join("");
}

function setMessage(message, error = false) {
  state.message = message;
  state.error = error;
}

function renderToolbar() {
  if (state.coach) {
    toolbar.innerHTML = `<span class="login-status">● ${escapeHtml(state.coach)}${state.organizer ? " · organizer" : ""}</span>
      <span class="toolbar-spacer"></span>
      ${state.organizer ? '<button type="button" class="btn primary" data-action="show-create">Create Tournament</button>' : ""}
      <button type="button" class="btn" data-action="logout">Log Out</button>`;
  } else {
    toolbar.innerHTML = `<div class="login-fields">
      <label class="visually-hidden" for="login-user">Username</label>
      <input id="login-user" class="control" autocomplete="username" placeholder="Username" value="${escapeHtml(state.loginUser)}">
      <label class="visually-hidden" for="login-password">Password</label>
      <input id="login-password" class="control" type="password" autocomplete="current-password" placeholder="Password">
      <button type="button" class="btn primary" data-action="login"${state.busy ? " disabled" : ""}>Log In</button>
    </div><span class="toolbar-spacer"></span><span class="hint">Sign in to register a team.</span>`;
  }
  connectionState.textContent = state.coach ? `● signed in as ${state.coach}` : "● signed out";
  connectionState.className = state.coach ? "connected" : "disconnected";
}

function renderMessage() {
  messageRoot.innerHTML = state.message
    ? `<div class="message${state.error ? " error" : ""}">${escapeHtml(state.message)}</div>`
    : "";
}

function ownEntrant(tournamentId) {
  const summary = state.tournaments.find((tournament) => tournament.id === tournamentId);
  if (summary?.myEntrantId) return { entrantId: summary.myEntrantId, droppedAt: summary.myDroppedAt };
  if (!state.coach || state.detail?.tournament?.id !== tournamentId) return undefined;
  return safeArray(state.detail.entrants).find((entrant) =>
    String(entrant.coachId ?? entrant.coach?.ffbCoachId ?? "").localeCompare(state.coach, undefined, { sensitivity: "accent" }) === 0,
  );
}

function renderTournamentList() {
  if (!state.tournaments.length) {
    listRoot.innerHTML = '<div class="empty">No tournaments are available.</div>';
    return;
  }
  listRoot.innerHTML = state.tournaments.map((tournament) => {
    const cap = Number(tournament.maxPlayers) === 0 ? "uncapped" : escapeHtml(tournament.maxPlayers);
    const selected = tournament.id === state.selectedId;
    const seat = ownEntrant(tournament.id);
    const canRegister = state.coach && (tournament.status === "draft" || tournament.status === "active");
    return `<article class="tournament-card">
      <div class="card-top"><h3>${escapeHtml(tournament.name)}</h3><span class="badge">${escapeHtml(tournament.status)}</span></div>
      <div class="meta">${escapeHtml(formatLabel(tournament.format))} · ${escapeHtml(tournament.packageName || "Legacy ruleset")}<br>
        ${escapeHtml(tournament.entrantCount ?? 0)} / ${cap} entrants · round ${escapeHtml(tournament.currentRound ?? 0)} / ${escapeHtml(tournament.roundCount ?? 0)}</div>
      <div class="card-actions">
        <button type="button" class="btn${selected ? " primary" : ""}" data-action="detail" data-id="${escapeHtml(tournament.id)}">Details &amp; Standings</button>
        ${canRegister && !seat ? `<button type="button" class="btn" data-action="register" data-id="${escapeHtml(tournament.id)}">Register</button>` : ""}
        ${seat && !seat.droppedAt ? `<button type="button" class="btn" data-action="withdraw" data-id="${escapeHtml(tournament.id)}" data-entrant-id="${escapeHtml(seat.entrantId ?? seat.id)}">Withdraw</button>` : ""}
      </div>
      ${state.registeringId === tournament.id ? renderTeamPicker(tournament.id) : ""}
    </article>`;
  }).join("");
}

function renderTeamPicker(tournamentId) {
  if (!state.ownTeams.length) return '<div class="registration-picker"><span class="empty">No active library teams are available.</span></div>';
  const options = state.ownTeams.map((team) =>
    `<option value="${escapeHtml(team.teamId)}">${escapeHtml(team.teamName ?? team.name ?? team.teamId)} · ${escapeHtml(team.race ?? "Unknown roster")}</option>`,
  ).join("");
  return `<div class="registration-picker">
    <select class="control" id="team-${escapeHtml(tournamentId)}">${options}</select>
    <button type="button" class="btn primary" data-action="confirm-register" data-id="${escapeHtml(tournamentId)}">Confirm Registration</button>
    <button type="button" class="btn" data-action="cancel-register">Cancel</button>
  </div>`;
}

function renderCreate() {
  const options = packageOptions();
  sidePanel.innerHTML = `<h2 class="panel-heading">Create Tournament</h2><div class="panel-body">
    <form id="create-form" class="form-grid">
      <label class="field full">Name<input class="control" name="name" maxlength="100" required></label>
      <label class="field full">Ruleset<select class="control" name="packageName" required>${options || '<option value="">No saved packages</option>'}</select></label>
      <label class="field"># of Players<input class="control" name="maxPlayers" type="number" min="2" step="1" value="8" required></label>
      <label class="field">Type<select class="control" name="format">
        <option value="swiss">Swiss</option><option value="roundRobin">Round-Robin</option><option value="knockout">Knockout</option>
      </select></label>
      <label class="field" data-swiss-rounds>Rounds<input class="control" name="roundCount" type="number" min="1" max="50" step="1" placeholder="Auto"></label>
      <label class="field">Ranking<select class="control" name="primaryTiebreaker">
        <option value="buchholz">Buchholz</option><option value="sonnebornBerger">Sonneborn-Berger</option>
      </select></label>
      <div class="field full"><button class="btn primary" type="submit"${state.busy || !options ? " disabled" : ""}>Create Draft</button></div>
    </form>
  </div>`;
}

function renderDetail() {
  if (!state.detail) {
    sidePanel.innerHTML = '<h2 class="panel-heading">Tournament Details</h2><div class="panel-body empty">Select a tournament to view entrants, rounds, and server-calculated standings.</div>';
    return;
  }
  const { tournament } = state.detail;
  const entrants = safeArray(state.detail.entrants);
  const standings = safeArray(state.detail.standings);
  const packages = packageOptions(tournament.packageName);
  const canManage = canManageTournament(tournament);
  const editForm = canManage ? `<section class="detail-section"><h3>Edit tournament</h3>
    <form id="edit-form" class="form-grid edit-form">
      <label class="field">Number of players<input class="control" name="maxPlayers" type="number" min="0" step="1" value="${escapeHtml(tournament.maxPlayers)}" required></label>
      <label class="field">Type<select class="control" name="format">
        <option value="swiss"${tournament.format === "swiss" ? " selected" : ""}>Swiss</option>
        <option value="roundRobin"${tournament.format === "roundRobin" ? " selected" : ""}>Round-Robin</option>
        <option value="knockout"${tournament.format === "knockout" ? " selected" : ""}>Knockout</option>
      </select></label>
      <label class="field" data-swiss-rounds${tournament.format === "swiss" ? "" : " hidden"}>Rounds<input class="control" name="roundCount" type="number" min="${escapeHtml(Math.max(1, Number(tournament.currentRound) || 0))}" max="50" step="1" value="${escapeHtml(tournament.roundCount)}" required></label>
      <label class="field">Ranking<select class="control" name="primaryTiebreaker"${tournament.status === "completed" ? " disabled" : ""}>
        <option value="buchholz"${tournament.tiebreakers?.[0] === "sonnebornBerger" ? "" : " selected"}>Buchholz</option>
        <option value="sonnebornBerger"${tournament.tiebreakers?.[0] === "sonnebornBerger" ? " selected" : ""}>Sonneborn-Berger</option>
      </select></label>
      <label class="field full">Ruleset<select class="control" name="packageName" required>${packages || '<option value="">No saved packages</option>'}</select></label>
      <label class="field full">Start date<input class="control" name="startsAt" type="datetime-local" value="${escapeHtml(toDateTimeLocal(tournament.startsAt))}"></label>
      <div class="field full"><button class="btn primary" type="submit"${state.busy || !packages ? " disabled" : ""}>Save</button></div>
    </form>
  </section>` : "";
  const actions = canManage ? `<section class="detail-section"><h3>Results</h3><div class="card-actions">
    ${tournament.status === "active" ? `<button type="button" class="btn" data-action="finish"${state.busy ? " disabled" : ""}>Finish tournament</button>` : ""}
    <label class="field">Export format<select class="control" id="export-format">
      <option value="csv">CSV</option><option value="json">JSON</option><option value="naf">NAF submission</option>
    </select></label>
    <button type="button" class="btn" data-action="export"${state.busy ? " disabled" : ""}>Export</button>
  </div></section>` : "";
  const entrantRows = entrants.map((entrant) => `<tr><td>${escapeHtml(entrant.seed)}</td><td>${escapeHtml(entrant.teamName ?? entrant.teamId)}</td><td>${escapeHtml(entrant.coachId ?? entrant.coach?.ffbCoachId)}</td><td>${entrant.droppedAt ? "Dropped" : "Entered"}</td></tr>`).join("");
  const standingRows = standings.map((row) => `<tr><td>${escapeHtml(row.rank)}</td><td>${escapeHtml(row.coachId)}</td><td>${escapeHtml(row.played)}</td><td>${escapeHtml(row.wins)}-${escapeHtml(row.draws)}-${escapeHtml(row.losses)}</td><td>${escapeHtml(row.points)}</td></tr>`).join("");
  sidePanel.innerHTML = `<h2 class="panel-heading">${escapeHtml(tournament.name)}</h2><div class="panel-body">
    <div class="meta">${escapeHtml(formatLabel(tournament.format))} · ${escapeHtml(tournament.packageName || "Legacy ruleset")} · round ${escapeHtml(tournament.currentRound)} / ${escapeHtml(tournament.roundCount)}</div>
    ${editForm}
    ${actions}
    <section class="detail-section"><h3>Entrants</h3><div class="table-wrap"><table><thead><tr><th>Seed</th><th>Team</th><th>Coach</th><th>Status</th></tr></thead><tbody>${entrantRows || '<tr><td colspan="4">No entrants.</td></tr>'}</tbody></table></div></section>
    <section class="detail-section"><h3>Standings</h3><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Coach</th><th>Played</th><th>W-D-L</th><th>Pts</th></tr></thead><tbody>${standingRows || '<tr><td colspan="5">No standings yet.</td></tr>'}</tbody></table></div></section>
  </div>`;
}

function render() {
  renderToolbar();
  renderMessage();
  renderTournamentList();
  if (state.creating && state.organizer) renderCreate(); else renderDetail();
}

async function loadTournaments() {
  try {
    const [active, draft, completed] = await Promise.all([
      requestJson("/api/fork/tournaments?status=active", authOptions()),
      requestJson("/api/fork/tournaments?status=draft", authOptions()),
      requestJson("/api/fork/tournaments?status=completed", authOptions()),
    ]);
    const rows = [...safeArray(active?.tournaments), ...safeArray(draft?.tournaments), ...safeArray(completed?.tournaments)];
    state.tournaments = rows.sort((left, right) => String(left.name).localeCompare(String(right.name)) || String(left.id).localeCompare(String(right.id)));
  } catch (error) {
    setMessage(serverMessage(error), true);
  }
  render();
}

async function loadDetail(id) {
  state.selectedId = id;
  state.creating = false;
  state.registeringId = "";
  try {
    state.detail = await requestJson(`/api/fork/tournaments/${encodeURIComponent(id)}`, authOptions());
    setMessage("");
  } catch (error) {
    state.detail = null;
    setMessage(serverMessage(error), true);
  }
  render();
}

async function login() {
  const username = document.querySelector("#login-user")?.value.trim() ?? "";
  const password = document.querySelector("#login-password")?.value ?? "";
  state.loginUser = username;
  if (!username || !password) { setMessage("Enter your username and password to log in.", true); render(); return; }
  state.busy = true;
  render();
  try {
    const loginResult = await requestJson("/api/fork/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CW-Auth": "1" },
      body: JSON.stringify({ username, password }),
    });
    state.token = loginResult.token;
    const session = await requestJson("/api/auth/session", authOptions());
    state.coach = String(session.coach ?? loginResult.coach ?? username);
    state.organizer = session.organizer === true || session.admin === true;
    state.admin = session.admin === true;
    state.ownTeams = safeArray((await requestJson(`/api/fork/library?coach=${encodeURIComponent(state.coach)}`, authOptions())).teams);
    state.loginUser = "";
    setMessage("");
  } catch (error) {
    state.token = null;
    state.coach = "";
    state.organizer = false;
    setMessage(serverMessage(error), true);
  } finally {
    state.busy = false;
  }
  await loadTournaments();
  if (state.selectedId) await loadDetail(state.selectedId);
}

async function restoreSession() {
  try {
    const session = await requestJson("/api/auth/session");
    if (session?.authenticated !== true) return;
    state.coach = String(session.coach ?? "");
    state.organizer = session.organizer === true || session.admin === true;
    state.admin = session.admin === true;
    state.ownTeams = safeArray((await requestJson(`/api/fork/library?coach=${encodeURIComponent(state.coach)}`, authOptions())).teams);
  } catch {
    // Public tournament browsing remains available when the session probe fails.
  }
}

async function createTournament(form) {
  const values = new FormData(form);
  state.busy = true;
  render();
  try {
    const roundCount = String(values.get("roundCount") ?? "").trim();
    const format = String(values.get("format") ?? "");
    const result = await requestJson("/api/fork/tournaments", authOptions("POST", {
      name: String(values.get("name") ?? ""),
      packageName: String(values.get("packageName") ?? ""),
      maxPlayers: Number(values.get("maxPlayers")),
      format,
      primaryTiebreaker: String(values.get("primaryTiebreaker") ?? ""),
      ...(format === "swiss" && roundCount ? { roundCount: Number(roundCount) } : {}),
    }));
    state.creating = false;
    setMessage("");
    await loadTournaments();
    await loadDetail(result.tournament.id);
  } catch (error) {
    setMessage(serverMessage(error), true);
  } finally {
    state.busy = false;
    render();
  }
}

async function editTournament(form) {
  const tournament = state.detail?.tournament;
  if (!tournament) return;
  const values = new FormData(form);
  const patch = {};
  const maxPlayers = Number(values.get("maxPlayers"));
  const format = String(values.get("format") ?? "");
  const packageName = String(values.get("packageName") ?? "");
  const startsAt = fromDateTimeLocal(String(values.get("startsAt") ?? ""));
  const primaryTiebreaker = values.get("primaryTiebreaker");
  const roundCount = Number(values.get("roundCount"));
  if (maxPlayers !== Number(tournament.maxPlayers)) patch.maxPlayers = maxPlayers;
  if (format !== tournament.format) patch.format = format;
  if (packageName !== tournament.packageName) patch.packageName = packageName;
  if (startsAt !== fromDateTimeLocal(toDateTimeLocal(tournament.startsAt))) patch.startsAt = startsAt;
  if (primaryTiebreaker !== null && primaryTiebreaker !== tournament.tiebreakers?.[0])
    patch.primaryTiebreaker = String(primaryTiebreaker);
  if (format === "swiss" && (tournament.format !== "swiss" || roundCount !== Number(tournament.roundCount)))
    patch.roundCount = roundCount;
  state.busy = true;
  render();
  try {
    await requestJson(`/api/fork/tournaments/${encodeURIComponent(tournament.id)}`, authOptions("PATCH", patch));
    setMessage("");
    await loadTournaments();
    await loadDetail(tournament.id);
  } catch (error) {
    setMessage(serverMessage(error), true);
  } finally {
    state.busy = false;
    render();
  }
}

async function finishTournament() {
  const tournament = state.detail?.tournament;
  if (!tournament || !confirm(`Finish ${tournament.name}? Open matches will be cancelled.`)) return;
  state.busy = true;
  render();
  try {
    await requestJson(`/api/fork/tournaments/${encodeURIComponent(tournament.id)}/finish`, authOptions("POST", {}));
    setMessage("");
    await loadTournaments();
    await loadDetail(tournament.id);
  } catch (error) {
    setMessage(serverMessage(error), true);
  } finally {
    state.busy = false;
    render();
  }
}

async function exportTournament() {
  const tournament = state.detail?.tournament;
  if (!tournament || !canManageTournament(tournament)) return;
  const format = document.querySelector("#export-format")?.value ?? "csv";
  state.busy = true;
  render();
  try {
    const response = await fetch(`/api/fork/tournaments/${encodeURIComponent(tournament.id)}/export?format=${encodeURIComponent(format)}`, authOptions());
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch { data = null; }
      const error = new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`);
      error.serverError = typeof data?.error === "string" ? data.error : undefined;
      throw error;
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `tournament.${format}`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage("");
  } catch (error) {
    setMessage(serverMessage(error), true);
  } finally {
    state.busy = false;
    render();
  }
}

async function beginRegistration(id) {
  state.registeringId = id;
  if (!state.ownTeams.length && state.coach) {
    try {
      state.ownTeams = safeArray((await requestJson(`/api/fork/library?coach=${encodeURIComponent(state.coach)}`, authOptions())).teams);
    } catch (error) { setMessage(serverMessage(error), true); }
  }
  render();
}

async function register(id) {
  const teamId = document.querySelector(`#team-${CSS.escape(id)}`)?.value;
  try {
    await requestJson(`/api/fork/tournaments/${encodeURIComponent(id)}/entrants`, authOptions("POST", { teamId }));
    state.registeringId = "";
    setMessage("");
    await loadTournaments();
    await loadDetail(id);
  } catch (error) {
    setMessage(serverMessage(error), true);
    render();
  }
}

async function withdraw(tournamentId, entrantId) {
  try {
    await requestJson(`/api/fork/tournaments/${encodeURIComponent(tournamentId)}/entrants/${encodeURIComponent(entrantId)}`, authOptions("DELETE"));
    setMessage("");
    await loadTournaments();
    await loadDetail(tournamentId);
  } catch (error) {
    setMessage(serverMessage(error), true);
    render();
  }
}

toolbar.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "login") void login();
  if (action === "logout") {
    state.loginUser = state.coach;
    state.token = null; state.coach = ""; state.organizer = false; state.admin = false; state.ownTeams = []; state.detail = null;
    setMessage(""); render(); void loadTournaments();
  }
  if (action === "show-create") { state.creating = true; state.selectedId = ""; state.detail = null; render(); }
});

toolbar.addEventListener("input", (event) => { if (event.target.id === "login-user") state.loginUser = event.target.value; });
toolbar.addEventListener("keydown", (event) => { if (event.key === "Enter" && !state.coach) void login(); });

listRoot.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "detail") void loadDetail(target.dataset.id);
  if (target.dataset.action === "register") void beginRegistration(target.dataset.id);
  if (target.dataset.action === "confirm-register") void register(target.dataset.id);
  if (target.dataset.action === "cancel-register") { state.registeringId = ""; render(); }
  if (target.dataset.action === "withdraw") void withdraw(target.dataset.id, target.dataset.entrantId);
});

sidePanel.addEventListener("submit", (event) => {
  if (!(event.target.id === "create-form" || event.target.id === "edit-form")) return;
  event.preventDefault();
  if (event.target.id === "create-form") void createTournament(event.target);
  else void editTournament(event.target);
});

sidePanel.addEventListener("change", (event) => {
  if (event.target.name !== "format") return;
  const rounds = event.target.form?.querySelector("[data-swiss-rounds]");
  if (rounds) rounds.hidden = event.target.value !== "swiss";
});

sidePanel.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "finish") void finishTournament();
  if (action === "export") void exportTournament();
});

async function initialize() {
  render();
  await restoreSession();
  try { state.packages = safeArray(await requestJson("/api/packages")); } catch (error) { setMessage(serverMessage(error), true); }
  await loadTournaments();
}

void initialize();
