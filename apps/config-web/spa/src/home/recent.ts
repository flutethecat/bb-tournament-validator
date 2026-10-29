// Past Games strip (owner 10-30): GET /api/recent-results, shown on the signed-out landing page and the coach page.
// Any failure is an empty strip: the page is public and never shows an error for this.

import type { Fetcher } from "../session";
import { resolveCrest, type ArtManifests } from "../tabletop/art";

export interface RecentSide {
  name: string;
  race: string;
  coach: string;
  crestUrl: string | null;
  score: number | null;
  cas: number | null;
}

export interface RecentResult {
  id: string;
  source: string;
  context: string;
  playedAt: string | null;
  href: string | null;
  home: RecentSide;
  away: RecentSide;
  concede: "home" | "away" | null;
  suspended: boolean;
}

/** The most the API returns (src/recentResults.ts RECENT_RESULTS_MAX; a test keeps the two equal): the Past Games strip asks for all of it. */
export const RECENT_LIMIT = 50;
export const RECENT_PATH = `/api/recent-results?limit=${RECENT_LIMIT}`;

const isSide = (s: unknown): s is RecentSide => !!s && typeof s === "object" && typeof (s as RecentSide).name === "string";

/** The newest games with each side's crest filled in from the race crest manifest when the team has no avatar. */
export async function loadRecentResults(api: Fetcher): Promise<RecentResult[]> {
  let rows: RecentResult[] = [];
  try {
    const res = await api<{ results?: unknown }>(RECENT_PATH);
    rows = (Array.isArray(res?.results) ? res.results : []).filter((r): r is RecentResult => !!r && typeof r === "object" && isSide((r as RecentResult).home) && isSide((r as RecentResult).away));
  } catch { return []; }
  if (!rows.length) return rows;
  let art: ArtManifests = {};
  try { art = { crests: await api<{ crests?: Record<string, string> }>("/crests/manifest.json") }; } catch { /* initials */ }
  const crest = (s: RecentSide): RecentSide => ({ ...s, crestUrl: s.crestUrl || resolveCrest(art, s.race) || null });
  return rows.map((r) => ({ ...r, home: crest(r.home), away: crest(r.away) }));
}
