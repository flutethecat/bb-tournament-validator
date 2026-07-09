/**
 * In-memory Create-Game matchmaking. A coach enters a challenge naming their team and
 * an opponent; when the opponent has a reciprocal pending challenge, the two are paired
 * and each side is handed its own fork-join JNLP (its own coach/team/password + a shared
 * join target). Delivery is poll-based (`matchstatus`): the client polls ~2s while
 * waiting. State is process-local with a short TTL — fine for v1 on a single config-web
 * instance; a DB or pub/sub would be needed only if this is ever load-balanced.
 *
 * Join target: if a `scheduleGame` function is supplied (see `scheduleForkGame` in
 * forkAdmin.ts), pairing calls the fork's own admin API to create a REAL game server-side
 * and get an authoritative gameId — both JNLPs carry `-gameId`, which the fork's join
 * handler always prefers over gameName. If scheduling isn't configured, or the call
 * fails for any reason, this falls back to the original scheme: a shared, deterministic
 * gameName that both sides join by (first join creates the game, second starts it) —
 * proven, so a scheduling failure never blocks a challenge from pairing.
 */

import { buildForkJnlp } from "./index.js";
import { safe } from "./util.js";

interface Challenge {
  coach: string;
  teamId: string;
  opponent: string;
  password?: string;
  createdAt: number;
}

interface MatchDelivery {
  gameName: string;
  opponent: string;
  jnlp: string;
  createdAt: number;
}

export type MatchStatus =
  | { status: "waiting" }
  | { status: "matched"; gameName: string; opponent: string; jnlp: string };

/** Injected so pure matchmaking logic stays testable without real fork/HTTP access. */
export type ForkGameScheduler = (teamHomeId: string, teamAwayId: string) => Promise<{ gameId: string } | undefined>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class Matchmaker {
  private readonly pending = new Map<string, Challenge>();
  private readonly matched = new Map<string, MatchDelivery>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly scheduleGame?: ForkGameScheduler;

  constructor(opts?: { ttlMs?: number; now?: () => number; scheduleGame?: ForkGameScheduler }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.scheduleGame = opts?.scheduleGame;
  }

  /** Case-insensitive key so "Kalimar" and "kalimar" are the same coach. */
  private key(coach: string): string {
    return coach.trim().toLowerCase();
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, c] of this.pending) if (c.createdAt < cutoff) this.pending.delete(k);
    for (const [k, m] of this.matched) if (m.createdAt < cutoff) this.matched.delete(k);
  }

  /**
   * Enter (or refresh) a pending challenge. Always resolves `{status:"waiting"}` — an
   * instant reciprocal match is delivered via the next `matchstatus` poll for BOTH
   * sides, keeping one code path (the client's flow is always challenge → poll). Async
   * because pairing may call out to the fork's admin API to schedule a real game; the
   * caller awaits so the response only comes back once pairing has fully resolved
   * (including the gameName-fallback path on a scheduling failure) — no partial state.
   */
  async challenge(opts: { coach: string; teamId: string; opponent: string; password?: string }): Promise<{ status: "waiting" }> {
    this.sweep();
    const coach = opts.coach.trim();
    const opponent = opts.opponent.trim();
    if (!coach) throw new Error("coach is required.");
    if (!opts.teamId?.trim()) throw new Error("teamId is required.");
    if (!opponent) throw new Error("opponent is required.");
    if (this.key(coach) === this.key(opponent)) throw new Error("You can't challenge yourself.");

    const mine: Challenge = { coach, teamId: opts.teamId.trim(), opponent, password: opts.password, createdAt: this.now() };
    this.pending.set(this.key(coach), mine);

    // Reciprocal? The opponent must already be waiting AND naming me.
    const theirs = this.pending.get(this.key(opponent));
    if (theirs && this.key(theirs.opponent) === this.key(coach)) {
      await this.pair(mine, theirs);
    }
    return { status: "waiting" };
  }

  private async pair(a: Challenge, b: Challenge): Promise<void> {
    // Deterministic, order-independent — same ordering used for both the gameName and
    // the home/away assignment passed to scheduleGame.
    const sorted = [a, b].sort((x, y) => x.coach.localeCompare(y.coach));
    const first = sorted[0]!;
    const second = sorted[1]!;
    const gameName = `chal_${safe(first.coach)}_${safe(second.coach)}_${this.now()}`;
    const at = this.now();

    let gameId: string | undefined;
    if (this.scheduleGame) {
      try {
        gameId = (await this.scheduleGame(first.teamId, second.teamId))?.gameId;
      } catch {
        gameId = undefined; // fall back to the gameName-only scheme below, not a hard failure
      }
    }

    this.matched.set(this.key(a.coach), {
      gameName,
      opponent: b.coach,
      jnlp: buildForkJnlp({ coach: a.coach, teamId: a.teamId, gameName, password: a.password, gameId }),
      createdAt: at,
    });
    this.matched.set(this.key(b.coach), {
      gameName,
      opponent: a.coach,
      jnlp: buildForkJnlp({ coach: b.coach, teamId: b.teamId, gameName, password: b.password, gameId }),
      createdAt: at,
    });
    this.pending.delete(this.key(a.coach));
    this.pending.delete(this.key(b.coach));
  }

  /**
   * Poll for a match. On a `matched` result the delivery is consumed (dropped) so a
   * duplicate poll won't re-open a stale game; the client stops polling once matched.
   */
  matchstatus(coach: string): MatchStatus {
    this.sweep();
    const k = this.key(coach);
    const m = this.matched.get(k);
    if (m) {
      this.matched.delete(k);
      return { status: "matched", gameName: m.gameName, opponent: m.opponent, jnlp: m.jnlp };
    }
    return { status: "waiting" };
  }

  /** Drop a coach's pending challenge. */
  cancel(coach: string): void {
    this.pending.delete(this.key(coach));
  }
}
