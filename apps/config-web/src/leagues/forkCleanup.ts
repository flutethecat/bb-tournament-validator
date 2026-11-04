/**
 * Removes a league fixture's fork team copies once the match is over (owner 11-03: "League manager teams that are used
 * for a match should be deleted at the end."). The rules of when live in forkCleanupRules.ts; the fork IO is the fork
 * client's removeTeams (forkClient.ts: the install's locks, the live-game check, files, library rows, reload).
 *
 *   marker   forkPlay.ts writes fork.cleanup "pending" in the same store write that banks the result (or cancels play).
 *            Nothing touches the fork in that write, so a failed removal can never hold up banking.
 *   scan     results from every other writer (hand entry, forfeit, deadline outcome, recorder publish) set no marker,
 *            so the tick also marks any fixture whose copies are no longer needed and that has no marker yet. The first
 *            scan on a server records the fixtures that were already in that state (the baseline file): those predate
 *            this and are left to the backfill, so deploying never sweeps old fixtures by itself.
 *   runner   runForkTeamCleanup, on the server's sync tick (after the result sync) and once shortly after start-up:
 *            every pending marker, and every failed one whose backoff has passed (2 min doubling to 6 h), is tried under
 *            the fixture's fork lock and its teams' locks. A restart resumes from the marker; every step is idempotent.
 *   shared   a fork team id another fixture still needs (any fixture whose copies are not finished with) is never
 *            removed: it is recorded as kept, and the tick removes it once no fixture needs it any more. When an id is
 *            removed, every fixture of the season that recorded it loses its build fingerprint, so a later generate
 *            rebuilds the team instead of trusting a copy that is gone.
 *   backfill forkTeamBackfill: the baseline fixtures (and anything stuck) whose copies are still installed. Listed by
 *            scripts/fork-team-cleanup.ts (read-only) and by POST /api/admin/league-fork-cleanup; removed only through
 *            that admin route with { apply: true }, inside the running server (its store and fork locks), or by the
 *            script's --apply while the server is stopped.
 *
 * Logs: the server log gets one line per removal or failure (league / season / fixture ids and fork team ids only), the
 * fixture's fork history gets the removal, the first failure and what was kept.
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { fixtureLockKey, withForkLocks, type LeagueForkClient } from "./forkPlay.js";
import { cleanupBackoffMs, cleanupDue, fixtureForkCopies, forkCleanupReason, markForkCleanup } from "./forkCleanupRules.js";
import type { LeagueStore } from "./store.js";
import type { LeagueFixture, SeasonRecord } from "./types.js";

export interface ForkCleanupDeps {
  store: LeagueStore;
  fork: LeagueForkClient;
  now?: () => Date;
  /** Server log line (default console.log / console.error). */
  log?: (line: string, error?: boolean) => void;
  /**
   * The scan's baseline (<FORK_STATE_DIR>/league-fork-cleanup-baseline.json on the server): fixtures already finished
   * with their copies, unmarked, at the first scan. Absent = every unmarked fixture is scanned (tests).
   */
  baselineFile?: string;
}

export interface FixtureRef { leagueId: string; seasonId: string; fixtureId: string }

export type CleanupOutcome =
  | { kind: "removed"; removed: string[]; kept: string[] }
  | { kind: "failed"; error: string; attempts: number }
  | { kind: "skipped"; why: string };

const BY = "Super FUMBBL";
const refText = (r: FixtureRef): string => `${r.leagueId}/${r.seasonId}/${r.fixtureId}`;

function writeLog(deps: Pick<ForkCleanupDeps, "log">, line: string, error = false): void {
  try {
    if (deps.log) deps.log(line, error);
    else if (error) console.error(line);
    else console.log(line);
  } catch { /* logging never fails a cleanup */ }
}

function forkLog(f: LeagueFixture, at: Date, text: string): void {
  if (!f.fork) return;
  f.fork.log.push({ at: at.toISOString(), by: BY, text });
  if (f.fork.log.length > 100) f.fork.log.splice(0, f.fork.log.length - 100);
}

/** Re-reads the season and changes this fixture in one synchronous write. */
function save(store: LeagueStore, r: FixtureRef, mutate: (f: LeagueFixture) => void): LeagueFixture | undefined {
  const season = store.season(r.leagueId, r.seasonId);
  const f = season?.fixtures.find((x) => x.id === r.fixtureId);
  if (!season || !f) return undefined;
  mutate(f);
  store.putSeason(season);
  return f;
}

/** Re-reads the season and changes it (this fixture and any other) in one synchronous write. */
function saveSeason(store: LeagueStore, r: FixtureRef, mutate: (f: LeagueFixture, season: SeasonRecord) => void): LeagueFixture | undefined {
  const season = store.season(r.leagueId, r.seasonId);
  const f = season?.fixtures.find((x) => x.id === r.fixtureId);
  if (!season || !f) return undefined;
  mutate(f, season);
  store.putSeason(season);
  return f;
}

/** Fork team ids other fixtures of the season still need (their copies are not finished with). */
function neededElsewhere(season: SeasonRecord, fixtureId: string): Set<string> {
  const ids = new Set<string>();
  for (const o of season.fixtures) {
    if (o.id === fixtureId || forkCleanupReason(o)) continue;
    for (const c of fixtureForkCopies(o)) ids.add(c.forkTeamId);
  }
  return ids;
}

const teamNames = (f: LeagueFixture, ids: string[]): string =>
  fixtureForkCopies(f).filter((c) => ids.includes(c.forkTeamId)).map((c) => f[c.side].team).join(" and ");

/**
 * One fixture's removal, under its fork lock and its teams' locks. `force` ignores the backoff (the backfill's apply).
 * A fixture without a marker, already removed, or whose copies are needed again is skipped.
 */
export async function cleanupFixtureForkTeams(deps: ForkCleanupDeps, r: FixtureRef, opts: { force?: boolean } = {}): Promise<CleanupOutcome> {
  const first = deps.store.season(r.leagueId, r.seasonId)?.fixtures.find((x) => x.id === r.fixtureId);
  if (!first) return { kind: "skipped", why: "fixture not found" };
  const lockIds = fixtureForkCopies(first).map((c) => c.forkTeamId);
  return withForkLocks([fixtureLockKey(r.leagueId, r.seasonId, r.fixtureId)], lockIds, async (): Promise<CleanupOutcome> => {
    const now = deps.now?.() ?? new Date();
    const season = deps.store.season(r.leagueId, r.seasonId);
    const f = season?.fixtures.find((x) => x.id === r.fixtureId);
    if (!season || !f?.fork?.cleanup) return { kind: "skipped", why: "no cleanup marker" };
    if (f.fork.cleanup.state === "removed") return { kind: "skipped", why: "already removed" };
    if (!forkCleanupReason(f)) return { kind: "skipped", why: "the copies are needed again" };
    if (!opts.force && !cleanupDue(f, now)) return { kind: "skipped", why: "waiting for the retry time" };
    const copies = fixtureForkCopies(f);
    const needed = neededElsewhere(season, f.id);
    const remove = copies.filter((c) => !needed.has(c.forkTeamId));
    const kept = [...new Set(copies.filter((c) => needed.has(c.forkTeamId)).map((c) => c.forkTeamId))];
    // A kept id may carry the reload-required marker of an earlier failed removal (it was not needed then). Its copy
    // may be half gone, so: drop the marker, and every fixture that recorded it forgets its fingerprint, so the fixture
    // that needs it now rebuilds and reinstalls it on its next generate (instead of being refused forever).
    const stuck = kept.filter((id) => deps.fork.teamCopies?.([id]).get(id)?.pendingReload);
    if (stuck.length) {
      try {
        deps.fork.releaseRemoval?.(stuck);
      } catch (e) {
        writeLog(deps, `[leagues] Super FUMBBL team copy marker release failed for ${refText(r)}: ${(e as Error).message}`, true);
      }
      saveSeason(deps.store, r, (_x, s) => {
        for (const o of s.fixtures) for (const c of fixtureForkCopies(o)) if (stuck.includes(c.forkTeamId)) delete o.fork!.teams[c.side]!.revision;
      });
      writeLog(deps, `[leagues] Super FUMBBL team copies needed again, marked for a rebuild: ${stuck.join(", ")}`);
    }
    if (remove.length) {
      let error: string | undefined;
      if (!deps.fork.removeTeams) error = "this server's fork client cannot remove teams";
      else {
        try { await deps.fork.removeTeams(remove.map(({ forkTeamId, coach }) => ({ forkTeamId, coach }))); } catch (e) {
          error = e instanceof Error && e.message ? e.message : "the fork did not remove the teams";
        }
      }
      if (error) {
        let attempts = 0;
        save(deps.store, r, (x) => {
          const c = x.fork?.cleanup;
          if (!c) return;
          c.attempts += 1;
          attempts = c.attempts;
          c.state = "failed";
          c.error = error.slice(0, 300);
          c.lastAttemptAt = now.toISOString();
          c.nextAttemptAt = new Date(now.getTime() + cleanupBackoffMs(c.attempts)).toISOString();
          if (c.attempts === 1) forkLog(x, now, `Could not remove the Super FUMBBL team copies yet (${c.error}). Retrying automatically.`);
        });
        writeLog(deps, `[leagues] Super FUMBBL team copy removal failed for ${refText(r)} (attempt ${attempts}): ${error}`, true);
        return { kind: "failed", error, attempts };
      }
    }
    const removed = [...new Set(remove.map((c) => c.forkTeamId))];
    saveSeason(deps.store, r, (x, s) => {
      // Every fixture that recorded a removed copy (this one and finished ones sharing it) forgets its fingerprint, so a
      // generate after a cancel is undone (or after an organiser reopens it) rebuilds instead of reusing a missing copy.
      for (const o of s.fixtures) for (const c of fixtureForkCopies(o)) if (removed.includes(c.forkTeamId)) delete o.fork!.teams[c.side]!.revision;
      const c = x.fork?.cleanup;
      if (!c) return;
      c.state = "removed";
      c.removedAt = now.toISOString();
      c.lastAttemptAt = now.toISOString();
      c.removed = removed;
      if (kept.length) c.kept = kept; else delete c.kept;
      delete c.error;
      delete c.nextAttemptAt;
      if (removed.length) forkLog(x, now, `Removed the Super FUMBBL copies of ${teamNames(x, removed)} (${c.reason}).`);
      if (kept.length) forkLog(x, now, `Kept the Super FUMBBL copy of ${teamNames(x, kept)}: another fixture still uses it.`);
    });
    writeLog(deps, `[leagues] Super FUMBBL team copies removed for ${refText(r)}: ${removed.join(", ") || "none"}${kept.length ? ` (kept for another fixture: ${kept.join(", ")})` : ""}`);
    return { kind: "removed", removed, kept };
  });
}

/** Unmarked fixtures whose copies are no longer needed, by ref. */
function unmarkedFinished(store: LeagueStore): Map<string, { ref: FixtureRef; reason: string }> {
  const out = new Map<string, { ref: FixtureRef; reason: string }>();
  for (const league of store.list()) {
    for (const season of store.competitions(league.id)) {
      for (const f of season.fixtures) {
        const reason = forkCleanupReason(f);
        if (!reason || f.fork?.cleanup) continue;
        const ref = { leagueId: league.id, seasonId: season.id, fixtureId: f.id };
        out.set(refText(ref), { ref, reason });
      }
    }
  }
  return out;
}

/** The baseline's file name under FORK_STATE_DIR. */
export const CLEANUP_BASELINE_FILE = "league-fork-cleanup-baseline.json";
const REF_PART = /^[^/\s]{1,200}$/;
const isFixtureKey = (x: unknown): x is string => typeof x === "string" && x.split("/").length === 3 && x.split("/").every((p) => REF_PART.test(p));

/**
 * Reads the baseline strictly: an object with createdAt (a date) and refs, every one a well-formed fixture key
 * (league/season/fixture). Anything else is an error, never an empty set.
 */
export function readCleanupBaseline(file: string): { ok: true; exists: boolean; refs: Set<string> } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: true, exists: false, refs: new Set() };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { ok: false, error: `the cleanup baseline is not valid JSON (${(e as Error).message})` }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "the cleanup baseline is not an object" };
  const b = parsed as { createdAt?: unknown; refs?: unknown };
  if (typeof b.createdAt !== "string" || !Number.isFinite(Date.parse(b.createdAt))) return { ok: false, error: "the cleanup baseline has no valid createdAt" };
  if (!Array.isArray(b.refs)) return { ok: false, error: "the cleanup baseline has no refs list" };
  const bad = b.refs.findIndex((r) => !isFixtureKey(r));
  if (bad >= 0) return { ok: false, error: `the cleanup baseline ref #${bad + 1} is not a fixture key` };
  return { ok: true, exists: true, refs: new Set(b.refs as string[]) };
}

/**
 * The baseline refs (written on the first scan). Throws on a file that exists but is not a valid baseline: the scan
 * then marks nothing (fail closed) until an operator fixes or deletes it.
 */
function baseline(deps: ForkCleanupDeps, current: Map<string, unknown>): Set<string> {
  if (!deps.baselineFile) return new Set();
  const read = readCleanupBaseline(deps.baselineFile);
  if (!read.ok) throw new Error(`${read.error}; no fixture is marked by the scan until it is fixed or deleted (${deps.baselineFile})`);
  if (!read.exists) {
    const refs = [...current.keys()].sort();
    atomicWriteTextFile(deps.baselineFile, JSON.stringify({ createdAt: (deps.now?.() ?? new Date()).toISOString(), refs }, null, 2));
    if (refs.length) writeLog(deps, `[leagues] Super FUMBBL team copy cleanup baseline: ${refs.length} older fixture(s) left to the backfill`);
    return new Set(refs);
  }
  return read.refs;
}

/**
 * The tick: every fixture with a due marker (pending, or failed past its backoff), and every unmarked fixture whose
 * copies are no longer needed (results from other writers), except the baseline. Never throws.
 */
export async function runForkTeamCleanup(deps: ForkCleanupDeps): Promise<{ removed: string[]; failed: string[] }> {
  const now = deps.now?.() ?? new Date();
  try {
    const unmarked = unmarkedFinished(deps.store);
    const skip = baseline(deps, unmarked);
    for (const [key, { ref, reason }] of unmarked) {
      if (skip.has(key)) continue;
      save(deps.store, ref, (x) => {
        if (!x.fork || x.fork.cleanup || !forkCleanupReason(x)) return;
        markForkCleanup(x, now, reason);
      });
    }
  } catch (e) {
    writeLog(deps, `[leagues] Super FUMBBL team copy scan skipped: ${(e as Error).message}`, true);
  }
  const due: FixtureRef[] = [];
  for (const league of deps.store.list()) {
    for (const season of deps.store.competitions(league.id)) {
      for (const f of season.fixtures) {
        if (!forkCleanupReason(f)) continue;
        const ref = { leagueId: league.id, seasonId: season.id, fixtureId: f.id };
        if (cleanupDue(f, now)) due.push(ref);
        else if (f.fork?.cleanup?.state === "removed" && f.fork.cleanup.kept?.length) {
          // A copy kept for another fixture that no longer needs it: this fixture removes it after all.
          const needed = neededElsewhere(season, f.id);
          if (f.fork.cleanup.kept.some((id) => !needed.has(id))) {
            save(deps.store, ref, (x) => { if (x.fork?.cleanup?.state === "removed") x.fork.cleanup.state = "pending"; });
            due.push(ref);
          }
        }
      }
    }
  }
  const removed: string[] = [];
  const failed: string[] = [];
  for (const r of due) {
    try {
      const out = await cleanupFixtureForkTeams(deps, r);
      if (out.kind === "removed") removed.push(refText(r));
      if (out.kind === "failed") failed.push(refText(r));
    } catch (e) {
      failed.push(refText(r));
      writeLog(deps, `[leagues] Super FUMBBL team copy cleanup error for ${refText(r)}: ${(e as Error).message}`, true);
    }
  }
  return { removed, failed };
}

export interface BackfillRow extends FixtureRef {
  reason: string;
  marker?: string;
  teams: Array<{ forkTeamId: string; files: number; libraries: number; pendingReload?: boolean; neededElsewhere: boolean }>;
  outcome?: CleanupOutcome;
}

/**
 * One-off sweep for fixtures that finished before cleanup existed (or are stuck): lists every fixture whose copies are
 * no longer needed but still have a team file or a library row. Dry-run unless `apply`; with apply each listed fixture
 * is marked (if it had no marker) and removed now, backoff ignored. Copies another fixture needs are listed, not removed.
 */
export async function forkTeamBackfill(deps: ForkCleanupDeps, opts: { apply?: boolean } = {}): Promise<BackfillRow[]> {
  if (!deps.fork.teamCopies) throw new Error("this fork client cannot list team copies");
  const rows: BackfillRow[] = [];
  for (const league of deps.store.list()) {
    for (const season of deps.store.competitions(league.id)) {
      const needed = (id: string): Set<string> => neededElsewhere(season, id);
      for (const f of season.fixtures) {
        const reason = forkCleanupReason(f);
        if (!reason) continue;
        const copies = fixtureForkCopies(f);
        const present = deps.fork.teamCopies(copies.map((c) => c.forkTeamId));
        const elsewhere = needed(f.id);
        const teams = [...new Set(copies.map((c) => c.forkTeamId))].map((id) => ({
          forkTeamId: id, files: present.get(id)?.files ?? 0, libraries: present.get(id)?.libraries ?? 0,
          ...(present.get(id)?.pendingReload ? { pendingReload: true } : {}), neededElsewhere: elsewhere.has(id),
        }));
        if (!teams.some((t) => !t.neededElsewhere && (t.files > 0 || t.libraries > 0 || t.pendingReload))) continue;
        rows.push({ leagueId: league.id, seasonId: season.id, fixtureId: f.id, reason, ...(f.fork?.cleanup ? { marker: f.fork.cleanup.state } : {}), teams });
      }
    }
  }
  if (!opts.apply) return rows;
  for (const row of rows) {
    const now = deps.now?.() ?? new Date();
    save(deps.store, row, (x) => {
      if (!x.fork) return;
      // A "removed" marker whose copies came back (a crash before the files went, or a hand copy): try again.
      if (x.fork.cleanup?.state === "removed") x.fork.cleanup.state = "pending";
      if (markForkCleanup(x, now, row.reason) && !x.fork.cleanup!.attempts) forkLog(x, now, `Marked the Super FUMBBL team copies for removal (backfill: ${row.reason}).`);
    });
    row.outcome = await cleanupFixtureForkTeams(deps, row, { force: true });
  }
  return rows;
}

export interface CleanupRouteResult { status: number; body: unknown }

/**
 * POST /api/admin/league-fork-cleanup { apply?: boolean } (site admins only): the backfill inside the running server, so
 * every fixture write goes through this process's store and fork locks. Dry run unless apply is exactly true.
 */
export async function leagueForkCleanupRoute(
  who: { coach: string; admin?: boolean } | undefined, input: Record<string, unknown>, deps: Omit<ForkCleanupDeps, "fork"> & { fork?: LeagueForkClient },
): Promise<CleanupRouteResult> {
  if (!who) return { status: 401, body: { error: "Authentication required." } };
  if (who.admin !== true) return { status: 403, body: { error: "Site admins only." } };
  if (!deps.fork) return { status: 503, body: { error: "Super FUMBBL is not connected on this server." } };
  const apply = input.apply === true;
  try {
    const rows = await forkTeamBackfill({ ...deps, fork: deps.fork }, { apply });
    writeLog(deps, `[leagues] league fork copy backfill by a site admin: ${apply ? "apply" : "dry run"}, ${rows.length} fixture(s)`);
    return { status: 200, body: { apply, rows, baseline: baselineStatus(deps.baselineFile) } };
  } catch (e) {
    return { status: 500, body: { error: (e as Error).message } };
  }
}

/** What the backfill and the admin route report about the scan's baseline (an invalid one stops the scan). */
export function baselineStatus(file: string | undefined): { ok: true; exists: boolean; count: number } | { ok: false; error: string } | undefined {
  if (!file) return undefined;
  const read = readCleanupBaseline(file);
  return read.ok ? { ok: true, exists: read.exists, count: read.refs.size } : { ok: false, error: `${read.error}: the automatic scan is stopped until it is fixed or deleted` };
}
