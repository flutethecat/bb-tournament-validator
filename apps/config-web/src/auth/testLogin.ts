/**
 * TEST SIGN-IN for local UAT only: POST /api/auth/test-login mints a real "discord"-method session without Discord.
 *
 * Inert (the path 404s like any unknown one) unless BOTH env vars are set:
 *   TEST_LOGIN_SECRET   >= 16 chars; sent as the X-Test-Login header
 *   TEST_LOGIN_COACHES  comma list of name[:level], level player|organizer|admin (default player)
 * Loopback callers only, no X-Forwarded-For, X-CW-Auth CSRF header required, timing-safe secret compare,
 * 3 wrong secrets per 10 min per IP -> 429. Never set these on a public host.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BANNED_ACCOUNT_MESSAGE, coachLevel } from "./access.js";
import { normalizeFfbCoachId, ownIdentityRecord, readIdentities, upsertIdentity, type CoachLevel } from "./identitiesStore.js";
import { attemptState, lockoutRemaining, recordFailure, type LoginAttempt } from "./loginAttempts.js";
import { buildSessionCookie, createSession, requestUsesTls } from "./session.js";

/** Any of these means the request came through a proxy: refuse, whatever the socket address says. */
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"];

export const TEST_LOGIN_PATH = "/api/auth/test-login";
const MAX_FAILURES = 3;
const WINDOW_MS = 10 * 60 * 1000;
const LEVEL_RANK: Record<CoachLevel, number> = { player: 0, organizer: 1, admin: 2 };

/** Own counter (not the coach-password one): a test-login probe must not lock real coaches out. */
export const testLoginAttemptsByIp = new Map<string, LoginAttempt>();

interface TestCoach { name: string; level: CoachLevel }

function config(): { secret: string; coaches: TestCoach[] } | undefined {
  const secret = process.env.TEST_LOGIN_SECRET ?? "";
  const list = process.env.TEST_LOGIN_COACHES ?? "";
  if (secret.length < 16 || !list.trim()) return undefined;
  const coaches: TestCoach[] = [];
  for (const part of list.split(",")) {
    const [rawName, rawLevel] = part.split(":");
    const name = (rawName ?? "").trim();
    if (!name) continue;
    const level = (rawLevel ?? "player").trim().toLowerCase();
    if (level !== "player" && level !== "organizer" && level !== "admin") continue;
    coaches.push({ name, level });
  }
  return coaches.length ? { secret, coaches } : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4 * 1024) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/** Returns true when the request was a test-login (handled), false to fall through. */
export async function handleTestLogin(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== TEST_LOGIN_PATH || (req.method ?? "GET") !== "POST") return false;
  const cfg = config();
  if (!cfg) return false;

  if (!isLoopback(req) || PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
    sendJson(res, 403, { error: "Test sign-in is loopback-only." });
    return true;
  }
  const given = req.headers["x-test-login"];
  if (req.headers["x-cw-auth"] !== "1" || typeof given !== "string" || !given) {
    sendJson(res, 403, { error: "Missing required X-CW-Auth / X-Test-Login header." });
    return true;
  }

  const now = Date.now();
  const ip = req.socket.remoteAddress ?? "unknown";
  const attempt = attemptState(testLoginAttemptsByIp, ip, now, WINDOW_MS);
  const remaining = lockoutRemaining(attempt, now);
  if (remaining > 0) {
    sendJson(res, 429, { error: "Too many attempts. Try again later." }, { "retry-after": String(Math.max(1, Math.ceil(remaining / 1000))) });
    return true;
  }
  if (!secretMatches(given, cfg.secret)) {
    recordFailure(attempt, now, MAX_FAILURES, WINDOW_MS);
    sendJson(res, 401, { error: "Invalid test sign-in secret." });
    return true;
  }

  let body: unknown;
  try { body = await readBody(req); } catch { sendJson(res, 400, { error: "Invalid JSON request body." }); return true; }
  const requested = body && typeof body === "object" ? (body as { coach?: unknown }).coach : undefined;
  if (typeof requested !== "string" || !requested.trim()) {
    sendJson(res, 400, { error: "coach is required." });
    return true;
  }
  const listed = cfg.coaches.find((c) => c.name.toLowerCase() === requested.trim().toLowerCase());
  if (!listed) {
    sendJson(res, 403, { error: "Coach is not in TEST_LOGIN_COACHES." });
    return true;
  }

  // Raise (never lower) the stored level THROUGH the identities store, the same writer /api/admin/identities uses.
  // Compare the RAW stored level (coachLevel() reports banned coaches as player); never touch a banned coach.
  const stored = readIdentities().coaches[normalizeFfbCoachId(listed.name)];
  if (stored?.banned === true) {
    sendJson(res, 403, { error: BANNED_ACCOUNT_MESSAGE });
    return true;
  }
  let level = coachLevel(listed.name);
  if (LEVEL_RANK[listed.level] > LEVEL_RANK[stored?.level ?? "player"] && LEVEL_RANK[listed.level] > LEVEL_RANK[level]) {
    try {
      const record = ownIdentityRecord(listed.name);
      upsertIdentity({ ...record, level: listed.level, updatedAt: new Date().toISOString(), updatedBy: "test-login" });
      level = listed.level;
      console.log(`test-login: ${listed.name} level -> ${listed.level}`);
    } catch (error) {
      sendJson(res, 500, { error: `Could not raise level: ${(error as Error).message}` });
      return true;
    }
  }

  const { token } = createSession(listed.name, now, "discord", { test: true });
  sendJson(res, 200, { ok: true, coach: listed.name, level }, { "set-cookie": buildSessionCookie(token, requestUsesTls(req)) });
  return true;
}
