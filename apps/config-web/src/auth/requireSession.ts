import type { IncomingMessage } from "node:http";
import { coachLevel, isAdmin, isOrganizer } from "./access.js";
import { sessionFromRequest } from "./session.js";

export interface SessionIdentity {
  coach: string;
  organizer: boolean;
  admin: boolean;
}

export type SessionDecision =
  | { kind: "allow"; identity?: SessionIdentity }
  | { kind: "redirect"; location: string }
  | { kind: "unauthorized" };

const PUBLIC_API_METHODS = new Map<string, ReadonlySet<string>>([
  ["/api/auth/login", new Set(["POST"])],
  ["/api/auth/session", new Set(["GET", "HEAD"])],
  ["/api/auth/discord/start", new Set(["GET"])],
  ["/api/auth/discord/callback", new Set(["GET"])],
  ["/api/auth/discord/pending", new Set(["GET"])],
  ["/api/auth/discord/complete", new Set(["POST"])],
  ["/api/fork/name-available", new Set(["GET"])],
  ["/api/fork/login", new Set(["POST"])],
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
  ["/api/fork/library/ingest", new Set(["POST"])],
  ["/api/fork/coaches", new Set(["GET", "HEAD"])],
  ["/api/fork/challenge", new Set(["GET", "HEAD"])],
  ["/api/fork/matchstatus", new Set(["GET", "HEAD"])],
  ["/api/fork/cancel", new Set(["GET", "HEAD"])],
  ["/api/fork/reload", new Set(["GET", "HEAD"])],
  ["/api/fork/rosters", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/legal-skills", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/inducements", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/preview", new Set(["POST"])],
  ["/api/fork/team-builder/build", new Set(["POST"])],
  ["/api/fork/my-games", new Set(["POST"])],
  // POST does its own coach auth in-handler; the GETs stay session+organizer-gated.
  ["/api/bug-reports", new Set(["POST"])],
]);

function isPublicRequest(method: string, pathname: string): boolean {
  if (pathname === "/login" && (method === "GET" || method === "HEAD")) return true;
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/" ||
      pathname === "/index.html" ||
      pathname === "/tournament-rules.html" ||
      pathname === "/tournament-rules.css" ||
      pathname === "/tournament-rules.js" ||
      pathname === "/discord-complete.html" ||
      pathname === "/discord-complete.js" ||
      pathname === "/admin.html" ||
      pathname === "/admin.css" ||
      pathname === "/admin.js" ||
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/api/packages/"))
  )
    return true;
  return PUBLIC_API_METHODS.get(pathname)?.has(method) === true;
}

export function requireSession(req: IncomingMessage, pathname: string, search: string): SessionDecision {
  const session = sessionFromRequest(req);
  const identity = session
    ? {
        coach: session.coach,
        organizer: coachLevel(session.coach) !== "player" || isOrganizer(session.coach),
        admin: isAdmin(session.coach),
      }
    : undefined;
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
