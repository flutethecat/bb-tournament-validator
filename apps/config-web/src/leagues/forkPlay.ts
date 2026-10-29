/**
 * Play on Super FUMBBL for league fixtures (spec-league-settings-2026-10-30 §3, owner note 10-30: results are parsed
 * into the league and the league teams are changed from them automatically).
 *
 *   GET  /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId              fixture summary (public; per-viewer actions)
 *   POST /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId/fork/generate   a seated coach or an organiser: build both
 *        fork teams from the league rosters (once per fixture), schedule the fork game (once), invite the opponent and tell
 *        the organisers and admins. Idempotent: a second click re-uses the teams and the game.
 *   POST .../fork/launch       the seated coach: records the launch and answers { jnlpUrl }
 *   GET  .../fork/jnlp         the seated coach only (403 otherwise): their seat's launch file (their own credential)
 *   POST .../fork/reset        organisers: { reason } clears a failed game (teams kept) so it can be generated again; logged
 *   POST .../fork/sync         organisers: look for the result now (the server also checks on a timer)
 *
 * The fork itself is reached only through `LeagueForkClient` (forkClient.ts on the server; a stub in tests), so no test
 * ever schedules a real game. Every fixture's fork work runs under one in-process lock, building and scheduling also
 * under a lock per fork team (two fixtures of one team never interleave), and every store write re-reads the season
 * first and replaces only this fixture's fork state, so a double click or a timer tick never doubles a team, a game or
 * a result.
 *
 * Game references are never dropped on a guess: an unclear schedule answer is marked uncertain and Reset first looks
 * for the game on the fork; Cancel withdraws only a game that has not started (the fork confirms), otherwise the game
 * is kept and still synced; the first Start Game rebuilds a team whose league roster changed since it was built
 * (withdrawing the unstarted game first), and once play has started that team's league roster is locked.
 */
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { buildFixturePost, discordEvents, postWebhook as defaultPoster, type WebhookPoster } from "./discord.js";
import { readJsonObject, type BodyDeps } from "./http.js";
import { applyForkResult, type ForkGameResult } from "./forkResult.js";
import { buildLeagueForkTeam, forkTeamIdFor, ForkTeamBuildError, leagueTeamRevision, rulesetBlocker, type LeagueForkTeamFile } from "./forkTeam.js";
import { fixturePlayed } from "./tourplay.js";
import { isLeagueOrganiser, leagueOwner, type LeagueStore } from "./store.js";
import { registrationsOf } from "./settings.js";
import type { FixtureForkState, FixtureForkStatus, ForkSide, LeagueFixture, LeagueRecord, SeasonRecord } from "./types.js";

/** Error a fork client throws with an HTTP status for the coach (503 no account store, 404 no fork account, ...). */
export class ForkClientError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type ForkScheduleOutcome = { kind: "scheduled"; gameId: string } | { kind: "rejected" | "unknown"; error: string };
export type ForkFindOutcome = { kind: "found"; gameId: string } | { kind: "none" } | { kind: "unknown"; error: string };
export interface ForkGameState { status: "scheduled" | "active" | "finished"; playedAt?: string }

/** Everything the league needs from the fork. */
export interface LeagueForkClient {
  /** Fork roster files by roster id. */
  rosters(): ReadonlyMap<string, string>;
  /** Result banking (the site backend) runs on this host: teams it could not value are refused before scheduling. */
  bankingGuard?: boolean;
  /**
   * In ONE critical section (the fork's team write locks for both teams and the cache-generation lock): check neither
   * team is in a live game, write `install` (rewrite the team files, list them in the coaches' libraries, reload), then
   * schedule home vs away. Throws, with nothing installed, when the check or the install fails.
   */
  prepareGame(input: { install: Array<{ coach: string; file: LeagueForkTeamFile }>; home: string; away: string }): Promise<ForkScheduleOutcome>;
  /** Is there a game between these two fork teams (live or finished)? "unknown" when the fork cannot confirm either way. */
  findGame(home: string, away: string): Promise<ForkFindOutcome>;
  /** Withdraws a game that has not started; true only when the fork confirms it. */
  deleteGame(gameId: string): Promise<boolean>;
  /** A seat's launch file for this coach (their own credential), under the game-start gate. Throws ForkClientError. */
  launchFile(input: { coach: string; teamId: string; gameName: string; gameId: string }): Promise<string>;
  /** What the fork says about these games (absent = unknown). Throws when the fork's lists cannot be confirmed. */
  gameStates(gameIds: string[]): Promise<Map<string, ForkGameState>>;
  /** A finished game's result: full (the server's FumbblResult) when readable, else basic; undefined when not available yet. */
  result(gameId: string, playedAt?: string): Promise<ForkGameResult | undefined>;
}

export interface ForkRouteDeps extends BodyDeps {
  store: LeagueStore;
  fork?: LeagueForkClient;
  notify?: (coach: string, input: NotificationInput) => void;
  identities?: () => Array<{ coach: string; level: string; banned?: boolean }>;
  postWebhook?: WebhookPoster;
  now?: () => Date;
}

const NO_STORE = { "cache-control": "no-store" };
const res = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string): LeagueApiResult => res(status, { error });
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
const SIDES: ForkSide[] = ["home", "away"];
export const FORK_BODY_MAX = 8 * 1024;
export const RESET_REASON_MAX = 300;

export const fixturePageLink = (leagueId: string, seasonId: string, fixtureId: string): string =>
  `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}&tab=fixtures&fixture=${encodeURIComponent(fixtureId)}`;

export const FORK_STATUS_LABEL: Record<FixtureForkStatus | "none", string> = {
  none: "Not generated",
  teams_built: "Teams built",
  scheduled: "Game scheduled",
  in_progress: "In progress",
  finished: "Finished",
  launch_failed: "Failed",
  cancelled: "Cancelled",
};

// ---- per-fixture lock ----

const locks = new Map<string, Promise<unknown>>();
function withFixtureLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** Runs `task` holding the lock of every fork team id (taken in sorted order, so two callers never deadlock). */
function withTeamLocks<T>(teamIds: string[], task: () => Promise<T>): Promise<T> {
  const ids = [...new Set(teamIds)].sort();
  const step = (i: number): Promise<T> => (i >= ids.length ? task() : withFixtureLock(`team:${ids[i]}`, () => step(i + 1)));
  return step(0);
}

// ---- who ----

function admins(deps: ForkRouteDeps): string[] {
  try { return (deps.identities?.() ?? []).filter((r) => r.level === "admin" && !r.banned).map((r) => r.coach); } catch { return []; }
}
const isManager = (league: LeagueRecord, who: LeagueApiIdentity | undefined): boolean => Boolean(who && (who.admin || isLeagueOrganiser(league, who.coach)));
/** The side this coach is seated on (their fork identity is the side's coachId). */
export function seatOf(f: LeagueFixture, coach: string | undefined): ForkSide | undefined {
  return SIDES.find((s) => same(f[s].coachId, coach));
}

/** Why this fixture cannot be generated on Super FUMBBL right now ("" = it can). */
export function generateBlocker(league: LeagueRecord, season: SeasonRecord, f: LeagueFixture): string {
  if (league.playOnFork !== true) return "Play on Super FUMBBL is off for this league.";
  const edition = rulesetBlocker(season.ruleset);
  if (edition) return edition;
  if (f.forkEnabled !== true) return "An organiser has not allowed this fixture on Super FUMBBL.";
  if (f.forkCancelled) return "Super FUMBBL play is cancelled for this fixture.";
  if (fixturePlayed(f)) return "This fixture already has a result.";
  if (!f.forkAllowLate && season.status !== "active") return "The season is finished. An organiser can allow a late launch.";
  if (!f.forkAllowLate && f.suspended) return "This fixture is marked not played. An organiser can allow a late launch.";
  for (const s of SIDES) {
    const side = f[s];
    if (!side.coachId) return `${side.coach || side.team} has no Super FUMBBL account linked to this league.`;
    if (!side.teamId || !season.teams.some((t) => t.id === side.teamId)) return `${side.team} has no league roster in this season.`;
  }
  if (same(f.home.coachId, f.away.coachId)) return "Both sides have the same coach.";
  return "";
}

// ---- read model ----

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
  /** Why Generate is not offered (shown to seated coaches and organisers). */
  blocker?: string;
  canStart: boolean;
  canReset: boolean;
  canConfigure: boolean;
  result?: FixtureForkState["result"];
  log?: FixtureForkState["log"];
}

export function fixtureForkView(league: LeagueRecord, season: SeasonRecord, f: LeagueFixture, who: LeagueApiIdentity | undefined): FixtureForkView {
  const fork = f.fork;
  const manager = isManager(league, who);
  const mySide = seatOf(f, who?.coach);
  // A fork record from a failed first team build (no teams yet) still reads as not generated.
  const status: FixtureForkStatus | "none" = !fork || (fork.status === "teams_built" && !SIDES.every((s) => fork.teams[s])) ? "none" : fork.status;
  const blocker = generateBlocker(league, season, f);
  const idle = status === "none" || status === "teams_built";
  const live = (status === "scheduled" || status === "in_progress") && Boolean(fork?.gameId);
  const involved = manager || Boolean(mySide);
  const hidden = !manager && registrationsOf(league).hideTeamComposition;
  const result = fork?.result && hidden
    ? { ...fork.result, home: { ...fork.result.home, lines: mySide === "home" ? fork.result.home.lines : [] }, away: { ...fork.result.away, lines: mySide === "away" ? fork.result.away.lines : [] } }
    : fork?.result;
  return {
    enabled: league.playOnFork === true && f.forkEnabled === true,
    status,
    statusLabel: FORK_STATUS_LABEL[status],
    allowLate: f.forkAllowLate === true,
    cancelled: f.forkCancelled === true,
    teams: Object.fromEntries(SIDES.filter((s) => fork?.teams[s]).map((s) => [s, { builtAt: fork!.teams[s]!.builtAt }])),
    ...(fork?.gameId ? { gameId: fork.gameId } : {}),
    ...(fork?.scheduledAt ? { scheduledAt: fork.scheduledAt } : {}),
    ...(involved && fork?.error ? { error: fork.error } : {}),
    ...(mySide ? { mySide } : {}),
    ...(involved && fork?.launched ? { launched: fork.launched } : {}),
    canGenerate: involved && idle && !blocker,
    ...(involved && blocker && idle ? { blocker } : {}),
    canStart: Boolean(mySide) && live && f.forkCancelled !== true,
    canReset: manager && status === "launch_failed",
    canConfigure: manager,
    ...(result ? { result } : {}),
    ...(manager && fork?.log.length ? { log: fork.log } : {}),
  };
}

/** The fork state a season read carries: status only (teams, ids and the log stay on the summary route). */
export function publicForkState(f: LeagueFixture): LeagueFixture {
  const { fork, forkNotice: _n, ...rest } = f;
  return fork ? { ...rest, fork: { status: fork.status, teams: {}, log: [] } } : rest;
}

// ---- writes ----

interface Located { league: LeagueRecord; season: SeasonRecord; fixture: LeagueFixture }
function locate(store: LeagueStore, leagueId: string, seasonId: string, fixtureId: string): Located | LeagueApiResult {
  const league = store.league(leagueId);
  if (!league) return fail(404, "League not found.");
  const season = store.season(leagueId, seasonId);
  if (!season) return fail(404, "Season not found.");
  const fixture = season.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return fail(404, "Fixture not found.");
  return { league, season, fixture };
}
const isResult = (x: Located | LeagueApiResult): x is LeagueApiResult => "status" in x;

/** Re-reads the season and replaces this fixture's fork state (and anything `also` changes) in one synchronous write. */
function saveFork(store: LeagueStore, leagueId: string, seasonId: string, fixtureId: string, mutate: (f: LeagueFixture, s: SeasonRecord) => void): SeasonRecord | undefined {
  const season = store.season(leagueId, seasonId);
  const f = season?.fixtures.find((x) => x.id === fixtureId);
  if (!season || !f) return undefined;
  mutate(f, season);
  store.putSeason(season);
  return season;
}

const log = (fork: FixtureForkState, at: Date, by: string, text: string): void => {
  fork.log.push({ at: at.toISOString(), by, text });
  if (fork.log.length > 100) fork.log.splice(0, fork.log.length - 100);
};

function send(deps: ForkRouteDeps, coach: string, input: NotificationInput): void {
  try { deps.notify?.(coach, input); } catch { /* fire-and-forget */ }
}

async function discord(deps: ForkRouteDeps, league: LeagueRecord, event: "fixtureCreated" | "matchResult", title: string, text: string): Promise<void> {
  if (!discordEvents(league)[event]) return;
  const url = deps.store.secrets(league.id).discordWebhookUrl;
  if (!url) return;
  try { await (deps.postWebhook ?? defaultPoster)(url, buildFixturePost(league, title, text)); } catch { /* best effort */ }
}

/** Invitation and organiser notices for a freshly scheduled game (each coach once). */
export function inviteNotices(league: LeagueRecord, seasonId: string, f: LeagueFixture, actor: string, siteAdmins: string[]): Array<{ coach: string; input: NotificationInput }> {
  const link = fixturePageLink(league.id, seasonId, f.id);
  const match = `${f.home.team} vs ${f.away.team}`;
  const out: Array<{ coach: string; input: NotificationInput }> = [];
  const seen = new Set<string>([actor.trim().toLowerCase()]);
  const add = (coach: string | undefined, input: NotificationInput): void => {
    const key = coach?.trim().toLowerCase();
    if (!coach || !key || seen.has(key)) return;
    seen.add(key);
    out.push({ coach: coach.trim(), input });
  };
  for (const s of SIDES)
    add(f[s].coachId, { type: "league-broadcast", title: "Play on Super FUMBBL", body: `${actor} has invited you to play your match on Super FUMBBL (${league.name}: ${match}).`, link, from: actor });
  const notice: NotificationInput = { type: "league-broadcast", title: "Fixture generated on Super FUMBBL", body: `${actor} generated ${match} (${league.name}) on Super FUMBBL.`, link, from: actor };
  for (const coach of [leagueOwner(league), ...league.organisers, ...siteAdmins]) add(coach, notice);
  return out;
}

/** A fixture whose Super FUMBBL game holds its teams: scheduled, running, or cancelled with a game still on the fork. */
const holdsGame = (f: LeagueFixture): boolean => Boolean(f.fork?.gameId) && ["scheduled", "in_progress", "cancelled"].includes(f.fork!.status);

/**
 * Builds the given sides' fork teams from the league rosters as they are now and schedules the game, in the fork
 * client's single critical section; records the outcome on the fixture. Runs under the fixture lock and both team locks.
 */
async function buildAndSchedule(deps: ForkRouteDeps, client: LeagueForkClient, leagueId: string, seasonId: string, fixtureId: string, who: string, rebuild: ForkSide[]): Promise<
  { ok: true; season: SeasonRecord; fixture: LeagueFixture; scheduled: boolean; invite: boolean } | { ok: false; result: LeagueApiResult }> {
  const now = (): Date => deps.now?.() ?? new Date();
  const at = locate(deps.store, leagueId, seasonId, fixtureId);
  if (isResult(at)) return { ok: false, result: at };
  const { season, fixture } = at;
  for (const s of rebuild) {
    const side = fixture[s];
    const busy = season.fixtures.find((o) => o.id !== fixture.id && holdsGame(o) && SIDES.some((x) => o.fork?.teams[x]?.teamId === side.teamId));
    if (busy) return { ok: false, result: fail(409, `${side.team} is in another Super FUMBBL game (${busy.home.team} vs ${busy.away.team}). Finish that one first.`) };
  }
  const files: Partial<Record<ForkSide, LeagueForkTeamFile>> = {};
  for (const s of rebuild) {
    const side = fixture[s];
    try {
      files[s] = buildLeagueForkTeam({ leagueId, seasonId, team: season.teams.find((t) => t.id === side.teamId)!, coach: side.coachId!, rosters: client.rosters(), ruleset: season.ruleset, bankingGuard: client.bankingGuard === true, now: now() });
    } catch (e) {
      if (e instanceof ForkTeamBuildError) return { ok: false, result: fail(409, e.message) };
      throw e;
    }
  }
  const forkId = (s: ForkSide): string => files[s]?.forkTeamId ?? fixture.fork?.teams[s]?.forkTeamId ?? forkTeamIdFor(leagueId, seasonId, fixture[s].teamId!);
  let outcome: ForkScheduleOutcome;
  try {
    outcome = await client.prepareGame({ install: rebuild.map((s) => ({ coach: fixture[s].coachId!, file: files[s]! })), home: forkId("home"), away: forkId("away") });
  } catch (e) {
    const reason = e instanceof Error && e.message ? e.message : "the fork did not load the teams";
    saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
      f.fork ??= { status: "teams_built", teams: {}, log: [] };
      log(f.fork, now(), who, `Team build failed: ${reason}`);
      if (!SIDES.every((x) => f.fork!.teams[x])) f.fork.error = `Team build failed: ${reason}`;
    });
    return { ok: false, result: fail(502, `The teams could not be prepared on Super FUMBBL: ${reason}`) };
  }
  let invite = false;
  const saved = saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
    const fork: FixtureForkState = f.fork ?? { status: "teams_built", teams: {}, log: [] };
    for (const s of rebuild) {
      const file = files[s]!;
      fork.teams[s] = { teamId: f[s].teamId!, forkTeamId: file.forkTeamId, coach: f[s].coachId!, builtAt: now().toISOString(), players: file.players, revision: file.revision };
    }
    if (rebuild.length) log(fork, now(), who, `Built ${rebuild.map((s) => f[s].team).join(" and ")} on Super FUMBBL from the league roster.`);
    fork.generatedBy ??= who;
    fork.generatedAt ??= now().toISOString();
    if (outcome.kind === "scheduled") {
      fork.status = "scheduled";
      fork.gameId = outcome.gameId;
      fork.gameName = `league-${fixtureId}`.slice(0, 60);
      fork.scheduledAt = now().toISOString();
      delete fork.error;
      delete fork.uncertain;
      log(fork, now(), who, `Scheduled game ${outcome.gameId}.`);
      invite = !fork.invited;
      fork.invited = true;
      f.startedAt ??= now().toISOString();
    } else {
      fork.status = "launch_failed";
      if (outcome.kind === "unknown") fork.uncertain = true; else delete fork.uncertain;
      fork.error = outcome.kind === "unknown" ? `The fork did not answer clearly; a game may exist (${outcome.error}).` : outcome.error;
      log(fork, now(), who, `Scheduling failed: ${fork.error}`);
    }
    f.fork = fork;
  });
  const final = saved?.fixtures.find((f) => f.id === fixtureId);
  if (!saved || !final) return { ok: false, result: fail(404, "Fixture not found.") };
  return { ok: true, season: saved, fixture: final, scheduled: outcome.kind === "scheduled", invite };
}

/** Sides whose fork team is missing or was built from an older league roster. */
function staleSides(season: SeasonRecord, f: LeagueFixture): ForkSide[] {
  return SIDES.filter((s) => {
    const built = f.fork?.teams[s];
    if (!built) return true;
    const team = season.teams.find((t) => t.id === f[s].teamId);
    if (!team) return false;
    // A team recorded before fingerprints existed cannot be shown current: rebuild it.
    return !built.revision || built.revision !== leagueTeamRevision(team);
  });
}

async function generate(deps: ForkRouteDeps, client: LeagueForkClient, leagueId: string, seasonId: string, fixtureId: string, who: LeagueApiIdentity): Promise<LeagueApiResult> {
  const at = locate(deps.store, leagueId, seasonId, fixtureId);
  if (isResult(at)) return at;
  const { league, fixture } = at;
  if (!seatOf(fixture, who.coach) && !isManager(league, who)) return fail(403, "Only the coaches of this fixture and the league organisers can generate it on Super FUMBBL.");
  const precheck = (x: Located): LeagueApiResult | undefined => {
    const status = x.fixture.fork?.status;
    if (status === "scheduled" || status === "in_progress") return res(200, { ok: true, fork: fixtureForkView(x.league, x.season, x.fixture, who) });
    if (status === "finished") return fail(409, "This fixture's Super FUMBBL game is finished.");
    if (status === "launch_failed") return fail(409, "The last attempt failed. An organiser can reset the game and try again.");
    const blocker = generateBlocker(x.league, x.season, x.fixture);
    return blocker ? fail(409, blocker) : undefined;
  };
  const early = precheck(at);
  if (early) return early;
  const teamIds = SIDES.map((s) => forkTeamIdFor(leagueId, seasonId, fixture[s].teamId!));
  return withTeamLocks(teamIds, async () => {
    const again = locate(deps.store, leagueId, seasonId, fixtureId);
    if (isResult(again)) return again;
    const stop = precheck(again);
    if (stop) return stop;
    const done = await buildAndSchedule(deps, client, leagueId, seasonId, fixtureId, who.coach, staleSides(again.season, again.fixture));
    if (!done.ok) return done.result;
    if (done.invite) {
      for (const n of inviteNotices(league, seasonId, done.fixture, who.coach, admins(deps))) send(deps, n.coach, n.input);
      await discord(deps, league, "fixtureCreated", `${done.fixture.home.team} vs ${done.fixture.away.team} on Super FUMBBL`, `${who.coach} generated this ${done.season.name} fixture on Super FUMBBL.`);
    }
    const view = fixtureForkView(league, done.season, done.fixture, who);
    return done.scheduled ? res(200, { ok: true, fork: view }) : res(502, { error: done.fixture.fork!.error, fork: view });
  });
}

function seatedLive(at: Located, who: LeagueApiIdentity): { side: ForkSide; fork: FixtureForkState } | LeagueApiResult {
  const side = seatOf(at.fixture, who.coach);
  if (!side) return fail(403, "Only the coaches seated in this fixture get its launch file.");
  const fork = at.fixture.fork;
  if (at.fixture.forkCancelled) return fail(409, "Super FUMBBL play is cancelled for this fixture.");
  if (!fork?.gameId || !fork.teams[side] || (fork.status !== "scheduled" && fork.status !== "in_progress"))
    return fail(409, "Generate the fixture on Super FUMBBL first.");
  return { side, fork };
}

/** Play has started for this fixture: a coach took a launch file, or the fork runs the game. */
const playStarted = (f: LeagueFixture): boolean => f.fork?.status === "in_progress" || Boolean(f.fork?.launched && Object.keys(f.fork.launched).length);

/**
 * Before the first launch: a team whose league roster changed since it was built is rebuilt, and the unstarted game is
 * withdrawn (the fork confirms) and scheduled again with the fresh teams. After play starts nothing is rebuilt.
 */
async function prepareLaunch(deps: ForkRouteDeps, client: LeagueForkClient, leagueId: string, seasonId: string, fixtureId: string, who: LeagueApiIdentity): Promise<
  { side: ForkSide; stale: ForkSide[] } | LeagueApiResult> {
  const at = locate(deps.store, leagueId, seasonId, fixtureId);
  if (isResult(at)) return at;
  const seat = seatedLive(at, who);
  if ("status" in seat) return seat;
  const stale = playStarted(at.fixture) || seat.fork.status !== "scheduled" ? [] : staleSides(at.season, at.fixture);
  if (stale.length) {
    const teamIds = SIDES.map((s) => seat.fork.teams[s]?.forkTeamId ?? forkTeamIdFor(leagueId, seasonId, at.fixture[s].teamId!));
    const refreshed = await withTeamLocks(teamIds, async (): Promise<LeagueApiResult | undefined> => {
      const old = seat.fork.gameId!;
      if (!(await client.deleteGame(old))) {
        return fail(409, "A league roster changed since this game was set up, and the old game could not be withdrawn on Super FUMBBL. Try again shortly.");
      }
      const t = deps.now?.() ?? new Date();
      saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
        const fork = f.fork!;
        delete fork.gameId; delete fork.gameName; delete fork.scheduledAt;
        fork.status = "teams_built";
        log(fork, t, who.coach, `Withdrew game ${old}: the league roster of ${stale.map((s) => f[s].team).join(" and ")} changed since it was built.`);
      });
      const done = await buildAndSchedule(deps, client, leagueId, seasonId, fixtureId, who.coach, stale);
      if (!done.ok) return done.result;
      if (!done.scheduled) return res(502, { error: done.fixture.fork!.error, fork: fixtureForkView(at.league, done.season, done.fixture, who) });
      return undefined;
    });
    if (refreshed) return refreshed;
  }
  return { side: seat.side, stale };
}

/** Records that this seat took its launch file (play has started: no more rebuilds, the rosters lock). */
function recordLaunch(deps: ForkRouteDeps, leagueId: string, seasonId: string, fixtureId: string, side: ForkSide): LeagueFixture | undefined {
  const t = deps.now?.() ?? new Date();
  const saved = saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
    if (!f.fork) return;
    f.fork.launched = { ...(f.fork.launched ?? {}), [side]: t.toISOString() };
  });
  return saved?.fixtures.find((f) => f.id === fixtureId);
}

async function launch(deps: ForkRouteDeps, client: LeagueForkClient, leagueId: string, seasonId: string, fixtureId: string, who: LeagueApiIdentity): Promise<LeagueApiResult> {
  const ready = await prepareLaunch(deps, client, leagueId, seasonId, fixtureId, who);
  if ("status" in ready) return ready;
  const gameId = recordLaunch(deps, leagueId, seasonId, fixtureId, ready.side)?.fork?.gameId;
  return res(200, { ok: true, jnlpUrl: `/api/leagues/${encodeURIComponent(leagueId)}/seasons/${encodeURIComponent(seasonId)}/fixtures/${encodeURIComponent(fixtureId)}/fork/jnlp`, side: ready.side, gameId, ...(ready.stale.length ? { rebuilt: ready.stale } : {}) });
}

/**
 * The launch file itself: the same fixture lock, seat and roster-freshness preparation as POST launch (a stale team is
 * rebuilt first, or 409 when its old game cannot be withdrawn), and the launch is recorded once the file is made.
 */
async function launchFileRoute(deps: ForkRouteDeps, client: LeagueForkClient, leagueId: string, seasonId: string, fixtureId: string, who: LeagueApiIdentity): Promise<LeagueApiResult> {
  const ready = await prepareLaunch(deps, client, leagueId, seasonId, fixtureId, who);
  if ("status" in ready) return ready;
  const at = locate(deps.store, leagueId, seasonId, fixtureId);
  if (isResult(at)) return at;
  const fork = at.fixture.fork;
  const team = fork?.teams[ready.side];
  if (!fork?.gameId || !team) return fail(409, "Generate the fixture on Super FUMBBL first.");
  try {
    const jnlp = await client.launchFile({ coach: team.coach, teamId: team.forkTeamId, gameName: fork.gameName ?? `league-${fixtureId}`, gameId: fork.gameId });
    recordLaunch(deps, leagueId, seasonId, fixtureId, ready.side);
    const safe = (s: string): string => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "game";
    return { status: 200, download: { bytes: Buffer.from(jnlp, "utf8"), contentType: "application/x-java-jnlp-file; charset=utf-8", filename: `league_${safe(fixtureId)}_${safe(team.coach)}.jnlp` }, headers: { ...NO_STORE } };
  } catch (e) {
    if (e instanceof ForkClientError) return fail(e.status, e.message);
    return fail(502, "The launch file could not be made right now.");
  }
}

async function reset(deps: ForkRouteDeps, leagueId: string, seasonId: string, fixtureId: string, who: LeagueApiIdentity, input: Record<string, unknown>): Promise<LeagueApiResult> {
  const at = locate(deps.store, leagueId, seasonId, fixtureId);
  if (isResult(at)) return at;
  if (!isManager(at.league, who)) return fail(403, "Only the league organisers can reset a Super FUMBBL game.");
  const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
  if (!reason) return fail(400, "Give a reason for the reset.");
  if (reason.length > RESET_REASON_MAX) return fail(400, `Keep the reason under ${RESET_REASON_MAX} characters.`);
  const fork0 = at.fixture.fork;
  if (fork0?.status !== "launch_failed") return fail(409, "Only a failed Super FUMBBL game can be reset.");
  const now = deps.now?.() ?? new Date();
  // An unclear schedule answer may have made a game: look for it before letting anyone schedule another.
  if (fork0.uncertain) {
    if (!deps.fork) return fail(503, "Super FUMBBL is not connected on this server, so the possible game cannot be checked.");
    const home = fork0.teams.home?.forkTeamId;
    const away = fork0.teams.away?.forkTeamId;
    const found: ForkFindOutcome = home && away ? await deps.fork.findGame(home, away) : { kind: "none" };
    if (found.kind === "unknown") return fail(503, "Super FUMBBL could not confirm whether the game exists. Try the reset again shortly.");
    if (found.kind === "found") {
      const saved = saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
        const fork = f.fork!;
        fork.status = "scheduled";
        fork.gameId = found.gameId;
        fork.gameName ??= `league-${fixtureId}`.slice(0, 60);
        fork.scheduledAt ??= now.toISOString();
        delete fork.error;
        delete fork.uncertain;
        log(fork, now, who.coach, `Reset asked (${reason}); game ${found.gameId} was found on Super FUMBBL and kept.`);
      });
      const f = saved?.fixtures.find((x) => x.id === fixtureId);
      return saved && f ? res(200, { ok: true, found: found.gameId, fork: fixtureForkView(at.league, saved, f, who) }) : fail(404, "Fixture not found.");
    }
  }
  const saved = saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
    const fork = f.fork!;
    const old = fork.gameId;
    delete fork.gameId;
    delete fork.gameName;
    delete fork.scheduledAt;
    delete fork.error;
    delete fork.launched;
    delete fork.uncertain;
    fork.status = "teams_built";
    log(fork, now, who.coach, `Reset${old ? ` (game ${old} dropped)` : ""}: ${reason}`);
  });
  const f = saved?.fixtures.find((x) => x.id === fixtureId);
  return saved && f ? res(200, { ok: true, fork: fixtureForkView(at.league, saved, f, who) }) : fail(404, "Fixture not found.");
}

/** "Allow late launch" with the fixture's Allow switch (no fork call). */
export function applyForkSettings(f: LeagueFixture, input: { forkAllowLate?: boolean }, by: string, now: Date): void {
  if (input.forkAllowLate === undefined) return;
  if (input.forkAllowLate) f.forkAllowLate = true; else delete f.forkAllowLate;
  if (f.fork) log(f.fork, now, by, input.forkAllowLate ? "Allowed a late launch." : "Late launch no longer allowed.");
}

/**
 * Admin per-game settings (fixture PATCH without forkEnabled): late launch and cancel, under the fixture lock.
 * Cancel withdraws the fork game only when it has not started and the fork confirms; otherwise the game is kept, its
 * reference stays and the result is still synced. Allowing play again returns to where the fixture was.
 */
export async function updateForkSettings(deps: ForkRouteDeps, leagueId: string, seasonId: string, fixtureId: string, who: LeagueApiIdentity, input: { forkAllowLate?: boolean; forkCancelled?: boolean }): Promise<LeagueApiResult> {
  return withFixtureLock(`${leagueId}/${seasonId}/${fixtureId}`, async () => {
    const at = locate(deps.store, leagueId, seasonId, fixtureId);
    if (isResult(at)) return at;
    const fork0 = at.fixture.fork;
    if (fork0?.status === "finished" && input.forkCancelled === true) return fail(409, "This fixture's Super FUMBBL game is finished.");
    const now = deps.now?.() ?? new Date();
    let withdrew: string | undefined;
    const cancelling = input.forkCancelled === true && at.fixture.forkCancelled !== true;
    if (cancelling && fork0?.gameId && fork0.status === "scheduled" && !playStarted(at.fixture) && deps.fork) {
      if (await deps.fork.deleteGame(fork0.gameId)) withdrew = fork0.gameId;
    }
    const saved = saveFork(deps.store, leagueId, seasonId, fixtureId, (f) => {
      applyForkSettings(f, input, who.coach, now);
      if (input.forkCancelled === undefined) return;
      const was = f.forkCancelled === true;
      if (input.forkCancelled) f.forkCancelled = true; else delete f.forkCancelled;
      const fork = f.fork;
      if (!fork || was === input.forkCancelled || fork.status === "finished") return;
      if (input.forkCancelled) {
        fork.statusBeforeCancel = fork.status;
        if (withdrew && fork.gameId === withdrew) {
          delete fork.gameId; delete fork.gameName; delete fork.scheduledAt; delete fork.launched;
          fork.statusBeforeCancel = "teams_built";
          log(fork, now, who.coach, `Cancelled Super FUMBBL play; game ${withdrew} was withdrawn.`);
        } else if (fork.gameId) {
          log(fork, now, who.coach, `Cancelled Super FUMBBL play. Game ${fork.gameId} could not be withdrawn (it may have started); it stays watched and its result still counts.`);
        } else {
          log(fork, now, who.coach, "Cancelled Super FUMBBL play.");
        }
        fork.status = "cancelled";
      } else if (fork.status === "cancelled") {
        fork.status = fork.statusBeforeCancel ?? (fork.gameId ? "scheduled" : "teams_built");
        delete fork.statusBeforeCancel;
        log(fork, now, who.coach, "Super FUMBBL play allowed again.");
      }
    });
    const f = saved?.fixtures.find((x) => x.id === fixtureId);
    return f ? res(200, { ok: true, fixture: publicForkState(f) }) : fail(404, "Fixture not found.");
  });
}

// ---- results ----

export interface SyncDeps {
  store: LeagueStore;
  fork: LeagueForkClient;
  notify?: (coach: string, input: NotificationInput) => void;
  postWebhook?: WebhookPoster;
  now?: () => Date;
}

/** Applies a finished game's result to its fixture once (under the fixture lock). */
export async function applyFixtureResult(deps: SyncDeps, leagueId: string, seasonId: string, fixtureId: string, result: ForkGameResult): Promise<{ applied: boolean; reason?: string }> {
  return withFixtureLock(`${leagueId}/${seasonId}/${fixtureId}`, async () => {
    const now = deps.now?.() ?? new Date();
    let outcome: ReturnType<typeof applyForkResult> | undefined;
    const saved = saveFork(deps.store, leagueId, seasonId, fixtureId, (f, season) => {
      outcome = applyForkResult(season, f, result, now);
      if (outcome.applied) {
        const r = outcome.result;
        log(f.fork!, now, "Super FUMBBL", `Result ${r.home.score} - ${r.away.score} applied (game ${r.gameId}, ${r.source === "full" ? "full result" : "score and player counters only"}).`);
      } else if (!outcome.already && f.fork) {
        log(f.fork, now, "Super FUMBBL", `Result of game ${result.gameId} not applied: ${outcome.reason}`);
      }
    });
    if (!saved || !outcome) return { applied: false, reason: "Fixture not found." };
    if (!outcome.applied) return { applied: false, reason: outcome.reason };
    const league = deps.store.league(leagueId);
    const f = saved.fixtures.find((x) => x.id === fixtureId)!;
    const r = outcome.result;
    const line = `${f.home.team} ${r.home.score} - ${r.away.score} ${f.away.team}`;
    if (league) {
      const link = fixturePageLink(leagueId, seasonId, fixtureId);
      for (const s of SIDES) {
        const coach = f[s].coachId;
        if (coach) send(deps as ForkRouteDeps, coach, { type: "league-broadcast", title: "Super FUMBBL result recorded", body: `${line} (${league.name}). Your league team has been updated from the game.`, link });
      }
      await discord(deps as ForkRouteDeps, league, "matchResult", line, `${saved.name}, played on Super FUMBBL.${outcome.retired.home.length + outcome.retired.away.length ? " Players were lost in this game." : ""}`);
    }
    return { applied: true };
  });
}

/**
 * Looks at every fixture with a live Super FUMBBL game: marks it in progress when the fork runs it, and applies the
 * result once the fork has finished it. Safe to run on a timer and by hand at the same time.
 */
export async function syncLeagueForkResults(deps: SyncDeps, only?: { leagueId: string; seasonId: string; fixtureId: string }): Promise<{ applied: string[]; errors: string[] }> {
  const open: Array<{ leagueId: string; seasonId: string; fixtureId: string; gameId: string; status: FixtureForkStatus }> = [];
  for (const league of deps.store.list()) {
    if (only && league.id !== only.leagueId) continue;
    for (const season of deps.store.seasons(league.id)) {
      if (only && season.id !== only.seasonId) continue;
      for (const f of season.fixtures) {
        if (only && f.id !== only.fixtureId) continue;
        // Cancelled fixtures keep syncing a game the fork still has (it may have been played).
        if (f.fork?.gameId && (f.fork.status === "scheduled" || f.fork.status === "in_progress" || f.fork.status === "cancelled"))
          open.push({ leagueId: league.id, seasonId: season.id, fixtureId: f.id, gameId: f.fork.gameId, status: f.fork.status });
      }
    }
  }
  const applied: string[] = [];
  const errors: string[] = [];
  if (!open.length) return { applied, errors };
  let states: Map<string, ForkGameState>;
  try { states = await deps.fork.gameStates([...new Set(open.map((o) => o.gameId))]); } catch (e) {
    return { applied, errors: [`game list: ${(e as Error).message}`] };
  }
  for (const o of open) {
    const st = states.get(o.gameId);
    if (!st) continue;
    if (st.status === "active" && o.status === "scheduled") {
      await withFixtureLock(`${o.leagueId}/${o.seasonId}/${o.fixtureId}`, async () => {
        saveFork(deps.store, o.leagueId, o.seasonId, o.fixtureId, (f) => {
          if (f.fork?.gameId === o.gameId && f.fork.status === "scheduled") f.fork.status = "in_progress";
        });
      });
      continue;
    }
    if (st.status !== "finished") continue;
    try {
      const result = await deps.fork.result(o.gameId, st.playedAt);
      if (!result) continue;
      const done = await applyFixtureResult(deps, o.leagueId, o.seasonId, o.fixtureId, result);
      if (done.applied) applied.push(o.gameId); else if (done.reason) errors.push(`${o.gameId}: ${done.reason}`);
    } catch (e) {
      errors.push(`${o.gameId}: ${(e as Error).message}`);
    }
  }
  return { applied, errors };
}

// ---- routes ----

/** Fixture summary and the fork actions; undefined when the path is not one of them. */
export async function leagueForkRoutes(
  method: string,
  leagueId: string,
  rest: string[],
  auth: LeagueApiIdentity | undefined,
  deps: ForkRouteDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, third, fixtureId, fourth, action, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "fixtures" || !fixtureId || more.length) return undefined;
  if (fourth === undefined) {
    if (method !== "GET" && method !== "HEAD") return undefined; // PATCH = the admin switches (settings routes)
    const at = locate(deps.store, leagueId, seasonId, fixtureId);
    if (isResult(at)) return at;
    const { league, season, fixture } = at;
    const { fork: _f, forkNotice: _n, ...shown } = fixture;
    return res(200, {
      league: { id: league.id, name: league.name, playOnFork: league.playOnFork === true },
      season: { id: season.id, name: season.name, status: season.status, ruleset: season.ruleset },
      fixture: shown,
      fork: fixtureForkView(league, season, fixture, auth),
      forkAvailable: Boolean(deps.fork),
    });
  }
  if (fourth !== "fork" || !action) return undefined;
  const known = ["generate", "launch", "jnlp", "reset", "sync"];
  if (!known.includes(action)) return fail(404, "Not found.");
  const wantGet = action === "jnlp";
  if (wantGet ? method !== "GET" : method !== "POST") return fail(405, wantGet ? "Use GET." : "Use POST.");
  if (!auth) return fail(401, "Sign in first.");
  let input: Record<string, unknown> = {};
  if (!wantGet) {
    const body = await readJsonObject(deps, FORK_BODY_MAX);
    if (!body.ok) return { status: body.status, ...(body.close ? { close: true } : {}), body: { error: body.error }, headers: { ...NO_STORE } };
    input = body.value;
  }
  const client = deps.fork;
  const key = `${leagueId}/${seasonId}/${fixtureId}`;
  if (action === "reset") return withFixtureLock(key, () => reset(deps, leagueId, seasonId, fixtureId, auth, input));
  if (!client) return fail(503, "Super FUMBBL is not connected on this server.");
  if (action === "generate") return withFixtureLock(key, () => generate(deps, client, leagueId, seasonId, fixtureId, auth));
  if (action === "sync") {
    const at = locate(deps.store, leagueId, seasonId, fixtureId);
    if (isResult(at)) return at;
    if (!isManager(at.league, auth)) return fail(403, "Only the league organisers can check for a result.");
    const out = await syncLeagueForkResults({ ...deps, fork: client }, { leagueId, seasonId, fixtureId });
    const now = locate(deps.store, leagueId, seasonId, fixtureId);
    if (isResult(now)) return now;
    return res(200, { ok: true, applied: out.applied, errors: out.errors, fork: fixtureForkView(now.league, now.season, now.fixture, auth) });
  }
  if (action === "launch") return withFixtureLock(key, () => launch(deps, client, leagueId, seasonId, fixtureId, auth));
  return withFixtureLock(key, () => launchFileRoute(deps, client, leagueId, seasonId, fixtureId, auth));
}
