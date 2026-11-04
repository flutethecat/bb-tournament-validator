/**
 * League ladders (spec-league-ladder-2026-11-02, lane 8b): the stored shape. A ladder is a competition inside a league,
 * alongside its seasons. It is stored as a SeasonRecord with `competition: "ladder"` and this `ladder` block, in the
 * league's seasons/ directory (id `ladder-<n>`), so its teams, fixtures, results, the tabletop recorder, Super FUMBBL play,
 * team pages, progression and account export / deletion all work exactly as for a season. LeagueStore.seasons() leaves
 * ladders out (every season-only path is unchanged); LeagueStore.ladders() / competitions() read them.
 *
 * Lifecycle (derived, lifecycle.ts): setup = season.stage "setup" (organisers only), active = stage "active", closed =
 * status "completed".
 *
 * Privacy: nothing here stores a coach name or id. Challenges, members and rounds point at team ids only (the team rows
 * carry the coach, which account deletion already anonymises); registrations are the season's rows.
 */
import type { RedraftRules } from "./types.js";

export type LadderRanking = "rating" | "points" | "position";
export const LADDER_RANKINGS: readonly LadderRanking[] = ["rating", "points", "position"];
/** league = teams progress (SPP, injuries, winnings); tournament = the roster resets to what joined after every game, new teams only. */
export type LadderStyle = "league" | "tournament";
export type LadderState = "setup" | "active" | "closed";

export interface LadderDeclineRule {
  enabled: boolean;
  /** Declines (expiries count too while the rule is on) within `days` that count as one loss. */
  count: number;
  days: number;
}

/** What starts a ladder redraft window (spec "Redraft" 11-02). The window length and budget come from the league's redraft
 *  rules with the ladder's override (`rules`) as the last layer (redraftRules.ts effectiveRedraftRules). */
export interface LadderRedraftSettings {
  /** period-end (default): each period end opens a window; schedule: the fixed dates below; games: a team after N games. */
  trigger: "period-end" | "schedule" | "games";
  /** Fixed schedule: window start dates (UTC ISO). */
  schedule: string[];
  /** Per team: a team that has played this many ladder games since it joined (or last redrafted) must redraft. */
  everyGames: number;
  /** Optional TV cap (gold); null = off. A team over it must redraft before its next challenge. */
  tvCap: number | null;
  /** The ladder's override of the league redraft rules (budget formula, window days...). */
  rules?: Partial<RedraftRules>;
}

/** Titles and belts (spec rounds 4-5): a LATER lane. Shaped here so the data needs no migration; nothing reads it yet. */
export interface LadderTitleSettings {
  belt: boolean;
  /** Champion bonuses in points: +defence per successful defence, +weekHeld per full week, +winBelt for taking it. */
  bonuses: { defence: number; weekHeld: number; winBelt: number; moneyInTheBank: number };
  /** Mandatory challenger window in days (the #2 v #3 eliminator, then the champion's mandatory defence). */
  mandatoryDays: number;
  rumble?: { field: "top8" | "open"; titleShot: boolean; points: number };
}

export interface LadderSettings {
  ranking: LadderRanking;
  style: LadderStyle;
  /** Rating ladders: games before a team is ranked. */
  minGames: number;
  /** Points ladders (and the points column elsewhere): per result. */
  points: { win: number; draw: number; loss: number };
  /** Places above (position ladders: only upward). null = any team. */
  challengeRange: number | null;
  /** Unanswered challenges a coach may have, issued plus received. */
  maxOpen: number;
  /** An unanswered challenge expires after this many hours. */
  expiryHours: number;
  /** An accepted challenge must be played within this many days (organiser-set deadline); unplayed = discarded. */
  playByDays: number;
  /** The same two teams may not meet again (play or challenge) for this many days after their last game. */
  rematchDays: number;
  declineRule: LadderDeclineRule;
  /** Teams built and validated in the Roster Builder for this ladder join straight away (organiser gets a note). */
  autoApproveValidated: boolean;
  /** Optional periods (days); null = no periods. A period end is the default redraft trigger and, later, period honours. */
  periodDays: number | null;
  /** Optional scheduled end (UTC ISO): challenges stop, open fixtures are discarded, the ranking freezes. */
  endsAt?: string;
  redraft: LadderRedraftSettings;
  /** The later titles lane. */
  titles?: LadderTitleSettings;
}

export type LadderChallengeState = "open" | "accepted" | "declined" | "expired" | "withdrawn" | "played" | "discarded";

export interface LadderChallenge {
  id: string;
  challengerTeamId: string;
  defenderTeamId: string;
  /** Stored state; reads derive expired / played / discarded from the clock and the fixture (ladder.ts challengeState). */
  state: LadderChallengeState;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string;
  /** The ladder fixture an accepted challenge became. */
  fixtureId?: string;
  /** The play-by deadline (UTC ISO), copied onto the fixture. */
  deadline?: string;
  /** When the job closed it (expired / discarded / played) and why (shown to both coaches). */
  closedAt?: string;
  reason?: string;
  /** Ranks when issued (position ladders: the swap is judged at the result). */
  ranks?: { challenger: number; defender: number };
  /** Notices already sent for this challenge (written before sending, so each goes once). */
  told?: string[];
}

/** A scheduled round (spec round 5: "open challenges but some matches must be scheduled"). */
export interface LadderRound {
  id: string;
  number: number;
  name: string;
  deadline?: string;
  fixtureIds: string[];
  createdAt: string;
}

export interface LadderMember {
  teamId: string;
  joinedAt: string;
  /** How it joined: a validated Roster Builder team (auto-approved), an organiser's approval, or a move from a season / ladder. */
  via: "validator" | "organiser" | "move";
  /** A move out (to a season or another ladder): the team row stays for the record, the member leaves the ranking. */
  leftAt?: string;
  movedTo?: { kind: "season" | "ladder"; id: string; teamId: string };
  /** Tournament-style ladders: the roster as it joined (reset after every game) and the last result it was reset after. */
  reset?: { roster: unknown; after?: string };
  /** Redraft (per-team trigger): games counted from here. */
  redraftedAt?: string;
}

/** A redraft window the ladder job opened (period end or fixed schedule): processed once. */
export interface LadderRedraftWindowRecord { opensAt: string; closesAt: string; processedAt?: string }

/** Points given outside results (the titles lane's champion bonuses): the points ranking adds them. Empty in this lane. */
export interface LadderPointAward { teamId: string; points: number; reason: string; at: string }

export interface LadderRecord {
  settings: LadderSettings;
  /** Copied from the current season / league at creation, editable (spec Q6). */
  playOnFork: boolean;
  rulesetPackage?: string;
  houseRules?: import("../competition/houseRules.js").HouseRules;
  description?: string;
  challenges: LadderChallenge[];
  rounds: LadderRound[];
  members: LadderMember[];
  redraftWindows?: LadderRedraftWindowRecord[];
  pointAwards?: LadderPointAward[];
  /** The creation wizard's progress (General -> Rules -> Ladder settings -> Review). */
  wizard?: { step: number; completedAt?: string };
  startedAt?: string;
  closedAt?: string;
  /** Gates (lane 8c): "Opens at" for ladder challenges after a redraft / period end. Off (absent) by default; no UI yet. */
  gates?: { challenges?: { opensAt: string; eventId?: string } };
  /** Titles lane (later): the belt holder and history, interim champion, Rumble events. Never written in this lane. */
  belt?: { holderTeamId: string; since: string; defences: number; interim?: boolean };
  rumbles?: Array<{ id: string; date: string; field: "top8" | "open"; tournamentId?: string }>;
  /** Closed with the scheduled end: who / why. */
  closedReason?: string;
}

/**
 * Clubs (not built yet): whether ladder games count toward a club's stats is a CLUB setting, default off (spec Q9). The
 * clubs lane stores this on the club; ladder fixtures carry `ladder` so it can tell them apart.
 */
export interface ClubLadderSetting { ladderGamesCount: boolean }
export const DEFAULT_CLUB_LADDER_SETTING: Readonly<ClubLadderSetting> = Object.freeze({ ladderGamesCount: false });
