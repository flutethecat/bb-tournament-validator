/**
 * Privacy state under <FORK_STATE_DIR>/privacy/ (never committed; the repo is public):
 *
 *   jobs/<jobId>.jsonl     the delete journal of one running job, append-only, one JSON object per line:
 *                            {"type":"plan", ...DeletePlan}                 first line, written before any step. It holds
 *                                                                           hashes and file keys in the clear; the names
 *                                                                           the steps need are only inside `sealed`
 *                                                                           (AES-256-GCM, key in keys/<jobId>.key)
 *                            {"type":"step","step":"<id>","status":"done"|"skipped"|"failed","at":"<iso>","error"?}
 *                            {"type":"complete","at":"<iso>"}                after the audit line is written
 *                            {"type":"abandoned","at","pending"}            retries ran out (7 days)
 *                          The file and its key are removed once the job completes or is abandoned, so the link between
 *                          the coach and the pseudonym does not outlive the job. A file left behind by a crash is resumed
 *                          on startup: a step with no "done"/"skipped" line runs again (every step is idempotent).
 *   keys/<jobId>.key       the job's sealing key (destroyed with the job).
 *   pseudonym-counter.json {"next": n}: the next "Deleted coach #<n>".
 *   deleted-coaches.json   {"version":2,"entries":{HMAC(PRIVACY_MAP_KEY, "coach:"+identity key | "naf:"+verified NAF id):
 *                          pseudonym}}: results, replay moments and NAF games written later are anonymised on write.
 *                          The key lives in the operator's environment, never here.
 *   recent-deletions.json  {"version":1,"markers":{HMAC(PRIVACY_MAP_KEY,"discord:"+id): expiry}}: a deleted account's
 *                          Discord sign-in is refused for 24 h.
 *   blocklist.json         {"version":1,"hashes":[...]}: HMAC-SHA256(salt, Discord user id) of deleted BANNED coaches.
 *   blocklist-salt         the salt when PRIVACY_BLOCKLIST_SALT is unset (generated on first use, mode 0600).
 *   audit.jsonl            one line per completed deletion: {"at","actor":"self"|"admin:<coach>","pseudonym","jobId"}.
 *   failed-jobs.jsonl      abandoned jobs for the admin card: {jobId, pseudonym, pending, startedAt, abandonedAt}.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";

export const privacyDir = (stateDir: string): string => join(stateDir, "privacy");
const jobsDir = (stateDir: string): string => join(privacyDir(stateDir), "jobs");

const unlinkIfExists = (path: string): void => {
  try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
};
const readLines = <T>(path: string): T[] => {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
};

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

// ---- salt + blocklist -------------------------------------------------------------------------------------------

/** The blocklist salt. */
export function privacySalt(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
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
  createHmac("sha256", privacySalt(stateDir, env)).update(discordUserId.trim(), "utf8").digest("hex");

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

// ---- deleted-coach map + recent-deletion markers --------------------------------------------------------------------
// Keyed hashes whose key (PRIVACY_MAP_KEY) lives in the operator's environment, never in the state dir, so the file alone
// cannot be checked against a dictionary of coach names, NAF ids or Discord ids. Without the key the delete feature is
// off (src/server.ts answers 503) and no write filter runs.

/** The operator key for the deleted-coach map, or undefined (feature off). At least 32 characters. */
export function privacyMapKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = env.PRIVACY_MAP_KEY?.trim();
  return k && k.length >= 32 ? k : undefined;
}

const mapFile = (stateDir: string): string => join(privacyDir(stateDir), "deleted-coaches.json");
let mapCache: { file: string; stamp: string; entries: Record<string, string> } | undefined;

/**
 * The map. Only a missing file is empty. Any other read or parse error: `strict` (the delete step that writes the map)
 * throws, so a new entry never overwrites the previous mappings with an empty map; the write filters keep the last
 * good copy read in this process, and with none they throw (fail closed: the writer refuses rather than stores names).
 */
function readDeletedMap(stateDir: string, strict = false): Record<string, string> {
  const file = mapFile(stateDir);
  let stamp = "none";
  try { const st = statSync(file); stamp = `${st.mtimeMs}:${st.size}`; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return failedMapRead(file, strict, e);
  }
  if (mapCache && mapCache.file === file && mapCache.stamp === stamp) return mapCache.entries;
  let entries: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
    if (!raw || typeof raw !== "object" || (raw.entries !== undefined && (typeof raw.entries !== "object" || raw.entries === null || Array.isArray(raw.entries))))
      throw new Error("deleted-coach map is malformed");
    entries = Object.fromEntries(Object.entries((raw.entries ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return failedMapRead(file, strict, e);
  }
  mapCache = { file, stamp, entries };
  return entries;
}

function failedMapRead(file: string, strict: boolean, error: unknown): Record<string, string> {
  if (!strict && mapCache && mapCache.file === file) return mapCache.entries; // the last good copy
  throw error;
}

export const mapHash = (mapKey: string, kind: "coach" | "naf" | "discord", value: string): string =>
  createHmac("sha256", mapKey).update(`${kind}:${value}`, "utf8").digest("hex");

function writeDeletedMap(stateDir: string, entries: Record<string, string>): void {
  mkdirSync(privacyDir(stateDir), { recursive: true });
  atomicWriteTextFile(mapFile(stateDir), `${JSON.stringify({ version: 2, entries }, null, 2)}\n`);
}

/** `coachKeys` are identity-store keys (normalizeFfbCoachId); `nafId` only when verified as the coach's. */
export function recordDeletedCoach(stateDir: string, mapKey: string, coachKeys: readonly string[], pseudonym: string, nafId?: string): void {
  const entries = { ...readDeletedMap(stateDir, true) };
  for (const k of coachKeys) entries[mapHash(mapKey, "coach", k)] = pseudonym;
  if (nafId) entries[mapHash(mapKey, "naf", nafId)] = pseudonym;
  writeDeletedMap(stateDir, entries);
}

/** The pseudonym of a deleted coach by identity-store key, or undefined. */
export function deletedPseudonymFor(stateDir: string, mapKey: string, coachKey: string): string | undefined {
  if (!coachKey) return undefined;
  const entries = readDeletedMap(stateDir);
  return Object.keys(entries).length ? entries[mapHash(mapKey, "coach", coachKey)] : undefined;
}

/** The pseudonym of a deleted coach by their verified NAF id, or undefined. */
export function deletedPseudonymForNaf(stateDir: string, mapKey: string, nafId: string): string | undefined {
  if (!nafId) return undefined;
  const entries = readDeletedMap(stateDir);
  return Object.keys(entries).length ? entries[mapHash(mapKey, "naf", nafId)] : undefined;
}

export const RECENT_DELETION_MS = 24 * 60 * 60_000;
const markerFile = (stateDir: string): string => join(privacyDir(stateDir), "recent-deletions.json");

/** Only a missing file is empty; any other read / parse error throws. */
function readMarkers(stateDir: string, now: number): Record<string, number> {
  let text: string;
  try { text = readFileSync(markerFile(stateDir), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const raw = JSON.parse(text) as { markers?: Record<string, unknown> };
  return Object.fromEntries(Object.entries(raw.markers ?? {}).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > now));
}

/** A deleted account's Discord id (as a keyed hash) is refused at sign-in for 24 h (late OAuth callbacks). */
export function markRecentDeletion(stateDir: string, discordMark: string, now = Date.now()): void {
  const markers = { ...readMarkers(stateDir, now), [discordMark]: now + RECENT_DELETION_MS };
  mkdirSync(privacyDir(stateDir), { recursive: true });
  atomicWriteTextFile(markerFile(stateDir), `${JSON.stringify({ version: 1, markers }, null, 2)}\n`);
}

export function isRecentlyDeleted(stateDir: string, mapKey: string | undefined, discordUserId: string, now = Date.now()): boolean {
  if (!mapKey || !discordUserId) return false;
  try {
    return Object.hasOwn(readMarkers(stateDir, now), mapHash(mapKey, "discord", discordUserId.trim()));
  } catch {
    return true; // unreadable markers: fail closed (the sign-in is refused until the file is readable again)
  }
}

// ---- audit ------------------------------------------------------------------------------------------------------

export interface AuditEntry { at: string; actor: string; pseudonym: string; jobId?: string }

/** One line per job: a second call for the same job id (a resumed job) is a no-op. */
export function appendAudit(stateDir: string, entry: AuditEntry): void {
  if (entry.jobId && readAudit(stateDir).some((a) => a.jobId === entry.jobId)) return;
  mkdirSync(privacyDir(stateDir), { recursive: true });
  appendFileSync(join(privacyDir(stateDir), "audit.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export const readAudit = (stateDir: string): AuditEntry[] => readLines<AuditEntry>(join(privacyDir(stateDir), "audit.jsonl"));

// ---- sealed plan data -------------------------------------------------------------------------------------------

const keyFile = (stateDir: string, jobId: string): string => join(privacyDir(stateDir), "keys", `${jobId}.key`);

export function sealForJob(stateDir: string, jobId: string, value: unknown): string {
  const key = randomBytes(32);
  mkdirSync(join(privacyDir(stateDir), "keys"), { recursive: true });
  atomicWriteTextFile(keyFile(stateDir, jobId), key.toString("hex"));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** The sealed value, or undefined when the job key is gone (job ended) or the data does not authenticate. */
export function unsealForJob<T>(stateDir: string, jobId: string, sealed: string): T | undefined {
  try {
    const key = Buffer.from(readFileSync(keyFile(stateDir, jobId), "utf8").trim(), "hex");
    const raw = Buffer.from(sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export const destroyJobKey = (stateDir: string, jobId: string): void => unlinkIfExists(keyFile(stateDir, jobId));

// ---- abandoned jobs ---------------------------------------------------------------------------------------------

export interface FailedJob { jobId: string; pseudonym: string; pending: string[]; startedAt: string; abandonedAt: string }

export function appendFailedJob(stateDir: string, job: FailedJob): void {
  if (readFailedJobs(stateDir).some((j) => j.jobId === job.jobId)) return;
  mkdirSync(privacyDir(stateDir), { recursive: true });
  appendFileSync(join(privacyDir(stateDir), "failed-jobs.jsonl"), `${JSON.stringify(job)}\n`, { encoding: "utf8", mode: 0o600 });
}

export const readFailedJobs = (stateDir: string): FailedJob[] => readLines<FailedJob>(join(privacyDir(stateDir), "failed-jobs.jsonl"));

// ---- journal ----------------------------------------------------------------------------------------------------

export type StepStatus = "done" | "skipped" | "failed";
export type JournalLine =
  | ({ type: "plan" } & Record<string, unknown>)
  | { type: "step"; step: string; status: StepStatus; at: string; error?: string }
  | { type: "complete"; at: string }
  | { type: "abandoned"; at: string; pending: string[] };

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
export const readJournal = (stateDir: string, jobId: string): JournalLine[] => readLines<JournalLine>(jobFile(stateDir, jobId));

export function listJobs(stateDir: string): string[] {
  try {
    return readdirSync(jobsDir(stateDir)).filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)).filter((id) => JOB_ID.test(id)).sort();
  } catch {
    return [];
  }
}

export function removeJournal(stateDir: string, jobId: string): void {
  const file = jobFile(stateDir, jobId);
  if (existsSync(file)) unlinkIfExists(file);
}
