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
import { normalizeFfbCoachId, readIdentities } from "../auth/identitiesStore.js";
import {
  buildPlan, collectExport, deleteContext, DELETE_STEPS, EXPORT_MAX_BYTES, ownedItems, splitPlan,
  type DeletePlan, type ExportFile, type OwnedItem, type PlanSecrets, type PrivacyDeps, type StoredPlan,
} from "./collectors.js";
import { nameKey } from "./anonymise.js";
import { fenceCoachHash, releaseCoachHash } from "./fence.js";
import {
  allocatePseudonym, appendAudit, appendFailedJob, appendJournal, blocklistHash, destroyJobKey, listJobs, newJobId,
  readFailedJobs, readJournal, removeJournal, sealForJob, unsealForJob, type FailedJob,
} from "./state.js";

export const JOB_RETRY_DAYS = 7;

export interface DeleteOutcome {
  status: "deleted" | "blocked" | "mismatch";
  owned?: OwnedItem[];
  /** Steps still pending (the fork account when the game server was unreachable). */
  pending?: string[];
  pseudonym?: string;
}

export interface OpenJob { jobId: string; pseudonym: string; pending: string[]; startedAt: string }

export class PrivacyService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly deps: PrivacyDeps, private readonly now: () => number = Date.now) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The coach's spelling on the identity record (falls back to the given name). */
  canonicalCoach(coach: string): string {
    return readIdentities().coaches[normalizeFfbCoachId(coach)]?.ffbCoachId ?? coach.trim();
  }

  owned(coach: string): OwnedItem[] {
    return ownedItems(this.deps, new Set([nameKey(coach), nameKey(this.canonicalCoach(coach))]));
  }

  exportFiles(coach: string): Promise<ExportFile[]> {
    return collectExport(this.deps, coach);
  }

  /** Open jobs (pending steps) and abandoned ones, for the admin card. Names never appear. */
  jobs(): { open: OpenJob[]; failed: FailedJob[] } {
    const open: OpenJob[] = [];
    for (const jobId of listJobs(this.deps.stateDir)) {
      const lines = readJournal(this.deps.stateDir, jobId);
      const plan = lines[0]?.type === "plan" ? (lines[0] as unknown as StoredPlan) : undefined;
      if (!plan) continue;
      const done = new Set(lines.flatMap((l) => (l.type === "step" && l.status !== "failed" ? [l.step] : [])));
      open.push({ jobId, pseudonym: plan.pseudonym, startedAt: plan.at, pending: DELETE_STEPS.map((s) => s.id).filter((id) => !done.has(id)) });
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
      const owned = this.owned(coach);
      if (owned.length) return { status: "blocked", owned };
      const jobId = newJobId();
      const plan = buildPlan(this.deps, {
        sessionCoach: coach,
        jobId,
        pseudonym: allocatePseudonym(this.deps.stateDir),
        actor,
        now,
        blockHashOf: (id) => blocklistHash(this.deps.stateDir, id, this.deps.env),
        discordAvatarUrl,
      });
      fenceCoachHash(plan.coachHash);
      const { stored, secrets } = splitPlan(plan);
      const line: StoredPlan = { ...stored, sealed: sealForJob(this.deps.stateDir, jobId, secrets) };
      appendJournal(this.deps.stateDir, jobId, { type: "plan", ...line });
      const pending = await this.runSteps(plan);
      return { status: "deleted", pending, pseudonym: plan.pseudonym };
    });
  }

  /** Resume every unfinished job (startup, retry timer). Returns the jobs still open afterwards. */
  resumeAll(): Promise<string[]> {
    return this.serial(async () => {
      const open: string[] = [];
      for (const jobId of listJobs(this.deps.stateDir)) {
        const lines = readJournal(this.deps.stateDir, jobId);
        const first = lines[0];
        if (!first || first.type !== "plan") { removeJournal(this.deps.stateDir, jobId); destroyJobKey(this.deps.stateDir, jobId); continue; }
        const { type: _t, sealed, ...stored } = first as unknown as StoredPlan & { type: string };
        if (lines.some((l) => l.type === "complete" || l.type === "abandoned")) {
          destroyJobKey(this.deps.stateDir, jobId);
          removeJournal(this.deps.stateDir, jobId);
          continue;
        }
        fenceCoachHash(stored.coachHash);
        const secrets = unsealForJob<PlanSecrets>(this.deps.stateDir, jobId, sealed);
        const expired = this.now() - Date.parse(stored.at) > JOB_RETRY_DAYS * 24 * 60 * 60_000;
        if (!secrets || expired) { this.abandon(stored, lines); continue; }
        const pending = await this.runSteps({ ...stored, ...secrets });
        if (pending.length) open.push(jobId);
      }
      return open;
    });
  }

  /** Out of retries (or the key is gone): destroy the sealed names, list the job for the admin, drop the journal. */
  private abandon(stored: Omit<StoredPlan, "sealed">, lines: ReturnType<typeof readJournal>): void {
    const dir = this.deps.stateDir;
    const done = new Set(lines.flatMap((l) => (l.type === "step" && l.status !== "failed" ? [l.step] : [])));
    const pending = DELETE_STEPS.map((s) => s.id).filter((id) => !done.has(id));
    const at = new Date(this.now()).toISOString();
    appendFailedJob(dir, { jobId: stored.jobId, pseudonym: stored.pseudonym, pending, startedAt: stored.at, abandonedAt: at });
    appendJournal(dir, stored.jobId, { type: "abandoned", at, pending });
    destroyJobKey(dir, stored.jobId);
    removeJournal(dir, stored.jobId);
    releaseCoachHash(stored.coachHash, this.now());
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
      }
    }
    if (pending.length === 0) {
      // audit first (idempotent by job id), then the complete marker: a crash in between never loses the audit
      appendAudit(dir, { at: new Date(this.now()).toISOString(), actor: plan.actor, pseudonym: plan.pseudonym, jobId: plan.jobId });
      appendJournal(dir, plan.jobId, { type: "complete", at: new Date(this.now()).toISOString() });
      destroyJobKey(dir, plan.jobId);
      removeJournal(dir, plan.jobId);
      releaseCoachHash(plan.coachHash, this.now());
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
