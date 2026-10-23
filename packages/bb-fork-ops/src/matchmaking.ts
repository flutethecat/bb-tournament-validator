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
/** How long an unresolved scheduling operation is kept for reconciliation. */
const OPERATION_TTL_MS = 30 * 60 * 1000;
/** Background re-attempts of a pairing whose scheduling outcome is unknown (both sides stay waiting meanwhile). */
const DEFAULT_PENDING_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000];

/**
 * The outcome of asking the fork to schedule a game.
 *  - scheduled: the fork created `gameId` (home/away as given).
 *  - rejected: DEFINITELY no game (the fork said no, or the request never went out). Named-game fallback is safe.
 *  - unknown: the request went out but the answer was lost (timeout / abort). A game MAY exist: never fall back to a
 *    named game; reconcile with the opaque token before delivering or scheduling again.
 */
export type ScheduleOutcome =
  | { kind: "scheduled"; gameId: string; homeTeamId: string; awayTeamId: string }
  | { kind: "rejected"; error?: string }
  | { kind: "unknown"; token?: unknown };

/** A scheduler that can reconcile an unknown outcome (the fork admin implementation lives in forkAdmin.ts). */
export interface ReconcilingScheduler {
  schedule(homeTeamId: string, awayTeamId: string): Promise<ScheduleOutcome>;
  /** Re-examine an `unknown` outcome: scheduled (the game exists and is still open with these teams), rejected
   *  (definitely no game), or still unknown. */
  reconcile(token: unknown): Promise<ScheduleOutcome>;
}

/** One scheduling operation awaiting reconciliation, bound to its participants and teams. */
interface SchedulingOperation {
  coachKeys: [string, string];
  homeCoach: string;
  awayCoach: string;
  homeTeamId: string;
  awayTeamId: string;
  /** The challenge ids that started it (audit; a retry re-uses the same consents when they are unchanged). */
  challengeIds: [string, string];
  /** Settles to the scheduler's own outcome; may still be running after the matchmaker's deadline. */
  call: { settled?: ScheduleOutcome; promise: Promise<ScheduleOutcome> };
  at: number;
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
  /** pending = both consents stand but the game's scheduling outcome is not known yet (retried in background). */
  status: "waiting" | "paired" | "pending";
  challengeId: string;
  pairing?: PairingEvent;
}

type PairOutcome = { kind: "paired"; event: PairingEvent } | { kind: "pending" };

/** Fired when a seat's JNLP is handed to its authorized owner through `matchstatus` (the client took the seat). */
export type DeliveryListener = (delivery: { coach: string; gameName: string; gameId?: string }) => void;

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
  private readonly scheduler?: ReconcilingScheduler;
  private readonly pendingRetryDelaysMs: number[];
  /** Unresolved scheduling operations keyed by the sorted coach pair (claimed and deleted atomically, under the
   *  pairing reservation, by the one pairing that uses the result). */
  private readonly operations = new Map<string, SchedulingOperation>();
  /** Per-coach consent generation: bumped on every challenge, cancel and pairing. A rollback restores an older
   *  challenge only when the coach's generation is still the one captured at the attempt. */
  private readonly generation = new Map<string, number>();
  private readonly deliveryListeners: DeliveryListener[] = [];
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
    /** Bound on one scheduling call (default 30 s); past it the outcome is "unknown" and the reservation ends. */
    scheduleTimeoutMs?: number;
    /** Preferred over `scheduleGame`: distinguishes a definite rejection from an unknown outcome and reconciles. */
    scheduler?: ReconcilingScheduler;
    /** Background retry delays for a pending (unknown-outcome) pairing; [] disables. */
    pendingRetryDelaysMs?: number[];
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
    this.scheduler = opts?.scheduler ?? (opts?.scheduleGame ? legacyScheduler(opts.scheduleGame) : undefined);
    this.pendingRetryDelaysMs = opts?.pendingRetryDelaysMs ?? DEFAULT_PENDING_RETRY_DELAYS_MS;
  }

  /** Register a delivery listener (the web Lobby marks a client-taken seat "in the client"). */
  onDelivered(listener: DeliveryListener): void {
    this.deliveryListeners.push(listener);
  }

  private gen(k: string): number {
    return this.generation.get(k) ?? 0;
  }

  private bump(k: string): number {
    const next = this.gen(k) + 1;
    this.generation.set(k, next);
    return next;
  }

  /** Is an unresolved scheduling operation open for these two coaches (the Lobby shows "setting up")? */
  schedulingPending(coachA: string, coachB: string): boolean {
    return this.operations.has(this.pairKey(coachA, coachB));
  }

  private pairKey(a: string, b: string): string {
    return [this.key(a), this.key(b)].sort().join("|");
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
    return { status: "waiting" }; // paired or pending, the client keeps polling matchstatus
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
    const outcome = await this.enter(mine);
    if (outcome?.kind === "paired") return { status: "paired", challengeId: mine.id, pairing: outcome.event };
    if (outcome?.kind === "pending") return { status: "pending", challengeId: mine.id };
    return { status: "waiting", challengeId: mine.id };
  }

  private newId(): string {
    return randomBytes(9).toString("base64url");
  }

  /** Store a challenge and pair it if reciprocal. Synchronous up to the pairing reservation. */
  private async enter(mine: Challenge): Promise<PairOutcome | undefined> {
    const k = this.key(mine.coach);
    for (const r of [k, this.key(mine.opponent)]) {
      if (this.reserved.has(r)) throw new Error("A game is already being set up for this coach. Try again in a moment.");
    }
    const previous = this.pending.get(k);
    const myGen = this.bump(k);
    this.pending.set(k, mine);
    // Reciprocal? The opponent must already be waiting AND naming me.
    const theirs = this.pending.get(this.key(mine.opponent));
    if (!theirs || this.key(theirs.opponent) !== k) return undefined;
    try {
      return await this.pair(mine, theirs, myGen);
    } catch (e) {
      // A failed attempt is rolled back as a whole: THIS challenge id is gone (pair() never restores it) and the
      // coach's previous challenge comes back only if it is still live AND nothing (cancel, another challenge, a
      // pairing) has happened to this coach since the attempt began.
      if (previous && previous.id !== mine.id && previous.createdAt >= this.now() - this.ttlMs
        && this.gen(k) === myGen && !this.pending.has(k)) {
        this.pending.set(k, previous);
      }
      throw e;
    }
  }

  private async pair(a: Challenge, b: Challenge, genA: number): Promise<PairOutcome> {
    // Reserve BEFORE any await: both challenges leave `pending` and both coaches are locked out of new
    // challenges until this pairing resolves. This is the atomicity guarantee (no filesystem lock needed).
    const ka = this.key(a.coach);
    const kb = this.key(b.coach);
    const genB = this.gen(kb);
    this.pending.delete(ka);
    this.pending.delete(kb);
    this.reserved.add(ka);
    this.reserved.add(kb);
    const restore = (c: Challenge, k: string, g: number): void => {
      if (this.gen(k) === g && !this.pending.has(k) && c.createdAt >= this.now() - this.ttlMs) this.pending.set(k, c);
    };
    try {
      const outcome = await this.pairReserved(a, b, (who) => (who === "b" ? restore(b, kb, genB) : restore(a, ka, genA)));
      if (outcome.kind === "pending") {
        // Unknown scheduling outcome: both consents stand; retry (and reconcile) in the background.
        restore(a, ka, genA);
        restore(b, kb, genB);
        this.retryPendingLater(a.coach, b.coach, 0);
      } else {
        this.bump(ka);
        this.bump(kb);
      }
      return outcome;
    } finally {
      this.reserved.delete(ka);
      this.reserved.delete(kb);
    }
  }

  private retryPendingLater(coachA: string, coachB: string, attempt: number): void {
    const delay = this.pendingRetryDelaysMs[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      const a = this.pending.get(this.key(coachA));
      const b = this.pending.get(this.key(coachB));
      if (!a || !b || this.key(a.opponent) !== this.key(coachB) || this.key(b.opponent) !== this.key(coachA)) return;
      if (this.reserved.has(this.key(coachA)) || this.reserved.has(this.key(coachB))) return;
      this.pair(a, b, this.gen(this.key(coachA)))
        .then((o) => { if (o.kind === "pending") this.retryPendingLater(coachA, coachB, attempt + 1); })
        .catch(() => { /* a refusal already rolled the attempt back */ });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  private async pairReserved(a: Challenge, b: Challenge, restoreSide: (who: "a" | "b") => void): Promise<PairOutcome> {
    if (this.validateSide) {
      for (const [side, other] of [[a, b], [b, a]] as const) {
        const error = await this.validateSide({ coach: side.coach, teamId: side.teamId });
        if (error) {
          // The invalid side's consent is void. The ATTEMPT (`a`) is always rolled back; the waiting side (`b`)
          // keeps waiting only when it is the valid one (and nothing happened to it meanwhile).
          if (other === b) restoreSide("b");
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

    let gameId: string | undefined;
    let home: Challenge;
    let away: Challenge;
    const opKey = this.pairKey(a.coach, b.coach);
    for (const [k, op] of this.operations) if (op.at < this.now() - OPERATION_TTL_MS) this.operations.delete(k);
    const open = this.operations.get(opKey);
    const sameTeams = (op: SchedulingOperation) =>
      [op.homeTeamId, op.awayTeamId].sort().join("|") === [a.teamId, b.teamId].sort().join("|");
    if (open && !sameTeams(open)) this.operations.delete(opKey); // other teams now: that operation is not ours to reuse

    const op = this.operations.get(opKey);
    if (op) {
      // Reconcile the earlier operation BEFORE anything else: its game may exist.
      const outcome = await this.resolveOperation(op);
      if (outcome.kind === "unknown") return { kind: "pending" };
      this.operations.delete(opKey); // claimed (we hold the reservation for both coaches): no second claimant
      [home, away] = this.key(a.coach) === this.key(op.homeCoach) ? [a, b] : [b, a];
      if (outcome.kind === "scheduled") gameId = outcome.gameId;
      else if (this.scheduler) {
        const fresh = await this.scheduleFresh(opKey, home, away);
        if (fresh === "pending") return { kind: "pending" };
        gameId = fresh;
      }
    } else {
      // Decide which of the two is HOME for the scheduled game (see HomeAwayMode).
      [home, away] = this.assignHomeAway(first, second);
      if (this.scheduler) {
        const fresh = await this.scheduleFresh(opKey, home, away);
        if (fresh === "pending") return { kind: "pending" };
        gameId = fresh;
      }
      // undefined gameId after a DEFINITE rejection: the gameName-only scheme below (unchanged, safe).
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
    return { kind: "paired", event };
  }

  /** Ask the scheduler, bounded by `scheduleTimeoutMs`. gameId | undefined (definite rejection) | "pending". */
  private async scheduleFresh(opKey: string, home: Challenge, away: Challenge): Promise<string | undefined | "pending"> {
    const scheduler = this.scheduler!;
    const call: SchedulingOperation["call"] = {
      promise: Promise.resolve()
        .then(() => scheduler.schedule(home.teamId, away.teamId))
        // A scheduler that throws gives no outcome at all: treat it as unknown (never as a safe rejection).
        .catch((): ScheduleOutcome => ({ kind: "unknown" })),
    };
    call.promise.then((o) => { call.settled = o; });
    const outcome = await this.boundedWait(call.promise);
    if (outcome?.kind === "scheduled") return outcome.gameId;
    if (outcome?.kind === "rejected") return undefined;
    // unknown, or our own deadline passed with the call still running: record the operation for reconciliation
    this.operations.set(opKey, {
      coachKeys: [this.key(home.coach), this.key(away.coach)],
      homeCoach: home.coach,
      awayCoach: away.coach,
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      challengeIds: [home.id, away.id],
      call,
      at: this.now(),
    });
    return "pending";
  }

  /** The current outcome of an open operation (its call's own result first, then the scheduler's reconcile). */
  private async resolveOperation(op: SchedulingOperation): Promise<ScheduleOutcome> {
    const settled = op.call.settled ?? (await this.boundedWait(op.call.promise, 0));
    if (!settled) return { kind: "unknown" };
    if (settled.kind !== "unknown") return settled;
    try {
      const reconciled = await this.boundedWait(this.scheduler!.reconcile(settled.token));
      return reconciled ?? { kind: "unknown" };
    } catch {
      return { kind: "unknown" };
    }
  }

  private async boundedWait<T>(promise: Promise<T>, ms = this.scheduleTimeoutMs): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
    try {
      return await Promise.race([promise, timeout]);
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
    for (const listener of this.deliveryListeners) {
      try { listener({ coach: m.coach, gameName: m.gameName, gameId: m.gameId }); } catch { /* views never break delivery */ }
    }
    const jnlp = buildSeatJnlp({ coach: m.coach, teamId: m.teamId, gameName: m.gameName, gameId: m.gameId, passwordMd5: m.passwordMd5 });
    return { ...status, jnlp };
  }

  /** Drop a coach's pending challenge (and fence any rollback that would restore an older one). */
  cancel(coach: string): void {
    this.pending.delete(this.key(coach));
    this.bump(this.key(coach));
  }
}

/**
 * Wrap a plain `scheduleGame` function: resolve with a gameId = scheduled; resolve empty or throw = rejected
 * (legacy semantics: the function reports definite failures by throwing). The matchmaker's own deadline turns a
 * call that never settles into "unknown"; reconcile then reads that same call's eventual result, nothing else.
 */
function legacyScheduler(fn: ForkGameScheduler): ReconcilingScheduler {
  return {
    async schedule(homeTeamId, awayTeamId) {
      try {
        const r = await fn(homeTeamId, awayTeamId);
        return r?.gameId ? { kind: "scheduled", gameId: r.gameId, homeTeamId, awayTeamId } : { kind: "rejected" };
      } catch (e) {
        return { kind: "rejected", error: (e as Error).message };
      }
    },
    async reconcile() {
      return { kind: "unknown" };
    },
  };
}
