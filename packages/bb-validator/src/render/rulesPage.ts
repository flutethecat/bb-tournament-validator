import { bb2025 } from "../dataset/bb2025/index";
import { normName } from "../dataset/lookup";
import { eligibleTeamNames, resolveMatrixCell, resolveTeamConfig, usesCountMode } from "../package/resolveConfig";
import type { SkillPackage, TournamentPackage } from "../package/types";

/** Fields delivered by the companion skill-escalation/star-tax change. */
type RulesPagePkg = Omit<TournamentPackage, "skillAllotment" | "starPlayers" | "inducements"> & {
  skillPointLabel?: string;
  skillAllotment: TournamentPackage["skillAllotment"] & {
    stackSurchargeSP?: number;
    stackSurchargeGold?: number;
  };
  starPlayers: TournamentPackage["starPlayers"] & {
    spTaxByCombinedCost?: { upToGold: number | null; sp: number }[];
  };
  inducements: TournamentPackage["inducements"] & {
    capOverrides?: {
      when: { starHasSkill: string };
      caps: Record<string, number>;
      note?: string;
    }[];
  };
};

export interface RulesPageOptions {
  roster?: string;
  problems?: string[];
  generatedAt?: Date;
  /** Optional deployment prefix, for example `/bbtv` or `https://bb.example`. */
  baseHref?: string;
}

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

const byName = (left: string, right: string): number =>
  left.localeCompare(right, "en", { sensitivity: "base" });

const uniqueNames = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normName(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const money = (value: number | null | undefined): string =>
  value == null ? "No cap" : `${value.toLocaleString("en-US")} gp`;

const compactMoney = (value: number | null | undefined): string =>
  value == null ? "—" : value.toLocaleString("en-US");

const capText = (value: number | null | undefined): string =>
  value == null ? "No cap" : `Maximum ${value}`;

const yesNo = (value: boolean): string => (value ? "Yes" : "No");

const mode = (pkg: TournamentPackage): "matrix" | "tiers" | "teamRules" | "flat" => {
  if (pkg.matrix?.cells.length) return "matrix";
  if (pkg.tiers?.length) return "tiers";
  if (pkg.teamRules?.length) return "teamRules";
  return "flat";
};

const basePrefix = (value?: string): string => {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  return trimmed === "/" ? "" : trimmed;
};

const rulesPath = (pkg: TournamentPackage, baseHref?: string): string =>
  `${basePrefix(baseHref)}/rules/${encodeURIComponent(pkg.name)}`;

const assetPath = (name: string, baseHref?: string): string => `${basePrefix(baseHref)}/${name}`;

const formatDate = (value: string | undefined): string => {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value ?? "";
  const month = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : value!;
};

const generatedDate = (value?: Date): string | undefined => {
  if (!value || Number.isNaN(value.getTime())) return undefined;
  return value.toISOString().slice(0, 10);
};

const stackingText = (value: number | null | undefined): string => {
  if (value == null) return "No cap";
  if (value === 0) return "No stacking";
  if (value === 1) return "1 player may carry 2 skills";
  return `Up to ${value} players may carry 2 skills`;
};

const swapDescription = (ratio = 2, max?: number | null): string =>
  `Swap ${ratio} primaries for 1 secondary${max != null ? ` · maximum ${max}` : ""}`;

const countAllotment = (
  primary: number | null,
  secondary: number | null,
  swap: boolean,
  ratio: number,
  max: number | null,
): string =>
  `${primary ?? "∞"} primary${secondary != null ? ` + ${secondary} secondary` : ""}` +
  (swap ? ` (${swapDescription(ratio, max)})` : "");

const skillBudgetText = (pkg: TournamentPackage, roster: string): string => {
  const cfg = resolveTeamConfig(pkg, roster);
  if (cfg.skillPackages?.length) return "Choose a skill package";
  if (usesCountMode(cfg))
    return countAllotment(
      cfg.maxPrimary,
      cfg.maxSecondary,
      cfg.secondarySwap,
      cfg.secondarySwapRatio,
      cfg.secondarySwapMax,
    );
  return String(cfg.skillPointBudget);
};

const packageSkillModel = (pkg: TournamentPackage): string => {
  const activeMode = mode(pkg);
  if (activeMode === "matrix") return "Primary/secondary matrix";
  if (pkg.skillPackages?.length || pkg.tiers?.some((tier) => tier.skillPackages?.length)) return "Choose-one packages";
  if (pkg.skillAllotment.maxPrimary != null || pkg.skillAllotment.maxSecondary != null) return "Skill counts";
  if (activeMode === "tiers" || activeMode === "teamRules") return "Skill Points per team";
  return `${pkg.skillAllotment.skillPointBudget} Skill Points`;
};

const section = (title: string, body: string, className = ""): string =>
  `<section${className ? ` class="${className}"` : ""}><h2>${esc(title)}</h2>${body}</section>`;

const definition = (term: string, description: string): string =>
  `<div><dt>${esc(term)}</dt><dd>${esc(description)}</dd></div>`;

const bannedList = (names: readonly string[], label: string): string => {
  const sorted = uniqueNames(names).sort(byName);
  if (!sorted.length) return `<p>${esc(label)}: None.</p>`;
  return `<p>${esc(label)}:</p><ul class="chip-list" aria-label="${esc(label)}">${sorted
    .map((name) => `<li class="banned-star-chip">${esc(name)}</li>`)
    .join("")}</ul>`;
};

const dataNoteCallout = (note: string): string => {
  const matches = [...note.matchAll(/\((\d+)\)\s*/g)];
  if (!matches.length)
    return `<aside class="callout hand-check"><h2>Hand-checked by the TO</h2><p>${esc(note)}</p><p>These rules are not enforced by the validator.</p></aside>`;
  const intro = note.slice(0, matches[0]!.index).trim();
  const items = matches.map((match, index) => {
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? note.length;
    return note.slice(start, end).trim().replace(/;$/, "");
  });
  return `<aside class="callout hand-check"><h2>Hand-checked by the TO</h2>${intro ? `<p>${esc(intro)}</p>` : ""}<ol start="${esc(matches[0]![1])}">${items
    .map((item) => `<li class="data-note-item">${esc(item)}</li>`)
    .join("")}</ol><p>These rules are not enforced by the validator.</p></aside>`;
};

const eligibleRosters = (pkg: TournamentPackage): string[] => {
  const names = eligibleTeamNames(pkg);
  return (names.includes("*") ? bb2025.teams.map((team) => team.name) : names).slice().sort(byName);
};

const unknownDatasetRoster = (name: string): boolean =>
  !bb2025.teams.some((team) => normName(team.name) === normName(name));

const rosterLabel = (name: string): string => `${name}${unknownDatasetRoster(name) ? "†" : ""}`;

const rosterFootnote = (pkg: TournamentPackage): string =>
  eligibleRosters(pkg).some(unknownDatasetRoster)
    ? `<p class="footnote">† not selectable in the Team Builder yet.</p>`
    : "";

const specificBans = (pkg: TournamentPackage, roster: string): string[] => {
  const values: string[] = [];
  const tier = pkg.tiers?.find((candidate) => candidate.rosters.some((name) => normName(name) === normName(roster)));
  values.push(...(tier?.bannedStars ?? []));
  values.push(...(resolveMatrixCell(pkg, roster)?.bannedStars ?? []));
  const team = pkg.teamRules?.find((candidate) => normName(candidate.team) === normName(roster));
  values.push(...(team?.bannedStars ?? []));
  return uniqueNames(values).sort(byName);
};

const teamRowsSection = (pkg: TournamentPackage, focusedRoster?: string): string => {
  const teams = eligibleRosters(pkg)
    .map((team) => ({ team, cfg: resolveTeamConfig(pkg, team) }))
    .sort((left, right) =>
      (left.cfg.gold ?? Number.MAX_SAFE_INTEGER) - (right.cfg.gold ?? Number.MAX_SAFE_INTEGER) ||
      byName(left.team, right.team),
    );
  let previousGold: number | null | undefined = undefined;
  const rows: string[] = [];
  for (const { team, cfg } of teams) {
    if (pkg.tiers?.length && cfg.gold !== previousGold) {
      rows.push(`<tr class="gold-band"><th scope="rowgroup" colspan="6">${esc(money(cfg.gold))}</th></tr>`);
      previousGold = cfg.gold;
    }
    const bans = specificBans(pkg, team);
    const current = focusedRoster && normName(focusedRoster) === normName(team);
    rows.push(`<tr class="team-row" data-team-row="true" data-roster="${esc(team)}"${current ? ' aria-current="true"' : ""}>
      <th scope="row">${esc(rosterLabel(team))}</th>
      <td>${esc(compactMoney(cfg.gold))}</td>
      <td>${esc(skillBudgetText(pkg, team))}</td>
      <td>${esc(stackingText(cfg.maxStackedPlayers))}</td>
      <td>${esc(yesNo(cfg.starPlayersAllowed))}</td>
      <td>${bans.length ? esc(bans.join(", ")) : "—"}</td>
    </tr>`);
  }
  return section(
    "Team tiers",
    `<div class="table-scroll"><table class="team-rules"><caption>Effective rules by team, sorted by gold then team</caption><thead><tr><th scope="col">Team</th><th scope="col">Gold</th><th scope="col">Skill budget</th><th scope="col">Stacking</th><th scope="col">Stars</th><th scope="col">Banned stars</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${rosterFootnote(pkg)}`,
  );
};

const matrixSection = (pkg: TournamentPackage): string => {
  const matrix = pkg.matrix!;
  const headings = matrix.columns.map((column) => `<th scope="col">${esc(money(column.gold))}</th>`).join("");
  const rows = matrix.rows.map((row, rowIndex) => {
    const label = row.label || `${row.primary} primary${row.secondary ? ` + ${row.secondary} secondary` : ""}`;
    const terms = row.secondarySwap
      ? ` · ${swapDescription(
          row.secondarySwapRatio ?? pkg.skillAllotment.secondarySwapRatio,
          row.secondarySwapMax !== undefined ? row.secondarySwapMax : pkg.skillAllotment.secondarySwapMax,
        )}`
      : "";
    const stacking = row.maxStackedPlayers !== undefined ? ` · ${stackingText(row.maxStackedPlayers)}` : "";
    const cells = matrix.columns.map((_column, columnIndex) => {
      const teams = matrix.cells
        .filter((cell) => cell.row === rowIndex && cell.col === columnIndex)
        .flatMap((cell) => cell.teams)
        .sort(byName);
      return `<td>${teams.length ? teams.map((team) => esc(rosterLabel(team))).join("<br>") : "—"}</td>`;
    }).join("");
    return `<tr><th scope="row">${esc(`${label}${terms}${stacking}`)}</th>${cells}</tr>`;
  }).join("");
  return section(
    "Team tiers",
    `<div class="table-scroll"><table class="matrix"><caption>Cash × skills matrix</caption><thead><tr><th scope="col">Skills</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div>${rosterFootnote(pkg)}`,
  );
};

const flatTeamsSection = (pkg: TournamentPackage): string => {
  const teams = pkg.eligibleRosters.includes("*") ? "All BB2025 teams" : pkg.eligibleRosters.map(rosterLabel).join(", ");
  return section("Team eligibility", `<p><strong>${esc(teams || "None")}</strong>${pkg.goldBudget != null ? ` · ${esc(money(pkg.goldBudget))}` : ""}</p>${rosterFootnote(pkg)}`);
};

const skillPackagesTables = (pkg: TournamentPackage): string => {
  const blocks: string[] = [];
  if (pkg.tiers?.length) {
    for (const tier of pkg.tiers.slice().sort((left, right) => left.tier - right.tier)) {
      const packages = tier.skillPackages?.length ? tier.skillPackages : pkg.skillPackages;
      if (!packages?.length) continue;
      blocks.push(skillPackageTable(packages, `Tier ${tier.tier} skill packages`));
    }
  } else if (pkg.skillPackages?.length) {
    blocks.push(skillPackageTable(pkg.skillPackages, "Skill packages"));
  }
  return blocks.join("");
};

const skillPackageTable = (packages: readonly SkillPackage[], caption: string): string => {
  const rows = packages.map((entry, index) => `<tr><th scope="row">${esc(entry.label ?? `Package ${index + 1}`)}</th><td>${esc(money(entry.gold))}</td><td>${esc(entry.skillPointBudget)}</td><td>${esc(entry.maxPerPlayer == null ? "No cap" : entry.maxPerPlayer)}</td><td>${esc(entry.starPlayersAllowed === false ? "No" : "Yes")}</td></tr>`).join("");
  return `<div class="table-scroll compact-table"><table><caption>${esc(caption)}</caption><thead><tr><th scope="col">Package</th><th scope="col">Gold</th><th scope="col">Skill budget</th><th scope="col">Skills per player</th><th scope="col">Stars</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

const costOverridesTable = (pkg: RulesPagePkg): string => {
  const names = uniqueNames([
    ...Object.keys(pkg.skillAllotment.skillCostSP),
    ...Object.keys(pkg.skillAllotment.skillCostGold ?? {}),
  ]).sort(byName);
  if (!names.length) return "";
  const hasGold = names.some((name) => pkg.skillAllotment.skillCostGold?.[name] != null);
  const rows = names.map((name) => `<tr><th scope="row">${esc(name)}</th><td>${esc(pkg.skillAllotment.skillCostSP[name] ?? "—")}</td>${hasGold ? `<td>${esc(pkg.skillAllotment.skillCostGold?.[name] == null ? "—" : money(pkg.skillAllotment.skillCostGold[name]))}</td>` : ""}</tr>`).join("");
  return `<div class="table-scroll compact-table"><table><caption>Per-skill price overrides</caption><thead><tr><th scope="col">Skill</th><th scope="col">SP</th>${hasGold ? '<th scope="col">Gold</th>' : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;
};

const skillsSection = (pkg: RulesPagePkg): string => {
  const allotment = pkg.skillAllotment;
  const pointUnit = allotment.primaryCostSP >= 5 && !allotment.skillCostGold ? "SPP" : "SP";
  const pointLabel = pkg.skillPointLabel ?? "Skill Points";
  const secondary = allotment.secondaryCostSP ?? allotment.primaryCostSP * allotment.secondaryMultiplier;
  const lines = [
    `Primary ${allotment.primaryCostSP} ${pointUnit}; secondary ${secondary} ${pointUnit}; elite surcharge +${allotment.eliteSurchargeSP} ${pointUnit}.`,
    allotment.stackSurchargeSP && allotment.stackSurchargeSP > 0
      ? `Each skill beyond a player's first costs +${allotment.stackSurchargeSP} ${pointUnit}.`
      : "",
    allotment.stackSurchargeGold && allotment.stackSurchargeGold > 0
      ? `Each skill beyond a player's first costs +${money(allotment.stackSurchargeGold)}.`
      : "",
    `Per-player cap: ${allotment.maxPerPlayer == null ? "none" : allotment.maxPerPlayer}.`,
    `Teamwide same-skill cap: ${allotment.maxSameSkillTeamwide == null ? "none" : allotment.maxSameSkillTeamwide}.`,
    `Default stacking: ${stackingText(allotment.maxStackedPlayers)}.`,
  ].filter(Boolean);
  const elite = allotment.eliteSkills.length
    ? `<p><strong>Elite skills:</strong> ${allotment.eliteSkills.map(esc).join(", ")}.</p>`
    : "";
  const flatCounts = allotment.maxPrimary != null || allotment.maxSecondary != null
    ? `<p><strong>Count allotment:</strong> ${esc(countAllotment(allotment.maxPrimary ?? null, allotment.maxSecondary ?? null, allotment.secondarySwap ?? false, allotment.secondarySwapRatio ?? 2, allotment.secondarySwapMax ?? null))}.</p>`
    : "";
  const goldPrices = allotment.primaryCostGold != null || allotment.secondaryCostGold != null || allotment.eliteSurchargeGold != null
    ? `<p><strong>Gold prices:</strong> primary ${esc(money(allotment.primaryCostGold ?? 20_000))}; secondary ${esc(money(allotment.secondaryCostGold ?? 40_000))}; elite surcharge +${esc(money(allotment.eliteSurchargeGold ?? 10_000))}.</p>`
    : "";
  return section(
    "Skills",
    `<p><strong>${esc(pointLabel)} prices:</strong> ${esc(lines[0])}</p><ul>${lines.slice(1).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>${goldPrices}${flatCounts}${elite}${costOverridesTable(pkg)}${skillPackagesTables(pkg)}`,
  );
};

const allBannedStars = (pkg: TournamentPackage): string[] =>
  uniqueNames([
    ...(pkg.bannedStars ?? []),
    ...(pkg.tiers ?? []).flatMap((tier) => tier.bannedStars),
    ...(pkg.matrix?.cells ?? []).flatMap((cell) => cell.bannedStars ?? []),
    ...(pkg.teamRules ?? []).flatMap((team) => team.bannedStars ?? []),
  ]).sort(byName);

const taxTable = (pkg: RulesPagePkg): string => {
  const brackets = pkg.starPlayers.spTaxByCombinedCost;
  if (!brackets?.length) return "";
  let previous = -1;
  const rows = brackets.map((bracket) => {
    const range = bracket.upToGold == null
      ? `${Math.max(0, previous + 1).toLocaleString("en-US")} gp and above`
      : `${Math.max(0, previous + 1).toLocaleString("en-US")}–${bracket.upToGold.toLocaleString("en-US")} gp`;
    previous = bracket.upToGold ?? previous;
    return `<tr><td>${esc(range)}</td><td>${esc(`${bracket.sp} SP`)}</td></tr>`;
  }).join("");
  return `<div class="table-scroll compact-table star-tax"><table><caption>Star Player skill-budget tax</caption><thead><tr><th scope="col">Combined star cost</th><th scope="col">Skill budget tax</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

const spCostTable = (pkg: RulesPagePkg): string => {
  const costs = pkg.starPlayers.spCostByTier;
  if (!costs || !Object.keys(costs).length) return "";
  const tierCount = Math.max(0, ...Object.values(costs).map((byTier) => byTier.length));
  const headings = Array.from({ length: tierCount }, (_unused, index) => `<th scope="col">Tier ${index + 1}</th>`).join("");
  const rows = Object.entries(costs).sort(([left], [right]) => byName(left, right)).map(([name, byTier]) =>
    `<tr><th scope="row">${esc(name)}</th>${Array.from({ length: tierCount }, (_unused, index) => `<td>${esc(byTier[index] ?? "—")}</td>`).join("")}</tr>`,
  ).join("");
  return `<div class="table-scroll"><table><caption>Star Player SP cost by tier</caption><thead><tr><th scope="col">Star Player</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div>`;
};

const starsSection = (pkg: RulesPagePkg): string => {
  const stars = pkg.starPlayers;
  const facts = [
    `Allowed: ${yesNo(stars.allowed)}.`,
    `Maximum count: ${stars.maxCount == null ? "no package cap" : stars.maxCount}.`,
    `Combined cost cap: ${money(stars.maxCombinedCost)}.`,
    `Paid in Skill Points: ${yesNo(stars.paidInSkillPoints === true)}.`,
  ];
  return section(
    "Star Players",
    `<ul>${facts.map((fact) => `<li>${esc(fact)}</li>`).join("")}</ul>${bannedList(allBannedStars(pkg), "Banned Star Players")}${taxTable(pkg)}${spCostTable(pkg)}<p class="eligibility-note">Stars must be eligible for the team under BB2025 (checked automatically).</p>`,
  );
};

const effectiveInducements = (pkg: RulesPagePkg): { id: string; name: string; cost: number | null; cap: number | null }[] => {
  const ids = pkg.inducements.allowed.includes("*")
    ? Object.keys(bb2025.inducements)
    : pkg.inducements.allowed;
  return uniqueNames(ids).map((id) => {
    const entry = bb2025.inducements[id];
    return {
      id,
      name: entry?.name ?? id,
      cost: entry?.cost ?? null,
      cap: pkg.inducements.caps[id] ?? entry?.max ?? null,
    };
  }).sort((left, right) => byName(left.name, right.name));
};

const inducementOverrides = (pkg: RulesPagePkg): string => {
  const rows = (pkg.inducements.capOverrides ?? []).flatMap((override) =>
    Object.entries(override.caps).map(([id, cap]) => {
      const name = bb2025.inducements[id]?.name ?? id;
      return `<li>${esc(`${name}: maximum ${cap} while a star with ${override.when.starHasSkill} is rostered${override.note ? ` (${override.note})` : ""}.`)}</li>`;
    }),
  );
  return rows.length ? `<h3>Conditional caps</h3><ul>${rows.join("")}</ul>` : "";
};

const sidelineList = (pkg: TournamentPackage): string => {
  const sideline = pkg.sideline;
  return `<h3>Sideline caps</h3><ul><li>Re-rolls: ${esc(capText(sideline.maxReRolls))}</li><li>Apothecary: ${esc(capText(sideline.maxApothecary))}</li><li>Cheerleaders: ${esc(capText(sideline.maxCheerleaders))}</li><li>Assistant coaches: ${esc(capText(sideline.maxAssistantCoaches))}</li><li>Dedicated fans: ${esc(capText(sideline.maxDedicatedFans))}</li></ul>`;
};

const inducementsSection = (pkg: RulesPagePkg): string => {
  const values = effectiveInducements(pkg);
  const body = values.length
    ? `<div class="table-scroll compact-table"><table><caption>Allowed inducements</caption><thead><tr><th scope="col">Inducement</th><th scope="col">Cost</th><th scope="col">Cap</th></tr></thead><tbody>${values.map((entry) => `<tr><th scope="row">${esc(entry.name)}</th><td>${esc(entry.cost == null ? "Variable" : money(entry.cost))}</td><td>${esc(entry.cap == null ? "No cap" : entry.cap)}</td></tr>`).join("")}</tbody></table></div>`
    : "<p>No inducements are allowed.</p>";
  return section("Inducements", `${body}${inducementOverrides(pkg)}${sidelineList(pkg)}`);
};

const atAGlance = (pkg: RulesPagePkg): string => {
  const stars = pkg.starPlayers;
  const starSummary = stars.allowed
    ? `Allowed; ${stars.maxCount == null ? "no count cap" : `maximum ${stars.maxCount}`}; combined cap ${money(stars.maxCombinedCost)}`
    : "Not allowed";
  const gold = mode(pkg) === "flat" ? money(pkg.goldBudget) : "Per tier, see table";
  return section("At a glance", `<dl class="at-a-glance">${[
    definition("Minimum players", String(pkg.special.minPlayers)),
    definition("Team budget", gold),
    definition("Skill budget model", packageSkillModel(pkg)),
    definition("Star Players", starSummary),
    definition("Stat increases", pkg.special.statIncreasesAllowed ? "Allowed" : "Not allowed"),
    definition("Slann", pkg.special.slannAllowed ? "Allowed" : "Not allowed"),
    definition("Re-rolls / Apothecary", `${capText(pkg.sideline.maxReRolls)} / ${capText(pkg.sideline.maxApothecary)}`),
  ].join("")}</dl>`);
};

const picker = (pkg: TournamentPackage, opts: RulesPageOptions): string => {
  const path = rulesPath(pkg, opts.baseHref);
  const options = eligibleRosters(pkg).map((name) =>
    `<option value="${esc(name)}"${opts.roster && normName(opts.roster) === normName(name) ? " selected" : ""}>${esc(rosterLabel(name))}</option>`,
  ).join("");
  return `<div class="rules-tools"><form class="roster-picker" method="get" action="${esc(path)}" data-rules-path="${esc(path)}" data-package-name="${esc(pkg.name)}" data-api-prefix="${esc(basePrefix(opts.baseHref))}"><label for="roster-picker">Focus a team</label><select id="roster-picker" name="roster"><option value="">All teams</option>${options}</select><button type="submit">Show team</button></form><button class="copy-link" type="button">Copy link</button><span class="copy-status" role="status" aria-live="polite"></span></div>`;
};

const racePanel = (pkg: RulesPagePkg, roster?: string): string => {
  if (!roster || !eligibleRosters(pkg).some((name) => normName(name) === normName(roster))) return "";
  const displayRoster = eligibleRosters(pkg).find((name) => normName(name) === normName(roster)) ?? roster;
  const cfg = resolveTeamConfig(pkg, displayRoster);
  const facts = [
    ["Gold", money(cfg.gold)],
    ["Skill budget", skillBudgetText(pkg, displayRoster)],
    ["Stacking", stackingText(cfg.maxStackedPlayers)],
    ["Stars", yesNo(cfg.starPlayersAllowed)],
    ["Allowed inducements", effectiveInducements(pkg).map((entry) => entry.name).join(", ") || "None"],
  ];
  return `<aside class="race-panel" data-race-panel><h2>Your team: ${esc(displayRoster)}</h2><dl>${facts.map(([term, value]) => definition(term!, value!)).join("")}</dl>${bannedList(cfg.bannedStars, "Banned Star Players for this team")}${taxTable(pkg)}</aside>`;
};

const problemsCallout = (problems: readonly string[]): string =>
  problems.length
    ? `<aside class="callout problems" aria-labelledby="package-problems"><h2 id="package-problems">Package problems</h2><ul>${problems.map((problem) => `<li>${esc(problem)}</li>`).join("")}</ul></aside>`
    : "";

const progressiveScript = (): string => `<script>
(function () {
  var form = document.querySelector('.roster-picker');
  var select = document.getElementById('roster-picker');
  var copy = document.querySelector('.copy-link');
  var status = document.querySelector('.copy-status');
  if (copy) copy.addEventListener('click', function () {
    navigator.clipboard.writeText(location.href).then(function () {
      if (status) status.textContent = 'Link copied.';
    }, function () {
      if (status) status.textContent = 'Copy failed; copy the address bar.';
    });
  });
  if (!form || !select || !window.fetch || !window.history) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    update(select.value);
  });
  select.addEventListener('change', function () { update(select.value); });
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char];
    });
  }
  function money(value) { return value == null ? 'No cap' : Number(value).toLocaleString('en-US') + ' gp'; }
  function stack(value) {
    if (value == null) return 'No cap';
    if (value === 0) return 'No stacking';
    if (value === 1) return '1 player may carry 2 skills';
    return 'Up to ' + value + ' players may carry 2 skills';
  }
  function resolvedStack(pkg, race, source) {
    var value = pkg.skillAllotment.maxStackedPlayers == null ? null : pkg.skillAllotment.maxStackedPlayers;
    var key = String(race).toLowerCase();
    var tier = (pkg.tiers || []).find(function (item) { return item.rosters.some(function (name) { return String(name).toLowerCase() === key; }); });
    if (tier && tier.maxStackedPlayers !== undefined) value = tier.maxStackedPlayers;
    if (pkg.matrix && source === 'matrix') {
      var cell = pkg.matrix.cells.find(function (item) { return item.teams.some(function (name) { return String(name).toLowerCase() === key; }); });
      var row = cell && pkg.matrix.rows[cell.row];
      if (row && row.maxStackedPlayers !== undefined) value = row.maxStackedPlayers;
    }
    var team = (pkg.teamRules || []).find(function (item) { return String(item.team).toLowerCase() === key; });
    if (team && team.maxStackedPlayers !== undefined) value = team.maxStackedPlayers;
    return value;
  }
  function taxTable(pkg) {
    var brackets = pkg.starPlayers.spTaxByCombinedCost || [];
    if (!brackets.length) return '';
    var previous = -1;
    var rows = brackets.map(function (bracket) {
      var from = Math.max(0, previous + 1).toLocaleString('en-US');
      var range = bracket.upToGold == null ? from + ' gp and above' : from + '–' + Number(bracket.upToGold).toLocaleString('en-US') + ' gp';
      if (bracket.upToGold != null) previous = bracket.upToGold;
      return '<tr><td>' + escapeHtml(range) + '</td><td>' + escapeHtml(bracket.sp + ' SP') + '</td></tr>';
    }).join('');
    return '<div class="table-scroll compact-table star-tax"><table><caption>Star Player skill-budget tax</caption><thead><tr><th scope="col">Combined star cost</th><th scope="col">Skill budget tax</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function update(roster) {
    var url = new URL(form.dataset.rulesPath, location.origin);
    if (roster) url.searchParams.set('roster', roster);
    history.replaceState(null, '', url.pathname + url.search);
    document.querySelectorAll('[data-team-row]').forEach(function (row) {
      if (roster && row.dataset.roster.toLowerCase() === roster.toLowerCase()) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
    var current = document.querySelector('[data-race-panel]');
    if (!roster) { if (current) current.remove(); return; }
    var api = (form.dataset.apiPrefix || '') + '/api/packages/' + encodeURIComponent(form.dataset.packageName) + '?roster=' + encodeURIComponent(roster);
    fetch(api).then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); }).then(function (body) {
      var race = body.rules && body.rules.race;
      if (!race) return;
      var cfg = body.pkg;
      var inducementIds = cfg.inducements.allowed.indexOf('*') >= 0 ? Object.keys((body.inducements || {})) : cfg.inducements.allowed;
      var facts = [
        ['Gold', money(race.gold)],
        ['Skill budget', race.packs && race.packs.length ? 'Choose a skill package' : String(race.skillPointBudget)],
        ['Stacking', stack(resolvedStack(cfg, race.roster, race.source))],
        ['Stars', race.stars.allowed ? 'Yes' : 'No'],
        ['Allowed inducements', inducementIds.length ? inducementIds.join(', ') : 'None']
      ];
      var panel = document.createElement('aside');
      panel.className = 'race-panel'; panel.setAttribute('data-race-panel', '');
      var bans = (race.bannedStars || []).slice().sort();
      panel.innerHTML = '<h2>Your team: ' + escapeHtml(race.roster) + '</h2><dl>' + facts.map(function (item) { return '<div><dt>' + escapeHtml(item[0]) + '</dt><dd>' + escapeHtml(item[1]) + '</dd></div>'; }).join('') + '</dl>' + (bans.length ? '<p>Banned Star Players for this team:</p><ul class="chip-list" aria-label="Banned Star Players for this team">' + bans.map(function (name) { return '<li class="banned-' + 'star-chip">' + escapeHtml(name) + '</li>'; }).join('') + '</ul>' : '<p>Banned Star Players for this team: None.</p>') + taxTable(cfg);
      if (current) current.replaceWith(panel); else form.parentElement.parentElement.insertAdjacentElement('afterend', panel);
    }).catch(function () { location.assign(url.pathname + url.search); });
  }
})();
</script>`;

const shell = (title: string, body: string, footer: string, opts: RulesPageOptions): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${esc(assetPath("theme.css", opts.baseHref))}">
<link rel="stylesheet" href="${esc(assetPath("rules-page.css", opts.baseHref))}">
<script src="${esc(assetPath("theme.js", opts.baseHref))}" defer></script>
<style>@media print{body{color:#000;background:#fff}.rules-tools,.theme-toggle{display:none!important}table,th,td{border-color:#000!important}}</style></head>
<body><div class="rules-page">${body}<footer>${footer}</footer></div>${progressiveScript()}</body></html>`;

export function renderRulesPage(pkg: TournamentPackage, opts: RulesPageOptions = {}): string {
  const pagePkg = pkg as RulesPagePkg;
  const date = generatedDate(opts.generatedAt);
  const metadata = [pkg.date ? formatDate(pkg.date) : "", pkg.ruleset, "Validator-enforced"].filter(Boolean);
  const header = `<header><h1>${esc(pkg.name)}</h1><p class="metadata">${metadata.map(esc).join(" · ")}</p>${pkg.description ? `<p class="lede">${esc(pkg.description)}</p>` : ""}${pkg.dataNote ? dataNoteCallout(pkg.dataNote) : ""}</header>`;
  const activeMode = mode(pkg);
  const teamSection = activeMode === "matrix"
    ? matrixSection(pkg)
    : activeMode === "flat"
      ? flatTeamsSection(pkg)
      : teamRowsSection(pkg, opts.roster);
  const main = `<main>${picker(pkg, opts)}${racePanel(pagePkg, opts.roster)}${atAGlance(pagePkg)}${teamSection}${skillsSection(pagePkg)}${starsSection(pagePkg)}${inducementsSection(pagePkg)}${problemsCallout(opts.problems ?? [])}</main>`;
  const footer = `Generated from ${esc(pkg.name)}${date ? ` on ${esc(date)}` : ""} · BB Tournament Validator · Problems: ${opts.problems?.length ? esc(opts.problems.length) : "none"}`;
  return shell(`${pkg.name} — Rules`, `${header}${main}`, footer, opts);
}

/** Same visual shell as a rules page, without inventing package content. */
export function renderRulesPageNotFound(packageId: string, opts: Pick<RulesPageOptions, "baseHref"> = {}): string {
  const body = `<header><h1>No ruleset called “${esc(packageId)}”</h1><p class="metadata">BB Tournament Validator</p></header><main><p>Check the link or ask the tournament organiser for the current ruleset URL.</p></main>`;
  return shell(`Ruleset not found — ${packageId}`, body, "BB Tournament Validator", opts);
}
