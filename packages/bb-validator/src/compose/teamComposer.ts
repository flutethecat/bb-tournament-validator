/**
 * Team composer (V1) — picks + a fork roster XML → a legal validator `Roster` and a
 * fork-loadable team XML. PURE / browser-safe (no fs/net): the caller supplies the roster
 * XML string; this module only parses/emits strings and reads the injected dataset.
 *
 * Separation guard (Yularen ruling A): the fork-XML parse/emit here is fork-SHAPED; the
 * validator core stays generic. A future move to a standalone `@bb/team-composer` package
 * should be a folder move, not a refactor — keep all fork-XML coupling inside this dir.
 *
 * Bridge note: the bundled dataset's position `id` is a SLUG (`snotling.snotling_lineman`),
 * NOT the numeric FUMBBL `positionId` (`66199`) the fork team XML needs — so the numeric
 * positionId + the fork `rosterId` (`snotling.bb2025`) are sourced from the roster XML on
 * disk (name-bridged to the dataset for stats/cost/legality via `validate()`).
 */

import type { Dataset } from "../dataset/types";
import {
  findPosition,
  findRoster,
  findStar,
  normName,
  skillAccess,
  starEligibleBySpecialRule,
} from "../dataset/lookup";
import type { Roster, RosterPlayer, Target } from "../model/roster";

/** A player position as read from a fork roster XML on disk (numeric positionId). */
export interface ForkRosterPosition {
  /** Numeric FUMBBL positionId, e.g. "66199" — what the team XML's <positionId> references. */
  positionId: string;
  name: string;
  gender: string;
  /** "Regular" | "Big Guy" | "Star". */
  type: string;
  /** True when the fork position is a roster-intrinsic Star player. */
  isStar: boolean;
  // ── Roster-intrinsic fields (present in the position XML block) ──
  // Used ONLY by the Secret League / dataset-free builder path (#52): SL races aren't in the
  // bb2025 dataset, but the roster XML is fully self-describing. The dataset path ignores these.
  /** Max copies allowed (<quantity>) — the per-position cap. */
  quantity?: number;
  /** Gold cost (<cost>). */
  cost?: number;
  MA?: number;
  ST?: number;
  /** Raw characteristic ints from the XML (<agility>/<passing>/<armour>); PA/AG=0 ⇒ none. */
  AG?: number;
  PA?: number;
  AV?: number;
  skills?: string[];
  /** Upstream FUMBBL image reference, e.g. `i/643472`. */
  urlPortrait?: string;
  /** Upstream FUMBBL sprite-sheet reference, e.g. `i/643392.png`. */
  urlIconSet?: string;
}

export interface ForkRoster {
  /** The <roster id> attr, e.g. "snotling.bb2025" — the team XML's <rosterId> + RosterCache key. */
  rosterId: string;
  /** The roster's own <name>, e.g. "Snotling". */
  raceName: string;
  reRollCost: number;
  maxReRolls: number;
  apothecaryAllowed: boolean;
  /** Roster-intrinsic (SL) cap on total "Big Guy"-type players (<maxBigGuys>); undefined ⇒ no roster cap. */
  maxBigGuys?: number;
  /** Positions in roster order, including roster-intrinsic Stars. */
  positions: ForkRosterPosition[];
}

export interface TeamPick {
  positionId: string;
  count: number;
  /** Custom-mode characteristic overrides for each player in this pick. */
  chosenStats?: { MA?: number; ST?: number; AG?: number; PA?: number; AV?: number };
  /**
   * Tournament builder (owner 08-04): extra skills chosen for EACH of the `count` players in this pick.
   * ROSTER-LEGAL only — every entry must be `primary`/`secondary` access for the position (see
   * {@link skillAccess}); traits, unknowns, and skills the position already prints are rejected. To give
   * two players of the same position DIFFERENT skills, emit two `count:1` picks. Ignored by the SL path.
   */
  chosenSkills?: string[];
}

export interface ComposeInput {
  /** The fork roster XML on disk for the chosen race. */
  forkRosterXml: string;
  coach: string;
  teamName: string;
  picks: TeamPick[];
  reRolls: number;
  apothecary: boolean;
  cheerleaders?: number;
  assistantCoaches?: number;
  dedicatedFans?: number;
  /** One chosen value from the race's special-rules menu. */
  specialRule?: string;
  /** Custom UAT mode (owner 08-04): apply ANY chosen skill/trait as-is — bypass the roster-legal check. */
  custom?: boolean;
}

export interface ComposeResult {
  teamId: string;
  /** Fork-loadable team XML — write to teams/, then /admin/refresh. */
  xml: string;
  /** Validator model — run validate(roster, pkg, dataset) at the edge (never trust the client). */
  roster: Roster;
}

const numTag = (xml: string, tag: string): number | undefined => {
  const m = xml.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, "i"));
  return m ? Number(m[1]) : undefined;
};
const strTag = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"))?.[1]?.trim();
const strTagWithAttributes = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, "i"))?.[1]?.trim();

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "x";

/**
 * Parse a fork roster XML into the fields the composer needs. The roster's own header
 * (id/name/reroll/apothecary) sits before the first `<position>`; each `<position>` block
 * carries the numeric id + name + gender + type.
 */
/**
 * Read the SR-258 custom marker back out of a composed team's XML — the ENFORCEMENT hook for the
 * submit path. A custom team's exported XML must re-validate as custom, or a gated tournament would
 * accept its free skills/stats. There is no team-XML→Roster parser today (validate() only runs on the
 * in-memory composed roster), so any future team-submit parser MUST set `roster.custom` via this.
 */
export function teamCustomFromXml(xml: string): boolean {
  return /<custom>\s*true\s*<\/custom>/i.test(xml);
}

export function parseForkRoster(xml: string): ForkRoster {
  const header = xml.split(/<position\b/i)[0] ?? xml;
  // Base bb2025 rosters carry <roster id="snotling.bb2025">; Secret League / imported rosters carry
  // <roster team="1064979"> instead (no id attr) — fall back to the team id so SL rosters have a key.
  const rosterId =
    xml.match(/<roster\b[^>]*\bid="([^"]+)"/i)?.[1] ??
    xml.match(/<roster\b[^>]*\bteam="([^"]+)"/i)?.[1] ??
    "";
  const raceName = strTag(header, "name") ?? "";
  const positions: ForkRosterPosition[] = [];
  for (const block of xml.match(/<position\b[\s\S]*?<\/position>/gi) ?? []) {
    const positionId = block.match(/<position\b[^>]*\bid="([^"]+)"/i)?.[1];
    if (!positionId) continue;
    const type = strTag(block, "type") ?? "Regular";
    // Skills live in <skillList><skill [value="n"]>Name</skill>…</skillList>.
    const skillList = block.match(/<skillList>([\s\S]*?)<\/skillList>/i)?.[1] ?? "";
    const skills = [...skillList.matchAll(/<skill\b[^>]*>([^<]+)<\/skill>/gi)].map((m) => m[1]!.trim());
    positions.push({
      positionId,
      name: strTag(block, "name") ?? "",
      gender: strTag(block, "gender") ?? "random",
      type,
      isStar: /star/i.test(type),
      // Roster-intrinsic (SL builder path); the dataset path ignores these.
      quantity: numTag(block, "quantity"),
      cost: numTag(block, "cost"),
      MA: numTag(block, "movement"),
      ST: numTag(block, "strength"),
      AG: numTag(block, "agility"),
      PA: numTag(block, "passing"),
      AV: numTag(block, "armour"),
      skills,
      urlPortrait: strTag(block, "portrait"),
      urlIconSet: strTagWithAttributes(block, "iconSet"),
    });
  }
  return {
    rosterId,
    raceName,
    reRollCost: numTag(header, "reRollCost") ?? 0,
    maxReRolls: numTag(header, "maxReRolls") ?? 8,
    apothecaryAllowed: /<apothecary>\s*true\s*<\/apothecary>/i.test(header),
    maxBigGuys: numTag(header, "maxBigGuys"),
    positions,
  };
}

/** A pickable position for the builder UI: the fork's numeric id + the dataset's stats/cost/cap. */
export interface RosterOption {
  positionId: string;
  name: string;
  cost: number;
  /** Max copies allowed (dataset `max`, e.g. 0-16 / 0-2). */
  max: number;
  MA: number;
  ST: number;
  AG: string;
  PA: string;
  AV: string;
  skills: string[];
  /** Present only for roster-intrinsic Star players. */
  isStar?: boolean;
  /** Direct upstream metadata; the client must allow-list before resolving. */
  urlPortrait?: string;
  /** Direct upstream metadata; the client renders the first sprite frame. */
  urlIconSet?: string;
}

export interface RosterOptions {
  rosterId: string;
  raceName: string;
  reRollCost: number;
  maxReRolls: number;
  apothecaryAllowed: boolean;
  positions: RosterOption[];
}

/**
 * The buildable positions for one race — the fork roster's numeric positionIds bridged to the
 * dataset (by name) for cost/cap/stats. Feeds the builder's picker. Positions the dataset can't
 * resolve by name are dropped, except Stars, whose blocks are self-describing.
 */
export function rosterOptions(forkRosterXml: string, data: Dataset): RosterOptions {
  const fork = parseForkRoster(forkRosterXml);
  const dsRoster = findRoster(data, fork.raceName);
  const positions: RosterOption[] = [];
  const plus = (n: number | undefined): string => (n && n > 0 ? `${n}+` : "-");
  for (const p of fork.positions) {
    // Roster-intrinsic Stars present in this XML are always eligible.
    // TODO(spec-B special-rule stars): requires a team-chosen special-rule value and an off-roster
    // star pool with a roster positionId; neither input exists in the current composer contract.
    if (p.isStar) {
      positions.push({
        positionId: p.positionId,
        name: p.name,
        cost: p.cost ?? 0,
        max: p.quantity ?? 1,
        MA: p.MA ?? 0,
        ST: p.ST ?? 0,
        AG: plus(p.AG),
        PA: plus(p.PA),
        AV: plus(p.AV),
        skills: [...(p.skills ?? [])],
        isStar: true,
        urlPortrait: p.urlPortrait,
        urlIconSet: p.urlIconSet,
      });
      continue;
    }
    const ds = dsRoster ? findPosition(dsRoster, p.name) : undefined;
    if (!ds) continue;
    positions.push({
      positionId: p.positionId,
      name: ds.name,
      cost: ds.cost,
      max: ds.max,
      MA: ds.MA,
      ST: ds.ST,
      AG: ds.AG,
      PA: ds.PA,
      AV: ds.AV,
      skills: [...ds.skills],
      urlPortrait: p.urlPortrait,
      urlIconSet: p.urlIconSet,
    });
  }
  return {
    rosterId: fork.rosterId,
    raceName: fork.raceName,
    reRollCost: fork.reRollCost,
    maxReRolls: fork.maxReRolls,
    apothecaryAllowed: fork.apothecaryAllowed,
    positions,
  };
}

/**
 * The buildable positions for a SECRET LEAGUE / custom race the bb2025 dataset does NOT carry (#52,
 * option A). Same shape as {@link rosterOptions}, but every field is sourced ROSTER-INTRINSICALLY from
 * the fork roster XML itself (cost/cap/stats/skills all present in each <position> block) — no dataset
 * lookup, so it scales to any SL roster with zero dataset edits. The dataset stays authoritative for the
 * 30 official races; this is the parallel path for the numeric-rosterId SL teams the dataset can't
 * resolve. AG/PA/AV are rendered `n+` (PA/AG=0 ⇒ "-", i.e. no passing / no agility roll offered).
 */
export function rosterOptionsIntrinsic(forkRosterXml: string): RosterOptions {
  const fork = parseForkRoster(forkRosterXml);
  const plus = (n: number | undefined): string => (n && n > 0 ? `${n}+` : "-");
  const positions: RosterOption[] = fork.positions.map((p) => ({
    positionId: p.positionId,
    name: p.name,
    cost: p.cost ?? 0,
    max: p.quantity ?? 0,
    MA: p.MA ?? 0,
    ST: p.ST ?? 0,
    AG: plus(p.AG),
    PA: plus(p.PA),
    AV: p.AV != null ? `${p.AV}+` : "-",
    skills: p.skills ?? [],
    ...(p.isStar ? { isStar: true } : {}),
    urlPortrait: p.urlPortrait,
    urlIconSet: p.urlIconSet,
  }));
  return {
    rosterId: fork.rosterId,
    raceName: fork.raceName,
    reRollCost: fork.reRollCost,
    maxReRolls: fork.maxReRolls,
    apothecaryAllowed: fork.apothecaryAllowed,
    positions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECRET LEAGUE / dataset-free compose path (#52, option A)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComposeIntrinsicInput extends ComposeInput {
  /**
   * TV budget cap in gold — the tournament/SL budget the TO configures (per Yularen's ruling: the
   * fixed 1000k baseline can't fit SL TVs, so the cap is a configurable input, not a constant). If
   * set, the composed team total must be ≤ budget. Omit ⇒ no budget check (build-only preview).
   */
  budget?: number;
}

/** One roster-intrinsic legality failure. `code` is stable for UI/edge handling; `message` is human-facing. */
export interface ComposeIssue {
  code: "roster_size" | "position_cap" | "reroll_cap" | "apothecary" | "big_guy_cap" | "budget";
  message: string;
}

export interface ComposeIntrinsicResult extends ComposeResult {
  /** Roster-intrinsic validation result — the edge MUST refuse to persist a team where `legal` is false. */
  legal: boolean;
  issues: ComposeIssue[];
}

/**
 * Compose a team from picks for a SECRET LEAGUE / custom race the bb2025 dataset does NOT carry (#52,
 * option A). Parallel to {@link composeTeam} but every stat/cost/cap is sourced ROSTER-INTRINSICALLY
 * from the fork roster XML — no dataset lookup, so it scales to any imported SL roster with zero dataset
 * edits. Because the dataset `validate()` core can't run for an off-dataset race, legality is enforced
 * HERE against the roster's own caps and the configured budget, and returned as structured `issues` +
 * a `legal` flag (the admission-guard the edge checks — a preview that shows an over-cap team must not
 * be persistable). Structurally-invalid picks (unknown positionId) still throw.
 */
export function composeTeamIntrinsic(input: ComposeIntrinsicInput, now = Date.now()): ComposeIntrinsicResult {
  const fork = parseForkRoster(input.forkRosterXml);
  const header = input.forkRosterXml.split(/<position\b/i)[0] ?? input.forkRosterXml;
  const specialRules = [...header.matchAll(/<rule>([^<]+)<\/rule>/gi)].map((m) => m[1]!.trim());
  const byId = new Map(fork.positions.map((p) => [p.positionId, p]));
  const plus = (n: number | undefined): Target => (n && n > 0 ? (`${n}+` as Target) : "-");
  const avTarget = (n: number | undefined): Target => (n != null ? (`${n}+` as Target) : "-");

  const teamId = mintTeamId(input.coach, fork.raceName, now);
  const players: RosterPlayer[] = [];
  const xmlPlayers: string[] = [];
  const perName = new Map<string, number>(); // display numbering per position name
  const perPosition = new Map<string, number>(); // positionId → total picked (for the cap check)
  let bigGuyCount = 0;

  for (const pick of input.picks) {
    const forkPos = byId.get(pick.positionId);
    if (!forkPos) throw new Error(`positionId "${pick.positionId}" is not in the ${fork.raceName} roster.`);
    const count = Math.max(0, pick.count | 0);
    perPosition.set(pick.positionId, (perPosition.get(pick.positionId) ?? 0) + count);
    for (let i = 0; i < count; i++) {
      const nr = players.length + 1;
      const idx = (perName.get(forkPos.name) ?? 0) + 1;
      perName.set(forkPos.name, idx);
      if (/big\s*guy/i.test(forkPos.type)) bigGuyCount++;
      players.push({
        number: nr,
        positionName: forkPos.name,
        MA: forkPos.MA ?? 0,
        ST: forkPos.ST ?? 0,
        AG: plus(forkPos.AG),
        PA: plus(forkPos.PA),
        AV: avTarget(forkPos.AV),
        skills: [...(forkPos.skills ?? [])],
        keywords: [],
        cost: forkPos.cost ?? 0,
      });
      const playerName = forkPos.isStar ? forkPos.name : `${forkPos.name} ${idx}`;
      xmlPlayers.push(
        `\t<player nr="${nr}" id="${teamId}${nr}"><name>${xmlEscape(playerName)}</name>` +
          `<gender>${xmlEscape(forkPos.gender)}</gender><positionId>${xmlEscape(pick.positionId)}</positionId>` +
          `<skillList></skillList></player>`,
      );
    }
  }

  const playersGold = players.reduce((s, p) => s + p.cost, 0);
  const staffGold =
    input.reRolls * fork.reRollCost +
    (input.apothecary ? 50000 : 0) +
    (input.assistantCoaches ?? 0) * 10000 +
    (input.cheerleaders ?? 0) * 10000 +
    Math.max(0, (input.dedicatedFans ?? 1) - 1) * 10000;
  const total = playersGold + staffGold;

  // Roster-intrinsic legality (the off-dataset admission guard). Standard team-size rule (11–16) plus
  // the roster's own caps (per-position <quantity>, <maxReRolls>, <apothecary>, <maxBigGuys>) and the
  // configured budget. Structured so the edge refuses a team the preview blessed but that busts a cap.
  const issues: ComposeIssue[] = [];
  if (players.length < 11) issues.push({ code: "roster_size", message: `Team has ${players.length} players; 11 is the minimum.` });
  if (players.length > 16) issues.push({ code: "roster_size", message: `Team has ${players.length} players; 16 is the maximum.` });
  for (const [pid, c] of perPosition) {
    const fp = byId.get(pid)!;
    const cap = fp.quantity ?? 0;
    if (c > cap) issues.push({ code: "position_cap", message: `${fp.name}: ${c} picked, roster max is ${cap}.` });
  }
  if (input.reRolls < 0 || input.reRolls > fork.maxReRolls)
    issues.push({ code: "reroll_cap", message: `${input.reRolls} re-rolls; roster allows 0–${fork.maxReRolls}.` });
  if (input.apothecary && !fork.apothecaryAllowed)
    issues.push({ code: "apothecary", message: `This roster does not allow an apothecary.` });
  if (fork.maxBigGuys != null && bigGuyCount > fork.maxBigGuys)
    issues.push({ code: "big_guy_cap", message: `${bigGuyCount} Big Guys picked; roster max is ${fork.maxBigGuys}.` });
  if (input.budget != null && total > input.budget)
    issues.push({ code: "budget", message: `Team value ${total} exceeds the ${input.budget} budget.` });

  const roster: Roster = {
    rosterName: fork.raceName,
    coach: input.coach,
    teamName: input.teamName,
    custom: input.custom === true,
    sideline: {
      apothecary: input.apothecary,
      assistantCoaches: input.assistantCoaches ?? 0,
      cheerleaders: input.cheerleaders ?? 0,
      dedicatedFans: input.dedicatedFans ?? 1,
      reRolls: input.reRolls,
    },
    inducements: [],
    leagues: [],
    specialRules,
    players,
    summary: { playersCost: playersGold, skillsCost: 0, inducementCost: 0, sidelineCost: staffGold, total },
  };

  const tvUnits = Math.round(total / 10000);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n\n<team id="${teamId}">\n\n` +
    `\t<coach>${xmlEscape(input.coach)}</coach>\n` +
    `\t<name>${xmlEscape(input.teamName)}</name>\n` +
    `\t<race>${xmlEscape(fork.raceName)}</race>\n` +
    `\t<rosterId>${xmlEscape(fork.rosterId)}</rosterId>\n` +
    `\t<reRolls>${input.reRolls}</reRolls>\n` +
    `\t<fanFactor>${input.dedicatedFans ?? 1}</fanFactor>\n` +
    `\t<apothecaries>${input.apothecary ? 1 : 0}</apothecaries>\n` +
    `\t<teamRating>${tvUnits}</teamRating>\n` +
    `\t<currentTeamValue>${tvUnits}</currentTeamValue>\n` +
    `\t<teamStrength>${tvUnits}</teamStrength>\n` +
    (input.custom ? `\t<custom>true</custom>\n` : "") +
    `\t<division>[X]</division>\n\n` +
    `\t<specialRules></specialRules>\n\n` +
    xmlPlayers.join("\n") +
    `\n\n</team>\n`;

  return { teamId, xml, roster, legal: issues.length === 0, issues };
}

/** Collision-proof team id in the reserved `tb_` namespace (string ⇒ never collides with numeric FUMBBL ids). */
export function mintTeamId(coach: string, raceName: string, now = Date.now()): string {
  return `tb_${slug(coach)}_${slug(raceName)}_${now.toString(36)}`;
}

/**
 * Compose a team from picks. Builds the validator `Roster` (stats/cost/skills from the
 * dataset, name-bridged) and emits the fork team XML (numeric positionId + rosterId from
 * the roster XML). Throws on an unknown pick or a race the dataset doesn't carry.
 */
/**
 * Tournament builder (owner 08-04): validate a pick's chosen extra skills against the dataset position
 * and return the accepted list (input order). ROSTER-LEGAL only — each skill must be `primary`/`secondary`
 * access for the position ({@link skillAccess}: its category ∈ the position's primary/secondary categories;
 * traits and unknowns are illegal), must not duplicate a skill the position already prints, and must not
 * repeat within the pick. Throws a CLIENT-SAFE error on the first violation (the config-web endpoint
 * surfaces the message); server-side authoritative — never trust the panel's own filtering.
 */
function resolveChosenSkills(
  data: Dataset,
  dsPos: NonNullable<ReturnType<typeof findPosition>>,
  chosen: string[] | undefined,
): string[] {
  if (!chosen || chosen.length === 0) return [];
  const printed = new Set(dsPos.skills.map(normName));
  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const raw of chosen) {
    const skill = raw.trim();
    if (!skill) continue;
    const key = normName(skill);
    if (printed.has(key)) throw new Error(`${dsPos.name} already has "${skill}".`);
    if (seen.has(key)) throw new Error(`Duplicate chosen skill "${skill}" on ${dsPos.name}.`);
    if (skillAccess(data, dsPos, skill) === "illegal")
      throw new Error(
        `"${skill}" is not a legal skill for ${dsPos.name} — pick one of its primary or secondary skills (traits and off-category skills aren't allowed).`,
      );
    seen.add(key);
    accepted.push(skill);
  }
  return accepted;
}

export function composeTeam(input: ComposeInput, data: Dataset, now = Date.now()): ComposeResult {
  const fork = parseForkRoster(input.forkRosterXml);
  const dsRoster = findRoster(data, fork.raceName);
  if (!dsRoster) throw new Error(`Race "${fork.raceName}" is not in the BB2025 dataset.`);
  const requestedSpecialRule = input.specialRule?.trim() || undefined;
  const specialRule = requestedSpecialRule
    ? dsRoster.specialRules.find((rule) => normName(rule) === normName(requestedSpecialRule))
    : undefined;
  if (requestedSpecialRule && !specialRule)
    throw new Error(`Special rule "${requestedSpecialRule}" is not available to ${dsRoster.name}.`);
  const byId = new Map(fork.positions.map((p) => [p.positionId, p]));

  const teamId = mintTeamId(input.coach, fork.raceName, now);
  const players: RosterPlayer[] = [];
  const xmlPlayers: string[] = [];
  const perPosition = new Map<string, number>();
  const plus = (n: number | undefined): Target => (n && n > 0 ? (`${n}+` as Target) : "-");
  const avTarget = (n: number | undefined): Target => (n != null ? (`${n}+` as Target) : "-");

  for (const pick of input.picks) {
    const forkPos = byId.get(pick.positionId);
    if (!forkPos) throw new Error(`positionId "${pick.positionId}" is not in the ${fork.raceName} roster.`);
    if (forkPos.isStar) {
      const star = findStar(data, forkPos.name);
      if (specialRule && star && !starEligibleBySpecialRule(star, specialRule))
        throw new Error(`Star player ${forkPos.name} is not eligible under ${specialRule}.`);
      if (pick.chosenSkills && pick.chosenSkills.length > 0)
        throw new Error(`Star player ${forkPos.name} cannot take chosen skills.`);
      const count = Math.max(0, pick.count | 0);
      const previousCount = perPosition.get(forkPos.name) ?? 0;
      const cap = forkPos.quantity ?? 1;
      if (previousCount + count > cap)
        throw new Error(`Star player ${forkPos.name} exceeds roster max ${cap}.`);
      for (let i = 0; i < count; i++) {
        const nr = players.length + 1;
        perPosition.set(forkPos.name, previousCount + i + 1);
        players.push({
          number: nr,
          positionName: forkPos.name,
          MA: forkPos.MA ?? 0,
          ST: forkPos.ST ?? 0,
          AG: plus(forkPos.AG),
          PA: plus(forkPos.PA),
          AV: avTarget(forkPos.AV),
          skills: [...(forkPos.skills ?? [])],
          keywords: [],
          cost: forkPos.cost ?? 0,
        });
        xmlPlayers.push(
          `\t<player nr="${nr}" id="${teamId}${nr}"><name>${xmlEscape(forkPos.name)}</name>` +
            `<gender>${xmlEscape(forkPos.gender)}</gender><positionId>${xmlEscape(pick.positionId)}</positionId>` +
            `<skillList></skillList></player>`,
        );
      }
      continue;
    }
    const dsPos = findPosition(dsRoster, forkPos.name);
    if (!dsPos) throw new Error(`Position "${forkPos.name}" is not in the ${fork.raceName} dataset roster.`);
    // Tournament builder: roster-legal chosen skills for this pick, applied to each of its `count` copies.
    // Custom UAT mode (owner 08-04): apply ANY chosen skill/trait as-is — no roster-legal check.
    const chosenSkills = input.custom
      ? (pick.chosenSkills ?? []).map((s) => s.trim()).filter(Boolean)
      : resolveChosenSkills(data, dsPos, pick.chosenSkills);
    const chosenSkillXml = chosenSkills.map((s) => `<skill>${xmlEscape(s)}</skill>`).join("");
    const chosenStats = input.custom === true ? pick.chosenStats : undefined;
    const chosenStatXml = chosenStats
      ? [
          chosenStats.MA !== undefined ? `<movement>${chosenStats.MA}</movement>` : "",
          chosenStats.ST !== undefined ? `<strength>${chosenStats.ST}</strength>` : "",
          chosenStats.AG !== undefined ? `<agility>${chosenStats.AG}</agility>` : "",
          chosenStats.PA !== undefined ? `<passing>${chosenStats.PA}</passing>` : "",
          chosenStats.AV !== undefined ? `<armour>${chosenStats.AV}</armour>` : "",
        ].join("")
      : "";
    for (let i = 0; i < Math.max(0, pick.count | 0); i++) {
      const nr = players.length + 1;
      const idx = (perPosition.get(dsPos.name) ?? 0) + 1;
      perPosition.set(dsPos.name, idx);
      players.push({
        number: nr,
        positionName: dsPos.name,
        MA: chosenStats?.MA ?? dsPos.MA,
        ST: chosenStats?.ST ?? dsPos.ST,
        AG: chosenStats?.AG !== undefined ? plus(chosenStats.AG) : dsPos.AG,
        PA: chosenStats?.PA !== undefined ? plus(chosenStats.PA) : dsPos.PA,
        AV: chosenStats?.AV !== undefined ? avTarget(chosenStats.AV) : dsPos.AV,
        skills: [...dsPos.skills, ...chosenSkills],
        keywords: [...dsPos.keywords],
        cost: dsPos.cost,
      });
      const playerName = `${dsPos.name} ${idx}`;
      xmlPlayers.push(
        `\t<player nr="${nr}" id="${teamId}${nr}"><name>${xmlEscape(playerName)}</name>` +
          `<gender>${xmlEscape(forkPos.gender)}</gender><positionId>${xmlEscape(pick.positionId)}</positionId>` +
          `${chosenStatXml}<skillList>${chosenSkillXml}</skillList></player>`,
      );
    }
  }

  const sideline = {
    apothecary: input.apothecary,
    assistantCoaches: input.assistantCoaches ?? 0,
    cheerleaders: input.cheerleaders ?? 0,
    dedicatedFans: input.dedicatedFans ?? 1,
    reRolls: input.reRolls,
  };
  // Team-value line items. sidelineCost (re-rolls at the roster-specific reRollCost, apothecary,
  // coaches, cheerleaders, extra dedicated fans) MUST live on roster.summary: recomputeGold() reads
  // summary.sidelineCost, so a composed team without it under-counts by the whole staff cost — both
  // the preview total AND the over-budget guard (goldBudget) then silently omit sideline staff
  // (owner playtest P3: a 955k team previewed under-budget). The reRoll cost is roster-specific, so
  // this is the only place that can compute it — the validator can't derive it from roster.sideline.
  const playersGold = players.reduce((s, p) => s + p.cost, 0);
  const staffGold =
    input.reRolls * fork.reRollCost +
    (input.apothecary ? 50000 : 0) +
    (input.assistantCoaches ?? 0) * 10000 +
    (input.cheerleaders ?? 0) * 10000 +
    Math.max(0, (input.dedicatedFans ?? 1) - 1) * 10000;

  const roster: Roster = {
    rosterName: dsRoster.name,
    coach: input.coach,
    teamName: input.teamName,
    custom: input.custom === true,
    sideline,
    inducements: [],
    leagues: [],
    specialRules: specialRule ? [specialRule] : [...dsRoster.specialRules],
    players,
    summary: {
      playersCost: playersGold,
      skillsCost: 0,
      inducementCost: 0,
      sidelineCost: staffGold,
      total: playersGold + staffGold,
    },
  };

  // Advisory team value for the XML header (the server recomputes from positions on load;
  // fork-native hand-authored teams carry TV in units of 10k — 1000k ⇒ ~100). Round-trip
  // test confirms the server accepts/recomputes this.
  const tvUnits = Math.round((playersGold + staffGold) / 10000);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n\n<team id="${teamId}">\n\n` +
    `\t<coach>${xmlEscape(input.coach)}</coach>\n` +
    `\t<name>${xmlEscape(input.teamName)}</name>\n` +
    `\t<race>${xmlEscape(fork.raceName)}</race>\n` +
    `\t<rosterId>${xmlEscape(fork.rosterId)}</rosterId>\n` +
    `\t<reRolls>${input.reRolls}</reRolls>\n` +
    `\t<fanFactor>${input.dedicatedFans ?? 1}</fanFactor>\n` +
    `\t<apothecaries>${input.apothecary ? 1 : 0}</apothecaries>\n` +
    `\t<teamRating>${tvUnits}</teamRating>\n` +
    `\t<currentTeamValue>${tvUnits}</currentTeamValue>\n` +
    `\t<teamStrength>${tvUnits}</teamStrength>\n` +
    (input.custom ? `\t<custom>true</custom>\n` : "") +
    `\t<division>[X]</division>\n\n` +
    `\t<specialRules></specialRules>\n\n` +
    xmlPlayers.join("\n") +
    `\n\n</team>\n`;

  return { teamId, xml, roster };
}
