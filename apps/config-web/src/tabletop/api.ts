/**
 * Tabletop recorder HTTP API (pure: server.ts supplies the session and the deps).
 *   POST /api/tabletop/matches                    create (participant or organiser)
 *   GET  /api/tabletop/matches/:id                match + events + current team files (participant/organiser)
 *   POST /api/tabletop/matches/:id/events         batch {events:[...]}, idempotent by event id
 *   POST /api/tabletop/matches/:id/submit         recording -> submitted, computes the preview
 *   POST /api/tabletop/matches/:id/confirm        each coach; organiser confirms for both; completes the match
 *   POST /api/tabletop/matches/:id/undo-revision  organiser: revert both teams one revision, reopen
 * Auth: Discord session only (401 anonymous, 403 non-Discord session / banned / non-participant).
 */

import { randomBytes, randomInt } from "node:crypto";
import { nafTimestamp } from "../tournaments/nafExport.js";
import { BANNED_ACCOUNT_MESSAGE } from "../auth/access.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import {
  MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_MATCH, effectiveEvents, parseEvent, validateEvent, type Side, type TabletopEvent,
} from "./events.js";
import {
  PRAYERS_TO_NUFFLE, journeymenNeeded, makeJourneymen, overlayRosters, planInducements, pregameSummary, teamValueWithJourneymen, weatherFor,
  type MatchPhase,
} from "./pregame.js";
import { leagueStandings, type LeaguePoints } from "./standings.js";
import { applyPostMatch, tallyMatch, type PostMatchOption, type PostMatchSummary, type TabletopPlayer, type TabletopTeamFile } from "./postMatch.js";
import { headRevision, type ChainChange, type CommitJournal, type MatchRecord, type TabletopRepository, type TeamChain } from "./store.js";
import { duplicatePlayerId, parseTeamRef } from "./teamFile.js";

export interface TabletopAuth { coach: string; method: string }
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
  round?: number;
  resultReportedAt?: string;
  /** The op id stamped on the recorded result (tabletop publications only). */
  resultOpId?: string;
}

/** The tournaments store seen through the single existing result path (TournamentStore.recordResult). */
export interface FixtureGateway {
  get(id: string): FixtureView | undefined;
  /** Every scheduled match (open or not); the fixtures route filters. */
  list?(): FixtureView[];
  record(id: string, input: { opId?: string; expectedRevision: number; homeScore: number; awayScore: number; homeCasualties: number; awayCasualties: number }, at: Date): void;
  retract(id: string, input: { expectedRevision: number; status: string }, at: Date): void;
}

export interface TabletopApiDeps {
  repo: TabletopRepository;
  results: {
    put(row: StoredTournamentResult): unknown;
    remove(gameId: string): boolean;
    get(gameId: string): StoredTournamentResult | undefined;
    /** Counting rows only (fork + published tabletop). */
    list(): StoredTournamentResult[];
  };
  fixtures?: FixtureGateway;
  /** A fixture's team id (the entrant's fork team) as a team the recorder can load for that coach, if it can. */
  resolveFixtureTeam?: (coach: string, teamId: string) => { ref: string; name: string } | undefined;
  /** Die roller for the server-side pre-game rolls: 1..sides. Default is crypto-random; tests inject. */
  rollDie?: (sides: number) => number;
  /** Fork-game metadata lookup for league standings (package name of a fork tournament game). */
  forkMetadata?: Parameters<typeof leagueStandings>[2];
  /** A league's points scheme when the tournaments store has one; default 3/1/0. */
  pointsFor?: (league: string) => LeaguePoints | undefined;
  /** The coach's own saved team as a team file (baseline revision), or undefined if they have no such save. */
  loadTeamFile: (coach: string, teamSaveId: string) => TabletopTeamFile | undefined;
  isBanned: (coach: string) => boolean;
  isOrganizer: (coach: string) => boolean;
  /** A coach's saved teams (id + name only, never roster bodies). */
  listSaves?: (coach: string) => Array<{ id: string; name: string }>;
  /** Every team the coach can play: fork library teams ("library:<id>") and builder saves (bare id). */
  listTeams?: (coach: string) => Array<{ ref: string; name: string; race: string; tv: number | null }>;
  now?: () => Date;
}

export const isTabletopApiPath = (path: string): boolean => path === "/api/tabletop" || path.startsWith("/api/tabletop/") || path === "/api/standings";

const POST_MATCH: readonly string[] = ["none", "spp-only", "full"];
const err = (status: number, error: string): TabletopResult => ({ status, body: { error } });
const resultGameId = (matchId: string): string => `tabletop-${matchId}`;

// Per-match serialisation: a repository that is not synchronous (Postgres) still sees one writer per match.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
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
  if (!auth?.coach) return err(401, "Sign in with Discord first.");
  if (auth.method !== "discord") return err(403, "The match recorder needs a Discord sign-in.");
  const me = auth.coach;
  if (deps.isBanned(me)) return err(403, BANNED_ACCOUNT_MESSAGE);
  const organiser = deps.isOrganizer(me);
  const now = (): Date => deps.now?.() ?? new Date();
  const { repo } = deps;

  if (path === "/api/tabletop/matches") {
    if (method === "GET") return listMatches(me, organiser, deps);
    if (method !== "POST") return err(405, "Method not allowed.");
    return createMatch(me, organiser, body, deps, now);
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
    const saves = (deps.listSaves?.(coach) ?? []).map((s) => ({ id: s.id, name: s.name }));
    const teams = (deps.listTeams?.(coach) ?? saves.map((x) => ({ ref: x.id, name: x.name, race: "", tv: null })))
      .map((t) => ({ ref: t.ref, name: t.name, race: t.race, tv: t.tv }));
    return { status: 200, body: { coach, saves, teams } };
  }
  const m = /^\/api\/tabletop\/matches\/([\w-]{1,64})(?:\/(events|submit|confirm|publish|undo-revision|resolve-conflict|pregame\/advance))?$/.exec(path);
  if (!m) return err(404, "Not found.");
  const id = m[1]!;
  const action = m[2];

  const match = await repo.getMatch(id);
  if (!match) return err(404, "Match not found.");
  const participant = match.home.coach === me || match.away.coach === me;
  if (!participant && !organiser) return err(403, "You are not a participant in this match.");

  if (!action) {
    if (method !== "GET") return err(405, "Method not allowed.");
    const events = await repo.readEvents(id);
    const teams = overlayRosters(await currentTeams(repo, match), events);
    return {
      status: 200,
      body: {
        match, phase: match.phase ?? "playing", pregame: pregameSummary(events), events,
        effectiveEventIds: effectiveEvents(events).map((e) => e.id), teams, tally: tallyView(events, teams),
      },
    };
  }
  if (method !== "POST") return err(405, "Method not allowed.");

  return serial(id, async () => {
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
    if (action === "events") return postEvents(fresh, me, body, deps, now);
    if (action === "pregame/advance") return pregameAdvance(fresh, me, organiser, body, deps, now);
    if (action === "submit") return submit(fresh, deps, now);
    if (action === "confirm") return confirm(fresh, me, organiser, deps, now);
    if (!organiser) return err(403, "Organizer access required.");
    if (action === "publish") return publish(fresh, me, deps, now);
    return undoRevision(fresh, deps, now);
  });
}

async function ensureChain(deps: TabletopApiDeps, coach: string, saveId: string, at: string): Promise<TeamChain | { error: string } | undefined> {
  const existing = await deps.repo.getChain(coach, saveId);
  if (existing) return existing;
  const base = deps.loadTeamFile(coach, saveId);
  if (!base) return undefined;
  const dup = duplicatePlayerId(base);
  if (dup) return { error: `${coach}'s team ${saveId} has a duplicate player id (${dup}).` };
  const chain: TeamChain = { saveId, coach, head: 0, revisions: [{ saveId, revision: 0, parent: null, teamFile: base, createdAt: at }] };
  await deps.repo.putChain(chain);
  return chain;
}

/** The server's own count of the effective events (score, per-player SPP, casualties): clients never compute rules. */
function tallyView(events: readonly TabletopEvent[], teams: Record<Side, TabletopTeamFile | undefined>) {
  const names = (t: TabletopTeamFile | undefined) => new Map((t?.players ?? []).map((p) => [p.id, p.name] as const));
  const t = tallyMatch(events, { home: names(teams.home), away: names(teams.away) });
  return {
    score: t.score,
    fanDelta: t.fanDelta,
    treasurySpent: t.treasurySpent,
    conceded: t.conceded,
    clock: t.clock,
    casualtiesSuffered: t.casualtiesSuffered,
    players: { home: [...t.lines.home.values()], away: [...t.lines.away.values()] },
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
        id: m.id, state: m.state, phase: m.phase ?? "playing", pendingOrganiser: m.state === "confirmed", ...(m.fixtureRef ? { fixtureRef: m.fixtureRef } : {}), postMatch: m.postMatch,
        home: { coach: m.home.coach, teamName: m.home.teamName }, away: { coach: m.away.coach, teamName: m.away.teamName },
        createdAt: m.createdAt, updatedAt: m.updatedAt,
      })),
    },
  };
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

async function createMatch(me: string, organiser: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
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
  const home = side(b.home);
  const away = side(b.away);
  if (!home || !away) return err(400, b.fixtureRef ? "Choose both teams: a fixture team could not be found automatically (send home.team / away.team as library:<id> or save:<id>)." : "home and away each need {coach, team}, team being library:<id> or save:<id>.");
  if (home.coach === away.coach) return err(400, "A match needs two different coaches.");
  const postMatch = b.postMatch ?? "full";
  if (typeof postMatch !== "string" || !POST_MATCH.includes(postMatch)) return err(400, "postMatch must be none, spp-only or full.");
  if (b.fixtureRef !== undefined && (typeof b.fixtureRef !== "string" || b.fixtureRef.length > 120)) return err(400, "fixtureRef must be a short string.");
  if (home.coach !== me && away.coach !== me && !organiser) return err(403, "You can only record a match you play in (or as an organiser).");
  if (deps.isBanned(home.coach) || deps.isBanned(away.coach)) return err(403, "A banned account cannot play a recorded match.");
  if (b.league !== undefined && (typeof b.league !== "string" || b.league.length > 60)) return err(400, "league must be a short string.");
  let league: string | undefined = typeof b.league === "string" && b.league.trim() ? b.league.trim() : undefined;
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
    ...(league ? { league } : {}),
    ...(fixtureSwap ? { fixtureSwap } : {}),
    postMatch: postMatch as PostMatchOption,
    createdBy: me,
    createdAt: at,
    updatedAt: at,
    confirmations: {},
    baseRevision: { home: chainHome.head, away: chainAway.head },
  };
  await deps.repo.createMatch(match);
  return { status: 201, body: { match } };
}

async function postEvents(match: MatchRecord, me: string, body: unknown, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state !== "recording") return err(409, `This match is ${match.state}; events can only be added while recording.`);
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
  const accepted: TabletopEvent[] = [];
  const duplicates: string[] = [];
  const at = now().toISOString();
  for (const r of raw) {
    const parsed = parseEvent(r, match.id, me, at);
    if (!parsed.ok) return err(400, parsed.error);
    if (known.has(parsed.event.id)) { duplicates.push(parsed.event.id); continue; }
    const v = validateEvent(parsed.event, running, rosters);
    if ("error" in v) return err(400, v.error);
    known.add(v.event.id);
    running.push(v.event);
    accepted.push(v.event);
  }
  if (stored.length + accepted.length > MAX_EVENTS_PER_MATCH) return err(409, "This match has too many events.");
  await deps.repo.appendEvents(match.id, accepted);
  const result = { accepted: accepted.map((e) => e.id), duplicates, total: stored.length + accepted.length, tally: tallyView(running, teams) };
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
  const built = await buildConfirmJournal(match, me, confirmations, deps, at);
  if (!built.ok) return built.error;
  return commit(built.journal, deps);
}

type Built = { ok: true; journal: CommitJournal } | { ok: false; error: TabletopResult };

/** Everything a finalising confirm writes, as one journal (bans rechecked first). */
async function buildConfirmJournal(
  match: MatchRecord, me: string, confirmations: Record<string, string>, deps: TabletopApiDeps, at: string,
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
  const tally = tallyMatch(events, { home: names(p.chainHome), away: names(p.chainAway) });
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
  const row: StoredTournamentResult = {
    gameId,
    pulledAt: at,
    source: "tabletop",
    ...(match.fixtureRef ? { fixtureRef: match.fixtureRef } : {}),
    ...(match.league ? { league: match.league } : {}),
    published: false,
    home: { teamId: match.home.teamSaveId, teamName: match.home.teamName, coach: match.home.coach },
    away: { teamId: match.away.teamSaveId, teamName: match.away.teamName, coach: match.away.coach },
    teams: [teamResult("home", p.home.summary), teamResult("away", p.away.summary)],
  };
  const next: MatchRecord = {
    ...match, state: "confirmed", confirmations, updatedAt: at, preview: { home: p.home.summary, away: p.away.summary },
    ...(wroteRevisions ? { wroteRevisions } : {}), resultGameId: gameId,
  };
  const change = (before: TeamChain, target: TeamChain): ChainChange => ({ expect: { head: before.head, revisions: before.revisions.length }, target });
  return {
    ok: true,
    journal: {
      matchId: match.id, opId: opId(), kind: "confirm",
      ...(match.postMatch !== "none" ? { homeChain: change(p.chainHome, homeChain), awayChain: change(p.chainAway, awayChain) } : {}),
      result: { put: row }, match: next,
    },
  };
}

async function undoRevision(match: MatchRecord, deps: TabletopApiDeps, now: () => Date, note?: string): Promise<TabletopResult> {
  if (match.state !== "confirmed" && match.state !== "published") return err(409, "Only a confirmed or published match can be reverted.");
  if (await recoveryPending(match, deps)) return recoveryPendingError();
  const chainHome = await deps.repo.getChain(match.home.coach, match.home.teamSaveId);
  const chainAway = await deps.repo.getChain(match.away.coach, match.away.teamSaveId);
  if (!chainHome || !chainAway) return err(409, "Team files are missing.");
  const w = match.wroteRevisions;
  if (w && (chainHome.head !== w.home || chainAway.head !== w.away))
    return err(409, "A team has newer revisions than this match; revert those first.");
  const link = match.state === "published" ? match.fixtureLink : undefined;
  if (link) {
    const f = deps.fixtures?.get(link.id);
    if (!f || f.resultOpId !== link.opId || f.revision !== link.expectedRevision + 1)
      return err(409, "The fixture changed since this result was published; resolve it in the tournament first.");
  }
  const back = (chain: TeamChain, rev: number): TeamChain => ({ ...chain, head: chain.revisions.find((r) => r.revision === rev)!.parent! });
  const { wroteRevisions: _w, resultGameId: _r, preview: _p, fixtureLink: _fl, publishedAt: _pa, publishedBy: _pb, ...rest } = match;
  const next: MatchRecord = { ...rest, state: "recording", confirmations: {}, updatedAt: now().toISOString(), ...(note ? { note } : {}) };
  return commit({
    matchId: match.id, opId: opId(), kind: "undo",
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
    try { if (await recoverMatch(j.matchId, deps)) done.push(j.matchId); } catch { /* conflict is marked; others retry later */ }
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
        return action === "reopen" ? reopen(fresh, note, deps, now) : confirmAndPublish(fresh, me, deps, now);
      });
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
  const built = await buildConfirmJournal(match, me, confirmations, deps, at);
  if (!built.ok) return built.error;
  const j = built.journal;
  const confirmed = j.match;
  const fx = fixtureForPublish(confirmed, at, deps, j.opId);
  if ("error" in fx) return fx.error;
  const row = (j.result as { put: StoredTournamentResult }).put;
  const next: MatchRecord = { ...confirmed, state: "published", publishedAt: at, publishedBy: me, ...(fx.fixtureLink ? { fixtureLink: fx.fixtureLink } : {}) };
  return commit({ ...j, kind: "publish", result: { put: { ...row, published: true } }, ...(fx.fixture ? { fixture: fx.fixture } : {}), match: next }, deps);
}

/** submitted -> recording directly; confirmed -> recording through the revision undo; published needs undo-revision first. */
async function reopen(match: MatchRecord, note: string | undefined, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state === "published") return err(409, "A published match must be reverted with undo-revision first.");
  if (match.state === "confirmed") return undoRevision(match, deps, now, note);
  if (match.state !== "submitted") return err(409, `This match is ${match.state}; only a submitted or confirmed match can be reopened.`);
  const { preview: _p, ...rest } = match;
  const next: MatchRecord = { ...rest, state: "recording", confirmations: {}, updatedAt: now().toISOString(), ...(note ? { note } : {}) };
  await deps.repo.updateMatch(next);
  return { status: 200, body: { match: next } };
}

// ---- Lane R1: pre-game --------------------------------------------------------------------------------------

type Phase = MatchPhase;

/**
 * POST .../pregame/advance. Runs (or accepts) the CURRENT phase and moves on. All rolls are made here, on the
 * server, and recorded as events; only the coin result can be entered by hand. Body per phase:
 *   fans, weather, journeymen, prayers: none (optional {phase} guards against a double advance)
 *   inducements: {team: "home"|"away", picks: [{id, qty}], skip?: true}
 *   coin: auto = {mode: "auto", call: "heads"|"tails", caller: "home"|"away"}; the server flips and replies with the
 *         result and winner, and the phase stays pregame:coin until the winner posts {choice: "kick"|"receive"};
 *         hand = {mode: "hand", call, caller, result, winner, choice} in one request
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
  const die = deps.rollDie ?? ((sides: number) => randomInt(1, sides + 1));
  const sides = ["home", "away"] as const;
  const out: TabletopEvent[] = [];
  const have = (id: string) => stored.some((e) => e.id === id);
  const mk = (id: string, type: TabletopEvent["type"], team: Side, payload: Record<string, unknown>): void => {
    if (!have(id)) out.push({ id, matchId: match.id, type, team, payload, ts: at, by: me });
  };
  const all = () => [...stored, ...out];
  const teams = () => overlayRosters({ home: baseTeams.home, away: baseTeams.away }, all()) as Record<Side, TabletopTeamFile>;
  const prayersBought = (side: Side): number => {
    const e = all().find((x) => x.type === "inducement" && x.team === side);
    const picks = (e?.payload.picks as Array<{ id: string; qty: number }> | undefined) ?? [];
    return picks.find((p) => p.id === "prayers_to_nuffle")?.qty ?? 0;
  };
  let next: Phase = phase;

  if (phase === "pregame:fans") {
    for (const side of sides) {
      const roll = die(3);
      mk(`pg-fans-${side}`, "fans", side, { roll, dedicatedFans: baseTeams[side]!.dedicatedFans, total: roll + baseTeams[side]!.dedicatedFans });
    }
    next = "pregame:weather";
  } else if (phase === "pregame:weather") {
    const a = die(6);
    const c2 = die(6);
    mk("pg-weather-0", "weather", "home", { pregame: true, roll: a + c2, dice: [a, c2], result: weatherFor(a + c2) });
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
    next = "pregame:inducements";
  } else if (phase === "pregame:inducements") {
    if (b.team !== "home" && b.team !== "away") return err(400, 'team must be "home" or "away".');
    const side: Side = b.team;
    if (!organiser && match[side].coach !== me) return err(403, "Each coach submits their own inducements.");
    if (all().some((e) => e.type === "inducement" && e.team === side)) return err(409, `${match[side].coach} has already submitted inducements.`);
    const picks = b.skip === true ? [] : b.picks;
    if (!Array.isArray(picks)) return err(400, "picks must be an array (or send skip: true).");
    const jm = (s: Side) => all().filter((e) => e.type === "journeyman" && e.team === s).map((e) => e.payload.player as TabletopPlayer);
    const tvHome = teamValueWithJourneymen(baseTeams.home!, jm("home"));
    const tvAway = teamValueWithJourneymen(baseTeams.away!, jm("away"));
    if (tvHome === undefined || tvAway === undefined) return err(422, "A team value is unknown, so petty cash cannot be worked out.");
    const role = tvHome === tvAway ? "equal" : (tvHome > tvAway) === (side === "home") ? "favourite" : "underdog";
    const other: Side = side === "home" ? "away" : "home";
    const otherEvent = all().find((e) => e.type === "inducement" && e.team === other);
    if (role === "underdog" && !otherEvent) return err(409, `The higher-value team (${other}) goes first: its treasury spending feeds the petty cash.`);
    const plan = planInducements({
      file: baseTeams[side]!, picks, role, tvDifference: Math.abs(tvHome - tvAway),
      favouriteSpent: role === "underdog" ? Number((otherEvent!.payload as { treasury?: number }).treasury ?? 0) : 0,
    });
    if ("error" in plan) return err(400, plan.error);
    mk(`pg-inducement-${side}`, "inducement", side, { picks: plan.picks, total: plan.total, treasury: plan.treasury, pettyCash: plan.pettyCash, skipped: plan.picks.length === 0 });
    const both = sides.every((s) => all().some((e) => e.type === "inducement" && e.team === s));
    if (both) next = prayersBought("home") + prayersBought("away") > 0 ? "pregame:prayers" : "pregame:coin";
  } else if (phase === "pregame:prayers") {
    for (const side of sides) {
      const n = prayersBought(side);
      const used = new Set<number>();
      for (let i = 1; i <= n; i += 1) {
        let roll = die(16);
        while (used.has(roll) && used.size < 16) roll = die(16); // duplicates are re-rolled
        used.add(roll);
        mk(`pg-prayer-${side}-${i}`, "prayer", side, { roll, name: PRAYERS_TO_NUFFLE[roll - 1] });
      }
    }
    next = "pregame:coin";
  } else if (phase === "pregame:coin") {
    const flip = all().find((e) => e.id === "pg-coinflip");
    const choiceGiven = b.choice !== undefined;
    if (choiceGiven && b.choice !== "kick" && b.choice !== "receive") return err(400, 'choice must be "kick" or "receive".');
    if (!flip) {
      const mode = b.mode;
      if (mode !== "auto" && mode !== "hand") return err(400, 'mode must be "auto" or "hand".');
      if (b.call !== "heads" && b.call !== "tails") return err(400, 'call must be "heads" or "tails".');
      if (b.caller !== "home" && b.caller !== "away") return err(400, 'caller must be "home" or "away".');
      const caller: Side = b.caller;
      const callerWins = (result: string) => result === b.call;
      if (mode === "auto") {
        if (choiceGiven) return err(400, "Make the call first; the winner chooses after the flip.");
        // The SERVER flips (crypto-random in production); the page animates to this result.
        const result = die(2) === 1 ? "heads" : "tails";
        const winner: Side = callerWins(result) ? caller : caller === "home" ? "away" : "home";
        mk("pg-coinflip", "coinFlip", winner, { mode, call: b.call, caller, result, winner });
        // stays at pregame:coin until the winner's choice is posted as a second advance
      } else {
        if (b.result !== "heads" && b.result !== "tails") return err(400, 'hand mode needs result: "heads" or "tails".');
        if (b.winner !== "home" && b.winner !== "away") return err(400, 'hand mode needs winner: "home" or "away".');
        if (!choiceGiven) return err(400, 'hand mode needs choice: "kick" or "receive".');
        const expected: Side = callerWins(b.result) ? caller : caller === "home" ? "away" : "home";
        if (b.winner !== expected) return err(400, `With that call and result the winner is ${expected}.`);
        mk("pg-coinflip", "coinFlip", b.winner, { mode, call: b.call, caller, result: b.result, winner: b.winner, choice: b.choice });
        next = "playing";
      }
    } else if (flip.payload.mode === "auto" && !all().some((e) => e.id === "pg-coinchoice")) {
      if (!choiceGiven) return err(400, 'The winner must choose: choice "kick" or "receive".');
      const winner = flip.team;
      if (!organiser && match[winner].coach !== me) return err(403, `${match[winner].coach} won the toss and makes the choice.`);
      mk("pg-coinchoice", "coinFlip", winner, { stage: "choice", winner, choice: b.choice });
      next = "playing";
    } else {
      return err(409, "The coin has already been flipped.");
    }
  }

  await deps.repo.appendEvents(match.id, out);
  const updated: MatchRecord = next === phase ? match : { ...match, phase: next, updatedAt: at };
  if (next !== phase) await deps.repo.updateMatch(updated);
  const events = [...stored, ...out];
  return {
    status: 200,
    body: {
      match: updated, phase: next, recorded: out.map((e) => e.id), pregame: pregameSummary(events),
      teams: overlayRosters({ home: baseTeams.home, away: baseTeams.away }, events),
      ...(phase === "pregame:inducements" && next === phase ? { waitingFor: sides.filter((s) => !events.some((e) => e.type === "inducement" && e.team === s)) } : {}),
    },
  };
}
