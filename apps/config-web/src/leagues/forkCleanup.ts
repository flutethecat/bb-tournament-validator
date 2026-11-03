/**
 * Removes a league fixture's fork team copies once the match is over (owner 11-03: "League manager teams that are used
 * for a match should be deleted at the end."). The rules of when live in forkCleanupRules.ts; the fork IO is the fork
 * client's removeTeams (forkClient.ts: the install's locks, the live-game check, files, library rows, reload).
 *
 *   marker   forkPlay.ts writes fork.cleanup "pending" in the same store write that banks the result (or cancels play).
 *            Nothing touches the fork in that write, so a failed removal can never hold up banking.
 *   runner   runForkTeamCleanup, on the server's sync tick (after the result sync) and once shortly after start-up:
 *            every pending marker, and every failed one whose backoff has passed (2 min doubling to 6 h), is tried under
 *            the fixture's fork lock and its teams' locks. A restart resumes from the marker; every step is idempotent.
 *   shared   a fork team id another fixture still needs (any fixture whose copies are not finished with) is never
 *            removed: it is recorded as kept, and the tick removes it once no fixture needs it any more.
 *   backfill forkTeamBackfill (scripts/fork-team-cleanup.ts): fixtures that finished before this existed have no marker;
 *            it lists the ones whose copies are still installed and removes them only with apply.
 *
 * Logs: the server log gets one line per removal or failure (league / season / fixture ids and fork team ids only), the
 * fixture's fork history gets the removal, the first failure and what was kept.
 */
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
}

export interface FixtureRef { leagueId: string; seasonId: string; fixtureId: string }

export type CleanupOutcome =
  | { kind: "removed"; removed: string[]; kept: string[] }
  | { kind: "failed"; error: string; attempts: number }
  | { kind: "skipped"; why: string };

const BY = "Super FUMBBL";
const refText = (r: FixtureRef): string => `${r.leagueId}/${r.seasonId}/${r.fixtureId}`;

function writeLog(deps: ForkCleanupDeps, line: string, error = false): void {
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
    save(deps.store, r, (x) => {
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

/** The tick: every fixture with a due marker (pending, or failed past its backoff). Never throws. */
export async function runForkTeamCleanup(deps: ForkCleanupDeps): Promise<{ removed: string[]; failed: string[] }> {
  const now = deps.now?.() ?? new Date();
  const due: FixtureRef[] = [];
  for (const league of deps.store.list()) {
    for (const season of deps.store.seasons(league.id)) {
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
  teams: Array<{ forkTeamId: string; files: number; libraries: number; neededElsewhere: boolean }>;
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
    for (const season of deps.store.seasons(league.id)) {
      const needed = (id: string): Set<string> => neededElsewhere(season, id);
      for (const f of season.fixtures) {
        const reason = forkCleanupReason(f);
        if (!reason) continue;
        const copies = fixtureForkCopies(f);
        const present = deps.fork.teamCopies(copies.map((c) => c.forkTeamId));
        const elsewhere = needed(f.id);
        const teams = [...new Set(copies.map((c) => c.forkTeamId))].map((id) => ({
          forkTeamId: id, files: present.get(id)?.files ?? 0, libraries: present.get(id)?.libraries ?? 0, neededElsewhere: elsewhere.has(id),
        }));
        if (!teams.some((t) => !t.neededElsewhere && (t.files > 0 || t.libraries > 0))) continue;
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
