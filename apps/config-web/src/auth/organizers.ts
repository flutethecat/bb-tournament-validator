// Legacy organiser list (organizers.json). Retired as a permission source (registration spec 2026-11-02, Q14): its names
// are imported into identity levels ONCE at startup (importLegacyOrganizers, before the server listens), a marker under
// FORK_STATE_DIR stops it running again, and coachLevel (src/auth/access.ts) reads identity levels only. Law 4: the
// import writes through the identities writer (upsertIdentity), never by editing identities.json.
//
// The file is still read by the privacy export (legacyOrganiser flag) and cleaned by account deletion; nothing else.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { MAX_FFB_COACH_ID_LENGTH, normalizeFfbCoachId, readIdentitiesStrict, upsertIdentity } from "./identitiesStore.js";

const DEFAULT_ORGANIZERS_FILE = fileURLToPath(new URL("../../organizers.json", import.meta.url));

export function organizersFile(): string {
  return process.env.ORGANIZERS_FILE ? resolve(process.env.ORGANIZERS_FILE) : DEFAULT_ORGANIZERS_FILE;
}

/** The marker the one-time import writes (counts only, no names). */
export const legacyOrganizersMarker = (stateDir: string): string => join(stateDir, "legacy-organizers-imported.json");

/** The actor stamped on identity records the import elevates (updatedBy). */
export const LEGACY_IMPORT_ACTOR = "legacy-organizers-import";

/**
 * The names in organizers.json. undefined = the file does not exist; throws when it exists but cannot be read or is not
 * `{ "organizers": string[] }` (the import then leaves no marker, so it retries on the next start).
 */
export function readLegacyOrganizerNames(file = organizersFile()): string[] | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const parsed = JSON.parse(text) as { organizers?: unknown } | null;
  const list = parsed && typeof parsed === "object" ? parsed.organizers : undefined;
  if (!Array.isArray(list) || list.some((name) => typeof name !== "string")) throw new Error("organizers.json must be { \"organizers\": string[] }.");
  return list as string[];
}

export interface LegacyImportResult {
  /** "imported" (ran now), "already" (marker found), "failed" (nothing or only part applied; retried next start). */
  status: "imported" | "already" | "failed";
  elevated: number;
  unchanged: number;
  skipped: number;
}

function writeMarker(marker: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(marker), { recursive: true });
  atomicWriteTextFile(marker, `${JSON.stringify({ version: 1, ...value }, null, 2)}
`);
}

/**
 * One-time, idempotent import of organizers.json into identity levels. Each name (identity key: trim + lower case, the
 * same fold the legacy reader used) is handled once per coach and the result is recorded ON the identity record
 * (legacyOrganiserImported): a player record is raised to organiser, an organiser or admin record keeps its level, and a
 * coach with no record gets a minimal record at organiser (so nobody who had rights through the file loses them). A
 * record that already carries legacyOrganiserImported is never touched again, so losing the marker can never re-grant a
 * level an admin removed later. A banned coach's record is raised too (coachLevel still answers "player" while banned,
 * exactly as the legacy bridge did). A name the identities writer refuses (a reserved pseudonym, a coach whose deletion
 * is running) is skipped.
 *
 * The marker is written as "running" BEFORE any identity write (a failure there aborts the import with nothing
 * applied) and as "done" after every name was handled; a "running" marker resumes on the next start (safe: per-coach
 * records stop any re-grant).
 */
export function importLegacyOrganizers(stateDir: string, options: { file?: string; now?: Date; log?: (line: string) => void } = {}): LegacyImportResult {
  const log = options.log ?? ((line: string) => console.log(line));
  const file = options.file ?? organizersFile();
  const marker = legacyOrganizersMarker(stateDir);
  const result: LegacyImportResult = { status: "already", elevated: 0, unchanged: 0, skipped: 0 };
  if (existsSync(marker)) {
    let done = false;
    try { done = (JSON.parse(readFileSync(marker, "utf8")) as { status?: unknown }).status !== "running"; } catch { done = false; }
    if (done) {
      if (existsSync(file)) log("[organizers] organizers.json is deprecated and no longer read for permissions (imported into identity levels); it can be removed.");
      return result;
    }
  }
  let names: string[] | undefined;
  try {
    names = readLegacyOrganizerNames(file);
    readIdentitiesStrict(); // an unreadable identities store must never be rewritten from an empty read
  } catch (e) {
    log(`[organizers] legacy organiser import failed, retried on the next start: ${(e as Error).message}`);
    return { ...result, status: "failed" };
  }
  const at = (options.now ?? new Date()).toISOString();
  try {
    writeMarker(marker, { status: "running", startedAt: at });
  } catch (e) {
    log(`[organizers] legacy organiser import aborted (its marker could not be written), nothing applied, retried on the next start: ${(e as Error).message}`);
    return { ...result, status: "failed" };
  }
  const seen = new Set<string>();
  for (const raw of names ?? []) {
    const name = raw.trim();
    const key = normalizeFfbCoachId(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (name.length > MAX_FFB_COACH_ID_LENGTH) { result.skipped++; continue; }
    try {
      const stored = readIdentitiesStrict().coaches[key];
      if (stored?.legacyOrganiserImported) { result.unchanged++; continue; } // handled once already: never re-applied
      if (stored && stored.level !== "player") {
        upsertIdentity({ ...stored, legacyOrganiserImported: at });
        result.unchanged++;
        continue;
      }
      upsertIdentity(stored
        ? { ...stored, level: "organizer", legacyOrganiserImported: at, updatedAt: at, updatedBy: LEGACY_IMPORT_ACTOR }
        : { ffbCoachId: name, level: "organizer", banned: false, silenced: false, note: "", profile: {}, identities: {}, legacyOrganiserImported: at, updatedAt: at, updatedBy: LEGACY_IMPORT_ACTOR });
      result.elevated++;
    } catch {
      result.skipped++;
    }
  }
  try {
    writeMarker(marker, { status: "done", importedAt: at, source: names ? "organizers.json" : "absent", elevated: result.elevated, unchanged: result.unchanged, skipped: result.skipped });
  } catch (e) {
    log(`[organizers] legacy organiser import ran but its marker could not be finished; it resumes next start and changes nothing already imported: ${(e as Error).message}`);
    return { ...result, status: "failed" };
  }
  log(`[organizers] imported organizers.json into identity levels: ${result.elevated} raised, ${result.unchanged} already organisers or admins, ${result.skipped} skipped. The file is no longer read for permissions.`);
  return { ...result, status: "imported" };
}
