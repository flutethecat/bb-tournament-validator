import { readLibrary, upsertLibraryTeam } from "@bb/fork-ops";
import type { ComposeResult, Roster } from "@bb/validator";

export type TeamBuilderBuildTarget =
  | { ok: true; teamId?: string }
  | { ok: false; status: 400 | 404; error: string };

/** Resolve an optional edit target within the authenticated coach's library. */
export function resolveTeamBuilderBuildTarget(
  libraryDir: string,
  coach: string,
  requestedTeamId: string | undefined,
): TeamBuilderBuildTarget {
  if (requestedTeamId === undefined) return { ok: true };
  const teamId = requestedTeamId.trim();
  if (!teamId) return { ok: false, status: 400, error: "teamId must be a non-empty string when supplied." };
  if (!readLibrary(libraryDir, coach).some((team) => team.teamId === teamId)) {
    return { ok: false, status: 404, error: "Team not found." };
  }
  return { ok: true, teamId };
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
  upsertLibraryTeam(libraryDir, roster.coach, {
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
    forkLoadable,
    ingestedAt,
  });
}
