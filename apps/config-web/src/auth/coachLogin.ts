/**
 * `POST /api/fork/login` — the FUMBBL40k client's ONE-TIME credential exchange (owner security
 * ruling 08-17: coach passwords must stop riding every config-web request, where they show up in
 * the JSON inspector, in proxy logs, and in any request replay).
 *
 * It is the browser portal's `/api/auth/login` (auth/portal.ts) with a different carrier: the same
 * `ffb_coaches` digest check, the same shared lockout (auth/loginAttempts.ts), the same session
 * store (auth/session.ts) — but the token comes back in the JSON body instead of a Set-Cookie,
 * because the Tauri client has no cookie jar and holds the token itself. The portal keeps its
 * HttpOnly cookie; nothing here weakens it.
 *
 * Unlike the portal this route works with the auth sidecar OFF, since the live host runs
 * ADMIN_PASSWORD mode and the ruling has to land there too.
 *
 * Accepts the credential pre-hashed (`passwordMd5`) or, for one release, as clear text
 * (`password`) — see the dual-accept note in the body.
 *
 * NEVER log the password OR the digest (SR-257). Failures log neither credential.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { coachSecretDigest } from "@bb/fork-ops";
import { noteLegacyPasswordAuth } from "./deprecation.js";
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
  /** Takes the md5 DIGEST of the password, not the clear text — see the dual-accept note
   *  on {@link coachLogin}. `ffb_coaches.password` already IS that digest, so this is the
   *  same comparison as before, one hop earlier. */
  verifyCoachDigest: (coach: string, passwordMd5: string) => Promise<boolean>;
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
  if (typeof coachRaw !== "string" || !coachRaw.trim())
    return { status: 400, body: { error: "Coach name and password are required." } };
  const coach = coachRaw.trim();

  // DUAL-ACCEPT (owner security ruling 08-17, one release of back-compat): current clients
  // send `passwordMd5` so the clear text never reaches the wire, the JSON inspector or a
  // proxy log; older clients still send `password` and keep working. Either way we reduce
  // to the digest here and nothing below this line sees a clear-text password.
  //
  // Honest scope: the digest is still a bearer-equivalent credential — capture it and you
  // can log in as that coach. What this removes is shoulder-surfing, the inspector, request
  // replay from logs, and password REUSE across sites (the harm that actually follows a
  // coach around). On-path capture is TLS's problem, and config-web is plain http.
  const passwordMd5 = field(options.body, "passwordMd5");
  const password = field(options.body, "password");
  let digest: string | undefined;
  let legacy = false;
  try {
    const reduced = coachSecretDigest({
      passwordMd5: typeof passwordMd5 === "string" ? passwordMd5 : undefined,
      password: typeof password === "string" ? password : undefined,
    });
    digest = reduced.digest;
    legacy = reduced.legacy;
  } catch {
    return { status: 400, body: { error: "passwordMd5 must be a 32-character hex md5 digest." } };
  }
  if (!digest) return { status: 400, body: { error: "Coach name and password are required." } };
  if (legacy) noteLegacyPasswordAuth("fork/login");

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
    verified = await options.verifyCoachDigest(coach, digest);
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
