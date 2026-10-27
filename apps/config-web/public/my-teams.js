/*
 * My Teams page (owner 10-27). Dependency-free like team-builder.js: a PURE core (rows + table markup, exported
 * as globalThis.MyTeams) and a small UI controller, createMyTeamsPage(deps), that the page boots with the real
 * document / fetch / location and the tests drive with stubs.
 *
 * Session: the same cookie session the builder uses: GET /api/auth/session, the Discord start link in the
 * header slot, POST /api/auth/logout from the account menu. Saves: GET /api/fork/team-builder/saves (summaries
 * carry name, raceName/rosterId, packageName, updatedAt), GET/PUT/DELETE /api/fork/team-builder/saves/:id.
 */
(function (root) {
  "use strict";

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

  /** Saved-team summaries -> table rows, newest first (updatedAt, then createdAt; ties keep server order).
   *  Race falls back to the roster id; a plain Team Builder save has no ruleset (""). */
  function rows(saves) {
    const time = (save) => { const t = Date.parse(save.updatedAt ?? save.createdAt ?? ""); return Number.isNaN(t) ? 0 : t; };
    return (Array.isArray(saves) ? saves : [])
      .filter((save) => save && typeof save.id === "string" && save.id)
      .map((save, index) => ({ save, index, t: time(save) }))
      .sort((a, b) => b.t - a.t || a.index - b.index)
      .map(({ save }) => ({
        id: save.id,
        name: String(save.name ?? ""),
        race: String(save.raceName || save.rosterId || ""),
        ruleset: save.packageName ? String(save.packageName) : "",
      }));
  }

  /** The table: Name / Race / Ruleset; each row opens its save, Rename / Delete at the row end. */
  function tableHtml(list) {
    if (!list.length) return '<p class="status-copy my-teams-empty">No saved teams yet.</p>';
    const body = list.map((row) => `<tr class="my-teams-row" data-open-save="${esc(row.id)}" tabindex="0" title="Open “${esc(row.name)}” in the Tournament Team Builder">
        <td class="my-teams-name">${esc(row.name)}</td>
        <td>${esc(row.race)}</td>
        <td>${row.ruleset ? esc(row.ruleset) : '<span class="my-teams-none">—</span>'}</td>
        <td class="my-teams-tools">
          <button type="button" class="session-button secondary" data-rename-save="${esc(row.id)}" aria-label="Rename “${esc(row.name)}”">Rename</button>
          <button type="button" class="session-button secondary danger" data-delete-save="${esc(row.id)}" aria-label="Delete “${esc(row.name)}”">Delete</button>
        </td>
      </tr>`).join("");
    return `<table class="my-teams-table">
      <thead><tr><th scope="col">Name</th><th scope="col">Race</th><th scope="col">Ruleset</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  const openUrl = (id) => `/tournament-team-builder.html?save=${encodeURIComponent(id)}`;

  /**
   * deps: { document, fetch, navigate(url), prompt(message, value), confirm(message), location: { pathname, hostname } }
   * Returns { start, render, state, loadSaves, onListClick, onListKey }; start() restores the session and loads the saves.
   */
  function createMyTeamsPage(deps) {
    const doc = deps.document;
    const $ = (id) => doc.getElementById(id);
    const state = { coach: "", admin: false, discord: false, saves: [], loaded: false, busy: false, message: "", error: false, loginMessage: "" };

    async function api(path, options = {}) {
      const headers = { ...(options.headers ?? {}), "X-CW-Auth": "1" };
      const response = await deps.fetch(path, { credentials: "same-origin", ...options, headers });
      const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
      return payload;
    }
    const setStatus = (text, error = false) => { state.message = text; state.error = error; };

    function render() {
      const signedIn = Boolean(state.coach);
      doc.querySelectorAll("[data-admin-only]").forEach((el) => { el.hidden = !(signedIn && state.admin); });
      doc.querySelectorAll("[data-signed-in-only]").forEach((el) => { el.hidden = !signedIn; });
      $("login-form").hidden = signedIn;
      $("signed-in-session").hidden = !signedIn;
      $("signed-in-coach").textContent = state.coach;
      $("logout-button").disabled = state.busy;
      const login = $("discord-login");
      login.href = `/api/auth/discord/start?next=${encodeURIComponent(deps.location.pathname || "/my-teams.html")}`;
      login.classList.toggle("disabled", !state.discord);
      login.setAttribute("aria-disabled", String(!state.discord));
      $("login-message").textContent = signedIn ? "" : state.loginMessage
        || (state.discord ? "" : "Discord sign-in is not available on this server right now.");
      $("my-teams-signin").hidden = signedIn;
      const status = $("my-teams-status");
      status.textContent = signedIn ? state.message : "";
      status.className = `status-copy${state.error ? " error" : ""}`;
      const list = $("my-teams-list");
      list.hidden = !signedIn || !state.loaded;
      list.innerHTML = signedIn && state.loaded ? tableHtml(rows(state.saves)) : "";
    }

    function signedOut(loginMessage = "") {
      state.coach = "";
      state.admin = false;
      state.saves = [];
      state.loaded = false;
      state.loginMessage = loginMessage;
      setStatus("");
    }
    function failed(error, action) {
      if (error.status === 401) return signedOut("Your session expired. Sign in again.");
      setStatus(error.status === 404 && action === "list your teams"
        ? "Saved teams aren't available on this server yet."
        : `Couldn't ${action} (${error.message}).`, true);
    }

    async function loadSaves() {
      if (!state.coach) return;
      try {
        const data = await api("/api/fork/team-builder/saves");
        state.saves = Array.isArray(data.saves) ? data.saves : [];
        state.loaded = true;
      } catch (error) {
        failed(error, "list your teams");
      }
      render();
    }
    async function restoreSession() {
      try {
        const session = await api("/api/auth/session");
        state.discord = session.discordSsoEnabled === true;
        if (session.authenticated === true) state.coach = String(session.coach ?? "").trim();
        state.admin = session.authenticated === true && (session.admin === true || session.organizer === true);
      } catch {
        // Signed-out view; the header keeps the Discord button.
      }
      render();
    }
    async function logout() {
      state.busy = true;
      render();
      try { await api("/api/auth/logout", { method: "POST" }); } catch { /* local sign-out still completes */ }
      state.busy = false;
      signedOut("Signed out.");
      render();
    }
    async function renameSave(id) {
      const save = state.saves.find((s) => s.id === id);
      if (!save) return;
      const answer = deps.prompt("Rename saved team:", save.name);
      const name = answer === null || answer === undefined ? "" : String(answer).trim();
      if (!name) return;
      try {
        const detail = await api(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`);
        await api(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, body: detail.save?.body ?? {} }),
        });
        setStatus(`Renamed to “${name}”.`);
        await loadSaves();
      } catch (error) {
        failed(error, "rename the team");
        render();
      }
    }
    async function deleteSave(id) {
      const save = state.saves.find((s) => s.id === id);
      if (!save || !deps.confirm(`Delete saved team “${save.name}”? This can't be undone.`)) return;
      try {
        await api(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`, { method: "DELETE" });
        setStatus(`Deleted “${save.name}”.`);
        await loadSaves();
      } catch (error) {
        failed(error, "delete the team");
        render();
      }
    }

    function onListClick(event) {
      const rename = event.target.closest("[data-rename-save]");
      if (rename) return renameSave(rename.dataset.renameSave);
      const del = event.target.closest("[data-delete-save]");
      if (del) return deleteSave(del.dataset.deleteSave);
      const row = event.target.closest("[data-open-save]");
      if (row) deps.navigate(openUrl(row.dataset.openSave));
    }
    function onListKey(event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest("button")) return;
      const row = event.target.closest("[data-open-save]");
      if (!row) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      deps.navigate(openUrl(row.dataset.openSave));
    }

    function wire() {
      const forkAdmin = $("fork-admin-link");
      if (forkAdmin) forkAdmin.href = `http://${deps.location.hostname || "127.0.0.1"}:22227/panel.html`;
      $("my-teams-list").addEventListener("click", onListClick);
      $("my-teams-list").addEventListener("keydown", onListKey);
      $("logout-button").addEventListener("click", () => { const menu = $("signed-in-session"); if (menu) menu.open = false; logout(); });
      // Account menu: click outside or Escape closes it.
      doc.addEventListener("click", (event) => { const menu = $("signed-in-session"); if (menu && menu.open && !menu.contains(event.target)) menu.open = false; });
      doc.addEventListener("keydown", (event) => { const menu = $("signed-in-session"); if (event.key === "Escape" && menu && menu.open) menu.open = false; });
    }

    async function start() {
      wire();
      render();
      await restoreSession();
      await loadSaves();
    }
    return { start, render, state, loadSaves, onListClick, onListKey };
  }

  root.MyTeams = { rows, tableHtml, openUrl, createMyTeamsPage };

  if (typeof document === "undefined" || !document.body || document.body.dataset.page !== "my-teams") return;
  createMyTeamsPage({
    document,
    fetch: (...args) => fetch(...args),
    navigate: (url) => { location.href = url; },
    prompt: (message, value) => window.prompt(message, value),
    confirm: (message) => window.confirm(message),
    location,
  }).start();
})(typeof globalThis !== "undefined" ? globalThis : this);
