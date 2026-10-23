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

import { randomBytes } from "node:crypto";
import { buildSeatJnlp, coachSecretDigest } from "./index.js";
import { safe } from "./util.js";

interface Challenge {
  /** Opaque identity of THIS consent: a re-entered challenge is a new id (the Lobby keys consent on it). */
  id: string;
  coach: string;
  teamId: string;
  opponent: string;
  /** hex md5(pw). The clear text is normalized away at admission (coachSecretDigest), so
   *  matchmaking never holds a plain password — it only carries the digest into each
   *  side's JNLP as `-passwordMd5`. Owner security ruling 08-17. */
  passwordMd5?: string;
  createdAt: number;
}

interface MatchDelivery {
  gameName: string;
  /** The server-scheduled gameId, when scheduling succeeded (else undefined → gameName join). */
  gameId?: string;
  opponent: string;
  coach: string;
  teamId: string;
  /** The digest THIS coach supplied with their own challenge (never one fetched for them). Only an
   *  authorized poll (the coach's own session, or the same digest) receives a JNLP carrying it. */
  passwordMd5?: string;
  createdAt: number;
}

export type MatchStatus =
  | { status: "waiting" }
  /** `jnlp` is present ONLY for an authorized poll of a seat with its own digest; otherwise status only. */
  | { status: "matched"; gameName: string; gameId?: string; opponent: string; jnlp?: string };

/** Who is polling: `authorized` = the caller's session owns the coach; `passwordMd5` = a digest the caller sent. */
export interface MatchStatusAuth {
  authorized: boolean;
  passwordMd5?: string;
}

/** Default bound on one scheduling call; the pairing reservation never outlives it. */
export const DEFAULT_SCHEDULE_TIMEOUT_MS = 30_000;
/** How long a late (post-timeout) scheduled game is kept for the next pairing of the same two teams. */
const LATE_GAME_TTL_MS = 30 * 60 * 1000;

interface ScheduleCall {
  promise: Promise<{ gameId: string; homeTeamId: string; awayTeamId: string } | undefined>;
  /** Some pairing used this call's result (a late completion must not be recorded again). */
  consumed: boolean;
  /** A pairing gave up waiting on this call; only then is a later result kept as a "late game". */
  timedOut: boolean;
}

/** Injected so pure matchmaking logic stays testable without real fork/HTTP access. */
export type ForkGameScheduler = (teamHomeId: string, teamAwayId: string) => Promise<{ gameId: string } | undefined>;

/** Injected coach-credential check (see the auth note above); `true` only on a verified
 *  match. Takes the md5 DIGEST, not the clear text — see Challenge.passwordMd5. */
export type ChallengeVerifier = (coach: string, passwordMd5: string) => Promise<boolean>;

/** A pending challenge as read by a VIEW (the web Lobby): never carries the digest. */
export interface PendingChallengeView {
  id: string;
  coach: string;
  teamId: string;
  opponent: string;
  createdAt: number;
}

/** Fired once per pairing, after scheduling resolved (gameId undefined on the gameName fallback).
 *  Read-only notification for views (the web Lobby); the deliveries are unchanged. */
export interface PairingEvent {
  gameName: string;
  gameId?: string;
  home: { coach: string; teamId: string; challengeId: string };
  away: { coach: string; teamId: string; challengeId: string };
  at: number;
}
export type PairingListener = (pairing: PairingEvent) => void;

/** Re-checked for BOTH sides at pairing time, before scheduling (team still owned / loaded, coach not
 *  banned). Return an error message to refuse; that side's challenge is dropped, the other stays pending. */
export type PairSideValidator = (side: { coach: string; teamId: string }) => Promise<string | undefined> | string | undefined;

/** Result of `challengeVerified`: the new challenge's id, and the pairing when it paired at once. */
export interface VerifiedChallengeResult {
  status: "waiting" | "paired";
  challengeId: string;
  pairing?: PairingEvent;
}

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
  private readonly pairingListeners: PairingListener[] = [];
  private readonly validateSide?: PairSideValidator;
  /** Coach keys whose pairing is in flight (between reservation and delivery). A challenge by or for a
   *  reserved coach is refused, so overlapping accepts can never pair (or schedule) twice. */
  private readonly reserved = new Set<string>();
  private readonly scheduleTimeoutMs: number;
  /** In-flight scheduling calls keyed by the (sorted) team pair: a retry awaits the same call, never a 2nd one. */
  private readonly inflight = new Map<string, ScheduleCall>();
  /** Games a timed-out call created after its deadline, reused by the next pairing of those teams. */
  private readonly lateGames = new Map<string, { gameId: string; homeTeamId: string; awayTeamId: string; at: number }>();
  private homeAwayMode: HomeAwayMode;

  constructor(opts?: {
    ttlMs?: number;
    now?: () => number;
    /** Injectable RNG (0..1) so "random" mode is deterministic under test. */
    random?: () => number;
    scheduleGame?: ForkGameScheduler;
    verifyChallenger?: ChallengeVerifier;
    homeAwayMode?: HomeAwayMode;
    onPaired?: PairingListener;
    validateSide?: PairSideValidator;
    /** Bound on one scheduling call (default 30 s). On timeout the pairing fails and the reservation ends. */
    scheduleTimeoutMs?: number;
  }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.random = opts?.random ?? Math.random;
    this.scheduleGame = opts?.scheduleGame;
    this.verifyChallenger = opts?.verifyChallenger;
    this.homeAwayMode = opts?.homeAwayMode ?? DEFAULT_HOME_AWAY_MODE;
    if (opts?.onPaired) this.pairingListeners.push(opts.onPaired);
    this.validateSide = opts?.validateSide;
    this.scheduleTimeoutMs = opts?.scheduleTimeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS;
  }

  /** Register a read-only pairing listener (the web Lobby view). A listener fault never breaks pairing. */
  onPaired(listener: PairingListener): void {
    this.pairingListeners.push(listener);
  }

  /** The coach's own pending challenge, digest stripped; undefined when none (or expired). */
  pendingOf(coach: string): PendingChallengeView | undefined {
    this.sweep();
    const c = this.pending.get(this.key(coach));
    return c ? { id: c.id, coach: c.coach, teamId: c.teamId, opponent: c.opponent, createdAt: c.createdAt } : undefined;
  }

  /** Pending challenges that NAME this coach as the opponent (an inbox), digest stripped, oldest first. */
  pendingFor(coach: string): PendingChallengeView[] {
    this.sweep();
    const k = this.key(coach);
    return [...this.pending.values()]
      .filter((c) => this.key(c.opponent) === k)
      .map((c) => ({ id: c.id, coach: c.coach, teamId: c.teamId, opponent: c.opponent, createdAt: c.createdAt }));
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
  async challenge(opts: {
    coach: string;
    teamId: string;
    opponent: string;
    /** Deprecated clear-text form, accepted for one release. */
    password?: string;
    /** hex md5(pw) — the preferred form. */
    passwordMd5?: string;
  }): Promise<{ status: "waiting" }> {
    this.sweep();
    const coach = opts.coach.trim();
    const opponent = opts.opponent.trim();
    if (!coach) throw new Error("coach is required.");
    if (!opts.teamId?.trim()) throw new Error("teamId is required.");
    if (!opponent) throw new Error("opponent is required.");
    if (this.key(coach) === this.key(opponent)) throw new Error("You can't challenge yourself.");

    // Accept either carrier and reduce to the digest immediately, so nothing downstream
    // (verification, the pending map, the delivered JNLP) ever sees a clear-text password.
    const { digest } = coachSecretDigest(opts);

    if (this.verifyChallenger) {
      if (!digest) throw new Error("A password is required to challenge.");
      const ok = await this.verifyChallenger(coach, digest);
      if (!ok) throw new Error("Invalid coach name or password.");
    }

    await this.enter({ id: this.newId(), coach, teamId: opts.teamId.trim(), opponent, passwordMd5: digest, createdAt: this.now() });
    return { status: "waiting" };
  }

  /**
   * A challenge whose coach the CALLER already proved (the web Lobby: a Discord-authenticated session).
   * Skips `verifyChallenger` and carries NO digest, so nothing fetched on the coach's behalf can ever
   * reach a delivery. Same pairing rules (and the same reservation) as `challenge`.
   */
  async challengeVerified(opts: { coach: string; teamId: string; opponent: string }): Promise<VerifiedChallengeResult> {
    this.sweep();
    const coach = opts.coach.trim();
    const opponent = opts.opponent.trim();
    if (!coach) throw new Error("coach is required.");
    if (!opts.teamId?.trim()) throw new Error("teamId is required.");
    if (!opponent) throw new Error("opponent is required.");
    if (this.key(coach) === this.key(opponent)) throw new Error("You can't challenge yourself.");
    const mine: Challenge = { id: this.newId(), coach, teamId: opts.teamId.trim(), opponent, createdAt: this.now() };
    const pairing = await this.enter(mine);
    return pairing ? { status: "paired", challengeId: mine.id, pairing } : { status: "waiting", challengeId: mine.id };
  }

  private newId(): string {
    return randomBytes(9).toString("base64url");
  }

  /** Store a challenge and pair it if reciprocal. Synchronous up to the pairing reservation. */
  private async enter(mine: Challenge): Promise<PairingEvent | undefined> {
    for (const k of [this.key(mine.coach), this.key(mine.opponent)]) {
      if (this.reserved.has(k)) throw new Error("A game is already being set up for this coach. Try again in a moment.");
    }
    const previous = this.pending.get(this.key(mine.coach));
    this.pending.set(this.key(mine.coach), mine);
    // Reciprocal? The opponent must already be waiting AND naming me.
    const theirs = this.pending.get(this.key(mine.opponent));
    if (!theirs || this.key(theirs.opponent) !== this.key(mine.coach)) return undefined;
    try {
      return await this.pair(mine, theirs);
    } catch (e) {
      // A failed attempt is rolled back as a whole: THIS challenge id is gone (pair() never restores it) and
      // the coach's previous challenge, if any and still live, comes back. Nothing is left pending unseen.
      if (previous && previous.id !== mine.id && previous.createdAt >= this.now() - this.ttlMs && !this.pending.has(this.key(mine.coach))) {
        this.pending.set(this.key(mine.coach), previous);
      }
      throw e;
    }
  }

  private async pair(a: Challenge, b: Challenge): Promise<PairingEvent> {
    // Reserve BEFORE any await: both challenges leave `pending` and both coaches are locked out of new
    // challenges until this pairing resolves. This is the atomicity guarantee (no filesystem lock needed).
    const ka = this.key(a.coach);
    const kb = this.key(b.coach);
    this.pending.delete(ka);
    this.pending.delete(kb);
    this.reserved.add(ka);
    this.reserved.add(kb);
    try {
      return await this.pairReserved(a, b);
    } finally {
      this.reserved.delete(ka);
      this.reserved.delete(kb);
    }
  }

  private async pairReserved(a: Challenge, b: Challenge): Promise<PairingEvent> {
    if (this.validateSide) {
      for (const [side, other] of [[a, b], [b, a]] as const) {
        const error = await this.validateSide({ coach: side.coach, teamId: side.teamId });
        if (error) {
          // The invalid side's consent is void. The ATTEMPT (`a`) is always rolled back; the waiting side (`b`)
          // keeps waiting only when it is the valid one (and has not expired meanwhile).
          if (other === b && b.createdAt >= this.now() - this.ttlMs) this.pending.set(this.key(b.coach), b);
          throw new Error(error);
        }
      }
    }
    // Stable, order-independent ordering — used for the gameName (so it's predictable/
    // reproducible regardless of who challenged first) AND as the base ordering the
    // home/away policy is applied on top of.
    const sorted = [a, b].sort((x, y) => x.coach.localeCompare(y.coach));
    const first = sorted[0]!;
    const second = sorted[1]!;
    const gameName = `chal_${safe(first.coach)}_${safe(second.coach)}_${this.now()}`;
    const at = this.now();

    // Decide which of the two is HOME for the scheduled game (see HomeAwayMode).
    let [home, away] = this.assignHomeAway(first, second);

    let gameId: string | undefined;
    if (this.scheduleGame) {
      const outcome = await this.scheduleOnce(home.teamId, away.teamId);
      if (outcome.kind === "timeout") {
        // The fork did not answer in time: no game is assumed. Roll back the attempt (enter() restores the
        // attempting coach's previous challenge), keep the waiting side waiting, and end the reservation. A late
        // answer is recorded for the next pairing of these teams, so a retry cannot schedule a second game.
        if (b.createdAt >= this.now() - this.ttlMs) this.pending.set(this.key(b.coach), b);
        throw new Error("The game server did not answer in time. Try again in a moment.");
      }
      if (outcome.kind === "scheduled") {
        gameId = outcome.gameId;
        // A reused (late) game keeps the home/away it was created with.
        if (outcome.homeTeamId === away.teamId) [home, away] = [away, home];
      }
      // outcome "failed": fall back to the gameName-only scheme below, not a hard failure (unchanged)
    }

    this.matched.set(this.key(a.coach), {
      gameName, gameId, opponent: b.coach, coach: a.coach, teamId: a.teamId, passwordMd5: a.passwordMd5, createdAt: at,
    });
    this.matched.set(this.key(b.coach), {
      gameName, gameId, opponent: a.coach, coach: b.coach, teamId: b.teamId, passwordMd5: b.passwordMd5, createdAt: at,
    });
    const event: PairingEvent = {
      gameName,
      gameId,
      home: { coach: home.coach, teamId: home.teamId, challengeId: home.id },
      away: { coach: away.coach, teamId: away.teamId, challengeId: away.id },
      at,
    };
    for (const listener of this.pairingListeners) {
      try { listener(event); } catch { /* a view fault never breaks pairing */ }
    }
    return event;
  }

  /**
   * One scheduling call per team pair, bounded by `scheduleTimeoutMs`. A pairing of the same teams while a call
   * is in flight awaits that call; a late result after a timeout is kept and reused, never scheduled twice.
   */
  private async scheduleOnce(
    homeTeamId: string,
    awayTeamId: string,
  ): Promise<{ kind: "scheduled"; gameId: string; homeTeamId: string } | { kind: "failed" } | { kind: "timeout" }> {
    const pairKey = [homeTeamId, awayTeamId].sort().join("|");
    for (const [k, g] of this.lateGames) if (g.at < this.now() - LATE_GAME_TTL_MS) this.lateGames.delete(k);
    const late = this.lateGames.get(pairKey);
    if (late) {
      this.lateGames.delete(pairKey);
      return { kind: "scheduled", gameId: late.gameId, homeTeamId: late.homeTeamId };
    }
    let call = this.inflight.get(pairKey);
    if (!call) {
      const scheduler = this.scheduleGame!;
      const created: ScheduleCall = {
        consumed: false,
        timedOut: false,
        promise: Promise.resolve()
          .then(() => scheduler(homeTeamId, awayTeamId))
          .then((r) => (r?.gameId ? { gameId: r.gameId, homeTeamId, awayTeamId } : undefined)),
      };
      call = created;
      this.inflight.set(pairKey, created);
      created.promise.then(
        (r) => {
          if (this.inflight.get(pairKey) === created) this.inflight.delete(pairKey);
          if (r && created.timedOut && !created.consumed) this.lateGames.set(pairKey, { ...r, at: this.now() });
        },
        () => { if (this.inflight.get(pairKey) === created) this.inflight.delete(pairKey); },
      );
    }
    const active = call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.scheduleTimeoutMs); });
    try {
      const r = await Promise.race([active.promise, timeout]);
      if (r === "timeout") { active.timedOut = true; return { kind: "timeout" }; }
      active.consumed = true;
      return r ? { kind: "scheduled", gameId: r.gameId, homeTeamId: r.homeTeamId } : { kind: "failed" };
    } catch {
      active.consumed = true;
      return { kind: "failed" };
    } finally {
      clearTimeout(timer);
    }
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
   * Poll for a match. Only an AUTHORIZED poll (`authorized`: the caller's session owns `coach`; or the
   * caller sent the same digest that coach supplied) gets a JNLP, built from that coach's OWN digest, and
   * consumes the delivery. Every other poll gets status only (paired, game name / id) and never consumes.
   * A seat with no digest of its own (web Lobby) never gets a JNLP here. Authorization is always explicit.
   */
  matchstatus(coach: string, auth: MatchStatusAuth): MatchStatus {
    this.sweep();
    const k = this.key(coach);
    const m = this.matched.get(k);
    if (!m) return { status: "waiting" };
    const status = { status: "matched" as const, gameName: m.gameName, gameId: m.gameId, opponent: m.opponent };
    // A seat without a digest of its own (a web Lobby seat) is never delivered here: its JNLP is session-scoped
    // (GET /api/lobby/:id/jnlp). No placeholder password, ever.
    if (!m.passwordMd5) return status;
    const proof = auth.passwordMd5?.trim().toLowerCase();
    const authorized = auth.authorized === true || (!!proof && proof === m.passwordMd5.toLowerCase());
    if (!authorized) return status; // status only, and the delivery stays for its owner
    this.matched.delete(k);
    const jnlp = buildSeatJnlp({ coach: m.coach, teamId: m.teamId, gameName: m.gameName, gameId: m.gameId, passwordMd5: m.passwordMd5 });
    return { ...status, jnlp };
  }

  /** Drop a coach's pending challenge. */
  cancel(coach: string): void {
    this.pending.delete(this.key(coach));
  }
}
