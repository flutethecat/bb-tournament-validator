/**
 * Parser for the fork's `FumbblResult` XML — the body of the multipart `xml:result` upload the
 * game server POSTs in FUMBBL-connected mode (part `f`, filename `result.xml`, text/xml).
 *
 * The schema is fixed BY the fork's serializer `FumbblResult.addToXml`
 * (`request/fumbbl/FumbblResult.java`) — every tag/attribute name below is quoted from that file,
 * so this parser is a term-for-term inverse, not a guess. The document is SAX-generated (attributes
 * always quoted, no mixed content, no entities beyond XML-escaping), so — exactly as the fork's own
 * `parseAdminGameList` does for `admin/list` — regex block extraction is a safe, dependency-free
 * match for the shape it actually produces.
 *
 * This module is PURE EXTRACTION. It banks nothing and derives nothing (CE-1): it turns the
 * server-computed numbers into a typed object. The banking apply (`fumbblResultBanking.ts`) consumes
 * it. Deliberately split so the parser is unit-testable against a captured upload with no filesystem.
 *
 * ⚠ FIDELITY: `starPlayerPoints @current` is the PRE-GAME spendable SPP baseline copied from the
 * roster player into PlayerResult by GameCache; `@earned` is the server-computed match delta. The banker
 * verifies the persisted baseline and writes `current + earned`.
 */

/** A single `<playerResult>` (`FumbblResult.java:330-440`). Absent optional counters default to 0. */
export interface ParsedPlayerResult {
  playerId: string;
  playerType?: string;
  positionId?: string;
  name?: string;
  gender?: string;
  defecting: boolean;
  /** `<starPlayerPoints @current>` — authoritative PRE-GAME spendable SPP baseline. */
  currentSpps?: number;
  /** `<starPlayerPoints @earned>` — this game's server-computed gain. */
  earnedSpps?: number;
  completions: number;
  touchdowns: number;
  deflections: number;
  interceptions: number;
  casualties: number;
  playerAwards: number; // MVPs (the concede-legal MVP is already resolved server-side — see #101 history)
  landings: number;
  blocks: number;
  fouls: number;
  rushing: number;
  passing: number;
  turnsPlayed: number;
  /** `<injury>` elements — serious injury AND the decay injury are BOTH emitted as `<injury>` (`:421-427`). */
  injuries: string[];
  /** `<gainedHatred><keyword>` lowercased keywords (`:429-434`). */
  gainedHatred: string[];
}

/** Exact BB2025 `SeriousInjury.getName()` values accepted by `SeriousInjuryFactory.forName`. */
const BB2025_SERIOUS_INJURIES = new Set([
  "Seriously Hurt (MNG)",
  "Serious Injury (NI)",
  "Head Injury (-AV)",
  "Smashed Knee (-MA)",
  "Broken Arm (-PA)",
  "Dislocated Hip (-AG)",
  "Dislocated Shoulder (-ST)",
  "Dead (RIP)",
]);

/** A `<teamResult teamId>` (`FumbblResult.java:158-232`). Money/modifier fields are omitted by the
 *  serializer when zero/non-positive — absent ⇒ 0 (or false), which the banker treats as "no delta". */
export interface ParsedTeamResult {
  teamId: string;
  score: number;
  conceded: boolean;
  concededLegally?: boolean; // only present when conceded (`:168-170`)
  stalled: boolean;
  penaltyScore?: number;
  spectators?: number;
  fame?: number;
  fanFactor?: number;
  winnings?: number;
  fanFactorModifier?: number;
  dedicatedFansModifier?: number;
  spirallingExpenses?: number;
  pettyCashTransferred?: number;
  pettyCashUsed?: number;
  teamValue?: number;
  treasurySpentOnInducements?: number;
  casualtiesSuffered: { badlyHurt: number; seriousInjury: number; rip: number };
  players: ParsedPlayerResult[];
}

/** The whole `<gameResult replayId halves>` document (`FumbblResult.java:134-152`). */
export interface ParsedGameResult {
  /** `@replayId` == the fork gameId (`getGame().getId()`, `:141`). */
  gameId: string;
  halves: number;
  teams: ParsedTeamResult[];
}

const attr = (s: string, name: string): string | undefined => {
  const assignments = [...s.matchAll(new RegExp(`\\b${name}\\s*=`, "g"))];
  if (assignments.length > 1) throw new Error(`duplicate ${name} attribute`);
  if (!assignments.length) return undefined;
  const exact = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  if (!exact) throw new Error(`malformed ${name} attribute`);
  return exact[1];
};

/** `<tag>text</tag>` — first occurrence within `scope`. Value is XML-unescaped. */
const el = (scope: string, tag: string): string | undefined => {
  const occurrences = [...scope.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"))];
  if (occurrences.length > 1) throw new Error(`duplicate <${tag}> element`);
  if (!occurrences.length) {
    if (new RegExp(`<${tag}\\b`, "i").test(scope)) throw new Error(`malformed <${tag}> element`);
    return undefined;
  }
  const m = occurrences[0]![0].match(new RegExp(`^<${tag}>([^<]*)</${tag}>$`, "i"));
  if (!m) throw new Error(`malformed <${tag}> element`);
  return unescapeXml(m[1]!);
};

const num = (scope: string, tag: string): number | undefined => {
  const v = el(scope, tag);
  if (v === undefined) return undefined;
  const parsed = Number(v);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid <${tag}> integer`);
  return parsed;
};

/** Optional boolean exactly as `UtilXml.addValueElement(boolean)` emits it. */
const bool = (scope: string, tag: string): boolean => {
  const value = el(scope, tag)?.trim().toLowerCase();
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid <${tag}> boolean`);
};

const integerAttr = (scope: string, name: string, fallback = 0): number => {
  const raw = attr(scope, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${name} integer attribute`);
  return parsed;
};

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** All `<tag ...>` occurrences (both empty `<tag/>` and `<tag>..</tag>`) of an element, as raw substrings. */
function blocks(scope: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope))) {
    if (m[1]?.includes("<")) throw new Error(`malformed <${tag}> opening tag`);
    out.push(m[0]!);
  }
  return out;
}

function parsePlayerResult(block: string): ParsedPlayerResult {
  for (const container of ["starPlayerPoints", "statistics", "gainedHatred"] as const) {
    const parsed = blocks(block, container);
    const tokens = [...block.matchAll(new RegExp(`<${container}\\b`, "gi"))];
    if (parsed.length > 1) throw new Error(`duplicate <${container}> container`);
    if (tokens.length !== parsed.length) throw new Error(`malformed <${container}> container`);
  }
  // The <statistics> and <starPlayerPoints> children carry the counters; they live inside `block`,
  // so scoped `num()` over the whole block finds them (each counter tag is unique within a player).
  return {
    playerId: attr(block, "playerId") ?? "",
    playerType: attr(block, "playerType"),
    positionId: attr(block, "positionId"),
    name: attr(block, "name"),
    gender: attr(block, "gender"),
    defecting: bool(block, "defecting"),
    currentSpps: spAttr(block, "current"),
    earnedSpps: spAttr(block, "earned"),
    completions: num(block, "completions") ?? 0,
    touchdowns: num(block, "touchdowns") ?? 0,
    deflections: num(block, "deflections") ?? 0,
    interceptions: num(block, "interceptions") ?? 0,
    casualties: num(block, "casualties") ?? 0,
    playerAwards: num(block, "playerAwards") ?? 0,
    landings: num(block, "landings") ?? 0,
    blocks: num(block, "blocks") ?? 0,
    fouls: num(block, "fouls") ?? 0,
    rushing: num(block, "rushing") ?? 0,
    passing: num(block, "passing") ?? 0,
    turnsPlayed: num(block, "turnsPlayed") ?? 0,
    injuries: [...block.matchAll(/<injury>([^<]*)<\/injury>/g)].map((m) => unescapeXml(m[1]!)),
    gainedHatred: [...block.matchAll(/<keyword>([^<]*)<\/keyword>/g)].map((m) => unescapeXml(m[1]!)),
  };
}

/** Read an attribute off the `<starPlayerPoints current=".." earned=".."/>` opening tag, if present. */
function spAttr(block: string, name: "current" | "earned"): number | undefined {
  const containers = blocks(block, "starPlayerPoints");
  if (containers.length > 1) throw new Error("duplicate <starPlayerPoints> container");
  if (!containers.length) return undefined;
  const opening = containers[0]!.match(/^<starPlayerPoints\b([^>]*)>/);
  if (!opening) throw new Error("malformed <starPlayerPoints> container");
  const v = attr(opening[1]!, name);
  if (v === undefined) return undefined;
  const parsed = Number(v);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid starPlayerPoints ${name} integer`);
  return parsed;
}

// Fork replay ids legitimately contain ':' (for example `test:...`). Slashes and controls are
// not logical-id characters; banking additionally hashes/sanitizes every filesystem filename.
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const requireNonnegative = (label: string, value: number | undefined): void => {
  if (value !== undefined && value < 0) throw new Error(`${label} must be nonnegative`);
};

function validateParsedResult(result: ParsedGameResult): void {
  if (!SAFE_ID.test(result.gameId)) throw new Error("gameResult replayId contains unsupported characters or length");
  requireNonnegative("halves", result.halves);
  const teamIds = new Set<string>();
  for (const team of result.teams) {
    if (!SAFE_ID.test(team.teamId)) throw new Error("teamResult teamId contains unsupported characters or length");
    if (teamIds.has(team.teamId)) throw new Error(`duplicate teamResult teamId ${team.teamId}`);
    teamIds.add(team.teamId);
    for (const [label, value] of Object.entries({
      score: team.score, spectators: team.spectators, fame: team.fame, fanFactor: team.fanFactor,
      winnings: team.winnings, spirallingExpenses: team.spirallingExpenses,
      pettyCashTransferred: team.pettyCashTransferred, pettyCashUsed: team.pettyCashUsed,
      teamValue: team.teamValue, treasurySpentOnInducements: team.treasurySpentOnInducements,
      badlyHurt: team.casualtiesSuffered.badlyHurt, seriousInjury: team.casualtiesSuffered.seriousInjury,
      rip: team.casualtiesSuffered.rip,
    })) requireNonnegative(label, value);
    if (team.dedicatedFansModifier !== undefined && Math.abs(team.dedicatedFansModifier) > 7) {
      throw new Error("dedicatedFansModifier is outside the supported range");
    }
    const playerIds = new Set<string>();
    for (const player of team.players) {
      if (!SAFE_ID.test(player.playerId)) throw new Error("playerResult playerId contains unsupported characters or length");
      if (playerIds.has(player.playerId)) throw new Error(`duplicate playerResult playerId ${player.playerId}`);
      playerIds.add(player.playerId);
      for (const [label, value] of Object.entries({
        currentSpps: player.currentSpps, earnedSpps: player.earnedSpps, completions: player.completions,
        touchdowns: player.touchdowns, deflections: player.deflections, interceptions: player.interceptions,
        casualties: player.casualties, playerAwards: player.playerAwards, landings: player.landings,
        blocks: player.blocks, fouls: player.fouls, turnsPlayed: player.turnsPlayed,
      })) requireNonnegative(label, value);
      if ((player.currentSpps === undefined) !== (player.earnedSpps === undefined)) {
        throw new Error("starPlayerPoints must carry both current baseline and earned delta");
      }
      if (player.earnedSpps !== undefined && player.earnedSpps === 0) {
        throw new Error("serialized starPlayerPoints earned delta must be positive");
      }
      for (const injury of player.injuries) {
        if (!BB2025_SERIOUS_INJURIES.has(injury)) {
          throw new Error(`unknown BB2025 serious injury ${JSON.stringify(injury)}`);
        }
      }
      // The server serializer deliberately emits signed yardage. It is still parsed by `num`,
      // which requires a finite safe integer; do not reject legitimate negative movement.
      for (const [label, value] of Object.entries({ rushing: player.rushing, passing: player.passing })) {
        if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
      }
    }
  }
}

function parseTeamResult(block: string): ParsedTeamResult {
  // Player results live inside <playerResultList> — isolate it so team-level counters (e.g. `casualties`
  // as a player stat) aren't confused with team fields. Team fields sit BEFORE the list.
  const lists = blocks(block, "playerResultList");
  if (lists.length !== 1) throw new Error("teamResult must contain exactly one <playerResultList>");
  const listMatch = lists[0]!.match(/^<playerResultList\b[^>]*>([\s\S]*?)<\/playerResultList>$/);
  if (!listMatch) throw new Error("malformed <playerResultList>");
  const listInner = listMatch?.[1] ?? "";
  const teamScope = listMatch ? block.slice(0, block.indexOf(listMatch[0])) : block;
  const casualtyContainers = blocks(teamScope, "casualtiesSuffered");
  if (casualtyContainers.length > 1) throw new Error("duplicate <casualtiesSuffered> container");
  if ([...teamScope.matchAll(/<casualtiesSuffered\b/gi)].length !== casualtyContainers.length) {
    throw new Error("malformed <casualtiesSuffered> container");
  }
  const casualtyMatch = casualtyContainers[0]?.match(/^<casualtiesSuffered\b([^>]*)\/>$/);
  if (casualtyContainers.length && !casualtyMatch) throw new Error("malformed <casualtiesSuffered> container");
  const cas = casualtyMatch?.[1] ?? "";
  const concededElement = el(teamScope, "conceded");
  const stalledElement = el(teamScope, "stalled");
  if (concededElement === undefined) throw new Error("teamResult is missing canonical <conceded>");
  if (stalledElement === undefined) throw new Error("teamResult is missing canonical <stalled>");
  const conceded = bool(teamScope, "conceded");
  const concededLegallyElement = el(teamScope, "concededLegally");
  if (conceded && concededLegallyElement === undefined) {
    throw new Error("conceded teamResult is missing canonical <concededLegally>");
  }
  if (!conceded && concededLegallyElement !== undefined) {
    throw new Error("non-conceded teamResult must not carry <concededLegally>");
  }
  return {
    teamId: attr(block, "teamId") ?? "",
    score: num(teamScope, "score") ?? 0,
    conceded,
    concededLegally: conceded ? bool(teamScope, "concededLegally") : undefined,
    stalled: bool(teamScope, "stalled"),
    penaltyScore: num(teamScope, "penaltyScore"),
    spectators: num(teamScope, "spectators"),
    fame: num(teamScope, "fame"),
    fanFactor: num(teamScope, "fanFactor"),
    winnings: num(teamScope, "winnings"),
    fanFactorModifier: num(teamScope, "fanFactorModifier"),
    dedicatedFansModifier: num(teamScope, "dedicatedFansModifier"),
    spirallingExpenses: num(teamScope, "spirallingExpenses"),
    pettyCashTransferred: num(teamScope, "pettyCashTransferred"),
    pettyCashUsed: num(teamScope, "pettyCashUsed"),
    teamValue: num(teamScope, "teamValue"),
    treasurySpentOnInducements: num(teamScope, "treasurySpentOnInducements"),
    casualtiesSuffered: {
      badlyHurt: integerAttr(cas, "badlyHurt"),
      seriousInjury: integerAttr(cas, "seriousInjury"),
      rip: integerAttr(cas, "rip"),
    },
    players: blocks(listInner, "playerResult").map(parsePlayerResult),
  };
}

/**
 * Parse a `FumbblResult` XML document. Throws on a malformed / non-`gameResult` document (TP-4 fail
 * loud — the `xml:result` handler quarantines rather than banking a silently-wrong result). A well-formed
 * document with zero teams still parses (returns `teams: []`) — the caller decides that's a fail.
 */
export function parseFumbblResult(xml: string): ParsedGameResult {
  const root = xml.match(/^\s*<gameResult\b([^>]*)>([\s\S]*)<\/gameResult>\s*$/);
  if (!root) throw new Error("not a FumbblResult document (no <gameResult> root)");
  const gameId = attr(root[1]!, "replayId");
  if (!gameId) throw new Error("FumbblResult <gameResult> has no replayId");
  const result: ParsedGameResult = {
    gameId,
    halves: Number(attr(root[1]!, "halves") ?? 0),
    teams: blocks(root[2]!, "teamResult").map(parseTeamResult),
  };
  if (!Number.isSafeInteger(result.halves)) throw new Error("invalid gameResult halves integer");
  validateParsedResult(result);
  return result;
}
