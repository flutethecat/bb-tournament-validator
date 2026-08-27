import { readLibrary, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import { findStar, isStarName, normName, type ComposeResult, type Roster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { coachNamesEqual, storedTeamCoach, storedTeamFile, storedTeamHasHistory } from "./teamDetail.js";

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
