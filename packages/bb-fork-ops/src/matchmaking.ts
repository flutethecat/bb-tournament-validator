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
 *
 * Auth: if a `verifyChallenger` function is supplied, a challenge must carry the coach's
 * own password and verify against the fork DB before it counts toward mutuality. Without
 * this, "mutual consent" is spoofable — anyone could issue both sides of a challenge
 * under someone else's name and make config-web fire admin `schedule` on their behalf
 * (Yularen's #admin-gate-security amendment §4b). Optional/backward-compatible, same
 * injection shape as `scheduleGame`, for the same testability reason.
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
  /** The server-scheduled gameId, when scheduling succeeded (else undefined → gameName join). */
  gameId?: string;
  opponent: string;
  jnlp: string;
  createdAt: number;
}

export type MatchStatus =
  | { status: "waiting" }
  | { status: "matched"; gameName: string; gameId?: string; opponent: string; jnlp: string };

/** Injected so pure matchmaking logic stays testable without real fork/HTTP access. */
export type ForkGameScheduler = (teamHomeId: string, teamAwayId: string) => Promise<{ gameId: string } | undefined>;

/** Injected coach-password check (see the auth note above); `true` only on a verified match. */
export type ChallengeVerifier = (coach: string, password: string) => Promise<boolean>;

/**
 * How home/away is assigned when a pair is scheduled (which team the fork gets as
 * `teamHomeId`). Home/away drives the pregame coin toss and pitch/dugout side, so a
 * FIXED assignment systematically favours one coach — hence these fairer options:
 *  - `"alternating"` (default) — deterministic + reproducible ("seeded"): the two coaches
 *    swap home/away each time THIS pair meets. The FIRST meeting is alphabetical by coach
 *    (so a one-off pairing is stable/predictable, and prior behaviour is preserved).
 *  - `"random"` — a fresh coin flip per pairing (fair on average, not reproducible).
 * Note: this only affects the server-scheduled path. On the gameName-only fallback the
 * fork assigns home by JOIN ORDER, which this can't control.
 */
export type HomeAwayMode = "alternating" | "random";
export const HOME_AWAY_MODES: HomeAwayMode[] = ["alternating", "random"];
export const DEFAULT_HOME_AWAY_MODE: HomeAwayMode = "alternating";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class Matchmaker {
  private readonly pending = new Map<string, Challenge>();
  private readonly matched = new Map<string, MatchDelivery>();
  /** Per-pair meeting counter (keyed by the sorted coach pair) — drives "alternating". */
  private readonly pairMeetings = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly scheduleGame?: ForkGameScheduler;
  private readonly verifyChallenger?: ChallengeVerifier;
  private homeAwayMode: HomeAwayMode;

  constructor(opts?: {
    ttlMs?: number;
    now?: () => number;
    /** Injectable RNG (0..1) so "random" mode is deterministic under test. */
    random?: () => number;
    scheduleGame?: ForkGameScheduler;
    verifyChallenger?: ChallengeVerifier;
    homeAwayMode?: HomeAwayMode;
  }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.random = opts?.random ?? Math.random;
    this.scheduleGame = opts?.scheduleGame;
    this.verifyChallenger = opts?.verifyChallenger;
    this.homeAwayMode = opts?.homeAwayMode ?? DEFAULT_HOME_AWAY_MODE;
  }

  /** Current home/away assignment policy (see HomeAwayMode). */
  getHomeAwayMode(): HomeAwayMode {
    return this.homeAwayMode;
  }

  /** Switch the home/away policy at runtime (backs the control-panel toggle). */
  setHomeAwayMode(mode: HomeAwayMode): void {
    if (!HOME_AWAY_MODES.includes(mode)) throw new Error(`Unknown home/away mode: ${mode}`);
    this.homeAwayMode = mode;
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

    if (this.verifyChallenger) {
      if (!opts.password) throw new Error("A password is required to challenge.");
      const ok = await this.verifyChallenger(coach, opts.password);
      if (!ok) throw new Error("Invalid coach name or password.");
    }

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
    // Stable, order-independent ordering — used for the gameName (so it's predictable/
    // reproducible regardless of who challenged first) AND as the base ordering the
    // home/away policy is applied on top of.
    const sorted = [a, b].sort((x, y) => x.coach.localeCompare(y.coach));
    const first = sorted[0]!;
    const second = sorted[1]!;
    const gameName = `chal_${safe(first.coach)}_${safe(second.coach)}_${this.now()}`;
    const at = this.now();

    // Decide which of the two is HOME for the scheduled game (see HomeAwayMode).
    const [home, away] = this.assignHomeAway(first, second);

    let gameId: string | undefined;
    if (this.scheduleGame) {
      try {
        gameId = (await this.scheduleGame(home.teamId, away.teamId))?.gameId;
      } catch {
        gameId = undefined; // fall back to the gameName-only scheme below, not a hard failure
      }
    }

    this.matched.set(this.key(a.coach), {
      gameName,
      gameId,
      opponent: b.coach,
      jnlp: buildForkJnlp({ coach: a.coach, teamId: a.teamId, gameName, password: a.password, gameId }),
      createdAt: at,
    });
    this.matched.set(this.key(b.coach), {
      gameName,
      gameId,
      opponent: a.coach,
      jnlp: buildForkJnlp({ coach: b.coach, teamId: b.teamId, gameName, password: b.password, gameId }),
      createdAt: at,
    });
    this.pending.delete(this.key(a.coach));
    this.pending.delete(this.key(b.coach));
  }

  /**
   * Apply the home/away policy to a stably-ordered pair (`first` < `second` by coach).
   * Returns `[home, away]`.
   *  - "alternating": swap on every ODD meeting of this exact pair. Meeting 0 (first ever)
   *    keeps the sorted order, so a one-off pairing is stable/alphabetical.
   *  - "random": swap on a coin flip (injectable RNG).
   */
  private assignHomeAway(first: Challenge, second: Challenge): [Challenge, Challenge] {
    let swap: boolean;
    if (this.homeAwayMode === "random") {
      swap = this.random() < 0.5;
    } else {
      const pairKey = `${this.key(first.coach)}|${this.key(second.coach)}`;
      const meeting = this.pairMeetings.get(pairKey) ?? 0;
      this.pairMeetings.set(pairKey, meeting + 1);
      swap = meeting % 2 === 1;
    }
    return swap ? [second, first] : [first, second];
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
      return { status: "matched", gameName: m.gameName, gameId: m.gameId, opponent: m.opponent, jnlp: m.jnlp };
    }
    return { status: "waiting" };
  }

  /** Drop a coach's pending challenge. */
  cancel(coach: string): void {
    this.pending.delete(this.key(coach));
  }
}
