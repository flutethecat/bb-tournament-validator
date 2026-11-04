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

/** Titles and belts (spec rounds 4-5, ladderTitles.ts). Off by default: a ladder with the belt on ranks by points. */
export interface LadderTitleSettings {
  belt: boolean;
  /** Champion bonuses in points: +defence per successful defence, +weekHeld per full week, +winBelt for taking it in a game,
   *  +moneyInTheBank on top of winBelt for winning a cash-in, +rumble for winning a Rumble. All editable. */
  bonuses: { defence: number; weekHeld: number; winBelt: number; moneyInTheBank: number; rumble: number };
  /** The champion must play the mandatory challenger within this many days, or the title passes to the challenger. */
  mandatoryDays: number;
  /** The #2 v #3 eliminator (and the vacant / interim title games) must be played within this many days. */
  eliminatorDays: number;
  /** Voluntary defences: only the top N of the ranking may challenge the champion. */
  defenceRange: number;
  /** No defence for this many days: the champion gets a reminder; graceDays later the title is vacated. */
  inactivityDays: number;
  graceDays: number;
  /** Money in the Bank (off by default): a title-shot contract from an N-win streak or an organiser event. */
  mitb: { enabled: boolean; streak: number; cashInDays: number; playHours: number };
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
  /** Titles and belts (ladderTitles.ts); absent = the defaults (belt off). */
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

/** Points an organiser gave outside results: the points ranking adds them (the champion bonuses are derived, ladderTitles.ts). */
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
  /** Titles (ladderTitles.ts): a mirror of the current champion the job keeps (the title replay is the authority). */
  belt?: { holderTeamId: string; since: string; defences: number; interim?: boolean };
  /** Titles: stored decisions (crowned / vacated / inactive / returned...), the title games set up, the title-shot contracts and
   *  the notices already sent. Reigns, defences and bonuses are derived from these plus the results (titleReplay). */
  titles?: LadderTitlesRecord;
  /** Rumble events (one-off knockouts inside the ladder, ladderTitles.ts). */
  rumbles?: LadderRumble[];
  /** Period honours already written (period number), so each period end is honoured once. */
  periodHonours?: number[];
  /** Closed with the scheduled end: who / why. */
  closedReason?: string;
}

/**
 * Clubs (not built yet): whether ladder games count toward a club's stats is a CLUB setting, default off (spec Q9). The
 * clubs lane stores this on the club; ladder fixtures carry `ladder` so it can tell them apart.
 */
export interface ClubLadderSetting { ladderGamesCount: boolean }
export const DEFAULT_CLUB_LADDER_SETTING: Readonly<ClubLadderSetting> = Object.freeze({ ladderGamesCount: false });

// ---- titles (ladderTitles.ts) ------------------------------------------------------------------------------------------------

export type TitleEventKind = "crowned" | "vacated" | "inactive" | "returned" | "interim-crowned";

/** A stored title decision: an organiser's, or the job's at a deadline (unplayed mandatory, eliminator fallback, inactivity). */
export interface TitleEvent {
  id: string;
  kind: TitleEventKind;
  at: string;
  teamId?: string;
  /** organiser / the job's rule ("mandatory-unplayed", "inactivity", "left", "fallback"). */
  by: "organiser" | "job";
  reason: string;
}

export type TitleBoutKind = "eliminator" | "mandatory" | "vacant" | "cashin" | "shot" | "interim" | "unification";
/** What a ladder fixture is for the titles: a title bout kind, a voluntary defence (an accepted challenge to the champion) or a Rumble game. */
export type TitleFixtureKind = TitleBoutKind | "defence" | "rumble";

/** A title game the ladder set up (a ladder fixture marked with the kind; home = the champion or the higher-ranked side). */
export interface TitleBout {
  id: string;
  kind: TitleBoutKind;
  homeTeamId: string;
  awayTeamId: string;
  createdAt: string;
  deadline: string;
  fixtureId: string;
  contractId?: string;
  /** Stored by the job / a write: scheduled until it is played, lapses at its deadline, or is cancelled. */
  state: "scheduled" | "played" | "lapsed" | "cancelled";
  closedAt?: string;
  /** Who went through (eliminator / vacant / interim), and how: the result, or the higher-ranked side at the deadline. */
  winnerTeamId?: string;
  how?: "result" | "fallback";
  note?: string;
}

/** A title-shot contract: Money in the Bank (a win streak or an organiser event) or a Rumble prize. */
export interface TitleContract {
  id: string;
  teamId: string;
  source: "streak" | "organiser" | "rumble";
  earnedAt: string;
  expiresAt: string;
  /** The cash-in game (one at a time); cleared again if the game lapsed unplayed while the contract is still valid. */
  boutId?: string;
  usedAt?: string;
  /** The fixture that completed the streak (streak contracts: never earned twice from one streak). */
  fromFixtureId?: string;
  note?: string;
}

export interface LadderTitlesRecord {
  events: TitleEvent[];
  bouts: TitleBout[];
  contracts: TitleContract[];
  /** When the belt / Money in the Bank were last switched on (streaks count from then). */
  beltOnAt?: string;
  mitbOnAt?: string;
  /** Notices already sent (markers), so each goes once across restarts. */
  told: string[];
}

export interface LadderRumbleMatch {
  slot: number;
  homeTeamId: string;
  awayTeamId?: string;
  fixtureId?: string;
  winnerTeamId?: string;
  how?: "result" | "bye" | "fallback";
}

/** A Rumble (spec round 5): an organiser-dated quick knockout inside the ladder; its games are ladder fixtures, the bracket is the
 *  tournament engine's knockout pairing. The winner gets a title-shot contract and the points set here. */
export interface LadderRumble {
  id: string;
  name: string;
  /** When the field is fixed and round 1 is drawn. */
  date: string;
  field: "top8" | "open";
  /** Days to play each round. */
  roundDays: number;
  points: number;
  createdAt: string;
  by: string;
  /** Open entry: the teams entered. */
  entries: string[];
  state: "entry" | "running" | "finished" | "cancelled";
  /** Seeded field (team ids, seed 1 first) once drawn. */
  seeds?: string[];
  rounds: Array<{ number: number; deadline: string; matches: LadderRumbleMatch[] }>;
  winnerTeamId?: string;
  finishedAt?: string;
  contractId?: string;
  note?: string;
}
