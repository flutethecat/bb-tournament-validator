// Site ratings (owner round 2, 11-04): the Ratings page (/app/ratings) and the coach summary popup's rating lines. Pure
// helpers over what /api/ratings sent (server-derived law): the server rates, ranks and filters; nothing here invents a
// figure. The page remembers the viewer's filters in guarded localStorage.

import type { Fetcher } from "../session";

export interface RatingView { rating: number; rd: number; games: number; provisional: boolean }
export interface LeaderboardRow extends RatingView { rank: number; coach: string }
export interface LeaderboardView {
  race: { key: string; label: string } | null;
  races: Array<{ key: string; label: string; coaches: number }>;
  minGames: number;
  provisional: boolean;
  provisionalGames: number;
  resetAt: string | null;
  total: number;
  rows: LeaderboardRow[];
}
export interface CoachRatingsView {
  coach: string;
  overall: RatingView & { rank?: number; of?: number };
  races: Array<RatingView & { race: string; label: string }>;
}

export interface LeaderboardFilters { race: string; minGames: number; provisional: boolean }
export const DEFAULT_FILTERS: LeaderboardFilters = { race: "", minGames: 0, provisional: false };
export const MIN_GAMES_CHOICES = [0, 5, 10, 25, 50] as const;

/** The leaderboard URL for a set of filters (defaults left out). */
export function leaderboardUrl(f: LeaderboardFilters): string {
  const q = new URLSearchParams();
  if (f.race) q.set("race", f.race);
  if (f.minGames > 0) q.set("min", String(f.minGames));
  if (f.provisional) q.set("provisional", "1");
  const s = q.toString();
  return `/api/ratings${s ? `?${s}` : ""}`;
}

export const coachRatingsUrl = (coach: string): string => `/api/ratings/coaches/${encodeURIComponent(coach)}`;

/** "1561 ±87". */
export const ratingLine = (r: Pick<RatingView, "rating" | "rd">): string => `${r.rating} ±${r.rd}`;

/** The panel caption: "12 COACHES", "1 COACH". */
export const coachCount = (n: number): string => `${n} ${n === 1 ? "coach" : "coaches"}`;

const FILTERS_KEY = "sf-ratings-filters";

export function readFilters(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): LeaderboardFilters {
  try {
    const raw = storage?.getItem(FILTERS_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const v = JSON.parse(raw) as Partial<LeaderboardFilters>;
    return {
      race: typeof v.race === "string" ? v.race.slice(0, 80) : "",
      minGames: typeof v.minGames === "number" && (MIN_GAMES_CHOICES as readonly number[]).includes(v.minGames) ? v.minGames : 0,
      provisional: v.provisional === true,
    };
  } catch { return { ...DEFAULT_FILTERS }; }
}

export function writeFilters(f: LeaderboardFilters, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* private window: not remembered */ }
}

/** The page's empty line for the current filters. */
export function emptyLine(v: Pick<LeaderboardView, "race" | "provisional" | "provisionalGames" | "minGames">): string {
  const where = v.race ? ` with ${v.race.label}` : "";
  if (!v.provisional) return `No coach${where} has played ${Math.max(v.provisionalGames, v.minGames)} rated games yet. Show provisional ratings to see everyone.`;
  return v.minGames > 0 ? `No coach${where} has played ${v.minGames} rated games yet.` : `No rated games${where} yet.`;
}

/** The race rating to show in the coach popup: the one for `race` when the coach has played it. */
export function raceRatingFor(view: CoachRatingsView | null | undefined, race: string | undefined): (RatingView & { label: string }) | undefined {
  if (!view || !race) return undefined;
  const k = race.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return view.races.find((r) => r.race === k);
}

export async function loadLeaderboard(api: Fetcher, f: LeaderboardFilters): Promise<LeaderboardView> {
  return api<LeaderboardView>(leaderboardUrl(f));
}
