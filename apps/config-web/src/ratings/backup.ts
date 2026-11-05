// Backups of the site ratings state (admin console v2, owner 11-04: "The ratings reset must take a BACKUP first, so it can
// be RESTORED"). The reset changes exactly one file, <state dir>/site-ratings.json (src/ratings/state.ts); a backup keeps
// that file's exact text (or the fact that it did not exist) in <state dir>/backups/ratings/site-ratings-<UTC stamp>.json.
// Restoring writes the kept text back byte for byte (or removes the file when it did not exist), after taking a backup of
// the state it replaces, so a restore can itself be undone. No personal data: the state file holds only the reset time.
//
// Used by POST /api/admin/ops/ratings/{reset,restore} (src/admin/console.ts) and scripts/reset-ratings.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { ratingsStateFile, readRatingsState, writeRatingsReset, type RatingsState } from "./state.js";

export const RATINGS_BACKUP_KIND = "site-ratings-backup";
/** site-ratings-20261104T101500123Z.json (UTC, milliseconds), plus -<n> when two land in the same millisecond. */
export const RATINGS_BACKUP_NAME = /^site-ratings-\d{8}T\d{9}Z(?:-\d{1,3})?\.json$/;

export interface RatingsBackupFile {
  kind: typeof RATINGS_BACKUP_KIND;
  version: 1;
  createdAt: string;
  /** Why it was taken: "before-reset", "before-restore" or "manual". */
  reason: string;
  /** The state file's name inside the state dir. */
  file: "site-ratings.json";
  existed: boolean;
  /** The file's exact text, or null when it did not exist. */
  content: string | null;
}

export interface RatingsBackupInfo { name: string; createdAt: string; size: number; reason: string; existed: boolean; resetAt: string | null }

export const ratingsBackupDir = (stateDir: string): string => join(stateDir, "backups", "ratings");

const stampOf = (at: Date): string => at.toISOString().replace(/[-:.]/g, "");

/** The state file's exact text, or null when absent. Any other read error throws (fail closed). */
function currentText(stateDir: string): string | null {
  try { return readFileSync(ratingsStateFile(stateDir), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}

/** Parses a reset time out of a state file's text without throwing (a backup may hold a file the reader would refuse). */
function resetAtOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Partial<RatingsState>;
    return typeof raw?.resetAt === "string" ? raw.resetAt : null;
  } catch { return null; }
}

/** Writes a backup of the current state and returns it. Throws when the state can't be read or the backup can't be written. */
export function backupRatingsState(stateDir: string, at: Date, reason: string): RatingsBackupInfo {
  const content = currentText(stateDir);
  const dir = ratingsBackupDir(stateDir);
  mkdirSync(dir, { recursive: true });
  let name = `site-ratings-${stampOf(at)}.json`;
  for (let n = 1; existsSync(join(dir, name)); n++) {
    if (n > 999) throw new Error("Too many ratings backups in the same millisecond.");
    name = `site-ratings-${stampOf(at)}-${n}.json`;
  }
  const backup: RatingsBackupFile = { kind: RATINGS_BACKUP_KIND, version: 1, createdAt: at.toISOString(), reason, file: "site-ratings.json", existed: content !== null, content };
  const text = `${JSON.stringify(backup, null, 2)}\n`;
  atomicWriteTextFile(join(dir, name), text);
  // read it back: a backup that does not round-trip is not a backup
  const check = readRatingsBackup(stateDir, name);
  if (check.content !== content) throw new Error("The ratings backup did not read back the same; nothing was changed.");
  return { name, createdAt: backup.createdAt, size: Buffer.byteLength(text), reason, existed: backup.existed, resetAt: resetAtOf(content) };
}

/** One backup by name (strict: an unknown name, a missing file or a malformed one throws). */
export function readRatingsBackup(stateDir: string, name: string): RatingsBackupFile {
  return loadRatingsBackup(stateDir, name).file;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** A backup read ONCE from disk: the parsed file and the sha-256 of the exact bytes that were parsed. */
function loadRatingsBackup(stateDir: string, name: string): { file: RatingsBackupFile; sha: string } {
  if (!RATINGS_BACKUP_NAME.test(name)) throw new RatingsBackupError(400, "Unknown backup.");
  let bytes: Buffer;
  try { bytes = readFileSync(join(ratingsBackupDir(stateDir), name)); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") throw new RatingsBackupError(404, "No such backup.");
    throw e;
  }
  let raw: Partial<RatingsBackupFile>;
  try { raw = JSON.parse(bytes.toString("utf8")) as Partial<RatingsBackupFile>; } catch { throw new RatingsBackupError(422, `${name} is not a ratings backup.`); }
  if (!raw || raw.kind !== RATINGS_BACKUP_KIND || raw.version !== 1 || raw.file !== "site-ratings.json" || typeof raw.existed !== "boolean"
    || (raw.existed ? typeof raw.content !== "string" : raw.content !== null) || typeof raw.createdAt !== "string") {
    throw new RatingsBackupError(422, `${name} is not a ratings backup.`);
  }
  return {
    file: { kind: RATINGS_BACKUP_KIND, version: 1, createdAt: raw.createdAt, reason: String(raw.reason ?? ""), file: "site-ratings.json", existed: raw.existed, content: raw.content ?? null },
    sha: sha256(bytes),
  };
}

/**
 * The restore revision (Sol P2, 11-04): binds the live state file's exact content, the backup's name and a hash of the
 * backup's exact bytes, so an apply refuses (409) if the live ratings OR the chosen backup changed after the dry run.
 */
export function ratingsRestoreRevision(liveText: string | null, name: string, backupSha: string): string {
  return sha256([liveText === null ? "absent" : `live:${sha256(liveText)}`, name, backupSha].join("|")).slice(0, 32);
}

export class RatingsBackupError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Every backup, newest first. Files that are not backups are skipped (listed as unreadable is not useful to restore). */
export function listRatingsBackups(stateDir: string): RatingsBackupInfo[] {
  const dir = ratingsBackupDir(stateDir);
  let names: string[];
  try { names = readdirSync(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const out: RatingsBackupInfo[] = [];
  for (const name of names) {
    if (!RATINGS_BACKUP_NAME.test(name)) continue;
    try {
      const b = readRatingsBackup(stateDir, name);
      out.push({ name, createdAt: b.createdAt, size: statSync(join(dir, name)).size, reason: b.reason, existed: b.existed, resetAt: resetAtOf(b.content) });
    } catch { /* not a backup: skipped */ }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export interface RatingsRestorePlan {
  backup: string;
  /** The live state now (exact text, or null when there is no file). */
  current: { existed: boolean; resetAt: string | null };
  /** What the restore would leave. */
  restored: { existed: boolean; resetAt: string | null };
  /** False when the live file already matches the backup byte for byte. */
  changes: boolean;
  /** Binds the live file, the backup name and the backup bytes; an apply must send it back (409 on any change). */
  revision: string;
}

function planFrom(stateDir: string, name: string, loaded: { file: RatingsBackupFile; sha: string }): RatingsRestorePlan {
  const now = currentText(stateDir);
  return {
    backup: name,
    current: { existed: now !== null, resetAt: resetAtOf(now) },
    restored: { existed: loaded.file.existed, resetAt: resetAtOf(loaded.file.content) },
    changes: now !== loaded.file.content,
    revision: ratingsRestoreRevision(now, name, loaded.sha),
  };
}

/** The dry run of a restore: what would change. Writes nothing. */
export function planRatingsRestore(stateDir: string, name: string): RatingsRestorePlan {
  return planFrom(stateDir, name, loadRatingsBackup(stateDir, name));
}

/**
 * Restores a backup: first backs up the live state ("before-restore"), then writes the backup's exact text (or removes the
 * file when the backup says it did not exist). The restored text must parse as a ratings state, or nothing changes.
 * `expectedRevision` (the dry run's): the backup is read once, its bytes hashed, and the revision recomputed from that
 * read and the live file; any mismatch is a 409 and nothing is written. The bytes checked are the bytes restored.
 */
export function restoreRatingsBackup(stateDir: string, name: string, at: Date, expectedRevision?: string): { restored: RatingsRestorePlan; safety: RatingsBackupInfo } {
  const loaded = loadRatingsBackup(stateDir, name);
  const backup = loaded.file;
  if (backup.content !== null) {
    // the same checks readRatingsState makes, before anything is written
    let ok = false;
    try {
      const parsed = JSON.parse(backup.content) as Partial<RatingsState>;
      ok = Boolean(parsed) && typeof parsed === "object" && parsed.version === 1
        && (parsed.resetAt === undefined || (typeof parsed.resetAt === "string" && Number.isFinite(Date.parse(parsed.resetAt))));
    } catch { ok = false; }
    if (!ok) throw new RatingsBackupError(422, `${name} holds a ratings file this site cannot read; nothing was changed.`);
  }
  const plan = planFrom(stateDir, name, loaded);
  if (expectedRevision !== undefined && expectedRevision !== plan.revision) {
    throw new RatingsBackupError(409, "The ratings or the backup changed since the dry run. Run it again.");
  }
  const safety = backupRatingsState(stateDir, at, "before-restore");
  const file = ratingsStateFile(stateDir);
  if (backup.content === null) {
    try { unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e; }
  } else {
    atomicWriteTextFile(file, backup.content);
  }
  readRatingsState(stateDir); // the restored file reads (it parsed above; this is the reader the site uses)
  return { restored: plan, safety };
}

/** The reset with its backup: the backup is written (and read back) first; no backup, no reset. */
export function resetRatingsWithBackup(stateDir: string, at: Date): { state: RatingsState; backup: RatingsBackupInfo } {
  readRatingsState(stateDir); // an unreadable state file stops the reset (fail closed) before anything is written
  const backup = backupRatingsState(stateDir, at, "before-reset");
  return { state: writeRatingsReset(stateDir, at), backup };
}
