// Shared registration core (registration spec 2026-11-02 §2, §8; lane L0): the registration window, the entry state
// machine and the adapter contract the tournament (L4) and league (L6) lanes implement. The rules live here once; the
// adapters only map their stored records to RegistrationEntry and persist the changes the core hands them.
//
// Nothing here is wired to a route yet. Absent fields on existing records keep today's behaviour (adapters map an entrant
// without `entryState` to "accepted", see legacyEntryState in ./window.ts).

export type CompetitionKind = "tournament" | "league";

/** Who decides an entry (§2): "auto" accepts while there is room; "organiser" makes every self-entry pending. */
export type ApprovalMode = "auto" | "organiser";

/** One registration window on a tournament or a league season (§2). All times are ISO strings. */
export interface RegistrationWindow {
  /** Absent = open from publication. */
  opensAt?: string;
  /** Absent = open until the competition starts. Tournaments: mirrors deadlines.registration. */
  closesAt?: string;
  /** Places. null (or 0) = no cap. Tournaments: maxPlayers stays the source; league seasons: max teams. */
  cap: number | null;
  /** Leagues: accepted teams per race. null / absent = no limit. */
  perRace?: number | null;
  approval: ApprovalMode;
  waitlist: boolean;
  /** Tournaments. Absent opensAt = 24 h before the start (Q11); absent closesAt = the start (or deadlines.checkIn). */
  checkIn?: { opensAt?: string; closesAt?: string; self: boolean };
  /** Tournaments: "register now, roster later" (Q4, default on). */
  rosterLater?: boolean;
  /** The roster deadline under "roster later". */
  rosterBy?: string;
  /** Leagues (Q8, default off). */
  allowExistingTeams?: boolean;
  /** Leagues (Q9, default off): registration may stay open in an active season. */
  allowMidSeason?: boolean;
}

export const ENTRY_STATES = ["pending", "accepted", "waitlisted", "declined", "withdrawn", "dropped"] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

/** States in which the entry is live (counts as "already registered"; the organisers see the coach's shared fields). */
export const ACTIVE_ENTRY_STATES: ReadonlySet<EntryState> = new Set(["pending", "accepted", "waitlisted"]);

export type TransitionAction = "submit" | "reenter" | "accept" | "promote" | "waitlist" | "decline" | "withdraw" | "drop";

/** One audited state change. `by` is a coach id, or "system" for an automatic promotion. */
export interface RegistrationTransition {
  action: TransitionAction;
  from: EntryState | null;
  to: EntryState;
  by: string;
  at: string;
  reason?: string;
}

/** The last organiser decision (accept / waitlist / decline / drop / promote). */
export interface RegistrationDecision {
  by: string;
  at: string;
  reason?: string;
}

/** An entry as the core sees it. Tournaments store these fields on TournamentEntrantRecord, leagues on a
 *  LeagueRegistration row (spec §8.1); the adapter maps both ways. */
export interface RegistrationEntry {
  /** Kept across re-entry (a withdrawn coach's row is reactivated with the same id, §7). */
  id: string;
  competitionId: string;
  /** The coach's fork account (identity key matching is case-insensitive). */
  coach: string;
  state: EntryState;
  /** First submission. */
  submittedAt: string;
  /** The current submission (reset on re-entry). A share grant counts only when given at or after it. */
  enteredAt: string;
  /** When the entry joined the waitlist (its place in line). */
  waitlistAt?: string;
  /** Monotonic per competition, assigned when the entry joins the waitlist: breaks waitlistAt ties (never the id, which
   *  a re-entering coach keeps from an older submission). */
  waitlistSeq?: number;
  decided?: RegistrationDecision;
  /** Leagues: the team's race, for the per-race limit. */
  race?: string;
  /** Every transition, oldest first. */
  log: RegistrationTransition[];
  /** Adapter payload (team ref, roster snapshot...), opaque to the core; kept on every transition. */
  data?: Record<string, unknown>;
}

/** What the core needs to know about one competition right now (built by the adapter from its stored record). */
export interface CompetitionSnapshot {
  kind: CompetitionKind;
  id: string;
  name: string;
  /** Tournaments: publishedAt set (or a pre-publish draft, which counts as published). Leagues: visibility published. */
  published: boolean;
  /** Completed or cancelled (tournament), finished season (league). */
  finished: boolean;
  /** Tournament: round 1 exists. League season: active (registration then needs allowMidSeason). */
  started: boolean;
  /** Tournament rosters locked. */
  locked: boolean;
  /** Marked test (Q13): the only competitions a test sign-in may write in. */
  test: boolean;
  window: RegistrationWindow;
  /** Owner + organisers (tournament ownerCoachId + organizerCoachIds; league owner + organisers). */
  managers: readonly string[];
  /** A shut Registration gate (tournaments, src/tournaments/registrationGate.ts): self-registration is refused until opensAt
   *  (absent = until an organiser opens it), with this message. */
  gate?: { opensAt?: string; message: string };
  /** Start of play (tournament start date + time), for the default check-in window. */
  startAt?: string;
  /** Which entries were sent the check-in-open notice, for which check-in window (`opensAt|closesAt`): once per entry
   *  per window; a moved window starts over. */
  checkInNotice?: CheckInNoticeRecord;
}

export interface CheckInNoticeRecord {
  window: string;
  entryIds: string[];
  at: string;
}

/** One entry change the adapter persists. `before` is absent for a brand new entry. */
export interface RegistrationChange {
  before?: RegistrationEntry;
  after: RegistrationEntry;
  transition: RegistrationTransition;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * The contract the tournament (L4) and league (L6) lanes implement. The core calls it only inside its per-competition
 * lock, so `entries` -> `commit` is one read-modify-write. `commit` must apply ALL changes or none (one store mutation),
 * and may do the competition's own follow-up on a transition (a league creates its LeagueTeam on accept, a tournament
 * clears its standings cache).
 */
export interface RegistrationAdapter {
  readonly kind: CompetitionKind;
  /** The competition, or undefined when it does not exist (404). */
  competition(id: string): MaybePromise<CompetitionSnapshot | undefined>;
  /** Every entry of the competition, in any state. */
  entries(id: string): MaybePromise<RegistrationEntry[]>;
  /** A fresh id for a new entry (tournaments: `<id>:entrant:<seed>`). */
  newEntryId(id: string, existing: readonly RegistrationEntry[]): string;
  /** Entries this adapter will not accept or promote right now (e.g. a tournament entry made with a retired team source). The
   *  core skips them when promoting from the waitlist, so one blocked entry never stops the next eligible one. */
  promotionBlocked?(competitionId: string, entry: RegistrationEntry): boolean;
  /** Persist the changes atomically. */
  commit(id: string, changes: readonly RegistrationChange[]): MaybePromise<void>;
  /** Record who got the check-in-open notice for the current window (CompetitionSnapshot.checkInNotice). */
  markCheckInNotice(id: string, notice: CheckInNoticeRecord): MaybePromise<void>;
  /** The SPA path a notification opens: the coach's entry, or the organisers' registrations list. */
  link(id: string, audience: "coach" | "organiser"): string;
}

/**
 * How an adapter maps its stored record type R to an entry and back (a guide for L4/L6; the core never calls it).
 * Tournaments: R = TournamentEntrantRecord (entryState? absent = accepted, waitlistAt?, waitlistSeq?, decided?, registrationLog?).
 * Leagues: R = LeagueRegistration (spec §5).
 */
export interface RegistrationRecordMapper<R> {
  toEntry(record: R): RegistrationEntry;
  /** The record carrying `entry`'s state (`record` is absent for a new entry). */
  fromEntry(entry: RegistrationEntry, record?: R): R;
}

/** The caller of a core action (from the session). */
export interface RegistrationActor {
  coach: string;
  admin?: boolean;
  /** A test sign-in session (Q13). */
  test?: boolean;
}

/** A refused action: `status` is the HTTP status, `code` a stable reason the SPA can switch on. */
export class RegistrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: RegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

export type RegistrationErrorCode =
  | "not-found" | "forbidden" | "test-session" | "closed" | "full" | "race-full" | "declined" | "removed"
  | "invalid-transition" | "organiser-only";

/** The result of an action: the entry after it, whether anything changed, and entries promoted as a consequence. */
export interface RegistrationResult {
  entry: RegistrationEntry;
  changed: boolean;
  promoted: RegistrationEntry[];
}
