import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseTeamXmlMeta, readLibrary, type LibraryTeam } from "@bb/fork-ops";
import type { SessionIdentity } from "./auth/requireSession.js";

export interface TeamDetailPlayer {
  id: string;
  number: number;
  name: string;
  position: string | null;
  positionId: string;
  skills: string[];
  injuries: string[];
  spp: number;
  mng: boolean;
  status: string | null;
}

export interface TeamDetail {
  id: string;
  name: string;
  race: string;
  rerolls: number;
  apothecary: boolean;
  fanFactor: number;
  assistantCoaches: number;
  cheerleaders: number;
  treasury: number;
  teamValue: number;
  rulesetPackName: string | null;
  players: TeamDetailPlayer[];
}

export type TeamDetailEndpointResult =
  | { status: 200; body: { team: TeamDetail } }
  | { status: 401 | 404 | 500 | 503; body: { error: string } };

export interface TeamDetailDeps {
  libraryDir: string;
  teamsDir?: string;
}

const attr = (scope: string, name: string): string | undefined =>
  scope.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];

const decodeXml = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const element = (scope: string, tag: string): string | undefined => {
  const found = scope.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, "i"));
  return found ? decodeXml(found[1]!).trim() : undefined;
};

const numberElement = (scope: string, tag: string): number | undefined => {
  const value = element(scope, tag);
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const safePart = (value: string): string => value.replace(/[^\w.-]+/g, "_") || "unknown";

export function storedTeamXml(teamsDir: string, teamId: string): string | undefined {
  if (!existsSync(teamsDir)) return undefined;
  const suffix = `_${safePart(teamId)}.xml`;
  for (const file of readdirSync(teamsDir)) {
    if (!file.startsWith("team_") || !file.endsWith(suffix)) continue;
    const xml = readFileSync(join(teamsDir, file), "utf8");
    if (decodeXml(attr(xml.match(/<team\b[^>]*>/i)?.[0] ?? "", "id") ?? "") === teamId) return xml;
  }
  return undefined;
}

export const coachNamesEqual = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export const storedTeamCoach = (xml: string): string | undefined => element(xml, "coach");

export function storedTeamHasHistory(xml: string): boolean {
  if (/<(?:playerStatistics|starPlayerPoints|statistics)\b/i.test(xml)) return true;
  for (const found of xml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)) {
    const player = found[0]!;
    const status = decodeXml(attr(player.match(/<player\b[^>]*>/i)?.[0] ?? "", "status") ?? "") || null;
    if (currentSpp(player) > 0 || /<injury\b/i.test(player) || playerMng(player, status)) return true;
    if ((numberElement(player, "playedGames") ?? numberElement(player, "games") ?? 0) > 0) return true;
  }
  return /<(?:playedGames|games)>\s*[1-9]\d*\s*<\//i.test(xml);
}

function storedRosterXml(teamsDir: string, teamId: string): string | undefined {
  const file = join(dirname(teamsDir), "rosters", `roster_team_${safePart(teamId)}.xml`);
  if (!existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function positionNames(rosterXml: string | undefined): Map<string, string> {
  const positions = new Map<string, string>();
  if (!rosterXml) return positions;
  for (const found of rosterXml.matchAll(/<position\b([^>]*)>([\s\S]*?)<\/position>/gi)) {
    const id = decodeXml(attr(found[1]!, "id") ?? "");
    const name = element(found[2]!, "name");
    if (id && name) positions.set(id, name);
  }
  return positions;
}

function currentSpp(playerXml: string): number {
  const statistics = playerXml.match(/<playerStatistics\b([^>]*)>/i)?.[1];
  const fromStatistics = statistics ? Number(attr(statistics, "currentSpps")) : Number.NaN;
  if (Number.isFinite(fromStatistics)) return fromStatistics;
  const starPoints = playerXml.match(/<starPlayerPoints\b([^>]*)>/i)?.[1];
  const fromStarPoints = starPoints ? Number(attr(starPoints, "current")) : Number.NaN;
  if (Number.isFinite(fromStarPoints)) return fromStarPoints;
  return numberElement(playerXml, "spp") ?? 0;
}

function playerMng(playerXml: string, status: string | null): boolean {
  const raw = attr(playerXml.match(/<player\b[^>]*>/i)?.[0] ?? "", "mng") ??
    element(playerXml, "mng") ?? element(playerXml, "missNextGame");
  if (raw !== undefined) return raw === "1" || raw.toLowerCase() === "true";
  return status ? /^(mng|miss[ _-]?next[ _-]?game)$/i.test(status) : false;
}

export function parseStoredTeamDetail(
  xml: string,
  stored: LibraryTeam,
  rosterXml?: string,
): TeamDetail {
  const meta = parseTeamXmlMeta(xml);
  const names = positionNames(rosterXml);
  const players: TeamDetailPlayer[] = [];

  for (const found of xml.matchAll(/<player\b([^>]*)>([\s\S]*?)<\/player>/gi)) {
    const block = found[0]!;
    const opening = found[1]!;
    const positionId = element(block, "positionId") ?? decodeXml(attr(opening, "positionId") ?? "");
    const status = decodeXml(attr(opening, "status") ?? "") || null;
    const skills = [...block.matchAll(/<skill\b[^>]*>([^<]*)<\/skill>/gi)]
      .map((match) => decodeXml(match[1]!).trim())
      .filter(Boolean);
    const injuries = [...block.matchAll(/<injury\b[^>]*>([^<]*)<\/injury>/gi)]
      .map((match) => decodeXml(match[1]!).trim())
      .filter(Boolean);
    const rawNumber = Number(attr(opening, "nr") ?? attr(opening, "number"));

    players.push({
      id: decodeXml(attr(opening, "id") ?? ""),
      number: Number.isFinite(rawNumber) ? rawNumber : 0,
      name: element(block, "name") ?? "",
      position: names.get(positionId) ?? element(block, "positionName") ?? element(block, "position") ?? null,
      positionId,
      skills,
      injuries,
      spp: currentSpp(block),
      mng: playerMng(block, status),
      status,
    });
  }

  const hasTeamValue = /<(?:currentTeamValue|teamValue)>/i.test(xml);
  return {
    id: stored.teamId,
    name: element(xml, "name") ?? stored.teamName,
    race: element(xml, "race") ?? stored.race,
    rerolls: meta.rerolls ?? stored.rerolls ?? 0,
    apothecary: meta.apothecary ?? stored.apothecary ?? false,
    fanFactor: meta.fanFactor ?? stored.fanFactor ?? 0,
    assistantCoaches: numberElement(xml, "assistantCoaches") ?? 0,
    cheerleaders: numberElement(xml, "cheerleaders") ?? 0,
    treasury: /<treasury>/i.test(xml) ? meta.gold : stored.gold,
    teamValue: hasTeamValue ? meta.teamValue : stored.teamValue,
    rulesetPackName: stored.rulesetPackName ?? null,
    players,
  };
}

export function teamDetailIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/teams\/([^/]+)\/detail$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

export function teamDetailEndpoint(
  auth: SessionIdentity | undefined,
  teamId: string,
  deps: TeamDetailDeps,
): TeamDetailEndpointResult {
  if (!auth) return { status: 401, body: { error: "Authentication required." } };
  const stored = readLibrary(deps.libraryDir, auth.coach).find((team) => team.teamId === teamId);
  if (!stored || !coachNamesEqual(stored.coach, auth.coach)) {
    return { status: 404, body: { error: "Team not found." } };
  }
  if (!deps.teamsDir) {
    return { status: 503, body: { error: "Fork teams dir not configured on this host (set FORK_TEAMS_DIR)." } };
  }

  try {
    const xml = storedTeamXml(deps.teamsDir, teamId);
    if (!xml) return { status: 404, body: { error: "Stored team data not found." } };
    if (!coachNamesEqual(storedTeamCoach(xml) ?? "", auth.coach)) {
      return { status: 404, body: { error: "Team not found." } };
    }
    return {
      status: 200,
      body: { team: parseStoredTeamDetail(xml, stored, storedRosterXml(deps.teamsDir, teamId)) },
    };
  } catch {
    return { status: 500, body: { error: "Stored team data could not be read." } };
  }
}
