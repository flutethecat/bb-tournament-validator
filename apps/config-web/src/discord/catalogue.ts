/**
 * The Discord event catalogue (creation wizards v2 Q8 + rounds 2b-5; league ladder spec Q8): every event a competition can
 * post, who it applies to, and its default per competition type. One toggle per event.
 *
 *   both        leagues (and their seasons / ladders) and tournaments
 *   league      leagues, seasons and ladders only
 *   tournament  tournaments only
 *   inGame      events from a RECORDED game only (the tabletop recorder's event log, a Super FUMBBL result): never invented
 *               (laws 15). Deaths and sent-offs post live by default; every other in-game event goes into the end-of-game
 *               digest unless the organiser switches it to live.
 *
 * The keys themselves are DISCORD_EVENT_KEYS (src/leagues/types.ts): a lane that adds an event adds its key there and a label
 * in src/leagues/discord.ts; an event without metadata here is treated as a league-only competition event, default on.
 */
import { DISCORD_EVENT_KEYS, type DiscordEventKey, type DiscordEvents } from "../leagues/types.js";

/** "league" covers a league and its seasons and ladders (the competition key is generic so ladders slot in later). */
export type CompetitionType = "league" | "tournament";
export type CompetitionKind = "league" | "season" | "ladder" | "tournament";
export const typeOfKind = (kind: CompetitionKind): CompetitionType => (kind === "tournament" ? "tournament" : "league");

/** ladder: league-type events that only a ladder (and the league, its fallback) shows; a season's settings hide them. */
export type EventScope = "both" | "league" | "tournament" | "inGame" | "ladder";

export const IN_GAME_KEYS = ["touchdown", "casualty", "injury", "death", "foul", "sentOff", "mvp", "hireFire"] as const;
export type InGameKey = (typeof IN_GAME_KEYS)[number];
export const isInGameKey = (k: string): k is InGameKey => (IN_GAME_KEYS as readonly string[]).includes(k);

interface EventMeta {
  scope: EventScope;
  /** Default for a league (and its seasons / ladders). */
  league: boolean;
  /** Default for a tournament: tournament mode ticks only the key events (owner round 2b / 3). */
  tournament: boolean;
}

const META: Partial<Record<DiscordEventKey, EventMeta>> = {
  published: { scope: "both", league: true, tournament: true },
  registrationOpened: { scope: "both", league: true, tournament: false },
  newRegistration: { scope: "both", league: false, tournament: false },
  registrationClosing: { scope: "both", league: true, tournament: true },
  checkInOpen: { scope: "tournament", league: false, tournament: true },
  roundPosted: { scope: "both", league: true, tournament: true },
  // Owner round 2b: match started ON for leagues, OFF for tournaments.
  matchStarted: { scope: "both", league: true, tournament: false },
  matchResult: { scope: "both", league: true, tournament: true },
  fixtureStart: { scope: "both", league: true, tournament: false },
  // Tournaments: the end-of-round summary (winners, upsets, top 3). Leagues: standings after each round (the Weekly Digest
  // carries the weekly standings, so this starts off for leagues).
  roundStandings: { scope: "both", league: false, tournament: true },
  finalStandings: { scope: "both", league: true, tournament: true },
  awards: { scope: "both", league: true, tournament: false },
  news: { scope: "both", league: true, tournament: false },
  fixtureCreated: { scope: "league", league: true, tournament: false },
  milestones: { scope: "league", league: true, tournament: false },
  // Redraft lane: each Rest & Relaxation roll (league only, off by default).
  redraftRolls: { scope: "league", league: false, tournament: false },
  seasonStarted: { scope: "league", league: true, tournament: false },
  seasonFinished: { scope: "league", league: true, tournament: false },
  // League Events: a new league night / draft / social... (each event's own "Post to Discord" starts ticked for league nights).
  leagueEvent: { scope: "league", league: true, tournament: false },
  // League ladders (spec Q8): challenge issued off, the rest on.
  ladderChallengeIssued: { scope: "ladder", league: false, tournament: false },
  ladderChallengeAccepted: { scope: "ladder", league: true, tournament: false },
  ladderResult: { scope: "ladder", league: true, tournament: false },
  ladderRankChanges: { scope: "ladder", league: true, tournament: false },
  // Ladder titles: all on by default (a ladder without a belt never has any of them).
  ladderBeltWon: { scope: "ladder", league: true, tournament: false },
  ladderBeltDefended: { scope: "ladder", league: true, tournament: false },
  ladderTitleVacated: { scope: "ladder", league: true, tournament: false },
  ladderMandatory: { scope: "ladder", league: true, tournament: false },
  ladderCashIn: { scope: "ladder", league: true, tournament: false },
  ladderInterim: { scope: "ladder", league: true, tournament: false },
  ladderRumble: { scope: "ladder", league: true, tournament: false },
  ladderHonours: { scope: "ladder", league: true, tournament: false },
  touchdown: { scope: "inGame", league: true, tournament: false },
  casualty: { scope: "inGame", league: true, tournament: false },
  injury: { scope: "inGame", league: true, tournament: false },
  death: { scope: "inGame", league: true, tournament: false },
  foul: { scope: "inGame", league: true, tournament: false },
  sentOff: { scope: "inGame", league: true, tournament: false },
  mvp: { scope: "inGame", league: true, tournament: false },
  hireFire: { scope: "inGame", league: true, tournament: false },
};

const FALLBACK: EventMeta = { scope: "league", league: true, tournament: false };
export const eventMeta = (k: DiscordEventKey): EventMeta => META[k] ?? FALLBACK;

/** Does this event apply to a competition of this type? */
export function appliesTo(k: DiscordEventKey, type: CompetitionType): boolean {
  const s = eventMeta(k).scope;
  return s === "both" || s === "inGame" || s === type || (s === "ladder" && type === "league");
}

/** The event keys a competition of this type shows (in catalogue order). */
export const eventKeysFor = (type: CompetitionType): DiscordEventKey[] => DISCORD_EVENT_KEYS.filter((k) => appliesTo(k, type));

/** Defaults per competition type: leagues post most things; tournaments start in tournament mode. */
export function defaultEvents(type: CompetitionType): DiscordEvents {
  const out = {} as DiscordEvents;
  for (const k of DISCORD_EVENT_KEYS) out[k] = appliesTo(k, type) && eventMeta(k)[type];
  return out;
}

/** Only deaths and sent-offs are live by default (owner round 3). */
export const DEFAULT_LIVE: Readonly<Record<InGameKey, boolean>> = {
  touchdown: false, casualty: false, injury: false, death: true, foul: false, sentOff: true, mvp: false, hireFire: false,
};

/** End-of-game digest: an option for both; on for leagues, off in tournament mode. */
export const defaultEndOfGameDigest = (type: CompetitionType): boolean => type === "league";

/** Tournament mode (requirement 6): what a tournament's Discord setup starts with ticked. */
export const TOURNAMENT_MODE_KEYS: readonly DiscordEventKey[] = ["published", "registrationClosing", "checkInOpen", "roundPosted", "matchResult", "roundStandings", "finalStandings"];

export type LiveMap = Record<InGameKey, boolean>;

/** A competition's stored Discord options (season / ladder / tournament; the league keeps its own on the league record). */
export interface CompetitionDiscordConfig {
  events?: Partial<DiscordEvents>;
  live?: Partial<LiveMap>;
  endOfGameDigest?: boolean;
  /** Coach's comments at the recorder's end-game step (default on). */
  comments?: boolean;
}

export interface EffectiveDiscordConfig {
  events: DiscordEvents;
  live: LiveMap;
  endOfGameDigest: boolean;
  comments: boolean;
}

/** `own` over `base` (base = the parent's effective options, or the type defaults). */
export function effectiveConfig(type: CompetitionType, own: CompetitionDiscordConfig | undefined, base?: EffectiveDiscordConfig): EffectiveDiscordConfig {
  const events = { ...(base?.events ?? defaultEvents(type)) };
  for (const k of DISCORD_EVENT_KEYS) if (typeof own?.events?.[k] === "boolean") events[k] = own.events[k]!;
  // A key that does not apply to this type is never on (a league never posts check-in; a tournament never fixtureCreated).
  for (const k of DISCORD_EVENT_KEYS) if (!appliesTo(k, type)) events[k] = false;
  const live = { ...(base?.live ?? DEFAULT_LIVE) };
  for (const k of IN_GAME_KEYS) if (typeof own?.live?.[k] === "boolean") live[k] = own.live[k]!;
  return {
    events,
    live,
    endOfGameDigest: typeof own?.endOfGameDigest === "boolean" ? own.endOfGameDigest : base?.endOfGameDigest ?? defaultEndOfGameDigest(type),
    comments: typeof own?.comments === "boolean" ? own.comments : base?.comments ?? true,
  };
}

/** The stored form of an effective config (auto-populating a new season from its league). */
export const freezeConfig = (c: EffectiveDiscordConfig): CompetitionDiscordConfig => ({ events: { ...c.events }, live: { ...c.live }, endOfGameDigest: c.endOfGameDigest, comments: c.comments });
