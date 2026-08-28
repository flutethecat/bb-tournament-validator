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

export interface TournamentRecord {
  id: string;
  name: string;
  status: TournamentStatus;
  format: "swiss" | "roundRobin" | "knockout";
  packageName: string;
  /** Zero is accepted only for migrated legacy data and means uncapped. */
  maxPlayers: number;
  roundCount: number;
  currentRound: number;
  tiebreakers: TournamentTiebreaker[];
  points: TournamentPoints;
  startsAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A tournament seat always points at a coach identity verified by config-web auth. */
export interface VerifiedCoachIdentity {
  coachId: string;
  ffbCoachId: string;
  discordUserId?: string;
  verifiedAt: string;
}

export interface TournamentEntrantRecord {
  id: string;
  tournamentId: string;
  seed: number;
  coach: VerifiedCoachIdentity;
  teamId: string;
  registeredAt: string;
  droppedAt?: string;
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
