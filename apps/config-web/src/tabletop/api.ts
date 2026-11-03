/**
 * Tabletop recorder HTTP API (pure: server.ts supplies the session and the deps).
 *   POST /api/tabletop/matches                    create (participant or organiser)
 *   GET  /api/tabletop/matches/:id                match + events + current team files (participant/organiser)
 *   POST /api/tabletop/matches/:id/events         batch {events:[...]}, idempotent by event id
 *   POST /api/tabletop/matches/:id/submit         recording -> submitted, computes the preview
 *   POST /api/tabletop/matches/:id/confirm        each coach; organiser confirms for both; completes the match
 *   POST /api/tabletop/matches/:id/undo-revision  organiser: revert both teams one revision, reopen
 *   POST /api/tabletop/matches/:id/pregame/advance run / record the current pre-game step (see pregameAdvance)
 *   POST /api/tabletop/matches/:id/pregame/skip    organiser: skip the rest of the pre-game (logged)
 *   POST /api/tabletop/matches/:id/seats/swap      organiser: swap home and away before the pre-game starts (logged)
 *   GET  /api/tabletop/matches/:id/dice            the dice roller: latest rolls, open block choices, the dice log (dice.ts)
 *   POST /api/tabletop/matches/:id/dice/roll|choose|log   roll on the server, choose a block die, the "Show dice log" toggle
 *   GET|POST /api/tabletop/matches/:id/forfeit[/defections|/settings]  managers: the forfeit dialog for a league fixture
 * Auth: Discord session for every write (401 anonymous, 403 non-Discord session / banned / non-participant).
 * The match view (GET /api/tabletop/matches/:id) is also open read-only (owner ruling 10-30): any signed-in coach who is
 * neither a participant nor an organiser gets `role: "spectator"`, and an anonymous visitor (or a non-Discord session)
 * does too when the match is not a test match. Every write from a spectator is refused with 403.
 */

import { createHash, randomBytes } from "node:crypto";
import { cryptoRoller, dieFrom, flipCoin, type Roller } from "../dice/roller.js";
import { nafTimestamp } from "../tournaments/nafExport.js";
import { BANNED_ACCOUNT_MESSAGE } from "../auth/access.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import { COMMENT_STATES, commentsFor, parseComment } from "../discord/comments.js";
import {
  MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_MATCH, effectiveEvents, parseEvent, validateEvent, type Side, type TabletopEvent,
} from "./events.js";
import {
  PRAYERS_TO_NUFFLE, coinCallerOf, inducementConfirmed, inducementMenu, journeymenNeeded, latestInducement, makeJourneymen, overlayRosters, inducementOffersFor, planInducements, pregameStepOf, pregameSummary, seatsSwappable, teamValueWithJourneymen, weatherFor,
  type InducementOffers, type InducementOptionExtras, type MatchPhase,
} from "./pregame.js";
import type { AnnouncementKind, RecorderAnnouncement, ResultSummary } from "./discord.js";
import {
  DEFAULT_TURN_TIMER_POLICY, endTurn, firstHalfReceiver, initialClock, startTurn,
  type ClockState, type MatchTimers, type TurnTimerPolicy,
} from "./clock.js";
import { decorateRoster } from "./eligibility.js";
import { diceRead, diceWrite } from "./dice.js";
import type { DiceLogStore } from "../dice/log.js";
import type { DiceRuleset } from "../dice/tables.js";
import { withRosterArt } from "./rosterArt.js";
import { leagueStandings, type LeaguePoints } from "./standings.js";
import { customOptionExtras, seasonInducementOffers } from "../leagues/inducements.js";
import type { SeasonInducements } from "../leagues/inducementRules.js";
import { computeGlicko } from "../coachGlicko.js";
import { CoachTitleStore, type CoachRatingView } from "../coachRank.js";
import type { NafSummary } from "../nafRecords.js";
import { applyPostMatch, sppCredits, sppForEvent, tallyMatch, type PostMatchOption, type PostMatchSummary, type TabletopPlayer, type TabletopTeamFile, SPP_VALUES } from "./postMatch.js";
import { headRevision, type ChainChange, type CommitJournal, type LobbyInducements, type MatchRecord, type TabletopRepository, type TeamChain } from "./store.js";
import { duplicatePlayerId, parseTeamRef } from "./teamFile.js";
import { tabletopCaptainApi, teamCaptainVacancy } from "./captain.js";
import { matchTeamKeys, teamLockKey, withTeamLocks } from "./teamLock.js";
import type { NotificationInput } from "../notifications.js";
import type { LobbyConfirmRules } from "../fixtureLobby/core.js";

export interface TabletopAuth { coach: string; method: string; /** A test sign-in session: matches it creates are flagged test. */ test?: boolean }
export interface TabletopResult { status: number; body: unknown; contentType?: string; headers?: Record<string, string> }

/** A tournament fixture (scheduled match) as the recorder needs to see it. */
export interface FixtureView {
  id: string;
  packageName?: string;
  /** Has two sides, is not completed/cancelled/dismissed, and its tournament is active. */
  open: boolean;
  status: string;
  revision: number;
  home: { coach: string; teamId?: string };
  away: { coach: string; teamId?: string };
  tournament?: { id: string; name: string };
  /** The tournament's total rounds, and its series' name when it belongs to a series (absent = none). */
  roundCount?: number;
  seriesName?: string;
  round?: number;
  resultReportedAt?: string;
  /** The tournament's turn-timer policy (absent = the default: optional, 240 s). */
  turnTimer?: TurnTimerPolicy;
  /** The tournament's commissioner-enabled opt-in inducements (absent = none). */
  inducementOptIns?: readonly string[];
  /** The op id stamped on the recorded result (tabletop publications only). */
  resultOpId?: string;
  /** An organiser cleared the fixture's result, and that result was the tabletop publication with this op id. */
  clearedOpId?: string;
}

/** The tournaments store seen through the single existing result path (TournamentStore.recordResult). */
export interface FixtureGateway {
  get(id: string): FixtureView | undefined;
  /** Every scheduled match (open or not); the fixtures route filters. */
  list?(): FixtureView[];
  record(id: string, input: { opId?: string; expectedRevision: number; homeScore: number; awayScore: number; homeCasualties: number; awayCasualties: number }, at: Date): void;
  retract(id: string, input: { expectedRevision: number; status: string }, at: Date): void;
}

/** The header bar above the hero: what competition the match belongs to, composed here so the page renders only what the server sent. */
export interface MatchContext {
  kind: "league" | "tournament" | "casual";
  title: string;
  subtitle: string;
  round?: number;
  roundCount?: number;
  startedAt?: string;
  venue?: string;
}

export function matchContext(match: MatchRecord, deps: Pick<TabletopApiDeps, "fixtures" | "packageNameOf">): MatchContext {
  const fixture = match.fixtureRef ? deps.fixtures?.get(match.fixtureRef) : undefined;
  const common = { startedAt: match.createdAt, ...(match.venue ? { venue: match.venue } : {}) };
  const t = fixture?.tournament;
  if (fixture && t) {
    const round = fixture.round;
    const roundCount = fixture.roundCount;
    // a match counted in a league other than the tournament's own ruleset is a league fixture: "<League>" over "Round 7/8"
    if (match.league && match.league !== fixture.packageName) {
      return { kind: "league", title: match.league, subtitle: round ? `Round ${round}${roundCount ? `/${roundCount}` : ""}` : "League match", ...(round ? { round } : {}), ...(roundCount ? { roundCount } : {}), ...common };
    }
    return { kind: "tournament", title: t.name, subtitle: fixture.seriesName || fixture.packageName || "", ...(round ? { round } : {}), ...(roundCount ? { roundCount } : {}), ...common };
  }
  if (match.league) return { kind: "league", title: match.league, subtitle: "League match", ...common };
  // a casual match names the ruleset the teams were built under (home first; both when they differ), never a placeholder
  const pk = [...new Set([deps.packageNameOf?.(match.home.coach, match.home.teamSaveId), deps.packageNameOf?.(match.away.coach, match.away.teamSaveId)].filter((x): x is string => Boolean(x)))];
  return { kind: "casual", title: "Casual match", subtitle: pk.join(" / "), ...common };
}

/** Each seat's coach rating (CR, Glicko-2 as FUMBBL runs it: coachGlicko.ts) and rank, from our own published results. */
export function coachRatings(match: MatchRecord, deps: Pick<TabletopApiDeps, "results" | "now" | "naf" | "titles">): Record<"home" | "away", CoachRatingView & { naf: NafSummary }> {
  const revision = deps.results.revision?.();
  // NAF games (opted-in coaches, cached) are appended here for the rating only: they are never in deps.results
  let rows = deps.results.list();
  let rev = revision;
  try {
    const naf = deps.naf?.rows() ?? [];
    if (naf.length) { rows = [...rows, ...naf]; if (rev !== undefined) rev = `${rev}:${deps.naf!.revision()}`; }
  } catch { /* fail open: ratings without NAF */ }
  const asOf = deps.now?.() ?? new Date();
  const rated = computeGlicko(rows, { asOf, ...(rev !== undefined ? { revision: rev } : {}) });
  const titled = (deps.titles ?? new CoachTitleStore()).session(rated, asOf);
  const of = (coach: string) => {
    let naf: NafSummary = { games: 0 };
    try { naf = deps.naf?.summary?.(coach) ?? naf; } catch { /* fail open */ }
    return { ...titled.view(coach), naf };
  };
  const out = { home: of(match.home.coach), away: of(match.away.coach) };
  titled.flush();
  return out;
}

export interface TabletopApiDeps {
  /** The ruleset/package name a team was built under (a library team's ruleset, a builder save's package), shown under "Casual match". */
  packageNameOf?: (coach: string, teamRef: string) => string | undefined;
  repo: TabletopRepository;
  /** The public folder holding the generated art manifests (sprites), for the roster sprites the match GET adds. */
  artDir?: string;
  /** A team ref ("library:<id>" or a save id) -> its uploaded avatar URL, or undefined (clients fall back to the race crest). */
  teamAvatarUrl?: (ref: string) => string | undefined;
  results: {
    /** Changes whenever the retained rows change (keys the coach rating cache). */
    revision?(): string;
    put(row: StoredTournamentResult): unknown;
    remove(gameId: string): boolean;
    get(gameId: string): StoredTournamentResult | undefined;
    /** Counting rows only (fork + published tabletop). */
    list(): StoredTournamentResult[];
  };
  fixtures?: FixtureGateway;
  /** NAF ranked games (src/nafRecords.ts). rows() are for computeGlicko only; refreshFor() is fire-and-forget on match creation (the one place NAF is scraped). */
  naf?: {
    rows(): StoredTournamentResult[];
    revision(): string;
    refreshFor?(coaches: string[]): void | Promise<void>;
    summary?(coach: string): NafSummary;
  };
  /** A fixture's team id (the entrant's fork team) as a team the recorder can load for that coach, if it can. */
  resolveFixtureTeam?: (coach: string, teamId: string) => { ref: string; name: string } | undefined;
  /** The site roller (src/dice/roller.ts) for every roll here: pre-game, seat draw, the dice roller. Default cryptoRoller; tests inject. */
  roller?: Roller;
  /** Die roller for the server-side pre-game rolls: 1..sides. Default is the site roller; tests inject. */
  rollDie?: (sides: number) => number;
  /** The seat draw at match creation: true = swap the home and away the request named. Default is crypto-random
   *  (owner ruling 10-30: seats are randomised for casual, fixture and test matches alike); tests inject. */
  drawSeats?: () => boolean;
  /** GAME_PAGES_PUBLIC_PLAYER_LINES for the spectator view: false = a spectator sees no player names or player lines
   *  (scores, casualties by team and the pre-game stay). Default true, as for the game pages. */
  publicPlayerLines?: boolean;
  /** Called with the new clock payload whenever a match's clock or phase changes, and after every pre-game write (the Super socket feed). */
  publishClock?: (matchId: string, payload: unknown) => void;
  /** Pre-game milestones and the final result for the optional Discord webhook (src/tabletop/discord.ts). Fire-and-forget; never blocks the match. */
  announce?: (a: RecorderAnnouncement) => void;
  /** Fork-game metadata lookup for league standings (package name of a fork tournament game). */
  forkMetadata?: Parameters<typeof leagueStandings>[2];
  /** A league's points scheme when the tournaments store has one; default 3/1/0. */
  pointsFor?: (league: string) => LeaguePoints | undefined;
  /** A league season's inducement table (League settings, Inducements tab) and the fork accounts seated on its teams
   *  (LeagueTeam.coachId); undefined when there is no such season. */
  leagueInducements?: (leagueId: string, seasonId: string) => { config: SeasonInducements | undefined; active: boolean; coaches: readonly string[] } | undefined;
  /** Does this (non-league) fixture have a fixture lobby? Then only the lobby's START creates its match. Throws when unreadable. */
  fixtureHasLobby?: (fixtureRef: string) => boolean;
  /**
   * A match started from a fixture lobby (match.inducements): the lobby's own inducement rules for its fixture (menu,
   * budget, validator), so the recorder's confirm judges a pre-filled list exactly as the lobby picker did. undefined =
   * the fixture cannot be read (the step then confirms the pre-filled lists only, unchanged).
   */
  lobbyRules?: (match: MatchRecord) => LobbyConfirmRules | undefined;
  /** The coach's own saved team as a team file (baseline revision), or undefined if they have no such save. */
  /** The baseline team file; `{ error }` (client-safe) when the stored team can't be admitted (e.g. an invalid Team Captain). */
  loadTeamFile: (coach: string, teamSaveId: string) => TabletopTeamFile | { error: string } | undefined;
  isBanned: (coach: string) => boolean;
  isOrganizer: (coach: string) => boolean;
  /** Organiser of THIS match's league or tournament, or a site admin (an after-start inducement edit; api.ts editInducements).
   *  Absent (tests, older hosts): the recorder's organiser flag decides. */
  managesMatch?: (coach: string, match: MatchRecord) => boolean;
  /** A coach's saved teams (id + name only, never roster bodies). */
  listSaves?: (coach: string) => Array<{ id: string; name: string }>;
  /** Every team the coach can play: fork library teams ("library:<id>") and builder saves (bare id). */
  listTeams?: (coach: string) => Array<{ ref: string; name: string; race: string; tv: number | null; registered?: Array<{ id: string; name: string }>; actions?: { count: number; items: string[] } }>;
  now?: () => Date;
  /** Persisted coach titles (hysteresis memory + bounds); absent = in-memory plain percentile titles. */
  titles?: CoachTitleStore;
  /** Coach notifications (src/notifications.ts): a result confirmed by both seats notifies both coaches. Fire-and-forget. */
  notify?: (coach: string, input: NotificationInput) => void;
  /** Competition Discord (src/discord/hub.ts): newly recorded events (live posts). Fire-and-forget; never blocks the match. */
  onEvents?: (match: MatchRecord, accepted: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>) => void;
  /** Competition Discord: the match was confirmed for good (end-of-game digest). Fire-and-forget. */
  onResult?: (match: MatchRecord, events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>) => Promise<unknown> | void;
  /** Coach's comments are on for this match's competition (src/discord/comments.ts). Absent = on. */
  commentsEnabled?: (match: MatchRecord) => boolean;
  /** The dice log (src/dice/log.ts); unset = the dice roller answers 404. */
  diceLog?: DiceLogStore;
  /** Live dice sync: push to the match's socket room after a roll or a choice is logged (the Super socket). Fire-and-forget. */
  publishDice?: (matchId: string, payload: unknown) => void;
  /** The match's ruleset for the kick-off table (a league season's; default BB2025). */
  rulesetOf?: (match: MatchRecord) => DiceRuleset | undefined;
  /** The forfeit dialog for a match on a league fixture (src/leagues/forfeit.ts through server.ts); unset = 404. */
  forfeit?: TabletopForfeitGateway;
}

/** The league forfeit routes as the recorder reaches them (the gateway checks the league organiser itself). */
export interface ForfeitGatewayResult { status: number; body?: unknown; headers?: Record<string, string> }
export interface TabletopForfeitGateway {
  model(match: MatchRecord, who: { coach: string; admin: boolean }): ForfeitGatewayResult;
  roll(match: MatchRecord, who: { coach: string; admin: boolean }, body: Record<string, unknown>): ForfeitGatewayResult;
  apply(match: MatchRecord, who: { coach: string; admin: boolean }, body: Record<string, unknown>): Promise<ForfeitGatewayResult>;
  settings(match: MatchRecord, who: { coach: string; admin: boolean }, on: unknown): ForfeitGatewayResult;
  /** Post the end-of-match report (once), after the forfeit and the match close are both written. */
  announce?(match: MatchRecord): Promise<void>;
  /** Is `coach` a site admin (the league routes' admin flag)? */
  isAdmin?(coach: string): boolean;
}

/** After a finalising confirm committed: both coaches hear the result is confirmed (never for Testing Suite matches). */
function notifyConfirmed(match: MatchRecord, me: string, deps: TabletopApiDeps): void {
  if (!deps.notify || match.test) return;
  try {
    const fixture = match.fixtureRef ? deps.fixtures?.get(match.fixtureRef) : undefined;
    const t = fixture?.tournament;
    const link = t ? `/app/tournaments/${encodeURIComponent(t.id)}?tab=rounds` : `/app/tabletop/${encodeURIComponent(match.id)}`;
    const input: NotificationInput = {
      type: "result-confirmed",
      title: `${t ? `${t.name}: ` : ""}result confirmed`,
      body: `${match.home.teamName} (${match.home.coach}) v ${match.away.teamName} (${match.away.coach}): the result is confirmed.`,
      link,
      from: me,
    };
    deps.notify(match.home.coach, input);
    deps.notify(match.away.coach, input);
  } catch { /* notifications are best effort */ }
}

/** Adds `avatarUrl` to a team view when the team has an uploaded avatar. */
function withAvatar<T extends TabletopTeamFile | undefined>(file: T, ref: string, deps: TabletopApiDeps): T {
  const url = file ? deps.teamAvatarUrl?.(ref) : undefined;
  return file && url ? { ...file, avatarUrl: url } : file;
}

export const isTabletopApiPath = (path: string): boolean => path === "/api/tabletop" || path.startsWith("/api/tabletop/") || path === "/api/standings";

const POST_MATCH: readonly string[] = ["none", "spp-only", "full"];
const err = (status: number, error: string): TabletopResult => ({ status, body: { error } });
const resultGameId = (matchId: string): string => `tabletop-${matchId}`;

// Per-match serialisation: a repository that is not synchronous (Postgres) still sees one writer per match.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>, teams: readonly string[] = []): Promise<T> {
  // every serialised write drops the cached match snapshot, before and after it runs; it also holds the match's TEAM locks
  // (teamLock.ts: one lock domain with match creation and the Team Captain writes)
  const write = async (): Promise<T> => { dropSnapshot(key); try { return await withTeamLocks(teams, fn); } finally { dropSnapshot(key); } };
  const run = (chains.get(key) ?? Promise.resolve()).then(write, write);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

export async function tabletopApi(
  method: string,
  path: string,
  auth: TabletopAuth | undefined,
  body: unknown,
  deps: TabletopApiDeps,
  query: URLSearchParams = new URLSearchParams(),
): Promise<TabletopResult | undefined> {
  if (!isTabletopApiPath(path)) return undefined;
  // A public read (no session): the standings contain only published results. Every write stays gated below.
  if (path === "/api/standings") {
    if (method !== "GET" && method !== "HEAD") return err(405, "Method not allowed.");
    const league = query.get("league")?.trim() ?? "";
    if (!league || league.length > 60) return err(400, "league is required.");
    const rows = leagueStandings(deps.results.list(), league, deps.forkMetadata ?? (() => undefined), deps.pointsFor?.(league));
    return { status: 200, body: { league, rows } };
  }
  // The read-only match view for an anonymous visitor or a non-Discord session: only a match that is not a test match.
  if (!auth?.coach || auth.method !== "discord") {
    const view = /^\/api\/tabletop\/matches\/([\w-]{1,64})$/.exec(path);
    if (view && (method === "GET" || method === "HEAD") && !(auth?.coach && deps.isBanned(auth.coach))) {
      const match = await deps.repo.getMatch(view[1]!);
      if (match && !match.test) return matchView(match, "spectator", deps);
      if (match && !auth?.coach) return err(401, "Sign in with Discord to watch a test match.");
    }
    if (!auth?.coach) return err(401, "Sign in with Discord first.");
    return err(403, "The match recorder needs a Discord sign-in.");
  }
  const me = auth.coach;
  if (deps.isBanned(me)) return err(403, BANNED_ACCOUNT_MESSAGE);
  const organiser = deps.isOrganizer(me);
  const now = (): Date => deps.now?.() ?? new Date();
  const { repo } = deps;

  if (path === "/api/tabletop/matches") {
    if (method === "GET") return listMatches(me, organiser, deps);
    if (method !== "POST") return err(405, "Method not allowed.");
    return createMatch(me, organiser, body, deps, now, auth.test ? { test: true } : {});
  }
  if (path.startsWith("/api/tabletop/organiser/")) {
    if (!organiser) return err(403, "Organizer access required.");
    return organiserApi(method, path, query, body, me, deps, now);
  }
  if (path === "/api/tabletop/fixtures") {
    if (method !== "GET") return err(405, "Method not allowed.");
    return listFixtures(me, organiser && query.get("all") === "1", deps);
  }
  if (path === "/api/tabletop/saves") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const coach = query.get("coach")?.trim() ?? "";
    if (!coach || coach.length > 60) return err(400, "coach is required.");
    const own = coach.toLowerCase() === me.toLowerCase();
    const saves = (deps.listSaves?.(coach) ?? []).map((s) => ({ id: s.id, name: s.name }));
    const teams = (deps.listTeams?.(coach) ?? saves.map((x) => ({ ref: x.id, name: x.name, race: "", tv: null })) as NonNullable<ReturnType<NonNullable<TabletopApiDeps["listTeams"]>>>)
      // Registrations and outstanding actions are the coach's own business: an opponent's lookup gets the plain list.
      .map((t) => (own ? { ref: t.ref, name: t.name, race: t.race, tv: t.tv, registered: t.registered ?? [], actions: t.actions ?? { count: 0, items: [] } } : { ref: t.ref, name: t.name, race: t.race, tv: t.tv }));
    // a team waiting for a new Team Captain (tabletop/captain.ts) is marked for its coach and for organisers
    const vacant = own || organiser ? await teamCaptainVacancy(repo, coach, teams.map((t) => t.ref)) : new Set<string>();
    return { status: 200, body: { coach, saves, teams: teams.map((t) => (vacant.has(t.ref) ? { ...t, captainVacant: true } : t)) } };
  }
  const captain = await tabletopCaptainApi(method, path, query, body, me, organiser, deps, dropAllSnapshots);
  if (captain) return captain;
  const m = /^\/api\/tabletop\/matches\/([\w-]{1,64})(?:\/(events|submit|confirm|publish|undo-revision|resolve-conflict|pregame\/advance|pregame\/skip|seats\/swap|turn\/start|turn\/end|turn\/set|inducements|comment|comment\/hide|dice|dice\/roll|dice\/choose|dice\/log|forfeit|forfeit\/defections|forfeit\/settings))?$/.exec(path);
  if (!m) return err(404, "Not found.");
  const id = m[1]!;
  const action = m[2];

  const match = await repo.getMatch(id);
  if (!match) return err(404, "Match not found.");
  const role = viewerRole(match, me, organiser);
  /** An organiser of this match's league / tournament, or an admin: inducement edits after the start and their undo. */
  const manage = deps.managesMatch ? deps.managesMatch(me, match) : organiser;
  // Every answer below that carries the match goes through the one comment filter (hidden comments: managers and author only).
  const scrub = (r: TabletopResult): TabletopResult => scrubComments(r, role, manage, deps);

  // Organiser edits of inducements after the start (owner 10-29): only an organiser of this league / tournament or an admin.
  if (action === "inducements") {
    if (!manage) return err(403, "Only an organiser of this league or tournament (or an admin) can edit inducements after the start.");
    if (method === "GET") return inducementEditMenu(match, deps);
    if (method !== "POST") return err(405, "Method not allowed.");
    return serial(id, async () => {
      try { await recoverMatch(id, deps); } catch (e) { return recoveryFailure(e); }
      return scrub(await editInducements((await repo.getMatch(id))!, me, body, deps, now));
    }, matchTeamKeys(match));
  }
  if (!action) {
    if (method !== "GET") return err(405, "Method not allowed.");
    return matchView(match, role, deps, manage);
  }
  // The dice roller (dice.ts): seats and organisers only, reads included; writes under the match lock.
  if (action === "dice" || action.startsWith("dice/")) {
    const v = { role, manage, me };
    if (action === "dice") return method === "GET" || method === "HEAD" ? diceRead(match, v, deps) : err(405, "Method not allowed.");
    if (method !== "POST") return err(405, "Method not allowed.");
    return serial(id, async () => diceWrite((await repo.getMatch(id))!, action, body, v, deps, now));
  }
  // The forfeit dialog for a league fixture (managers of the competition; the league routes check the organiser again).
  if (action === "forfeit" || action.startsWith("forfeit/")) {
    if (!manage) return err(403, "Only an organiser of this league (or an admin) can enter a forfeit.");
    if (!deps.forfeit) return err(404, "Forfeits are not available here.");
    const who = { coach: me, admin: deps.forfeit.isAdmin?.(me) ?? false };
    const asResult = (r: ForfeitGatewayResult): TabletopResult => ({ status: r.status, body: r.body ?? {}, ...(r.headers ? { headers: r.headers } : {}) });
    if (action === "forfeit" && (method === "GET" || method === "HEAD")) return asResult(deps.forfeit.model(match, who));
    if (method !== "POST") return err(405, "Method not allowed.");
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (action === "forfeit/defections") return asResult(deps.forfeit.roll(match, who, b));
    if (action === "forfeit/settings") return asResult(deps.forfeit.settings(match, who, b.defectionRolls));
    return serial(id, async () => {
      const fresh = (await repo.getMatch(id))!;
      if (fresh.forfeit) return err(409, "This match was already forfeited.");
      if (!fresh.forfeitPending && (fresh.state === "confirmed" || fresh.state === "published")) return err(409, `This match is ${fresh.state}: undo its result before entering a forfeit.`);
      // Two writes (the league fixture, then this match): the pending marker goes first, so a crash between them is finished
      // by a retry (the league side answers the forfeit it already applied for this match) instead of a 409.
      const at = now().toISOString();
      const pending = fresh.forfeitPending ?? { at, by: me };
      if (!fresh.forfeitPending) await repo.updateMatch({ ...fresh, forfeitPending: pending, updatedAt: at });
      const out = asResult(await deps.forfeit!.apply(fresh, who, b));
      if (out.status !== 200) {
        // refused (bad input, blocked fixture): nothing was applied, so the match is not left pending
        const now2 = (await repo.getMatch(id))!;
        const { forfeitPending: _p, ...rest } = now2;
        await repo.updateMatch(rest as MatchRecord);
        return out;
      }
      // The forfeit replaces the report: the match closes (published, no results row, no team revisions), keeping its score.
      const score = (out.body as { score?: { home: number; away: number } }).score;
      const { forfeitPending: _p, ...base } = fresh;
      const closed: MatchRecord = { ...base, state: "published", forfeit: { at: pending.at, by: pending.by, ...(score ? { score } : {}) }, publishedAt: at, publishedBy: me, updatedAt: at };
      await repo.updateMatch(closed);
      // The Discord report only after both writes (fire-and-forget; posted once).
      void deps.forfeit!.announce?.(closed).catch(() => undefined);
      return { status: 200, body: { ...(out.body as Record<string, unknown>), match: closed } };
    }, matchTeamKeys(match));
  }
  // Coach's comments (end-game step): a seat writes its own; a manager of the competition hides one.
  if (action === "comment" || action === "comment/hide") {
    if (method !== "POST") return err(405, "Method not allowed.");
    return scrub(await serial(id, async () => commentAction((await repo.getMatch(id))!, action, me, role, manage, body, deps, now)));
  }
  if (method !== "POST") return err(405, "Method not allowed.");
  // a spectator reads; every write (events, turns, pre-game, seats, submit, confirm, organiser tools) is refused here
  // (a scoped manager outside the match may post events: postEvents lets them undo inducement edits only)
  if (role === "spectator" && !(manage && action === "events")) return err(403, "You are watching this match: only its coaches and organisers can change it.");

  return scrub(await serial(id, async () => {
    if (action === "resolve-conflict") {
      if (!organiser) return err(403, "Organizer access required.");
      const j = await repo.getJournal(id);
      if (!j || j.state !== "conflict") return err(409, "This match has no conflicted commit.");
      await repo.clearJournal(id);
      return { status: 200, body: { match: await repo.getMatch(id), discarded: { kind: j.kind, conflict: j.conflict } } };
    }
    try {
      const replayed = await recoverMatch(id, deps);
      if (replayed && (action === "confirm" || action === "publish" || action === "undo-revision") && replayed.kind === (action === "confirm" ? "confirm" : action === "publish" ? "publish" : "undo"))
        return { status: 200, body: { match: replayed.match, recovered: true } };
    } catch (e) {
      return recoveryFailure(e);
    }
    const fresh = (await repo.getMatch(id))!;
    if (fresh.forfeit || fresh.forfeitPending) return err(409, "This match was forfeited: its result is the forfeit entered by an organiser.");
    if (action === "events") return postEvents(fresh, me, organiser, body, deps, now, manage);
    if (action === "turn/set") return turnSet(fresh, me, organiser, body, deps, now);
    if (action === "turn/start" || action === "turn/end") return turnAction(fresh, me, organiser, action, body, deps, now);
    if (action === "pregame/advance") return pregameAdvance(fresh, me, organiser, body, deps, now);
    if (action === "pregame/skip") return pregameSkip(fresh, me, organiser, deps, now);
    if (action === "seats/swap") return swapSeats(fresh, me, organiser, deps, now);
    if (action === "submit") return submit(fresh, deps, now);
    if (action === "confirm") return confirm(fresh, me, organiser, deps, now);
    if (!organiser) return err(403, "Organizer access required.");
    if (action === "publish") return publish(fresh, me, deps, now);
    return undoRevision(fresh, deps, now, undefined, me);
  }, matchTeamKeys(match)));
}

/** The match as this viewer sees its coach's comments (hidden ones only for a manager of THIS competition, and their author). */
function withComments(match: MatchRecord, role: ViewerRole, manage: boolean, deps: TabletopApiDeps): MatchRecord & { commentsEnabled?: boolean } {
  const { comments: _c, ...rest } = match;
  const viewer = manage ? "manager" : role === "home" || role === "away" ? role : "other";
  const comments = commentsFor(match, viewer);
  const enabled = deps.commentsEnabled ? deps.commentsEnabled(match) : true;
  return { ...rest, ...(comments ? { comments } : {}), commentsEnabled: enabled };
}

/** Any response body carrying a match record (`match`, or a recovered `match`) gets the viewer's comment filter. */
function scrubComments(r: TabletopResult, role: ViewerRole, manage: boolean, deps: TabletopApiDeps): TabletopResult {
  const body = r.body as { match?: unknown } | undefined;
  const m = body && typeof body === "object" ? body.match : undefined;
  if (!m || typeof m !== "object" || !("home" in (m as object)) || !("state" in (m as object))) return r;
  return { ...r, body: { ...body, match: withComments(m as MatchRecord, role, manage, deps) } };
}

/** POST .../comment { text } (a seat, at the end-game step) and POST .../comment/hide { side, hidden } (a manager). */
async function commentAction(match: MatchRecord, action: string, me: string, role: ViewerRole, manage: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  const at = now().toISOString();
  if (action === "comment/hide") {
    if (!manage) return err(403, "Only an organiser of this league or tournament (or an admin) can hide a comment.");
    const b = (body ?? {}) as { side?: unknown; hidden?: unknown };
    if (b.side !== "home" && b.side !== "away") return err(400, "side must be home or away.");
    if (typeof b.hidden !== "boolean") return err(400, "hidden must be true or false.");
    const c = match.comments?.[b.side];
    if (!c) return err(404, "That coach has not written a comment.");
    // Unhiding an emptied slot drops it; otherwise the hide sticks to the seat's slot whatever the author writes next.
    const slot = b.hidden ? { ...c, hidden: { by: me, at } } : c.text ? { text: c.text, at: c.at } : undefined;
    const comments = { ...match.comments };
    if (slot) comments[b.side] = slot; else delete comments[b.side];
    const { comments: _prev, ...base } = match;
    const next: MatchRecord = { ...base, ...(Object.keys(comments).length ? { comments } : {}), updatedAt: at };
    await deps.repo.updateMatch(next);
    return { status: 200, body: { match: withComments(next, role, manage, deps) } };
  }
  if (role !== "home" && role !== "away") return err(403, "Only the two coaches of this match can write a comment.");
  if (!COMMENT_STATES.has(match.state)) return err(409, "Comments open at the end of the match, once it is submitted.");
  if (deps.commentsEnabled && !deps.commentsEnabled(match)) return err(409, "Coach's comments are turned off for this competition.");
  const parsed = parseComment(body);
  if (!parsed.ok) return err(400, parsed.error);
  const comments = { ...(match.comments ?? {}) };
  // one comment per coach per game: writing again replaces it; "" removes it. An organiser's hide sticks to the seat's
  // slot (an emptied hidden comment keeps the hide), so a re-post stays hidden until an organiser unhides it.
  const hidden = comments[role]?.hidden;
  if (!parsed.text && !hidden) delete comments[role];
  else comments[role] = { text: parsed.text, at, ...(hidden ? { hidden } : {}) };
  const { comments: _old, ...rest } = match;
  const next: MatchRecord = { ...rest, ...(Object.keys(comments).length ? { comments } : {}), updatedAt: at };
  await deps.repo.updateMatch(next);
  return { status: 200, body: { match: withComments(next, role, manage, deps) } };
}

/** Who is looking at a match: a seat (home / away) first, then an organiser, else a spectator (read-only). */
export type ViewerRole = "home" | "away" | "organiser" | "spectator";
function viewerRole(match: MatchRecord, me: string, organiser: boolean): ViewerRole {
  if (match.home.coach === me) return "home";
  if (match.away.coach === me) return "away";
  return organiser ? "organiser" : "spectator";
}

/** The derived, role-independent part of the match view: built once per match revision and shared by every viewer
 *  (the read-only page polls it). Never mutated after it is built. */
interface MatchSnapshot {
  events: readonly TabletopEvent[];
  viewEvents: ReadonlyArray<Record<string, unknown>>;
  effectiveEventIds: readonly string[];
  teams: Record<Side, unknown>;
  tally: ReturnType<typeof tallyView>;
  pregame: Record<string, unknown>;
}
const SNAPSHOT_MAX = 200;
/** Per repository (tests each bring their own), per match: the revision key and the (shared, coalesced) build. */
const snapshotCache = new WeakMap<TabletopRepository, Map<string, { key: string; value: Promise<MatchSnapshot> }>>();
const snapshotRepos = new Set<WeakRef<TabletopRepository>>();
/** Drop every cached match snapshot (account deletion rewrote match records and event logs). */
export function dropAllSnapshots(): void {
  for (const ref of snapshotRepos) {
    const repo = ref.deref();
    if (!repo) { snapshotRepos.delete(ref); continue; }
    snapshotCache.get(repo)?.clear();
  }
}
function dropSnapshot(matchId: string): void {
  for (const ref of snapshotRepos) {
    const repo = ref.deref();
    if (!repo) { snapshotRepos.delete(ref); continue; }
    snapshotCache.get(repo)?.delete(matchId);
  }
}
/** The match's revision: its record plus the event log's size (append-only), so a write from anywhere shows. */
async function snapshotKey(match: MatchRecord, deps: TabletopApiDeps): Promise<string> {
  const ev = deps.repo.eventsRevision ? await deps.repo.eventsRevision(match.id) : "";
  return `${match.updatedAt}|${match.state}|${match.phase ?? "playing"}|${ev}`;
}
async function matchSnapshot(match: MatchRecord, deps: TabletopApiDeps): Promise<MatchSnapshot> {
  let byMatch = snapshotCache.get(deps.repo);
  if (!byMatch) { byMatch = new Map(); snapshotCache.set(deps.repo, byMatch); snapshotRepos.add(new WeakRef(deps.repo)); }
  const key = await snapshotKey(match, deps);
  const hit = byMatch.get(match.id);
  if (hit && hit.key === key) return hit.value;
  const value = buildSnapshot(match, deps);
  byMatch.delete(match.id); // re-insert: the map's order is least recently built first
  byMatch.set(match.id, { key, value });
  while (byMatch.size > SNAPSHOT_MAX) byMatch.delete(byMatch.keys().next().value!);
  value.catch(() => { if (byMatch!.get(match.id)?.value === value) byMatch!.delete(match.id); });
  return value;
}
async function buildSnapshot(match: MatchRecord, deps: TabletopApiDeps): Promise<MatchSnapshot> {
  const events = await deps.repo.readEvents(match.id);
  const base = await currentTeams(deps.repo, match);
  const teams = overlayRosters(base, events);
  const effective = effectiveEvents(events);
  const effectiveIds = new Set(effective.map((e) => e.id));
  // the undo that retracted each event, indexed once (the first undo naming it, as recorded)
  const undoOf = new Map<string, TabletopEvent>();
  for (const e of events) if (e.type === "undo" && typeof e.payload.target === "string" && !undoOf.has(e.payload.target)) undoOf.set(e.payload.target, e);
  const kindOf = kindLookup(teams);
  const phase: Phase = match.phase ?? "playing";
  return {
    events,
    // a retracted event stays in the log with who removed it and when (the undo event's record), so the feed can show it struck through
    viewEvents: events.map((e) => {
      const u = e.type === "undo" ? undefined : undoOf.get(e.id);
      return { ...e, sppEarned: effectiveIds.has(e.id) ? sppForEvent(e, kindOf) : 0, ...(u ? { removed: { by: u.by, at: u.ts, admin: u.admin === true } } : {}) };
    }),
    effectiveEventIds: effective.map((e) => e.id),
    // per player: kind, available / unavailableReason, eligible{...} (server-derived, so the page filters without rules of its own)
    teams: {
      home: withAvatar(withRosterArt(decorateRoster("home", teams.home, events), deps.artDir), match.home.teamSaveId, deps),
      away: withAvatar(withRosterArt(decorateRoster("away", teams.away, events), deps.artDir), match.away.teamSaveId, deps),
    },
    tally: tallyView(events, teams),
    pregame: pregameViewOf(match, events, phase === "pregame:inducements" ? base : { home: undefined, away: undefined }, deps),
  };
}

/** GET /api/tabletop/matches/:id: the whole match view for a seat or an organiser; a spectator gets the allowlisted
 *  public view model (spectatorView). The page hides every control for a spectator; the server refuses their writes. */
/** A forfeited match shows the forfeit's score (the result an organiser entered), not the events' count. */
function withForfeitScore(r: TabletopResult, match: MatchRecord): TabletopResult {
  const score = match.forfeit?.score;
  const body = r.body as { tally?: { score?: unknown } } | undefined;
  if (!score || r.status !== 200 || !body?.tally) return r;
  return { ...r, body: { ...body, tally: { ...body.tally, score: { home: score.home, away: score.away } }, forfeitScore: score } };
}

async function matchView(match: MatchRecord, role: ViewerRole, deps: TabletopApiDeps, manage = false): Promise<TabletopResult> {
  return withForfeitScore(await matchViewInner(match, role, deps, manage), match);
}

async function matchViewInner(match: MatchRecord, role: ViewerRole, deps: TabletopApiDeps, manage = false): Promise<TabletopResult> {
  const now = deps.now?.() ?? new Date();
  const snap = await matchSnapshot(match, deps);
  const full = {
    match: withComments(match, role, manage, deps), role, context: matchContext(match, deps), coachRating: coachRatings(match, deps), phase: match.phase ?? "playing", clock: clockView(match, snap.events, deps, now),
    pregame: snap.pregame,
    events: snap.viewEvents,
    effectiveEventIds: snap.effectiveEventIds,
    teams: snap.teams,
    tally: snap.tally,
    // the SPP each kind of event earns (the confirm modal shows the gain before an event is posted; the client keeps no table of its own)
    sppValues: SPP_VALUES,
  };
  return { status: 200, body: role === "spectator" ? spectatorView(full, deps.publicPlayerLines !== false) : full };
}

type Rec = Record<string, unknown>;
const pick = (o: unknown, keys: readonly string[]): Rec => {
  const src = (o && typeof o === "object" ? o : {}) as Rec;
  const out: Rec = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};
/** Payload keys a spectator never sees: what a team spent from its treasury (its treasury follows from it). */
const PRIVATE_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["treasury", "pettyCash", "treasuryBefore"]);
/** Payload keys that name a player: dropped when player lines are not public. */
const PLAYER_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["player", "victim", "thrower", "thrown"]);
const PUBLIC_PLAYER_KEYS = ["id", "name", "number", "positionId", "position", "positionName", "kind", "sprite", "mng", "dead", "available"] as const;

function publicPayload(p: unknown, lines: boolean): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries((p && typeof p === "object" ? p : {}) as Rec)) {
    if (PRIVATE_PAYLOAD_KEYS.has(k)) continue;
    if (PLAYER_PAYLOAD_KEYS.has(k)) {
      if (!lines) continue;
      // a journeyman's payload carries the whole player: only the public fields
      out[k] = v && typeof v === "object" ? pick(v, PUBLIC_PLAYER_KEYS) : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * The spectator view model (owner ruling 10-30 #7, review fix): an allowlist, never the stored records. The scoreboard
 * (score, casualties by team, concession, clock), the pre-game state, the public log lines, team names, races, colours
 * and coaches. Player names and player lines (the roster, SPP per event, per-player tallies) only when
 * GAME_PAGES_PUBLIC_PLAYER_LINES allows. Never: treasuries or what was spent from them, team values beyond the pre-game
 * TV, save ids, revisions, journals, organiser notes, the post-match preview.
 */
export function spectatorView(full: { match: MatchRecord; [k: string]: unknown }, lines: boolean): Rec {
  const m = full.match;
  const seat = (s: MatchRecord["home"]) => ({ coach: s.coach, teamName: s.teamName });
  const match: Rec = {
    id: m.id, state: m.state, phase: m.phase ?? "playing", home: seat(m.home), away: seat(m.away), postMatch: m.postMatch,
    confirmations: { ...m.confirmations }, createdAt: m.createdAt, updatedAt: m.updatedAt,
    ...(m.test ? { test: true } : {}), ...(m.allowOvertime ? { allowOvertime: true } : {}),
  };
  const teamOf = (t: unknown) => {
    if (!t || typeof t !== "object") return t;
    const players = Array.isArray((t as Rec).players) ? ((t as Rec).players as unknown[]) : [];
    return { ...pick(t, ["name", "race", "rosterId", "color", "avatarUrl"]), players: lines ? players.map((p) => pick(p, PUBLIC_PLAYER_KEYS)) : [] };
  };
  const teams = full.teams as Record<Side, unknown>;
  const events = (full.events as Rec[]).map((e) => ({
    ...pick(e, ["id", "type", "team", "half", "turn", "ts", "by", "admin", "removed"]),
    ...(lines && e.player !== undefined ? { player: e.player, sppEarned: e.sppEarned } : {}),
    payload: publicPayload(e.payload, lines),
  }));
  const t = full.tally as ReturnType<typeof tallyView>;
  const tally = {
    score: t.score, fanDelta: t.fanDelta, conceded: t.conceded, clock: t.clock, casualtiesSuffered: t.casualtiesSuffered,
    players: lines ? t.players : { home: [], away: [] },
    events: lines ? t.events : [],
  };
  const pg = { ...(full.pregame as Rec) };
  const ind = pg.inducements as Rec | undefined;
  if (ind && typeof ind === "object") pg.inducements = { home: ind.home && publicPayload(ind.home, lines), away: ind.away && publicPayload(ind.away, lines) };
  const budget = pg.budget as Record<Side, unknown> | undefined;
  if (budget) pg.budget = { home: pick(budget.home, ["role", "submitted", "spent"]), away: pick(budget.away, ["role", "submitted", "spent"]) };
  if (!lines && pg.journeymen && typeof pg.journeymen === "object") pg.journeymen = { home: [], away: [] };
  return {
    match, role: "spectator", context: full.context, coachRating: full.coachRating, phase: full.phase, clock: full.clock,
    pregame: pg, events, effectiveEventIds: full.effectiveEventIds,
    teams: { home: teamOf(teams.home), away: teamOf(teams.away) }, tally, sppValues: full.sppValues, playerLines: lines,
  };
}

async function ensureChain(deps: TabletopApiDeps, coach: string, saveId: string, at: string): Promise<TeamChain | { error: string } | undefined> {
  const existing = await deps.repo.getChain(coach, saveId);
  if (existing) return existing;
  const base = deps.loadTeamFile(coach, saveId);
  if (!base) return undefined;
  if ("error" in base) return { error: `${coach}'s team ${saveId}: ${base.error}` };
  const dup = duplicatePlayerId(base);
  if (dup) return { error: `${coach}'s team ${saveId} has a duplicate player id (${dup}).` };
  const chain: TeamChain = { saveId, coach, head: 0, revisions: [{ saveId, revision: 0, parent: null, teamFile: base, createdAt: at }] };
  await deps.repo.putChain(chain);
  return chain;
}

/** The server's own count of the effective events (score, per-player SPP, casualties): clients never compute rules. */
/** Player kind lookup over team files (stars and mercenaries earn no SPP; journeymen do). */
const kindLookup = (teams: Record<Side, TabletopTeamFile | undefined>) =>
  (side: Side, id: string): string | undefined => teams[side]?.players.find((p) => p.id === id)?.kind ?? (teams[side]?.players.find((p) => p.id === id)?.journeyman ? "journeyman" : undefined);

/** Log copy for a Throw Team-mate event: who threw whom, how, and whether the thrown player landed. */
function throwText(e: TabletopEvent, teams: Record<Side, TabletopTeamFile | undefined>): string {
  const nameOf = (id: unknown) => (typeof id === "string" ? teams[e.team]?.players.find((p) => p.id === id)?.name ?? id : undefined);
  const how = e.payload.superb === true ? "superb pass" : "subpar throw";
  const end = e.payload.landed === true ? "lands safely" : "does not land";
  const thrower = nameOf(e.payload.thrower);
  const thrown = nameOf(e.payload.thrown);
  return `${thrower && thrown ? `${thrower} throws ${thrown}` : thrower ? `${thrower} throws a team-mate` : thrown ? `${thrown} is thrown` : "Throw Team-mate"} - ${how}, ${end}`;
}

function tallyView(events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>) {
  const names = (t: TabletopTeamFile | undefined) => new Map((t?.players ?? []).map((p) => [p.id, p.name] as const));
  const kindOf = kindLookup(teams);
  const t = tallyMatch(events, { home: names(teams.home), away: names(teams.away) }, kindOf);
  return {
    score: t.score,
    fanDelta: t.fanDelta,
    treasurySpent: t.treasurySpent,
    conceded: t.conceded,
    clock: t.clock,
    casualtiesSuffered: t.casualtiesSuffered,
    players: { home: [...t.lines.home.values()], away: [...t.lines.away.values()] },
    // SPP each EFFECTIVE event earns (server-derived: clients never keep an SPP table of their own)
    // `credits` names who got what: a Throw Team-mate can credit both the thrower and the thrown player
    events: effectiveEvents(events).map((e) => ({
      id: e.id, team: e.team, ...(e.player ? { player: e.player } : {}), sppEarned: sppForEvent(e, kindOf),
      credits: sppCredits(e, kindOf).map(({ player, spp }) => ({ player, spp })),
      ...(e.type === "throwTeamMate" ? { text: throwText(e, teams) } : {}),
    })),
  };
}

async function listMatches(me: string, organiser: boolean, deps: TabletopApiDeps): Promise<TabletopResult> {
  const all = await deps.repo.listMatches();
  const mine = all.filter((m) => organiser || m.home.coach === me || m.away.coach === me);
  mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.updatedAt.localeCompare(a.updatedAt));
  return {
    status: 200,
    body: {
      matches: mine.map((m) => ({
        id: m.id, state: m.state, phase: m.phase ?? "playing", pendingOrganiser: m.state === "confirmed", ...(m.test ? { test: true } : {}), ...(m.fixtureRef ? { fixtureRef: m.fixtureRef } : {}), postMatch: m.postMatch,
        home: { coach: m.home.coach, teamName: m.home.teamName }, away: { coach: m.away.coach, teamName: m.away.teamName },
        createdAt: m.createdAt, updatedAt: m.updatedAt,
      })),
    },
  };
}

/** A match's two team files as the recorder names its players (journeymen included): Discord digests read names from it. */
export async function tabletopMatchTeams(repo: TabletopRepository, match: MatchRecord, events: readonly TabletopEvent[]): Promise<Record<Side, TabletopTeamFile | undefined>> {
  return overlayRosters(await currentTeams(repo, match), events);
}

async function currentTeams(repo: TabletopRepository, match: MatchRecord): Promise<Record<Side, TabletopTeamFile | undefined>> {
  const read = async (s: MatchRecord["home"]) => {
    const c = await repo.getChain(s.coach, s.teamSaveId);
    return c ? headRevision(c).teamFile : undefined;
  };
  return { home: await read(match.home), away: await read(match.away) };
}

const sameCoach = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The caller's UNRESOLVED fixtures (either orientation); an organiser with ?all=1 sees every unresolved fixture. */
async function listFixtures(me: string, all: boolean, deps: TabletopApiDeps): Promise<TabletopResult> {
  const side = (s: { coach: string; teamId?: string }) => {
    const team = s.teamId ? deps.resolveFixtureTeam?.(s.coach, s.teamId) : undefined;
    return { coach: s.coach, ...(team ? { teamRef: team.ref, teamName: team.name } : {}) };
  };
  const fixtures = (deps.fixtures?.list?.() ?? [])
    .filter((f) => f.open && (all || sameCoach(f.home.coach, me) || sameCoach(f.away.coach, me)))
    .sort((a, b) => (a.tournament?.name ?? "").localeCompare(b.tournament?.name ?? "") || (a.round ?? 0) - (b.round ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((f) => ({ fixtureRef: f.id, tournament: f.tournament ?? null, round: f.round ?? null, home: side(f.home), away: side(f.away) }));
  return { status: 200, body: { fixtures } };
}

/** Options only the admin Testing Suite uses (same validation and store as a normal create). */
export interface CreateMatchOptions {
  test?: boolean;
  timers?: MatchTimers;
  /** Fixture lobby START only (never from a request body): each coach's resolved inducements, keyed by lower-cased coach;
   *  stored on the match by the drawn seats. */
  inducementsByCoach?: Record<string, LobbyInducements>;
  /** The fixture lobby's START (never a request body): the only way to create a match for a league fixture. */
  fromLobby?: boolean;
}

export async function createMatch(
  me: string, organiser: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date, options: CreateMatchOptions = {},
): Promise<TabletopResult> {
  const b = (body && typeof body === "object" ? { ...(body as Record<string, any>) } : {}) as Record<string, any>;
  // A body with only a fixtureRef is filled from the fixture (coaches, and the teams when they can be resolved);
  // anything the caller sends explicitly wins.
  if (typeof b.fixtureRef === "string" && b.fixtureRef) {
    const f = deps.fixtures?.get(b.fixtureRef);
    if (f) {
      const fill = (s: { coach: string; teamId?: string }) => {
        const team = s.teamId ? deps.resolveFixtureTeam?.(s.coach, s.teamId) : undefined;
        return { coach: s.coach, ...(team ? { team: team.ref } : {}) };
      };
      b.home = { ...fill(f.home), ...(b.home ?? {}) };
      b.away = { ...fill(f.away), ...(b.away ?? {}) };
    }
  }
  const side = (v: any): { coach: string; teamSaveId: string; kind: "library" | "save" } | undefined => {
    const ref = parseTeamRef(v?.team ?? v?.teamSaveId);
    return v && typeof v.coach === "string" && v.coach.trim() && ref ? { coach: v.coach.trim(), teamSaveId: ref.ref, kind: ref.kind } : undefined;
  };
  if (options.test && b.fixtureRef) return err(400, "A test match cannot be linked to a fixture.");
  // A league fixture starts from its lobby only (the start gate, the inducement hold and the presence rule live there).
  if (typeof b.fixtureRef === "string" && b.fixtureRef.startsWith("league:") && !options.fromLobby)
    return err(409, "Start this league fixture from its fixture lobby.");
  // Any other fixture (tournaments) starts from its lobby once someone opened one (a lobby write: chat, a lock, Ready);
  // fixtures without a lobby keep the direct recorder path.
  if (typeof b.fixtureRef === "string" && b.fixtureRef && !b.fixtureRef.startsWith("league:") && !options.fromLobby && deps.fixtureHasLobby) {
    let lobby: boolean;
    try { lobby = deps.fixtureHasLobby(b.fixtureRef); } catch { return err(500, "Could not read the fixture lobby right now."); }
    if (lobby) return err(409, "Start this fixture from its fixture lobby.");
  }
  let home = side(b.home);
  let away = side(b.away);
  if (!home || !away) return err(400, b.fixtureRef ? "Choose both teams: a fixture team could not be found automatically (send home.team / away.team as library:<id> or save:<id>)." : "home and away each need {coach, team}, team being library:<id> or save:<id>.");
  if (home.coach === away.coach) return err(400, "A match needs two different coaches.");
  const postMatch = b.postMatch ?? "full";
  if (typeof postMatch !== "string" || !POST_MATCH.includes(postMatch)) return err(400, "postMatch must be none, spp-only or full.");
  if (b.fixtureRef !== undefined && (typeof b.fixtureRef !== "string" || b.fixtureRef.length > 120)) return err(400, "fixtureRef must be a short string.");
  if (home.coach !== me && away.coach !== me && !organiser) return err(403, "You can only record a match you play in (or as an organiser).");
  // Home and away are drawn at random here (owner ruling 10-30), for every kind of match; the request only names the two
  // teams. The fixture check below runs on the drawn seats, so a fixture match records which way round it was played.
  const swapped = (deps.drawSeats ?? (() => flipCoin(deps.roller ?? cryptoRoller)))();
  if (swapped) [home, away] = [away, home];
  if (deps.isBanned(home.coach) || deps.isBanned(away.coach)) return err(403, "A banned account cannot play a recorded match.");
  if (b.league !== undefined && (typeof b.league !== "string" || b.league.length > 60)) return err(400, "league must be a short string.");
  let league: string | undefined = typeof b.league === "string" && b.league.trim() ? b.league.trim() : undefined;
  // The league season whose inducement table prices the pre-game (League settings, Inducements tab): it must exist and be in progress.
  let leagueSeason: MatchRecord["leagueSeason"];
  if (b.leagueSeason !== undefined && b.leagueSeason !== null) {
    const ls = b.leagueSeason as Record<string, unknown>;
    const id = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,80}$/.test(v);
    if (typeof ls !== "object" || !id(ls.leagueId) || !id(ls.seasonId)) return err(400, "leagueSeason must be { leagueId, seasonId }.");
    const found = deps.leagueInducements?.(ls.leagueId, ls.seasonId);
    if (!found) return err(409, "That league season does not exist.");
    if (!found.active) return err(409, "That league season is finished.");
    // Only a match between two coaches seated in that season (by fork account) may use its table, so nobody borrows
    // another league's cheaper inducements. The creator is already a participant or an organiser (checked above).
    const seated = new Set(found.coaches.map((c) => c.trim().toLowerCase()));
    if (![home.coach, away.coach].every((c) => seated.has(c.trim().toLowerCase())))
      return err(400, "Both coaches must have a team in that league season to use its inducement table.");
    leagueSeason = { leagueId: ls.leagueId, seasonId: ls.seasonId };
  }
  let fixtureSwap = false;
  if (b.fixtureRef) {
    const fixture = deps.fixtures?.get(b.fixtureRef);
    if (!fixture) return err(409, "That fixture does not exist.");
    if (!fixture.open) return err(409, "That fixture is already resolved or closed.");
    const k = (s: string) => s.trim().toLowerCase();
    const straight = k(fixture.home.coach) === k(home.coach) && k(fixture.away.coach) === k(away.coach);
    fixtureSwap = k(fixture.home.coach) === k(away.coach) && k(fixture.away.coach) === k(home.coach);
    if (!straight && !fixtureSwap) return err(409, "The fixture's coaches do not match this match's home and away coaches.");
    league ??= fixture.packageName;
  }
  // From here the two team chains are read, pinned and checked for open matches: under both TEAM locks (teamLock.ts), so a
  // Team Captain appoint / revoke or a commit on either team cannot interleave.
  const homeSeat = home, awaySeat = away;
  return withTeamLocks([teamLockKey(homeSeat), teamLockKey(awaySeat)], async (): Promise<TabletopResult> => {
  const home = homeSeat, away = awaySeat;
  // One unfinished match per fixture.
  if (b.fixtureRef && (await deps.repo.listMatches()).some((m) => m.fixtureRef === b.fixtureRef && (m.state === "recording" || m.state === "submitted")))
    return err(409, "This fixture already has a match in progress.");
  const at = now().toISOString();
  const chainHome = await ensureChain(deps, home.coach, home.teamSaveId, at);
  const chainAway = await ensureChain(deps, away.coach, away.teamSaveId, at);
  if (chainHome && "error" in chainHome) return err(422, chainHome.error);
  if (chainAway && "error" in chainAway) return err(422, chainAway.error);
  if (!chainHome) return err(404, `${home.coach} has no ${home.kind === "library" ? "library team" : "saved team"} ${home.teamSaveId}.`);
  if (!chainAway) return err(404, `${away.coach} has no ${away.kind === "library" ? "library team" : "saved team"} ${away.teamSaveId}.`);
  for (const s of [home, away])
    if (await deps.repo.findOpenMatchForSave(s.coach, s.teamSaveId)) return err(409, `${s.coach}'s team is already in an unfinished recorded match.`);
  const match: MatchRecord = {
    id: `tm_${randomBytes(9).toString("hex")}`,
    state: "recording",
    ...(b.fixtureRef ? { fixtureRef: b.fixtureRef } : {}),
    home: { ...home, teamName: headRevision(chainHome).teamFile.name },
    away: { ...away, teamName: headRevision(chainAway).teamFile.name },
    phase: (b.pregame === "skip" ? "playing" : "pregame:fans") as MatchPhase,
    ...(b.pregame === "skip" ? { clock: initialClock([]), timers: options.timers ?? ({ mode: "off", seconds: DEFAULT_TURN_TIMER_POLICY.seconds, enforced: "off" } as MatchTimers) } : {}),
    ...(b.pregame !== "skip" && options.timers ? { timers: options.timers } : {}), // preset: the pre-game skips the timers question
    ...(options.test ? { test: true as const } : {}),
    ...(b.allowOvertime === true ? { allowOvertime: true } : {}),
    ...(league ? { league } : {}),
    ...(leagueSeason ? { leagueSeason } : {}),
    ...(fixtureSwap ? { fixtureSwap } : {}),
    ...(options.inducementsByCoach ? { inducements: {
      home: options.inducementsByCoach[home.coach.trim().toLowerCase()] ?? { picks: [], total: 0, treasury: 0, pettyCash: 0 },
      away: options.inducementsByCoach[away.coach.trim().toLowerCase()] ?? { picks: [], total: 0, treasury: 0, pettyCash: 0 },
    } } : {}),
    postMatch: postMatch as PostMatchOption,
    createdBy: me,
    createdAt: at,
    updatedAt: at,
    confirmations: {},
    baseRevision: { home: chainHome.head, away: chainAway.head },
  };
  await deps.repo.createMatch(match);
  const seeded = lobbyInducementEvents(match, me, at);
  // the lobby's resolved inducements are the pre-game submissions (treasury spent as resolved); the step is skipped later
  await deps.repo.appendEvents(match.id, [seatsEvent(match, "pg-seats", { stage: "draw", swapped, rolledBy: "site" }, me, at), ...seeded]);
  // a fixture is starting: refresh the NAF cache of both coaches in the background (never awaited, never fails the request)
  try { void Promise.resolve(deps.naf?.refreshFor?.([home.coach, away.coach])).catch((e) => console.warn(`[naf] refresh failed: ${(e as Error).message}`)); }
  catch (e) { console.warn(`[naf] refresh failed: ${(e as Error).message}`); }
  return { status: 201, body: { match } };
  });
}

/** The lobby's resolved inducements as the pre-game submissions of both seats (ids pg-inducement-<side>: idempotent). */
function lobbyInducementEvents(match: MatchRecord, by: string, at: string): TabletopEvent[] {
  if (!match.inducements) return [];
  return (["home", "away"] as const).map((side) => {
    const ind = match.inducements![side];
    return {
      id: `pg-inducement-${side}`, matchId: match.id, type: "inducement" as const, team: side, ts: at, by,
      payload: { picks: ind.picks, total: ind.total, treasury: ind.treasury, pettyCash: ind.pettyCash, skipped: ind.picks.length === 0, submittedBy: by, lobby: true },
    };
  });
}

/**
 * Fixture lobby recovery (an interrupted or refused START): the unfinished match for this fixtureRef, adopted only when
 * its two coaches and teams are the fixture's CURRENT ones; otherwise `{ error }` (an organiser must close the old match).
 * A match whose lobby submissions were not written (the event append failed) gets them now, once (event ids).
 * undefined = no unfinished match for the fixture.
 */
export async function adoptLobbyMatch(deps: TabletopApiDeps, input: {
  fixtureRef: string; actor: string; home: { coach: string; team: string }; away: { coach: string; team: string };
  inducementsByCoach?: Record<string, LobbyInducements>; now?: Date;
}): Promise<{ matchId: string } | { error: string } | undefined> {
  const m = (await deps.repo.listMatches()).find((x) => x.fixtureRef === input.fixtureRef && (x.state === "recording" || x.state === "submitted"));
  if (!m) return undefined;
  const key = (c: string) => c.trim().toLowerCase();
  const want = new Map([[key(input.home.coach), parseTeamRef(input.home.team)?.ref], [key(input.away.coach), parseTeamRef(input.away.team)?.ref]]);
  const same = want.size === 2 && [m.home, m.away].every((s) => want.has(key(s.coach)) && want.get(key(s.coach)) === s.teamSaveId);
  if (!same) return { error: "A match with the previous coaches or teams is still open for this fixture. An organiser must close it before this lobby can start." };
  const by = input.inducementsByCoach;
  const home = by?.[key(m.home.coach)], away = by?.[key(m.away.coach)];
  if (home && away) {
    await serial(m.id, async () => {
      const fresh = (await deps.repo.getMatch(m.id)) ?? m;
      if (!fresh.inducements) {
        fresh.inducements = { home, away };
        await deps.repo.updateMatch(fresh);
      }
      const events = await deps.repo.readEvents(m.id);
      const missing = lobbyInducementEvents(fresh, input.actor, (input.now ?? new Date()).toISOString()).filter((e) => !events.some((x) => x.id === e.id));
      if (missing.length) {
        await deps.repo.appendEvents(m.id, missing);
        dropSnapshot(m.id);
      }
    }, matchTeamKeys(m));
  }
  return { matchId: m.id };
}

/** A `seats` log row: who sits where (names copied in, so the row still reads right after a later swap). */
function seatsEvent(match: MatchRecord, id: string, payload: Record<string, unknown>, by: string, at: string): TabletopEvent {
  const seat = (s: MatchRecord["home"]) => ({ coach: s.coach, teamName: s.teamName });
  return { id, matchId: match.id, type: "seats", team: "home", payload: { ...payload, home: seat(match.home), away: seat(match.away) }, ts: at, by };
}

/**
 * POST .../seats/swap: an organiser swaps home and away (owner ruling 10-30), logged as a `seats` row. Only before the
 * first pre-game record, because every pre-game record (fans, journeymen, inducements, the coin) names a seat. The
 * match's base revisions and a fixture's orientation swap with the seats.
 */
async function swapSeats(match: MatchRecord, me: string, organiser: boolean, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (!organiser) return err(403, "Only an organiser can swap home and away.");
  if (match.state !== "recording") return err(409, `This match is ${match.state}.`);
  // only at the very start: the first pre-game phase (a skipped pre-game, or a running turn, can never swap)
  if ((match.phase ?? "playing") !== "pregame:fans") return err(409, "Home and away can only be swapped before the pre-game starts.");
  const stored = await deps.repo.readEvents(match.id);
  if (!seatsSwappable(stored)) return err(409, "The pre-game has started: home and away can only be swapped before the first pre-game roll.");
  const at = now().toISOString();
  const { fixtureSwap: _fs, ...rest } = match;
  const flipped = match.fixtureRef ? match.fixtureSwap !== true : false;
  const updated: MatchRecord = {
    ...rest, home: match.away, away: match.home, updatedAt: at,
    baseRevision: { home: match.baseRevision.away, away: match.baseRevision.home },
    ...(flipped ? { fixtureSwap: true } : {}),
  };
  const n = stored.filter((e) => e.type === "seats" && e.payload.stage === "swap").length;
  const base = seatsEvent(updated, `pg-seatswap-${n + 1}`, { stage: "swap" }, me, at);
  const row: TabletopEvent = updated.home.coach !== me && updated.away.coach !== me ? { ...base, admin: true } : base;
  await deps.repo.appendEvents(match.id, [row]);
  await deps.repo.updateMatch(updated);
  const events = [...stored, row];
  const clock = clockView(updated, events, deps, now());
  deps.publishClock?.(match.id, { ...clock, phase: updated.phase ?? "playing" });
  return { status: 200, body: { match: updated, recorded: [row.id], pregame: pregameViewOf(updated, events, { home: undefined, away: undefined }, deps) } };
}

/** Events that belong to the match rather than a team: every other event credits or names a player of `team`, so a participant may record it for their own team only. */
const BOTH_TEAM_EVENTS: ReadonlySet<string> = new Set(["weather", "endOfMatch"]);

/** `manage`: an organiser of this match's league / tournament or an admin (deps.managesMatch): may undo an inducement edit on
 *  either side, even without being a recorder organiser or a seat. */
async function postEvents(match: MatchRecord, me: string, organiser: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date, manage = organiser): Promise<TabletopResult> {
  // Recording: anyone in the match records; participants may undo their own side's events. Once submitted, only an
  // organiser may undo events (the preview is recomputed); confirmed / published matches need a revert first.
  const reopenForUndo = match.state === "submitted";
  if (match.state !== "recording" && !reopenForUndo) return err(409, `This match is ${match.state}; events can only be added while recording.`);
  if ((match.phase ?? "playing") !== "playing") return err(409, `Finish the pre-game first (the match is at ${match.phase}).`);
  const raw = (body as { events?: unknown } | undefined)?.events;
  if (!Array.isArray(raw) || raw.length === 0) return err(400, "events must be a non-empty array.");
  if (raw.length > MAX_EVENTS_PER_BATCH) return err(400, `At most ${MAX_EVENTS_PER_BATCH} events per request.`);
  const stored = await deps.repo.readEvents(match.id);
  const teams = overlayRosters(await currentTeams(deps.repo, match), stored);
  if (!teams.home || !teams.away) return err(409, "Team files are missing.");
  const rosters = { home: teams.home, away: teams.away };
  const known = new Set(stored.map((e) => e.id));
  const running = [...stored];
  const clock = currentClock(match, stored);
  const mySides = (["home", "away"] as const).filter((sd) => match[sd].coach === me);
  const accepted: TabletopEvent[] = [];
  const duplicates: string[] = [];
  const at = now().toISOString();
  for (const r of raw) {
    const parsed = parseEvent(r, match.id, me, at);
    if (!parsed.ok) return err(400, parsed.error);
    if (known.has(parsed.event.id)) { duplicates.push(parsed.event.id); continue; }
    // an organiser's after-start inducement edit is undone only by a manager (managesMatch), on either side, recording or submitted
    const undoTarget = parsed.event.type === "undo" ? running.find((e) => e.id === parsed.event.payload.target) : undefined;
    const adminEditUndo = undoTarget?.type === "inducement" && undoTarget.payload.adminEdit === true;
    if (adminEditUndo && !manage) return err(403, "Only an organiser of this league or tournament (or an admin) can undo an inducement edit.");
    // a manager who is neither a seat nor a recorder organiser reaches here only for that undo
    if (!adminEditUndo && !organiser && mySides.length === 0) return err(403, "You are watching this match: only its coaches and organisers can change it.");
    // after submit only an organiser edits the report (undo, and adding or correcting events for either side); the preview is recomputed below
    // (one exception: a coach may still add their OWN team's MVP after submit, until the match is confirmed)
    if (reopenForUndo && parsed.event.type !== "undo" && !organiser && !(parsed.event.type === "mvp" && mySides.includes(parsed.event.team))) return err(409, `This match is ${match.state}; only an organiser can edit events now.`);
    // a participant records results for their OWN team only (touchdown, casualty causer, injury victim, MVP); organisers adjudicate both sides
    if (!organiser && !BOTH_TEAM_EVENTS.has(parsed.event.type) && parsed.event.type !== "undo") {
      if (!mySides.includes(parsed.event.team)) return err(403, "You can only record results for your own team; an organiser can for either.");
      // a casualty's victim must be on the opposing team for a participant (an organiser may set either)
      if (parsed.event.type === "casualty" && parsed.event.payload.victimTeam !== undefined && parsed.event.payload.victimTeam === parsed.event.team)
        return err(403, "A casualty's victim must be on the opposing team.");
    }
    if (parsed.event.type === "undo") {
      if (reopenForUndo && !organiser && !adminEditUndo) return err(403, "Once the match is submitted only an organiser can undo events.");
      if (!organiser && !adminEditUndo) {
        const target = running.find((e) => e.id === parsed.event.payload.target);
        // a participant may also retract a casualty / injury THEY recorded, on either roster, while the match is recording
        const mineToRetract = target !== undefined && (target.type === "casualty" || target.type === "injury") && target.by === me && match.state === "recording";
        if (target && !mySides.includes(target.team) && !mineToRetract) return err(403, "You can only undo your own side's events; an organiser can undo any.");
      }
    } else if (parsed.event.half === undefined || (parsed.event.turn === undefined && clock.turn >= 1)) {
      // the server stamps the match clock on events the client left unmarked
      parsed.event = {
        ...parsed.event,
        ...(parsed.event.half === undefined ? { half: clock.half } : {}),
        ...(parsed.event.turn === undefined && clock.turn >= 1 ? { turn: clock.turn } : {}),
      };
    }
    const v = validateEvent(parsed.event, running, rosters);
    if ("error" in v) return err(v.status ?? 400, v.error);
    // an organiser acting for a team they do not coach (an undo carries its target's team) is stamped admin: persisted, replayed, shown in the log
    // (a both-team event - weather, end of match - defaults to team "home", so it counts as admin only when the organiser plays in neither team)
    if (adminEditUndo || (organiser && (BOTH_TEAM_EVENTS.has(v.event.type) ? mySides.length === 0 : !mySides.includes(v.event.team)))) v.event = { ...v.event, admin: true };
    known.add(v.event.id);
    running.push(v.event);
    accepted.push(v.event);
    // undoing an inducement edit also undoes the petty-cash adjustment it made to the other team (editInducements)
    const follow = v.event.type === "undo" ? running.find((e) => e.type === "inducement" && e.payload.followsFrom === v.event.payload.target) : undefined;
    if (follow) {
      const extra: TabletopEvent = { ...v.event, id: `u${randomBytes(12).toString("hex")}`, team: follow.team, payload: { target: follow.id, with: v.event.id } };
      known.add(extra.id);
      running.push(extra);
      accepted.push(extra);
    }
  }
  if (stored.length + accepted.length > MAX_EVENTS_PER_MATCH) return err(409, "This match has too many events.");
  await deps.repo.appendEvents(match.id, accepted);
  if (accepted.length && deps.onEvents) { try { deps.onEvents(match, accepted, teams); } catch { /* Discord is best effort */ } }
  const result = {
    accepted: accepted.map((e) => e.id), duplicates, total: stored.length + accepted.length, tally: tallyView(running, teams),
    clock: clockView(match, running, deps, now()),
  };
  if (reopenForUndo && accepted.length) {
    // an organiser's undo after submit: the preview both coaches saw is stale, so recompute it and clear confirmations
    const p = await computePreview(match, running, deps);
    if (!p.ok) return p.error;
    const next: MatchRecord = { ...match, confirmations: {}, preview: { home: p.home.summary, away: p.away.summary }, updatedAt: now().toISOString() };
    await deps.repo.updateMatch(next);
    return { status: 200, body: { ...result, match: next } };
  }
  // endOfMatch is the submit: the match moves to submitted in the same request.
  if (accepted.some((e) => e.type === "endOfMatch")) {
    const submitted = await submit(match, deps, now);
    if (submitted.status !== 200) return submitted;
    return { status: 200, body: { ...result, submitted: true, match: (submitted.body as { match: MatchRecord }).match } };
  }
  return { status: 200, body: result };
}

/** Preview both teams' post-match from the CURRENT head revisions; 409 if a head moved since creation. */
async function computePreview(match: MatchRecord, events: TabletopEvent[], deps: TabletopApiDeps) {
  const chainHome = await deps.repo.getChain(match.home.coach, match.home.teamSaveId);
  const chainAway = await deps.repo.getChain(match.away.coach, match.away.teamSaveId);
  if (!chainHome || !chainAway) return { ok: false as const, error: err(409, "Team files are missing.") };
  if (chainHome.head !== match.baseRevision.home || chainAway.head !== match.baseRevision.away)
    return { ok: false as const, error: err(409, "A team changed since this match was created; start a new match.") };
  const opt = { postMatch: match.postMatch, ruleset: "bb2025" as const, matchId: match.id };
  const home = applyPostMatch(headRevision(chainHome).teamFile, events, { ...opt, team: "home" });
  const away = applyPostMatch(headRevision(chainAway).teamFile, events, { ...opt, team: "away" });
  return { ok: true as const, chainHome, chainAway, home, away };
}

async function submit(match: MatchRecord, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state !== "recording") return err(409, `This match is already ${match.state}.`);
  if ((match.phase ?? "playing") !== "playing") return err(409, `Finish the pre-game first (the match is at ${match.phase}).`);
  const p = await computePreview(match, await deps.repo.readEvents(match.id), deps);
  if (!p.ok) return p.error;
  const next: MatchRecord = {
    ...match, state: "submitted", updatedAt: now().toISOString(), confirmations: {},
    preview: { home: p.home.summary, away: p.away.summary },
  };
  await deps.repo.updateMatch(next);
  return { status: 200, body: { match: next } };
}

async function confirm(match: MatchRecord, me: string, organiser: boolean, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state !== "submitted") return err(409, `This match is ${match.state}; only a submitted match can be confirmed.`);
  const at = now().toISOString();
  const confirmations = { ...match.confirmations };
  if (organiser) { confirmations[match.home.coach] = at; confirmations[match.away.coach] = at; }
  else confirmations[me] = at;
  const complete = Boolean(confirmations[match.home.coach] && confirmations[match.away.coach]);
  if (!complete) {
    const next = { ...match, confirmations, updatedAt: at };
    await deps.repo.updateMatch(next);
    return { status: 200, body: { match: next } };
  }
  // an organiser confirming for both coaches is recorded as such (who, when) on the match and the journal, not as two coach confirmations
  const built = await buildConfirmJournal(match, me, confirmations, deps, at, organiser);
  if (!built.ok) return built.error;
  const done = await commit(built.journal, deps);
  if (done.status === 200) { notifyConfirmed(match, me, deps); await announceResult(built.journal.match, deps); }
  return done;
}

/**
 * The final result for the Discord webhook (owner ruling 10-30): posted once each time a match is confirmed for good
 * (both coaches, an organiser for both, or the organiser's confirm-and-publish). Built from the same tally as the
 * results row. Best effort: nothing here can fail the confirmation.
 */
async function announceResult(match: MatchRecord, deps: TabletopApiDeps): Promise<void> {
  if (!deps.announce && !deps.onResult) return;
  try {
    const events = await deps.repo.readEvents(match.id);
    const teams = overlayRosters(await currentTeams(deps.repo, match), events);
    if (deps.announce) announce(deps, ["result"], match, events, resultSummaryOf(events, teams));
    // the competition's own Discord (end-of-game digest): never awaited, never fails the confirmation
    if (deps.onResult) void Promise.resolve().then(() => deps.onResult!(match, events, teams)).catch((e) => console.warn(`[discord] result post failed: ${(e as Error).message}`));
  } catch (e) {
    console.warn(`[recorder-webhook] result summary failed: ${(e as Error).message}`);
  }
}

/** Score, casualties, concession, MVPs and scorers per side, named from the rosters (the Discord result embed). */
export function resultSummaryOf(events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>): ResultSummary {
  const names = (t: TabletopTeamFile | undefined) => new Map((t?.players ?? []).map((p) => [p.id, p.name] as const));
  const t = tallyMatch(events, { home: names(teams.home), away: names(teams.away) }, kindLookup(teams));
  // casualties CAUSED: effective casualty events attributed to the causing side (e.team), bucketed like the result row
  // (BH / SI = MNG, NI, stat loss / dead). A standalone injury has no causer and counts for nobody.
  const caused: Record<Side, { bh: number; si: number; rip: number }> = { home: { bh: 0, si: 0, rip: 0 }, away: { bh: 0, si: 0, rip: 0 } };
  for (const e of effectiveEvents(events)) {
    if (e.type !== "casualty") continue;
    const result = e.payload.result as string;
    const b = caused[e.team];
    if (result === "BH") b.bh += 1; else if (result === "DEAD") b.rip += 1; else b.si += 1;
  }
  const side = (s: Side) => {
    const lines = [...t.lines[s].values()];
    return {
      score: t.score[s],
      casualties: caused[s],
      conceded: t.conceded[s],
      scorers: lines.filter((l) => l.touchdowns > 0).map((l) => ({ name: l.name, touchdowns: l.touchdowns })),
      mvps: lines.filter((l) => l.mvp > 0).map((l) => l.name),
    };
  };
  return { home: side("home"), away: side("away") };
}

type Built = { ok: true; journal: CommitJournal } | { ok: false; error: TabletopResult };

/** Everything a finalising confirm writes, as one journal (bans rechecked first). */
async function buildConfirmJournal(
  match: MatchRecord, me: string, confirmations: Record<string, string>, deps: TabletopApiDeps, at: string, admin = false,
): Promise<Built> {
  // Bans are rechecked immediately before finalisation: both participants and the confirming caller.
  for (const coach of new Set([match.home.coach, match.away.coach, me]))
    if (deps.isBanned(coach)) return { ok: false, error: err(403, coach === me ? BANNED_ACCOUNT_MESSAGE : `${coach} is banned; the match cannot be finalised.`) };
  if (await recoveryPending(match, deps)) return { ok: false, error: recoveryPendingError() };
  const events = await deps.repo.readEvents(match.id);
  const p = await computePreview(match, events, deps);
  if (!p.ok) return { ok: false, error: p.error };

  let wroteRevisions: MatchRecord["wroteRevisions"];
  let homeChain = p.chainHome;
  let awayChain = p.chainAway;
  if (match.postMatch !== "none") {
    const add = (chain: TeamChain, file: TabletopTeamFile): TeamChain => {
      const revision = chain.revisions.length;
      return {
        ...chain, head: revision,
        revisions: [...chain.revisions, { saveId: chain.saveId, revision, parent: chain.head, teamFile: file, matchId: match.id, createdAt: at }],
      };
    };
    homeChain = add(p.chainHome, p.home.teamFile);
    awayChain = add(p.chainAway, p.away.teamFile);
    wroteRevisions = { home: homeChain.head, away: awayChain.head };
  }

  // Results row into the same store the standings / Elo read, flagged tabletop. Built from the same tally.
  const names = (c: TeamChain) => new Map(headRevision(c).teamFile.players.map((pl) => [pl.id, pl.name] as const));
  const tally = tallyMatch(events, { home: names(p.chainHome), away: names(p.chainAway) },
    kindLookup({ home: headRevision(p.chainHome).teamFile, away: headRevision(p.chainAway).teamFile }));
  const teamResult = (side: Side, summary: PostMatchSummary) => ({
    teamId: match[side].teamSaveId,
    score: tally.score[side],
    winnings: summary.winnings,
    penaltyScore: -1,
    conceded: tally.conceded[side],
    casualtiesSuffered: tally.casualtiesSuffered[side],
    players: [...tally.lines[side].values()].map((l) => ({
      playerId: l.id, name: l.name, touchdowns: l.touchdowns, casualtiesCaused: l.casualtiesCaused, blocks: 0, fouls: l.fouls,
      completions: l.completions, interceptions: l.interceptions, deflections: l.deflections, mvp: l.mvp,
    })),
  });
  const gameId = resultGameId(match.id);
  // the team value each side brought (its head team file before this match), for the coach rating's team-value term
  const ctv = (chain: TeamChain): { teamValue?: number } => { const v = headRevision(chain).teamFile.teamValue; return typeof v === "number" && v > 0 ? { teamValue: v } : {}; };
  const row: StoredTournamentResult = {
    gameId,
    pulledAt: at,
    playedAt: events.findLast((e) => e.type === "endOfMatch" && typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts)))?.ts ?? at, // the end of the match, else the confirmation
    source: "tabletop",
    ...(match.fixtureRef ? { fixtureRef: match.fixtureRef } : {}),
    ...(match.league ? { league: match.league } : {}),
    published: false,
    ...(match.test ? { test: true } : {}),
    home: { teamId: match.home.teamSaveId, teamName: match.home.teamName, coach: match.home.coach, ...ctv(p.chainHome) },
    away: { teamId: match.away.teamSaveId, teamName: match.away.teamName, coach: match.away.coach, ...ctv(p.chainAway) },
    teams: [teamResult("home", p.home.summary), teamResult("away", p.away.summary)],
  };
  const next: MatchRecord = {
    ...match, state: "confirmed", confirmations, updatedAt: at, preview: { home: p.home.summary, away: p.away.summary },
    ...(admin ? { confirmedBy: { by: me, at, admin: true } } : {}),
    ...(wroteRevisions ? { wroteRevisions } : {}), resultGameId: gameId,
  };
  const change = (before: TeamChain, target: TeamChain): ChainChange => ({ expect: { head: before.head, revisions: before.revisions.length }, target });
  return {
    ok: true,
    journal: {
      matchId: match.id, opId: opId(), kind: "confirm", by: me, ...(admin ? { admin: true } : {}),
      ...(match.postMatch !== "none" ? { homeChain: change(p.chainHome, homeChain), awayChain: change(p.chainAway, awayChain) } : {}),
      result: { put: row }, match: next,
    },
  };
}

async function undoRevision(match: MatchRecord, deps: TabletopApiDeps, now: () => Date, note?: string, actor?: string): Promise<TabletopResult> {
  if (match.state !== "confirmed" && match.state !== "published") return err(409, "Only a confirmed or published match can be reverted.");
  if (await recoveryPending(match, deps)) return recoveryPendingError();
  const chainHome = await deps.repo.getChain(match.home.coach, match.home.teamSaveId);
  const chainAway = await deps.repo.getChain(match.away.coach, match.away.teamSaveId);
  if (!chainHome || !chainAway) return err(409, "Team files are missing.");
  const w = match.wroteRevisions;
  if (w && (chainHome.head !== w.home || chainAway.head !== w.away)) {
    // a Team Captain appointed after this match sits on top (tabletop/captain.ts): it is revoked explicitly, never dropped
    const appointed = [chainHome, chainAway].find((c, i) => { const h = headRevision(c); return h.appointment && h.parent === (i === 0 ? w.home : w.away); });
    if (appointed) return err(409, `${headRevision(appointed).teamFile.name} appointed a new Team Captain after this match; revoke the appointment first.`);
    return err(409, "A team has newer revisions than this match; revert those first.");
  }
  let link = match.state === "published" ? match.fixtureLink : undefined;
  if (link) {
    const f = deps.fixtures?.get(link.id);
    // An organiser cleared this publication's result in the tournament (owner ruling 10-29 Â§7): the fixture already let
    // go of it, so the revert leaves the fixture alone (it is unplayed) and a later publish records it again.
    if (f && !f.resultReportedAt && f.clearedOpId === link.opId) link = undefined;
    else if (!f || f.resultOpId !== link.opId || f.revision !== link.expectedRevision + 1)
      return err(409, "The fixture changed since this result was published; resolve it in the tournament first.");
  }
  const back = (chain: TeamChain, rev: number): TeamChain => ({ ...chain, head: chain.revisions.find((r) => r.revision === rev)!.parent! });
  const { wroteRevisions: _w, resultGameId: _r, preview: _p, fixtureLink: _fl, publishedAt: _pa, publishedBy: _pb, ...rest } = match;
  const next: MatchRecord = { ...rest, state: "recording", confirmations: {}, updatedAt: now().toISOString(), ...(note ? { note } : {}) };
  return commit({
    matchId: match.id, opId: opId(), kind: "undo", ...(actor ? { by: actor, admin: true } : {}),
    ...(w ? {
      homeChain: { expect: { head: chainHome.head, revisions: chainHome.revisions.length }, target: back(chainHome, w.home) },
      awayChain: { expect: { head: chainAway.head, revisions: chainAway.revisions.length }, target: back(chainAway, w.away) },
    } : {}),
    result: match.resultGameId ? { remove: match.resultGameId } : null,
    ...(link ? { fixture: { op: "retract" as const, id: link.id, opId: link.opId, expectedRevision: link.expectedRevision + 1, status: link.priorStatus, at: next.updatedAt } } : {}),
    match: next,
  }, deps);
}

async function publish(match: MatchRecord, me: string, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state !== "confirmed") return err(409, `This match is ${match.state}; only a confirmed match can be published.`);
  const at = now().toISOString();
  const stored = match.resultGameId ? deps.results.get(match.resultGameId) : undefined;
  if (!stored || !match.preview) return err(409, "The match's confirmed result is missing.");
  const op = opId();
  const fx = fixtureForPublish(match, at, deps, op);
  if ("error" in fx) return fx.error;
  const { fixture, fixtureLink } = fx;
  const next: MatchRecord = { ...match, state: "published", publishedAt: at, publishedBy: me, updatedAt: at, ...(fixtureLink ? { fixtureLink } : {}) };
  return commit({
    matchId: match.id, opId: op, kind: "publish", // a publication never rewrites team chains
    result: { put: { ...stored, published: true } }, ...(fixture ? { fixture } : {}), match: next,
  }, deps);
}

/** The fixture record op for publishing `match` (preview must exist), or a 409. */
function fixtureForPublish(match: MatchRecord, at: string, deps: TabletopApiDeps, op: string):
  { error: TabletopResult } | { fixture?: CommitJournal["fixture"]; fixtureLink?: MatchRecord["fixtureLink"] } {
  const preview = match.preview!;
  let fixture: CommitJournal["fixture"];
  let fixtureLink: MatchRecord["fixtureLink"];
  if (match.fixtureRef) {
    const f = deps.fixtures?.get(match.fixtureRef);
    if (!f || !f.open) return { error: err(409, "The fixture is no longer open; resolve it in the tournament first.") };
    const cas = (s: PostMatchSummary) => s.players.reduce((n, p) => n + p.casualtiesCaused, 0);
    const swapped = match.fixtureSwap === true;
    const [h, a] = swapped ? [preview.away, preview.home] : [preview.home, preview.away];
    fixture = {
      op: "record", id: match.fixtureRef, opId: op, expectedRevision: f.revision, at,
      homeScore: h.score.for, awayScore: a.score.for, homeCasualties: cas(h), awayCasualties: cas(a),
    };
    fixtureLink = { id: match.fixtureRef, priorStatus: f.status, expectedRevision: f.revision, reportedAt: at, swapped, opId: op };
  }
  return { fixture, fixtureLink };
}

const opId = (): string => randomBytes(8).toString("hex");

/** The world changed since a commit was prepared: it must not be applied over the newer state. */
export class JournalConflict extends Error {}

const teamKey = (s: { coach: string; teamSaveId: string }): string => `${s.coach}\0${s.teamSaveId}`;

/** Another match's unresolved journal on either of this match's teams blocks chain-touching commits. */
async function recoveryPending(match: MatchRecord, deps: TabletopApiDeps): Promise<boolean> {
  const mine = new Set([teamKey(match.home), teamKey(match.away)]);
  for (const id of await deps.repo.listJournalMatchIds()) {
    if (id === match.id) continue;
    const j = await deps.repo.getJournal(id);
    if (j && [j.match.home, j.match.away].some((side) => mine.has(teamKey(side)))) return true;
  }
  return false;
}
const recoveryPendingError = (): TabletopResult => err(409, "Recovery pending: an unfinished commit on another match uses one of these teams.");

function recoveryFailure(e: unknown): TabletopResult {
  if (e instanceof JournalConflict) return { status: 409, body: { error: `Recovery conflict: ${e.message}`, conflict: true } };
  return err(500, "An earlier commit on this match is still being completed; try again.");
}

/** Decide, WITHOUT writing, what each part of a journal still needs; throws JournalConflict if anything moved. */
async function preflight(j: CommitJournal, deps: TabletopApiDeps): Promise<{ home: boolean; away: boolean; fixture: boolean }> {
  const chain = async (change?: ChainChange): Promise<boolean> => {
    if (!change) return false;
    const cur = await deps.repo.getChain(change.target.coach, change.target.saveId);
    if (!cur) throw new JournalConflict(`${change.target.coach}'s team file is missing`);
    if (JSON.stringify(cur) === JSON.stringify(change.target)) return false; // already applied
    if (cur.head === change.expect.head && cur.revisions.length === change.expect.revisions) return true;
    throw new JournalConflict(`${change.target.coach}'s team changed (now at revision ${cur.head}) since this commit was prepared`);
  };
  const home = await chain(j.homeChain);
  const away = await chain(j.awayChain);
  let fixture = false;
  if (j.fixture) {
    if (!deps.fixtures) throw new Error("no fixture gateway");
    const f = deps.fixtures.get(j.fixture.id);
    if (!f) throw new JournalConflict("the fixture no longer exists");
    if (j.fixture.op === "record") {
      if (f.revision === j.fixture.expectedRevision && !f.resultReportedAt) fixture = true;
      else if (f.resultOpId !== j.opId) throw new JournalConflict("the fixture was changed by someone else since this commit was prepared");
    } else if (f.resultOpId === j.fixture.opId && f.revision === j.fixture.expectedRevision) {
      fixture = true;
    } else if (!(f.revision === j.fixture.expectedRevision + 1 && !f.resultReportedAt)) {
      throw new JournalConflict("the fixture result was changed by someone else since it was published");
    }
  }
  return { home, away, fixture };
}

/** Preflight everything, then apply what is still needed (every write is a full-state, idempotent one), then clear. */
async function applyJournal(j: CommitJournal, deps: TabletopApiDeps): Promise<void> {
  const need = await preflight(j, deps);
  if (need.home) await deps.repo.putChain(j.homeChain!.target);
  if (need.away) await deps.repo.putChain(j.awayChain!.target);
  if (need.fixture && j.fixture) {
    const fx = j.fixture;
    if (fx.op === "record") {
      const { op: _op, id, at, opId: stamp, ...input } = fx;
      deps.fixtures!.record(id, { ...input, opId: stamp }, new Date(at));
    } else {
      deps.fixtures!.retract(fx.id, { expectedRevision: fx.expectedRevision, status: fx.status }, new Date(fx.at));
    }
  }
  if (j.result && "put" in j.result) deps.results.put(j.result.put);
  else if (j.result) deps.results.remove(j.result.remove);
  await deps.repo.updateMatch(j.match);
  await deps.repo.clearJournal(j.matchId);
}

async function markConflict(j: CommitJournal, reason: string, deps: TabletopApiDeps): Promise<void> {
  try { await deps.repo.putJournal({ ...j, state: "conflict", conflict: reason }); } catch { /* the journal stays pending */ }
}

/** Journal first (with its sequence), then apply. A failure part-way leaves the journal for replay; a retry completes it. */
async function commit(journal: CommitJournal, deps: TabletopApiDeps): Promise<TabletopResult> {
  let j = journal;
  try {
    j = { ...journal, seq: journal.seq ?? (await deps.repo.nextJournalSeq()), state: "pending" };
    await deps.repo.putJournal(j);
    await applyJournal(j, deps);
  } catch (e) {
    if (e instanceof JournalConflict) {
      await markConflict(j, e.message, deps);
      return recoveryFailure(e);
    }
    return err(500, "The commit was recorded but not fully applied; it will be completed when you retry.");
  }
  return { status: 200, body: { match: j.match } };
}

/** Replay an unfinished journal for one match to completion (undefined when none). A conflict is surfaced, never overwritten. */
export async function recoverMatch(matchId: string, deps: TabletopApiDeps): Promise<CommitJournal | undefined> {
  const j = await deps.repo.getJournal(matchId);
  if (!j) return undefined;
  if (j.state === "conflict") throw new JournalConflict(j.conflict ?? "an earlier commit conflicted");
  try {
    await applyJournal(j, deps);
  } catch (e) {
    if (e instanceof JournalConflict) await markConflict(j, e.message, deps);
    throw e;
  }
  return j;
}

/** Startup recovery: replay unfinished journals in their recorded sequence, skipping conflicts. Returns the match ids completed. */
export async function recoverTabletop(deps: TabletopApiDeps): Promise<string[]> {
  const journals: CommitJournal[] = [];
  for (const id of await deps.repo.listJournalMatchIds()) {
    const j = await deps.repo.getJournal(id);
    if (j && j.state !== "conflict") journals.push(j);
  }
  journals.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const done: string[] = [];
  for (const j of journals) {
    try { if (await withTeamLocks(matchTeamKeys(j.match), () => recoverMatch(j.matchId, deps))) done.push(j.matchId); } catch { /* conflict is marked; others retry later */ }
  }
  return done;
}

// ---- Lane T4: organiser tools -------------------------------------------------------------------

const BULK_MAX = 100;

/** Matches linked to a tournament (and optionally a round) through fixtureRef `<tournamentId>:round:<n>:match:<k>`. */
async function matchesFor(query: URLSearchParams, deps: TabletopApiDeps): Promise<{ error: TabletopResult } | { matches: MatchRecord[] }> {
  const tournament = query.get("tournament")?.trim() ?? "";
  if (!tournament || tournament.length > 120) return { error: err(400, "tournament is required.") };
  const roundRaw = query.get("round");
  let prefix = `${tournament}:round:`;
  if (roundRaw !== null && roundRaw !== "") {
    if (!/^\d{1,3}$/.test(roundRaw)) return { error: err(400, "round must be a number.") };
    prefix += `${Number(roundRaw)}:`;
  }
  const all = await deps.repo.listMatches();
  const matches = all.filter((m) => m.fixtureRef?.startsWith(prefix));
  matches.sort((a, b) => (a.fixtureRef ?? "").localeCompare(b.fixtureRef ?? "", undefined, { numeric: true }) || a.createdAt.localeCompare(b.createdAt));
  return { matches };
}

const casOf = (s: PostMatchSummary): number => s.players.reduce((n, p) => n + p.casualtiesCaused, 0);

async function organiserApi(
  method: string, path: string, query: URLSearchParams, body: unknown, me: string, deps: TabletopApiDeps, now: () => Date,
): Promise<TabletopResult> {
  if (path === "/api/tabletop/organiser/matches") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const found = await matchesFor(query, deps);
    if ("error" in found) return found.error;
    const rows = [];
    for (const m of found.matches) {
      const t = tallyMatch(await deps.repo.readEvents(m.id));
      rows.push({
        id: m.id, state: m.state, pendingOrganiser: m.state === "confirmed", fixtureRef: m.fixtureRef,
        home: { coach: m.home.coach, teamName: m.home.teamName }, away: { coach: m.away.coach, teamName: m.away.teamName },
        score: t.score, confirmations: m.confirmations, ...(m.note ? { note: m.note } : {}), updatedAt: m.updatedAt,
      });
    }
    return { status: 200, body: { matches: rows } };
  }

  if (path === "/api/tabletop/organiser/export") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const found = await matchesFor(query, deps);
    if ("error" in found) return found.error;
    const header = ["timeStamp", "homeCoach", "homeTeam", "awayCoach", "awayTeam", "homeTouchDowns", "awayTouchDowns", "homeBadlyHurt", "awayBadlyHurt", "fixture"];
    const lines = [header.join(",")];
    for (const m of found.matches) {
      if (m.state !== "published" || !m.preview) continue;
      lines.push([
        nafTimestamp(m.publishedAt ?? m.updatedAt), m.home.coach, m.home.teamName, m.away.coach, m.away.teamName,
        m.preview.home.score.for, m.preview.away.score.for, casOf(m.preview.home), casOf(m.preview.away), m.fixtureRef ?? "",
      ].map(csvCell).join(","));
    }
    return {
      status: 200, body: `${lines.join("\r\n")}\r\n`, contentType: "text/csv; charset=utf-8",
      headers: { "content-disposition": 'attachment; filename="tabletop-results.csv"', "cache-control": "no-store" },
    };
  }

  if (path === "/api/tabletop/organiser/bulk") {
    if (method !== "POST") return err(405, "Method not allowed.");
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_MAX || !ids.every((i) => typeof i === "string" && /^[\w-]{1,64}$/.test(i)))
      return err(400, `ids must be 1-${BULK_MAX} match ids.`);
    if (b.action !== "confirm-publish" && b.action !== "reopen") return err(400, "action must be confirm-publish or reopen.");
    if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 500)) return err(400, "note must be at most 500 characters.");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : undefined;
    const action = b.action;
    const results: Array<{ id: string; ok: boolean; status: number; error?: string; state?: string }> = [];
    for (const id of new Set(ids as string[])) {
      const pre = await deps.repo.getMatch(id);
      const r = await serial(id, async (): Promise<TabletopResult> => {
        const match = await deps.repo.getMatch(id);
        if (!match) return err(404, "Match not found.");
        try {
          const replayed = await recoverMatch(id, deps);
          if (replayed && replayed.match.state === (action === "reopen" ? "recording" : "published")) return { status: 200, body: { match: replayed.match } };
        } catch (e) {
          return recoveryFailure(e);
        }
        const fresh = (await deps.repo.getMatch(id))!;
        return action === "reopen" ? reopen(fresh, note, deps, now, me) : confirmAndPublish(fresh, me, deps, now);
      }, pre ? matchTeamKeys(pre) : []);
      const out = r.body as { error?: string; match?: { state: string } };
      results.push({ id, ok: r.status === 200, status: r.status, ...(out.error ? { error: out.error } : {}), ...(out.match ? { state: out.match.state } : {}) });
    }
    return { status: 200, body: { results } };
  }
  return err(404, "Not found.");
}

/** CSV cell: quoted when needed; a leading = + - @ is neutralised so a spreadsheet never runs a coach name as a formula. */
function csvCell(value: string | number): string {
  let v = String(value);
  if (/^[=+\-@\t\r]/.test(v) && typeof value === "string") v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Organiser confirmation for both seats and publication as ONE journalled commit. */
async function confirmAndPublish(match: MatchRecord, me: string, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state === "confirmed") return publish(match, me, deps, now);
  if (match.state !== "submitted") return err(409, `This match is ${match.state}; only a submitted or confirmed match can be published.`);
  const at = now().toISOString();
  const confirmations = { [match.home.coach]: at, [match.away.coach]: at };
  const built = await buildConfirmJournal(match, me, confirmations, deps, at, true);
  if (!built.ok) return built.error;
  const j = built.journal;
  const confirmed = j.match;
  const fx = fixtureForPublish(confirmed, at, deps, j.opId);
  if ("error" in fx) return fx.error;
  const row = (j.result as { put: StoredTournamentResult }).put;
  const next: MatchRecord = { ...confirmed, state: "published", publishedAt: at, publishedBy: me, ...(fx.fixtureLink ? { fixtureLink: fx.fixtureLink } : {}) };
  const done = await commit({ ...j, kind: "publish", result: { put: { ...row, published: true } }, ...(fx.fixture ? { fixture: fx.fixture } : {}), match: next }, deps);
  if (done.status === 200) { notifyConfirmed(match, me, deps); await announceResult(next, deps); }
  return done;
}

/** submitted -> recording directly; confirmed -> recording through the revision undo; published needs undo-revision first. */
async function reopen(match: MatchRecord, note: string | undefined, deps: TabletopApiDeps, now: () => Date, actor?: string): Promise<TabletopResult> {
  if (match.state === "published") return err(409, "A published match must be reverted with undo-revision first.");
  if (match.state === "confirmed") return undoRevision(match, deps, now, note, actor);
  if (match.state !== "submitted") return err(409, `This match is ${match.state}; only a submitted or confirmed match can be reopened.`);
  const { preview: _p, ...rest } = match;
  const next: MatchRecord = { ...rest, state: "recording", confirmations: {}, updatedAt: now().toISOString(), ...(note ? { note } : {}) };
  await deps.repo.updateMatch(next);
  return { status: 200, body: { match: next } };
}

// ---- Lane R1: pre-game --------------------------------------------------------------------------------------

type Phase = MatchPhase;

/**
 * POST .../pregame/advance: THE pre-game transition function. Runs (or accepts) the CURRENT phase, validates the body
 * and the actor for that phase, records events and moves on. Sequence: the BB2025 pre-game sequence,
 * https://bloodbowlbase.ru/bb2025/core_rules/the_game_of_blood_bowl/ . Dice are rolled at the table, so every roll is
 * either made here ("site", crypto-random) or typed in from the table ("hand"); payloads say which (rolledBy). Body per
 * phase (an optional {phase} guards against a double advance):
 *   fans:     {} | {mode: "site"} | {mode: "hand", rolls: {home: 1-3, away: 1-3}}
 *   weather:  {} | {mode: "site"} | {mode: "hand", dice: [1-6, 1-6]}
 *   journeymen: {}
 *   inducements: {team: "home"|"away", picks: [{id, qty}], skip?: true}
 *   prayers:  {} | {mode: "site"} | {mode: "hand", rolls: {home: [1-16...], away: [...]}} (one per prayer bought, distinct)
 *   coin: the AWAY coach calls the toss (owner ruling 10-30: the seats are drawn at creation, the caller is derived
 *         from them; coinCallerOf). Three sub-steps, each authorised
 *         on its own: the call ({mode: "auto"|"hand", call}, the away coach or an organiser); the result (auto: the
 *         server flips at once; hand: {mode: "hand", result} from either coach or an organiser, recorded as pg-coincall
 *         then pg-coinflip); the choice ({choice: "kick"|"receive"}, the winner or an organiser). A request may carry
 *         several sub-steps ({mode: "hand", call, result, choice}) only if its sender may do each of them.
 *         A `caller` / `winner` sent in the body must match the server's.
 * Events carry deterministic ids, so a retry after a partial failure re-uses what was already recorded.
 */
async function pregameAdvance(
  match: MatchRecord, me: string, organiser: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date,
): Promise<TabletopResult> {
  if (match.state !== "recording") return err(409, `This match is ${match.state}.`);
  const phase: Phase = match.phase ?? "playing";
  if (phase === "playing") return err(409, "The pre-game is finished.");
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (b.phase !== undefined && b.phase !== phase) return err(409, `The match is at ${phase}, not ${String(b.phase)}.`);
  const stored = await deps.repo.readEvents(match.id);
  const baseTeams = await currentTeams(deps.repo, match);
  if (!baseTeams.home || !baseTeams.away) return err(409, "Team files are missing.");
  const at = now().toISOString();
  const die = deps.rollDie ?? dieFrom(deps.roller ?? cryptoRoller);
  const sides = ["home", "away"] as const;
  const out: TabletopEvent[] = [];
  const have = (id: string) => stored.some((e) => e.id === id);
  const mk = (id: string, type: TabletopEvent["type"], team: Side, payload: Record<string, unknown>): void => {
    if (!have(id)) out.push({ id, matchId: match.id, type, team, payload, ts: at, by: me });
  };
  const all = () => [...stored, ...out];
  const teams = () => overlayRosters({ home: baseTeams.home, away: baseTeams.away }, all()) as Record<Side, TabletopTeamFile>;
  const prayersBought = (side: Side): number => {
    const e = latestInducement(all(), side);
    const picks = (e?.payload.picks as Array<{ id: string; qty: number }> | undefined) ?? [];
    return picks.find((p) => p.id === "prayers_to_nuffle")?.qty ?? 0;
  };
  let next: Phase = phase;
  const policy = timerPolicyFor(match, deps);
  /** Physical dice: "site" (roll here) unless the body says the coaches typed in what they rolled. */
  const rollMode = b.mode === undefined || b.mode === "site" ? "site" : b.mode === "hand" ? "coach" : undefined;
  const entered = (rolledBy: "site" | "coach") => (rolledBy === "coach" ? { rolledBy, enteredBy: me } : { rolledBy });
  const isRoll = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
  let timers: MatchTimers | undefined;
  /** After the coin: the competition may forbid (off) or require (required) turn timers; otherwise the coaches are asked. */
  const afterCoin = (): Phase => {
    if (match.test && match.timers) { timers = match.timers; return "playing"; } // a test match preset its timers
    if (policy.enforced === "optional") return "pregame:timers";
    timers = { mode: policy.enforced === "required" ? "on" : "off", seconds: policy.seconds, enforced: policy.enforced };
    return "playing";
  };

  if (phase === "pregame:fans") {
    // The fans (#the-fans): each team's Fan Factor = D3 + its Dedicated Fans.
    if (!rollMode) return err(400, 'mode must be "site" or "hand".');
    if (rollMode === "coach" && !sides.every((sd) => isRoll(b.rolls?.[sd], 3))) return err(400, "rolls.home and rolls.away must each be 1, 2 or 3 (the D3 each coach rolled).");
    for (const side of sides) {
      const roll = rollMode === "coach" ? (b.rolls[side] as number) : die(3);
      mk(`pg-fans-${side}`, "fans", side, { roll, dedicatedFans: baseTeams[side]!.dedicatedFans, total: roll + baseTeams[side]!.dedicatedFans, ...entered(rollMode) });
    }
    next = "pregame:weather";
  } else if (phase === "pregame:weather") {
    // The weather (#weather-table): 2D6 on the table.
    if (!rollMode) return err(400, 'mode must be "site" or "hand".');
    if (rollMode === "coach" && !(Array.isArray(b.dice) && b.dice.length === 2 && b.dice.every((d: unknown) => isRoll(d, 6)))) return err(400, "dice must be the two D6 results, each 1 to 6.");
    const a = rollMode === "coach" ? (b.dice[0] as number) : die(6);
    const c2 = rollMode === "coach" ? (b.dice[1] as number) : die(6);
    mk("pg-weather-0", "weather", "home", { pregame: true, roll: a + c2, dice: [a, c2], result: weatherFor(a + c2), ...entered(rollMode) });
    next = "pregame:journeymen";
  } else if (phase === "pregame:journeymen") {
    for (const side of sides) {
      if (all().some((e) => e.type === "journeyman" && e.team === side)) continue;
      const need = journeymenNeeded(baseTeams[side]!);
      if (need === 0) continue;
      const made = makeJourneymen(baseTeams[side]!, need);
      if ("error" in made) return err(422, `${match[side].coach}: ${made.error}`);
      made.players.forEach((player, i) => mk(`pg-journeyman-${side}-${i + 1}`, "journeyman", side, { player, cost: made.cost / need }));
    }
    // Inducements picked on the fixture summary (lobby) are seeded by createMatch: they PRE-FILL the picker, and each team
    // confirms or changes its list here (owner 11-02, round answer Q3), so the step always runs.
    next = "pregame:inducements";
  } else if (phase === "pregame:inducements") {
    if (b.team !== "home" && b.team !== "away") return err(400, 'team must be "home" or "away".');
    const side: Side = b.team;
    // Either participant (or an organiser) may submit for BOTH teams (one phone at the table); strangers never reach here.
    // A new submission for a team REPLACES its earlier one while the phase is still open.
    const earlier = all().filter((e) => e.type === "inducement" && e.team === side).length;
    const picks = b.skip === true ? [] : b.picks;
    if (!Array.isArray(picks)) return err(400, "picks must be an array (or send skip: true).");
    if (match.inducements) {
      // started from a fixture lobby: the lobby's own rules (one validator with the lobby picker)
      const out2 = lobbyPlanSeat(match, deps, all(), { home: baseTeams.home, away: baseTeams.away }, side, picks, { skip: b.skip === true, order: true });
      if ("error" in out2) return err(out2.status, out2.error);
      mk(earlier === 0 ? `pg-inducement-${side}` : `pg-inducement-${side}-${earlier + 1}`, "inducement", side, {
        ...out2.payload, submittedBy: me, ...(earlier > 0 ? { replaces: earlier } : {}),
      });
    } else {
    const jm = (s: Side) => all().filter((e) => e.type === "journeyman" && e.team === s).map((e) => e.payload.player as TabletopPlayer);
    const tvHome = teamValueWithJourneymen(baseTeams.home!, jm("home"));
    const tvAway = teamValueWithJourneymen(baseTeams.away!, jm("away"));
    if (tvHome === undefined || tvAway === undefined) return err(422, "A team value is unknown, so petty cash cannot be worked out.");
    const role = tvHome === tvAway ? "equal" : (tvHome > tvAway) === (side === "home") ? "favourite" : "underdog";
    const other: Side = side === "home" ? "away" : "home";
    const otherEvent = latestInducement(all(), other);
    // a list pre-filled from the fixture summary counts only once confirmed here
    if (role === "underdog" && !inducementConfirmed(all(), other)) return err(409, `The higher-value team (${other}) goes first: its treasury spending feeds the petty cash.`);
    const plan = planInducements({
      offers: inducementSourceFor(match, deps).offers,
      file: baseTeams[side]!, picks, role, tvDifference: Math.abs(tvHome - tvAway),
      favouriteSpent: role === "underdog" ? Number((otherEvent!.payload as { treasury?: number }).treasury ?? 0) : 0,
    });
    if ("error" in plan) return err(400, plan.error);
    mk(earlier === 0 ? `pg-inducement-${side}` : `pg-inducement-${side}-${earlier + 1}`, "inducement", side, {
      picks: plan.picks, total: plan.total, treasury: plan.treasury, pettyCash: plan.pettyCash, skipped: plan.picks.length === 0,
      submittedBy: me, ...(earlier > 0 ? { replaces: earlier } : {}),
    });
    }
    const both = sides.every((s) => inducementConfirmed(all(), s));
    if (both) next = prayersBought("home") + prayersBought("away") > 0 ? "pregame:prayers" : "pregame:coin";
  } else if (phase === "pregame:prayers") {
    if (!rollMode) return err(400, 'mode must be "site" or "hand".');
    if (rollMode === "coach") {
      for (const side of sides) {
        const n = prayersBought(side);
        const r = b.rolls?.[side] ?? [];
        if (!Array.isArray(r) || r.length !== n || !r.every((x: unknown) => isRoll(x, 16)) || new Set(r).size !== r.length)
          return err(400, `rolls.${side} must list ${n} different D16 result${n === 1 ? "" : "s"} (1 to 16).`);
      }
    }
    for (const side of sides) {
      const n = prayersBought(side);
      const used = new Set<number>();
      for (let i = 1; i <= n; i += 1) {
        let roll = rollMode === "coach" ? (b.rolls[side][i - 1] as number) : die(16);
        while (rollMode === "site" && used.has(roll) && used.size < 16) roll = die(16); // duplicates are rerolled
        used.add(roll);
        mk(`pg-prayer-${side}-${i}`, "prayer", side, { roll, name: PRAYERS_TO_NUFFLE[roll - 1], ...entered(rollMode) });
      }
    }
    next = "pregame:coin";
  } else if (phase === "pregame:coin") {
    // Determine the kicking team (#determine-kicking-team). Three sub-steps, each with its own actor:
    //   1. the call: only the away coach (or an organiser; a match drawn under the old rule keeps its drawn caller);
    //   2. the result: the site flips (auto, straight after the call) or either coach / an organiser enters the real coin;
    //   3. kick or receive: only the toss winner (or an organiser).
    // One request may carry several sub-steps, but each is authorised on its own and nothing is recorded if any fails.
    const flip = all().find((e) => e.id === "pg-coinflip");
    const callEvent = all().find((e) => e.id === "pg-coincall");
    const choiceGiven = b.choice !== undefined;
    if (choiceGiven && b.choice !== "kick" && b.choice !== "receive") return err(400, 'choice must be "kick" or "receive".');
    const mayChoose = (winner: Side): boolean => organiser || match[winner].coach === me;
    if (!flip) {
      const caller = coinCallerOf(all());
      if (b.caller !== undefined && b.caller !== caller) return err(400, `${match[caller].coach} (${caller}) calls the toss.`);
      const other: Side = caller === "home" ? "away" : "home";
      const mode = callEvent ? "hand" : b.mode;
      if (mode !== "auto" && mode !== "hand") return err(400, 'mode must be "auto" or "hand".');
      if (callEvent && b.mode !== undefined && b.mode !== "hand") return err(409, "The call is recorded for a real coin: enter what the coin showed.");
      const call = (callEvent?.payload.call ?? b.call) as string;
      if (call !== "heads" && call !== "tails") return err(400, 'call must be "heads" or "tails".');
      if (callEvent && b.call !== undefined && b.call !== call) return err(409, `${match[caller].coach} already called ${call}.`);
      // 1. the call
      if (!callEvent && !organiser && match[caller].coach !== me) return err(403, `${match[caller].coach} calls the toss.`);
      if (mode === "auto") {
        if (choiceGiven) return err(400, "Make the call first; the winner chooses after the flip.");
        // 2. the SERVER flips (crypto-random in production); the page animates to this result.
        const result = die(2) === 1 ? "heads" : "tails";
        const winner: Side = result === call ? caller : other;
        mk("pg-coinflip", "coinFlip", winner, { mode, call, caller, result, winner, rolledBy: "site" });
        // stays at pregame:coin until the winner's choice is posted as a second advance
      } else {
        if (b.result === undefined) {
          if (callEvent) return err(400, 'Enter what the coin showed: result "heads" or "tails".');
          if (choiceGiven) return err(400, "Enter the coin's result before the winner chooses.");
          mk("pg-coincall", "coinFlip", caller, { stage: "call", mode: "hand", caller, call, calledBy: me });
        } else {
          // 2. the real coin: either coach or an organiser enters it
          if (b.result !== "heads" && b.result !== "tails") return err(400, 'hand mode needs result: "heads" or "tails".');
          const winner: Side = b.result === call ? caller : other;
          if (b.winner !== undefined && b.winner !== winner) return err(400, `With that call and result the winner is ${winner}.`);
          // 3. the choice, only when this coach won (or is an organiser); checked before anything is recorded
          if (choiceGiven && !mayChoose(winner)) return err(403, `${match[winner].coach} won the toss and makes the choice.`);
          if (!callEvent) mk("pg-coincall", "coinFlip", caller, { stage: "call", mode: "hand", caller, call, calledBy: me });
          mk("pg-coinflip", "coinFlip", winner, { mode: "hand", call, caller, result: b.result, winner, rolledBy: "coach", enteredBy: me });
          if (choiceGiven) {
            mk("pg-coinchoice", "coinFlip", winner, { stage: "choice", winner, choice: b.choice });
            next = afterCoin();
          }
        }
      }
    } else if (!flip.payload.choice && !all().some((e) => e.id === "pg-coinchoice")) {
      // 3. kick or receive
      if (!choiceGiven) return err(400, 'The winner must choose: choice "kick" or "receive".');
      const winner = flip.team;
      if (!mayChoose(winner)) return err(403, `${match[winner].coach} won the toss and makes the choice.`);
      mk("pg-coinchoice", "coinFlip", winner, { stage: "choice", winner, choice: b.choice });
      next = afterCoin();
    } else {
      return err(409, "The coin has already been flipped.");
    }
  } else if (phase === "pregame:timers") {
    // Turn timers engage only if BOTH coaches agree (an organiser may answer for both). A new answer replaces that team's
    // earlier one until both have answered.
    if (typeof b.agree !== "boolean") return err(400, "agree must be true or false.");
    const answering = organiser ? sides : sides.filter((sd) => match[sd].coach === me);
    if (!answering.length) return err(403, "Only the two coaches (or an organiser) answer the turn-timer question.");
    for (const sd of answering) {
      const n = all().filter((e) => e.type === "timerAgree" && e.team === sd).length;
      mk(n === 0 ? `pg-timer-${sd}` : `pg-timer-${sd}-${n + 1}`, "timerAgree", sd, { agree: b.agree, answeredBy: me });
    }
    const answered = (sd: Side) => all().filter((e) => e.type === "timerAgree" && e.team === sd).at(-1);
    if (sides.every((sd) => answered(sd))) {
      const on = sides.every((sd) => answered(sd)!.payload.agree === true);
      timers = { mode: on ? "on" : "off", seconds: policy.seconds, enforced: policy.enforced };
      next = "playing";
    }
  }

  await deps.repo.appendEvents(match.id, out);
  const events = [...stored, ...out];
  const updated: MatchRecord = next === phase ? match : {
    ...match, phase: next, updatedAt: at,
    ...(timers ? { timers } : {}),
    ...(next === "playing" ? { clock: initialClock(events) } : {}), // the receiving team (from the coin) is active at 1Ht0
  };
  if (next !== phase) await deps.repo.updateMatch(updated);
  const clock = clockView(updated, events, deps, now());
  // every pre-game write is pushed, so the other phone (and onlookers) refresh at once, not at the next poll
  if (next !== phase || out.length) deps.publishClock?.(match.id, { ...clock, phase: next });
  const recordedIds = new Set(out.map((e) => e.id));
  const milestones: AnnouncementKind[] = [];
  if (recordedIds.has("pg-fans-home") || recordedIds.has("pg-fans-away")) milestones.push("fans");
  if (recordedIds.has("pg-weather-0")) milestones.push("weather");
  if (phase === "pregame:inducements" && next !== phase) milestones.push("inducements");
  if (out.some((e) => e.type === "prayer")) milestones.push("prayers");
  if (recordedIds.has("pg-coinchoice") || (recordedIds.has("pg-coinflip") && out.find((e) => e.id === "pg-coinflip")!.payload.choice)) milestones.push("coin");
  announce(deps, milestones, updated, events);
  return {
    status: 200,
    body: {
      match: updated, phase: next, clock, recorded: out.map((e) => e.id), pregame: pregameViewOf(updated, events, baseTeams, deps),
      teams: overlayRosters({ home: baseTeams.home, away: baseTeams.away }, events),
      ...(phase === "pregame:timers" && next === phase ? { waitingFor: sides.filter((sd) => !events.some((e) => e.type === "timerAgree" && e.team === sd)) } : {}),
      ...(phase === "pregame:inducements" && next === phase ? { waitingFor: sides.filter((s) => !inducementConfirmed(events, s)) } : {}),
    },
  };
}

/** Hands pre-game milestones to the optional Discord poster; a failure there never reaches the match. */
function announce(deps: TabletopApiDeps, kinds: readonly AnnouncementKind[], match: MatchRecord, events: readonly TabletopEvent[], result?: ResultSummary): void {
  if (!deps.announce) return;
  for (const kind of kinds) {
    try { deps.announce({ kind, match, events, ...(result ? { result } : {}) }); } catch (e) { console.warn(`[recorder-webhook] announce failed: ${(e as Error).message}`); }
  }
}

/** The `pregame` block of the match view: the summary, the step the page shows and, during inducements, the menu. */
function pregameViewOf(match: MatchRecord, events: readonly TabletopEvent[], baseTeams: Record<Side, TabletopTeamFile | undefined>, deps: TabletopApiDeps): Record<string, unknown> {
  const phase: Phase = match.phase ?? "playing";
  const view: Record<string, unknown> = {
    ...pregameSummary(events, phase), step: pregameStepOf(phase, events, match.clock ?? null),
    // the organiser may still swap home and away (before the first pre-game record)
    seatsSwappable: match.state === "recording" && phase === "pregame:fans" && seatsSwappable(events),
  };
  if (phase === "pregame:inducements" && baseTeams.home && baseTeams.away) {
    Object.assign(view, inducementMenu({ teams: { home: baseTeams.home, away: baseTeams.away }, events, ...inducementSourceFor(match, deps) }));
    // a lobby match: the lobby's menu and budget (stars, package caps, Builder-paid lines), by the drawn seats
    if (match.inducements) Object.assign(view, lobbyPickerView(match, deps, events, baseTeams, view));
  }
  return view;
}

function lobbyRulesOf(match: MatchRecord, deps: TabletopApiDeps): LobbyConfirmRules | undefined {
  try { return deps.lobbyRules?.(match); } catch { return undefined; }
}

type LobbySideId = "home" | "away";
/** A lobby match's rules with the drawn seats mapped to the lobby's sides and the recorder's team values (journeymen in). */
interface LobbyCtx { lr: LobbyConfirmRules; side: Record<Side, LobbySideId | undefined>; tv: Partial<Record<LobbySideId, number | null>> }
function lobbyCtxOf(match: MatchRecord, deps: TabletopApiDeps, events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>): LobbyCtx | undefined {
  const lr = lobbyRulesOf(match, deps);
  if (!lr) return undefined;
  const side = { home: lr.sideOf(match.home.coach), away: lr.sideOf(match.away.coach) };
  const tv: LobbyCtx["tv"] = {};
  for (const s of ["home", "away"] as const) {
    const ls = side[s], f = teams[s];
    if (!ls || !f) continue;
    // the petty-cash gap uses the team values after journeymen, as the recorder's own pricing does
    const v = teamValueWithJourneymen(f, events.filter((e) => e.type === "journeyman" && e.team === s).map((e) => e.payload.player as TabletopPlayer));
    if (typeof v === "number") tv[ls] = v;
  }
  return { lr, side, tv };
}
const seatOf = (ctx: LobbyCtx, ls: LobbySideId | undefined): Side | undefined => (ls ? (["home", "away"] as const).find((s) => ctx.side[s] === ls) : undefined);

/** The favourite's treasury spend in force (what feeds the underdog's petty cash); 0 for anyone else. */
function ctxOverdogSpend(ctx: LobbyCtx, events: readonly TabletopEvent[], seat: Side, confirmedOnly = true): number {
  const r = ctx.lr.roles(ctx.tv);
  if (!r.overdog || ctx.side[seat] !== r.underdog) return 0;
  const over = seatOf(ctx, r.overdog);
  if (!over || (confirmedOnly && !inducementConfirmed(events, over))) return 0;
  return Number(latestInducement(events, over)?.payload.treasury ?? 0);
}

/** Star ids no team may hire here: the other team's picks and every star already on either roster (Builder stars). */
function takenStars(teams: Record<Side, TabletopTeamFile | undefined>, events: readonly TabletopEvent[], seat: Side): string[] {
  const other: Side = seat === "home" ? "away" : "home";
  const picked = ((latestInducement(events, other)?.payload.picks as Array<{ id: string }> | undefined) ?? []).map((p) => p.id).filter((id) => id.startsWith("star:"));
  const rostered = (["home", "away"] as const).flatMap((s) => (teams[s]?.players ?? []).filter((p) => p.kind === "star" && !p.dead).flatMap((p) => [`star:${p.positionName ?? p.name}`, `star:${p.name}`]));
  return [...new Set([...picked, ...rostered])];
}

/** The seeded (lobby) list of a seat and its Builder-paid lines. */
const seededOf = (events: readonly TabletopEvent[], seat: Side) => events.find((e) => e.id === `pg-inducement-${seat}`)?.payload;
const paidLinesOf = (seeded: Record<string, unknown> | undefined): Array<{ id: string; qty: number }> =>
  ((seeded?.picks as Array<{ id: string; prefilled?: number }> | undefined) ?? []).filter((p) => Number(p.prefilled) > 0).map((p) => ({ id: p.id, qty: Number(p.prefilled) }));

/** The picker for a lobby match: the lobby's catalogue and budget; without the lobby's rules, the seeded lines are added. */
function lobbyPickerView(match: MatchRecord, deps: TabletopApiDeps, events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>, view: Record<string, unknown>): Record<string, unknown> {
  const ctx = lobbyCtxOf(match, deps, events, teams);
  const options: Record<string, unknown> = {}, budget: Record<string, unknown> = {};
  const base = (view.inducementOptions ?? {}) as Record<string, Array<{ id: string }>>;
  const baseBudget = (view.budget ?? {}) as Record<string, Record<string, unknown>>;
  for (const s of ["home", "away"] as const) {
    const own = latestInducement(events, s);
    const flags = { spent: Number(own?.payload.total ?? 0), submitted: inducementConfirmed(events, s), ...(own?.payload.lobby === true ? { lobby: true } : {}) };
    const ls = ctx?.side[s];
    if (ctx && ls) {
      const b = ctx.lr.budget(ls, ctxOverdogSpend(ctx, events, s), ctx.tv);
      options[s] = ctx.lr.options(ls, ctx.tv);
      budget[s] = { role: b.role === "overdog" ? "favourite" : b.role, pettyCash: b.pettyCash, treasury: b.treasury, topUpLimit: b.topUpLimit, ...flags };
      continue;
    }
    // rules unreadable: the seeded lines join the catalogue (stars and Builder-paid lines included) so "confirm unchanged" works
    const seeded = (seededOf(events, s)?.picks as Array<{ id: string; name?: string; qty: number; cost: number; prefilled?: number }> | undefined) ?? [];
    const extra = seeded.filter((p) => !(base[s] ?? []).some((o) => o.id === p.id)).map((p) => {
      const paid = Number(p.prefilled ?? 0), bought = Math.max(0, p.qty - paid);
      return { id: p.id, name: p.name ?? p.id, price: bought ? Math.round(p.cost / bought) : 0, max: p.qty, ...(paid ? { prefilled: paid } : {}) };
    });
    options[s] = [...(base[s] ?? []).map((o) => { const p = seeded.find((x) => x.id === o.id); return p?.prefilled ? { ...o, prefilled: p.prefilled } : o; }), ...extra];
    budget[s] = { ...(baseBudget[s] ?? {}), ...flags };
  }
  return { inducementOptions: { ...base, ...options }, budget: { ...baseBudget, ...budget } };
}

/**
 * One seat's list judged by the lobby's rules (the confirm at the pre-game step, and an organiser's edit): the resolved
 * payload, or why not. `skip` keeps the Builder-paid lines. Without the lobby's rules only the seeded list itself passes.
 */
function lobbyPlanSeat(match: MatchRecord, deps: TabletopApiDeps, events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>,
  seat: Side, rawPicks: unknown, opts: { skip: boolean; order: boolean; spend?: number }): { payload: Record<string, unknown> } | { status: number; error: string } {
  const other: Side = seat === "home" ? "away" : "home";
  const seeded = seededOf(events, seat);
  const picks = opts.skip ? paidLinesOf(seeded) : rawPicks;
  const ctx = lobbyCtxOf(match, deps, events, teams);
  if (!ctx) {
    // the underdog (petty cash in its lobby list) still goes second
    const otherSeed = seededOf(events, other);
    if (opts.order && Number(seeded?.pettyCash ?? 0) > 0 && Number(otherSeed?.pettyCash ?? 0) === 0 && !inducementConfirmed(events, other))
      return { status: 409, error: `The higher-value team (${other}) goes first: its treasury spending feeds the petty cash.` };
    const key = (list: unknown) => JSON.stringify((Array.isArray(list) ? list : []).map((p) => [String((p as { id?: unknown }).id), Number((p as { qty?: unknown }).qty)]).sort());
    if (!seeded || key(picks) !== key(seeded.picks)) return { status: 409, error: "The fixture's inducement rules cannot be read right now: confirm the list as picked, or try again later." };
    return { payload: { picks: seeded.picks, total: seeded.total, treasury: seeded.treasury, pettyCash: seeded.pettyCash, skipped: (seeded.picks as unknown[]).length === 0, confirmedAsPicked: true } };
  }
  const ls = ctx.side[seat];
  if (!ls) return { status: 409, error: "This match's coaches no longer match its fixture." };
  const r = ctx.lr.roles(ctx.tv);
  if (opts.order && ls === r.underdog && r.overdog) {
    const over = seatOf(ctx, r.overdog);
    if (over && !inducementConfirmed(events, over)) return { status: 409, error: `The higher-value team (${over}) goes first: its treasury spending feeds the petty cash.` };
  }
  const spend = opts.spend ?? ctxOverdogSpend(ctx, events, seat, opts.order);
  const plan = ctx.lr.plan(ls, picks, spend, takenStars(teams, events, seat), ctx.tv);
  if ("error" in plan) return { status: 400, error: plan.error };
  return {
    payload: {
      picks: plan.picks, total: plan.total, treasury: plan.treasury, pettyCash: plan.pettyCash, skipped: plan.picks.length === 0,
      ...(ls === r.underdog && r.overdog ? { overdogSpend: spend } : {}),
    },
  };
}

/**
 * POST .../pregame/skip: an organiser skips whatever is left of the pre-game (logged as `pregameSkip`). The match moves
 * to playing at the set-up (1Ht0); turn timers take the test preset or the competition's fixed rule, else off.
 */
async function pregameSkip(match: MatchRecord, me: string, organiser: boolean, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (!organiser) return err(403, "Only an organiser can skip the pre-game.");
  if (match.state !== "recording") return err(409, `This match is ${match.state}.`);
  const phase: Phase = match.phase ?? "playing";
  if (phase === "playing") return err(409, "The pre-game is finished.");
  const at = now().toISOString();
  const stored = await deps.repo.readEvents(match.id);
  const skip: TabletopEvent = { id: "pg-skip", matchId: match.id, type: "pregameSkip", team: "home", payload: { from: phase }, ts: at, by: me };
  const out = stored.some((e) => e.id === "pg-skip") ? [] : [skip];
  await deps.repo.appendEvents(match.id, out);
  const events = [...stored, ...out];
  const policy = timerPolicyFor(match, deps);
  const timers: MatchTimers = match.timers ?? { mode: policy.enforced === "required" ? "on" : "off", seconds: policy.seconds, enforced: policy.enforced };
  const updated: MatchRecord = { ...match, phase: "playing", updatedAt: at, timers, clock: initialClock(events) };
  await deps.repo.updateMatch(updated);
  const clock = clockView(updated, events, deps, now());
  deps.publishClock?.(match.id, { ...clock, phase: "playing" });
  announce(deps, ["skip"], updated, events);
  return { status: 200, body: { match: updated, phase: "playing", clock, recorded: out.map((e) => e.id), pregame: pregameViewOf(updated, events, { home: undefined, away: undefined }, deps) } };
}

// ---- Organiser edits of inducements after the start (owner ruling 10-29, spec-landing-bubble-retro §9.2) -------------
//
// GET  .../inducements  the picker for either team: the effective table (league season or package rules), budgets, current picks
// POST .../inducements  {team, picks: [{id, qty}] | skip: true, id?}: appends an admin-stamped `inducement` event that replaces
//                       the team's inducements in force. Nothing is rewritten: the feed keeps every record, and the post-match
//                       treasury debit follows the latest record in force (postMatch.ts tallyMatch).
// Same price and budget rules as the pre-game step (planInducements). When the higher-value team's treasury spend changes, the
// lower-value team's petty cash changes too: its picks are re-priced and, if its treasury top-up moves, a second admin event
// (`followsFrom`) records that; if its picks no longer fit, the edit is refused so the organiser edits that team first.
// Undo: the newest edit (with its adjustment) can be undone like any admin event, by an organiser (events.ts validateEvent).
// Prayers to Nuffle are rolled before the kick-off, so their number cannot change once the coin step is reached.

const PRAYER_LOCKED_PHASES: ReadonlySet<string> = new Set(["pregame:coin", "pregame:timers", "playing"]);
const EARLY_PHASES: ReadonlySet<string> = new Set(["pregame:fans", "pregame:weather", "pregame:journeymen"]);
const EDIT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Why an organiser cannot edit this match's inducements right now ("" = they can). */
function inducementEditBlock(match: MatchRecord): string {
  if (match.state !== "recording" && match.state !== "submitted") return `This match is ${match.state}: reopen it first.`;
  const phase = match.phase ?? "playing";
  if (phase === "pregame:inducements") return "The pre-game inducement step is open: use its picker.";
  if (EARLY_PHASES.has(phase) && !match.inducements) return "Inducements are chosen at the pre-game step.";
  return "";
}

async function inducementEditMenu(match: MatchRecord, deps: TabletopApiDeps): Promise<TabletopResult> {
  const events = await deps.repo.readEvents(match.id);
  const teams = await currentTeams(deps.repo, match);
  if (!teams.home || !teams.away) return err(409, "Team files are missing.");
  const menu = inducementMenu({ teams: { home: teams.home, away: teams.away }, events, ...inducementSourceFor(match, deps) });
  // a lobby match: the lobby's catalogue and budget (stars, package caps, Builder-paid lines)
  if (match.inducements) Object.assign(menu, lobbyPickerView(match, deps, events, teams, menu as unknown as Record<string, unknown>));
  const picksOf = (s: Side) => ((latestInducement(events, s)?.payload.picks as Array<{ id: string; qty: number }> | undefined) ?? []).map((p) => ({ id: p.id, qty: p.qty }));
  const block = inducementEditBlock(match);
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: { ...menu, current: { home: picksOf("home"), away: picksOf("away") }, editable: !block, ...(block ? { reason: block } : {}), prayersLocked: PRAYER_LOCKED_PHASES.has(match.phase ?? "playing") },
  };
}

async function editInducements(match: MatchRecord, me: string, body: unknown, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  const block = inducementEditBlock(match);
  if (block) return err(409, block);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (b.team !== "home" && b.team !== "away") return err(400, 'team must be "home" or "away".');
  if (b.id !== undefined && (typeof b.id !== "string" || !EDIT_ID_RE.test(b.id))) return err(400, "id must be 8-64 chars of [A-Za-z0-9_-] (a client uuid).");
  const picks = b.skip === true ? [] : b.picks;
  if (!Array.isArray(picks) || picks.length > 40) return err(400, "picks must be an array (or send skip: true).");
  const side: Side = b.team;
  const other: Side = side === "home" ? "away" : "home";
  const stored = await deps.repo.readEvents(match.id);
  if (b.id && stored.some((e) => e.id === b.id)) return { status: 200, body: { match, recorded: [], duplicates: [b.id] } }; // a retry
  if (stored.length + 2 > MAX_EVENTS_PER_MATCH) return err(409, "This match has too many events.");
  const teams = await currentTeams(deps.repo, match);
  if (!teams.home || !teams.away) return err(409, "Team files are missing.");
  const jm = (s: Side) => stored.filter((e) => e.type === "journeyman" && e.team === s).map((e) => e.payload.player as TabletopPlayer);
  const tvHome = teamValueWithJourneymen(teams.home, jm("home"));
  const tvAway = teamValueWithJourneymen(teams.away, jm("away"));
  if (tvHome === undefined || tvAway === undefined) return err(422, "A team value is unknown, so petty cash cannot be worked out.");
  const roleOf = (s: Side): "favourite" | "underdog" | "equal" => (tvHome === tvAway ? "equal" : (tvHome > tvAway) === (s === "home") ? "favourite" : "underdog");
  const gap = Math.abs(tvHome - tvAway);
  const { offers } = inducementSourceFor(match, deps);
  const prev = latestInducement(stored, side);
  const otherPrev = latestInducement(stored, other);
  const spentOf = (e: TabletopEvent | undefined): number => Number((e?.payload as { treasury?: number } | undefined)?.treasury ?? 0);
  // A match started from a fixture lobby: the edit is judged by that lobby's rules (Builder-paid lines kept, "skip" keeps
  // them too), unless the organiser sends override: true (the recorder's own pricing; marked on the record and logged).
  const fromLobby = Boolean(match.inducements && match.fixtureRef && deps.lobbyRules);
  const lobbyRules = fromLobby && b.override !== true;
  const override = fromLobby && b.override === true;
  if (override) console.warn(`[tabletop] organiser inducement edit with override on match ${match.id} (${side})`);
  let plan: { picks: unknown[]; total: number; treasury: number; pettyCash: number };
  if (lobbyRules) {
    const res = lobbyPlanSeat(match, deps, stored, teams, side, picks, { skip: b.skip === true, order: false });
    if ("error" in res) return err(res.status, res.status === 409 ? `${res.error} An organiser can send override: true to edit by the recorder's own pricing.` : res.error);
    plan = res.payload as typeof plan;
  } else {
    const legacy = planInducements({ offers, file: teams[side]!, picks, role: roleOf(side), tvDifference: gap, favouriteSpent: roleOf(side) === "underdog" ? spentOf(otherPrev) : 0 });
    if ("error" in legacy) return err(400, legacy.error);
    plan = legacy;
  }
  const prayers = (list: unknown): number => ((list as Array<{ id: string; qty: number }> | undefined) ?? []).find((p) => p.id === "prayers_to_nuffle")?.qty ?? 0;
  const prayersChanged = prayers(prev?.payload.picks) !== prayers(plan.picks);
  if (prayersChanged && PRAYER_LOCKED_PHASES.has(match.phase ?? "playing")) return err(409, "Prayers to Nuffle are rolled before the kick-off: their number cannot change now.");
  const at = now().toISOString();
  const clock = (match.phase ?? "playing") === "playing" ? currentClock(match, stored) : undefined;
  const when = clock && clock.half !== null ? { half: clock.half, ...(clock.turn >= 1 ? { turn: clock.turn } : {}) } : {};
  const id = typeof b.id === "string" ? b.id : `adm-ind-${side}-${randomBytes(6).toString("hex")}`;
  const record = (eid: string, team: Side, p: { picks: unknown[]; total: number; treasury: number; pettyCash: number }, extra: Record<string, unknown>): TabletopEvent => ({
    id: eid, matchId: match.id, type: "inducement", team, ...when,
    payload: { picks: p.picks, total: p.total, treasury: p.treasury, pettyCash: p.pettyCash, skipped: p.picks.length === 0, submittedBy: me, adminEdit: true, ...extra },
    ts: at, by: me, admin: true,
  } as TabletopEvent);
  const out: TabletopEvent[] = [record(id, side, plan, {
    treasuryBefore: spentOf(prev), ...(prev ? { replaces: prev.id } : {}), ...(prayersChanged ? { prayersChanged: true } : {}), ...(override ? { override: true } : {}),
  })];
  // The favourite's treasury spend feeds the underdog's petty cash: re-price the underdog's picks in force.
  const ctx = lobbyRules ? lobbyCtxOf(match, deps, stored, teams) : undefined;
  const favourite = ctx ? ctx.side[side] !== undefined && ctx.side[side] === ctx.lr.roles(ctx.tv).overdog : roleOf(side) === "favourite";
  if (favourite && otherPrev && spentOf(prev) !== plan.treasury) {
    const theirPicks = ((otherPrev.payload.picks as Array<{ id: string; qty: number }> | undefined) ?? []).map((p) => ({ id: p.id, qty: p.qty }));
    let again: { picks: unknown[]; total: number; treasury: number; pettyCash: number } | { error: string };
    if (ctx) {
      const res = lobbyPlanSeat(match, deps, [...stored, ...out], teams, other, theirPicks, { skip: false, order: false, spend: plan.treasury });
      again = "error" in res ? { error: res.error } : (res.payload as { picks: unknown[]; total: number; treasury: number; pettyCash: number });
    } else again = planInducements({ offers, file: teams[other]!, picks: theirPicks, role: "underdog", tvDifference: gap, favouriteSpent: plan.treasury });
    if ("error" in again) return err(409, `That leaves ${match[other].teamName} over its budget (${again.error}) Edit their inducements first.`);
    if (again.treasury !== spentOf(otherPrev) || again.pettyCash !== Number(otherPrev.payload.pettyCash ?? 0)) {
      // its own id, derived from the WHOLE edit id (never a truncation, which two long ids could share) and linked by followsFrom
      const pcId = `pc-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 40)}`;
      if (stored.some((e) => e.id === pcId)) return err(409, "That edit id is already in use; send a fresh one.");
      out.push(record(pcId, other, again, { followsFrom: id, replaces: otherPrev.id, treasuryBefore: spentOf(otherPrev) }));
    }
  }
  await deps.repo.appendEvents(match.id, out);
  const events = [...stored, ...out];
  let updated = match;
  if (match.state === "submitted") {
    // the preview both coaches saw is stale: recompute it and clear the confirmations (as an organiser's undo after submit does)
    const p = await computePreview(match, events, deps);
    if (!p.ok) return p.error;
    updated = { ...match, confirmations: {}, preview: { home: p.home.summary, away: p.away.summary }, updatedAt: at };
    await deps.repo.updateMatch(updated);
  }
  const treasury = Object.fromEntries(out.map((e) => [e.team, { before: Number(e.payload.treasuryBefore ?? 0), after: Number(e.payload.treasury ?? 0) }]));
  return { status: 200, body: { match: updated, recorded: out.map((e) => e.id), treasury, pregame: pregameSummary(events, match.phase ?? "playing") } };
}

// ---- Lane R3: match clock and turns ------------------------------------------------------------------------

/** The competition's turn-timer policy for this match: its tournament's setting for a fixture match, else the default. */
function inducementOptInsFor(match: MatchRecord, deps: TabletopApiDeps): readonly string[] {
  const f = match.fixtureRef ? deps.fixtures?.get(match.fixtureRef) : undefined;
  return f?.inducementOptIns ?? [];
}

/**
 * THE price source of a match's inducement phase: the league season's effective table when the match names one
 * (src/leagues/inducements.ts: standard overrides + custom types), else the shared dataset with the fixture's opt-ins.
 * Read live, so the picker and the submit always judge by the same (current) table.
 */
function inducementSourceFor(match: MatchRecord, deps: TabletopApiDeps): { offers: InducementOffers; ids?: readonly string[]; extras?: Record<string, InducementOptionExtras> } {
  const optIns = inducementOptInsFor(match, deps);
  const ls = match.leagueSeason;
  const found = ls ? deps.leagueInducements?.(ls.leagueId, ls.seasonId) : undefined;
  if (!found) return { offers: inducementOffersFor(optIns) };
  const { offers, ids } = seasonInducementOffers(found.config, optIns);
  return { offers, ids, extras: customOptionExtras(found.config) };
}

function timerPolicyFor(match: MatchRecord, deps: TabletopApiDeps): TurnTimerPolicy {
  const f = match.fixtureRef ? deps.fixtures?.get(match.fixtureRef) : undefined;
  return f?.turnTimer ?? DEFAULT_TURN_TIMER_POLICY;
}

const currentClock = (match: MatchRecord, events: readonly TabletopEvent[]): ClockState => match.clock ?? initialClock(events);

/** The clock payload both phones read (GET, events POST, turn routes, the Super socket): server time included. */
export function clockView(match: MatchRecord, events: readonly TabletopEvent[], deps: TabletopApiDeps, now: Date) {
  const playing = (match.phase ?? "playing") === "playing";
  const c: ClockState = playing ? currentClock(match, events) : { half: 1, turn: 0, activeTeam: null, turnStartedAt: null };
  const policy = timerPolicyFor(match, deps);
  const answered = (sd: Side) => events.filter((e) => e.type === "timerAgree" && e.team === sd).at(-1)?.payload.agree === true;
  const on = match.timers?.mode === "on";
  return {
    half: c.half,
    turn: c.turn,
    activeTeam: c.activeTeam,
    turnStartedAt: c.turnStartedAt,
    turnTimer: {
      mode: match.timers?.mode ?? "off",
      seconds: match.timers?.seconds ?? policy.seconds,
      // "required" engages without asking, so both count as agreed
      agreed: policy.enforced === "required" && on ? { home: true, away: true } : { home: answered("home"), away: answered("away") },
      enforced: match.timers?.enforced ?? policy.enforced,
    },
    allowOvertime: match.allowOvertime === true,
    serverNow: now.toISOString(),
  };
}

/** POST .../turn/start (1Ht0 -> 1Ht1, 2Ht0 -> 2Ht1) and .../turn/end. Auth: the ACTIVE team's coach, or an organiser. */
async function turnAction(
  match: MatchRecord, me: string, organiser: boolean, action: "turn/start" | "turn/end", body: unknown, deps: TabletopApiDeps, now: () => Date,
): Promise<TabletopResult> {
  if (match.state !== "recording") return err(409, `This match is ${match.state}.`);
  if ((match.phase ?? "playing") !== "playing") return err(409, `Finish the pre-game first (the match is at ${match.phase}).`);
  const events = await deps.repo.readEvents(match.id);
  const clock = currentClock(match, events);
  const stale = (message: string): TabletopResult => ({ status: 409, body: { error: message, clock: clockView(match, events, deps, now()) } });
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  // Only the active team's coach moves the clock. An organiser may step in for them with `override: true` (nobody else can send it).
  const isActiveCoach = clock.activeTeam !== null && match[clock.activeTeam].coach === me;
  if (!isActiveCoach && !(organiser && b.override === true))
    return err(403, clock.activeTeam ? `It is ${match[clock.activeTeam].coach}'s turn.` : "The match has no turns left.");
  // A stale press (the turn already moved on, e.g. a double tap or a second phone) changes nothing and answers 409 with the clock.
  if (b.expectedHalf !== undefined && b.expectedHalf !== clock.half) return stale("The clock has moved on.");
  if (b.expectedTurn !== undefined && b.expectedTurn !== clock.turn) return stale("The clock has moved on.");
  if (b.expectedTeam !== undefined && b.expectedTeam !== clock.activeTeam) return stale("The clock has moved on.");
  const at = now().toISOString();
  const first = firstHalfReceiver(events);
  const next = action === "turn/start" ? startTurn(clock, at) : endTurn(clock, first, match.allowOvertime === true, at);
  if ("error" in next) return stale(next.error);
  if (action === "turn/end") {
    const id = `turn-end-${clock.half}-${clock.turn}-${clock.activeTeam}`;
    if (!events.some((e) => e.id === id))
      await deps.repo.appendEvents(match.id, [{
        id, matchId: match.id, type: "turnEnd", team: clock.activeTeam!, half: clock.half, turn: clock.turn,
        payload: { half: clock.half, turn: clock.turn, team: clock.activeTeam }, ts: at, by: me, ...(isActiveCoach ? {} : { admin: true }), // an organiser override is an admin event
      }]);
  }
  const updated: MatchRecord = { ...match, clock: next, updatedAt: at };
  await deps.repo.updateMatch(updated);
  const view = clockView(updated, events, deps, now());
  deps.publishClock?.(match.id, { ...view, phase: "playing" });
  return { status: 200, body: { clock: view, match: updated } };
}

/**
 * POST .../turn/set {half, turn, activeTeam}: change the clock by hand during play. Either participant while the match is
 * recording, an organiser always. Resets turnStartedAt, records a server-written `turnSet` event, and publishes the clock.
 */
async function turnSet(match: MatchRecord, me: string, organiser: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (!organiser && match.state !== "recording") return err(403, "Once the match is submitted only an organiser can change the clock.");
  if ((match.phase ?? "playing") !== "playing") return err(409, `Finish the pre-game first (the match is at ${match.phase}).`);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.half !== 1 && b.half !== 2 && b.half !== "OT") return err(400, 'half must be 1, 2 or "OT".');
  if (b.half === "OT" && match.allowOvertime !== true) return err(400, "This match does not allow overtime.");
  if (!Number.isInteger(b.turn) || (b.turn as number) < 0 || (b.turn as number) > 8) return err(400, "turn must be a whole number from 0 to 8.");
  if (b.activeTeam !== "home" && b.activeTeam !== "away") return err(400, 'activeTeam must be "home" or "away".');
  const events = await deps.repo.readEvents(match.id);
  const from = currentClock(match, events);
  const at = now().toISOString();
  const to: ClockState = { half: b.half, turn: b.turn as number, activeTeam: b.activeTeam, turnStartedAt: at };
  const brief = (c: ClockState) => ({ half: c.half, turn: c.turn, activeTeam: c.activeTeam });
  await deps.repo.appendEvents(match.id, [{
    id: `turn-set-${now().getTime()}-${randomBytes(3).toString("hex")}`, matchId: match.id, type: "turnSet", team: to.activeTeam!,
    half: to.half, ...(to.turn >= 1 ? { turn: to.turn } : {}),
    payload: { from: brief(from), to: brief(to), by: me }, ts: at, by: me,
    ...(organiser && match[to.activeTeam!].coach !== me ? { admin: true } : {}),
  }]);
  const updated: MatchRecord = { ...match, clock: to, updatedAt: at };
  await deps.repo.updateMatch(updated);
  const view = clockView(updated, events, deps, now());
  deps.publishClock?.(match.id, { ...view, phase: "playing" });
  return { status: 200, body: { clock: view, match: updated } };
}
