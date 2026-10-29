// League API shapes the SPA reads (server: src/leagues/types.ts + src/leagues/api.ts + src/leagues/stats.ts).

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
  [key: string]: unknown;
}

export interface LeaguePhase {
  id: string;
  category: string;
  name: string;
  groups: string[];
  standings: StandingRow[];
  includes?: string[];
}

export interface PlayerSeasonStats {
  td: number;
  cas: number;
  mvp: number;
  int: number;
  completions: number;
  fouls: number;
  injuries: number;
  sentOffs: number;
  spp: number;
  performance: number;
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
}

export interface FormerPlayer extends PlayerIdentity {
  name: string;
  position: string;
  level: string;
  stats: PlayerSeasonStats;
}

export interface LeagueTeam {
  id: string;
  name: string;
  race: string;
  coach: string;
  coachId?: string;
  teamValue: number | null;
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
  /** The league hides team composition from this viewer: players emptied, playerCount kept. */
  rosterHidden?: boolean;
  playerCount?: number;
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
}

export type StatsScope = "bb2020" | "bb2025" | "all";
export type LeaderStat = "td" | "cas" | "mvp" | "int" | "completions" | "fouls" | "spp";

export interface PlayerLeader { playerId: string; seasonId: string; name: string; position: string; team: string; race: string; coach: string; seasons: number[]; value: number }
export interface RecordLine { games: number; wins: number; draws: number; losses: number; points: number; tdFor: number; tdAgainst: number; casFor: number; casAgainst: number; winPct: number }
export interface CoachRecord extends RecordLine { coach: string; coachId?: string; seasons: number[]; teams: number; titles: number }
export interface TeamRecord extends RecordLine { team: string; race: string; coach: string; seasons: number[] }
export interface RaceRecord extends RecordLine { race: string; teams: number }
export interface BigWin {
  seasonId: string; season: number; phase: string; round: number; margin: number; playedAt?: string;
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
}

// ---- League settings (organisers; server: src/leagues/settings.ts LeagueSettingsView) ----

export type LeagueCountry = "US" | "CA";
export interface LeagueAddress { country: LeagueCountry; region: string; postcode: string; locality: string; street: string }

export interface LeagueRegistrations {
  allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
  allowRegistration: boolean;
  hideTeamComposition: boolean;
  maxRegistrations: number | null;
  maxPerRace: number | null;
}

export type DiscordEventKey = "news" | "fixtureCreated" | "matchStarted" | "matchResult" | "milestones";
export type DiscordEvents = Record<DiscordEventKey, boolean>;

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
  information: { name: string; fullName: string; description: string; ruleset: LeagueRuleset; mode: "individual"; address: LeagueAddress | null };
  permissions: { owner: string; organisers: string[]; admins: string[]; canEditOrganisers: boolean; canChangeOwner: boolean };
  registrations: LeagueRegistrations;
  connections: {
    playOnFork: boolean;
    discord: { configured: boolean; maskedUrl: string; events: DiscordEvents };
    naf: { available: false; note: string };
  };
  teamBuilding: { seasonId: string; seasonName: string; ruleset: LeagueRuleset; rules: TeamBuildingRules } | null;
  regions: Record<LeagueCountry, Array<{ code: string; name: string }>>;
  rulesets: LeagueRuleset[];
  eliteSkills: string[];
}
