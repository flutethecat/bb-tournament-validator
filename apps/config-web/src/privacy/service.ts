/**
 * Data export and account deletion (privacy spec 2026-10-31 §2, §3).
 *
 * Deletion is one journaled job (src/privacy/state.ts): the plan line first (names sealed with a per-job key), then one
 * line per step in DELETE_STEPS order. A step that throws (the fork unreachable, a file the OS will not delete) is
 * journaled "failed" and the job carries on with the others; the job stays open and its pending steps run again on the
 * next retry (startup and a timer). When every step is done the audit line is written (idempotent by job id), then the
 * complete marker, then the job key and the journal are removed. A job still open after JOB_RETRY_DAYS is abandoned:
 * its key (and with it the sealed names) is destroyed, it is listed for the admin, and the journal is removed.
 *
 * While a job runs, the coach is fenced (src/privacy/fence.ts): identity, save, avatar, library and notification writes
 * for them are refused. Jobs run one at a time in this process.
 */
import type { ServerResponse } from "node:http";
import { crc32 } from "../leagues/exportZip.js";
import { discordAvatarUrl } from "../auth/discordSso.js";
import { normalizeFfbCoachId, readIdentitiesStrict } from "../auth/identitiesStore.js";
import {
  avatarSlotCollision, buildPlan, collectExport, deleteContext, DELETE_STEPS, EXPORT_MAX_BYTES, ownedItems, splitPlan,
  type DeletePlan, type ExportFile, type OwnedItem, type PlanSecrets, type PrivacyDeps, type StoredPlan,
} from "./collectors.js";
import { nameKey } from "./anonymise.js";
import { coachKeyHash, fenceCoachHash, releaseCoachHash } from "./fence.js";
import {
  allocatePseudonym, appendAudit, appendFailedJob, appendJournal, blocklistHash, destroyJobKey, listJobs, newJobId,
  readFailedJobs, readJournal, removeJournal, sealForJob, unsealForJob, type FailedJob,
} from "./state.js";

export const JOB_RETRY_DAYS = 7;

export interface DeleteOutcome {
  status: "deleted" | "blocked" | "mismatch" | "unavailable" | "conflict";
  owned?: OwnedItem[];
  /** Steps still pending (the fork account when the game server was unreachable). */
  pending?: string[];
  pseudonym?: string;
}

export interface OpenJob { jobId: string; pseudonym: string; pending: string[]; startedAt: string; stuck: boolean }


/** Every fence hash a job installed: the plan's and each journaled "fence" line (never derived from the job key). */
function journalFenceHashes(lines: ReturnType<typeof readJournal>): string[] {
  const out = new Set<string>();
  const first = lines[0];
  if (first?.type === "plan") out.add((first as unknown as StoredPlan).coachHash);
  for (const l of lines) if (l.type === "fence") for (const h of l.hashes) out.add(h);
  return [...out].filter((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h));
}

/** Steps an admin may leave unfinished when closing a stuck job (the account itself is already gone by then). */
export const CLOSABLE_PENDING = new Set(["fork-account", "final-sweep"]);

export type CloseResult = { ok: true } | { ok: false; reason: "not-found" } | { ok: false; reason: "unfinished"; pending: string[] };

export class PrivacyService {
  private chain: Promise<unknown> = Promise.resolve();
  private warnedNoKey = false;

  constructor(readonly deps: PrivacyDeps, private readonly now: () => number = Date.now) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The coach's spelling on the identity record (falls back to the given name). */
  canonicalCoach(coach: string): string {
    return readIdentitiesStrict().coaches[normalizeFfbCoachId(coach)]?.ffbCoachId ?? coach.trim();
  }

  owned(coach: string): OwnedItem[] {
    return ownedItems(this.deps, new Set([nameKey(coach), nameKey(this.canonicalCoach(coach))]));
  }

  exportFiles(coach: string): Promise<ExportFile[]> {
    return collectExport(this.deps, coach);
  }

  /** Open jobs (pending steps; `stuck` = out of retries, waiting for an admin) and the history of jobs that got stuck. Names
   *  never appear. */
  jobs(): { open: OpenJob[]; failed: FailedJob[] } {
    const open: OpenJob[] = [];
    for (const jobId of listJobs(this.deps.stateDir)) {
      const lines = readJournal(this.deps.stateDir, jobId);
      const plan = lines[0]?.type === "plan" ? (lines[0] as unknown as StoredPlan) : undefined;
      if (!plan) continue;
      const done = new Set(lines.flatMap((l) => (l.type === "step" && l.status !== "failed" ? [l.step] : [])));
      open.push({ jobId, pseudonym: plan.pseudonym, startedAt: plan.at, pending: DELETE_STEPS.map((s) => s.id).filter((id) => !done.has(id)), stuck: lines.some((l) => l.type === "abandoned") });
    }
    return { open, failed: readFailedJobs(this.deps.stateDir) };
  }

  /**
   * Delete a coach (self-service or admin). `confirm` must equal the coach name (identity-store key). Blocked while the
   * coach owns a draft/active tournament or any league.
   */
  deleteCoach(coach: string, confirm: unknown, actor: string, now = new Date(this.now())): Promise<DeleteOutcome> {
    return this.serial(async () => {
      const canonical = this.canonicalCoach(coach);
      if (typeof confirm !== "string" || !confirm.trim() || (nameKey(confirm) !== nameKey(canonical) && nameKey(confirm) !== nameKey(coach)))
        return { status: "mismatch" };
      if (!this.deps.mapKey) return { status: "unavailable" };
      const owned = this.owned(coach);
      if (owned.length) return { status: "blocked", owned };
      if (avatarSlotCollision(canonical)) return { status: "conflict" };
      const jobId = newJobId();
      const plan = buildPlan(this.deps, {
        sessionCoach: coach,
        jobId,
        pseudonym: allocatePseudonym(this.deps.stateDir),
        actor,
        now,
        mapKey: this.deps.mapKey,
        blockHashOf: (id) => blocklistHash(this.deps.stateDir, id, this.deps.env),
        discordAvatarUrl,
      });
      fenceCoachHash(plan.coachHash);
      const { stored, secrets } = splitPlan(plan);
      const line: StoredPlan = { ...stored, sealed: sealForJob(this.deps.stateDir, jobId, secrets) };
      appendJournal(this.deps.stateDir, jobId, { type: "plan", ...line });
      appendJournal(this.deps.stateDir, jobId, { type: "fence", hashes: [plan.coachHash] });
      const pending = await this.runSteps(plan);
      return { status: "deleted", pending, pseudonym: plan.pseudonym };
    });
  }

  /** Resume every unfinished job (startup, retry timer). Returns the jobs still open afterwards. */
  resumeAll(): Promise<string[]> {
    return this.serial(async () => {
      const open: string[] = [];
      const jobs = listJobs(this.deps.stateDir);
      if (jobs.length && !this.deps.mapKey) {
        // Without the map key no step may run (the deleted-coach map could not be written): every journal stays pending.
        if (!this.warnedNoKey) { console.error("[privacy] PRIVACY_MAP_KEY is not set: open delete jobs stay pending until it is."); this.warnedNoKey = true; }
        for (const jobId of jobs) {
          const first = readJournal(this.deps.stateDir, jobId)[0];
          for (const h of journalFenceHashes(readJournal(this.deps.stateDir, jobId))) fenceCoachHash(h);
        }
        return jobs;
      }
      for (const jobId of jobs) {
        const lines = readJournal(this.deps.stateDir, jobId);
        const first = lines[0];
        if (!first || first.type !== "plan") { removeJournal(this.deps.stateDir, jobId); destroyJobKey(this.deps.stateDir, jobId); continue; }
        const { type: _t, sealed, ...stored } = first as unknown as StoredPlan & { type: string };
        if (lines.some((l) => l.type === "complete")) {
          destroyJobKey(this.deps.stateDir, jobId);
          removeJournal(this.deps.stateDir, jobId);
          continue;
        }
        const known = journalFenceHashes(lines);
        for (const h of known) fenceCoachHash(h);
        const secrets = unsealForJob<PlanSecrets>(this.deps.stateDir, jobId, sealed);
        if (secrets) {
          // journals from before the NFC fence key: fence the NFC form too, and journal it so it is always released
          const nfc = coachKeyHash(secrets.coach);
          if (!known.includes(nfc)) { appendJournal(this.deps.stateDir, jobId, { type: "fence", hashes: [nfc] }); fenceCoachHash(nfc); }
        }
        // Stuck (out of retries, or its key is gone): never retried automatically; journal, key and fence stay until an
        // admin retries or closes it from the admin card.
        if (lines.some((l) => l.type === "abandoned")) { open.push(jobId); continue; }
        const expired = this.now() - Date.parse(stored.at) > JOB_RETRY_DAYS * 24 * 60 * 60_000;
        if (!secrets || expired) { this.markStuck(stored, lines); open.push(jobId); continue; }
        const pending = await this.runSteps({ ...stored, ...secrets });
        if (pending.length) open.push(jobId);
      }
      return open;
    });
  }

  /**
   * Out of retries (or the key is gone): the job is STUCK. It is never retried automatically and an admin is alerted
   * (log + the admin card), but the journal, the job key and the fence all stay: releasing the fence of an incomplete job
   * would reopen a partly deleted account. Only an admin closes it (closeJob) or retries it (retryJob).
   */
  private markStuck(stored: Omit<StoredPlan, "sealed">, lines: ReturnType<typeof readJournal>): void {
    const dir = this.deps.stateDir;
    const done = new Set(lines.flatMap((l) => (l.type === "step" && l.status !== "failed" ? [l.step] : [])));
    const pending = DELETE_STEPS.map((s) => s.id).filter((id) => !done.has(id));
    const at = new Date(this.now()).toISOString();
    appendFailedJob(dir, { jobId: stored.jobId, pseudonym: stored.pseudonym, pending, startedAt: stored.at, abandonedAt: at });
    appendJournal(dir, stored.jobId, { type: "abandoned", at, pending });
    console.error(`[privacy] delete job ${stored.jobId} (${stored.pseudonym}) is stuck on ${pending.join(", ")}: an admin must retry or close it.`);
  }

  /** Admin: run a stuck job's pending steps again now (e.g. the fork is back). Returns the steps still pending. */
  retryJob(jobId: string): Promise<string[] | undefined> {
    return this.serial(async () => {
      const lines = readJournal(this.deps.stateDir, jobId);
      const first = lines[0];
      if (!first || first.type !== "plan" || !this.deps.mapKey) return undefined;
      const { type: _t, sealed, ...stored } = first as unknown as StoredPlan & { type: string };
      const secrets = unsealForJob<PlanSecrets>(this.deps.stateDir, jobId, sealed);
      if (!secrets) return undefined;
      return this.runSteps({ ...stored, ...secrets });
    });
  }

  /**
   * Admin: close a stuck job without finishing it (the admin resolved the rest by hand, e.g. removed the fork account).
   * Audited as closed; the journal, key and fence go only now.
   */
  closeJob(jobId: string, admin: string): Promise<CloseResult> {
    return this.serial(async (): Promise<CloseResult> => {
      const dir = this.deps.stateDir;
      const lines = readJournal(dir, jobId);
      const first = lines[0];
      if (!first || first.type !== "plan") return { ok: false, reason: "not-found" };
      const stored = first as unknown as StoredPlan;
      const done = new Set(lines.flatMap((l) => (l.type === "step" && l.status !== "failed" ? [l.step] : [])));
      const pending = DELETE_STEPS.map((x) => x.id).filter((id) => !done.has(id));
      // Only a job whose account is already gone (identity removed, sessions revoked, everything else done) may be closed.
      const blocking = pending.filter((id) => !CLOSABLE_PENDING.has(id));
      if (blocking.length) return { ok: false, reason: "unfinished", pending };
      const secrets = unsealForJob<PlanSecrets>(dir, jobId, stored.sealed);
      if (pending.includes("final-sweep") && secrets) {
        // the final sweep is attempted as part of Close (it needs the sealed names; without the key it cannot run)
        const sweep = DELETE_STEPS.find((x) => x.id === "final-sweep")!;
        try {
          const status = await sweep.run(deleteContext(this.deps, { ...stored, ...secrets }));
          appendJournal(dir, jobId, { type: "step", step: sweep.id, status, at: new Date(this.now()).toISOString() });
        } catch (e) {
          appendJournal(dir, jobId, { type: "step", step: sweep.id, status: "failed", at: new Date(this.now()).toISOString(), error: String((e as NodeJS.ErrnoException).code ?? (e as Error).message).slice(0, 120) });
        }
      }
      appendAudit(dir, { at: new Date(this.now()).toISOString(), actor: `${stored.actor}; closed by admin:${admin}`, pseudonym: stored.pseudonym, jobId });
      appendJournal(dir, jobId, { type: "complete", at: new Date(this.now()).toISOString() });
      const hashes = journalFenceHashes(readJournal(dir, jobId));
      destroyJobKey(dir, jobId);
      removeJournal(dir, jobId);
      for (const h of hashes) releaseCoachHash(h, this.now());
      return { ok: true };
    });
  }

  private async runSteps(plan: DeletePlan): Promise<string[]> {
    const dir = this.deps.stateDir;
    const finished = new Set(readJournal(dir, plan.jobId).flatMap((l) => (l.type === "step" && l.status !== "failed" ? [l.step] : [])));
    const ctx = deleteContext(this.deps, plan);
    const pending: string[] = [];
    for (const step of DELETE_STEPS) {
      if (finished.has(step.id)) continue;
      try {
        const status = await step.run(ctx);
        appendJournal(dir, plan.jobId, { type: "step", step: step.id, status, at: new Date(this.now()).toISOString() });
      } catch (error) {
        pending.push(step.id);
        // error codes / transport messages only (a path could name a file; keep it short and never the coach)
        const e = error as NodeJS.ErrnoException;
        appendJournal(dir, plan.jobId, { type: "step", step: step.id, status: "failed", at: new Date(this.now()).toISOString(), error: (e.code ?? String(e.message ?? e)).slice(0, 120) });
        break; // a failed step halts the job: later steps never run ahead of it; the retry resumes here
      }
    }
    if (pending.length === 0) {
      // audit first (idempotent by job id), then the complete marker: a crash in between never loses the audit
      appendAudit(dir, { at: new Date(this.now()).toISOString(), actor: plan.actor, pseudonym: plan.pseudonym, jobId: plan.jobId });
      appendJournal(dir, plan.jobId, { type: "complete", at: new Date(this.now()).toISOString() });
      const hashes = new Set([...journalFenceHashes(readJournal(dir, plan.jobId)), plan.coachHash]);
      destroyJobKey(dir, plan.jobId);
      removeJournal(dir, plan.jobId);
      for (const h of hashes) releaseCoachHash(h, this.now());
      this.deps.onCoachDeleted?.();
    }
    return pending;
  }
}

// ---- streamed zip (stored entries, no temp files) ----------------------------------------------------------------

export class ExportTooLargeError extends Error {}

/** Check the export against the cap before anything is sent. */
export function exportSize(files: ExportFile[]): number {
  return files.reduce((n, f) => n + (typeof f.content === "string" ? Buffer.byteLength(f.content, "utf8") : f.content.length), 0);
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Write the files to the response as a zip, entry by entry (the response is never buffered whole). */
export async function streamZip(res: ServerResponse, files: ExportFile[], filename: string, now = new Date(), max = EXPORT_MAX_BYTES): Promise<void> {
  if (exportSize(files) > max) throw new ExportTooLargeError(`The export is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const write = (chunk: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (res.write(chunk)) resolve();
    else { res.once("drain", resolve); res.once("error", reject); }
  });
  const { time, date } = dosTime(now);
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    await write(Buffer.concat([local, nameBuf]));
    await write(data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  await write(Buffer.concat([centralBuf, end]));
  res.end();
}
