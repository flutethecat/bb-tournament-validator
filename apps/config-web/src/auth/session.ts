import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SESSION_COOKIE_NAME = "cw_session";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Default idle timeout: a session expires after this long WITHOUT a request (env SESSION_IDLE_MS). */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Default absolute cap: no session outlives this, however active (env SESSION_MAX_MS). */
export const SESSION_ABSOLUTE_MS = 90 * DAY_MS;
/** A slid expiry is written back to disk, and the cookie refreshed, at most this often per session. */
export const SESSION_WRITE_BACK_MS = 10 * 60 * 1000;

const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const sessionIdleMs = (): number => envMs("SESSION_IDLE_MS", SESSION_TTL_MS);
export const sessionMaxMs = (): number => envMs("SESSION_MAX_MS", SESSION_ABSOLUTE_MS);

/** How the session was authenticated. Discord-only surfaces (the web Lobby) require "discord". */
export type SessionMethod = "discord" | "password";

export interface Session {
  coach: string;
  expiry: number;
  method: SessionMethod;
}

interface Entry extends Session {
  created: number;
  /** Last time this entry was written to disk (in memory only). */
  persistedAt: number;
  /** Last time the browser cookie's Max-Age was refreshed (in memory only). */
  cookieAt?: number;
}

const TOKEN_BYTES = 32;
const TOKEN_HEX = new RegExp(`^[a-f0-9]{${TOKEN_BYTES * 2}}$`, "i");

// Hot cache keyed by SHA-256 of the token: the token itself is never stored, in memory or on disk.
const sessions = new Map<string, Entry>();
// Tokens seen by THIS process, only so the "session ended" notification can name the token (sockets close by token).
const liveTokens = new Map<string, string>();
const endedListeners: Array<(token: string) => void> = [];

const hashToken = (token: string): string => createHash("sha256").update(token.toLowerCase(), "utf8").digest("hex");

/** Notified with the token whenever a session ends (deleted or pruned as expired) and the token is known. Faults are contained. */
export function onSessionEnded(listener: (token: string) => void): void {
  endedListeners.push(listener);
}

function ended(hash: string, token?: string): void {
  const t = token ?? liveTokens.get(hash);
  liveTokens.delete(hash);
  if (!t) return;
  for (const l of endedListeners) {
    try { l(t); } catch { /* a listener fault never breaks the session store */ }
  }
}

// ---- durable store: <data-store>/sessions.json -------------------------------------------------------
const DEFAULT_SESSIONS_FILE = fileURLToPath(new URL("../../sessions.json", import.meta.url));
let loadedFrom: string | undefined | null = null; // null = never loaded

/** SESSIONS_FILE, else sessions.json beside IDENTITIES_FILE, else beside the default identities store.
 *  Under the test runner with neither set: undefined = memory only (never write into a data directory). */
function sessionsFile(): string | undefined {
  if (process.env.SESSIONS_FILE) return resolve(process.env.SESSIONS_FILE);
  if (process.env.IDENTITIES_FILE) return join(dirname(resolve(process.env.IDENTITIES_FILE)), "sessions.json");
  return process.env.VITEST ? undefined : DEFAULT_SESSIONS_FILE;
}

function persist(): void {
  const file = sessionsFile();
  if (!file) return;
  const out: Record<string, { coach: string; expiry: number; method: SessionMethod; created: number }> = {};
  for (const [hash, e] of sessions) out[hash] = { coach: e.coach, expiry: e.expiry, method: e.method, created: e.created };
  const payload = `${JSON.stringify({ version: 1, sessions: out })}\n`;
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    console.error(`[sessions] could not persist sessions: ${(error as Error).message}`);
  }
}

function expired(e: Entry, now: number): boolean {
  return e.expiry <= now || now >= e.created + sessionMaxMs();
}

/** Load the store from disk (once per configured path), pruning expired entries. Sessions already live in memory
 *  (made before the path was configured) are kept and merged in, so configuring the path never signs anyone out. */
function ensureLoaded(now: number, clear = false): void {
  const file = sessionsFile();
  if (loadedFrom === file && !clear) return;
  const hadMemory = !clear && sessions.size > 0;
  loadedFrom = file;
  if (clear) { sessions.clear(); liveTokens.clear(); }
  if (!file) return;
  let pruned = hadMemory; // a memory-only session set is written out to the newly configured file
  if (!existsSync(file)) { if (pruned) persist(); return; }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: number; sessions?: Record<string, Partial<Entry>> };
    for (const [hash, e] of Object.entries(parsed.sessions ?? {})) {
      if (!/^[a-f0-9]{64}$/.test(hash) || typeof e?.coach !== "string" || typeof e.expiry !== "number" || typeof e.created !== "number") continue;
      if (e.method !== "discord" && e.method !== "password") continue;
      const entry: Entry = { coach: e.coach, expiry: e.expiry, method: e.method, created: e.created, persistedAt: now };
      if (expired(entry, now)) { pruned = true; continue; }
      if (!sessions.has(hash)) sessions.set(hash, entry);
    }
  } catch (error) {
    console.error(`[sessions] unreadable sessions file ignored: ${(error as Error).message}`);
  }
  if (pruned) persist();
}

/** Drop the in-memory cache and reload from disk (what a server restart does; used by tests and operators). */
export function reloadSessionStore(now = Date.now()): void {
  ensureLoaded(now, true);
}

function pruneExpired(now: number): void {
  ensureLoaded(now);
  let removed = false;
  for (const [hash, e] of sessions) {
    if (expired(e, now)) { sessions.delete(hash); ended(hash); removed = true; }
  }
  if (removed) persist();
}

/** Periodic sweep: prune expired sessions (memory and disk). */
export function sweepSessions(now = Date.now()): void {
  pruneExpired(now);
}

export function createSession(
  coach: string,
  now = Date.now(),
  method: SessionMethod = "password",
): { token: string; session: Session } {
  pruneExpired(now);
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const hash = hashToken(token);
  const entry: Entry = {
    coach: coach.trim(),
    expiry: Math.min(now + sessionIdleMs(), now + sessionMaxMs()),
    method,
    created: now,
    persistedAt: now,
    cookieAt: now,
  };
  sessions.set(hash, entry);
  liveTokens.set(hash, token);
  persist();
  return { token, session: { coach: entry.coach, expiry: entry.expiry, method } };
}

/** Resolve a token. A live session slides: the idle expiry moves out (capped by the absolute limit); written back at most every 10 min. */
export function getSession(token: string | undefined, now = Date.now()): Session | undefined {
  if (!token || !TOKEN_HEX.test(token)) return undefined;
  pruneExpired(now);
  const hash = hashToken(token);
  const entry = sessions.get(hash);
  if (!entry) return undefined;
  liveTokens.set(hash, token.toLowerCase());
  const slid = Math.min(now + sessionIdleMs(), entry.created + sessionMaxMs());
  if (slid > entry.expiry) {
    entry.expiry = slid;
    if (now - entry.persistedAt >= SESSION_WRITE_BACK_MS) { entry.persistedAt = now; persist(); }
  }
  return { coach: entry.coach, expiry: entry.expiry, method: entry.method };
}

export function deleteSession(token: string | undefined): boolean {
  if (!token || !TOKEN_HEX.test(token)) return false;
  ensureLoaded(Date.now());
  const hash = hashToken(token);
  if (!sessions.delete(hash)) return false;
  persist();
  ended(hash, token.toLowerCase());
  return true;
}

/**
 * Refresh the browser cookie's Max-Age for a cookie-authenticated request (the cookie must slide with the server
 * expiry or the browser would drop it). Throttled like the disk write-back; Bearer clients hold a token, not a cookie.
 */
export function refreshSessionCookie(req: IncomingMessage, res: ServerResponse, now = Date.now()): void {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
  if (!token || !TOKEN_HEX.test(token) || res.headersSent) return;
  if (!getSession(token, now)) return;
  const entry = sessions.get(hashToken(token));
  if (!entry || (entry.cookieAt !== undefined && now - entry.cookieAt < SESSION_WRITE_BACK_MS)) return;
  entry.cookieAt = now;
  res.setHeader("set-cookie", buildSessionCookie(token, requestUsesTls(req), Math.max(1, Math.floor((entry.expiry - now) / 1000))));
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * `Authorization: Bearer <token>` — the FUMBBL40k client's session carrier. The Tauri client has no
 * cookie jar to inherit a same-origin session from, so it holds the token itself; Bearer (not a
 * cookie) is also why the client needs no CSRF header (a cross-site form cannot set this header).
 * Returns undefined for a Basic header, leaving the admin Basic path untouched.
 */
export function bearerTokenFromRequest(req: IncomingMessage): string | undefined {
  const match = (req.headers.authorization ?? "").match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : undefined;
}

/** Bearer first (client), then the portal's cookie (browser). Both resolve into the SAME store. */
export function sessionTokenFromRequest(req: IncomingMessage): string | undefined {
  return bearerTokenFromRequest(req) ?? parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
}

export function sessionFromRequest(req: IncomingMessage): Session | undefined {
  return getSession(sessionTokenFromRequest(req));
}

export function requestUsesTls(req: IncomingMessage): boolean {
  return (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true;
}

function cookieSecurity(secure: boolean): string {
  return secure ? "; Secure" : "";
}

export function buildSessionCookie(token: string, secure: boolean, maxAgeSeconds = Math.floor(sessionIdleMs() / 1000)): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${cookieSecurity(secure)}`;
}

export function buildClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${cookieSecurity(secure)}`;
}
