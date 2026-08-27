import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseTeamXmlMeta, readLibrary, type LibraryTeam } from "@bb/fork-ops";
import { bb2025 } from "@bb/validator/dataset";
import type { SessionIdentity } from "./auth/requireSession.js";

type TeamDetailIdentity = Pick<SessionIdentity, "coach" | "organizer">;
import { pendingAdvancementForPlayer, playerProgression, runtimeSafeCharacteristicAvailable, teamRevision, type AdvancementCosts, type PendingAdvancementResponse } from "./teamAdvancement.js";

export interface Capability {
  available: boolean;
  reason?: string;
}

export interface TeamDetailPlayer {
  id: string;
  number: number;
  name: string;
  position: string | null;
  positionId: string;
  skills: string[];
  injuries: string[];
  injuryDetails: Array<{ name: string; recovering: boolean }>;
  spp: number;
  earnedSpp: number | null;
  advancements: number;
  rank: string;
  advancementCosts: AdvancementCosts | null;
  advancementMethods: Record<"randomPrimary" | "chosenPrimary" | "chosenSecondary" | "characteristic", Capability>;
  pendingAdvancement: PendingAdvancementResponse | null;
  primaryCategories: string[];
  secondaryCategories: string[];
  primarySkills: string[];
  secondarySkills: string[];
  movement: number | null;
  strength: number | null;
  agility: number | null;
  passing: number | null;
  armour: number | null;
  currentValue: number;
  mng: boolean;
  status: string | null;
  gender: string | null;
  journeyman: boolean;
  refundable: boolean;
}

export interface TeamDetailFiredPlayer {
  id: string;
  name: string;
  position: string | null;
  positionId: string;
  reason: string;
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
  leagues: string[];
  specialRules: string[];
  canEditRoster: Capability;
  revision: string;
  players: TeamDetailPlayer[];
  /** Raw stored status ("0" new / "1" active / upstream values); absent in the XML = "0". */
  teamStatus: string;
  /** The roster XML's <nameGenerator> id for name/generate; "default" when the roster carries none. */
  nameGenerator: string;
  firedPlayers: TeamDetailFiredPlayer[];
  resurrection?: boolean;
}

export type TeamDetailEndpointResult =
  | { status: 200; body: { team: TeamDetail } }
  | { status: 401 | 404 | 500 | 503; body: { error: string } };

export interface TeamDetailDeps {
  libraryDir: string;
  teamsDir?: string;
  tokenSecret?: string;
  now?: () => number;
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

export function storedTeamFile(teamsDir: string, teamId: string): { path: string; xml: string } | undefined {
  if (!existsSync(teamsDir)) return undefined;
  const suffix = `_${safePart(teamId)}.xml`;
  const matches: Array<{ path: string; xml: string }> = [];
  for (const file of readdirSync(teamsDir)) {
    if (!file.startsWith("team_") || !file.endsWith(suffix)) continue;
    const path = join(teamsDir, file);
    const xml = readFileSync(path, "utf8");
    if (decodeXml(attr(xml.match(/<team\b[^>]*>/i)?.[0] ?? "", "id") ?? "") === teamId) matches.push({ path, xml });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function storedTeamXml(teamsDir: string, teamId: string): string | undefined {
  return storedTeamFile(teamsDir, teamId)?.xml;
}

export const coachNamesEqual = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export const storedTeamCoach = (xml: string): string | undefined => element(xml, "coach");

export function storedTeamHasHistory(xml: string): boolean {
  if (/<(?:pendingAdvancement|advancement)\b/i.test(xml)) return true;
  for (const found of xml.matchAll(/<player\b[^>]*>[\s\S]*?<\/player>/gi)) {
    const player = found[0]!;
    // Intrinsic skills live in roster XML. A player-level skill is an acquired/customized player
    // state that whole-roster recomposition cannot preserve safely, even when old XML has no audit.
    if (/<skill\b/i.test(player)) return true;
    const status = decodeXml(attr(player.match(/<player\b[^>]*>/i)?.[0] ?? "", "status") ?? "") || null;
    if (currentSpp(player) > 0 || /<injury\b/i.test(player) || playerMng(player, status)) return true;
    if (/<(?:playerStatistics|starPlayerPoints)\b[^>]*(?:earnedSpps|earned)="[1-9]\d*"/i.test(player)) return true;
    if (/<(?:completions|touchdowns|interceptions|casualties|mvps|passing|rushing|blocks|fouls)>\s*[1-9]\d*\s*<\//i.test(player)) return true;
    if ((numberElement(player, "playedGames") ?? numberElement(player, "games") ?? 0) > 0) return true;
  }
  return /<(?:playedGames|games)>\s*[1-9]\d*\s*<\//i.test(xml);
}

function storedRosterXml(teamsDir: string, teamId: string, teamXml: string): string | undefined {
  const rostersDir = join(dirname(teamsDir), "rosters");
  let file = join(rostersDir, `roster_team_${safePart(teamId)}.xml`);
  if (!existsSync(file)) {
    const rosterId = element(teamXml, "rosterId");
    if (!rosterId) return undefined;
    file = join(rostersDir, `roster_${safePart(rosterId)}.xml`);
  }
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
  if (/<injury\b[^>]*\brecovering="true"/i.test(playerXml)) return true;
  const raw = attr(playerXml.match(/<player\b[^>]*>/i)?.[0] ?? "", "mng") ??
    element(playerXml, "mng") ?? element(playerXml, "missNextGame");
  if (raw !== undefined) return raw === "1" || raw.toLowerCase() === "true";
  return status ? /^(mng|miss[ _-]?next[ _-]?game)$/i.test(status) : false;
}

export function parseStoredTeamDetail(
  xml: string,
  stored: LibraryTeam,
  rosterXml?: string,
  context?: { auth: TeamDetailIdentity; tokenSecret: string; now?: number },
): TeamDetail {
  const meta = parseTeamXmlMeta(xml);
  const names = positionNames(rosterXml);
  const players: TeamDetailPlayer[] = [];
  const revision = teamRevision(xml);
  const hasAnyPending = /<pendingAdvancement\b/i.test(xml);
  const header = xml.split(/<player\b/i)[0] ?? xml;
  const teamOpening = xml.match(/<team\b[^>]*>/i)?.[0] ?? "";
  const teamStatus = (element(header, "status") ??
    decodeXml(attr(teamOpening, "status") ?? "").trim()) || "0";
  // Refunds exist only on a NEW team (raw status 0/absent) — mirrors teamMutation's refundPlayer gate.
  const teamIsNew = /^(?:|0|new)$/i.test(teamStatus.replace(/[\s_-]+/g, ""));

  for (const found of xml.matchAll(/<player\b([^>]*)>([\s\S]*?)<\/player>/gi)) {
    const block = found[0]!;
    const opening = found[1]!;
    const positionId = element(block, "positionId") ?? decodeXml(attr(opening, "positionId") ?? "");
    const status = decodeXml(attr(opening, "status") ?? "") || null;
    const skills = [...block.matchAll(/<skill\b[^>]*>([^<]*)<\/skill>/gi)]
      .map((match) => decodeXml(match[1]!).trim())
      .filter(Boolean);
    const injuryDetails = [...block.matchAll(/<injury\b([^>]*)>([^<]*)<\/injury>/gi)]
      .map((match) => ({
        name: decodeXml(match[2]!).trim(),
        recovering: attr(match[1]!, "recovering") === "true",
      }))
      .filter((injury) => injury.name.length > 0);
    const injuries = injuryDetails.map((injury) => injury.name);
    const rawNumber = Number(attr(opening, "nr") ?? attr(opening, "number"));

    const progression = playerProgression(block, rosterXml);
    const pendingAdvancement = context
      ? pendingAdvancementForPlayer(context.auth, stored.teamId, decodeXml(attr(opening, "id") ?? ""), revision, block, context.tokenSecret, context.now)
      : null;
    const unavailable = (reason: string): Capability => ({ available: false, reason });
    const spp = currentSpp(block);
    const commonReason = stored.retired
      ? "Retired teams cannot gain advancements."
      : !progression.costs
        ? (progression.rank === "Ineligible" ? "This player type cannot gain advancements." : "This player already has six advancements.")
        : hasAnyPending ? "Finish the team's pending advancement before starting another." : undefined;
    const methodReason = (method: keyof AdvancementCosts): string | undefined => {
      if (commonReason) return commonReason;
      const cost = progression.costs?.[method];
      return cost !== undefined && spp < cost ? `Needs ${cost} SPP; ${spp} available.` : undefined;
    };
    const primaryAvailable = progression.primarySkills.some((skill) => bb2025.skills[skill]?.elite !== true);
    const primaryScopeReason = "Elite Skills are unavailable until the fork runtime can represent their surcharge exactly.";
    const characteristicScopeReason = "MA, Secondary fallback, and Elite fallback results are unavailable until the fork runtime can represent them exactly.";
    const randomReason = methodReason("randomPrimary");
    const chosenReason = methodReason("chosenPrimary");
    const characteristicReason = methodReason("characteristic");
    const advancementMethods: TeamDetailPlayer["advancementMethods"] = {
      randomPrimary: randomReason ? unavailable(randomReason) : primaryAvailable ? { available: true, reason: primaryScopeReason } : unavailable("No runtime-safe non-Elite Primary Skills remain."),
      chosenPrimary: chosenReason ? unavailable(chosenReason) : primaryAvailable ? { available: true, reason: primaryScopeReason } : unavailable("No runtime-safe non-Elite Primary Skills remain."),
      chosenSecondary: commonReason ? unavailable(commonReason) : unavailable("Secondary advancements are unavailable until the fork runtime can represent their pricing exactly."),
      characteristic: characteristicReason
        ? unavailable(characteristicReason)
        : runtimeSafeCharacteristicAvailable(block, rosterXml)
          ? { available: true, reason: characteristicScopeReason }
          : unavailable("No runtime-safe Characteristic or Primary fallback remains for this player."),
    };
    players.push({
      id: decodeXml(attr(opening, "id") ?? ""),
      number: Number.isFinite(rawNumber) ? rawNumber : 0,
      name: element(block, "name") ?? "",
      position: names.get(positionId) ?? element(block, "positionName") ?? element(block, "position") ?? null,
      positionId,
      skills,
      injuries,
      injuryDetails,
      spp,
      earnedSpp: progression.earnedSpp,
      advancements: progression.advancements,
      rank: progression.rank,
      advancementCosts: progression.costs,
      advancementMethods,
      pendingAdvancement,
      primaryCategories: progression.primaryCategories,
      secondaryCategories: progression.secondaryCategories,
      primarySkills: progression.primarySkills,
      secondarySkills: progression.secondarySkills,
      movement: progression.characteristics.MA,
      strength: progression.characteristics.ST,
      agility: progression.characteristics.AG,
      passing: progression.characteristics.PA,
      armour: progression.characteristics.AV,
      currentValue: progression.currentValue,
      mng: playerMng(block, status),
      status,
      gender: element(block, "gender") ?? null,
      journeyman: status !== null && /^journeyman$/i.test(status),
      // Mirrors teamMutation's refundPlayer gate: NEW team, no acquired skills/injuries/SPP/games.
      refundable: teamIsNew && skills.length === 0 && injuries.length === 0 && spp === 0 &&
        !playerMng(block, status) &&
        !/<(?:playedGames|games)>\s*[1-9]/i.test(block),
    });
  }

  const firedPlayers: TeamDetailFiredPlayer[] = [];
  for (const found of xml.matchAll(/<firedPlayer\b([^>]*)>([\s\S]*?)<\/firedPlayer>/gi)) {
    const block = found[0]!;
    const opening = found[1]!;
    const positionId = element(block, "positionId") ?? decodeXml(attr(opening, "positionId") ?? "");
    firedPlayers.push({
      id: decodeXml(attr(opening, "id") ?? ""),
      // Fired blocks carry <firedName> (renamed so the Java SAX parser cannot take it for the team name).
      name: element(block, "firedName") ?? element(block, "name") ?? "",
      position: names.get(positionId) ?? element(block, "position") ?? null,
      positionId,
      reason: decodeXml(attr(opening, "reason") ?? "") || "fired",
    });
  }

  const hasTeamValue = /<(?:currentTeamValue|teamValue|teamRating)>/i.test(xml);
  const listValues = (scope: string, tag: string): string[] => [...scope.matchAll(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, "gi"))]
    .map((match) => decodeXml(match[1]!).trim()).filter(Boolean);
  const leagues = [...new Set([...listValues(xml, "league"), ...listValues(rosterXml ?? "", "league")])];
  const nestedRules = (scope: string): string[] => [...scope.matchAll(/<specialRules\b[^>]*>([\s\S]*?)<\/specialRules>/gi)]
    .flatMap((match) => listValues(match[1]!, "rule"));
  const specialRules = [...new Set([
    ...listValues(xml, "specialRule"),
    ...listValues(rosterXml ?? "", "specialRule"),
    ...nestedRules(xml),
    ...nestedRules(rosterXml ?? ""),
  ])];
  const canEditRoster: Capability = stored.retired
    ? { available: false, reason: "Retired teams cannot be edited." }
    : storedTeamHasHistory(xml)
      ? { available: false, reason: "Whole-roster editing is unavailable after a team has match history; use player progression instead." }
      : context?.auth.organizer === true
        ? { available: true }
        : { available: false, reason: "Whole-roster editing requires organizer access; team owners may still use player progression." };
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
    leagues,
    specialRules,
    canEditRoster,
    revision,
    players,
    teamStatus,
    nameGenerator: (rosterXml ? element(rosterXml, "nameGenerator") : undefined) ?? "default",
    firedPlayers,
    ...(attr(teamOpening, "resurrection") === "true" ? { resurrection: true } : {}),
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
  auth: TeamDetailIdentity | undefined,
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
      body: { team: parseStoredTeamDetail(xml, stored, storedRosterXml(deps.teamsDir, teamId, xml), deps.tokenSecret ? { auth, tokenSecret: deps.tokenSecret, now: deps.now?.() } : undefined) },
    };
  } catch {
    return { status: 500, body: { error: "Stored team data could not be read." } };
  }
}
