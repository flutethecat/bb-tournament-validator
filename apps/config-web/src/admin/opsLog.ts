// The admin console's Operations log (owner 11-04: "every use is logged"): one JSON line per Operations action in
// <state dir>/admin/ops-log.jsonl, newest last. Who (the site admin's coach name), when, what, whether it was a dry run,
// the outcome (the dry run's or the apply's counts) and the backup it wrote. Append-only; nothing here is ever rewritten.
// The admin's name is the only personal data (src/privacy/collectors.ts "admin-ops-log": exported to that admin, kept on
// deletion as the audit trail of an admin action, like organiser-request decisions).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface OpsLogEntry {
  at: string;
  by: string;
  /** "ratings-reset", "ratings-restore", "demo-seed", "demo-remove", "fork-reload", "league-fork-cleanup", "test-match", "test-purge". */
  action: string;
  dryRun: boolean;
  ok: boolean;
  /** The HTTP status the action answered. */
  status: number;
  /** One plain line: what happened. */
  summary: string;
  /** The backup written before the change, when there was one. */
  backup?: string;
  /** Small machine-readable facts (counts, ids). Never secrets. */
  detail?: Record<string, unknown>;
}

export const opsLogFile = (stateDir: string): string => join(stateDir, "admin", "ops-log.jsonl");

export function appendOpsLog(stateDir: string, entry: OpsLogEntry): void {
  const file = opsLogFile(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** The newest `limit` entries, newest first. A missing log is empty; an unreadable one throws (fail closed). Bad lines are skipped. */
export function readOpsLog(stateDir: string, limit = 100): OpsLogEntry[] {
  let text: string;
  try { text = readFileSync(opsLogFile(stateDir), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const out: OpsLogEntry[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line) as OpsLogEntry;
      if (e && typeof e.at === "string" && typeof e.by === "string" && typeof e.action === "string") out.push(e);
    } catch { /* a torn line: skipped */ }
  }
  return out;
}
