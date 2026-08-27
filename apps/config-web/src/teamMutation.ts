import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  acknowledgeRestoredTeamXmlTransaction,
  acquireTeamNameWriteLock,
  acquireTeamWriteLock,
  atomicWriteTextFile,
  beginTeamXmlTransaction,
  commitTeamXmlTransaction,
  libraryCoaches,
  parseTeamXmlMeta,
  readLibrary,
  restoreTeamXmlTransaction,
  upsertLibraryTeam,
  type LibraryTeam,
  type ReloadResult,
} from "@bb/fork-ops";
import { coachNamesEqual, storedTeamCoach, storedTeamFile } from "./teamDetail.js";
import { playerProgression } from "./teamAdvancement.js";

export type TeamMutationOperation =
  | "renumber"
  | "addReroll"
  | "removeReroll"
  | "discardReroll"
  | "addAssistantCoach"
  | "fireAssistantCoach"
  | "addCheerleader"
  | "fireCheerleader"
  | "addApothecary"
  | "fireApothecary"
  | "changeDedicatedFans"
  | "rename"
  | "addPlayer"
  | "firePlayer"
  | "retirePlayer"
  | "temporaryRetirePlayer"
  | "undoTemporaryRetire"
  | "rehirePlayer"
  | "refundPlayer"
  | "setResurrection"
  | "ready"
  | "unready";

const MUTATION_OPERATIONS = new Set<TeamMutationOperation>([
  "renumber",
  "addReroll",
  "removeReroll",
  "discardReroll",
  "addAssistantCoach",
  "fireAssistantCoach",
  "addCheerleader",
  "fireCheerleader",
  "addApothecary",
  "fireApothecary",
  "changeDedicatedFans",
  "rename",
  "addPlayer",
  "firePlayer",
  "retirePlayer",
  "temporaryRetirePlayer",
  "undoTemporaryRetire",
  "rehirePlayer",
  "refundPlayer",
  "setResurrection",
  "ready",
  "unready",
]);

export interface TeamMutationIdentity {
  coach?: string;
  admin: boolean;
}

export interface TeamMutationDeps {
  libraryDir: string;
  teamsDir?: string;
  now?: () => number;
  reload?: () => Promise<ReloadResult>;
  duplicateNameError: (name: string, excludeTeamId?: string) => string | undefined;
}

export type TeamMutationResult =
  | { status: 200; body: { ok: true; teamId: string; reload: ReloadResult } & Record<string, unknown> }
  | { status: 400 | 401 | 404 | 409 | 500 | 503; body: { error: string } };

export type TeamCheckNameResult =
  | { status: 200; body: { ok: true } | { ok: false; error: string } }
  | { status: 400; body: { error: string } };

type JsonObject = Record<string, unknown>;

class EndpointFailure extends Error {
  constructor(readonly status: 400 | 401 | 404 | 409 | 500 | 503, message: string) {
    super(message);
  }
}

const fail = (status: EndpointFailure["status"], message: string): never => {
  throw new EndpointFailure(status, message);
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: JsonObject, expected: readonly string[]): boolean => {
  const wanted = new Set(expected);
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => wanted.has(key));
};

const decodeXml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const encodeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const attr = (scope: string, name: string): string | undefined =>
  scope.match(new RegExp(`\\b${escapeRe(name)}="([^"]*)"`, "i"))?.[1];

const element = (scope: string, tag: string): string | undefined => {
  const matches = [...scope.matchAll(new RegExp(`<${escapeRe(tag)}\\b[^>]*>([^<]*)</${escapeRe(tag)}>`, "gi"))];
  if (matches.length !== 1) return undefined;
  return decodeXml(matches[0]![1]!).trim();
};

function teamIdFromBody(value: unknown): string {
  if (typeof value === "string") {
    const teamId = value.trim();
    if (teamId && teamId.length <= 128) return teamId;
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return fail(400, "teamId must be a non-empty string or non-negative integer.");
}

function setTeamResurrection(xml: string, resurrection: boolean): string {
  const opening = xml.match(/<team\b[^>]*>/i)?.[0];
  if (!opening) return fail(500, "Stored team XML has no root team element.");
  let updated = opening;
  if (resurrection) {
    // Upstream ffb-common Team.startXmlElement for XML_TAG "team" reads only the id attribute;
    // unknown root attributes are ignored (ffb-common/src/main/java/com/fumbbl/ffb/model/Team.java).
    updated = /\bresurrection="[^"]*"/i.test(opening)
      ? opening.replace(/\bresurrection="[^"]*"/i, 'resurrection="true"')
      : opening.replace(/>$/, ' resurrection="true">');
  } else {
    updated = opening.replace(/\s+resurrection="[^"]*"/gi, "");
  }
  return updated === opening ? xml : xml.replace(opening, updated);
}

/**
 * Local config-web naming law is deliberately only trimmed non-empty plus uniqueness.
 * The 100-character ceiling is a defensive input sanity bound, not a Blood Bowl/FUMBBL rule.
 * Profanity filtering is intentionally omitted: this private fork has no configured list or service.
 */
export function teamNameValidationError(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return "Team name must not be empty.";
  if (value.trim().length > 100) return "Team name must be at most 100 characters.";
  return undefined;
}

export function teamMutationOperation(pathname: string): TeamMutationOperation | undefined {
  const operation = pathname.match(/^\/api\/team\/([^/]+)$/)?.[1] as TeamMutationOperation | undefined;
  return operation && MUTATION_OPERATIONS.has(operation) ? operation : undefined;
}

export function isTeamMutationWritePath(pathname: string): boolean {
  return teamMutationOperation(pathname) !== undefined;
}

export function teamCheckNameEndpoint(
  rawBody: unknown,
  duplicateNameError: (name: string, excludeTeamId?: string) => string | undefined,
): TeamCheckNameResult {
  if (!isRecord(rawBody) || !hasExactKeys(rawBody, ["name"])) {
    return { status: 400, body: { error: "checkName requires exactly {name}." } };
  }
  const validityError = teamNameValidationError(rawBody.name);
  if (validityError) return { status: 200, body: { ok: false, error: validityError } };
  const duplicateError = duplicateNameError((rawBody.name as string).trim());
  return duplicateError
    ? { status: 200, body: { ok: false, error: duplicateError } }
    : { status: 200, body: { ok: true } };
}

interface LibraryTarget {
  coachKey: string;
  team: LibraryTeam;
}

function libraryTarget(auth: TeamMutationIdentity, libraryDir: string, teamId: string): LibraryTarget | undefined {
  if (!auth.admin) {
    const coach = auth.coach?.trim();
    if (!coach) return undefined;
    const team = readLibrary(libraryDir, coach).find((entry) => entry.teamId === teamId);
    return team && coachNamesEqual(team.coach, coach) ? { coachKey: coach, team } : undefined;
  }

  const matches = libraryCoaches(libraryDir).flatMap((coachKey) =>
    readLibrary(libraryDir, coachKey)
      .filter((entry) => entry.teamId === teamId)
      .map((team) => ({ coachKey, team })),
  );
  if (matches.length > 1) fail(500, `Team ${teamId} has conflicting library ownership rows.`);
  return matches[0];
}

function storedRosterXml(teamsDir: string, teamId: string, teamXml: string): string | undefined {
  const rostersDir = join(dirname(teamsDir), "rosters");
  const byTeam = join(rostersDir, `roster_team_${teamId.replace(/[^\w.-]+/g, "_") || "unknown"}.xml`);
  if (existsSync(byTeam)) return readFileSync(byTeam, "utf8");
  const rosterId = element(teamXml, "rosterId");
  if (!rosterId) return undefined;
  const byRoster = join(rostersDir, `roster_${rosterId.replace(/[^\w.-]+/g, "_") || "unknown"}.xml`);
  return existsSync(byRoster) ? readFileSync(byRoster, "utf8") : undefined;
}

function integerTag(xml: string, tags: readonly string[], options?: { required?: boolean; fallback?: number }): number {
  const found = tags.flatMap((tag) =>
    [...xml.matchAll(new RegExp(`<${escapeRe(tag)}\\b[^>]*>\\s*([^<]*)\\s*</${escapeRe(tag)}>`, "gi"))]
      .map((match) => ({ tag, raw: match[1]!.trim() })),
  );
  if (found.length === 0) {
    if (options?.required) fail(500, `Stored team XML is missing <${tags[0]}>.`);
    return options?.fallback ?? 0;
  }
  if (found.length !== 1 || !/^\d+$/.test(found[0]!.raw)) {
    return fail(500, `Stored team XML has a malformed or duplicate <${tags.join("/")}> value.`);
  }
  const value = Number(found[0]!.raw);
  if (!Number.isSafeInteger(value) || value < 0) return fail(500, `Stored team XML has an invalid <${found[0]!.tag}> value.`);
  return value;
}

function setIntegerTag(xml: string, tags: readonly string[], preferredTag: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return fail(500, `Cannot safely write <${preferredTag}>.`);
  const matches = tags.flatMap((tag) =>
    [...xml.matchAll(new RegExp(`<${escapeRe(tag)}\\b[^>]*>\\s*[^<]*\\s*</${escapeRe(tag)}>`, "gi"))]
      .map((match) => ({ tag, full: match[0] })),
  );
  if (matches.length > 1) return fail(500, `Stored team XML has duplicate <${tags.join("/")}> values.`);
  if (matches.length === 1) {
    const match = matches[0]!;
    return xml.replace(match.full, match.full.replace(/>\s*[^<]*\s*</, `>${value}<`));
  }
  const insertion = `\n\t<${preferredTag}>${value}</${preferredTag}>`;
  if (/<treasury\b/i.test(xml)) return xml.replace(/\s*<treasury\b/i, `${insertion}\n\t<treasury`);
  if (/<\/team>/i.test(xml)) return xml.replace(/\s*<\/team>/i, `${insertion}\n</team>`);
  return fail(500, "Stored team XML is missing its closing team element.");
}

function setTextTag(xml: string, tag: string, value: string): string {
  const matches = [...xml.matchAll(new RegExp(`<${escapeRe(tag)}\\b[^>]*>[^<]*</${escapeRe(tag)}>`, "gi"))];
  if (matches.length !== 1) return fail(500, `Stored team XML has a missing or duplicate <${tag}> value.`);
  const full = matches[0]![0];
  return xml.replace(full, full.replace(/>[^<]*</, `>${encodeXml(value)}<`));
}

function setTeamTextTag(xml: string, tag: string, value: string): string {
  const firstPlayer = xml.search(/<player\b/i);
  const header = firstPlayer === -1 ? xml : xml.slice(0, firstPlayer);
  const tail = firstPlayer === -1 ? "" : xml.slice(firstPlayer);
  return setTextTag(header, tag, value) + tail;
}

function teamStatus(xml: string): string {
  const root = xml.match(/<team\b[^>]*>/i)?.[0] ?? "";
  const raw = element(xml.split(/<player\b/i)[0] ?? xml, "status") ?? decodeXml(attr(root, "status") ?? "");
  // Library rows have no status and composed teams are pre-play builds, so an absent field is NEW.
  return raw.trim() || "NEW";
}

function rerollCosts(teamXml: string, rosterXml: string): { paid: number; value: number } {
  const base = integerTag(rosterXml, ["reRollCost"], { required: true });
  if (base <= 0) return fail(500, "Stored roster XML has an invalid <reRollCost> value.");
  const status = teamStatus(teamXml).toUpperCase().replace(/[\s_-]+/g, "");
  const discounted = status === "NEW" || status === "REDRAFTING" || status === "0";
  const paid = discounted ? base / 2 : base * 2;
  if (!Number.isSafeInteger(paid)) return fail(500, "The roster reroll price cannot be represented exactly.");
  return { paid, value: base };
}

function apothecaryAllowed(rosterXml: string): boolean {
  const value = element(rosterXml, "apothecary");
  if (value === undefined) return false;
  return value.toLowerCase() === "true";
}

function bumpTeamValueAggregates(xml: string, deltaGold: number): string {
  if (deltaGold === 0) return xml;
  const firstPlayer = xml.search(/<player\b/i);
  let header = firstPlayer === -1 ? xml : xml.slice(0, firstPlayer);
  const tail = firstPlayer === -1 ? "" : xml.slice(firstPlayer);
  const builderDialect = /<(?:teamRating|teamStrength)\b/i.test(header);
  const tags = ["teamValue", "tournamentWeight", "teamRating", "rating", "currentTeamValue", "teamStrength", "strength"];
  for (const tag of tags) {
    const matches = [...header.matchAll(new RegExp(`<${tag}\\b[^>]*>\\s*([^<]*)\\s*</${tag}>`, "gi"))];
    if (matches.length > 1) return fail(500, `Stored team XML has duplicate <${tag}> aggregates.`);
    if (matches.length === 0) continue;
    const raw = matches[0]![1]!.trim();
    if (!/^\d+$/.test(raw)) return fail(500, `Stored team XML has a malformed <${tag}> aggregate.`);
    const before = Number(raw);
    const units = builderDialect || tag === "teamRating" || tag === "rating" || tag === "teamStrength" || tag === "strength";
    const applied = units ? deltaGold / 10_000 : deltaGold;
    const next = before + applied;
    if (!Number.isSafeInteger(applied) || !Number.isSafeInteger(next) || next < 0) {
      return fail(500, `Cannot safely update the stored <${tag}> aggregate.`);
    }
    const full = matches[0]![0];
    header = header.replace(full, full.replace(/>\s*[^<]*\s*</, `>${next}<`));
  }
  return header + tail;
}

function renumber(xml: string, playerNumbers: JsonObject): string {
  const players = [...xml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)].map((match) => match[0]);
  const byId = new Map<string, { block: string; number: number }>();
  for (const block of players) {
    const opening = block.match(/<player\b[^>]*>/i)?.[0] ?? "";
    const id = decodeXml(attr(opening, "id") ?? "");
    const numberElement = element(block, "number");
    const rawNumber = numberElement ?? attr(opening, "nr") ?? attr(opening, "number");
    const number = Number(rawNumber);
    if (!id || !Number.isSafeInteger(number)) return fail(500, "Stored team XML has a player with an invalid id or number.");
    if (byId.has(id)) return fail(500, `Stored team XML contains duplicate player id ${id}.`);
    byId.set(id, { block, number });
  }

  for (const [playerId, requested] of Object.entries(playerNumbers)) {
    if (!byId.has(playerId)) return fail(400, `Unknown playerId ${playerId}.`);
    if (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > 99) {
      return fail(400, `Player ${playerId} must have a number from 1 to 99.`);
    }
    byId.get(playerId)!.number = requested as number;
  }

  const occupied = new Map<number, string>();
  for (const [playerId, player] of byId) {
    if (player.number < 1 || player.number > 99) return fail(400, `Player ${playerId} has a final number outside 1-99.`);
    const other = occupied.get(player.number);
    if (other) return fail(400, `Duplicate final player number ${player.number} for players ${other} and ${playerId}.`);
    occupied.set(player.number, playerId);
  }

  let updated = xml;
  for (const [playerId, player] of byId) {
    if (!Object.hasOwn(playerNumbers, playerId)) continue;
    const opening = player.block.match(/<player\b[^>]*>/i)?.[0] ?? "";
    let nextBlock: string;
    if (element(player.block, "number") !== undefined) {
      nextBlock = setTextTag(player.block, "number", String(player.number));
    } else if (/\bnr="[^"]*"/i.test(opening)) {
      nextBlock = player.block.replace(opening, opening.replace(/\bnr="[^"]*"/i, `nr="${player.number}"`));
    } else if (/\bnumber="[^"]*"/i.test(opening)) {
      nextBlock = player.block.replace(opening, opening.replace(/\bnumber="[^"]*"/i, `number="${player.number}"`));
    } else {
      return fail(500, `Stored player ${playerId} has no supported number field.`);
    }
    updated = updated.replace(player.block, nextBlock);
  }
  return updated;
}

// ── P3: player lifecycle + ready/unready (contract §3C) ──────────────────────────────────────────
//
// Dispatcher rulings without contract provenance, chosen fail-safe and commented at the site:
// fired/retired players are stored as <firedPlayer> nodes (never nested <player> — the Java server's
// team parser must not field them); no refunds anywhere except the NEW-team refundPlayer buy-back;
// no agent fee on re-hire (the fork has no season provenance); ready is gated to NEW teams (post-game
// re-ready is a production HOLD) and never triggers Expensive Mistakes (no season/redraft provenance).

const ROSTER_OPERATIONS = new Set<TeamMutationOperation>([
  "addPlayer",
  "firePlayer",
  "retirePlayer",
  "temporaryRetirePlayer",
  "undoTemporaryRetire",
  "rehirePlayer",
  "refundPlayer",
  "ready",
  "unready",
]);

const MAX_TEAM_PLAYERS = 16;
const MIN_READY_PLAYERS = 11;

interface PlayerBlock {
  block: string;
  opening: string;
  id: string;
  nr: number | undefined;
  status: string;
  positionId: string;
}

function parsePlayerBlock(block: string): PlayerBlock {
  const opening = block.match(/<(?:fired)?[pP]layer\b[^>]*>/i)?.[0] ?? "";
  const nrRaw = element(block, "number") ?? attr(opening, "nr") ?? attr(opening, "number");
  const nr = Number(nrRaw);
  return {
    block,
    opening,
    id: decodeXml(attr(opening, "id") ?? ""),
    nr: Number.isSafeInteger(nr) ? nr : undefined,
    status: decodeXml(attr(opening, "status") ?? ""),
    positionId: element(block, "positionId") ?? decodeXml(attr(opening, "positionId") ?? ""),
  };
}

function activePlayerBlocks(xml: string): PlayerBlock[] {
  return [...xml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)].map((match) => parsePlayerBlock(match[0]!));
}

function firedPlayerBlocks(xml: string): PlayerBlock[] {
  return [...xml.matchAll(/<firedPlayer\b[^>]*>[\s\S]*?<\/firedPlayer>/gi)].map((match) => parsePlayerBlock(match[0]!));
}

interface RosterPosition {
  id: string;
  name: string;
  type: string;
  quantity: number;
  cost: number;
  gender: string;
}

function rosterPositions(rosterXml: string): Map<string, RosterPosition> {
  const positions = new Map<string, RosterPosition>();
  for (const found of rosterXml.matchAll(/<position\b([^>]*)>([\s\S]*?)<\/position>/gi)) {
    const id = decodeXml(attr(found[1]!, "id") ?? "");
    if (!id) continue;
    const body = found[2]!;
    const quantity = Number(element(body, "quantity") ?? "");
    const cost = Number(element(body, "cost") ?? "");
    positions.set(id, {
      id,
      name: element(body, "name") ?? "",
      type: element(body, "type") ?? "",
      quantity: Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : 0,
      cost: Number.isSafeInteger(cost) && cost >= 0 ? cost : 0,
      gender: (element(body, "gender") ?? "").toLowerCase(),
    });
  }
  return positions;
}

type TeamStatusClass = "NEW" | "ACTIVE" | "OTHER";

function teamStatusClass(raw: string): TeamStatusClass {
  const status = raw.trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (status === "" || status === "NEW" || status === "0") return "NEW";
  if (status === "1" || status === "ACTIVE") return "ACTIVE";
  return "OTHER";
}

/** Writes the raw FUMBBL status value ("0" new / "1" active) wherever this dialect stores it. */
function writeTeamStatus(xml: string, value: string): string {
  const firstPlayer = xml.search(/<player\b/i);
  const header = firstPlayer === -1 ? xml : xml.slice(0, firstPlayer);
  const statusElements = [...header.matchAll(/<status\b[^>]*>[^<]*<\/status>/gi)];
  if (statusElements.length > 1) return fail(500, "Stored team XML has duplicate <status> values.");
  if (statusElements.length === 1) return setTeamTextTag(xml, "status", value);
  const root = xml.match(/<team\b[^>]*>/i)?.[0];
  if (!root) return fail(500, "Stored team XML is missing its team element.");
  const next = /\bstatus="[^"]*"/i.test(root)
    ? root.replace(/\bstatus="[^"]*"/i, `status="${encodeXml(value)}"`)
    : root.replace(/>$/, ` status="${encodeXml(value)}">`);
  return xml.replace(root, next);
}

function lowestFreeNumber(taken: ReadonlySet<number>): number {
  for (let candidate = 1; candidate <= 99; candidate++) if (!taken.has(candidate)) return candidate;
  return fail(400, "No free player number from 1 to 99 remains.");
}

/** Fork-generated player ids use `<teamId>h<n>` — collision-free within the team and string-safe on the Java side (builder teams prove string ids play). */
function newPlayerId(xml: string, teamId: string): string {
  const prefix = `${teamId}h`;
  let max = 0;
  for (const found of xml.matchAll(new RegExp(`\\bid="${escapeRe(prefix)}(\\d+)"`, "gi"))) {
    max = Math.max(max, Number(found[1]!));
  }
  return `${prefix}${max + 1}`;
}

/** The stored dialect is "rich" (fork/FUMBBL ingest: status attrs, playerStatistics) or "compact" (builder). */
function richPlayerDialect(players: readonly PlayerBlock[], teamId: string): boolean {
  if (players.length > 0) return players.some((player) => /<playerStatistics\b/i.test(player.block));
  return /^\d+$/.test(teamId);
}

interface NewPlayerFields {
  id: string;
  nr: number;
  name: string;
  gender: string;
  positionId: string;
  positionName: string;
  status: string;
  extraSkills: readonly string[];
}

function buildPlayerNode(rich: boolean, fields: NewPlayerFields): string {
  const skills = fields.extraSkills
    .map((skill) => (skill === "Loner" ? `<skill value="4">Loner</skill>` : `<skill>${encodeXml(skill)}</skill>`))
    .join("");
  if (!rich) {
    const status = fields.status === "Active" ? "" : ` status="${encodeXml(fields.status)}"`;
    return `\t<player nr="${fields.nr}" id="${encodeXml(fields.id)}"${status}><name>${encodeXml(fields.name)}</name><gender>${fields.gender}</gender><positionId>${encodeXml(fields.positionId)}</positionId><skillList>${skills}</skillList></player>`;
  }
  const statistics = ["completions", "touchdowns", "interceptions", "casualties", "mvps", "passing", "rushing", "blocks", "fouls", "games"]
    .map((tag) => `            <${tag}>0</${tag}>`)
    .join("\n");
  return [
    `    <player status="${encodeXml(fields.status)}" nr="${fields.nr}" id="${encodeXml(fields.id)}">`,
    `        <name>${encodeXml(fields.name)}</name>`,
    `        <gender>${fields.gender}</gender>`,
    `        <positionId>${encodeXml(fields.positionId)}</positionId>`,
    `        <position>${encodeXml(fields.positionName)}</position>`,
    `        <playerStatistics currentSpps="0">`,
    statistics,
    `        </playerStatistics>`,
    skills ? `        <skillList>${skills}</skillList>` : `        <skillList/>`,
    `        <injuryList/>`,
    `    </player>`,
  ].join("\n");
}

function insertPlayerNode(xml: string, node: string): string {
  const lastClose = xml.toLowerCase().lastIndexOf("</player>");
  if (lastClose !== -1) {
    const end = lastClose + "</player>".length;
    return `${xml.slice(0, end)}\n${node}${xml.slice(end)}`;
  }
  const fired = xml.search(/<firedPlayers\b/i);
  if (fired !== -1) return `${xml.slice(0, fired)}${node}\n${xml.slice(fired)}`;
  if (!/<\/team>/i.test(xml)) return fail(500, "Stored team XML is missing its closing team element.");
  return xml.replace(/\s*<\/team>/i, `\n${node}\n</team>`);
}

function appendFiredPlayerNode(xml: string, node: string): string {
  if (/<\/firedPlayers>/i.test(xml)) return xml.replace(/\s*<\/firedPlayers>/i, `\n${node}\n</firedPlayers>`);
  if (!/<\/team>/i.test(xml)) return fail(500, "Stored team XML is missing its closing team element.");
  return xml.replace(/\s*<\/team>/i, `\n<firedPlayers>\n${node}\n</firedPlayers>\n</team>`);
}

function withPlayerStatus(block: string, status: string): string {
  const opening = block.match(/<player\b[^>]*>/i)?.[0] ?? fail(500, "The player block is missing its opening tag.");
  const nextOpening = /\bstatus="[^"]*"/i.test(opening)
    ? opening.replace(/\bstatus="[^"]*"/i, `status="${encodeXml(status)}"`)
    : opening.replace(/<player\b/i, `<player status="${encodeXml(status)}"`);
  return block.replace(opening, nextOpening);
}

function withPlayerNumber(block: string, nr: number): string {
  if (element(block, "number") !== undefined) return setTextTag(block, "number", String(nr));
  const opening = block.match(/<player\b[^>]*>/i)?.[0] ?? "";
  if (/\bnr="[^"]*"/i.test(opening)) return block.replace(opening, opening.replace(/\bnr="[^"]*"/i, `nr="${nr}"`));
  if (/\bnumber="[^"]*"/i.test(opening)) return block.replace(opening, opening.replace(/\bnumber="[^"]*"/i, `number="${nr}"`));
  return block.replace(opening, opening.replace(/<player\b/i, `<player nr="${nr}"`));
}

function playerIdFromBody(value: unknown): string {
  if (typeof value === "string" && value.trim() && value.trim().length <= 128) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return fail(400, "playerId must be a non-empty string or non-negative integer.");
}

function playerHasHistory(block: string): boolean {
  if (/<skill\b/i.test(block) || /<injury\b/i.test(block)) return true;
  const statistics = block.match(/<playerStatistics\b[^>]*/i)?.[0] ?? "";
  const starPoints = block.match(/<starPlayerPoints\b[^>]*/i)?.[0] ?? "";
  const spp = Number(attr(statistics, "currentSpps") ?? attr(starPoints, "current") ?? 0);
  if (Number.isFinite(spp) && spp > 0) return true;
  return /<(?:playedGames|games)>\s*[1-9]/i.test(block);
}

function requireRoster(rosterXml: string | undefined, purpose: string): string {
  return rosterXml ?? fail(500, `Stored roster XML is required to ${purpose}.`);
}

function currentTreasury(xml: string): number {
  return integerTag(xml, ["treasury"], { required: true });
}

function debitTreasury(xml: string, cost: number, description: string): string {
  const treasury = currentTreasury(xml);
  if (treasury < cost) return fail(400, `Insufficient treasury: ${description} requires ${cost}.`);
  return setIntegerTag(xml, ["treasury"], "treasury", treasury - cost);
}

function applyRosterOperation(
  operation: TeamMutationOperation,
  body: JsonObject,
  teamXml: string,
  rosterXml: string | undefined,
  teamId: string,
  admin: boolean,
): { xml: string; extra?: Record<string, unknown> } {
  const players = activePlayerBlocks(teamXml);

  if (operation === "addPlayer") {
    if (!hasExactKeys(body, ["teamId", "positionId", "gender", "name"])) {
      return fail(400, "addPlayer requires exactly {teamId, positionId, gender, name}.");
    }
    const gender = typeof body.gender === "string" ? body.gender : "";
    if (!/^(?:male|female|neutral)$/.test(gender)) return fail(400, "gender must be male, female, or neutral (lowercase).");
    if (typeof body.name !== "string" || body.name.trim().length === 0) return fail(400, "Player name must not be empty.");
    if (body.name.trim().length > 100) return fail(400, "Player name must be at most 100 characters.");
    const positionId = typeof body.positionId === "number" && Number.isSafeInteger(body.positionId)
      ? String(body.positionId)
      : typeof body.positionId === "string" ? body.positionId.trim() : "";
    if (!positionId) return fail(400, "positionId must be a non-empty string or integer.");
    const position = rosterPositions(requireRoster(rosterXml, "hire a player")).get(positionId);
    if (!position) return fail(400, `Unknown positionId ${positionId} for this team's roster.`);
    // Stars and Infamous Staff are induced per game, never hired onto the stored roster.
    if (/star|staff/i.test(position.type)) return fail(400, `${position.name} is induced per game and cannot be hired onto the roster.`);
    if (players.length >= MAX_TEAM_PLAYERS) return fail(400, `A team may not have more than ${MAX_TEAM_PLAYERS} players.`);
    const samePosition = players.filter((player) => player.positionId === positionId).length;
    if (position.quantity > 0 && samePosition >= position.quantity) {
      return fail(400, `A team may not have more than ${position.quantity} of ${position.name}.`);
    }
    let xml = debitTreasury(teamXml, position.cost, `hiring a ${position.name}`);
    const nr = lowestFreeNumber(new Set(players.map((player) => player.nr).filter((n): n is number => n !== undefined)));
    const id = newPlayerId(xml, teamId);
    const node = buildPlayerNode(richPlayerDialect(players, teamId), {
      id,
      nr,
      name: (body.name as string).trim(),
      gender,
      positionId,
      positionName: position.name,
      status: "Active",
      extraSkills: [],
    });
    xml = insertPlayerNode(xml, node);
    return { xml: bumpTeamValueAggregates(xml, position.cost), extra: { playerId: id, number: nr } };
  }

  if (operation === "ready") {
    if (!hasExactKeys(body, ["teamId", "journeymen"]) || !Array.isArray(body.journeymen)) {
      return fail(400, "ready requires exactly {teamId, journeymen: []}.");
    }
    const statusClass = teamStatusClass(teamStatus(teamXml));
    if (statusClass === "ACTIVE") return fail(400, "The team is already ready.");
    if (statusClass === "OTHER" && !admin) {
      return fail(400, "Only a NEW team can be made ready on the fork; post-game ready is unavailable until post-game parity completes.");
    }
    const fieldable = players.filter((player) => !/temporarilyretired/i.test(player.status.replace(/[\s_-]+/g, "")));
    let xml = teamXml;
    let tvDelta = 0;
    const hired: Array<{ playerId: string; number: number }> = [];
    if (fieldable.length >= MIN_READY_PLAYERS) {
      if (body.journeymen.length > 0) return fail(400, "This team does not need journeymen.");
    } else {
      const need = MIN_READY_PLAYERS - fieldable.length;
      const positions = rosterPositions(requireRoster(rosterXml, "provision journeymen"));
      const picks: Array<{ position: RosterPosition; quantity: number }> = [];
      let total = 0;
      for (const entry of body.journeymen) {
        if (!isRecord(entry) || !hasExactKeys(entry, ["positionId", "quantity"]) || !Number.isSafeInteger(entry.quantity) || (entry.quantity as number) < 1) {
          return fail(400, "Each journeyman pick requires exactly {positionId, quantity} with a positive integer quantity.");
        }
        const positionId = typeof entry.positionId === "number" ? String(entry.positionId) : typeof entry.positionId === "string" ? entry.positionId.trim() : "";
        const position = positions.get(positionId);
        if (!position) return fail(400, `Unknown journeyman positionId ${positionId}.`);
        // Contract §4: journeyman-legal positions are the 12/16-quantity linemen.
        if (position.quantity !== 12 && position.quantity !== 16) {
          return fail(400, `${position.name} is not a journeyman-legal position (roster quantity must be 12 or 16).`);
        }
        picks.push({ position, quantity: entry.quantity as number });
        total += entry.quantity as number;
      }
      if (total !== need) return fail(400, `This team needs exactly ${need} journeymen to field ${MIN_READY_PLAYERS} players.`);
      if (players.length + need > MAX_TEAM_PLAYERS) return fail(400, `A team may not have more than ${MAX_TEAM_PLAYERS} players.`);
      const taken = new Set(players.map((player) => player.nr).filter((n): n is number => n !== undefined));
      const rich = richPlayerDialect(players, teamId);
      let sequence = 0;
      for (const pick of picks) {
        for (let i = 0; i < pick.quantity; i++) {
          sequence++;
          const nr = lowestFreeNumber(taken);
          taken.add(nr);
          const id = newPlayerId(xml, teamId);
          // Handoff §7 shape: a stable player node with status="journeyman", ordinary player type, and Loner.
          // A "random" roster gender is provisioned as neutral (no random source is owed here).
          const gender = /^(?:male|female|neutral)$/.test(pick.position.gender) ? pick.position.gender : "neutral";
          const node = buildPlayerNode(rich, {
            id,
            nr,
            name: `Journeyman ${pick.position.name} ${sequence}`,
            gender,
            positionId: pick.position.id,
            positionName: pick.position.name,
            status: "journeyman",
            extraSkills: ["Loner"],
          });
          xml = insertPlayerNode(xml, node);
          // Journeymen cost no gold but count toward team value at position cost.
          tvDelta += pick.position.cost;
          hired.push({ playerId: id, number: nr });
        }
      }
    }
    xml = writeTeamStatus(bumpTeamValueAggregates(xml, tvDelta), "1");
    // Expensive Mistakes is deliberately never triggered: the fork has no season/redraft provenance.
    return { xml, extra: hired.length > 0 ? { journeymen: hired } : {} };
  }

  if (operation === "unready") {
    if (!hasExactKeys(body, ["teamId"])) return fail(400, "unready requires exactly {teamId}.");
    if (teamStatusClass(teamStatus(teamXml)) !== "ACTIVE") return fail(400, "Only a ready team can be unreadied.");
    return { xml: writeTeamStatus(teamXml, "0") };
  }

  // Remaining operations all take exactly {teamId, playerId}.
  if (!hasExactKeys(body, ["teamId", "playerId"])) return fail(400, `${operation} requires exactly {teamId, playerId}.`);
  const playerId = playerIdFromBody(body.playerId);

  if (operation === "rehirePlayer") {
    const fired = firedPlayerBlocks(teamXml).find((player) => player.id === playerId);
    if (!fired) return fail(400, "Player not found among this team's fired players.");
    if (players.length >= MAX_TEAM_PLAYERS) return fail(400, `A team may not have more than ${MAX_TEAM_PLAYERS} players.`);
    const roster = requireRoster(rosterXml, "price a re-hire");
    const position = rosterPositions(roster).get(fired.positionId);
    if (position && position.quantity > 0 && players.filter((player) => player.positionId === fired.positionId).length >= position.quantity) {
      return fail(400, `A team may not have more than ${position.quantity} of ${position.name}.`);
    }
    // Re-hire price = the player's current value; no agent fee (the fork has no season provenance).
    const value = playerProgression(fired.block, roster).currentValue;
    let xml = debitTreasury(teamXml, value, "re-hiring this player");
    xml = xml.replace(fired.block, "");
    xml = xml.replace(/<firedPlayers>\s*<\/firedPlayers>\s*\n?/i, "");
    let restored = fired.block
      .replace(/^<firedPlayer\b/i, "<player")
      .replace(/<\/firedPlayer>$/i, "</player>")
      .replace(/<firedName\b/i, "<name")
      .replace(/<\/firedName>/i, "</name>")
      .replace(/<firedRace\b/i, "<race")
      .replace(/<\/firedRace>/i, "</race>")
      .replace(/\breason="[^"]*"\s?/i, "");
    restored = withPlayerStatus(restored, "Active");
    restored = withPlayerNumber(restored, lowestFreeNumber(new Set(players.map((player) => player.nr).filter((n): n is number => n !== undefined))));
    xml = insertPlayerNode(xml, restored);
    return { xml: bumpTeamValueAggregates(xml, value) };
  }

  const target = players.find((player) => player.id === playerId);
  if (!target) return fail(400, "Player not found on this team.");

  if (operation === "temporaryRetirePlayer") {
    if (/temporarilyretired/i.test(target.status.replace(/[\s_-]+/g, ""))) return fail(400, "This player is already temporarily retired.");
    if (!admin && /journeyman/i.test(target.status)) return fail(400, "A journeyman cannot be temporarily retired.");
    const freshStatReduction = [...target.block.matchAll(/<injury\b([^>]*)>([^<]*)<\/injury>/gi)].some((injury) => {
      if (attr(injury[1]!, "recovering") !== "true") return false;
      const name = decodeXml(injury[2]!).trim();
      return /\(\s*-[^)]*[a-z0-9][^)]*\)/i.test(name) || /-\s*(?:\d+\s*)?[a-z]{1,4}\b/i.test(name);
    });
    if (!admin && !freshStatReduction) return fail(400, "Temporary retirement requires a fresh stat-reducing injury.");
    // Team value is deliberately unchanged: the fork has no provenance for temporary-retirement TV relief.
    return { xml: teamXml.replace(target.block, withPlayerStatus(target.block, "TemporarilyRetired")) };
  }

  if (operation === "undoTemporaryRetire") {
    if (!/temporarilyretired/i.test(target.status.replace(/[\s_-]+/g, ""))) return fail(400, "This player is not temporarily retired.");
    return { xml: teamXml.replace(target.block, withPlayerStatus(target.block, "Active")) };
  }

  if (/<pendingAdvancement\b/i.test(teamXml)) {
    return fail(400, "Finish the team's pending advancement before removing players.");
  }
  const value = playerProgression(target.block, requireRoster(rosterXml, "value this player")).currentValue;

  if (operation === "firePlayer" || operation === "retirePlayer") {
    const reason = operation === "firePlayer" ? "fired" : "retired";
    // No refund (the standing dispatcher ruling). The node is preserved for re-hire and the
    // firedPlayers[] detail section, renamed <firedPlayer> so the Java team parser never fields it.
    // The Java SAX handler stays on Team for unknown tags, so the child <name>/<race> tags must
    // also be renamed — a bare <name> inside <firedPlayers> would overwrite the TEAM name on load.
    const moved = target.block
      .replace(/^<player\b/i, `<firedPlayer reason="${reason}"`)
      .replace(/<\/player>$/i, "</firedPlayer>")
      .replace(/<name\b/i, "<firedName")
      .replace(/<\/name>/i, "</firedName>")
      .replace(/<race\b/i, "<firedRace")
      .replace(/<\/race>/i, "</firedRace>");
    let xml = teamXml.replace(target.block, "");
    xml = appendFiredPlayerNode(xml, moved);
    return { xml: bumpTeamValueAggregates(xml, -value) };
  }

  // refundPlayer: the NEW-team buy-back — full position-cost refund, node removed outright.
  if (!admin && teamStatusClass(teamStatus(teamXml)) !== "NEW") {
    return fail(400, "Refunds are only available before a team's first game.");
  }
  if (playerHasHistory(target.block)) return fail(400, "A player with skills, injuries, or match history cannot be refunded.");
  const position = rosterPositions(requireRoster(rosterXml, "price a refund")).get(target.positionId);
  if (!position) return fail(400, `The player's position ${target.positionId} is unknown to this team's roster; no refund price exists.`);
  let xml = setIntegerTag(teamXml, ["treasury"], "treasury", currentTreasury(teamXml) + position.cost);
  xml = xml.replace(target.block, "");
  // Contract §3C: refundPlayer responds {number}; non-zero would mean re-added as a journeyman,
  // which the fork's pre-play refund never does.
  return { xml: bumpTeamValueAggregates(xml, -value), extra: { number: 0 } };
}

function applyOperation(
  operation: TeamMutationOperation,
  body: JsonObject,
  teamXml: string,
  rosterXml: string | undefined,
  duplicateNameError: TeamMutationDeps["duplicateNameError"],
  teamId: string,
  admin: boolean,
): { xml: string; teamName?: string; extra?: Record<string, unknown> } {
  if (ROSTER_OPERATIONS.has(operation)) return applyRosterOperation(operation, body, teamXml, rosterXml, teamId, admin);
  if (operation === "renumber") {
    if (!hasExactKeys(body, ["teamId", "playerNumbers"]) || !isRecord(body.playerNumbers)) {
      return fail(400, "renumber requires exactly {teamId, playerNumbers}.");
    }
    return { xml: renumber(teamXml, body.playerNumbers) };
  }
  if (operation === "changeDedicatedFans") {
    if (!hasExactKeys(body, ["teamId", "newDf"]) || !Number.isSafeInteger(body.newDf)) {
      return fail(400, "changeDedicatedFans requires exactly integer fields {teamId, newDf}.");
    }
    const newDf = body.newDf as number;
    if (newDf < 1 || newDf > 6) return fail(400, "newDf must be from 1 to 6.");
    const current = integerTag(teamXml, ["fanFactor", "dedicatedFans"], { required: true });
    const cost = Math.max(0, newDf - current) * 10_000;
    const treasury = integerTag(teamXml, ["treasury"], { required: true });
    if (treasury < cost) return fail(400, `Insufficient treasury: changing dedicated fans requires ${cost}.`);
    // BB2025 dedicated fans do not add team value. Decreases intentionally receive no refund.
    let xml = setIntegerTag(teamXml, ["fanFactor", "dedicatedFans"], "fanFactor", newDf);
    xml = setIntegerTag(xml, ["treasury"], "treasury", treasury - cost);
    return { xml };
  }
  if (operation === "rename") {
    if (!hasExactKeys(body, ["teamId", "newName"])) return fail(400, "rename requires exactly {teamId, newName}.");
    const validityError = teamNameValidationError(body.newName);
    if (validityError) return fail(400, validityError);
    const newName = (body.newName as string).trim();
    const duplicateError = duplicateNameError(newName, teamId);
    if (duplicateError) return fail(409, duplicateError);
    return { xml: setTeamTextTag(teamXml, "name", newName), teamName: newName };
  }
  if (operation === "setResurrection") {
    if (!hasExactKeys(body, ["teamId", "resurrection"])) {
      return fail(400, "setResurrection requires exactly {teamId, resurrection}.");
    }
    if (typeof body.resurrection !== "boolean") return fail(400, "resurrection must be a boolean.");
    return { xml: setTeamResurrection(teamXml, body.resurrection) };
  }

  if (!hasExactKeys(body, ["teamId"])) return fail(400, `${operation} requires exactly {teamId}.`);
  const treasury = integerTag(teamXml, ["treasury"], { required: true });
  let xml = teamXml;
  let tvDelta = 0;
  const debit = (cost: number, description: string): void => {
    if (treasury < cost) fail(400, `Insufficient treasury: ${description} requires ${cost}.`);
    xml = setIntegerTag(xml, ["treasury"], "treasury", treasury - cost);
  };

  if (operation === "addReroll") {
    if (!rosterXml) return fail(500, "Stored roster XML is required to price a reroll.");
    const count = integerTag(xml, ["reRolls"], { required: true });
    if (count >= 8) return fail(400, "A team may not have more than 8 rerolls.");
    const costs = rerollCosts(xml, rosterXml);
    debit(costs.paid, "a reroll");
    xml = setIntegerTag(xml, ["reRolls"], "reRolls", count + 1);
    tvDelta = costs.value;
  } else if (operation === "removeReroll" || operation === "discardReroll") {
    if (!rosterXml) return fail(500, "Stored roster XML is required to value a reroll.");
    const count = integerTag(xml, ["reRolls"], { required: true });
    if (count <= 0) return fail(400, "The team has no reroll to remove.");
    xml = setIntegerTag(xml, ["reRolls"], "reRolls", count - 1);
    // The contract carries no paid-price provenance, so remove/discard gives no treasury refund.
    tvDelta = -rerollCosts(xml, rosterXml).value;
  } else if (operation === "addAssistantCoach") {
    const count = integerTag(xml, ["assistantCoaches"], { fallback: 0 });
    if (count >= 6) return fail(400, "A team may not have more than 6 assistant coaches.");
    debit(10_000, "an assistant coach");
    xml = setIntegerTag(xml, ["assistantCoaches"], "assistantCoaches", count + 1);
    tvDelta = 10_000;
  } else if (operation === "fireAssistantCoach") {
    const count = integerTag(xml, ["assistantCoaches"], { fallback: 0 });
    if (count <= 0) return fail(400, "The team has no assistant coach to fire.");
    // Firing staff has no refund because the contract defines no staff refund semantics.
    xml = setIntegerTag(xml, ["assistantCoaches"], "assistantCoaches", count - 1);
    tvDelta = -10_000;
  } else if (operation === "addCheerleader") {
    const count = integerTag(xml, ["cheerleaders"], { fallback: 0 });
    debit(10_000, "a cheerleader");
    xml = setIntegerTag(xml, ["cheerleaders"], "cheerleaders", count + 1);
    tvDelta = 10_000;
  } else if (operation === "fireCheerleader") {
    const count = integerTag(xml, ["cheerleaders"], { fallback: 0 });
    if (count <= 0) return fail(400, "The team has no cheerleader to fire.");
    // Firing staff has no refund because the contract defines no staff refund semantics.
    xml = setIntegerTag(xml, ["cheerleaders"], "cheerleaders", count - 1);
    tvDelta = -10_000;
  } else if (operation === "addApothecary") {
    if (!rosterXml || !apothecaryAllowed(rosterXml)) return fail(400, "This roster does not allow an apothecary.");
    const count = integerTag(xml, ["apothecaries"], { fallback: 0 });
    if (count >= 1) return fail(400, "A team may not have more than one apothecary.");
    debit(50_000, "an apothecary");
    xml = setIntegerTag(xml, ["apothecaries"], "apothecaries", 1);
    tvDelta = 50_000;
  } else if (operation === "fireApothecary") {
    const count = integerTag(xml, ["apothecaries"], { fallback: 0 });
    if (count <= 0) return fail(400, "The team has no apothecary to fire.");
    // Firing staff has no refund because the contract defines no staff refund semantics.
    xml = setIntegerTag(xml, ["apothecaries"], "apothecaries", 0);
    tvDelta = -50_000;
  }
  return { xml: bumpTeamValueAggregates(xml, tvDelta) };
}

function syncedLibraryTeam(before: LibraryTeam, xml: string, teamName?: string): LibraryTeam {
  const meta = parseTeamXmlMeta(xml);
  return {
    ...before,
    ...(teamName !== undefined ? { teamName } : {}),
    // parseTeamXmlMeta intentionally defaults absent aggregates to zero; mutation sync must instead
    // preserve an existing library value when that derived field is not carried by this XML dialect.
    ...(/<(?:currentTeamValue|teamValue|teamRating)\b/i.test(xml) ? { teamValue: meta.teamValue } : {}),
    ...(/<treasury\b/i.test(xml) ? { gold: meta.gold } : {}),
    ...(meta.rerolls !== undefined ? { rerolls: meta.rerolls } : {}),
    ...(meta.fanFactor !== undefined ? { fanFactor: meta.fanFactor } : {}),
    ...(meta.apothecary !== undefined ? { apothecary: meta.apothecary } : {}),
  };
}

async function reloadResult(reload: TeamMutationDeps["reload"]): Promise<ReloadResult> {
  if (!reload) return { reloaded: false, reason: "Fork reload is not configured on this host." };
  try {
    return await reload();
  } catch (error) {
    return { reloaded: false, reason: error instanceof Error ? error.message : "Fork reload failed." };
  }
}

export async function teamMutationEndpoint(
  auth: TeamMutationIdentity | undefined,
  operation: TeamMutationOperation,
  rawBody: unknown,
  deps: TeamMutationDeps,
): Promise<TeamMutationResult> {
  if (!auth) return { status: 401, body: { error: "Authentication required." } };
  if (!isRecord(rawBody) || !Object.hasOwn(rawBody, "teamId")) {
    return { status: 400, body: { error: `${operation} requires a JSON object containing teamId.` } };
  }

  let teamId: string;
  try {
    teamId = teamIdFromBody(rawBody.teamId);
  } catch (error) {
    const failure = error as EndpointFailure;
    return { status: failure.status, body: { error: failure.message } };
  }
  if (!deps.teamsDir) return { status: 503, body: { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." } };

  let initial: LibraryTarget | undefined;
  try { initial = libraryTarget(auth, deps.libraryDir, teamId); }
  catch (error) {
    const failure = error as EndpointFailure;
    return { status: failure.status, body: { error: failure.message } };
  }
  if (!initial) return { status: 404, body: { error: "Team not found." } };

  const now = deps.now?.() ?? Date.now();
  const generationLock = acquireTeamNameWriteLock(deps.teamsDir, now);
  if (!generationLock) return { status: 409, body: { error: "Another team/cache generation update is in progress." } };
  const teamLock = acquireTeamWriteLock(deps.teamsDir, teamId, now);
  if (!teamLock) {
    generationLock.release();
    return { status: 409, body: { error: "Another update is already in progress for this team." } };
  }

  try {
    const target = libraryTarget(auth, deps.libraryDir, teamId);
    if (!target) return { status: 404, body: { error: "Team not found." } };
    const stored = storedTeamFile(deps.teamsDir, teamId);
    if (!stored || !coachNamesEqual(storedTeamCoach(stored.xml) ?? "", target.team.coach)) {
      return { status: 404, body: { error: "Team not found." } };
    }
    const roster = storedRosterXml(deps.teamsDir, teamId, stored.xml);
    const applied = applyOperation(operation, rawBody, stored.xml, roster, deps.duplicateNameError, teamId, auth.admin);
    const after = syncedLibraryTeam(target.team, applied.xml, applied.teamName);
    const transaction = beginTeamXmlTransaction({
      teamsDir: deps.teamsDir,
      teamId,
      targetPath: stored.path,
      teamXml: applied.xml,
      library: { baseDir: deps.libraryDir, coach: target.coachKey, team: after },
    });
    try {
      atomicWriteTextFile(stored.path, applied.xml);
      upsertLibraryTeam(deps.libraryDir, target.coachKey, after);
      // Reload refusal is reported but is not grounds to undo an already-coherent disk mutation.
      const reload = await reloadResult(deps.reload);
      commitTeamXmlTransaction(transaction, reload.reloaded);
      return { status: 200, body: { ok: true, teamId, ...applied.extra, reload } };
    } catch (error) {
      try {
        restoreTeamXmlTransaction(transaction);
        acknowledgeRestoredTeamXmlTransaction(transaction);
      } catch (rollbackError) {
        return {
          status: 500,
          body: { error: `The team mutation failed and rollback also failed: ${(rollbackError as Error).message}` },
        };
      }
      return { status: 500, body: { error: `The team mutation was rolled back: ${(error as Error).message}` } };
    }
  } catch (error) {
    const failure = error instanceof EndpointFailure ? error : new EndpointFailure(500, (error as Error).message);
    return { status: failure.status, body: { error: failure.message } };
  } finally {
    teamLock.release();
    generationLock.release();
  }
}
