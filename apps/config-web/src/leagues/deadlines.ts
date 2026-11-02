/**
 * League fixture deadlines (owner 10-29: "Fixtures can have a deadline"; spec-main-landing-nav §2.2, §4.2, ruling §6(d)).
 *
 *   PATCH /api/leagues/:id/seasons/:seasonId/deadlines
 *         { revision, rounds?: [{ phaseId, round, deadline: ISO | null }],
 *           fixtures?: [{ id, deadline?: ISO | null, decision?: "no-result" | "both-lose" | null }],
 *           policy?: { autoForfeit?: boolean, outcome?: "review" | "no-result" | "both-lose" } }
 *
 * Organisers and site admins only (anonymous 401, unknown league 404, others 403). The write names the season revision
 * as last read (body.revision or If-Match): 428 missing, 409 stale; it answers the season read model (new revision in
 * it). CSRF and the onboarding 428 gate run in front of every /api write (server.ts). Nothing here runs on a GET.
 *
 * Data: every fixture's effective deadline = its own `deadline` ?? its round's (`season.roundDeadlines`, per phase and
 * round). Stored as UTC ISO instants; pages show them in the viewer's timezone.
 *
 * Auto-forfeit (season.deadlinePolicy, OFF unless an organiser turns it on): once a fixture's effective deadline has
 * passed and it has no result, is not suspended and carries no deadline outcome, the job applies the season's outcome:
 *   - review (default): "Overdue, needs organiser decision"; no score is invented.
 *   - no-result: the fixture counts nowhere.
 *   - both-lose: a 0-0 with both sides conceded, which the standings already count as a loss for each (identity.ts).
 * The outcome is written before anyone is told, so it is applied and announced once (both coaches and the league's
 * organisers, one notification each); a restart finds it written and skips it. The job runs on a server timer, at
 * startup, and after a deadlines write; never in a GET handler. A fixture with a result or an organiser's decision is
 * never touched, and neither is one whose Super FUMBBL game is under way or still to report; a real result (fork sync
 * or the fixtures editor) always replaces an auto-applied outcome. Reopen keeps auto-forfeit off the fixture until its
 * deadline changes. An organiser who moves a deadline into the future lifts an auto-applied outcome (an extension); their
 * own decisions stay until they change them, and entering a result in the fixtures editor replaces any outcome.
 */
import type { NotificationInput } from "../notifications.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { seasonForViewer } from "./api.js";
import { addLog } from "./events.js";
import { readJsonObject, requestRevision } from "./http.js";
import { isLeagueOrganiser, leagueOwner, type LeagueStore } from "./store.js";
import type { DeadlineOutcome, DeadlinePolicy, LeagueFixture, LeagueRecord, RoundDeadline, SeasonRecord } from "./types.js";
import { publishedLeagues } from "./lifecycle.js";
import { fixtureRedraftBlock } from "./redraftWindow.js";

export const DEADLINE_OUTCOMES: readonly DeadlineOutcome[] = ["review", "no-result", "both-lose"];
/** What an organiser may decide for a fixture (review is the "not decided yet" state). */
export const DECISION_OUTCOMES: readonly DeadlineOutcome[] = ["no-result", "both-lose"];
export const DEFAULT_POLICY: DeadlinePolicy = { autoForfeit: false, outcome: "review" };
export const DEADLINES_MAX_BYTES = 256 * 1024;
const ROUND_ROWS_MAX = 500;
const FIXTURE_ROWS_MAX = 2000;
const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

export const OUTCOME_TEXT: Record<DeadlineOutcome, string> = {
  review: "it is marked overdue for an organiser to decide",
  "no-result": "it is recorded as no result",
  "both-lose": "both teams take a loss",
};

// ---- pure helpers ---------------------------------------------------------------------------------------------------

/** An ISO instant with an explicit zone (Z or ±hh:mm), years 2000-2199, as UTC ISO; undefined when it is not one. */
export function parseDeadline(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 40) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v.trim())) return undefined;
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t)) return undefined;
  const iso = new Date(t).toISOString();
  const year = Number(iso.slice(0, 4));
  return year >= 2000 && year < 2200 ? iso : undefined;
}

export const policyOf = (season: Pick<SeasonRecord, "deadlinePolicy">): DeadlinePolicy => ({ ...DEFAULT_POLICY, ...(season.deadlinePolicy ?? {}) });

export function roundDeadlineOf(season: Pick<SeasonRecord, "roundDeadlines">, phaseId: string, round: number): string | undefined {
  return season.roundDeadlines?.find((r) => r.phaseId === phaseId && r.round === round)?.deadline;
}

/** The fixture's own deadline, else its round's. */
export function effectiveDeadline(season: Pick<SeasonRecord, "roundDeadlines">, f: Pick<LeagueFixture, "deadline" | "phaseId" | "round">): string | undefined {
  return f.deadline ?? roundDeadlineOf(season, f.phaseId, f.round);
}

/** A score is recorded on either side (a real result, or a both-lose placeholder). */
const hasScore = (f: LeagueFixture): boolean => f.home.score !== null || f.away.score !== null;
/** A result the deadline logic must leave alone: any score that is not our own both-lose placeholder. */
export const hasRealResult = (f: LeagueFixture): boolean => hasScore(f) && f.deadlineOutcome?.outcome !== "both-lose";

/**
 * A Super FUMBBL game is under way for the fixture or its result is still to come: scheduled, in progress, or a game id
 * without an applied result (not cancelled, not a failed launch). Auto-forfeit waits for it.
 */
export function forkGamePending(f: Pick<LeagueFixture, "fork">): boolean {
  const fork = f.fork;
  if (!fork || fork.result) return false;
  if (fork.status === "scheduled" || fork.status === "in_progress") return true;
  return Boolean(fork.gameId) && fork.status !== "cancelled" && fork.status !== "launch_failed";
}

/** Fixtures the auto-forfeit job would act on now (policy on, active season). Pure. */
export function dueFixtures(season: SeasonRecord, now: Date, skip?: (f: LeagueFixture) => boolean): LeagueFixture[] {
  if (season.status !== "active" || !policyOf(season).autoForfeit) return [];
  const t = now.getTime();
  return season.fixtures.filter((f) => {
    if (f.deadlineOutcome || f.suspended || hasScore(f) || forkGamePending(f) || skip?.(f)) return false;
    const d = effectiveDeadline(season, f);
    // Reopened by an organiser: skipped until the fixture's deadline changes.
    if (d !== undefined && f.deadlineReopenedFor === d) return false;
    return d !== undefined && Date.parse(d) <= t;
  });
}

function setPlaceholder(f: LeagueFixture): void {
  f.home.score = 0; f.away.score = 0;
  f.home.cas = null; f.away.cas = null;
  f.home.conceded = true; f.away.conceded = true;
}
function clearPlaceholder(f: LeagueFixture): void {
  f.home.score = null; f.away.score = null;
  f.home.cas = null; f.away.cas = null;
  f.home.conceded = false; f.away.conceded = false;
}

/** Sets (or replaces) the fixture's deadline outcome; true when the standings inputs changed. */
function putOutcome(f: LeagueFixture, outcome: DeadlineOutcome, at: string, opts: { auto?: boolean; by?: string; deadline?: string }): boolean {
  const wasPlaceholder = f.deadlineOutcome?.outcome === "both-lose";
  f.deadlineOutcome = { outcome, ...(opts.auto ? { auto: true as const } : {}), ...(opts.by ? { by: opts.by } : {}), at, ...(opts.deadline ? { deadline: opts.deadline } : {}) };
  if (outcome === "both-lose" && !wasPlaceholder) { setPlaceholder(f); return true; }
  if (outcome !== "both-lose" && wasPlaceholder) { clearPlaceholder(f); return true; }
  return false;
}
/** Removes the fixture's deadline outcome (and a both-lose placeholder); true when the standings inputs changed. */
function dropOutcome(f: LeagueFixture): boolean {
  const wasPlaceholder = f.deadlineOutcome?.outcome === "both-lose";
  delete f.deadlineOutcome;
  if (wasPlaceholder) { clearPlaceholder(f); return true; }
  return false;
}

const matchText = (f: LeagueFixture): string => `${f.home.team} vs ${f.away.team}`;
const fixtureLink = (leagueId: string, seasonId: string, fixtureId: string): string =>
  `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}&tab=fixtures&fixture=${encodeURIComponent(fixtureId)}`;

/** The coach accounts on the fixture (an organiser-cleared team assignment means none) plus the league's organisers, once each. */
export function deadlineRecipients(league: LeagueRecord, season: SeasonRecord, f: LeagueFixture): string[] {
  const out = new Map<string, string>();
  const add = (c: string | undefined) => { const k = (c ?? "").trim().toLowerCase(); if (k && !out.has(k)) out.set(k, c!.trim()); };
  for (const side of [f.home, f.away]) {
    const team = side.teamId ? season.teams.find((t) => t.id === side.teamId) : undefined;
    if (team?.coachAssigned?.cleared) continue;
    add(side.coachId ?? team?.coachId);
  }
  add(leagueOwner(league));
  for (const o of league.organisers) add(o);
  return [...out.values()];
}

/**
 * Applies the season's auto-forfeit outcome to every due fixture IN PLACE (no write). Returns the fixtures it marked.
 * Callers write the season before notifying (applied once; a restart sees the outcome and skips the fixture).
 */
export function applyDue(season: SeasonRecord, now: Date, skip?: (f: LeagueFixture) => boolean): LeagueFixture[] {
  const due = dueFixtures(season, now, skip);
  if (!due.length) return [];
  const { outcome } = policyOf(season);
  const at = now.toISOString();
  let standings = false;
  for (const f of due) {
    const deadline = effectiveDeadline(season, f);
    if (putOutcome(f, outcome, at, { auto: true, deadline })) standings = true;
    addLog(season, { at, by: "Auto-forfeit", kind: "fixture-deadline", fixtureId: f.id, text: `${matchText(f)} passed its deadline unplayed: ${OUTCOME_TEXT[outcome]}.` });
  }
  if (standings) season.resultsChangedAt = at;
  return due;
}

function notifyApplied(notify: ((coach: string, input: NotificationInput) => void) | undefined, league: LeagueRecord, season: SeasonRecord, fixtures: LeagueFixture[]): void {
  if (!notify) return;
  for (const f of fixtures) {
    const outcome = f.deadlineOutcome?.outcome ?? "review";
    const round = f.round ? `, Round ${f.round}` : "";
    const input: NotificationInput = {
      type: "league-broadcast",
      title: "Fixture deadline passed",
      body: `${matchText(f)} (${league.name}${round}) was not played by its deadline: ${OUTCOME_TEXT[outcome]}.`,
      link: fixtureLink(league.id, season.id, f.id),
      from: "",
    };
    for (const coach of deadlineRecipients(league, season, f)) { try { notify(coach, input); } catch { /* fire-and-forget */ } }
  }
}

/** Active seasons with auto-forfeit on; rebuilt only after a write through the store (version()) or WATCH_TTL_MS. */
export const WATCH_TTL_MS = 10 * 60_000;
interface WatchIndex { version: number; at: number; seasons: Array<{ leagueId: string; seasonId: string }> }
const watchIndexes = new WeakMap<LeagueStore, WatchIndex>();
export function watchedSeasons(store: LeagueStore, now = Date.now()): Array<{ leagueId: string; seasonId: string }> {
  const hit = watchIndexes.get(store);
  if (hit && hit.version === store.version() && now - hit.at < WATCH_TTL_MS) return hit.seasons;
  const seasons: WatchIndex["seasons"] = [];
  for (const league of publishedLeagues(store.list())) // lane L5: no auto-forfeit (or its notices) while a draft
    for (const s of store.seasons(league.id)) if (s.status === "active" && policyOf(s).autoForfeit) seasons.push({ leagueId: league.id, seasonId: s.id });
  watchIndexes.set(store, { version: store.version(), at: now, seasons });
  return seasons;
}

export interface DeadlineJobDeps {
  store: LeagueStore;
  notify?: (coach: string, input: NotificationInput) => void;
  now?: () => Date;
}

export interface DeadlineJobOutcome { applied: Array<{ leagueId: string; seasonId: string; fixtureId: string; outcome: DeadlineOutcome }> }

/**
 * The auto-forfeit job: every active season whose organiser turned auto-forfeit on. Synchronous from each season's read
 * to its write, so nothing in this process interleaves; the outcome is stored before the notifications go out.
 */
export function runDeadlineJob(deps: DeadlineJobDeps): DeadlineJobOutcome {
  const now = deps.now?.() ?? new Date();
  const out: DeadlineJobOutcome = { applied: [] };
  const watched = watchedSeasons(deps.store, now.getTime());
  if (!watched.length) return out;
  for (const { leagueId, seasonId } of watched) {
    const league = deps.store.league(leagueId);
    if (!league) continue;
    const season = deps.store.season(league.id, seasonId);
    // A team in an open redraft window (or still needing its redraft) takes no deadline outcome until it may play again.
    const all = deps.store.seasons(league.id);
    const skip = (f: LeagueFixture): boolean => Boolean(fixtureRedraftBlock(all, f, now));
    if (!season || !dueFixtures(season, now, skip).length) continue;
    const marked = applyDue(season, now, skip);
    if (!marked.length) continue;
    try { deps.store.putSeason(season); } catch { continue; }
    notifyApplied(deps.notify, league, season, marked);
    for (const f of marked) out.applied.push({ leagueId: league.id, seasonId: season.id, fixtureId: f.id, outcome: f.deadlineOutcome!.outcome });
  }
  return out;
}

// ---- organiser write ------------------------------------------------------------------------------------------------

function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach)) return fail(403, "This league is not one of yours: only its organisers and site admins can set its deadlines.");
  return undefined;
}

class InputError extends Error { constructor(message: string, readonly field: string) { super(message); } }

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** null clears; undefined when absent; throws on anything else that is not an ISO instant with a zone. */
function deadlineField(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const iso = parseDeadline(v);
  if (!iso) throw new InputError("A deadline must be a date and time with a timezone (ISO 8601), or null to clear it.", field);
  return iso;
}

interface ParsedInput {
  rounds: Array<{ phaseId: string; round: number; deadline: string | null }>;
  fixtures: Array<{ id: string; deadline?: string | null; decision?: DeadlineOutcome | null }>;
  policy?: { autoForfeit?: boolean; outcome?: DeadlineOutcome };
}

function parseInput(input: Record<string, unknown>, season: SeasonRecord): ParsedInput {
  const out: ParsedInput = { rounds: [], fixtures: [] };
  const phaseIds = new Set([...season.phases.map((p) => p.id), ...season.fixtures.map((f) => f.phaseId)]);
  if (input.rounds !== undefined) {
    if (!Array.isArray(input.rounds) || input.rounds.length > ROUND_ROWS_MAX) throw new InputError("rounds must be a list of { phaseId, round, deadline }.", "rounds");
    input.rounds.forEach((raw, i) => {
      const f = `rounds[${i}]`;
      if (!isObj(raw)) throw new InputError(`${f} must be an object.`, f);
      if (typeof raw.phaseId !== "string" || !phaseIds.has(raw.phaseId)) throw new InputError(`${f}: pick a phase of this season.`, `${f}.phaseId`);
      if (typeof raw.round !== "number" || !Number.isInteger(raw.round) || raw.round < 0 || raw.round > 999) throw new InputError(`${f}: round must be a whole number.`, `${f}.round`);
      if (raw.deadline === undefined) throw new InputError(`${f}: send a deadline, or null to clear it.`, `${f}.deadline`);
      out.rounds.push({ phaseId: raw.phaseId, round: raw.round, deadline: deadlineField(raw.deadline, `${f}.deadline`) as string | null });
    });
  }
  if (input.fixtures !== undefined) {
    if (!Array.isArray(input.fixtures) || input.fixtures.length > FIXTURE_ROWS_MAX) throw new InputError("fixtures must be a list of { id, deadline?, decision? }.", "fixtures");
    input.fixtures.forEach((raw, i) => {
      const f = `fixtures[${i}]`;
      if (!isObj(raw)) throw new InputError(`${f} must be an object.`, f);
      if (typeof raw.id !== "string" || !season.fixtures.some((x) => x.id === raw.id)) throw new InputError(`${f}: fixture not found in this season.`, `${f}.id`);
      const row: ParsedInput["fixtures"][number] = { id: raw.id };
      const d = deadlineField(raw.deadline, `${f}.deadline`);
      if (d !== undefined) row.deadline = d;
      if (raw.decision !== undefined) {
        if (raw.decision !== null && !(DECISION_OUTCOMES as readonly unknown[]).includes(raw.decision)) throw new InputError(`${f}: decision must be "no-result", "both-lose" or null.`, `${f}.decision`);
        row.decision = raw.decision as DeadlineOutcome | null;
      }
      if (row.deadline === undefined && row.decision === undefined) throw new InputError(`${f}: send a deadline or a decision.`, f);
      out.fixtures.push(row);
    });
  }
  if (input.policy !== undefined) {
    if (!isObj(input.policy)) throw new InputError("policy must be an object.", "policy");
    const p: NonNullable<ParsedInput["policy"]> = {};
    if (input.policy.autoForfeit !== undefined) {
      if (typeof input.policy.autoForfeit !== "boolean") throw new InputError("policy.autoForfeit must be true or false.", "policy.autoForfeit");
      p.autoForfeit = input.policy.autoForfeit;
    }
    if (input.policy.outcome !== undefined) {
      if (!(DEADLINE_OUTCOMES as readonly unknown[]).includes(input.policy.outcome)) throw new InputError('policy.outcome must be "review", "no-result" or "both-lose".', "policy.outcome");
      p.outcome = input.policy.outcome as DeadlineOutcome;
    }
    out.policy = p;
  }
  if (!out.rounds.length && !out.fixtures.length && !out.policy) throw new InputError("Nothing to change: send rounds, fixtures or policy.", "");
  return out;
}

/** Applies a parsed write to the season in place; true when the standings inputs changed. Throws InputError on a refused decision. */
function applyInput(season: SeasonRecord, input: ParsedInput, who: string, now: Date): boolean {
  const at = now.toISOString();
  let standings = false;
  // Decisions first refuse fixtures with a real result (nothing is written on a refusal: checked before any change).
  for (const row of input.fixtures) {
    const f = season.fixtures.find((x) => x.id === row.id)!;
    if (row.decision !== undefined && hasRealResult(f)) throw new InputError(`${matchText(f)} has a result: clear it in the fixtures editor first.`, "decision");
  }
  const list: RoundDeadline[] = [...(season.roundDeadlines ?? [])];
  for (const r of input.rounds) {
    const i = list.findIndex((x) => x.phaseId === r.phaseId && x.round === r.round);
    if (r.deadline === null) { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) list[i] = { phaseId: r.phaseId, round: r.round, deadline: r.deadline };
    else list.push({ phaseId: r.phaseId, round: r.round, deadline: r.deadline });
  }
  if (input.rounds.length) {
    list.sort((a, b) => a.phaseId.localeCompare(b.phaseId) || a.round - b.round);
    if (list.length) season.roundDeadlines = list; else delete season.roundDeadlines;
  }
  for (const row of input.fixtures) {
    const f = season.fixtures.find((x) => x.id === row.id)!;
    if (row.deadline !== undefined) { if (row.deadline === null) delete f.deadline; else f.deadline = row.deadline; }
    if (row.decision === null) {
      if (f.deadlineOutcome && dropOutcome(f)) standings = true;
      // Reopen: auto-forfeit leaves the fixture alone until its deadline changes (no re-apply, no re-notify).
      const d = effectiveDeadline(season, f);
      if (d !== undefined && Date.parse(d) <= now.getTime()) f.deadlineReopenedFor = d; else delete f.deadlineReopenedFor;
    } else if (row.decision) { delete f.deadlineReopenedFor; if (putOutcome(f, row.decision, at, { by: who, deadline: effectiveDeadline(season, f) })) standings = true; }
  }
  // A reopen marker for a deadline that is no longer the fixture's is spent.
  for (const f of season.fixtures) if (f.deadlineReopenedFor !== undefined && f.deadlineReopenedFor !== effectiveDeadline(season, f)) delete f.deadlineReopenedFor;
  // An extension: an auto-applied outcome whose fixture's deadline is now in the future is lifted.
  for (const f of season.fixtures) {
    if (!f.deadlineOutcome?.auto) continue;
    const d = effectiveDeadline(season, f);
    if (d !== undefined && Date.parse(d) > now.getTime()) { if (dropOutcome(f)) standings = true; }
  }
  if (input.policy) {
    const next = { ...policyOf(season), ...input.policy };
    season.deadlinePolicy = { autoForfeit: next.autoForfeit, outcome: next.outcome, updatedBy: who, updatedAt: at };
  }
  if (standings) season.resultsChangedAt = at;
  return standings;
}

/** PATCH /api/leagues/:id/seasons/:seasonId/deadlines; undefined when the path is not this route. */
export async function leagueDeadlineRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, what, ...more] = rest;
  if (first !== "seasons" || !seasonId || what !== "deadlines" || more.length) return undefined;
  if (method !== "PATCH") return fail(405, "Use PATCH.");
  const early = gate(league, auth);
  if (early) return early;
  const body = await readJsonObject(deps, DEADLINES_MAX_BYTES);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  // Judged against the league as it is now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const who = auth!;
  const current = season.revision ?? 0;
  const asked = requestRevision(body.value, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the season revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "This season changed since you opened it. Reload to see the latest.", { revision: current });
  if (season.status !== "active") return fail(409, `${season.name} is finished: its deadlines can no longer change.`);
  const now = deps.now?.() ?? new Date();
  let marked: LeagueFixture[];
  try {
    applyInput(season, parseInput(body.value, season), who.coach, now);
    // A deadline already in the past with auto-forfeit on is applied in the same write (and announced once, below).
    marked = applyDue(season, now);
  } catch (e) {
    if (e instanceof InputError) return fail(400, e.message, e.field ? { field: e.field } : {});
    throw e;
  }
  try { deps.store.putSeason(season); } catch { return fail(500, "Could not save the deadlines right now."); }
  const saved = deps.store.season(lg.id, season.id) ?? season;
  notifyApplied(deps.notify, lg, saved, marked.map((m) => saved.fixtures.find((f) => f.id === m.id) ?? m));
  return res(200, { ok: true, revision: saved.revision ?? 0, season: seasonForViewer(lg, saved, who) });
}

// ---- coach-facing reads (derived, no writes) ------------------------------------------------------------------------

/** A fixture that is still open as far as deadlines go: no real result, not suspended, not decided as no result / both lose. */
export function fixtureOpenForDeadline(f: LeagueFixture): boolean {
  if (f.suspended || hasScore(f)) return false;
  return !f.deadlineOutcome || f.deadlineOutcome.outcome === "review";
}
