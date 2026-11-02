// Shared by the SPA (/app) and the vanilla Lobby page (/lobby/). Same-origin JSON calls. Identity rides the Discord session cookie (cw_session); every write carries the
// X-CW-Auth CSRF header the server requires for cookie-authenticated writes.

export class ApiError extends Error {
  /** `data`: the parsed JSON error body when there was one (e.g. a 409's `revision`, a 422's `problems`). */
  constructor(readonly status: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { ...init.headers, accept: "application/json" };
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
    throw new ApiError(res.status, msg, data ?? undefined);
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
  /** Tournament page (lane 6): all optional. */
  seriesId?: string;
  bannerUrl?: string;
  location?: TournamentLocation;
  startTime?: string;
  entryFee?: string;
  summary?: string;
  notes?: string;
  news?: TournamentNewsPost[];
  deadlines?: TournamentDeadlines;
  /** NAF sanctioned (owner 10-31): the coach's profile NAF name and number go to the organisers, or "I am not a NAF member". */
  nafSanctioned?: boolean;
  /** Fixtures are played on Super FUMBBL: the fixture lobby gates the launch and has no inducement step. Absent = tabletop. */
  playOnFork?: boolean;
}

export interface TournamentLocation { venue?: string; address?: string; mapUrl?: string }
export interface TournamentDeadlines { registration?: string; checkIn?: string }
export interface TournamentNewsPost { id: string; title: string; body: string; by: string; at: string; pinned: boolean; editedAt?: string }

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
  /** Coach and managers only: the entry's NAF details (on a NAF-sanctioned tournament the coach's current profile NAF
   *  name and number; otherwise a number stored with the entry), whether the NAF coach page check matches, and the
   *  "not a NAF member" flag. */
  nafNumber?: string;
  nafName?: string;
  nafChecked?: boolean;
  notNafMember?: boolean;
  /** NAF sanctioned and the entry has no NAF answer: no profile NAF details, no stored number (coach and managers). */
  nafPending?: boolean;
  /** Managers only: what the coach shares with this tournament's organisers (the coach name plus granted fields). */
  shared?: TournamentSharedContact;
}

export interface TournamentSharedContact { coach: string; preferredName?: string; email?: string; phones?: Array<{ number: string; label?: string }> }

export interface TournamentRound { id: string; number: number; status: "pending" | "active" | "completed"; scheduledMatchIds: string[] }

export interface TournamentFixtureSide { entrantId: string; teamId: string; coach: { ffbCoachId: string } }

export interface TournamentFixture {
  id: string;
  roundNumber: number;
  status: string;
  home: TournamentFixtureSide;
  /** Absent = bye. */
  away?: TournamentFixtureSide;
  /** opId = the tabletop publication that recorded it (coaches and managers only). */
  result?: { homeScore: number; awayScore: number; homeCasualties?: number; awayCasualties?: number; opId?: string };
  revision?: number;
  /** An organiser changed the result (kind "result"): who and when for everyone who sees the fixture; reason and the
   *  previous / first-reported values for the coaches who play it and the managers. */
  edited?: TournamentFixtureEdit;
  /** The source record the result came from (a fork game id), kept linked after an edit. */
  launch?: { gameId?: string };
}

export type TournamentResultValues = { homeScore: number; awayScore: number; homeCasualties?: number; awayCasualties?: number };
export interface TournamentFixtureEdit {
  kind?: "result";
  byCoachId: string;
  at: string;
  reason?: string;
  cleared?: true;
  /** A result reported again after a clear. */
  reportedAgainAt?: string;
  previous?: TournamentResultValues | null;
  original?: TournamentResultValues | null;
}

/** One organiser result edit or clear in the tournament's activity log (stamped admin). */
export interface TournamentActivityEntry {
  id: string; at: string; by: string; kind: "result-edited" | "result-cleared"; admin: true;
  fixtureId: string; roundNumber: number;
  /** result, previous and reason come only to the tournament's managers and the fixture's two coaches. */
  result?: TournamentResultValues; previous?: TournamentResultValues | null; reason?: string;
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
  /** The Tournament Series it belongs to, when any. */
  series?: { id: string; name: string };
  entrants: TournamentEntrant[];
  rounds: TournamentRound[];
  standings?: TournamentStandingRow[];
  scheduledMatches?: TournamentFixture[];
  /** Organiser result edits the viewer may see (newest first). */
  activity?: TournamentActivityEntry[];
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
    /** The coach and the managers only; the opponent sees validity. */
    problems?: string[];
    /** The shared Team Builder read-view model (the same one the public team page renders). */
    view?: SharedTeamView;
  };
}

/** The fields of the server's shared team view model (src/teamShareView.ts) the SPA renders. */
export interface SharedTeamView {
  teamName: string;
  coach: string;
  raceName: string;
  ruleset: { name: string; tierLabel: string | null } | null;
  players: Array<{
    number: number;
    position: string;
    positionFull: string;
    isStar: boolean;
    stats: { MA: number; ST: number; AG: string; PA: string; AV: string };
    printed: Array<{ name: string; category: string }>;
    /** Team Captain: the nominated player's free grants ("Team Captain" + its free Pro). */
    captain?: boolean;
    free?: Array<{ name: string; category: string }>;
    added: Array<{ name: string; category: string; access?: "primary" | "secondary" }>;
    statIncreases: string[];
    cost: number | null;
  }>;
  sideline: { reRolls: number; apothecary: boolean; assistantCoaches: number; cheerleaders: number; dedicatedFans: number };
  inducements: Array<{ name: string; count: number }>;
  specialRules: string[];
  summary: { players: number; total: number | null; cap: number | null; primarySkills: number; secondarySkills: number };
  validity: { valid: boolean; issues: number; custom: boolean; findings: string[] };
}

/** GET /api/auth/test-login/options: the local-UAT test sign-in, when this server has it switched on. */
export interface TestLoginOptions { enabled: boolean; coaches?: Array<{ coach: string; level: string }> }
