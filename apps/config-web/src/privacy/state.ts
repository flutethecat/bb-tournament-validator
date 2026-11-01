/**
 * Privacy state under <FORK_STATE_DIR>/privacy/ (never committed; the repo is public):
 *
 *   jobs/<jobId>.jsonl     the delete journal of one running job, append-only, one JSON object per line:
 *                            {"type":"plan", ...DeletePlan}                      first line, written before any step
 *                            {"type":"step","step":"<id>","status":"done"|"skipped"|"failed","at":"<iso>","error"?}
 *                            {"type":"complete","at":"<iso>"}
 *                          The file is removed once the job completes (it names the coach; the mapping to the pseudonym
 *                          must not outlive the job). A file left behind by a crash is resumed on startup: a step with no
 *                          "done"/"skipped" line runs again (every step is idempotent).
 *   pseudonym-counter.json {"next": n}: the next "Deleted coach #<n>"; the coach -> n mapping is never stored.
 *   blocklist.json         {"version":1,"hashes":[...]}: HMAC-SHA256(salt, Discord user id) of deleted BANNED coaches.
 *   blocklist-salt         the salt when PRIVACY_BLOCKLIST_SALT is unset (generated on first use, mode 0600).
 *   audit.jsonl            one line per completed deletion: {"at","actor":"self"|"admin:<coach>","pseudonym"}.
 */
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";

export const privacyDir = (stateDir: string): string => join(stateDir, "privacy");
const jobsDir = (stateDir: string): string => join(privacyDir(stateDir), "jobs");

// ---- pseudonym counter ----------------------------------------------------------------------------------------

export function allocatePseudonym(stateDir: string): string {
  const file = join(privacyDir(stateDir), "pseudonym-counter.json");
  let next = 1;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { next?: unknown };
    if (Number.isSafeInteger(raw.next) && (raw.next as number) > 0) next = raw.next as number;
  } catch { /* first deletion */ }
  mkdirSync(privacyDir(stateDir), { recursive: true });
  atomicWriteTextFile(file, `${JSON.stringify({ next: next + 1 })}\n`);
  return `Deleted coach #${next}`;
}

// ---- blocklist --------------------------------------------------------------------------------------------------

function blocklistSalt(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PRIVACY_BLOCKLIST_SALT?.trim();
  if (fromEnv) return fromEnv;
  const file = join(privacyDir(stateDir), "blocklist-salt");
  try {
    const salt = readFileSync(file, "utf8").trim();
    if (salt) return salt;
  } catch { /* generate below */ }
  mkdirSync(privacyDir(stateDir), { recursive: true });
  const salt = randomBytes(32).toString("hex");
  atomicWriteTextFile(file, `${salt}\n`);
  return salt;
}

export const blocklistHash = (stateDir: string, discordUserId: string, env?: NodeJS.ProcessEnv): string =>
  createHmac("sha256", blocklistSalt(stateDir, env)).update(discordUserId.trim(), "utf8").digest("hex");

function readBlocklist(stateDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(privacyDir(stateDir), "blocklist.json"), "utf8")) as { hashes?: unknown };
    return Array.isArray(raw.hashes) ? raw.hashes.filter((h): h is string => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)) : [];
  } catch {
    return [];
  }
}

export function addToBlocklist(stateDir: string, hash: string): void {
  const hashes = readBlocklist(stateDir);
  if (hashes.includes(hash)) return;
  mkdirSync(privacyDir(stateDir), { recursive: true });
  atomicWriteTextFile(join(privacyDir(stateDir), "blocklist.json"), `${JSON.stringify({ version: 1, hashes: [...hashes, hash] }, null, 2)}\n`);
}

/** True when this Discord account belonged to a banned coach who was deleted (sign-in and sign-up are refused). */
export function isDiscordBlocked(stateDir: string, discordUserId: string, env?: NodeJS.ProcessEnv): boolean {
  if (!discordUserId) return false;
  const hashes = readBlocklist(stateDir);
  return hashes.length > 0 && hashes.includes(blocklistHash(stateDir, discordUserId, env));
}

// ---- audit ------------------------------------------------------------------------------------------------------

export interface AuditEntry { at: string; actor: string; pseudonym: string }

export function appendAudit(stateDir: string, entry: AuditEntry): void {
  mkdirSync(privacyDir(stateDir), { recursive: true });
  appendFileSync(join(privacyDir(stateDir), "audit.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readAudit(stateDir: string): AuditEntry[] {
  try {
    return readFileSync(join(privacyDir(stateDir), "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

// ---- journal ----------------------------------------------------------------------------------------------------

export type StepStatus = "done" | "skipped" | "failed";
export type JournalLine =
  | ({ type: "plan" } & Record<string, unknown>)
  | { type: "step"; step: string; status: StepStatus; at: string; error?: string }
  | { type: "complete"; at: string };

const JOB_ID = /^[a-f0-9]{24}$/;
export const newJobId = (): string => randomBytes(12).toString("hex");
const jobFile = (stateDir: string, jobId: string): string => {
  if (!JOB_ID.test(jobId)) throw new Error("Bad job id.");
  return join(jobsDir(stateDir), `${jobId}.jsonl`);
};

export function appendJournal(stateDir: string, jobId: string, line: JournalLine): void {
  mkdirSync(jobsDir(stateDir), { recursive: true });
  appendFileSync(jobFile(stateDir, jobId), `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The journal lines of a job; a torn last line (crash mid-append) is ignored. */
export function readJournal(stateDir: string, jobId: string): JournalLine[] {
  let text = "";
  try { text = readFileSync(jobFile(stateDir, jobId), "utf8"); } catch { return []; }
  const out: JournalLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as JournalLine); } catch { /* torn tail */ }
  }
  return out;
}

export function listJobs(stateDir: string): string[] {
  try {
    return readdirSync(jobsDir(stateDir)).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)).filter((id) => JOB_ID.test(id)).sort();
  } catch {
    return [];
  }
}

export function removeJournal(stateDir: string, jobId: string): void {
  const file = jobFile(stateDir, jobId);
  if (existsSync(file)) unlinkSync(file);
}
