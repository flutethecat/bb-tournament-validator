import type { IncomingMessage } from "node:http";
import { isOrganizer } from "./organizers.js";
import { sessionFromRequest } from "./session.js";

export interface SessionIdentity {
  coach: string;
  organizer: boolean;
}

export type SessionDecision =
  | { kind: "allow"; identity?: SessionIdentity }
  | { kind: "redirect"; location: string }
  | { kind: "unauthorized" };

const PUBLIC_API_METHODS = new Map<string, ReadonlySet<string>>([
  ["/api/auth/login", new Set(["POST"])],
  ["/api/skills", new Set(["GET", "HEAD"])],
  ["/api/stars", new Set(["GET", "HEAD"])],
  ["/api/teams", new Set(["GET", "HEAD"])],
  ["/api/presets", new Set(["GET", "HEAD"])],
  ["/api/packages", new Set(["GET", "HEAD", "POST"])],
  ["/api/export", new Set(["POST"])],
  ["/api/artprompt", new Set(["POST"])],
  ["/api/fork/jnlp", new Set(["GET", "HEAD"])],
  ["/api/fork/register", new Set(["GET", "HEAD"])],
  ["/api/fork/library", new Set(["GET", "HEAD"])],
  ["/api/fork/library/ingest", new Set(["GET", "HEAD"])],
  ["/api/fork/coaches", new Set(["GET", "HEAD"])],
  ["/api/fork/challenge", new Set(["GET", "HEAD"])],
  ["/api/fork/matchstatus", new Set(["GET", "HEAD"])],
  ["/api/fork/cancel", new Set(["GET", "HEAD"])],
  ["/api/fork/reload", new Set(["GET", "HEAD"])],
  ["/api/fork/rosters", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/legal-skills", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/preview", new Set(["POST"])],
  ["/api/fork/team-builder/build", new Set(["POST"])],
  ["/api/fork/my-games", new Set(["POST"])],
]);

function isPublicRequest(method: string, pathname: string): boolean {
  if (pathname === "/login" && (method === "GET" || method === "HEAD")) return true;
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/tournament-rules.html" ||
      pathname === "/tournament-rules.css" ||
      pathname === "/tournament-rules.js" ||
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/api/packages/"))
  )
    return true;
  return PUBLIC_API_METHODS.get(pathname)?.has(method) === true;
}

export function requireSession(req: IncomingMessage, pathname: string, search: string): SessionDecision {
  const session = sessionFromRequest(req);
  const identity = session ? { coach: session.coach, organizer: isOrganizer(session.coach) } : undefined;
  const method = req.method ?? "GET";

  if (isPublicRequest(method, pathname)) return identity ? { kind: "allow", identity } : { kind: "allow" };
  if (identity) return { kind: "allow", identity };
  if (pathname.startsWith("/api/")) return { kind: "unauthorized" };
  if (method === "GET" || method === "HEAD") {
    const next = `${pathname}${search}`;
    return { kind: "redirect", location: `/login?next=${encodeURIComponent(next)}` };
  }
  return { kind: "unauthorized" };
}
