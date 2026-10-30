// The background job that fills the replay moments cache (store.ts). Never on an HTTP request path: the game page only
// reads the cache and says "pending" until the job has read the game.
//
//   triggers  a fork result stored in the results store (onResultStored, tournamentResults.ts), a sweep shortly after
//             startup and then every `intervalMs` (results imported by another process), newest games first;
//   pace      one game at a time and at least `gapMs` between two visits to the fork (a global last-visit stamp, kept
//             when the queue empties, so two results arriving back to back never open two connections together);
//   once      a game the fork answered is cached for good, ready or unavailable ("Replay Unavailable" for 1072);
//             any failure (fork down, timeout, a cache write that fails) is retried later with a doubling backoff, at
//             most `maxFailures` times per process; the job never rejects;
//   guard     replaying loads the game into the fork's game cache, and the fork deletes a cached TEST game (or an
//             unstarted / one-team one) from its database when it evicts it (GameCache.removeGame). The fork's status
//             lists do not select the testing column (DbAdminListByStatusQuery: every game reads testMode="false"), so
//             the job asks the fork's per-game admin list (`list?gameId=`, DbAdminListByIdQuery, which does select it)
//             and also refuses every game the site itself knows as a test (test-games.json, a test results row). A game
//             whose test status cannot be known is never loaded: cached unavailable.

import { adminChallenge, adminExchange, adminResponse, parseAdminGameList, type ForkAdminConfig } from "@bb/fork-ops";
import type { ReplayReadResult } from "./reader.js";
import type { ReplayMomentStore } from "./store.js";

export interface ReplayGuard {
  /** The fork's testing column; undefined when the answer did not carry it (unknown = not safe). */
  testMode: boolean | undefined;
  status: string;
  started?: string;
  homeTeamId: string;
  awayTeamId: string;
}

/** The fork's per-game admin entry (`admin/list?gameId=`), or undefined when the fork lists no such game. */
export async function forkGameGuard(cfg: ForkAdminConfig, gameId: string): Promise<ReplayGuard | undefined> {
  const xml = await adminExchange(cfg, async () => {
    const response = adminResponse(await adminChallenge(cfg), cfg.passwordMd5Hex);
    const res = await fetch(`${cfg.baseUrl}/admin/list?response=${encodeURIComponent(response)}&gameId=${encodeURIComponent(gameId)}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`fork admin/list?gameId failed (HTTP ${res.status})`);
    return res.text();
  });
  if (/<error>/i.test(xml)) throw new Error("fork admin/list?gameId answered an error");
  return parseGameGuard(xml, gameId);
}

/** One game's guard from an admin list answer. */
export function parseGameGuard(xml: string, gameId: string): ReplayGuard | undefined {
  const entry = parseAdminGameList(xml).find((g) => g.gameId === gameId);
  if (!entry) return undefined;
  let testMode: boolean | undefined;
  for (const m of xml.matchAll(/<game\b([^>]*)>/g)) {
    if (/\bid="([^"]*)"/.exec(m[1]!)?.[1] !== gameId) continue;
    const t = /\btestMode="([^"]*)"/.exec(m[1]!)?.[1];
    testMode = t === "true" ? true : t === "false" ? false : undefined;
  }
  return { testMode, status: entry.status, started: entry.started, homeTeamId: entry.homeTeamId, awayTeamId: entry.awayTeamId };
}

/** Why replaying this game could cost the fork its copy, or undefined when it is safe to load. */
export function unsafeReason(guard: ReplayGuard): string | undefined {
  if (guard.testMode === true) return "fork test game: not replayed (the fork deletes a test game it evicts after loading it)";
  if (guard.testMode !== false) return "test status unknown: not replayed (the fork deletes a test game it evicts after loading it)";
  if (!guard.homeTeamId || !guard.awayTeamId) return "one-team game: not replayed (the fork deletes it when it evicts it)";
  const started = guard.started?.trim();
  if (!started || /^1970-01-01/.test(started)) return "unstarted game: not replayed (the fork deletes it when it evicts it)";
  return undefined;
}

const FINISHED = new Set(["finished", "backuped"]);
export const SITE_TEST_REASON = "site test game (test-games.json or a test result): not replayed";
export const UNKNOWN_GAME_REASON = "test status unknown: the fork lists no such game";

export interface ReplayJobRow { gameId: string; source?: string; playedAt?: string; pulledAt?: string }

export interface ReplayJobDeps {
  store: ReplayMomentStore;
  /** Every results-store row. */
  rows: () => readonly ReplayJobRow[];
  /** The fork's per-game guard (throws when the fork cannot be asked). */
  guard: (gameId: string) => Promise<ReplayGuard | undefined>;
  /** A game the site knows as a test (test-games.json, a test results row): never loaded. */
  isSiteTest: (gameId: string) => boolean;
  read: (gameId: string) => Promise<ReplayReadResult>;
  /** Minimum time between two visits to the fork. */
  gapMs?: number;
  /** First retry delay after a failure; doubles per failure. */
  retryBaseMs?: number;
  maxFailures?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type ReplayStatus = "ready" | "pending" | "unavailable";

const SAFE_ID = /^[0-9]{1,18}$/;
const isForkRow = (r: ReplayJobRow): boolean => (r.source === undefined || r.source === "fork") && SAFE_ID.test(r.gameId);
const realSleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export function createReplayJob(deps: ReplayJobDeps) {
  const gapMs = deps.gapMs ?? 20_000;
  const retryBaseMs = deps.retryBaseMs ?? 10 * 60_000;
  const maxFailures = deps.maxFailures ?? 3;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? (() => {});
  const queue: string[] = [];
  const queued = new Set<string>();
  const failures = new Map<string, number>();
  const retryAt = new Map<string, number>();
  const logged = new Set<string>();
  let lastVisit = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;

  const gaveUp = (id: string): boolean => (failures.get(id) ?? 0) >= maxFailures;
  const waiting = (id: string): boolean => (retryAt.get(id) ?? 0) > now();
  const cached = (id: string): boolean => { try { return deps.store.has(id); } catch { return false; } };
  const skip = (id: string): boolean => cached(id) || gaveUp(id) || waiting(id);

  /** A failure: retried later (doubling backoff), logged once per game and kind. */
  function fail(id: string, kind: string, why: string): void {
    const n = (failures.get(id) ?? 0) + 1;
    failures.set(id, n);
    retryAt.set(id, now() + retryBaseMs * 2 ** (n - 1));
    if (!logged.has(`${id}:${kind}`)) { logged.add(`${id}:${kind}`); log(`[replay] game ${id}: ${why} (retried later, attempt ${n}/${maxFailures})`); }
  }

  function cacheUnavailable(id: string, reason: string): void {
    deps.store.put({ gameId: id, status: "unavailable", readAt: new Date(now()).toISOString(), reason });
    log(`[replay] game ${id}: ${reason}`);
  }

  async function visit(): Promise<void> {
    const wait = lastVisit + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastVisit = now();
  }

  async function processOne(id: string): Promise<void> {
    let siteTest = true;
    try { siteTest = deps.isSiteTest(id); } catch { siteTest = true; }
    if (siteTest) { cacheUnavailable(id, SITE_TEST_REASON); return; }
    await visit();
    let guard: ReplayGuard | undefined;
    try {
      guard = await deps.guard(id);
    } catch (e) {
      fail(id, "guard", `the fork's game entry could not be read: ${(e as Error).message}`);
      return;
    }
    if (!guard) { cacheUnavailable(id, UNKNOWN_GAME_REASON); return; }
    if (!FINISHED.has(guard.status)) { fail(id, "status", `not finished on the fork (${guard.status || "no status"})`); return; }
    const unsafe = unsafeReason(guard);
    if (unsafe) { cacheUnavailable(id, unsafe); return; }
    let result: ReplayReadResult;
    try {
      result = await deps.read(id);
    } catch (e) {
      fail(id, "read", (e as Error).message);
      return;
    }
    const readAt = new Date(now()).toISOString();
    if (result.status === "unavailable") { cacheUnavailable(id, result.reason); return; }
    const d = result.derivation;
    deps.store.put({ gameId: id, status: "ready", readAt, commands: d.commands, truncated: d.truncated, teams: d.teams, moments: d.moments });
    log(`[replay] game ${id}: ${d.moments.length} moments from ${d.commands} commands`);
  }

  async function drain(): Promise<void> {
    while (queue.length && !stopped) {
      const id = queue.shift()!;
      queued.delete(id);
      if (skip(id)) continue;
      try {
        await processOne(id);
      } catch (e) {
        // a cache write that failed (ENOSPC, EACCES) or anything unforeseen: this game later, the job carries on
        fail(id, "write", `could not be cached: ${(e as Error).message}`);
      }
    }
  }

  function kick(): Promise<void> {
    running ??= drain().catch(() => { /* never rejects */ }).finally(() => { running = undefined; });
    return running;
  }

  return {
    /** Queue one game (a result just stored). */
    enqueue(gameId: string): void {
      const id = String(gameId);
      if (stopped || !SAFE_ID.test(id) || queued.has(id) || skip(id)) return;
      queue.push(id);
      queued.add(id);
      void kick();
    },
    /** Queue every fork row without a cached answer, newest first. */
    sweep(): number {
      if (stopped) return 0;
      let rows: readonly ReplayJobRow[] = [];
      try { rows = deps.rows(); } catch { return 0; }
      const when = (r: ReplayJobRow): number => Date.parse(r.playedAt ?? r.pulledAt ?? "") || 0;
      const todo = rows.filter((r) => isForkRow(r) && !queued.has(r.gameId) && !skip(r.gameId)).sort((a, b) => when(b) - when(a));
      for (const r of todo) { queue.push(r.gameId); queued.add(r.gameId); }
      if (todo.length) void kick();
      return todo.length;
    },
    /** What the game page says about this game's ordered log. */
    status(gameId: string): ReplayStatus {
      let entry;
      try { entry = deps.store.get(gameId); } catch { entry = undefined; }
      if (entry) return entry.status;
      return stopped || gaveUp(gameId) ? "unavailable" : "pending";
    },
    /** Startup sweep after `initialDelayMs`, then one every `intervalMs`. */
    start(opts: { initialDelayMs?: number; intervalMs?: number } = {}): void {
      startTimer = setTimeout(() => this.sweep(), opts.initialDelayMs ?? 60_000);
      startTimer.unref?.();
      timer = setInterval(() => this.sweep(), opts.intervalMs ?? 15 * 60_000);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      if (startTimer) clearTimeout(startTimer);
    },
    /** Resolves when the queue is drained (tests). */
    idle(): Promise<void> { return running ?? Promise.resolve(); },
    pending: () => queue.length,
  };
}

export type ReplayJob = ReturnType<typeof createReplayJob>;
