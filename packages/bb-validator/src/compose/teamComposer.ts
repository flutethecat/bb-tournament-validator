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
import { findPosition, findRoster, normName } from "../dataset/lookup";
import type { Roster, RosterPlayer } from "../model/roster";

/** A player position as read from a fork roster XML on disk (numeric positionId). */
export interface ForkRosterPosition {
  /** Numeric FUMBBL positionId, e.g. "66199" — what the team XML's <positionId> references. */
  positionId: string;
  name: string;
  gender: string;
  /** "Regular" | "Big Guy" | "Star" — Stars are excluded from V1 team-building. */
  type: string;
}

export interface ForkRoster {
  /** The <roster id> attr, e.g. "snotling.bb2025" — the team XML's <rosterId> + RosterCache key. */
  rosterId: string;
  /** The roster's own <name>, e.g. "Snotling". */
  raceName: string;
  reRollCost: number;
  maxReRolls: number;
  apothecaryAllowed: boolean;
  /** Non-star positions only (id-keyed elsewhere; order preserved for the picker UI). */
  positions: ForkRosterPosition[];
}

export interface TeamPick {
  positionId: string;
  count: number;
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

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "x";

/**
 * Parse a fork roster XML into the fields the composer needs. The roster's own header
 * (id/name/reroll/apothecary) sits before the first `<position>`; each `<position>` block
 * carries the numeric id + name + gender + type. Star positions are dropped (out of V1).
 */
export function parseForkRoster(xml: string): ForkRoster {
  const header = xml.split(/<position\b/i)[0] ?? xml;
  const rosterId = xml.match(/<roster\b[^>]*\bid="([^"]+)"/i)?.[1] ?? "";
  const raceName = strTag(header, "name") ?? "";
  const positions: ForkRosterPosition[] = [];
  for (const block of xml.match(/<position\b[\s\S]*?<\/position>/gi) ?? []) {
    const positionId = block.match(/<position\b[^>]*\bid="([^"]+)"/i)?.[1];
    if (!positionId) continue;
    const type = strTag(block, "type") ?? "Regular";
    if (/star/i.test(type)) continue; // V1: base positions only, no stars
    positions.push({
      positionId,
      name: strTag(block, "name") ?? "",
      gender: strTag(block, "gender") ?? "random",
      type,
    });
  }
  return {
    rosterId,
    raceName,
    reRollCost: numTag(header, "reRollCost") ?? 0,
    maxReRolls: numTag(header, "maxReRolls") ?? 8,
    apothecaryAllowed: /<apothecary>\s*true\s*<\/apothecary>/i.test(header),
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
 * resolve by name are dropped (defensive; the on-disk 30 all resolve).
 */
export function rosterOptions(forkRosterXml: string, data: Dataset): RosterOptions {
  const fork = parseForkRoster(forkRosterXml);
  const dsRoster = findRoster(data, fork.raceName);
  const positions: RosterOption[] = [];
  for (const p of fork.positions) {
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

/** Collision-proof team id in the reserved `tb_` namespace (string ⇒ never collides with numeric FUMBBL ids). */
export function mintTeamId(coach: string, raceName: string, now = Date.now()): string {
  return `tb_${slug(coach)}_${slug(raceName)}_${now.toString(36)}`;
}

/**
 * Compose a team from picks. Builds the validator `Roster` (stats/cost/skills from the
 * dataset, name-bridged) and emits the fork team XML (numeric positionId + rosterId from
 * the roster XML). Throws on an unknown pick or a race the dataset doesn't carry.
 */
export function composeTeam(input: ComposeInput, data: Dataset, now = Date.now()): ComposeResult {
  const fork = parseForkRoster(input.forkRosterXml);
  const dsRoster = findRoster(data, fork.raceName);
  if (!dsRoster) throw new Error(`Race "${fork.raceName}" is not in the BB2025 dataset.`);
  const byId = new Map(fork.positions.map((p) => [p.positionId, p]));

  const teamId = mintTeamId(input.coach, fork.raceName, now);
  const players: RosterPlayer[] = [];
  const xmlPlayers: string[] = [];
  const perPosition = new Map<string, number>();

  for (const pick of input.picks) {
    const forkPos = byId.get(pick.positionId);
    if (!forkPos) throw new Error(`positionId "${pick.positionId}" is not in the ${fork.raceName} roster (or is a Star).`);
    const dsPos = findPosition(dsRoster, forkPos.name);
    if (!dsPos) throw new Error(`Position "${forkPos.name}" is not in the ${fork.raceName} dataset roster.`);
    for (let i = 0; i < Math.max(0, pick.count | 0); i++) {
      const nr = players.length + 1;
      const idx = (perPosition.get(dsPos.name) ?? 0) + 1;
      perPosition.set(dsPos.name, idx);
      players.push({
        number: nr,
        positionName: dsPos.name,
        MA: dsPos.MA,
        ST: dsPos.ST,
        AG: dsPos.AG,
        PA: dsPos.PA,
        AV: dsPos.AV,
        skills: [...dsPos.skills],
        keywords: [...dsPos.keywords],
        cost: dsPos.cost,
      });
      const playerName = `${dsPos.name} ${idx}`;
      xmlPlayers.push(
        `\t<player nr="${nr}" id="${teamId}${nr}"><name>${xmlEscape(playerName)}</name>` +
          `<gender>${xmlEscape(forkPos.gender)}</gender><positionId>${xmlEscape(pick.positionId)}</positionId>` +
          `<skillList></skillList></player>`,
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
  const roster: Roster = {
    rosterName: dsRoster.name,
    coach: input.coach,
    teamName: input.teamName,
    sideline,
    inducements: [],
    leagues: [],
    specialRules: [...dsRoster.specialRules],
    players,
  };

  // Advisory team value for the XML header (the server recomputes from positions on load;
  // fork-native hand-authored teams carry TV in units of 10k — 1000k ⇒ ~100). Round-trip
  // test confirms the server accepts/recomputes this.
  const playersGold = players.reduce((s, p) => s + p.cost, 0);
  const staffGold =
    input.reRolls * fork.reRollCost +
    (input.apothecary ? 50000 : 0) +
    (input.assistantCoaches ?? 0) * 10000 +
    (input.cheerleaders ?? 0) * 10000 +
    Math.max(0, (input.dedicatedFans ?? 1) - 1) * 10000;
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
    `\t<division>[X]</division>\n\n` +
    `\t<specialRules></specialRules>\n\n` +
    xmlPlayers.join("\n") +
    `\n\n</team>\n`;

  return { teamId, xml, roster };
}
