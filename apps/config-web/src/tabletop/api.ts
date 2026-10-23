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
import { BANNED_ACCOUNT_MESSAGE } from "../auth/access.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import {
  MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_MATCH, effectiveEvents, parseEvent, validateEvent, type Side, type TabletopEvent,
} from "./events.js";
import { applyPostMatch, tallyMatch, type PostMatchOption, type PostMatchSummary, type TabletopTeamFile } from "./postMatch.js";
import { headRevision, type CommitJournal, type MatchRecord, type TabletopRepository, type TeamChain } from "./store.js";
import { duplicatePlayerId } from "./teamFile.js";

export interface TabletopAuth { coach: string; method: string }
export interface TabletopResult { status: number; body: unknown }

export interface TabletopApiDeps {
  repo: TabletopRepository;
  results: { put(row: StoredTournamentResult): unknown; remove(gameId: string): boolean };
  /** The coach's own saved team as a team file (baseline revision), or undefined if they have no such save. */
  loadTeamFile: (coach: string, teamSaveId: string) => TabletopTeamFile | undefined;
  isBanned: (coach: string) => boolean;
  isOrganizer: (coach: string) => boolean;
  now?: () => Date;
}

export const isTabletopApiPath = (path: string): boolean => path === "/api/tabletop" || path.startsWith("/api/tabletop/");

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
    if (method !== "POST") return err(405, "Method not allowed.");
    return createMatch(me, organiser, body, deps, now);
  }
  const m = /^\/api\/tabletop\/matches\/([\w-]{1,64})(?:\/(events|submit|confirm|undo-revision))?$/.exec(path);
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
    return { status: 200, body: { match, events, effectiveEventIds: effectiveEvents(events).map((e) => e.id), teams } };
  }
  if (method !== "POST") return err(405, "Method not allowed.");

  return serial(id, async () => {
    try {
      const replayed = await recoverMatch(id, deps);
      if (replayed && (action === "confirm" || action === "undo-revision") && replayed.kind === (action === "confirm" ? "confirm" : "undo"))
        return { status: 200, body: { match: replayed.match, recovered: true } };
    } catch {
      return err(500, "An earlier commit on this match is still being completed; try again.");
    }
    const fresh = (await repo.getMatch(id))!;
    if (action === "events") return postEvents(fresh, me, body, deps, now);
    if (action === "submit") return submit(fresh, deps, now);
    if (action === "confirm") return confirm(fresh, me, organiser, deps, now);
    if (!organiser) return err(403, "Organizer access required.");
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
  return { status: 200, body: { accepted: accepted.map((e) => e.id), duplicates, total: stored.length + accepted.length } };
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
  // Bans are rechecked immediately before finalisation: both participants and the confirming caller.
  for (const coach of new Set([match.home.coach, match.away.coach, me]))
    if (deps.isBanned(coach)) return err(403, coach === me ? BANNED_ACCOUNT_MESSAGE : `${coach} is banned; the match cannot be finalised.`);
  const events = await deps.repo.readEvents(match.id);
  const p = await computePreview(match, events, deps);
  if (!p.ok) return p.error;

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
    home: { teamId: match.home.teamSaveId, teamName: match.home.teamName, coach: match.home.coach },
    away: { teamId: match.away.teamSaveId, teamName: match.away.teamName, coach: match.away.coach },
    teams: [teamResult("home", p.home.summary), teamResult("away", p.away.summary)],
  };
  const next: MatchRecord = {
    ...match, state: "confirmed", confirmations, updatedAt: at, preview: { home: p.home.summary, away: p.away.summary },
    ...(wroteRevisions ? { wroteRevisions } : {}), resultGameId: gameId,
  };
  return commit({ matchId: match.id, opId: opId(), kind: "confirm", homeChain, awayChain, result: { put: row }, match: next }, deps);
}

async function undoRevision(match: MatchRecord, deps: TabletopApiDeps, now: () => Date): Promise<TabletopResult> {
  if (match.state !== "confirmed") return err(409, "Only a confirmed match can be reverted.");
  const chainHome = await deps.repo.getChain(match.home.coach, match.home.teamSaveId);
  const chainAway = await deps.repo.getChain(match.away.coach, match.away.teamSaveId);
  if (!chainHome || !chainAway) return err(409, "Team files are missing.");
  const w = match.wroteRevisions;
  if (w && (chainHome.head !== w.home || chainAway.head !== w.away))
    return err(409, "A team has newer revisions than this match; revert those first.");
  const back = (chain: TeamChain, rev: number): TeamChain => ({ ...chain, head: chain.revisions.find((r) => r.revision === rev)!.parent! });
  const { wroteRevisions: _w, resultGameId: _r, preview: _p, ...rest } = match;
  const next: MatchRecord = { ...rest, state: "recording", confirmations: {}, updatedAt: now().toISOString() };
  return commit({
    matchId: match.id, opId: opId(), kind: "undo",
    homeChain: w ? back(chainHome, w.home) : chainHome,
    awayChain: w ? back(chainAway, w.away) : chainAway,
    result: match.resultGameId ? { remove: match.resultGameId } : null,
    match: next,
  }, deps);
}

const opId = (): string => randomBytes(8).toString("hex");

/** Apply every record of a journal (all idempotent full-state writes), then clear it. */
async function applyJournal(j: CommitJournal, deps: TabletopApiDeps): Promise<void> {
  await deps.repo.putChain(j.homeChain);
  await deps.repo.putChain(j.awayChain);
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
