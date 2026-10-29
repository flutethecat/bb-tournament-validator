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
  /** v4: reserved for Tournament Series (phase 5). */
  seriesId?: string;
  /** Tournament page (lane 6, additive, no version bump): `tournament-banners/<sha256>.<png|jpg|webp>` relative to the
   *  tournaments data dir. Never sent to clients; the read model carries `bannerUrl` instead. */
  bannerPath?: string;
  location?: TournamentLocation;
  /** Local start time at the venue, "HH:MM" (24 h). */
  startTime?: string;
  /** Free text, e.g. "15 GBP" or "Free". */
  entryFee?: string;
  /** Organiser-written markdown-lite (paragraphs, **bold**, *italic*, http(s) links, lists). */
  summary?: string;
  /** "What to bring" notes, markdown-lite. */
  notes?: string;
  /** Organiser news posts (stored in posting order; the read model sorts pinned first, newest first). */
  news?: TournamentNewsPost[];
  /** ISO timestamps. The coach home Deadlines panel reads exactly these names. */
  deadlines?: TournamentDeadlines;
  createdAt: string;
  updatedAt: string;
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
  submission?: TournamentSubmission;
}

export interface TournamentRoundRecord {
  id: string;
  tournamentId: string;
  number: number;
  status: RoundStatus;
  scheduledMatchIds: string[];
  createdAt: string;
  completedAt?: string;
}

export interface ScheduledMatchResult {
  homeScore: number;
  awayScore: number;
  homeCasualties?: number;
  awayCasualties?: number;
  reportedAt: string;
  /** Tabletop publications stamp the commit op id here so a replay can recognise its own write. */
  opId?: string;
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
  /** v4: set when an organiser changed the pairing of this fixture (fixtures editor, phase 4). */
  edited?: { byCoachId: string; at: string; reason?: string };
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
}
