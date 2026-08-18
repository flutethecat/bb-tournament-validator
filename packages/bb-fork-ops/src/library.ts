/**
 * A coach's fork team library — the set of teams they've ingested and can pick from
 * when creating a game. Stored as one JSON file per coach under a base dir (chosen over
 * a fork-DB table so the Bot owns its own metadata without a schema migration on the
 * fork's DB; the authoritative team XML still lives in the fork's teams/ dir). The
 * teams persist permanently (they survive a fork rebuild as long as the XML files and
 * these library rows are kept) — the deliberate v1 choice, see the resume-prompt notes.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safe } from "./util.js";

export interface LibraryTeam {
  /** FUMBBL team id (string) — primary key within a coach's library. */
  teamId: string;
  teamName: string;
  /** FUMBBL roster name, e.g. "Gnome". */
  race: string;
  /** Owning fork coach name (the library key). */
  coach: string;
  /** TV in thousands (see parseTeamXmlMeta). */
  teamValue: number;
  /** Treasury (raw gold). */
  gold: number;
  rerolls?: number;
  fanFactor?: number;
  apothecary?: boolean;
  /** false ⇒ no matching fork roster loaded; the client warns but still lists it. */
  forkLoadable: boolean;
  ingestedAt: string;
}

const fileFor = (baseDir: string, coach: string): string => join(baseDir, `${safe(coach).toLowerCase()}.json`);

/** Read a coach's library (empty array if none / unreadable). */
export function readLibrary(baseDir: string, coach: string): LibraryTeam[] {
  const file = fileFor(baseDir, coach);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as LibraryTeam[]) : [];
  } catch {
    return [];
  }
}

/** Insert or replace a team in a coach's library (keyed on teamId); returns the new list. */
export function upsertLibraryTeam(baseDir: string, coach: string, team: LibraryTeam): LibraryTeam[] {
  mkdirSync(baseDir, { recursive: true });
  const teams = readLibrary(baseDir, coach).filter((t) => t.teamId !== team.teamId);
  teams.push(team);
  teams.sort((a, b) => a.teamName.localeCompare(b.teamName));
  writeFileSync(fileFor(baseDir, coach), JSON.stringify(teams, null, 2), "utf8");
  return teams;
}

/** Remove a team from a coach's library by teamId; returns the new list. */
export function removeLibraryTeam(baseDir: string, coach: string, teamId: string): LibraryTeam[] {
  const teams = readLibrary(baseDir, coach).filter((t) => t.teamId !== teamId);
  if (existsSync(baseDir)) writeFileSync(fileFor(baseDir, coach), JSON.stringify(teams, null, 2), "utf8");
  return teams;
}

/** List every coach that has a library file (used only for housekeeping/debugging). */
export function libraryCoaches(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

/**
 * Find an existing team whose name collides with `teamName`, across EVERY coach's
 * library (FUMBBL team names are globally unique, not per-coach — see the duplicate-name
 * guard on team creation in config-web's server.ts). Comparison is trimmed + case-insensitive.
 * `excludeTeamId` lets a resubmission/update of the SAME team pass through without
 * tripping on its own existing row.
 */
export function findLibraryTeamByName(
  baseDir: string,
  teamName: string,
  excludeTeamId?: string,
): LibraryTeam | undefined {
  const want = teamName.trim().toLowerCase();
  for (const coach of libraryCoaches(baseDir)) {
    for (const t of readLibrary(baseDir, coach)) {
      if (t.teamId === excludeTeamId) continue;
      if (t.teamName.trim().toLowerCase() === want) return t;
    }
  }
  return undefined;
}
