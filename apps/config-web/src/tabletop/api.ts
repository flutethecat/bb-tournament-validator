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

import { randomBytes } from "node:crypto";
import { nafTimestamp } from "../tournaments/nafExport.js";
import { BANNED_ACCOUNT_MESSAGE } from "../auth/access.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import {
  MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_MATCH, effectiveEvents, parseEvent, validateEvent, type Side, type TabletopEvent,
} from "./events.js";
import { leagueStandings, type LeaguePoints } from "./standings.js";
import { applyPostMatch, tallyMatch, type PostMatchOption, type PostMatchSummary, type TabletopTeamFile } from "./postMatch.js";
import { headRevision, type CommitJournal, type MatchRecord, type TabletopRepository, type TeamChain } from "./store.js";
import { duplicatePlayerId } from "./teamFile.js";

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
  home: { coach: string };
  away: { coach: string };
  resultReportedAt?: string;
}

/** The tournaments store seen through the single existing result path (TournamentStore.recordResult). */
export interface FixtureGateway {
  get(id: string): FixtureView | undefined;
  record(id: string, input: { expectedRevision: number; homeScore: number; awayScore: number; homeCasualties: number; awayCasualties: number }, at: Date): void;
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
  if (path === "/api/standings") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const league = query.get("league")?.trim() ?? "";
    if (!league || league.length > 60) return err(400, "league is required.");
    const rows = leagueStandings(deps.results.list(), league, deps.forkMetadata ?? (() => undefined), deps.pointsFor?.(league));
    return { status: 200, body: { league, rows } };
  }
  if (path === "/api/tabletop/saves") {
    if (method !== "GET") return err(405, "Method not allowed.");
    const coach = query.get("coach")?.trim() ?? "";
    if (!coach || coach.length > 60) return err(400, "coach is required.");
    const saves = (deps.listSaves?.(coach) ?? []).map((s) => ({ id: s.id, name: s.name }));
    return { status: 200, body: { coach, saves } };
  }
  const m = /^\/api\/tabletop\/matches\/([\w-]{1,64})(?:\/(events|submit|confirm|publish|undo-revision))?$/.exec(path);
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
    const teams = await currentTeams(repo, match);
    return { status: 200, body: { match, events, effectiveEventIds: effectiveEvents(events).map((e) => e.id), teams, tally: tallyView(events, teams) } };
  }
  if (method !== "POST") return err(405, "Method not allowed.");

  return serial(id, async () => {
    try {
      const replayed = await recoverMatch(id, deps);
      if (replayed && (action === "confirm" || action === "publish" || action === "undo-revision") && replayed.kind === (action === "confirm" ? "confirm" : action === "publish" ? "publish" : "undo"))
        return { status: 200, body: { match: replayed.match, recovered: true } };
    } catch {
      return err(500, "An earlier commit on this match is still being completed; try again.");
    }
    const fresh = (await repo.getMatch(id))!;
    if (action === "events") return postEvents(fresh, me, body, deps, now);
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
        id: m.id, state: m.state, pendingOrganiser: m.state === "confirmed", ...(m.fixtureRef ? { fixtureRef: m.fixtureRef } : {}), postMatch: m.postMatch,
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

async function createMatch(me: string, organiser: boolean, body: unknown, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  const side = (v: any): { coach: string; teamSaveId: string } | undefined =>
    v && typeof v.coach === "string" && v.coach.trim() && typeof v.teamSaveId === "string" && /^[\w-]{1,64}$/.test(v.teamSaveId)
      ? { coach: v.coach.trim(), teamSaveId: v.teamSaveId } : undefined;
  const home = side(b.home);
  const away = side(b.away);
  if (!home || !away) return err(400, "home and away each need {coach, teamSaveId}.");
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
  if (!chainHome) return err(404, `${home.coach} has no saved team ${home.teamSaveId}.`);
  if (!chainAway) return err(404, `${away.coach} has no saved team ${away.teamSaveId}.`);
  for (const s of [home, away])
    if (await deps.repo.findOpenMatchForSave(s.coach, s.teamSaveId)) return err(409, `${s.coach}'s team is already in an unfinished recorded match.`);
  const match: MatchRecord = {
    id: `tm_${randomBytes(9).toString("hex")}`,
    state: "recording",
    ...(b.fixtureRef ? { fixtureRef: b.fixtureRef } : {}),
    home: { ...home, teamName: headRevision(chainHome).teamFile.name },
    away: { ...away, teamName: headRevision(chainAway).teamFile.name },
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
  const raw = (body as { events?: unknown } | undefined)?.events;
  if (!Array.isArray(raw) || raw.length === 0) return err(400, "events must be a non-empty array.");
  if (raw.length > MAX_EVENTS_PER_BATCH) return err(400, `At most ${MAX_EVENTS_PER_BATCH} events per request.`);
  const stored = await deps.repo.readEvents(match.id);
  const teams = await currentTeams(deps.repo, match);
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
  return { status: 200, body: { accepted: accepted.map((e) => e.id), duplicates, total: stored.length + accepted.length, tally: tallyView(running, teams) } };
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
    conceded: false,
    casualtiesSuffered: tally.casualtiesSuffered[side],
    players: [...tally.lines[side].values()].map((l) => ({
      playerId: l.id, name: l.name, touchdowns: l.touchdowns, casualtiesCaused: l.casualtiesCaused, blocks: 0, fouls: 0,
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
  return { ok: true, journal: { matchId: match.id, opId: opId(), kind: "confirm", homeChain, awayChain, result: { put: row }, match: next } };
}

async function undoRevision(match: MatchRecord, deps: TabletopApiDeps, now: () => Date, note?: string): Promise<TabletopResult> {
  if (match.state !== "confirmed" && match.state !== "published") return err(409, "Only a confirmed or published match can be reverted.");
  const chainHome = await deps.repo.getChain(match.home.coach, match.home.teamSaveId);
  const chainAway = await deps.repo.getChain(match.away.coach, match.away.teamSaveId);
  if (!chainHome || !chainAway) return err(409, "Team files are missing.");
  const w = match.wroteRevisions;
  if (w && (chainHome.head !== w.home || chainAway.head !== w.away))
    return err(409, "A team has newer revisions than this match; revert those first.");
  const link = match.state === "published" ? match.fixtureLink : undefined;
  if (link) {
    const f = deps.fixtures?.get(link.id);
    if (!f || f.resultReportedAt !== link.reportedAt || f.revision !== link.expectedRevision + 1)
      return err(409, "The fixture changed since this result was published; resolve it in the tournament first.");
  }
  const back = (chain: TeamChain, rev: number): TeamChain => ({ ...chain, head: chain.revisions.find((r) => r.revision === rev)!.parent! });
  const { wroteRevisions: _w, resultGameId: _r, preview: _p, fixtureLink: _fl, publishedAt: _pa, publishedBy: _pb, ...rest } = match;
  const next: MatchRecord = { ...rest, state: "recording", confirmations: {}, updatedAt: now().toISOString(), ...(note ? { note } : {}) };
  return commit({
    matchId: match.id, opId: opId(), kind: "undo",
    homeChain: w ? back(chainHome, w.home) : chainHome,
    awayChain: w ? back(chainAway, w.away) : chainAway,
    result: match.resultGameId ? { remove: match.resultGameId } : null,
    ...(link ? { fixture: { op: "retract" as const, id: link.id, expectedRevision: link.expectedRevision + 1, status: link.priorStatus, at: next.updatedAt } } : {}),
    match: next,
  }, deps);
}

async function publish(match: MatchRecord, me: string, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state !== "confirmed") return err(409, `This match is ${match.state}; only a confirmed match can be published.`);
  const at = now().toISOString();
  const chainHome = await deps.repo.getChain(match.home.coach, match.home.teamSaveId);
  const chainAway = await deps.repo.getChain(match.away.coach, match.away.teamSaveId);
  const stored = match.resultGameId ? deps.results.get(match.resultGameId) : undefined;
  if (!chainHome || !chainAway || !stored || !match.preview) return err(409, "The match's confirmed result is missing.");
  const fx = fixtureForPublish(match, at, deps);
  if ("error" in fx) return fx.error;
  const { fixture, fixtureLink } = fx;
  const next: MatchRecord = { ...match, state: "published", publishedAt: at, publishedBy: me, updatedAt: at, ...(fixtureLink ? { fixtureLink } : {}) };
  return commit({
    matchId: match.id, opId: opId(), kind: "publish", homeChain: chainHome, awayChain: chainAway,
    result: { put: { ...stored, published: true } }, ...(fixture ? { fixture } : {}), match: next,
  }, deps);
}

/** The fixture record op for publishing `match` (preview must exist), or a 409. */
function fixtureForPublish(match: MatchRecord, at: string, deps: TabletopApiDeps):
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
      op: "record", id: match.fixtureRef, expectedRevision: f.revision, at,
      homeScore: h.score.for, awayScore: a.score.for, homeCasualties: cas(h), awayCasualties: cas(a),
    };
    fixtureLink = { id: match.fixtureRef, priorStatus: f.status, expectedRevision: f.revision, reportedAt: at, swapped };
  }
  return { fixture, fixtureLink };
}

const opId = (): string => randomBytes(8).toString("hex");

/** Apply every record of a journal (all idempotent full-state writes), then clear it. */
async function applyJournal(j: CommitJournal, deps: TabletopApiDeps): Promise<void> {
  await deps.repo.putChain(j.homeChain);
  await deps.repo.putChain(j.awayChain);
  if (j.fixture) {
    const gateway = deps.fixtures;
    if (!gateway) throw new Error("no fixture gateway");
    const f = gateway.get(j.fixture.id);
    if (j.fixture.op === "record") {
      const { op: _op, id, at, ...input } = j.fixture;
      if (f && f.revision === input.expectedRevision) gateway.record(id, input, new Date(at));
      else if (!(f && f.revision > input.expectedRevision && f.resultReportedAt)) throw new Error("fixture changed during commit");
    } else if (f?.resultReportedAt) {
      gateway.retract(j.fixture.id, { expectedRevision: j.fixture.expectedRevision, status: j.fixture.status }, new Date(j.fixture.at));
    }
  }
  if (j.result && "put" in j.result) deps.results.put(j.result.put);
  else if (j.result) deps.results.remove(j.result.remove);
  await deps.repo.updateMatch(j.match);
  await deps.repo.clearJournal(j.matchId);
}

/** Journal first, then apply. A failure part-way leaves the journal for replay; a retry completes it (never a 409). */
async function commit(j: CommitJournal, deps: TabletopApiDeps): Promise<TabletopResult> {
  try {
    await deps.repo.putJournal(j);
    await applyJournal(j, deps);
  } catch {
    return err(500, "The commit was recorded but not fully applied; it will be completed when you retry.");
  }
  return { status: 200, body: { match: j.match } };
}

/** Replay an unfinished journal for one match to completion (undefined when none). */
export async function recoverMatch(matchId: string, deps: TabletopApiDeps): Promise<CommitJournal | undefined> {
  const j = await deps.repo.getJournal(matchId);
  if (!j) return undefined;
  await applyJournal(j, deps);
  return j;
}

/** Startup recovery: replay every unfinished journal. Returns the match ids completed. */
export async function recoverTabletop(deps: TabletopApiDeps): Promise<string[]> {
  const done: string[] = [];
  for (const id of await deps.repo.listJournalMatchIds()) {
    try { if (await recoverMatch(id, deps)) done.push(id); } catch { /* left for the next attempt */ }
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
        } catch {
          return err(500, "An earlier commit on this match is still being completed; try again.");
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
  const fx = fixtureForPublish(confirmed, at, deps);
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
