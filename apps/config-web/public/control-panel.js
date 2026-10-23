// Control panel: the admin "Testing suite" card. Visible only when the session may use /api/admin/testing/* (organiser/admin
// session, or the legacy admin password); every other visitor never sees it. Vanilla, like the rest of this page.
(() => {
  "use strict";
  const card = document.getElementById("testing-suite");
  if (!card) return;
  const KEY = "cw.testing.tabletop";
  const $ = (id) => document.getElementById(id);
  const status = $("tt-status");
  const say = (text, bad) => { status.textContent = text; status.classList.toggle("bad", Boolean(bad)); };

  const api = async (path, init = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: { "content-type": "application/json", ...(init.method && init.method !== "GET" ? { "x-cw-auth": "1" } : {}), ...(init.headers || {}) },
    });
    let body = null;
    try { body = await response.json(); } catch { /* no body */ }
    if (!response.ok) throw Object.assign(new Error(body?.error || `${response.status} ${response.statusText}`), { status: response.status });
    return body;
  };

  const store = {
    read() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
    write(value) { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private window / blocked storage */ } },
  };

  const sides = ["home", "away"];
  const coachInput = (side) => $(`tt-${side}-coach`);
  const teamSelect = (side) => $(`tt-${side}-team`);

  function setTeams(side, teams, wanted) {
    const select = teamSelect(side);
    select.textContent = "";
    const list = [...teams];
    if (wanted && !list.some((t) => t.ref === wanted)) list.unshift({ ref: wanted, name: wanted, race: "", tv: null });
    if (!list.length) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "(no teams found)";
      select.append(none);
      return;
    }
    for (const t of list) {
      const option = document.createElement("option");
      option.value = t.ref;
      option.textContent = `${t.name}${t.race ? ` - ${t.race}` : ""}${t.tv ? ` (${t.tv}k)` : ""} [${t.ref}]`;
      select.append(option);
    }
    if (wanted) select.value = wanted;
  }

  async function loadTeams(side, wanted) {
    const coach = coachInput(side).value.trim();
    if (!coach) { setTeams(side, [], wanted); return; }
    try {
      const data = await api(`/api/admin/testing/teams?coach=${encodeURIComponent(coach)}`);
      setTeams(side, data.teams || [], wanted);
    } catch (error) {
      setTeams(side, [], wanted);
      say(`Could not list ${coach}'s teams: ${error.message}`, true);
    }
  }

  // Coach type-ahead over the public fork coach search (2+ characters, debounced).
  for (const side of sides) {
    let timer;
    const input = coachInput(side);
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return;
      timer = setTimeout(async () => {
        try {
          const data = await api(`/api/fork/coaches?q=${encodeURIComponent(q)}&limit=10`);
          const list = $("tt-coaches");
          list.textContent = "";
          for (const name of data.coaches || []) { const o = document.createElement("option"); o.value = name; list.append(o); }
        } catch { /* the fork DB may be unreachable: the field still accepts typed names */ }
      }, 250);
    });
    input.addEventListener("change", () => loadTeams(side));
  }

  function collect() {
    const body = {
      home: { coach: coachInput("home").value.trim(), team: teamSelect("home").value },
      away: { coach: coachInput("away").value.trim(), team: teamSelect("away").value },
      pregame: $("tt-pregame").value,
      postMatch: $("tt-postmatch").value,
    };
    if ($("tt-timer").checked) body.turnTimer = { mode: "on", seconds: Number($("tt-seconds").value) || 240 };
    return body;
  }

  function remember(body) {
    store.write({
      home: body.home, away: body.away, pregame: body.pregame, postMatch: body.postMatch,
      timer: Boolean(body.turnTimer), seconds: body.turnTimer?.seconds ?? (Number($("tt-seconds").value) || 240),
    });
  }

  $("tt-create").addEventListener("click", async () => {
    const body = collect();
    if (!body.home.coach || !body.away.coach || !body.home.team || !body.away.team) { say("Pick a coach and a team for both sides.", true); return; }
    remember(body);
    // Open the tab synchronously (a popup opened after the await is blocked), then point it at the new match.
    const tab = window.open("", "_blank");
    say("Creating...");
    try {
      const made = await api("/api/admin/testing/tabletop-match", { method: "POST", body: JSON.stringify(body) });
      const link = document.createElement("a");
      link.href = made.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = made.url;
      status.textContent = "Created: ";
      status.classList.remove("bad");
      status.append(link);
      if (tab) tab.location.href = made.url;
    } catch (error) {
      if (tab) tab.close();
      say(error.message, true);
    }
  });

  $("tt-purge").addEventListener("click", async () => {
    if (!window.confirm("Delete every test match? Real matches are not touched.")) return;
    try {
      const done = await api("/api/admin/testing/tabletop-matches", { method: "DELETE" });
      say(`Purged ${done.purged} test match${done.purged === 1 ? "" : "es"}.`);
    } catch (error) { say(error.message, true); }
  });

  async function init() {
    try { await api("/api/admin/testing/tools"); } catch { return; } // not an organiser/admin: the card stays hidden
    card.hidden = false;
    const saved = store.read();
    let start = saved;
    if (!start) {
      try { start = (await api("/api/admin/testing/tabletop-defaults")).defaults; } catch { start = null; }
    }
    if (start) {
      for (const side of sides) coachInput(side).value = start[side]?.coach ?? "";
      if (saved) {
        $("tt-pregame").value = saved.pregame || "skip";
        $("tt-postmatch").value = saved.postMatch || "none";
        $("tt-timer").checked = Boolean(saved.timer);
        $("tt-seconds").value = String(saved.seconds || 240);
      }
    }
    for (const side of sides) await loadTeams(side, start?.[side]?.team);
  }
  init();
})();
