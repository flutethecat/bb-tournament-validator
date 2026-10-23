/**
 * In-memory Create-Game matchmaking. A coach enters a challenge naming their team and
 * an opponent; when the opponent has a reciprocal pending challenge, the two are paired
 * and each side is handed its own fork-join JNLP (its own coach/team/password + a shared
 * join target). Delivery is poll-based (`matchstatus`): the client polls ~2s while
 * waiting. State is process-local with a short TTL — fine for v1 on a single config-web
 * instance; a DB or pub/sub would be needed only if this is ever load-balanced.
 *
 * Join target: if a scheduler is supplied (see `forkScheduler` / `scheduleForkGame` in
 * forkAdmin.ts), pairing calls the fork's own admin API to create a REAL game server-side
 * and get an authoritative gameId — both JNLPs carry `-gameId`, which the fork's join
 * handler always prefers over gameName. If scheduling isn't configured, or the fork
 * DEFINITELY refused, this falls back to the original scheme: a shared, deterministic
 * gameName that both sides join by (first join creates the game, second starts it).
 *
 * Uncertain outcomes (owner ruling, Astra round 4): when the schedule request went out
 * and no definite answer came back, a game MAY exist. The pairing becomes UNCERTAIN: both
 * consents stay held by that operation (the coaches are reserved), nothing is scheduled
 * again automatically, no timers run. It resolves only when (a) a "check again" finds the
 * exact matchup live on the fork (the same two coaches with the same two teams; the
 * lowest game id wins and any others are reported as duplicates), or (b) a human starts
 * over / cancels, which withdraws both consents. Absence and elapsed time never count as
 * "no game".
 *
 * Auth: if a `verifyChallenger` function is supplied, a challenge must carry the coach's
 * own password and verify against the fork DB before it counts toward mutuality. Without
 * this, "mutual consent" is spoofable — anyone could issue both sides of a challenge
 * under someone else's name and make config-web fire admin `schedule` on their behalf
 * (Yularen's #admin-gate-security amendment §4b). Optional/backward-compatible, same
 * injection shape as the scheduler, for the same testability reason.
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

/** Bound on one scheduler call; past it the outcome is "unknown" (the pairing becomes uncertain). */
export const DEFAULT_SCHEDULE_TIMEOUT_MS = 30_000;

/**
 * The outcome of asking the fork to schedule a game.
 *  - scheduled: the fork answered with `gameId`.
 *  - rejected: DEFINITELY no game (a readable servlet `<error>`, or a failure before the request went out).
 *  - unknown: anything else after the request went out. A game MAY exist; never schedule again automatically.
 */
export type ScheduleOutcome =
  | { kind: "scheduled"; gameId: string; homeTeamId: string; awayTeamId: string }
  | { kind: "rejected"; error?: string }
  | { kind: "unknown"; error?: string };

/** The exact matchup being looked for: these two coaches with these two teams (either orientation). */
export interface Matchup {
  home: { coach: string; teamId: string };
  away: { coach: string; teamId: string };
}

/** One live game found for a matchup, with the home seat as the fork lists it. */
export interface MatchupGame {
  gameId: string;
  homeCoach: string;
}

/** A coach is held by an in-flight or uncertain operation: only Check again / Start over apply. */
export class ConsentHeldError extends Error {
  constructor(message = "A game is being set up for this coach. Use Check again or Start over.") {
    super(message);
    this.name = "ConsentHeldError";
  }
}

export interface ReconcilingScheduler {
  schedule(homeTeamId: string, awayTeamId: string): Promise<ScheduleOutcome>;
  /** Live games whose two seats are exactly the matchup's coaches with its teams, lowest id first, each with the
   *  coach the fork lists as HOME. `undefined` = the check could not be made (stays uncertain). An empty list is
   *  NOT proof of "no game". */
  findMatchup?(matchup: Matchup): Promise<MatchupGame[] | undefined>;
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

/** Fired once per pairing (gameId undefined on the gameName fallback). Read-only notification for views. */
export interface PairingEvent {
  gameName: string;
  gameId?: string;
  home: { coach: string; teamId: string; challengeId: string };
  away: { coach: string; teamId: string; challengeId: string };
  at: number;
  /** Further live games found for the same exact matchup (an extra game was created; an organiser can remove it). */
  duplicates?: string[];
}
export type PairingListener = (pairing: PairingEvent) => void;

/** Re-checked for BOTH sides at pairing time, before scheduling (team still owned / loaded, coach not
 *  banned). Return an error message to refuse; that side's challenge is dropped, the other stays pending. */
export type PairSideValidator = (side: { coach: string; teamId: string }) => Promise<string | undefined> | string | undefined;

/** Result of `challengeVerified` / `checkAgain`. */
export interface VerifiedChallengeResult {
  /** uncertain = both consents are held by a scheduling operation whose outcome is not known. */
  status: "waiting" | "paired" | "uncertain";
  challengeId: string;
  pairing?: PairingEvent;
}

/** Fired when a seat's JNLP is handed to its authorized owner through `matchstatus` (the client took the seat). */
export type DeliveryListener = (delivery: { coach: string; gameName: string; gameId?: string }) => void;

/** What a view may know about the operation between two coaches. */
export type OperationState = "none" | "inflight" | "uncertain";

type PairOutcome =
  | { kind: "paired"; event: PairingEvent }
  | { kind: "uncertain" }
  | { kind: "abandoned" };

/** A scheduling operation whose outcome is unknown; it holds both consents until it resolves or is abandoned. */
interface UncertainOperation {
  key: string;
  a: Challenge;
  b: Challenge;
  genA: number;
  genB: number;
  home: Challenge;
  away: Challenge;
  gameName: string;
  since: number;
  checking: boolean;
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
  private readonly scheduler?: ReconcilingScheduler;
  private readonly verifyChallenger?: ChallengeVerifier;
  private readonly pairingListeners: PairingListener[] = [];
  private readonly deliveryListeners: DeliveryListener[] = [];
  private readonly validateSide?: PairSideValidator;
  private readonly scheduleTimeoutMs: number;
  /** Coach key -> the challenge an in-flight pairing holds (between reservation and outcome). */
  private readonly inflight = new Map<string, Challenge>();
  /** Sorted coach-pair key -> the uncertain operation holding both consents. */
  private readonly uncertain = new Map<string, UncertainOperation>();
  /** Per-coach consent generation: bumped on every challenge, cancel, expiry, start over and pairing. Anything
   *  that awaited (verification, validation, scheduling, a check) acts only if the generation it captured is
   *  still current. */
  private readonly generation = new Map<string, number>();
  private homeAwayMode: HomeAwayMode;

  constructor(opts?: {
    ttlMs?: number;
    now?: () => number;
    /** Injectable RNG (0..1) so "random" mode is deterministic under test. */
    random?: () => number;
    /** Plain scheduler: a gameId is scheduled, an empty result or a throw is a definite rejection. */
    scheduleGame?: ForkGameScheduler;
    /** Preferred: classifies definite rejection vs unknown and can look the matchup up on the fork. */
    scheduler?: ReconcilingScheduler;
    verifyChallenger?: ChallengeVerifier;
    homeAwayMode?: HomeAwayMode;
    onPaired?: PairingListener;
    validateSide?: PairSideValidator;
    scheduleTimeoutMs?: number;
  }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts?.now ?? Date.now;
    this.random = opts?.random ?? Math.random;
    this.scheduler = opts?.scheduler ?? (opts?.scheduleGame ? plainScheduler(opts.scheduleGame) : undefined);
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

  /** Register a delivery listener (the web Lobby marks a client-taken seat "in the client"). */
  onDelivered(listener: DeliveryListener): void {
    this.deliveryListeners.push(listener);
  }

  /** The coach's own pending challenge, digest stripped; undefined when none (or expired). */
  pendingOf(coach: string): PendingChallengeView | undefined {
    this.sweep();
    const c = this.pending.get(this.key(coach));
    return c ? view(c) : undefined;
  }

  /** Pending challenges that NAME this coach as the opponent (an inbox), digest stripped, oldest first. */
  pendingFor(coach: string): PendingChallengeView[] {
    this.sweep();
    const k = this.key(coach);
    return [...this.pending.values()].filter((c) => this.key(c.opponent) === k).map(view);
  }

  /** The operation between two coaches: none, in flight (scheduling right now), or uncertain. */
  operationState(coachA: string, coachB: string): OperationState {
    this.sweep();
    if (this.uncertain.has(this.pairKey(coachA, coachB))) return "uncertain";
    const a = this.inflight.get(this.key(coachA));
    return a && this.key(a.opponent) === this.key(coachB) ? "inflight" : "none";
  }

  /** The challenge ids an in-flight or uncertain operation holds for this coach's pairing ([] when none). */
  heldChallengeIds(coach: string): string[] {
    const k = this.key(coach);
    const mine = this.inflight.get(k);
    if (mine) {
      const theirs = this.inflight.get(this.key(mine.opponent));
      return theirs ? [mine.id, theirs.id] : [mine.id];
    }
    for (const op of this.uncertain.values()) {
      if (this.key(op.a.coach) === k || this.key(op.b.coach) === k) return [op.a.id, op.b.id];
    }
    return [];
  }

  /** Does the matchmaker still hold this exact consent (pending, in flight, or in an uncertain operation)? */
  holdsChallenge(coach: string, challengeId: string): boolean {
    this.sweep();
    const k = this.key(coach);
    if (this.pending.get(k)?.id === challengeId || this.inflight.get(k)?.id === challengeId) return true;
    for (const op of this.uncertain.values()) if (op.a.id === challengeId || op.b.id === challengeId) return true;
    return false;
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

  private pairKey(a: string, b: string): string {
    return [this.key(a), this.key(b)].sort().join("|");
  }

  private gen(k: string): number {
    return this.generation.get(k) ?? 0;
  }

  private bump(k: string): number {
    const next = this.gen(k) + 1;
    this.generation.set(k, next);
    return next;
  }

  private isReserved(k: string): boolean {
    if (this.inflight.has(k)) return true;
    for (const op of this.uncertain.values()) if (this.key(op.a.coach) === k || this.key(op.b.coach) === k) return true;
    return false;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, c] of this.pending) {
      if (c.createdAt < cutoff) { this.pending.delete(k); this.bump(k); } // an expired consent is a changed consent
    }
    for (const [k, m] of this.matched) if (m.createdAt < cutoff) this.matched.delete(k);
  }

  /**
   * Enter (or refresh) a pending challenge. Always resolves `{status:"waiting"}` — an
   * instant reciprocal match is delivered via the next `matchstatus` poll for BOTH
   * sides, keeping one code path (the client's flow is always challenge → poll).
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

    // Admission generation: a cancel, another challenge or a pairing while verification is pending voids this one.
    const admission = this.gen(this.key(coach));
    if (this.verifyChallenger) {
      if (!digest) throw new Error("A password is required to challenge.");
      const ok = await this.verifyChallenger(coach, digest);
      if (!ok) throw new Error("Invalid coach name or password.");
    }
    if (this.gen(this.key(coach)) !== admission) throw new Error("Your challenge changed while it was being checked. Try again.");

    await this.enter({ id: this.newId(), coach, teamId: opts.teamId.trim(), opponent, passwordMd5: digest, createdAt: this.now() });
    return { status: "waiting" }; // paired or uncertain, the client keeps polling matchstatus
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
    return this.result(outcome, mine.id);
  }

  private result(outcome: PairOutcome | undefined, challengeId: string): VerifiedChallengeResult {
    if (outcome?.kind === "paired") return { status: "paired", challengeId, pairing: outcome.event };
    if (outcome?.kind === "uncertain") return { status: "uncertain", challengeId };
    return { status: "waiting", challengeId };
  }

  private newId(): string {
    return randomBytes(9).toString("base64url");
  }

  /** Store a challenge and pair it if reciprocal. Synchronous up to the pairing reservation. */
  private async enter(mine: Challenge): Promise<PairOutcome | undefined> {
    const k = this.key(mine.coach);
    const ko = this.key(mine.opponent);
    // A coach held by an in-flight or uncertain operation cannot enter a new challenge (the held consent id never
    // changes); only Check again / Start over apply to it.
    for (const r of [k, ko]) if (this.isReserved(r)) throw new ConsentHeldError();
    // Expiry is checked again right before the reservation: a consent that expired while this request was being
    // authenticated is gone for good (held consents of an uncertain operation are not subject to it).
    this.sweep();
    const previous = this.pending.get(k);
    const myGen = this.bump(k);
    this.pending.set(k, mine);
    // Reciprocal? The opponent must already be waiting AND naming me.
    const theirs = this.pending.get(ko);
    if (!theirs || this.key(theirs.opponent) !== k) return undefined;
    try {
      return await this.pair(mine, theirs, myGen);
    } catch (e) {
      // A failed attempt is rolled back as a whole: THIS challenge id is gone and the coach's previous challenge
      // comes back only if still live AND nothing happened to this coach since the attempt began.
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
    this.inflight.set(ka, a);
    this.inflight.set(kb, b);
    try {
      return await this.pairReserved(a, b, genA, genB);
    } finally {
      this.inflight.delete(ka);
      this.inflight.delete(kb);
    }
  }

  private async pairReserved(a: Challenge, b: Challenge, genA: number, genB: number): Promise<PairOutcome> {
    const ka = this.key(a.coach);
    const kb = this.key(b.coach);
    const current = () => this.gen(ka) === genA && this.gen(kb) === genB;
    if (this.validateSide) {
      for (const [side, other] of [[a, b], [b, a]] as const) {
        const error = await this.validateSide({ coach: side.coach, teamId: side.teamId });
        if (error) {
          // The invalid side's consent is void. The ATTEMPT (`a`) is always rolled back; the waiting side (`b`)
          // keeps waiting only when it is the valid one and nothing happened to it meanwhile.
          if (other === b && this.gen(kb) === genB && !this.pending.has(kb) && b.createdAt >= this.now() - this.ttlMs) {
            this.pending.set(kb, b);
          }
          throw new Error(error);
        }
      }
      if (!current()) return { kind: "abandoned" }; // cancelled while validating
    }
    // Consent deadlines are re-checked right before the schedule request is sent: a consent that expired while
    // it was being validated is gone (the expiry exemption only begins once an outcome is uncertain). The other,
    // still-valid side keeps waiting.
    const expired = (c: Challenge) => c.createdAt < this.now() - this.ttlMs;
    if (expired(a) || expired(b)) {
      for (const [c, k, g] of [[a, ka, genA], [b, kb, genB]] as const) {
        if (expired(c)) this.bump(k);
        else if (this.gen(k) === g && !this.pending.has(k)) this.pending.set(k, c);
      }
      return { kind: "abandoned" };
    }
    // Stable, order-independent ordering — used for the gameName (so it's predictable/
    // reproducible regardless of who challenged first) AND as the base ordering the
    // home/away policy is applied on top of.
    const sorted = [a, b].sort((x, y) => x.coach.localeCompare(y.coach));
    const first = sorted[0]!;
    const second = sorted[1]!;
    const gameName = `chal_${safe(first.coach)}_${safe(second.coach)}_${this.now()}`;
    // Decide which of the two is HOME for the scheduled game (see HomeAwayMode).
    const [home, away] = this.assignHomeAway(first, second);

    let gameId: string | undefined;
    if (this.scheduler) {
      const outcome: ScheduleOutcome = (await this.bounded(
        Promise.resolve().then(() => this.scheduler!.schedule(home.teamId, away.teamId)).catch((): ScheduleOutcome => ({ kind: "unknown" })),
      )) ?? { kind: "unknown", error: "no answer in time" };
      // A consent withdrawn while the fork was asked (cancel, close, expiry) is honoured: no pairing, no restore.
      if (!current()) return { kind: "abandoned" };
      if (outcome.kind === "unknown") {
        const key = this.pairKey(a.coach, b.coach);
        this.uncertain.set(key, { key, a, b, genA, genB, home, away, gameName, since: this.now(), checking: false });
        return { kind: "uncertain" };
      }
      if (outcome.kind === "scheduled") gameId = outcome.gameId;
      // "rejected": definitely no game, the gameName-only scheme below (unchanged, safe)
    }
    return { kind: "paired", event: this.deliver(a, b, home, away, gameName, gameId) };
  }

  private deliver(a: Challenge, b: Challenge, home: Challenge, away: Challenge, gameName: string, gameId?: string, duplicates?: string[]): PairingEvent {
    const at = this.now();
    this.bump(this.key(a.coach));
    this.bump(this.key(b.coach));
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
      ...(duplicates && duplicates.length ? { duplicates } : {}),
    };
    for (const listener of this.pairingListeners) {
      try { listener(event); } catch { /* a view fault never breaks pairing */ }
    }
    return event;
  }

  /**
   * "Check again" for an uncertain pairing between two coaches: looks the exact matchup up on the fork. Paired
   * when it is live there; still uncertain otherwise (absence proves nothing). Never schedules.
   */
  async checkAgain(coachA: string, coachB: string): Promise<VerifiedChallengeResult | undefined> {
    const op = this.uncertain.get(this.pairKey(coachA, coachB));
    if (!op) return undefined;
    const mine = this.key(op.a.coach) === this.key(coachA) ? op.a : op.b;
    return this.result(await this.checkOperation(op), mine.id);
  }

  private async checkOperation(op: UncertainOperation): Promise<PairOutcome> {
    if (op.checking) return { kind: "uncertain" }; // one check at a time
    const valid = () => this.uncertain.get(op.key) === op
      && this.gen(this.key(op.a.coach)) === op.genA && this.gen(this.key(op.b.coach)) === op.genB;
    if (!valid()) return { kind: "abandoned" };
    if (!this.scheduler?.findMatchup) return { kind: "uncertain" };
    // The check stays occupied until the lookup itself settles (not just until our deadline), so repeated checks
    // never stack reads on the account store.
    op.checking = true;
    const lookup = Promise.resolve()
      .then(() => this.scheduler!.findMatchup!({
        home: { coach: op.home.coach, teamId: op.home.teamId },
        away: { coach: op.away.coach, teamId: op.away.teamId },
      }))
      .catch(() => undefined);
    void lookup.finally(() => { op.checking = false; });
    const games = await this.bounded(lookup);
    if (!valid()) return { kind: "abandoned" }; // started over / cancelled during the check
    if (!games || games.length === 0) return { kind: "uncertain" };
    const sorted = [...games].sort((x, y) => Number(x.gameId) - Number(y.gameId));
    const found = sorted[0]!;
    this.uncertain.delete(op.key); // claimed: the one and only consumer
    // The fork's own listing decides home/away (an existing game may have the sides the other way round).
    const [home, away] = this.key(found.homeCoach) === this.key(op.away.coach) ? [op.away, op.home] : [op.home, op.away];
    return { kind: "paired", event: this.deliver(op.a, op.b, home, away, op.gameName, found.gameId, sorted.slice(1).map((g) => g.gameId)) };
  }

  /** "Start over" from an uncertain pairing: withdraws BOTH consents (a game may already exist on the fork). */
  startOver(coach: string): boolean {
    const k = this.key(coach);
    for (const op of this.uncertain.values()) {
      if (this.key(op.a.coach) === k || this.key(op.b.coach) === k) {
        this.uncertain.delete(op.key);
        this.bump(this.key(op.a.coach));
        this.bump(this.key(op.b.coach));
        return true;
      }
    }
    return false;
  }

  /** Withdraw exactly this consent wherever it is held (pending, in flight, or in an uncertain operation). */
  withdraw(coach: string, challengeId: string): void {
    if (this.holdsChallenge(coach, challengeId)) this.cancel(coach);
  }

  private async bounded<T>(promise: Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.scheduleTimeoutMs); });
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

  /**
   * May this caller cancel `coach`'s challenge? Same rule as `matchstatus`: the coach's own session
   * (`authorized`), or the digest that coach supplied with the challenge being cancelled.
   */
  mayCancel(coach: string, auth: MatchStatusAuth): boolean {
    if (auth.authorized === true) return true;
    const proof = auth.passwordMd5?.trim().toLowerCase();
    if (!proof) return false;
    const k = this.key(coach);
    const held = [this.pending.get(k), this.inflight.get(k),
      ...[...this.uncertain.values()].flatMap((op) => [op.a, op.b]).filter((c) => this.key(c.coach) === k)];
    return held.some((c) => !!c?.passwordMd5 && c.passwordMd5.toLowerCase() === proof);
  }

  /** Drop a coach's challenge wherever it is, fence every in-flight step on it, and start over an uncertain
   *  pairing it belongs to (both consents withdrawn). Callers check `mayCancel` first. */
  cancel(coach: string): void {
    const k = this.key(coach);
    this.pending.delete(k);
    this.bump(k);
    this.startOver(coach);
  }
}

const view = (c: Challenge): PendingChallengeView => ({ id: c.id, coach: c.coach, teamId: c.teamId, opponent: c.opponent, createdAt: c.createdAt });

/** A plain `scheduleGame` function: a gameId is scheduled; an empty result or a throw is a definite rejection
 *  (its contract); a call that never settles becomes unknown through the matchmaker's own deadline. */
function plainScheduler(fn: ForkGameScheduler): ReconcilingScheduler {
  return {
    async schedule(homeTeamId, awayTeamId) {
      try {
        const r = await fn(homeTeamId, awayTeamId);
        return r?.gameId ? { kind: "scheduled", gameId: r.gameId, homeTeamId, awayTeamId } : { kind: "rejected" };
      } catch (e) {
        return { kind: "rejected", error: (e as Error).message };
      }
    },
  };
}
