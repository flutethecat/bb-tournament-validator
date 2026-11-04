// Site-wide coach ratings (owner round 2, 11-04): Glicko-2 (Glickman, "Example of the Glicko-2 system") with the standard
// defaults: rating 1500, RD 350, volatility 0.06, tau 0.5. One rating per coach overall and one per coach per race.
//
// Rating periods: one UTC calendar day. Every game played on a day is rated together against the opponents' ratings at the
// START of that day (Glicko-2's simultaneous update), so the order of games inside a day never matters. A coach who does
// not play on a day only has their RD grow (step 6 with no games): phi^2 + sigma^2 per idle day, worked out in closed form
// (n idle days add n * sigma^2), so nothing loops over idle days. RD never goes above the starting 350.
//
// Per race: the coach's race rating is updated with the same game against the OPPONENT'S OVERALL rating (their skill, not
// their record with the race they happened to bring).
//
// Pure and deterministic: the same games (and the same "as of" day) always give the same ratings. The engine is
// coachGlicko.ts glickoUpdate (steps 2-8), run with these parameters and no team-value term.

import { GLICKO_SCALE, glickoUpdate, type GlickoOpponent, type GlickoParams, type GlickoState } from "../coachGlicko.js";

export const SITE_GLICKO: GlickoParams = { tau: 0.5, sigma: 0.06, rating: 1500, rd: 350, rdCap: 350, epsilon: 1e-6 };
/** Rated games before a rating (overall, or for one race) stops being provisional. */
export const PROVISIONAL_GAMES = 5;
export const DAY_MS = 86_400_000;

/** The rating period (UTC day number) of a time in ms. */
export const periodOf = (ms: number): number => Math.floor(ms / DAY_MS);

export interface RatedSide {
  /** The coach's identity key (normalizeFfbCoachId of the account name). */
  coach: string;
  /** The race of the team the coach played, as recorded (absent = unknown: the game rates overall only). */
  race?: string;
}

export type RatedSource = "league" | "ladder" | "tournament" | "fork";

/** One game that counts, from any source (src/ratings/sources.ts). */
export interface RatedGame {
  /** Stable identity of the result (league:<league>:<season>:<fixture>, tournament:<id>:<match>, fork:<gameId>). */
  key: string;
  source: RatedSource;
  /** When it was played, ms. */
  at: number;
  home: RatedSide;
  away: RatedSide;
  /** 1 = home won, 0.5 = draw, 0 = away won. */
  homeScore: 0 | 0.5 | 1;
}

export interface SiteRating {
  rating: number;
  rd: number;
  volatility: number;
  games: number;
  provisional: boolean;
  /** When the last rated game was played, ms. */
  lastPlayed: number;
}

export interface RaceRating extends SiteRating {
  race: string;
  /** The race as first recorded (display). */
  label: string;
}

export interface SiteRatings {
  overall: Map<string, SiteRating>;
  /** coach -> race key -> rating. */
  byRace: Map<string, Map<string, RaceRating>>;
  /** race key -> display label. */
  races: Map<string, string>;
  /** Games that were rated (after the reset cutoff and de-duplication). */
  games: number;
}

/** The race key: NFC, trimmed, single-spaced, lower case. */
export const raceKey = (race: string): string => race.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

interface Entity extends GlickoState { games: number; period: number; lastPlayed: number }

const fresh = (): GlickoState => ({ r: SITE_GLICKO.rating, rd: SITE_GLICKO.rd, sigma: SITE_GLICKO.sigma });

/** RD after `idle` rating periods without a game (closed form of step 6, capped at the starting RD). */
export function inflateRd(rd: number, sigma: number, idle: number): number {
  if (idle <= 0) return rd;
  const phi = rd / GLICKO_SCALE;
  const cap = SITE_GLICKO.rdCap / GLICKO_SCALE;
  return Math.min(Math.sqrt(phi * phi + idle * sigma * sigma), cap) * GLICKO_SCALE;
}

/** An entity's rating at the start of period `p` (idle inflation since its last period), or the default when unrated. */
function startOf(e: Entity | undefined, p: number): GlickoState {
  if (!e) return fresh();
  return { r: e.r, rd: inflateRd(e.rd, e.sigma, p - e.period - 1), sigma: e.sigma };
}

export interface ComputeOptions {
  /** Games played before this time (ms) are not counted: the go-live reset (src/ratings/state.ts). */
  resetAt?: number;
  /** Inflate every RD up to this time's period (a viewer's "now"); default: no inflation past each coach's last game. */
  asOf?: number;
}

/**
 * Glicko-2 over `games`. A game whose key was already seen counts once (the first one, by time then key); a game with the
 * same coach on both sides is ignored.
 */
export function computeSiteRatings(games: readonly RatedGame[], opts: ComputeOptions = {}): SiteRatings {
  const seen = new Set<string>();
  const ordered = [...games]
    .filter((g) => Number.isFinite(g.at) && (opts.resetAt === undefined || g.at >= opts.resetAt) && g.home.coach && g.away.coach && g.home.coach !== g.away.coach)
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((g) => (seen.has(g.key) ? false : (seen.add(g.key), true)));

  const overall = new Map<string, Entity>();
  const byRace = new Map<string, Map<string, Entity>>();
  const races = new Map<string, string>();

  let i = 0;
  while (i < ordered.length) {
    const p = periodOf(ordered[i]!.at);
    const day: RatedGame[] = [];
    while (i < ordered.length && periodOf(ordered[i]!.at) === p) day.push(ordered[i++]!);

    // Every opponent is read at the start of the day, before anyone's update.
    const start = new Map<string, GlickoState>();
    const startFor = (coach: string): GlickoState => {
      let s = start.get(coach);
      if (!s) { s = startOf(overall.get(coach), p); start.set(coach, s); }
      return s;
    };
    const overallGames = new Map<string, { opp: GlickoOpponent[]; last: number }>();
    const raceGames = new Map<string, { coach: string; race: string; opp: GlickoOpponent[]; last: number }>();
    const add = (side: RatedSide, opponent: RatedSide, score: number, at: number): void => {
      const o = startFor(opponent.coach);
      const game = { r: o.r, rd: o.rd, score };
      const row = overallGames.get(side.coach) ?? { opp: [], last: 0 };
      row.opp.push(game); row.last = Math.max(row.last, at);
      overallGames.set(side.coach, row);
      const label = side.race?.trim();
      if (!label) return;
      const rk = raceKey(label);
      if (!races.has(rk)) races.set(rk, label);
      const id = `${side.coach}\u0000${rk}`;
      const rr = raceGames.get(id) ?? { coach: side.coach, race: rk, opp: [], last: 0 };
      rr.opp.push(game); rr.last = Math.max(rr.last, at);
      raceGames.set(id, rr);
    };
    for (const g of day) {
      startFor(g.home.coach); startFor(g.away.coach);
      add(g.home, g.away, g.homeScore, g.at);
      add(g.away, g.home, 1 - g.homeScore, g.at);
    }
    for (const [coach, row] of overallGames) {
      const before = overall.get(coach);
      const next = glickoUpdate(startOf(before, p), row.opp, SITE_GLICKO);
      overall.set(coach, { ...next, games: (before?.games ?? 0) + row.opp.length, period: p, lastPlayed: row.last });
    }
    for (const row of raceGames.values()) {
      let mine = byRace.get(row.coach);
      if (!mine) { mine = new Map(); byRace.set(row.coach, mine); }
      const before = mine.get(row.race);
      const next = glickoUpdate(startOf(before, p), row.opp, SITE_GLICKO);
      mine.set(row.race, { ...next, games: (before?.games ?? 0) + row.opp.length, period: p, lastPlayed: row.last });
    }
  }

  const asOfPeriod = opts.asOf !== undefined ? periodOf(opts.asOf) : undefined;
  const view = (e: Entity): SiteRating => ({
    rating: e.r,
    rd: asOfPeriod !== undefined ? inflateRd(e.rd, e.sigma, asOfPeriod - e.period) : e.rd,
    volatility: e.sigma,
    games: e.games,
    provisional: e.games < PROVISIONAL_GAMES,
    lastPlayed: e.lastPlayed,
  });
  const out: SiteRatings = { overall: new Map(), byRace: new Map(), races, games: ordered.length };
  for (const [coach, e] of overall) out.overall.set(coach, view(e));
  for (const [coach, mine] of byRace) {
    const m = new Map<string, RaceRating>();
    for (const [rk, e] of mine) m.set(rk, { ...view(e), race: rk, label: races.get(rk) ?? rk });
    out.byRace.set(coach, m);
  }
  return out;
}

/** What an unrated coach shows. */
export function defaultRating(): SiteRating {
  return { rating: SITE_GLICKO.rating, rd: SITE_GLICKO.rd, volatility: SITE_GLICKO.sigma, games: 0, provisional: true, lastPlayed: 0 };
}

/** What a rating consumer needs (the fixture lobby's coach cards): a SiteRating fits it. */
export interface CoachRatingInput { rating: number; rd?: number; games: number; provisional: boolean }

/** A rating as the routes send it: rounded rating and RD. */
export interface RatingView { rating: number; rd: number; games: number; provisional: boolean }
export const ratingView = (r: SiteRating): RatingView => ({ rating: Math.round(r.rating), rd: Math.round(r.rd), games: r.games, provisional: r.provisional });
