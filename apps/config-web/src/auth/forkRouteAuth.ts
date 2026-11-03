import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Fork route lockdown (owner rulings 11-03): "No-sign-in paths should be locked down for all fork paths." and
 * "Tournament Builder remains open but saving is locked behind login."
 *
 * ONE policy for both gate paths: the AUTH_SIDECAR session gate (requireSession.ts) and the sidecar-off ADMIN_PASSWORD gate
 * (server.ts authorized()), plus the in-handler check (forkRouteDenial) that answers the same way in both modes.
 *
 * Stays open on purpose (in the static public lists, not here): /api/fork/login, /api/fork/name-available,
 * /api/fork/register (sign-up), and the Tournament Builder reads: /api/fork/rosters, team-builder tiers / limits /
 * inducements / legal-skills and POST team-builder/preview (package draft visibility still applies in-handler).
 *
 * GAME CREATION IS EXEMPT, TEMPORARILY (owner 11-03: "Hold on fixing the client, we don't need to lock down game creation
 * yet."): /api/fork/challenge, /api/fork/matchstatus, /api/fork/cancel and /api/fork/jnlp keep exactly their legacy
 * behaviour (query digest or clear-text password included) whatever the flag says, so the live desktop client keeps
 * creating games. Move them into LOCKABLE_FORK_ROUTES when the owner lifts the hold (client changes listed in docs/setup.md).
 *
 * The routes below were reachable without a session. With FORK_ROUTES_REQUIRE_AUTH on (the default) they need a signed-in
 * coach: the cw_session cookie or `Authorization: Bearer <token>` (both resolve through sessionFromRequest, the same store
 * /api/me/teams/:ref uses). The flag is OFF unless set (owner 11-03), and off they keep their old public posture, so the
 * live desktop client is not broken before its Bearer changes ship.
 */

export type ForkRouteKind =
  /** Signed-in coach (or the admin Basic password / admin token where the handler already accepted it). */
  | "signed-in"
  /** Signed-in coach, an admin credential, or the server-to-server key (read-only aggregate reads). */
  | "service-read"
  /** Signed-in coach, or the deprecated body coach+password the handler verifies against the fork DB (client fallback). */
  | "body-credential";

export interface ForkRoutePolicy {
  methods: ReadonlySet<string>;
  kind: ForkRouteKind;
  /** Where the route was public before the lockdown: both gates, or only server.ts PUBLIC_PATHS (sidecar-off). */
  legacyGate: "both" | "public-paths";
}

const GET = new Set(["GET", "HEAD"]);
const POST = new Set(["POST"]);

export const LOCKABLE_FORK_ROUTES: ReadonlyMap<string, ForkRoutePolicy> = new Map<string, ForkRoutePolicy>([
  ["/api/fork/library", { methods: GET, kind: "service-read", legacyGate: "both" }],
  ["/api/fork/library/ingest", { methods: POST, kind: "signed-in", legacyGate: "both" }],
  ["/api/fork/library/retire", { methods: new Set(["GET", "POST"]), kind: "signed-in", legacyGate: "public-paths" }],
  ["/api/fork/coaches", { methods: GET, kind: "service-read", legacyGate: "both" }],
  ["/api/fork/reload", { methods: new Set(["GET", "HEAD", "POST"]), kind: "signed-in", legacyGate: "both" }],
  ["/api/fork/games", { methods: GET, kind: "signed-in", legacyGate: "public-paths" }],
  ["/api/fork/records", { methods: GET, kind: "service-read", legacyGate: "public-paths" }],
  ["/api/fork/team-builder/build", { methods: POST, kind: "body-credential", legacyGate: "both" }],
  ["/api/fork/my-games", { methods: POST, kind: "body-credential", legacyGate: "both" }],
]);

/** Error code on every lockdown 401, so clients can tell "sign in" from a wrong password. */
export const SIGN_IN_REQUIRED = "sign_in_required";
export const SIGN_IN_REQUIRED_MESSAGE = "Sign in to use this.";

/** Server-to-server shared secret: env key name and request header. Unset key = the header is never accepted. */
export const SERVICE_KEY_ENV = "CONFIG_WEB_SERVICE_KEY";
export const SERVICE_KEY_HEADER = "x-cw-service-key";

/** FORK_ROUTES_REQUIRE_AUTH: OFF unless the value says on ("1", "true", "on", "yes"; owner 11-03). Read per request. */
export function forkRoutesRequireAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FORK_ROUTES_REQUIRE_AUTH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function policyFor(method: string, pathname: string): ForkRoutePolicy | undefined {
  const policy = LOCKABLE_FORK_ROUTES.get(pathname);
  return policy && policy.methods.has(method.toUpperCase()) ? policy : undefined;
}

export function isLockableForkRoute(pathname: string): boolean {
  return LOCKABLE_FORK_ROUTES.has(pathname);
}

/** Does the request carry the configured server-to-server key? Constant-time compare; an unset key never matches. */
export function serviceKeyMatches(header: string | string[] | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env[SERVICE_KEY_ENV]?.trim();
  const given = typeof header === "string" ? header.trim() : undefined;
  if (!expected || !given) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(given));
}

interface GateHeaders {
  authorization?: string | string[];
  [SERVICE_KEY_HEADER]?: string | string[];
}

/**
 * May this lockable fork route pass the OUTER gate without a session? Flag off: exactly the old public posture
 * (`gate` says which list it was on). Flag on: only requests that carry a credential the handler verifies (an
 * Authorization header: Bearer admin token or Basic admin password; the service key on service reads), plus the
 * body-credential routes whose handler verifies the body. Not a decision by itself: forkRouteDenial runs in-handler.
 */
export function forkGateAdmits(method: string, pathname: string, headers: GateHeaders, gate: "session" | "public-paths"): boolean {
  const policy = policyFor(method, pathname);
  if (!policy) return false;
  if (!forkRoutesRequireAuth()) return gate === "public-paths" || policy.legacyGate === "both";
  if (policy.kind === "body-credential") return true;
  if (typeof headers.authorization === "string" && headers.authorization.trim()) return true;
  return policy.kind === "service-read" && typeof headers[SERVICE_KEY_HEADER] === "string";
}

export interface ForkCaller {
  /** A signed-in coach (session cookie or Bearer session token). */
  signedIn: boolean;
  /** The admin Basic password or an admin token (the handlers' existing admin credentials). */
  adminCredential: boolean;
  /** The server-to-server key matched. */
  service: boolean;
}

/** The in-handler lockdown answer for a lockable fork route (undefined = proceed to the handler's own checks). */
export function forkRouteDenial(method: string, pathname: string, caller: ForkCaller): { status: 401; body: { error: string; code: string } } | undefined {
  if (!forkRoutesRequireAuth()) return undefined;
  const policy = policyFor(method, pathname);
  if (!policy) return undefined;
  if (caller.signedIn || caller.adminCredential) return undefined;
  if (policy.kind === "body-credential") return undefined; // the handler verifies coach+password or refuses 401
  if (policy.kind === "service-read" && caller.service) return undefined;
  return { status: 401, body: { error: SIGN_IN_REQUIRED_MESSAGE, code: SIGN_IN_REQUIRED } };
}
