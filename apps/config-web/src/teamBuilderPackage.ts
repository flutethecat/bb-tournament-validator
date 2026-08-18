import { resolveTeamConfig, type TournamentPackage } from "@bb/validator";
import type { PackageFiles } from "./data.js";

/** What preview/build validate against, plus (when a tournament package was
 *  explicitly selected) the info the client needs to render the ruleset note
 *  and auto-populate the budget field. */
export interface ResolvedBuilderPackage {
  pkg: TournamentPackage;
  /** Set only when `packageName` was supplied and resolved — omitted for the baseline. */
  selected?: { name: string; description?: string };
}

/**
 * Resolve the package a team-builder request validates against.
 *   - `packageName` omitted → the standalone baseline (byte-identical to pre-tournament-mode
 *     callers; `selected` is absent so the response carries no `package` echo).
 *   - `packageName` set but unknown → `{ error }` (never silently falls back to baseline —
 *     a tournament-mode caller asking for a specific ruleset must get a clear 4xx, not a
 *     roster validated against the wrong rules).
 *   - `packageName` set and found → that package, `selected` populated for the response.
 */
export function resolveBuilderPackage(
  packages: PackageFiles,
  baseline: TournamentPackage,
  packageName: string | undefined,
): ResolvedBuilderPackage | { error: string } {
  if (!packageName) return { pkg: baseline };
  const found = packages.get(packageName);
  if (!found) return { error: `Unknown tournament package "${packageName}".` };
  return { pkg: found.pkg, selected: { name: found.pkg.name, description: found.pkg.description } };
}

/** The `package` field to echo on a preview/build response — the resolved package's
 *  display name/note plus the per-roster budget for THIS composed team's race (tier/matrix/
 *  team-rule aware via resolveTeamConfig). Undefined when no package was selected, so
 *  existing (non-tournament) callers see no shape change. */
export function packageResponseInfo(
  resolved: ResolvedBuilderPackage,
  raceName: string,
): { name: string; description?: string; budget: number | null } | undefined {
  if (!resolved.selected) return undefined;
  const cfg = resolveTeamConfig(resolved.pkg, raceName);
  return { name: resolved.selected.name, description: resolved.selected.description, budget: cfg.gold };
}
