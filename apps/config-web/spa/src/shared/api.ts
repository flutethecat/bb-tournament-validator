// Shared by the SPA (/app) and the vanilla Lobby page (/lobby/). Same-origin JSON calls. Identity rides the Discord session cookie (cw_session); every write carries the
// X-CW-Auth CSRF header the server requires for cookie-authenticated writes.

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    headers["x-cw-auth"] = "1";
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  if (!res.ok) {
    const msg = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface SessionInfo {
  authenticated: boolean;
  coach?: string;
  /** "discord" | "password": the lobby accepts Discord sessions only. */
  authMethod?: string;
  discordSsoEnabled?: boolean;
  organizer?: boolean;
  admin?: boolean;
  /** A test sign-in session (local UAT). */
  test?: boolean;
  expiresAt?: string;
}

/** The fields of GET /api/account the SPA reads (the server sends more; nothing else is rendered). */
export interface AccountInfo {
  ffbCoachId: string;
  profile?: { displayName?: string; avatar?: string };
  identities?: { discordUsername?: string; discordUserId?: string };
  discordAvatarUrl?: string | null;
  fumbblName?: string | null;
}

export interface LibraryTeam {
  teamId: string;
  teamName: string;
  race: string;
  teamValue: number;
  forkLoadable?: boolean;
}

export interface LobbyTeam { teamId: string; teamName: string; race: string; teamValue?: number }

export interface SeatView {
  coach: string;
  role: "creator" | "opponent";
  team: LobbyTeam | null;
  state: "here" | "left" | "client" | "not-here-yet";
  side: "home" | "away" | null;
}

export interface ChatMessage { id: number; coach: string; text: string; ts: number }

export interface LobbyView {
  id: string;
  me: "creator" | "opponent";
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  status: "waiting" | "ready" | "needs-renewal";
  opponentAccepted: boolean;
  settingUp?: boolean;
  uncertain?: boolean;
  duplicateGames?: string[];
  canCheckAgain?: boolean;
  canStartOver?: boolean;
  canAccept: boolean;
  canRenew: boolean;
  creator: SeatView;
  opponent: SeatView;
  game: { gameName: string; gameId: string | null } | null;
  bothPresent: boolean;
  canLaunch: boolean;
  chat?: ChatMessage[];
}

export interface PendingChallenge { coach: string; teamId: string; opponent: string; createdAt: number; lobbyId?: string }

export interface RosterPlayer {
  number: number; name: string; position: string | null; skills: string[]; injuries: string[]; spp: number;
  value: number; ma: number | null; st: number | null; ag: number | null; pa: number | null; av: number | null; mng: boolean;
}

export interface Roster {
  teamId: string; name: string; race: string; teamValue: number; treasury: number; rerolls: number;
  apothecary: boolean; fanFactor: number; assistantCoaches: number; cheerleaders: number; players: RosterPlayer[];
}

/** Tournament fields the SPA reads from GET /api/fork/tournaments and GET /api/tournaments/:id (the server sends more). */
export interface TournamentSummary {
  id: string;
  name: string;
  status: "draft" | "active" | "completed" | "cancelled";
  format: "swiss" | "roundRobin" | "knockout";
  packageName: string;
  rulesetPackName?: string;
  maxPlayers: number;
  roundCount: number;
  currentRound: number;
  tiebreakers?: string[];
  startsAt?: string;
  entrantCount?: number;
  /** v4 (phase 2/3): roles, dates, systems, lock and start stamps. */
  endsAt?: string;
  ownerCoachId?: string;
  organizerCoachIds?: string[];
  pairingSystem?: TournamentPairingSystem;
  seedingMode?: TournamentSeedingMode;
  rostersLockedAt?: string;
  startedAt?: string;
  remainingRounds?: number;
  myEntrantId?: string;
  myDroppedAt?: string;
}

export type TournamentPairingSystem = "dutch" | "monrad" | "eloSeeded";
export type TournamentSeedingMode = "elo" | "manual";

/** The five participant flags (coach and managers only). */
export interface TournamentEntrantFlags { paid: boolean; rosterVerified: boolean; frozen: boolean; checkedIn: boolean; active: boolean }

/** A submitted team as the page shows it; `problems` only reaches the coach and the managers. */
export interface TournamentSubmissionView {
  saveId?: string;
  submittedAt: string;
  teamName?: string;
  race?: string;
  valid: boolean;
  problemCount: number;
  checkedAt?: string;
  problems?: string[];
}

export interface TournamentListPage {
  tournaments: TournamentSummary[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface TournamentEntrant {
  id: string;
  entrantId?: string;
  seed: number;
  coachId?: string;
  teamId: string;
  teamName?: string;
  race?: string;
  logoUrl?: string;
  registeredAt?: string;
  droppedAt?: string;
  submission?: TournamentSubmissionView;
  flags?: TournamentEntrantFlags;
  rosterVerifiedOverride?: boolean;
  manualSeed?: number;
}

export interface TournamentRound { id: string; number: number; status: "pending" | "active" | "completed"; scheduledMatchIds: string[] }

export interface TournamentFixtureSide { entrantId: string; teamId: string; coach: { ffbCoachId: string } }

export interface TournamentFixture {
  id: string;
  roundNumber: number;
  status: string;
  home: TournamentFixtureSide;
  /** Absent = bye. */
  away?: TournamentFixtureSide;
  result?: { homeScore: number; awayScore: number; homeCasualties?: number; awayCasualties?: number };
  revision?: number;
}

export interface TournamentStandingRow {
  rank: number; entrantId: string; coachId: string; teamId: string;
  played: number; wins: number; draws: number; losses: number; byes: number; points: number;
  touchdownsFor: number; touchdownsAgainst: number; touchdownDifferential: number;
  casualtiesFor: number; casualtiesAgainst: number; casualtyDifferential: number;
  buchholz: number; sonnebornBerger: number; opponentWinPercentage: number; seed: number;
}

export interface TournamentDetailResponse {
  tournament: TournamentSummary;
  entrants: TournamentEntrant[];
  rounds: TournamentRound[];
  standings?: TournamentStandingRow[];
  scheduledMatches?: TournamentFixture[];
  /** What the viewer may do here (the server stays the authority). */
  capabilities?: { manage: boolean; assignRoles: boolean };
}

/** GET /api/fork/team-builder/saves rows the team picker reads. */
export interface BuilderSaveSummary { id: string; name: string; raceName?: string; packageName: string | null; teamId: string | null; updatedAt: string }

/** POST /api/tournaments/:id/rounds {preview: true}. */
export interface TournamentRoundPreview {
  roundNumber: number;
  pairings: Array<{ homeEntrantId: string; awayEntrantId?: string }>;
  seeds: Record<string, number>;
  pairingSystem: TournamentPairingSystem;
  seedingMode: TournamentSeedingMode;
}

/** GET /api/tournaments/:id/entrants/:eid/build: the read-only team (live library row and/or the submitted snapshot). */
export interface TournamentTeamBuild {
  tournamentId: string;
  entrantId: string;
  coachId?: string;
  team?: { teamName?: string; race?: string; teamValue?: number; rerolls?: number; apothecary?: boolean; fanFactor?: number };
  submission?: {
    submittedAt: string;
    teamName?: string;
    race?: string;
    valid: boolean;
    problems: string[];
    snapshot?: {
      teamName?: string;
      picks?: Array<{ positionId: string; count: number; chosenSkills?: string[] }>;
      reRolls?: number;
      apothecary?: boolean;
      cheerleaders?: number;
      assistantCoaches?: number;
      dedicatedFans?: number;
      rosteredInducements?: Array<{ key: string; count: number }>;
      inducements?: Array<{ key: string; count: number }>;
    } | null;
  };
}

/** GET /api/auth/test-login/options: the local-UAT test sign-in, when this server has it switched on. */
export interface TestLoginOptions { enabled: boolean; coaches?: Array<{ coach: string; level: string }> }
