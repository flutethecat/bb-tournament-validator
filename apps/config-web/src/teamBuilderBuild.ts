import { readLibrary, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import { findStar, isStarName, normName, type ComposeResult, type Roster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { coachNamesEqual, storedTeamCoach, storedTeamFile, storedTeamHasHistory } from "./teamDetail.js";
import { expandPickNames } from "./playerNames.js";

export type TeamBuilderBuildTarget =
  | { ok: true; teamId?: string; path?: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Resolve an optional edit target within the authenticated coach's library. */
export function resolveTeamBuilderBuildTarget(
  libraryDir: string,
  teamsDir: string,
  coach: string,
  requestedTeamId: string | undefined,
): TeamBuilderBuildTarget {
  if (requestedTeamId === undefined) return { ok: true };
  const teamId = requestedTeamId.trim();
  if (!teamId) return { ok: false, status: 400, error: "teamId must be a non-empty string when supplied." };
  const stored = readLibrary(libraryDir, coach).find((team) => team.teamId === teamId);
  if (!stored || !coachNamesEqual(stored.coach, coach)) {
    return { ok: false, status: 404, error: "Team not found." };
  }
  try {
    const teamFile = storedTeamFile(teamsDir, teamId);
    if (!teamFile || !coachNamesEqual(storedTeamCoach(teamFile.xml) ?? "", coach)) {
      return { ok: false, status: 404, error: "Team not found." };
    }
    if (stored.retired) return { ok: false, status: 409, error: "Retired teams can't be edited." };
    if (storedTeamHasHistory(teamFile.xml)) {
      return {
        ok: false,
        status: 409,
        error: "This team has match history; editing played teams isn't supported yet.",
      };
    }
    return { ok: true, teamId, path: teamFile.path };
  } catch {
    return { ok: false, status: 404, error: "Team not found." };
  }
}

/** Keep freshly minted player ids, but make the composed XML overwrite the requested team. */
export function retargetComposedTeam<T extends ComposeResult>(composed: T, teamId: string | undefined): T {
  if (!teamId) return composed;
  const root = `<team id="${composed.teamId}">`;
  if (!composed.xml.includes(root)) throw new Error("Composed team XML is missing its team id.");
  return { ...composed, teamId, xml: composed.xml.replace(root, `<team id="${teamId}">`) };
}

const xmlText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** Roster Builder player names (owner 11-01): the composer writes "<Position> <n>" for every player; a name the coach
 *  kept on the pick (`names[i]`, cleaned) replaces it in the team XML, matched by player order. Untouched when the
 *  composed players don't line up one-to-one with the picks. Stars are never renamed: a player whose composed name
 *  isn't "<Position> <n>" (the composer writes a star's own name) or whose position is a star keeps its name, whatever
 *  names[] says. */
export function applyPickNames<T extends ComposeResult>(composed: T, picks: unknown): T {
  const names = expandPickNames(picks);
  if (!names.some(Boolean)) return composed;
  const re = /(<player nr="\d+"[^>]*><name>)([^<]*)(<\/name>)/g;
  const found = composed.xml.match(re)?.length ?? 0;
  if (found !== names.length) return composed;
  const positions = composed.roster.players.map((p) => p.positionName);
  let i = 0;
  const xml = composed.xml.replace(re, (whole, open: string, old: string, close: string) => {
    const at = i++;
    const name = names[at] ?? "";
    const position = positions[at] ?? "";
    const star = !/\s\d+$/.test(old) || (position !== "" && isStarName(bb2025, position));
    return name && !star ? `${open}${xmlText(name)}${close}` : whole;
  });
  return { ...composed, xml };
}

export function registerBuiltTeam(
  libraryDir: string,
  roster: Roster,
  teamId: string,
  totalGold: number,
  ingestedAt: string,
  forkLoadable: boolean,
  rulesetPackName?: string,
): void {
  // Stamp before reload at the call site so forkLoadable reflects this exact write.
  upsertLibraryTeam(libraryDir, roster.coach, builtLibraryTeam(
    roster, teamId, totalGold, ingestedAt, forkLoadable, rulesetPackName,
  ));
}

export function builtLibraryTeam(
  roster: Roster,
  teamId: string,
  totalGold: number,
  ingestedAt: string,
  forkLoadable: boolean,
  rulesetPackName?: string,
): LibraryTeam {
  const rosteredInducements = roster.inducements.map((inducement) => ({
    key: inducement.id?.trim() || normName(inducement.name).replace(/ /g, "_"),
    count: inducement.count ?? 1,
  }));
  const rosteredStars = roster.players
    .filter((player) => isStarName(bb2025, player.positionName))
    .map((player) => findStar(bb2025, player.positionName)?.name ?? player.positionName);
  return {
    teamId,
    teamName: roster.teamName,
    race: roster.rosterName,
    coach: roster.coach,
    teamValue: Math.round(totalGold / 1000),
    gold: 0,
    rerolls: roster.sideline.reRolls,
    fanFactor: roster.sideline.dedicatedFans,
    apothecary: roster.sideline.apothecary,
    rulesetPackName,
    ...(rosteredInducements.length ? { rosteredInducements } : {}),
    ...(rosteredStars.length ? { rosteredStars } : {}),
    forkLoadable,
    ingestedAt,
  };
}
