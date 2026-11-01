/**
 * Data export and account deletion (privacy spec 2026-10-31 §2, §3).
 *
 * Deletion is one journaled job (src/privacy/state.ts): the plan line first, then one line per step in DELETE_STEPS order.
 * A step that throws (the fork unreachable) is journaled "failed" and the job carries on with the others; the job stays
 * open and its pending steps run again on the next retry (startup and a timer). When every step is done the job is
 * audited (pseudonym only) and its journal removed. Jobs run one at a time in this process.
 */
import type { ServerResponse } from "node:http";
import { crc32 } from "../leagues/exportZip.js";
import { discordAvatarUrl } from "../auth/discordSso.js";
import { normalizeFfbCoachId, readIdentities } from "../auth/identitiesStore.js";
import {
  buildPlan, collectExport, deleteContext, DELETE_STEPS, EXPORT_MAX_BYTES, ownedItems,
  type DeletePlan, type ExportFile, type OwnedItem, type PrivacyDeps,
} from "./collectors.js";
import { nameKey } from "./anonymise.js";
import {
  allocatePseudonym, appendAudit, appendJournal, blocklistHash, listJobs, newJobId, readJournal, removeJournal,
} from "./state.js";

export interface DeleteOutcome {
  status: "deleted" | "blocked" | "mismatch";
  owned?: OwnedItem[];
  /** Steps still pending (the fork account when the game server was unreachable). */
  pending?: string[];
  pseudonym?: string;
}

export class PrivacyService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly deps: PrivacyDeps) {}

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

  /**
   * Delete a coach (self-service or admin). `confirm` must equal the coach name (case-insensitive, trimmed). Blocked while
   * the coach owns a draft/active tournament or any league.
   */
  deleteCoach(coach: string, confirm: unknown, actor: string, now = new Date()): Promise<DeleteOutcome> {
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
      appendJournal(this.deps.stateDir, jobId, { type: "plan", ...plan });
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
        if (!first || first.type !== "plan") { removeJournal(this.deps.stateDir, jobId); continue; } // never got past the plan write
        if (lines.some((l) => l.type === "complete")) { removeJournal(this.deps.stateDir, jobId); continue; }
        const { type: _t, ...plan } = first;
        const pending = await this.runSteps(plan as unknown as DeletePlan);
        if (pending.length) open.push(jobId);
      }
      return open;
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
        appendJournal(dir, plan.jobId, { type: "step", step: step.id, status, at: new Date().toISOString() });
      } catch (error) {
        pending.push(step.id);
        // the message never carries the coach name into a log line here: steps throw transport errors only
        appendJournal(dir, plan.jobId, { type: "step", step: step.id, status: "failed", at: new Date().toISOString(), error: String((error as Error).message ?? error).slice(0, 200) });
      }
    }
    if (pending.length === 0) {
      appendJournal(dir, plan.jobId, { type: "complete", at: new Date().toISOString() });
      appendAudit(dir, { at: new Date().toISOString(), actor: plan.actor, pseudonym: plan.pseudonym });
      removeJournal(dir, plan.jobId);
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
