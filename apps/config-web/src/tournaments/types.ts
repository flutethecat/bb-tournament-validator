import type { PairingAvoid } from "../competition/format.js";
import type { HouseRules } from "../competition/houseRules.js";

export type TournamentStatus = "draft" | "active" | "completed" | "cancelled";
export type RoundStatus = "pending" | "active" | "completed";
export type ScheduledMatchStatus =
  | "scheduled"
  | "launching"
  | "launched"
  | "launch_failed"
  | "dismissed"
  | "completed"
  | "cancelled";

export type TournamentPrimaryTiebreaker = "buchholz" | "sonnebornBerger";

export type TournamentTiebreaker =
  | TournamentPrimaryTiebreaker
  | "opponentWinPercentage"
  | "headToHead"
  | "touchdownDifferential"
  | "touchdownsFor"
  | "casualtyDifferential"
  | "casualtiesFor"
  | "seed";

export interface TournamentPoints {
  win: number;
  draw: number;
  loss: number;
  bye: number;
}

/** Tabletop turn-timer policy of a competition: off (forbidden), optional (both coaches must agree), required (always on). */
/** Swiss pairing systems: Dutch (score groups, top half v bottom half), Monrad (1-2, 3-4), eloSeeded (the original min-cost matcher). */
export type TournamentPairingSystem = "dutch" | "monrad" | "eloSeeded";
export const TOURNAMENT_PAIRING_SYSTEMS: readonly TournamentPairingSystem[] = ["dutch", "monrad", "eloSeeded"];
export type TournamentSeedingMode = "elo" | "manual";
export const TOURNAMENT_SEEDING_MODES: readonly TournamentSeedingMode[] = ["elo", "manual"];

export interface TournamentTurnTimer { enforced: "off" | "optional" | "required"; seconds: number }
export const DEFAULT_TOURNAMENT_TURN_TIMER: TournamentTurnTimer = { enforced: "optional", seconds: 240 };

export interface TournamentRecord {
  id: string;
  name: string;
  status: TournamentStatus;
  /** A test competition (registration spec Q13): the only kind a test sign-in may write in (src/registration/testSession.ts). */
  test?: true;
  /** Registration spec §6 / Q3 (lane L3): set when a manager published the tournament. Informational; visibility follows
   *  `unpublished` (src/tournaments/publication.ts). */
  publishedAt?: string;
  /** Set on a draft created unpublished by the wizard (or unpublished by a manager): only its managers and admins see it,
   *  and nobody can register. Absent = published, so every record written before publishing existed (Q3: "existing
   *  drafts count as published") and every record the old create route wrote stays public. */
  unpublished?: true;
  /** Registration settings (registration spec §2). Absent on legacy records (today's behaviour). */
  registration?: TournamentRegistrationSettings;
  format: "swiss" | "roundRobin" | "knockout";
  packageName: string;
  /** Zero is accepted only for migrated legacy data and means uncapped. */
  maxPlayers: number;
  roundCount: number;
  /** True only when an organizer selected the Swiss round count instead of using the derived default. */
  roundCountExplicit?: boolean;
  currentRound: number;
  tiebreakers: TournamentTiebreaker[];
  points: TournamentPoints;
  startsAt?: string;
  /** Absent = the default (optional, 240 s). Organiser-editable through the tournament settings route. */
  turnTimer?: TournamentTurnTimer;
  /** Commissioner-enabled opt-in inducements (wireNames, e.g. "canopicJar"). Absent = [] (none). Organiser-editable through the tournament settings route. */
  inducementOptIns?: string[];
  /** Absent only on legacy records, which remain admin-only until ownership is assigned. Kept equal to ownerCoachId (older readers). */
  organizerCoachId?: string;
  /** v4: the tournament owner (defaults to the creator; migrated from organizerCoachId). Admin or owner may reassign it. */
  ownerCoachId?: string;
  /** v4: per-tournament organisers added by the owner or an admin; each is a manager of this tournament. */
  organizerCoachIds?: string[];
  /** v4: ISO end date (organiser-set; informational). */
  endsAt?: string;
  /** v4: Swiss pairing system. Absent on migrated records = "eloSeeded" (the original min-cost matcher, unchanged behaviour). */
  pairingSystem?: TournamentPairingSystem;
  /** v4: how round 1 is seeded. Absent = "elo". */
  seedingMode?: TournamentSeedingMode;
  /** v4: set while rosters are frozen (snapshot + validation taken); submissions are refused until unlocked. */
  rostersLockedAt?: string;
  /** v4: set when the tournament moved draft -> active through POST /start. */
  startedAt?: string;
  /** Tournament Series (phase 5): the series this tournament belongs to (at most one). Kept equal to the series'
   *  `tournaments` list by the store (attach / detach / delete write both in one mutation). */
  seriesId?: string;
  /** Tournament page (lane 6, additive, no version bump): `tournament-banners/<sha256>.<png|jpg|webp>` relative to the
   *  tournaments data dir. Never sent to clients; the read model carries `bannerUrl` instead. */
  bannerPath?: string;
  location?: TournamentLocation;
  /** Local start time at the venue, "HH:MM" (24 h). */
  startTime?: string;
  /** Free text, e.g. "15 GBP" or "Free". */
  entryFee?: string;
  /** Payment links (src/payments/links.ts): the organiser's PayPal.Me link in its https form, and their Venmo username
   *  without the @. Coaches pay outside the site; organisers mark entries paid. */
  payPal?: string;
  venmo?: string;
  /** Organiser-written markdown-lite (paragraphs, **bold**, *italic*, http(s) links, lists). */
  summary?: string;
  /** "What to bring" notes, markdown-lite. */
  notes?: string;
  /** Organiser news posts (stored in posting order; the read model sorts pinned first, newest first). */
  news?: TournamentNewsPost[];
  /** ISO timestamps. The coach home Deadlines panel reads exactly these names. */
  deadlines?: TournamentDeadlines;
  /** NAF sanctioned (owner 10-31): coach registration needs the NAF name and number on the coach's profile (shared with
   *  the organisers), or the "I am not a NAF member" box. Absent = false. */
  nafSanctioned?: boolean;
  /** Fixtures are played on Super FUMBBL (online): the fixture lobby gates the launch and has no inducement step.
   *  Absent = tabletop (the lobby's START creates the recorder match). Organiser-editable through the settings route. */
  playOnFork?: boolean;
  /** Custom awards organisers and admins gave (src/tournaments/honours.ts). The podium is derived, never stored here. */
  awards?: TournamentAward[];
  /** Bumped by every award write; writes send it back (body `revision` or If-Match): 428 missing, 409 stale. */
  awardsRevision?: number;
  /** Organiser result edits and clears, newest first, capped (TOURNAMENT_ACTIVITY_CAP). Stamped admin. */
  activity?: TournamentActivityEntry[];
  /** House rules (creation wizards v2): stored here, never on the shared package. Absent = every setting "as the ruleset
   *  says" (src/competition/houseRules.ts houseRulesOf derives it on read). */
  houseRules?: HouseRules;
  /** Swiss pairing avoidance (same club / same region). Absent = none. */
  pairingAvoid?: PairingAvoid;
  /** The organiser's regions; coaches pick one when they join (a later lane). Absent = none. */
  regions?: string[];
  /** Site-authorised event (owner round 3: every event run on the site is authorised for now). Absent = true (records
   *  written before the flag existed); the read model always carries the derived boolean. */
  authorised?: boolean;
  /** Registration (lane L4): who was sent the check-in-open notice for which check-in window (src/registration). */
  checkInNotice?: { window: string; entryIds: string[]; at: string };
  /** Registration (lane L4): who was sent the "roster due" reminder for which roster deadline (once per entry per deadline). */
  rosterDueNotice?: { rosterBy: string; entryIds: string[]; at: string };
  createdAt: string;
  updatedAt: string;
}

/** A custom tournament award (same model as a league award, spec-main-landing-nav §2 item 4, with `tournamentId`). */
export interface TournamentAward {
  id: string;
  tournamentId: string;
  title: string;
  /** A key of the shared award icon table (src/leagues/awards.ts AWARD_ICONS). */
  icon: string;
  /** The recipient's account (ffbCoachId): every tournament seat has one. */
  toCoach: string;
  /** Team awards: the entrant and its team as shown when given. */
  entrantId?: string;
  teamId?: string;
  toTeam?: string;
  race?: string;
  note: string;
  /** The giving organiser's (or admin's) account. */
  by: string;
  at: string;
}

/** A tournament's registration window settings (registration spec §2). One source per value: the cap is `maxPlayers`, the
 *  close is `deadlines.registration` and the check-in close is `deadlines.checkIn` (the Manage → Page form keeps editing
 *  those), so only the rest is stored here. */
export interface TournamentRegistrationSettings {
  /** Absent = open from publication. */
  opensAt?: string;
  /** Q5: tournaments auto-accept by default. */
  approval: "auto" | "organiser";
  /** Q6: on by default. */
  waitlist: boolean;
  /** Q4: "register now, roster later", on by default. */
  rosterLater: boolean;
  /** The roster deadline under "roster later". */
  rosterBy?: string;
  /** Q11: self check-in on by default; absent opensAt = 24 h before the start. */
  checkIn: { self: boolean; opensAt?: string };
}

export interface TournamentLocation { venue?: string; address?: string; mapUrl?: string }
export interface TournamentDeadlines { registration?: string; checkIn?: string }
export interface TournamentNewsPost {
  id: string;
  title: string;
  body: string;
  /** The posting manager's coach id. */
  by: string;
  /** ISO posting time. */
  at: string;
  pinned: boolean;
  editedAt?: string;
}

/** A tournament seat always points at a coach identity verified by config-web auth. */
export interface VerifiedCoachIdentity {
  coachId: string;
  ffbCoachId: string;
  discordUserId?: string;
  verifiedAt: string;
}

/** Participant status: five organiser flags. rosterVerified follows the validator unless an organiser overrode it. */
export interface TournamentEntrantFlags {
  paid: boolean;
  rosterVerified: boolean;
  frozen: boolean;
  checkedIn: boolean;
  active: boolean;
}
export const DEFAULT_ENTRANT_FLAGS: TournamentEntrantFlags = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };

export interface TournamentSubmissionValidation {
  ok: boolean;
  problems: string[];
  checkedAt: string;
  packageName: string;
  packageRevision?: string;
  /** The enforced house rules the check ran under (src/competition/houseRules.ts houseRulesStamp); absent = none. */
  houseRulesKey?: string;
}

/** A coach's submitted team: the Team Builder save (or library team) frozen as it was when submitted or locked. */
export interface TournamentSubmission {
  /** `save:<id>` (Team Builder save) or `library:<teamId>`. */
  saveId: string;
  /** The save's updatedAt (or the library team id) at submission time. */
  revision: string;
  submittedAt: string;
  teamId?: string;
  teamName?: string;
  race?: string;
  /** The save body (or library summary) as validated. Shown only to the coach, managers and the scheduled opponent. */
  snapshot: unknown;
  validation: TournamentSubmissionValidation;
}

export interface TournamentEntrantRecord {
  id: string;
  tournamentId: string;
  seed: number;
  coach: VerifiedCoachIdentity;
  teamId: string;
  registeredAt: string;
  droppedAt?: string;
  /** v4 (absent on migrated rows = DEFAULT_ENTRANT_FLAGS). */
  flags?: TournamentEntrantFlags;
  /** v4: organiser override of flags.rosterVerified; when set it wins over the validator. */
  rosterVerifiedOverride?: boolean;
  /** v4: organiser seed for seedingMode "manual" (1 = top seed). */
  manualSeed?: number;
  /** Who last changed flags.paid, and when (the coach and managers only; anonymised on account deletion). */
  paidUpdated?: { by: string; at: string };
  submission?: TournamentSubmission;
  /** A NAF number stored with the entry (coach and managers only): typed by the coach before the profile became the
   *  source (owner 10-31), or given by an organiser adding the coach. On a NAF-sanctioned tournament the coach's profile
   *  NAF details win when present; new self-entries store none (derived from the profile on read). */
  nafNumber?: string;
  /** Set when the coach ticked "I am not a NAF member" registering for a NAF-sanctioned tournament (managers only). */
  notNafMember?: true;
  /** The coach was asked for their NAF answer (organiser-made entry, or the tournament became sanctioned after the
   *  entry): the one-notice guard. Whether the entry owes the answer is derived on read (nafOwed: no profile NAF number,
   *  no stored number, not "not a NAF member"); the roster submission is refused while it does. */
  nafPending?: true;
  /** The entry's NAF details frozen when the coach withdrew from (or was dropped from) a NAF-sanctioned tournament:
   *  the profile's name and number then, else the number stored with the entry. Used only by the NAF report, so the
   *  games the coach played are reported; never shown elsewhere (a withdrawn entry shows no live profile NAF). */
  nafSnapshot?: { nafName?: string; nafNumber: string; at: string };
  /** The region the coach picked from the tournament's list when joining (a later lane sets it). Absent/null = none. */
  region?: string | null;
  /** The club the coach represents in this tournament (clubs lane). Absent/null = none. */
  clubId?: string | null;
  // ---- Registration (lane L4, src/tournaments/registration.ts over the src/registration core) ----------------------
  /** The entry's state. Absent = accepted (legacy rows), or withdrawn when droppedAt is set. Only accepted (and entries
   *  that left after acceptance: withdrawn / dropped with droppedAt) live in `entrants`; pending, waitlisted, declined and
   *  entries withdrawn before acceptance live in the data file's `heldEntrants`, so no reader of `entrants` ever sees them. */
  entryState?: "pending" | "accepted" | "waitlisted" | "declined" | "withdrawn" | "dropped";
  /** The first submission when the coach re-entered (registeredAt is then the current submission). */
  firstRegisteredAt?: string;
  waitlistAt?: string;
  waitlistSeq?: number;
  /** The last organiser decision (coach and managers only). */
  decided?: { by: string; at: string; reason?: string };
  /** The audited transitions, oldest first (managers only). */
  registrationLog?: Array<{ action: string; from: string | null; to: string; by: string; at: string; reason?: string }>;
  /** The entry's payment reference (e.g. SF-7Q2K) for PayPal / Venmo notes. Coach and managers only. Absent on rows
   *  written before it existed (derived on read: src/tournaments/registration.ts referenceCodes). */
  refCode?: string;
  /** The coach pressed "I've paid" (coach and managers only); organisers still tick Paid themselves. */
  coachSaysPaid?: { at: string };
  /** A held entry's coach was told (or asked) about NAF on a sanctioned tournament: the panel may show the profile NAF. */
  nafToldAt?: string;
  /** When organisers were last told about "I've paid" (one notice per 24 h however often it is toggled). */
  paidClaimNotifiedAt?: string;
  /** When the entry was checked in, and by whom (the coach, or an organiser). */
  checkedInBy?: { by: string; at: string };
}

export interface TournamentRoundRecord {
  id: string;
  tournamentId: string;
  number: number;
  status: RoundStatus;
  scheduledMatchIds: string[];
  createdAt: string;
  completedAt?: string;
  /** Pairing avoidance: pairs drawn although they share a club or region (no clash-free draw existed). Shown to the
   *  organisers on the round. Absent = none. */
  clashes?: Array<{ homeEntrantId: string; awayEntrantId: string; kinds: Array<"club" | "region"> }>;
}

export interface ScheduledMatchResult {
  homeScore: number;
  awayScore: number;
  homeCasualties?: number;
  awayCasualties?: number;
  reportedAt: string;
  /** Tabletop publications stamp the commit op id here so a replay can recognise its own write. */
  opId?: string;
  /** Typed in by an organiser or admin (PATCH /api/scheduled-matches/:id/result), not recorded: never announced on Discord. */
  manual?: true;
}

/** The result values an organiser edit replaces (kept for audit). */
export type ScheduledMatchResultValues = Pick<ScheduledMatchResult, "homeScore" | "awayScore" | "homeCasualties" | "awayCasualties">;

/** An organiser's change to a fixture. A result edit keeps the source record (fork game id / tabletop match) linked: the
 *  fixture's launch.gameId and result.opId stay, and the published result row is never rewritten. */
export interface ScheduledMatchEdit {
  /** The editing manager's account (anonymised on deletion). */
  byCoachId: string;
  at: string;
  reason?: string;
  /** Absent = a pairing change (legacy shape). */
  kind?: "result";
  /** Result edits: the result before this edit (null = the fixture had none). */
  previous?: ScheduledMatchResultValues | null;
  /** Result edits: the result as first reported (fork / tabletop / manual entry), kept across later edits. */
  original?: ScheduledMatchResultValues | null;
  /** Result edits: true when the edit cleared the result (the fixture is unplayed again). */
  cleared?: true;
  /** A cleared tabletop result's publication op id: the recorder may revert that publication without touching the
   *  fixture (it is already unplayed), then confirm and republish it. */
  clearedOpId?: string;
  /** When a result was reported again after a clear (the stamp then records the clear, no longer the cleared state). */
  reportedAgainAt?: string;
}

/** One entry of a tournament's activity log (organiser result edits; newest first, capped). Stamped `admin`. */
export interface TournamentActivityEntry {
  id: string;
  at: string;
  /** The acting manager's account. */
  by: string;
  kind: "result-edited" | "result-cleared";
  admin: true;
  fixtureId: string;
  roundNumber: number;
  /** The result after the change (absent when cleared). */
  result?: ScheduledMatchResultValues;
  previous: ScheduledMatchResultValues | null;
  reason?: string;
}

export interface ChallengerLaunchMetadata {
  challengePath: "/api/fork/challenge";
  jnlpPath: "/api/fork/jnlp";
  gameName?: string;
  gameId?: string;
  lastAttemptAt?: string;
  launchedAt?: string;
  retryCount: number;
  lastError?: string;
}

export interface ScheduledMatchSide {
  entrantId: string;
  coach: VerifiedCoachIdentity;
  teamId: string;
}

export interface ScheduledMatchRecord {
  id: string;
  tournamentId: string;
  roundId: string;
  roundNumber: number;
  home: ScheduledMatchSide;
  /** Undefined is a Swiss bye. */
  away?: ScheduledMatchSide;
  status: ScheduledMatchStatus;
  revision: number;
  launch: ChallengerLaunchMetadata;
  result?: ScheduledMatchResult;
  /** The time both coaches agreed through a game-time proposal (src/schedule): a 2-hour slot, UTC ISO. */
  scheduledTime?: { start: string; end: string; agreedAt: string };
  /** v4: set when an organiser changed this fixture: its pairing (fixtures editor, phase 4) or, with `kind: "result"`,
   *  its confirmed result (organiser result edit, owner ruling 10-29 §7). The latest change only; the full history is
   *  the tournament's `activity` log. */
  edited?: ScheduledMatchEdit;
  createdAt: string;
  updatedAt: string;
}

export interface WaitingPresenceLease {
  scheduledMatchId: string;
  coachId: string;
  renewedAt: string;
  expiresAt: string;
}

export interface TournamentStandingRow {
  rank: number;
  entrantId: string;
  coachId: string;
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  points: number;
  touchdownsFor: number;
  touchdownsAgainst: number;
  touchdownDifferential: number;
  casualtiesFor: number;
  casualtiesAgainst: number;
  casualtyDifferential: number;
  buchholz: number;
  sonnebornBerger: number;
  opponentWinPercentage: number;
  seed: number;
}

export interface TournamentStandingsRecord {
  tournamentId: string;
  matchRevision: string;
  rows: TournamentStandingRow[];
  calculatedAt: string;
}

export interface TournamentDataFileV2 {
  version: 2;
  tournaments: Record<string, TournamentRecord>;
  entrants: Record<string, TournamentEntrantRecord>;
  rounds: Record<string, TournamentRoundRecord>;
  standings: Record<string, TournamentStandingsRecord>;
  scheduledMatches: Record<string, ScheduledMatchRecord>;
  waitingPresence: Record<string, WaitingPresenceLease>;
}

export interface TournamentDataFileV3 extends Omit<TournamentDataFileV2, "version"> {
  version: 3;
}

export interface TournamentDataFileV4 extends Omit<TournamentDataFileV2, "version"> {
  version: 4;
  /** Tournament Series (phase 5, additive, no version bump): absent on files written before series existed. */
  series?: Record<string, TournamentSeriesRecord>;
  /** Registration (lane L4, additive): entries not in the field - pending, waitlisted, declined, or withdrawn before they
   *  were accepted. Same record shape as `entrants`; an entry moves into `entrants` when it is accepted. Never read by
   *  the field's readers (pairing, standings, public lists, notifications, sharing). */
  heldEntrants?: Record<string, TournamentEntrantRecord>;
}

/** How a series totals each coach's event points: every event, or each coach's N best events. */
export type SeriesScoring = "sum" | "bestN";
export const SERIES_SCORING: readonly SeriesScoring[] = ["sum", "bestN"];
/** The series' default pairing for new sub-tournaments (owner 10-28: Elo seeding is an option inside a series). */
export type SeriesSeeding = "dutch" | "monrad" | "elo";
export const SERIES_SEEDINGS: readonly SeriesSeeding[] = ["dutch", "monrad", "elo"];
/** Series seeding -> the tournament pairing system it defaults new sub-tournaments to ("elo" = the Elo-seeded matcher). */
export const SERIES_SEEDING_PAIRING: Readonly<Record<SeriesSeeding, TournamentPairingSystem>> = { dutch: "dutch", monrad: "monrad", elo: "eloSeeded" };

/** Tournament Series (owner 10-28: "sub-tournaments that all contribute to the standings"). No entrants or rounds of its
 *  own: coaches appear in the series standings by playing its sub-tournaments. Stored in tournaments.json `series`. */
export interface TournamentSeriesRecord {
  id: string;
  name: string;
  /** Organiser-written plain text. */
  description: string;
  /** Coach ids that manage the series (the creator first). Admins manage every series. */
  organisers: string[];
  scoring: SeriesScoring;
  /** scoring "bestN" only: how many of each coach's best events count. */
  bestN?: number;
  seeding: SeriesSeeding;
  /** Sub-tournament ids in the order they were added. */
  tournaments: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped by every write; writes send the revision they loaded (body `revision` or If-Match): 428 missing, 409 stale. */
  revision: number;
}
