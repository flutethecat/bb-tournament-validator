import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_COOKIE_NAME = "cw_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface Session {
  coach: string;
  expiry: number;
}

const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;
const sessions = new Map<string, Session>();

function pruneExpired(now: number): void {
  for (const [token, session] of sessions) {
    if (session.expiry <= now) sessions.delete(token);
  }
}

function tokenBuffer(token: string): Buffer | undefined {
  if (!new RegExp(`^[a-f0-9]{${TOKEN_HEX_LENGTH}}$`, "i").test(token)) return undefined;
  return Buffer.from(token, "hex");
}

function findStoredToken(candidate: string): string | undefined {
  const candidateBuffer = tokenBuffer(candidate);
  if (!candidateBuffer) return undefined;
  for (const storedToken of sessions.keys()) {
    const storedBuffer = tokenBuffer(storedToken);
    if (storedBuffer && timingSafeEqual(storedBuffer, candidateBuffer)) return storedToken;
  }
  return undefined;
}

export function createSession(coach: string, now = Date.now()): { token: string; session: Session } {
  pruneExpired(now);
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const session = { coach: coach.trim(), expiry: now + SESSION_TTL_MS };
  sessions.set(token, session);
  return { token, session: { ...session } };
}

export function getSession(token: string | undefined, now = Date.now()): Session | undefined {
  if (!token) return undefined;
  pruneExpired(now);
  const storedToken = findStoredToken(token);
  if (!storedToken) return undefined;
  const session = sessions.get(storedToken);
  if (!session) return undefined;
  return { ...session };
}

export function deleteSession(token: string | undefined): boolean {
  if (!token) return false;
  const storedToken = findStoredToken(token);
  return storedToken ? sessions.delete(storedToken) : false;
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

export function sessionTokenFromRequest(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
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

export function buildSessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Strict${cookieSecurity(secure)}`;
}

export function buildClearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${cookieSecurity(secure)}`;
}
