// Site ratings service: gathers the rated games from the stores (sources.ts), replays Glicko-2 (glicko.ts) from the go-live
// reset (state.ts), and answers the leaderboard and per-coach reads. Derived on every read, cached:
// - the cache key is every input's revision (league store writes, the tournaments file, the results store, the reset file)
//   plus the UTC day (RDs grow per idle day); a write from another process (an import script) shows within `ttlMs`;
// - deletion of a coach rewrites the stores (results, leagues and tournaments are anonymised) and drops the cache
//   (clear(), the server's onCoachDeleted), so nothing of a deleted coach stays under their name.
// Fails closed: an unreadable reset file or identities file throws; routes answer 503.
//
// Privacy (leaderboards and the coach read): only coaches with an account that is not banned and not a deleted coach
// ("Deleted coach #n") are listed. Draft, test and demo leagues and unpublished tournaments never reach the ratings at all.

import { normalizeFfbCoachId, readIdentitiesStrict, type IdentityStore } from "../auth/identitiesStore.js";
import type { LeagueStore } from "../leagues/store.js";
import { isReservedCoachName } from "../privacy/reservedNames.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import type { TournamentDataFileV4 } from "../tournaments/types.js";
import { computeSiteRatings, periodOf, PROVISIONAL_GAMES, raceKey, ratingView, type RatingView, type SiteRating, type SiteRatings } from "./glicko.js";
import { collectRatedGames, type LeagueSource } from "./sources.js";
import { ratingsStateStamp, readRatingsState } from "./state.js";

export interface SiteRatingsDeps {
  stateDir: string;
  leagues: Pick<LeagueStore, "list" | "competitions" | "version">;
  tournaments: () => TournamentDataFileV4;
  /** Changes whenever the tournaments file does. */
  tournamentsStamp: () => string;
  results: () => StoredTournamentResult[];
  resultsRevision: () => string;
  /** A fork team's race (the team library), for the per-race ratings of Super FUMBBL games. Built once per replay. */
  forkRaces?: () => (teamId: string) => string | undefined;
  identities?: () => IdentityStore;
  now?: () => number;
  ttlMs?: number;
}

export interface LeaderboardQuery { race?: string; minGames?: number; provisional?: boolean; limit?: number }
export interface LeaderboardRow extends RatingView { rank: number; coach: string }
export interface Leaderboard {
  race: { key: string; label: string } | null;
  races: Array<{ key: string; label: string; coaches: number }>;
  minGames: number;
  provisional: boolean;
  provisionalGames: number;
  resetAt: string | null;
  total: number;
  rows: LeaderboardRow[];
}
export interface CoachRatings {
  coach: string;
  overall: RatingView & { rank?: number; of?: number };
  races: Array<RatingView & { race: string; label: string }>;
}

export const LEADERBOARD_MAX_ROWS = 500;
export const MIN_GAMES_MAX = 1000;

export class SiteRatingsService {
  private memo: { key: string; at: number; ratings: SiteRatings; resetAt: string | null } | undefined;
  constructor(private readonly deps: SiteRatingsDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** Drop the cache (a coach was deleted, or a test wrote a store behind the service's back). */
  clear(): void { this.memo = undefined; }

  /** Every coach's ratings, as of today. Throws when the reset file cannot be read. */
  current(): { ratings: SiteRatings; resetAt: string | null } {
    const now = this.now();
    const key = [this.deps.leagues.version(), this.deps.tournamentsStamp(), this.deps.resultsRevision(), ratingsStateStamp(this.deps.stateDir), periodOf(now)].join("|");
    const ttl = this.deps.ttlMs ?? 30_000;
    if (this.memo && this.memo.key === key && now - this.memo.at < ttl) return this.memo;
    const state = readRatingsState(this.deps.stateDir);
    const leagues: LeagueSource[] = this.deps.leagues.list().map((league) => ({ league, competitions: this.deps.leagues.competitions(league.id) }));
    const games = collectRatedGames({
      leagues, tournaments: this.deps.tournaments(), results: this.deps.results(),
      ...(this.deps.forkRaces ? { forkRace: this.deps.forkRaces() } : {}),
    });
    const resetAt = state.resetAt ?? null;
    const ratings = computeSiteRatings(games, { ...(resetAt ? { resetAt: Date.parse(resetAt) } : {}), asOf: now });
    this.memo = { key, at: now, ratings, resetAt };
    return this.memo;
  }

  /** The overall ratings by coach key (the fixture lobby's coach cards and tournament seeding). */
  overall(): ReadonlyMap<string, SiteRating> { return this.current().ratings.overall; }

  /** Coaches the public reads may list: an account, not banned, not a deleted coach. key -> display name. */
  private listed(): Map<string, string> {
    const store = (this.deps.identities ?? readIdentitiesStrict)();
    const out = new Map<string, string>();
    for (const [k, r] of Object.entries(store.coaches ?? {})) {
      if (!r || r.banned || typeof r.ffbCoachId !== "string" || isReservedCoachName(r.ffbCoachId)) continue;
      out.set(normalizeFfbCoachId(k), r.ffbCoachId);
    }
    return out;
  }

  leaderboard(q: LeaderboardQuery = {}): Leaderboard {
    const { ratings, resetAt } = this.current();
    const listed = this.listed();
    const minGames = Math.max(0, Math.min(MIN_GAMES_MAX, Math.floor(q.minGames ?? 0)));
    const provisional = q.provisional === true;
    const limit = Math.max(1, Math.min(LEADERBOARD_MAX_ROWS, Math.floor(q.limit ?? LEADERBOARD_MAX_ROWS)));
    const raceCounts = new Map<string, number>();
    for (const [coach, mine] of ratings.byRace) {
      if (!listed.has(coach)) continue;
      for (const rk of mine.keys()) raceCounts.set(rk, (raceCounts.get(rk) ?? 0) + 1);
    }
    const races = [...raceCounts].map(([key, coaches]) => ({ key, label: ratings.races.get(key) ?? key, coaches }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const rk = q.race ? raceKey(q.race) : "";
    const found = rk ? races.find((r) => r.key === rk) : undefined;
    const race = rk ? { key: rk, label: found?.label ?? q.race!.trim() } : null;
    const pool: Array<{ coach: string; r: SiteRating }> = [];
    for (const [coach, name] of listed) {
      const r = race ? ratings.byRace.get(coach)?.get(race.key) : ratings.overall.get(coach);
      if (!r || r.games < 1 || r.games < minGames || (r.provisional && !provisional)) continue;
      pool.push({ coach: name, r });
    }
    pool.sort((a, b) => b.r.rating - a.r.rating || b.r.games - a.r.games || a.coach.localeCompare(b.coach));
    const rows = pool.slice(0, limit).map((p, i) => ({ rank: i + 1, coach: p.coach, ...ratingView(p.r) }));
    return { race, races, minGames, provisional, provisionalGames: PROVISIONAL_GAMES, resetAt, total: pool.length, rows };
  }

  /** One listed coach's ratings (overall with its rank among established coaches, and every race); undefined = not listed. */
  coach(name: string): CoachRatings | undefined {
    const k = normalizeFfbCoachId(name);
    const listed = this.listed();
    const display = listed.get(k);
    if (!display) return undefined;
    const { ratings } = this.current();
    const mine = ratings.overall.get(k);
    const overall: CoachRatings["overall"] = mine ? ratingView(mine) : { rating: 1500, rd: 350, games: 0, provisional: true };
    if (mine && !mine.provisional) {
      const field = [...listed.keys()].map((c) => ratings.overall.get(c)).filter((r): r is SiteRating => Boolean(r && !r.provisional));
      overall.rank = field.filter((r) => r.rating > mine.rating).length + 1;
      overall.of = field.length;
    }
    const races = [...(ratings.byRace.get(k)?.values() ?? [])]
      .map((r) => ({ race: r.race, label: r.label, ...ratingView(r) }))
      .sort((a, b) => b.games - a.games || a.label.localeCompare(b.label));
    return { coach: display, overall, races };
  }

  /** The coach's own ratings for the privacy export (no listing filter: it is the coach's own data). */
  exportFor(coach: string): { overall: SiteRating | null; races: Array<SiteRating & { race: string; label: string }>; resetAt: string | null } {
    const k = normalizeFfbCoachId(coach);
    const { ratings, resetAt } = this.current();
    return { overall: ratings.overall.get(k) ?? null, races: [...(ratings.byRace.get(k)?.values() ?? [])], resetAt };
  }
}
