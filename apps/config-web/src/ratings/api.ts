// Site ratings routes (public reads; GETs never write):
//   GET /api/ratings?race=<race>&min=<games>&provisional=1   the leaderboard (overall, or one race)
//   GET /api/ratings/coaches/<coach>                         one coach's overall and per-race ratings
// Only listed coaches appear (service.ts: an account, not banned, not deleted). 503 when the ratings cannot be read.

import type { SiteRatingsService } from "./service.js";

export const RATINGS_PATH = "/api/ratings";
const COACH_PATH = /^\/api\/ratings\/coaches\/([^/]{1,200})$/;

export const isRatingsPath = (path: string): boolean => path === RATINGS_PATH || COACH_PATH.test(path);

export interface RouteResult { status: number; body: unknown; headers?: Record<string, string> }

export function ratingsRoute(method: string, path: string, query: URLSearchParams, service: SiteRatingsService): RouteResult | undefined {
  if (!isRatingsPath(path)) return undefined;
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "Ratings are read-only." }, headers: { allow: "GET, HEAD" } };
  try {
    if (path === RATINGS_PATH) {
      const minRaw = query.get("min");
      const min = minRaw === null || minRaw === "" ? 0 : Number(minRaw);
      if (!Number.isInteger(min) || min < 0) return { status: 400, body: { error: "min must be a whole number of games." } };
      const race = query.get("race")?.trim() || undefined;
      if (race && race.length > 80) return { status: 400, body: { error: "Unknown race." } };
      return { status: 200, body: service.leaderboard({ ...(race ? { race } : {}), minGames: min, provisional: query.get("provisional") === "1" }) };
    }
    let name: string;
    try { name = decodeURIComponent(COACH_PATH.exec(path)![1]!); } catch { return { status: 400, body: { error: "Bad coach name." } }; }
    const coach = service.coach(name);
    if (!coach) return { status: 404, body: { error: "Coach not found." } };
    return { status: 200, body: coach };
  } catch {
    return { status: 503, body: { error: "Ratings are unavailable right now." } };
  }
}
