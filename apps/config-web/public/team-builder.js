(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
  const gold = (value) => Number.isFinite(value) ? `${Math.round(value / 1000).toLocaleString()}k` : "—";
  const totalPlayers = () => slots.length;
  const positionCount = (id) => slots.filter((slot) => slot === id).length;

  const SKILL_GROUPS = {
    general: new Set(["Block", "Dauntless", "Dirty Player", "Fend", "Frenzy", "Kick", "Pro", "Shadowing", "Strip Ball", "Sure Hands", "Tackle", "Wrestle"]),
    agility: new Set(["Catch", "Defensive", "Diving Catch", "Diving Tackle", "Dodge", "Jump Up", "Leap", "Safe Pair of Hands", "Sidestep", "Sneaky Git", "Sprint", "Sure Feet"]),
    strength: new Set(["Arm Bar", "Brawler", "Break Tackle", "Grab", "Guard", "Juggernaut", "Mighty Blow", "Multiple Block", "Pile Driver", "Stand Firm", "Strong Arm", "Thick Skull"]),
    passing: new Set(["Accurate", "Cannoneer", "Cloud Burster", "Dump-off", "Leader", "Nerves of Steel", "On the Ball", "Pass", "Running Pass", "Safe Pass"]),
    mutation: new Set(["Big Hand", "Claws", "Disturbing Presence", "Extra Arms", "Foul Appearance", "Horns", "Iron Hard Skin", "Monstrous Mouth", "Prehensile Tail", "Tentacles", "Two Heads", "Very Long Legs"]),
  };

  const STAFF_ROWS = [
    { key: "reRolls", label: "Re-rolls", min: 0, max: () => current?.maxReRolls ?? 8, cost: () => current?.reRollCost ?? 0 },
    { key: "assistantCoaches", label: "Assistant Coaches", min: 0, max: () => 6, cost: () => 10_000 },
    { key: "cheerleaders", label: "Cheerleaders", min: 0, max: () => 12, cost: () => 10_000 },
    { key: "dedicatedFans", label: "Dedicated Fans", min: 1, max: () => 7, cost: () => 10_000 },
    { key: "apothecary", label: "Apothecary", min: 0, max: () => 1, cost: () => 50_000 },
  ];

  let rosters = [];
  let packages = [];
  let current = null;
  let currentPackageRules = null;
  let slots = [];
  let previewTimer = null;
  let previewSequence = 0;
  let packageRulesSequence = 0;
  let lastPreviewValid = false;
  let nameGateTimer = null;
  let authToken = null;
  let authCoach = "";
  let authBusy = false;
  let buildBusy = false;
  let discordSsoEnabled = false;
  let loginFeedback = "";
  let loginFeedbackError = false;
  let staff = {
    reRolls: 0,
    assistantCoaches: 0,
    cheerleaders: 0,
    dedicatedFans: 1,
    apothecary: 0,
  };

  $("fork-admin-link").href = `http://${location.hostname || "127.0.0.1"}:22227/panel.html`;

  async function api(path, options = {}) {
    const headers = { ...(options.headers ?? {}), "X-CW-Auth": "1" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {
        body: payload,
        status: response.status,
      });
    }
    return payload;
  }

  function syncBuildButton() {
    if (buildBusy) {
      $("build-btn").textContent = "Creating…";
      $("build-btn").disabled = true;
      return;
    }
    $("build-btn").textContent = authCoach ? "Create Team" : "Sign In to Create";
    $("build-btn").disabled = !authCoach || !lastPreviewValid;
  }

  function setSessionCoach(coach) {
    authCoach = String(coach ?? "").trim();
    const coachInput = $("coach");
    coachInput.value = authCoach;
    coachInput.readOnly = Boolean(authCoach);
    if (authCoach) coachInput.setAttribute("aria-readonly", "true");
    else coachInput.removeAttribute("aria-readonly");
    $("current-coach-label").textContent = authCoach || "Choose an existing fork account below";
    syncBuildButton();
  }

  function renderSession() {
    const signedIn = Boolean(authCoach);
    $("session-panel").classList.toggle("authenticated", signedIn);
    $("login-form").hidden = signedIn;
    $("signed-in-session").hidden = !signedIn;
    $("signed-in-coach").textContent = authCoach;
    $("session-title").textContent = signedIn ? "Fork account connected" : "Sign in to create your team";
    $("login-button").disabled = authBusy;
    $("login-button").textContent = authBusy ? "Signing In…" : "Log In";
    $("logout-button").disabled = authBusy;
    $("discord-login").hidden = signedIn || !discordSsoEnabled;
    $("login-message").textContent = loginFeedback;
    $("login-message").className = `session-message${loginFeedbackError ? " error" : ""}`;
    syncBuildButton();
  }

  async function restoreSession() {
    try {
      const session = await api("/api/auth/session");
      discordSsoEnabled = session.discordSsoEnabled === true;
      if (session.authenticated === true) setSessionCoach(session.coach);
    } catch {
      // The builder remains browsable and exposes its own login form.
    }
    renderSession();
  }

  async function login(event) {
    event.preventDefault();
    const username = $("login-user").value.trim();
    const password = $("login-password").value;
    if (!username || !password) {
      loginFeedback = "Enter your fork coach name and password.";
      loginFeedbackError = true;
      renderSession();
      return;
    }
    authBusy = true;
    loginFeedback = "";
    loginFeedbackError = false;
    renderSession();
    try {
      const result = await api("/api/fork/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      authToken = result.token ?? null;
      const session = await api("/api/auth/session");
      discordSsoEnabled = session.discordSsoEnabled === true;
      setSessionCoach(session.coach ?? result.coach ?? username);
      $("login-user").value = "";
      loginFeedback = "";
    } catch (error) {
      authToken = null;
      setSessionCoach("");
      loginFeedback = error.message;
      loginFeedbackError = true;
    } finally {
      $("login-password").value = "";
      authBusy = false;
      renderSession();
      schedulePreview();
    }
  }

  async function logout() {
    authBusy = true;
    loginFeedback = "";
    renderSession();
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // Local sign-out still completes if the server session already expired.
    }
    authToken = null;
    setSessionCoach("");
    authBusy = false;
    loginFeedback = "Signed out.";
    loginFeedbackError = false;
    renderSession();
    schedulePreview();
  }

  function ordinaryPositions() {
    if (!current) return [];
    return current.positions
      .filter((position) => !position.isStar)
      .slice()
      .sort((left, right) => right.cost - left.cost || left.name.localeCompare(right.name));
  }

  function positionById(positionId) {
    return current?.positions.find((position) => position.positionId === positionId) ?? null;
  }

  function initials(name) {
    const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
  }

  function skillClass(skill) {
    for (const [group, names] of Object.entries(SKILL_GROUPS)) {
      if (names.has(skill)) return `skill skill-${group}`;
    }
    return "skill skill-trait";
  }

  function statStrip(position, className) {
    return `<div class="${className}">${["MA", "ST", "AG", "PA", "AV"].map((stat) =>
      `<span><b>${esc(position?.[stat] ?? "—")}</b><small>${stat}</small></span>`
    ).join("")}</div>`;
  }

  function skillList(position, className) {
    const skills = position?.skills ?? [];
    if (!skills.length) return `<div class="${className}"><span class="status-copy">No printed skills</span></div>`;
    return `<div class="${className}">${skills.map((skill) =>
      `<span class="${skillClass(skill)}">${esc(skill)}</span>`
    ).join("")}</div>`;
  }

  function renderPositions() {
    if (!current) {
      $("positions").innerHTML = '<p class="status-copy">Choose a roster to see its positions.</p>';
      return;
    }
    const named = Boolean($("team-name").value.trim());
    $("positions").innerHTML = ordinaryPositions().map((position) => {
      const count = positionCount(position.positionId);
      const exhausted = count >= position.max || totalPlayers() >= 16;
      return `<button
        class="position-card${exhausted ? " exhausted" : ""}${named ? "" : " name-required"}"
        type="button"
        data-add-position="${esc(position.positionId)}"
        ${exhausted ? "disabled" : ""}
        aria-label="Add ${esc(position.name)}"
      >
        <div class="position-head">
          <span class="sprite-frame" aria-hidden="true">${esc(initials(position.name))}</span>
          <span class="position-name"><strong>${esc(position.name)}</strong><small>${position.max - count} of ${position.max} left</small></span>
          <span class="cost">${gold(position.cost)}</span>
        </div>
        ${statStrip(position, "stat-strip")}
        ${skillList(position, "printed-skills")}
      </button>`;
    }).join("");
  }

  function renderRoster() {
    $("player-count").textContent = `${totalPlayers()} / 16`;
    $("m-players").textContent = String(totalPlayers());
    if (!slots.length) {
      $("roster-slots").innerHTML = '<div class="roster-empty">Add a player from a position card above.</div>';
      return;
    }
    $("roster-slots").innerHTML = slots.map((positionId, index) => {
      const position = positionById(positionId);
      return `<div class="roster-row roster-grid">
        <span class="slot-number">${index + 1}</span>
        <div class="player-cell">
          <span class="sprite-frame roster-sprite" aria-hidden="true">${esc(initials(position?.name))}</span>
          <span class="player-copy"><strong>${esc(position?.name ?? "Unknown position")}</strong><small>Roster player</small></span>
        </div>
        ${statStrip(position, "row-stats")}
        ${skillList(position, "row-skills")}
        <span class="cost">${gold(position?.cost)}</span>
        <button class="remove-player" type="button" data-remove-slot="${index}" aria-label="Remove ${esc(position?.name ?? "player")}">×</button>
      </div>`;
    }).join("");
  }

  function staffUnavailable(key) {
    return key === "apothecary" && current && !current.apothecaryAllowed;
  }

  function staffCost() {
    return STAFF_ROWS.reduce((sum, row) => sum + Math.max(0, staff[row.key] - row.min) * row.cost(), 0);
  }

  function renderStaff() {
    $("staff-controls").innerHTML = STAFF_ROWS.map((row) => {
      const max = row.max();
      const unavailable = staffUnavailable(row.key);
      const value = staff[row.key];
      return `<div class="stepper-row${unavailable ? " unavailable" : ""}">
        <span class="stepper-label">${esc(row.label)}<small>${row.min}–${max}</small></span>
        <button type="button" data-staff-key="${row.key}" data-staff-delta="-1" ${unavailable || value <= row.min ? "disabled" : ""} aria-label="Remove ${esc(row.label)}">−</button>
        <b>${value}</b>
        <button class="step-add" type="button" data-staff-key="${row.key}" data-staff-delta="1" ${unavailable || value >= max ? "disabled" : ""} aria-label="Add ${esc(row.label)}">+</button>
        <small class="stepper-cost">× ${gold(row.cost())} = ${gold(Math.max(0, value - row.min) * row.cost())}</small>
      </div>`;
    }).join("");
    $("m-staff").textContent = gold(staffCost());
  }

  function requestBody() {
    const counts = new Map();
    for (const positionId of slots) counts.set(positionId, (counts.get(positionId) ?? 0) + 1);
    return {
      rosterId: current?.rosterId,
      ...($('package').value ? { packageName: $('package').value } : {}),
      coach: authCoach || $("coach").value.trim(),
      teamName: $("team-name").value.trim(),
      picks: [...counts].map(([positionId, count]) => ({ positionId, count })),
      reRolls: staff.reRolls,
      apothecary: staff.apothecary === 1,
      assistantCoaches: staff.assistantCoaches,
      cheerleaders: staff.cheerleaders,
      dedicatedFans: staff.dedicatedFans,
    };
  }

  function selectedBudget() {
    const packBudgets = currentPackageRules?.race?.packs?.map((pack) => pack.gold) ?? [];
    return Math.max(currentPackageRules?.budget ?? 1_000_000, ...packBudgets);
  }

  function updateBudgetDisplay() {
    const budget = selectedBudget();
    $('m-budget').textContent = gold(budget);
    const preset = $('package').value;
    const packageRow = packages.find((row) => row.name === preset);
    $('package-note').hidden = !preset;
    $('package-note-title').textContent = preset;
    $('package-note-copy').textContent = [
      currentPackageRules?.race?.tierLabel,
      currentPackageRules?.dataNote,
    ].filter(Boolean).join(' — ') || packageRow?.description || 'Tournament rules apply.';
    const budgetBadge = document.querySelector('.build-key span:nth-child(2)');
    if (budgetBadge) budgetBadge.textContent = `${gold(budget)} budget`;
  }

  async function loadPackageRules() {
    const sequence = ++packageRulesSequence;
    const packageName = $('package').value;
    currentPackageRules = null;
    if (!packageName) {
      updateBudgetDisplay();
      schedulePreview();
      return;
    }
    const rosterName = current?.raceName;
    try {
      const suffix = rosterName ? `?roster=${encodeURIComponent(rosterName)}` : '';
      const response = await api(`/api/packages/${encodeURIComponent(packageName)}${suffix}`);
      if (sequence !== packageRulesSequence) return;
      currentPackageRules = response.rules ?? null;
      updateBudgetDisplay();
      schedulePreview();
    } catch (error) {
      if (sequence !== packageRulesSequence) return;
      $('builder-status').textContent = `Couldn't load preset: ${error.message}`;
      $('builder-status').className = 'status-copy error';
      updateBudgetDisplay();
      resetValidity();
    }
  }

  function showNameGate() {
    clearTimeout(nameGateTimer);
    $("name-gate-toast").hidden = false;
    $("team-name").focus();
    nameGateTimer = setTimeout(() => { $("name-gate-toast").hidden = true; }, 3000);
  }

  function addPosition(positionId) {
    if (!$("team-name").value.trim()) {
      showNameGate();
      return;
    }
    const position = positionById(positionId);
    if (!position || position.isStar || positionCount(positionId) >= position.max || totalPlayers() >= 16) return;
    slots.push(positionId);
    renderPositions();
    renderRoster();
    schedulePreview();
  }

  function removeSlot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return;
    slots.splice(index, 1);
    renderPositions();
    renderRoster();
    schedulePreview();
  }

  function stepStaff(key, delta) {
    const row = STAFF_ROWS.find((item) => item.key === key);
    if (!row || staffUnavailable(key)) return;
    staff[key] = Math.max(row.min, Math.min(row.max(), staff[key] + delta));
    renderStaff();
    schedulePreview();
  }

  function resetValidity() {
    previewSequence++;
    lastPreviewValid = false;
    $("refresh-dot").hidden = true;
    $("validity-card").hidden = true;
    syncBuildButton();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    updateApproximateTotal();
    if (!current || !slots.length || !$("team-name").value.trim() || !$("coach").value.trim()) {
      resetValidity();
      return;
    }
    $("refresh-dot").hidden = false;
    previewTimer = setTimeout(preview, 250);
  }

  function updateApproximateTotal() {
    const playerCost = slots.reduce((sum, positionId) => sum + (positionById(positionId)?.cost ?? 0), 0);
    if (!$("m-gold").dataset.authoritative) $("m-gold").textContent = gold(playerCost + staffCost());
  }

  function renderFindings(errors, warnings) {
    const rows = [
      ...errors.map((finding) => ["err", finding]),
      ...warnings.map((finding) => ["warn", finding]),
    ];
    $("findings").innerHTML = rows.map(([kind, finding]) =>
      `<div class="finding ${kind === "warn" ? "warn" : ""}">${esc(finding.message)}${finding.suggestion ? ` — ${esc(finding.suggestion)}` : ""}</div>`
    ).join("");
  }

  async function preview() {
    const sequence = ++previewSequence;
    $("validity-card").hidden = false;
    $("validity-card").className = "live-card validity-card checking";
    $("validity-headline").textContent = "Checking team…";
    $("findings").innerHTML = "";
    try {
      const result = await api("/api/fork/team-builder/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      if (sequence !== previewSequence) return;
      const used = result.summary?.goldUsed ?? 0;
      const budget = Math.max(result.summary?.goldBudget ?? 0, selectedBudget());
      $("m-gold").dataset.authoritative = "true";
      $("m-gold").textContent = gold(used);
      $("m-gold").className = used > budget ? "over-budget" : "within-budget";
      const errors = result.errors ?? [];
      const warnings = result.warnings ?? [];
      lastPreviewValid = result.valid === true;
      $("validity-card").className = `live-card validity-card ${lastPreviewValid ? "valid" : "invalid"}`;
      $("validity-headline").textContent = lastPreviewValid
        ? "Team is valid ✓"
        : `Team is invalid${errors.length ? `: ${errors.length} ${errors.length === 1 ? "issue" : "issues"} to fix` : ""}`;
      renderFindings(errors, warnings);
      syncBuildButton();
    } catch (error) {
      if (sequence !== previewSequence) return;
      lastPreviewValid = false;
      $("validity-card").className = "live-card validity-card invalid";
      $("validity-headline").textContent = "Couldn't check the team";
      renderFindings([{ message: error.message }], []);
      syncBuildButton();
    } finally {
      if (sequence === previewSequence) $("refresh-dot").hidden = true;
    }
  }

  async function buildTeam(event) {
    event.preventDefault();
    if (!authCoach) {
      loginFeedback = "Sign in with the fork account that will own this team.";
      loginFeedbackError = true;
      renderSession();
      $("login-user").focus();
      return;
    }
    if (!lastPreviewValid) return;
    buildBusy = true;
    syncBuildButton();
    $("build-result").hidden = true;
    try {
      const result = await api("/api/fork/team-builder/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody()),
      });
      $("build-result").className = "result-banner success";
      $("build-result").innerHTML = `<strong>Team Created ✓</strong><span>Installed ${esc(result.teamId)} — ready in Create Game.</span>`;
      $("build-result").hidden = false;
    } catch (error) {
      if (error.status === 401) {
        authToken = null;
        setSessionCoach("");
        loginFeedback = "Your session expired. Sign in again to create the team.";
        loginFeedbackError = true;
        renderSession();
      }
      $("build-result").className = "result-banner error";
      $("build-result").innerHTML = `<strong>Build failed</strong><span>${esc(error.message)}</span>`;
      $("build-result").hidden = false;
    } finally {
      buildBusy = false;
      syncBuildButton();
    }
  }

  async function boot() {
    renderStaff();
    updateApproximateTotal();
    try {
      const [{ rosters: rosterRows }, { users }, packageRows] = await Promise.all([
        api("/api/fork/rosters"),
        api("/api/fork/users").catch(() => ({ users: [] })),
        api('/api/packages').catch(() => []),
      ]);
      rosters = rosterRows ?? [];
      packages = Array.isArray(packageRows) ? packageRows : [];
      $('package').innerHTML = '<option value="">Standard 1,000k</option>' +
        packages.map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`).join('');
      const requestedPreset = new URLSearchParams(location.search).get('preset');
      if (requestedPreset && packages.some((row) => row.name === requestedPreset)) $('package').value = requestedPreset;
      $("race").innerHTML = '<option value="">Choose a roster</option>' +
        rosters.map((roster) => `<option value="${esc(roster.rosterId)}">${esc(roster.raceName)}</option>`).join("");
      $("coach-list").innerHTML = (users ?? []).map((user) => `<option value="${esc(user.fumbblName)}"></option>`).join("");
      if (!rosters.length) {
        $("race").innerHTML = '<option value="">No base rosters installed on the fork</option>';
        $("builder-status").textContent = "No BB2025 roster data is available.";
      }
      await loadPackageRules();
    } catch (error) {
      $("race").innerHTML = '<option value="">Rosters unavailable</option>';
      $("builder-status").textContent = `Couldn't load rosters: ${error.message}`;
      $("builder-status").className = "status-copy error";
    }
  }

  $("race").addEventListener("change", () => {
    current = rosters.find((roster) => roster.rosterId === $("race").value) ?? null;
    slots = [];
    staff = { reRolls: 0, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, apothecary: 0 };
    delete $("m-gold").dataset.authoritative;
    $("m-gold").className = "";
    $("m-gold").textContent = "0k";
    $("build-result").hidden = true;
    renderPositions();
    renderRoster();
    renderStaff();
    updateApproximateTotal();
    loadPackageRules();
  });

  $('package').addEventListener('change', () => {
    delete $('m-gold').dataset.authoritative;
    $('m-gold').className = '';
    loadPackageRules();
  });

  $("team-name").addEventListener("input", () => {
    $("name-gate-toast").hidden = true;
    delete $("m-gold").dataset.authoritative;
    renderPositions();
    schedulePreview();
  });

  $("coach").addEventListener("input", () => {
    $("current-coach-label").textContent = $("coach").value.trim() || "Choose an existing fork account below";
    schedulePreview();
  });

  $("positions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-position]");
    if (button) addPosition(button.dataset.addPosition);
  });
  $("roster-slots").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-slot]");
    if (button) removeSlot(Number(button.dataset.removeSlot));
  });
  $("staff-controls").addEventListener("click", (event) => {
    const button = event.target.closest("[data-staff-key]");
    if (button) stepStaff(button.dataset.staffKey, Number(button.dataset.staffDelta));
  });
  $("build-form").addEventListener("submit", buildTeam);
  $("login-form").addEventListener("submit", login);
  $("logout-button").addEventListener("click", logout);

  async function start() {
    renderSession();
    await restoreSession();
    await boot();
  }

  start();
})();
