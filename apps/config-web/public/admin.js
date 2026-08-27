"use strict";

const state = {
  authed: false,
  token: null,
  account: "",
  loginUser: "",
  expiresAt: "",
  discordSsoEnabled: false,
  section: "users",
  users: [],
  identities: {},
  games: [],
  libraryTeams: [],
  settings: { homeAwayMode: "", overtime: false },
  errors: {},
  loading: false,
  busy: false,
  connected: false,
  editingIdentity: "",
  modal: null,
  message: null,
  tournamentResult: null,
};

const toolbar = document.querySelector("#toolbar");
const workspace = document.querySelector("#workspace");
const rightRail = document.querySelector("#right-rail");
const modalRoot = document.querySelector("#modal-root");
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

function authOptions(method = "GET", body) {
  const headers = { "X-CW-Auth": "1" };
  if (typeof state.token === "string" && state.token.length > 0) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const options = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body ?? {});
  }
  return options;
}

function title(words) {
  return words.split(" ").map((word) => word ? `<span>${escapeHtml(word[0])}</span>${escapeHtml(word.slice(1))}` : "").join(" ");
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function goldLabel(value) {
  const gold = Number(value);
  return Number.isFinite(gold) ? `${gold.toLocaleString()} gold` : "unknown treasury";
}

function gameId(game) {
  return String(game?.gameId ?? game?.id ?? "");
}

function derivedIdentities(user) {
  if (!user?.linked) return {};
  return {
    discordUserId: String(user.linked.discordUserId ?? ""),
    nafName: String(user.linked.nafName ?? ""),
    nafId: String(user.linked.nafId ?? ""),
    tournamentCoachId: String(user.linked.id ?? ""),
  };
}

function identityRecord(user) {
  const overlay = state.identities[normalizeName(user.fumbblName)];
  return {
    ffbCoachId: String(overlay?.ffbCoachId ?? user.fumbblName ?? ""),
    level: ["player", "organizer", "admin"].includes(overlay?.level) ? overlay.level : "player",
    banned: overlay?.banned === true,
    silenced: overlay?.silenced === true,
    identities: { ...derivedIdentities(user), ...(overlay?.identities ?? {}) },
  };
}

function mergedUsers() {
  const byName = new Map();
  for (const user of safeArray(state.users)) {
    const forkName = String(user?.fumbblName ?? "").trim();
    if (!forkName) continue;
    byName.set(normalizeName(forkName), { ...user, fumbblName: forkName, games: safeArray(user.games) });
  }
  for (const [key, record] of Object.entries(state.identities)) {
    if (!byName.has(key) && record?.ffbCoachId) {
      byName.set(key, { fumbblName: String(record.ffbCoachId), linked: null, games: [] });
    }
  }
  return [...byName.values()].sort((a, b) => {
    const activity = Number(safeArray(b.games).length > 0) - Number(safeArray(a.games).length > 0);
    return activity || String(a.fumbblName).localeCompare(String(b.fumbblName), undefined, { sensitivity: "base" });
  });
}

function detailedGamesById() {
  const details = new Map();
  for (const user of mergedUsers()) {
    for (const game of safeArray(user.games)) {
      if (gameId(game)) details.set(gameId(game), game);
    }
  }
  for (const game of safeArray(state.modal?.games)) {
    if (gameId(game)) details.set(gameId(game), game);
  }
  return details;
}

function normalizedGame(game, detail) {
  return {
    gameId: gameId(game) || gameId(detail),
    status: String(game?.status ?? detail?.status ?? "active"),
    half: Number(game?.half ?? detail?.half ?? 0),
    turn: Number(game?.turn ?? detail?.turn ?? 0),
    started: String(game?.started ?? detail?.started ?? ""),
    homeTeamId: String(game?.homeTeamId ?? detail?.homeTeamId ?? ""),
    homeTeamName: String(game?.homeTeamName ?? game?.homeTeam ?? detail?.homeTeamName ?? detail?.homeTeam ?? "Home team"),
    homeCoach: String(game?.homeCoach ?? detail?.homeCoach ?? ""),
    awayTeamId: String(game?.awayTeamId ?? detail?.awayTeamId ?? ""),
    awayTeamName: String(game?.awayTeamName ?? game?.awayTeam ?? detail?.awayTeamName ?? detail?.awayTeam ?? "Away team"),
    awayCoach: String(game?.awayCoach ?? detail?.awayCoach ?? ""),
  };
}

function gameList() {
  const details = detailedGamesById();
  return safeArray(state.games).map((game) => normalizedGame(game, details.get(gameId(game))));
}

function setMessage(text, kind = "ok") {
  state.message = text ? { text: String(text), kind } : null;
}

function renderMessage() {
  if (!state.message) return "";
  const className = state.message.kind === "error" ? "validation message-banner error" : "saved-banner message-banner";
  return `<div class="${className}">${escapeHtml(state.message.text)}</div>`;
}

function renderErrors() {
  const messages = Object.entries(state.errors).map(([label, message]) => `${label}: ${message}`);
  if (!messages.length) return "";
  return `<div class="validation"><div class="validation-title">Unavailable</div>${messages.map((message) => `<div>${escapeHtml(message)}</div>`).join("")}</div>`;
}

function renderToolbar() {
  const login = state.authed
    ? `<span class="login-status">● ${escapeHtml(state.account)}${state.expiresAt ? ` · token expires ${escapeHtml(state.expiresAt)}` : ""}</span>
       <button type="button" class="btn" data-action="logout">Log Out</button>`
    : `<label class="visually-hidden" for="login-user">Username</label>
       <input id="login-user" class="control" style="width:130px" autocomplete="username" placeholder="Username" value="${escapeHtml(state.loginUser)}">
       <label class="visually-hidden" for="login-password">Password</label>
       <input id="login-password" class="control" style="width:140px" type="password" autocomplete="current-password" placeholder="Password">
       <button type="button" class="btn primary" data-action="login"${state.busy ? " disabled" : ""}>Log In</button>
       ${state.discordSsoEnabled ? '<button type="button" class="btn" data-action="discord-login">Discord</button>' : ""}`;

  toolbar.innerHTML = `
    <span class="toolbar-label">Section</span>
    <button type="button" class="chip${state.section === "users" ? " active" : ""}" data-action="section" data-section="users">Users</button>
    <button type="button" class="chip${state.section === "games" ? " active" : ""}" data-action="section" data-section="games">Game Controls</button>
    <span class="toolbar-spacer"></span>
    ${login}`;
}

function identityChips(record) {
  const values = record.identities ?? {};
  const chips = [];
  if (values.discordUsername) chips.push(`Discord @${values.discordUsername}`);
  if (values.discordUserId) chips.push(`Discord ID ${values.discordUserId}`);
  if (values.nafName || values.nafId) chips.push(`NAF ${values.nafName || "account"}${values.nafId ? ` #${values.nafId}` : ""}`);
  if (values.tournamentCoachId) chips.push(`Tournament ${values.tournamentCoachId}`);
  return chips.length
    ? chips.map((value) => `<span class="chip identity-chip">${escapeHtml(value)}</span>`).join("")
    : '<span class="identity-empty">No attached identities</span>';
}

function renderIdentityEditor(user, record) {
  const values = record.identities ?? {};
  const forkName = escapeHtml(user.fumbblName);
  return `<tr>
    <td class="identity-editor-cell" colspan="7">
      <div class="panel identity-editor" data-identity-editor="${forkName}">
        <div class="section-head">
          <div class="section-title">${title("Identity Library")}</div>
          <span class="section-note">Fork account ${forkName} is the primary identity.</span>
        </div>
        <div class="form-grid">
          <label class="field"><span class="field-label">Discord user ID</span><input class="control" data-identity-field="discordUserId" value="${escapeHtml(values.discordUserId)}"></label>
          <label class="field"><span class="field-label">Discord username</span><input class="control" data-identity-field="discordUsername" value="${escapeHtml(values.discordUsername)}"></label>
          <label class="field"><span class="field-label">Tournament coach ID</span><input class="control" data-identity-field="tournamentCoachId" value="${escapeHtml(values.tournamentCoachId)}"></label>
          <label class="field"><span class="field-label">NAF name</span><input class="control" data-identity-field="nafName" data-naf-field="nafName" value="${escapeHtml(values.nafName)}"></label>
          <label class="field"><span class="field-label">NAF ID</span><input class="control" data-identity-field="nafId" data-naf-field="nafId" value="${escapeHtml(values.nafId)}"></label>
        </div>
        <div class="inline-controls">
          <button type="button" class="btn primary" data-action="save-naf-identity" data-fork-name="${forkName}">Save NAF Identity</button>
          <button type="button" class="btn" data-action="save-identities" data-fork-name="${forkName}">Save Admin Identities</button>
          <button type="button" class="btn" data-action="cancel-identities">Cancel</button>
        </div>
      </div>
    </td>
  </tr>`;
}

function renderUserRow(user) {
  const record = identityRecord(user);
  const forkName = escapeHtml(user.fumbblName);
  const pending = state.busy ? " disabled" : "";
  const statuses = safeArray(user.games).length
    ? safeArray(user.games).map((game) => `<button type="button" class="chip status-badge in-game" data-action="open-game" data-fork-name="${forkName}">In-Game #${escapeHtml(gameId(game))} (${escapeHtml(game.status ?? "live")})</button>`).join(" ")
    : '<span class="chip status-badge">Idle</span>';
  const row = `<tr>
    <td class="account-cell">${forkName}</td>
    <td>
      <label class="visually-hidden" for="level-${escapeHtml(normalizeName(user.fumbblName))}">Permission level for ${forkName}</label>
      <select id="level-${escapeHtml(normalizeName(user.fumbblName))}" class="control" data-action="level" data-fork-name="${forkName}"${pending}>
        <option value="player"${record.level === "player" ? " selected" : ""}>Player</option>
        <option value="organizer"${record.level === "organizer" ? " selected" : ""}>Organizer</option>
        <option value="admin"${record.level === "admin" ? " selected" : ""}>Admin</option>
      </select>
    </td>
    <td>${statuses}</td>
    <td><div class="identity-list">${identityChips(record)}</div></td>
    <td><button type="button" class="flag-toggle banned${record.banned ? " active" : ""}" role="switch" aria-checked="${record.banned}" data-action="toggle-banned" data-fork-name="${forkName}"${pending}>${record.banned ? "Banned" : "Allowed"}</button></td>
    <td><button type="button" class="flag-toggle${record.silenced ? " active" : ""}" role="switch" aria-checked="${record.silenced}" data-action="toggle-silenced" data-fork-name="${forkName}"${pending}>${record.silenced ? "Silenced" : "Normal"}</button></td>
    <td class="actions-cell"><div class="row-actions">
      <button type="button" class="btn compact" data-action="edit-identities" data-fork-name="${forkName}">Identities</button>
      <button type="button" class="btn compact" data-action="reset-password" data-fork-name="${forkName}"${pending}>Reset PW</button>
      <button type="button" class="btn danger compact" data-action="clear-games" data-fork-name="${forkName}"${pending}>Clear</button>
    </div></td>
  </tr>`;
  return row + (normalizeName(state.editingIdentity) === normalizeName(user.fumbblName) ? renderIdentityEditor(user, record) : "");
}

function renderUsers() {
  const users = mergedUsers();
  if (state.loading && !users.length) return '<div class="loading-banner">Loading users and identity library…</div>';
  return `${renderMessage()}${renderErrors()}
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Fork Accounts")}</div>
        <span class="section-note">${escapeHtml(users.length)} account${users.length === 1 ? "" : "s"} · fork account is the primary ID</span>
        <span class="grow"></span>
        <button type="button" class="btn" data-action="refresh">Refresh</button>
      </div>
      <div class="notice">Silenced is a display-only flag. It does not suppress or mute in-game chat.</div>
      ${users.length ? `<div class="admin-table-wrap"><table class="admin-table">
        <thead><tr><th>Fork account</th><th>Level</th><th>Status</th><th>Attached identities</th><th>Banned</th><th>Silenced</th><th>Actions</th></tr></thead>
        <tbody>${users.map(renderUserRow).join("")}</tbody>
      </table></div>` : '<div class="hint">No fork accounts are available.</div>'}
    </section>`;
}

function renderGame(game, inModal = false) {
  const id = escapeHtml(game.gameId);
  const homeTeamId = escapeHtml(game.homeTeamId);
  const awayTeamId = escapeHtml(game.awayTeamId);
  const source = inModal ? "modal" : "workspace";
  return `<article class="panel game-row">
    <div class="game-meta"><span class="chip active">#${id}</span><span>${escapeHtml(game.status)}</span><span>Half ${escapeHtml(game.half)} · Turn ${escapeHtml(game.turn)}</span>${game.started ? `<span>Started ${escapeHtml(game.started)}</span>` : ""}</div>
    <div class="game-matchup">
      <div class="game-side"><strong>${escapeHtml(game.homeTeamName)}</strong><span>Home · ${escapeHtml(game.homeCoach)}${game.homeTeamId ? ` · team ${homeTeamId}` : ""}</span></div>
      <div class="game-side"><strong>${escapeHtml(game.awayTeamName)}</strong><span>Away · ${escapeHtml(game.awayCoach)}${game.awayTeamId ? ` · team ${awayTeamId}` : ""}</span></div>
    </div>
    <div class="game-actions">
      <button type="button" class="btn" data-action="game-action" data-source="${source}" data-game-id="${id}" data-operation="close">Close</button>
      <button type="button" class="btn danger" data-action="game-action" data-source="${source}" data-game-id="${id}" data-operation="delete">Delete</button>
      <button type="button" class="btn" data-action="game-action" data-source="${source}" data-game-id="${id}" data-operation="concede" data-team-id="${homeTeamId}"${game.homeTeamId ? "" : " disabled"}>Concede home</button>
      <button type="button" class="btn" data-action="game-action" data-source="${source}" data-game-id="${id}" data-operation="concede" data-team-id="${awayTeamId}"${game.awayTeamId ? "" : " disabled"}>Concede away</button>
    </div>
  </article>`;
}

function renderGames() {
  const games = gameList();
  if (state.loading && !games.length) return '<div class="loading-banner">Loading live games and matchmaking settings…</div>';
  return `${renderMessage()}${renderErrors()}
    <section class="panel">
      <div class="section-head">
        <div class="section-title">${title("Live Games")}</div>
        <span class="section-note">${escapeHtml(games.length)} active game${games.length === 1 ? "" : "s"}</span>
        <span class="grow"></span>
        <button type="button" class="btn" data-action="refresh">Refresh</button>
      </div>
      <div class="hint">Close ends a game cleanly. Delete removes its live row. Concede assigns the loss to the selected side.</div>
    </section>
    ${games.length ? games.map((game) => renderGame(game)).join("") : '<section class="panel"><div class="hint">No active games reported by the fork.</div></section>'}`;
}

function renderUserRail() {
  const users = mergedUsers();
  const records = users.map(identityRecord);
  const inGame = users.filter((user) => safeArray(user.games).length).length;
  return `<section class="summary-card">
    <div class="rail-title">${title("User Summary")}</div>
    <div class="summary-row"><span>Fork accounts</span><span>${escapeHtml(users.length)}</span></div>
    <div class="summary-row"><span>In game</span><span>${escapeHtml(inGame)}</span></div>
    <div class="summary-row"><span>Organizers / admins</span><span>${escapeHtml(records.filter((record) => record.level !== "player").length)}</span></div>
    <div class="summary-row"><span>Banned</span><span>${escapeHtml(records.filter((record) => record.banned).length)}</span></div>
    <div class="summary-row"><span>Silenced flags</span><span>${escapeHtml(records.filter((record) => record.silenced).length)}</span></div>
  </section>
  <section class="panel">
    <div class="section-title">${title("Flag Limits")}</div>
    <div class="notice">Silenced is stored and displayed only; the fork has no admin operation that suppresses in-game chat.</div>
  </section>`;
}

function renderGameRail() {
  const mode = state.settings.homeAwayMode;
  const overtime = state.settings.overtime === true;
  const tournamentOptions = state.libraryTeams.map((team) => {
    const id = String(team?.teamId ?? "").trim();
    const label = `${String(team?.teamName ?? id)} — ${String(team?.coach ?? "unknown coach")}`;
    return id ? `<option value="${escapeHtml(id)}" label="${escapeHtml(label)}"></option>` : "";
  }).join("");
  const tournamentResult = state.tournamentResult?.gameId
    ? `<div class="notice">Game <strong>${escapeHtml(state.tournamentResult.gameId)}</strong> launched.<br>Home: ${escapeHtml(state.tournamentResult.home?.coach)} — ${escapeHtml(goldLabel(state.tournamentResult.home?.treasury))}<br>Away: ${escapeHtml(state.tournamentResult.away?.coach)} — ${escapeHtml(goldLabel(state.tournamentResult.away?.treasury))}</div>`
    : "";
  return `<section class="panel">
    <div class="section-title">${title("Matchmaking")}</div>
    <div class="field"><span class="field-label">Home / away</span><div class="segment-group">
      <button type="button" class="chip${mode === "alternating" ? " active" : ""}" data-action="home-away" data-mode="alternating">Alternating</button>
      <button type="button" class="chip${mode === "random" ? " active" : ""}" data-action="home-away" data-mode="random">Random</button>
    </div></div>
    <div class="hint">Alternating swaps sides on rematches; random uses a coin flip per game.</div>
    <div class="field"><span class="field-label">Overtime on new scheduled games</span><div class="segment-group">
      <button type="button" class="chip${!overtime ? " active" : ""}" data-action="overtime" data-enabled="false">Off</button>
      <button type="button" class="chip${overtime ? " active" : ""}" data-action="overtime" data-enabled="true">On</button>
    </div></div>
  </section>
  <section class="panel">
    <div class="section-title">${title("Broadcast Message")}</div>
    <div class="rail-form">
      <label class="field"><span class="field-label">Message to connected coaches</span><textarea id="broadcast-text" class="control" placeholder="Server announcement"></textarea></label>
      <button type="button" class="btn primary" data-action="broadcast">Broadcast</button>
    </div>
  </section>
  <section class="panel">
    <div class="section-title">${title("Schedule Game")}</div>
    <div class="rail-form">
      <label class="field"><span class="field-label">Home team ID</span><input id="schedule-home" class="control" inputmode="numeric"></label>
      <label class="field"><span class="field-label">Away team ID</span><input id="schedule-away" class="control" inputmode="numeric"></label>
      <button type="button" class="btn primary" data-action="schedule">Schedule</button>
    </div>
  </section>
  <section class="panel">
    <div class="section-title">${title("Tournament Match")}</div>
    <div class="hint">Pre-loads each roster's saved inducements, reloads both teams, and schedules the match. Star Players already ride the roster.</div>
    <div class="rail-form">
      <datalist id="tournament-team-options">${tournamentOptions}</datalist>
      <label class="field"><span class="field-label">Home team</span><input id="tournament-home" class="control" list="tournament-team-options" placeholder="Team ID"></label>
      <label class="field"><span class="field-label">Away team</span><input id="tournament-away" class="control" list="tournament-team-options" placeholder="Team ID"></label>
      <label class="field"><span class="field-label">Package name (optional)</span><input id="tournament-package" class="control" placeholder="Tournament package"></label>
      <button type="button" class="btn primary" data-action="tournament-launch">Launch</button>
      ${tournamentResult}
    </div>
  </section>`;
}

function renderModal() {
  if (!state.modal) {
    modalRoot.innerHTML = "";
    return;
  }
  let body;
  if (state.modal.loading) body = '<div class="loading-banner">Loading live games…</div>';
  else if (state.modal.error) body = `<div class="validation">${escapeHtml(state.modal.error)}</div>`;
  else {
    const games = safeArray(state.modal.games).map((game) => normalizedGame(game));
    body = games.length ? games.map((game) => renderGame(game, true)).join("") : '<div class="hint">No live games for this account.</div>';
  }
  modalRoot.innerHTML = `<div class="modal-overlay" data-action="close-modal">
    <div class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="game-modal-title">
      <div class="modal-head">
        <div id="game-modal-title" class="section-title">${title(`${state.modal.forkName} Live Games`)}</div>
        <button type="button" class="btn" data-action="close-modal">Close</button>
      </div>
      ${body}
    </div>
  </div>`;
}

function render() {
  renderToolbar();
  if (!state.authed) {
    workspace.innerHTML = `${renderMessage()}<section class="panel">
      <div class="section-title">${title("Admin Login Required")}</div>
      <div class="hint">The console shell is public, but its data and controls remain protected by the admin APIs. Log in above to continue.</div>
    </section>`;
    rightRail.innerHTML = `<section class="summary-card"><div class="rail-title">${title("Admin Console")}</div><div class="boundary-note">Users, identity flags, live games, scheduling, and fork controls load only after authentication.</div></section>`;
  } else if (state.section === "users") {
    workspace.innerHTML = renderUsers();
    rightRail.innerHTML = renderUserRail();
  } else {
    workspace.innerHTML = renderGames();
    rightRail.innerHTML = renderGameRail();
  }
  connectionState.textContent = state.authed ? (state.connected ? "● connected" : "● authenticated") : "● signed out";
  connectionState.className = state.authed && state.connected ? "connected" : "disconnected";
  renderModal();
}

async function login() {
  const username = document.querySelector("#login-user")?.value.trim() ?? "";
  const password = document.querySelector("#login-password")?.value ?? "";
  state.loginUser = username;
  if (!username || !password) {
    setMessage("Enter your username and password to log in.", "error");
    render();
    return;
  }
  state.busy = true;
  setMessage("");
  render();
  try {
    const result = await requestJson("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CW-Auth": "1" },
      body: JSON.stringify({ username, password }),
    });
    state.authed = true;
    state.token = result?.token ?? null;
    state.account = username;
    state.loginUser = "";
    state.expiresAt = String(result?.expiresAt ?? "");
    setMessage("");
  } catch (error) {
    state.authed = false;
    state.token = null;
    state.account = "";
    state.expiresAt = "";
    setMessage(serverMessage(error), "error");
  } finally {
    state.busy = false;
    render();
  }
  if (state.authed) await loadData();
}

async function logout() {
  state.loginUser = state.account;
  try {
    await requestJson("/api/auth/logout", authOptions("POST"));
  } catch {
    // Local logout still succeeds if the server request fails.
  }
  state.authed = false;
  state.token = null;
  state.account = "";
  state.expiresAt = "";
  state.users = [];
  state.identities = {};
  state.games = [];
  state.libraryTeams = [];
  state.errors = {};
  state.connected = false;
  state.editingIdentity = "";
  state.modal = null;
  setMessage("");
  render();
}

async function loadData() {
  if (!state.authed || state.loading) return;
  state.loading = true;
  state.errors = {};
  render();
  const requests = [
    ["Users", "/api/fork/users"],
    ["Identity library", "/api/admin/identities"],
    ["Live games", "/api/fork/games"],
    ["Matchmaking settings", "/api/fork/matchmaking-settings"],
  ];
  const results = await Promise.allSettled(requests.map(([, path]) => requestJson(path, authOptions())));
  let successes = 0;
  results.forEach((result, index) => {
    const [label] = requests[index];
    if (result.status === "rejected") {
      state.errors[label] = serverMessage(result.reason);
      if (result.reason?.status === 401) logout();
      return;
    }
    successes += 1;
    const value = result.value;
    if (label === "Users") state.users = safeArray(value?.users);
    if (label === "Identity library") state.identities = value?.coaches && typeof value.coaches === "object" ? value.coaches : {};
    if (label === "Live games") state.games = safeArray(value?.games ?? value);
    if (label === "Matchmaking settings") state.settings = { homeAwayMode: String(value?.homeAwayMode ?? ""), overtime: value?.overtime === true };
  });
  const libraryCoaches = [...new Set(mergedUsers().map((user) => String(user.fumbblName ?? "").trim()).filter(Boolean))];
  const libraries = await Promise.allSettled(libraryCoaches.map((coach) =>
    requestJson(`/api/fork/library?coach=${encodeURIComponent(coach)}`, authOptions()),
  ));
  state.libraryTeams = libraries.flatMap((result) => result.status === "fulfilled" ? safeArray(result.value?.teams) : [])
    .filter((team) => team?.retired !== true && String(team?.teamId ?? "").trim())
    .sort((left, right) => {
      const coachOrder = String(left.coach ?? "").localeCompare(String(right.coach ?? ""));
      return coachOrder || String(left.teamName ?? "").localeCompare(String(right.teamName ?? ""));
    });
  state.connected = successes > 0;
  state.loading = false;
  render();
}

async function updateIdentity(forkName, patch) {
  if (!state.authed || state.busy) return;
  state.busy = true;
  setMessage("");
  render();
  try {
    const result = await requestJson("/api/admin/identities", authOptions("POST", { ffbCoachId: forkName, ...patch }));
    state.identities[normalizeName(forkName)] = result.coach;
    setMessage(`Saved admin identity settings for ${forkName}.`);
  } catch (error) {
    setMessage(serverMessage(error), "error");
  } finally {
    state.busy = false;
    render();
  }
}

async function saveIdentities(forkName) {
  const editor = [...document.querySelectorAll("[data-identity-editor]")].find((element) => normalizeName(element.dataset.identityEditor) === normalizeName(forkName));
  if (!editor) return;
  const identities = {};
  editor.querySelectorAll("[data-identity-field]:not([data-naf-field])").forEach((input) => {
    identities[input.dataset.identityField] = input.value.trim();
  });
  state.editingIdentity = "";
  await updateIdentity(forkName, { identities });
}

async function saveNafIdentity(forkName) {
  const editor = [...document.querySelectorAll("[data-identity-editor]")].find((element) => normalizeName(element.dataset.identityEditor) === normalizeName(forkName));
  if (!editor || !state.authed || state.busy) return;
  const nafIdentity = {};
  editor.querySelectorAll("[data-naf-field]").forEach((input) => {
    nafIdentity[input.dataset.nafField] = input.value.trim();
  });
  state.busy = true;
  state.editingIdentity = "";
  setMessage("");
  render();
  try {
    const result = await requestJson("/api/admin/identities/naf", authOptions("POST", { ffbCoachId: forkName, ...nafIdentity }));
    state.identities[normalizeName(forkName)] = result.coach;
    setMessage(`Saved NAF identity for ${forkName}.`);
  } catch (error) {
    setMessage(serverMessage(error), "error");
  } finally {
    state.busy = false;
    render();
  }
}

async function resetPassword(forkName) {
  const password = window.prompt(`New FORK password for "${forkName}". Leave blank to use the default test password.`);
  if (password === null) return;
  try {
    const body = { username: forkName };
    if (password) body.password = password;
    await requestJson("/api/fork/user/reset-password", authOptions("POST", body));
    setMessage(`Fork password reset for ${forkName}.`);
  } catch (error) {
    setMessage(serverMessage(error), "error");
  }
  render();
}

async function clearGames(forkName) {
  if (!window.confirm(`Clear every live game for "${forkName}"? This deletes each game row they are part of.`)) return;
  try {
    const result = await requestJson("/api/fork/user/clear-games", authOptions("POST", { username: forkName }));
    const cleared = safeArray(result?.cleared).length;
    const failed = safeArray(result?.failed).length;
    setMessage(`Cleared ${cleared} game${cleared === 1 ? "" : "s"} for ${forkName}${failed ? `; ${failed} failed` : ""}.`, failed ? "error" : "ok");
    await loadData();
  } catch (error) {
    setMessage(serverMessage(error), "error");
    render();
  }
}

async function openGameModal(forkName) {
  state.modal = { forkName, games: [], loading: true, error: "" };
  renderModal();
  try {
    const result = await requestJson(`/api/fork/user/${encodeURIComponent(forkName)}/games`, authOptions());
    if (!state.modal || normalizeName(state.modal.forkName) !== normalizeName(forkName)) return;
    state.modal.games = safeArray(result?.games);
    state.modal.loading = false;
  } catch (error) {
    if (!state.modal || normalizeName(state.modal.forkName) !== normalizeName(forkName)) return;
    state.modal.loading = false;
    state.modal.error = serverMessage(error);
  }
  renderModal();
}

async function runGameAction(target) {
  const id = target.dataset.gameId ?? "";
  const operation = target.dataset.operation ?? "";
  const teamId = target.dataset.teamId ?? "";
  if (!id || !["close", "delete", "concede"].includes(operation)) return;
  if (operation === "delete" && !window.confirm(`Delete game ${id}? This removes the game row.`)) return;
  if (operation === "concede" && !teamId) {
    setMessage(`Game ${id} did not report a team ID for that side.`, "error");
    render();
    return;
  }
  try {
    await requestJson(`/api/fork/game/${encodeURIComponent(id)}/${operation}`, authOptions("POST", teamId ? { teamId } : {}));
    setMessage(`${operation[0].toUpperCase() + operation.slice(1)} completed for game ${id}.`);
    state.modal = null;
    await loadData();
  } catch (error) {
    setMessage(serverMessage(error), "error");
    render();
  }
}

async function updateMatchmaking(patch) {
  try {
    const result = await requestJson("/api/fork/matchmaking-settings", authOptions("POST", patch));
    state.settings = { homeAwayMode: String(result?.homeAwayMode ?? state.settings.homeAwayMode), overtime: result?.overtime === true };
    setMessage("Matchmaking settings saved.");
  } catch (error) {
    setMessage(serverMessage(error), "error");
  }
  render();
}

async function broadcastMessage() {
  const text = document.querySelector("#broadcast-text")?.value.trim() ?? "";
  if (!text) {
    setMessage("Enter a broadcast message.", "error");
    render();
    return;
  }
  try {
    await requestJson("/api/fork/message", authOptions("POST", { text }));
    setMessage("Broadcast sent.");
  } catch (error) {
    setMessage(serverMessage(error), "error");
  }
  render();
}

async function scheduleGame() {
  const homeTeamId = document.querySelector("#schedule-home")?.value.trim() ?? "";
  const awayTeamId = document.querySelector("#schedule-away")?.value.trim() ?? "";
  if (!homeTeamId || !awayTeamId) {
    setMessage("Enter both home and away team IDs.", "error");
    render();
    return;
  }
  try {
    const result = await requestJson("/api/fork/schedule", authOptions("POST", { homeTeamId, awayTeamId }));
    setMessage(result?.gameId ? `Scheduled game ${result.gameId}.` : "Game scheduled.");
    await loadData();
  } catch (error) {
    setMessage(serverMessage(error), "error");
    render();
  }
}

async function launchTournamentMatch() {
  const homeTeamId = document.querySelector("#tournament-home")?.value.trim() ?? "";
  const awayTeamId = document.querySelector("#tournament-away")?.value.trim() ?? "";
  const packageName = document.querySelector("#tournament-package")?.value.trim() ?? "";
  if (!homeTeamId || !awayTeamId) {
    setMessage("Choose both tournament teams.", "error");
    render();
    return;
  }
  if (homeTeamId === awayTeamId) {
    setMessage("Choose two different tournament teams.", "error");
    render();
    return;
  }
  try {
    const result = await requestJson("/api/fork/tournament-match", authOptions("POST", {
      homeTeamId,
      awayTeamId,
      ...(packageName ? { packageName } : {}),
    }));
    state.tournamentResult = result;
    setMessage(`Tournament game ${String(result?.gameId ?? "")} launched.`);
    await loadData();
  } catch (error) {
    setMessage(serverMessage(error), "error");
    render();
  }
}

toolbar.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "login") login();
  if (target.dataset.action === "discord-login") location.assign("/api/auth/discord/start?next=/admin.html");
  if (target.dataset.action === "logout") logout();
  if (target.dataset.action === "section") {
    state.section = target.dataset.section === "games" ? "games" : "users";
    state.editingIdentity = "";
    setMessage("");
    render();
  }
});

toolbar.addEventListener("change", (event) => {
  if (event.target.id === "login-user") state.loginUser = event.target.value;
});

toolbar.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !state.authed) login();
});

workspace.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const forkName = target.dataset.forkName ?? "";
  if (action === "refresh") loadData();
  if (action === "edit-identities") { state.editingIdentity = forkName; render(); }
  if (action === "cancel-identities") { state.editingIdentity = ""; render(); }
  if (action === "save-naf-identity") saveNafIdentity(forkName);
  if (action === "save-identities") saveIdentities(forkName);
  if (action === "toggle-banned") {
    const user = mergedUsers().find((entry) => normalizeName(entry.fumbblName) === normalizeName(forkName));
    if (user) updateIdentity(forkName, { banned: !identityRecord(user).banned });
  }
  if (action === "toggle-silenced") {
    const user = mergedUsers().find((entry) => normalizeName(entry.fumbblName) === normalizeName(forkName));
    if (user) updateIdentity(forkName, { silenced: !identityRecord(user).silenced });
  }
  if (action === "reset-password") resetPassword(forkName);
  if (action === "clear-games") clearGames(forkName);
  if (action === "open-game") openGameModal(forkName);
  if (action === "game-action") runGameAction(target);
});

workspace.addEventListener("change", (event) => {
  const target = event.target.closest("[data-action]");
  if (target?.dataset.action === "level") updateIdentity(target.dataset.forkName ?? "", { level: target.value });
});

rightRail.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "home-away") updateMatchmaking({ homeAwayMode: target.dataset.mode });
  if (target.dataset.action === "overtime") updateMatchmaking({ overtime: target.dataset.enabled === "true" });
  if (target.dataset.action === "broadcast") broadcastMessage();
  if (target.dataset.action === "schedule") scheduleGame();
  if (target.dataset.action === "tournament-launch") launchTournamentMatch();
});

rightRail.addEventListener("change", () => {});

modalRoot.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "close-modal" && (target === event.target || target.tagName === "BUTTON")) {
    state.modal = null;
    renderModal();
  }
  if (target.dataset.action === "game-action") runGameAction(target);
});

modalRoot.addEventListener("change", () => {});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modal) {
    state.modal = null;
    renderModal();
  }
});

async function initialize() {
  render();
  try {
    const result = await requestJson("/api/auth/session");
    state.discordSsoEnabled = result?.discordSsoEnabled === true;
    if (result?.authenticated !== true) {
      render();
      return;
    }
    state.authed = true;
    state.account = String(result.coach ?? "");
    state.token = null;
    state.expiresAt = String(result.expiresAt ?? "");
    render();
    await loadData();
  } catch {
    // Stay signed out when the session probe is unavailable.
  }
}

initialize();
