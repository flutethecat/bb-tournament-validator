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
  | "rename";

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
  | { status: 200; body: { ok: true; teamId: string; reload: ReloadResult } }
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

function applyOperation(
  operation: TeamMutationOperation,
  body: JsonObject,
  teamXml: string,
  rosterXml: string | undefined,
  duplicateNameError: TeamMutationDeps["duplicateNameError"],
  teamId: string,
): { xml: string; teamName?: string } {
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
    const applied = applyOperation(operation, rawBody, stored.xml, roster, deps.duplicateNameError, teamId);
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
      return { status: 200, body: { ok: true, teamId, reload } };
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
