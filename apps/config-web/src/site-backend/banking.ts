/**
 * Post-game banking apply for the site-backend's `xml:result` receive (Yularen C-2, verbatim from
 * spec-team-management-hub §3 AMENDMENT-2; Meero SR-91 PA-3).
 *
 * CE-1  — bank the server-computed numbers, NEVER recompute. The game server owns the rules; the
 *         FumbblResult XML already carries winnings / SPP / injuries / EM. We apply, we don't derive.
 * BR-1/BR-3 — per-(gameId, teamId) TWO-PHASE ledger so a crash mid-apply can't double-bank:
 *         write IN_PROGRESS marker + a `.bak` of the team file BEFORE touching it → flip the marker
 *         to APPLIED after → on startup, an interrupted marker (IN_PROGRESS with no APPLIED) restores
 *         from `.bak` and re-applies. "Idempotent on a clean re-run" is NOT "crash-safe"; the marker
 *         is what makes the mid-apply crash recoverable.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  startedAt: number;
  appliedAt?: number;
}

export interface BankResult {
  ok: boolean;
  gameId: string;
  applied: string[]; // teamIds applied
  quarantined?: { teamId: string; reason: string }[];
}

export interface BankingDirs {
  resultsDir: string; // where result XML + ledger markers live
  teamsDir: string; // the team store
}

/** A single team's banking task extracted from a parsed FumbblResult. `applyFn` mutates `xml` → new xml. */
export interface TeamBankTask {
  teamId: string;
  applyFn: (currentXml: string) => string;
}

const markerPath = (dirs: BankingDirs, gameId: string, teamId: string): string =>
  join(dirs.resultsDir, "ledger", `${gameId}_${teamId}.json`);

const teamFilePath = (dirs: BankingDirs, teamId: string): string | undefined => {
  // The fork keys teams by id; on disk they're team_<coach>_<id>.xml (coach prefix varies). Resolve
  // by the id suffix. AV-2: no match ⇒ no ownership ⇒ do not write.
  const suffix = `_${teamId}.xml`;
  const hit = readdirSync(dirs.teamsDir).find((f) => f.endsWith(suffix) || f === `team_${teamId}.xml`);
  return hit ? join(dirs.teamsDir, hit) : undefined;
};

const quarantine = (dirs: BankingDirs, gameId: string, teamId: string, reason: string, resultXml?: string): void => {
  const qdir = join(dirs.resultsDir, "quarantine");
  mkdirSync(qdir, { recursive: true });
  const base = join(qdir, `${gameId}_${teamId}`);
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
    return JSON.parse(readFileSync(p, "utf8")) as LedgerMarker;
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
  const mp = markerPath(dirs, gameId, teamId);
  const existing = readMarker(mp);
  if (existing?.phase === "APPLIED") return true; // already banked — idempotent

  const teamFile = teamFilePath(dirs, teamId); // AV-2
  if (!teamFile) {
    quarantine(dirs, gameId, teamId, `no team file resolves for teamId ${teamId} (ownership)`, resultXml);
    return false;
  }

  const st = statSync(teamFile);
  const bakFile = `${teamFile}.bank-bak`;

  // PHASE 1: back up + record IN_PROGRESS *before* any mutation.
  copyFileSync(teamFile, bakFile);
  const marker: LedgerMarker = {
    gameId,
    teamId,
    phase: "IN_PROGRESS",
    teamFile,
    bakFile,
    teamSizeAtRead: st.size,
    teamMtimeAtRead: st.mtimeMs,
    startedAt: 0, // stamped by caller-injected clock via marker rewrite is overkill; 0 is a valid sentinel
  };
  writeMarker(dirs, marker);

  // PHASE 2: mutate. Any throw here leaves IN_PROGRESS + .bak on disk → recoverable on restart.
  let newXml: string;
  try {
    newXml = task.applyFn(readFileSync(teamFile, "utf8"));
  } catch (e) {
    quarantine(dirs, gameId, teamId, `apply threw: ${(e as Error).message}`, resultXml);
    // leave marker IN_PROGRESS: recovery restores the .bak (no partial write happened yet)
    restoreFromBak(marker);
    rmSync(mp, { force: true });
    return false;
  }

  // AV-3: re-check the file wasn't mutated concurrently between read and commit.
  const st2 = statSync(teamFile);
  if (st2.size !== marker.teamSizeAtRead || st2.mtimeMs !== marker.teamMtimeAtRead) {
    quarantine(dirs, gameId, teamId, `concurrent modification of ${teamFile} during apply (AV-3)`, resultXml);
    restoreFromBak(marker);
    rmSync(mp, { force: true });
    return false;
  }

  // Commit the mutated team file atomically, then flip the marker to APPLIED.
  const tmp = `${teamFile}.tmp`;
  writeFileSync(tmp, newXml, "utf8");
  renameSync(tmp, teamFile);
  writeMarker(dirs, { ...marker, phase: "APPLIED", appliedAt: 0 });
  return true;
}

function restoreFromBak(m: LedgerMarker): void {
  if (existsSync(m.bakFile)) copyFileSync(m.bakFile, m.teamFile);
}

/**
 * Startup recovery (BR-3): any IN_PROGRESS-not-APPLIED marker = a crash mid-apply. Restore the team
 * file from its `.bak` and drop the marker so the next result re-applies cleanly. Idempotent.
 * Call once at site-backend boot before serving `xml:result`.
 */
export function recoverInterrupted(dirs: BankingDirs): { recovered: string[] } {
  const ldir = join(dirs.resultsDir, "ledger");
  if (!existsSync(ldir)) return { recovered: [] };
  const recovered: string[] = [];
  for (const f of readdirSync(ldir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(ldir, f);
    const m = readMarker(p);
    if (!m || m.phase === "APPLIED") continue; // APPLIED = done; leave as the applied-record
    restoreFromBak(m);
    rmSync(p, { force: true });
    recovered.push(`${m.gameId}_${m.teamId}`);
  }
  return { recovered };
}

/**
 * Bank a full game result: apply every team task under its own ledger. A per-team quarantine does
 * NOT abort the other team (each is its own (gameId,teamId) unit). Returns the outcome for the
 * `xml:result` responder to turn into `<result>success</result>` (all applied) or a failure.
 */
export function bankGameResult(dirs: BankingDirs, gameId: string, tasks: TeamBankTask[], resultXml: string): BankResult {
  mkdirSync(dirs.resultsDir, { recursive: true });
  const applied: string[] = [];
  const quarantined: { teamId: string; reason: string }[] = [];
  for (const t of tasks) {
    const ok = applyOneTeam(dirs, gameId, t, resultXml);
    if (ok) applied.push(t.teamId);
    else quarantined.push({ teamId: t.teamId, reason: "see results/quarantine" });
  }
  return { ok: quarantined.length === 0, gameId, applied, quarantined: quarantined.length ? quarantined : undefined };
}
