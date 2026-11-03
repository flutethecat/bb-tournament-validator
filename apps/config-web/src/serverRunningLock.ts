/**
 * "config-web is running on this state dir": a lock the server takes at start and holds for its lifetime
 * (<FORK_STATE_DIR>/.config-web-running.lock, the @bb/fork-ops file lock with the owner's pid). Offline tools that write
 * the stores (scripts/fork-team-cleanup.ts --apply) take the same lock and refuse while the server holds it, whatever
 * host or port the server listens on. A lock left by a process that died is taken over (its pid is gone).
 */
import { join } from "node:path";
import { acquireFileWriteLock, type FileWriteLock } from "@bb/fork-ops";

export const serverRunningLockPath = (stateDir: string): string => join(stateDir, ".config-web-running.lock");

/** Takes the lock (undefined when a live process already holds it). Never stolen from a live owner. */
export function acquireServerRunningLock(stateDir: string): FileWriteLock | undefined {
  // staleMs = infinity: only a dead owner pid frees it, never its age (the server holds it for days).
  return acquireFileWriteLock(serverRunningLockPath(stateDir), Date.now(), Number.POSITIVE_INFINITY);
}
