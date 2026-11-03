// League API shapes the SPA reads (server: src/leagues/types.ts + src/leagues/api.ts + src/leagues/stats.ts).

import type { HouseRules } from "../../../src/competition/houseRules";

export type LeagueRuleset = "BB2020" | "BB2025";

export interface SeasonSummary {
  id: string;
  number: number;
  name: string;
  ruleset: LeagueRuleset;
  status: "active" | "completed";
  startedAt?: string;
  endedAt?: string;
  teamCount: number;
  fixtureCount: number;
  playedCount: number;
  champion?: { coach: string; team: string; race: string };
  /** Finished on this site (Finish season wrote a podium record): the organiser may reopen it. */
  finishedHere?: boolean;
  /** Lane L5: setup | registration | active | completed (absent from older servers = derived from status). */
  stage?: "setup" | "registration" | "active" | "completed";
}

export interface LeagueSummary {
  id: string;
  name: string;
  fullName: string;
  slug: string;
  description: string;
  organisers: string[];
  /** Play on Super FUMBBL is on (absent on older servers = off). */
  playOnFork?: boolean;
  createdAt: string;
  logoUrl?: string;
  bannerUrl?: string;
  seasonCount: number;
  currentSeason?: SeasonSummary;
  /** Lane L5: "draft" = only its organisers and admins see it. */
  visibility?: "draft";
  /** Creation wizards v2 (absent on older servers): house rules, the ruleset card's package, the authorised flag. */
  houseRules?: HouseRules;
  rulesetPackage?: string;
  authorised?: boolean;
  /** Browse leagues (list rows only; absent on older servers): status, place and the public search index. */
  browse?: LeagueBrowseInfo;
}

export type LeagueBrowseStatus = "in-progress" | "registration" | "finished" | "off-season";

/** GET /api/leagues row extras (server src/leagues/browse.ts). Public fields only. */
export interface LeagueBrowseInfo {
  status: LeagueBrowseStatus;
  registrationOpen: boolean;
  location?: string;
  regions: string[];
  test?: true;
  seasons: string[];
  teams: Array<{ name: string; coach: string }>;
}

export interface FixtureSide {
  team: string;
  /** LeagueTeam.id (team name + canonical coach, race as the tiebreaker). */
  teamId?: string;
  coach: string;
  coachId?: string;
  race: string;
  nafUser?: string;
  score: number | null;
  cas: number | null;
  conceded: boolean;
}

export interface LeagueFixture {
  id: string;
  category: string;
  phase: string;
  phaseId: string;
  group: string;
  round: number;
  table: number;
  home: FixtureSide;
  away: FixtureSide;
  suspended: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** An admin allowed this fixture on Super FUMBBL. */
  forkEnabled?: boolean;
  /** Scheduled date (YYYY-MM-DD) from the organiser fixtures editor. */
  date?: string;
  /** Test data (Discord posts carry "[Test]"). */
  test?: boolean;
  /** Admin per-game settings: a late launch is allowed / Super FUMBBL play is cancelled. */
  forkAllowLate?: boolean;
  forkCancelled?: boolean;
  /** Season reads carry the Super FUMBBL status only. */
  fork?: { status: FixtureForkStatus };
  /** The time both coaches agreed through a game-time proposal (Schedule): a 2-hour slot, UTC ISO. */
  scheduledTime?: { start: string; end: string; agreedAt: string };
  /** Organiser's per-fixture deadline (UTC ISO); unset = the round deadline. */
  deadline?: string;
  /** What happened at the deadline: the auto-forfeit outcome (auto) or an organiser's decision. */
  deadlineOutcome?: { outcome: DeadlineOutcome; auto?: true; by?: string; at: string; deadline?: string };
}

/** review = overdue, needs an organiser's decision; no-result = counts nowhere; both-lose = a loss for each side. */
export type DeadlineOutcome = "review" | "no-result" | "both-lose";
export interface RoundDeadline { phaseId: string; round: number; deadline: string }
export interface DeadlinePolicy { autoForfeit: boolean; outcome: DeadlineOutcome; updatedBy?: string; updatedAt?: string }

// ---- Play on Super FUMBBL: fixture summary (server: src/leagues/forkPlay.ts) ----

export type ForkSide = "home" | "away";
export type FixtureForkStatus = "teams_built" | "scheduled" | "in_progress" | "finished" | "launch_failed" | "cancelled";

export interface ForkPlayerLine {
  playerId?: string;
  forkPlayerId: string;
  name: string;
  td: number;
  cas: number;
  completions: number;
  interceptions: number;
  mvp: number;
  fouls: number;
  spp?: number;
  injuries: string[];
}

export interface CasualtiesSuffered { badlyHurt: number; seriousInjury: number; rip: number }

/** One side of a Super FUMBBL result; the optional fields are the server's own figures, omitted when it sent none. */
export interface ForkSideResult {
  score: number; cas: number; conceded: boolean; winnings: number; lines: ForkPlayerLine[];
  /** Conceding side of a full result: the server judged the concession legal (true) or not (false). */
  concededLegally?: boolean;
  casualtiesSuffered?: CasualtiesSuffered;
  spectators?: number; fame?: number; fanFactor?: number; dedicatedFansModifier?: number;
}

export interface FixtureForkResult {
  gameId: string;
  source: "full" | "basic";
  appliedAt: string;
  penalty?: { home: number; away: number };
  /** Basic result: treasuries left alone for an organiser to settle. */
  financialPending?: boolean;
  home: ForkSideResult;
  away: ForkSideResult;
}

export interface FixtureForkView {
  enabled: boolean;
  status: FixtureForkStatus | "none";
  statusLabel: string;
  allowLate: boolean;
  cancelled: boolean;
  teams: Partial<Record<ForkSide, { builtAt: string }>>;
  gameId?: string;
  scheduledAt?: string;
  error?: string;
  mySide?: ForkSide;
  launched?: Partial<Record<ForkSide, string>>;
  canGenerate: boolean;
  blocker?: string;
  canStart: boolean;
  canReset: boolean;
  canConfigure: boolean;
  result?: FixtureForkResult;
  log?: Array<{ at: string; by: string; text: string }>;
}

export interface FixtureSummary {
  league: { id: string; name: string; playOnFork: boolean };
  season: { id: string; name: string; status: "active" | "completed"; ruleset: LeagueRuleset };
  fixture: LeagueFixture;
  fork: FixtureForkView;
  forkAvailable: boolean;
}

/** League news (Overview): pinned first, then newest first; bodies in markdown-lite. */
export interface LeagueNewsPost { id: string; title: string; body: string; by: string; at: string; pinned: boolean; editedAt?: string }

export interface StandingRow {
  group: string;
  rank: number;
  team: string;
  teamId?: string;
  race: string;
  coach: string;
  coachId?: string;
  points: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
  completions?: number;
  interceptions?: number;
  injuriesFor?: number;
  injuriesAgainst?: number;
  deathsFor?: number;
  deathsAgainst?: number;
  foulsFor?: number;
  foulsAgainst?: number;
  /** The team's last results in this table, oldest first (server-derived). */
  latest?: Array<"W" | "D" | "L">;
  [key: string]: unknown;
}

export type StandingsStat = "completions" | "interceptions" | "injuries" | "deaths" | "fouls";

export interface LeaguePhase {
  id: string;
  category: string;
  name: string;
  groups: string[];
  standings: StandingRow[];
  includes?: string[];
  /** The table is the TourPlay export's ("imported") or computed from the results ("computed"). */
  standingsSource?: "computed" | "imported";
  standingsStats?: StandingsStat[];
  /** The table's divisions in order, including ones with no team scheduled yet. */
  standingsGroups?: string[];
  format?: "table" | "knockout";
}

export interface PlayerSeasonStats {
  td: number;
  cas: number;
  mvp: number;
  int: number;
  completions: number;
  fouls: number;
  /** Injuries SUFFERED by the player (see src/leagues/types.ts); `cas` is casualties caused. */
  injuries: number;
  sentOffs: number;
  spp: number;
  performance: number;
  /** Super FUMBBL result counters (absent = 0); rushing / passing are signed yardage. */
  blocks?: number;
  rushing?: number;
  passing?: number;
  deflections?: number;
  landings?: number;
  turnsPlayed?: number;
}

/** Every imported player carries a stable id; careerKey / previousIds link the same player across seasons. */
export interface PlayerIdentity { playerId: string; careerKey?: string; previousIds?: string[] }

export interface LeaguePlayer extends PlayerIdentity {
  number: number | null;
  name: string;
  position: string;
  ma: number | null;
  st: number | null;
  ag: number | null;
  pa: number | null;
  av: number | null;
  skills: string[];
  value: number | null;
  level: string;
  availableSpp: number;
  niggling: number;
  missNextGame: boolean;
  stats: PlayerSeasonStats;
  /** Seasons the player took part in before this one (server LeaguePlayer.seasonsPlayed; organisers edit it). */
  seasonsPlayed?: number;
  /** Injuries recorded on the team page (server teamOps.ts INJURIES keys); `by` only in the coach / organiser view. */
  injuries?: Array<{ type: string; at: string; by?: string }>;
}

export interface FormerPlayer extends PlayerIdentity {
  name: string;
  position: string;
  level: string;
  stats: PlayerSeasonStats;
  /** The skills the player had when they left (a departed Team Captain keeps the trait and its Pro). */
  skills?: string[];
}

export interface LeagueTeam {
  id: string;
  name: string;
  race: string;
  coach: string;
  coachId?: string;
  /** An organiser assigned the coach account (Teams tab, Assign coach account). */
  coachAssigned?: { by: string; at: string; cleared?: true };
  /** Recomputed by the league from stored player values + staff (server teamValue.ts). */
  teamValue: number | null;
  /** teamValue without the players who miss the next game; unset until the server recomputed it. */
  currentTeamValue?: number | null;
  treasury: number | null;
  rerolls: number | null;
  fans: number | null;
  assistantCoaches: number | null;
  cheerleaders: number | null;
  apothecary: boolean;
  tier: string;
  raceLeague: string;
  players: LeaguePlayer[];
  formerPlayers: FormerPlayer[];
  /** The Team Captain left the roster and no new one is appointed yet (server leagues/captain.ts). */
  captainVacant?: true;
  /** Read model, only while vacant: the roster players who may be appointed (server captainApi.ts withCaptainCandidates). */
  captainEligible?: string[];
  /** Team page v2: absent = active. An inactive team has no standings row and is listed under "Inactive". */
  status?: "inactive";
  statusChanged?: { by: string; at: string };
  /** Team library lane identity (server teamOps.ts): the team, and this season's entry. */
  teamUid?: string;
  entryId?: string;
}

export type HonourValue = number | string | Record<string, number | string>;

export interface HonourTable {
  key: string;
  category: string;
  stat: string;
  kind: "player" | "team" | "coach";
  rows: Array<{ rank: number; name: string; team: string; coach: string; position?: string; level?: string; playerId?: string; value: HonourValue }>;
}

export interface LeagueAward {
  category: string;
  type: string;
  name: string;
  description: string;
  coach: string;
  team: string;
  race: string;
  goldenStar: boolean;
  podium?: true;
}

export type PodiumSlot = "champion" | "runnerUp" | "consolation";
export interface PodiumPlace { ref: string; teamId?: string; team: string; coach: string; race: string }
/** GET /api/leagues/:id/seasons/:sid/podium: what Finish season proposes (server standings.ts). */
export interface PodiumProposal {
  champion?: PodiumPlace;
  runnerUp?: PodiumPlace;
  consolation?: PodiumPlace;
  decidedBy: "playoff" | "standings" | "imported" | "pending" | "none";
  note: string;
  candidates: PodiumPlace[];
  /** One-line hint: the last phase looks like a bracket but is not marked as a knockout. */
  hint?: string;
}

export interface UnattributedStats { team: string; teamId?: string; name: string; position: string; stats: PlayerSeasonStats; reason: string; /** playerIds the total could belong to (absent on files imported before ids existed). */ candidates?: string[] }

export interface SeasonRecord {
  id: string;
  leagueId: string;
  number: number;
  name: string;
  sourceSlug: string;
  ruleset: LeagueRuleset;
  status: "active" | "completed";
  startedAt?: string;
  endedAt?: string;
  phases: LeaguePhase[];
  fixtures: LeagueFixture[];
  participants: Array<{ coach: string; team: string; race: string; country: string }>;
  teams: LeagueTeam[];
  honours: HonourTable[];
  awards: LeagueAward[];
  /** Honour totals the export could not pin to one player (absent on files imported before it existed). */
  unattributedStats?: UnattributedStats[];
  importedAt: string;
  /** Bumped on every write; organiser season writes (Assign coach account) send the one they loaded. */
  revision?: number;
  news?: LeagueNewsPost[];
  /** Round deadlines (per phase and round, UTC ISO). */
  roundDeadlines?: RoundDeadline[];
  /** Auto-forfeit after the deadline (absent = off). */
  deadlinePolicy?: DeadlinePolicy;
  /** The "Pay entry fee" block (server-built): links, entry fee, and the viewer's own teams' paid status. */
  payment?: {
    entryFee?: string;
    payPal?: string;
    venmo?: { handle: string; url: string };
    mine?: Array<{ teamId: string; team: string; paid: boolean }>;
  };
}

export type StatsScope = "bb2020" | "bb2025" | "all";
export type LeaderStat = "td" | "cas" | "mvp" | "int" | "completions" | "fouls" | "spp";

export interface PlayerLeader { playerId: string; seasonId: string; teamId?: string; name: string; position: string; team: string; race: string; coach: string; seasons: number[]; value: number }
export interface RecordLine { games: number; wins: number; draws: number; losses: number; points: number; tdFor: number; tdAgainst: number; casFor: number; casAgainst: number; winPct: number }
export interface CoachRecord extends RecordLine { coach: string; coachId?: string; seasons: number[]; teams: number; titles: number }
export interface TeamRecord extends RecordLine { team: string; race: string; coach: string; seasons: number[] }
export interface RaceRecord extends RecordLine { race: string; teams: number }
export interface BigWin {
  seasonId: string; fixtureId?: string; season: number; phase: string; round: number; margin: number; playedAt?: string;
  winner: { team: string; coach: string; race: string; score: number };
  loser: { team: string; coach: string; race: string; score: number };
}

export interface LeagueStats {
  scope: StatsScope;
  seasons: Array<{ id: string; number: number; name: string; ruleset: LeagueRuleset; status: string }>;
  totals: { seasons: number; games: number; touchdowns: number; casualties: number; teams: number; coaches: number; players: number };
  leaders: Record<LeaderStat, PlayerLeader[]>;
  coaches: CoachRecord[];
  teams: TeamRecord[];
  races: RaceRecord[];
  biggestWins: BigWin[];
  mostGames: CoachRecord[];
  champions: Array<{ seasonId: string; season: number; ruleset: LeagueRuleset; coach: string; team: string; race: string }>;
  /** Spotlight cards in display order (absent from a server older than the cards). */
  cards?: StatsCard[];
}

export type StatsCardId =
  | "top-scorer" | "casualties" | "mvp" | "playmaker" | "interceptor" | "dirtiest" | "iron-man" | "best-coach" | "best-team" | "biggest-win";
export type StatsCardLink =
  | { kind: "player"; seasonId: string; teamId: string; playerId: string }
  | { kind: "team"; seasonId: string; teamId: string }
  | { kind: "fixture"; seasonId: string; fixtureId: string };
/** One spotlight card (server: src/leagues/stats.ts StatsCard). */
export interface StatsCard {
  id: StatsCardId;
  title: string;
  value: string;
  unit: string;
  name: string;
  team: string;
  race: string;
  coach: string;
  detail: string;
  seasons: number[];
  tied: string[];
  icon: string;
  link: StatsCardLink;
}
/** A spotlight card without a league link (tournament Statistics: src/tournaments/honours.ts SpotCard). */
export type SpotCard = Omit<StatsCard, "id" | "link" | "seasons"> & { id: string; link?: StatsCardLink; seasons?: number[] };

// ---- League settings (organisers; server: src/leagues/settings.ts LeagueSettingsView) ----

export type LeagueCountry = "US" | "CA";
export interface LeagueAddress { country: LeagueCountry; region: string; postcode: string; locality: string; street: string }

export interface LeagueRegistrations {
  allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
  allowRegistration: boolean;
  maxRegistrations: number | null;
  maxPerRace: number | null;
  /** League default payment links a new season copies (absent = none). */
  payPal?: string;
  venmo?: string;
}

export type DiscordEventKey = "news" | "fixtureCreated" | "matchStarted" | "matchResult" | "milestones" | "redraftRolls";
/** redraftRolls (11-02) is optional so older read models and fixtures still fit; the server always sends every key. */
export type DiscordEvents = Record<Exclude<DiscordEventKey, "redraftRolls">, boolean> & { redraftRolls?: boolean };

/** One roster row of a season's team building rules (the Tournament Team Builder reads these for a league team). */
export interface TeamBuildingRosterRule {
  roster: string;
  /** GW tier 1-6. */
  tier: number;
  /** Initial treasury in thousands of gold. */
  treasury: number;
  /** Extra starting skills by access, 0-6 each; Elite = TeamBuildingRules.eliteSkills. */
  startingSkills: { primary: number; secondary: number; elite: number };
}
export interface TeamBuildingRules { rosters: TeamBuildingRosterRule[]; eliteSkills: string[]; updatedAt?: string; updatedBy?: string }

export interface LeagueSettingsView {
  id: string;
  revision: number;
  information: {
    name: string; fullName: string; description: string; ruleset: LeagueRuleset; mode: "individual"; address: LeagueAddress | null;
    /** Creation wizards v2 (absent on older servers): Played on, and the ruleset card's package. */
    playOnFork?: boolean;
    rulesetPackage?: string | null;
    /** IANA time zone; null = not set (the league reads UTC). */
    timeZone?: string | null;
  };
  /** Creation wizards v2 (absent on older servers): house rules, the organiser's regions, and the authorised flag. */
  houseRules?: HouseRules;
  competitionRegions?: string[];
  authorised?: boolean;
  permissions: { owner: string; organisers: string[]; admins: string[]; canEditOrganisers: boolean; canChangeOwner: boolean };
  registrations: LeagueRegistrations;
  connections: {
    playOnFork: boolean;
    discord: { configured: boolean; maskedUrl: string; events: DiscordEvents };
    naf: { available: false; note: string };
  };
  teamBuilding: { seasonId: string; seasonName: string; ruleset: LeagueRuleset; rules: TeamBuildingRules } | null;
  /** Redraft budget formula and options (absent on older servers). */
  redraft?: { rules: RedraftRules; defaults: RedraftRules; set: Array<keyof RedraftRules> };
  regions: Record<LeagueCountry, Array<{ code: string; name: string }>>;
  rulesets: LeagueRuleset[];
  eliteSkills: string[];
}

// ---- Redraft (server: src/leagues/redraft.ts + redraftApi.ts) ----

export type RedraftTaskStatus = "pending" | "submitted" | "skipped" | "expired";
export interface RedraftAmounts { perGame: number; perWin: number; perDraw: number; perLoss: number }
export interface RedraftBudget {
  base: number; treasury: number; played: number; wins: number; draws: number; bonus: number; raw: number; capped: number;
  /** Since 11-02: losses and the amounts used (absent on older budgets = the defaults). */
  losses?: number; amounts?: RedraftAmounts;
}
export interface RedraftOverride { budget: number; reason: string; by: string; at: string }
export interface RedraftLogEntry { at: string; by: string; text: string; teamId?: string }
/** The league's redraft formula and options (League settings -> Redraft; server redraftRules.ts). */
export interface RedraftRules extends RedraftAmounts {
  base: number | null; agentFee: number; capEnabled: boolean; cap: number; setBudget: number; liftToBudget: boolean; windowDays: number;
}
export interface RedraftLift { to: number; by: string; at: string; auto: boolean }
export interface RedraftWindow { opensAt: string; closesAt: string; openNotifiedAt?: string; reminderAt?: string; processedAt?: string }
/** The board's status column (server redraftPhase). */
export type RedraftPhase = "not-selected" | "not-started" | "in-progress" | "submitted" | "needs-redraft" | "skipped" | "expired";

export interface RedraftBoardRow {
  teamId: string;
  sourceSeasonId: string;
  sourceSeasonName: string;
  name: string;
  coach: string;
  coachId?: string;
  race: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  treasury: number;
  budget: RedraftBudget;
  players: Array<{ name: string; position: string; seasons: number }>;
  selected: boolean;
  status?: RedraftTaskStatus;
  override?: RedraftOverride;
  spendable: number;
  /** Since 11-02 (absent on older servers): earned vs the set budget, the lift and the status column. */
  earned?: number;
  setBudget?: number;
  liftApplies?: boolean;
  lift?: RedraftLift;
  phase?: RedraftPhase;
  needsRedraft?: { at: string; reason: string };
}

export interface RedraftBoardView {
  leagueId: string;
  leagueName: string;
  revision: number;
  source: { id: string; name: string; number: number; ruleset: string } | null;
  target: { id: string; name: string } | null;
  /** Pickers: every finished season (redraft from), and the seasons after the source (draft lists go into). */
  sources?: Array<{ id: string; name: string }>;
  targets?: Array<{ id: string; name: string; status: string }>;
  state: { startedAt: string; byCoach: string; capEnabled: boolean; cap: number; revision: number; closedAt?: string; closedBy?: string; log: RedraftLogEntry[] } | null;
  capEnabled: boolean;
  cap: number;
  /** Since 11-02: the formula (the confirmed snapshot, else the league's settings) and the window. */
  rules?: RedraftRules;
  /** The league settings revision the formula was read at (Confirm sends it back; 409 when the settings moved on). */
  settingsRevision?: number;
  window?: (RedraftWindow & { open: boolean; before: boolean }) | null;
  active: RedraftBoardRow[];
  inactive: RedraftBoardRow[];
  note: string;
}

export interface RestRoll { playerId: string; roll: number; target: number; recovered: boolean; source: "site" | "entered" }

export interface RedraftPlayerQuote {
  playerId: string;
  number: number | null;
  name: string;
  position: string;
  value: number;
  seasons: number;
  fee: number;
  cost: number;
  niggling: number;
  nigglingAfter: number;
  missNextGame: boolean;
  bigGuy: boolean;
  /** Redraft mode (11-02): the sheet line. */
  stats?: StatLine;
  skills?: string[];
  level?: string;
}

/** MA / ST / AG / PA / AV as printed ("3+"; "-" unknown). */
export interface StatLine { MA: string; ST: string; AG: string; PA: string; AV: string }

export interface RedraftStaffQuote {
  rerollCost: number;
  maxRerolls: number;
  assistantCoachCost: number;
  cheerleaderCost: number;
  apothecaryCost: number;
  apothecaryAllowed: boolean;
  current: { rerolls: number; assistantCoaches: number; cheerleaders: number; apothecary: boolean };
}

export interface CoachRedraftView {
  leagueId: string;
  revision: number;
  teamId: string;
  name: string;
  race: string;
  coach: string;
  sourceSeason: { id: string; name: string };
  targetSeason: { id: string; name: string } | null;
  status: RedraftTaskStatus;
  /** Why the task expired (status "expired"); "" otherwise. */
  expiredReason?: string;
  closed: boolean;
  budget: RedraftBudget;
  capEnabled: boolean;
  cap: number;
  override: RedraftOverride | null;
  spendable: number;
  /** Redraft mode (11-02; absent on older servers). */
  earned?: number;
  setBudget?: number;
  lift?: RedraftLift | null;
  agentFee?: number;
  amounts?: RedraftAmounts;
  window?: { opensAt: string; closesAt: string; open: boolean; before: boolean } | null;
  needsRedraft?: { at: string; reason: string } | null;
  auto?: boolean;
  phase?: RedraftPhase;
  skillCategories?: Record<string, string>;
  apothecaryNow: boolean;
  rest: { target: number; done: boolean; rolls: RestRoll[]; needed: Array<{ playerId: string; name: string; position: string; niggling: number }> };
  players: RedraftPlayerQuote[];
  staff: RedraftStaffQuote;
  positions: Array<{ name: string; cost: number; max: number; bigGuy: boolean; stats?: StatLine; skills?: string[] }>;
  limits: { minPlayers: number; maxPlayers: number; assistantCoaches: number; cheerleaders: number; maxBigGuys: number };
  draft: { spent: number; treasury: number; keep: Array<{ playerId: string; cost: number }>; hires: Array<{ position: string; count: number; cost: number }> } | null;
  knownRoster: boolean;
}

export interface MyRedraftTask {
  leagueId: string; leagueName: string; teamId: string; teamName: string; race: string; status: RedraftTaskStatus; spendable: number; link: string;
  phase?: RedraftPhase; closesAt?: string;
}

/** The team summary's redraft budget (GET .../seasons/:seasonId/teams/:teamId/redraft-budget). */
export interface TeamRedraftBudget {
  teamId: string;
  teamName: string;
  seasonId: string;
  seasonName: string;
  record: { played: number; wins: number; draws: number; losses: number };
  rules: Pick<RedraftRules, "base" | "perGame" | "perWin" | "perDraw" | "perLoss" | "capEnabled" | "cap" | "setBudget" | "liftToBudget">;
  budget: RedraftBudget;
  earned: number;
  setBudget: number;
  liftWouldApply: boolean;
  expected: number;
  /** Only for the team's coach and the league's organisers. */
  redraft: null | { phase: RedraftPhase; spendable: number; override: RedraftOverride | null; lift: RedraftLift | null; window: RedraftWindow | null; history: RedraftLogEntry[]; link: string };
}
