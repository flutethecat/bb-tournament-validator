/**
 * Render a TournamentPackage to a self-contained one-page HTML rules sheet.
 * Pure (string in, string out) so both the Discord bot and the config pane use it.
 * Print-friendly light theme; everything inline so the file stands alone.
 */

import type { TournamentPackage } from "../package/types";

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const gp = (n: number | null | undefined): string => (n == null ? "—" : `${n.toLocaleString("en-US")} gp`);

const yesNo = (b: boolean): string => (b ? "Yes" : "No");

/** Count-mode ("3 primary + 2 secondary ↔") or SP-budget allotment text. */
function allotText(
  primary?: number | null,
  secondary?: number | null,
  swap?: boolean,
  sp?: number | null,
): string {
  if (primary != null || secondary != null)
    return `${primary ?? "∞"} primary${secondary != null ? ` + ${secondary} secondary` : ""}${swap ? " ↔" : ""}`;
  return sp != null ? `${sp} SP` : "—";
}

/** Skill-stacking cap ("max players with >1 added skill"); "—" = no cap. */
const stackText = (n: number | null | undefined): string => (n == null ? "—" : String(n));

function skillCostLine(pkg: TournamentPackage): string {
  const sa = pkg.skillAllotment;
  const sec = sa.secondaryCostSP != null ? `${sa.secondaryCostSP} SP` : `${sa.secondaryMultiplier}× primary`;
  const elite = sa.eliteSurchargeSP > 0 ? `Elite +${sa.eliteSurchargeSP} SP (${sa.eliteSkills.join(", ")})` : "Elite skills cost the same";
  return `Primary ${sa.primaryCostSP} SP · Secondary ${sec} · ${elite}`;
}

/** The active configuration mode. */
function mode(pkg: TournamentPackage): "matrix" | "tiers" | "teamRules" | "flat" {
  if (pkg.matrix?.cells.length) return "matrix";
  if (pkg.tiers?.length) return "tiers";
  if (pkg.teamRules?.length) return "teamRules";
  return "flat";
}

function matrixSection(pkg: TournamentPackage): string {
  const m = pkg.matrix!;
  const teamsAt = (r: number, c: number) =>
    m.cells.filter((cell) => cell.row === r && cell.col === c).flatMap((cell) => cell.teams);
  const head = m.columns.map((col) => `<th>${gp(col.gold)}</th>`).join("");
  const rows = m.rows
    .map((row, r) => {
      const label = row.label || `${row.primary} primary${row.secondary ? ` + ${row.secondary} secondary` : ""}`;
      const swap = row.secondarySwap ? ' <span class="swap" title="Swap 2 primaries for 1 secondary">↔ swap</span>' : "";
      const stack = row.maxStackedPlayers != null ? ` <span class="swap" title="Max players with >1 added skill">· stack ≤ ${row.maxStackedPlayers}</span>` : "";
      const cells = m.columns
        .map((_, c) => `<td>${teamsAt(r, c).map(esc).join("<br>") || "—"}</td>`)
        .join("");
      return `<tr><th class="rowhead">${esc(label)}${swap}${stack}</th>${cells}</tr>`;
    })
    .join("");
  return section(
    "Cash × Skills Matrix",
    `<p class="hint">Each team sits at a cash column (total gold) and a skills row (primary + secondary allotment). “↔ swap” = swap 2 primaries for 1 secondary.</p>
     <table class="matrix"><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function tiersSection(pkg: TournamentPackage): string {
  const rows = pkg
    .tiers!.slice()
    .sort((a, b) => a.tier - b.tier)
    .map(
      (t) =>
        `<tr><th class="rowhead">Tier ${t.tier}${t.label ? ` — ${esc(t.label)}` : ""}</th>
         <td>${gp(t.gold)}</td><td>${esc(allotText(t.maxPrimary, t.maxSecondary, t.secondarySwap, t.skillPointBudget))}</td>
         <td>${stackText(t.maxStackedPlayers)}</td>
         <td>${yesNo(t.starPlayersAllowed)}</td><td>${t.bannedStars.map(esc).join(", ") || "—"}</td>
         <td>${t.rosters.map(esc).join(", ")}</td></tr>`,
    )
    .join("");
  return section(
    "Tiers",
    `<p class="hint">Skills = SP budget or count-mode allotment (“↔” = swap 2 primaries for 1 secondary). Stacking = max players allowed more than one added skill.</p>
     <table><thead><tr><th></th><th>Gold</th><th>Skills</th><th>Stacking</th><th>Stars</th><th>Banned stars</th><th>Teams</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function teamRulesSection(pkg: TournamentPackage): string {
  const rows = pkg
    .teamRules!.map(
      (t) =>
        `<tr><th class="rowhead">${esc(t.team)}</th>
         <td>${gp(t.gold ?? null)}</td>
         <td>${t.maxPrimary != null ? t.maxPrimary : "—"}</td>
         <td>${t.maxSecondary != null ? t.maxSecondary : "—"}</td>
         <td>${t.secondarySwap ? "↔" : "—"}</td>
         <td>${stackText(t.maxStackedPlayers)}</td>
         <td>${t.starPlayersAllowed === undefined ? "inherit" : yesNo(t.starPlayersAllowed)}</td>
         <td>${(t.bannedStars ?? []).map(esc).join(", ") || "—"}</td></tr>`,
    )
    .join("");
  return section(
    "Team Rules",
    `<p class="hint">“↔” = Secondary Swap: swap 2 primaries for 1 secondary. Stacking = max players with >1 added skill. Blank fields inherit the package defaults.</p>
     <table><thead><tr><th></th><th>Gold</th><th>Primary</th><th>Secondary</th><th>Swap</th><th>Stacking</th><th>Stars</th><th>Banned stars</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function flatSkillSection(pkg: TournamentPackage): string {
  const sa = pkg.skillAllotment;
  const budget =
    sa.maxPrimary != null || sa.maxSecondary != null
      ? `${sa.maxPrimary ?? "∞"} primary${sa.maxSecondary != null ? ` + ${sa.maxSecondary} secondary` : ""}` +
        (sa.secondarySwap ? " (↔ swap 2 primaries for 1 secondary)" : "")
      : `${sa.skillPointBudget} Skill Points`;
  return section(
    "Skill Allotment",
    `<p><strong>${esc(budget)}</strong></p><p class="hint">${esc(skillCostLine(pkg))}${sa.maxPerPlayer != null ? ` · max ${sa.maxPerPlayer} added skills per player` : ""}${sa.maxSameSkillTeamwide != null ? ` · max ${sa.maxSameSkillTeamwide} of a skill team-wide` : ""}${sa.maxStackedPlayers != null ? ` · max ${sa.maxStackedPlayers} players with >1 added skill` : ""}</p>`,
  );
}

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

export function renderPackageHtml(pkg: TournamentPackage): string {
  const m = mode(pkg);
  const parts: string[] = [];

  if (m === "matrix") parts.push(matrixSection(pkg));
  else if (m === "tiers") parts.push(tiersSection(pkg));
  else if (m === "teamRules") {
    parts.push(flatSkillSection(pkg));
    parts.push(teamRulesSection(pkg));
  } else parts.push(flatSkillSection(pkg));

  // Eligible teams (when not implied by a tier/matrix/team table)
  if (m === "flat") {
    const teams = pkg.eligibleRosters.includes("*") ? "All BB2025 teams" : pkg.eligibleRosters.join(", ") || "—";
    parts.push(section("Eligible Teams", `<p>${esc(teams)}</p>`));
    if (pkg.goldBudget != null) parts.push(section("Team Value", `<p><strong>${gp(pkg.goldBudget)}</strong></p>`));
  }

  // Stars & bans
  const starLines = [
    `Star Players: <strong>${pkg.starPlayers.allowed ? "Allowed" : "Not allowed"}</strong>` +
      (pkg.starPlayers.allowed && pkg.starPlayers.maxCount != null ? ` (max ${pkg.starPlayers.maxCount})` : "") +
      (pkg.starPlayers.allowed && pkg.starPlayers.maxCombinedCost != null ? `, max combined ${gp(pkg.starPlayers.maxCombinedCost)}` : ""),
    pkg.bannedStars?.length ? `Globally banned: ${pkg.bannedStars.map(esc).join(", ")}` : "",
  ].filter(Boolean);
  parts.push(section("Star Players", `<ul>${starLines.map((l) => `<li>${l}</li>`).join("")}</ul>`));

  // Inducements
  const ind =
    pkg.inducements.allowed.includes("*") ? "All inducements allowed" : pkg.inducements.allowed.length ? pkg.inducements.allowed.map(esc).join(", ") : "None";
  parts.push(section("Inducements", `<p>${ind}</p>`));

  // Sideline
  const sl = pkg.sideline;
  const slItems = [
    ["Re-rolls", sl.maxReRolls],
    ["Apothecary", sl.maxApothecary],
    ["Cheerleaders", sl.maxCheerleaders],
    ["Assistant coaches", sl.maxAssistantCoaches],
    ["Dedicated fans", sl.maxDedicatedFans],
  ]
    .map(([k, v]) => `<li>${k}: <strong>${v == null ? "no limit" : `max ${v}`}</strong></li>`)
    .join("");
  parts.push(section("Sideline", `<ul>${slItems}</ul>`));

  // Special
  const sp = pkg.special;
  const spItems = [
    `Minimum players: <strong>${sp.minPlayers}</strong>`,
    `Insignificant-trait constraint: ${yesNo(sp.insignificantTraitConstraint)}`,
    `Stat increases: ${yesNo(sp.statIncreasesAllowed)}`,
    `Slann allowed: ${yesNo(sp.slannAllowed)}`,
    sp.bannedSkills.length ? `Banned skills: ${sp.bannedSkills.map(esc).join(", ")}` : "",
  ].filter(Boolean);
  parts.push(section("Special Rules", `<ul>${spItems.map((l) => `<li>${l}</li>`).join("")}</ul>`));

  const subtitle = [pkg.date ? esc(pkg.date) : "", pkg.description ? esc(pkg.description) : ""].filter(Boolean).join(" — ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(pkg.name)} — Rules</title>
<style>
  :root { --gold:#b8860b; --ink:#1c2230; --dim:#5a6472; --line:#d9dee6; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 system-ui, "Segoe UI", Roboto, sans-serif; color: var(--ink); margin: 0; background: #fff; }
  .sheet { max-width: 900px; margin: 0 auto; padding: 28px; }
  header { border-bottom: 3px solid var(--gold); padding-bottom: 10px; margin-bottom: 6px; }
  h1 { margin: 0; font-size: 1.7rem; }
  .subtitle { color: var(--dim); margin-top: 2px; }
  section { margin-top: 16px; break-inside: avoid; }
  h2 { font-size: 1rem; color: var(--gold); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; border-bottom: 1px solid var(--line); padding-bottom: 3px; }
  p { margin: 4px 0; } .hint { color: var(--dim); font-size: .85rem; }
  ul { margin: 4px 0; padding-left: 18px; } li { margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; font-size: .85rem; }
  th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top; }
  thead th { background: #f4f1e8; }
  .rowhead { background: #faf8f2; font-weight: 600; white-space: nowrap; }
  table.matrix thead th { text-align: center; }
  .swap { color: var(--gold); font-size: .78rem; font-weight: 600; }
  footer { margin-top: 24px; color: var(--dim); font-size: .75rem; border-top: 1px solid var(--line); padding-top: 6px; }
  @media print { .sheet { padding: 0; } body { font-size: 12px; } }
</style></head>
<body><div class="sheet">
  <header><h1>${esc(pkg.name)}</h1>${subtitle ? `<div class="subtitle">${subtitle}</div>` : ""}</header>
  ${parts.join("\n  ")}
  <footer>BB Tournament Validator · ruleset "${esc(pkg.ruleset)}" · generated ${new Date().toISOString().slice(0, 10)}</footer>
</div></body></html>`;
}
