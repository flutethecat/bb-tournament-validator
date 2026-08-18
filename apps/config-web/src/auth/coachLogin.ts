/**
 * `POST /api/fork/login` — the FUMBBL40k client's ONE-TIME credential exchange (owner security
 * ruling 08-17: coach passwords must stop riding every config-web request, where they show up in
 * the JSON inspector, in proxy logs, and in any request replay).
 *
 * It is the browser portal's `/api/auth/login` (auth/portal.ts) with a different carrier: the same
 * `verifyCoachPassword` check, the same shared lockout (auth/loginAttempts.ts), the same session
 * store (auth/session.ts) — but the token comes back in the JSON body instead of a Set-Cookie,
 * because the Tauri client has no cookie jar and holds the token itself. The portal keeps its
 * HttpOnly cookie; nothing here weakens it.
 *
 * Unlike the portal this route works with the auth sidecar OFF, since the live host runs
 * ADMIN_PASSWORD mode and the ruling has to land there too.
 *
 * NEVER log the password (SR-257). Failures log neither credential.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSession, SESSION_TTL_MS } from "./session.js";
import {
  attemptState,
  attemptsByCoach,
  attemptsByIp,
  lockoutRemaining,
  normalizeCoach,
  recordFailure,
} from "./loginAttempts.js";

export interface CoachLoginOptions {
  verifyCoachPassword: (coach: string, password: string) => Promise<boolean>;
  authenticationAvailable: boolean;
  /** Raw JSON body, already parsed by the caller (server.ts owns body reading). */
  body: unknown;
}

export interface CoachLoginResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === "object" && name in body
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function clientIp(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

/** Pure-ish decision half — no I/O on the response, so tests can drive it directly. */
export async function coachLogin(
  req: IncomingMessage,
  options: CoachLoginOptions,
  now = Date.now(),
): Promise<CoachLoginResult> {
  if (!options.authenticationAvailable)
    return { status: 503, body: { error: "Login is unavailable: fork DB is not configured on this host." } };

  // `coach` is this route's name for it; `username` accepted so the portal's payload shape works too.
  const coachRaw = field(options.body, "coach") ?? field(options.body, "username");
  const password = field(options.body, "password");
  if (typeof coachRaw !== "string" || !coachRaw.trim() || typeof password !== "string" || !password)
    return { status: 400, body: { error: "Coach name and password are required." } };
  const coach = coachRaw.trim();

  const ipKey = clientIp(req);
  const coachKey = normalizeCoach(coach);
  const ipAttempt = attemptState(attemptsByIp, ipKey, now);
  const coachAttempt = attemptState(attemptsByCoach, coachKey, now);
  const remaining = Math.max(lockoutRemaining(ipAttempt, now), lockoutRemaining(coachAttempt, now));
  if (remaining > 0)
    return {
      status: 429,
      body: { error: "Too many login attempts. Try again later." },
      headers: { "retry-after": String(Math.max(1, Math.ceil(remaining / 1000))) },
    };

  let verified = false;
  try {
    verified = await options.verifyCoachPassword(coach, password);
  } catch {
    return { status: 503, body: { error: "Coach authentication is temporarily unavailable." } };
  }
  if (!verified) {
    recordFailure(ipAttempt, now);
    recordFailure(coachAttempt, now);
    return { status: 401, body: { error: "Invalid coach name or password." } };
  }

  attemptsByIp.delete(ipKey);
  attemptsByCoach.delete(coachKey);
  const { token, session } = createSession(coach, now);
  return {
    status: 200,
    body: {
      ok: true,
      token,
      coach: session.coach,
      expiresAt: new Date(session.expiry).toISOString(),
      expiresInMs: SESSION_TTL_MS,
    },
  };
}

export function sendCoachLogin(res: ServerResponse, result: CoachLoginResult): void {
  res.writeHead(result.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(result.headers ?? {}),
  });
  res.end(JSON.stringify(result.body));
}
