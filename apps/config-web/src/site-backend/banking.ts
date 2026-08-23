/**
 * Post-game banking apply for the site-backend's `xml:result` receive (Yularen C-2, verbatim from
 * spec-team-management-hub §3 AMENDMENT-2; Meero SR-91 PA-3).
 *
 * CE-1  — bank the server-computed numbers, NEVER recompute. The game server owns the rules; the
 *         FumbblResult XML already carries winnings / SPP / injuries / EM. We apply, we don't derive.
 * BR-1/BR-3 — per-(gameId, teamId) TWO-PHASE ledger so a crash mid-apply can't double-bank:
 *         record both the before/apply hashes, write IN_PROGRESS before the mutation, then flip to
 *         APPLIED. Startup recovery never restores a backup over an unrelated later mutation.
 * AV-2  — ownership: the result's team must resolve to a real team file before any write.
 * AV-3  — re-check the team file's mtime/size at WRITE-COMMIT (not just at read); a concurrent mutation
 *         aborts the apply into quarantine rather than clobbering.
 * quarantine-on-validation-fail — a malformed/unresolvable result goes to results/quarantine/ with an
 *         error sidecar; NEVER a half-apply.
 *
 * This module owns the LEDGER + orchestration. The team-XML field mutation is injected as `applyFn`
 * (the fork-data writer, specced separately) so the crash-safety machinery here is unit-testable
 * against a trivial apply and the real writer drops in unchanged.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acknowledgePendingGameResults, acquirePendingGameResultsWriteLock, acquireTeamNameWriteLock, acquireTeamWriteLock, atomicWriteTextFile, forkCacheGenerationReloadRequired, forkCacheReloadRequired, markForkCacheReloadRequired, markPendingGameResults, parseTeamXmlMeta, readLibraryStrict, upsertLibraryTeam, type FileWriteLock } from "@bb/fork-ops";
import { parseFumbblResult } from "./fumbblResult.js";
import { buildBankTasks } from "./fumbblResultBanking.js";

export type ApplyPhase = "IN_PROGRESS" | "APPLIED";

/** One ledger marker per (gameId, teamId). Persisted as JSON next to the result. */
export interface LedgerMarker {
  gameId: string;
  teamId: string;
  phase: ApplyPhase;
  teamFile: string; // absolute path to the team XML this apply mutates
  bakFile: string; // absolute path to the pre-apply backup
  teamSizeAtRead: number; // AV-3: bytes at read time
  teamMtimeAtRead: number; // AV-3: mtimeMs at read time
  beforeHash?: string;
  appliedHash?: string;
  /** Hash of the complete authenticated FumbblResult payload; binds idempotency to content, not ID alone. */
  resultHash?: string;
  startedAt: number;
  appliedAt?: number;
}

export interface BankResult {
  ok: boolean;
  gameId: string;
  applied: string[]; // teamIds applied
  /** No team mutation began; the exact authenticated result may be durably queued for later replay. */
  deferred?: boolean;
  quarantined?: { teamId: string; reason: string }[];
}

export interface BankingDirs {
  resultsDir: string; // where result XML + ledger markers live
  teamsDir: string; // the team store
  libraryDir?: string;
}

/** A single team's banking task extracted from a parsed FumbblResult. `applyFn` mutates `xml` → new xml. */
export interface TeamBankTask {
  teamId: string;
  applyFn: (currentXml: string) => string;
}

export const bankingLedgerStem = (gameId: string, teamId: string): string => {
  const readable = (value: string): string => value.replace(/[^A-Za-z0-9.-]+/g, "_").slice(0, 24) || "id";
  // Length-prefixed tuple hashing makes the key injective at the input layer; the full digest avoids
  // delimiter collisions while keeping every Windows filename component comfortably below 255 bytes.
  const tuple = `${Buffer.byteLength(gameId, "utf8")}:${gameId}${Buffer.byteLength(teamId, "utf8")}:${teamId}`;
  return `${readable(gameId)}_${readable(teamId)}_${createHash("sha256").update(tuple).digest("hex")}`;
};

const markerPath = (dirs: BankingDirs, gameId: string, teamId: string): string =>
  join(dirs.resultsDir, "ledger", `${bankingLedgerStem(gameId, teamId)}.json`);

const deferredPath = (dirs: BankingDirs, gameId: string): string =>
  join(dirs.resultsDir, "pending", `${createHash("sha256").update(gameId).digest("hex")}.result.xml`);

const waitForPendingResultsLock = async (teamsDir: string, timeoutMs = 5_000): Promise<FileWriteLock> => {
  const deadline = Date.now() + timeoutMs;
  do {
    const lock = acquirePendingGameResultsWriteLock(teamsDir);
    if (lock) return lock;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  } while (Date.now() < deadline);
  throw new Error("pending-result queue is busy");
};

/** Preserve the exact authenticated one-shot result until cache recovery can safely bank it. */
export async function deferGameResult(dirs: BankingDirs, gameId: string, resultXml: string): Promise<string> {
  const queueLock = await waitForPendingResultsLock(dirs.teamsDir);
  try {
    const path = deferredPath(dirs, gameId);
    // The marker and queue publication share a distinct lock with replay's final acknowledgement.
    // A concurrent team transaction may clear its own marker, but cannot erase this queue gate.
    markPendingGameResults(dirs.teamsDir, `authenticated game result ${gameId} is queued for banking`);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== resultXml) throw new Error(`deferred result ${gameId} conflicts with an existing payload`);
      return path;
    }
    atomicWriteTextFile(path, resultXml);
    return path;
  } finally {
    queueLock.release();
  }
}

const teamFilePath = (dirs: BankingDirs, teamId: string): string | undefined => {
  // The fork keys teams by id; on disk they're team_<coach>_<id>.xml (coach prefix varies). Resolve
  // by the id suffix. AV-2: no match ⇒ no ownership ⇒ do not write.
  const suffix = `_${teamId}.xml`;
  const hits = readdirSync(dirs.teamsDir).filter((f) => f.endsWith(suffix) || f === `team_${teamId}.xml`);
  return hits.length === 1 ? join(dirs.teamsDir, hits[0]!) : undefined;
};

const quarantine = (dirs: BankingDirs, gameId: string, teamId: string, reason: string, resultXml?: string): void => {
  const qdir = join(dirs.resultsDir, "quarantine");
  mkdirSync(qdir, { recursive: true });
  const base = join(qdir, bankingLedgerStem(gameId, teamId));
  writeFileSync(`${base}.error.txt`, `${new Date(0).toISOString()} ${reason}\n`.replace(/^.*? /, ""), "utf8");
  if (resultXml !== undefined) writeFileSync(`${base}.result.xml`, resultXml, "utf8");
};

const writeMarker = (dirs: BankingDirs, m: LedgerMarker): void => {
  const p = markerPath(dirs, m.gameId, m.teamId);
  mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2), "utf8");
  renameSync(tmp, p); // atomic marker flip
};

const readMarker = (p: string): LedgerMarker | undefined => {
  try {
    const value = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const marker = value as Record<string, unknown>;
    if (typeof marker.gameId !== "string" || !marker.gameId || typeof marker.teamId !== "string" || !marker.teamId ||
      (marker.phase !== "IN_PROGRESS" && marker.phase !== "APPLIED") || typeof marker.teamFile !== "string" ||
      typeof marker.bakFile !== "string" || typeof marker.teamSizeAtRead !== "number" || typeof marker.teamMtimeAtRead !== "number" ||
      typeof marker.startedAt !== "number" ||
      (marker.resultHash !== undefined && (typeof marker.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(marker.resultHash)))) return undefined;
    return marker as unknown as LedgerMarker;
  } catch {
    return undefined;
  }
};

/**
 * Apply one team's banking under the two-phase ledger. Returns true on APPLIED, false on quarantine.
 * Safe to call again after a crash: an existing APPLIED marker for this (gameId,teamId) short-circuits
 * (idempotent), an IN_PROGRESS marker means "recover first" (handled by {@link recoverInterrupted}).
 */
function applyOneTeam(dirs: BankingDirs, gameId: string, task: TeamBankTask, resultXml: string): boolean {
  const { teamId } = task;
  const incomingResultHash = hash(resultXml);
  const mp = markerPath(dirs, gameId, teamId);
  if (existsSync(mp)) {
    const existing = readMarker(mp);
    const sameIdentity = existing?.gameId === gameId && existing.teamId === teamId;
    if (existing?.phase === "APPLIED" && sameIdentity) {
      if (existing.resultHash === incomingResultHash) return true; // identical payload already banked
      quarantine(dirs, gameId, teamId, "banking retry payload conflicts with the applied result ledger", resultXml);
      return false;
    }
    if (existing && !sameIdentity) {
      quarantine(dirs, gameId, teamId, "banking ledger identity does not match its tuple key", resultXml);
      return false;
    }
    // A retry may arrive before process startup recovery. Resolve a valid IN_PROGRESS marker now;
    // never overwrite its backup/hash record and apply again from the possibly-applied XML.
    recoverInterrupted(dirs, true);
    const recovered = readMarker(mp);
    if (recovered?.phase === "APPLIED" && recovered.gameId === gameId && recovered.teamId === teamId) {
      if (recovered.resultHash === incomingResultHash) return true;
      quarantine(dirs, gameId, teamId, "recovered banking payload conflicts with the retry result", resultXml);
      return false;
    }
    if (existsSync(mp)) {
      quarantine(
        dirs,
        gameId,
        teamId,
        recovered ? "an interrupted banking operation conflicts with the current team state" : "the existing banking marker is unreadable",
        resultXml,
      );
      return false;
    }
  }

  const lock = acquireTeamWriteLock(dirs.teamsDir, teamId, Date.now(), true);
  if (!lock) {
    quarantine(dirs, gameId, teamId, `another team update is in progress for ${teamId}`, resultXml);
    return false;
  }
  try {
    const teamFile = teamFilePath(dirs, teamId); // AV-2, resolved under the shared team lock
    if (!teamFile) {
      quarantine(dirs, gameId, teamId, `no team file resolves for teamId ${teamId} (ownership)`, resultXml);
      return false;
    }
    const beforeXml = readFileSync(teamFile, "utf8");
    const teamStatAtRead = statSync(teamFile);
    const teamSizeAtRead = Buffer.byteLength(beforeXml);
    if (teamStatAtRead.size !== teamSizeAtRead) {
      quarantine(dirs, gameId, teamId, "team XML changed while its banking snapshot was read", resultXml);
      return false;
    }
    const bakFile = `${teamFile}.bank-bak`;

    let newXml: string;
    try {
      newXml = task.applyFn(beforeXml);
    } catch (e) {
      quarantine(dirs, gameId, teamId, `apply threw: ${(e as Error).message}`, resultXml);
      return false;
    }

    // AV-3: our team lock serializes every fork/config-web writer, but it cannot compel an unrelated
    // process that ignores the lock. Re-read immediately before committing and compare both metadata
    // and content. This closes the practical stale-read window without pretending Node can impose a
    // mandatory cross-process lock on arbitrary external editors. The final atomic rename remains the
    // commit boundary; operators must route all supported writers through the shared team lock.
    const commitStat = statSync(teamFile);
    const commitXml = readFileSync(teamFile, "utf8");
    if (commitStat.size !== teamStatAtRead.size || commitStat.mtimeMs !== teamStatAtRead.mtimeMs ||
      hash(commitXml) !== hash(beforeXml)) {
      quarantine(dirs, gameId, teamId, "team XML changed after banking read and before commit", resultXml);
      return false;
    }

    // PHASE 1: persist the exact validated snapshot + record IN_PROGRESS *before* any mutation.
    // Do not copy the live path here: an external writer between validation and backup would otherwise
    // poison recovery authority with bytes that were never used to calculate `newXml`.
    atomicWriteTextFile(bakFile, beforeXml);
    const marker: LedgerMarker = {
      gameId,
      teamId,
      phase: "IN_PROGRESS",
      teamFile,
      bakFile,
      teamSizeAtRead,
      teamMtimeAtRead: teamStatAtRead.mtimeMs,
      beforeHash: hash(beforeXml),
      appliedHash: hash(newXml),
      resultHash: incomingResultHash,
      startedAt: 0,
    };
    writeMarker(dirs, marker);

    // Commit the mutated team file atomically, synchronize its persistent library row, then flip
    // the marker. A metadata failure rolls the XML back while the shared team lock is still held.
    markForkCacheReloadRequired(dirs.teamsDir, `Banked result ${gameId} for team ${teamId} requires a fork cache reload.`);
    atomicWriteTextFile(teamFile, newXml);
    try {
      synchronizeLibrary(dirs, teamId, newXml);
    } catch (error) {
      try {
        atomicWriteTextFile(teamFile, beforeXml);
        synchronizeLibrary(dirs, teamId, beforeXml);
        rmSync(mp, { force: true });
      } catch (rollbackError) {
        markForkCacheReloadRequired(
          dirs.teamsDir,
          `Banking rollback for result ${gameId}, team ${teamId} could not restore coherent XML/library metadata: ${(rollbackError as Error).message}`,
        );
        quarantine(dirs, gameId, teamId, `library synchronization and rollback failed: ${(rollbackError as Error).message}`, resultXml);
        return false;
      }
      quarantine(
        dirs,
        gameId,
        teamId,
        `library metadata synchronization failed; team write rolled back: ${(error as Error).message}`,
        resultXml,
      );
      return false;
    }
    writeMarker(dirs, { ...marker, phase: "APPLIED", appliedAt: 0 });
    return true;
  } finally {
    lock.release();
  }
}

function synchronizeLibrary(dirs: BankingDirs, teamId: string, xml: string): void {
  if (!dirs.libraryDir) return;
  const coach = xml.match(/<coach>([^<]*)<\/coach>/i)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
  if (!coach) throw new Error("stored team has no coach");
  const existing = readLibraryStrict(dirs.libraryDir, coach).find((team) => team.teamId === teamId);
  if (!existing) return;
  const meta = parseTeamXmlMeta(xml);
  upsertLibraryTeam(dirs.libraryDir, coach, {
    ...existing,
    teamValue: meta.teamValue,
    gold: meta.gold,
    rerolls: meta.rerolls ?? existing.rerolls,
    fanFactor: meta.fanFactor ?? existing.fanFactor,
    apothecary: meta.apothecary ?? existing.apothecary,
  });
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Startup recovery never restores a backup over a team that may contain a later valid mutation.
 * Hash equality distinguishes "write never happened" from "write completed before marker flip";
 * any third state is quarantined for operator reconciliation.
 * Call once at site-backend boot before serving `xml:result`.
 */
export function recoverInterrupted(dirs: BankingDirs, generationLockHeld = false): { recovered: string[]; errors: string[] } {
  const ldir = join(dirs.resultsDir, "ledger");
  if (!existsSync(ldir)) return { recovered: [], errors: [] };
  const generationLock = generationLockHeld ? undefined : acquireTeamNameWriteLock(dirs.teamsDir);
  if (!generationLockHeld && !generationLock) return { recovered: [], errors: ["cache-generation lock is unavailable"] };
  const recovered: string[] = [];
  const errors: string[] = [];
  try {
    for (const f of readdirSync(ldir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(ldir, f);
      const m = readMarker(p);
      if (!m) {
        const message = `unreadable banking ledger ${f}`;
        errors.push(message);
        markForkCacheReloadRequired(dirs.teamsDir, message);
        continue;
      }
      if (m.phase === "APPLIED") continue; // APPLIED = done; leave as the applied-record
      const lock = acquireTeamWriteLock(dirs.teamsDir, m.teamId, Date.now(), true);
      if (!lock) {
        errors.push(`banking recovery could not lock team ${m.teamId}`);
        continue;
      }
      try {
      const authoritativeTeamFile = teamFilePath(dirs, m.teamId);
      if (!authoritativeTeamFile || resolve(authoritativeTeamFile) !== resolve(m.teamFile) || resolve(m.bakFile) !== resolve(`${authoritativeTeamFile}.bank-bak`)) {
        quarantine(dirs, m.gameId, m.teamId, "interrupted banking marker does not resolve to the authoritative team/backup paths");
        errors.push(`banking marker paths are not authoritative for ${m.gameId}/${m.teamId}`);
        continue;
      }
      if (!existsSync(authoritativeTeamFile)) {
        errors.push(`authoritative team file is missing for ${m.gameId}/${m.teamId}`);
        continue;
      }
      const current = readFileSync(authoritativeTeamFile, "utf8");
      const currentHash = hash(current);
      const beforeHash = m.beforeHash ?? (existsSync(m.bakFile) ? hash(readFileSync(m.bakFile, "utf8")) : undefined);
      if (m.appliedHash && currentHash === m.appliedHash) {
        try {
          // A crash can land after the XML rename but before persistent library metadata and the
          // APPLIED flip. Reconcile the library from the authoritative applied XML before closing.
          synchronizeLibrary(dirs, m.teamId, current);
          writeMarker(dirs, { ...m, phase: "APPLIED", appliedAt: Date.now() });
          markForkCacheReloadRequired(dirs.teamsDir, `Recovered applied result ${m.gameId} for team ${m.teamId} requires a fork cache reload.`);
          recovered.push(`${m.gameId}_${m.teamId}`);
        } catch (error) {
          quarantine(dirs, m.gameId, m.teamId, `interrupted banking could not synchronize library metadata: ${(error as Error).message}`);
          errors.push(`banking library recovery failed for ${m.gameId}/${m.teamId}: ${(error as Error).message}`);
        }
      } else if (beforeHash && currentHash === beforeHash) {
        try {
          // The XML rollback may have completed after an applied library row became visible. Restore
          // metadata from the authoritative before-generation before discarding recovery authority.
          synchronizeLibrary(dirs, m.teamId, current);
          rmSync(p, { force: true });
          recovered.push(`${m.gameId}_${m.teamId}`);
        } catch (error) {
          quarantine(dirs, m.gameId, m.teamId, `interrupted banking rollback could not synchronize library metadata: ${(error as Error).message}`);
          errors.push(`banking rollback metadata recovery failed for ${m.gameId}/${m.teamId}: ${(error as Error).message}`);
        }
      } else {
        quarantine(dirs, m.gameId, m.teamId, "interrupted banking conflicts with a later team mutation; backup was not restored");
        errors.push(`banking generation is ambiguous for ${m.gameId}/${m.teamId}`);
      }
      } finally {
        lock.release();
      }
    }
  } finally {
    generationLock?.release();
  }
  if (errors.length) markForkCacheReloadRequired(dirs.teamsDir, errors.join("; "));
  return { recovered, errors };
}

/**
 * Bank a full game result: deterministically preflight every team before the first mutation, then
 * apply each team under its own ledger. Validation failure aborts the game atomically; an unexpected
 * commit-time failure is quarantined in its `(gameId,teamId)` transaction. Returns the outcome for the
 * `xml:result` responder to turn into `<result>success</result>` (all applied) or a failure.
 */
export function bankGameResult(
  dirs: BankingDirs,
  gameId: string,
  tasks: TeamBankTask[],
  resultXml: string,
  generationLockHeld = false,
  replayingDeferred = false,
): BankResult {
  mkdirSync(dirs.resultsDir, { recursive: true });
  const applied: string[] = [];
  const quarantined: { teamId: string; reason: string }[] = [];
  const generationLock = generationLockHeld ? undefined : acquireTeamNameWriteLock(dirs.teamsDir);
  if (!generationLockHeld && !generationLock) {
    return {
      ok: false,
      deferred: true,
      gameId,
      applied,
      quarantined: tasks.map((task) => ({ teamId: task.teamId, reason: "team/cache generation update in progress" })),
    };
  }
  try {
    // A byte-identical server retry after exact banking is already terminal even while the cache
    // reload marker remains. Conversely, the same replay/team tuple with different authenticated
    // content is a hard conflict, not work that may be deferred behind that marker.
    const incomingResultHash = hash(resultXml);
    const existingApplied = tasks.map((task) => ({ task, marker: readMarker(markerPath(dirs, gameId, task.teamId)) }));
    if (existingApplied.length > 0 && existingApplied.every(({ task, marker }) =>
      marker?.phase === "APPLIED" && marker.gameId === gameId && marker.teamId === task.teamId &&
      marker.resultHash === incomingResultHash)) {
      return { ok: true, gameId, applied: tasks.map((task) => task.teamId) };
    }
    const conflictingApplied = existingApplied.filter(({ task, marker }) => marker?.phase === "APPLIED" &&
      marker.gameId === gameId && marker.teamId === task.teamId && marker.resultHash !== incomingResultHash);
    if (conflictingApplied.length) {
      for (const { task } of conflictingApplied) {
        quarantine(dirs, gameId, task.teamId, "banking retry payload conflicts with the applied result ledger", resultXml);
      }
      return {
        ok: false,
        gameId,
        applied,
        quarantined: conflictingApplied.map(({ task }) => ({ teamId: task.teamId, reason: "see results/quarantine" })),
      };
    }
    // Never bank atop an unresolved team transaction or stale cache generation. The operator/startup
    // recovery path must reconcile its journal and reload first; this result can then be retried.
    if (replayingDeferred ? forkCacheGenerationReloadRequired(dirs.teamsDir) : forkCacheReloadRequired(dirs.teamsDir)) {
      return {
        ok: false,
        deferred: true,
        gameId,
        applied,
        quarantined: tasks.map((task) => ({ teamId: task.teamId, reason: "banking deferred until team/cache recovery completes" })),
      };
    }
    // Dry-run every not-yet-applied team under the generation lock before the first mutation. This
    // makes deterministic payload/team validation game-atomic: a stale SPP baseline or malformed
    // treasury on one side cannot bank the other side and poison a corrected server retry.
    for (const { task, marker } of existingApplied) {
      if (marker?.phase === "APPLIED" && marker.gameId === gameId && marker.teamId === task.teamId &&
        marker.resultHash === incomingResultHash) continue;
      const teamFile = teamFilePath(dirs, task.teamId);
      if (!teamFile) {
        quarantine(dirs, gameId, task.teamId, `no team file resolves for teamId ${task.teamId} (ownership)`, resultXml);
        return { ok: false, gameId, applied, quarantined: [{ teamId: task.teamId, reason: "see results/quarantine" }] };
      }
      try {
        task.applyFn(readFileSync(teamFile, "utf8"));
      } catch (error) {
        quarantine(dirs, gameId, task.teamId, `preflight apply threw: ${(error as Error).message}`, resultXml);
        return { ok: false, gameId, applied, quarantined: [{ teamId: task.teamId, reason: "see results/quarantine" }] };
      }
    }
    for (const t of tasks) {
      const ok = applyOneTeam(dirs, gameId, t, resultXml);
      if (ok) applied.push(t.teamId);
      else quarantined.push({ teamId: t.teamId, reason: "see results/quarantine" });
    }
  } finally {
    generationLock?.release();
  }
  return { ok: quarantined.length === 0, gameId, applied, quarantined: quarantined.length ? quarantined : undefined };
}

/** Replay durably deferred one-shot server results after team journals/cache have been reconciled. */
export async function replayDeferredGameResults(
  dirs: BankingDirs,
  reloadCache: (() => Promise<boolean>) | undefined,
  generationLockHeld = false,
): Promise<{ replayed: string[]; errors: string[] }> {
  const pendingDir = join(dirs.resultsDir, "pending");
  let files: string[];
  const scanLock = await waitForPendingResultsLock(dirs.teamsDir);
  try {
    files = existsSync(pendingDir)
      ? readdirSync(pendingDir).filter((entry) => entry.endsWith(".result.xml")).sort()
      : [];
    if (!files.length) acknowledgePendingGameResults(dirs.teamsDir);
  } finally {
    scanLock.release();
  }
  if (!files.length) return { replayed: [], errors: [] };
  const replayed: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const path = join(pendingDir, file);
    try {
      const xml = readFileSync(path, "utf8");
      const parsed = parseFumbblResult(xml);
      const banked = bankGameResult(dirs, parsed.gameId, buildBankTasks(parsed, dirs.teamsDir), xml, generationLockHeld, true);
      if (!banked.ok) throw new Error(banked.quarantined?.map((entry) => `${entry.teamId}: ${entry.reason}`).join("; ") || "banking failed");
      if (!reloadCache || !(await reloadCache())) throw new Error("fork cache reload refused after deferred banking");
      rmSync(path, { force: true });
      replayed.push(parsed.gameId);
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`);
      break; // a retained cache marker must be resolved before any later result can safely apply
    }
  }
  const acknowledgementLock = await waitForPendingResultsLock(dirs.teamsDir);
  try {
    if (!errors.length && (!existsSync(pendingDir) || readdirSync(pendingDir).every((entry) => !entry.endsWith(".result.xml")))) {
      acknowledgePendingGameResults(dirs.teamsDir);
    }
  } finally {
    acknowledgementLock.release();
  }
  return { replayed, errors };
}
