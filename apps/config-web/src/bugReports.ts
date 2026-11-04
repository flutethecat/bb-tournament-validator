/**
 * Bug-report ingestion (owner feature 08-18): the FUMBBL40k client's Report button POSTs
 * {description + wire/app logs + game context} here for on-disk storage + later ingestion.
 *
 * Auth mirrors the other coach-scoped fork routes (my-games/build): Bearer session, OR
 * coach + passwordMd5/password dual-accept verified against ffb_coaches. A report must be
 * attributable. Creds are STRIPPED before persisting — report.json is built from an
 * explicit field allowlist, never a body spread.
 *
 * Abuse surface fails closed: 15MB body cap at READ time, per-field caps (413), and a
 * per-coach in-memory rate limit (10/hour, 429) — same idiom as auth/loginAttempts.ts.
 *
 * Reporter updates (owner 11-04): a successful submit also returns a one-time `receipt` (32 random bytes, base64url).
 * Only its SHA-256 (`receiptHash`) is stored, in a small per-report `status.json` beside report.json, and it never
 * leaves this module. The public POST /api/bug-reports/status reads ONLY status.json (size-capped), never the full
 * report, and answers { status, reply, replyAt, fixedIn, updatedAt } for entries whose receipt matches. `playerUpdate`
 * in report.json holds the owner's public reply and fixed-in version, apart from the private triage notes; every PATCH
 * rewrites status.json from it. Reports filed before receipts have no status.json and are never answered.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coachSecretDigest } from "@bb/fork-ops";
import { noteLegacyPasswordAuth } from "./auth/deprecation.js";
import type { SessionIdentity } from "./auth/requireSession.js";

export const BUG_REPORT_BODY_CAP = 48 * 1024 * 1024; // logs plus an optional base64 screenshot
export const WIRE_LOG_CAP = 12 * 1024 * 1024;
export const APP_LOG_CAP = 2 * 1024 * 1024;
export const CONTEXT_CAP = 32 * 1024; // serialized
export const DESCRIPTION_CAP = 4000; // chars
export const SCREENSHOT_CAP = 5 * 1024 * 1024;
export const TRIAGE_TEXT_CAP = 8000;
export const RATE_LIMIT_MAX = 10;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Owner's public reply to the reporter (shown in the client). */
export const REPLY_CAP = 2000;
/** "Fixed in" client version, e.g. 1.0.307 or 1.0.307a. */
export const FIXED_IN_CAP = 32;
const FIXED_IN_PATTERN = /^\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+.]?[A-Za-z0-9]{1,16})?$/;
/** POST /api/bug-reports/status: entries per request, body cap, per-IP rate limit. */
export const STATUS_QUERY_MAX = 50;
export const STATUS_BODY_CAP = 16 * 1024;
export const STATUS_RATE_MAX = 30;
export const STATUS_RATE_WINDOW_MS = 60 * 60 * 1000;
const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, unpadded
const RECEIPT_HASH_PATTERN = /^[0-9a-f]{64}$/;
/** status.json: the only file the public status check reads. */
const STATUS_FILE = "status.json";
export const STATUS_RECORD_CAP = 8 * 1024;
/** Short scalar metadata on a submit (clientVersion, gameId): over-long values are refused with 400. */
export const METADATA_FIELD_CAP = 64;

export class BodyTooLargeError extends Error {}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** A fresh one-time receipt and the hash that is the only thing stored. */
export function newReceipt(): { receipt: string; receiptHash: string } {
  const receipt = randomBytes(32).toString("base64url");
  return { receipt, receiptHash: sha256(receipt).toString("hex") };
}

/** Constant-time check of a presented receipt against a stored hash. Missing / malformed hash never matches. */
export function receiptMatches(storedHash: unknown, receipt: string): boolean {
  const valid = typeof storedHash === "string" && RECEIPT_HASH_PATTERN.test(storedHash);
  // A missing hash still pays for one hash + compare, so a miss costs the same as a wrong receipt.
  const equal = timingSafeEqual(sha256(receipt), valid ? Buffer.from(storedHash, "hex") : DUMMY_HASH);
  return valid && equal;
}
const DUMMY_HASH = Buffer.alloc(32);

/** readBody with a hard cap, enforced WHILE reading — an oversize body is aborted, not buffered. */
export async function readJsonCapped(req: AsyncIterable<Buffer>, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new BodyTooLargeError(`Request body exceeds the ${maxBytes}-byte limit for this route.`);
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Strict allowlist [A-Za-z0-9_-] + truncate — path traversal is the obvious attack here. */
export function sanitizeComponent(raw: string | undefined, fallback: string, max = 40): string {
  const cleaned = (raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, max);
  return cleaned || fallback;
}

// Per-coach submission timestamps (normalized name). In-memory, same tradeoff as loginAttempts.
export const reportTimesByCoach = new Map<string, number[]>();

function rateLimited(coach: string, now: number): number {
  const key = coach.trim().toLowerCase();
  const times = (reportTimesByCoach.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  reportTimesByCoach.set(key, times);
  if (times.length >= RATE_LIMIT_MAX) return RATE_WINDOW_MS - (now - times[0]!);
  return 0;
}

function noteReport(coach: string, now: number): void {
  reportTimesByCoach.get(coach.trim().toLowerCase())!.push(now);
}

/**
 * Organizer/admin gate for the read routes — fail-closed: no organizer identity and no
 * admin auth (including ADMIN_PASSWORD unset) ⇒ refused.
 */
export function bugReportAccessError(opts: { organizer: boolean; adminAuthed: boolean }): string | undefined {
  if (opts.organizer || opts.adminAuthed) return undefined;
  return "Bug-report access is restricted to organizers — sign in as an organizer coach or use admin auth.";
}

export interface BugReportBody {
  coach?: string;
  password?: string;
  passwordMd5?: string;
  /** Owner 09-10: set by the PUBLIC client edition (no fork account) — accepted unauthenticated, filed as `fumbbl:<coach>`. */
  publicEdition?: boolean;
  description?: string;
  gameId?: string;
  gameService?: string;
  clientVersion?: string;
  wireLog?: string | null;
  appLog?: string | null;
  context?: unknown;
  kind?: "bug" | "feedback";
  screenshot?: {
    fileName?: string;
    mimeType?: string;
    base64?: string;
  };
}

export interface BugReportDeps {
  dir: string;
  authenticationAvailable: boolean;
  verifyCoachDigest: (coach: string, passwordMd5: string) => Promise<boolean>;
}

export interface BugReportResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const asTrimmed = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Owner 08-18: which SERVICE the game id belongs to. Strict allowlist — an unknown value from a
 *  future/foreign client degrades to null (unknown), never to a trusted-looking string. */
export function normalizeGameService(v: unknown): "fumbbl" | "fork" | null {
  return v === "fumbbl" || v === "fork" ? v : null;
}

export type ReportKind = "bug" | "feedback";
export type ReportTriageStatus = "new" | "triaged" | "in-progress" | "resolved" | "closed";

const TRIAGE_STATUSES = new Set<ReportTriageStatus>(["new", "triaged", "in-progress", "resolved", "closed"]);
const SCREENSHOT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function decodeScreenshot(value: BugReportBody["screenshot"]):
  | { bytes: Buffer; fileName: string; mimeType: string }
  | { error: string }
  | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return { error: "screenshot must be an object." };
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.toLowerCase() : "";
  const extension = SCREENSHOT_TYPES[mimeType];
  if (!extension) return { error: "screenshot must be a PNG, JPEG, or WebP image." };
  if (typeof value.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))
    return { error: "screenshot base64 is invalid." };
  const bytes = Buffer.from(value.base64, "base64");
  if (bytes.length === 0) return { error: "screenshot is empty." };
  if (bytes.length > SCREENSHOT_CAP) return { error: `screenshot exceeds the ${SCREENSHOT_CAP / (1024 * 1024)}MB limit.` };
  return { bytes, fileName: `screenshot.${extension}`, mimeType };
}

export async function submitBugReport(
  raw: unknown,
  auth: SessionIdentity | undefined,
  deps: BugReportDeps,
  now = Date.now(),
): Promise<BugReportResult> {
  const body = (raw && typeof raw === "object" ? raw : {}) as BugReportBody;

  // --- auth: proven identity first, else coach creds (dual-accept, siblings' pattern) ---
  let coach: string;
  if (auth) {
    coach = auth.coach;
  } else if (body.publicEdition === true) {
    // Owner 09-10: the PUBLIC client edition (github.com/flutethecat/superfumbbl-client) has no fork account. Its
    // reports are accepted unauthenticated, filed under `fumbbl:<claimed FUMBBL coach>` so triage can tell them
    // apart, and share the per-coach rate limit (10/hour) — anonymous senders pool under `fumbbl:anonymous`.
    coach = `fumbbl:${(asTrimmed(body.coach) || "anonymous").slice(0, 40)}`;
  } else {
    const bodyCoach = asTrimmed(body.coach);
    if (!bodyCoach || (!body.password && !body.passwordMd5))
      return { status: 401, body: { error: "A bug report requires a session token (POST /api/fork/login), or your coach name + fork password." } };
    if (!deps.authenticationAvailable)
      return { status: 503, body: { error: "Coach auth unavailable (fork DB not configured on this host)." } };
    let digest: string | undefined;
    try {
      const reduced = coachSecretDigest({
        passwordMd5: typeof body.passwordMd5 === "string" ? body.passwordMd5 : undefined,
        password: typeof body.password === "string" ? body.password : undefined,
      });
      digest = reduced.digest;
      if (reduced.legacy) noteLegacyPasswordAuth("/api/bug-reports"); // DEPRECATED back-compat (owner 08-17)
    } catch (e) {
      return { status: 400, body: { error: (e as Error).message } };
    }
    if (!digest || !(await deps.verifyCoachDigest(bodyCoach, digest)))
      return { status: 401, body: { error: "Coach authentication failed (wrong coach or password)." } };
    coach = bodyCoach;
  }

  // --- validate + per-field caps (fail closed) ---
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) return { status: 400, body: { error: "description is required." } };
  if (description.length > DESCRIPTION_CAP)
    return { status: 400, body: { error: `description exceeds ${DESCRIPTION_CAP} characters.` } };
  const kind: ReportKind = body.kind === "feedback" ? "feedback" : "bug";
  if (body.kind !== undefined && body.kind !== "bug" && body.kind !== "feedback")
    return { status: 400, body: { error: "kind must be bug or feedback." } };
  const screenshot = decodeScreenshot(body.screenshot);
  if (screenshot && "error" in screenshot)
    return { status: screenshot.error.includes("exceeds") ? 413 : 400, body: { error: screenshot.error } };
  if (body.wireLog != null && typeof body.wireLog !== "string")
    return { status: 400, body: { error: "wireLog must be a string." } };
  if (body.appLog != null && typeof body.appLog !== "string")
    return { status: 400, body: { error: "appLog must be a string." } };
  if (body.wireLog && Buffer.byteLength(body.wireLog, "utf8") > WIRE_LOG_CAP)
    return { status: 413, body: { error: `wireLog exceeds the ${WIRE_LOG_CAP / (1024 * 1024)}MB limit.` } };
  if (body.appLog && Buffer.byteLength(body.appLog, "utf8") > APP_LOG_CAP)
    return { status: 413, body: { error: `appLog exceeds the ${APP_LOG_CAP / (1024 * 1024)}MB limit.` } };
  for (const field of ["clientVersion", "gameId"] as const) {
    const value = body[field];
    if (value != null && typeof value !== "string") return { status: 400, body: { error: `${field} must be a string.` } };
    if (typeof value === "string" && value.trim().length > METADATA_FIELD_CAP)
      return { status: 400, body: { error: `${field} is limited to ${METADATA_FIELD_CAP} characters.` } };
  }
  if (body.gameService != null && typeof body.gameService !== "string")
    return { status: 400, body: { error: "gameService must be a string." } };
  let contextJson: string | undefined;
  if (body.context !== undefined) {
    if (typeof body.context !== "object" || body.context === null)
      return { status: 400, body: { error: "context must be an object." } };
    contextJson = JSON.stringify(body.context);
    if (Buffer.byteLength(contextJson, "utf8") > CONTEXT_CAP)
      return { status: 413, body: { error: `context exceeds ${CONTEXT_CAP} bytes serialized.` } };
  }

  // --- per-coach rate limit ---
  const remaining = rateLimited(coach, now);
  if (remaining > 0)
    return {
      status: 429,
      body: { error: `Too many bug reports (max ${RATE_LIMIT_MAX}/hour). Try again later.` },
      headers: { "retry-after": String(Math.max(1, Math.ceil(remaining / 1000))) },
    };

  // --- store: <UTC-timestamp>_<coach>_<[service-]gameId|nogame>/ — every component allowlisted ---
  const gameId = asTrimmed(body.gameId);
  const gameService = normalizeGameService(body.gameService);
  // Owner 08-18: the folder self-identifies WHICH service the id belongs to when both are known.
  const gameComponent = gameService && gameId ? `${gameService}-${gameId}` : gameId;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}_${sanitizeComponent(coach, "coach")}_${sanitizeComponent(gameComponent, "nogame")}`;
  let id = base;
  for (let n = 1; existsSync(join(deps.dir, id)); n += 1) id = `${base}-${n}`;
  const reportDir = join(deps.dir, id);
  mkdirSync(reportDir, { recursive: true });

  // One-time receipt for the reporter's status checks: only its hash is written, the receipt goes back once.
  const { receipt, receiptHash } = newReceipt();
  // Explicit allowlist — password/passwordMd5 (and anything unknown) never persist.
  const report = {
    id,
    coach, // the AUTHENTICATED coach, not a free-form claim
    submittedAt: new Date(now).toISOString(),
    description,
    kind,
    gameId: gameId ?? null,
    gameService,
    clientVersion: asTrimmed(body.clientVersion) ?? null,
    context: contextJson ? (JSON.parse(contextJson) as unknown) : null,
    files: {
      wireLog: body.wireLog ? "wire.log" : null,
      appLog: body.appLog ? "app.log" : null,
      screenshot: screenshot?.fileName ?? null,
      screenshotMimeType: screenshot?.mimeType ?? null,
    },
    triage: {
      status: "new" as ReportTriageStatus,
      rootCause: "",
      reason: "",
      updatedAt: null,
      updatedBy: null,
    },
    playerUpdate: emptyPlayerUpdate(),
  };
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  writeStatusRecord(reportDir, statusRecordFor(receiptHash, "new", report.playerUpdate, report.submittedAt));
  if (body.wireLog) writeFileSync(join(reportDir, "wire.log"), body.wireLog, "utf8");
  if (body.appLog) writeFileSync(join(reportDir, "app.log"), body.appLog, "utf8");
  if (screenshot) writeFileSync(join(reportDir, screenshot.fileName), screenshot.bytes);

  noteReport(coach, now);
  return { status: 200, body: { ok: true, id, receipt } };
}

/** The owner's public answer to the reporter, kept apart from the private triage notes. */
export interface PlayerUpdate {
  reply: string | null;
  replyAt: string | null;
  fixedIn: string | null;
  /** Last change to the PUBLIC fields (status, reply, fixedIn); private notes never move it. */
  updatedAt: string | null;
}

function emptyPlayerUpdate(): PlayerUpdate {
  return { reply: null, replyAt: null, fixedIn: null, updatedAt: null };
}

function normalizedPlayerUpdate(value: unknown): PlayerUpdate {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return { reply: text(raw.reply), replyAt: text(raw.replyAt), fixedIn: text(raw.fixedIn), updatedAt: text(raw.updatedAt) };
}

export interface BugReportRow {
  id: string;
  coach: string;
  gameId: string | null;
  gameService: "fumbbl" | "fork" | null;
  clientVersion: string | null;
  description: string;
  submittedAt: string;
  kind: ReportKind;
  triage: {
    status: ReportTriageStatus;
    rootCause: string;
    reason: string;
    updatedAt: string | null;
    updatedBy: string | null;
  };
  playerUpdate: PlayerUpdate;
}

function normalizedTriage(value: unknown): BugReportRow["triage"] {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    status: TRIAGE_STATUSES.has(raw.status as ReportTriageStatus) ? raw.status as ReportTriageStatus : "new",
    rootCause: typeof raw.rootCause === "string" ? raw.rootCause : "",
    reason: typeof raw.reason === "string" ? raw.reason : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
  };
}

/** Privacy notice: bug reports are kept 12 months. */
export const BUG_REPORT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Deletes report folders submitted more than the retention ago (submittedAt, else the timestamp prefix of the id). Returns the ids removed. */
export function pruneBugReports(dir: string, now = Date.now(), maxAgeMs = BUG_REPORT_RETENTION_MS): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let submitted = NaN;
    try {
      const r = JSON.parse(readFileSync(join(dir, entry.name, "report.json"), "utf8")) as { submittedAt?: unknown };
      if (typeof r.submittedAt === "string") submitted = Date.parse(r.submittedAt);
    } catch { /* fall back to the id prefix */ }
    if (Number.isNaN(submitted)) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(entry.name);
      if (m) submitted = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    }
    if (Number.isNaN(submitted) || now - submitted <= maxAgeMs) continue; // undated folders are left alone
    try { rmSync(join(dir, entry.name), { recursive: true, force: true }); removed.push(entry.name); } catch { /* retried tomorrow */ }
  }
  return removed;
}

/** Listing for the organizer view: metadata only, description truncated to 200 chars. */
export function listBugReports(dir: string): BugReportRow[] {
  if (!existsSync(dir)) return [];
  const rows: BugReportRow[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, entry.name, "report.json"), "utf8")) as BugReportRow & {
        description?: string;
      };
      rows.push({
        id: entry.name,
        coach: r.coach ?? "",
        gameId: r.gameId ?? null,
        gameService: normalizeGameService(r.gameService), // pre-08-18 reports have no field → null
        clientVersion: r.clientVersion ?? null,
        description: (r.description ?? "").slice(0, 200),
        submittedAt: r.submittedAt ?? "",
        kind: r.kind === "feedback" ? "feedback" : "bug",
        triage: normalizedTriage(r.triage),
        playerUpdate: normalizedPlayerUpdate((r as { playerUpdate?: unknown }).playerUpdate),
      });
    } catch {
      /* skip malformed folders */
    }
  }
  return rows.sort((a, b) => b.id.localeCompare(a.id)); // timestamp-prefixed ⇒ newest first
}

/** Full report.json (never the logs — those stay on disk for the owner). Traversal-safe: the id
 *  must survive the same allowlist the writer used, verbatim. */
export function getBugReport(dir: string, id: string): unknown | undefined {
  const raw = readStoredReport(dir, id);
  return raw ? withoutReceiptHash(raw) : undefined;
}

/** report.json as stored (receiptHash included) — module-internal; every caller-facing read goes through getBugReport. */
function readStoredReport(dir: string, id: string): Record<string, unknown> | undefined {
  if (!REPORT_ID_PATTERN.test(id)) return undefined;
  const file = join(dir, id, "report.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function withoutReceiptHash(report: Record<string, unknown>): Record<string, unknown> {
  const { receiptHash: _hidden, ...rest } = report;
  return rest;
}

/** Owner text for the reporter: undefined = leave unchanged, null/"" = clear. */
function parseReplyField(value: unknown): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "reply must be a string or null." };
  const trimmed = value.trim();
  if (trimmed.length > REPLY_CAP) return { ok: false, error: `reply is limited to ${REPLY_CAP} characters.` };
  return { ok: true, value: trimmed || null };
}

function parseFixedInField(value: unknown): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "fixedIn must be a string or null." };
  const trimmed = value.trim().replace(/^v(?=\d)/i, "");
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > FIXED_IN_CAP || !FIXED_IN_PATTERN.test(trimmed))
    return { ok: false, error: "fixedIn must be a version such as 1.0.307." };
  return { ok: true, value: trimmed };
}

export function updateBugReportTriage(
  dir: string,
  id: string,
  raw: unknown,
  actor: string,
  now = Date.now(),
): BugReportResult {
  const current = readStoredReport(dir, id);
  if (!current) return { status: 404, body: { error: "Bug report not found." } };
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const status = body.status;
  const rootCause = body.rootCause;
  const reason = body.reason;
  if (!TRIAGE_STATUSES.has(status as ReportTriageStatus))
    return { status: 400, body: { error: "status must be new, triaged, in-progress, resolved, or closed." } };
  if (typeof rootCause !== "string" || typeof reason !== "string")
    return { status: 400, body: { error: "rootCause and reason must be strings." } };
  if (rootCause.length > TRIAGE_TEXT_CAP || reason.length > TRIAGE_TEXT_CAP)
    return { status: 400, body: { error: `rootCause and reason are limited to ${TRIAGE_TEXT_CAP} characters each.` } };
  const reply = parseReplyField(body.reply);
  if (!reply.ok) return { status: 400, body: { error: reply.error } };
  const fixedIn = parseFixedInField(body.fixedIn);
  if (!fixedIn.ok) return { status: 400, body: { error: fixedIn.error } };
  const stamp = new Date(now).toISOString();
  // Public fields: status, reply and fixedIn move playerUpdate.updatedAt; root cause and notes never do.
  const before = normalizedPlayerUpdate(current.playerUpdate);
  const nextReply = reply.value === undefined ? before.reply : reply.value;
  const nextFixedIn = fixedIn.value === undefined ? before.fixedIn : fixedIn.value;
  const replyChanged = nextReply !== before.reply;
  const publicChanged = normalizedTriage(current.triage).status !== status || replyChanged || nextFixedIn !== before.fixedIn;
  const playerUpdate: PlayerUpdate = {
    reply: nextReply,
    replyAt: replyChanged ? (nextReply ? stamp : null) : before.replyAt,
    fixedIn: nextFixedIn,
    updatedAt: publicChanged ? stamp : before.updatedAt,
  };
  const report = {
    ...current,
    triage: {
      status,
      rootCause: rootCause.trim(),
      reason: reason.trim(),
      updatedAt: stamp,
      updatedBy: actor,
    },
    playerUpdate,
  };
  writeFileSync(join(dir, id, "report.json"), JSON.stringify(report, null, 2), "utf8");
  // Keep the small public status record in step; a report filed before receipts has none and never gets one.
  const record = readStatusRecord(dir, id);
  if (record) {
    const submittedAt = typeof current.submittedAt === "string" ? current.submittedAt : null;
    writeStatusRecord(join(dir, id), statusRecordFor(record.receiptHash, status as ReportTriageStatus, playerUpdate, submittedAt));
  }
  return { status: 200, body: { ok: true, report: withoutReceiptHash(report) } };
}

export type PublicReportStatus = "received" | "triaged" | "inProgress" | "resolved" | "closed";
const PUBLIC_STATUS: Record<ReportTriageStatus, PublicReportStatus> = {
  new: "received",
  triaged: "triaged",
  "in-progress": "inProgress",
  resolved: "resolved",
  closed: "closed",
};

export interface ReportStatusRow {
  id: string;
  status: PublicReportStatus;
  reply: string | null;
  replyAt: string | null;
  fixedIn: string | null;
  updatedAt: string | null;
}

/** Validates { reports: [{ id, receipt }] }: a bad shape or more than STATUS_QUERY_MAX entries is an error. */
export function parseStatusQuery(raw: unknown): { entries: Array<{ id: string; receipt: string }> } | { error: string } {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { reports?: unknown }).reports : undefined;
  if (!Array.isArray(list)) return { error: "reports must be an array." };
  if (list.length > STATUS_QUERY_MAX) return { error: `At most ${STATUS_QUERY_MAX} reports per request.` };
  const entries: Array<{ id: string; receipt: string }> = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Each entry must be { id, receipt }." };
    const { id, receipt } = item as { id?: unknown; receipt?: unknown };
    if (typeof id !== "string" || typeof receipt !== "string") return { error: "Each entry must be { id, receipt }." };
    entries.push({ id, receipt });
  }
  return { entries };
}

/**
 * Public status for the entries whose receipt matches. Unknown ids, malformed ids or receipts, wrong receipts and
 * reports with no stored hash (filed before receipts existed) are left out silently — the answer never says which.
 * Only the allowlisted public fields are returned.
 */
export function lookupBugReportStatuses(dir: string, entries: ReadonlyArray<{ id: string; receipt: string }>): ReportStatusRow[] {
  const rows: ReportStatusRow[] = [];
  const seen = new Set<string>();
  for (const { id, receipt } of entries) {
    // Each id is looked at once per request, case-insensitively (Windows folders are), before any read: one request
    // cannot spend its 50 entries on one report.
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!REPORT_ID_PATTERN.test(id) || !RECEIPT_PATTERN.test(receipt)) continue;
    const record = readStatusRecord(dir, id); // id validated above (and again inside) before any path is built
    // Unknown ids still run the hash + compare (against a dummy), like a wrong receipt.
    if (!receiptMatches(record?.receiptHash, receipt) || !record) continue;
    rows.push({ id, status: record.status, reply: record.reply, replyAt: record.replyAt, fixedIn: record.fixedIn, updatedAt: record.updatedAt });
  }
  return rows;
}

interface StatusRecord {
  receiptHash: string;
  status: PublicReportStatus;
  reply: string | null;
  replyAt: string | null;
  fixedIn: string | null;
  updatedAt: string | null;
}

const PUBLIC_STATUSES = new Set<PublicReportStatus>(Object.values(PUBLIC_STATUS));

function statusRecordFor(receiptHash: string, status: ReportTriageStatus, update: PlayerUpdate, submittedAt: string | null): StatusRecord {
  return {
    receiptHash,
    status: PUBLIC_STATUS[status],
    reply: update.reply,
    replyAt: update.replyAt,
    fixedIn: update.fixedIn,
    // Never edited yet: the report's own submit time, so the field is always a timestamp.
    updatedAt: update.updatedAt ?? submittedAt,
  };
}

/** Atomic (tmp + rename), so a status check never reads a half-written record. */
function writeStatusRecord(reportDir: string, record: StatusRecord): void {
  const file = join(reportDir, STATUS_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(record), "utf8");
  renameSync(`${file}.tmp`, file);
}

/** status.json only, never report.json; undefined when missing, over STATUS_RECORD_CAP or malformed. */
function readStatusRecord(dir: string, id: string): StatusRecord | undefined {
  if (!REPORT_ID_PATTERN.test(id)) return undefined;
  const file = join(dir, id, STATUS_FILE);
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > STATUS_RECORD_CAP) return undefined;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || typeof raw.receiptHash !== "string" || !RECEIPT_HASH_PATTERN.test(raw.receiptHash)) return undefined;
    if (!PUBLIC_STATUSES.has(raw.status as PublicReportStatus)) return undefined;
    const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return {
      receiptHash: raw.receiptHash,
      status: raw.status as PublicReportStatus,
      reply: text(raw.reply),
      replyAt: text(raw.replyAt),
      fixedIn: text(raw.fixedIn),
      updatedAt: text(raw.updatedAt),
    };
  } catch {
    return undefined;
  }
}

export function getBugReportScreenshot(dir: string, id: string): { mimeType: string; base64: string } | undefined {
  const report = getBugReport(dir, id) as { files?: { screenshot?: unknown; screenshotMimeType?: unknown } } | undefined;
  if (!report) return undefined;
  const fileName = typeof report.files?.screenshot === "string" ? report.files.screenshot : "";
  const mimeType = typeof report.files?.screenshotMimeType === "string" ? report.files.screenshotMimeType : "";
  if (!/^screenshot\.(png|jpg|webp)$/.test(fileName) || !SCREENSHOT_TYPES[mimeType]) return undefined;
  const file = join(dir, id, fileName);
  if (!existsSync(file)) return undefined;
  return { mimeType, base64: readFileSync(file).toString("base64") };
}
