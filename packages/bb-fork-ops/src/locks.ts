import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safe } from "./util.js";

const DEFAULT_STALE_MS = 5 * 60 * 1000;

interface LockRecord {
  token: string;
  pid: number;
  createdAt: number;
}

export interface FileWriteLock {
  path: string;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(path: string): LockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Partial<LockRecord>;
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || !Number.isFinite(value.createdAt)) return undefined;
    return value as LockRecord;
  } catch {
    return undefined;
  }
}

/** Atomic cross-process lock. A stale lock is stolen only when its owner PID is no longer alive. */
export function acquireFileWriteLock(path: string, now = Date.now(), staleMs = DEFAULT_STALE_MS): FileWriteLock | undefined {
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "owner.json"), JSON.stringify({ token, pid: process.pid, createdAt: now } satisfies LockRecord), "utf8");
      return {
        path,
        release(): void {
          const current = readRecord(path);
          if (current?.token === token) rmSync(path, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let oldEnough = false;
      try {
        oldEnough = now - statSync(path).mtimeMs >= staleMs;
      } catch {
        continue;
      }
      const owner = readRecord(path);
      // A valid record whose PID is definitely gone is safe to recover immediately after a
      // process crash. The age threshold is only needed when ownership is unreadable/ambiguous.
      if ((owner && processIsAlive(owner.pid)) || (!owner && !oldEnough)) return undefined;
      const stalePath = `${path}.stale-${token}`;
      try {
        renameSync(path, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function teamWriteLockPath(teamsDir: string, teamId: string): string {
  return join(teamsDir, ".team-write-locks", `${safe(teamId)}.lock`);
}

export function forkCacheReloadMarkerPath(teamsDir: string): string {
  return join(teamsDir, ".fork-cache-reload-required.json");
}

export function pendingGameResultsMarkerPath(teamsDir: string): string {
  return join(teamsDir, ".fork-pending-game-results.json");
}

export function pendingGameResultsWriteLockPath(teamsDir: string): string {
  return join(teamsDir, ".pending-game-results.lock");
}

export function acquirePendingGameResultsWriteLock(teamsDir: string, now = Date.now()): FileWriteLock | undefined {
  return acquireFileWriteLock(pendingGameResultsWriteLockPath(teamsDir), now);
}

/** Cache/disk generation itself is unresolved, excluding the independent pending-results gate. */
export function forkCacheGenerationReloadRequired(teamsDir: string): boolean {
  return existsSync(forkCacheReloadMarkerPath(teamsDir));
}

export function forkCacheReloadRequired(teamsDir: string): boolean {
  return forkCacheGenerationReloadRequired(teamsDir) || existsSync(pendingGameResultsMarkerPath(teamsDir));
}

export function markForkCacheReloadRequired(teamsDir: string, reason: string): void {
  atomicWriteTextFile(forkCacheReloadMarkerPath(teamsDir), JSON.stringify({ at: new Date().toISOString(), reason }));
}

export function acknowledgeForkCacheReload(teamsDir: string): void {
  const path = forkCacheReloadMarkerPath(teamsDir);
  if (existsSync(path)) unlinkSync(path);
}

/** Independent gate: transaction/cache acknowledgement must never erase queued one-shot results. */
export function markPendingGameResults(teamsDir: string, reason: string): void {
  atomicWriteTextFile(pendingGameResultsMarkerPath(teamsDir), JSON.stringify({ at: new Date().toISOString(), reason }));
}

export function acknowledgePendingGameResults(teamsDir: string): void {
  const path = pendingGameResultsMarkerPath(teamsDir);
  if (existsSync(path)) unlinkSync(path);
}

export function acquireTeamWriteLock(
  teamsDir: string,
  teamId: string,
  now = Date.now(),
  allowCacheIncoherent = false,
): FileWriteLock | undefined {
  if (!allowCacheIncoherent && forkCacheReloadRequired(teamsDir)) return undefined;
  return acquireFileWriteLock(teamWriteLockPath(teamsDir, teamId), now);
}

export function teamNameWriteLockPath(teamsDir: string): string {
  return join(teamsDir, ".global-team-name.lock");
}

/** Serializes the final global-name recheck and commit across different team ids/coaches. */
export function acquireTeamNameWriteLock(teamsDir: string, now = Date.now()): FileWriteLock | undefined {
  return acquireFileWriteLock(teamNameWriteLockPath(teamsDir), now);
}

export function libraryWriteLockPath(baseDir: string, coach: string): string {
  return join(baseDir, ".library-write-locks", `${safe(coach).toLowerCase()}.lock`);
}

/** Same-directory write + rename. Callers must hold the resource's write lock. */
export function atomicWriteTextFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, "w");
    try {
      writeFileSync(fd, value, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    // A file fsync alone does not make the directory entry durable on filesystems that
    // require an explicit directory flush after rename. Windows may refuse opening a
    // directory as a file descriptor, so this remains best-effort there; the atomic
    // rename still provides process-crash consistency.
    try {
      const directoryFd = openSync(dirname(path), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch {
      /* unsupported by this platform/filesystem */
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
