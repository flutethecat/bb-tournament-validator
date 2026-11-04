/**
 * Leagues: a league (name, artwork, organisers) with numbered seasons. Seasons are stored whole (phases with their
 * standings, fixtures, participants, team rosters with per-player season stats, honours, awards). The first league
 * (TABBL) was imported from the organiser's TourPlay exports (scripts/import-tourplay-league.ts).
 *
 * Storage: <FORK_STATE_DIR>/leagues/<leagueId>/league.json + seasons/<seasonId>.json, atomic writes.
 * The read model (api.ts) exposes logoUrl / bannerUrl, never the stored file paths.
 */

import type { SeasonInducements } from "./inducementRules.js";
import type { HouseRules } from "../competition/houseRules.js";

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
  discordEvents?: Partial<DiscordEvents>;
  /** League-level Discord options beyond the toggles (src/discord/catalogue.ts): live in-game events, end-of-game digest,
   *  coach's comments. Absent = the defaults. */
  discord?: Omit<import("../discord/catalogue.js").CompetitionDiscordConfig, "events">;
  /** Per-competition Discord options of its seasons / ladders, keyed "season:<seasonId>" (auto-populated from the league
   *  when the season is made). Absent = the league's. */
  competitionDiscord?: Record<string, import("../discord/catalogue.js").CompetitionDiscordConfig>;
  /** Weekly Digest schedule (src/discord/weekly.ts). Absent = on by default (weekly, Sunday 10:00) once a webhook exists. */
  weeklyDigest?: import("../discord/weekly.js").WeeklyDigestSettings;
  /** IANA time zone the league's schedules use (Weekly Digest). Absent = UTC. */
  timeZone?: string;
  /** League Events: Discord scheduled events in the organiser's server (src/discord/scheduledEvents.ts; needs the bot there).
   *  Organiser read model only; never on a public read. Absent = off. */
  scheduledEvents?: {
    enabled: boolean; guildId?: string; channelId?: string; channelType?: "voice" | "stage";
    /** The sync stopped: no organiser of the league (with a linked Discord account) can manage events in that server. */
    blocked?: { reason: string; at: string };
  };
  /** Play on Super FUMBBL (default off): fixtures an admin allows can then be generated on the fork (later lane). */
  playOnFork?: boolean;
  /** A test competition (registration spec Q13): the only kind a test sign-in may write in (src/registration/testSession.ts). */
  test?: true;
  /** Lane L5 (registration spec §4): draft = visible to its organisers and site admins only (lifecycle.ts); absent = published
   *  (every imported league). */
  visibility?: "draft" | "published";
  /** The creation wizard's progress (wizard.ts): the step reached, who started it, when Create league finished it. */
  wizard?: { step: number; createdBy: string; completedAt?: string };
  /** First published (Publish in League settings). */
  publishedAt?: string;
  /** House rules (creation wizards v2), stored on the league, never on a shared package. Absent = all "as the ruleset says". */
  houseRules?: HouseRules;
  /** The ruleset card picked in the wizard / settings: a saved package name (e.g. "EuroBowl 2026"). Absent = the plain
   *  base ruleset (`ruleset`, BB2025 by default). Shown on the league; the league Roster Builder still builds from the base
   *  ruleset and the season's team building table (package rules in league mode are a later lane). */
  rulesetPackage?: string;
  /** The organiser's regions (Season step); coaches pick one at join (a later lane). */
  regions?: string[];
  /** Site-authorised (owner round 3: every competition run on the site is, for now). Absent = true. */
  authorised?: boolean;
  /** Written only by scripts/seed-demo-leagues.ts (demo data): which script and run created it. --remove needs it. Never in a read model. */
  seededBy?: { script: string; run: string };
  /** Redraft budget cap the board starts from (default on, 1,300,000); remembered from the last confirmed redraft. */
  redraftCap?: { enabled: boolean; cap: number };
  /** Redraft budget formula and options (League settings -> Redraft; redraftRules.ts). Unset keys take the defaults; unset
   *  liftToBudget = off (leagues made before 11-02 keep the old behaviour; the wizard sets it on for new leagues). */
  redraftRules?: Partial<RedraftRules>;
  /** Settings revision: every settings write bumps it; a PATCH naming an older revision is refused (409). */
  revision?: number;
  /** Awards an organiser or admin gave (awards.ts); the podium and imported awards stay on their seasons. */
  awards?: LeagueCustomAward[];
  /** Organiser-curated Hall of Fame entries, in display order (awards.ts). */
  hallOfFame?: HallOfFamePin[];
  /** Awards / Hall of Fame revision: every such write bumps it; a write naming an older one is refused (409). */
  honoursRevision?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * An award given on this site by an organiser of the league or a site admin (spec §2 item 4). The recipient is a team
 * (toTeam / teamId / race, plus its coach) or a coach; toCoachId is the coach's fork account when the league maps it.
 */
export interface LeagueCustomAward {
  id: string;
  title: string;
  /** Key of the award icon table (awards.ts AWARD_ICONS: our own icon set). */
  icon: string;
  toCoach?: string;
  toCoachId?: string;
  toTeam?: string;
  teamId?: string;
  race?: string;
  /** The season the award belongs to; unset = league-wide. */
  seasonId?: string;
  note: string;
  by: string;
  at: string;
}

/** A pinned Hall of Fame entry: a season champion, an award (season or custom, by its list id) or a free-text record. */
export interface HallOfFamePin {
  id: string;
  kind: "champion" | "award" | "record";
  seasonId?: string;
  awardId?: string;
  text?: string;
  note: string;
  by: string;
  at: string;
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
  /** League default payment links that a new season copies (src/payments/links.ts; absent = none). */
  payPal?: string;
  venmo?: string;
}

export const DISCORD_EVENT_KEYS = [
  "news", "fixtureCreated", "matchStarted", "matchResult", "milestones", "redraftRolls",
  // Discord events overhaul (src/discord/catalogue.ts holds who each applies to and its defaults).
  "published", "registrationOpened", "newRegistration", "registrationClosing", "checkInOpen", "roundPosted", "fixtureStart",
  "roundStandings", "finalStandings", "awards", "seasonStarted", "seasonFinished",
  "touchdown", "casualty", "injury", "death", "foul", "sentOff", "mvp", "hireFire",
  // League Events (src/leagues/leagueEvents.ts): "New league event" on the league (or linked season) webhook.
  "leagueEvent",
] as const;
export type DiscordEventKey = (typeof DISCORD_EVENT_KEYS)[number];
export type DiscordEvents = Record<DiscordEventKey, boolean>;

// ---- League Events (src/leagues/leagueEvents.ts): <leagueDir>/events.json --------------------------------------------

export const LEAGUE_EVENT_TYPES = ["league-night", "draft", "tournament-day", "social", "other"] as const;
export type LeagueEventType = (typeof LEAGUE_EVENT_TYPES)[number];

/**
 * One League Event (a league night, draft, tournament day, social...). Times are WALL-CLOCK times in the league's time zone
 * ("2026-11-05T19:00"), so a weekly league night stays at 19:00 across daylight saving; instants are derived on read.
 * No coach data is stored here (no author field), so account export / deletion has nothing to do in this file.
 */
export interface LeagueCalendarEvent {
  id: string;
  /** Bumped on every organiser write; PATCH / DELETE name it (409 when stale). */
  revision: number;
  title: string;
  type: LeagueEventType;
  /** "YYYY-MM-DDTHH:MM" in the league zone. */
  start: string;
  end: string;
  location: { kind: "venue" | "online"; text: string };
  description: string;
  /** Optional link to a season (or, once ladders exist, a ladder) of this league. */
  link?: { kind: "season" | "ladder"; id: string };
  /** Repeats every N weeks (1 = weekly) up to and including `until` (YYYY-MM-DD, league zone). */
  recurrence?: { everyWeeks: number; until: string };
  /** Coaches get an inbox reminder 24 hours before each occurrence. */
  remind: boolean;
  /** Post "New league event" to the league's Discord webhook when it is created (default on for league nights). */
  announce: boolean;
  createdAt: string;
  updatedAt: string;
  /** Coaches were told about this event (a create / change note, or the publish note): its cancellation is always sent. */
  announced?: boolean;
  /** Occurrence keys (local start) already reminded or covered by the create / change notice: once each. */
  reminded?: string[];
  /** The Discord Guild Scheduled Event mirroring the next occurrence (server side; never on a public read). `start` / `end`
   *  are the UTC instants it was given, `channelId` its channel: the drift check compares them with what is wanted now. */
  discord?: DiscordMirror;
  /** Earlier occurrences' Discord events still under way: tracked until they end (plus a grace period), so a delete, a
   *  disable, a server change or a move can still remove them. */
  discordLive?: DiscordMirror[];
  /** Bumped every time the event is queued for a Discord sync (an edit, a settings change); a sync result for an older
   *  generation never clears or fails a newer one. */
  syncGen?: number;
  /** A Discord sync waiting to run (retried with backoff; `failed` after the last attempt, until the next edit). `gen` =
   *  the syncGen it was queued for. */
  discordSync?: { attempts: number; nextAt: string; error?: string; failed?: boolean; gen?: number };
}

/** A Discord scheduled event still to remove (its League Event was deleted, or the server changed). */
export interface DiscordMirror { guildId: string; eventId: string; occurrence: string; start: string; end: string; channelId?: string }

export interface PendingDiscordDelete { guildId: string; eventId: string; attempts: number; nextAt: string; title?: string; error?: string }

/** A cleanup that ran out of retries: kept (never dropped) and shown in Connections with "Retry cleanup". */
export interface DiscordDeadLetter { guildId: string; eventId: string; title?: string; at: string; error: string; checkedAt?: string }

export interface LeagueEventsFile {
  events: LeagueCalendarEvent[];
  discordDeletes?: PendingDiscordDelete[];
  discordDeadLetters?: DiscordDeadLetter[];
}

/** <leagueDir>/secrets.json: server-side only, masked in every read model, never logged. */
export interface LeagueSecrets {
  discordWebhookUrl?: string;
  /** Per-competition webhooks of this league: "season:<seasonId>" (and later "ladder:<ladderId>"). Blank = the league's. */
  competitionWebhooks?: Record<string, string>;
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
  /** League settings, Inducements tab (inducements.ts): standard-table overrides + custom types, with their own revision. */
  inducements?: SeasonInducements;
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
  /**
   * The coach who played this side, frozen when the fixture got its result (team library lane, records follow the coach
   * of each game: identity.ts stampPlayedCoaches, run by every season write). Coach records, summaries and club stats
   * attribute the game by it (identity.ts gameCoach), never by the team's current coach. Cleared again when the result is.
   */
  playedBy?: PlayedCoach;
  /** The stamp of a result that was cleared, kept so a correction re-entered by the same holder counts for the same
   *  coach (identity.ts stampPlayedCoaches); dropped when the entry changes hands meanwhile. */
  clearedPlayedBy?: PlayedCoach;
}

/** The coach facets of one side at the time it was played (FixtureSide.playedBy). */
export interface PlayedCoach {
  coach: string;
  coachId?: string;
  nafUser?: string;
  coachAssigned?: true;
  /** How many times the team behind the entry had changed hands (LeagueTeam.entryHistory spans - 1) when this side was
   *  played: a cleared result re-entered while it is still the same holder keeps this stamp (identity.ts). */
  span?: number;
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
  /**
   * An organiser or admin overrode a result that already existed (a recorded, imported or typed one) in the fixtures
   * editor: the Weekly Digest labels it an administrative result. A first-time typed score is NOT marked (a played game's
   * score); a recorded result, a forfeit or a clear replaces the mark.
   */
  resultEdit?: { by?: string; at: string };
  /** Admin per-game setting: Super FUMBBL play is cancelled for this fixture (no generate, no start). */
  forkCancelled?: boolean;
  /** Play on Super FUMBBL state (forkPlay.ts): the fork teams built for it, the scheduled game, the applied result. */
  fork?: FixtureForkState;
  /** The time both coaches agreed through a game-time proposal (src/schedule): a 2-hour slot, UTC ISO. Never set by an import. */
  scheduledTime?: { start: string; end: string; agreedAt: string };
  /** Organiser's per-fixture deadline (UTC ISO); unset = the round deadline (deadlines.ts effectiveDeadline). */
  deadline?: string;
  /** What happened at the deadline (deadlines.ts): the auto-forfeit job's outcome, or an organiser's decision. */
  deadlineOutcome?: FixtureDeadlineOutcome;
  /** An organiser reopened the fixture after its deadline: auto-forfeit skips it while its effective deadline is still this one. */
  deadlineReopenedFor?: string;
  /**
   * Tabletop recorder link (tabletopFixtures.ts): bumped by every result the recorder writes or retracts here, and the
   * op id / time of the recorded one (the recorder's publish journal checks them, like a tournament fixture's revision).
   */
  tabletop?: { revision: number; opId?: string; reportedAt?: string };
  /**
   * Team page v2: the organiser's decision for this unplayed fixture when one side's team went inactive. cancel = no
   * result (deadlineOutcome "no-result"), forfeit = the inactive side concedes, leave = stays scheduled. Never applied
   * automatically.
   */
  inactiveDecision?: { teamId: string; decision: "cancel" | "forfeit" | "leave"; by: string; at: string };
  /**
   * An administrative forfeit (src/leagues/forfeit.ts, the TourPlay-style dialog): the F markers, "No effect on standings"
   * and the penalty points. Public (the F markers show on the fixture); the details live in forfeitDetail.
   */
  forfeit?: FixtureForfeit;
  /** Internal (never in a read model): who entered the forfeit, the numbers applied to the rosters and the defection rolls. */
  forfeitDetail?: FixtureForfeitDetail;
  /** Internal (never in a read model): defection rolls made from the forfeit dialog and not applied yet (no rerolling). */
  forfeitDraft?: FixtureForfeitDraft;
  /** Admin per-game setting (the fixture's admin panel, or the recorder's Admin panel): false = a forfeit rolls no
   *  defections. Absent = on (FFB rolls them after an illegal concession). */
  defectionRolls?: false;
}

/** The public part of a forfeit. */
export interface FixtureForfeit {
  home: boolean;
  away: boolean;
  /** "No effect on standings": the fixture counts nowhere in the table. */
  noStandings?: true;
  /** Points taken off each forfeiting team's standings (organiser-set). */
  penalty?: { home: number; away: number };
  at: string;
}

export interface ForfeitDefectionRoll { playerId: string; name: string; number?: number | null; advancements: number; roll: number; leaves: boolean; rollId?: string }

export interface FixtureForfeitDraft {
  side: "home" | "away";
  rolls: ForfeitDefectionRoll[];
  at: string;
  by: string;
}

export interface FixtureForfeitDetail {
  by: string;
  at: string;
  legalConcession: boolean;
  /** The numbers applied per side (winnings in gold, fans, MVP and miss-next-game player ids). */
  sides: Record<"home" | "away", { winnings: number; fans: number; mvp: string[]; missNextGame: string[] }>;
  /** Defection rolls of the forfeiting team, when rolled. */
  defections?: { side: "home" | "away"; rolls: ForfeitDefectionRoll[] };
  /** The recorder match this forfeit closed, when entered from the recorder. */
  matchId?: string;
  /** When the end-of-match report was posted (never twice). */
  announcedAt?: string;
  /** What the undo restores (both rosters and the fixture result before the forfeit) and the rosters' fingerprint after it. */
  undo?: {
    teams: Partial<Record<"home" | "away", LeagueTeam>>;
    fixture: {
      home: { score: number | null; cas: number | null; conceded: boolean };
      away: { score: number | null; cas: number | null; conceded: boolean };
      finishedAt?: string; resultEdit?: { by?: string; at: string }; deadlineOutcome?: FixtureDeadlineOutcome;
    };
    afterHash: string;
  };
}

// ---- Fixture deadlines (spec-main-landing-nav §2.2, ruling §6(d); deadlines.ts) ----

/**
 * review = "Overdue, needs organiser decision" (no score, the default); no-result = the fixture counts nowhere;
 * both-lose = both sides take a loss (stored as a 0-0 with both sides conceded, so standings count it as they already do).
 */
export type DeadlineOutcome = "review" | "no-result" | "both-lose";

/** A round's deadline, set by an organiser per phase and round (UTC ISO). */
export interface RoundDeadline { phaseId: string; round: number; deadline: string }

/** Season setting: auto-forfeit unplayed fixtures after their deadline (absent = off; ruling §6(d)). */
export interface DeadlinePolicy {
  autoForfeit: boolean;
  outcome: DeadlineOutcome;
  updatedBy?: string;
  updatedAt?: string;
}

export interface FixtureDeadlineOutcome {
  outcome: DeadlineOutcome;
  /** true = applied by the auto-forfeit job (an organiser extending the deadline lifts it); unset = an organiser's decision. */
  auto?: true;
  /** The organiser who decided (organiser decisions only). */
  by?: string;
  at: string;
  /** The effective deadline that had passed (or was in force) when this was applied. */
  deadline?: string;
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

/**
 * The fixture's fork team copies are being (or were) removed: the files, their library rows and a fork reload
 * (forkCleanup.ts). Written "pending" before any file is touched, so a crash or restart resumes it; "failed" retries with
 * a backoff on the sync tick. While a marker exists the copies are treated as gone: a fixture generated again (play
 * allowed again after a cancel) rebuilds both teams and clears it.
 */
export interface FixtureForkCleanup {
  state: "pending" | "removed" | "failed";
  /** Why the copies are no longer needed. */
  reason: string;
  since: string;
  attempts: number;
  lastAttemptAt?: string;
  /** failed: not retried before this time. */
  nextAttemptAt?: string;
  /** failed: the last error. */
  error?: string;
  removedAt?: string;
  /** Fork team ids removed. */
  removed?: string[];
  /** Fork team ids left in place because another fixture still needs them (that fixture removes them later). */
  kept?: string[];
}

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
  /** A finished game whose result arrived while a team was redrafting (redraftWindow.ts): held, not applied. The timer
   *  leaves it alone; an organiser's "Check for a result" applies it once neither team is blocked any more. */
  redraftHold?: { at: string; gameId: string; reason: string };
  /** Removal of this fixture's fork team copies once the match is over (forkCleanup.ts, owner 11-03). */
  cleanup?: FixtureForkCleanup;
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
  /** Read model only (standings.ts): the team's last results in this table, oldest first, at most six. */
  latest?: Array<"W" | "D" | "L">;
}

/** Tiebreak keys a phase may name (standings.ts orderRows). headToHead = points from the games among the tied teams. */
export type TiebreakKey = "points" | "tdDiff" | "casDiff" | "headToHead" | "tdFor" | "casFor" | "wins" | "name";
/** Optional stat columns a table carries (only when the results recorded them). */
export type StandingsStat = "completions" | "interceptions" | "injuries" | "deaths" | "fouls";

export interface LeaguePhase {
  id: string;
  category: string;
  name: string;
  groups: string[];
  standings: StandingRow[];
  /** Fixture-only phases whose games count in this phase's standings (e.g. Interdivision in Regular). */
  includes?: string[];
  /** Table (league games, the default) or knockout (playoff bracket): set only by an organiser (PATCH .../phases/:phaseId). */
  format?: "table" | "knockout";
  /** Points per result for computed standings (absent = W3 D1 L0, standings.ts DEFAULT_POINTS). */
  points?: { win: number; draw: number; loss: number };
  /** Tiebreak order for computed standings (absent = points, TD diff, CAS diff, head-to-head, name). */
  tiebreaks?: TiebreakKey[];
  /** Read model only (standings.ts): the table is the TourPlay export's, or computed from the results. */
  standingsSource?: "computed" | "imported";
  /** Read model only: the optional stat columns this table carries. */
  standingsStats?: StandingsStat[];
  /** Read model only: the table's divisions in order, including ones with no team scheduled yet. */
  standingsGroups?: string[];
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
  /** Active (true) or standby: the TourPlay export's value, then the organiser's (Participants tab, participants.ts). */
  active: boolean;
  /** Participants tab flags set by an organiser (participants.ts; absent = false). Organiser-only: the public read drops them. */
  paid?: true;
  rosterVerified?: true;
  frozen?: true;
  checkedIn?: true;
  /** Who changed the participant flags last, and when (anonymised on account deletion). */
  flagsUpdated?: { by: string; at: string };
  /** Who last changed `paid`, and when (organiser-only like the flag; anonymised on account deletion). */
  paidUpdated?: { by: string; at: string };
  /** An organiser set active / standby on this site (the TourPlay export's value alone means nothing: it marks every row inactive). */
  activeSet?: true;
  /** The season team this row belongs to, pinned by the Participants tab (participants.ts participantOf). */
  teamId?: string;
  /** Created by the Participants tab for a roster team the export did not list (kept on re-import while the team exists). */
  addedHere?: true;
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
  /** A league-play Team Captain appointment: the skills the captaincy granted free ("Team Captain", plus "Pro" unless already owned). */
  captainGrants?: string[];
  /** Injuries an organiser recorded on the team page (teamOps.ts INJURIES): what and when. `by` never leaves the server in a
   *  public read. A lasting injury's stat change is already applied to the stats above. */
  injuries?: PlayerInjuryRecord[];
  /**
   * The team's played-game count when an organiser (or an injury) set missNextGame on the team page: once the team has
   * played more games than this, the player has served it and the flag clears (teamOps.ts settleServedMng).
   */
  mngGames?: number;
  /** What a coach paid for this player on the team page (a pre-game firing refunds exactly this, never the valuation). */
  purchasePrice?: number;
  /** An advancement roll waiting for the coach's pick (teamAdvance.ts): its SPP is already spent, and the same choices come
   *  back until one is taken. Coach and organisers only: never in a public read (teamOps.ts publicTeam). */
  pendingAdvance?: PendingAdvance;
  /** The dice log ids of the advancement rolls saved on this player (the last 20): a logged roll whose id is missing here
   *  never reached the season and is restored from the log, not rolled again (teamAdvance.ts unsavedRoll). */
  advanceRolls?: string[];
}

/**
 * A rolled advancement awaiting the coach's choice (spec-forfeit-and-dice-2026-11-02, Q7). One per player at a time.
 *  - randomPrimary: the two skills the category table gave (`choices`), the 2D6 rolls behind them (rerolls included);
 *  - characteristic: the D8 (`roll`), the characteristics it lets this player improve (`choices`), and the skills the
 *    coach may take instead ("Choose Skill": `skills.primary` / `skills.secondary`).
 */
export interface PendingAdvance {
  /** The dice log roll id (src/dice/log.ts, the team's `tm-` log). */
  id: string;
  kind: "randomPrimary" | "characteristic";
  at: string;
  by: string;
  /** An organiser rolled on the coach's behalf. */
  admin?: true;
  /** SPP spent on the roll (charged when it was rolled; never again). */
  cost: number;
  /** The player's advancement count when rolled (the rank the pick reaches is count + 1). */
  count: number;
  category?: string;
  rolls?: Array<{ dice: [number, number]; skill: string; rerolled?: true }>;
  roll?: number;
  choices: string[];
  skills?: { primary: string[]; secondary: string[] };
}

/** One recorded injury (team page v2). */
export interface PlayerInjuryRecord { type: string; at: string; by?: string }

/** A player who appears in the season honours but not on the final roster (dead, fired, retired). */
export interface FormerPlayer extends PlayerIdentity {
  name: string;
  position: string;
  level: string;
  stats: PlayerSeasonStats;
  /** The skills the player had when they left (a departed Team Captain keeps the trait and its Pro here). Absent on older rows. */
  skills?: string[];
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
  /**
   * The Team Captain left the roster (killed, defected, not re-hired) and no new one is appointed yet (owner 10-30; set
   * and cleared by leagues/captain.ts markCaptainVacancy on every roster write, cleared by an appointment).
   */
  captainVacant?: true;
  /** The Team Captain's playerId while one is known (leagues/captain.ts): survives a re-import that omits skills. */
  captainPlayerId?: string;
  /**
   * Team status in the league (team page v2, organisers' cog): absent = active. An inactive team leaves the standings
   * (opponents keep their earned results) and is listed under "Inactive"; its unplayed fixtures are never cancelled by
   * this flag alone (the organiser decides each one: LeagueFixture.inactiveDecision).
   */
  status?: "inactive";
  /** Who last changed the status, and when. */
  statusChanged?: { by: string; at: string };
  /** Edit history (team page v2): coach and organiser edits, status changes, fixture decisions. Coach and organisers only:
   *  never in a public read (teamOps.ts publicTeam). Newest first, capped. */
  history?: TeamHistoryEntry[];
  /**
   * Identity for the team library lane (spec-team-management 11-02; teamOps.ts ensureTeamIdentity has the full note):
   * teamUid = the team itself (owned by its coach, the same across seasons and, later, leagues); entryId = this league
   * season's slot the team fills (standings and fixtures belong to the entry; a later swap changes the entry's team).
   */
  teamUid?: string;
  entryId?: string;
  /** The explicit redraft link (redraft.ts buildDraftTeam): the season this roster was drafted from. A redrafted team is
   *  past its first game whatever its roster (team page v2 in-season rules). */
  redraftedFrom?: { seasonId: string };
  /** League registration (lane L6): the registration entry this team was created from on acceptance, and the coach's
   *  library team it came from (when one was used: its teamUid follows that library team across seasons). */
  registrationId?: string;
  libraryTeamId?: string;
  /**
   * Available for Takeover (team library lane): a league organiser or a site admin listed the team; coaches (members or
   * not) apply through the registration core (takeover.ts). `id` names the listing (a fresh one each time it is listed),
   * `by` never leaves the server in a public read.
   */
  takeover?: { id: string; since: string; by?: string; note?: string };
  /**
   * The entry's history (team library lane): the teams and coaches that held this season slot, oldest first, each with
   * the entry's game numbers it covers ("Team A (games 1-5), Team B (games 6-)"). Written by a swap, an approved
   * application or a takeover; absent = the team has held the entry all season. `outgoing` (the replaced roster, kept so
   * nothing is lost) stays with the coach and organisers.
   */
  entryHistory?: EntrySpan[];
  /** An organiser asked to swap in one of the coach's PRIVATE teams (a save or library team the coach never shared): the
   *  coach approves or declines it (teamLibraryApi.ts). The ref names the coach's own team; organisers never see its
   *  contents. Coach and organisers only: never in a public read. */
  swapRequest?: { id: string; ref: string; by: string; at: string };
}

/** One holder of a league entry (LeagueTeam.entryHistory). */
export interface EntrySpan {
  name: string;
  race: string;
  coach: string;
  coachId?: string;
  /** The team's lineage id (teamOps.ts). */
  teamUid?: string;
  /** First game of the entry this holder played (1-based); toGame unset = still holding it. */
  fromGame: number;
  toGame?: number;
  /** How this holder came in: "start" = held it from the beginning; swap = an organiser swapped the team in; apply = an
   *  approved takeover application with the coach's own team; takeover = the coach took the team over. */
  via: "start" | "swap" | "apply" | "takeover";
  at: string;
  by?: string;
  /** The replaced team as it was when it left the entry (private: coach and organisers only). */
  outgoing?: LeagueTeam;
}

/** One team history line: what changed (old -> new), who, when. */
export interface TeamHistoryEntry {
  at: string;
  by: string;
  kind: "coach-edit" | "organiser-edit" | "status" | "fixture-decision" | "forfeit" | "advancement" | "swap" | "takeover";
  changes: Array<{ what: string; from?: string; to?: string }>;
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
  /** Written by Finish season (the podium); removed again when the season is reopened. */
  podium?: true;
}

export type PodiumSlot = "champion" | "runnerUp" | "consolation";

/**
 * The podium Finish season crowned (standings.ts proposePodium; the places themselves are the podium awards). Team refs
 * only (team id, or name:<team>): coach names live on the awards, which the privacy anonymiser already covers.
 */
export interface SeasonPodium {
  /** How the final podium was decided: the playoff final, the final standings, the organiser's override, the import's awards. */
  decidedBy: "playoff" | "standings" | "organiser" | "imported" | "none";
  /** What the site proposed, by team ref. */
  proposed: Partial<Record<PodiumSlot, string>>;
  /** What was crowned, by team ref. */
  final: Partial<Record<PodiumSlot, string>>;
  /** The organiser changed the proposal. */
  overridden: boolean;
  by: string;
  at: string;
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
  /** Last time a result was entered, edited, cleared or applied on this site (standings.ts: an imported season with a newer result is recomputed). */
  resultsChangedAt?: string;
  /** Set by Finish season; cleared by Reopen. */
  podium?: SeasonPodium;
  /** Bumped by the store on every write (results, fixtures, redraft application...): the stats cache keys on it. */
  revision?: number;
  /** "manual" = started from League settings (Start a new season). */
  source: "tourplay-export" | "manual";
  rules?: SeasonRules;
  /** Lane L5: setup -> registration -> active -> completed (lifecycle.ts seasonStage); absent = derived from status. */
  stage?: "setup" | "registration" | "active";
  /** Per-season registration settings (Q7; seasonRegistration.ts), copied from the league defaults when the season is made;
   *  absent = the league's Registrations settings. */
  registration?: import("./seasonRegistration.js").SeasonRegistration;
  /** Round deadlines (organiser, per phase and round): a fixture without its own deadline takes its round's. */
  roundDeadlines?: RoundDeadline[];
  /** Auto-forfeit after the deadline (absent = off). */
  deadlinePolicy?: DeadlinePolicy;
  /** The off-season redraft run FROM this (finished) season: see redraft.ts. */
  redraft?: RedraftState;
  /** League news posted during this season (stored in posting order; reads sort pinned first, newest first). */
  news?: LeagueNewsPost[];
  /** Season activity log (fixtures created / deleted, matches started, results), newest first, capped: see events.ts. */
  log?: LeagueEventEntry[];
  /** Read model only (api.ts seasonForViewer): the season's payment links and entry fee, plus the viewer's own entries'
   *  paid status (`mine`, signed-in coaches only). Absent when there is nothing to show. */
  payment?: SeasonPaymentView;
  /** League registration (lane L6, src/leagues/registration.ts): every coach's entry for this season, in any state.
   *  Organisers and the entry's coach only: never in a season read (api.ts seasonForViewer drops it). Accepting an entry
   *  creates its LeagueTeam in the same season write. */
  registrations?: import("./registration.js").LeagueRegistrationRow[];
  /** Takeover applications (team library lane, takeover.ts), every listing's, in any state. Organisers and the applicant
   *  only: never in a season read (api.ts seasonForViewer drops it). */
  takeoverApplications?: import("./takeover.js").TakeoverApplicationRow[];
}

/** What the league page's "Pay entry fee" block shows (api.ts seasonForViewer). */
export interface SeasonPaymentView {
  entryFee?: string;
  payPal?: string;
  venmo?: { handle: string; url: string };
  /** The viewer's own teams in the season and whether an organiser marked each one paid. Never anyone else's. */
  mine?: Array<{ teamId: string; team: string; paid: boolean }>;
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

export type LeagueEventKind = "fixture-created" | "fixture-deleted" | "match-started" | "match-result" | "team-coach" | "team-value-diff" | "team-value-unresolved" | "fixture-deadline" | "forfeit" | "defection";

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
  /** played x per game + wins x per win + draws x per draw (+ losses x per loss); 20k / 20k / 10k / 0 by default. */
  bonus: number;
  raw: number;
  capped: number;
  /** Losses (counted when the formula pays for them). Absent on budgets made before 11-02. */
  losses?: number;
  /** The amounts this budget used (redraftRules.ts). Absent on budgets made before 11-02 (= the defaults). */
  amounts?: RedraftAmounts;
}

/** The per-result amounts of the redraft formula, in gold. */
export interface RedraftAmounts { perGame: number; perWin: number; perDraw: number; perLoss: number }

/**
 * Redraft budget formula and options (owner 11-02): a league default in League settings; a ladder may override it later
 * (redraftRules.ts effectiveRedraftRules takes the override as its last layer).
 */
export interface RedraftRules extends RedraftAmounts {
  /** Starting amount in gold; null = the roster's initial treasury (the receiving season's Team building table, else 1,000,000). */
  base: number | null;
  /** Agent fee per season a re-hired player has taken part in. */
  agentFee: number;
  capEnabled: boolean;
  cap: number;
  /** The set budget: a team that earned less may be lifted to it (budget = max(earned, set)). */
  setBudget: number;
  /** Lift every team below the set budget automatically when a redraft opens. */
  liftToBudget: boolean;
  /** Redraft window length in days (no play while it is open). */
  windowDays: number;
}

/** A lift of a team's redraft budget to the set budget (organiser's Lift to budget, or automatic when the redraft opened). */
export interface RedraftLift { to: number; by: string; at: string; auto: boolean }

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
  /** Lifted to the set budget (spendable = max(earned, lift.to) unless an override is set). */
  lift?: RedraftLift;
  /** The window closed before a valid draft list: the team may not play until the coach submits one. */
  needsRedraft?: { at: string; reason: string };
  /** Rebuilt from the current roster when the window closed (no list submitted in time). */
  auto?: true;
}

export interface RedraftLogEntry {
  at: string;
  by: string;
  text: string;
  /** The team the entry is about (lifts, overrides, window outcomes): the team summary's redraft history. */
  teamId?: string;
}

/** The redraft window (owner 11-02, the gate stub): no play from opensAt to closesAt; the job notes what it has done. */
export interface RedraftWindow {
  opensAt: string;
  closesAt: string;
  /** Coaches told the window is open. */
  openNotifiedAt?: string;
  /** Coaches still drafting reminded 24 h before the close. */
  reminderAt?: string;
  /** The close started: rebuilt lists and needs-redraft marks are journalled on the tasks (redraftWindow.ts). */
  closing?: string;
  /** The close was processed (teams rebuilt or marked needs redraft). */
  processedAt?: string;
}

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
  /** The formula and options the redraft opened with (redraftRules.ts); absent on redrafts confirmed before 11-02. */
  rules?: RedraftRules;
  /** Absent on redrafts confirmed before 11-02 (no window, no play block). */
  window?: RedraftWindow;
}
