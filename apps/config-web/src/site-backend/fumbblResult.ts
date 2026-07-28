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
 * ⚠ FIDELITY: `starPlayerPoints @current` is the AUTHORITATIVE post-game SPP TOTAL the server computed
 * (`PlayerResult.getCurrentSpps()`), and `@earned` is that game's gain. The banker SETS current, it does
 * not add earned to a local base — that is CE-1 (bank the server's number, never recompute).
 */

/** A single `<playerResult>` (`FumbblResult.java:330-440`). Absent optional counters default to 0. */
export interface ParsedPlayerResult {
  playerId: string;
  playerType?: string;
  positionId?: string;
  name?: string;
  gender?: string;
  defecting: boolean;
  /** `<starPlayerPoints @current>` — the AUTHORITATIVE new total (set, don't add). undefined ⇒ no SPP block. */
  currentSpps?: number;
  /** `<starPlayerPoints @earned>` — this game's gain (for audit/logging; banking uses current). */
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

const attr = (s: string, name: string): string | undefined =>
  s.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** `<tag>text</tag>` — first occurrence within `scope`. Value is XML-unescaped. */
const el = (scope: string, tag: string): string | undefined => {
  const m = scope.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return m ? unescapeXml(m[1]!) : undefined;
};

const num = (scope: string, tag: string): number | undefined => {
  const v = el(scope, tag);
  return v === undefined ? undefined : Number(v);
};

/** Element value coerced to a boolean the way `UtilXml.addValueElement(boolean)` emits it ("true"/"false"). */
const bool = (scope: string, tag: string): boolean => el(scope, tag)?.trim().toLowerCase() === "true";

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
  while ((m = re.exec(scope))) out.push(m[0]!);
  return out;
}

function parsePlayerResult(block: string): ParsedPlayerResult {
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
  const sp = block.match(/<starPlayerPoints\b([^>]*)>/);
  if (!sp) return undefined;
  const v = attr(sp[1]!, name);
  return v === undefined ? undefined : Number(v);
}

function parseTeamResult(block: string): ParsedTeamResult {
  // Player results live inside <playerResultList> — isolate it so team-level counters (e.g. `casualties`
  // as a player stat) aren't confused with team fields. Team fields sit BEFORE the list.
  const listMatch = block.match(/<playerResultList\b[^>]*>([\s\S]*?)<\/playerResultList>/);
  const listInner = listMatch?.[1] ?? "";
  const teamScope = listMatch ? block.slice(0, block.indexOf(listMatch[0])) : block;
  const cas = teamScope.match(/<casualtiesSuffered\b([^>]*)\/>/)?.[1] ?? "";
  const conceded = bool(teamScope, "conceded");
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
      badlyHurt: Number(attr(cas, "badlyHurt") ?? 0),
      seriousInjury: Number(attr(cas, "seriousInjury") ?? 0),
      rip: Number(attr(cas, "rip") ?? 0),
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
  const root = xml.match(/<gameResult\b([^>]*)>([\s\S]*)<\/gameResult>/);
  if (!root) throw new Error("not a FumbblResult document (no <gameResult> root)");
  const gameId = attr(root[1]!, "replayId");
  if (!gameId) throw new Error("FumbblResult <gameResult> has no replayId");
  return {
    gameId,
    halves: Number(attr(root[1]!, "halves") ?? 0),
    teams: blocks(root[2]!, "teamResult").map(parseTeamResult),
  };
}
