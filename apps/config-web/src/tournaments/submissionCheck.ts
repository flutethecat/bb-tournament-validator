/**
 * Tournament submission check (spec-spa-tournaments 6.3): snapshot a coach's Team Builder save (`save:<id>`, a bare
 * id, or `library:<teamId>` = the newest save linked to that library team) and validate it against the TOURNAMENT's
 * package. This is the ONE package-aware path every submission, roster lock and start goes through.
 *
 * Only base-roster sheets can be checked against a package (the dataset validator); a Secret League roster (off
 * dataset, its budget lives in the saved body) and a library team without a sheet are stored as "cannot be checked
 * automatically": unverified, for an organiser to verify by hand. Identity is the entrant's coach, never a request
 * field; saves are read from that coach's own file only.
 */

import { readSaves, type TeamBuilderSave } from "../teamBuilderSaves.js";
import type { TournamentSubmission, TournamentSubmissionValidation } from "./types.js";

export interface SubmissionCheckDeps {
  savesDir: string;
  /** Owner coach of an ACTIVE library team (case-insensitive compare is done here). */
  libraryOwner(teamId: string): string | undefined;
  libraryTeam(teamId: string): { teamName?: string; race?: string; teamValue?: number } | undefined;
  packageRevision(packageName: string): string | undefined;
  isSecretLeague(rosterId: string): boolean;
  /** Compose a base-roster builder body and validate it against the named package; throws a client-safe message on
   *  bad input; undefined when this host cannot compose (no fork teams directory). */
  validateBody(body: Record<string, unknown>, packageName: string): { ok: boolean; problems: string[] } | undefined;
}

export type SubmissionCheckResult = TournamentSubmission | { error: string; status?: 400 | 404 | 409 };

export const UNCHECKABLE_LIBRARY = "This team has no Team Builder sheet, so it cannot be checked automatically. An organiser can verify it by hand.";
export const UNCHECKABLE_SECRET_LEAGUE = "Secret League rosters cannot be checked against this tournament's ruleset automatically. An organiser can verify it by hand.";
export const UNCHECKABLE_HOST = "Team validation needs the fork teams directory on this host. An organiser can verify it by hand.";

const sameCoach = (a: string | undefined, b: string): boolean => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export function checkTournamentSubmission(
  deps: SubmissionCheckDeps,
  coach: string,
  ref: string,
  packageName: string,
  now: Date,
): SubmissionCheckResult {
  const checkedAt = now.toISOString();
  const packageRevision = (() => { try { return deps.packageRevision(packageName); } catch { return undefined; } })();
  const validation = (ok: boolean, problems: string[]): TournamentSubmissionValidation => ({
    ok, problems, checkedAt, packageName, ...(packageRevision ? { packageRevision } : {}),
  });
  const saves = readSaves(deps.savesDir, coach);
  let save: TeamBuilderSave | undefined;
  if (ref.startsWith("library:")) {
    const teamId = ref.slice("library:".length);
    if (!sameCoach(deps.libraryOwner(teamId), coach)) return { error: "That team is not in your library.", status: 400 };
    save = saves.filter((s) => s.teamId === teamId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!save) {
      const team = deps.libraryTeam(teamId);
      return {
        saveId: ref, revision: teamId, submittedAt: checkedAt, teamId,
        ...(team?.teamName ? { teamName: team.teamName } : {}),
        ...(team?.race ? { race: team.race } : {}),
        snapshot: team ? { teamId, teamName: team.teamName, race: team.race, teamValue: team.teamValue } : null,
        validation: validation(false, [UNCHECKABLE_LIBRARY]),
      };
    }
  } else {
    const id = ref.startsWith("save:") ? ref.slice("save:".length) : ref;
    save = saves.find((s) => s.id === id);
    if (!save) return { error: "Team Builder save not found.", status: 404 };
  }
  const teamId = save.teamId && sameCoach(deps.libraryOwner(save.teamId), coach) ? save.teamId : undefined;
  const base = {
    saveId: `save:${save.id}`, revision: save.updatedAt, submittedAt: checkedAt,
    ...(teamId ? { teamId } : {}),
    teamName: save.name, ...(save.raceName ? { race: save.raceName } : {}),
    snapshot: { ...save.body, packageName: save.packageName },
  };
  const rosterId = typeof save.body.rosterId === "string" ? save.body.rosterId : save.rosterId;
  if (rosterId && deps.isSecretLeague(rosterId)) return { ...base, validation: validation(false, [UNCHECKABLE_SECRET_LEAGUE]) };
  try {
    const body = { ...save.body, coach, teamName: String(save.body.teamName || save.name), packageName };
    const result = deps.validateBody(body, packageName);
    if (!result) return { ...base, validation: validation(false, [UNCHECKABLE_HOST]) };
    return { ...base, validation: validation(result.ok && result.problems.length === 0, result.problems) };
  } catch (e) {
    return { ...base, validation: validation(false, [(e as Error).message]) };
  }
}
