/*
 * Public team view (owner 10-27). Dependency-free like my-teams.js: a PURE core (token parsing + markup, exported
 * as globalThis.TeamView so vitest can load it in a vm) and a small controller, createTeamViewPage(deps), that the
 * page boots with the real document / fetch / location and the tests drive with stubs.
 *
 * Data: GET /api/fork/team-builder/shared/<token> → { team } (teamShareView.ts SharedTeamView). Session (optional):
 * GET /api/auth/session only decides the nav links; the owner-only "Open in Tournament Builder" link comes from
 * the server's `ownerSaveId`, which it includes only when the viewer's session coach owns the save.
 */
(function (root) {
  "use strict";

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const isNum = (value) => typeof value === "number" && Number.isFinite(value);
  const gold = (value) => (isNum(value) ? `${Math.round(value / 1000).toLocaleString("en-US")}k` : "—");
  const TOKEN_RE = /^[0-9a-f]{32}$/;
  const STATS = ["MA", "ST", "AG", "PA", "AV"];

  /** The share token from /t/<token> or /team-view.html?t=<token>; "" when absent or malformed. */
  function tokenFrom(location) {
    const path = /^\/t\/([0-9a-f]{32})$/.exec(String(location?.pathname ?? ""));
    if (path) return path[1];
    const query = new URLSearchParams(String(location?.search ?? "")).get("t") ?? "";
    return TOKEN_RE.test(query) ? query : "";
  }

  /** Skill Key colour class for a dataset category (same mapping as team-builder.js categoryClass). */
  function categoryClass(category) {
    const k = String(category || "").toLowerCase();
    if (k.startsWith("gen")) return "skill-general";
    if (k.startsWith("agi")) return "skill-agility";
    if (k.startsWith("str")) return "skill-strength";
    if (k.startsWith("pass") || k.startsWith("dev")) return "skill-passing";
    if (k.startsWith("mut")) return "skill-mutation";
    return "skill-trait";
  }

  /** Art paths come from the server model; only relative paths inside the generated art folders are used. */
  const artSrc = (path) => (typeof path === "string" && /^(?:sprites|crests|icons)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.png$/.test(path) ? `/${path}` : "");
  const initials = (name) => String(name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  function spriteHtml(player) {
    const src = artSrc(player.sprite);
    return `<span class="sprite-frame tv-sprite" aria-hidden="true"><span class="sprite-fallback">${esc(initials(player.position))}</span>${src ? `<img class="sprite-image" src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ""}</span>`;
  }
  /** Short position name (server model `position`); the full name (`positionFull`) is the tooltip. */
  /** Player name (fork teams on the management page); builder sheets carry none. */
  const nameHtml = (p) => (typeof p.name === "string" && p.name.trim() ? `<span class="tv-pname">${esc(p.name)}</span>` : "");
  const posTitle = (p) => (typeof p.positionFull === "string" && p.positionFull && p.positionFull !== p.position ? ` title="${esc(p.positionFull)}"` : "");
  // An uploaded team avatar (src/teamAvatars.ts public read, optionally ?v=-busted) replaces the race crest in the banner.
  const avatarSrc = (url) => (typeof url === "string" && /^\/api\/fork\/teams\/[^/?#]+\/avatar(?:\?v=\d+)?$/.test(url) ? url : "");
  function crestHtml(team) {
    const src = avatarSrc(team.avatarUrl) || artSrc(team.crest);
    return `<span class="sprite-frame crest-frame tv-crest" aria-hidden="true"><span class="sprite-fallback">${esc(initials(team.teamName))}</span>${src ? `<img class="crest-image" src="${esc(src)}" alt="" decoding="async">` : ""}</span>`;
  }

  function formatDate(iso) {
    const t = Date.parse(String(iso ?? ""));
    if (Number.isNaN(t)) return "";
    const d = new Date(t);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const rulesetText = (team) => (team.ruleset ? [team.ruleset.name, team.ruleset.tierLabel].filter(Boolean).join(" — ") : "");

  const CAPTAIN_TAG = ' <span class="tv-tag tv-captain" title="Team Captain" aria-label="Team Captain">C</span>';
  function skillChip(skill, added) {
    const access = added && skill.access === "secondary" ? "secondary" : added ? "primary" : "";
    const label = added ? `${access === "secondary" ? "Secondary" : "Primary"} skill added: ${skill.name}` : skill.name;
    return `<span class="skill ${categoryClass(skill.category)}${added ? " tv-added" : ""}${access === "secondary" ? " tv-secondary" : ""}" title="${esc(label)}">${esc(skill.name)}</span>`;
  }
  function skillsHtml(player) {
    const printed = (player.printed ?? []).map((s) => skillChip(s, false));
    // Team Captain grants: the trait and its free Pro, marked as free (never an added, paid skill).
    const free = (player.free ?? []).map((s) => `<span class="skill ${categoryClass(s.category)} tv-free" title="${esc(`Free with Team Captain: ${s.name}`)}">${esc(s.name)}</span>`);
    const added = (player.added ?? []).map((s) => skillChip(s, true));
    const stats = (player.statIncreases ?? []).map((s) => `<span class="skill tv-stat-up" title="Characteristic increase">+${esc(s)}</span>`);
    const all = [...printed, ...free, ...added, ...stats];
    return all.length ? all.join("") : '<span class="tv-none">—</span>';
  }
  function statCell(player, stat) {
    const up = (player.statIncreases ?? []).includes(stat);
    const value = player.stats?.[stat];
    return { up, text: value === undefined || value === null || value === "" ? "—" : String(value) };
  }

  /** With the `sheet` hook (team management page) the name/position becomes a button opening the player sheet;
   *  without it (the public page) the markup is unchanged. */
  function openWrap(player, index, sheet, inner) {
    if (!sheet) return inner;
    const label = sheet(player, index);
    return `<button type="button" class="tv-open" data-sheet="${index}"${label ? ` aria-label="${esc(label)}"` : ""}>${inner}</button>`;
  }

  function tableHtml(players, actions, spp, sheet) {
    const rows = players.map((p, i) => `<tr${p.isStar ? ' class="tv-star"' : ""}>
        <td class="tv-col-sprite">${spriteHtml(p)}</td>
        <td class="tv-num">${esc(p.number)}</td>
        <td class="tv-pos"${posTitle(p)}${sheet ? ` data-sheet-row="${i}"` : ""}>${openWrap(p, i, sheet, `${nameHtml(p)}${esc(p.position)}`)}${p.isStar ? ' <span class="tv-tag">Star</span>' : ""}${p.captain ? CAPTAIN_TAG : ""}</td>
        ${STATS.map((stat) => { const c = statCell(p, stat); return `<td class="tv-stat${c.up ? " tv-up" : ""}"${c.up ? ` title="${stat} increased"` : ""}><span class="tv-stat-box">${esc(c.text)}${c.up ? '<span class="tv-up-mark" aria-hidden="true">▲</span>' : ""}</span></td>`; }).join("")}
        <td class="tv-skills"><div class="row-skills">${skillsHtml(p)}</div></td>
        <td class="tv-cost">${gold(p.cost)}</td>${spp ? `
        <td class="tv-spp">${spp(p, i)}</td>` : ""}${actions ? `
        <td class="tv-actions">${actions(p, i)}</td>` : ""}
      </tr>`).join("");
    return `<table class="tv-table">
      <thead><tr><th scope="col"><span class="visually-hidden">Sprite</span></th><th scope="col">#</th><th scope="col">Position</th>${STATS.map((s) => `<th scope="col" class="tv-stat">${s}</th>`).join("")}<th scope="col">Skills</th><th scope="col" class="tv-cost">Cost</th>${spp ? '<th scope="col" class="tv-spp">SPP</th>' : ""}${actions ? '<th scope="col" class="tv-actions"><span class="visually-hidden">Advancement</span></th>' : ""}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  function cardsHtml(players, actions, spp, sheet) {
    return `<ol class="tv-cards">${players.map((p, i) => `<li class="tv-card${p.isStar ? " tv-star" : ""}">
        <div class="tv-card-head"${sheet ? ` data-sheet-row="${i}"` : ""}>${spriteHtml(p)}<span class="tv-num">#${esc(p.number)}</span><span class="tv-pos"${posTitle(p)}>${openWrap(p, i, sheet, `${nameHtml(p)}${esc(p.position)}`)}${p.isStar ? ' <span class="tv-tag">Star</span>' : ""}${p.captain ? CAPTAIN_TAG : ""}</span><span class="tv-cost">${gold(p.cost)}</span></div>
        <dl class="tv-card-stats">${STATS.map((stat) => { const c = statCell(p, stat); return `<div class="${c.up ? "tv-up" : ""}"><dt>${stat}</dt><dd>${esc(c.text)}${c.up ? '<span class="tv-up-mark" aria-label="increased">▲</span>' : ""}</dd></div>`; }).join("")}</dl>
        <div class="row-skills">${skillsHtml(p)}</div>${actions || spp ? `
        <div class="tv-card-actions">${spp ? `<span class="tv-spp">${spp(p, i)}</span>` : ""}${actions ? actions(p, i) : ""}</div>` : ""}
      </li>`).join("")}</ol>`;
  }

  function sidelineHtml(team) {
    const s = team.sideline ?? {};
    // Owner 10-28: each staff line carries a Super FUMBBL icon (served from /icons, same provenance as the builder art).
    const rows = [
      ["Rerolls", s.reRolls ?? 0, "icons/ui/re_roll.png"], ["Apothecary", s.apothecary ? "Yes" : "No", "icons/ui/apothecary.png"],
      ["Assistant coaches", s.assistantCoaches ?? 0, "icons/inducements/part_time_assistant_coaches.png"],
      ["Cheerleaders", s.cheerleaders ?? 0, "icons/inducements/temp_agency_cheerleaders.png"], ["Dedicated fans", s.dedicatedFans ?? 1, "icons/ui/dedicated_fans.png"],
    ];
    // Owner 10-28: staff the team has none of (0 / no apothecary) are not listed.
    const shown = rows.filter(([, v]) => !(v === 0 || v === "0" || v === "No"));
    const list = shown.length ? shown : [["No sideline staff", "", ""]];
    return `<section class="tv-panel" aria-labelledby="tv-sideline-title"><h2 id="tv-sideline-title" class="section-title"><span>S</span>ideline <span>S</span>taff</h2>
      <dl class="tv-pairs">${list.map(([k, v, icon]) => { const src = artSrc(icon); return `<div><dt class="tv-staff-cell">${src ? `<img class="crest-image tv-staff-icon" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy">` : ""}<span>${esc(k)}</span></dt><dd>${esc(v)}</dd></div>`; }).join("")}</dl></section>`;
  }
  function inducementsHtml(team) {
    const list = team.inducements ?? [];
    const total = team.summary?.inducementsCost;
    // Owner 10-27: always present, as a table (Inducement / Qty) with the total spend; "None" when the team bought none.
    const body = list.length
      ? list.map((i) => { const src = artSrc(i.icon); return `<tr><td class="tv-ind-cell">${src ? `<img class="crest-image tv-ind-icon" src="${esc(src)}" alt="" aria-hidden="true" loading="lazy">` : ""}<span>${esc(i.name)}</span></td><td class="num">${esc(isNum(i.count) ? i.count : 1)}</td></tr>`; }).join("")
      : `<tr><td colspan="2" class="status-copy tv-none">None</td></tr>`;
    const foot = isNum(total) ? `<tfoot><tr><th scope="row">Total</th><td class="num">${esc(gold(total))}</td></tr></tfoot>` : "";
    return `<section class="tv-panel" aria-labelledby="tv-ind-title"><h2 id="tv-ind-title" class="section-title"><span>I</span>nducements</h2>
      <table class="tv-ind-table"><tbody>${body}</tbody>${foot}</table></section>`;
  }
  /** Owner 10-27: special rules are small text beside the team name, not a panel. */
  function rulesInlineHtml(team) {
    const list = (team.specialRules ?? []).map(String).filter(Boolean);
    // Owner: beside the team TYPE, e.g. Dwarf — "Worlds Edge Superleague / Bribery & Corruption / Brawlin' Brutes".
    return list.length ? ` <small class="tv-rules-inline" aria-label="Special rules">${list.map(esc).join(" / ")}</small>` : "";
  }
  function totalsHtml(team) {
    const s = team.summary ?? {};
    const cells = [
      ["Players", String(s.players ?? (team.players ?? []).length)],
      ["Players cost", gold(s.playersCost)],
      ...(isNum(s.starsCost) && s.starsCost > 0 ? [["Stars", gold(s.starsCost)]] : []),
      ["Skills", gold(s.skillsCost)],
      ["Inducements", gold(s.inducementsCost)],
      ["Sideline", gold(s.sidelineCost)],
      ["Primary / Secondary", `${s.primarySkills ?? 0} / ${s.secondarySkills ?? 0}`],
    ];
    const total = isNum(s.total) ? (isNum(s.cap) ? `${gold(s.total)} <small>/ ${gold(s.cap)}</small>` : gold(s.total)) : "—";
    const over = isNum(s.total) && isNum(s.cap) && s.total > s.cap;
    return `<section class="tv-totals" aria-label="Team totals">
      ${cells.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}
      <div class="tv-total${over ? " tv-over" : ""}"><span>Total</span><b>${total}</b></div>
    </section>`;
  }
  /** Owner 10-27: no stencil badge - a small check (or cross) with the ruleset name in small text, top right. */
  function badgeHtml(team) {
    const v = team.validity ?? {};
    const ruleset = team.ruleset?.name ?? "";
    // Owner 10-28: ruleset name on its own line; the check (or cross) with "Verified" / the issue count beneath it.
    if (v.valid) return `<span class="tv-badge tv-valid" title="Valid team"><small>${ruleset ? esc(ruleset) : "Team"}</small><span class="tv-verdict"><span class="tv-check" aria-hidden="true">&#10003;</span>${esc(typeof team.verdict === "string" && team.verdict ? team.verdict : "Verified")}</span></span>`;
    const n = isNum(v.issues) && v.issues > 0 ? v.issues : 1;
    const findings = Array.isArray(v.findings) ? v.findings.map(String).filter(Boolean) : [];
    const list = findings.length ? `<ul class="tv-issues" aria-label="Issues">${findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
    return `<span class="tv-badge tv-invalid"><small>${ruleset ? esc(ruleset) : "Team"}</small><span class="tv-verdict"><span class="tv-check" aria-hidden="true">&#10007;</span>Has ${n} issue${n === 1 ? "" : "s"}</span>${list}</span>`;
  }

  /**
   * The whole page body for a team model. opts (the team management page, /app/teams/<ref>; the public page passes
   * none): { bylineLead: "Coach" (default "Shared by"), hideOwnerLink: true, actions(player, index) -> HTML for an
   * extra "Advancement" column / card footer, spp(player, index) -> HTML for an "SPP" column before it,
   * sheet(player, index) -> the accessible label of a name/position button (data-sheet="<index>") opening the player sheet }.
   */
  function viewHtml(team, opts = {}) {
    const players = Array.isArray(team.players) ? team.players : [];
    const actions = typeof opts.actions === "function" ? opts.actions : null;
    const spp = typeof opts.spp === "function" ? opts.spp : null;
    const sheet = typeof opts.sheet === "function" ? opts.sheet : null;
    const ruleset = rulesetText(team);
    const date = formatDate(team.updatedAt);
    const byline = [`${esc(opts.bylineLead || "Shared by")} <strong>${esc(team.coach)}</strong>`, ruleset ? esc(ruleset) : "", date ? `updated ${esc(date)}` : ""].filter(Boolean).join(" · ");
    const owner = !opts.hideOwnerLink && typeof team.ownerSaveId === "string" && /^[\w-]{1,64}$/.test(team.ownerSaveId)
      ? `<a class="session-button tv-owner" href="/tournament-team-builder.html?save=${encodeURIComponent(team.ownerSaveId)}">Open in Tournament Builder</a>` : "";
    return `<header class="tv-banner">
        <div class="tv-banner-top">
          <h1>${esc(team.teamName)}</h1>
          <div class="tv-banner-side">${badgeHtml(team)}${owner}</div>
        </div>
        <div class="tv-banner-main">
          ${crestHtml(team)}
          <div class="tv-title">
            <p class="tv-race">${esc(team.raceName)}${rulesInlineHtml(team)}</p>
            <p class="tv-byline">${byline}</p>
          </div>
          <p class="tv-key" aria-label="Skill key"><span class="skill skill-general">General</span><span class="skill skill-agility">Agility</span><span class="skill skill-strength">Strength</span><span class="skill skill-passing">Passing</span><span class="skill skill-mutation">Mutation</span><span class="skill skill-trait">Trait</span><span class="skill tv-added skill-general">Added</span><span class="skill tv-stat-up">+Stat</span></p>
        </div>
      </header>
      ${totalsHtml(team)}
      <section class="tv-roster" aria-label="Roster">
        ${players.length ? tableHtml(players, actions, spp, sheet) + cardsHtml(players, actions, spp, sheet) : '<p class="status-copy">This team has no players on this server.</p>'}
      </section>
      <div class="tv-extras">${sidelineHtml(team)}${inducementsHtml(team)}</div>
`;
  }

  function notFoundHtml() {
    return `<section class="tv-gone"><h1><span>T</span>eam not found</h1><p>This team link is no longer available.</p>
      <p><a class="session-button secondary" href="/tournament-team-builder.html">Build a team</a></p></section>`;
  }

  /**
   * deps: { document, fetch, location: { pathname, search } }. Returns { start, state }.
   */
  function createTeamViewPage(deps) {
    const doc = deps.document;
    const state = { token: tokenFrom(deps.location), team: null, gone: false, error: "", coach: "", admin: false };

    function render() {
      const signedIn = Boolean(state.coach);
      doc.querySelectorAll("[data-admin-only]").forEach((el) => { el.hidden = !(signedIn && state.admin); });
      doc.querySelectorAll("[data-signed-in-only]").forEach((el) => { el.hidden = !signedIn; });
      const host = doc.getElementById("team-view-root");
      if (state.team) {
        host.innerHTML = viewHtml(state.team);
        doc.title = `${state.team.teamName} — Super FUMBBL`;
      } else if (state.gone) {
        host.innerHTML = notFoundHtml();
        doc.title = "Team not found — Super FUMBBL";
      } else if (state.error) {
        host.innerHTML = `<p class="status-copy error">${esc(state.error)}</p>`;
      }
    }

    async function loadTeam() {
      if (!state.token) { state.gone = true; return; }
      try {
        const response = await deps.fetch(`/api/fork/team-builder/shared/${state.token}`, { credentials: "same-origin", cache: "no-store" });
        if (response.status === 404) { state.gone = true; return; }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.team) { state.error = `Couldn't load this team (${payload.error || `HTTP ${response.status}`}).`; return; }
        state.team = payload.team;
      } catch (error) {
        state.error = `Couldn't load this team (${error && error.message ? error.message : "network error"}).`;
      }
    }
    async function restoreSession() {
      try {
        const response = await deps.fetch("/api/auth/session", { credentials: "same-origin" });
        const session = await response.json().catch(() => ({}));
        if (session.authenticated === true) {
          state.coach = String(session.coach ?? "").trim();
          state.admin = session.admin === true || session.organizer === true;
        }
      } catch {
        // Anonymous view.
      }
    }

    async function start() {
      await Promise.all([loadTeam(), restoreSession()]);
      render();
    }
    return { start, render, state };
  }

  root.TeamView = { tokenFrom, categoryClass, skillsHtml, viewHtml, notFoundHtml, formatDate, createTeamViewPage };

  if (typeof document === "undefined" || !document.body || document.body.dataset.page !== "team-view") return;
  // A missing sprite/crest/icon file just drops the <img>; the initials stay.
  document.addEventListener("error", (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.matches(".sprite-image, .crest-image")) target.remove();
  }, true);
  createTeamViewPage({ document, fetch: (...args) => fetch(...args), location }).start();
})(typeof globalThis !== "undefined" ? globalThis : this);
