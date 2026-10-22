/*
 * Super FUMBBL — browser Team Builder (config-web /team-builder.html).
 *
 * Ports the desktop client's dev-branch TeamBuilderView (Vue) to dependency-free JS:
 * Create / Custom / Tournament modes, the fork-library edit flow, per-player skills and
 * stat increases, star players (incl. star pairs and tournament star packs), rostered
 * inducements, the pick-one league / special rule, server-authoritative preview, build,
 * saved drafts for signed-in coaches, and a printable roster sheet.
 *
 * Layout: a PURE core (no DOM; exported as globalThis.TeamBuilderCore so vitest can load
 * this file in a vm and exercise it) followed by the UI, which only boots on the page.
 * The server preview is authoritative — the client never re-implements legality beyond
 * UX hints (caps, greyed buttons).
 */
(() => {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;

  // ════════════════════════════════════════════════════════════════════════════
  // PURE CORE
  // ════════════════════════════════════════════════════════════════════════════
  const Core = (() => {
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
    const isNum = (value) => typeof value === "number" && Number.isFinite(value);
    /** Coerce a server/package value to a finite number, else null — every number rendered into
     *  markup passes through here (or gold()), so a hostile package can't smuggle HTML in a "number". */
    const num = (value) => {
      if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const str = (value) => (value === null || value === undefined ? "" : String(value));
    const gold = (value) => isNum(value) ? `${Math.round(value / 1000).toLocaleString("en-US")}k` : "—";
    const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const STATS = ["MA", "ST", "AG", "PA", "AV"];

    // ── League / special rule (port of teamBuilderLeaguePresentation.ts) ──
    function normalizeLeagueOptions(options) {
      const seen = new Set();
      const out = [];
      for (const option of options ?? []) {
        const league = String(option ?? "").trim();
        if (!league || seen.has(league)) continue;
        seen.add(league);
        out.push(league);
      }
      return out;
    }
    function leagueFieldPresentation(options, selection) {
      const menu = options.length > 1;
      const selectedValid = options.includes(selection.selectedLeague) && (!menu || selection.explicit);
      return {
        visible: options.length > 0,
        interactive: menu,
        selectionRequired: menu && !selectedValid,
        selectedValid,
      };
    }
    function reconcileLeagueSelection(options, current) {
      if (options.length === 1) return { selectedLeague: options[0] ?? "", explicit: false };
      if (options.length > 1 && current.explicit && options.includes(current.selectedLeague)) return current;
      return { selectedLeague: "", explicit: false };
    }
    function explicitLeagueSpecialRule(options, selection) {
      if (options.length <= 1 || !selection.explicit) return undefined;
      return options.includes(selection.selectedLeague) ? selection.selectedLeague : undefined;
    }
    const normRule = (value) => String(value ?? "").trim().toLocaleLowerCase();
    function starEligibleForLeague(playsFor, options, selectedLeague) {
      if (options.length === 0) return true;
      if (!options.includes(selectedLeague)) return false;
      const rules = (playsFor ?? []).map(normRule).filter(Boolean);
      if (rules.length === 0 || rules.includes("(any)")) return true;
      const selected = normRule(selectedLeague);
      if (rules.includes("(negate availability)")) {
        return !rules.some((rule) => rule !== "(negate availability)" && rule === selected);
      }
      if (rules.includes(selected)) return true;
      const selectable = new Set(options.map(normRule));
      return !rules.some((rule) => selectable.has(rule));
    }

    // ── Star choices incl. pairs (port of teamBuilderStarPairs.ts) ──
    const KNOWN_PAIRS = [
      { label: "Grak & Crumbleberry", names: ["Grak", "Crumbleberry"] },
      { label: "Dribl & Drull", names: ["Dribl", "Drull"] },
      { label: "Valen & Lucien Swift", names: ["Valen Swift", "Lucien Swift"] },
    ];
    function choiceFor(members, known) {
      const ordered = known
        ? known.names.map((name) => members.find((member) => norm(member.name) === norm(name)))
        : [...members].sort((a, b) => a.name.localeCompare(b.name));
      return {
        key: ordered.map((member) => member.positionId).sort().join("|"),
        label: known?.label ?? ordered.map((member) => member.name).join(" & "),
        members: ordered,
        cost: ordered.reduce((sum, member) => sum + (member.cost ?? 0), 0),
        paired: ordered.length > 1,
      };
    }
    function buildStarChoices(positions) {
      const stars = (positions ?? []).filter((position) => position.isStar === true);
      const byId = new Map(stars.map((star) => [star.positionId, star]));
      const byName = new Map(stars.map((star) => [norm(star.name), star]));
      const consumed = new Set();
      const invalid = new Set();
      const choices = [];
      for (const star of stars) {
        const partnerId = String(star.teamWithPositionId ?? "").trim();
        if (!partnerId || consumed.has(star.positionId) || invalid.has(star.positionId)) continue;
        const partner = byId.get(partnerId);
        if (!partner) { invalid.add(star.positionId); continue; }
        const linked = stars.filter((candidate) => candidate.positionId === star.positionId
          || candidate.positionId === partner.positionId
          || candidate.teamWithPositionId === star.positionId
          || candidate.teamWithPositionId === partner.positionId);
        const ids = new Set(linked.map((candidate) => candidate.positionId));
        if (linked.length !== 2 || !linked.every((c) => !c.teamWithPositionId || ids.has(c.teamWithPositionId))) {
          for (const candidate of linked) invalid.add(candidate.positionId);
          continue;
        }
        const names = new Set(linked.map((member) => norm(member.name)));
        const known = KNOWN_PAIRS.find((pair) => pair.names.every((name) => names.has(norm(name))));
        choices.push(choiceFor(linked, known));
        for (const candidate of linked) consumed.add(candidate.positionId);
      }
      for (const pair of KNOWN_PAIRS) {
        const present = pair.names.map((name) => byName.get(norm(name))).filter(Boolean);
        if (present.length === 0) continue;
        if (present.length === 2 && present.every((p) => consumed.has(p.positionId))) continue;
        if (present.length !== 2 || present.some((p) => consumed.has(p.positionId) || invalid.has(p.positionId))) {
          for (const p of present) invalid.add(p.positionId);
          continue;
        }
        choices.push(choiceFor(present, pair));
        for (const p of present) consumed.add(p.positionId);
      }
      for (const star of stars) {
        if (consumed.has(star.positionId) || invalid.has(star.positionId)) continue;
        choices.push(choiceFor([star]));
      }
      return choices;
    }

    // ── Position-group caps (Big Guy limits) ──
    function positionGroupCapped(positionId, groups, counts) {
      for (const group of groups ?? []) {
        if (!group || !Array.isArray(group.positions) || !isNum(group.max)) continue;
        if (!group.positions.includes(positionId)) continue;
        const total = group.positions.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
        if (total >= group.max) return group;
      }
      return null;
    }

    // ── Wire picks ──
    /** Slots → TeamPick[] in slot order. Consecutive identical players merge into one pick
     *  (count:n); any player with added skills / stat increases otherwise rides its own pick so
     *  two players of one position can carry different skills (TeamPick contract). Order is kept so
     *  a saved body restores the exact roster order. */
    function buildPicks(slots, options = {}) {
      const withSkills = options.skills !== false;
      const withStats = options.stats === true;
      const allowedStats = Array.isArray(options.allowedStats) ? options.allowedStats : null;
      const withCustomStats = options.customStats === true;
      const picks = [];
      let last = null;
      for (const slot of slots ?? []) {
        const chosenSkills = withSkills && !slot.isStar ? [...(slot.chosenSkills ?? [])] : [];
        const chosenStatIncreases = withStats && !slot.isStar
          ? (slot.chosenStatIncreases ?? []).filter((stat) => !allowedStats || allowedStats.includes(stat))
          : [];
        const chosenStats = {};
        if (withCustomStats && !slot.isStar) {
          // Server contract: integers 0-20 on MA/ST/AG/PA/AV only.
          for (const stat of STATS) {
            const value = num(slot.chosenStats?.[stat]);
            if (value !== null && Number.isInteger(value) && value >= 0 && value <= 20) chosenStats[stat] = value;
          }
        }
        const statsKey = STATS.filter((stat) => stat in chosenStats).map((stat) => `${stat}${chosenStats[stat]}`).join(",");
        const signature = `${slot.positionId}|${chosenSkills.join(",")}|${chosenStatIncreases.join(",")}|${statsKey}`;
        if (last && last.signature === signature) {
          last.pick.count += 1;
          continue;
        }
        const pick = { positionId: slot.positionId, count: 1 };
        if (chosenSkills.length) pick.chosenSkills = chosenSkills;
        if (chosenStatIncreases.length) pick.chosenStatIncreases = chosenStatIncreases;
        if (statsKey) pick.chosenStats = chosenStats;
        picks.push(pick);
        last = { signature, pick };
      }
      return picks;
    }
    /** TeamPick[] → slots (inverse of buildPicks; used when restoring a saved body). */
    function slotsFromPicks(picks, positionById) {
      const slots = [];
      for (const pick of picks ?? []) {
        const count = Math.max(0, Math.floor(Number(pick?.count) || 0));
        const position = positionById(pick?.positionId);
        if (!position) continue;
        for (let i = 0; i < count; i++) {
          slots.push({
            positionId: position.positionId,
            isStar: position.isStar === true,
            chosenSkills: Array.isArray(pick.chosenSkills) ? pick.chosenSkills.map(String) : [],
            chosenStatIncreases: Array.isArray(pick.chosenStatIncreases)
              ? pick.chosenStatIncreases.map((stat) => String(stat).toUpperCase()).filter((stat) => STATS.includes(stat))
              : [],
            ...(pick.chosenStats && typeof pick.chosenStats === "object"
              ? { chosenStats: Object.fromEntries(STATS.filter((stat) => num(pick.chosenStats[stat]) !== null).map((stat) => [stat, num(pick.chosenStats[stat])])) }
              : {}),
          });
        }
      }
      return slots;
    }

    // ── Stat increases ──
    const targetNum = (value) => {
      const match = String(value ?? "").match(/(\d+)/);
      return match ? Number(match[1]) : null;
    };
    /** Apply chosen +1 characteristic increases to a position's printed profile.
     *  MA/ST/AV go up by one (AV 10+ → 11+); AG/PA targets improve by one (4+ → 3+, floor 1+). */
    function improvedStats(position, increases, overrides) {
      const out = {};
      for (const stat of STATS) out[stat] = { value: position?.[stat] ?? "—", improved: false };
      // Custom-mode chosenStats: absolute raw values (AG/PA/AV are roll targets, e.g. 3 = "3+").
      for (const stat of STATS) {
        const n = num(overrides?.[stat]);
        if (n === null) continue;
        const value = stat === "MA" || stat === "ST" ? n : n > 0 ? `${n}+` : "-";
        if (String(value) !== String(out[stat].value)) out[stat] = { value, improved: true };
      }
      for (const raw of increases ?? []) {
        const stat = String(raw).toUpperCase();
        const cell = out[stat];
        if (!cell) continue;
        if (stat === "MA" || stat === "ST") {
          const n = Number(cell.value);
          if (Number.isFinite(n)) cell.value = n + 1;
        } else if (stat === "AV") {
          const n = targetNum(cell.value);
          if (n != null) cell.value = `${n + 1}+`;
        } else {
          const n = targetNum(cell.value);
          if (n != null) cell.value = `${Math.max(1, n - 1)}+`;
        }
        cell.improved = true;
      }
      return out;
    }
    /** Gold cost of one stat increase: `costGold` may be a flat number or a per-stat map. */
    function statIncreaseCost(statRules, stat) {
      const cost = statRules?.costGold;
      if (isNum(cost)) return cost;
      if (cost && typeof cost === "object" && isNum(cost[stat])) return cost[stat];
      return null;
    }

    // ── Package rules (Small Gods-style tier knobs) ──
    /** Normalize a `rules` block from the preview echo, or the same per-tier fields carried
     *  flat (or under `rules`) on a /tiers row. Null when none of the knobs are present. */
    function normalizeTierRules(raw) {
      if (!raw || typeof raw !== "object") return null;
      const src = raw.rules && typeof raw.rules === "object" ? raw.rules : raw;
      const keys = ["maxSecondary", "eliteMaxTotal", "eliteMaxSameSkill", "maxStackedPlayers", "stackedPlayer", "statIncreases", "starPacks", "maxStars"];
      if (!keys.some((key) => key in src)) return null;
      let stat = src.statIncreases && typeof src.statIncreases === "object" ? src.statIncreases : null;
      // `allowed` is either a boolean or the list of characteristics this tier may raise ([] = none).
      if (stat && Array.isArray(stat.allowed)) {
        const stats = stat.allowed.map((s) => String(s).toUpperCase()).filter((s) => STATS.includes(s));
        stat = stats.length ? { ...stat, stats } : null;
      }
      if (stat) {
        const cost = stat.costGold;
        const costGold = num(cost) ?? (cost && typeof cost === "object"
          ? Object.fromEntries(STATS.filter((k) => num(cost[k]) !== null).map((k) => [k, num(cost[k])]))
          : null);
        stat = stat.allowed === false ? null : {
          allowed: stat.allowed,
          ...(Array.isArray(stat.stats) ? { stats: stat.stats.map((k) => String(k).toUpperCase()).filter((k) => STATS.includes(k)) } : {}),
          costGold,
          maxPerPlayer: num(stat.maxPerPlayer),
          ...(stat.exclusiveWithSkills === false ? { exclusiveWithSkills: false } : {}),
        };
      }
      const stacked = src.stackedPlayer && typeof src.stackedPlayer === "object" ? src.stackedPlayer : null;
      return {
        tier: num(src.tier ?? raw.tier),
        maxSecondary: num(src.maxSecondary),
        eliteMaxTotal: num(src.eliteMaxTotal),
        eliteMaxSameSkill: num(src.eliteMaxSameSkill),
        maxStackedPlayers: num(src.maxStackedPlayers),
        stackedPlayer: stacked ? { maxSkills: num(stacked.maxSkills), maxSecondary: num(stacked.maxSecondary), maxElite: num(stacked.maxElite) } : null,
        statIncreases: stat,
        starPacks: Array.isArray(src.starPacks)
          ? src.starPacks.filter((pack) => pack && typeof pack === "object").map((pack) => ({
            id: str(pack.id),
            label: str(pack.label ?? pack.id ?? "Pack"),
            fee: num(pack.fee),
            feeMode: pack.feeMode === "each" ? "each" : "once",
            max: num(pack.max),
            stars: Array.isArray(pack.stars) ? pack.stars.map(str) : [],
          }))
          : [],
        maxStars: num(src.maxStars),
      };
    }
    const countLabel = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    function stackLabel(stacked) {
      if (!stacked) return "—";
      const parts = [];
      // Plain "max" wording: the page's display font has no "≤" glyph.
      if (isNum(stacked.maxSkills)) parts.push(`max ${countLabel(stacked.maxSkills, "skill")}`);
      if (isNum(stacked.maxSecondary)) parts.push(`max ${stacked.maxSecondary} secondary`);
      if (isNum(stacked.maxElite)) parts.push(`max ${stacked.maxElite} elite`);
      return parts.join(" · ") || "—";
    }
    function statIncreaseLabel(stat) {
      if (!stat) return "—";
      const cost = stat.costGold;
      const allowed = Array.isArray(stat.stats) ? stat.stats : null;
      if (isNum(cost)) return allowed ? allowed.map((k) => `+${k} ${gold(cost)}`).join(", ") : `+1 stat (${gold(cost)})`;
      if (cost && typeof cost === "object") {
        return Object.entries(cost)
          .filter(([k, v]) => isNum(v) && (!allowed || allowed.includes(k)))
          .map(([k, v]) => `+${k} ${gold(v)}`).join(", ") || "Allowed";
      }
      return allowed ? allowed.map((k) => `+${k}`).join(", ") : "Allowed";
    }
    function starPackLabel(pack) {
      const fee = isNum(pack.fee) && pack.fee > 0 ? ` +${gold(pack.fee)}${pack.feeMode === "each" ? " each" : " once"}` : "";
      const max = isNum(pack.max) ? ` (max ${pack.max})` : "";
      return `${pack.label ?? pack.id ?? "Pack"}${fee}${max}`;
    }
    /** The tier's limits as short display lines for the ruleset panel. */
    function tierLimitLines(rules) {
      if (!rules) return [];
      const lines = [];
      if (rules.maxSecondary != null) lines.push(`Secondary skills: max ${rules.maxSecondary}`);
      if (rules.eliteMaxTotal != null || rules.eliteMaxSameSkill != null) {
        const parts = [];
        if (rules.eliteMaxTotal != null) parts.push(`max ${rules.eliteMaxTotal} total`);
        if (rules.eliteMaxSameSkill != null) parts.push(`max ${rules.eliteMaxSameSkill} of the same skill`);
        lines.push(`Elite skills: ${parts.join(", ")}`);
      }
      if (rules.maxStackedPlayers != null) {
        lines.push(`Stacked players: max ${rules.maxStackedPlayers}${rules.stackedPlayer ? ` (${stackLabel(rules.stackedPlayer)})` : ""}`);
      }
      if (rules.statIncreases) lines.push(`Characteristics: ${statIncreaseLabel(rules.statIncreases)} (max ${rules.statIncreases.maxPerPlayer ?? 1} per player)`);
      if (rules.maxStars != null) lines.push(`Star players: max ${rules.maxStars}`);
      if (rules.starPacks?.length) lines.push(`Star packs: ${rules.starPacks.map(starPackLabel).join(" · ")}`);
      return lines;
    }
    /** /tiers rows (one per race) → one tournament-rules-sheet row per tier. */
    function tierTable(rows, tierSummary) {
      const byTier = new Map();
      for (const row of rows ?? []) {
        if (!row || !isNum(Number(row.tier))) continue;
        const tier = Number(row.tier);
        const entry = byTier.get(tier) ?? { tier, rosters: [], rules: null };
        const summaryGold = (tierSummary ?? []).find((t) => t.tier === tier)?.gold;
        const rowGold = row.gold ?? row.goldCap ?? row.budget ?? row.rules?.gold ?? summaryGold ?? null;
        const rowRules = normalizeTierRules(row);
        entry.rosters.push({ name: str(row.name), gold: num(rowGold), starPacks: rowRules?.starPacks ?? [] });
        entry.rules = entry.rules ?? normalizeTierRules(row);
        byTier.set(tier, entry);
      }
      return [...byTier.values()]
        .sort((a, b) => a.tier - b.tier)
        .map((entry) => ({ ...entry, rosters: entry.rosters.sort((a, b) => String(a.name).localeCompare(String(b.name))) }));
    }
    function tierTableHtml(table) {
      if (!table.length) return "";
      const detailed = table.some((row) => row.rules);
      const head = detailed
        ? "<tr><th scope=\"col\">Tier</th><th scope=\"col\">Rosters (gold cap)</th><th scope=\"col\">Secondary</th><th scope=\"col\">Elite</th><th scope=\"col\">Stacks</th><th scope=\"col\">Stack types</th><th scope=\"col\">Characteristics</th><th scope=\"col\">Star packs</th></tr>"
        : "<tr><th scope=\"col\">Tier</th><th scope=\"col\">Rosters (gold cap)</th></tr>";
      const body = table.map((row) => {
        const rosters = row.rosters.map((r) => `${esc(r.name)}${r.gold != null ? ` <small>(${gold(r.gold)})</small>` : ""}`).join(", ");
        if (!detailed) return `<tr><th scope="row">${esc(row.tier)}</th><td>${rosters}</td></tr>`;
        const r = row.rules ?? {};
        const elite = [r.eliteMaxTotal != null ? `${r.eliteMaxTotal} total` : "", r.eliteMaxSameSkill != null ? `${r.eliteMaxSameSkill} same` : ""].filter(Boolean).join(" · ") || "—";
        // Star packs can differ per roster inside a tier (e.g. an underdog roster unlocking every pack):
        // show the tier's common set, then name the rosters that differ.
        const packKey = (packs) => packs.map((p) => starPackLabel(p)).join("\u0000");
        const tally = new Map();
        for (const roster of row.rosters) tally.set(packKey(roster.starPacks), (tally.get(packKey(roster.starPacks)) ?? 0) + 1);
        const common = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
        const exceptions = row.rosters.filter((roster) => packKey(roster.starPacks) !== common)
          .map((roster) => `<div class="tier-pack-exception"><b>${esc(roster.name)}:</b> ${roster.starPacks.length ? roster.starPacks.map((p) => esc(starPackLabel(p))).join(" · ") : "none"}</div>`).join("");
        const packsCell = (common ? common.split("\u0000").map(esc).join("<br>") : "—") + exceptions;
        return `<tr><th scope="row">${esc(row.tier)}</th><td>${rosters}</td><td>${esc(r.maxSecondary ?? "—")}</td><td>${esc(elite)}</td><td>${esc(r.maxStackedPlayers ?? "—")}</td><td>${esc(stackLabel(r.stackedPlayer))}</td><td>${esc(statIncreaseLabel(r.statIncreases))}</td><td>${packsCell}</td></tr>`;
      }).join("");
      return `<thead>${head}</thead><tbody>${body}</tbody>`;
    }
    /** Star packs that contain a given star (by normalized name). */
    function starPacksFor(starName, starPacks) {
      const key = norm(starName);
      return (starPacks ?? []).filter((pack) => (pack.stars ?? []).some((name) => norm(name) === key));
    }

    // ── SP model (port of teamBuilderRuleset.ts playerSkillSp) ──
    const DEFAULT_SKILL_COSTS = { primary: 1, secondary: 2, eliteSurcharge: 0.5, stackSurcharge: 0, eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"] };
    function playerSkillSp(names, secondaryOf, costs = DEFAULT_SKILL_COSTS) {
      const elite = new Set((costs.eliteSkills ?? []).map((s) => s.toLowerCase().replace(/[^a-z]/g, "")));
      const base = names.reduce((sum, name) => sum
        + (secondaryOf(name) ? costs.secondary : costs.primary)
        + (elite.has(name.toLowerCase().replace(/[^a-z]/g, "")) ? costs.eliteSurcharge : 0), 0);
      return base + Math.max(0, names.length - 1) * (costs.stackSurcharge ?? 0);
    }

    // ── Roster sheet ──
    const titleCase = (value) => String(value ?? "").replace(/\b([a-z])/g, (m) => m.toUpperCase());
    /**
     * Build the printable roster-sheet model. `input`:
     *   { raceName, coach, teamName, players:[{ position, chosenSkills, chosenStatIncreases, accessOf(skill) }],
     *     staff:{reRolls,apothecary,assistantCoaches,cheerleaders,dedicatedFans}, apothecaryAllowed,
     *     inducements:[{label,count}], specialRules:[], summary (preview summary or null),
     *     costs:{ players, stars, sideline, skills, inducements } (client fallbacks), budget }
     */
    function rosterSheetModel(input) {
      const regular = [];
      const stars = [];
      for (const player of input.players ?? []) {
        const position = player.position ?? {};
        const stats = improvedStats(position, player.chosenStatIncreases, player.chosenStats);
        const added = (player.chosenSkills ?? []).map((skill) => ({ name: skill, access: player.accessOf ? player.accessOf(skill) : "primary" }));
        const row = {
          position: position.name ?? "Unknown position",
          stats,
          printed: [...(Array.isArray(position.skillsDisplay) && position.skillsDisplay.length ? position.skillsDisplay : position.skills ?? [])].sort((x, y) => x.localeCompare(y)),
          added,
          statIncreases: (player.chosenStatIncreases ?? []).map((s) => String(s).toUpperCase()),
          cost: position.cost ?? null,
          keywords: Array.isArray(position.keywords) ? position.keywords.map(titleCase) : null,
          isStar: position.isStar === true,
        };
        (row.isStar ? stars : regular).push(row);
      }
      const rows = [...regular, ...stars].map((row, index) => ({ ...row, number: index + 1 }));
      const summary = input.summary ?? null;
      const costs = input.costs ?? {};
      const pick = (serverValue, clientValue) => (isNum(serverValue) ? serverValue : clientValue);
      const primaryCount = rows.reduce((n, r) => n + r.added.filter((s) => s.access !== "secondary").length, 0);
      const secondaryCount = rows.reduce((n, r) => n + r.added.filter((s) => s.access === "secondary").length, 0);
      const summaryRows = [
        ["Players cost", gold(costs.players)],
        ...(stars.length ? [["Star players cost", gold(pick(summary?.starsCost, costs.stars))]] : []),
        ["Skills cost", gold(pick(summary?.skillsCost, costs.skills))],
        ...(isNum(summary?.statIncreasesCost) && summary.statIncreasesCost > 0 ? [["Stat increases", gold(summary.statIncreasesCost)]] : []),
        ...(isNum(summary?.starFeesCost) && summary.starFeesCost > 0 ? [["Star fees", gold(summary.starFeesCost)]] : []),
        ["Inducement cost", gold(pick(summary?.inducementsCost, costs.inducements))],
        ["Sideline cost", gold(costs.sideline)],
        ["Primary skills", String(pick(summary?.primarySkillCount, primaryCount))],
        ["Secondary skills", String(pick(summary?.secondarySkillCount, secondaryCount))],
      ];
      if (isNum(summary?.goldUsed)) {
        const budget = isNum(input.budget) ? input.budget : summary.goldBudget;
        summaryRows.push(["Total", isNum(budget) ? `${gold(summary.goldUsed)} / ${gold(budget)}` : gold(summary.goldUsed)]);
      }
      const staff = input.staff ?? {};
      const sideline = [
        ["Apothecary", input.apothecaryAllowed === false ? "—" : (staff.apothecary ? "Yes" : "No")],
        ["Assistant coaches", String(staff.assistantCoaches ?? 0)],
        ["Cheerleaders", String(staff.cheerleaders ?? 0)],
        ["Dedicated fans", String(staff.dedicatedFans ?? 1)],
        ["Rerolls", String(staff.reRolls ?? 0)],
      ];
      const keywordRows = [];
      const seenPositions = new Set();
      for (const row of rows) {
        if (!row.keywords?.length || seenPositions.has(row.position)) continue;
        seenPositions.add(row.position);
        keywordRows.push({ position: row.position, keywords: row.keywords });
      }
      return {
        raceName: input.raceName ?? "",
        coach: input.coach ?? "",
        teamName: input.teamName ?? "",
        rulesetName: input.rulesetName ?? "",
        sideline,
        inducements: (input.inducements ?? []).filter((item) => item.count > 0),
        specialRules: [...new Set((input.specialRules ?? []).map((rule) => String(rule).trim()).filter(Boolean))],
        summary: summaryRows,
        rows,
        keywords: keywordRows,
      };
    }
    function sheetStatCell(cell) {
      return cell.improved ? `<td class="stat improved">${esc(cell.value)}</td>` : `<td class="stat">${esc(cell.value)}</td>`;
    }
    function sheetSkills(row) {
      const parts = row.printed.map((skill) => `<span class="sk-printed">${esc(skill)}</span>`);
      for (const skill of row.added) {
        const cls = skill.access === "secondary" ? "sk-secondary" : "sk-primary";
        parts.push(`<span class="${cls}">${esc(skill.name)}</span>`);
      }
      for (const stat of row.statIncreases) parts.push(`<span class="sk-stat">+${esc(stat)}</span>`);
      return parts.join(", ");
    }
    function sheetBox(title, body) {
      return `<div class="rs-box"><div class="rs-box-title">${esc(title)}</div>${body}</div>`;
    }
    const kvRows = (pairs) => `<table class="rs-kv">${pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;
    function rosterSheetHtml(model) {
      const inducements = model.inducements.length
        ? kvRows(model.inducements.map((item) => [item.label, String(item.count)]))
        : '<p class="rs-none">None</p>';
      const rules = model.specialRules.length
        ? `<ul class="rs-rules">${model.specialRules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul>`
        : '<p class="rs-none">None</p>';
      const rows = model.rows.map((row) => `<tr${row.isStar ? ' class="rs-star"' : ""}>
        <td class="num">${row.number}</td>
        <td class="pos">${esc(row.position)}${row.isStar ? ' <small>(Star)</small>' : ""}</td>
        ${["MA", "ST", "AG", "PA", "AV"].map((stat) => sheetStatCell(row.stats[stat])).join("")}
        <td class="skills">${sheetSkills(row)}</td>
        <td class="cost">${esc(row.cost != null ? gold(row.cost) : "—")}</td>
      </tr>`).join("");
      const keywords = model.keywords.length
        ? `<p class="rs-keywords">Keywords: ${model.keywords.map((k) => `<b>${esc(k.position)}:</b> ${esc(k.keywords.join(", "))}`).join(" | ")}</p>`
        : "";
      return `<article class="roster-sheet">
  <header class="rs-top">
    <div class="rs-ident">
      <div class="rs-race">${esc(model.raceName)}</div>
      <div class="rs-label-row"><span class="rs-label">COACH NAME</span><span class="rs-value">${esc(model.coach)}</span></div>
      <div class="rs-label-row"><span class="rs-label">TEAM NAME</span><span class="rs-value">${esc(model.teamName)}</span></div>
      ${model.rulesetName ? `<div class="rs-ruleset">${esc(model.rulesetName)}</div>` : ""}
    </div>
    ${sheetBox("SIDELINE", kvRows(model.sideline))}
    ${sheetBox("INDUCEMENTS", inducements)}
    ${sheetBox("LEAGUES & SPECIAL RULES", rules)}
    ${sheetBox("SUMMARY", kvRows(model.summary))}
  </header>
  <table class="rs-roster">
    <thead><tr><th class="num">#</th><th class="pos">POSITION</th><th>MA</th><th>ST</th><th>AG</th><th>PA</th><th>AV</th><th class="skills">SKILLS</th><th class="cost">COST</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${keywords}
</article>`;
    }
    /** Sheet styles — used for the print view on the page AND the standalone download. */
    const SHEET_CSS = `
.roster-sheet{color:#000;background:#fff;font-family:"Noto Serif","Times New Roman",Times,serif;font-size:11pt;line-height:1.25;padding:0;}
.roster-sheet *{box-sizing:border-box;}
.roster-sheet td,.roster-sheet th,.roster-sheet span,.roster-sheet div,.roster-sheet li{color:#000;}
.rs-top{display:grid;grid-template-columns:minmax(0,1.5fr) repeat(4,minmax(0,1fr));gap:8px;align-items:stretch;margin-bottom:10px;}
.rs-ident{display:flex;flex-direction:column;gap:6px;}
.rs-race{font-size:26pt;font-weight:700;line-height:1.05;}
.rs-label-row{display:flex;align-items:stretch;border:1px solid #000;}
.rs-label{flex:0 0 auto;padding:3px 6px;font-size:8pt;font-weight:700;letter-spacing:.04em;border-right:1px solid #000;background:#f1f1f1;display:flex;align-items:center;}
.rs-value{flex:1;padding:3px 6px;font-size:11pt;}
.rs-ruleset{font-size:9pt;font-style:italic;}
.rs-box{border:1px solid #000;padding:4px 6px;font-size:9pt;}
.rs-box-title{font-weight:700;font-size:8.5pt;letter-spacing:.05em;border-bottom:1px solid #000;margin:0 -6px 3px;padding:0 6px 2px;}
.rs-kv{width:100%;border-collapse:collapse;}
.rs-kv td{padding:0 0 1px;vertical-align:top;}
.rs-kv td:last-child{text-align:right;white-space:nowrap;padding-left:6px;}
.rs-rules{margin:0;padding-left:14px;}
.rs-none{margin:0;color:#444;}
.rs-roster{width:100%;border-collapse:collapse;border:1.5px solid #000;}
.rs-roster th,.rs-roster td{border:1px solid #000;padding:3px 5px;vertical-align:top;}
.rs-roster th{font-size:9pt;font-weight:700;text-align:center;background:#f1f1f1;}
.rs-roster td.num{width:28px;text-align:center;}
.rs-roster td.pos{white-space:nowrap;font-weight:400;}
.rs-roster td.stat{width:34px;text-align:center;}
.roster-sheet .rs-roster td.stat.improved{font-weight:700;color:#1a73c8;}
.rs-roster td.cost{width:58px;text-align:right;white-space:nowrap;}
.rs-roster th.skills,.rs-roster td.skills{text-align:left;}
.rs-roster tr.rs-star td{background:#fafafa;}
.roster-sheet .sk-printed{color:#000;}
.roster-sheet .sk-primary{color:#1a73c8;font-style:italic;}
.roster-sheet .sk-secondary{color:#5a9e2f;font-style:italic;}
.roster-sheet .sk-stat{color:#1a73c8;font-weight:700;font-style:italic;}
.rs-keywords{margin:8px 0 0;font-size:9pt;}
@page{size:A4 landscape;margin:10mm;}
@media print{.roster-sheet{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
`;
    function standaloneSheetDocument(model) {
      const title = `${model.teamName || model.raceName || "Team"} — roster sheet`;
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>html,body{margin:0;background:#fff;}body{padding:12mm;}${SHEET_CSS}</style>
</head>
<body>
${rosterSheetHtml(model)}
</body>
</html>
`;
    }
    const sheetFileName = (model) => `${(model.teamName || model.raceName || "team").replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "_") || "team"}_roster.html`;

    /**
     * Compare a stored player's characteristics with the printed position. Returns the +1 tournament
     * increases (MA/ST/AV up one, AG/PA one step better) and, for custom rebuilds, the absolute raw
     * value of EVERY changed stat. Explicit about "no value": a printed "-" PA/AG and a stored 0/null
     * passing/agility both mean "none" (raw 0), so a Deathroller given PA 3 or a thrower stripped to
     * no PA still round-trip.
     */
    function deriveStatChanges(position, player) {
      const printedRaw = (stat) => {
        const value = position?.[stat];
        if (stat === "MA" || stat === "ST") return num(value);
        const match = String(value ?? "").match(/(\d+)/);
        return match ? Number(match[1]) : 0; // "-" / missing → none
      };
      const storedRaw = (stat, value) => {
        const n = num(value);
        if (stat === "MA" || stat === "ST") return n;
        return n === null || n <= 0 ? 0 : n; // 0 / null → none
      };
      const stored = { MA: player.movement, ST: player.strength, AG: player.agility, PA: player.passing, AV: player.armour };
      const increases = [];
      const absolute = {};
      for (const stat of STATS) {
        if (stored[stat] === undefined) continue; // the detail didn't report this characteristic
        const before = printedRaw(stat);
        const after = storedRaw(stat, stored[stat]);
        if (before === null || after === null || before === after) continue;
        absolute[stat] = after;
        const oneStep = stat === "AG" || stat === "PA"
          ? before > 0 && after > 0 && after === before - 1
          : after === before + 1;
        if (oneStep) increases.push(stat);
      }
      return { increases, absolute };
    }

    return {
      esc, gold, norm, num, STATS, deriveStatChanges,
      normalizeLeagueOptions, leagueFieldPresentation, reconcileLeagueSelection, explicitLeagueSpecialRule, starEligibleForLeague,
      buildStarChoices, positionGroupCapped, buildPicks, slotsFromPicks,
      improvedStats, statIncreaseCost, normalizeTierRules, tierLimitLines, tierTable, tierTableHtml, starPacksFor, starPackLabel,
      stackLabel, statIncreaseLabel, DEFAULT_SKILL_COSTS, playerSkillSp,
      rosterSheetModel, rosterSheetHtml, standaloneSheetDocument, sheetFileName, SHEET_CSS,
    };
  })();
  root.TeamBuilderCore = Core;

  if (typeof document === "undefined" || !document.getElementById("team-builder-title")) return;

  // ════════════════════════════════════════════════════════════════════════════
  // UI
  // ════════════════════════════════════════════════════════════════════════════
  const { esc, gold, norm } = Core;
  const $ = (id) => document.getElementById(id);
  const MAX_PLAYERS = 16;

  // Skill colouring fallback until the /api/skills catalog lands (traits are absent from the catalog).
  const SKILL_GROUPS = {
    general: ["Block", "Dauntless", "Dirty Player", "Fend", "Frenzy", "Kick", "Pro", "Shadowing", "Strip Ball", "Sure Hands", "Tackle", "Wrestle"],
    agility: ["Catch", "Defensive", "Diving Catch", "Diving Tackle", "Dodge", "Jump Up", "Leap", "Safe Pair of Hands", "Sidestep", "Sneaky Git", "Sprint", "Sure Feet"],
    strength: ["Arm Bar", "Brawler", "Break Tackle", "Grab", "Guard", "Juggernaut", "Mighty Blow", "Multiple Block", "Pile Driver", "Stand Firm", "Strong Arm", "Thick Skull"],
    passing: ["Accurate", "Cannoneer", "Cloud Burster", "Dump-off", "Leader", "Nerves of Steel", "On the Ball", "Pass", "Running Pass", "Safe Pass"],
    mutation: ["Big Hand", "Claws", "Disturbing Presence", "Extra Arms", "Foul Appearance", "Horns", "Iron Hard Skin", "Monstrous Mouth", "Prehensile Tail", "Tentacles", "Two Heads", "Very Long Legs"],
  };
  const FALLBACK_CATEGORY = new Map(Object.entries(SKILL_GROUPS).flatMap(([group, names]) => names.map((name) => [name, group])));

  const STAFF_ROWS = [
    { key: "reRolls", label: "Rerolls", min: 0, max: () => current?.maxReRolls ?? 8, cost: () => current?.reRollCost ?? 0, free: 0 },
    { key: "assistantCoaches", label: "Assistant Coaches", min: 0, max: () => 6, cost: () => 10_000, free: 0 },
    { key: "cheerleaders", label: "Cheerleaders", min: 0, max: () => 12, cost: () => 10_000, free: 0 },
    { key: "dedicatedFans", label: "Dedicated Fans", min: 1, max: () => 7, cost: () => 10_000, free: 1 },
    { key: "apothecary", label: "Apothecary", min: 0, max: () => 1, cost: () => 50_000, free: 0 },
  ];
  const PRIMARY_GOLD = 20_000;
  const SECONDARY_GOLD = 40_000;
  const ELITE_GOLD = 10_000;
  const DEFAULT_ELITE = new Set(["Block", "Dodge", "Guard", "Mighty Blow"]);

  const freshStaff = () => ({ reRolls: 0, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, apothecary: 0 });

  // ── state ──
  // tournament-team-builder.html sets body[data-builder="tournament"]: the shared builder is locked to
  // tournament mode behind its own setup flow (1 ruleset → 2 tiered race → 3 build).
  const TOURNAMENT_PAGE = document.body?.dataset.builder === "tournament";
  let mode = TOURNAMENT_PAGE ? "tournament" : "create";
  let setupStep = 1;
  let packageDoc = null; // GET /api/packages/<name> `pkg` (description, eligibleRosters)
  let rosters = [];
  let packages = [];
  let current = null;
  let packageRules = null;
  let tierRows = [];
  let tierTableOpen = false;
  let leagueSelection = { selectedLeague: "", explicit: false };
  let slots = [];
  let staff = freshStaff();
  let inducementCatalog = [];
  let inducementCounts = {};
  let selectedSkillPack = null;
  let skillPickerIndex = null;
  let pickerCategory = null;
  let preview = null; // { valid, errors, warnings, summary, package }
  let previewPending = false;
  let previewTimer = null;
  let previewSequence = 0;
  let packageRulesSequence = 0;
  let inducementSequence = 0;
  let nameGateTimer = null;
  let authToken = null;
  let authCoach = "";
  let authOrganizer = false; // whole-roster editing (build with teamId) is organizer-only server-side
  let authBusy = false;
  let buildBusy = false;
  let discordSsoEnabled = false;
  let loginFeedback = "";
  let loginFeedbackError = false;
  let editingTeamId = null;
  let skillCatalog = null; // Map name -> { category, elite }
  const legalSkillsCache = new Map(); // `${rosterId}:${positionId}` -> { primary, secondary, alreadyPrinted }
  let starSpOpen = false;
  let saves = [];
  let savesAvailable = true;
  let savesOpen = false;
  let currentSave = null; // { id, name }
  let library = [];

  $("fork-admin-link").href = `http://${location.hostname || "127.0.0.1"}:22227/panel.html`;

  async function api(path, options = {}) {
    const headers = { ...(options.headers ?? {}), "X-CW-Auth": "1" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { body: payload, status: response.status });
    }
    return payload;
  }
  const postJson = (path, body, method = "POST") => api(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // ── derived helpers ──
  const canEditSkills = () => mode === "custom" || mode === "tournament";
  const positionById = (positionId) => current?.positions.find((position) => position.positionId === positionId) ?? null;
  const positionCount = (positionId) => slots.filter((slot) => slot.positionId === positionId).length;
  const positionCounts = () => {
    const counts = new Map();
    for (const slot of slots) counts.set(slot.positionId, (counts.get(slot.positionId) ?? 0) + 1);
    return counts;
  };
  const leagueOptions = () => Core.normalizeLeagueOptions(current?.leagueOptions);
  const leaguePresentation = () => Core.leagueFieldPresentation(leagueOptions(), leagueSelection);
  const activeLeague = () => (leaguePresentation().selectedValid ? leagueSelection.selectedLeague : "");
  const selectedSpecialRule = () => Core.explicitLeagueSpecialRule(leagueOptions(), leagueSelection);
  const selectedPackageName = () => (mode === "tournament" ? $("package").value : "");
  const raceRules = () => (mode === "tournament" && current ? packageRules?.race ?? null : null);
  const ownTierRow = () => current && tierRows.find((row) => norm(row.name) === norm(current.raceName));
  /** Tier knobs for the current race: the authoritative preview echo first, then the /tiers row. */
  function tierRules() {
    if (mode !== "tournament") return null;
    return Core.normalizeTierRules(preview?.package?.rules) ?? Core.normalizeTierRules(ownTierRow());
  }
  function statRules() {
    if (!canEditSkills()) return null;
    const rules = tierRules();
    return rules?.statIncreases ?? null;
  }
  const exclusiveStatAndSkill = () => statRules()?.exclusiveWithSkills !== false;
  const maxStatsPerPlayer = () => Number(statRules()?.maxPerPlayer ?? 1) || 1;

  function skillMeta(skill) {
    return skillCatalog?.get(skill) ?? null;
  }
  function categoryClass(category) {
    const k = String(category || "").toLowerCase();
    if (k.startsWith("gen")) return "skill-general";
    if (k.startsWith("agi")) return "skill-agility";
    if (k.startsWith("str")) return "skill-strength";
    if (k.startsWith("pass") || k.startsWith("dev")) return "skill-passing";
    if (k.startsWith("mut")) return "skill-mutation";
    return "skill-trait";
  }
  function skillClass(skill) {
    const base = String(skill).replace(/\s*\(.*\)\s*$/, "").replace(/\*+$/, "").trim();
    const meta = skillMeta(base);
    if (meta?.category) return `skill ${categoryClass(meta.category)}`;
    const group = FALLBACK_CATEGORY.get(base);
    return group ? `skill skill-${group}` : "skill skill-trait";
  }
  const isElite = (skill) => {
    const meta = skillMeta(skill);
    if (meta) return meta.elite === true;
    const own = raceRules()?.skillCosts?.eliteSkills;
    return own ? own.includes(skill) : DEFAULT_ELITE.has(skill);
  };
  const legalKey = (positionId) => `${current?.rosterId}:${positionId}`;
  function skillAccess(positionId, skill) {
    const set = legalSkillsCache.get(legalKey(positionId));
    if (set?.secondary?.some((entry) => entry.skill === skill)) return "secondary";
    if (set?.primary?.some((entry) => entry.skill === skill)) return "primary";
    return mode === "custom" ? "custom" : "primary";
  }
  function slotSkillGold(slot) {
    return slot.chosenSkills.reduce((sum, skill) => sum
      + (skillAccess(slot.positionId, skill) === "secondary" ? SECONDARY_GOLD : PRIMARY_GOLD)
      + (isElite(skill) ? ELITE_GOLD : 0), 0);
  }
  function slotStatGold(slot) {
    const rules = statRules();
    const allowed = allowedStatList();
    return (slot.chosenStatIncreases ?? []).filter((stat) => allowed.includes(stat))
      .reduce((sum, stat) => sum + (Core.statIncreaseCost(rules, stat) ?? 0), 0);
  }
  function staffCost() {
    return STAFF_ROWS.reduce((sum, row) => sum + Math.max(0, staff[row.key] - row.free) * row.cost(), 0);
  }
  const playerSlots = () => slots.filter((slot) => !positionById(slot.positionId)?.isStar);
  const starSlots = () => slots.filter((slot) => positionById(slot.positionId)?.isStar);
  const rawPlayerCost = () => playerSlots().reduce((sum, slot) => sum + (positionById(slot.positionId)?.cost ?? 0), 0);
  /** Star picks on the roster: a paired package (Grak & Crumbleberry…) counts once. */
  function starPickCount() {
    return allStarChoices().filter((choice) => choice.members.some((m) => positionCount(m.positionId) > 0)).length;
  }
  const rawStarCost = () => starSlots().reduce((sum, slot) => sum + (positionById(slot.positionId)?.cost ?? 0), 0);
  const inducementPicks = () => Object.entries(inducementCounts).filter(([, count]) => count > 0).map(([key, count]) => ({ key, count }));
  const inducementGold = () => inducementPicks().reduce((sum, pick) => sum + pick.count * (inducementCatalog.find((item) => item.key === pick.key)?.price ?? 0), 0);
  const addedSkillGold = () => slots.reduce((sum, slot) => sum + slotSkillGold(slot), 0);
  const statGold = () => slots.reduce((sum, slot) => sum + slotStatGold(slot), 0);
  function clientBudget() {
    if (mode !== "tournament") return 1_000_000;
    const pack = selectedPackSummary();
    return pack?.gold ?? preview?.package?.budget ?? packageRules?.budget ?? 1_000_000;
  }
  function selectedPackSummary() {
    const race = raceRules();
    return race && selectedSkillPack ? race.packs?.find((pack) => pack.label === selectedSkillPack) ?? null : null;
  }

  // ── tournament star filtering ──
  function allStarChoices() {
    return Core.buildStarChoices(current?.positions ?? []);
  }
  function starEligible(position) {
    return Core.starEligibleForLeague(position.playsFor, leagueOptions(), activeLeague());
  }
  function displayedStarChoices() {
    if (mode === "create" || !current) return [];
    const base = allStarChoices().filter((choice) => choice.members.every(starEligible));
    if (mode === "custom") return base.sort((a, b) => a.label.localeCompare(b.label));
    const race = raceRules();
    if (race && race.stars && !race.stars.allowed) return [];
    const banned = new Set((race?.bannedStars ?? []).map(norm));
    const priced = race?.stars?.spCosts?.length ? new Set(race.stars.spCosts.map((star) => norm(star.name))) : null;
    const packs = tierRules()?.starPacks ?? [];
    return base
      .filter((choice) => choice.members.every((member) => !banned.has(norm(member.name))))
      .filter((choice) => !priced || choice.members.some((member) => priced.has(norm(member.name))))
      .filter((choice) => !packs.length || choice.members.some((member) => Core.starPacksFor(member.name, packs).length))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  const starSectionVisible = () => mode === "custom" || (mode === "tournament" && (raceRules()?.stars?.allowed ?? true) && Boolean(current));
  function starCap() {
    if (mode !== "tournament") return null;
    const caps = [raceRules()?.stars?.maxCount, tierRules()?.maxStars].filter((n) => typeof n === "number");
    return caps.length ? Math.min(...caps) : null;
  }
  function starSp(choice) {
    const costs = raceRules()?.stars?.spCosts;
    if (!costs?.length) return null;
    const byName = new Map(costs.map((star) => [norm(star.name), star.sp]));
    return choice.members.reduce((sum, member) => sum + (byName.get(norm(member.name)) ?? 0), 0);
  }

  // ════════════════ session ════════════════
  function syncBuildButton() {
    const button = $("build-btn");
    const label = editingTeamId ? "Save Team" : "Create Team";
    if (buildBusy) {
      button.textContent = editingTeamId ? "Saving…" : "Creating…";
      button.disabled = true;
    } else {
      button.textContent = authCoach ? label : "Sign In to Create";
      const valid = mode === "custom" ? Boolean(preview) : preview?.valid === true;
      button.disabled = !authCoach || !valid || previewPending;
    }
    const exportable = Boolean(current && slots.length);
    $("print-sheet").disabled = !exportable;
    $("download-sheet").disabled = !exportable;
  }
  function setSessionCoach(coach) {
    authCoach = String(coach ?? "").trim();
    const coachInput = $("coach");
    if (authCoach) coachInput.value = authCoach;
    coachInput.readOnly = Boolean(authCoach);
    if (authCoach) coachInput.setAttribute("aria-readonly", "true");
    else coachInput.removeAttribute("aria-readonly");
    $("current-coach-label").textContent = authCoach || coachInput.value.trim() || "Choose an existing fork account below";
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
    renderSaves();
    syncBuildButton();
  }
  function sessionExpired(message) {
    authToken = null;
    authOrganizer = false;
    setSessionCoach("");
    loginFeedback = message;
    loginFeedbackError = true;
    saves = [];
    currentSave = null;
    renderSession();
  }
  async function restoreSession() {
    try {
      const session = await api("/api/auth/session");
      discordSsoEnabled = session.discordSsoEnabled === true;
      if (session.authenticated === true) setSessionCoach(session.coach);
      authOrganizer = session.authenticated === true && session.organizer === true;
    } catch {
      // The builder remains browsable and exposes its own login form.
    }
    renderSession();
    if (authCoach) loadSaves();
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
      const result = await postJson("/api/fork/login", { username, password });
      authToken = result.token ?? null;
      const session = await api("/api/auth/session");
      discordSsoEnabled = session.discordSsoEnabled === true;
      setSessionCoach(session.coach ?? result.coach ?? username);
      authOrganizer = session.organizer === true;
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
      if (authCoach) loadSaves();
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
    authOrganizer = false;
    setSessionCoach("");
    authBusy = false;
    loginFeedback = "Signed out.";
    loginFeedbackError = false;
    saves = [];
    currentSave = null;
    renderSession();
    schedulePreview();
  }

  // ════════════════ rendering ════════════════
  function initials(name) {
    const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
  }
  function statStrip(position, className, increases, overrides) {
    const stats = Core.improvedStats(position, increases, overrides);
    return `<div class="${className}">${Core.STATS.map((stat) =>
      `<span${stats[stat].improved ? ' class="improved"' : ""}><b>${esc(stats[stat].value)}</b><small>${stat}</small></span>`
    ).join("")}</div>`;
  }
  function printedSkillChips(position) {
    return (position?.skills ?? []).map((skill) => `<span class="${skillClass(skill)}">${esc(skill)}</span>`).join("");
  }

  function renderMode() {
    document.querySelectorAll(".mode-grid [data-mode]").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const library = mode === "library";
    if ($("library-panel")) $("library-panel").hidden = !library;
    $("builder-panel").hidden = library || (TOURNAMENT_PAGE && setupStep !== 3);
    $("package-field").hidden = mode !== "tournament" || TOURNAMENT_PAGE;
    $("custom-badge").hidden = mode !== "custom";
    $("builder-heading-text").textContent = mode === "tournament"
      ? "Tournament Slot Builder"
      : mode === "custom" ? "Custom Team — Slot Builder" : "Create Team — Slot Builder";
    $("editing-badge").hidden = !editingTeamId;
    $("editing-badge").textContent = editingTeamId ? "Editing fork team" : "";
  }

  function renderLeague() {
    const options = leagueOptions();
    const presentation = Core.leagueFieldPresentation(options, leagueSelection);
    $("league-field").hidden = !presentation.visible;
    const select = $("league");
    select.disabled = !presentation.interactive;
    select.required = presentation.interactive;
    select.innerHTML = (presentation.interactive ? '<option value="" disabled>Choose a league</option>' : "")
      + options.map((league) => `<option value="${esc(league)}">${esc(league)}</option>`).join("");
    select.value = activeLeague() || (presentation.interactive ? "" : options[0] ?? "");
    const rule = selectedSpecialRule();
    $("league-rule").textContent = rule ? `Special rule: ${rule}` : "";
  }

  function renderRulesetPanel() {
    const panel = $("ruleset-panel");
    if (mode !== "tournament" || !$("package").value) {
      panel.hidden = true;
      $("tier-table-wrap").hidden = true;
      return;
    }
    const lines = [];
    const race = raceRules();
    const rules = tierRules();
    const tierButton = tierRows.length
      ? `<button type="button" class="tier-table-toggle" data-tier-table aria-expanded="${tierTableOpen}">${tierTableOpen ? "Hide" : "Show"} tier table</button>`
      : "";
    if (race) {
      const pack = selectedPackSummary();
      lines.push(`<div class="ruleset-line ruleset-head"><strong>${esc(race.roster)}</strong>${race.tierLabel ? ` — ${esc(race.tierLabel)}` : ""}`
        + ` · Budget ${gold(pack?.gold ?? race.gold)}`
        + (!race.packs?.length ? (race.skillPointBudget ? ` · ${race.skillPointBudget} SP` : "") : pack ? ` · ${pack.skillPointBudget} SP (${esc(pack.label)})` : "")
        + (race.maxPerPlayer != null ? ` · ${race.maxPerPlayer} skill${race.maxPerPlayer === 1 ? "" : "s"}/player` : "")
        + `${tierButton}</div>`);
      if (race.packs?.length) {
        lines.push(`<div class="ruleset-line pack-choice-line"><div class="pack-grid${selectedSkillPack ? " has-selection" : ""}">${race.packs.map((p) =>
          `<button type="button" class="pack-choice-btn${selectedSkillPack === p.label ? " selected" : ""}" data-skill-pack="${esc(p.label)}" aria-pressed="${selectedSkillPack === p.label}"><strong>${esc(p.label)}</strong><small>${gold(p.gold)} / ${p.skillPointBudget} SP${p.maxPerPlayer != null ? ` · ${p.maxPerPlayer} skill${p.maxPerPlayer === 1 ? "" : "s"}/player` : ""}</small></button>`
        ).join("")}</div>${selectedSkillPack ? "" : '<span class="ruleset-caveat">Pick your skill pack.</span>'}</div>`);
      }
      if (race.stars) {
        lines.push(race.stars.allowed
          ? `<div class="ruleset-line">Stars${race.stars.maxCount != null ? ` (max ${race.stars.maxCount})` : ""}${race.stars.paidInSkillPoints ? ", paid in SP" : ""}</div>`
          : '<div class="ruleset-line">No star players</div>');
      }
      for (const line of Core.tierLimitLines(rules)) lines.push(`<div class="ruleset-line ruleset-limit">${esc(line)}</div>`);
      if (packageRules?.dataNote) lines.push(`<div class="ruleset-caveat">${esc(packageRules.dataNote)}</div>`);
    } else if (packageRules?.tierSummary?.length) {
      lines.push(`<div class="ruleset-line ruleset-head"><strong>${esc(packageRules.name)}</strong> — ${packageRules.tierSummary.length} tiers${tierButton}</div>`);
      for (const tier of packageRules.tierSummary) {
        lines.push(`<div class="ruleset-line"><strong>${esc(tier.label)}</strong>${tier.packs?.length
          ? ` · Packs ${tier.packs.map((p) => `${gold(p.gold)}/${p.skillPointBudget}SP`).join(" / ")}`
          : ` · ${gold(tier.gold)}${tier.skillPointBudget ? ` / ${tier.skillPointBudget} SP` : ""}`}<span class="ruleset-rosters"> — ${esc(tier.rosters.join(", "))}</span></div>`);
      }
      if (packageRules.dataNote) lines.push(`<div class="ruleset-caveat">${esc(packageRules.dataNote)}</div>`);
    } else {
      const row = packages.find((p) => p.name === $("package").value);
      const text = preview?.package?.description ?? row?.description ?? "Tournament rules apply.";
      lines.push(`<div class="ruleset-line"><strong>${esc($("package").value)}</strong> — ${esc(text)}${tierButton}</div>`);
    }
    if (preview && !preview.package && preview.rosterId === current?.rosterId) {
      lines.push('<div class="ruleset-caveat">Ruleset validation pending server update.</div>');
    }
    panel.innerHTML = lines.join("");
    panel.hidden = false;
    renderTierTable();
  }
  function renderTierTable() {
    const wrap = $("tier-table-wrap");
    const table = Core.tierTable(tierRows, packageRules?.tierSummary);
    if (!tierTableOpen || !table.length || mode !== "tournament") {
      wrap.hidden = true;
      return;
    }
    $("tier-table").innerHTML = Core.tierTableHtml(table);
    wrap.hidden = false;
  }

  function renderPositions() {
    if (!current) {
      $("positions").innerHTML = '<p class="status-copy">Choose a roster to see its positions.</p>';
      return;
    }
    const named = Boolean($("team-name").value.trim());
    const counts = positionCounts();
    $("positions").innerHTML = current.positions
      .filter((position) => !position.isStar)
      .slice()
      .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
      .map((position) => {
        const count = counts.get(position.positionId) ?? 0;
        const group = mode === "custom" ? null : Core.positionGroupCapped(position.positionId, current.positionGroups, counts);
        const exhausted = count >= position.max || Boolean(group) || slots.length >= MAX_PLAYERS;
        const title = !named ? "You must name your team." : group ? `${group.label ?? "Position group"} limit reached` : "";
        return `<button class="position-card${exhausted ? " exhausted" : ""}${named ? "" : " name-required"}" type="button"
          data-add-position="${esc(position.positionId)}" ${exhausted ? "disabled" : ""} ${title ? `title="${esc(title)}"` : ""}
          aria-label="Add ${esc(position.name)}">
          <div class="position-head">
            <span class="sprite-frame" aria-hidden="true">${esc(initials(position.name))}</span>
            <span class="position-name"><strong>${esc(position.name)}</strong><small>${Math.max(0, position.max - count)} of ${position.max} left</small></span>
            <span class="cost">${gold(position.cost)}</span>
          </div>
          ${statStrip(position, "stat-strip")}
          <div class="printed-skills">${printedSkillChips(position) || '<span class="status-copy">No printed skills</span>'}</div>
        </button>`;
      }).join("");
  }

  function statControl(slot, index, position) {
    const rules = statRules();
    if (!rules || position?.isStar) return "";
    const chosen = slot.chosenStatIncreases ?? [];
    const blocked = exclusiveStatAndSkill() && slot.chosenSkills.length > 0;
    const stats = (Array.isArray(rules.stats) && rules.stats.length ? rules.stats : Core.STATS)
      .filter((stat) => !(stat === "PA" && String(position?.PA ?? "-").trim() === "-"));
    const options = stats.map((stat) => {
      const cost = Core.statIncreaseCost(rules, stat);
      return `<option value="${esc(stat)}">+${esc(stat)}${cost != null ? ` (${gold(cost)})` : ""}</option>`;
    }).join("");
    if (maxStatsPerPlayer() <= 1) {
      return `<label class="stat-pick" title="${blocked ? "A player with an added skill can't also take a stat increase." : "Characteristic increase"}">
        <span>Stat</span>
        <select data-stat-slot="${index}" ${blocked ? "disabled" : ""} aria-label="Stat increase for player ${index + 1}">
          <option value="">—</option>${options}
        </select></label>`;
    }
    const chips = chosen.map((stat) => `<span class="chosen-chip stat-chip">+${esc(stat)}<button type="button" data-remove-stat="${index}" data-stat="${esc(stat)}" aria-label="Remove +${esc(stat)}">×</button></span>`).join("");
    const full = chosen.length >= maxStatsPerPlayer();
    return `<span class="stat-pick">${chips}${full || blocked ? "" : `<select data-stat-slot="${index}" aria-label="Add stat increase"><option value="">+ Stat</option>${options}</select>`}</span>`;
  }

  function renderRoster() {
    $("player-count").textContent = `${slots.length} / ${MAX_PLAYERS}`;
    if (!slots.length) {
      $("roster-slots").innerHTML = '<div class="roster-empty">Add a player from a position card above.</div>';
      return;
    }
    const edit = canEditSkills();
    $("roster-slots").innerHTML = slots.map((slot, index) => {
      const position = positionById(slot.positionId);
      const star = position?.isStar === true;
      const blockedSkills = Boolean(statRules()) && exclusiveStatAndSkill() && (slot.chosenStatIncreases ?? []).length > 0;
      const added = edit && !star ? slot.chosenSkills.map((skill) => {
        const access = skillAccess(slot.positionId, skill);
        return `<span class="chosen-chip ${skillClass(skill)} access-${access}">${esc(skill)}<button type="button" data-remove-skill="${index}" data-skill="${esc(skill)}" aria-label="Remove ${esc(skill)}">×</button></span>`;
      }).join("") : "";
      const liveStats = (slot.chosenStatIncreases ?? []).filter((stat) => allowedStatList().includes(stat));
      const statChips = liveStats.length && maxStatsPerPlayer() <= 1
        ? slot.chosenStatIncreases.map((stat) => `<span class="chosen-chip stat-chip">+${esc(stat)}</span>`).join("")
        : "";
      const select = edit ? statControl(slot, index, position) : "";
      const skillButton = edit && !star
        ? `<button type="button" class="skill-add-btn${skillPickerIndex === index ? " open" : ""}" data-skill-slot="${index}" ${blockedSkills ? 'disabled title="A player with a stat increase can\'t also have an added skill."' : ""}><span>Add</span><span>Skill</span></button>`
        : "";
      return `<div class="roster-row roster-grid${skillPickerIndex === index ? " picking" : ""}">
        <span class="slot-number">${index + 1}</span>
        <div class="player-cell">
          <span class="sprite-frame roster-sprite" aria-hidden="true">${esc(initials(position?.name))}</span>
          <span class="player-copy"><strong>${esc(position?.name ?? "Unknown position")}</strong><small>${star ? "Star player" : "Roster player"}</small></span>
        </div>
        ${statStrip(position, "row-stats", liveStats, mode === "custom" ? slot.chosenStats : null)}
        <div class="row-skills">${printedSkillChips(position)}${added}${statChips}${select}</div>
        <span class="cost">${gold(position?.cost)}</span>
        <div class="row-actions">
          ${skillButton}
          <span class="fire-cell"><button class="remove-player" type="button" data-remove-slot="${index}" aria-label="Remove ${esc(position?.name ?? "player")}">×</button><small class="fire-label">FIRE</small></span>
        </div>
      </div>`;
    }).join("");
    // Restore select values (rendered as strings, set after insertion).
    document.querySelectorAll("[data-stat-slot]").forEach((select) => {
      const slot = slots[Number(select.dataset.statSlot)];
      if (slot && maxStatsPerPlayer() <= 1) select.value = slot.chosenStatIncreases?.[0] ?? "";
    });
  }

  async function ensureSkillCatalog() {
    if (skillCatalog) return skillCatalog;
    try {
      const data = await api("/api/skills");
      const map = new Map();
      for (const group of Object.values(data ?? {})) {
        if (!Array.isArray(group)) continue;
        for (const row of group) {
          const name = typeof row?.name === "string" ? row.name.trim() : "";
          if (name && !map.has(name)) map.set(name, { category: row.category ?? "", elite: row.elite === true });
        }
      }
      skillCatalog = map;
    } catch {
      skillCatalog = new Map();
    }
    return skillCatalog;
  }
  async function ensureLegalSkills(positionId) {
    const key = legalKey(positionId);
    if (legalSkillsCache.has(key)) return legalSkillsCache.get(key);
    const data = await api(`/api/fork/team-builder/legal-skills?rosterId=${encodeURIComponent(current.rosterId)}&positionId=${encodeURIComponent(positionId)}`);
    const set = {
      primary: Array.isArray(data.primary) ? data.primary : [],
      secondary: Array.isArray(data.secondary) ? data.secondary : [],
      alreadyPrinted: Array.isArray(data.alreadyPrinted) ? data.alreadyPrinted : [],
    };
    legalSkillsCache.set(key, set);
    return set;
  }

  const CATEGORY_ORDER = ["str", "gen", "agi", "pass", "dev", "mut"];
  const categoryRank = (category) => {
    const k = String(category || "").toLowerCase();
    const index = CATEGORY_ORDER.findIndex((prefix) => k.startsWith(prefix));
    return index < 0 ? CATEGORY_ORDER.length : index;
  };
  function groupByCategory(skills) {
    const map = new Map();
    for (const skill of skills) {
      const category = skill.category || "Trait";
      if (!map.has(category)) map.set(category, []);
      map.get(category).push(skill);
    }
    return [...map.entries()]
      .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]))
      .map(([category, list]) => ({ category, skills: list.sort((x, y) => x.skill.localeCompare(y.skill)) }));
  }
  function pickerSet(slot) {
    if (mode === "custom") {
      const all = [...(skillCatalog ?? new Map()).entries()].map(([skill, meta]) => ({ skill, category: meta.category, elite: meta.elite }));
      return { primary: all, secondary: [], alreadyPrinted: [] };
    }
    return legalSkillsCache.get(legalKey(slot.positionId)) ?? null;
  }
  function renderSkillPicker() {
    const panel = $("skill-picker");
    const slot = skillPickerIndex != null ? slots[skillPickerIndex] : null;
    const position = slot ? positionById(slot.positionId) : null;
    if (!slot || !position || position.isStar || !canEditSkills()) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $("skill-picker-heading").textContent = `${mode === "custom" ? "All Skills" : "Add Skill"} — #${skillPickerIndex + 1} ${position.name}`;
    const body = $("skill-picker-body");
    const set = pickerSet(slot);
    if (!set) {
      body.innerHTML = '<div class="skill-picker-status">Loading legal skills…</div>';
      return;
    }
    // Owned matrix: innate printed skills appear (dimmed ✓) in their catalog category.
    const printed = (position.skills ?? []).map((name) => String(name).replace(/\s*\(.*\)\s*$/, "").replace(/\*+$/, ""))
      .filter((name) => skillMeta(name)?.category)
      .map((name) => ({ skill: name, category: skillMeta(name).category, elite: skillMeta(name).elite, innate: true }));
    const printedNames = new Set(printed.map((p) => p.skill));
    const primaryCats = new Set(set.primary.map((s) => s.category));
    const secondaryCats = new Set(set.secondary.map((s) => s.category));
    const innateSecondary = (p) => secondaryCats.has(p.category) && !primaryCats.has(p.category);
    const sections = mode === "custom"
      ? [{ label: null, access: "custom", groups: groupByCategory([...set.primary]) }]
      : [
        { label: "Primary", access: "primary", groups: groupByCategory([...set.primary, ...printed.filter((p) => !innateSecondary(p))]) },
        { label: "Secondary", access: "secondary", groups: groupByCategory([...set.secondary, ...printed.filter(innateSecondary)]) },
      ].filter((section) => section.groups.length);
    if (!sections.length) {
      body.innerHTML = '<div class="skill-picker-status">No selectable skills for this position.</div>';
      return;
    }
    const categories = sections.flatMap((section) => section.groups.map((group) => group.category));
    if (!pickerCategory || !categories.includes(pickerCategory)) pickerCategory = categories[0];
    const blades = sections.map((section) => `${section.label ? `<div class="skill-blade-tab">${section.label}</div>` : ""}<div class="skill-blade-row">${section.groups.map((group) =>
      `<button type="button" class="skill-blade ${categoryClass(group.category)}" data-blade="${esc(group.category)}" data-active="${pickerCategory === group.category}"><span>${esc(group.category)}</span><small>${group.skills.filter((s) => !s.innate).length}</small></button>`
    ).join("")}</div>`).join("");
    const section = sections.find((s) => s.groups.some((g) => g.category === pickerCategory));
    const group = section.groups.find((g) => g.category === pickerCategory);
    const chips = group.skills.map((skill) => {
      const innate = skill.innate === true || printedNames.has(skill.skill);
      const added = slot.chosenSkills.includes(skill.skill);
      const price = mode === "custom" || innate ? "" : `+${gold((section.access === "secondary" ? SECONDARY_GOLD : PRIMARY_GOLD) + (skill.elite ? ELITE_GOLD : 0))}`;
      return `<span class="skill-chip-cell"><button type="button" class="skill-chip ${categoryClass(skill.category)}${innate ? " innate" : ""}${added ? " added" : ""}" data-pick-skill="${esc(skill.skill)}" ${innate || added ? "disabled" : ""}>
        <span class="skill-chip-main">${skill.elite ? '<span class="elite-mark" title="Elite skill" aria-label="Elite">◆</span>' : ""}<span>${esc(skill.skill)}</span>${innate ? '<span class="skill-owned-check" aria-label="Already printed">✓</span>' : ""}</span>
        <span class="skill-chip-meta"><small>${esc(price)}</small></span>
      </button>${added ? `<button type="button" class="skill-chip-remove" data-unpick-skill="${esc(skill.skill)}" aria-label="Remove ${esc(skill.skill)}">×</button>` : ""}</span>`;
    }).join("");
    body.innerHTML = `<div class="skill-blade-bar">${blades}</div><div class="skill-picker-grid">${chips}</div>`;
  }

  function renderStars() {
    const visible = starSectionVisible();
    $("star-section").hidden = !visible;
    if (!visible) {
      $("star-sp-section").hidden = true;
      return;
    }
    const choices = displayedStarChoices();
    const cap = starCap();
    const starCount = starPickCount();
    $("star-cap").textContent = cap != null ? `${starCount} / ${cap}` : "";
    const named = Boolean($("team-name").value.trim());
    const packs = mode === "tournament" ? tierRules()?.starPacks ?? [] : [];
    if (!choices.length) {
      $("star-list").innerHTML = `<p class="status-copy">${mode === "custom" && leaguePresentation().selectionRequired
        ? "Choose a league to see star players."
        : mode === "tournament" ? "No star players are available for this roster under this ruleset." : "No star players are available for this roster."}</p>`;
    } else {
      $("star-list").innerHTML = choices.map((choice) => {
        const present = choice.members.filter((m) => positionCount(m.positionId) > 0).length;
        const status = choice.paired ? (present === 0 ? "0 / 1" : present === choice.members.length ? "1 / 1" : `${present} of ${choice.members.length} present`) : `${present} / ${choice.members[0].max ?? 1}`;
        const sp = mode === "tournament" ? starSp(choice) : null;
        const memberPacks = [...new Set(choice.members.flatMap((m) => Core.starPacksFor(m.name, packs)))];
        const packLine = memberPacks.length ? `<small class="star-pack">${memberPacks.map((p) => esc(Core.starPackLabel(p))).join(" · ")}</small>` : "";
        const canAdd = canAddStarChoice(choice);
        const capReached = cap != null && starCount >= cap && present === 0;
        return `<div class="star-row">
          <span class="star-sprites${choice.paired ? " paired" : ""}" aria-hidden="true">${choice.members.map((m) => `<span class="sprite-frame">${esc(initials(m.name))}</span>`).join("")}</span>
          <span class="star-copy"><strong>${esc(choice.label)}</strong><small>${sp != null ? `${sp} SP` : gold(choice.cost)} · ${status}</small>${packLine}</span>
          <span class="star-actions">
            <button type="button" data-star-remove="${esc(choice.key)}" ${present ? "" : "disabled"} aria-label="Remove ${esc(choice.label)}">−</button>
            <button type="button" class="star-add${named ? "" : " name-required"}" data-star-add="${esc(choice.key)}" ${canAdd && !capReached ? "" : "disabled"}
              ${!named ? 'title="You must name your team."' : capReached ? 'title="This ruleset\'s star player limit is reached."' : ""} aria-label="Add ${esc(choice.label)}">+</button>
          </span>
        </div>`;
      }).join("");
    }
    // Star SP table (tournament, SP-priced stars).
    const race = raceRules();
    const costs = race?.stars?.spCosts ?? [];
    const offered = new Set(choices.flatMap((c) => c.members.map((m) => norm(m.name))));
    const rows = costs.filter((star) => offered.has(norm(star.name)));
    const banned = race?.bannedStars ?? [];
    $("star-sp-section").hidden = !(mode === "tournament" && (rows.length || banned.length));
    $("star-sp-toggle").textContent = `${starSpOpen ? "▾" : "▸"} Star Player SP costs${rows.length ? ` (${rows.length})` : ""}`;
    $("star-sp-toggle").setAttribute("aria-expanded", String(starSpOpen));
    $("star-sp-body").hidden = !starSpOpen;
    $("star-sp-body").innerHTML = (rows.length
      ? `<table class="star-sp-table"><thead><tr><th scope="col">Star Player</th><th scope="col">SP Cost</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.name)}</th><td>${r.sp} SP</td></tr>`).join("")}</tbody></table>`
      : "") + (banned.length ? `<div class="ruleset-line">Banned: ${esc(banned.join(", "))}</div>` : "");
  }
  function canAddStarChoice(choice) {
    if (choice.members.every((m) => positionCount(m.positionId) > 0)) return false;
    if (choice.members.some((m) => !m.isStar || !starEligible(m))) return false;
    const missing = choice.members.filter((m) => positionCount(m.positionId) === 0);
    if (slots.length + missing.length > MAX_PLAYERS) return false;
    const counts = positionCounts();
    for (const member of missing) {
      if ((counts.get(member.positionId) ?? 0) >= (member.max ?? 1)) return false;
      if (mode !== "custom" && Core.positionGroupCapped(member.positionId, current?.positionGroups, counts)) return false;
      counts.set(member.positionId, (counts.get(member.positionId) ?? 0) + 1);
    }
    return true;
  }

  function renderInducements() {
    const visible = mode === "tournament" || mode === "custom";
    $("inducement-section").hidden = !visible || !current;
    if (!visible) return;
    const items = mode === "tournament" ? inducementCatalog.filter((item) => item.allowed) : inducementCatalog;
    $("inducement-list").innerHTML = items.map((item) => {
      const count = inducementCounts[item.key] ?? 0;
      const atMax = item.max !== null && item.max !== undefined && count >= item.max;
      return `<div class="stepper-row${item.allowed ? "" : " unavailable"}">
        <span class="stepper-label">${esc(item.label)}<small>${gold(item.price)}${item.max != null ? ` · max ${item.max}` : ""}</small></span>
        <button type="button" data-inducement="${esc(item.key)}" data-delta="-1" ${!item.allowed || count === 0 ? "disabled" : ""} aria-label="Remove ${esc(item.label)}">−</button>
        <b>${count}</b>
        <button type="button" class="step-add" data-inducement="${esc(item.key)}" data-delta="1" ${!item.allowed || atMax ? "disabled" : ""} aria-label="Add ${esc(item.label)}">+</button>
      </div>`;
    }).join("");
  }

  function renderStaff() {
    $("staff-controls").innerHTML = STAFF_ROWS.map((row) => {
      const max = row.max();
      const unavailable = row.key === "apothecary" && current && !current.apothecaryAllowed;
      const value = staff[row.key];
      return `<div class="stepper-row${unavailable ? " unavailable" : ""}">
        <span class="stepper-label">${esc(row.label)}<small>${row.min}–${max}</small></span>
        <button type="button" data-staff-key="${row.key}" data-staff-delta="-1" ${unavailable || value <= row.min ? "disabled" : ""} aria-label="Remove ${esc(row.label)}">−</button>
        <b>${value}</b>
        <button class="step-add" type="button" data-staff-key="${row.key}" data-staff-delta="1" ${unavailable || value >= max ? "disabled" : ""} aria-label="Add ${esc(row.label)}">+</button>
        <small class="stepper-cost">× ${gold(row.cost())} = ${gold(Math.max(0, value - row.free) * row.cost())}</small>
      </div>`;
    }).join("");
  }

  function renderValueCard() {
    const s = preview?.summary ?? null;
    const lines = [];
    // `value` is plain text (escaped here); `valueClass` is one of the fixed tokens below.
    const line = (label, value, cls = "", valueClass = "") => lines.push(`<div class="value-line${cls ? ` ${cls}` : ""}"><span>${esc(label)}</span><strong>${valueClass ? `<span class="${valueClass}">${esc(value)}</span>` : esc(value)}</strong></div>`);
    const pick = (server, client) => (typeof server === "number" && Number.isFinite(server) ? server : client);
    line("Players", `${slots.length} · ${gold(rawPlayerCost())}`);
    if (mode !== "create" && starSlots().length) line("Star players", gold(pick(s?.starsCost, rawStarCost())));
    line("Sideline staff", gold(staffCost()));
    if (mode !== "create") line("Inducements", gold(pick(s?.inducementsCost, inducementGold())));
    line("Skills", gold(pick(s?.skillsCost, addedSkillGold())));
    if (statRules() || (s?.statIncreasesCost ?? 0) > 0) line("Stat increases", gold(pick(s?.statIncreasesCost, statGold())));
    if ((s?.starFeesCost ?? 0) > 0) line("Star fees", gold(s.starFeesCost));
    if (mode !== "create") {
      line("Primary skills", String(pick(s?.primarySkillCount, slots.reduce((n, sl) => n + sl.chosenSkills.filter((k) => skillAccess(sl.positionId, k) !== "secondary").length, 0))));
      line("Secondary skills", String(pick(s?.secondarySkillCount, slots.reduce((n, sl) => n + sl.chosenSkills.filter((k) => skillAccess(sl.positionId, k) === "secondary").length, 0))));
      const spBudget = selectedPackSummary()?.skillPointBudget ?? (s?.skillPointBudget || raceRules()?.skillPointBudget || 0);
      if (spBudget) {
        const used = s?.skillPointsUsed ?? slots.reduce((sum, sl) => sum + Core.playerSkillSp(sl.chosenSkills, (k) => skillAccess(sl.positionId, k) === "secondary", raceRules()?.skillCosts ?? Core.DEFAULT_SKILL_COSTS), 0);
        line("Skill points", `${Core.num(used) ?? "—"} / ${Core.num(spBudget) ?? "—"}`, "", used > spBudget ? "over-budget" : "");
      }
    }
    const estimate = rawPlayerCost() + rawStarCost() + staffCost() + inducementGold() + addedSkillGold() + statGold();
    const used = s ? s.goldUsed : estimate;
    const budget = mode === "tournament" ? clientBudget() : (s?.goldBudget ?? clientBudget());
    const label = s ? (mode === "custom" ? "Authoritative preview" : "Total") : previewPending ? "Calculating team value…" : $("team-name").value.trim() ? "Estimate" : "Please name your team";
    line(label, `${gold(used)} / ${gold(budget)}`, "total", used > budget ? "over-budget" : "within-budget");
    $("value-lines").innerHTML = lines.join("");
    $("refresh-dot").hidden = !previewPending;
  }

  function findingText(finding) {
    if (typeof finding === "string") return finding;
    if (finding && typeof finding === "object") {
      const text = finding.message || finding.text || JSON.stringify(finding);
      return finding.suggestion ? `${text} — ${finding.suggestion}` : text;
    }
    return String(finding);
  }
  function renderValidity() {
    const card = $("validity-card");
    if (!current || !slots.length || !$("team-name").value.trim()) {
      card.hidden = true;
      return;
    }
    const errors = preview?.errors ?? [];
    const warnings = preview?.warnings ?? [];
    card.hidden = false;
    let cls = "checking";
    let headline = "Checking team…";
    if (mode === "custom") {
      cls = "custom";
      headline = "Custom team — validation off";
    } else if (preview?.failed) {
      cls = "invalid";
      headline = "Couldn't check the team";
    } else if (preview && !previewPending) {
      cls = preview.valid ? "valid" : "invalid";
      headline = preview.valid ? "Team is valid ✓" : `Team is invalid${errors.length ? `: ${errors.length} ${errors.length === 1 ? "issue" : "issues"} to fix` : ""}`;
    } else if (preview) {
      cls = `${preview.valid ? "valid" : "invalid"} refreshing`;
      headline = preview.valid ? "Team is valid ✓" : "Team is invalid";
    }
    card.className = `live-card validity-card ${cls}`;
    $("validity-headline").textContent = headline;
    $("findings").innerHTML = [
      ...errors.map((f) => `<div class="finding">${esc(findingText(f))}</div>`),
      ...warnings.map((f) => `<div class="finding warn">${esc(findingText(f))}</div>`),
    ].join("");
  }

  function renderAll() {
    renderMode();
    renderLeague();
    renderRulesetPanel();
    renderPositions();
    renderRoster();
    renderSkillPicker();
    renderStars();
    renderInducements();
    renderStaff();
    renderValueCard();
    renderValidity();
    renderSaves();
    syncBuildButton();
  }

  // ════════════════ ingestion sanitizing ════════════════
  // Strings are escaped at render time; numbers are coerced here so no server/package value that is
  // rendered raw as a "number" can carry markup into an innerHTML sink.
  const n0 = (value, fallback = null) => Core.num(value) ?? fallback;
  // Field-by-field copies only: never spread a server object, so an unexpected or string-typed
  // field can't ride into a render path. Strings stay strings (escaped at render), numbers are coerced.
  const sv = (value) => (value === null || value === undefined ? "" : String(value));
  const strList = (value) => (Array.isArray(value) ? value.map(sv) : []);
  const cell = (value) => (Core.num(value) ?? sv(value));
  function sanitizeRoster(roster) {
    return {
      rosterId: sv(roster?.rosterId),
      raceName: sv(roster?.raceName),
      reRollCost: n0(roster?.reRollCost, 0),
      maxReRolls: n0(roster?.maxReRolls, 8),
      apothecaryAllowed: roster?.apothecaryAllowed !== false,
      leagueOptions: strList(roster?.leagueOptions),
      ...(Array.isArray(roster?.specialRules) ? { specialRules: strList(roster.specialRules) } : {}),
      ...(Array.isArray(roster?.alwaysOnRules) ? { alwaysOnRules: strList(roster.alwaysOnRules) } : {}),
      positions: (Array.isArray(roster?.positions) ? roster.positions : []).map((position) => ({
        positionId: sv(position?.positionId),
        name: sv(position?.name),
        type: sv(position?.type),
        cost: n0(position?.cost, 0),
        max: n0(position?.max, 0),
        MA: cell(position?.MA),
        ST: cell(position?.ST),
        AG: sv(position?.AG),
        PA: sv(position?.PA),
        AV: sv(position?.AV),
        skills: strList(position?.skills),
        ...(Array.isArray(position?.skillsDisplay) ? { skillsDisplay: strList(position.skillsDisplay) } : {}),
        ...(Array.isArray(position?.keywords) ? { keywords: strList(position.keywords) } : {}),
        isStar: position?.isStar === true,
        playsFor: strList(position?.playsFor),
        ...(position?.teamWithPositionId ? { teamWithPositionId: sv(position.teamWithPositionId) } : {}),
      })),
      positionGroups: Array.isArray(roster?.positionGroups)
        ? roster.positionGroups.map((group) => ({ positions: strList(group?.positions), max: n0(group?.max, 0), label: sv(group?.label) }))
        : undefined,
    };
  }
  function sanitizePack(pack) {
    return { label: sv(pack?.label), gold: n0(pack?.gold), skillPointBudget: n0(pack?.skillPointBudget, 0), maxPerPlayer: n0(pack?.maxPerPlayer) };
  }
  function sanitizeSkillCosts(costs) {
    if (!costs || typeof costs !== "object") return undefined;
    return {
      primary: n0(costs.primary, Core.DEFAULT_SKILL_COSTS.primary),
      secondary: n0(costs.secondary, Core.DEFAULT_SKILL_COSTS.secondary),
      eliteSurcharge: n0(costs.eliteSurcharge, 0),
      stackSurcharge: n0(costs.stackSurcharge, 0),
      eliteSkills: strList(costs.eliteSkills),
    };
  }
  function sanitizePackageRules(rules) {
    const race = rules.race && typeof rules.race === "object" ? rules.race : null;
    const stars = race?.stars && typeof race.stars === "object" ? race.stars : null;
    return {
      name: sv(rules.name),
      ...(rules.dataNote ? { dataNote: sv(rules.dataNote) } : {}),
      budget: n0(rules.budget),
      tierSummary: rules.tierSummary.map((tier) => ({
        tier: n0(tier?.tier),
        label: sv(tier?.label),
        rosters: strList(tier?.rosters),
        gold: n0(tier?.gold),
        skillPointBudget: n0(tier?.skillPointBudget),
        packs: Array.isArray(tier?.packs) ? tier.packs.map(sanitizePack) : [],
      })),
      race: race ? {
        roster: sv(race.roster),
        source: sv(race.source),
        tierNumber: n0(race.tierNumber),
        ...(race.tierLabel ? { tierLabel: sv(race.tierLabel) } : {}),
        gold: n0(race.gold),
        skillPointBudget: n0(race.skillPointBudget, 0),
        skillCosts: sanitizeSkillCosts(race.skillCosts),
        maxPerPlayer: n0(race.maxPerPlayer),
        packs: Array.isArray(race.packs) ? race.packs.map(sanitizePack) : [],
        bannedStars: strList(race.bannedStars),
        stars: stars ? {
          allowed: stars.allowed !== false,
          maxCount: n0(stars.maxCount),
          paidInSkillPoints: stars.paidInSkillPoints === true,
          spCosts: Array.isArray(stars.spCosts)
            ? stars.spCosts.map((star) => ({ name: sv(star?.name), sp: n0(star?.sp, 0) }))
            : undefined,
        } : undefined,
      } : undefined,
    };
  }
  /** The preview's `package` echo: name/description/budget plus the raw rules block, which is only
   *  ever read through Core.normalizeTierRules (itself field-by-field). */
  function sanitizePackageEcho(echo) {
    if (!echo || typeof echo !== "object") return null;
    return {
      name: sv(echo.name),
      ...(echo.description ? { description: sv(echo.description) } : {}),
      budget: n0(echo.budget),
      ...(echo.rules && typeof echo.rules === "object" ? { rules: echo.rules } : {}),
    };
  }
  function sanitizeSummary(summary) {
    if (!summary || typeof summary !== "object") return null;
    const out = {};
    for (const [key, value] of Object.entries(summary)) {
      const n = Core.num(value);
      if (n !== null) out[key] = n;
    }
    return out;
  }

  // ════════════════ data loading ════════════════
  async function loadPackageRules() {
    const sequence = ++packageRulesSequence;
    const name = selectedPackageName();
    if (!name) {
      packageRules = null;
      tierRows = [];
      renderAll();
      return;
    }
    const race = current?.raceName;
    const [rulesResult, tiersResult] = await Promise.allSettled([
      api(`/api/packages/${encodeURIComponent(name)}${race ? `?roster=${encodeURIComponent(race)}` : ""}`),
      api(`/api/fork/team-builder/tiers?packageName=${encodeURIComponent(name)}`),
    ]);
    if (sequence !== packageRulesSequence) return;
    packageDoc = rulesResult.status === "fulfilled" && rulesResult.value?.pkg && typeof rulesResult.value.pkg === "object"
      ? rulesResult.value.pkg : null;
    packageRules = rulesResult.status === "fulfilled" && rulesResult.value?.rules && Array.isArray(rulesResult.value.rules.tierSummary)
      ? sanitizePackageRules(rulesResult.value.rules) : null;
    tierRows = tiersResult.status === "fulfilled" && Array.isArray(tiersResult.value?.races) ? tiersResult.value.races : [];
    if (rulesResult.status === "rejected") setStatus(`Couldn't load the ruleset: ${rulesResult.reason.message}`, true);
    renderAll();
    renderSetup();
  }
  async function loadInducements() {
    const sequence = ++inducementSequence;
    if (mode === "create") {
      inducementCatalog = [];
      inducementCounts = {};
      $("inducement-status").textContent = "";
      return;
    }
    const name = selectedPackageName();
    try {
      const data = await api(`/api/fork/team-builder/inducements${name ? `?packageName=${encodeURIComponent(name)}` : ""}`);
      if (sequence !== inducementSequence) return;
      inducementCatalog = (Array.isArray(data.inducements) ? data.inducements : []).map((item) => ({
        key: String(item.key ?? ""),
        label: String(item.label ?? item.key ?? ""),
        price: Core.num(item.price) ?? 0,
        max: Core.num(item.max),
        allowed: item.allowed === true,
      }));
      const next = {};
      for (const item of inducementCatalog) {
        const count = item.allowed ? Math.max(0, Math.floor(inducementCounts[item.key] ?? 0)) : 0;
        next[item.key] = item.max == null ? count : Math.min(count, Math.max(0, item.max));
      }
      inducementCounts = next;
      $("inducement-status").textContent = inducementCatalog.length ? "" : "No inducements are available for this package.";
    } catch (error) {
      if (sequence !== inducementSequence) return;
      inducementCatalog = [];
      inducementCounts = {};
      $("inducement-status").textContent = `Couldn't load inducements (${error.message}).`;
    }
    renderInducements();
    schedulePreview();
  }
  function setStatus(text, error = false) {
    $("builder-status").textContent = text;
    $("builder-status").className = `status-copy${error ? " error" : ""}`;
  }

  // ════════════════ preview / build ════════════════
  /** Characteristics the current tier lets a player raise (empty when the ruleset offers none). */
  function allowedStatList() {
    const rules = statRules();
    if (!rules) return [];
    return Array.isArray(rules.stats) && rules.stats.length ? rules.stats : Core.STATS;
  }
  /** `forSave`: a tournament draft keeps its stat increases while the tier rules are still unknown
   *  (not yet loaded / failed), so a save never silently drops them. Preview/build only ever send
   *  increases the ruleset allows — the server rejects anything else. */
  function requestBody({ forSave = false } = {}) {
    const edit = canEditSkills();
    const rulesUnknown = mode === "tournament" && !tierRules();
    const keepAll = forSave && rulesUnknown;
    const picks = Core.buildPicks(slots.map((slot) => ({ ...slot, isStar: positionById(slot.positionId)?.isStar === true })), {
      skills: edit,
      stats: mode === "tournament" && (keepAll || Boolean(statRules())),
      allowedStats: keepAll ? null : allowedStatList(),
      customStats: mode === "custom",
    });
    const specialRule = selectedSpecialRule();
    const inducements = inducementPicks();
    return {
      ...(editingTeamId ? { teamId: editingTeamId } : {}),
      rosterId: current?.rosterId,
      coach: authCoach || $("coach").value.trim(),
      teamName: $("team-name").value.trim(),
      picks,
      reRolls: staff.reRolls,
      apothecary: current?.apothecaryAllowed !== false && staff.apothecary === 1,
      assistantCoaches: staff.assistantCoaches,
      cheerleaders: staff.cheerleaders,
      dedicatedFans: staff.dedicatedFans,
      ...(mode === "custom" ? { custom: true } : {}),
      ...(mode === "tournament" && $("package").value ? { packageName: $("package").value } : {}),
      ...(mode === "tournament" && selectedSkillPack ? { skillPack: selectedSkillPack } : {}),
      ...(specialRule ? { specialRule } : {}),
      ...(mode !== "create" && inducements.length ? { rosteredInducements: inducements } : {}),
    };
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewSequence++;
    if (preview && preview.rosterId !== current?.rosterId) preview = null;
    if (!current || !slots.length || !$("team-name").value.trim() || !(authCoach || $("coach").value.trim()) || mode === "library") {
      previewPending = false;
      renderValueCard();
      renderValidity();
      syncBuildButton();
      return;
    }
    previewPending = true;
    renderValueCard();
    renderValidity();
    syncBuildButton();
    const sequence = previewSequence;
    previewTimer = setTimeout(() => runPreview(sequence), 300);
  }
  async function runPreview(sequence) {
    const rosterId = current?.rosterId;
    try {
      const result = await postJson("/api/fork/team-builder/preview", requestBody());
      if (sequence !== previewSequence) return;
      const hadRules = Boolean(Core.normalizeTierRules(preview?.package?.rules));
      preview = {
        rosterId,
        valid: result.valid === true,
        errors: Array.isArray(result.errors) ? result.errors : [],
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        summary: sanitizeSummary(result.summary),
        package: sanitizePackageEcho(result.package),
      };
      previewPending = false;
      // The rules echo can change the controls (stat-increase selects, star packs) — re-render fully when it appears.
      if (hadRules !== Boolean(Core.normalizeTierRules(preview.package?.rules))) renderAll();
      else { renderRulesetPanel(); renderStars(); renderValueCard(); renderValidity(); syncBuildButton(); }
    } catch (error) {
      if (sequence !== previewSequence) return;
      previewPending = false;
      preview = { rosterId, failed: true, valid: false, errors: [error.message], warnings: [], summary: preview?.summary ?? null, package: preview?.package ?? null };
      renderValueCard();
      renderValidity();
      syncBuildButton();
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
    buildBusy = true;
    syncBuildButton();
    $("build-result").hidden = true;
    try {
      const body = { ...requestBody(), ...(currentSave ? { saveId: currentSave.id } : {}) };
      const result = await postJson("/api/fork/team-builder/build", body);
      $("build-result").className = "result-banner success";
      $("build-result").innerHTML = `<strong>${editingTeamId ? "Team Saved ✓" : "Team Created ✓"}</strong><span>Installed ${esc(result.teamId)} — ready in Create Game.</span>`;
      $("build-result").hidden = false;
      if (currentSave && result.teamId && authOrganizer) {
        // The save is now linked to this fork team: further builds from it update the team.
        editingTeamId = result.teamId;
        renderMode();
      }
      if (currentSave) loadSaves();
    } catch (error) {
      if (error.status === 401) sessionExpired("Your session expired. Sign in again to create the team.");
      const detail = Array.isArray(error.body?.errors) ? error.body.errors.map(findingText) : [];
      $("build-result").className = "result-banner error";
      $("build-result").innerHTML = `<strong>Build failed</strong><span>${esc(error.message)}</span>${detail.map((d) => `<span>${esc(d)}</span>`).join("")}`;
      $("build-result").hidden = false;
    } finally {
      buildBusy = false;
      syncBuildButton();
    }
  }

  // ════════════════ mutations ════════════════
  function showNameGate() {
    clearTimeout(nameGateTimer);
    $("name-gate-toast").hidden = false;
    $("team-name").focus();
    nameGateTimer = setTimeout(() => { $("name-gate-toast").hidden = true; }, 3000);
  }
  function changed({ positions = true } = {}) {
    $("build-result").hidden = true;
    if (positions) renderPositions();
    renderRoster();
    renderSkillPicker();
    renderStars();
    renderValueCard();
    schedulePreview();
  }
  function addPosition(positionId) {
    if (!$("team-name").value.trim()) { showNameGate(); return; }
    const position = positionById(positionId);
    if (!position || position.isStar || positionCount(positionId) >= position.max || slots.length >= MAX_PLAYERS) return;
    if (mode !== "custom" && Core.positionGroupCapped(positionId, current.positionGroups, positionCounts())) return;
    slots.push({ positionId, chosenSkills: [], chosenStatIncreases: [] });
    changed();
  }
  function removeSlot(index) {
    const slot = slots[index];
    if (!slot) return;
    const pair = allStarChoices().find((choice) => choice.paired && choice.members.some((m) => m.positionId === slot.positionId));
    if (pair) {
      removeStarChoice(pair.key);
      return;
    }
    slots.splice(index, 1);
    if (skillPickerIndex === index) skillPickerIndex = null;
    else if (skillPickerIndex != null && skillPickerIndex > index) skillPickerIndex--;
    changed();
  }
  function addStarChoice(key) {
    if (!$("team-name").value.trim()) { showNameGate(); return; }
    const choice = displayedStarChoices().find((c) => c.key === key);
    if (!choice || !canAddStarChoice(choice)) return;
    const cap = starCap();
    if (cap != null && starPickCount() >= cap) return;
    for (const member of choice.members) {
      if (positionCount(member.positionId) === 0) slots.push({ positionId: member.positionId, chosenSkills: [], chosenStatIncreases: [] });
    }
    changed();
  }
  function removeStarChoice(key) {
    const choice = allStarChoices().find((c) => c.key === key);
    if (!choice) return;
    for (const member of choice.members) {
      const index = slots.map((s) => s.positionId).lastIndexOf(member.positionId);
      if (index >= 0) slots.splice(index, 1);
    }
    skillPickerIndex = null;
    changed();
  }
  async function openSkillPicker(index) {
    if (skillPickerIndex === index) {
      skillPickerIndex = null;
      renderRoster();
      renderSkillPicker();
      return;
    }
    const slot = slots[index];
    if (!slot) return;
    skillPickerIndex = index;
    pickerCategory = null;
    renderRoster();
    renderSkillPicker();
    try {
      await ensureSkillCatalog();
      if (mode !== "custom") await ensureLegalSkills(slot.positionId);
    } catch (error) {
      if (skillPickerIndex === index) $("skill-picker-body").innerHTML = `<div class="skill-picker-status">Couldn't load legal skills (${esc(error.message)}).</div>`;
      return;
    }
    if (skillPickerIndex === index) renderSkillPicker();
    $("skill-picker").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function addSkill(skill) {
    const slot = slots[skillPickerIndex];
    if (!slot || slot.chosenSkills.includes(skill)) return;
    if (statRules() && exclusiveStatAndSkill() && slot.chosenStatIncreases.length) return;
    slot.chosenSkills.push(skill);
    changed({ positions: false });
  }
  function removeSkill(index, skill) {
    const slot = slots[index];
    if (!slot) return;
    slot.chosenSkills = slot.chosenSkills.filter((s) => s !== skill);
    changed({ positions: false });
  }
  function setStatIncrease(index, stat) {
    const slot = slots[index];
    if (!slot) return;
    if (maxStatsPerPlayer() <= 1) slot.chosenStatIncreases = stat ? [stat] : [];
    else if (stat && !slot.chosenStatIncreases.includes(stat) && slot.chosenStatIncreases.length < maxStatsPerPlayer()) slot.chosenStatIncreases.push(stat);
    changed({ positions: false });
  }
  function stepStaff(key, delta) {
    const row = STAFF_ROWS.find((item) => item.key === key);
    if (!row || (key === "apothecary" && current && !current.apothecaryAllowed)) return;
    staff[key] = Math.max(row.min, Math.min(row.max(), staff[key] + delta));
    renderStaff();
    renderValueCard();
    schedulePreview();
  }
  function stepInducement(key, delta) {
    const item = inducementCatalog.find((entry) => entry.key === key);
    if (!item?.allowed) return;
    const max = item.max == null ? Number.MAX_SAFE_INTEGER : Math.max(0, item.max);
    inducementCounts = { ...inducementCounts, [key]: Math.max(0, Math.min(max, (inducementCounts[key] ?? 0) + delta)) };
    renderInducements();
    renderValueCard();
    schedulePreview();
  }
  /** Strip what the new mode doesn't support so what's shown == what's built (Vue watch(mode) port). */
  function cleanSlotsForMode() {
    slots = slots
      .filter((slot) => mode !== "create" || !positionById(slot.positionId)?.isStar)
      .map((slot) => (canEditSkills() ? slot : { ...slot, chosenSkills: [], chosenStatIncreases: [] }));
    if (mode !== "custom" && current?.positionGroups) {
      const accepted = new Map();
      slots = slots.filter((slot) => {
        if (Core.positionGroupCapped(slot.positionId, current.positionGroups, accepted)) return false;
        accepted.set(slot.positionId, (accepted.get(slot.positionId) ?? 0) + 1);
        return true;
      });
    }
  }
  async function selectMode(next, { keepEdit = false } = {}) {
    if (!keepEdit) {
      editingTeamId = null;
      $("edit-hint").hidden = true;
    }
    mode = next;
    skillPickerIndex = null;
    if (mode === "library") {
      renderMode();
      loadLibrary();
      return;
    }
    cleanSlotsForMode();
    if (mode === "tournament" && !$("package").value && packages.length) $("package").value = packages[0].name;
    renderAll();
    await Promise.all([loadPackageRules(), loadInducements()]);
    schedulePreview();
  }
  function selectRoster(rosterId) {
    current = rosters.find((roster) => roster.rosterId === rosterId) ?? null;
    slots = [];
    staff = freshStaff();
    skillPickerIndex = null;
    selectedSkillPack = null;
    preview = null;
    leagueSelection = Core.reconcileLeagueSelection(leagueOptions(), { selectedLeague: "", explicit: false });
    $("league-notice").hidden = true;
    $("build-result").hidden = true;
    renderAll();
    loadPackageRules();
  }
  function selectLeague(league) {
    leagueSelection = Core.reconcileLeagueSelection(leagueOptions(), { selectedLeague: league, explicit: true });
    // Drop stars that are no longer eligible for the chosen league (pairs atomically).
    const before = slots.length;
    const choiceById = new Map();
    for (const choice of allStarChoices()) for (const member of choice.members) choiceById.set(member.positionId, choice);
    const remove = new Set();
    for (const slot of slots) {
      const position = positionById(slot.positionId);
      if (!position?.isStar || starEligible(position)) continue;
      for (const member of choiceById.get(position.positionId)?.members ?? [position]) remove.add(member.positionId);
    }
    slots = slots.filter((slot) => !remove.has(slot.positionId));
    const removed = before - slots.length;
    $("league-notice").hidden = !removed;
    $("league-notice").textContent = removed ? `${removed} ineligible star player${removed === 1 ? "" : "s"} removed.` : "";
    renderLeague();
    changed();
  }

  // ════════════════ restore (saves + library edit) ════════════════
  /** Restore the whole builder from a TeamBuilderBody (saved draft). */
  async function applyBody(body) {
    const nextMode = body.custom ? "custom" : body.packageName ? "tournament" : "create";
    mode = nextMode;
    editingTeamId = typeof body.teamId === "string" && body.teamId.trim() ? body.teamId : null;
    if (body.packageName) {
      if (!packages.some((p) => p.name === body.packageName)) {
        $("edit-hint").hidden = false;
        $("edit-hint").textContent = `This team's ruleset '${body.packageName}' is no longer available.`;
      } else {
        $("package").value = body.packageName;
      }
    }
    $("team-name").value = body.teamName ?? "";
    current = rosters.find((roster) => roster.rosterId === body.rosterId) ?? null;
    $("race").value = current?.rosterId ?? "";
    if (!current) {
      setStatus(`The saved roster "${body.rosterId}" isn't available on this server.`, true);
      slots = [];
      renderAll();
      return;
    }
    leagueSelection = Core.reconcileLeagueSelection(leagueOptions(),
      body.specialRule ? { selectedLeague: body.specialRule, explicit: true } : { selectedLeague: "", explicit: false });
    slots = Core.slotsFromPicks(body.picks, positionById);
    staff = {
      reRolls: Number(body.reRolls) || 0,
      assistantCoaches: Number(body.assistantCoaches) || 0,
      cheerleaders: Number(body.cheerleaders) || 0,
      dedicatedFans: Number(body.dedicatedFans) || 1,
      apothecary: body.apothecary ? 1 : 0,
    };
    selectedSkillPack = typeof body.skillPack === "string" ? body.skillPack : null;
    const induced = body.rosteredInducements ?? body.inducements ?? [];
    inducementCounts = Object.fromEntries((Array.isArray(induced) ? induced : []).map((p) => [p.key, Number(p.count) || 0]));
    preview = null;
    skillPickerIndex = null;
    renderAll();
    await Promise.all([loadPackageRules(), loadInducements(), ensureSkillCatalog()]);
    // Inducement load clamps counts to the catalog; re-apply the saved ones it allows.
    for (const pick of Array.isArray(induced) ? induced : []) {
      if (inducementCatalog.some((item) => item.key === pick.key && item.allowed)) inducementCounts[pick.key] = Number(pick.count) || 0;
    }
    // Fetch legal skills for every skilled position so primary/secondary colouring is exact.
    const skilled = [...new Set(slots.filter((s) => s.chosenSkills.length).map((s) => s.positionId))];
    await Promise.allSettled(skilled.map((id) => ensureLegalSkills(id)));
    if (TOURNAMENT_PAGE) setupStep = 3;
    renderAll();
    renderSetup();
    schedulePreview();
  }

  // ── Saves (signed-in coaches; server contract /api/fork/team-builder/saves) ──
  function renderSaves() {
    const signedIn = Boolean(authCoach);
    $("saves-signin").hidden = signedIn;
    $("saves-signin").innerHTML = discordSsoEnabled
      ? 'Sign in (fork account or <a href="/api/auth/discord/start?next=/team-builder.html">Discord</a>) to save drafts and recall them later.'
      : "Sign in with your fork account to save drafts and recall them later.";
    $("saves-actions").hidden = !signedIn || !savesAvailable;
    $("saves-list").hidden = !signedIn || !savesOpen || !savesAvailable;
    $("saves-toggle").textContent = savesOpen ? "Hide list" : `Show list${saves.length ? ` (${saves.length})` : ""}`;
    $("saves-toggle").setAttribute("aria-expanded", String(savesOpen));
    $("current-save-label").textContent = currentSave ? `Editing “${currentSave.name}”` : "";
    $("save-button").disabled = !current;
    $("save-as-button").disabled = !current;
    if (!signedIn) {
      $("saves-status").textContent = "";
      return;
    }
    $("saves-list").innerHTML = saves.length ? saves.map((save) => {
      const built = Boolean(save.teamId);
      const updated = save.updatedAt ? new Date(save.updatedAt) : null;
      return `<div class="save-row${currentSave?.id === save.id ? " current" : ""}">
        <span class="save-copy"><strong>${esc(save.name)}</strong><small>${esc(save.raceName ?? save.rosterId ?? "")}${save.packageName ? ` · ${esc(save.packageName)}` : ""}${updated && !Number.isNaN(updated.getTime()) ? ` · ${esc(updated.toLocaleDateString())}` : ""}</small></span>
        <span class="save-badge ${built ? "built" : "draft"}">${built ? "Built" : "Draft"}</span>
        <span class="save-buttons">
          <button type="button" class="session-button secondary" data-save-load="${esc(save.id)}">Load</button>
          <button type="button" class="session-button secondary" data-save-rename="${esc(save.id)}">Rename</button>
          <button type="button" class="session-button secondary danger" data-save-delete="${esc(save.id)}">Delete</button>
        </span>
      </div>`;
    }).join("") : '<p class="status-copy">No saved teams yet.</p>';
  }
  function savesError(error, action) {
    if (error.status === 401) {
      sessionExpired("Your session expired. Sign in again to use saved teams.");
      return;
    }
    if (error.status === 404 && action === "list") {
      savesAvailable = false;
      $("saves-status").textContent = "Saved teams aren't available on this server yet.";
      renderSaves();
      return;
    }
    $("saves-status").textContent = `Couldn't ${action} (${error.message}).`;
  }
  async function loadSaves() {
    if (!authCoach) return;
    try {
      const data = await api("/api/fork/team-builder/saves");
      savesAvailable = true;
      saves = Array.isArray(data.saves) ? data.saves : [];
      if (currentSave && !saves.some((save) => save.id === currentSave.id)) currentSave = null;
      if (/^Couldn't/.test($("saves-status").textContent)) $("saves-status").textContent = "";
    } catch (error) {
      savesError(error, "list");
    }
    renderSaves();
  }
  async function saveTeam(asNew) {
    if (!authCoach || !current) return;
    let name = currentSave?.name;
    if (asNew || !currentSave) {
      const suggested = $("team-name").value.trim() || `${current.raceName} team`;
      name = window.prompt("Save team as:", suggested);
      if (name === null) return;
      name = name.trim();
      if (!name) return;
    }
    const body = requestBody({ forSave: true });
    try {
      const data = asNew || !currentSave
        ? await postJson("/api/fork/team-builder/saves", { name, body })
        : await postJson(`/api/fork/team-builder/saves/${encodeURIComponent(currentSave.id)}`, { name, body }, "PUT");
      const save = data.save ?? null;
      if (save?.id) currentSave = { id: save.id, name: save.name ?? name };
      $("saves-status").textContent = `Saved “${currentSave?.name ?? name}”.`;
      await loadSaves();
    } catch (error) {
      savesError(error, "save the team");
      renderSaves();
    }
  }
  async function loadSave(id) {
    try {
      const data = await api(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`);
      const save = data.save;
      if (!save?.body) throw new Error("Saved team has no builder state.");
      if (TOURNAMENT_PAGE && !save.body.packageName) {
        $("saves-status").textContent = `“${save.name ?? ""}” isn't a tournament team — open it in the Team Builder.`;
        return;
      }
      currentSave = { id: save.id ?? id, name: save.name ?? "" };
      $("saves-status").textContent = `Loaded “${currentSave.name}”.`;
      // A save that was already built edits its fork team instead of minting a second one.
      await applyBody(authOrganizer && save.teamId && !save.body.teamId ? { ...save.body, teamId: save.teamId } : save.body);
      renderSaves();
    } catch (error) {
      savesError(error, "load the team");
      renderSaves();
    }
  }
  async function renameSave(id) {
    const save = saves.find((s) => s.id === id);
    if (!save) return;
    const name = window.prompt("Rename saved team:", save.name);
    if (name === null || !name.trim()) return;
    try {
      const detail = await api(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`);
      await postJson(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`, { name: name.trim(), body: detail.save?.body ?? {} }, "PUT");
      if (currentSave?.id === id) currentSave.name = name.trim();
      await loadSaves();
    } catch (error) {
      savesError(error, "rename the team");
      renderSaves();
    }
  }
  async function deleteSave(id) {
    const save = saves.find((s) => s.id === id);
    if (!save || !window.confirm(`Delete saved team “${save.name}”? This can't be undone.`)) return;
    try {
      await api(`/api/fork/team-builder/saves/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (currentSave?.id === id) currentSave = null;
      $("saves-status").textContent = `Deleted “${save.name}”.`;
      await loadSaves();
    } catch (error) {
      savesError(error, "delete the team");
      renderSaves();
    }
  }

  // ── Fork library ("Your Fork Teams") with whole-roster edit ──
  async function loadLibrary() {
    const coach = authCoach || $("coach").value.trim();
    if (!coach) {
      $("library-status").textContent = "Sign in (or enter your coach name) to see your fork teams.";
      $("library-list").innerHTML = "";
      return;
    }
    $("library-status").textContent = "Loading your fork teams…";
    try {
      const data = await api(`/api/fork/library?coach=${encodeURIComponent(coach)}`);
      library = Array.isArray(data.teams) ? data.teams : [];
      $("library-status").textContent = library.length ? "" : "No teams are currently in your fork library.";
    } catch (error) {
      library = [];
      $("library-status").textContent = `Couldn't load your teams (${error.message}).`;
    }
    $("library-list").innerHTML = library.map((team) => `<div class="library-row">
      <span class="sprite-frame" aria-hidden="true">${esc(initials(team.teamName))}</span>
      <span class="save-copy"><strong>${esc(team.teamName)}</strong><small>${esc(team.race)} · ${gold((team.teamValue ?? 0) * 1000)}${team.rulesetPackName ? ` · ${esc(team.rulesetPackName)}` : ""}${team.forkLoadable === false ? " · not fork-loadable" : ""}</small></span>
      <button type="button" class="session-button secondary" data-library-edit="${esc(team.teamId)}">Edit Team</button>
    </div>`).join("");
  }
  function rosterForRace(race) {
    const key = norm(race);
    return rosters.find((roster) => norm(roster.raceName) === key || norm(roster.rosterId) === key) ?? null;
  }
  async function editLibraryTeam(teamId) {
    if (!authCoach) {
      $("library-status").textContent = "Sign in with the fork account that owns this team to edit it.";
      return;
    }
    $("library-status").textContent = "Loading team…";
    let detail;
    try {
      const data = await api(`/api/teams/${encodeURIComponent(teamId)}/detail`);
      detail = data.team ?? data.detail ?? data;
    } catch (error) {
      if (error.status === 401) sessionExpired("Your session expired. Sign in again to edit the team.");
      $("library-status").textContent = `Couldn't load the team (${error.message}).`;
      return;
    }
    if (detail.canEditRoster && detail.canEditRoster.available === false) {
      $("library-status").textContent = detail.canEditRoster.reason ?? "Whole-roster editing is unavailable for this team.";
      return;
    }
    const roster = rosterForRace(detail.race ?? "");
    if (!roster) {
      $("library-status").textContent = `Couldn't edit this team (no builder roster matched ${detail.race}).`;
      return;
    }
    const byId = (id) => roster.positions.find((p) => p.positionId === id) ?? null;
    const restored = [];
    for (const player of [...(detail.players ?? [])].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
      const position = byId(player.positionId);
      if (!position) continue;
      const printed = new Set(position.skills ?? []);
      const { increases, absolute } = Core.deriveStatChanges(position, player);
      restored.push({
        positionId: position.positionId,
        isStar: position.isStar === true,
        chosenSkills: (player.skills ?? []).filter((skill) => !printed.has(skill)),
        chosenStatIncreases: increases,
        chosenStats: absolute,
      });
    }
    const leagues = Core.normalizeLeagueOptions(roster.leagueOptions);
    const stored = [...new Set([...(detail.leagues ?? []), ...(detail.specialRules ?? [])].filter((l) => leagues.includes(l)))];
    const packageOk = detail.rulesetPackName && packages.some((p) => p.name === detail.rulesetPackName);
    const anySkills = restored.some((s) => s.chosenSkills.length || s.chosenStatIncreases.length || Object.keys(s.chosenStats).length);
    const body = {
      teamId: detail.id ?? teamId,
      rosterId: roster.rosterId,
      teamName: detail.name ?? "",
      // Tournament teams carry +1 increases; custom teams carry their absolute characteristic values.
      picks: Core.buildPicks(restored, { skills: true, stats: Boolean(packageOk), customStats: !packageOk }),
      reRolls: detail.rerolls ?? 0,
      apothecary: detail.apothecary === true,
      assistantCoaches: detail.assistantCoaches ?? 0,
      cheerleaders: detail.cheerleaders ?? 0,
      dedicatedFans: detail.fanFactor ?? 1,
      ...(packageOk ? { packageName: detail.rulesetPackName } : !anySkills ? {} : { custom: true }),
      ...(stored.length === 1 && leagues.length > 1 ? { specialRule: stored[0] } : {}),
    };
    currentSave = null;
    await applyBody(body);
    if (detail.rulesetPackName && !packageOk) {
      $("edit-hint").hidden = false;
      $("edit-hint").textContent = `This team's ruleset pack '${detail.rulesetPackName}' is no longer available; editing it in ${body.custom ? "Custom" : "Create"} mode.`;
    }
    renderSaves();
  }

  // ════════════════ roster sheet export ════════════════
  function sheetModel() {
    const specialRules = [
      ...(Array.isArray(current?.specialRules) ? current.specialRules : []),
      ...(Array.isArray(current?.alwaysOnRules) ? current.alwaysOnRules : []),
      ...(activeLeague() ? [activeLeague()] : []),
    ];
    return Core.rosterSheetModel({
      raceName: current?.raceName ?? "",
      coach: authCoach || $("coach").value.trim(),
      teamName: $("team-name").value.trim(),
      rulesetName: mode === "tournament" ? [$("package").value, raceRules()?.tierLabel].filter(Boolean).join(" — ") : "",
      players: slots.map((slot) => ({
        position: positionById(slot.positionId),
        chosenSkills: canEditSkills() ? slot.chosenSkills : [],
        chosenStatIncreases: statRules() ? (slot.chosenStatIncreases ?? []).filter((stat) => allowedStatList().includes(stat)) : [],
        chosenStats: mode === "custom" ? slot.chosenStats : null,
        accessOf: (skill) => (skillAccess(slot.positionId, skill) === "secondary" ? "secondary" : "primary"),
      })),
      staff,
      apothecaryAllowed: current?.apothecaryAllowed !== false,
      inducements: inducementPicks().map((pick) => ({ label: inducementCatalog.find((i) => i.key === pick.key)?.label ?? pick.key, count: pick.count })),
      specialRules,
      summary: preview?.summary ?? null,
      costs: {
        players: rawPlayerCost(),
        stars: rawStarCost(),
        sideline: staffCost(),
        skills: addedSkillGold(),
        inducements: inducementGold(),
      },
      budget: mode === "tournament" ? clientBudget() : undefined,
    });
  }
  function ensureSheetStyle() {
    if (document.getElementById("roster-sheet-style")) return;
    const style = document.createElement("style");
    style.id = "roster-sheet-style";
    style.textContent = Core.SHEET_CSS;
    document.head.appendChild(style);
  }
  async function prepareSheet() {
    // Exact primary/secondary colouring needs each skilled position's access lists.
    const skilled = [...new Set(slots.filter((s) => s.chosenSkills.length).map((s) => s.positionId))];
    await Promise.allSettled(skilled.map((id) => ensureLegalSkills(id)));
    return sheetModel();
  }
  async function printSheet() {
    if (!current || !slots.length) return;
    ensureSheetStyle();
    $("roster-sheet").innerHTML = Core.rosterSheetHtml(await prepareSheet());
    window.print();
  }
  async function downloadSheet() {
    if (!current || !slots.length) return;
    const model = await prepareSheet();
    const blob = new Blob([Core.standaloneSheetDocument(model)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = Core.sheetFileName(model);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ════════════════ tournament page setup flow ════════════════
  /** Races the selected package admits, with their tier and team-value cap, grouped by tier. */
  function eligibleRaceGroups() {
    const listed = Array.isArray(packageDoc?.eligibleRosters) ? packageDoc.eligibleRosters.map(String) : [];
    const all = !listed.length || listed.includes("*");
    const admitted = (name) => all || listed.some((entry) => norm(entry) === norm(name));
    const groups = new Map();
    const seen = new Set();
    for (const row of tierRows) {
      const roster = rosterForRace(String(row.name ?? ""));
      if (!roster || !admitted(row.name) || seen.has(roster.rosterId)) continue;
      seen.add(roster.rosterId);
      const tier = Core.num(row.tier);
      const summaryGold = packageRules?.tierSummary?.find((t) => t.tier === tier)?.gold;
      const capGold = Core.num(row.gold ?? row.goldCap ?? row.budget) ?? Core.num(summaryGold) ?? Core.num(packageRules?.budget);
      const key = tier ?? "—";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ roster, gold: capGold });
    }
    // A package without tier rows still lists every admitted roster under one heading.
    if (!tierRows.length) {
      const flat = rosters.filter((roster) => admitted(roster.raceName)).map((roster) => ({ roster, gold: Core.num(packageRules?.budget) }));
      if (flat.length) groups.set("—", flat);
    }
    return [...groups.entries()]
      .sort((a, b) => (Number(a[0]) || 99) - (Number(b[0]) || 99))
      .map(([tier, races]) => ({ tier, races: races.sort((x, y) => x.roster.raceName.localeCompare(y.roster.raceName)) }));
  }
  function renderSetup() {
    if (!TOURNAMENT_PAGE) return;
    const name = $("package").value;
    const tierLabel = raceRules()?.tierLabel ?? (raceRules()?.tierNumber != null ? `Tier ${raceRules().tierNumber}` : "");
    document.querySelectorAll("[data-tt-step]").forEach((button) => {
      const step = Number(button.dataset.ttStep);
      button.disabled = step === 2 ? !name : step === 3 ? !current : false;
      button.classList.toggle("active", step === setupStep);
      if (step === setupStep) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    $("tt-step-1-label").textContent = name || "Choose a tournament";
    $("tt-step-2-label").textContent = current ? `${current.raceName}${tierLabel ? ` · ${tierLabel}` : ""}` : "Pick a tiered race";
    $("tt-step-package").hidden = setupStep !== 1;
    $("tt-step-race").hidden = setupStep !== 2;
    $("builder-panel").hidden = setupStep !== 3;
    // Step 1 — rulesets + the chosen one's description, data note and tier table.
    $("tt-packages").innerHTML = packages.length ? packages.map((row) => `<button type="button" role="listitem" class="tt-card${row.name === name ? " selected" : ""}" data-tt-package="${esc(row.name)}" aria-pressed="${row.name === name}">
        <strong>${esc(row.name)}</strong>${row.description ? `<small>${esc(String(row.description).slice(0, 180))}${String(row.description).length > 180 ? "…" : ""}</small>` : ""}
      </button>`).join("") : '<p class="status-copy">No tournament packages are saved yet.</p>';
    $("tt-package-detail").hidden = !name;
    if (name) {
      $("tt-package-name").textContent = name;
      $("tt-package-description").textContent = String(packageDoc?.description ?? packages.find((row) => row.name === name)?.description ?? "");
      const note = packageRules?.dataNote ?? packageDoc?.dataNote ?? "";
      $("tt-package-note").textContent = String(note);
      $("tt-package-note").hidden = !note;
      const table = Core.tierTable(tierRows, packageRules?.tierSummary);
      $("tt-tier-table").innerHTML = Core.tierTableHtml(table);
      $("tt-tier-table").hidden = !table.length;
      $("tt-tier-empty").hidden = Boolean(table.length);
    }
    // Step 2 — eligible races grouped by tier, each with its team-value cap.
    if (setupStep === 2) {
      const groups = eligibleRaceGroups();
      $("tt-race-title").textContent = `Step 2 — Pick a race for ${name}`;
      $("tt-races").innerHTML = groups.length ? groups.map((group) => `<section class="tt-race-group" aria-label="${esc(group.tier === "—" ? "Eligible rosters" : `Tier ${group.tier}`)}">
          <div class="section-title">${group.tier === "—" ? "<span>E</span>ligible <span>R</span>osters" : `<span>T</span>ier ${esc(group.tier)}`}</div>
          <div class="tt-card-grid">${group.races.map(({ roster, gold: cap }) => `<button type="button" class="tt-card tt-race${current?.rosterId === roster.rosterId ? " selected" : ""}" data-tt-race="${esc(roster.rosterId)}">
            <strong>${esc(roster.raceName)}</strong><small>${cap != null ? `TV cap ${gold(cap)}` : "Package budget"}</small>
          </button>`).join("")}</div>
        </section>`).join("") : '<p class="status-copy">No installed roster is eligible for this ruleset.</p>';
    }
    // Step 3 — the locked builder's summary bar.
    if (current && name) {
      const cap = clientBudget();
      $("tt-locked-summary").innerHTML = `<b>${esc(name)}</b> · ${esc(current.raceName)}${tierLabel ? ` · ${esc(tierLabel)}` : ""} · TV cap ${gold(cap)}`;
    }
  }
  function confirmDiscard() {
    return !slots.length || window.confirm("Discard the current roster and start over?");
  }
  async function choosePackage(name) {
    if (name !== $("package").value && current && !confirmDiscard()) return;
    if (name !== $("package").value) {
      current = null;
      slots = [];
      staff = freshStaff();
      preview = null;
      selectedSkillPack = null;
      currentSave = null;
      editingTeamId = null;
      $("race").value = "";
    }
    $("package").value = name;
    setupStep = 1;
    renderSetup();
    await Promise.all([loadPackageRules(), loadInducements()]);
  }
  function chooseRace(rosterId) {
    if (current?.rosterId === rosterId) {
      setupStep = 3;
      renderAll();
      renderSetup();
      return;
    }
    if (current && !confirmDiscard()) return;
    $("race").value = rosterId;
    currentSave = null;
    editingTeamId = null;
    setupStep = 3;
    selectRoster(rosterId);
    renderSetup();
  }
  function goToStep(step) {
    if (step === 2 && !$("package").value) return;
    if (step === 3 && !current) return;
    setupStep = step;
    renderAll();
    renderSetup();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (TOURNAMENT_PAGE) {
    $("tt-steps").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tt-step]");
      if (button && !button.disabled) goToStep(Number(button.dataset.ttStep));
    });
    $("tt-packages").addEventListener("click", (event) => {
      const card = event.target.closest("[data-tt-package]");
      if (card) choosePackage(card.dataset.ttPackage);
    });
    $("tt-to-races").addEventListener("click", () => goToStep(2));
    $("tt-back-package").addEventListener("click", () => goToStep(1));
    $("tt-races").addEventListener("click", (event) => {
      const card = event.target.closest("[data-tt-race]");
      if (card) chooseRace(card.dataset.ttRace);
    });
    $("tt-change-package").addEventListener("click", () => goToStep(1));
    $("tt-change-race").addEventListener("click", () => goToStep(2));
  }

  // ════════════════ boot + events ════════════════
  async function boot() {
    renderAll();
    try {
      const [{ rosters: rosterRows }, { users }, packageRows] = await Promise.all([
        api("/api/fork/rosters"),
        api("/api/fork/users").catch(() => ({ users: [] })),
        api("/api/packages").catch(() => []),
      ]);
      rosters = (Array.isArray(rosterRows) ? rosterRows : []).map(sanitizeRoster);
      const list = Array.isArray(packageRows) ? packageRows : Array.isArray(packageRows?.packages) ? packageRows.packages : [];
      packages = list.filter((row) => typeof row?.name === "string");
      $("package").innerHTML = packages.length
        ? packages.map((row) => `<option value="${esc(row.name)}">${esc(row.name)}</option>`).join("")
        : '<option value="">No tournament packages are saved yet</option>';
      $("race").innerHTML = '<option value="">Choose a roster</option>'
        + rosters.map((roster) => `<option value="${esc(roster.rosterId)}">${esc(roster.raceName)}</option>`).join("");
      $("coach-list").innerHTML = (users ?? []).map((user) => `<option value="${esc(user.fumbblName)}"></option>`).join("");
      if (!rosters.length) {
        $("race").innerHTML = '<option value="">No base rosters installed on the fork</option>';
        setStatus("No BB2025 roster data is available.");
      }
      ensureSkillCatalog().then(() => { renderPositions(); renderRoster(); });
      const params = new URLSearchParams(location.search);
      const preset = params.get("preset") ?? params.get("package");
      const requestedMode = params.get("mode");
      if (TOURNAMENT_PAGE) {
        // Deep links: ?package=<name>[&race=<rosterId>] skip straight to the matching step.
        $("package").value = "";
        renderAll();
        renderSetup();
        if (preset && packages.some((row) => row.name === preset)) {
          await choosePackage(preset);
          const race = params.get("race");
          if (race && rosters.some((roster) => roster.rosterId === race)) chooseRace(race);
          else if (params.has("race") || params.get("step") === "2") goToStep(2);
        }
      } else if (preset && packages.some((row) => row.name === preset)) {
        $("package").value = preset;
        await selectMode("tournament");
      } else if (["create", "custom", "tournament", "library"].includes(requestedMode)) {
        await selectMode(requestedMode);
      } else {
        renderAll();
      }
    } catch (error) {
      $("race").innerHTML = '<option value="">Rosters unavailable</option>';
      setStatus(`Couldn't load rosters: ${error.message}`, true);
    }
  }

  $("race").addEventListener("change", () => selectRoster($("race").value));
  $("package").addEventListener("change", async () => {
    selectedSkillPack = null;
    preview = null;
    await Promise.all([loadPackageRules(), loadInducements()]);
    schedulePreview();
  });
  $("league").addEventListener("change", () => selectLeague($("league").value));
  $("team-name").addEventListener("input", () => {
    $("name-gate-toast").hidden = true;
    renderPositions();
    renderStars();
    schedulePreview();
  });
  $("coach").addEventListener("input", () => {
    $("current-coach-label").textContent = $("coach").value.trim() || "Choose an existing fork account below";
    schedulePreview();
  });
  document.querySelector(".mode-grid")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (button && button.dataset.mode !== mode) selectMode(button.dataset.mode);
  });
  $("ruleset-panel").addEventListener("click", (event) => {
    const pack = event.target.closest("[data-skill-pack]");
    if (pack) {
      selectedSkillPack = selectedSkillPack === pack.dataset.skillPack ? null : pack.dataset.skillPack;
      renderRulesetPanel();
      renderValueCard();
      schedulePreview();
      return;
    }
    if (event.target.closest("[data-tier-table]")) {
      tierTableOpen = !tierTableOpen;
      renderRulesetPanel();
    }
  });
  $("positions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-position]");
    if (!button) return;
    if (!$("team-name").value.trim()) { showNameGate(); return; }
    addPosition(button.dataset.addPosition);
  });
  // Disabled position cards swallow clicks; surface the name gate from the grid itself.
  $("positions").addEventListener("pointerdown", (event) => {
    if (event.target.closest(".name-required") && !$("team-name").value.trim()) showNameGate();
  });
  $("roster-slots").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-slot]");
    if (remove) return removeSlot(Number(remove.dataset.removeSlot));
    const skill = event.target.closest("[data-remove-skill]");
    if (skill) return removeSkill(Number(skill.dataset.removeSkill), skill.dataset.skill);
    const stat = event.target.closest("[data-remove-stat]");
    if (stat) {
      const slot = slots[Number(stat.dataset.removeStat)];
      if (slot) slot.chosenStatIncreases = slot.chosenStatIncreases.filter((s) => s !== stat.dataset.stat);
      return changed({ positions: false });
    }
    const picker = event.target.closest("[data-skill-slot]");
    if (picker) openSkillPicker(Number(picker.dataset.skillSlot));
  });
  $("roster-slots").addEventListener("change", (event) => {
    const select = event.target.closest("[data-stat-slot]");
    if (select) setStatIncrease(Number(select.dataset.statSlot), select.value);
  });
  $("skill-picker").addEventListener("click", (event) => {
    if (event.target.closest("#skill-picker-close")) {
      skillPickerIndex = null;
      renderRoster();
      renderSkillPicker();
      return;
    }
    const blade = event.target.closest("[data-blade]");
    if (blade) {
      pickerCategory = blade.dataset.blade;
      renderSkillPicker();
      return;
    }
    const unpick = event.target.closest("[data-unpick-skill]");
    if (unpick) return removeSkill(skillPickerIndex, unpick.dataset.unpickSkill);
    const pick = event.target.closest("[data-pick-skill]");
    if (pick && !pick.disabled) addSkill(pick.dataset.pickSkill);
  });
  $("star-list").addEventListener("click", (event) => {
    const add = event.target.closest("[data-star-add]");
    if (add) return addStarChoice(add.dataset.starAdd);
    const remove = event.target.closest("[data-star-remove]");
    if (remove) removeStarChoice(remove.dataset.starRemove);
  });
  $("star-sp-toggle").addEventListener("click", () => { starSpOpen = !starSpOpen; renderStars(); });
  $("inducement-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-inducement]");
    if (button) stepInducement(button.dataset.inducement, Number(button.dataset.delta));
  });
  $("staff-controls").addEventListener("click", (event) => {
    const button = event.target.closest("[data-staff-key]");
    if (button) stepStaff(button.dataset.staffKey, Number(button.dataset.staffDelta));
  });
  $("build-form").addEventListener("submit", buildTeam);
  $("print-sheet").addEventListener("click", printSheet);
  $("download-sheet").addEventListener("click", downloadSheet);
  $("login-form").addEventListener("submit", login);
  $("logout-button").addEventListener("click", logout);
  $("save-button").addEventListener("click", () => saveTeam(false));
  $("save-as-button").addEventListener("click", () => saveTeam(true));
  $("saves-toggle").addEventListener("click", () => { savesOpen = !savesOpen; renderSaves(); if (savesOpen) loadSaves(); });
  $("saves-list").addEventListener("click", (event) => {
    const load = event.target.closest("[data-save-load]");
    if (load) return loadSave(load.dataset.saveLoad);
    const rename = event.target.closest("[data-save-rename]");
    if (rename) return renameSave(rename.dataset.saveRename);
    const del = event.target.closest("[data-save-delete]");
    if (del) deleteSave(del.dataset.saveDelete);
  });
  $("library-list")?.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-library-edit]");
    if (edit) editLibraryTeam(edit.dataset.libraryEdit);
  });

  (async () => {
    renderSession();
    await restoreSession();
    await boot();
  })();
})();
