import type { IncomingMessage } from "node:http";
import { coachLevel, isAdmin, isOrganizer } from "./access.js";
import { forkGateAdmits } from "./forkRouteAuth.js";
import { sessionFromRequest } from "./session.js";
import { isPublicArtPath } from "../publicArt.js";
import { isSpaPath } from "../spaRoutes.js";
import { teamBuilderSharedPath, teamViewPagePath } from "../teamBuilderSaves.js";

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
  ["/api/auth/desktop/start", new Set(["POST"])],
  ["/api/auth/desktop/claim", new Set(["POST"])],
  ["/api/auth/desktop/cancel", new Set(["POST"])],
  ["/api/fork/name-available", new Set(["GET"])],
  ["/api/fork/login", new Set(["POST"])],
  ["/api/skills", new Set(["GET", "HEAD"])],
  ["/api/standings", new Set(["GET", "HEAD"])], // published tabletop + fork standings: a public read
  ["/api/stars", new Set(["GET", "HEAD"])],
  ["/api/teams", new Set(["GET", "HEAD"])],
  ["/api/positions", new Set(["GET", "HEAD"])],
  ["/api/presets", new Set(["GET", "HEAD"])],
  ["/api/packages", new Set(["GET", "HEAD", "POST"])],
  // Ruleset export (creation wizards v2): read-only; a draft package answers 404 in-handler.
  ["/api/ruleset-summary", new Set(["GET", "HEAD"])],
  ["/api/export", new Set(["POST"])],
  ["/api/artprompt", new Set(["POST"])],
  // Fork sign-up stays open (owner 11-03); an existing coach still needs its session or admin in-handler.
  ["/api/fork/register", new Set(["GET", "HEAD"])],
  // Game creation stays open with FORK_ROUTES_REQUIRE_AUTH on or off (owner 11-03, "we don't need to lock down game
  // creation yet"): TEMPORARY until the owner lifts the hold. challenge verifies its digest in-handler; matchstatus,
  // cancel and jnlp keep their legacy session-or-digest rules.
  ["/api/fork/jnlp", new Set(["GET", "HEAD"])],
  ["/api/fork/challenge", new Set(["GET", "HEAD"])],
  ["/api/fork/matchstatus", new Set(["GET", "HEAD"])],
  ["/api/fork/cancel", new Set(["GET", "HEAD"])],
  // Tournament Builder reads stay open (owner 11-03): rosters, catalog reads and the non-mutating preview. Saving is
  // locked: team-builder/saves and build are lockdown routes (src/auth/forkRouteAuth.ts).
  ["/api/fork/rosters", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/legal-skills", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/inducements", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/tiers", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/limits", new Set(["GET", "HEAD"])],
  ["/api/fork/team-builder/preview", new Set(["POST"])],
  // POST does its own coach auth in-handler; the GETs stay session+organizer-gated.
  ["/api/bug-reports", new Set(["POST"])],
  // Reporter status checks (owner 11-04): public; answers only receipt-matched entries, rate-limited per IP.
  ["/api/bug-reports/status", new Set(["POST"])],
  // Global site search (src/search/index.ts): a public read; it uses the session only to show drafts to their organisers.
  ["/api/search", new Set(["GET", "HEAD"])],
]);

function isPublicRequest(method: string, pathname: string): boolean {
  if (pathname === "/login" && (method === "GET" || method === "HEAD")) return true;
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/theme.css" ||
      pathname === "/theme.js" ||
      pathname === "/team-builder.html" ||
      pathname === "/team-builder.css" ||
      pathname === "/team-builder.js" ||
      pathname === "/sheet-pdf.js" ||
      pathname === "/vendor/pdfmake/pdfmake.min.js" ||
      pathname === "/vendor/pdfmake/vfs_fonts.js" ||
      pathname === "/tournament-team-builder.html" ||
      pathname === "/my-teams.html" ||
      pathname === "/my-teams.js" ||
      pathname === "/team-view.html" ||
      pathname === "/team-view.js" ||
      pathname === "/team-view.css" ||
      teamViewPagePath(pathname) !== undefined ||
      teamBuilderSharedPath(pathname) !== undefined ||
      isPublicArtPath(pathname) ||
      pathname === "/tournament-rules.html" ||
      pathname === "/tournament-rules.css" ||
      pathname === "/tournament-rules.js" ||
      pathname === "/lobby" ||
      pathname.startsWith("/lobby/") ||
      isSpaPath(pathname) ||
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/api/packages/"))
  )
    return true;
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/api/tournaments" ||
      pathname === "/api/fork/tournaments" ||
      /^\/api\/tournaments\/[^/]+$/.test(pathname) ||
      /^\/api\/tournaments\/[^/]+\/standings$/.test(pathname) ||
      /^\/api\/fork\/tournaments\/[^/]+$/.test(pathname) ||
      /^\/api\/fork\/tournaments\/[^/]+\/standings$/.test(pathname) ||
      // Tournament Statistics / Honours, Awards and the Registration gate countdown: public reads (award POST/DELETE stay session-gated, organisers in-handler).
      /^\/api\/(?:fork\/)?tournaments\/[^/]+\/(?:statistics|awards|gates)$/.test(pathname) ||
      // Tournament banner image: a public read (PUT/DELETE stay session-gated and manager-checked in-handler).
      /^\/api\/tournaments\/[^/]+\/banner$/.test(pathname) ||
      /^\/api\/fork\/tournaments\/[^/]+\/banner$/.test(pathname) ||
      // Tournament fixture lobby: a read-only view for anyone (drafts 404 except for managers; writes stay session-gated).
      /^\/api\/tournaments\/[^/]+\/fixtures\/[^/]+\/lobby$/.test(pathname) ||
      // Tournament board (src/boards/competitionApi.ts): its tab status and, when the organisers turned public read on, the
      // threads. The handler decides; every other board route stays session-gated. (League boards ride /api/leagues/ below.)
      /^\/api\/tournaments\/[^/]+\/board(?:\/status)?$/.test(pathname) ||
      // Tabletop match view: a read-only spectator view for anyone (owner ruling 10-30); the handler decides the role and
      // refuses an anonymous visitor on a test match. Every other tabletop route stays session-gated.
      /^\/api\/tabletop\/matches\/[\w-]{1,64}$/.test(pathname) ||
      // Leagues: every read is public (list, league, seasons, stats, logo / header bar, the inducement table and
      // .../seasons/:seasonId/inducements/usage); writes stay session-gated. Drafts answer as unknown in-handler.
      pathname === "/api/leagues" ||
      pathname.startsWith("/api/leagues/") ||
      // Tournament Series: list and series pages are public reads; writes stay session-gated in-handler.
      pathname === "/api/series" ||
      /^\/api\/series\/[^/]+$/.test(pathname) ||
      // Site ratings (src/ratings/api.ts): the leaderboard and one coach's ratings are public reads.
      pathname === "/api/ratings" ||
      /^\/api\/ratings\/coaches\/[^/]{1,200}$/.test(pathname) ||
      // Clubs (src/clubs/api.ts isPublicClubRead): the directory, a club page, its stats and its crest are public reads;
      // the board, the admin view and every write stay session-gated.
      pathname === "/api/clubs" ||
      /^\/api\/clubs\/[^/]+$/.test(pathname) ||
      /^\/api\/clubs\/[^/]+\/(?:stats|crest)$/.test(pathname) ||
      // Badges (src/badges/api.ts isPublicBadgeRead): the catalog and a coach's, team's or league's badges are public reads.
      /^\/api\/badges\/(?:catalog|coach\/[^/]+|team\/[^/]+\/[^/]+\/[^/]+|league\/[^/]+)$/.test(pathname))
  )
    return true;
  return PUBLIC_API_METHODS.get(pathname)?.has(method) === true;
}

/** Fork routes that used to be public (src/auth/forkRouteAuth.ts): open only with FORK_ROUTES_REQUIRE_AUTH off, or when
 *  the request carries a credential the handler verifies. */
function forkRouteAdmitted(req: IncomingMessage, method: string, pathname: string): boolean {
  return forkGateAdmits(method, pathname, req.headers, "session");
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

  if (isPublicRequest(method, pathname) || (!identity && forkRouteAdmitted(req, method, pathname))) return identity ? { kind: "allow", identity } : { kind: "allow" };
  if (identity) return { kind: "allow", identity };
  if (pathname.startsWith("/api/")) return { kind: "unauthorized" };
  if (method === "GET" || method === "HEAD") {
    const next = `${pathname}${search}`;
    return { kind: "redirect", location: `/login?next=${encodeURIComponent(next)}` };
  }
  return { kind: "unauthorized" };
}
