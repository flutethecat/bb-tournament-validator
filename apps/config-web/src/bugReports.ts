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
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coachSecretDigest } from "@bb/fork-ops";
import { noteLegacyPasswordAuth } from "./auth/deprecation.js";
import type { SessionIdentity } from "./auth/requireSession.js";

export const BUG_REPORT_BODY_CAP = 32 * 1024 * 1024; // route-specific; JSON-escaping can ~2x a 12MB log, so the raw-body cap leaves headroom (client caps: wire 12MB + app 2MB). Other routes keep today's readBody
export const WIRE_LOG_CAP = 12 * 1024 * 1024;
export const APP_LOG_CAP = 2 * 1024 * 1024;
export const CONTEXT_CAP = 32 * 1024; // serialized
export const DESCRIPTION_CAP = 4000; // chars
export const RATE_LIMIT_MAX = 10;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

export class BodyTooLargeError extends Error {}

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
  description?: string;
  gameId?: string;
  gameService?: string;
  clientVersion?: string;
  wireLog?: string | null;
  appLog?: string | null;
  context?: unknown;
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
  if (body.wireLog != null && typeof body.wireLog !== "string")
    return { status: 400, body: { error: "wireLog must be a string." } };
  if (body.appLog != null && typeof body.appLog !== "string")
    return { status: 400, body: { error: "appLog must be a string." } };
  if (body.wireLog && Buffer.byteLength(body.wireLog, "utf8") > WIRE_LOG_CAP)
    return { status: 413, body: { error: `wireLog exceeds the ${WIRE_LOG_CAP / (1024 * 1024)}MB limit.` } };
  if (body.appLog && Buffer.byteLength(body.appLog, "utf8") > APP_LOG_CAP)
    return { status: 413, body: { error: `appLog exceeds the ${APP_LOG_CAP / (1024 * 1024)}MB limit.` } };
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

  // Explicit allowlist — password/passwordMd5 (and anything unknown) never persist.
  const report = {
    id,
    coach, // the AUTHENTICATED coach, not a free-form claim
    submittedAt: new Date(now).toISOString(),
    description,
    gameId: gameId ?? null,
    gameService,
    clientVersion: asTrimmed(body.clientVersion) ?? null,
    context: contextJson ? (JSON.parse(contextJson) as unknown) : null,
    files: {
      wireLog: body.wireLog ? "wire.log" : null,
      appLog: body.appLog ? "app.log" : null,
    },
  };
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  if (body.wireLog) writeFileSync(join(reportDir, "wire.log"), body.wireLog, "utf8");
  if (body.appLog) writeFileSync(join(reportDir, "app.log"), body.appLog, "utf8");

  noteReport(coach, now);
  return { status: 200, body: { ok: true, id } };
}

export interface BugReportRow {
  id: string;
  coach: string;
  gameId: string | null;
  gameService: "fumbbl" | "fork" | null;
  clientVersion: string | null;
  description: string;
  submittedAt: string;
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
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const file = join(dir, id, "report.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
