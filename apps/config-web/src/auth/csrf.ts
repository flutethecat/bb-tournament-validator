import type { IncomingMessage } from "node:http";
import { DISCORD_PENDING_COOKIE } from "./discordSso.js";
import { bearerTokenFromRequest, parseCookies, sessionFromRequest } from "./session.js";

/**
 * CSRF guard for config-web, ONE rule for both gate paths (the AUTH_SIDECAR session gate and the sidecar-off
 * ADMIN_PASSWORD host). server.ts runs it once, ahead of every /api dispatch, so a new route is covered by default.
 *
 * Rule: a request that rides an ambient browser cookie (a live `cw_session`, or the Discord sign-up pending cookie)
 * and no `Authorization: Bearer` header must carry `X-CW-Auth: 1` on every state-changing /api request. A cross-site
 * page can make the browser attach a cookie, but it cannot set a custom header without a CORS preflight (and the
 * preflight never grants credentials), so the header proves the call came from our own pages.
 *
 * State-changing = any method other than GET / HEAD / OPTIONS (derived from the method, never a hand-kept route list),
 * plus the few legacy GET routes that change state (STATE_CHANGING_GET_PATHS).
 *
 * Not cookie-ridden, so never asked for the header:
 *  - Bearer requests: the desktop client and token callers set the header themselves, so it cannot be forged
 *    cross-site. With a Bearer header the cookie is ignored for identity (sessionTokenFromRequest prefers Bearer).
 *  - Requests without a cw_session / pending cookie: Basic admin password, coach password digest, the fork's
 *    machine-to-machine calls, anonymous calls. None of them carries an ambient session.
 * A request carrying BOTH Basic and a live cookie still needs the header: the browser attaches both on its own.
 */
export const CSRF_HEADER = "x-cw-auth";

/** Routes that authorise themselves without the session cookie, so a cookie riding along must not block them. */
export const CSRF_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/api/mail/postmark/webhook", // Postmark server-to-server; checks its own Basic-auth webhook secret
  "/api/mail/unsubscribe", // signed token in the link; RFC 8058 one-click POST comes from mail clients, no custom header
  "/api/mail/verify", // signed token in the link (GET only)
  "/api/bug-reports/status", // reporter status check: public read-only POST, ignores any session, receipts authorise it
]);

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Legacy GET routes that change state when a session owns the coach (the desktop client calls them cookie-less). */
const STATE_CHANGING_GET_PATHS: ReadonlySet<string> = new Set([
  "/api/fork/register", // sets the coach's fork password
  "/api/fork/challenge", // enters a challenge / schedules a game
  "/api/fork/matchstatus", // consumes the coach's match delivery
  "/api/fork/cancel", // drops the coach's pending challenge
]);

export function isStateChangingApiGet(pathname: string): boolean {
  return STATE_CHANGING_GET_PATHS.has(pathname) || /^\/api\/fork\/match\/[^/]+\/result$/.test(pathname); // imports the result
}

export function isStateChangingApiRequest(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/") || CSRF_EXEMPT_PATHS.has(pathname)) return false;
  const verb = method.toUpperCase();
  if (!SAFE_METHODS.has(verb)) return true;
  return (verb === "GET" || verb === "HEAD") && isStateChangingApiGet(pathname);
}

/** Does this request authenticate (or could it) by an ambient browser cookie rather than a header the caller set? */
export function ridesAmbientCookie(req: IncomingMessage): boolean {
  if (bearerTokenFromRequest(req)) return false;
  if (sessionFromRequest(req)) return true;
  return Boolean(parseCookies(req.headers.cookie).get(DISCORD_PENDING_COOKIE));
}

/** True when the request must be refused 403 for a missing X-CW-Auth header. */
export function csrfHeaderMissing(req: IncomingMessage, method: string, pathname: string): boolean {
  if (!isStateChangingApiRequest(method, pathname)) return false;
  if (req.headers[CSRF_HEADER] === "1") return false;
  return ridesAmbientCookie(req);
}
