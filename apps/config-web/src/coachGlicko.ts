// FUMBBL-style Coach Rating (CR) for the fork's coaches: Glicko-2 (Glickman, "Example of the Glicko-2 system", steps 1-8) with FUMBBL's settings:
// tau 0.2, initial volatility 0.15, initial rating 1500, initial RD 150, RD CAPPED at that initial 150 (after the pre-period inflation and after the
// update), a 7-day rating period, and a team-value ("CTV") adjustment of the expected score. The displayed CR is r' - 5 * max(RD' - 100, 0).
//
// Inputs are the same published results the Elo uses (src/coachElo.ts), in chronological order; games are grouped into 7-day periods counted from a fixed
// epoch (the result's pulledAt is the only timestamp a stored row has) and the periods are processed in order. Every game of a period is rated against
// the opponents' values at the START of that period (Glicko-2's simultaneous update). A coach with no game in a period only gets the RD inflation, capped.
//
// CTV adjustment (step 3, modified E): E(mu, mu_j, phi_j, rho) = 1 / (1 + exp(-g(phi_j) * (mu - mu_j + rho))),
//   rho = (-4 g(phi_j) + 5.5) / (1 + exp(deltaCTV / 200000)) - (-4 g(phi_j) + 5.5) / 2,
//   deltaCTV = (OPPONENT's team value - OWN team value) in gold (a row without team values: deltaCTV = 0, so rho = 0).
// Sign: (-4 g + 5.5) is positive for g in (0, 1], so rho is NEGATIVE when the opponent's team is worth more (deltaCTV > 0) and positive when it is worth less.
// A negative rho lowers E, so the coach who plays UP in team value is expected to score less and gains more for a win (and loses less for a loss): the bonus
// the rule intends. rho is added to mu on the same scale as mu = (r - 1500) / 173.7178.

import { createHash } from "node:crypto";
import { deriveTeamResult, type StoredTournamentResult } from "./tournamentResults.js";

export const GLICKO_SCALE = 173.7178;

export interface GlickoParams {
  /** System constant tau (volatility change). */
  tau: number;
  /** Initial volatility sigma. */
  sigma: number;
  /** Initial rating r. */
  rating: number;
  /** Initial RD. */
  rd: number;
  /** RD is never allowed above this (after inflation and after the update); Infinity = uncapped (the paper's example). */
  rdCap: number;
  /** Convergence tolerance of the volatility iteration (the paper uses 0.000001). */
  epsilon: number;
}

/** FUMBBL's CR settings. */
export const FUMBBL_CR: GlickoParams = { tau: 0.2, sigma: 0.15, rating: 1500, rd: 150, rdCap: 150, epsilon: 1e-6 };
export const PERIOD_DAYS = 7;
/** Rating periods count from this Monday, UTC. */
export const PERIOD_EPOCH_MS = Date.UTC(2000, 0, 3);
const DAY_MS = 86_400_000;
/** The gold scale of the team-value difference inside rho. */
const CTV_SCALE = 200_000;

export interface GlickoState { r: number; rd: number; sigma: number }
export interface GlickoOpponent { r: number; rd: number; score: number; /** opponent team value minus own team value, in gold (absent = 0) */ deltaCtv?: number }

/** Glicko-2's g(phi). */
export const glickoG = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

/** The team-value term rho (see the header): 0 when the team values are equal or unknown, negative when the opponent's team is worth more. */
export function rho(gPhi: number, deltaCtv: number): number {
  const c = -4 * gPhi + 5.5;
  return c / (1 + Math.exp(deltaCtv / CTV_SCALE)) - c / 2;
}

/** The modified expected score E(mu, mu_j, phi_j, rho). */
export function expectedScore(mu: number, muJ: number, phiJ: number, rhoTerm = 0): number {
  return 1 / (1 + Math.exp(-glickoG(phiJ) * (mu - muJ + rhoTerm)));
}

/** One Glicko-2 update (steps 2-8) of a coach over a period's games; no games = the step-6 inflation only (capped). */
export function glickoUpdate(state: GlickoState, games: readonly GlickoOpponent[], params: GlickoParams = FUMBBL_CR): GlickoState {
  const cap = params.rdCap / GLICKO_SCALE;
  const phi = state.rd / GLICKO_SCALE;
  if (games.length === 0) {
    const inflated = Math.min(Math.sqrt(phi * phi + state.sigma * state.sigma), cap);
    return { r: state.r, rd: inflated * GLICKO_SCALE, sigma: state.sigma };
  }
  const mu = (state.r - 1500) / GLICKO_SCALE;
  const terms = games.map((game) => {
    const muJ = (game.r - 1500) / GLICKO_SCALE;
    const phiJ = game.rd / GLICKO_SCALE;
    const gj = glickoG(phiJ);
    const e = expectedScore(mu, muJ, phiJ, rho(gj, game.deltaCtv ?? 0));
    return { gj, e, s: game.score };
  });
  // step 3
  const v = 1 / terms.reduce((sum, t) => sum + t.gj * t.gj * t.e * (1 - t.e), 0);
  // step 4
  const sumGs = terms.reduce((sum, t) => sum + t.gj * (t.s - t.e), 0);
  const delta = v * sumGs;
  // step 5: the new volatility (Illinois algorithm)
  const a = Math.log(state.sigma * state.sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (params.tau * params.tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * params.tau) < 0) k += 1;
    B = a - k * params.tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > params.epsilon) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C;
    fB = fC;
  }
  const sigma = Math.exp(A / 2);
  // step 6: the pre-period RD, capped
  const phiStar = Math.min(Math.sqrt(phi * phi + sigma * sigma), cap);
  // step 7
  const phiNew = Math.min(1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v), cap);
  const muNew = mu + phiNew * phiNew * sumGs;
  // step 8
  return { r: muNew * GLICKO_SCALE + 1500, rd: phiNew * GLICKO_SCALE, sigma };
}

/** The displayed CR: r - 5 * max(RD - 100, 0), a whole number. */
export const displayedCr = (r: number, rd: number): number => Math.round(r - 5 * Math.max(rd - 100, 0));

export interface CoachGlicko { cr: number; r: number; rd: number; sigma: number; games: number }

export interface GlickoOptions {
  params?: GlickoParams;
  /** Inflate every coach's RD through the period containing this time (the match page passes "now"); default: through the last game's period. */
  asOf?: Date;
  periodDays?: number;
  epochMs?: number;
  /** The results store's revision: with it the ratings are cached per (revision, 7-day period) and the rows are not re-read to build the key. */
  revision?: string;
}

/** What a never-rated coach shows. */
export function unratedGlicko(params: GlickoParams = FUMBBL_CR): CoachGlicko {
  return { cr: displayedCr(params.rating, params.rd), r: params.rating, rd: params.rd, sigma: params.sigma, games: 0 };
}

const coachKey = (coach: string): string => coach.trim().toLowerCase();
/** The game's period: when it was PLAYED; a legacy row without playedAt falls back to when it was pulled. */
const periodOf = (result: StoredTournamentResult, periodMs: number, epochMs: number): number => {
  const t = Date.parse(result.playedAt ?? result.pulledAt);
  return Number.isFinite(t) ? Math.floor((t - epochMs) / periodMs) : 0;
};
const gameOrder = (left: StoredTournamentResult, right: StoredTournamentResult): number => {
  const leftId = Number(left.gameId);
  const rightId = Number(right.gameId);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
  return left.gameId.localeCompare(right.gameId);
};

const memo = new Map<string, Map<string, CoachGlicko>>();

/**
 * Glicko-2 CR over all retained games (the Elo's input), 7-day periods in order (keyed on when each game was PLAYED). Pure and deterministic: the same
 * results (and `asOf` period) give the same ratings. Test and unpublished rows never reach `results` (the store lists counting rows only).
 */
export function computeGlicko(results: readonly StoredTournamentResult[], options: GlickoOptions = {}): Map<string, CoachGlicko> {
  const params = options.params ?? FUMBBL_CR;
  const periodMs = (options.periodDays ?? PERIOD_DAYS) * DAY_MS;
  const epochMs = options.epochMs ?? PERIOD_EPOCH_MS;
  // The cache key is the period the rating is asked for (not the millisecond) plus either the caller's results-store revision (cheap: no replay, no row hashing)
  // or, without one, a hash of the rows themselves.
  const asOfIndex = options.asOf ? Math.floor((options.asOf.getTime() - epochMs) / periodMs) : null;
  const head = JSON.stringify([params, periodMs, epochMs, asOfIndex]);
  let key: string;
  if (options.revision !== undefined) key = `rev:${options.revision}:${head}`;
  else {
    const hash = createHash("sha256").update(head);
    for (const result of results) {
      hash.update(result.gameId).update("\0").update(result.playedAt ?? result.pulledAt).update("\0").update(result.home.coach).update("\0").update(result.away.coach).update("\0")
        .update(String(result.home.teamValue ?? "")).update("\0").update(String(result.away.teamValue ?? "")).update("\0");
      for (const team of result.teams) hash.update(team.teamId).update(String(team.score)).update(String(team.penaltyScore)).update("\0");
    }
    key = `rows:${hash.digest("hex")}`;
  }
  const cached = memo.get(key);
  if (cached) return cached;

  const ordered = [...results].sort(gameOrder);
  const byPeriod = new Map<number, StoredTournamentResult[]>();
  for (const result of ordered) {
    const p = periodOf(result, periodMs, epochMs);
    const bucket = byPeriod.get(p);
    if (bucket) bucket.push(result); else byPeriod.set(p, [result]);
  }
  const lastGame = ordered.length ? Math.max(...byPeriod.keys()) : -Infinity;
  const asOfPeriod = asOfIndex ?? lastGame;
  const first = ordered.length ? Math.min(...byPeriod.keys()) : 0;
  const last = Math.max(lastGame, asOfPeriod);

  const states = new Map<string, GlickoState & { games: number }>();
  const fresh = (): GlickoState & { games: number } => ({ r: params.rating, rd: params.rd, sigma: params.sigma, games: 0 });
  for (let period = first; period <= last && ordered.length > 0; period += 1) {
    const games = byPeriod.get(period) ?? [];
    const snapshot = new Map<string, GlickoState>([...states].map(([c, s]) => [c, { r: s.r, rd: s.rd, sigma: s.sigma }]));
    const lookup = (coach: string): GlickoState => snapshot.get(coach) ?? { r: params.rating, rd: params.rd, sigma: params.sigma };
    const perCoach = new Map<string, GlickoOpponent[]>();
    for (const result of games) {
      const homeTeam = result.teams.find((team) => team.teamId === result.home.teamId);
      const awayTeam = result.teams.find((team) => team.teamId === result.away.teamId);
      if (!homeTeam || !awayTeam) throw new Error(`Game ${result.gameId} result does not match its stored participants.`);
      const home = coachKey(result.home.coach);
      const away = coachKey(result.away.coach);
      const outcome = deriveTeamResult(homeTeam, awayTeam).outcome;
      const homeScore = outcome === "won" ? 1 : outcome === "drawn" ? 0.5 : 0;
      const known = typeof result.home.teamValue === "number" && typeof result.away.teamValue === "number";
      const deltaHome = known ? result.away.teamValue! - result.home.teamValue! : 0; // opponent minus own
      const homeSnap = lookup(home);
      const awaySnap = lookup(away);
      const push = (coach: string, game: GlickoOpponent): void => { const list = perCoach.get(coach); if (list) list.push(game); else perCoach.set(coach, [game]); };
      push(home, { r: awaySnap.r, rd: awaySnap.rd, score: homeScore, deltaCtv: deltaHome });
      push(away, { r: homeSnap.r, rd: homeSnap.rd, score: 1 - homeScore, deltaCtv: -deltaHome });
    }
    for (const coach of new Set([...states.keys(), ...perCoach.keys()])) {
      const before = states.get(coach) ?? fresh();
      const played = perCoach.get(coach) ?? [];
      const after = glickoUpdate({ r: before.r, rd: before.rd, sigma: before.sigma }, played, params);
      states.set(coach, { ...after, games: before.games + played.length });
    }
  }
  const out = new Map<string, CoachGlicko>();
  for (const [coach, s] of states) out.set(coach, { cr: displayedCr(s.r, s.rd), r: s.r, rd: s.rd, sigma: s.sigma, games: s.games });
  memo.set(key, out);
  if (memo.size > 8) memo.delete(memo.keys().next().value!);
  return out;
}
