/**
 * Leagues: a league (name, artwork, organisers) with numbered seasons. Seasons are stored whole (phases with their
 * standings, fixtures, participants, team rosters with per-player season stats, honours, awards). The first league
 * (TABBL) was imported from the organiser's TourPlay exports (scripts/import-tourplay-league.ts).
 *
 * Storage: <FORK_STATE_DIR>/leagues/<leagueId>/league.json + seasons/<seasonId>.json, atomic writes.
 * The read model (api.ts) exposes logoUrl / bannerUrl, never the stored file paths.
 */

export type LeagueRuleset = "BB2020" | "BB2025";
export const LEAGUE_RULESETS: readonly LeagueRuleset[] = ["BB2020", "BB2025"];
export type SeasonStatus = "active" | "completed";

export interface LeagueRecord {
  id: string;
  name: string;
  fullName: string;
  slug: string;
  description: string;
  /** `league-art/<sha256>.<ext>` under the league's directory, or unset. */
  logoPath?: string;
  bannerPath?: string;
  /** Coach ids (fork accounts) who may change the league artwork and settings; admins always may. */
  organisers: string[];
  /** The league owner (a coach id); unset = the first organiser. Only the owner or an admin changes the organisers. */
  owner?: string;
  /** Default rules edition for a new season (Information tab). */
  ruleset?: LeagueRuleset;
  /** Play mode: individual coaches (the only mode today). */
  mode?: "individual";
  address?: LeagueAddress;
  registrations?: LeagueRegistrations;
  /** Discord webhook event toggles; the URL itself lives in secrets.json, never here. */
  discordEvents?: DiscordEvents;
  /** Play on Super FUMBBL (default off): fixtures an admin allows can then be generated on the fork (later lane). */
  playOnFork?: boolean;
  /** Redraft budget cap the board starts from (default on, 1,300,000); remembered from the last confirmed redraft. */
  redraftCap?: { enabled: boolean; cap: number };
  /** Settings revision: every settings write bumps it; a PATCH naming an older revision is refused (409). */
  revision?: number;
  createdAt: string;
  updatedAt: string;
}

export type LeagueCountry = "US" | "CA";

/** Where the league plays (US or Canada). region = state / province code; postcode = ZIP (5 or 5-4) or A1A 1A1. */
export interface LeagueAddress {
  country: LeagueCountry;
  region: string;
  postcode: string;
  locality: string;
  street: string;
}

export interface LeagueRegistrations {
  allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
  allowRegistration: boolean;
  /** null = no limit. */
  maxRegistrations: number | null;
  /** null = no limit. */
  maxPerRace: number | null;
}

export const DISCORD_EVENT_KEYS = ["news", "fixtureCreated", "matchStarted", "matchResult", "milestones"] as const;
export type DiscordEventKey = (typeof DISCORD_EVENT_KEYS)[number];
export type DiscordEvents = Record<DiscordEventKey, boolean>;

/** <leagueDir>/secrets.json: server-side only, masked in every read model, never logged. */
export interface LeagueSecrets {
  discordWebhookUrl?: string;
}

/**
 * Team building rules of a season (League settings, Team building tab), read by the Tournament Team Builder when a
 * team is built for this league. One row per roster of the season's ruleset (BB2025 dataset names).
 */
export interface TeamBuildingRosterRule {
  /** Dataset roster name ("Black Orc"). */
  roster: string;
  /** GW tier 1-6 (dataset default unless the league changed it). */
  tier: number;
  /** Initial treasury in thousands of gold (1000 = 1,000,000). */
  treasury: number;
  /** Extra starting skills the organiser grants, by access: 0-6 each. Elite = eliteSkills. */
  startingSkills: { primary: number; secondary: number; elite: number };
}

export interface TeamBuildingRules {
  rosters: TeamBuildingRosterRule[];
  /** The skills that count as Elite (Small Gods: Block, Guard, Mighty Blow, Dodge). */
  eliteSkills: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface SeasonRules {
  teamBuilding?: TeamBuildingRules;
}

/** One side of a fixture. coachId is set when the coach maps to a fork identity (NAF name match). */
export interface FixtureSide {
  team: string;
  /** The season team this side resolves to (LeagueTeam.id): team name + canonical coach, race as the tiebreaker. */
  teamId?: string;
  coach: string;
  coachId?: string;
  /** coachId was set by an organiser (Assign coach account): authoritative, never linked to the display / NAF name. */
  coachAssigned?: true;
  race: string;
  nafUser?: string;
  score: number | null;
  cas: number | null;
  conceded: boolean;
}

export interface LeagueFixture {
  id: string;
  /** TourPlay category: "Season" or "Cup". */
  category: string;
  phase: string;
  /** `<category>-<phase>` slug; matches LeaguePhase.id. */
  phaseId: string;
  group: string;
  round: number;
  table: number;
  home: FixtureSide;
  away: FixtureSide;
  suspended: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** An admin allowed this fixture to be played on Super FUMBBL (needs league.playOnFork). */
  forkEnabled?: boolean;
  /** Internal (never in a read model): who was told this fixture may be played on Super FUMBBL, and when last. */
  forkNotice?: { at: string; to: string[] };
  /** Scheduled date (YYYY-MM-DD) set in the organiser fixtures editor. */
  date?: string;
  /** Test data: Discord posts about this fixture carry the "[Test]" prefix. */
  test?: boolean;
  /** Discord announcement markers (independent of the capped season log): when "started" posted, which result posted. */
  announced?: { started?: string; result?: string };
  /** Admin per-game setting: the fixture may be generated on Super FUMBBL although its season is finished or the fixture is marked not played. */
  forkAllowLate?: boolean;
  /** Admin per-game setting: Super FUMBBL play is cancelled for this fixture (no generate, no start). */
  forkCancelled?: boolean;
  /** Play on Super FUMBBL state (forkPlay.ts): the fork teams built for it, the scheduled game, the applied result. */
  fork?: FixtureForkState;
}

// ---- Play on Super FUMBBL (spec-league-settings-2026-10-30 §3; forkPlay.ts) ----

export type ForkSide = "home" | "away";

/**
 * teams_built = both fork teams exist, no game yet; scheduled = the fork game exists; in_progress = the fork lists it
 * as running; finished = the result was applied to the fixture and the teams; launch_failed = scheduling failed
 * (error says why; an organiser resets it); cancelled = an organiser cancelled Super FUMBBL play for the fixture.
 */
export type FixtureForkStatus = "teams_built" | "scheduled" | "in_progress" | "finished" | "launch_failed" | "cancelled";

/** The fork copy of one side's league team, built from the league roster when the fixture was generated. */
export interface FixtureForkTeam {
  /** LeagueTeam.id. */
  teamId: string;
  /** The fork team id (one per league / season / team; rewritten from the league roster at each generate). */
  forkTeamId: string;
  /** The fork coach who owns the team (the side's coachId). */
  coach: string;
  builtAt: string;
  /** Fork player id -> league playerId, as written to the team file (the result maps back through this). */
  players: Array<{ forkPlayerId: string; playerId: string }>;
  /** leagueTeamRevision of the league roster the file was built from (a change before the first launch rebuilds it). */
  revision?: string;
}

export interface FixtureForkLogEntry { at: string; by: string; text: string }

/** One player's line from a Super FUMBBL result (server numbers only). */
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
  /** SPP earned this game (full results only). */
  spp?: number;
  /** Serious injuries the server recorded (full results only), e.g. "Seriously Hurt (MNG)", "Dead (RIP)". */
  injuries: string[];
}

/** Casualties a team suffered, as the server counted them (FumbblResult casualtiesSuffered; the basic listing's bh/si/rip). */
export interface CasualtiesSuffered { badlyHurt: number; seriousInjury: number; rip: number }

/**
 * One side of a Super FUMBBL result. The optional fields fill themselves from the server's result (no coach input) and
 * are omitted when the result did not carry them (the server's serializer omits zero / false values, so absent = 0).
 */
export interface ForkSideResult {
  score: number;
  cas: number;
  conceded: boolean;
  /** Full results, conceding side only: the server judged the concession legal (true) or not (false). */
  concededLegally?: boolean;
  /** Casualties this team suffered (omitted when none). */
  casualtiesSuffered?: CasualtiesSuffered;
  /** Full results only, as the server sent them: attendance, fame, fan factor and the dedicated-fans change. */
  spectators?: number;
  fame?: number;
  fanFactor?: number;
  dedicatedFansModifier?: number;
  winnings: number;
  lines: ForkPlayerLine[];
  /**
   * Full results only, when they differ: the fork's teamValue minus the league's KICKOFF figure for the team (signed
   * gold) = its current team value before the result was applied + dedicated fans x 10k, the same terms the fork's
   * kickoff figure counts (teamValue.ts kickoffTeamValue). Informational (owner 10-30): never changes anything.
   */
  forkTeamValueDiff?: number;
}

export interface FixtureForkResult {
  gameId: string;
  /** "full" = the server's FumbblResult (SPP, injuries, fans); "basic" = score and player counters only. */
  source: "full" | "basic";
  appliedAt: string;
  /** A penalty shootout decided the game (home-away shootout score). */
  penalty?: { home: number; away: number };
  /** A basic result: winnings and inducement spend are unknown, the treasuries were left alone for an organiser to settle. */
  financialPending?: boolean;
  home: ForkSideResult;
  away: ForkSideResult;
}

export interface FixtureForkState {
  status: FixtureForkStatus;
  teams: Partial<Record<ForkSide, FixtureForkTeam>>;
  gameId?: string;
  gameName?: string;
  generatedBy?: string;
  generatedAt?: string;
  scheduledAt?: string;
  /** launch_failed: why (the fork's own refusal text, or "outcome unknown"). */
  error?: string;
  /** The last schedule call had no clear answer: a game may exist. Reset first looks for it on the fork. */
  uncertain?: boolean;
  /** cancelled: the status to return to when Super FUMBBL play is allowed again. */
  statusBeforeCancel?: FixtureForkStatus;
  /** When each seated coach last took their launch file. */
  launched?: Partial<Record<ForkSide, string>>;
  /** Invitation notifications went out (once per fixture). */
  invited?: boolean;
  result?: FixtureForkResult;
  /** Organiser-visible history: generate, schedule, failures, resets (with reasons), result. */
  log: FixtureForkLogEntry[];
}

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
  injuriesFor: number;
  injuriesAgainst: number;
  completions: number;
  interceptions: number;
  deathsFor: number;
  deathsAgainst: number;
  foulsFor: number;
  foulsAgainst: number;
  sentOffsFor: number;
  sentOffsAgainst: number;
  secretObjectives: number;
  buchholz: number;
}

export interface LeaguePhase {
  id: string;
  category: string;
  name: string;
  groups: string[];
  standings: StandingRow[];
  /** Fixture-only phases whose games count in this phase's standings (e.g. Interdivision in Regular). */
  includes?: string[];
}

export interface LeagueParticipant {
  coach: string;
  coachId?: string;
  /** See FixtureSide.coachAssigned. */
  coachAssigned?: true;
  nafUser?: string;
  country: string;
  race: string;
  team: string;
  registeredAt?: string;
  active: boolean;
}

/** Season totals for one player, from the TourPlay player honours (absent = 0). */
export interface PlayerSeasonStats {
  td: number;
  cas: number;
  mvp: number;
  int: number;
  completions: number;
  fouls: number;
  /**
   * Injuries SUFFERED by this player (the victim), not inflicted: `cas` is the casualties the player caused. A Super
   * FUMBBL result adds one per game in which the server recorded a casualty result for the player (a serious injury or
   * death). The server's per-player result names serious injuries only, so a Badly Hurt is not counted per player.
   */
  injuries: number;
  sentOffs: number;
  spp: number;
  performance: number;
  /**
   * Counters from Super FUMBBL results only (FumbblResult player statistics), added once per banked fixture. Absent = 0;
   * rushing and passing are the server's signed yardage.
   */
  blocks?: number;
  rushing?: number;
  passing?: number;
  deflections?: number;
  landings?: number;
  turnsPlayed?: number;
}

/** The optional per-fixture counters of PlayerSeasonStats, in display order. */
export const FORK_PLAYER_COUNTERS = ["blocks", "rushing", "passing", "deflections", "landings", "turnsPlayed"] as const;
export type ForkPlayerCounter = (typeof FORK_PLAYER_COUNTERS)[number];

export const EMPTY_PLAYER_STATS: PlayerSeasonStats = {
  td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0,
};

/** Identity every imported player carries (see playerIds.ts): the season id, and the link to the same player's other seasons. */
export interface PlayerIdentity {
  /** `p-<hash>`: stable across re-imports, unique within the league, opaque. */
  playerId: string;
  /** `c-<hash>`: the same player across seasons (same team lineage, shirt number, name, position). Set by the importer's career link. */
  careerKey?: string;
  /** This player's ids in earlier seasons, oldest first. */
  previousIds?: string[];
}

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
  /**
   * Seasons this player took part in BEFORE this roster's season (our store's field; the FFB server has none). A
   * season counts when the player is on a roster whose team played at least one game in it. Derived at import from
   * the career links (playerIds.ts assignSeasonsPlayed); a redraft carries it forward with the finished season added.
   */
  seasonsPlayed?: number;
}

/** A player who appears in the season honours but not on the final roster (dead, fired, retired). */
export interface FormerPlayer extends PlayerIdentity {
  name: string;
  position: string;
  level: string;
  stats: PlayerSeasonStats;
}

export interface LeagueTeam {
  /** Season-unique id (slug of name + coach, race added on a clash); fixtures and standings point at it. */
  id: string;
  name: string;
  race: string;
  coach: string;
  coachId?: string;
  /**
   * An organiser set the coach account (Assign coach account): who and when. With coachId the account is authoritative
   * (identity.ts); `cleared` = the organiser removed the account (kept so a re-import does not bring it back).
   */
  coachAssigned?: { by: string; at: string; cleared?: true };
  nafUser?: string;
  /**
   * Team value (gold), RECOMPUTED by the league from the stored player values plus staff after every mutation
   * (teamValue.ts refreshTeamValues; owner 10-30). The fork's figure is never adopted.
   */
  teamValue: number | null;
  /** Current team value: teamValue without the players who miss the next game (teamValue.ts). Unset until recomputed. */
  currentTeamValue?: number | null;
  /** The team value the TourPlay export listed at import (its CurrentTeamValue), kept for reference only. */
  importedTeamValue?: number | null;
  /** The race "Team value not recomputed" was logged for (once per team and race; cleared when the race resolves). */
  valueUnresolvedRace?: string;
  treasury: number | null;
  rerolls: number | null;
  fans: number | null;
  assistantCoaches: number | null;
  cheerleaders: number | null;
  apothecary: boolean;
  tier: string;
  /** TourPlay's sub-league label for the race ("WorldsEdgeSuperleague"). */
  raceLeague: string;
  players: LeaguePlayer[];
  formerPlayers: FormerPlayer[];
}

export type HonourKind = "player" | "team" | "coach";

/** A coach honour value: a plain number or a TourPlay brace record ({ Wins = 4, Draws = 0, ... }). */
export type HonourValue = number | string | Record<string, number | string>;

export interface HonourRow {
  rank: number;
  /** Player name (player honours), team name (team honours) or coach (coach honours). */
  name: string;
  team: string;
  coach: string;
  position?: string;
  level?: string;
  /** Player boards: the roster / former player this row is, when the export pins it to exactly one. */
  playerId?: string;
  value: HonourValue;
}

export interface HonourTable {
  /** `<category>-<stat>`, e.g. "season-mosttouchdowns". */
  key: string;
  category: string;
  stat: string;
  kind: HonourKind;
  rows: HonourRow[];
}

export interface LeagueAward {
  category: string;
  type: string;
  name: string;
  description: string;
  coach: string;
  coachId?: string;
  team: string;
  race: string;
  goldenStar: boolean;
}

/**
 * Honour totals the export cannot pin to one player: two players of one team share a name and position, or two teams
 * share a name. Recorded once (on the team when known), never copied onto several players.
 */
export interface UnattributedStats {
  team: string;
  teamId?: string;
  name: string;
  position: string;
  stats: PlayerSeasonStats;
  reason: string;
  /** The playerIds of the roster players this total could belong to (empty when the team has no roster). */
  candidates: string[];
}

export interface SeasonRecord {
  id: string;
  leagueId: string;
  number: number;
  name: string;
  sourceSlug: string;
  ruleset: LeagueRuleset;
  status: SeasonStatus;
  startedAt?: string;
  endedAt?: string;
  phases: LeaguePhase[];
  fixtures: LeagueFixture[];
  participants: LeagueParticipant[];
  teams: LeagueTeam[];
  honours: HonourTable[];
  awards: LeagueAward[];
  unattributedStats: UnattributedStats[];
  importedAt: string;
  /** Bumped by the store on every write (results, fixtures, redraft application...): the stats cache keys on it. */
  revision?: number;
  /** "manual" = started from League settings (Start a new season). */
  source: "tourplay-export" | "manual";
  rules?: SeasonRules;
  /** The off-season redraft run FROM this (finished) season: see redraft.ts. */
  redraft?: RedraftState;
  /** League news posted during this season (stored in posting order; reads sort pinned first, newest first). */
  news?: LeagueNewsPost[];
  /** Season activity log (fixtures created / deleted, matches started, results), newest first, capped: see events.ts. */
  log?: LeagueEventEntry[];
}

/** A league news post (League page, Overview): modelled on the tournament news (MarkdownLite body). */
export interface LeagueNewsPost {
  id: string;
  title: string;
  body: string;
  by: string;
  at: string;
  pinned: boolean;
  editedAt?: string;
}

export type LeagueEventKind = "fixture-created" | "fixture-deleted" | "match-started" | "match-result" | "team-coach" | "team-value-diff" | "team-value-unresolved";

export interface LeagueEventEntry {
  at: string;
  by: string;
  kind: LeagueEventKind;
  fixtureId?: string;
  /** team-coach: the season team whose coach account changed; team-value-diff / team-value-unresolved: the team concerned. */
  teamId?: string;
  text: string;
  /** match-result: the score the post announced ("2-1/3-0"); the same result is never announced twice. */
  sig?: string;
}

// ---- Redraft (League settings, Administration -> Start redraft; spec-league-settings-2026-10-30 §2) ----

/** expired = the next season moved on (results, or a different roster) before the draft list could be applied. */
export type RedraftTaskStatus = "pending" | "submitted" | "skipped" | "expired";

/** Budget terms in gold (see redraft.ts redraftBudget). raw = base + treasury + bonus; capped = what the coach may spend. */
export interface RedraftBudget {
  base: number;
  treasury: number;
  /** League fixtures played last season, wins and draws (counts, not gold). */
  played: number;
  wins: number;
  draws: number;
  /** played x 20k + wins x 20k + draws x 10k. */
  bonus: number;
  raw: number;
  capped: number;
}

/** One Rest & Relaxation roll: a niggling injury rolls off on target+ (4+, or 3+ with an Apothecary). */
export interface RestRoll {
  playerId: string;
  roll: number;
  target: number;
  recovered: boolean;
  /** "site" = rolled by the server ("Roll for me"); "entered" = the coach typed a tabletop result. */
  source: "site" | "entered";
}

/** A player kept on the draft list: the source season's playerId, plus the cost that was charged. */
export interface DraftKeep { playerId: string; cost: number }

/** The coach's submitted Team Draft List (what was bought). */
export interface DraftList {
  keep: DraftKeep[];
  hires: Array<{ position: string; count: number; cost: number }>;
  staff: { rerolls: number; assistantCoaches: number; cheerleaders: number; apothecary: boolean; cost: number };
  spent: number;
  /** Unspent budget: becomes the new team's treasury. */
  treasury: number;
  /** The new roster (players with fresh ids for the next season). */
  team: LeagueTeam;
}

export interface RedraftTeamTask {
  teamId: string;
  /** The season the team's roster comes from (the redraft season for active teams; an earlier one for inactive). */
  sourceSeasonId: string;
  /** Snapshot for the board (the coach may have renamed nothing; these are the source roster's). */
  name: string;
  coach: string;
  coachId?: string;
  race: string;
  selected: boolean;
  budget: RedraftBudget;
  status: RedraftTaskStatus;
  /** Organiser override of the spendable budget (gold), with the reason shown to the coach. */
  override?: { budget: number; reason: string; by: string; at: string };
  rest?: { at: string; by: string; rolls: RestRoll[] };
  submittedAt?: string;
  submittedBy?: string;
  draft?: DraftList;
  /** The season the draft list was written into ("" / unset = waiting for Start a new season). */
  appliedTo?: string;
  /** Why the task expired (status "expired"). */
  expiredReason?: string;
}

export interface RedraftLogEntry { at: string; by: string; text: string }

export interface RedraftState {
  startedAt: string;
  byCoach: string;
  capEnabled: boolean;
  cap: number;
  /** Bumped on every write; a POST naming an older revision is refused (409), none at all 428. */
  revision: number;
  teams: RedraftTeamTask[];
  closedAt?: string;
  closedBy?: string;
  /** League news for the redraft (also posted to Discord when the league has a webhook). */
  log: RedraftLogEntry[];
  /** The season the organiser picked to receive the draft lists (unset = the default target, see redraft.ts). */
  targetSeasonId?: string;
}
