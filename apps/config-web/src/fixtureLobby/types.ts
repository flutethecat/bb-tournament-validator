/**
 * Fixture lobby (spec-landing-bubble-retro-2026-10-29 §8-§9.3): one lobby per fixture where the two coaches chat, lock
 * their rosters and pre-match inducements, press Ready and start their game. The core (core.ts, store.ts, api.ts) knows
 * nothing about where the fixture comes from: a source adapter (league.ts today; tournaments later) turns its fixture
 * into a LobbyFixture.
 *
 * Stored per fixture (store.ts): the two sides' lobby state, the Auto-Buy hold, the start record and the chat. Presence
 * is memory only (presence.ts).
 */
import type { EffectiveInducement } from "../leagues/inducementRules.js";
import type { InducementOffers } from "../tabletop/pregame.js";
import type { TabletopTeamFile } from "../tabletop/postMatch.js";

export type LobbySide = "home" | "away";
export const LOBBY_SIDES: readonly LobbySide[] = ["home", "away"];
export const otherSide = (s: LobbySide): LobbySide => (s === "home" ? "away" : "home");

/** One pick: a standard / custom inducement id with a count, or a star player `star:<name>` (count 1). */
export interface LobbyPick { id: string; qty: number }

export interface LobbySideState {
  picks: LobbyPick[];
  /** The list is locked (immutable for the coach; an organiser may unlock). */
  locked: boolean;
  lockedAt?: string;
  /** Underdog only: "buy exactly this list at launch if the overdog spends nothing" (§9.1). */
  autoBuy: boolean;
  rosterLocked: boolean;
  /** Tabletop fixtures: the coach's recorder team (library:<id> or a Roster Builder save id) locked with the roster. */
  teamRef?: string;
  ready: boolean;
  /** Last change to this side: who, when, and whether an organiser made it for the coach. */
  by?: string;
  at?: string;
  admin?: true;
}

export interface LobbyChatMessage {
  id: string;
  /** The coach who wrote it ("" on a system line). */
  from: string;
  text: string;
  at: string;
  /** A system line (lock, Auto-Buy, hold, start): `from` names the coach it is about, if any. */
  system?: true;
  /** System lines: the coach who did it, for the {actor} token (templates never hold names). */
  actor?: string;
  /** Who the writer is in this fixture (seat colour of the bubble). */
  role?: LobbySide | "organiser";
}

/** START held for the underdog's inducement pick (§9.1 step 3, §9.2, §9.3). */
export interface LobbyHold {
  at: string;
  underdog: LobbySide;
  /** What the overdog spent from treasury (its list is final from here on and visible to the underdog). */
  overdogSpend: number;
  /** The underdog's petty cash now (the TV gap plus the overdog's spend) and before (the gap alone). */
  pettyCash: number;
  was: number;
}

/** `prefilled`: how many of `qty` the team already had (Builder-bought, tournaments): paid in the Builder, so not charged. */
export interface ResolvedPick { id: string; name: string; qty: number; cost: number; prefilled?: number }
export interface ResolvedSide {
  picks: ResolvedPick[];
  total: number;
  /** Gold out of the treasury (the overdog's whole spend; the underdog's top-up beyond petty cash). */
  treasury: number;
  pettyCash: number;
}
export interface StarClash { name: string; kept?: LobbySide; removedFrom: LobbySide[]; refunded: boolean }
export interface LobbyResolution {
  home: ResolvedSide;
  away: ResolvedSide;
  /** The underdog's petty cash at launch and the overdog's treasury spend (§9.1 state machine). */
  pettyCash: number;
  treasurySpend: number;
  stars: StarClash[];
}

export interface LobbyRecord {
  schema: 1;
  /** `league:<leagueId>:<seasonId>:<fixtureId>` (or a tournament key later). */
  key: string;
  source: "league" | "tournament";
  /** The two coaches (fork account ids) when the lobby was created: the privacy export / delete link. */
  coaches: string[];
  revision: number;
  sides: Record<LobbySide, LobbySideState>;
  /** Set once START held for the underdog's pick: the overdog's list is final. */
  overdogFinal?: true;
  hold?: LobbyHold;
  resolved?: LobbyResolution;
  /** A START in flight (written before the match is created, so a crash never makes two). */
  starting?: { opId: string; at: string; by: string; resolution?: LobbyResolution };
  started?: { at: string; by: string; admin?: true; mode: LobbyMode; matchId?: string };
  chat: LobbyChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export type LobbyMode = "tabletop" | "fork";

/** Rules the lobby judges inducements by (league: season table; tournament: package flags). */
export interface LobbyRules {
  /** Coaches may spend treasury on inducements (§9.2: leagues on, tournaments off unless `inducements.treasuryTopUp`). */
  treasuryTopUp: boolean;
  /** Both sides picked the same star: Highlander keeps it with the side that locked first; else it leaves both teams. */
  highlander: boolean;
  /** A star removed at START is not charged (refund) or is lost (forfeit). */
  starClash: "refund" | "forfeit";
}

export interface LobbyTeam {
  id: string;
  name: string;
  race: string;
  /** Current team value (gold): the petty-cash gap is worked out from these. */
  tv: number | null;
  treasury: number;
  rerolls: number | null;
  apothecary: boolean;
  fans: number | null;
  assistantCoaches: number | null;
  cheerleaders: number | null;
  playerCount: number;
  /** The first few players (mini roster). */
  roster: Array<{ number: number | null; name: string; position: string; skills: string[]; spp: number }>;
  /** What the inducement offers judge (race, special rules, treasury). */
  file: TabletopTeamFile;
  /** Star players this team may hire (name + cost). */
  stars: Array<{ name: string; cost: number }>;
}

export interface LobbyCoachStats {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points?: number;
  tdPerGame: number;
  casPerGame: number;
  /** Last five outcomes, newest last. */
  form: Array<"W" | "D" | "L">;
}

export interface LobbyMeeting {
  at: string;
  event: string;
  home: { coach: string; team: string; score: number };
  away: { coach: string; team: string; score: number };
  cas: { home: number | null; away: number | null };
  /** SPA path of the match report, when there is one. */
  to?: string;
}

export interface LobbyHeadToHead {
  /** Wins of each side's coach, draws, and TD / CAS totals over every meeting. */
  wins: Record<LobbySide, number>;
  draws: number;
  td: Record<LobbySide, number>;
  cas: Record<LobbySide, number>;
  meetings: LobbyMeeting[];
}

export interface LobbyFixtureSide {
  /** The seat's fork account (empty when the side has no account yet). */
  coachId: string;
  coach: string;
  team: LobbyTeam;
  standing?: { rank: number; points: number; group: string };
  stats: { season: LobbyCoachStats; allTime: LobbyCoachStats };
}

/** Everything a source adapter tells the core about one fixture. */
export interface LobbyFixture {
  key: string;
  source: "league" | "tournament";
  mode: LobbyMode;
  /** Not played, not suspended (a lobby on a finished fixture is read-only). */
  open: boolean;
  closedReason?: string;
  header: {
    competition: string;
    season?: string;
    phase?: string;
    group?: string;
    round: number;
    /** Rounds in the competition (tournaments: "Round 2 of 5"). */
    rounds?: number;
    table?: number;
    date?: string;
    deadline?: string;
    ruleset: string;
  };
  links: { competition: string; fixture: string; standings: string; rules: string };
  sides: Record<LobbySide, LobbyFixtureSide>;
  rules: LobbyRules;
  /** Why the lobby has no inducement step ("" = it has one). */
  noInducements: string;
  offers: InducementOffers;
  ids: readonly string[];
  table: EffectiveInducement[];
  isOrganiser: (coach: string) => boolean;
  headToHead: LobbyHeadToHead;
  organisers: string[];
  /**
   * Tabletop fixtures: whether a recorder team (library team / Roster Builder save) IS this side's competition team.
   * Inducement budgets come from the competition team, so only that team may be locked for the recorder.
   */
  recorderTeamAllowed: (side: LobbySide, team: { ref: string; name: string; race?: string }) => boolean;
  /** How START creates the match: the recorder's fixtureRef and the extra createMatch fields (league season, league name). */
  start: { fixtureRef: string; extra: Record<string, unknown> };
  /**
   * Inducements the team already has (tournaments: bought in the Builder with the roster's gold). Shown pre-filled and
   * non-removable; they share the per-item caps with the coach's picks, cost nothing here and reach the reporter with
   * the resolved lists. Absent = none.
   */
  prefilled?: Record<LobbySide, LobbyPick[]>;
  /**
   * Tabletop fixtures that play a fixed team (tournaments: the entrant's submitted / snapshotted roster): the roster lock
   * takes it (no free choice of recorder team), or is refused with the reason. Absent = the coach picks a recorder team.
   */
  fixedTeams?: Record<LobbySide, { ref: string; name: string; race: string } | { error: string }>;
  /** The mini roster and the pre-filled list are for the two coaches and the organisers only (tournament snapshots). */
  rosterPrivate?: boolean;
  /** SPA path of each side's full roster (default: the competition page's team tab). */
  teamLinks?: Partial<Record<LobbySide, string>>;
}
